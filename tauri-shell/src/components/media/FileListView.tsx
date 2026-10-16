import { memo, useCallback } from 'react'
import type { MediaItem } from '../../api/media'
import { kindLabelKey } from '../../api/media'
import { useTranslation } from '../../i18n'
import { resolveDisplayName } from '../../lib/displayName'
import { isTauri } from '../../lib/env'
import { VirtualList } from '../ui/virtual-list'
// 媒体库组件的格式化/来源工具一律从 mediaSources 取（该文件是唯一 import
// `lib/tgmedia` 的地方，通用工具已在其中 re-export）——与本目录其他组件同一纪律。
import { fmtDate, fmtSize, hasMediaBytes, sourceLabelKey } from '../../lib/mediaSources'

/**
 * **文件列表（Explorer 显示）** —— 文件域父行（全部文件）的唯一呈现形态。
 *
 * 2026-10-15 用户裁定（BUG-299「设计基础违反定性」）：「文件管理是列表，是
 * Explorer 显示，但绝对不可能是视频」。据此：
 *
 * - 「全部文件」（`cat-all`）渲染**行**：类型图标 + 名称 + 类型 + 大小 + 日期 +
 *   来源 + 行内动作（打开目录 / 删除）—— Explorer 语义，不是海报墙；
 * - 海报墙（`MediaCard`）降为「视频」等分类子集的视图，**不再是域的默认定义**；
 * - 媒体行仍可播放：双击行 = 打开全局播放器（视频/图片/音频行为与网格一致）。
 *
 * 交互取 Explorer 常识而非本仓旧例：**单击选中、双击打开**；复选框常驻可见
 * （BUG-040：入口禁纯 hover 显形）。删除走父级确认路径（含字节联动）。
 *
 * 非媒体成品（zip/exe/pdf）当前尚未进入数据源（BUG-299 M2-T00a/T01a 接入文件
 * 事实端点后本组件即承载它们）——本组件按「任意条目一视同仁」实现，不预设媒体。
 */

const KIND_ICON: Record<string, string> = {
  video: '🎬',
  photo: '🖼',
  audio: '🎵',
  file: '📄',
}

/** 类型徽标：未知类型不画（显示一个错的类型比不显示更糟，同 MediaCard 口径）。 */
function kindIcon(kind: string): string {
  return KIND_ICON[kind] ?? KIND_ICON.file
}

export interface FileListViewProps {
  items: MediaItem[]
  /** 选中集（item id）—— 与父面板批量工具栏同一个源。 */
  selected: Set<number>
  /** 列表总条数（分页提示用）。 */
  total: number
  onSelectToggle: (id: number, shiftKey: boolean) => void
  /** 双击行（或「打开」按钮）：媒体进全局播放器。 */
  onOpen: (item: MediaItem) => void
  /** 行内删除（父级弹确认，含字节联动）。 */
  onDelete: (item: MediaItem) => void
  /** 错误上报（打开目录失败等，走父级 error 通道）。 */
  onError?: (msg: string) => void
}

/**
 * 单行。`memo` 化（BUG-026 流畅优先）：窗口化后每刻只渲染视口 ± overscan 行
 * （BUG-316 段②），但每次滚动进出窗口仍会重挂整行；复选框/图标都是纯展示，
 * 没必要跟着父面板任何 setState 重算。
 */
const FileRow = memo(function FileRow(props: {
  item: MediaItem
  selected: boolean
  onSelectToggle: (id: number, shiftKey: boolean) => void
  onOpen: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
  onReveal?: (item: MediaItem) => void
}) {
  const { t } = useTranslation()
  const { item, selected, onSelectToggle, onOpen, onDelete, onReveal } = props
  const name = resolveDisplayName({ item })
  const fullPath = item.absolutePath ?? item.filePath ?? ''
  const hasBytes = hasMediaBytes(item)
  const icon = kindIcon(item.kind)

  const reveal = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onReveal?.(item)
    },
    [item, onReveal],
  )
  const del = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onDelete(item)
    },
    [item, onDelete],
  )
  const open = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onOpen(item)
    },
    [item, onOpen],
  )

  return (
    <div
      role="row"
      data-testid="file-list-row"
      data-item-id={item.id}
      // 可证伪锚点：来源列的真实语义必须落在 DOM 上（验收数「下载成品行」用；
      // 只靠文案列会让脚本退化成字符串匹配——名字里带「下载」就会误计）。
      data-source={item.source}
      data-selected={selected ? 'true' : undefined}
      className={[
        'grid grid-cols-[20px_24px_minmax(0,1fr)_64px_88px_104px_64px_auto] items-center gap-2',
        'border-b border-border-subtle/40 px-2 py-1.5 text-[12px] cursor-default select-none',
        selected ? 'bg-accent/10' : 'hover:bg-surface-2/60',
      ].join(' ')}
      onClick={(e) => onSelectToggle(item.id, e.shiftKey)}
      onDoubleClick={() => onOpen(item)}
      title={fullPath || undefined}
    >
      {/* 复选框常驻可见（BUG-040：禁纯 hover 显形） */}
      <input
        type="checkbox"
        aria-label={t('media.fileList.select', { name })}
        checked={selected}
        onChange={() => onSelectToggle(item.id, false)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer"
        data-testid={`file-list-check-${item.id}`}
      />
      <span className="shrink-0 text-center text-[13px] leading-none" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 truncate text-fg-strong" title={name}>
        {name}
        {!hasBytes ? (
          <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-muted">
            {t('media.fileList.missing')}
          </span>
        ) : null}
      </span>
      <span className="truncate text-muted">{t(kindLabelKey(item.kind) ?? 'media.kindFile')}</span>
      <span className="text-right tabular-nums text-muted">{fmtSize(item.size)}</span>
      <span className="tabular-nums text-muted">{fmtDate(item.addedAt)}</span>
      <span className="truncate text-[11px] text-muted">{t(sourceLabelKey(item.source))}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
          onClick={open}
          title={t('media.fileList.open')}
          data-testid={`file-list-open-${item.id}`}
        >
          {t('media.fileList.open')}
        </button>
        {onReveal ? (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
            onClick={reveal}
            title={t('media.fileList.openDir')}
            data-testid={`file-list-reveal-${item.id}`}
          >
            {t('media.fileList.openDir')}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-destructive"
          onClick={del}
          title={t('media.delete')}
          data-testid={`file-list-delete-${item.id}`}
        >
          {t('media.delete')}
        </button>
      </span>
    </div>
  )
})

export function FileListView(props: FileListViewProps) {
  const { t } = useTranslation()
  const { items, selected, total, onSelectToggle, onOpen, onDelete, onError } = props

  /**
   * 「打开目录」（BUG-299 出口判据 7：文件域行内物理定位）。
   * 与 `DownloadItem` 同一通道：Tauri 桌面壳内 `revealItemInDir`（打开所在文件夹
   * 并选中文件）；网页调试模式无该通道，如实报错给父级 error（不静默失败）。
   */
  const reveal = useCallback(
    (item: MediaItem) => {
      const p = item.absolutePath ?? item.filePath
      if (!p) {
        onError?.(t('media.fileList.noPath'))
        return
      }
      if (!isTauri()) {
        onError?.(t('media.fileList.openDirWebUnsupported'))
        return
      }
      void (async () => {
        try {
          const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
          await revealItemInDir(p)
        } catch (e) {
          onError?.(`${t('media.fileList.openDir')}${t('media.fileList.failed')}: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    [onError, t],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-list">
      {/* 列头（Explorer 明细视图的列名行） */}
      <div
        role="row"
        data-testid="file-list-header"
        className="grid grid-cols-[20px_24px_minmax(0,1fr)_64px_88px_104px_64px_auto] items-center gap-2 border-b border-border-subtle px-2 py-1.5 text-[11px] font-medium text-muted"
      >
        <span />
        <span />
        <span>{t('media.fileList.name')}</span>
        <span>{t('media.fileList.kind')}</span>
        <span className="text-right">{t('media.fileList.size')}</span>
        <span>{t('media.fileList.date')}</span>
        <span>{t('media.fileList.source')}</span>
        <span />
      </div>
      {/*
        窗口化（BUG-316 段②）：cat-all 实测 671 行全量同步渲染 ⇒ 单次 longtask
        ~230ms。行高实测 34px 均匀（bug316_row_geometry 探针），estimate 取实测值；
        overscan 10 行 ≈ 340px 快滚缓冲。契约：容器 data-total = items.length
        （验收脚本据此断言「渲染行数 < 总数」——全量渲染必 FAIL）。
      */}
      <VirtualList
        className="min-h-0 flex-1 overflow-y-auto"
        testId="file-list-scroll"
        items={items}
        estimate={34}
        overscan={10}
        keyOf={(item) => item.id}
        renderItem={(item) => (
          <FileRow
            item={item}
            selected={selected.has(item.id)}
            onSelectToggle={onSelectToggle}
            onOpen={onOpen}
            onDelete={onDelete}
            onReveal={reveal}
          />
        )}
      />
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle/40 px-2 py-1.5 text-[10px] text-muted/80">
        <span>{t('media.fileList.dblHint')}</span>
        {total > items.length ? <span>{t('media.showing', { n: items.length, total })}</span> : null}
      </div>
    </div>
  )
}
