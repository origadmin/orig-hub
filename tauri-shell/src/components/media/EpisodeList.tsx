import { useEffect, useMemo, useRef } from 'react'
import { Image as ImageIcon, ListVideo } from 'lucide-react'
import type { MediaEpisode } from '../../api/media'
import { cn } from '../../lib/utils'
import { fmtDuration } from '../../lib/tgmedia'
import { useTranslation } from '../../i18n'
import { sortEpisodes } from '../../hooks/useSeriesDetail'

/**
 * 播放/浏览中的分集列表侧栏（纯展示）。
 *
 * 数据由调用方经 `useSeriesDetail` 取得后传入 —— 保持单一数据源，
 * 播放器的「即将播放 第 N 集」标注与这里的高亮来自同一份 episodes。
 *
 * **按媒体类型区分呈现**（剧集可以是混合内容）：
 *   视频/音频 → 集号 + 时长，点击 = 播放
 *   图片      → 类型图标 + 「图片」标签，点击 = 浏览（不进播放序列）
 * 若不做区分，图片会以「第 N 集 · --:--」的形态混在电影的分集里 ——
 * 用户报的「图片被当视频播放」正是这种呈现造成的。
 *
 * 点击某集 → 回调 `onSelect(itemId)`，由调用方定位。
 * 若目标项不在当前列表内，通过 `isSelectable` 判定为**显式禁用**：
 * 点了没反应的控件比禁用态更让人困惑。
 *
 * 行尾**不挂任何播放图标**：当前集已由「强调色底 + 强调色标题 + 序号徽标反色」表达，
 * 再挂一个 ▶ 只会让人以为那是「点这里播放本集」的按钮 —— 而当前集本来就在播，
 * 点它什么也不会发生。看得见却按不动的控件是纯误导，故不表达。
 */
export interface EpisodeListProps {
  /** 剧集标题 */
  title: string
  episodes: MediaEpisode[]
  /** 当前播放/浏览的条目 id：用于高亮与自动滚动 */
  currentItemId: number
  loading?: boolean
  error?: string | null
  onSelect: (itemId: number) => void
  /** 该项是否在当前列表内（否则禁用） */
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

  /**
   * 同类序列内的序号：视频与图片**各自从 1 起**。
   *
   * 不直接用 episodeNo —— 图片在加入剧集时也会占用集号（实测某剧集
   * 视频集号为 1、2、6、7、8，因为 3、4、5 被图片占了），直接显示会跳号。
   * 侧栏的作用是导航，按「连着播第几个」呈现更符合心智；
   * 原始集号在副行以 `E<n>` 标出，避免与数据脱节。
   */
  const seqNo = useMemo(() => {
    const m = new Map<number, { pos: number; isPhoto: boolean }>()
    let v = 0
    let p = 0
    for (const e of sorted) {
      const isPhoto = e.kind === 'photo'
      m.set(e.itemId, { pos: isPhoto ? ++p : ++v, isPhoto })
    }
    return m
  }, [sorted])

  const videoCount = useMemo(() => sorted.filter((e) => e.kind !== 'photo').length, [sorted])
  const photoCount = sorted.length - videoCount

  // 切集后把当前项滚进可视区（长剧集不滚动会看不到高亮在哪）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentItemId, sorted.length])

  /**
   * 当前项在「同类型序列」内的位置 —— 与播放器返回行同源。
   * 不用 episodeNo：混合剧集里图片会被编出「第 4 集」这种误导性编号，
   * 且 episodeNo 本身会断档（实测某剧集为 4、5、7），直接显示会错位。
   */
  const seqInfo = useMemo(() => {
    const c = sorted.find((e) => e.itemId === currentItemId)
    if (!c) return null
    const isPhoto = c.kind === 'photo'
    const seq = sorted.filter((e) => (e.kind === 'photo') === isPhoto)
    return { pos: seq.findIndex((e) => e.itemId === currentItemId) + 1, total: seq.length }
  }, [sorted, currentItemId])

  const empty = !loading && (error || sorted.length === 0)

  /** 头部计数：混合剧集把两类都标出来，避免「8 集」实为 5 视频 + 3 图片的误导 */
  const headerCount = (() => {
    if (empty) return null
    if (videoCount > 0 && photoCount > 0)
      return t('player.mixedCount', { v: videoCount, p: photoCount })
    if (!seqInfo) return `${sorted.length}`
    return `${seqInfo.pos}/${seqInfo.total}`
  })()

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
        {headerCount && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted">{headerCount}</span>
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
            const isPhoto = ep.kind === 'photo'
            const seq = seqNo.get(ep.itemId)
            // 标题直接取分集字段 —— 后端已把它收敛为「所指向条目的标题」，
            // 这里不再有 `ep.title || ep.itemTitle` 的兜底链（两个名字的来源）。
            const label =
              ep.title ||
              (isPhoto ? t('player.photoEp', { n: seq?.pos ?? 1 }) : '') ||
              `#${ep.itemId}`
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
                {/* 徽标：视频给集号，图片给类型图标 —— 一眼能分出「能播」和「只能看」 */}
                {isPhoto ? (
                  <span
                    className={cn(
                      'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded',
                      active ? 'bg-accent text-white' : 'bg-surface-2 text-fg-mid',
                    )}
                    title={t('player.photoLabel')}
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <span
                    className={cn(
                      'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-semibold tabular-nums',
                      active ? 'bg-accent text-white' : 'bg-surface-2 text-fg-mid',
                    )}
                  >
                    {seq?.pos ?? ep.episodeNo}
                  </span>
                )}

                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-[12px] leading-snug',
                      active ? 'font-medium text-accent' : 'text-fg-strong',
                    )}
                    title={ep.title || ''}
                  >
                    {label}
                  </span>
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted">
                    {isPhoto ? (
                      t('player.photoLabel')
                    ) : (
                      <>
                        {/* 集号与「第几个」不一致时（图片占用了集号）标出原始集号，避免与数据脱节 */}
                        {ep.episodeNo !== seq?.pos ? `E${ep.episodeNo} · ` : ''}
                        {fmtDuration(ep.duration ?? undefined) || '--:--'}
                      </>
                    )}
                    {!enabled && ` · ${t('player.notInPlaylist')}`}
                    {/* 合并溯源：集号重编过，必须让人知道「这条原来属于哪部剧、是第几集」——
                        否则合并后与目标原有的同号分集分不清谁是谁 */}
                    {(ep.originSeriesTitle || ep.originEpisodeNo != null) && (
                      <span className="block text-[10px] text-accent/75">
                        {ep.originSeriesTitle
                          ? `合并自《${ep.originSeriesTitle}》`
                          : '合并自其他剧集'}
                        {ep.originEpisodeNo != null ? ` 原 E${ep.originEpisodeNo}` : ''}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
