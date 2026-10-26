import { X } from 'lucide-react'
import type { MediaEpisode } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { albumGridClass, coverFit } from '../../lib/tgmedia'
import { useTranslation } from '../../i18n'

/**
 * photo-only / album 形态的**宫格**（= 图册位）。
 *
 * 与行式的差别（设计 §3.3）：
 *   - 无集号行、无播放入口（P6：图片永不进播放序列）、无展开态；
 *   - 点击瓦片 = 开灯箱（范围 = 本组全部 photo 分集，R6）；
 *   - 瓦片右上角 × = `onRemoveEpisode`（**继承现状 `series-gallery-remove` 的
 *     「从剧集移除」能力**，BUG-149：移除平铺行不等于丢能力）。
 *
 * 列数复用 `albumGridClass(n)`（与 TG 相册同规则，不另写一套）。
 */
export function EpisodePhotoGrid(props: {
  eps: MediaEpisode[]
  /** 点第 index 张瓦片开灯箱（index 是**本组内**的序号） */
  onOpenLightbox: (index: number) => void
  onRemoveEpisode: (ep: MediaEpisode) => void
}) {
  const { t } = useTranslation()
  const { eps, onOpenLightbox, onRemoveEpisode } = props

  if (eps.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted" data-testid="episode-photo-grid">
        {t('media.gallery.empty')}
      </p>
    )
  }

  return (
    <div
      className={`grid ${albumGridClass(eps.length)} gap-1`}
      data-testid="episode-photo-grid"
    >
      {eps.map((ep, i) => (
        // 外层用 div 而非 button：每张瓦片里要放「浏览」与「移除」两个按钮，
        // 外层若仍是 button 会形成**嵌套按钮**（HTML 非法，点击语义也会串）。
        <div
          key={ep.id}
          className="group relative aspect-square overflow-hidden rounded border border-border-subtle bg-surface-2"
          data-testid={`episode-photo-tile-${ep.itemId}`}
        >
          <button
            type="button"
            onClick={() => onOpenLightbox(i)}
            title={ep.title || t('media.episode.viewImage')}
            className="block h-full w-full"
          >
            <img
              src={ep.poster ?? mediaItemUrl(ep.itemId)}
              alt={ep.title || ''}
              loading="lazy"
              className={`h-full w-full ${coverFit('photo')}`}
            />
          </button>
          {/* 移除入口：与分集列表的「移除」同一语义（只摘除归属，内容留在资料库）。
              ⚠️ 已取证（2026-09-22，实测本机 orig-tg）：TG 自动成剧的图片分集被摘除后，
              `append_episodes_ranged`（media.rs:1714）只按**当前** media_episode 行去重，
              没有任何「已摘除」负向记录 —— 同一 TG 组下一次重新缓存/同步会把它**重新编回**
              （实测：移除 itemId=143 后再次 append，该图复活）。要「删了不回来」，
              后端需补一条 tombstone（负向记录）。详见 BUG-112 风险节。 */}
          <button
            type="button"
            onClick={() => onRemoveEpisode(ep)}
            title={t('media.episode.removeFromSeriesHint')}
            aria-label={t('media.episode.removeFromSeriesHint')}
            data-testid={`episode-photo-remove-${ep.itemId}`}
            className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive focus-visible:opacity-100 group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
