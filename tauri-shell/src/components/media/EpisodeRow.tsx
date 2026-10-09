import { useEffect, useRef } from 'react'
import { ChevronDown, CloudOff, Film, Image as ImageIcon, Music, Pencil, Play } from 'lucide-react'
import type { EpisodeImageMeta, MediaEpisode, MediaSeriesDetail } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { canRecacheFromSource, coverFit, fmtDuration, hasMediaBytes, sourceLabelKey } from '../../lib/mediaSources'
import { episodeSlotLabel, shouldRenderEpisodeTitle } from '../../lib/episodePresentation'
import { CoverImage } from './CoverImage'
import { useTranslation } from '../../i18n'
import { seriesLabel } from '../../lib/displayTitle'

/**
 * 单集**行态**：位置（集号）+ 指代（封面）+ 标识（标题）+ 关键状态（时长 / 多源 /
 * 字节态 / 挂图指示 / 溯源）。
 *
 * 布局是**扁平网格**（不是行内嵌套按钮）：行首有一个覆盖整行的绝对定位按钮负责
 * 「展开/收起」，行内的 `episode-cover` / `episode-edit` / `episode-recache` /
 * `episode-images` 都是它的**兄弟**节点，各自被提升 `z-index` 拿到点击。
 * 这样既满足「点行任意处展开」，又不产生嵌套 `<button>`（HTML 非法、点击语义会串）。
 *
 * 无字节（BUG-080）时**不渲染播放入口** —— 一个点了必然 404 的播放按钮，是把
 * 「没有字节」伪装成「可以播放」。
 */
export function EpisodeRow(props: {
  ep: MediaEpisode
  series: MediaSeriesDetail
  expanded: boolean
  /** 键盘焦点（roving tabindex）—— 只有它 `tabIndex=0` */
  keyboardFocused: boolean
  onToggle: () => void
  onPlay: () => void
  onEdit: () => void
  onOpenImages: (img: EpisodeImageMeta, index: number) => void
  onRecache: () => void
  /** typeahead 搜索用：条目标题快照（缺失回退空串） */
  label: string
}) {
  const { t } = useTranslation()
  const { ep, series, expanded, keyboardFocused } = props
  const imgs = ep.images ?? []
  /** 行态只露前 1 张：整条列表的密度不能被挂图吃掉，展开态才是看全部的位置 */
  const firstImg = imgs[0]
  const recacheable = canRecacheFromSource(ep.source)
  const withBytes = hasMediaBytes(ep)
  const rowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (keyboardFocused) rowRef.current?.focus()
  }, [keyboardFocused])

  return (
    <div
      data-testid={`episode-row-${ep.id}`}
      data-episode-label={props.label}
      className={`relative rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border-subtle/60 hover:bg-surface-2/70 ${
        expanded ? 'bg-surface-2/50' : ''
      }`}
    >
      {/* 行覆盖层：点行任意处 = 展开/收起。它是这一行的唯一 tab 停靠点
          （roving tabindex），本身不承载任何信息位。 */}
      <button
        ref={rowRef}
        type="button"
        onClick={props.onToggle}
        tabIndex={keyboardFocused ? 0 : -1}
        aria-expanded={expanded}
        aria-label={`${episodeSlotLabel(ep)}${
          shouldRenderEpisodeTitle(ep, series) ? ` · ${ep.title ?? ''}` : ''
        }`}
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      />

      <div className="relative z-10 flex items-center gap-3">
        {/* 集号：**位置**，同时也是槽位编辑入口（与展开态「编辑」面板同一个 handler）。
            集号就是这一行的坐标 —— 想改「这是第几集」时，直觉上的落点就是集号本身。
            节点名沿用现状 `episode-slot`（§13.1「节点名全部沿用」清单）。 */}
        <button
          type="button"
          onClick={props.onEdit}
          title={t('media.episode.editSlot')}
          data-testid="episode-slot"
          className="w-14 shrink-0 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
        >
          {episodeSlotLabel(ep)}
        </button>

        {/* 指代位：有字节 = 可播；无字节 = 虚线占位 + 重新缓存。 */}
        {withBytes ? (
          <button
            type="button"
            onClick={props.onPlay}
            className="group/cover relative block aspect-video w-40 shrink-0 overflow-hidden rounded bg-surface-2"
            title={ep.kind === 'photo' ? t('media.episode.viewImage') : t('media.episode.play')}
            data-testid="episode-cover"
          >
            {ep.poster ? (
              /* 封面走 coverFit（photo → contain，非 photo → cover），
                 竖版源图由 CoverImage 按实际方向兜底改判 contain（§3.1.1）。 */
              <CoverImage
                src={ep.poster}
                fit={coverFit(ep.kind)}
                className="h-full w-full"
              />
            ) : ep.kind === 'photo' ? (
              <CoverImage
                src={mediaItemUrl(ep.itemId)}
                kind="photo"
                fit="object-contain"
                className="h-full w-full"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-muted">
                {ep.kind === 'audio' ? <Music className="h-4 w-4" /> : <Film className="h-4 w-4" />}
              </span>
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/cover:opacity-100">
              {ep.kind === 'photo' ? (
                <ImageIcon className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 fill-white" />
              )}
            </span>
          </button>
        ) : (
          <div
            className="flex aspect-video w-40 shrink-0 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-border-subtle bg-surface-2 px-0.5 text-muted"
            data-testid="episode-nobytes"
            title={
              recacheable
                ? t('media.recacheFrom', { source: t(sourceLabelKey(ep.source)) })
                : t('media.fileMissingHint')
            }
          >
            <CloudOff className="h-3.5 w-3.5" />
            <span className="text-[9px] leading-none">
              {recacheable ? t('media.notCached') : t('media.fileMissing')}
            </span>
            {recacheable ? (
              <button
                type="button"
                onClick={props.onRecache}
                className="rounded bg-accent/90 px-1 py-px text-[9px] font-medium leading-none text-white transition-colors hover:bg-accent"
                data-testid="episode-recache"
              >
                {t('media.recache')}
              </button>
            ) : null}
          </div>
        )}

        {/* 标识位：标题（R5 门控）+ 关键状态 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className={`truncate text-[12.5px] ${
                shouldRenderEpisodeTitle(ep, series) ? 'text-fg-strong' : 'text-muted'
              }`}
              title={ep.title ?? ''}
            >
              {shouldRenderEpisodeTitle(ep, series) ? ep.title : episodeSlotLabel(ep)}
            </p>
            {(ep.sources?.length ?? 0) > 0 ? (
              <span
                className="shrink-0 rounded border border-border-subtle/70 px-1 text-[9.5px] text-muted"
                title={t('media.episode.sourcesTitle')}
                data-testid="episode-source-count"
              >
                {t('media.episode.sourceCount', { n: (ep.sources?.length ?? 0) + 1 })}
              </span>
            ) : null}
          </div>
          <p className="text-[10px] text-muted">
            {ep.kind === 'photo'
              ? t('media.episode.kindPhoto')
              : fmtDuration(ep.duration ?? undefined) || t('media.episode.durationUnknown')}
            {(ep.originSeriesTitle || ep.originEpisodeNo != null) && (
              <span className="text-accent/80">
                {' · '}
                {ep.originSeriesTitle
                  ? t('media.episode.originFrom', { title: seriesLabel(ep.originSeriesTitle) })
                  : t('media.episode.originFromUntitled')}
                {ep.originEpisodeNo != null
                  ? ` ${t('media.episode.originEpisode', { n: ep.originEpisodeNo })}`
                  : ''}
              </span>
            )}
            {ep.ref && (
              <span className="text-muted/70" title={`${t(sourceLabelKey(ep.source))} · ${ep.ref}`}>
                {' · '}
                {t(sourceLabelKey(ep.source))}
              </span>
            )}
          </p>
        </div>

        {/* 挂图指示：行态给「有图」的证据（首图缩略 + 张数），看全部在展开态 */}
        {firstImg ? (
          <button
            type="button"
            onClick={() => props.onOpenImages(firstImg, 0)}
            className="group/img relative h-9 w-12 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-2"
            title={t('media.episode.viewImage')}
            data-testid="episode-images"
          >
            <img
              src={firstImg.poster ?? mediaItemUrl(firstImg.itemId)}
              alt=""
              loading="lazy"
              className={`h-full w-full ${coverFit('photo')}`}
            />
            {imgs.length > 1 ? (
              <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-0.5 text-[8px] leading-3 text-white">
                {imgs.length}
              </span>
            ) : null}
          </button>
        ) : null}

        {/* 编辑入口：**恒在**，不受 R2/R5 门控影响（R3）—— 去重只影响展示 */}
        <button
          type="button"
          onClick={props.onEdit}
          className="shrink-0 rounded px-1 text-muted hover:bg-surface-2 hover:text-fg-mid"
          title={t('media.episode.editMeta')}
          data-testid="episode-edit"
        >
          <Pencil className="h-3 w-3" />
        </button>

        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </div>
    </div>
  )
}
