import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { fmtDuration, fmtSize } from '../../lib/tgmedia'
import {
  generateImageThumb,
  generateVideoPoster,
  markPosterFailed,
  posterFailed,
} from '../../lib/poster'

const KIND_ICON: Record<string, string> = {
  video: '🎬',
  photo: '🖼',
  audio: '🎵',
  file: '📄',
}

/**
 * 海报卡片（主流媒体站样式）：16:9 封面 + 悬浮操作层 + 标题/元信息。
 *
 * 封面策略（三级）：
 *   1. 后端已存 `poster`（data-uri）——直接用
 *   2. 图片类直接取原图（浏览器自适应缩放，无需额外生成）
 *   3. 视频类首次进入视口时抽帧生成，成功后回写后端，后续永久复用
 */
export function MediaCard(props: {
  item: MediaItem
  selected?: boolean
  /** 剧集里的集号标签，如 `S1E3` */
  episodeLabel?: string
  onSelectToggle?: (id: number, shiftKey: boolean) => void
  onOpen: (item: MediaItem) => void
  onEdit?: (item: MediaItem) => void
  /** 封面生成并回写成功后回调（用于就地更新列表，避免整页刷新） */
  onPosterReady?: (patch: { id: number; poster: string; duration?: number }) => void
}) {
  const { item, selected, episodeLabel, onSelectToggle, onOpen, onEdit, onPosterReady } = props
  const [poster, setPoster] = useState<string | null>(item.poster ?? null)
  const [genFailed, setGenFailed] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)

  // 换条目时重置本地封面状态
  useEffect(() => {
    setPoster(item.poster ?? null)
    setGenFailed(posterFailed(`v-${item.id}`))
    startedRef.current = false
  }, [item.id, item.poster])

  /** 图片直接原图；视频无封面时进入视口再抽帧（懒生成，避免首屏解码风暴） */
  useEffect(() => {
    if (poster || genFailed) return
    if (item.kind !== 'video') return
    const el = boxRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    const start = async () => {
      if (startedRef.current) return
      startedRef.current = true
      try {
        const probe = await generateVideoPoster(mediaItemUrl(item.id), 1, 480)
        setPoster(probe.dataUrl)
        onPosterReady?.({
          id: item.id,
          poster: probe.dataUrl,
          duration: probe.duration || undefined,
        })
      } catch {
        markPosterFailed(`v-${item.id}`)
        setGenFailed(true)
      }
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          void start()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
    // onPosterReady 每次渲染都变，故意不进依赖，否则观察器反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.kind, poster, genFailed])

  /** 图片类：生成统一缩略图（原图可能很大，直接进网格浪费解码） */
  useEffect(() => {
    if (poster || genFailed) return
    if (item.kind !== 'photo') return
    let alive = true
    generateImageThumb(mediaItemUrl(item.id), 480)
      .then((u) => {
        if (!alive) return
        setPoster(u)
        onPosterReady?.({ id: item.id, poster: u })
      })
      .catch(() => {
        if (!alive) return
        setGenFailed(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.kind, poster, genFailed])

  const thumbSrc =
    poster ?? (item.kind === 'photo' ? mediaItemUrl(item.id) : null)

  return (
    <div
      ref={boxRef}
      className={[
        'group relative flex flex-col overflow-hidden rounded-lg border bg-surface transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'border-border-subtle/60 hover:border-accent/50',
      ].join(' ')}
    >
      {/* 封面区（16:9） */}
      <button
        type="button"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) {
            onSelectToggle?.(item.id, e.shiftKey)
            return
          }
          onOpen(item)
        }}
        className="relative block aspect-video w-full overflow-hidden bg-surface-2"
        title={item.title}
      >
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xl text-muted">
            {genFailed ? '🚫' : KIND_ICON[item.kind] ?? '📄'}
          </span>
        )}

        {/* 悬浮操作层 */}
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-sm text-black">
            ▶
          </span>
        </span>

        {/* 时长徽标 */}
        {item.duration ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-medium text-white">
            {fmtDuration(item.duration)}
          </span>
        ) : null}

        {/* 集号徽标 */}
        {episodeLabel ? (
          <span className="absolute left-1 top-1 rounded bg-accent/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {episodeLabel}
          </span>
        ) : null}

        {/* 多选勾选框（悬浮/选中时可见） */}
        {onSelectToggle ? (
          <span
            role="checkbox"
            aria-checked={Boolean(selected)}
            onClick={(e) => {
              e.stopPropagation()
              onSelectToggle(item.id, e.shiftKey)
            }}
            className={[
              'absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded border text-[11px] transition-opacity',
              selected
                ? 'border-accent bg-accent text-white opacity-100'
                : 'border-white/70 bg-black/40 text-transparent opacity-0 group-hover:opacity-100',
            ].join(' ')}
          >
            ✓
          </span>
        ) : null}
      </button>

      {/* 文本区 */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
        <p className="truncate text-[12px] font-medium text-fg-strong" title={item.title}>
          {item.title}
        </p>
        <p className="flex items-center gap-1 truncate text-[10px] text-muted">
          <span>{fmtSize(item.size)}</span>
          {item.seriesTitle ? <span className="truncate">· {item.seriesTitle}</span> : null}
        </p>
        {item.tags.length > 0 ? (
          <p className="flex flex-wrap gap-1 pt-0.5">
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag.id}
                className="rounded px-1 py-px text-[9px]"
                style={{
                  background: `${tag.color ?? '#64748b'}22`,
                  color: tag.color ?? '#64748b',
                }}
              >
                {tag.name}
              </span>
            ))}
            {item.tags.length > 3 ? (
              <span className="text-[9px] text-muted">+{item.tags.length - 3}</span>
            ) : null}
          </p>
        ) : null}
      </div>

      {/* 编辑入口（悬浮） */}
      {onEdit ? (
        <button
          type="button"
          onClick={() => onEdit(item)}
          className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
          title="编辑"
        >
          ✎
        </button>
      ) : null}
    </div>
  )
}
