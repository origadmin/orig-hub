import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import {
  tgHealth,
  listTgDialogs,
  listTgMessages,
  downloadTgMessage,
} from '../api/tg'
import type { TgChannel, TgMediaItem } from '../types'
import { useStore } from '../store/useStore'

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

/**
 * TG 频道内容（orig-tg 独立服务）。绑定后通过侧边栏「TG」Tab 进入。
 * 左栏为订阅频道列表，右栏为该频道媒体消息；每条可手动下载。
 */
export function TgPanel() {
  const { t } = useTranslation()
  const { setError } = useStore()
  const [alive, setAlive] = useState(false)
  const [channels, setChannels] = useState<TgChannel[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [messages, setMessages] = useState<TgMediaItem[]>([])
  const [loading, setLoading] = useState({ channels: false, messages: false })
  const [downloading, setDownloading] = useState<Set<number>>(new Set())

  useEffect(() => {
    tgHealth()
      .then(() => setAlive(true))
      .catch(() => setAlive(false))
  }, [])

  useEffect(() => {
    if (!alive) return
    setLoading((p) => ({ ...p, channels: true }))
    listTgDialogs()
      .then((list) => setChannels(list))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading((p) => ({ ...p, channels: false })))
  }, [alive, setError])

  /** 选中频道 → 拉取该频道媒体消息 */
  const selectChannel = async (id: number) => {
    setSelectedId(id)
    setMessages([])
    setLoading((p) => ({ ...p, messages: true }))
    try {
      setMessages(await listTgMessages(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading((p) => ({ ...p, messages: false }))
    }
  }

  const doDownload = async (chatId: number | string, msgId: number) => {
    setDownloading((s) => new Set(s).add(msgId))
    try {
      await downloadTgMessage(chatId, msgId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloading((s) => {
        const next = new Set(s)
        next.delete(msgId)
        return next
      })
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左栏：频道列表 */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-surface/40">
        <div className="border-b border-border-subtle/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-fg-strong">{t('tg.heading')}</h2>
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                alive ? 'bg-success' : 'bg-danger',
              )}
            />
          </div>
          <p className="mt-0.5 text-[11px] text-muted">{t('tg.sub')}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading.channels && <p className="px-2 py-2 text-xs text-muted">{t('tg.loadingChannels')}</p>}
          {!loading.channels && channels.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted">{alive ? t('tg.noChannels') : t('tg.offline')}</p>
          )}
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => selectChannel(ch.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                selectedId === ch.id ? 'bg-accent/10 text-accent' : 'text-fg-mid hover:bg-surface-2/70',
              )}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
                {(ch.title || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{ch.title}</p>
                {ch.username && <p className="truncate text-[10px] text-muted">@{ch.username}</p>}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* 右栏：媒体消息 */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {selectedId === null ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.selectChannel')}</p>
        ) : loading.messages ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.loadingMessages')}</p>
        ) : messages.length === 0 ? (
          <p className="pt-6 text-center text-sm text-muted">{t('tg.noMessages')}</p>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-fg-strong">
                    {m.caption || `#${m.id}`}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                    <span className="font-mono text-[10px] text-muted">#{m.id}</span>
                    {m.mimeType && <Badge variant="secondary" className="text-[9px]">{m.mimeType}</Badge>}
                    <span>{fmtSize(m.size)}</span>
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={downloading.has(m.id)}
                  onClick={() => doDownload(selectedId, m.id)}
                >
                  {downloading.has(m.id) ? '…' : t('tg.download')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}