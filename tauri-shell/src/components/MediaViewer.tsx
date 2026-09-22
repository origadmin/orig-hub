import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { Button } from './ui/button'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import { VideoPlayer } from './media/VideoPlayer'
import { EpisodeList } from './media/EpisodeList'
import { useSeriesDetail } from '../hooks/useSeriesDetail'
import type { ViewerItem } from '../types'

/**
 * 内容的**使用方式**（不是类型别名 —— 它决定播放组如何分流）。
 *
 *   play    → 连续播放（视频 / 音频），有播放控件、自动连播
 *   browse  → 逐张浏览（图片），只有翻页，没有播放语义
 *   none    → 不支持预览（如文档/压缩包）
 *
 * 为什么必须分流：剧集可能是混合内容（实测某剧集 = 5 视频 + 3 图片）。
 * 若把图片也编进播放序列，播完第 2 集会「自动连播到第 3 集（图片）」——
 * 即用户报的「视频和图片全部作为视频播放了，从没见过播放图片的电影」。
 * 分流后：点视频 → 组内只有视频（连着播）；点图片 → 组内只有图片（连着翻）。
 */
type Mode = 'play' | 'browse' | 'none'
const modeOf = (k: ViewerItem['kind'] | undefined): Mode =>
  k === 'photo' ? 'browse' : k === 'video' || k === 'audio' ? 'play' : 'none'

/**
 * 全局媒体播放器页（模块无关，不带任何模块信息）：打开时独占内容区整页。
 * 返回行（← 返回 + 标题 + 位置/总数）+ 媒体区（‹ › 收在面板内侧，不会出框）+ caption 底部行。
 *
 * 视频交给 `media/VideoPlayer`（自绘控件，含快捷键/倍速/画中画/自动连播）；
 * 图片走 `<img>` 浏览（无播放控件）；当播放项带 `seriesId` 时右侧挂分集列表 ——
 * 侧栏列出**整部剧集**（含另一种类型），点哪一项就切到哪种模式。
 *
 * 键盘（**与播放器内部快捷键刻意分工，互不重叠**）：
 *   ←/→ 组内上一个/下一个，Esc 返回
 *   播放器内部：Space/K 播放暂停、J/L 快退快进 10s、↑/↓ 音量、M 静音、F 全屏、P 画中画
 */
export function MediaViewer(props: {
  items: ViewerItem[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  /** 返回行标题；缺省用当前项 caption / #messageId */
  title?: string
  className?: string
}) {
  const { t } = useTranslation()
  const { items, index, onIndex, onClose, title, className } = props
  const cur = items[index]

  /** 图片降级失败（视频的失败由 VideoPlayer 内部处理） */
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => setImgFailed(false), [cur?.key])

  const seriesId = cur?.seriesId ?? null
  /**
   * 有剧集归属就显示侧栏 —— **刻意不按媒体类型过滤**。
   * 剧集可能是混合内容（实测某剧集 = 3 个视频 + 7 张图片）。若只对视频显示，
   * 用户点到图片那一集时侧栏会突然消失，此后再也无法切回视频集 ——
   * 这正是「点了没反应 / 列表没了」的成因。
   */
  const showEpisodes = Boolean(seriesId)
  /** 分集数据（单一来源）：侧栏列表与「即将播放 第 N 集」标注共用同一份 */
  const { detail, loading, error } = useSeriesDetail(seriesId)

  const mode = modeOf(cur?.kind)
  /**
   * 当前组 = 同一使用方式的内容。
   *
   * `items` 仍是**全量**（`viewer.index` 指向它，契约不变），组是派生的：
   * 侧栏点另一种类型 → 全量 index 变化 → 组的 kind 跟着变 → 自动换模式。
   * 不需要任何跨层回调，也不会出现「播放组里混进图片」。
   */
  const group = useMemo(
    () => (cur ? items.filter((i) => modeOf(i.kind) === mode) : []),
    [items, cur, mode],
  )
  const curKey = cur ? String(cur.key) : ''
  const posInGroup = group.findIndex((i) => String(i.key) === curKey)
  const prevItem = posInGroup > 0 ? group[posInGroup - 1] : null
  const nextItem =
    posInGroup >= 0 && posInGroup < group.length - 1 ? group[posInGroup + 1] : null

  /** 组内跳转：把目标项换算回全量 index（store 契约不变） */
  const goTo = (it: ViewerItem) => {
    const idx = items.findIndex((x) => String(x.key) === String(it.key))
    if (idx >= 0 && idx !== index) onIndex(idx)
  }

  const many = group.length > 1

  // 键盘导航：←/→ 组内切换，Esc 返回（组件自持，任何挂载处行为一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        if (prevItem) goTo(prevItem)
      } else if (e.key === 'ArrowRight') {
        if (nextItem) goTo(nextItem)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prevItem, nextItem, index, items, onIndex, onClose])

  // 分集列表点击：在**全量** items 内按 itemId 定位（媒体库里 messageId 即 MediaItem.id）。
  // 定位到另一种类型也没关系 —— 上面的 group 会随之切换模式。
  const selectEpisode = (itemId: number) => {
    const idx = items.findIndex((it) => it.messageId === itemId)
    if (idx >= 0 && idx !== index) onIndex(idx)
  }
  const isSelectable = (itemId: number) => items.some((it) => it.messageId === itemId)

  const nextUp = nextItem
    ? {
        title: nextItem.caption?.trim() || `#${nextItem.messageId}`,
        poster: nextItem.poster,
        episodeNo:
          nextItem.episodeNo ??
          detail?.episodes.find((e) => e.itemId === nextItem.messageId)?.episodeNo ??
          null,
      }
    : null

  if (!cur) return null

  const browse = mode === 'browse'
  /** 位置文案：浏览说「第 n 张」，播放在剧集里说「第 n 集」，否则只说位次 */
  const positionText = (() => {
    if (posInGroup < 0 || group.length <= 1) return null
    const n = posInGroup + 1
    if (browse) return t('player.photoPos', { n, total: group.length })
    if (cur.episodeNo) return t('player.episodePos', { n: cur.episodeNo, total: group.length })
    return `${n}/${group.length}`
  })()

  return (
    <div
      className={cn('flex min-h-0 flex-col bg-surface/20', className)}
      data-testid="media-viewer"
      data-message-id={cur.messageId}
    >
      {/* 返回行：← 返回 + 标题 + 位置/总数 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={onClose}
        >
          ← {t('tg.backToFeed')}
        </Button>
        {/* 图片模式下显式标出「浏览」，避免用户以为在播放 */}
        {browse && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-mid">
            <ImageIcon className="h-3 w-3" />
            {t('player.browse')}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[12px] text-muted"
          data-testid="viewer-title"
        >
          {title || cur.caption?.trim() || `#${cur.messageId}`}
        </span>
        {positionText && (
          <span
            className="shrink-0 text-[11px] tabular-nums text-muted"
            data-testid="viewer-position"
          >
            {positionText}
          </span>
        )}
      </div>

      {/* 主体：媒体区 + 分集侧栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 媒体区：黑底居中；‹ › 组内切换收在面板两侧，不再出框 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black">
          {many && prevItem && (
            <button
              type="button"
              aria-label={browse ? t('player.prevPhoto') : t('player.prevItem')}
              onClick={() => goTo(prevItem)}
              data-testid="viewer-prev"
              className="absolute left-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
            >
              ‹
            </button>
          )}

          {browse ? (
            <img
              key={String(cur.key)}
              src={cur.src}
              alt={cur.caption || ''}
              className="max-h-full max-w-full rounded-lg object-contain"
              onError={(e) => {
                const img = e.currentTarget
                if (cur.fallbackSrc && !img.dataset.fallback) {
                  img.dataset.fallback = '1'
                  img.src = cur.fallbackSrc
                } else {
                  setImgFailed(true)
                }
              }}
            />
          ) : mode === 'play' ? (
            <VideoPlayer
              key={String(cur.key)}
              src={cur.src}
              fallbackSrc={cur.fallbackSrc}
              poster={cur.poster}
              autoPlay
              nextUp={nextUp}
              onPlayNext={() => nextItem && goTo(nextItem)}
            />
          ) : (
            <p className="max-w-[80%] rounded-md border border-white/20 bg-white/5 px-3 py-2 text-center text-xs text-white/85">
              {t('player.unsupported')}
            </p>
          )}

          {many && nextItem && (
            <button
              type="button"
              aria-label={browse ? t('player.nextPhoto') : t('player.nextItem')}
              onClick={() => goTo(nextItem)}
              data-testid="viewer-next"
              className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
            >
              ›
            </button>
          )}

          {imgFailed && (
            <p className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-center text-xs text-white/85">
              {t('tg.decodeFail')}
            </p>
          )}
        </div>

        {showEpisodes && seriesId && (
          <EpisodeList
            title={detail?.title ?? ''}
            episodes={detail?.episodes ?? []}
            loading={loading}
            error={error}
            currentItemId={cur.messageId}
            onSelect={selectEpisode}
            isSelectable={isSelectable}
          />
        )}
      </div>

      {/*
       * 底部文案行：媒体库条目**优先显示介绍**。
       *
       * 条目的 `caption` 在媒体库场景被填成标题（返回行已经显示了一遍），
       * 若这里再显示 caption，同一个标题会出现两次、而真正的正文无处可看 ——
       * 这正是「视频内容错误」的观感来源。有 `description` 就显示它。
       *
       * `whitespace-pre-wrap` 与剧集详情（`SeriesDetail`）的正文渲染**必须一致**：
       * 介绍是多段文本，折叠换行会把分段吃掉 —— 同一段正文在剧集页有分段、
       * 在播放页变成一坨，就是「剧集对、视频错」的又一种形态。
       */}
      {(cur.description?.trim() || cur.caption?.trim()) && (
        <p
          className="max-h-24 shrink-0 overflow-y-auto whitespace-pre-wrap break-words border-t border-border-subtle/60 bg-black px-4 py-2 text-center text-xs text-white/80 [overflow-wrap:anywhere]"
          data-testid="viewer-text"
        >
          {cur.description?.trim() || cur.caption}
        </p>
      )}

      {/*
       * 图片轮播带（browse 模式且组内多图）。
       *
       * 为什么必须有：多图剧集（或一次加入的多张图）此前只能靠 ‹ › 一张张翻，
       * 用户无法知道「这组一共几张、还剩哪些」——即「多张图加入后没有完整展示」。
       * 缩略图带把**整组图片一次摆出来**：当前张高亮、点任意一张直接切过去，
       * 位置与顺序一眼可见。
       *
       * 只对图片（browse）出现：视频/音频的顺序导航由分集侧栏承担，
       * 再挂一条缩略带是重复的第二套控件。
       *
       * 缩略图用 `object-cover` 是**刻意**的：48px 的方格里它是「索引」而非内容，
       * 内容由上方大图完整呈现（`object-contain`，绝不裁切）。
       */}
      {browse && group.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-border-subtle/60 bg-black px-3 py-2">
          {group.map((it, i) => {
            const on = String(it.key) === curKey
            return (
              <button
                key={String(it.key)}
                type="button"
                onClick={() => goTo(it)}
                aria-current={on ? 'true' : undefined}
                aria-label={t('player.photoPos', { n: i + 1, total: group.length })}
                title={it.caption?.trim() || `#${it.messageId}`}
                data-testid="photo-strip-item"
                className={cn(
                  'relative h-12 w-12 shrink-0 overflow-hidden rounded border transition-all',
                  on
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-white/15 opacity-65 hover:opacity-100',
                )}
              >
                <img
                  src={it.poster ?? it.src}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[9px] tabular-nums text-white">
                  {i + 1}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
