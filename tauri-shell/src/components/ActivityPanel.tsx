import { memo, useEffect, useRef, useState } from 'react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { useEvent } from '../hooks/useEvent'
import { useTranslation } from '../i18n'
import { formatBytes, formatSpeed } from '../lib/utils'
import { fetchActivity, activitySignature } from '../api/activity'
import type {
  ActivityAction,
  ActivitySnapshot,
  ActivitySource,
  ActivityTaskView,
} from '../api/activity'
import { downloadAction } from '../api/daemon'
import { retryCacheTask } from '../api/tg'
import { useStore } from '../store/useStore'

/**
 * 「传输中」视图（BUG-077 方案 (a)）：消费 `GET /api/activity` 的只读聚合。
 *
 * 三条铁律在**本组件**的落点（改这里前先读一遍）：
 * - **只读**：本视图对 `/api/activity` 只发 GET，没有任何写请求；
 * - **控制分流**：按钮按 `control.side` 各回原路径 —— daemon 侧走
 *   `/api/downloads/:id?action=...`，tg 侧走 `/api/cache/tasks/:id/retry`；
 * - **不给统一删除**：`ACTION_LABEL` 里**没有**删除类动词，后端 `actions` 也永远不会
 *   出现；删除留在各自原面板（那里说得清「删了会怎样」），这里只用
 *   `activity.deleteHint` 明确告知用户去哪删。
 * - **不造假暂停/继续**：TG 侧只可能出现「重试」（后端 `actions_for` 保证）；
 *   即便契约哪天变了，这里也严格按 `task.actions` 渲染 —— 拿不到就不画按钮。
 *
 * 流畅约束（AGENTS.md §5 轮询三律）：
 * - 有活才轮：无在途任务 + 队列空 + 来源健康 → 停轮询（队列一有任务即被 store 唤醒）；
 * - 等值短路：快照签名未变不 setState；
 * - 失败退避：请求失败按 2 的幂退避，上限 30s。
 */

/** 轮询周期上限 5s（BUG-030）：任务/列表类轮询不得高于 5s 一次 */
const POLL_MS = 5000
/** 退避上限（失败时） */
const MAX_POLL_MS = 30000
/** 「纯粹在等来源恢复」时的节奏：没有真活在跑，守恢复不需要 5s 粒度 */
const RECOVERY_POLL_MS = 30000

/** 动作 → i18n key。**刻意不含任何删除类动词** */
const ACTION_LABEL: Record<ActivityAction, string> = {
  pause: 'activity.pause',
  resume: 'activity.resume',
  cancel: 'activity.cancel',
  retry: 'activity.retry',
}

/** 下载侧状态 → i18n key（TG 侧复用既有 `tg.status*`） */
const DOWNLOAD_STATUS_KEY: Record<string, string> = {
  downloading: 'activity.st.downloading',
  queued: 'activity.st.queued',
  idle: 'activity.st.idle',
  paused: 'activity.st.paused',
  completed: 'activity.st.completed',
  error: 'activity.st.error',
  cancelled: 'activity.st.cancelled',
}

const CACHE_STATUS_KEY: Record<string, string> = {
  queued: 'tg.statusQueued',
  running: 'tg.statusRunning',
  done: 'tg.statusDone',
  failed: 'tg.statusFailed',
  cancelled: 'tg.statusCancelled',
  interrupted: 'tg.statusInterrupted',
}

function statusLabel(task: ActivityTaskView, tr: (k: string) => string): string {
  const map = task.kind === 'download' ? DOWNLOAD_STATUS_KEY : CACHE_STATUS_KEY
  const key = map[task.status]
  return key ? tr(key) : task.status
}

/** done/total 展示：字节走 formatBytes（下载）；条目数走「n/N 条」（TG 缓存） */
function amountText(task: ActivityTaskView, tr: (k: string) => string): string {
  if (task.unit === 'items') {
    return `${task.done}/${task.total} ${tr('activity.unitItems')}`
  }
  return `${formatBytes(task.done)} / ${formatBytes(task.total)}`
}

export function ActivityPanel() {
  const { t } = useTranslation()
  const [snap, setSnap] = useState<ActivitySnapshot | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /**
   * **在途**下载条数（store 标量，SSE 驱动）：**只作「有没有活」的唤醒信号** ——
   * 只在增删任务时变化，进度更新不会变，因此不会变成「每次进度一条请求」。
   *
   * 口径必须是**在途**（downloading/queued/idle），**不能**用 `s.downloads.length`：
   * 那是含 completed/failed/paused 的全量列表，只要用户历史上有任何一条记录就恒 > 0，
   * 「有活才轮（终态即停）」会退化成永久 5s 轮询（AGENTS.md §5）。
   * 与 MainLayout 的 `downloadingBucket` 同口径；paused 不会自己变，不靠轮询发现。
   *
   * selector **必须返回数字**：返回 filter 出的数组会每次新引用 → 无限重渲染。
   */
  const inTransit = useStore(
    (s) =>
      s.downloads.filter(
        (d) =>
          d.status === 'downloading' || d.status === 'queued' || d.status === 'idle',
      ).length,
  )
  const setError = useStore((s) => s.setError)

  const backoff = useRef(0)
  const sigRef = useRef('')

  const load = useEvent(async () => {
    try {
      const next = await fetchActivity('active')
      const sig = activitySignature(next)
      // 等值短路：签名未变则不 setState（AGENTS.md §5）
      if (sig !== sigRef.current) {
        sigRef.current = sig
        setSnap(next)
      }
      backoff.current = 0
      setFailed(null)
    } catch (e) {
      backoff.current = Math.min(backoff.current + 1, 4)
      setFailed(e instanceof Error ? e.message : String(e))
    }
  })

  /** TG 来源是否处于「故障中」（`tg plugin disabled` 是用户裁定，不算故障、不因此轮询） */
  const cacheSource: ActivitySource | undefined = snap?.sources.find(
    (s) => s.kind === 'cache',
  )
  const sourceDown = Boolean(
    cacheSource &&
      !cacheSource.available &&
      cacheSource.error !== 'tg plugin disabled',
  )
  /** 有活才轮的判据：有在途任务 / 下载在途 / 有来源待恢复 */
  const hasWork = (snap?.tasks.length ?? 0) > 0 || inTransit > 0 || sourceDown
  // 轮询循环里读最新值（避免把 hasWork 写进闭包造成陈旧判断）
  const hasWorkRef = useRef(hasWork)
  hasWorkRef.current = hasWork

  /**
   * 「纯粹在等来源恢复」——没有真活在跑，只是守着 9877 恢复。
   * 此时不需要 5s 粒度：等恢复用恢复档节奏即可，且不给故障中的进程添压。
   */
  const idleWait = sourceDown && (snap?.tasks.length ?? 0) === 0 && inTransit === 0
  const idleWaitRef = useRef(idleWait)
  idleWaitRef.current = idleWait

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const tick = async () => {
      await load()
      if (stopped) return
      // 终态即停：没活了就不再排下一次（有活时由下方 deps 变化重新唤醒）
      if (!hasWorkRef.current) return
      const delay =
        backoff.current > 0
          ? Math.min(POLL_MS * 2 ** backoff.current, MAX_POLL_MS)
          : idleWaitRef.current
            ? RECOVERY_POLL_MS
            : POLL_MS
      timer = setTimeout(tick, delay)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [load, hasWork])

  /** 控制分流：按 `control.side` 把动作指回各侧原路径 */
  const runAction = useEvent(
    async (task: ActivityTaskView, a: ActivityAction) => {
      try {
        if (task.control.side === 'daemon') {
          if (a === 'pause' || a === 'resume' || a === 'cancel') {
            await downloadAction(task.control.native_id, a)
          }
        } else if (a === 'retry') {
          // TG 侧唯一可达的「继续」：按 id 复位终态行重跑（无真续传，不能暂停/继续）。
          await retryCacheTask(Number(task.control.native_id))
        }
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
  )

  const tasks = snap?.tasks ?? []
  const degraded = (snap?.sources ?? []).filter((s) => !s.available)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="activity-panel">
      <div className="shrink-0 px-4 pt-1 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-fg-strong">
            {t('activity.title')}
          </h2>
          <span className="text-[11px] text-muted">{t('activity.sub')}</span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-muted">
          {t('activity.deleteHint')}
        </p>
      </div>

      {/* 来源降级提示：9877 挂掉时**只**提示该来源，列表其余照常（BUG-077 风险 4） */}
      {degraded.length > 0 && (
        <div
          className="mx-4 mb-2 shrink-0 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-4 text-warning"
          data-testid="activity-source-down"
        >
          {degraded
            .map((s) =>
              t('activity.sourceDown', {
                kind: t(
                  s.kind === 'cache'
                    ? 'activity.kindCache'
                    : 'activity.kindDownload',
                ),
                reason: s.error ?? '',
              }),
            )
            .join('；')}
        </div>
      )}

      {failed && (
        <div className="mx-4 mb-2 shrink-0 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {failed}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {tasks.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted">
            {t('activity.empty')}
          </div>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <ActivityRow key={task.id} task={task} onAction={runAction} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  task: ActivityTaskView
  onAction: (task: ActivityTaskView, a: ActivityAction) => void
}

const ActivityRow = memo(function ActivityRow({ task, onAction }: RowProps) {
  const { t } = useTranslation()
  const isCache = task.kind === 'cache'
  /** 速度只对**有采样**的一侧显示：TG 侧无该字段（既不是 0 也不是 null），故不显示 */
  const showSpeed = !isCache && task.speed !== null && task.speed !== undefined
  const busy = task.status === 'downloading' || task.status === 'running'
  /**
   * 白名单过滤：**没有文案的动作一律不画**。
   * 后端 `Action` 枚举是封闭的，所以现在不会命中；但将来后端新增动词而前端没跟，
   * `ACTION_LABEL[a]` 为 undefined → `t()` 返回 undefined → 渲染出**空标签按钮**，
   * 点击后 daemon 分支只认 pause/resume/cancel、tg 分支只认 retry，两边都静默 no-op
   * —— 正是「把不可用的能力做成看起来可用的按钮」。宁可不画，不可画个死的。
   */
  const actions = task.actions.filter((a) => a in ACTION_LABEL)

  return (
    <li className="rounded-lg border border-border-subtle bg-surface/60 p-3">
      <div className="flex items-center gap-2">
        <Badge variant={isCache ? 'secondary' : 'default'}>
          {t(isCache ? 'activity.kindCache' : 'activity.kindDownload')}
        </Badge>
        <span
          className="min-w-0 flex-1 truncate text-[13px] text-fg-strong"
          title={task.name}
        >
          {task.name}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {amountText(task, t)}
        </span>
        {showSpeed && (
          <span className="shrink-0 font-mono text-[11px] text-accent">
            {formatSpeed(task.speed ?? 0)}
          </span>
        )}
        <span className="shrink-0 text-[11px] text-fg-soft">
          {statusLabel(task, t)}
        </span>
      </div>

      <Progress className="mt-2" value={task.progress} animated={busy} smoothMs={POLL_MS} />

      {task.error && (
        <p
          className="mt-1.5 truncate text-[11px] text-danger"
          title={task.error}
        >
          {task.error}
        </p>
      )}

      {/*
        按钮**完全由后端 `actions` 驱动**：后端不给就画不出来。
        于是 TG 侧永远只有「重试」、两侧都永远没有「删除」。
      */}
      {actions.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'cancel' ? 'ghost' : 'secondary'}
              onClick={() => onAction(task, a)}
              data-testid={`activity-action-${a}`}
            >
              {t(ACTION_LABEL[a])}
            </Button>
          ))}
        </div>
      )}
    </li>
  )
})
