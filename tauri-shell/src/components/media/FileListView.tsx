import { memo, useCallback } from 'react'
import type { MediaItem } from '../../api/media'
import { kindLabelKey } from '../../api/media'
import { useTranslation } from '../../i18n'
import { resolveDisplayName } from '../../lib/displayName'
import { revealItemPath } from '../../lib/reveal'
import { cn } from '../../lib/utils'
import { VirtualList } from '../ui/virtual-list'
// 媒体库组件的格式化/来源工具一律从 mediaSources 取（该文件是唯一 import
// `lib/tgmedia` 的地方，通用工具已在其中 re-export）——与本目录其他组件同一纪律。
import { fmtDate, fmtSize, hasMediaBytes, parseSourceRef, sourceLabelKey } from '../../lib/mediaSources'

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
 * ⚠ **2026-10-23 用户裁定推翻上一条的「单击选中、双击打开」（BUG-403）**：
 * 「文件管理点击内容应显示详情与可操作功能，而非选中」。现行语义 =
 * **单击打开「内容详情」**（`ItemDetailDialog`：信息 + 播放/打开目录/在 TG 中查看/
 * 编辑/删除），**选中只走复选框**（显式动作）；「双击打开」一并撤销 —— 单击已经
 * 弹了覆盖层，再叠一次播放会同时出现两个东西，播放改为详情里的按钮。
 * 别按上面那句旧例改回去。
 *
 * 非媒体成品（zip/exe/pdf）当前尚未进入数据源（BUG-299 M2-T00a/T01a 接入文件
 * 事实端点后本组件即承载它们）——本组件按「任意条目一视同仁」实现，不预设媒体。
 */

/**
 * 排序值（与 `MediaListQuery.sort` 同一枚举；面板持有 state，本组件经列头驱动）。
 */
export type FilesSort = 'recent' | 'oldest' | 'title' | 'duration' | 'size'

/**
 * BUG-399（列头与行内容横向错位）的**结构性修复**：
 *
 * 列头与每一行**必须**是同一套列模板 —— 之前两边各写一份字面量相同的模板字符串，
 * 但列头末列是空 `<span/>`，`auto` 轨道塌成 **0px**，而行末列是真实动作按钮
 * （实测 212px）⇒ 名称列一头 812px 一头 589px，类型/大小/日期/来源全体错位；
 * 且各行动作列宽还随「在 TG 中查看」有无各自伸缩，**行与行也互不对齐**。
 * 修复：模板收敛为单一常量 + 动作列**定宽** 216px（实测最宽行动作簇 212px，
 * 留 4px 余量），簇内 `justify-end` 右贴齐 —— 头、行、行与行全部共线。
 */
const FILE_ROW_GRID =
  'grid grid-cols-[20px_24px_minmax(0,1fr)_64px_88px_104px_64px_216px] items-center gap-2'

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
  onSelectToggle: (id: number, shiftKey: boolean) => void
  /**
   * **单击行**（BUG-403）：打开内容详情。选中不再由行点击触发 —— 只有复选框能改选中。
   */
  onOpenDetail: (item: MediaItem) => void
  /** 行内「打开」按钮：媒体进全局播放器（受管成品交系统默认程序）。 */
  onOpen: (item: MediaItem) => void
  /** 行内删除（父级弹确认，含字节联动）。 */
  onDelete: (item: MediaItem) => void
  /** 错误上报（打开目录失败等，走父级 error 通道）。 */
  onError?: (msg: string) => void
  /**
   * BUG-400：排序状态由父面板持有（与分类网格的排序下拉同一 state），
   * 本组件经**列头点击**驱动（Explorer 语义：排序即列头交互）。
   */
  sort: FilesSort
  onSortChange: (s: FilesSort) => void
  /**
   * **选择模式**（任务 #9 / BUG-317 选择模式裁定）：面板里已有 ≥1 条被选中
   * 时为 true。此时行双击与「打开」按钮**不进入播放/系统打开** —— 与
   * MediaCard 封面同一口径（打开是覆盖层，会把隐形的选择上下文冲掉）。
   * 行单击 / 复选框 / 打开目录 / 删除不受影响。
   */
  selectionMode?: boolean
  /**
   * BUG-385：「在 TG 中查看」—— 行内应用内跳转（`setPendingTgFocus` + 切 TG 域）。
   * 只有 ref 能解析出 TG 坐标的行才渲染入口（`parseSourceRef` 门控），
   * 本地来源没有可跳的消息 ⇒ 不渲染（点了也没有坐标）。
   */
  onViewInTg?: (coords: { chatId: number; messageId: number }) => void
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
  onOpenDetail: (item: MediaItem) => void
  onOpen: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
  onReveal?: (item: MediaItem) => void
  selectionMode?: boolean
  onViewInTg?: (coords: { chatId: number; messageId: number }) => void
}) {
  const { t } = useTranslation()
  const { item, selected, onSelectToggle, onOpenDetail, onOpen, onDelete, onReveal, selectionMode = false, onViewInTg } = props
  const name = resolveDisplayName({ item })
  const fullPath = item.absolutePath ?? item.filePath ?? ''
  const hasBytes = hasMediaBytes(item)
  const icon = kindIcon(item.kind)
  // BUG-385：TG 坐标可解析才给跳转入口（本地/无 ref ⇒ 不渲染）。
  const tgAt = parseSourceRef(item.ref, item.source)

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
      if (selectionMode) return
      onOpen(item)
    },
    [item, onOpen, selectionMode],
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
        FILE_ROW_GRID,
        'border-b border-border-subtle/40 px-2 py-1.5 text-[12px] cursor-pointer select-none',
        selected ? 'bg-accent/10' : 'hover:bg-surface-2/60',
      ].join(' ')}
      // BUG-403：单击 = 看详情（不是选中）。选中只由复选框改；「双击打开」已撤销。
      onClick={() => onOpenDetail(item)}
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
      <span className="flex shrink-0 items-center justify-end gap-1">
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong disabled:cursor-not-allowed disabled:opacity-40"
          onClick={open}
          disabled={selectionMode}
          title={
            selectionMode
              ? t('media.fileList.openInSelection')
              : t('media.fileList.open')
          }
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
        {/* BUG-385：行级「在 TG 中查看」—— 文件域筛选结果的落地视图此前
            零跳转入口（items 网格按 BUG-307 设计锁不烤入、剧集链路入口在
            来源块），用户在「筛选 → 这一条」路径上回不到 TG 原消息。
            坐标不可解析（本地来源）⇒ 不渲染。 */}
        {tgAt && onViewInTg ? (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
            onClick={(e) => {
              e.stopPropagation()
              onViewInTg(tgAt)
            }}
            title={t('media.viewInTg')}
            data-testid={`file-list-view-tg-${item.id}`}
          >
            {t('media.viewInTg')}
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

/**
 * 列头排序按钮（BUG-400：Explorer 语义 —— 排序即列头交互，独立排序下拉撤销）。
 * 日期列是唯一的双向列：recent（最新在前）↔ oldest（最旧在前）点击互切；
 * 名称/大小是单键列（方向由后端定义），激活时高亮。
 * 模块级定义（组件体内定义会每渲染重挂 —— memo 失效）。
 */
const SortHeader = memo(function SortHeader(props: {
  label: string
  active: boolean
  /** 仅日期列给方向箭头（recent=↓ 最新在前 / oldest=↑ 最旧在前） */
  arrow?: 'asc' | 'desc'
  onClick: () => void
  testId: string
  className?: string
}) {
  const { label, active, arrow, onClick, testId, className } = props
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        'truncate rounded px-0.5 text-left hover:text-fg-strong',
        active && 'text-fg-strong',
        className,
      )}
      title={label}
    >
      {label}
      {arrow === 'desc' ? ' ↓' : arrow === 'asc' ? ' ↑' : ''}
    </button>
  )
})

export function FileListView(props: FileListViewProps) {
  const { t } = useTranslation()
  const {
    items,
    selected,
    onSelectToggle,
    onOpenDetail,
    onOpen,
    onDelete,
    onError,
    sort,
    onSortChange,
    selectionMode = false,
    onViewInTg,
  } = props

  /**
   * 「打开目录」（BUG-299 出口判据 7：文件域行内物理定位）。
   * 通道收口在 `lib/reveal`（网页调试模式无该通道，如实报错给父级 error，
   * 不静默失败）。
   */
  const reveal = useCallback(
    (item: MediaItem) => {
      const p = item.absolutePath ?? item.filePath
      if (!p) {
        onError?.(t('media.fileList.noPath'))
        return
      }
      void revealItemPath(p, {
        onError: (msg) => onError?.(msg),
        unsupported: t('media.fileList.openDirWebUnsupported'),
        failed: `${t('media.fileList.openDir')}${t('media.fileList.failed')}`,
      })
    },
    [onError, t],
  )

  /**
   * 列头排序按钮见模块级 `SortHeader`。
   */
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-list">
      {/*
        列头（Explorer 明细视图的列名行）。
        BUG-399 两处对齐修复：
        1. 列模板与行**同一常量**（FILE_ROW_GRID）—— 两份字面量必然漂移；
        2. `overflow-y-scroll [scrollbar-gutter:stable]` —— 行在滚动容器里，垂直
           滚动条吃掉 ~10px 宽度而列头在容器外，列头因此整体右偏。gutter stable
           让列头也预留同样的滚动条槽，两边轨道逐像素对齐（列头无纵向溢出，
           不画真实滚动条，只有等宽预留槽）。
      */}
      <div
        role="row"
        data-testid="file-list-header"
        className={cn(
          FILE_ROW_GRID,
          'overflow-y-scroll [scrollbar-gutter:stable] border-b border-border-subtle px-2 py-1.5 text-[11px] font-medium text-muted',
        )}
      >
        <span />
        <span />
        <SortHeader
          label={t('media.fileList.name')}
          active={sort === 'title'}
          onClick={() => onSortChange('title')}
          testId="file-sort-title"
        />
        <span>{t('media.fileList.kind')}</span>
        <SortHeader
          label={t('media.fileList.size')}
          active={sort === 'size'}
          onClick={() => onSortChange('size')}
          testId="file-sort-size"
          className="text-right"
        />
        <SortHeader
          label={t('media.fileList.date')}
          active={sort === 'recent' || sort === 'oldest'}
          arrow={sort === 'oldest' ? 'asc' : sort === 'recent' ? 'desc' : undefined}
          onClick={() => onSortChange(sort === 'recent' ? 'oldest' : 'recent')}
          testId="file-sort-date"
        />
        <span>{t('media.fileList.source')}</span>
        <span />
      </div>
      {/*
        窗口化（BUG-316 段②）：cat-all 实测 671 行全量同步渲染 ⇒ 单次 longtask
        ~230ms。行高实测 34px 均匀（bug316_row_geometry 探针），estimate 取实测值；
        overscan 10 行 ≈ 340px 快滚缓冲。契约：容器 data-total = items.length
        （验收脚本据此断言「渲染行数 < 总数」——全量渲染必 FAIL）。
        `[scrollbar-gutter:stable]`（BUG-399）：短列表（无滚动条）时也预留滚动条
        槽，行与列头在任何条数下都保持同宽轨道。
      */}
      <VirtualList
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
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
            onOpenDetail={onOpenDetail}
            onOpen={onOpen}
            onDelete={onDelete}
            onReveal={reveal}
            selectionMode={selectionMode}
            onViewInTg={onViewInTg}
          />
        )}
      />
    </div>
  )
}
