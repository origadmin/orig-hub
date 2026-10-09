import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { CacheBytesPanel } from './CacheBytesPanel'
import { cn, formatBytes, formatSpeed } from '../lib/utils'
import { useTranslation } from '../i18n'
import { describeTgFailure } from '../lib/tgReason'
import { deriveEntryState } from '../lib/entryState'
import { useStore } from '../store/useStore'
import { useEvent } from '../hooks/useEvent'
import { findMediaItemIdByRef, getMediaItem, mediaItemUrl } from '../api/media'
import {
  cancelCacheTask,
  cancelCacheTasks,
  deleteCacheTask,
  deleteCacheTasksByIds,
  listAllCacheTasks,
  listTgDialogs,
  retryCacheTask,
  retryCacheTasks,
} from '../api/tg'
import type { TgCacheTask, TgChannel, ViewerItem } from '../types'

/**
 * 入库流水线面板（原「缓存管理」）。
 *
 * ## 它到底是什么（概念修正）
 *
 * 缓存下来的字节**就是媒体库条目的本体**：`cache_one` → `mark_downloaded` →
 * `upsert_media_item(source="tg", ref="{chat}:{msg}")`，不存在第二份拷贝
 * （媒体库播放直接读 `media_item.file_path`）。所以这里不是「TG 的一个缓存资产箱」，
 * 而是**订阅内容 → 媒体库的入库流水线**：一条记录 = 一次入库尝试，终点是媒体库的成品。
 * 呈现层据此重排（分组按入库口径、动作给出「去媒体库查看」），数据层一行未动。
 *
 * ## 两个页签为什么不合并
 *
 * **入库流水线**（任务域）与**回收临时文件**（磁盘域）是两件事：合并会让「字节管理」
 * 重新变回主视角 —— 那正是本次要纠正的错位。故只改名易位：流水线默认在前，
 * 字节回收收进次位页签。
 *
 * ## 为什么必须有「全选 / 删除所选」（BUG-149）
 *
 * 记录只增不减：`cache_task` 没有任何保留策略（无自动 GC），且终态后再次入队是
 * `INSERT` 新行（`docs/design/ingest-pipeline-assessment.md` 3.10）。只有「单条删除」
 * 时，清 20 条要 20 次点击加 20 次确认 —— 等于没有清理能力。
 *
 * 曾在 `9bee7b8` 以「清记录是假需求」为由把批量删除整个撤掉：那是**无编号的自主
 * 重构**，且推翻了三天前刚验收的 BUG-054（用户原文「清理需要有全选，部分选择这些吧？
 * 一个一个删？」）。现按 L1 档（多选删除）恢复，依据见
 * `docs/design/ingest-pipeline-redesign-assessment.md` §1.4。
 *
 * 清记录**不释放字节**（字节在回收页签）—— 所以记录值得保留，但也不该被当成资产
 * 管理动作：批量删除走原子端点，且必须先确认、如实报出影响面。
 *
 * ## 为什么每条删除都要确认
 *
 * 记录一旦删掉，那条消息的入库历史就没了（重新入库要回 TG 翻消息）；
 * 行内一个小按钮贴着手滑就到，误点代价不小。确认条内**如实报出活跃任务数**——
 * 删活跃记录等于停掉正在跑的入库，不说清楚就是偷偷改状态。
 */

// BUG-170：状态徽标文案改由 `deriveEntryState` 单源派生（见 TaskRow 内
// ENTRY_LABEL_KEY），不再直接用任务机状态查表 —— 消灭「任务说完了、字节没影」的
// 呈现空窗。STATUS_KEY 随之删除，STATUS_STYLE（配色按任务机状态）保留。

const STATUS_STYLE: Record<TgCacheTask['status'], string> = {
  queued: 'bg-surface-2 text-fg-muted',
  running: 'bg-accent/15 text-accent',
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  cancelled: 'bg-surface-2 text-fg-muted',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

/** 记录的三种「结果」归属：成功 / 失败（含取消、中断）/ 活跃。 */
const ACTIVE_STATUS = new Set<TgCacheTask['status']>(['queued', 'running'])
const RETRYABLE = new Set<TgCacheTask['status']>(['failed', 'cancelled', 'interrupted'])

/**
 * 入库分组（呈现口径）：一条记录处在入库流程的哪一段。
 *
 * 与 `TgCacheTask.status` 是「多对一」而非一一对应 —— 后端状态表达的是**任务机**的
 * 状态（排队/在跑/终态/异常终态），界面要表达的是**用户关心的进度**（成了没/在跑/
 * 卡住了）。把六种状态平铺成六段就是让用户自己去归类，故收敛成四段。
 */
type IngestGroup = 'ingested' | 'ingesting' | 'failed' | 'cancelled'

const GROUP_OF: Record<TgCacheTask['status'], IngestGroup> = {
  queued: 'ingesting',
  running: 'ingesting',
  done: 'ingested',
  failed: 'failed',
  interrupted: 'failed',
  cancelled: 'cancelled',
}

/** 主视图（统计条 + 分组标签）覆盖的分组；`cancelled` 收进「更多」折叠，不占主视图。 */
const MAIN_GROUPS: IngestGroup[] = ['ingested', 'ingesting', 'failed']

/** 筛选档：**只筛列表**，与批量动作无关（批量删除已整个撤掉）。 */
type Scope = 'all' | 'success' | 'failed'

const SCOPE_TABS: Array<{ key: Scope; labelKey: string }> = [
  { key: 'all', labelKey: 'tg.cacheScopeAll' },
  { key: 'success', labelKey: 'tg.cacheScopeSuccess' },
  { key: 'failed', labelKey: 'tg.cacheScopeFailed' },
]

/** 按入库分组统计（服务端已给 counts，这里只做呈现口径的归并）。 */
function groupCounts(counts: Record<string, number>): Record<IngestGroup, number> {
  const out: Record<IngestGroup, number> = {
    ingested: 0,
    ingesting: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const [status, group] of Object.entries(GROUP_OF) as Array<
    [TgCacheTask['status'], IngestGroup]
  >) {
    out[group] += counts[status] ?? 0
  }
  return out
}

function scopeCount(scope: Scope, groups: Record<IngestGroup, number>): number {
  switch (scope) {
    case 'all':
      return MAIN_GROUPS.reduce((a, g) => a + groups[g], 0)
    case 'success':
      return groups.ingested
    case 'failed':
      return groups.failed
  }
}

function fmtWhen(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 停滞阈值（BUG-221）：字节超过 15s 没再推进而任务仍 `running` ⇒ 行内报
 * 「已 N 秒无进展」。
 *
 * 为什么是 15s：轮询 5s，取 3 拍 —— 既不会把「5s 轮询的正常间隙」误报成卡死，
 * 也不会让用户等上半分钟才知道停了。
 */
const STALL_MS = 15_000

/**
 * 速度读数的保鲜窗口：最后一次字节推进距今超过 10s 就**不再显示速度**。
 *
 * 速度是「相邻两次采样的字节差」派生出来的，它天然带着采样时刻；一旦字节停了，
 * 这个差值就变成历史值 —— 继续显示等于拿旧速率冒充当前速率（宁缺勿假）。
 */
const RATE_FRESH_MS = 10_000

/** 剩余时间文案（`≈3 分 20 秒` 这一档由 i18n 决定语序）。 */
function fmtEta(sec: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  return h > 0 ? t('tg.ingestEtaHour', { h, m }) : t('tg.ingestEtaMinSec', { m, s: rest })
}

/**
 * 流水线的一行（AGENTS.md §5：高频路径的行组件必须 `memo` 化）。
 *
 * 行内动作**按组切换**，且只有一条主按钮：已入库 → 去媒体库查看（成品的出口）；
 * 入库失败 → 重试；入库中 → 取消。删除记录退为次级动作（记录是历史，不是资产）。
 */
const IngestTaskRow = memo(function IngestTaskRow(props: {
  task: TgCacheTask
  /** 频道标题（宿主没给频道表时退回 `#<chatId>`） */
  title: string
  /** 宿主时钟（ms）：停滞秒数与速度保鲜都按它算，随轮询刷新（不新开定时器） */
  now: number
  busy: boolean
  /** 该行是否正在确认「删除记录」 */
  confirming: boolean
  /** 该行点过「去媒体库查看」但 by-ref 未命中（成品不在库里） */
  missing: boolean
  /** 该行是否参与批量选择（「更多」里的已取消组不参与：全选的语义是当前筛选内） */
  selectable: boolean
  /** 该行是否已被勾中 */
  selected: boolean
  onToggleSelect: (task: TgCacheTask) => void
  onGoLibrary: (task: TgCacheTask) => void
  onRetry: (task: TgCacheTask) => void
  onCancel: (task: TgCacheTask) => void
  onAskDelete: (task: TgCacheTask) => void
  onDelete: (task: TgCacheTask) => void
  onDismissDelete: () => void
}) {
  const {
    task,
    title,
    now,
    busy,
    confirming,
    missing,
    selectable,
    selected,
    onToggleSelect,
    onGoLibrary,
    onRetry,
    onCancel,
    onAskDelete,
    onDelete,
    onDismissDelete,
  } = props
  const { t } = useTranslation()
  /**
   * 进度**以字节为准**（BUG-221）。
   *
   * 旧式 `done/total` 的分母是**消息数**：一条几百 MB 的视频 `total = 1`，完成前
   * 恒 0% —— 最耗时的恰恰最不可见。现在 running 且总量已知时优先用
   * `progressBytes/progressBytesTotal`；总量未知就退回消息级读数；
   * 两者都不可用时显示「准备中」，**不假造百分比**。
   */
  const pb = task.progressBytes ?? null
  const pbTotalNum = task.progressBytesTotal ?? 0
  const running = task.status === 'running'
  const bytePct =
    running && pb !== null && pb > 0 && pbTotalNum > 0
      ? Math.min(100, (pb / pbTotalNum) * 100)
      : null
  const msgPct = task.total > 0 ? (task.done / task.total) * 100 : null
  const pct = bytePct ?? msgPct
  /** 还没起步（running 但既无字节进度也无已完成条目）：如实说「准备中」，不报 0%。 */
  const preparing = running && bytePct === null && task.done === 0

  /** 字节心跳距今多久（ms）；`null` = 服务端没给心跳（老库/未起步）。 */
  const sinceMs = task.progressAt != null ? now - task.progressAt : null
  const stalled = running && sinceMs !== null && sinceMs > STALL_MS
  const stalledSec = stalled && sinceMs !== null ? Math.floor(sinceMs / 1000) : null

  /**
   * 速度 / 剩余时间：相邻两次采样的字节差派生（复用现有 5s 轮询，不新增轮询源）。
   *
   * 只有**一次**采样（或字节没涨、心跳没走）时保持 `null` —— 不给数字好过给假数字。
   * 心跳时间戳用服务端下发的 `progressAt` 做差（同一时钟），不受本机时钟漂移影响。
   */
  const [rate, setRate] = useState<{ bps: number; etaSec: number | null } | null>(null)
  const prevSample = useRef<{ bytes: number; at: number } | null>(null)
  useEffect(() => {
    const bytes = task.progressBytes ?? null
    const at = task.progressAt ?? null
    const clear = () => setRate((prev) => (prev === null ? prev : null))
    if (!running || bytes === null || at === null) {
      prevSample.current = null
      clear()
      return
    }
    const prev = prevSample.current
    prevSample.current = { bytes, at }
    if (prev === null || at <= prev.at || bytes <= prev.bytes) {
      clear()
      return
    }
    const bps = ((bytes - prev.bytes) * 1000) / (at - prev.at)
    const remainSec = pbTotalNum > bytes ? Math.round((pbTotalNum - bytes) / bps) : null
    setRate((p) =>
      p !== null && Math.abs(p.bps - bps) < 0.5 && p.etaSec === remainSec
        ? p
        : { bps, etaSec: remainSec },
    )
  }, [running, task.progressBytes, task.progressAt, pbTotalNum])

  /** 速度只在「采样还新鲜」时显示：字节一停，旧速率就不再是当前速率。 */
  const rateFresh = rate !== null && sinceMs !== null && sinceMs <= RATE_FRESH_MS
  const bytesLabel =
    pb !== null && pb > 0
      ? pbTotalNum > 0
        ? `${formatBytes(pb)} / ${formatBytes(pbTotalNum)}`
        : t('tg.ingestDownloaded', { size: formatBytes(pb) })
      : null
  const active = ACTIVE_STATUS.has(task.status)
  const ingested = task.status === 'done'
  const retryable = RETRYABLE.has(task.status)
  const single = task.groupId == null
  // BUG-170：行内状态徽标走**单源派生**（deriveEntryState）——任务 done = 字节
  // 落库（present）、活跃 = 缓存中、failed/interrupted = 失败、cancelled 归
  // 「缺字节可重试」档。动作按钮（重试/取消/删除）仍按任务机状态判定，两者语义不同。
  const entry = deriveEntryState({
    taskStatus: task.status,
    bytesPresence: task.status === 'done' ? 'present' : undefined,
  })
  const ENTRY_LABEL_KEY: Record<string, string> = {
    cached: 'tg.statusDone',
    caching: 'tg.statusRunning',
    queued: 'tg.statusQueued',
    failed: 'tg.statusFailed',
    // cancelled 在任务机里是独立态（有专门的分组与文案），呈现层保留它：
    registered: task.status === 'cancelled' ? 'tg.statusCancelled' : 'tg.statusQueued',
    bytesMissing: task.status === 'cancelled' ? 'tg.statusCancelled' : 'tg.statusQueued',
  }
  return (
    <div
      className="rounded-md border border-border-subtle bg-surface-2/40 p-2.5"
      data-testid="cache-task-row"
      data-status={task.status}
    >
      <div className="flex items-center gap-2">
        {selectable ? (
          <input
            type="checkbox"
            className="h-3.5 w-3.5 shrink-0 accent-accent"
            checked={selected}
            disabled={busy}
            onChange={() => onToggleSelect(task)}
            aria-label={t('tg.cacheSelectRow')}
            title={t('tg.cacheSelectRow')}
            data-testid="cache-select-row"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
              STATUS_STYLE[task.status],
            )}
          >
            {t(ENTRY_LABEL_KEY[entry])}
          </span>
          <span className="truncate text-xs text-fg-strong">
            {title} · {single ? t('tg.cacheScopeSingle') : t('tg.cacheScopeGroup')} ·{' '}
            {t('tg.cacheCountUnit', { n: task.messageIds.length })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {ingested ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onGoLibrary(task)}
              data-testid="cache-task-golibrary"
            >
              {t('tg.ingestGoLibrary')}
            </Button>
          ) : null}
          {retryable ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onRetry(task)}
              data-testid="cache-task-retry"
            >
              {t('tg.cacheRetry')}
            </Button>
          ) : null}
          {active ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onCancel(task)}
              data-testid="cache-task-cancel"
            >
              {t('tg.cacheCancel')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={busy}
            onClick={() => onAskDelete(task)}
            data-testid="cache-task-delete"
          >
            {t('tg.cacheDelete')}
          </Button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Progress
          value={pct ?? 0}
          animated={running && !stalled}
          smoothMs={4800}
          className="flex-1"
        />
        {preparing ? (
          <span className="shrink-0 text-[11px] text-fg-muted" data-testid="cache-task-preparing">
            {t('tg.ingestPreparing')}
          </span>
        ) : pct !== null ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-fg-muted"
            data-testid="cache-task-bytes-pct"
          >
            {pct.toFixed(1)}%
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
          {task.done}/{task.total}
        </span>
        <span className="shrink-0 text-[11px] text-fg-muted">{fmtWhen(task.updatedAt)}</span>
      </div>
      {/* 字节读数 / 速度 / 剩余时间 / 停滞（BUG-221）：把「在下载 / 卡死 / 已恢复」
          变成可观测的读数，而不是让用户盯着分钟级时间戳猜。 */}
      {bytesLabel !== null || rateFresh || stalledSec !== null ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
          {bytesLabel !== null ? (
            <span className="tabular-nums" data-testid="cache-task-bytes">
              {bytesLabel}
            </span>
          ) : null}
          {rateFresh && rate !== null ? (
            <span className="tabular-nums" data-testid="cache-task-speed">
              {formatSpeed(rate.bps)}
            </span>
          ) : null}
          {rateFresh && rate !== null && rate.etaSec !== null ? (
            <span className="tabular-nums" data-testid="cache-task-eta">
              {fmtEta(rate.etaSec, t)}
            </span>
          ) : null}
          {stalledSec !== null ? (
            <span
              className="font-medium text-amber-600 dark:text-amber-400"
              data-testid="cache-task-stalled"
            >
              {t('tg.ingestStalled', { n: stalledSec })}
            </span>
          ) : null}
        </div>
      ) : null}
      {active && task.currentId != null ? (
        <p className="mt-1 text-[11px] text-fg-muted">
          {t('tg.cacheCurrentMsg', { id: task.currentId })}
        </p>
      ) : null}
      {task.status === 'failed' && task.error ? (
        // 与 TgPanel 共用同一映射（BUG-111）：此前这里连「受保护内容」的特例都没有，
        // 任务失败原因一律原样渲染（`request error: dropped (cancelled)` 直接进界面）。
        <p
          className="mt-1 truncate text-[11px] text-red-500"
          title={describeTgFailure(task.error, t)}
        >
          {describeTgFailure(task.error, t)}
        </p>
      ) : null}
      {missing ? (
        <p className="mt-1 text-[11px] text-fg-muted" data-testid="cache-task-notinlib">
          {t('tg.ingestNotInLibrary')}
        </p>
      ) : null}
      {/* 单条删除确认内联到当前任务行：用户清楚「删的是哪一条」 */}
      {confirming ? (
        <div
          className="mt-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
          data-testid="cache-confirm-inline"
        >
          {t('tg.cacheDeleteConfirmOne')}
          {active ? <span className="ml-1">{t('tg.cacheDeleteConfirmRunning')}</span> : null}
          <div className="mt-1.5 flex justify-end gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={busy}
              onClick={() => onDelete(task)}
              data-testid="cache-confirm-inline-yes"
            >
              {t('tg.cacheDeleteConfirmYes')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={onDismissDelete}
              data-testid="cache-confirm-inline-no"
            >
              {t('tg.cacheDeleteConfirmNo')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
})

/**
 * 待确认的删除。
 *
 * `one` = 行内单条；`batch` = 勾选的若干条（BUG-149 恢复，BUG-054 验收形态）。
 * 批量走原子端点 `DELETE /api/cache/tasks?ids=…`，不循环调单条 —— 循环调单条没有
 * 原子性也没有影响面，正是 BUG-054 时代要摆脱的旧形态。
 */
type Confirm = { kind: 'one'; id: number } | { kind: 'batch'; ids: number[] } | null

export function CacheManagerDialog(props: {
  channels?: TgChannel[]
  onClose: () => void
  /** 任务状态变化后通知宿主刷新 feed 缓存标记（如 done 后「已缓存」角标） */
  onTasksChanged?: () => void
  /**
   * 打开时落在哪个页签（BUG-059）。
   *
   * 设置页的「回收临时文件」不再就地全清，而是打开本面板的「回收临时文件」页签 ——
   * 同一个清理能力只有一个家，两处入口只是两个门。
   */
  initialView?: 'tasks' | 'bytes'
  /**
   * 「去媒体库查看」的跨视图出口（切到媒体库视图）。
   *
   * 由 MainLayout 提供（`view` 是它的局部 state）：流水线先就地起播，再借这个回调
   * 把用户送到成品所在的媒体库。宿主没给时只在本地起播（不切视图），能力不消失。
   */
  onOpenMedia?: () => void
}) {
  const { channels, onClose, onTasksChanged, initialView = 'tasks', onOpenMedia } = props
  const { t } = useTranslation()
  const { openViewer, setPendingMediaFocus } = useStore()
  const [view, setView] = useState<'tasks' | 'bytes'>(initialView)
  const [tasks, setTasks] = useState<TgCacheTask[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [scope, setScope] = useState<Scope>('all')
  const [confirm, setConfirm] = useState<Confirm>(null)
  /** 批量选择的记录 id（BUG-149）。只存 id，选中集与列表按 id 求交，故任务被删/列表
   *  刷新后自然收敛，不需要额外的清理 effect。 */
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  /** 点过「去媒体库查看」但库里查不到成品的 ref：行内如实写「尚未入库」。 */
  const [missRefs, setMissRefs] = useState<Set<string>>(new Set())
  /** 已取消分组默认折叠（不占主视图），展开才看。 */
  const [cancelledOpen, setCancelledOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const aliveRef = useRef(true)
  /**
   * 已查过的 tg ref → 媒体库条目 id（`null` = 查过但不在库里）。
   *
   * 与 TgPanel 的 `photoCheckedRef` 同一写法：**同一个 ref 只问一次后端**。
   * 不做列表级 `source="tg"` 筛选（后端 `listMediaItems` 不支持），也不在每次渲染
   * 重查 —— by-ref 是幂等读，但十几个行一起渲染就会变成十几个请求。
   */
  const libRefCache = useRef<Map<string, number | null>>(new Map())
  // 拖拽误关防护：只有在遮罩上按下**且**抬起时才关闭（面板内拖到遮罩松手会误关）。
  const downOnOverlay = useRef(false)

  /**
   * 频道标题自给自足。
   *
   * 本对话框有**两个宿主**：TG 面板（有频道列表，直接传）与设置页（没有，只传 initialView）。
   * 标题只从 prop 取的话，从设置页进来就永远拿不到 —— 界面会静默退化成 `#-1002533442302`，
   * 而「按频道选定」正是要靠标题才认得出是哪个频道（BUG-059 的原话诉求）。
   * 所以：宿主给了就用（省一次请求），没给就自己拉一次。
   */
  const [ownChannels, setOwnChannels] = useState<TgChannel[]>([])
  useEffect(() => {
    if (channels && channels.length > 0) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let retried = false
    /** `/api/tg/dialogs` 单页上限 200（实测 `limit=1000` 仍只回 200 + `hasMore=true`），
     *  而本地可能有数百个会话（本机 514）。只取第一页的话，排在后面的频道会静默退化成
     *  `#-100…` —— 而「按频道选定」正是靠标题才认得出是哪个频道。有界翻页：最多 4 页。 */
    const MAX_PAGES = 4
    const load = async (refresh: boolean) => {
      try {
        const acc: TgChannel[] = []
        let offset = 0
        for (let i = 0; i < MAX_PAGES; i++) {
          const p = await listTgDialogs({ limit: 200, offset, refresh: refresh && i === 0 })
          if (!alive) return
          if (p.items.length === 0) {
            // 缓存优先接口在缓存空时**后台起全量扫描**（`scanning=true`）并空手而归。
            // 就此收工会让标题永远停在 `#id`，所以按扫描状态**有界**重试一次（refresh=1）。
            if (p.scanning && i === 0 && !retried) {
              retried = true
              timer = setTimeout(() => void load(true), 1500)
            }
            break
          }
          acc.push(...p.items)
          offset += p.items.length
          if (!p.hasMore) break
        }
        if (acc.length > 0) setOwnChannels(acc)
      } catch {
        /* 标题只是显示增益，失败退回 `#id`，不阻断清理本身 */
      }
    }
    void load(false)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [channels])
  const allChannels = channels && channels.length > 0 ? channels : ownChannels

  const titleOf = useCallback(
    (chatId: number) => allChannels.find((c) => c.id === chatId)?.title,
    [allChannels],
  )

  // 等值短路（流畅度规则）：列表**与计数**都没变就不 setState——只比较列表会让
  // 清除后的计数停在旧值上。
  const sigRef = useRef('')
  const load = useCallback(async () => {
    try {
      // 磁盘占用读数（`getCacheStats`）已随「回收临时文件」页签下移：流水线只关心
      // 入库进度，顶部再摆一个「已缓存多少字节」正是把字节当资产的旧视角。
      const res = await listAllCacheTasks()
      if (!aliveRef.current) return
      const list = res.tasks ?? []
      const nextCounts = res.counts ?? {}
      // BUG-221：字节进度与心跳必须进等值判据 —— 否则「只有字节在涨」的刷新会被
      // 短路掉，行内读数又变回「分钟级不动」，正是本 BUG 的现象。
      const sig =
        list
          .map(
            (x) =>
              `${x.id}:${x.status}:${x.done}:${x.total}:${x.currentId ?? ''}:${x.error ?? ''}` +
              `:${x.progressBytes ?? ''}:${x.progressAt ?? ''}`,
          )
          .join('|') +
        '#' +
        JSON.stringify(nextCounts)
      if (sig !== sigRef.current) {
        sigRef.current = sig
        setTasks(list)
        setCounts(nextCounts)
      }
      setErr('')
    } catch (e) {
      if (aliveRef.current) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => {
      aliveRef.current = false
    }
  }, [load])

  /**
   * 宿主时钟（ms）：停滞秒数与速度保鲜都按它算。
   *
   * 为什么要它：字节一停，`progressAt` 就不变，等值短路会拦掉 setState —— 没有
   * 独立时钟的话「已 N 秒无进展」会冻在第一次读到的 N 上，等于报了个过期数。
   * 复用既有 5s 轮询的节拍（同一拍里更新），**不新开第二个定时器**。
   */
  const [nowMs, setNowMs] = useState(() => Date.now())

  // 轮询三律：有活才轮（5s）；全部终态即停。
  const hasActive = tasks.some((x) => ACTIVE_STATUS.has(x.status))
  useEffect(() => {
    if (!hasActive) return
    const iv = setInterval(() => {
      setNowMs(Date.now())
      void load()
    }, 5000)
    return () => clearInterval(iv)
  }, [hasActive, load])

  // Escape 关闭（键盘可达性，与遮罩点击等价）；有确认条时先撤确认。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirm) setConfirm(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, confirm])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      // 写操作后必须重拉：行消失是列表级变化，靠增量轮询会有滞后。
      sigRef.current = ''
      await load()
      onTasksChanged?.()
      setErr('')
    } catch (e) {
      if (aliveRef.current) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  /** 原任务重试（BUG-078）：按 id 复位同一条记录为 queued，不再新建任务。 */
  const retry = (task: TgCacheTask) => act(() => retryCacheTask(task.id))

  const removeOne = (id: number) => act(() => deleteCacheTask(id))

  /**
   * 批量删除：一次 `DELETE /api/cache/tasks?ids=…` 删掉勾选的几条（BUG-149）。
   *
   * 不循环调单条：单条循环没有原子性（中途失败会留下半清不清的状态），也报不出
   * 影响面。删完把这几条退出选中集，避免「已选 3 条」指着已经不存在的记录。
   */
  const removeMany = async (ids: number[]) => {
    await act(() => deleteCacheTasksByIds(ids))
    if (!aliveRef.current) return
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }

  /**
   * 批量重试（BUG-249）：**只发可重试的子集**（见 `retryableSelected` 的契约说明）。
   *
   * 重试是按 id 复位**同一行**（任务不消失），所以动作完成后**保留选中**——
   * 用户可以接着看它们转成 queued；这也与 `removeMany`（删了就得退出选中）相反。
   */
  const batchRetry = useEvent(() => {
    if (retryableSelected.length === 0) return
    void act(() => retryCacheTasks(retryableSelected))
  })

  /** 批量取消（BUG-249）：**只发可取消的子集**（活跃态）；终态不在其中，不被改动。 */
  const batchCancel = useEvent(() => {
    if (cancellableSelected.length === 0) return
    void act(() => cancelCacheTasks(cancellableSelected))
  })

  /**
   * 「去媒体库查看」：一次入库的终点是媒体库里的成品，出口就该通向成品。
   *
   * 走 by-ref（`source="tg"`、`ref="{chat}:{msg}"`），不按 chat 全量筛 —— 后端
   * `listMediaItems` 只支持 kind/q/tag/series，本次不为这个出口新增后端能力。
   * 命中即**就地起播**（播放器是全屏覆盖层），再把焦点 ref 交给媒体库、切视图，
   * 于是关掉播放器后用户落在成品所在的库里；未命中就如实写「尚未入库」——
   * 「已入库」却跳不到成品，比不给出这个按钮更让人困惑。
   */
  const goLibrary = useEvent(async (task: TgCacheTask) => {
    const msgId = task.messageIds[0]
    if (msgId == null) return
    const ref = `${task.chatId}:${msgId}`
    let id = libRefCache.current.get(ref)
    if (id === undefined) {
      try {
        id = await findMediaItemIdByRef('tg', ref)
      } catch {
        id = null
      }
      libRefCache.current.set(ref, id)
    }
    if (!aliveRef.current) return
    if (id == null) {
      setMissRefs((prev) => (prev.has(ref) ? prev : new Set(prev).add(ref)))
      return
    }
    try {
      const item = await getMediaItem(id)
      if (!aliveRef.current) return
      const viewerItem: ViewerItem = {
        key: `media-${item.id}`,
        chatId: 0,
        messageId: item.id,
        kind: item.kind,
        caption: item.title,
        description: item.description ?? null,
        src: mediaItemUrl(item.id),
        poster: item.poster ?? null,
        seriesId: item.seriesId ?? null,
      }
      setPendingMediaFocus(ref)
      openViewer({ items: [viewerItem], index: 0, title: item.title || undefined })
      onOpenMedia?.()
    } catch (e) {
      if (aliveRef.current) setErr(e instanceof Error ? e.message : String(e))
    }
  })

  // 筛选：三档标签**只决定看什么**，同时它也是「全选」的作用范围。
  const visible = useMemo(() => {
    switch (scope) {
      case 'all':
        return tasks.filter((x) => GROUP_OF[x.status] !== 'cancelled')
      case 'success':
        return tasks.filter((x) => GROUP_OF[x.status] === 'ingested')
      case 'failed':
        return tasks.filter((x) => GROUP_OF[x.status] === 'failed')
    }
  }, [scope, tasks])

  /** 已取消单独成组：不占主视图（统计条与分组标签都不算它），只留在「更多」里。 */
  const cancelled = useMemo(() => tasks.filter((x) => GROUP_OF[x.status] === 'cancelled'), [tasks])

  /** 统计条的三段读数（呈现口径，服务端 counts 按状态给，这里按入库分组归并）。 */
  const groups = useMemo(() => groupCounts(counts), [counts])

  /**
   * 行标题（BUG-232 v2）：**入库内容的标题**，由服务端随任务一起下发
   * （`task.title` = 该任务覆盖的第一条消息的 caption，取自消息同步时已落库的
   * `media_message` —— 与任务成败无关，failed/queued/interrupted 同样有标题）。
   *
   * v1 的错误修法（已被用户裁定「获取逻辑完全错了」）：壳按媒体库条目 by-ref 反查。
   * 那套只覆盖已出成品的任务（failed/queued 必然空白），还把「服务端一次 SQL」
   * 换成「每行一次 HTTP + 渲染期补数据」——数据早已在本地，是获取路径选错了层。
   *
   * 回退链末端（BUG-220 的剩余缺口）：**拿不到标题时也必须可辨认**。
   * 消息本身没有 caption（与 BUG-246 的「缺行」是两回事）时 `task.title` 为 null，
   * 此前整行退化成纯频道名 —— 同一频道的一排行长得一模一样，用户仍然分不出
   * 哪行是哪批，正是 BUG-220 原文「无法知道具体的入库内容是什么」。现在末端拼上
   * 该任务的首个消息号 `#<msg>`（消息号是数据不是文案，故不新增 i18n 键）。
   */
  const ingestTitleOf = useCallback(
    (task: TgCacheTask): string => {
      const content = task.title?.trim()
      if (content) return content
      const head = titleOf(task.chatId) ?? `频道 ${task.chatId}`
      // `messageIds` 为空的极端情况：退回频道链本身 —— 绝不渲染出空串或裸 `#`。
      const first = task.messageIds[0]
      return first == null ? head : `${head} #${first}`
    },
    [titleOf],
  )

  /**
   * 当前筛选内被勾中的 id（BUG-149）。
   *
   * 用「当前可见行 ∩ 选中集」导出，而不是直接用选中集：列表刷新/记录被删/切筛选档后
   * 选中集自然收敛，不会残留一个看不见却会被删掉的 id。
   */
  const selectedIds = useMemo(
    () => visible.filter((x) => selected.has(x.id)).map((x) => x.id),
    [visible, selected],
  )
  const allVisibleSelected = visible.length > 0 && selectedIds.length === visible.length

  /**
   * 选中集里**各自能动的那一部分**（BUG-249 的核心，不是可选的优化）。
   *
   * 批量端点**整请求校验**：请求里只要夹带一条状态不合法的记录就 422 全拒
   * （后端 `batch_task_action`，合法的那几条也不执行）。所以界面不能把「已选 N 条」
   * 原样发给端点 —— 必须先算出「可重试 x / 可取消 y」，**只发这 x / y**。
   *
   * 同时这也兑现了「不静默跳过」：落差（N−x / N−y）直接摊在动作条上，用户看得见
   * 「12 条里有 3 条本次不受影响」，而不是点了没反应还以为全动了。
   */
  const selectedTasks = useMemo(
    () => visible.filter((x) => selected.has(x.id)),
    [visible, selected],
  )
  const retryableSelected = useMemo(
    () => selectedTasks.filter((x) => RETRYABLE.has(x.status)).map((x) => x.id),
    [selectedTasks],
  )
  const cancellableSelected = useMemo(
    () => selectedTasks.filter((x) => ACTIVE_STATUS.has(x.status)).map((x) => x.id),
    [selectedTasks],
  )

  const onToggleSelect = useEvent((task: TgCacheTask) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(task.id)) next.delete(task.id)
      else next.add(task.id)
      return next
    })
  })
  const onToggleAll = useEvent(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      // 全中则取消当前筛选内的，否则补齐（BUG-054 的「表头全选」语义）。
      for (const x of visible) {
        if (allVisibleSelected) next.delete(x.id)
        else next.add(x.id)
      }
      return next
    })
  })

  /** 待删集合里有多少条是活跃任务：删活跃记录等于停掉正在跑的入库，必须如实报。 */
  const batchConfirm = confirm?.kind === 'batch' ? confirm : null
  const batchActiveCount = batchConfirm
    ? tasks.filter((x) => batchConfirm.ids.includes(x.id) && ACTIVE_STATUS.has(x.status)).length
    : 0

  // 行内回调必须引用恒定，否则行组件的 memo 白做（AGENTS.md §5）。
  const onRetry = useEvent((task: TgCacheTask) => void retry(task))
  const onCancelTask = useEvent((task: TgCacheTask) => void act(() => cancelCacheTask(task.id)))
  // 「去媒体库查看」同样必须引用恒定：写成内联箭头函数的话，行组件每次渲染都收到新的
  // prop，`memo` 直接失效 —— 轮询一刷新就整列表重渲染（AGENTS.md §5）。
  const onGoLibrary = useEvent((task: TgCacheTask) => void goLibrary(task))
  const onAskDelete = useEvent((task: TgCacheTask) => setConfirm({ kind: 'one', id: task.id }))
  const onDelete = useEvent((task: TgCacheTask) => {
    setConfirm(null)
    void removeOne(task.id)
  })
  const onDismissDelete = useEvent(() => setConfirm(null))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose()
        downOnOverlay.current = false
      }}
      data-testid="cache-manager-overlay"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="cache-manager"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[13px] font-semibold text-fg-strong">{t('tg.cacheManager')}</h4>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
              {t('tg.cacheRefresh')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('tg.cacheClose')}
              title={t('tg.cacheClose')}
              onClick={onClose}
              data-testid="cache-close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 两个页签：入库流水线（任务域，默认）/ 回收临时文件（磁盘域）。
            不合并：合并会让「字节管理」重新变回主视角，那正是本次要纠正的错位。
            清理能力只有一个家，设置页只是另一个门（BUG-059）。 */}
        <div className="mt-3 flex items-center gap-1.5" data-testid="cache-tabs">
          {(
            [
              ['tasks', 'tg.clearTabTasks'],
              ['bytes', 'tg.clearTabBytes'],
            ] as const
          ).map(([key, labelKey]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                view === key
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'bg-surface-2 text-fg-muted hover:text-fg-strong',
              )}
              data-testid={`cache-tab-${key}`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        {/* 入库统计条：三段读数（已入库 / 入库中 / 失败）。
            原先是「已缓存 {size} · {n} 个文件」—— 那是把字节当资产的口径；流水线的
            主视角是**进度**，字节的释放归「回收临时文件」页签（那里自带占用读数）。 */}
        <div
          className="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2/40 px-2.5 py-2 text-xs text-fg-muted"
          aria-label={t('tg.ingestSummary', {
            done: groups.ingested,
            active: groups.ingesting,
            failed: groups.failed,
          })}
          data-testid="cache-ingest-summary"
        >
          <span className="shrink-0" data-testid="ingest-summary-done">
            {t('tg.ingestStatusIngested')} {groups.ingested}
          </span>
          <span className="shrink-0 text-muted">·</span>
          <span className="shrink-0" data-testid="ingest-summary-active">
            {t('tg.ingestStatusIngesting')} {groups.ingesting}
          </span>
          <span className="shrink-0 text-muted">·</span>
          <span className="shrink-0" data-testid="ingest-summary-failed">
            {t('tg.ingestStatusFailed')} {groups.failed}
          </span>
        </div>

        {view === 'tasks' ? (
          <>
            {/* —— 入库流水线页签（进度与出口：记录怎么来的、成品在哪）—— */}
            {/* 分组档：只筛列表（批量删除已撤掉，它不再决定任何动作的范围）。
                映射：全部 = 已入库+入库中+入库失败（已取消不进主视图）；
                已入库 = done；入库失败 = failed + interrupted。 */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {SCOPE_TABS.map(({ key, labelKey }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScope(key)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs transition-colors',
                    scope === key
                      ? 'bg-accent/15 font-medium text-accent'
                      : 'bg-surface-2 text-fg-muted hover:text-fg-strong',
                  )}
                  data-testid={`cache-scope-${key}`}
                >
                  {t(labelKey)} · {scopeCount(key, groups)}
                </button>
              ))}
            </div>

            {/* 选择工具条：全选（当前筛选内）+ 已选计数 + 删除所选（BUG-149）。
                没有它，清 20 条 done 要 20 次点击加 20 次确认 —— 等于没有清理能力。 */}
            {visible.length > 0 ? (
              <div
                className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted"
                data-testid="cache-select-bar"
              >
                <label className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={allVisibleSelected}
                    disabled={busy}
                    onChange={() => onToggleAll()}
                    aria-label={t('tg.cacheSelectAll')}
                    data-testid="cache-select-all"
                  />
                  {t('tg.cacheSelectAll')}
                </label>
                <span className="shrink-0" data-testid="cache-selected-count">
                  {t('tg.cacheSelectedCount', { n: selectedIds.length })}
                </span>
                <span className="min-w-0 flex-1" />
              </div>
            ) : null}

            {/* 批量动作条（BUG-249）：**选中才出现**。三种动作各只对「适用的子集」生效，
                并把「选中 N 条 / 可重试 x / 可取消 y」如实摊开 —— 只发 x / y，剩下
                N−x 条本次不受影响，绝不明发全量让后端 422、也绝不静默跳过。 */}
            {selectedIds.length > 0 ? (
              <div
                className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-2.5 py-2 text-[11px] text-fg-muted"
                data-testid="cache-batch-bar"
              >
                <span
                  className="shrink-0 font-medium text-fg-strong"
                  data-testid="cache-batch-counts"
                >
                  {t('tg.cacheBatchCounts', {
                    n: selectedIds.length,
                    retry: retryableSelected.length,
                    cancel: cancellableSelected.length,
                  })}
                </span>
                <span className="min-w-0 flex-1" />
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy || retryableSelected.length === 0}
                  title={
                    retryableSelected.length < selectedIds.length
                      ? t('tg.cacheBatchRetryHint', {
                          hit: retryableSelected.length,
                          miss: selectedIds.length - retryableSelected.length,
                        })
                      : undefined
                  }
                  onClick={batchRetry}
                  data-testid="cache-batch-retry"
                >
                  {t('tg.cacheBatchRetry', { n: retryableSelected.length })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={busy || cancellableSelected.length === 0}
                  title={
                    cancellableSelected.length < selectedIds.length
                      ? t('tg.cacheBatchCancelHint', {
                          hit: cancellableSelected.length,
                          miss: selectedIds.length - cancellableSelected.length,
                        })
                      : undefined
                  }
                  onClick={batchCancel}
                  data-testid="cache-batch-cancel"
                >
                  {t('tg.cacheBatchCancel', { n: cancellableSelected.length })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'batch', ids: selectedIds })}
                  data-testid="cache-batch-delete"
                >
                  {t('tg.cacheDeleteSelected', { n: selectedIds.length })}
                </Button>
              </div>
            ) : null}

            {/* 批量确认条（BUG-054 验收形态：任何删除都要确认，且如实报出活跃任务数） */}
            {batchConfirm ? (
              <div
                className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
                data-testid="cache-confirm-batch"
              >
                {t('tg.cacheDeleteConfirmBatch', { n: batchConfirm.ids.length })}
                {batchActiveCount > 0 ? (
                  <span className="ml-1">{t('tg.cacheDeleteConfirmRunning')}</span>
                ) : null}
                <div className="mt-1.5 flex justify-end gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={busy}
                    onClick={() => void removeMany(batchConfirm.ids)}
                    data-testid="cache-confirm-batch-yes"
                  >
                    {t('tg.cacheDeleteConfirmYes')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => setConfirm(null)}
                    data-testid="cache-confirm-batch-no"
                  >
                    {t('tg.cacheDeleteConfirmNo')}
                  </Button>
                </div>
              </div>
            ) : null}

            {err ? <p className="mt-2 text-xs text-red-500">{err}</p> : null}

        {/* 入库记录列表 */}
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {visible.map((task) => (
            <IngestTaskRow
              key={task.id}
              task={task}
              title={ingestTitleOf(task)}
              now={nowMs}
              busy={busy}
              confirming={confirm?.kind === 'one' && confirm.id === task.id}
              missing={
                task.messageIds[0] != null &&
                missRefs.has(`${task.chatId}:${task.messageIds[0]}`)
              }
              selectable
              selected={selected.has(task.id)}
              onToggleSelect={onToggleSelect}
              onGoLibrary={onGoLibrary}
              onRetry={onRetry}
              onCancel={onCancelTask}
              onAskDelete={onAskDelete}
              onDelete={onDelete}
              onDismissDelete={onDismissDelete}
            />
          ))}
          {!loading && visible.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-fg-muted">
              {tasks.length === 0 ? t('tg.cacheTaskHint') : t('tg.cacheNoTasks')}
            </div>
          ) : null}
        </div>

        {/* 已取消：收进「更多」折叠。它是「用户自己叫停」的历史，既不是进度也不是
            失败，摆在主视图里只会稀释「还有多少没入库」这个真问题。 */}
        {cancelled.length > 0 ? (
          <div className="mt-2 shrink-0 border-t border-border-subtle/60 pt-2">
            <button
              type="button"
              onClick={() => setCancelledOpen((o) => !o)}
              aria-expanded={cancelledOpen}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-fg-mid hover:bg-surface-2"
              data-testid="cache-more-toggle"
            >
              {cancelledOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {t('tg.ingestStatusCancelled')} · {cancelled.length}
            </button>
            {cancelledOpen ? (
              <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
                {cancelled.map((task) => (
                  <IngestTaskRow
                    key={task.id}
                    task={task}
                    title={ingestTitleOf(task)}
                    now={nowMs}
                    busy={busy}
                    confirming={confirm?.kind === 'one' && confirm.id === task.id}
                    missing={false}
                    selectable={false}
                    selected={false}
                    onToggleSelect={onToggleSelect}
                    onGoLibrary={onGoLibrary}
                    onRetry={onRetry}
                    onCancel={onCancelTask}
                    onAskDelete={onAskDelete}
                    onDelete={onDelete}
                    onDismissDelete={onDismissDelete}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
          </>
        ) : (
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            {/* 回收临时文件（原「缓存字节」）：字节**必须**能回收，只是读起来应当是
                「回收入库准备物的临时文件」，而不是「管理缓存资产」。 */}
            <div className="shrink-0 rounded-md border border-border-subtle/70 bg-surface-2/25 px-2.5 py-2">
              <p className="text-[12px] font-medium text-fg-strong">
                {t('tg.ingestCleanupSection')}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">
                {t('tg.ingestCleanupHint')}
              </p>
            </div>
            <CacheBytesPanel
              // 频道标题：条目明细只带 chatId（数字），不给标题就只能显示 `#-1002533442302`。
              chatTitleOf={titleOf}
              onChanged={() => {
                // 字节回收后宿主读数会变（占用/文件数），必须重拉；任务记录不受影响但一起拉也就一次请求。
                sigRef.current = ''
                void load()
                onTasksChanged?.()
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
