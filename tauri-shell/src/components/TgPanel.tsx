import { useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import {
  tgHealth,
  listTgDialogs,
  listTgMonitoredChannels,
  addTgMonitoredChannel,
  removeTgMonitoredChannel,
  listTgMonitorMessages,
  syncTgMonitor,
  downloadTgMessage,
} from '../api/tg'
import type { TgChannel, TgStoredMessage } from '../types'
import { useStore } from '../store/useStore'

/** 未分组的内部键（避免与真实分组标题冲突） */
const UNGROUPED = '__ungrouped__'

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

interface Group {
  key: string
  label: string
  channels: TgChannel[]
}

/**
 * TG 频道内容（orig-tg 独立服务）。绑定后通过侧边栏「TG」Tab 进入。
 * 左栏按 TG 分组归类订阅频道（可折叠、可按分组过滤、可搜索），每条可勾选监控；
 * 右栏展示选中监控频道「已入库媒体」，支持立即同步、下载与系统播放器播放。
 */
export function TgPanel() {
  const { t } = useTranslation()
  const { setError } = useStore()
  const [alive, setAlive] = useState(false)
  const [channels, setChannels] = useState<TgChannel[]>([])
  const [monitored, setMonitored] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [stored, setStored] = useState<TgStoredMessage[]>([])
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [loadingStored, setLoadingStored] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [downloading, setDownloading] = useState<Set<number>>(new Set())
  const [downloadedPaths, setDownloadedPaths] = useState<Map<number, string>>(new Map())

  useEffect(() => {
    tgHealth()
      .then(() => setAlive(true))
      .catch(() => setAlive(false))
  }, [])

  useEffect(() => {
    if (!alive) return
    setLoadingChannels(true)
    listTgDialogs()
      .then(setChannels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingChannels(false))
    listTgMonitoredChannels()
      .then((list) => setMonitored(new Set(list.map((c) => c.channelId))))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [alive, setError])

  /** 选中频道 → 若是监控频道，拉取已入库媒体 */
  useEffect(() => {
    if (selectedId === null || !monitored.has(selectedId)) {
      setStored([])
      return
    }
    let cancelled = false
    setLoadingStored(true)
    listTgMonitorMessages(selectedId)
      .then((list) => {
        if (!cancelled) setStored(list)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoadingStored(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, monitored, setError])

  /** 搜索 + 分组过滤后的分组列表（未分组置底） */
  const groups: Group[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    const visible = channels.filter(
      (ch) =>
        (q === '' ||
          ch.title.toLowerCase().includes(q) ||
          (ch.username ?? '').toLowerCase().includes(q)) &&
        (filter === 'all' ||
          (filter === UNGROUPED && !ch.folder) ||
          (filter !== UNGROUPED && ch.folder === filter)),
    )
    const map = new Map<string, Group>()
    for (const ch of visible) {
      const key = ch.folder ?? UNGROUPED
      if (!map.has(key)) map.set(key, { key, label: ch.folder ?? t('tg.ungrouped'), channels: [] })
      map.get(key)!.channels.push(ch)
    }
    return [...map.values()].sort(
      (a, b) => Number(a.key === UNGROUPED) - Number(b.key === UNGROUPED),
    )
  }, [channels, search, filter, t])

  /** 折叠/展开分组（默认展开） */
  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 勾选/取消监控某频道 */
  const toggleMonitor = async (ch: TgChannel) => {
    const isMon = monitored.has(ch.id)
    try {
      if (isMon) {
        await removeTgMonitoredChannel(ch.id)
        setMonitored((prev) => {
          const next = new Set(prev)
          next.delete(ch.id)
          return next
        })
        if (selectedId === ch.id) setStored([])
      } else {
        await addTgMonitoredChannel({
          channelId: ch.id,
          title: ch.title,
          username: ch.username,
        })
        setMonitored((prev) => new Set(prev).add(ch.id))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 立即同步：触发一轮增量入库，然后刷新当前选中频道的入库媒体 */
  const doSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await syncTgMonitor()
      if (selectedId !== null && monitored.has(selectedId)) {
        const list = await listTgMonitorMessages(selectedId)
        setStored(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  /** 下载已入库媒体，成功后记录本地路径用于播放 */
  const doStoredDownload = async (msg: TgStoredMessage) => {
    setDownloading((s) => new Set(s).add(msg.messageId))
    try {
      const { path } = await downloadTgMessage(msg.channelId, msg.messageId)
      setDownloadedPaths((prev) => new Map(prev).set(msg.messageId, path))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloading((s) => {
        const next = new Set(s)
        next.delete(msg.messageId)
        return next
      })
    }
  }

  /** 用系统默认播放器打开已下载文件 */
  const playStored = async (msg: TgStoredMessage) => {
    const path = downloadedPaths.get(msg.messageId)
    if (!path) {
      setError(t('tg.noMessages'))
      return
    }
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(path)
    } catch (e) {
      console.error('openPath failed', e)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const selectChannel = (id: number) => {
    setSelectedId(id === selectedId ? null : id)
  }

  const selectedMonitored = selectedId !== null && monitored.has(selectedId)

  return (
    <div className="flex h-full min-h-0">
      {/* 左栏：分组频道列表 */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-surface/40">
        <div className="border-b border-border-subtle/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-fg-strong">{t('tg.heading')}</h2>
            <span
              className={cn('h-2 w-2 rounded-full', alive ? 'bg-success' : 'bg-danger')}
            />
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[11px] text-muted">{t('tg.sub')}</p>
            {monitored.size > 0 && (
              <Badge variant="secondary" className="text-[9px]">
                {t('tg.monitoredCount', { n: monitored.size })}
              </Badge>
            )}
          </div>
        </div>

        <div className="space-y-2 border-b border-border-subtle/60 p-2">
          {/* 分组过滤 */}
          <div className="flex flex-wrap gap-1.5">
            {[
              { key: 'all', label: t('tg.filterAll') },
              ...groups.map((g) => ({ key: g.key, label: g.label })),
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => setFilter(opt.key)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                  filter === opt.key
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-fg-mid hover:bg-surface-2/70',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tg.searchPlaceholder')}
            className="h-8 text-xs"
          />
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={doSync}
            disabled={syncing || monitored.size === 0}
          >
            {syncing ? t('tg.syncing') : t('tg.sync')}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loadingChannels && (
            <p className="px-2 py-2 text-xs text-muted">{t('tg.loadingChannels')}</p>
          )}
          {!loadingChannels && channels.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted">
              {alive ? t('tg.noChannels') : t('tg.offline')}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.key} className="mb-1">
              <button
                onClick={() => toggleGroup(g.key)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted hover:bg-surface-2/70"
              >
                <svg
                  className={cn(
                    'h-3 w-3 shrink-0 transition-transform',
                    collapsed.has(g.key) && '-rotate-90',
                  )}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                </svg>
                <span className="truncate">{g.label}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted">{g.channels.length}</span>
              </button>
              {!collapsed.has(g.key) &&
                g.channels.map((ch) => (
                  <div
                    key={ch.id}
                    className={cn(
                      'group flex items-center gap-1 rounded-md pr-1.5 transition-colors',
                      selectedId === ch.id ? 'bg-accent/10' : 'hover:bg-surface-2/70',
                    )}
                  >
                    <button
                      onClick={() => selectChannel(ch.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                    >
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
                        {(ch.title || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-fg-strong">
                          {ch.title}
                        </p>
                        {ch.username && (
                          <p className="truncate text-[10px] text-muted">@{ch.username}</p>
                        )}
                      </div>
                    </button>
                    <Switch
                      checked={monitored.has(ch.id)}
                      onChange={() => toggleMonitor(ch)}
                      id={`monitor-${ch.id}`}
                    />
                  </div>
                ))}
            </div>
          ))}
        </div>
      </aside>

      {/* 右栏：选中频道的已入库媒体 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {selectedId === null ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.selectChannel')}</p>
        ) : !selectedMonitored ? (
          <div className="mx-auto max-w-xl pt-10 text-center">
            <p className="text-sm text-muted">{t('tg.notMonitored')}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                const ch = channels.find((c) => c.id === selectedId)
                if (ch) toggleMonitor(ch)
              }}
            >
              {t('tg.addMonitor')}
            </Button>
          </div>
        ) : loadingStored ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.loadingMonitor')}</p>
        ) : stored.length === 0 ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.noStored')}</p>
        ) : (
          <div className="mx-auto max-w-3xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg-strong">{t('tg.storedHeading')}</h3>
              <Badge variant="secondary" className="text-[10px]">
                {stored.length}
              </Badge>
            </div>
            <div className="space-y-2">
              {stored.map((m) => {
                const hasPath = downloadedPaths.has(m.messageId)
                return (
                  <div
                    key={m.messageId}
                    className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-fg-strong">
                        {m.caption || `#${m.messageId}`}
                      </p>
                      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                        <span className="font-mono text-[10px] text-muted">#{m.messageId}</span>
                        {m.mimeType && (
                          <Badge variant="secondary" className="text-[9px]">
                            {m.mimeType}
                          </Badge>
                        )}
                        <span>{fmtSize(m.size)}</span>
                        {(m.downloaded || hasPath) && (
                          <Badge variant="success" className="text-[9px]">
                            {t('tg.downloaded')}
                          </Badge>
                        )}
                      </p>
                    </div>
                    {hasPath ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => playStored(m)}
                      >
                        {t('tg.play')}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={downloading.has(m.messageId)}
                        onClick={() => doStoredDownload(m)}
                      >
                        {downloading.has(m.messageId) ? '…' : t('tg.download')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
