import { useEffect, useMemo, useState } from 'react'
import { Film, GitMerge, Image as ImageIcon, Music, Pencil, Play, Tag, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import type { MediaEpisode, MediaSeries, MediaSeriesDetail, MediaTag } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { fmtDuration } from '../../lib/tgmedia'
import { setSeriesTags, patchSeries, patchEpisode } from '../../api/media'
import { generateVideoPoster } from '../../lib/poster'
import { TagPicker } from './TagManagerDialog'

const KIND_LABEL: Record<string, string> = {
  series: '剧集',
  collection: '合集',
  album: '图集',
}

/** 剧集详情：元数据头 + 按季分组的分集列表（可播放/移除） */
export function SeriesDetail(props: {
  detail: MediaSeriesDetail
  tags: MediaTag[]
  /** 从第 index 集开始播放（整季作为一个播放组，支持 ←/→ 切换） */
  onPlay: (index: number) => void
  onRemoveEpisode: (ep: MediaEpisode) => void
  onDeleteSeries: () => void
  /** 打开「合并到…」对话框（把另一个剧集整体并入当前剧集） */
  onMerge: () => void
  onBack: () => void
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const {
    detail,
    tags,
    onPlay,
    onRemoveEpisode,
    onDeleteSeries,
    onMerge,
    onBack,
    onChanged,
    onError,
  } = props
  const [editingTags, setEditingTags] = useState(false)
  const [selected, setSelected] = useState<number[]>(detail.tags.map((t) => t.id))
  const [busy, setBusy] = useState(false)
  // 剧集介绍 / 单集介绍 编辑态（问题3）
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(detail.description ?? '')
  const [editingEp, setEditingEp] = useState<number | null>(null)
  const [epDraft, setEpDraft] = useState('')

  /** 按季分组（季号升序） */
  const seasons = useMemo(() => {
    const map = new Map<number, MediaEpisode[]>()
    for (const ep of detail.episodes) {
      if (!map.has(ep.season)) map.set(ep.season, [])
      map.get(ep.season)!.push(ep)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [detail.episodes])

  /** 封面：剧集显式封面 → 首集封面 → 首集原图（图片类无需生成缩略） */
  const cover =
    detail.poster ??
    detail.episodes[0]?.poster ??
    (detail.episodes[0] ? mediaItemUrl(detail.episodes[0].itemId) : null)

  const saveTags = async () => {
    setBusy(true)
    try {
      await setSeriesTags(detail.id, selected)
      setEditingTags(false)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveDesc = async () => {
    setBusy(true)
    try {
      await patchSeries(detail.id, { description: descDraft.trim() || undefined })
      setEditingDesc(false)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveEp = async (epId: number) => {
    setBusy(true)
    try {
      await patchEpisode(epId, { description: epDraft.trim() || undefined })
      setEditingEp(null)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：封面 + 元数据 */}
      <div className="flex shrink-0 gap-4 border-b border-border-subtle/60 p-4">
        <div className="h-28 w-48 shrink-0 overflow-hidden rounded-lg bg-surface-2">
          {cover ? (
            <img src={cover} alt={detail.title} className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-muted">
              {detail.kind === 'album' ? (
                <ImageIcon className="h-8 w-8" />
              ) : (
                <Film className="h-8 w-8" />
              )}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-[11px]"
              onClick={onBack}
            >
              ← 返回
            </Button>
            <h3 className="min-w-0 flex-1 truncate pt-1 text-[15px] font-semibold text-fg-strong">
              {detail.title}
            </h3>
          </div>
          {detail.description || editingDesc ? (
            <div className="mt-1">
              {editingDesc ? (
                <div className="space-y-1.5">
                  <textarea
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    placeholder="剧集介绍…"
                    rows={3}
                    className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[11.5px] text-fg-strong"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="h-6 px-2.5 text-[11px]" disabled={busy} onClick={() => void saveDesc()}>
                      保存
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2.5 text-[11px]"
                      onClick={() => setEditingDesc(false)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="group/desc relative">
                  <p className="line-clamp-3 pr-12 text-[11.5px] leading-relaxed text-muted">
                    {detail.description}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDescDraft(detail.description ?? '')
                      setEditingDesc(true)
                    }}
                    className="absolute right-0 top-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                  >
                    <Pencil className="h-3 w-3" /> 编辑
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDescDraft('')
                setEditingDesc(true)
              }}
              className="mt-1 rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
            >
              ＋ 添加剧集介绍
            </button>
          )}
          <p className="mt-1 text-[11px] text-muted">
            {KIND_LABEL[detail.kind] ?? detail.kind}
            {detail.year ? ` · ${detail.year}` : ''} · {detail.episodeCount} 集 ·{' '}
            {detail.seasonCount} 季
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                setSelected(detail.tags.map((t) => t.id))
                setEditingTags((v) => !v)
              }}
            >
              <Tag className="h-3.5 w-3.5" />
              标签
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onMerge}
              title="把另一个剧集的内容并入本剧集（源剧集会被删除）"
            >
              <GitMerge className="h-3.5 w-3.5" />
              合并到…
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive"
              onClick={onDeleteSeries}
            >
              删除剧集
            </Button>
          </div>
        </div>
      </div>

      {editingTags ? (
        <div className="shrink-0 border-b border-border-subtle/60 bg-surface-2/40 px-4 py-3">
          <TagPicker tags={tags} selected={selected} onChange={setSelected} />
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-7 px-3 text-[11px]" disabled={busy} onClick={() => void saveTags()}>
              保存标签
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-[11px]"
              onClick={() => setEditingTags(false)}
            >
              取消
            </Button>
          </div>
        </div>
      ) : detail.tags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border-subtle/60 px-4 py-2">
          {detail.tags.map((t) => (
            <span
              key={t.id}
              className="rounded-full px-2 py-0.5 text-[10px]"
              style={{ background: `${t.color ?? '#64748b'}22`, color: t.color ?? '#64748b' }}
            >
              {t.name}
            </span>
          ))}
        </div>
      ) : null}

      {/* 分集列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {detail.episodes.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted">
            还没有分集，去「全部内容」里勾选后点「加入剧集」
          </p>
        ) : (
          seasons.map(([season, eps]) => (
            <section key={season} className="mb-4">
              <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">第 {season} 季</h4>
              <ul className="space-y-1">
                {eps.map((ep) => {
                  const idx = detail.episodes.indexOf(ep)
                  return (
                    <li
                      key={ep.id}
                      className="rounded-md border border-transparent px-2 py-1.5 hover:border-border-subtle/60 hover:bg-surface-2/70"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-[11px] font-medium text-muted">
                          S{ep.season}E{ep.episodeNo}
                        </span>
                        <button
                          type="button"
                          onClick={() => onPlay(idx)}
                          className="relative h-11 w-20 shrink-0 overflow-hidden rounded bg-surface-2"
                          title={ep.kind === 'photo' ? '浏览图片' : '播放'}
                        >
                          {ep.poster ? (
                            <img
                              src={ep.poster}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : ep.kind === 'photo' ? (
                            <img
                              src={mediaItemUrl(ep.itemId)}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-muted">
                              {ep.kind === 'audio' ? (
                                <Music className="h-4 w-4" />
                              ) : (
                                <Film className="h-4 w-4" />
                              )}
                            </span>
                          )}
                          {/* 动作标识按类型区分：图片是「浏览」，不是「播放」 */}
                          <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity hover:opacity-100">
                            {ep.kind === 'photo' ? (
                              <ImageIcon className="h-4 w-4" />
                            ) : (
                              <Play className="h-4 w-4 fill-white" />
                            )}
                          </span>
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[12.5px] text-fg-strong">
                              {ep.title || ep.itemTitle || `#${ep.itemId}`}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingEp(ep.id)
                                setEpDraft(ep.description ?? '')
                              }}
                              className="shrink-0 rounded px-1 text-muted hover:bg-surface-2 hover:text-fg-mid"
                              title="编辑本集介绍"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                          {/* 副行按类型给语义：图片没有时长概念，显示「--:--」会被误当可播内容 */}
                          <p className="text-[10px] text-muted">
                            {ep.kind === 'photo'
                              ? '图片'
                              : fmtDuration(ep.duration ?? undefined) || '--:--'}
                            {/* 合并溯源：重编集号后必须让用户知道「这条原来是哪部剧的第几集」，
                                否则「搬来的 1-2」与目标原有的 1、2 会分不清谁是谁 */}
                            {(ep.originSeriesTitle || ep.originEpisodeNo != null) && (
                              <span className="text-accent/80">
                                {' · '}
                                {ep.originSeriesTitle
                                  ? `合并自《${ep.originSeriesTitle}》`
                                  : '合并自其他剧集'}
                                {ep.originEpisodeNo != null ? ` 原 E${ep.originEpisodeNo}` : ''}
                              </span>
                            )}
                            {/* 文件来源：「同一内容多源导入」时，这是判断该删哪条的唯一依据
                                （标题与文件名都不可靠，见 BUG-037） */}
                            {ep.ref && (
                              <span
                                className="text-muted/70"
                                title={`${ep.source === 'tg' ? 'TG' : '本地'} · ${ep.ref}`}
                              >
                                {' · '}
                                {ep.source === 'tg' ? 'TG' : '本地'}
                              </span>
                            )}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-[11px] text-destructive"
                          onClick={() => onRemoveEpisode(ep)}
                          title="从剧集中移除（内容保留在资料库）"
                        >
                          移除
                        </Button>
                      </div>
                      {editingEp === ep.id ? (
                        <div className="mt-1.5 space-y-1.5 pl-[4.25rem]">
                          <textarea
                            value={epDraft}
                            onChange={(e) => setEpDraft(e.target.value)}
                            placeholder="本集介绍…"
                            rows={2}
                            className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-fg-strong"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" className="h-6 px-2.5 text-[11px]" disabled={busy} onClick={() => void saveEp(ep.id)}>
                              保存
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2.5 text-[11px]"
                              onClick={() => setEditingEp(null)}
                            >
                              取消
                            </Button>
                          </div>
                        </div>
                      ) : ep.description ? (
                        <p className="mt-1 line-clamp-2 pl-[4.25rem] text-[10.5px] text-muted">
                          {ep.description}
                        </p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

/** 剧集卡片（剧集浏览墙用） */
export function SeriesCard(props: {
  series: MediaSeries
  tags: MediaTag[]
  onOpen: () => void
  onDelete: () => void
  /** 抽帧得到的封面回写成功（持久化到剧集，下次直接复用） */
  onCoverReady?: (seriesId: number, poster: string) => void
}) {
  const { series, tags, onOpen, onDelete, onCoverReady } = props
  const [poster, setPoster] = useState<string | null>(series.poster ?? null)
  const [coverFailed, setCoverFailed] = useState(false)

  useEffect(() => {
    setPoster(series.poster ?? null)
    setCoverFailed(false)
  }, [series.id, series.poster])

  /** 首集是视频且没有封面 → 抽帧生成并回写（与内容卡片同一套机制） */
  useEffect(() => {
    if (poster || coverFailed) return
    if (series.coverKind !== 'video' || !series.coverItemId) return
    let alive = true
    generateVideoPoster(mediaItemUrl(series.coverItemId), 1, 480)
      .then((p) => {
        if (!alive) return
        setPoster(p.dataUrl)
        onCoverReady?.(series.id, p.dataUrl)
      })
      .catch(() => {
        if (alive) setCoverFailed(true)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id, series.coverKind, series.coverItemId, poster, coverFailed])

  // 图片类可以直接原图当封面；视频必须等抽帧，绝不能把视频地址塞进 <img>
  const cover =
    poster ??
    (series.coverKind === 'photo' && series.coverItemId
      ? mediaItemUrl(series.coverItemId)
      : null)
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border-subtle/60 bg-surface transition-colors hover:border-accent/50">
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-video w-full overflow-hidden bg-surface-2"
      >
        {cover ? (
          <img src={cover} alt={series.title} className="h-full w-full object-cover" />
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
            查看
          </span>
        </span>
        <span className="absolute left-1 top-1 rounded bg-accent/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {KIND_LABEL[series.kind] ?? series.kind}
        </span>
        <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] text-white">
          {series.episodeCount} 集
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
        <p className="truncate text-[12px] font-medium text-fg-strong" title={series.title}>
          {series.title}
        </p>
        <p className="text-[10px] text-muted">
          {series.seasonCount} 季 · {series.episodeCount} 集
        </p>
        {series.tags.length > 0 ? (
          <p className="flex flex-wrap gap-1 pt-0.5">
            {series.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className="rounded px-1 py-px text-[9px]"
                style={{ background: `${t.color ?? '#64748b'}22`, color: t.color ?? '#64748b' }}
              >
                {tags.find((x) => x.id === t.id)?.name ?? t.name}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="absolute bottom-1 right-1 flex items-center rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
        title="删除剧集"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  )
}
