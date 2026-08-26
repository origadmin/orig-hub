import { useEffect } from 'react'
import { Badge } from './ui/badge'
import { useStore } from '../store/useStore'
import { cn, formatBytes, formatSpeed, formatEta } from '../lib/utils'
import type { DownloadStatus } from '../types'

/** 状态词 → 中文（统一语言，避免英文/中文混搭） */
const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  completed: '已完成',
  error: '错误',
  cancelled: '已取消',
}

/** 连接（源）状态词 → 中文 */
const CONN_STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  downloading: '下载中',
  error: '错误',
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

  const { downloads } = useStore()
  const statusLabel = STATUS_LABEL[item.status] ?? STATUS_LABEL.idle

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
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[86vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-surface shadow-2xl">
        {/* 顶部细强调线（拖拽手柄暗示，内嵌无空洞） */}
        <div
          className="h-1 w-full"
          style={{
            background: `linear-gradient(90deg, ${NIC_PALETTE.slice(0, ifaces.length || 1).join(', ')})`,
          }}
        />

        {/* 表头：内嵌抓手 + 文件名 + 状态徽标 + 关闭 */}
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="select-none text-lg leading-none text-muted" title="拖拽">
            ⠿
          </span>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong">
            {item.filename || '未知文件'}
          </p>
          <Badge>{statusLabel}</Badge>
          <button
            onClick={onClose}
            className="ml-1 rounded-md px-2 py-1 text-muted hover:bg-border-subtle"
            title="关闭"
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
            <span className="font-mono">剩余 {formatEta(item.eta)}</span>
          )}
          <span className="font-mono">
            {item.blocks_total ?? 0} 块
            {item.blocks_total ? ` · 每块约 ${formatBytes(Math.ceil((item.total_size || 0) / (item.blocks_total || 1)))}` : ''}
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
          {/* 左：块完成位图（颜色 = 负责网卡） */}
          <div className="border-b border-border-subtle p-4 sm:border-b-0 sm:border-r">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              块完成位图（颜色 = 负责网卡）
            </div>
            {showGrid ? (
              <>
                {hasArray ? (
                  <div
                    className="flex max-h-56 flex-wrap gap-0.5 overflow-auto"
                    title={`${item.blocks_done ?? 0}/${item.blocks_total} 块完成 · ${item.blocks_pending ?? 0} 待下载`}
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
                            title="未分配"
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
                          title={`${iface} · ${st === 2 ? '完成' : st === 1 ? '下载中' : st === 3 ? '失败' : '待下载'}`}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <div className="font-mono text-xs text-muted">
                    {item.blocks_done ?? 0}/{item.blocks_total} 块完成
                    {item.blocks_pending ? ` · ${item.blocks_pending} 待下载` : ''}
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
                    未分配
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                  <span>■ 实色 = 完成</span>
                  <span>▢ 半透明 = 下载中</span>
                  <span>⛒ 红框 = 失败</span>
                </div>
                <div className="mt-2 text-[11px] text-muted">
                  完成 / 失败 / 待下载颜色统一为网卡色，仅用填充样式区分；未分配统一为灰色。
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-border-subtle/60 px-3 py-2 text-xs text-muted">
                单流模式（无分块）：以字节进度为准，不展示块网格。
              </div>
            )}
          </div>

          {/* 右：源 / 网卡表 + 全局一行小字 */}
          <div className="p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              源 / 网卡
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted">
                  <th className="px-2 py-1 text-left font-semibold">源#</th>
                  <th className="px-2 py-1 text-left font-semibold">网卡</th>
                  <th className="px-2 py-1 text-left font-semibold">状态</th>
                  <th className="px-2 py-1 text-right font-semibold">速度</th>
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
                      {CONN_STATE_LABEL[c.state] ?? c.state}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-fg-mid">
                      {formatSpeed(c.speed)}
                    </td>
                  </tr>
                ))}
                {(item.connections_detail ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-2 py-2 text-muted">
                      无源信息
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="mt-3 rounded-lg bg-border-subtle/60 px-3 py-2 text-[11px] text-muted">
              全局 · 总速度 <span className="font-mono text-accent">{formatSpeed(globalSpeed)}</span>
              {' · '}任务数 <span className="font-mono text-fg-mid">{downloads.length}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
