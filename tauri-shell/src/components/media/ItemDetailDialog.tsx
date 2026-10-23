import { useEffect } from 'react'
import { useTranslation } from '../../i18n'
import type { MediaItem } from '../../api/media'
import { kindLabelKey, mediaItemUrl } from '../../api/media'
import type { FileFact } from '../../api/files'
import {
  coverFit,
  fmtDate,
  fmtSize,
  hasMediaBytes,
  parseSourceRef,
  sourceLabelKey,
} from '../../lib/mediaSources'
import { resolveDisplayName } from '../../lib/displayName'

/**
 * **内容详情**（BUG-403）—— 文件管理里单击一行的落地动作。
 *
 * 2026-10-23 用户裁定（原话）：「文件管理点击内容应显示详情与可操作功能，而非选中」。
 * 据此本仓**推翻** Explorer 的「单击选中、双击打开」旧例：
 *
 * - 单击行 = 打开本对话框（读信息 + 就地操作）；
 * - 选中只走复选框（显式动作），行不再因为一次点击变成选中态；
 * - 「双击打开」一并撤销 —— 单击已经弹了覆盖层，再叠一次播放会让用户看到两个
 *   东西同时出现。播放改成详情里的一个按钮，与「打开目录 / 在 TG 中查看 / 编辑 /
 *   删除」并列。
 *
 * 两种行都必须能开详情（`catAllRows` 是「已登记媒体 ∪ 受管成品」的并集）：
 * - 媒体条目（有 `media_item` 行）：可播放、可编辑标题/介绍/标签；
 * - 受管成品（`fileFact`，没有库行）：只能打开 / 定位 / 删除 —— 没有可编辑的库字段，
 *   所以「编辑」入口**不渲染**（渲染一个点了没反应的按钮比不渲染更糟，BUG-327 同族）。
 */
/**
 * 详情里的一行「标签：值」。值缺失时整行不画 —— 空行只会让用户以为字段丢了。
 *
 * 模块级定义：写在组件体内会让 React 每次渲染都当成**新组件类型**而整行重挂
 * （`Row` 是纯展示，重挂无功能损失，但会给覆盖层带来无谓的 unmount/remount）。
 */
function DetailRow({ label, value, title }: { label: string; value: string; title?: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-[11.5px]">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-all text-fg-strong" title={title ?? value}>
        {value}
      </span>
    </div>
  )
}

export function ItemDetailDialog(props: {
  item: MediaItem & { fileFact?: FileFact }
  onClose: () => void
  /** 播放（媒体）/ 交给系统默认程序打开（受管成品）。 */
  onOpen: (item: MediaItem) => void
  /** 打开所在目录并选中文件。 */
  onReveal: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
  /** 媒体条目才有：打开标题/介绍/标签编辑。 */
  onEdit?: (item: MediaItem) => void
  onViewInTg?: (coords: { chatId: number; messageId: number }) => void
}) {
  const { item, onClose, onOpen, onReveal, onDelete, onEdit, onViewInTg } = props
  const { t } = useTranslation()
  const fact = item.fileFact
  const name = fact?.name ?? resolveDisplayName({ item })
  const fullPath = fact?.path ?? item.absolutePath ?? item.filePath ?? ''
  const hasBytes = hasMediaBytes(item)
  const tgAt = parseSourceRef(item.ref, item.source)
  const kindText = fact
    ? fact.ext
      ? fact.ext.toUpperCase()
      : fact.category
    : t(kindLabelKey(item.kind) ?? 'media.kindFile')
  const seriesText = item.seriesTitle
    ? `${item.seriesTitle}${
        item.seriesEpisodeNo
          ? ` S${item.seriesSeason ?? 1}E${item.seriesEpisodeNo}${
              item.seriesEpisodeNoEnd && item.seriesEpisodeNoEnd !== item.seriesEpisodeNo
                ? `-${item.seriesEpisodeNoEnd}`
                : ''
            }`
          : ''
      }`
    : ''

  /**
   * Esc 关闭：覆盖层不响应 Esc 会被用户读成「卡住了」（详情是只读视图，
   * 关闭没有任何副作用，不需要二次确认）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-y-auto rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="item-detail-dialog"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 text-base font-semibold text-fg-strong" data-testid="item-detail-name">
            {name}
          </h2>
          <button
            type="button"
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
            onClick={onClose}
            data-testid="item-detail-close"
          >
            {t('media.itemDetail.close')}
          </button>
        </div>

        <div className="mt-3 flex gap-3">
          <div className="h-24 w-40 shrink-0 overflow-hidden rounded-md bg-surface-2">
            {fact ? (
              <span className="flex h-full w-full items-center justify-center text-2xl text-muted">
                📄
              </span>
            ) : item.kind === 'photo' ? (
              <img src={mediaItemUrl(item.id)} alt="" className="h-full w-full object-contain" />
            ) : item.poster ? (
              <img src={item.poster} alt="" className={`h-full w-full ${coverFit(item.kind)}`} />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-2xl text-muted">
                {item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '🎵' : '📄'}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <DetailRow label={t('media.item.kind')} value={kindText} />
            <DetailRow label={t('media.itemDetail.size')} value={fmtSize(fact ? fact.size : item.size)} />
            <DetailRow
              label={t('media.itemDetail.date')}
              value={fmtDate(fact ? fact.modified_at : item.addedAt)}
            />
            <DetailRow
              label={t('media.itemDetail.source')}
              value={fact ? t('media.itemDetail.fact') : t(sourceLabelKey(item.source))}
            />
            <DetailRow
              label={t('media.itemDetail.bytes')}
              value={hasBytes ? t('media.itemDetail.bytesPresent') : t('media.itemDetail.bytesMissing')}
            />
            {seriesText ? <DetailRow label={t('media.itemDetail.series')} value={seriesText} /> : null}
            {!fact && item.tags.length > 0 ? (
              <DetailRow
                label={t('media.itemDetail.tags')}
                value={item.tags.map((tag) => `#${tag.name}`).join(' ')}
              />
            ) : null}
            <DetailRow
              label={t('media.itemDetail.path')}
              value={fullPath || t('media.itemDetail.noPath')}
              title={fullPath}
            />
          </div>
        </div>

        {/* 操作区：详情即入口（BUG-403 的「可操作功能」）。 */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-3">
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onOpen(item)}
            disabled={!fact && !hasBytes}
            title={!fact && !hasBytes ? t('media.itemDetail.bytesMissing') : undefined}
            data-testid="item-detail-open"
          >
            {fact ? t('media.fileList.open') : t('media.itemDetail.play')}
          </button>
          <button
            type="button"
            className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-fg-strong hover:bg-surface-2"
            onClick={() => onReveal(item)}
            disabled={!fullPath}
            data-testid="item-detail-reveal"
          >
            {t('media.fileList.openDir')}
          </button>
          {tgAt && onViewInTg ? (
            <button
              type="button"
              className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-fg-strong hover:bg-surface-2"
              onClick={() => onViewInTg(tgAt)}
              data-testid="item-detail-view-tg"
            >
              {t('media.viewInTg')}
            </button>
          ) : null}
          {!fact && onEdit ? (
            <button
              type="button"
              className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-fg-strong hover:bg-surface-2"
              onClick={() => onEdit(item)}
              data-testid="item-detail-edit"
            >
              {t('media.itemDetail.edit')}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
            onClick={() => onDelete(item)}
            data-testid="item-detail-delete"
          >
            {t('media.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
