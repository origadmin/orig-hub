import { useEffect, useMemo, useState } from 'react'
import type { DownloadStatus, DownloadStatusValue } from '../../types'
import type { DlFilter } from '../../nav'
import { DownloadList } from './DownloadList'
import { IngestGroupRow } from './IngestGroupRow'
import type { UseIngestGroupsResult } from './useIngestGroups'
import { groupInBucket } from './ingestGroups'
import { useStore } from '../../store/useStore'
import { VirtualList } from '../../components/ui/virtual-list'
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
 *   - **TG 入库** = `props.ingest`（orig-tg 全量任务，含 `itemKey` 聚合依据）。
 *
 * 为什么不走 daemon `/api/activity`：它**不下发 `itemKey`**，缺了聚合依据；
 * 补字段需重编并重启 daemon，而本机 `taskkill` 返回「拒绝访问」（无权重启）。
 * 直连 orig-tg 与媒体库（`api/media.ts`）是同一种既有架构形态。
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
}

const RUNNING: DownloadStatusValue[] = ['downloading', 'queued', 'idle']

/** 来源切片：与侧栏状态树**正交**（状态是纵向分档，来源是横向切片）。 */
type SourceFilter = 'all' | 'download' | 'ingest'

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: '全部',
  download: '下载',
  ingest: 'TG 入库',
}

export function DownloadPanel({ dlFilter, items, ingest }: Props) {
  const { setError } = useStore()
  const { groups, overview, loading, error, refresh, run, remove } = ingest
  const [source, setSource] = useState<SourceFilter>('all')

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

  const engineRows = useMemo(() => {
    switch (dlFilter) {
      case 'running':
        return items.filter((d) => RUNNING.includes(d.status))
      case 'paused':
        return items.filter((d) => d.status === 'paused')
      case 'done':
        return items.filter((d) => d.status === 'completed')
      case 'all':
      default:
        // 全部任务 = 三档 + 失败兜底（error | cancelled 只在此可见）
        return items.filter(
          (d) =>
            RUNNING.includes(d.status) ||
            d.status === 'paused' ||
            d.status === 'completed' ||
            d.status === 'error' ||
            d.status === 'cancelled',
        )
    }
  }, [dlFilter, items])

  /** 入库对象：按 `itemKey` 聚合后的顶层行，再按树档过滤。 */
  const ingestRows = useMemo(
    () => groups.filter((g) => groupInBucket(g.latest.status, dlFilter)),
    [groups, dlFilter],
  )

  const showEngine = source !== 'ingest' && engineRows.length > 0
  const showIngest = source !== 'download' && ingestRows.length > 0
  const total = (showEngine ? engineRows.length : 0) + (showIngest ? ingestRows.length : 0)

  /**
   * 来源健康：orig-tg 不可达 ⇒ 拉取必然失败。
   *
   * banner 与 `error` **严格同真同假**（双向），避免出现「banner 恒隐」式假绿。
   */
  const tgUnavailable = error != null

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const counts: Record<SourceFilter, number> = {
    all: (source !== 'ingest' ? engineRows.length : 0) +
    (source !== 'download' ? ingestRows.length : 0),
    download: engineRows.length,
    ingest: ingestRows.length,
  }

  if (loading && total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-surface-2 border-t-accent" />
        <p className="mt-4 text-sm">加载中…</p>
      </div>
    )
  }

  if (total === 0 && error) {
    return (
      <div className="flex flex-col items-center justify-center py-24" data-testid="dl-error">
      <p className="text-sm text-danger">{error}</p>
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
      {/* 概览（笼统的数据）：先给结论级计数，再列具体对象 */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[11px] text-muted"
        data-testid="dl-overview"
      >
        <span className="font-mono text-fg-mid" data-testid="dl-overview-total">
          入库对象 {overview.total}
        </span>
        <span className="font-mono text-accent" data-testid="dl-overview-active">
          在传 {overview.active}
        </span>
        <span className="font-mono text-warning" data-testid="dl-overview-stalled">
          待处理 {overview.stalled}
        </span>
        <span className="font-mono text-success" data-testid="dl-overview-done">
          已完成 {overview.done}
        </span>
        <span className="font-mono" data-testid="dl-overview-cancelled">
          已取消 {overview.cancelled}
        </span>
      </div>

      {/* 来源切片 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="dl-source-filter">
        {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((k) => (
          <button
            key={k}
            onClick={() => setSource(k)}
            data-testid={`dl-source-${k}`}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              source === k
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border-subtle text-muted hover:text-fg-mid'
            }`}
          >
            {SOURCE_LABELS[k]}
            <span className="ml-1 font-mono">{counts[k]}</span>
          </button>
        ))}
      </div>

      {tgUnavailable && (
        <div
          className="shrink-0 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          data-testid="dl-tg-unavailable"
        >
          TG 服务未连接，入库任务暂时无法读取（普通下载不受影响）：{error}
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
              ? '连上 TG 后，入库任务会出现在这里'
              : '点击右上角「新建下载」添加任务，或在 TG 面板入库'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          {showEngine && (
            <div className="shrink-0">
              <DownloadList items={engineRows} />
            </div>
          )}
          {showIngest && (
            /*
             * 入库组行窗口化（BUG-316 段②）：实测 104 行 × 折叠 108px 全量渲染
             * ⇒ 单次 longtask ~240ms。estimate 取折叠行实测高；展开行 432px 由
             * measure-and-cache 逐帧收敛（VirtualList 内 RO）。间距沿用原
             * space-y-2.5（10px 烘进 wrapper padding）。契约：容器
             * data-total = ingestRows.length（验收脚本据此断言渲染行数 < 总数）。
             */
            <VirtualList<IngestGroup>
              className="min-h-0 flex-1 overflow-y-auto"
              testId="dl-group-list"
              items={ingestRows}
              estimate={108}
              overscan={6}
              keyOf={(g) => g.key}
              rowClassName="pb-2.5"
              renderItem={(g) => (
                <IngestGroupRow
                  group={g}
                  onAction={(task, action) => {
                    void run(task, action).catch(fail)
                  }}
                  onRemove={(task) => {
                    void remove(task).catch(fail)
                  }}
                />
              )}
            />
          )}
        </div>
      )}
    </div>
  )
}
