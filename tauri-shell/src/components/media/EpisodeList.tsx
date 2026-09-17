import { useEffect, useMemo, useRef } from 'react'
import { ListVideo, Play } from 'lucide-react'
import type { MediaEpisode } from '../../api/media'
import { cn } from '../../lib/utils'
import { fmtDuration } from '../../lib/tgmedia'
import { useTranslation } from '../../i18n'
import { sortEpisodes } from '../../hooks/useSeriesDetail'

/**
 * 播放中的分集列表侧栏（纯展示）。
 *
 * 数据由调用方经 `useSeriesDetail` 取得后传入 —— 保持单一数据源，
 * 播放器的「即将播放 第 N 集」标注与这里的高亮来自同一份 episodes。
 *
 * 点击某集 → 回调 `onSelect(itemId)`，由调用方在当前播放组内定位。
 * 若目标项不在播放组内，通过 `isSelectable` 判定为**显式禁用**：
 * 点了没反应的控件比禁用态更让人困惑。
 */
export interface EpisodeListProps {
  /** 剧集标题 */
  title: string
  episodes: MediaEpisode[]
  /** 当前播放的条目 id：用于高亮与自动滚动 */
  currentItemId: number
  loading?: boolean
  error?: string | null
  onSelect: (itemId: number) => void
  /** 该项是否在当前播放组内（否则禁用） */
  isSelectable?: (itemId: number) => boolean
  className?: string
}

export function EpisodeList({
  title,
  episodes,
  currentItemId,
  loading,
  error,
  onSelect,
  isSelectable,
  className,
}: EpisodeListProps) {
  const { t } = useTranslation()
  const activeRef = useRef<HTMLButtonElement | null>(null)

  const sorted = useMemo(() => sortEpisodes(episodes ?? []), [episodes])

  // 切集后把当前集滚进可视区（长剧集不滚动会看不到高亮在哪）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentItemId, sorted.length])

  const currentNo = useMemo(
    () => sorted.find((e) => e.itemId === currentItemId)?.episodeNo ?? null,
    [sorted, currentItemId],
  )

  const empty = !loading && (error || sorted.length === 0)

  return (
    <aside
      className={cn(
        'flex w-[300px] shrink-0 flex-col border-l border-border-subtle/60 bg-surface/30',
        className,
      )}
      aria-label={t('player.episodes')}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <ListVideo className="h-4 w-4 shrink-0 text-fg-mid" />
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-strong"
          title={title}
        >
          {title || t('player.episodes')}
        </span>
        {!empty && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted">
            {currentNo ? `${currentNo}/${sorted.length}` : sorted.length}
          </span>
        )}
      </div>

      {loading && <div className="p-3 text-[11px] text-muted">{t('player.episodesLoading')}</div>}

      {empty && (
        <div className="p-3 text-[11px] text-muted">
          {error ? t('player.episodesFailed') : t('player.episodesEmpty')}
        </div>
      )}

      {!loading && !empty && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sorted.map((ep) => {
            const active = ep.itemId === currentItemId
            const enabled = isSelectable ? isSelectable(ep.itemId) : true
            return (
              <button
                key={ep.id}
                ref={active ? activeRef : undefined}
                type="button"
                disabled={!enabled}
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  if (!active && enabled) onSelect(ep.itemId)
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 border-b border-border-subtle/30 px-3 py-2 text-left transition-colors',
                  active ? 'bg-accent/10' : enabled ? 'hover:bg-surface-2/60' : 'opacity-45',
                  !enabled && 'cursor-not-allowed',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-semibold tabular-nums',
                    active ? 'bg-accent text-white' : 'bg-surface-2 text-fg-mid',
                  )}
                >
                  {ep.episodeNo}
                </span>

                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-[12px] leading-snug',
                      active ? 'font-medium text-accent' : 'text-fg-strong',
                    )}
                    title={ep.title || ep.itemTitle || ''}
                  >
                    {ep.title ||
                      ep.itemTitle ||
                      (ep.kind === 'photo'
                        ? t('player.photoEp', { n: ep.episodeNo })
                        : `#${ep.itemId}`)}
                  </span>
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted">
                    {fmtDuration(ep.duration ?? undefined) || '--:--'}
                    {!enabled && ` · ${t('player.notInPlaylist')}`}
                  </span>
                </span>

                {active && <Play className="mt-1 h-3.5 w-3.5 shrink-0 fill-accent text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
