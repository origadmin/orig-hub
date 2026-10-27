import { useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { RowCheckbox } from '../../components/ui/selection-bar'
import {
  formatBytes,
  formatEta,
  formatSpeed,
} from '../../lib/utils'
import type { DownloadStatus } from '../../types'
import { useStore } from '../../store/useStore'
import { DownloadDetailSheet } from './DownloadDetailSheet'
import { isTauri } from '../../lib/env'
import { useTranslation } from '../../i18n'

const statusMeta: Record<
  string,
  { key: string; variant: 'success' | 'warning' | 'danger' | 'default' | 'secondary' }
> = {
  downloading: { key: 'download.item.status.downloading', variant: 'default' },
  queued: { key: 'download.item.status.queued', variant: 'secondary' },
  idle: { key: 'download.item.status.idle', variant: 'secondary' },
  paused: { key: 'download.item.status.paused', variant: 'warning' },
  completed: { key: 'download.item.status.completed', variant: 'success' },
  error: { key: 'download.item.status.error', variant: 'danger' },
  cancelled: { key: 'download.item.status.cancelled', variant: 'secondary' },
  // BUG-319 持久化引入的状态：进程消失留下的行。缺了它就会落进 `?? statusMeta.idle`
  // 而被渲染成「空闲」—— 那不是空闲，是没人再跑它了。
  interrupted: { key: 'download.item.status.interrupted', variant: 'warning' },
}

export function DownloadItem({
  item,
  selected = false,
  onToggleSelect,
}: {
  item: DownloadStatus
  /** 行级选中（BUG-353 下载域控制面） */
  selected?: boolean
  onToggleSelect?: (id: string) => void
}) {
  const { t } = useTranslation()
  const { pause, resume, cancel, retry, remove, setError } = useStore()
  const [sheetOpen, setSheetOpen] = useState(false)
  const meta = statusMeta[item.status] ?? statusMeta.idle
  const isActive = item.status === 'downloading'
  /**
   * 传输控制动词**只认后端下发的 `actions`**，不按 status 自己推。
   *
   * 为什么要这样：按 status 推等于把「哪个状态有哪些能力」这条契约复制进 UI，
   * 每加一个来源（未来的第 N 个协议/插件）就得改一遍这里；按 actions 渲染，
   * 新来源只在后端 `actions_for` 声明一次，本文件零改动。
   */
  const can = (a: string) => (item.actions ?? []).includes(a)
  /**
   * 停住的行（已中断 / 错误 / 已取消）：动作按钮**常驻可见**，不藏在 hover 后面。
   *
   * 在途行的按钮 hover 才显示是常规做法（平时不需要操作它）；但停住的行恰恰
   * 是「用户在等它、正要找按钮」的那一行 —— 把入口藏进 hover 就等于让用户在
   * 最需要它的时候看不见它（BUG-320 同型：入口存在但用户看不见 = 等于没有）。
   * 判定仍从 `actions` 推：不具备暂停/继续能力 ⇒ 不在途。
   */
  const stalled = !can('pause') && !can('resume')

  /** 用默认应用打开文件本身（completed 任务可用） */
  const handleReveal = async () => {
    if (!item.dest_path) {
      setError(t('download.item.errPathMissingOpen'))
      return
    }
    // BUG-286：纯浏览器里 plugin-shell 的 IPC 桥是 undefined，裸调会把 raw 异常上屏。
    if (!isTauri()) {
      setError(t('download.item.errOpenNonTauri'))
      return
    }
    try {
      // shell:allow-open（与 daemon sidecar 同套授权，已验证可用）——直接打开文件本体，无需解析路径
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(item.dest_path)
    } catch (e) {
      console.error('open file failed', e)
      setError(t('download.item.errOpenFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  /** 在资源管理器中打开文件所在目录（completed 任务可用） */
  const handleOpenDir = async () => {
    if (!item.dest_path) {
      setError(t('download.item.errPathMissingDir'))
      return
    }
    // BUG-286：同上 —— 没有 opener 通道时不调 revealItemInDir。
    if (!isTauri()) {
      setError(t('download.item.errOpenDirNonTauri'))
      return
    }
    try {
      // revealItemInDir 直接吃完整文件路径、打开其所在文件夹并选中文件，
      // 完全不需要手写的 slice/regex 去解析父目录（那正是上一版在分隔符/尾斜杠/空格目录下算错、导致 open 失败的根因）。
      // 权限 allow-reveal-item-in-dir 已确认嵌进二进制且「打开文件」按钮一直用它、从未报坏。
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      await revealItemInDir(item.dest_path)
    } catch (e) {
      console.error('open dir failed', e)
      setError(t('download.item.errOpenDirFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <div
      data-testid="download-item"
      data-status={item.status}
      data-fid={item.id}
      data-selected={selected ? '1' : '0'}
      className={
        'group cursor-pointer rounded-lg border bg-surface p-4 transition-all duration-200 hover:border-accent/40 hover:bg-surface/80 ' +
        (selected ? 'border-accent/60 bg-accent/5' : 'border-border-subtle')
      }
      onClick={() => setSheetOpen(true)}
      title={t('download.item.titleDetail')}
    >
      <div className="flex items-start justify-between gap-3">
        {/* 行级选中（BUG-353）：点击只切换选中态、不打开详情 Sheet。 */}
        <label
          className="mt-0.5 flex shrink-0 cursor-pointer items-center"
          onClick={(e) => e.stopPropagation()}
          title={t('download.item.titleSelect')}
        >
          {/* BUG-393：行选择框走全仓标准组件（尺寸/配色只有一处定义）。 */}
          <RowCheckbox
            checked={!!selected}
            onChange={() => onToggleSelect?.(item.id)}
            testId="download-item-select"
            ariaLabel={t('download.item.ariaSelect')}
          />
        </label>
        {/* 文件名 + URL */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-fg-strong">
              {item.filename || t('download.detail.unknownFile')}
            </p>
            <Badge variant={meta.variant}>{t(meta.key)}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted" title={item.url}>
            {item.url}
          </p>
        </div>

        {/* 操作按钮（图标+文字）；stopPropagation 避免触发详情。
            终态行（stalled：既无 pause 也无 resume 可点）必须常驻可见 ——
            用户正要找「重试」时它却藏在 hover 后面，等于入口不存在。 */}
        <div
          className={
            'flex shrink-0 items-center gap-1 transition-opacity ' +
            (stalled ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')
          }
          onClick={(e) => e.stopPropagation()}
        >
          {can('pause') && (
            <Button size="sm" variant="ghost" onClick={() => pause(item.id)} title={t('download.item.pause')}>
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14M16 5v14" />
              </svg>
              {t('download.item.pause')}
            </Button>
          )}
          {can('resume') && (
            <Button size="sm" variant="ghost" onClick={() => resume(item.id)} title={t('download.item.resume')}>
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86z" />
              </svg>
              {t('download.item.resume')}
            </Button>
          )}
          {can('cancel') && (
            <Button size="sm" variant="ghost" onClick={() => cancel(item.id)} title={t('download.item.cancel')}>
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 6 6 18M6 6l12 12" />
              </svg>
              {t('download.item.cancel')}
            </Button>
          )}
          {/**
           * BUG-322：停住的行（已中断 / 错误 / 已取消）的重试入口。
           * title 明说「整任务重跑」—— 引擎无真续传，含糊成「继续」就是假能力。
           */}
          {can('retry') && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="download-retry"
              onClick={() => retry(item.id)}
              title={t('download.item.retryTitle')}
            >
              <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
              </svg>
              {t('download.item.retry')}
            </Button>
          )}
          {/**
           * 删除**不属于** `actions` 契约（契约刻意不含删除：删下载 = 删用户资产，
           * 与传输控制不是一类事），故这里仍按状态判定 —— 但必须覆盖 `interrupted`，
           * 否则中断的行既不能重试也删不掉，成了卡在列表里的死行。
           */}
          {(item.status === 'completed' ||
            item.status === 'error' ||
            item.status === 'cancelled' ||
            item.status === 'interrupted') && (
            <>
              {item.status === 'completed' && isTauri() && item.dest_path && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { void handleReveal(); }} title={t('download.item.revealTitle')}>
                    <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
                    </svg>
                    {t('download.item.openFile')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { void handleOpenDir(); }} title={t('download.item.openDirTitle')}>
                    <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                    </svg>
                    {t('download.item.openDir')}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => remove(item.id)} title={t('download.item.delete')}>
                <svg className="mr-1 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                </svg>
                {t('download.item.delete')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div className="mt-3">
        <Progress value={item.progress} animated={isActive} />
      </div>

      {/* 元信息（全中文） */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-mono text-fg-mid">
          {formatBytes(item.downloaded)}
          {item.total_size > 0 && (
            <> / {formatBytes(item.total_size)}</>
          )}
        </span>
        <span className="font-mono text-accent">
          {isActive ? formatSpeed(item.speed) : '—'}
        </span>
        {isActive && item.eta > 0 && (
          <span className="font-mono">{t('download.detail.remaining', { eta: formatEta(item.eta) })}</span>
        )}
        {item.connections > 0 && (
          <span className="font-mono">{item.connections}{t('download.item.connectionsUnit')}</span>
        )}
        {item.blocks_total ? (
          <span className="font-mono">{item.blocks_done ?? 0}/{item.blocks_total}{t('download.item.blocksUnit')}</span>
        ) : null}
        {item.status === 'completed' && item.avg_speed > 0 && (
          <span className="font-mono">{t('download.item.avgSpeed', { speed: formatSpeed(item.avg_speed) })}</span>
        )}
        {item.error && (
          <span className="truncate text-danger" title={item.error}>
            {item.error}
          </span>
        )}
      </div>

      {/* 块进度 / 连接详情 → 移至底部详情 Sheet（整行点击打开） */}

      {sheetOpen && (
        <DownloadDetailSheet item={item} onClose={() => setSheetOpen(false)} />
      )}
    </div>
  )
}
