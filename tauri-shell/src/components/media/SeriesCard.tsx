import { useEffect, useRef, useState } from 'react'
import { Film, Image as ImageIcon, Trash2 } from 'lucide-react'
import type { MediaSeries, MediaTag } from '../../api/media'
import { mediaItemUrl, seriesKindLabelKey } from '../../api/media'
import { coverFit } from '../../lib/mediaSources'
import { resolveSeriesCover } from '../../lib/episodePresentation'
import {
  cancelCoverJob,
  COVER_VIEWPORT_MARGIN,
  isPosterBudgetDropped,
  requestVideoPoster,
} from '../../lib/poster'
import { TagToken } from './TagToken'
import { useTranslation } from '../../i18n'
import { seriesLabel } from '../../lib/displayTitle'

/** 剧集卡片（剧集浏览墙用） */
export function SeriesCard(props: {
  series: MediaSeries
  tags: MediaTag[]
  onOpen: () => void
  onDelete: () => void
  /**
   * 剧集墙多选（BUG-186）：是否被选中。
   *
   * 与 items 视图的 `selected`（装 item id）**完全独立** —— 这是**剧集 id** 的选择集，
   * 不共用同一状态（BUG-153/BUG-155 的既有裁定：`selected` 属 items 视图）。
   */
  selected?: boolean
  /** 切换选中（点击选择框，或 Ctrl/Cmd + 点击卡片）。缺省 = 不启用选择（仅浏览）。 */
  onSelectToggle?: (seriesId: number) => void
  /** 抽帧得到的封面回写成功（持久化到剧集，下次直接复用） */
  onCoverReady?: (seriesId: number, poster: string) => void
}) {
  const { t } = useTranslation()
  const { series, tags, onOpen, onDelete, onCoverReady, selected, onSelectToggle } = props
  const [poster, setPoster] = useState<string | null>(series.poster ?? null)
  const [coverFailed, setCoverFailed] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setPoster(series.poster ?? null)
    setCoverFailed(false)
  }, [series.id, series.poster])

  /**
   * 首集是视频且没有封面 → 抽帧并回写（与内容卡片同一套机制）。
   *
   * BUG-239：**进入视口才抽帧**（此前是挂载即抽 —— 剧集墙上几十张卡会同时排队
   * 解码；`.jpg` 抽帧与播放器争资源，正是用户体感的卡顿）。可见性、去重、队列上限、
   * 播放让路统一由 `lib/poster` 的预算层负责；key 用 `v-<coverItemId>`，与
   * `MediaCard` 对同一条目的抽帧**合并为一次**（同一份字节）。
   */
  useEffect(() => {
    if (poster || coverFailed) return
    if (series.coverKind !== 'video' || !series.coverItemId) return
    /*
     * BUG-250：封面条目**没有字节**时不抽帧。
     *
     * 抽帧会向 `/api/media/items/:id/raw` 发请求，而该端点对无字节条目必然失败
     * （video 实测 404）—— 主页每张这样的剧集卡都会在控制台刷一次错误，
     * 而结果注定是 `coverFailed`。老后端不下发 `coverHasBytes`（undefined），
     * 此时按既有行为继续抽帧，不做静默改变。
     */
    if (series.coverHasBytes === false) return
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const coverItemId = series.coverItemId
    const key = `v-${coverItemId}`
    let alive = true
    let visible = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const attempt = () => {
      if (!alive || !visible) return
      requestVideoPoster(key, mediaItemUrl(coverItemId), 1, 480).then(
        (p) => {
          if (!alive) return
          setPoster(p.dataUrl)
          onCoverReady?.(series.id, p.dataUrl)
        },
        (e) => {
          if (!alive) return
          if (isPosterBudgetDropped(e)) {
            // 预算丢弃不是失败：重新进入视口再试（覆盖不倒退）。
            if (visible) retryTimer = setTimeout(attempt, 1500)
            return
          }
          setCoverFailed(true)
        },
      )
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            visible = true
            attempt()
          } else {
            visible = false
            cancelCoverJob(key)
          }
        }
      },
      { rootMargin: COVER_VIEWPORT_MARGIN },
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
      if (retryTimer) clearTimeout(retryTimer)
      cancelCoverJob(key)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id, series.coverKind, series.coverItemId, series.coverHasBytes, poster, coverFailed])

  // 封面走**单点回退链**（R12）：与 `SeriesHero` 同一函数，不再各写一遍。
  // 本地抽帧结果（poster state）优先于 resolver —— 它是刚算出来的、必然有效。
  const resolved = resolveSeriesCover({ ...series, episodes: [] })
  const cover = poster ?? resolved ?? null
  const kindLabel = (k: string): string => t(seriesKindLabelKey(k))
  const isSelected = Boolean(selected)
  return (
    <div
      ref={cardRef}
      data-testid="series-card-root"
      data-series-id={series.id}
      data-selected={isSelected ? 'true' : 'false'}
      className={[
        'group relative flex flex-col overflow-hidden rounded-lg border bg-surface transition-colors',
        isSelected
          ? 'border-accent ring-2 ring-accent/70'
          : 'border-border-subtle/60 hover:border-accent/50',
      ].join(' ')}
    >
      {/* 选择框（BUG-186）：**不冒泡**，点它只切选中、绝不打开详情。
          触屏没有 Ctrl/Cmd，故选择框是触屏上唯一的选中入口；键盘可达。 */}
      {onSelectToggle ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={t('media.seriesSelectionToggle', { title: seriesLabel(series.title) })}
          title={t('media.seriesSelectionToggle', { title: seriesLabel(series.title) })}
          data-testid="series-card-select"
          data-series-id={series.id}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSelectToggle(series.id)
          }}
          className={[
            'absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md border text-[13px] font-semibold leading-none shadow-sm transition-colors',
            isSelected
              ? 'border-accent bg-accent text-white'
              : 'border-white/70 bg-black/55 text-transparent hover:bg-black/75',
          ].join(' ')}
        >
          ✓
        </button>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          // Ctrl/Cmd + 点击卡片 = 切换选中（不用长按 —— 触屏长按语义与系统手势冲突）。
          // 不带修饰键 = 打开详情（**行为保持原样**）。
          if ((e.ctrlKey || e.metaKey) && onSelectToggle) {
            e.preventDefault()
            e.stopPropagation()
            onSelectToggle(series.id)
            return
          }
          onOpen()
        }}
        data-testid="series-card"
        data-series-id={series.id}
        className="relative block aspect-video w-full overflow-hidden bg-surface-2"
      >
        {cover ? (
          <img
            src={cover}
            alt={series.title}
            className={`h-full w-full ${coverFit(series.coverKind)}`}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            {series.kind === 'album' ? (
              <ImageIcon className="h-7 w-7" />
            ) : (
              <Film className="h-7 w-7" />
            )}
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-black">
            {t('media.series.open')}
          </span>
        </span>
        <span className="absolute left-1 top-1 rounded bg-accent/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {kindLabel(series.kind)}
        </span>
        {/* BUG-304 / D18（修订 BUG-254 的呈现）：剧集卡**不再**出现「未缓存」标。
            口径：文件域是「真的内容」，没有任何分集落盘的剧集**根本不进列表**
            （过滤在 `MediaLibraryPanel.loadSeries`，判据是后端的 `hasBytes`）。
            于是「标了未缓存却仍在列表里」这一自相矛盾的状态不可能再出现 ——
            用户原话：「当前视频中居然存在未缓存,既然没有为什么在里面?」
            注意判据的**主体**变了：原 `coverHasBytes` 只看封面那一条，
            「封面是张没缓存的图、正片全在」会被误标；新过滤看的是「有没有任何内容」。
            `coverHasBytes` 本身**仍然有效且仍在用** —— 它决定能否对 video 封面抽帧
            （见下方封面渲染分支），只是不再驱动这个角标。 */}
        <span
          className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] text-white"
          data-testid="series-video-count"
        >
          {/*
            BUG-220：这里原先渲染 `episodeCount`（「N 集」），而它是**集数、不分 kind**
            —— 纯图片专辑也会显示成「10 集」，用户读作视频数就是「图片被统计成视频」。
            改为名副其实的**视频数**：角标只给视频，图片数由下面的内容构成行承担。
            老后端不下发 videoCount 时不渲染（不编造 0）。
          */}
          {series.videoCount != null ? t('media.series.videoCount', { n: series.videoCount }) : null}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
        <p className="truncate text-[12px] font-medium text-fg-strong" title={series.title}>
          {series.title}
        </p>
        <p className="text-[10px] text-muted">
          {t('media.series.seasonCount', { n: series.seasonCount })} ·{' '}
          {/* BUG-220：同角标——「N 集」改为视频数，集数口径含图片会误导。 */}
          {series.videoCount != null
            ? t('media.series.videoCount', { n: series.videoCount })
            : t('media.episodeCount', { n: series.episodeCount })}
        </p>
        {/* BUG-250：内容构成（有没有视频 / 有没有图片）必须在主页可见 ——
            0 也如实显示，用户不该为了确认「这部剧里有没有图片」而逐个点进去。
            老后端不下发这两个字段时不渲染（不编造 0）。 */}
        {series.videoCount != null || series.photoCount != null ? (
          <p className="text-[10px] text-muted" data-testid="series-content-kinds">
            {t('media.series.videoCount', { n: series.videoCount ?? 0 })} ·{' '}
            {t('media.series.photoCount', { n: series.photoCount ?? 0 })}
          </p>
        ) : null}
        {series.tags.length > 0 ? (
          <p className="flex flex-wrap gap-x-1 gap-y-0.5 pt-0.5">
            {series.tags.map((tag) => (
              <TagToken key={tag.id} name={tags.find((x) => x.id === tag.id)?.name ?? tag.name} />
            ))}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="absolute bottom-1 right-1 flex h-8 w-8 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
        title={t('media.series.delete')}
        aria-label={t('media.series.delete')}
        data-testid="series-card-delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}
