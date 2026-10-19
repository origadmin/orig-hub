import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelCacheTask,
  deleteCacheTask,
  retryCacheTask,
  setCacheTaskPriority,
} from '../../api/tg'
import { fetchActivity, type ActivityTask } from '../../api/daemon'
import type { TgCacheTask } from '../../types'
import {
  groupIngestTasks,
  ingestActionsFor,
  isCacheActive,
  isCacheStalled,
  summarizeGroups,
  type IngestAction,
  type IngestGroup,
  type IngestOverview,
} from './ingestGroups'

/**
 * TG 入库任务的**单一数据源 + 单一轮询点**（BUG-300 / M3 修正，2026-10-15 复报后收敛）。
 *
 * 数据源 = daemon `GET /api/activity`（`scope=all`）：
 *   - 这是为「引擎下载 + orig-tg 缓存」统一设计的只读聚合端点（五铁律：不改存储、
 *     写操作各走原路径、不造统一删除、不造假暂停/继续、跨进程容错恒 200）。
 *   - `cache` 任务的 `groupKey` 现在 == orig-tg `itemKey`（本轮补的字段），前端据此
 *     把「同一内容的多次入库」合并成一行（BT 的「种子」粒度）。
 *   - 写操作（重试/取消）仍按 `control`（side=native_id）指回 orig-tg 原端点，
 *     本模块不另起写路径。
 *   - 比首版的 orig-tg 直连更贴近「单一聚合入口」裁定；orig-tg 不可达时端点仍 200，
 *     仅 `sources.cache.available=false`，前端照常渲染其余来源。
 *
 * 轮询三律（AGENTS.md §5）：
 *   ① **有活才轮**：列表里还有在传/停滞的对象才续轮，全部已结束 ⇒ 停轮；
 *      **例外（BUG-318）**：最近一次拉取是「来源不可用」（orig-tg 取不到）时必须续轮
 *      —— 未知状态若停轮，orig-tg 恢复后不会自动回血，用户看到的「数据丢失」
 *      将一直持续到手动刷新；
 *   ② **等值短路**：签名（id|status|done|error|priority）不变则不 setState，避免每拍重渲染；
 *   ③ **卸载即停**：组件卸载后不再回写状态。
 *
 * ## 按视图在场门控（2026-10-16 用户裁定「不在其位不谋其政」）
 *
 * 本 hook 挂在**常驻的 MainLayout** 上（侧栏徽标/状态栏/下载面板三处同源），
 * 若不在场也轮询 ⇒ 用户在媒体库/设置/TG 任何视图都在每 3s 拉 `/api/activity`
 * （每次读 SQLite）—— 模块不在场却持续干活，且是跨视图卡顿的请求面来源之一。
 *
 * 故 `enabled=false`（下载域不在场）时：**不拉、不起轮**，已拉到的行与 overview
 * 原样保留（侧栏徽标/状态栏显示最后已知值）；切回下载域（`enabled=true`）立即
 * 拉一次 + 起轮。数据归属 = 下载域，消费方（徽标/状态栏）只读快照，不驱动拉取。
 *
 * ## 「取不到」≠「没有」（BUG-318；BUG-176 在下载域的复发）
 *
 * daemon `GET /api/activity` 恒 200，orig-tg 不可用时 `tasks` 里就是没有 cache 条
 * （`sources[1].available=false` + 原因，BUG-077 铁律 5）。若只读 `tasks`，前端会把
 * 「取不到」渲染成「暂无传输任务」—— 无 banner、无错误、行全消，且空 groups 让
 * 门禁停轮。故本模块：
 *   - cache 来源 `available === false` ⇒ 置 `unavailable`（banner 直出原因），
 *     **保留 last-known 行不清空**（用户观感即「数据丢失」；不清空 + 明示才是诚实降级）；
 *   - `tg plugin disabled` 同路径标注（用户主动关闭不是故障，但同样读不到）；
 *   - 未知态续轮 ⇒ orig-tg 恢复后**自动回血**，无需手动刷新。
 */

/** 把 daemon 聚合视图里的 cache 任务投影成前端聚合层需要的 `TgCacheTask` 形状。
 * `groupKey` 即 orig-tg `itemKey`（合并键）；`control.native_id` 即缓存任务整数 id（写操作真身）。
 *
 * `chatId`/`messageIds`/`priority` 由 daemon 从 orig-tg 任务载荷原样转发（2026-10-15 补）：
 * 前两者是「去媒体库查看」拼 `ref={chat}:{msg}` 的唯一坐标来源（相册/批量组的
 * `itemKey` 给不出 msg），后者是优先下载（BUG-277）的排序状态。 */
function toCacheTask(t: ActivityTask): TgCacheTask {
  return {
    id: Number(t.control.native_id) || 0,
    chatId: t.chatId ?? 0,
    itemKey: t.groupKey,
    messageIds: t.messageIds ?? [],
    total: t.total,
    done: t.done,
    status: t.status as TgCacheTask['status'],
    error: t.error ?? undefined,
    createdAt: t.updated_at,
    updatedAt: t.updated_at,
    title: t.name,
    priority: t.priority ?? 0,
  }
}

/** 轮询间隔：入库按条目推进，且该端点每次读 SQLite（BUG-085 已知豁免），3s 是折中。 */
const DEFAULT_INTERVAL_MS = 3000

/** 同键批次的任务签名（用于等值短路与变化检测）。
 * `priority` 必须进签名（BUG-277 同款教训）：只看进度会漏掉「只有优先下载变了」
 * 的刷新 —— 顺序与徽标都不更新，用户点了像没点。 */
function signature(tasks: TgCacheTask[]): string {
  return tasks
    .map((t) => `${t.id}|${t.status}|${t.done}|${t.total}|${t.error ?? ''}|${t.priority ?? 0}`)
    .join(';')
}

export interface UseIngestGroupsResult {
  /** 聚合后的入库对象（一个 `itemKey` 一行），已排序 */
  groups: IngestGroup[]
  /** 原始任务记录（未聚合） */
  tasks: TgCacheTask[]
  /** 概览口径（「笼统的数据」） */
  overview: IngestOverview
  loading: boolean
  /** 最近一次拉取失败的原因；`null` = 正常（orig-tg 可达） */
  error: string | null
  /**
   * 「取不到」态（BUG-318）：daemon 可达但 cache 来源 `available=false` 的原因。
   *
   * 与 `error` 分工：`error` = 整个聚合端点失败（daemon 都没通）；`unavailable` =
   * 端点成功但 orig-tg 这一侧没取到（可能不可达、可能被用户关闭）。两者都**不清空**
   * 已拉到的行 —— 清空即用户观感的「数据丢失」。
   */
  unavailable: string | null
  refresh: () => void
  run: (task: TgCacheTask, action: IngestAction) => Promise<void>
  remove: (task: TgCacheTask) => Promise<void>
}

export function useIngestGroups(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  enabled: boolean = true,
): UseIngestGroupsResult {
  const [tasks, setTasks] = useState<TgCacheTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const inFlight = useRef(false)
  const lastSig = useRef<string | null>(null)
  /**
   * 最近一次拉取是否「来源不可用」（BUG-318）。未知态必须续轮：停轮 ⇒ orig-tg
   * 恢复后不自动回血，用户观感 = 数据丢了一直不回来。
   */
  const sourceUnknown = useRef(false)
  /**
   * 是否有活（在传/停滞）需要续轮 —— 由数据推导，不额外维护状态。
   *
   * 初值**必须是 true**：首轮无论如何都要拉一次，否则「无活 ⇒ 不拉 ⇒ 永远无活」
   * 是死锁（实测表现：下载页永久停在「加载中…」）。
   */
  const hasWork = useRef(true)

  useEffect(() => {
    // 按视图在场门控（2026-10-16）：下载域不在场 ⇒ 不拉、不起轮。已拉到的行与
    // overview 保留（徽标/状态栏只读快照），切回下载域时本 effect 重建立即补拉。
    // `refresh()` 在场外被调用（如面板挂载 effect）只会 +tick，effect 重建后
    // 仍被本门控挡住 —— 语义正确：调用方在场才需要刷新。
    if (!enabled) return
    let cancelled = false
    /**
     * @param guarded 是否启用重入保护。
     *
     * 首次（含 StrictMode 的第二次挂载）**必须不设防**：若首轮就被上一次
     * 尚未返回的请求挡掉，而那次请求又因 effect 重建被标记取消、在 `finally`
     * 里跳过状态回写，就会形成「没人写状态 + 没人再发请求」的死锁。
     * 只有周期轮询需要防重叠（上一拍没回就不追加）。
     */
    const pull = async (guarded: boolean) => {
      if (guarded && inFlight.current) return
      inFlight.current = true
      try {
        const data = await fetchActivity('all')
        // BUG-318：先问「这一侧取到了吗」，再决定 tasks 能不能当「没有」读。
        // orig-tg 不可用（监督重启实测约每 10-15 分钟一次）时端点恒 200 但
        // cache 零条 —— 只读 tasks 就会把「取不到」渲染成「暂无传输任务」。
        const cacheSrc = (data?.sources ?? []).find((s) => s.kind === 'cache')
        const srcUnavailable = cacheSrc != null && cacheSrc.available === false
        if (cancelled) return
        sourceUnknown.current = srcUnavailable
        if (srcUnavailable) {
          // 取到不取到都不知道 ⇒ 绝不清空已拉到的行（清空即用户观感的数据丢失），
          // 只把原因交给 banner；行继续显示为「断开前的最后快照」。
          setUnavailable(cacheSrc?.error ?? 'TG 入库任务暂时无法读取')
          setError(null)
          return
        }
        setUnavailable(null)
        setError(null)
        const next = (Array.isArray(data?.tasks) ? data.tasks : [])
          .filter((t) => t.kind === 'cache')
          .map(toCacheTask)
        if (cancelled) return
        const sig = signature(next)
        if (sig !== lastSig.current) {
          lastSig.current = sig
          setTasks(next)
        }
      } catch (e) {
        if (cancelled) return
        // daemon 都没通：同样是「未知」⇒ 续轮（恢复后自动回血），行不动。
        sourceUnknown.current = true
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inFlight.current = false
        if (!cancelled) setLoading(false)
      }
    }
    void pull(false)
    const h = setInterval(() => {
      // 有活才轮：全部已结束（done/cancelled）时停轮，等下一次用户可见触发。
      if (!hasWork.current) return
      void pull(true)
    }, intervalMs)
    return () => {
      cancelled = true
      clearInterval(h)
    }
  }, [intervalMs, tick, enabled])

  const groups = useMemo(() => groupIngestTasks(tasks), [tasks])
  const overview = useMemo(() => summarizeGroups(groups), [groups])

  /**
   * 有活才轮 + **未知态续轮**（BUG-318）：全部终态 ⇒ 停轮；但最近一次拉取是
   * 「取不到」（orig-tg 不可用 / daemon 没通）时必须续 —— 否则服务恢复后
   * 没有人再拉，行一直停在断开前的快照，用户看到的就是「数据丢了」。
   */
  hasWork.current =
    groups.some(
      (g) => isCacheActive(g.latest.status) || isCacheStalled(g.latest.status),
    ) || sourceUnknown.current

  const refresh = useCallback(() => {
    // 停轮后重新起轮：先解掉「无活」门禁，再触发一次即时拉取。
    hasWork.current = true
    setTick((n) => n + 1)
  }, [])

  const run = useCallback(
    async (task: TgCacheTask, action: IngestAction) => {
      const allowed = ingestActionsFor(task.status, task.priority ?? 0)
      if (!allowed.includes(action)) {
        throw new Error(`该入库任务当前不支持操作：${action}`)
      }
      switch (action) {
        case 'retry':
          await retryCacheTask(task.id)
          break
        case 'cancel':
          await cancelCacheTask(task.id)
          break
        // 优先下载（BUG-277）：置顶数值由**后端**算（当前最大 + 1），前端只表达
        // 意图；语义是「当前任务跑完后下一个跑它」，不抢占正在跑的任务。
        case 'prefer':
          await setCacheTaskPriority(task.id, { top: true })
          break
        case 'unprefer':
          await setCacheTaskPriority(task.id, { priority: 0 })
          break
      }
      refresh()
    },
    [refresh],
  )

  const remove = useCallback(
    async (task: TgCacheTask) => {
      await deleteCacheTask(task.id)
      refresh()
    },
    [refresh],
  )

  return { groups, tasks, overview, loading, error, unavailable, refresh, run, remove }
}
