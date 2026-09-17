import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import { VideoPlayer } from './media/VideoPlayer'
import { EpisodeList } from './media/EpisodeList'
import { useSeriesDetail } from '../hooks/useSeriesDetail'
import type { ViewerItem } from '../types'

/**
 * 全局媒体播放器页（模块无关，不带任何模块信息）：打开时独占内容区整页。
 * 返回行（← 返回 + 标题 + n/N）+ 媒体区（‹ › 收在面板内侧，不会出框）+ caption 底部行。
 *
 * 视频交给 `media/VideoPlayer`（自绘控件，含快捷键/倍速/画中画/自动连播）；
 * 当播放项带 `seriesId` 时，右侧挂分集列表 —— 点某集即在播放组内定位。
 *
 * 键盘（**与播放器内部快捷键刻意分工，互不重叠**）：
 *   ←/→ 组内切换上一个/下一个，Esc 返回
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
  const many = items.length > 1

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

  // 键盘导航：←/→ 组内切换，Esc 返回（组件自持，任何挂载处行为一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        if (index > 0) onIndex(index - 1)
      } else if (e.key === 'ArrowRight') {
        if (index < items.length - 1) onIndex(index + 1)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onIndex, onClose])

  // 分集列表点击：在播放组内按 itemId 定位（媒体库里 messageId 即 MediaItem.id）
  const selectEpisode = (itemId: number) => {
    const idx = items.findIndex((it) => it.messageId === itemId)
    if (idx >= 0 && idx !== index) onIndex(idx)
  }
  const isSelectable = (itemId: number) => items.some((it) => it.messageId === itemId)

  const next = index < items.length - 1 ? items[index + 1] : null
  const nextUp = next
    ? {
        title: next.caption?.trim() || `#${next.messageId}`,
        poster: next.poster,
        episodeNo:
          next.episodeNo ?? detail?.episodes.find((e) => e.itemId === next.messageId)?.episodeNo ?? null,
      }
    : null

  if (!cur) return null

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface/20', className)}>
      {/* 返回行：← 返回 + 标题 + n/N */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={onClose}
        >
          ← {t('tg.backToFeed')}
        </Button>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
          {title || cur.caption?.trim() || `#${cur.messageId}`}
        </span>
        {many && (
          <span className="shrink-0 text-[11px] text-muted">
            {index + 1}/{items.length}
          </span>
        )}
      </div>

      {/* 主体：媒体区 + 分集侧栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 媒体区：黑底居中；‹ › 组内切换收在面板两侧，不再出框 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black">
          {many && index > 0 && (
            <button
              type="button"
              aria-label={t('player.prevItem')}
              onClick={() => onIndex(index - 1)}
              className="absolute left-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
            >
              ‹
            </button>
          )}

          {cur.kind === 'photo' ? (
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
          ) : (
            <VideoPlayer
              key={String(cur.key)}
              src={cur.src}
              fallbackSrc={cur.fallbackSrc}
              poster={cur.poster}
              autoPlay
              nextUp={nextUp}
              onPlayNext={() => onIndex(index + 1)}
            />
          )}

          {many && index < items.length - 1 && (
            <button
              type="button"
              aria-label={t('player.nextItem')}
              onClick={() => onIndex(index + 1)}
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
