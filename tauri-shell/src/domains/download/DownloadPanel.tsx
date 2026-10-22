import { useEffect, useMemo, useState } from 'react'
import type { DownloadStatus } from '../../types'
import type { DlFilter } from '../../nav'
import { DownloadItem } from './DownloadItem'
import { IngestGroupRow } from './IngestGroupRow'
import type { UseIngestGroupsResult } from './useIngestGroups'
import { groupInBucket, ingestActionsFor } from './ingestGroups'
import { engineRowsInBucket } from './dlBuckets'
import { useStore } from '../../store/useStore'
import { useGoLibrary } from '../../hooks/useGoLibrary'
import { enqueueCacheTask } from '../../api/tg'
import { VirtualList } from '../../components/ui/virtual-list'
import { Button } from '../../components/ui/button'
import type { IngestGroup } from './ingestGroups'

/**
 * 下载域容器（模块重整 M0 · BUG-298 / M0-T02；M3 并入 TG 入库 · BUG-300）。
 *
 * **只换挂载与状态来源**（禁区原文）：列表组件本身不改、行内悬停操作不改、
 * DetailSheet 不改、「新建下载」仍在标题栏右侧、**页面内无 tabs** ——
 * 状态选择唯一载体是侧栏下载树（`nav.dlFilter`）。
 *
 * ## 呈现的「度」（BUG-300 复报修正的要点）
 *
 * 入库任务的**存储单位是一次入库操作**（`cache_task` 一行 = 一批消息的一次入队），
 * 不是内容对象。同一批内容被重复点入库会留下多条同 `itemKey` 的记录（实测
 * 137 条任务只有 104 个键，最多的键重复 7 次）。
 *
 * 因此下载域**不按原始任务行平铺**（那是把每次操作当成一个顶层任务，用户会把
 * 「同一内容的 7 次入库」误读成 7 个不同任务），而是按 BT 的粒度呈现：
 *
 * | BT             | 下载域里的 TG 入库                |
 * |----------------|-----------------------------------|
 * | 种子 = 顶层行   | 内容对象（`itemKey`）= 顶层行      |
 * | 文件 = 展开明细 | 每集消息 = 展开明细（BUG-296 组清单）|
 * | 历次做种记录     | 历史批次 = 折叠进展开区            |
 *
 * 顶层一行 = 一批内容（含「共 N 次」运行记录），顶层之上再给**概览口径**
 * （在传 / 待处理 / 已完成 / 已取消的对象数）—— 这就是「笼统的数据」。
 *
 * ## 数据源
 *   - **普通下载** = `props.items`（MainLayout 从 store 取，SSE 单一合并源，含块进度等细节）；
 *   - **TG 入库** = `props.ingest`（daemon `GET /api/activity`，`groupKey` = orig-tg `itemKey`
 *     作聚合依据；BUG-300 复报后切回的单一聚合入口）。
 */

interface Props {
  /** 侧栏下载树当前选择 */
  dlFilter: DlFilter
  /** 引擎任务全量（MainLayout 从 store 取，未过滤） */
  items: DownloadStatus[]
  /**
   * 入库任务快照（含聚合依据）——**由 MainLayout 轮询后下传**，本面板不自拉。
   *
   * 单一真源：侧栏徽标、状态栏读数与这里的行数必须来自**同一时刻的同一份数据**，
   * 各自拉一份会轮询两次、落后一个间隔不等（BUG-082 三处同源纪律）。
   */
  ingest: UseIngestGroupsResult
  /**
   * 「去媒体库查看」的跨视图出口（切到媒体库视图）。
   *
   * 由 MainLayout 提供（`view` 是它的局部 state）：入库行点了「去媒体库查看」，
   * 就地起播之后要落在成品所在的媒体库（而不是留在下载域），否则「查看」只是一次
   * 播放器弹出，用户从没到达过成品所在的地方。宿主没给时只在本地起播，能力不消失。
   */
  onOpenMedia?: () => void
}

/**
 * BUG-372：下载域统一行模型 —— engine 下载行与 TG 入库组行**同表滚动**。
 *
 * 旧结构把 engine 行包在 `shrink-0` 块里钉在滚动器**外面**：入库源不可达时
 * （orig-tg 抖动期 `ingestRows=0`）整个面板没有任何 overflow 容器，鼠标滚轮
 * 压哪儿都不滚（用户 2026-10-22：「他为什么不滚」连问四遍）；两者都在时也
 * 只有入库那一条窄条能滚，engine 区是滚不动死区。
 */
type DLRow =
  | { kind: 'engine'; item: DownloadStatus }
  | { kind: 'ingest'; group: IngestGroup }

export function DownloadPanel({ dlFilter, items, ingest, onOpenMedia }: Props) {
  const { setError, cancel } = useStore()
  const { groups, loading, error, unavailable, downloadUnavailable, refresh, run, remove } = ingest
  /**
   * BUG-353：下载域的**选中**控制面。
   *
   * 此前在传/待处理行只有行内「取消」按钮、没有任何选中能力 ⇒ 既不能批量干预、
   * 也无法表达「这些是我正在关注的内容」—— 用户原话「下载中内容，没有选中，
   * 无法过滤取消下载」（第二次强调）。现在每行一个 checkbox，选中的行进入此集合，
   * 底部出现批量条，可一次性「取消选中」。
   *
   * 选中键带来源前缀以避免引擎 id 与入库 key 撞名：`e:` + 引擎任务 id，
   * `i:` + 入库组 key。
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /**
   * 「去媒体库查看」（BUG-300 复报：入库流水线原先没有跳转查看）。与缓存管理面板
   * 共用 `useGoLibrary` 一份实现 —— ref 约定/ViewerItem 形状漂移就会一个宿主能跳、
   * 另一个跳错（BUG-082 同款分裂）。
   */
  const { goLibrary } = useGoLibrary({
    onOpenMedia,
    onError: (msg) => setError(msg),
  })

  /**
   * 本面板挂载时立即拉一次。
   *
   * 为什么需要：入库轮询遵守「有活才轮」（全部终态即停轮，省 DB 读），
   * 而 hook 挂在**常驻的 MainLayout** 上 —— 用户切走再切回下载域时面板重挂载、
   * hook 不重挂载，不补这一下就会拿着停轮前的旧快照，看起来像「数据没更新」。
   * `refresh` 是恒定引用（useCallback），故只在挂载时触发一次。
   */
  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * 引擎任务按树档过滤。**条件不在本文件写第二份** —— 侧栏徽标与状态栏读数
   * 由 `MainLayout` 用同一个 `countEngineBucket` 数，两处共用 `dlBuckets.ts`
   * 才不会有「徽标 3、列表 0」（BUG-377）。
   */
  const engineRows = useMemo(() => engineRowsInBucket(items, dlFilter), [dlFilter, items])

  /** 入库对象：按 `itemKey` 聚合后的顶层行，再按树档过滤。 */
  const ingestRows = useMemo(
    () => groups.filter((g) => groupInBucket(g.latest.status, dlFilter)),
    [groups, dlFilter],
  )

  /**
   * BUG-372：engine 行 + 入库行合成**一个**窗口化列表（见 `DLRow` 注释）。
   * 行键带 `e:`/`i:` 前缀，与选中集合 `selected` 同一套命名空间。
   */
  const dlRows = useMemo<DLRow[]>(
    () => [
      ...engineRows.map((item): DLRow => ({ kind: 'engine', item })),
      ...ingestRows.map((group): DLRow => ({ kind: 'ingest', group })),
    ],
    [engineRows, ingestRows],
  )

  // BUG-366：来源切片与概览两块常驻占位已撤（用户 2026-10-22：「上面死占2垃圾」）。
  // 实测两块合计占 61px 首屏纵向空间，且全 0 时仍原样占位。撤后列表直接置顶。
  const total = engineRows.length + ingestRows.length

  /**
   * 来源健康：orig-tg 不可达 ⇒ 拉取必然失败。
   *
   * BUG-318：两条通道并检 —— `error` = 聚合端点都没通（daemon 挂）；`unavailable` =
   * 端点通但 cache 来源 `available=false`（orig-tg 重启中/被关闭）。任一条为真都出
   * banner，且**不清空已拉到的行**（清空即用户观感的「数据丢失」，见 useIngestGroups）。
   *
   * banner 与两个原因**严格同真同假**（双向），避免出现「banner 恒隐」式假绿。
   */
  // BUG-355：横幅范围由 `sources` 两源联合推导，不再写死「普通下载不受影响」。
  // daemon 都没通 ⇒ 两侧都不可用；仅 cache 侧取不到 ⇒ 只报 TG；下载源也不可用 ⇒ 如实报「均不可用」。
  const daemonDown = error != null
  const dlDown = daemonDown || downloadUnavailable != null
  const tgUnavailable = daemonDown || unavailable != null || downloadUnavailable != null
  const tgReason = unavailable ?? downloadUnavailable ?? error
  const tgScopeText = daemonDown
    ? '服务未连接，TG 入库与普通下载均不可用'
    : unavailable != null && dlDown
      ? 'TG 入库与普通下载均不可用'
      : unavailable != null
        ? 'TG 入库任务暂时无法读取'
        : dlDown
          ? '普通下载不可用'
          : ''

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  /**
   * 批量下载**勾选的**条目（BT 式选择，2026-10-19 用户裁定「不需要按钮，
   * 只需要选择，只有选中的才下载」）。
   *
   * 幂等由后端保证（BUG-308）：整条已入库 ⇒ 返回 `alreadyIngested`（零字节重下）；
   * 有活跃任务覆盖 ⇒ 复用；只有「已登记但字节已失」才复位重跑。所以这里**不做
   * 前端去重** —— 前端猜去重必然与后端口径分裂（同一条消息一处拦下一处放行）。
   *
   * 逐条入队而非合并成一个任务：勾选只是用户面的「选中即下载」表达，后端没有
   * 「把任意消息集打成一个任务」的契约（`enqueueCacheTask` 的 messageIds 是
   * 同组/同条语义），硬造合并请求会改变任务的取消/重试粒度。
   *
   * 全部入队后 refresh 一次：新任务要马上出现在列表里，否则用户点了没反应。
   */
  const downloadSelected = async (chatId: number, messageIds: number[]) => {
    if (messageIds.length === 0) return
    try {
      let skipped = 0
      for (const messageId of messageIds) {
        const res = await enqueueCacheTask({ chatId, messageIds: [messageId] })
        if (res?.alreadyIngested) skipped += 1
      }
      if (skipped > 0) {
        setError(`${skipped} 项已入库，未重复下载`)
      }
      refresh()
    } catch (e) {
      fail(e)
    }
  }

  /**
   * 行级选中切换（BUG-353）。键带 `e:`/`i:` 前缀区分引擎下载与 TG 入库。
   */
  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  /**
   * 批量取消选中的下载（BUG-353）：把选中集合映射到各自来源的取消动作。
   *
   * 只有后端判据允许取消的才进队列（引擎 `actions` 含 `cancel` / 入库
   * `ingestActionsFor` 含 `cancel`），不可取消的选中项计入 skipped 并提示 ——
   * 不要让「点了没反应」冒充成功。
   */
  const cancelSelected = async () => {
    const ops: Array<() => Promise<unknown>> = []
    let skipped = 0
    for (const k of selected) {
      if (k.startsWith('e:')) {
        const id = k.slice(2)
        const it = engineRows.find((d) => d.id === id)
        if (it && (it.actions ?? []).includes('cancel')) {
          ops.push(() => cancel(id))
        } else {
          skipped += 1
        }
      } else if (k.startsWith('i:')) {
        const gk = k.slice(2)
        const g = groups.find((x) => x.key === gk)
        if (g && ingestActionsFor(g.latest.status, g.latest.priority ?? 0).includes('cancel')) {
          ops.push(() => run(g.latest, 'cancel'))
        } else {
          skipped += 1
        }
      }
    }
    if (ops.length === 0) {
      if (skipped > 0) setError('选中的内容无可取消的操作')
      return
    }
    try {
      await Promise.all(ops.map((o) => o()))
      setSelected(new Set())
      refresh()
      if (skipped > 0) setError(`${skipped} 项已无取消操作，已跳过`)
    } catch (e) {
      fail(e)
    }
  }

  /** 选中集合按来源拆成两个 id/key 集合，下传给两个列表（避免跨来源键名冲突）。 */
  const engineSel = useMemo(() => {
    const s = new Set<string>()
    for (const k of selected) if (k.startsWith('e:')) s.add(k.slice(2))
    return s
  }, [selected])
  const ingestSel = useMemo(() => {
    const s = new Set<string>()
    for (const k of selected) if (k.startsWith('i:')) s.add(k.slice(2))
    return s
  }, [selected])

  if (loading && total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-2 border-t-accent" />
        <p className="mt-4 text-sm">加载中…</p>
      </div>
    )
  }

  // 分级（BUG-318 / BUG-355）：`error` = 聚合端点都没通（daemon 挂）⇒ 两侧都不可用；
  // `unavailable` = orig-tg 单侧取不到（重启中/被关闭）⇒ 走黄色 banner + 空态；
  // `downloadUnavailable` = 下载源（引擎）不可用 ⇒ 横幅如实报「均不可用」，不再写死
  // 「普通下载不受影响」。三者都**不清空**已拉到的行（清空即用户观感的「数据丢失」）。
  if (total === 0 && error != null) {
    return (
      <div className="flex flex-col items-center justify-center py-24" data-testid="dl-error">
      <p className="text-sm text-danger">{tgReason}</p>
      <button
        onClick={refresh}
        className="mt-3 text-xs text-accent hover:underline"
      >
          重试
      </button>
      </div>
    )
  }

  return (
    /*
     * 布局：根弹性列 + 列表内滚动（BUG-316 段②）。入库组行实测 104 行全量同步
     * 渲染 ⇒ 单次 longtask ~240ms；改为窗口化后列表只渲染视口 ± overscan 行，
     * 概览/来源切片/banner 置顶（shrink-0），页面级滚动（main 的 overflow-y-auto）
     * 因面板 h-full 自然变 no-op。
     */
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* BUG-353：下载域选中控制面。选中任意行后出现，批量「取消选中」。 */}
      {selected.size > 0 && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-sm"
          data-testid="dl-batch-bar"
        >
          <span className="text-fg-mid" data-testid="dl-batch-count">
            已选 {selected.size} 项
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              data-testid="dl-batch-clear"
              title="清空选择"
            >
              清空
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => void cancelSelected()}
              data-testid="dl-batch-cancel"
              title="取消选中的下载"
            >
              取消选中
            </Button>
          </div>
        </div>
      )}

      {tgUnavailable && (
        <div
          className="shrink-0 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          data-testid="dl-tg-unavailable"
        >
          {tgScopeText}：{tgReason}
          {/* 仅当「只有 TG 取不到」且仍有快照行时，才提示「断开前的最后快照」；
              两侧都挂时不适用（BUG-355） */}
          {unavailable != null && !dlDown && ingestRows.length > 0 && '（下列入库行为断开前的最后快照，恢复后自动刷新）'}
        </div>
      )}

      {total === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center py-24 text-center"
          data-testid="dl-empty"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2">
            <svg className="h-8 w-8 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-medium text-fg-mid">暂无传输任务</h3>
          <p className="mt-1 text-xs text-muted">
            {tgUnavailable
              ? (dlDown
                  ? '恢复服务后，任务会出现在这里'
                  : '连上 TG 后，入库任务会出现在这里')
              : '点击右上角「新建下载」添加任务，或在 TG 面板入库'}
          </p>
        </div>
      ) : (
        /*
         * BUG-372：engine 行与入库行合并进**同一个** VirtualList —— 一个滚动区
         * 全覆盖（旧结构把 engine 行钉在 `shrink-0` 块里置于滚动器外，入库源
         * 抖动取不到时整个面板无从滚动，用户观感「他为什么不滚」）。
         *
         * 窗口化沿用 BUG-316 段②：estimate 取 engine 行实测高 116px，入库折叠
         * 行 108px / 展开行 432px 由 VirtualList 内 measure-and-cache 逐帧收敛；
         * 行间距 10px 烘进 rowClassName（pb-2.5）。行键 `e:`/`i:` 前缀与选中
         * 集合同一套命名空间，防跨来源撞名。
         */
        <VirtualList<DLRow>
          className="min-h-0 flex-1 overflow-y-auto"
          testId="dl-group-list"
          items={dlRows}
          estimate={116}
          overscan={6}
          keyOf={(r) => (r.kind === 'engine' ? `e:${r.item.id}` : `i:${r.group.key}`)}
          rowClassName="pb-2.5"
          renderItem={(r) =>
            r.kind === 'engine' ? (
              <DownloadItem
                item={r.item}
                selected={engineSel.has(r.item.id)}
                onToggleSelect={(id) => toggleSelect('e:' + id)}
              />
            ) : (
              <IngestGroupRow
                group={r.group}
                selected={ingestSel.has(r.group.key)}
                onToggleSelect={(key) => toggleSelect('i:' + key)}
                onAction={(task, action) => {
                  void run(task, action).catch(fail)
                }}
                onRemove={(task) => {
                  void remove(task).catch(fail)
                }}
                onGoLibrary={(task) => {
                  void goLibrary(task)
                }}
                onDownloadSelected={(chatId, messageIds) => {
                  void downloadSelected(chatId, messageIds)
                }}
              />
            )
          }
        />
      )}
    </div>
  )
}
