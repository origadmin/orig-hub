import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { cn } from '../lib/utils'
import {
  cancelCacheTask,
  clearFinishedCacheTasks,
  enqueueCacheTask,
  listAllCacheTasks,
} from '../api/tg'
import type { TgCacheTask, TgChannel } from '../types'

/**
 * 缓存管理面板（BUG-029）：缓存任务的唯一可观测面。
 *
 * 数据源 `GET /api/tg/cache/tasks/all`（全量任务 + 状态计数），与 1s 轮询的
 * 单结果契约（`GET /api/tg/cache/tasks`）并存互不影响。
 *
 * 刷新策略遵守轮询三律（AGENTS.md §5）：打开拉一次；仅当存在活跃任务时
 * 以 2s 间隔轮询，全部终态即停；手动刷新按钮兜底。
 */

const STATUS_LABEL: Record<TgCacheTask['status'], string> = {
  queued: '排队中',
  running: '缓存中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const STATUS_STYLE: Record<TgCacheTask['status'], string> = {
  queued: 'bg-surface-2 text-fg-muted',
  running: 'bg-accent/15 text-accent',
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  cancelled: 'bg-surface-2 text-fg-muted',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const COUNT_ORDER: Array<{ key: string; label: string }> = [
  { key: 'running', label: '缓存中' },
  { key: 'queued', label: '排队' },
  { key: 'done', label: '完成' },
  { key: 'failed', label: '失败' },
  { key: 'interrupted', label: '中断' },
  { key: 'cancelled', label: '取消' },
]

function taskLabel(t: TgCacheTask, channelTitle: string | undefined): string {
  const scope = t.groupId != null ? '整组' : '单条'
  const ch = channelTitle ?? `频道 ${t.chatId}`
  return `${ch} · ${scope} · ${t.messageIds.length} 条`
}

function fmtWhen(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function CacheManagerDialog(props: {
  channels?: TgChannel[]
  onClose: () => void
  /** 任务状态变化后通知宿主刷新 feed 缓存标记（如 done 后「已缓存」角标） */
  onTasksChanged?: () => void
}) {
  const { channels, onClose, onTasksChanged } = props
  const [tasks, setTasks] = useState<TgCacheTask[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const aliveRef = useRef(true)

  const titleOf = useCallback(
    (chatId: number) => channels?.find((c) => c.id === chatId)?.title,
    [channels],
  )

  // 等值短路（流畅度规则）：快照内容没变就不 setState，5s 轮询绝大多数是空转、零重渲染。
  const sigRef = useRef('')
  const load = useCallback(async () => {
    try {
      const res = await listAllCacheTasks()
      if (!aliveRef.current) return
      const tasks = res.tasks ?? []
      const sig = tasks
        .map((t) => `${t.id}:${t.status}:${t.done}:${t.total}:${t.currentId ?? ''}:${t.error ?? ''}`)
        .join('|')
      if (sig !== sigRef.current) {
        sigRef.current = sig
        setTasks(tasks)
        setCounts(res.counts ?? {})
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

  // 轮询三律：有活才轮（5s，BUG-030：2s 过频致卡顿）；全部终态即停。
  const hasActive = tasks.some((t) => t.status === 'running' || t.status === 'queued')
  useEffect(() => {
    if (!hasActive) return
    const iv = setInterval(() => void load(), 5000)
    return () => clearInterval(iv)
  }, [hasActive, load])

  // Escape 关闭（键盘可达性，与遮罩点击等价）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await load()
      onTasksChanged?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const retry = (t: TgCacheTask) =>
    act(() =>
      enqueueCacheTask({ chatId: t.chatId, messageIds: t.messageIds, groupId: t.groupId }),
    )

  const clearFinished = () =>
    act(() => clearFinishedCacheTasks())

  const total = COUNT_ORDER.reduce((s, { key }) => s + (counts[key] ?? 0), 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-[13px] font-semibold text-fg-strong">缓存管理</h4>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              刷新
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={total - (counts.running ?? 0) - (counts.queued ?? 0) <= 0}
              onClick={() => void clearFinished()}
            >
              清除记录
            </Button>
          </div>
        </div>

        {/* 状态计数行：数量/状态一眼可读 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {COUNT_ORDER.map(({ key, label }) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-fg-muted"
            >
              <span className="font-medium text-fg-strong">{counts[key] ?? 0}</span>
              {label}
            </span>
          ))}
          {total === 0 && !loading ? (
            <span className="text-xs text-fg-muted">暂无缓存任务</span>
          ) : null}
        </div>

        {err ? <p className="mt-2 text-xs text-red-500">{err}</p> : null}

        {/* 任务列表 */}
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {tasks.map((t) => {
            const pct = t.total > 0 ? (t.done / t.total) * 100 : 0
            const active = t.status === 'running' || t.status === 'queued'
            const retryable =
              t.status === 'failed' || t.status === 'cancelled' || t.status === 'interrupted'
            return (
              <div
                key={t.id}
                className="rounded-md border border-border-subtle bg-surface-2/40 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                        STATUS_STYLE[t.status],
                      )}
                    >
                      {STATUS_LABEL[t.status]}
                    </span>
                    <span className="truncate text-xs text-fg-strong">
                      {taskLabel(t, titleOf(t.chatId))}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void act(() => cancelCacheTask(t.id))}
                      >
                        取消
                      </Button>
                    ) : null}
                    {retryable ? (
                      <Button variant="ghost" size="sm" onClick={() => void retry(t)}>
                        重试
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <Progress value={pct} animated={t.status === 'running'} smoothMs={4800} className="flex-1" />
                  <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
                    {t.done}/{t.total}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-muted">
                    {fmtWhen(t.updatedAt)}
                  </span>
                </div>
                {t.currentId != null ? (
                  <p className="mt-1 text-[11px] text-fg-muted">正在缓存消息 #{t.currentId}</p>
                ) : null}
                {t.error ? (
                  <p className="mt-1 truncate text-[11px] text-red-500" title={t.error}>
                    {t.error}
                  </p>
                ) : null}
              </div>
            )
          })}
          {!loading && tasks.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-fg-muted">
              缓存任务将在这里显示进度与状态
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
