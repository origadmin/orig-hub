import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelCacheTask,
  deleteCacheTask,
  listAllCacheTasks,
  retryCacheTask,
} from '../../api/tg'
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
 * TG 入库任务的**单一数据源 + 单一轮询点**（BUG-300 / M3 修正）。
 *
 * 数据源为什么是 orig-tg 直连而不是 daemon `/api/activity`：
 *   入库任务**就住在 orig-tg**（`cache_task` 表），`itemKey` 是它天然的去重键；
 *   daemon 的聚合投影目前**不下发 `itemKey`**，拿不到聚合依据 —— 而补字段要重编并
 *   重启 daemon（本机 taskkill 返回「拒绝访问」，无权重启）。故本轮走直连，
 *   与媒体库（`api/media.ts` → orig-tg）保持同一架构形态。
 *
 * 轮询三律（AGENTS.md §5）：
 *   ① **有活才轮**：列表里还有在传/停滞的对象才续轮，全部已结束 ⇒ 停轮；
 *   ② **等值短路**：签名（id|status|done|error）不变则不 setState，避免每拍重渲染；
 *   ③ **卸载即停**：组件卸载后不再回写状态。
 */

/** 轮询间隔：入库按条目推进，且该端点每次读 SQLite（BUG-085 已知豁免），3s 是折中。 */
const DEFAULT_INTERVAL_MS = 3000

/** 同键批次的任务签名（用于等值短路与变化检测）。 */
function signature(tasks: TgCacheTask[]): string {
  return tasks
    .map((t) => `${t.id}|${t.status}|${t.done}|${t.total}|${t.error ?? ''}`)
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
  refresh: () => void
  run: (task: TgCacheTask, action: IngestAction) => Promise<void>
  remove: (task: TgCacheTask) => Promise<void>
}

export function useIngestGroups(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): UseIngestGroupsResult {
  const [tasks, setTasks] = useState<TgCacheTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const inFlight = useRef(false)
  const lastSig = useRef<string | null>(null)
  /**
   * 是否有活（在传/停滞）需要续轮 —— 由数据推导，不额外维护状态。
   *
   * 初值**必须是 true**：首轮无论如何都要拉一次，否则「无活 ⇒ 不拉 ⇒ 永远无活」
   * 是死锁（实测表现：下载页永久停在「加载中…」）。
   */
  const hasWork = useRef(true)

  useEffect(() => {
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
        const data = await listAllCacheTasks()
        const next = Array.isArray(data?.tasks) ? data.tasks : []
        if (cancelled) return
        const sig = signature(next)
        if (sig !== lastSig.current) {
          lastSig.current = sig
          setTasks(next)
        }
        setError(null)
      } catch (e) {
        if (cancelled) return
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
  }, [intervalMs, tick])

  const groups = useMemo(() => groupIngestTasks(tasks), [tasks])
  const overview = useMemo(() => summarizeGroups(groups), [groups])

  hasWork.current = groups.some(
    (g) => isCacheActive(g.latest.status) || isCacheStalled(g.latest.status),
  )

  const refresh = useCallback(() => {
    // 停轮后重新起轮：先解掉「无活」门禁，再触发一次即时拉取。
    hasWork.current = true
    setTick((n) => n + 1)
  }, [])

  const run = useCallback(
    async (task: TgCacheTask, action: IngestAction) => {
      const allowed = ingestActionsFor(task.status)
      if (!allowed.includes(action)) {
        throw new Error(`该入库任务当前不支持操作：${action}`)
      }
      if (action === 'retry') await retryCacheTask(task.id)
      else await cancelCacheTask(task.id)
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

  return { groups, tasks, overview, loading, error, refresh, run, remove }
}
