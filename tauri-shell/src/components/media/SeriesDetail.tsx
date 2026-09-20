import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  CloudOff,
  Film,
  GitMerge,
  Image as ImageIcon,
  Music,
  Pencil,
  Play,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { MediaEpisode, MediaSeries, MediaSeriesDetail, MediaTag } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { coverFit, fmtDuration, hasMediaBytes, parseTgRef } from '../../lib/tgmedia'
import {
  setSeriesTags,
  patchSeries,
  patchEpisode,
  moveEpisode,
  switchEpisodeSource,
} from '../../api/media'
import { enqueueCacheTask } from '../../api/tg'
import { generateVideoPoster } from '../../lib/poster'
import { TagPicker } from './TagManagerDialog'

const KIND_LABEL: Record<string, string> = {
  series: '剧集',
  collection: '合集',
  album: '图集',
}

/**
 * 介绍文本：统一「裁剪/全显」规则（总介绍与单集介绍共用）。
 *
 * 规则（基础逻辑）：
 *  - 未超 `maxLines` 行 → 全部显示，无任何按钮；
 *  - 超出 → 折叠到 `maxLines` 行，出现「展开/收起」；
 *  - 用户手写的换行（\n）永远保留；长无空格串（URL 等）强制可断行，不撑破容器。
 */
function DescText(props: { text: string; maxLines: number; className?: string }) {
  const { text, maxLines, className } = props
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    setExpanded(false)
    setClamped(false)
    const el = ref.current
    if (!el) return
    // 折叠态量溢出：scrollHeight > clientHeight 即内容比可视区高（+1 容亚像素误差）
    setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [text, maxLines])
  return (
    <div className={className}>
      <p
        ref={ref}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: maxLines,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
        className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-muted"
      >
        {text}
      </p>
      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[10px] text-accent hover:underline"
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
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
  /** 图片灯箱：剧集图片在自己的浏览位里翻，不进播放器、不占分集槽。 */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  // 剧集名称 / 剧集介绍 / 单集介绍 编辑态
  //
  // 名称必须可编辑：TG 自动成剧的名称取自 caption 首行，规则以外的情形（人工新建、
  // 命名不准）只能靠用户改；此前详情页只能改介绍、改不了名字 ——
  // 用户只能删掉整部剧重建，这是最影响可用性的一处缺口。
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(detail.title)
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState(detail.description ?? '')
  const [editingEp, setEditingEp] = useState<number | null>(null)
  /** 本集标题草稿 —— 改的是**这条内容**的标题（分集会跟着显示同一个名字） */
  const [epTitle, setEpTitle] = useState('')
  const [epDraft, setEpDraft] = useState('')
  /** 槽位草稿（季号/集号）：与标题/介绍一起在同一个面板里提交 */
  const [epSeason, setEpSeason] = useState('1')
  const [epNo, setEpNo] = useState('1')

  /**
   * 重新缓存某一集（BUG-080）。
   *
   * 清缓存只删字节、留条目：这一集仍在剧集列表里，却会以「可播」的外观呈现，
   * 点下去 raw 端点 404。这里给 TG 来源一个**原路取回**的入口（`ref` 里的
   * `chat:msg` 就是下载地址）；本地导入的文件没有原路，只如实标「文件已丢失」。
   */
  const recacheEpisode = (ep: MediaEpisode) => {
    if (ep.source !== 'tg') {
      onError('这一集不是 TG 来源，没有可重新拉取的地址')
      return
    }
    const tg = parseTgRef(ep.ref)
    if (!tg) {
      onError('这一集的来源标识不是 chat:msg，无法重新缓存')
      return
    }
    enqueueCacheTask({ chatId: tg.chatId, messageIds: [tg.messageId] })
      .then(() => onError('已重新入队缓存，完成后这一集会恢复播放'))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /**
   * 打开某一集的编辑面板。
   *
   * 三件事必须一起给：**标题**（此前没有入口，用户只能退到「全部内容」去找卡片）、
   * **介绍**（此前读的是分集行上的副本，条目里有介绍它也显示空）、**槽位**。
   * 三处读的都是同一个来源（见 `MediaEpisode.title/description` 注释）。
   */
  const openEpisodeEdit = (ep: MediaEpisode) => {
    setEditingEp(ep.id)
    setEpTitle(ep.title ?? '')
    setEpDraft(ep.description ?? '')
    setEpSeason(String(ep.season))
    setEpNo(String(ep.episodeNo))
  }

  /**
   * 图片**不是**分集列表的内容 —— 它有独立的浏览位（下方图册）。
   * 混排会让播放序列里出现点不动的「分集」，这正是此前图片侵入视频的表现。
   */
  const photoEps = useMemo(
    () => detail.episodes.filter((e) => e.kind === 'photo'),
    [detail.episodes],
  )
  const playEps = useMemo(
    () => detail.episodes.filter((e) => e.kind !== 'photo'),
    [detail.episodes],
  )

  /** 按季分组（季号升序）——只编排可播发的内容（视频）。 */
  const seasons = useMemo(() => {
    const map = new Map<number, MediaEpisode[]>()
    for (const ep of playEps) {
      if (!map.has(ep.season)) map.set(ep.season, [])
      map.get(ep.season)!.push(ep)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [playEps])

  // 灯箱键盘操作：Esc 关闭、←/→ 翻图片（DOM 焦点不确定，故挂 window）。
  useEffect(() => {
    if (viewerIndex == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewerIndex(null)
      if (e.key === 'ArrowLeft')
        setViewerIndex((i) => ((i ?? 0) - 1 + photoEps.length) % photoEps.length)
      if (e.key === 'ArrowRight') setViewerIndex((i) => ((i ?? 0) + 1) % photoEps.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewerIndex, photoEps.length])

  /** 封面：剧集里第一张图片（photo 文件即封面，免抽帧）→ 显式/已抽帧 poster。
      视频地址绝不进 <img>——视频封面只能走抽帧回写（与 SeriesCard 同一约束）。 */
  const photoEp = photoEps[0] ?? null
  const cover =
    (photoEp ? mediaItemUrl(photoEp.itemId) : null) ??
    detail.poster ??
    playEps[0]?.poster ??
    null

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

  /**
   * 保存剧集名称。
   *
   * 名称是 NOT NULL 且是列表/卡片的主标识，**空值直接拒绝**（不像介绍那样允许清空）——
   * 空标题会让剧集在墙上变成一张无法辨认的卡。前端先拦一道，避免发一次必然 422 的请求。
   */
  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next) return
    setBusy(true)
    try {
      if (next !== detail.title) await patchSeries(detail.id, { title: next })
      setEditingTitle(false)
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
      // 空介绍 = 显式清空（null），不是「不改」——否则介绍设过就永远清不掉
      await patchSeries(detail.id, { description: descDraft.trim() || null })
      setEditingDesc(false)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 保存本集：**标题 + 介绍 + 槽位（季号/集号）**一次提交。
   *
   * 标题与介绍由后端写穿到所指向的条目 —— 分集不持有内容文案的第二份副本，
   * 所以在剧集里改完，媒体库卡片与播放页看到的就是同一个结果。
   * 标题为空时前端直接拦下并说明：空标题会让卡片变成一张认不出的卡，
   * 后端也会按「不改」处理（发出去只会得到「保存了但没变」的假象）。
   *
   * 集号允许任意值（2、3…不必从 1 连续）；若目标槽已被同剧另一条占用，后端对调两条的
   * 槽位 —— 所以这里不做「号是否重复」的客户端校验，那会把后端已经能正确处理的情形
   * 变成假报错。只挡明显非法的输入（空/非正整数）。
   */
  const saveEp = async (epId: number) => {
    const season = Number(epSeason)
    const no = Number(epNo)
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(no) || no < 1) {
      onError('季号与集号必须是 ≥ 1 的整数')
      return
    }
    if (!epTitle.trim()) {
      onError('标题不能为空 —— 空标题会让这条内容在资料库里变成一张认不出的卡')
      return
    }
    setBusy(true)
    try {
      await patchEpisode(epId, {
        title: epTitle.trim(),
        description: epDraft.trim() || null,
        season,
        episodeNo: no,
      })
      setEditingEp(null)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 换位：与同季相邻的一集交换槽位；边界处后端返回 moved=false，如实提示 */
  const moveEp = async (epId: number, dir: 'up' | 'down') => {
    setBusy(true)
    try {
      const r = await moveEpisode(epId, dir)
      if (!r.moved) onError(dir === 'up' ? '已经是本季第一集' : '已经是本季最后一集')
      else onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部：封面 + 元数据 */}
      <div className="flex min-w-0 gap-4 border-b border-border-subtle/60 p-4">
        {/* 极窄窗口下隐藏封面：按钮行的可用宽度不能低于单个按钮（否则出界裁剪） */}
        <div className="hidden h-28 w-48 shrink-0 overflow-hidden rounded-lg bg-surface-2 min-[720px]:block">
          {cover ? (
            <img
              src={cover}
              alt={detail.title}
              className={`h-full w-full ${coverFit(detail.coverKind)}`}
            />
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
            {editingTitle ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="h-7 text-[13px]"
                  autoFocus
                  data-testid="series-title-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveTitle()
                    if (e.key === 'Escape') setEditingTitle(false)
                  }}
                />
                <Button
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  disabled={busy || !titleDraft.trim()}
                  onClick={() => void saveTitle()}
                  data-testid="series-title-save"
                >
                  保存
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={() => {
                    setTitleDraft(detail.title)
                    setEditingTitle(false)
                  }}
                >
                  取消
                </Button>
              </div>
            ) : (
              <>
                <h3 className="min-w-0 flex-1 truncate pt-1 text-[15px] font-semibold text-fg-strong">
                  {detail.title}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(detail.title)
                    setEditingTitle(true)
                  }}
                  className="mt-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                  title="编辑剧集名称"
                  data-testid="series-title-edit"
                >
                  <Pencil className="h-3 w-3" /> 改名
                </button>
              </>
            )}
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
                  {/* 总介绍：≤3 行全显；超出折叠 + 展开/收起（DescText 统一规则） */}
                  <DescText text={detail.description || ''} maxLines={3} className="pr-12" />
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
              className="mt-1 self-start rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
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

      {/* 图片浏览位：图片随内容一起归档进剧集，但**不进播放序列**——它有自己的展位。 */}
      {photoEps.length > 0 ? (
        <div className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">
            图片 · {photoEps.length}
          </h4>
          <div className="flex gap-2 overflow-x-auto pb-1" data-testid="series-gallery">
            {photoEps.map((ep, i) => (
              <button
                key={ep.id}
                type="button"
                onClick={() => setViewerIndex(i)}
                title={ep.title || '浏览图片'}
                data-testid="series-gallery-item"
                className="h-16 w-24 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-2"
              >
                <img
                  src={mediaItemUrl(ep.itemId)}
                  alt={ep.title || '剧集图片'}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 分集列表 */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4">
        {playEps.length === 0 && photoEps.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted">
            还没有内容，去「全部内容」里勾选后点「加入剧集」
          </p>
        ) : playEps.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">本剧集暂无可播放的视频</p>
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
                        {/* 集号可点：打开本集编辑面板（季号/集号/介绍一起改）。
                            集号是**位置**，所以「改号」与「换位」是同一件事的两种入口。 */}
                        <button
                          type="button"
                          onClick={() => openEpisodeEdit(ep)}
                          title="修改季号 / 集号"
                          data-testid="episode-slot"
                          className="w-12 shrink-0 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
                        >
                          {/* 合集显示为区间（E1-2），单集保持 E1 */}
                          S{ep.season}E{ep.episodeNo}
                          {ep.episodeNoEnd != null && ep.episodeNoEnd > ep.episodeNo
                            ? `-${ep.episodeNoEnd}`
                            : ''}
                        </button>
                        {/* 无字节（BUG-080）：**不给播放入口**。
                            一个点了必然 404 的播放按钮，是把「没有字节」伪装成「可以播放」；
                            这里换成占位 +（TG 来源）重新缓存 /（其余）文件已丢失。 */}
                        {hasMediaBytes(ep) ? (
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
                                className={`h-full w-full ${coverFit(ep.kind)}`}
                              />
                            ) : ep.kind === 'photo' ? (
                              <img
                                src={mediaItemUrl(ep.itemId)}
                                alt=""
                                loading="lazy"
                                className="h-full w-full object-contain"
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
                        ) : (
                          <div
                            className="flex h-11 w-20 shrink-0 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-border-subtle bg-surface-2 px-0.5 text-muted"
                            data-testid="episode-nobytes"
                            title={
                              ep.source === 'tg'
                                ? '字节已清理：可重新从 TG 缓存'
                                : '文件已丢失：磁盘上找不到字节'
                            }
                          >
                            <CloudOff className="h-3.5 w-3.5" />
                            <span className="text-[9px] leading-none">
                              {ep.source === 'tg' ? '未缓存' : '文件丢失'}
                            </span>
                            {ep.source === 'tg' ? (
                              <button
                                type="button"
                                onClick={() => recacheEpisode(ep)}
                                className="rounded bg-accent/90 px-1 py-px text-[9px] font-medium leading-none text-white transition-colors hover:bg-accent"
                                title="重新从 TG 拉取这一集的字节"
                                data-testid="episode-recache"
                              >
                                重新缓存
                              </button>
                            ) : null}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {editingEp === ep.id ? (
                              /* 行内编辑标题（BUG-076）：不再另开一行；textarea 自动换行、
                                 完整显示不截断——否则长标题在编辑态被截掉会存错内容。 */
                              <textarea
                                value={epTitle}
                                onChange={(e) => setEpTitle(e.target.value)}
                                placeholder="本集标题"
                                aria-label="本集标题"
                                data-testid="episode-title-input"
                                rows={2}
                                className="min-w-0 flex-1 resize-none rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-[12.5px] text-fg-strong [overflow-wrap:anywhere]"
                              />
                            ) : (
                              <>
                                <p className="truncate text-[12.5px] text-fg-strong" title={ep.title || ''}>
                                  {ep.title || `#${ep.itemId}`}
                                </p>
                                <button
                                  type="button"
                                  onClick={() => openEpisodeEdit(ep)}
                                  className="shrink-0 rounded px-1 text-muted hover:bg-surface-2 hover:text-fg-mid"
                                  title="编辑本集（标题 / 季号 / 集号 / 介绍）"
                                  data-testid="episode-edit"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              </>
                            )}
                            {/* 同槽备用来源（BUG-039）：点击切主；长按/右键语义不做，摘除在编辑面板 */}
                            {(ep.sources?.length ?? 0) > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  void (async () => {
                                    const alt = ep.sources![0]
                                    await switchEpisodeSource(ep.id, alt.itemId)
                                    onChanged()
                                  })()
                                }}
                                title={`备用来源：${ep
                                  .sources!.map((s) => s.title || `#${s.itemId}`)
                                  .join('、')}\n点击把第一个备用源切为主条目`}
                                className="shrink-0 rounded border border-border-subtle/70 px-1 text-[9.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                              >
                                {ep.sources!.length + 1} 源
                              </button>
                            )}
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
                        {/* 换位：与同季相邻一集交换槽位（↑/↓ 各一格） */}
                        <div className="flex shrink-0 flex-col gap-0.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void moveEp(ep.id, 'up')}
                            title="上移一位（与本季上一集换位）"
                            data-testid="episode-move-up"
                            className="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid disabled:opacity-40"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void moveEp(ep.id, 'down')}
                            title="下移一位（与本季下一集换位）"
                            data-testid="episode-move-down"
                            className="flex h-5 w-5 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid disabled:opacity-40"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
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
                          {/* 标题改在行内（与列表同一行），不再单独开一行（BUG-076）。
                              槽位：允许任意 ≥1 的整数（2、3…不必从 1 连续）。
                              目标槽被占用时后端对调两条，故这里不拦「号重复」。 */}
                          <div className="flex items-center gap-2 text-[11px] text-muted">
                            <span>第</span>
                            <input
                              type="number"
                              min={1}
                              value={epSeason}
                              onChange={(e) => setEpSeason(e.target.value)}
                              aria-label="季号"
                              data-testid="episode-season-input"
                              className="h-6 w-14 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
                            />
                            <span>季</span>
                            <span>第</span>
                            <input
                              type="number"
                              min={1}
                              value={epNo}
                              onChange={(e) => setEpNo(e.target.value)}
                              aria-label="集号"
                              data-testid="episode-no-input"
                              className="h-6 w-14 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
                            />
                            <span>集</span>
                            <span className="text-[10px] text-muted/80">
                              （号被占用时会与那一集互换位置）
                            </span>
                          </div>
                          <textarea
                            value={epDraft}
                            onChange={(e) => setEpDraft(e.target.value)}
                            placeholder="本集介绍…"
                            rows={2}
                            className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-fg-strong"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="h-6 px-2.5 text-[11px]"
                              disabled={busy}
                              onClick={() => void saveEp(ep.id)}
                              data-testid="episode-save"
                            >
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
                        /* 单集介绍：≤2 行全显；超出折叠 + 展开/收起（与总介绍同一规则） */
                        <DescText
                          text={ep.description}
                          maxLines={2}
                          className="mt-1 pl-[4.25rem] text-[10.5px]"
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* 图片灯箱：←/→ 翻页，Esc 关闭。图片只在浏览位里翻，永不进播放器。 */}
      {viewerIndex != null && photoEps[viewerIndex] ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
          onClick={() => setViewerIndex(null)}
          data-testid="series-photo-viewer"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setViewerIndex(null)
            }}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
          {photoEps.length > 1 ? (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setViewerIndex((i) => ((i ?? 0) - 1 + photoEps.length) % photoEps.length)
                }}
                className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                aria-label="上一张"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setViewerIndex((i) => ((i ?? 0) + 1) % photoEps.length)
                }}
                className="absolute right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
                aria-label="下一张"
              >
                ›
              </button>
            </>
          ) : null}
          <img
            src={mediaItemUrl(photoEps[viewerIndex].itemId)}
            alt={photoEps[viewerIndex].title || '剧集图片'}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/70">
            {viewerIndex + 1} / {photoEps.length}
          </p>
        </div>
      ) : null}
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

  // 图片类可以直接原图当封面，且**优先于任何派生 poster**——poster 可能是历史上
  // 自动抽帧回写的视频帧（甚至黑帧），有图片集时原图才是最忠实的封面。
  const cover =
    (series.coverKind === 'photo' && series.coverItemId
      ? mediaItemUrl(series.coverItemId)
      : null) ?? poster ?? null
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border border-border-subtle/60 bg-surface transition-colors hover:border-accent/50">
      <button
        type="button"
        onClick={onOpen}
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
            {series.tags.map((t) => (
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
        className="absolute bottom-1 right-1 flex h-8 w-8 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
        title="删除剧集"
        aria-label="删除剧集"
        data-testid="series-card-delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}
