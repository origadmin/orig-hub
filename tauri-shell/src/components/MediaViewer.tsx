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
    <div className={cn('flex min-h-0 flex-col bg-surface/20', className)}>
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
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
          {title || cur.caption?.trim() || `#${cur.messageId}`}
        </span>
        {positionText && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted">{positionText}</span>
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

      {cur.caption?.trim() && (
        <p className="max-h-24 shrink-0 overflow-y-auto border-t border-border-subtle/60 bg-black px-4 py-2 text-center text-xs text-white/80">
          {cur.caption}
        </p>
      )}
    </div>
  )
}
