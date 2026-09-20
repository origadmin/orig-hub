import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, HardDrive, RotateCcw, Square, X } from 'lucide-react'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { CacheBytesPanel } from './CacheBytesPanel'
import { cn } from '../lib/utils'
import { useTranslation } from '../i18n'
import {
  cancelCacheTask,
  deleteCacheTask,
  deleteCacheTasksByIds,
  getCacheStats,
  listAllCacheTasks,
  listTgDialogs,
  retryCacheTask,
} from '../api/tg'
import type { TgCacheTask, TgChannel } from '../types'

/**
 * 缓存管理面板。
 *
 * ## 边界（动词最小化 + 范围参数化）
 *
 * 缓存管理只有两类对象：**任务记录**（时间线）与**缓存文件**（磁盘字节）。
 * 此前把「动词」当成要枚举的东西（单删 / 全删 / 清除记录 / 清除终态 …），
 * 于是每想到一个场景就加一个按钮 —— 必然无限叠加（「清空失败」就成了第 N 个）。
 * 收敛后：**记录面** = 取消 / 重试 / 删除；**字节面** = 清除缓存文件。
 *
 * ## 为什么删除要能「全选 / 部分选择」
 *
 * 此前批量动词只有一个 `清除记录`，范围由上方分段（全部/成功/失败）决定 ——
 * 意味着**只能整档清，不能挑着清**；想删三条不相邻的记录只能一条一条点，
 * 用户原话「一个一个删？」。选择本身才是诉求，靠枚举档位永远追不上
 * （清空失败 / 清空成功 / 清空中断…），故批量动作改为**勾选驱动**：
 * 每行一个勾选框、表头全选、`删除所选 (N)`。点全选即等价于原来的「全部」档。
 *
 * ## 为什么每条删除都要确认
 *
 * 记录一旦删掉，那条消息的缓存历史就没了（重新缓存要回 TG 翻消息）；
 * 行内一个小按钮贴着手滑就到，误点代价不小。确认条内**如实报出活跃任务数**——
 * 删活跃记录等于停掉正在跑的下载，不说清楚就是偷偷改状态。
 *
 * ## 「清除缓存文件」为什么不在这个面板里
 *
 * 它是释放磁盘字节的动作，与「设置 → 通用 → TG 模块」下的清理项是**同一个后端动作**
 * （`POST /api/cache/clear`）。两个入口两个说法只会让人以为是两件事，故只保留设置页那一个；
 * 本面板保留占用读数，便于对照「记录没了但字节还在」这类困惑。
 */

const STATUS_KEY: Record<TgCacheTask['status'], string> = {
  queued: 'tg.statusQueued',
  running: 'tg.statusRunning',
  done: 'tg.statusDone',
  failed: 'tg.statusFailed',
  cancelled: 'tg.statusCancelled',
  interrupted: 'tg.statusInterrupted',
}

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

/** 筛选档：**只筛列表**（批量动作已改为勾选驱动，不再由它决定范围）。 */
type Scope = 'all' | 'success' | 'failed'

const SCOPE_TABS: Array<{ key: Scope; labelKey: string }> = [
  { key: 'all', labelKey: 'tg.cacheScopeAll' },
  { key: 'success', labelKey: 'tg.cacheScopeSuccess' },
  { key: 'failed', labelKey: 'tg.cacheScopeFailed' },
]

function scopeCount(scope: Scope, counts: Record<string, number>, tasks: TgCacheTask[]): number {
  const c = (k: string) => counts[k] ?? 0
  switch (scope) {
    case 'all':
      return tasks.length
    case 'success':
      return c('done')
    case 'failed':
      return c('failed') + c('cancelled') + c('interrupted')
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function fmtWhen(sec: number): string {
  const d = new Date(sec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 待确认的删除：单条 / 勾选的批量。 */
type Confirm = { kind: 'one'; id: number } | { kind: 'batch' } | null

export function CacheManagerDialog(props: {
  channels?: TgChannel[]
  onClose: () => void
  /** 任务状态变化后通知宿主刷新 feed 缓存标记（如 done 后「已缓存」角标） */
  onTasksChanged?: () => void
  /**
   * 打开时落在哪个页签（BUG-059）。
   *
   * 设置页的「清除缓存文件」不再就地全清，而是打开本面板的「缓存字节」页签 ——
   * 同一个清理能力只有一个家，两处入口只是两个门。
   */
  initialView?: 'tasks' | 'bytes'
}) {
  const { channels, onClose, onTasksChanged, initialView = 'tasks' } = props
  const { t } = useTranslation()
  const [view, setView] = useState<'tasks' | 'bytes'>(initialView)
  const [tasks, setTasks] = useState<TgCacheTask[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [stats, setStats] = useState<{ files: number; bytes: number; external: number }>({
    files: 0,
    bytes: 0,
    external: 0,
  })
  const [scope, setScope] = useState<Scope>('all')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const aliveRef = useRef(true)
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
      const [res, st] = await Promise.all([listAllCacheTasks(), getCacheStats()])
      if (!aliveRef.current) return
      const list = res.tasks ?? []
      const nextCounts = res.counts ?? {}
      const sig =
        list
          .map((x) => `${x.id}:${x.status}:${x.done}:${x.total}:${x.currentId ?? ''}:${x.error ?? ''}`)
          .join('|') +
        '#' +
        JSON.stringify(nextCounts)
      if (sig !== sigRef.current) {
        sigRef.current = sig
        setTasks(list)
        setCounts(nextCounts)
        // 勾选集跟随列表收敛：删掉的行不能留在选中态里（否则「已选 3 项」会虚报，
        // 下次删除还会拿旧 id 打后端）。返回同一引用表示无变化，不触发重渲染。
        setSel((prev) => {
          if (prev.size === 0) return prev
          const alive = new Set(list.map((x) => x.id))
          const next = new Set([...prev].filter((id) => alive.has(id)))
          return next.size === prev.size ? prev : next
        })
      }
      setStats({ files: st.files ?? 0, bytes: st.bytes ?? 0, external: st.external ?? 0 })
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

  // 轮询三律：有活才轮（5s）；全部终态即停。
  const hasActive = tasks.some((x) => ACTIVE_STATUS.has(x.status))
  useEffect(() => {
    if (!hasActive) return
    const iv = setInterval(() => void load(), 5000)
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

  const removeOne = (id: number) =>
    act(async () => {
      await deleteCacheTask(id)
      setSel((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })

  const removeSelected = () => {
    const ids = [...sel]
    if (ids.length === 0) return
    return act(async () => {
      await deleteCacheTasksByIds(ids)
      setSel(new Set())
    })
  }

  // 筛选：三档标签**只决定看什么**。批量动作的作用范围由勾选决定（见文件头注释）。
  const visible = useMemo(() => {
    switch (scope) {
      case 'all':
        return tasks
      case 'success':
        return tasks.filter((x) => x.status === 'done')
      case 'failed':
        return tasks.filter((x) => RETRYABLE.has(x.status))
    }
  }, [scope, tasks])

  const visibleIds = useMemo(() => visible.map((x) => x.id), [visible])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => sel.has(id))
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => sel.has(id))

  const toggle = (id: number) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAllVisible = () =>
    setSel((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
      else visibleIds.forEach((id) => next.add(id))
      return next
    })

  const selCount = sel.size
  /** 勾选里正在跑的任务数：删它等于停掉下载，确认条必须说清。 */
  const selActiveCount = tasks.filter((x) => sel.has(x.id) && ACTIVE_STATUS.has(x.status)).length

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

        {/* 两个页签：任务记录（时间线）/ 缓存字节（磁盘）。
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

        {/* 磁盘占用：只读读数。字节的释放动作在「缓存字节」页签，这里只负责如实显示 */}
        <div className="mt-2.5 flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2/40 px-2.5 py-2 text-xs text-fg-muted">
          <HardDrive className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {t('tg.cacheUsage', { size: fmtBytes(stats.bytes), n: stats.files })}
          </span>
          {stats.external > 0 ? (
            <span className="shrink-0 text-[11px]">· {t('tg.cacheExternal', { n: stats.external })}</span>
          ) : null}
          {/* 只在**不在这个页签**时才指路（BUG-081）：用户已经站在「缓存字节」页签上
              还被告知「清理入口在缓存字节页签」，是一句指向自己的话 —— 提示一旦自指，
              就不再是指路，而是噪音。 */}
          {view !== 'bytes' ? (
            <span
              className="ml-auto shrink-0 text-[10.5px] text-muted"
              data-testid="cache-purge-hint"
            >
              {t('tg.cachePurgeHere')}
            </span>
          ) : null}
        </div>

        {view === 'tasks' ? (
          <>
            {/* —— 任务记录页签（时间线：记录怎么删，不动磁盘字节）—— */}
            {/* 筛选档：只筛列表 */}
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
              {t(labelKey)} · {scopeCount(key, counts, tasks)}
            </button>
          ))}
        </div>

        {/* 选择工具条：全选（当前筛选内）+ 删除所选 */}
        <div className="mt-2 flex items-center gap-2 rounded-md border border-border-subtle/70 bg-surface-2/25 px-2 py-1.5">
          <button
            type="button"
            onClick={toggleAllVisible}
            disabled={visibleIds.length === 0}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-fg-mid hover:bg-surface-2 disabled:opacity-50"
            data-testid="cache-select-all"
          >
            {allVisibleSelected ? (
              <CheckSquare className="h-3.5 w-3.5" />
            ) : (
              <Square className={cn('h-3.5 w-3.5', someVisibleSelected && 'text-accent')} />
            )}
            {t('tg.cacheSelectAll')}
          </button>
          <span className="text-[11px] text-fg-muted" data-testid="cache-selected-count">
            {t('tg.cacheSelectedCount', { n: selCount })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-[11px]"
            disabled={busy || selCount === 0}
            onClick={() => setConfirm({ kind: 'batch' })}
            data-testid="cache-delete-selected"
          >
            {t('tg.cacheDeleteSelected', { n: selCount })}
          </Button>
        </div>

        {/* 确认条：单条与批量的唯一提交口（不只是多一次点击，而是把「要删几条」写清楚） */}
        {confirm?.kind === 'batch' ? (
          <div
            className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
            data-testid="cache-confirm"
          >
            {/* 单条确认已内联到**该任务行**（BUG-078），这里只服务批量删除 */}
            {t('tg.cacheDeleteConfirmBatch', { n: selCount })}
            {selActiveCount > 0 ? (
              <span className="ml-1">{t('tg.cacheDeleteConfirmRunning')}</span>
            ) : null}
            <div className="mt-1.5 flex justify-end gap-2">
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                disabled={busy}
                onClick={() => {
                  setConfirm(null)
                  void removeSelected()
                }}
                data-testid="cache-confirm-yes"
              >
                {t('tg.cacheDeleteConfirmYes')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => setConfirm(null)}
                data-testid="cache-confirm-no"
              >
                {t('tg.cacheDeleteConfirmNo')}
              </Button>
            </div>
          </div>
        ) : null}

        {err ? <p className="mt-2 text-xs text-red-500">{err}</p> : null}

        {/* 任务列表 */}
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {visible.map((task) => {
            const pct = task.total > 0 ? (task.done / task.total) * 100 : 0
            const active = ACTIVE_STATUS.has(task.status)
            const retryable = RETRYABLE.has(task.status)
            const single = task.groupId == null
            const on = sel.has(task.id)
            return (
              <div
                key={task.id}
                className={cn(
                  'rounded-md border bg-surface-2/40 p-2.5',
                  on ? 'border-accent/60 bg-accent/5' : 'border-border-subtle',
                )}
                data-testid="cache-task-row"
                data-selected={on ? 'true' : undefined}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={t('tg.cacheSelectRow')}
                      onClick={() => toggle(task.id)}
                      className="shrink-0 rounded p-0.5 text-fg-mid hover:bg-surface-2"
                      data-testid={`cache-task-check-${task.id}`}
                    >
                      {on ? (
                        <CheckSquare className="h-3.5 w-3.5 text-accent" />
                      ) : (
                        <Square className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                        STATUS_STYLE[task.status],
                      )}
                    >
                      {t(STATUS_KEY[task.status])}
                    </span>
                    <span className="truncate text-xs text-fg-strong">
                      {titleOf(task.chatId) ?? `频道 ${task.chatId}`} ·{' '}
                      {single ? t('tg.cacheScopeSingle') : t('tg.cacheScopeGroup')} ·{' '}
                      {t('tg.cacheCountUnit', { n: task.messageIds.length })}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act(() => cancelCacheTask(task.id))}
                        data-testid="cache-task-cancel"
                      >
                        {t('tg.cacheCancel')}
                      </Button>
                    ) : null}
                    {retryable ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('tg.cacheRetry')}
                        aria-label={t('tg.cacheRetry')}
                        disabled={busy}
                        onClick={() => void retry(task)}
                        data-testid="cache-task-retry"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'one', id: task.id })}
                      data-testid="cache-task-delete"
                    >
                      {t('tg.cacheDelete')}
                    </Button>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <Progress
                    value={pct}
                    animated={task.status === 'running'}
                    smoothMs={4800}
                    className="flex-1"
                  />
                  <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
                    {task.done}/{task.total}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-muted">
                    {fmtWhen(task.updatedAt)}
                  </span>
                </div>
                {active && task.currentId != null ? (
                  <p className="mt-1 text-[11px] text-fg-muted">
                    {t('tg.cacheCurrentMsg', { id: task.currentId })}
                  </p>
                ) : null}
                {task.status === 'failed' && task.error ? (
                  <p className="mt-1 truncate text-[11px] text-red-500" title={task.error}>
                    {task.error}
                  </p>
                ) : null}
                {/* 单条删除确认内联到当前任务下（BUG-078）：点删除不再在面板顶部弹框，
                    而是紧贴该任务行——用户清楚「删的是哪一条」。批量删除仍走顶部确认条。 */}
                {confirm?.kind === 'one' && confirm.id === task.id ? (
                  <div
                    className="mt-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
                    data-testid="cache-confirm-inline"
                  >
                    {t('tg.cacheDeleteConfirmOne')}
                    {ACTIVE_STATUS.has(task.status) ? (
                      <span className="ml-1">{t('tg.cacheDeleteConfirmRunning')}</span>
                    ) : null}
                    <div className="mt-1.5 flex justify-end gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={busy}
                        onClick={() => {
                          setConfirm(null)
                          void removeOne(task.id)
                        }}
                        data-testid="cache-confirm-inline-yes"
                      >
                        {t('tg.cacheDeleteConfirmYes')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-[11px]"
                        onClick={() => setConfirm(null)}
                        data-testid="cache-confirm-inline-no"
                      >
                        {t('tg.cacheDeleteConfirmNo')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
          {!loading && visible.length === 0 ? (
            <div className="flex h-24 items-center justify-center text-xs text-fg-muted">
              {tasks.length === 0 ? t('tg.cacheTaskHint') : t('tg.cacheNoTasks')}
            </div>
          ) : null}
        </div>
          </>
        ) : (
          <CacheBytesPanel
            // 频道标题：条目明细只带 chatId（数字），不给标题就只能显示 `#-1002533442302`。
            chatTitleOf={titleOf}
            onChanged={() => {
              // 字节清掉后宿主读数会变（占用/文件数），必须重拉；任务记录不受影响但一起拉也就一次请求。
              sigRef.current = ''
              void load()
              onTasksChanged?.()
            }}
          />
        )}
      </div>
    </div>
  )
}
