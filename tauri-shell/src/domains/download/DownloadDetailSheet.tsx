import { useEffect } from 'react'
import { Badge } from '../../components/ui/badge'
import { useStore } from '../../store/useStore'
import { cn, formatBytes, formatSpeed, formatEta } from '../../lib/utils'
import type { DownloadStatus } from '../../types'
import { useTranslation } from '../../i18n'

/** 状态词 → i18n key（统一语言，避免英文/中文混搭） */
const STATUS_KEY: Record<string, string> = {
  idle: 'download.detail.status.idle',
  queued: 'download.detail.status.queued',
  downloading: 'download.detail.status.downloading',
  paused: 'download.detail.status.paused',
  completed: 'download.detail.status.completed',
  error: 'download.detail.status.error',
  cancelled: 'download.detail.status.cancelled',
}

/** 连接（源）状态词 → i18n key */
const CONN_STATE_KEY: Record<string, string> = {
  idle: 'download.detail.connState.idle',
  downloading: 'download.detail.connState.downloading',
  error: 'download.detail.connState.error',
}

/** 网卡配色（按出现顺序分配；超过调色板长度则循环） */
const NIC_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#14b8a6',
  '#f59e0b',
  '#ec4899',
  '#0ea5e9',
  '#84cc16',
  '#f43f5e',
]

const UNASSIGNED = 255

export function DownloadDetailSheet({
  item,
  onClose,
}: {
  item: DownloadStatus
  onClose: () => void
}) {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { t } = useTranslation()
  const { downloads } = useStore()
  const statusLabel = t(STATUS_KEY[item.status] ?? STATUS_KEY.idle)

  // 源下标 → 网卡名 → 颜色
  const srcToIface = new Map<number, string>()
  for (const c of item.connections_detail ?? []) srcToIface.set(c.source_index, c.iface)
  const ifaces = Array.from(new Set((item.connections_detail ?? []).map((c) => c.iface)))
  const ifaceColor: Record<string, string> = {}
  ifaces.forEach((nic, i) => {
    ifaceColor[nic] = NIC_PALETTE[i % NIC_PALETTE.length]
  })

  // 全局聚合（仅一行小字，不重复画条）
  const active = downloads.filter(
    (d) => d.status === 'downloading' || d.status === 'queued',
  )
  const globalSpeed = active.reduce((s, d) => s + (d.speed || 0), 0)

  const showGrid = item.supports_range !== false && !!item.blocks_total && item.blocks_total > 0
  const blocks = item.blocks ?? []
  const hasArray = blocks.length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      // 阻止点击冒泡到外层下载卡片的 onClick（否则 X/遮罩关闭会被卡片的“重新打开”即时抵消，表现为“按钮无效”）
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[86vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-surface shadow-2xl">
        {/*
          表头：**标题必须是第一个元素**（BUG-374，用户第四次提出「标题不在第一行」）。
          此处删掉两样压在标题前面的东西：
          ① 顶部那条网卡配色渐变强调线 —— 它与 `IngestDetailSheet`（无此线）不一致，
             用户问「为什么有的有蓝色顶框,有的没有」并直言其丑陋，故**去掉**而不是
             给另一边加上（统一取向残缺更少的那一侧）；
          ② 抓手 `⠿` —— 它排在标题**前面**，且带 `title="拖拽"`，而 Sheet 根本不能拖，
             是一句「说了做不到」的提示（2026-10-20 已在入库侧清掉同一句谎言）。
        */}
        <div className="flex items-center gap-2 px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong">
            {item.filename || t('download.detail.unknownFile')}
          </p>
          <Badge>{statusLabel}</Badge>
          <button
            onClick={onClose}
            className="ml-1 rounded-md px-2 py-1 text-muted hover:bg-border-subtle"
            title={t('download.detail.close')}
          >
            ✕
          </button>
        </div>

        {/* 元信息行 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-xs text-muted">
          <span className="font-mono text-fg-mid">
            {formatBytes(item.downloaded)}
            {item.total_size > 0 && <> / {formatBytes(item.total_size)}</>}
          </span>
          <span className="font-mono text-accent">
            {item.status === 'downloading' ? formatSpeed(item.speed) : '—'}
          </span>
          {item.status === 'downloading' && item.eta > 0 && (
            <span className="font-mono">{t('download.detail.remaining', { eta: formatEta(item.eta) })}</span>
          )}
          <span className="font-mono">
            {item.blocks_total ?? 0}
            {t('download.detail.blocksUnit')}
            {item.blocks_total ? t('download.detail.perBlock', { size: formatBytes(Math.ceil((item.total_size || 0) / (item.blocks_total || 1))) }) : ''}
          </span>
        </div>

        {/* 该任务字节进度条 */}
        <div className="px-4 pb-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-border-subtle">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${Math.min(100, item.progress)}%` }}
            />
          </div>
        </div>

        {/* 主体：左块网格 / 右源表 */}
        <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-auto sm:flex-row sm:gap-0">
          {/* 左：块完成位图（颜色 = 负责网卡）；sm 下固定宽度，避免挤压右栏 */}
          <div className="w-full shrink-0 border-b border-border-subtle p-4 sm:w-[70%] sm:shrink-0 sm:border-b-0 sm:border-r">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {t('download.detail.blockBitmap')}
          </div>
          {showGrid ? (
            <>
              {hasArray ? (
                <div
                  className="flex max-h-56 flex-wrap gap-0.5 overflow-auto"
                  title={`${item.blocks_done ?? 0}/${item.blocks_total}${t('download.detail.blocksDone')} · ${item.blocks_pending ?? 0}${t('download.detail.blocksPending')}`}
                >
                    {blocks.map((st, i) => {
                      const src = item.block_source?.[i] ?? UNASSIGNED
                      const iface = src !== UNASSIGNED ? srcToIface.get(src) : undefined
                      const color = iface ? ifaceColor[iface] : undefined
                      if (!color) {
                        return (
                          <span
                            key={i}
                            className="h-2.5 w-2.5 rounded-[1px] bg-border-subtle"
                            title={t('download.detail.unassigned')}
                          />
                        )
                      }
                      const cls =
                        st === 3
                          ? 'ring-2 ring-danger'
                          : st === 2
                            ? ''
                            : st === 1
                              ? 'opacity-50'
                              : 'opacity-40'
                      return (
                        <span
                          key={i}
                          className={cn('h-2.5 w-2.5 rounded-[1px]', cls)}
                          style={{ backgroundColor: color }}
                          title={`${iface} · ${st === 2 ? t('download.detail.blockState.done') : st === 1 ? t('download.detail.blockState.downloading') : st === 3 ? t('download.detail.blockState.failed') : t('download.detail.blockState.pending')}`}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-muted">
                    {item.blocks_done ?? 0}/{item.blocks_total}
                    {t('download.detail.blocksDone')}
                    {item.blocks_pending ? ` · ${item.blocks_pending}${t('download.detail.blocksPending')}` : ''}
                  </div>
                )}

                {/* 图例：网卡色 + 状态样式 */}
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
                  {ifaces.map((nic) => (
                    <span key={nic} className="flex items-center gap-1">
                      <span
                        className="inline-block h-3 w-3 rounded-[1px]"
                        style={{ backgroundColor: ifaceColor[nic] }}
                      />
                      {nic}
                    </span>
                  ))}
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded-[1px] bg-border-subtle" />
                    {t('download.detail.unassigned')}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                  <span>{t('download.detail.legendSolid')}</span>
                  <span>{t('download.detail.legendTranslucent')}</span>
                  <span>{t('download.detail.legendFailed')}</span>
                </div>
                <div className="mt-2 text-[11px] text-muted">
                  {t('download.detail.legendNote')}
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-border-subtle/60 px-3 py-2 text-xs text-muted">
                {t('download.detail.singleStream')}
              </div>
            )}
          </div>

          {/* 右：源 / 网卡表 + 全局一行小字 */}
          <div className="min-w-0 flex-1 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {t('download.detail.sourceNic')}
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted">
                <th className="px-2 py-1 text-left font-semibold">{t('download.detail.colSource')}</th>
                <th className="px-2 py-1 text-left font-semibold">{t('download.detail.colNic')}</th>
                <th className="px-2 py-1 text-left font-semibold">{t('download.detail.colStatus')}</th>
                <th className="px-2 py-1 text-right font-semibold">{t('download.detail.colSpeed')}</th>
              </tr>
            </thead>
            <tbody>
              {(item.connections_detail ?? []).map((c) => (
                <tr key={c.id} className="border-t border-border-subtle">
                  <td className="px-2 py-1 font-mono text-fg-mid">{c.source_index}</td>
                  <td className="px-2 py-1 font-mono text-fg-mid">{c.iface}</td>
                  <td
                    className={cn(
                      'px-2 py-1 font-medium',
                      c.state === 'error' ? 'text-danger' : 'text-success',
                    )}
                  >
                    {t(CONN_STATE_KEY[c.state] ?? c.state)}
                  </td>
                    <td className="px-2 py-1 text-right font-mono text-fg-mid">
                      {formatSpeed(c.speed)}
                    </td>
                  </tr>
                ))}
                {(item.connections_detail ?? []).length === 0 && (
                  <tr>
                  <td colSpan={4} className="px-2 py-2 text-muted">
                    {t('download.detail.noSource')}
                  </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="mt-3 rounded-lg bg-border-subtle/60 px-3 py-2 text-[11px] text-muted">
              {t('download.detail.globalSpeed')}
              <span className="font-mono text-accent">{formatSpeed(globalSpeed)}</span>
              {' · '}
              {t('download.detail.taskCount')}
              <span className="font-mono text-fg-mid">{downloads.length}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
