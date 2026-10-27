import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { listTgMonitoredChannels, removeTgMonitoredChannel } from '../api/tg'
import type { TgMonitoredChannel } from '../types'
import { useStore } from '../store/useStore'
import { cn } from '../lib/utils'

/**
 * 底部状态栏的 TG 监控态按钮（D1/D2/D3：fd 风格 = 单状态按钮 + 下拉明细）。
 *
 * - 单一状态按钮常驻状态栏，**不论数据量多大/多小都显示**（D3 硬约束）：
 *   0 个监控 → 显示「未监控」；有监控 → 「监控 N」；orig-tg 未运行 → 灰点 + 离线提示。
 * - 点击展开下拉：列出被监控频道、各自回溯进度（backfillUntil 目标 + 进行中态）、
 *   以及「取消监控」动作（BUG-454 同源纪律：动作只做取消，不在此处另开监控流程，
 *   添加仍在 TG 视图，避免双入口分裂）。
 * - 自有低频轮询（8s，仅展开时），与 TgPanel 内的监控列表**各取各的**——
 *   状态栏是全局常驻入口、TgPanel 是管理面，二者读同一端点但互不耦合，
 *   避免把轮询塞进已很重的 MainLayout 单一轮询点（那只负责入库概览）。
 */

const POLL_MS = 8000

function fmtDate(unixSec: number): string {
  if (!unixSec) return '—'
  const d = new Date(unixSec * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const StatusBarMonitor = memo(function StatusBarMonitor() {
  const { t } = useTranslation()
  const [list, setList] = useState<TgMonitoredChannel[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tgRunning = useStore((s) => s.tgService.running)
  const tgLastError = useStore((s) => s.tgService.lastError)

  const load = async () => {
    try {
      const m = await listTgMonitoredChannels()
      setList(m)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!tgRunning) {
      setList([])
      return
    }
    if (open) void load()
    const id = setInterval(() => {
      if (open) void load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [tgRunning, open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const unmonitor = async (ch: TgMonitoredChannel) => {
    setBusy(ch.channelId)
    try {
      await removeTgMonitoredChannel(ch.channelId)
      setList((prev) => prev.filter((c) => c.channelId !== ch.channelId))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const n = list.length
  const dot = !tgRunning
    ? 'bg-muted'
    : tgLastError
      ? 'bg-amber-400'
      : n > 0
        ? 'bg-accent'
        : 'bg-muted'

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('statusbar.monitorTitle', { n })}
        className="flex h-6 items-center gap-1 rounded border border-border-subtle px-1.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-strong"
        data-testid="statusbar-monitor"
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
        {n > 0 ? t('statusbar.monitorCount', { n }) : t('statusbar.monitorNone')}
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-lg border border-border-subtle bg-surface p-2 text-xs shadow-lg">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="font-medium text-fg-strong">{t('statusbar.monitorDropdownTitle')}</span>
          </div>
          <p className="mb-1 px-1 text-[10px] text-muted">{t('statusbar.monitorHint')}</p>
          {err && <div className="px-1 py-1 text-[10px] text-danger">{err}</div>}
          {!tgRunning && (
            <div className="px-1 py-2 text-[11px] text-muted">{t('statusbar.monitorOffline')}</div>
          )}
          {tgRunning && list.length === 0 && !err && (
            <div className="px-1 py-2 text-[11px] text-muted">{t('statusbar.monitorEmpty')}</div>
          )}
          <ul className="max-h-64 overflow-auto">
            {list.map((ch) => (
              <li
                key={ch.channelId}
                className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-fg-strong">{ch.title}</p>
                  {ch.backfillUntil ? (
                    <p className="truncate text-[10px] text-muted">
                      {t('statusbar.monitorBackfill', { date: fmtDate(ch.backfillUntil) })}
                    </p>
                  ) : ch.newCount > 0 ? (
                    <p className="truncate text-[10px] text-accent">
                      {t('statusbar.monitorNew', { n: ch.newCount })}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={busy === ch.channelId}
                  onClick={() => void unmonitor(ch)}
                  title={t('statusbar.monitorUnmonitor')}
                  className="shrink-0 rounded px-1 text-[10px] text-muted hover:bg-danger/15 hover:text-danger disabled:opacity-50"
                  data-testid={`statusbar-monitor-unmonitor-${ch.channelId}`}
                >
                  {t('statusbar.monitorUnmonitor')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
})
