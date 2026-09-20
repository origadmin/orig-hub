import { memo, useEffect, useRef, useState } from 'react'
import { CloudOff, Pencil, Trash2 } from 'lucide-react'
import type { MediaItem } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { coverFit, fmtDuration, fmtSize, hasMediaBytes } from '../../lib/tgmedia'
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
 *
 * `memo` 化（BUG-026 流畅优先）：一屏最多 120 张卡，父面板任何一次 setState
 * 都会带着整墙重渲染 —— 封面抽帧是解码级开销，重渲染一次就重算一次。
 */
function MediaCardBase(props: {
  item: MediaItem
  selected?: boolean
  /** 剧集里的集号标签，如 `S1E3` */
  episodeLabel?: string
  onSelectToggle?: (id: number, shiftKey: boolean) => void
  onOpen: (item: MediaItem) => void
  onEdit?: (item: MediaItem) => void
  /**
   * 逐条删除入口（BUG-057）。
   *
   * 此前删除只作为**批量动作**存在（工具栏里，且挂在 `selected.size > 0` 之下），
   * 单条删除只能退化成「大小为 1 的批量」：先勾选、再找工具栏、再确认。
   * 选择态被当成删除的前置仪式 —— 这里是把它拿掉，删除与编辑同级。
   */
  onDelete?: (item: MediaItem) => void
  /** 封面生成并回写成功后回调（用于就地更新列表，避免整页刷新） */
  onPosterReady?: (patch: { id: number; poster: string; duration?: number }) => void
  /**
   * 重新缓存入口（BUG-080）：TG 来源条目在字节被清掉后可原路取回。
   * 非 TG 来源没有「原路」可言，条目会拿到 `null`，展示层只标「文件已丢失」。
   */
  onRecache?: (item: MediaItem) => void
}) {
  const {
    item,
    selected,
    episodeLabel,
    onSelectToggle,
    onOpen,
    onEdit,
    onDelete,
    onPosterReady,
    onRecache,
  } = props
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

  /**
   * 有没有字节（BUG-080）。
   *
   * 清缓存只删字节、留条目 —— 没有这个判断，清完缓存的卡片与正常内容**长得一样**，
   * 点下去 raw 端点 404、静默播不了。有没有字节是事实态，展示层必须如实呈现。
   */
  const playable = hasMediaBytes(item)
  const recacheable = !playable && Boolean(onRecache)

  return (
    <div
      ref={boxRef}
      data-testid="media-card"
      className={[
        'group relative flex flex-col overflow-hidden rounded-lg border bg-surface transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent'
          : 'border-border-subtle/60 hover:border-accent/50',
      ].join(' ')}
    >
      {/* 封面区（16:9） */}
      <div className="relative block aspect-video w-full overflow-hidden bg-surface-2">
        {playable ? (
          <button
            type="button"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) {
                onSelectToggle?.(item.id, e.shiftKey)
                return
              }
              onOpen(item)
            }}
            className="relative block h-full w-full"
            title={item.title}
          >
            {thumbSrc ? (
              <img
                src={thumbSrc}
                alt={item.title}
                loading="lazy"
                /* 图片类 `object-contain`：卡片几何统一（16:9），但图片**不裁切** */
                className={`h-full w-full ${coverFit(item.kind)}`}
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
          </button>
        ) : (
          /* 无字节占位（BUG-080）：**不给播放入口** —— 一个点了必然 404 的按钮
             比没有按钮更糟，它把「没有字节」伪装成「可以播放」。
             封面位如实显示占位，TG 来源给「重新缓存」，其余标「文件已丢失」。 */
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-muted"
            data-testid="item-nobytes"
            title={recacheable ? '字节已清理：可重新从 TG 缓存' : '文件已丢失：磁盘上找不到字节'}
          >
            <CloudOff className="h-5 w-5" />
            <span className="text-[10px] leading-none">
              {recacheable ? '缓存已清理' : '文件已丢失'}
            </span>
            {recacheable ? (
              <button
                type="button"
                onClick={() => onRecache?.(item)}
                className="rounded-full bg-accent/90 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white transition-colors hover:bg-accent"
                title="重新从 TG 拉取字节（条目保留在资料库）"
                data-testid="item-recache"
              >
                重新缓存
              </button>
            ) : null}
          </div>
        )}

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
      </div>

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
          <p className="flex flex-wrap gap-1 pt-0.5" data-testid="item-tags">
            {/* 全量展示：省略成「+N」会让标签看起来像没归档（>3 个时尤其明显）。 */}
            {item.tags.map((tag) => (
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
          </p>
        ) : null}
      </div>

      {/*
       * 卡片操作条：**常驻可见**（编辑 + 删除）。
       *
       * 编辑入口曾经写成 `opacity-0 group-hover:opacity-100` —— 只有把鼠标悬停到封面正中央
       * 才显形，用户根本找不到「标题在哪儿改」，于是反馈「剧集和视频的标题不能编辑」。
       * 功能存在但入口不可发现，等于没有。删除入口同理，且它比编辑更依赖「一眼看到」：
       * 找不到删除的人会去勾选，于是又把「选择」当成删除的前置仪式。
       */}
      {onEdit || onDelete ? (
        <div className="absolute bottom-1 right-1 flex items-center gap-1">
          {onDelete ? (
            <button
              type="button"
              onClick={() => onDelete(item)}
              className="flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm transition-colors hover:bg-destructive hover:text-white"
              title="从资料库删除这条内容（只删记录，磁盘上的文件不受影响）"
              aria-label="删除"
              data-testid="item-delete"
            >
              <Trash2 className="h-3 w-3" />
              删除
            </button>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="flex items-center gap-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm transition-colors hover:bg-black/85 hover:text-white"
              title="编辑标题 / 介绍 / 标签"
              aria-label="编辑"
              data-testid="item-edit"
            >
              <Pencil className="h-3 w-3" />
              编辑
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 记忆化导出：网格里上百张卡，props 不变就不重渲染（见文件头说明）。 */
export const MediaCard = memo(MediaCardBase)
