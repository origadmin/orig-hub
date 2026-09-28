import { useState } from 'react'
import { ChevronDown, ChevronUp, CloudOff, Image as ImageIcon, ImagePlus, Pencil, Play, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import type { EpisodeImageMeta, MediaEpisode, MediaSeriesDetail } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import {
  canRecacheFromSource,
  coverFit,
  fmtDuration,
  hasMediaBytes,
  sourceLabelKey,
} from '../../lib/mediaSources'
import {
  episodeSlotLabel,
  shouldRenderEpisodeDescription,
  shouldRenderEpisodeTitle,
} from '../../lib/episodePresentation'
import { EpisodeEditPanel } from './EpisodeEditPanel'
import { CoverImage } from './CoverImage'
import { useTranslation } from '../../i18n'

/** 展开态挂图横滚条的最大张数（超出后靠横滚，不再展开/收起） */
const IMAGE_TILE_LIMIT = 24
/** 挂图默认内联显示的张数；超出的折进「还有 N 张」切换按钮（≥ 4 张才出现） */
const IMAGE_INLINE = 3

/**
 * 单集**展开态**：这一集的全部信息位 + 全部操作。
 *
 * 块序**固定写死**（设计 §3.2 / 回归点 #11）：
 *   大封面 → 本集标题（R5 门控）→ 本集介绍（R2 门控）→ 挂图区 → 多源区 →
 *   操作区 → 来源 / 溯源
 *
 * 手风琴 ≤ 1 集 ⇒ 展开态是单集的**唯一焦点**；若块序随布局漂移，用户每次都要
 * 重新找「介绍在哪」。工程师不得调序。
 *
 * 操作区恒显（无字节时「播放」禁用 + `title` 说明，Q4）：能力可达性优先于外观整洁。
 */
export function EpisodeExpanded(props: {
  ep: MediaEpisode
  series: MediaSeriesDetail
  onEdit: () => void
  onEditClose: () => void
  /** 编辑保存成功：容器据此重取详情，避免页面停留在改前的旧文案 */
  onEditSaved: () => void
  editing: boolean
  onAttachImages: () => void
  onRemoveImage: (itemId: number) => void
  onMove: (dir: 'up' | 'down') => void
  onRemove: () => void
  onPlay: () => void
  onSwitchSource: (itemId: number) => void
  onDetachSource: (itemId: number) => void
  onRecache: () => void
  onGotoItem: () => void
  onOpenLightbox: (index: number) => void
  onError: (msg: string) => void
}) {
  const { t } = useTranslation()
  const { ep, series } = props
  const allImgs = ep.images ?? []
  /** 默认只露前 3 张，其余折进「还有 N 张」——一集挂十几张图时不能把展开块撑成图片墙。 */
  const [imgsExpanded, setImgsExpanded] = useState(false)
  const imgs = (imgsExpanded ? allImgs : allImgs.slice(0, IMAGE_INLINE)).slice(
    0,
    IMAGE_TILE_LIMIT,
  )
  const sources = ep.sources ?? []
  const withBytes = hasMediaBytes(ep)
  const recacheable = canRecacheFromSource(ep.source)
  const showTitle = shouldRenderEpisodeTitle(ep, series)
  const showDesc = shouldRenderEpisodeDescription(ep, series)

  return (
    <div className="flex flex-col gap-4" data-testid="episode-expanded">
      {/* ① 大封面（恒显） */}
      <div className="aspect-video w-full max-w-[480px] overflow-hidden rounded-lg bg-surface-2">
        {ep.poster ? (
          /* 竖版源图由 CoverImage 按实际方向兜底改判 contain（§3.1.1） */
          <CoverImage src={ep.poster} fit={coverFit(ep.kind)} className="h-full w-full" />
        ) : ep.kind === 'photo' ? (
          <CoverImage
            src={mediaItemUrl(ep.itemId)}
            kind="photo"
            fit="object-contain"
            className="h-full w-full"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <ImageIcon className="h-8 w-8" />
          </span>
        )}
      </div>

      {/* ② 本集标题（R5 门控；被隐藏时集号即主标识） */}
      {showTitle ? (
        <h4 className="text-[13px] font-semibold text-fg-strong [overflow-wrap:anywhere]">
          {ep.title}
        </h4>
      ) : (
        <h4 className="text-[13px] font-semibold text-muted">{episodeSlotLabel(ep)}</h4>
      )}

      {/* ③ 本集介绍（R2 门控）。被隐藏 = 与剧集介绍逐字相同，剧集头那份承担显示。 */}
      {showDesc ? (
        <p className="max-w-prose whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11.5px] leading-relaxed text-muted">
          {ep.description}
        </p>
      ) : (
        <p className="text-[11.5px] text-muted/70">{t('media.descEmptyEp')}</p>
      )}

      {/* ④ 挂图区：横滚瓦片；点某张开灯箱（范围 = 本集全部挂图，R6）。
          「挂图」入口**只在操作区**（§3.2）—— 同一 handler 挂两个按钮会产生
          重复锚点，验收按 testid 计数时会翻倍。 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-fg-strong">
          {t('media.episode.imagesCount', { n: (ep.images ?? []).length })}
        </span>
        {imgs.length > 0 ? (
          <div className="flex items-start gap-2 overflow-x-auto pb-1" data-testid="episode-images">
            {imgs.map((img, i) => (
              <ImageTile
                key={img.itemId}
                img={img}
                onOpen={() => props.onOpenLightbox(i)}
                onRemove={() => props.onRemoveImage(img.itemId)}
              />
            ))}
            {/* 折叠切换（能力 #17）：挂图 > 3 张时给一个「还有 N 张 / 收起」入口，
                否则一集挂十几张图会把展开块撑成图片墙（节点名沿用 `episode-images-toggle`）。 */}
            {allImgs.length > IMAGE_INLINE ? (
              <button
                type="button"
                onClick={() => setImgsExpanded((v) => !v)}
                title={
                  imgsExpanded
                    ? t('media.episode.imagesCollapse')
                    : t('media.episode.imagesMore', { n: allImgs.length - IMAGE_INLINE })
                }
                data-testid="episode-images-toggle"
                className="shrink-0 self-center rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
              >
                {imgsExpanded
                  ? t('media.episode.imagesCollapse')
                  : `+${allImgs.length - IMAGE_INLINE}`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ⑤ 多源区（`sources.length > 0`；主版本 + 备用源，切主/摘除都是显式按钮） */}
      {sources.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-fg-strong">
            {t('media.episode.sourcesTitle')}
          </span>
          <ul className="flex flex-col gap-1">
            <li className="flex items-center gap-2 rounded border border-accent/40 bg-accent/5 px-2 py-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-fg-strong">
                {ep.title || `#${ep.itemId}`}
              </span>
              <span className="shrink-0 text-[10px] text-accent" data-testid="episode-source-primary">
                {t('media.episode.sourcePrimary')}
              </span>
            </li>
            {sources.map((s) => (
              <li
                key={s.itemId}
                className="flex items-center gap-2 rounded border border-border-subtle/70 px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate text-fg-mid">
                  {s.title || `#${s.itemId}`}
                </span>
                <button
                  type="button"
                  onClick={() => props.onSwitchSource(s.itemId)}
                  className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                  data-testid="episode-source-switch"
                >
                  {t('media.episode.switchPrimary')}
                </button>
                <button
                  type="button"
                  onClick={() => props.onDetachSource(s.itemId)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                  data-testid="episode-source-detach"
                >
                  {t('media.episode.detachSource')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ⑥ 操作区（恒显）：编辑 / 挂图 / 上移 / 下移 / 移除 / 播放 / 前往条目 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={props.editing ? props.onEditClose : props.onEdit}
          data-testid="episode-edit"
        >
          <Pencil className="h-3 w-3" />
          {t('media.episode.editMeta')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={props.onAttachImages}
          data-testid="episode-attach-images"
        >
          <ImagePlus className="h-3 w-3" />
          {t('media.attachImages')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => props.onMove('up')}
          title={t('media.episode.moveUp')}
          data-testid="episode-move-up"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => props.onMove('down')}
          title={t('media.episode.moveDown')}
          data-testid="episode-move-down"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px] text-destructive"
          onClick={props.onRemove}
          title={t('media.episode.removeFromSeries')}
          data-testid="episode-remove"
        >
          <Trash2 className="h-3 w-3" />
          {t('media.remove')}
        </Button>
        {/* Q4：无字节时「播放」禁用 + title 说明 —— 不让长得能点的按钮去 404 */}
        <Button
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={!withBytes}
          onClick={props.onPlay}
          title={withBytes ? t('media.episode.play') : t('media.fileMissingHint')}
          data-testid="episode-play"
        >
          <Play className="h-3 w-3" />
          {t('media.episode.play')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          onClick={props.onGotoItem}
          data-testid="episode-goto-item"
        >
          {t('media.episode.gotoItem')}
        </Button>
        {/* 无字节时展开态再给一次同一 handler 的重缓存入口（能力落位 #19） */}
        {!withBytes ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={!recacheable}
            onClick={props.onRecache}
            title={recacheable ? t('media.recache') : t('media.fileMissingHint')}
            data-testid="episode-recache"
          >
            <CloudOff className="h-3 w-3" />
            {t('media.recache')}
          </Button>
        ) : null}
      </div>

      {/* 编辑面板：**就在展开态内**（R11 要求独立编辑入口 ≤ 1，且说明只在面板内） */}
      {props.editing ? (
        <EpisodeEditPanel
          ep={ep}
          series={series}
          onClose={props.onEditClose}
          onSaved={props.onEditSaved}
          onError={props.onError}
        />
      ) : null}

      {/* ⑦ 来源 / 溯源 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        {ep.ref ? (
          <span title={`${t(sourceLabelKey(ep.source))} · ${ep.ref}`}>
            {t('media.fromSource', { source: t(sourceLabelKey(ep.source)) })}
            <span className="ml-1 text-muted/70">{ep.ref}</span>
          </span>
        ) : null}
        {ep.duration != null && ep.kind !== 'photo' ? (
          <span>{fmtDuration(ep.duration ?? undefined)}</span>
        ) : null}
        {ep.originSeriesTitle || ep.originEpisodeNo != null ? (
          <span className="text-accent/80">
            {ep.originSeriesTitle
              ? t('media.episode.originFrom', { title: ep.originSeriesTitle })
              : t('media.episode.originFromUntitled')}
            {ep.originEpisodeNo != null
              ? ` ${t('media.episode.originEpisode', { n: ep.originEpisodeNo })}`
              : ''}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** 挂图瓦片 88×120：外层是 div（内含「看大图」与「摘除」两个按钮，避免嵌套按钮） */
function ImageTile(props: {
  img: EpisodeImageMeta
  onOpen: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { img, onOpen, onRemove } = props
  const src = img.poster ?? mediaItemUrl(img.itemId)
  return (
    <div className="group/img relative h-[120px] w-[88px] shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-2">
      <button
        type="button"
        onClick={onOpen}
        className="block h-full w-full"
        title={t('media.episode.viewImage')}
        aria-label={t('media.episode.viewImage')}
        data-testid="episode-image-open"
      >
        <img src={src} alt="" loading="lazy" className={`h-full w-full ${coverFit('photo')}`} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        title={t('media.removeEpisodeImage')}
        aria-label={t('media.removeEpisodeImage')}
        data-testid="episode-image-remove"
        className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive focus-visible:opacity-100 group-hover/img:opacity-100"
      >
        <span className="text-[10px] leading-none">×</span>
      </button>
    </div>
  )
}
