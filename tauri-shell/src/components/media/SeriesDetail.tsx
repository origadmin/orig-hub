import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  CloudOff,
  Film,
  GitMerge,
  Image as ImageIcon,
  ImagePlus,
  Music,
  Pencil,
  Play,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { MediaEpisode, MediaItem, MediaSeries, MediaSeriesDetail, MediaTag } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import {
  canRecacheFromSource,
  coverFit,
  fmtDuration,
  hasMediaBytes,
  recacheFromSource,
  sourceLabelKey,
} from '../../lib/mediaSources'
import {
  createTag,
  setSeriesTags,
  patchSeries,
  patchEpisode,
  moveEpisode,
  switchEpisodeSource,
  attachEpisodeImages,
  detachEpisodeImage,
  listMediaItems,
} from '../../api/media'
import { generateVideoPoster } from '../../lib/poster'
import { TagPicker } from './TagManagerDialog'
import { TagToken } from './TagToken'
import { useTranslation } from '../../i18n'

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
  const { t } = useTranslation()
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
   * 合集区间终点（BUG-153）。
   *
   * 一条分集可以覆盖**一段**集号（E3-4，一个视频装着两集的量），此前编辑面板只给起点，
   * 于是这种分集的终点既改不了、也退不回单集 —— 用户原话「多集无法编辑，集数只能修改前」。
   * 后端 `EpisodeEdit.episode_no_end` 是三态（不传=不改 / null=清除区间 / n=设为 n），
   * 前端此前**从不传这个字段**，等于把后端能力砍掉一半。
   * 空串 = 单集（提交时显式传 null，不能省略字段，否则「改回单集」的意图丢失）。
   */
  const [epEnd, setEpEnd] = useState('')

  /**
   * 重新缓存某一集（BUG-080）。
   *
   * 清缓存只删字节、留条目：这一集仍在剧集列表里，却会以「可播」的外观呈现，
   * 点下去 raw 端点 404。这里给**支持原路取回的来源**一个入口（TG 的 `ref` 里
   * `chat:msg` 就是下载地址）；本地导入的文件没有原路，只如实标「文件已丢失」。
   *
   * 判定走 `canRecacheFromSource(source)`，**不写死 'tg'** —— 来源是可扩展的，
   * 今天只有 TG 能原路取回，明天 OSS/S3 也能，剧集页不该知道这件事。
   */
  const recacheEpisode = (ep: MediaEpisode) => {
    if (!canRecacheFromSource(ep.source)) {
      onError(`这一集的来源（${t(sourceLabelKey(ep.source))}）没有可重新拉取的地址`)
      return
    }
    recacheFromSource(ep.ref, ep.source)
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
    // 合集分集预填终点（单集为空串）——BUG-153：不预填等于用户一保存就把区间冲成单集。
    setEpEnd(ep.episodeNoEnd != null ? String(ep.episodeNoEnd) : '')
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
   * 打标签时**就地新建**标签。
   *
   * `tags` 是父层传下来的只读列表，剧集页自己没有「重新拉标签」的通道；
   * 但搜不到就让人关掉面板去标签管理绕一圈，是把一个动作劈成两处。
   * 这里建完交给 `onChanged()`（父层的 `refreshAll` 会连带 `listTags`），
   * 返回 id 让 `TagPicker` 立刻勾上 —— 用户感知是「一个动作」。
   */
  const createTagHere = async (name: string): Promise<number | null> => {
    try {
      const r = await createTag(name)
      onChanged()
      return r.id
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      return null
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
   *
   * 合集区间终点（`episodeNoEnd`）随本次提交一起下发 —— 两集合装在一个文件里的分集
   * 此前只能改起点，这里是它唯一的编辑入口（BUG-153）。
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
    /*
     * 区间终点（BUG-153）：
     *  - 留空      → `null`，显式表达「改回单集」。**必须传字段**：后端 Option<Option<i64>>，
     *                省略字段是「不改」，那样用户清空输入后区间还在，等于点了保存没反应。
     *  - 非数字    → 拦下（含小数、负数）。
     *  - `<= 起点` → 按单集处理（传 `null`）并提示。
     *
     * 「<= 起点 视为单集」而不是「直接报错」：单个视频装一段集号是本模型的常态，
     * E5-5 与 E5 是同一个东西的两种写法。用户的意图是「它不再是一段」，报错会逼他
     * 把 5 改成 4（更小的数字反而合法）—— 那才是把用户往错的方向推。故这里归一化并
     * 内联说明，让「输入被接受了，且被当成单集」这件事可见。
     */
    const endRaw = epEnd.trim()
    let end: number | null = null
    let endHint = ''
    if (endRaw !== '') {
      const n = Number(endRaw)
      if (!Number.isInteger(n) || n < 1) {
        onError('结束集号必须是 ≥ 1 的整数（留空 = 单集）')
        return
      }
      if (n <= no) {
        end = null
        endHint = `结束集号 ${n} 不大于起始集号 ${no}，已按单集保存`
      } else {
        end = n
      }
    }
    setBusy(true)
    try {
      await patchEpisode(epId, {
        title: epTitle.trim(),
        description: epDraft.trim() || null,
        season,
        episodeNo: no,
        // 恒定下发：省略字段 = 后端「不改」，清空区间就永远生效不了
        episodeNoEnd: end,
      })
      setEditingEp(null)
      if (endHint) onError(endHint)
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

  /**
   * 摘除一张集级挂图（BUG-168）：只摘关联，图片条目留在资料库。
   * `removed:0`（本来就没挂）不单独提示 —— 目标态已达成，与成功同观感。
   */
  const removeEpisodeImage = async (epId: number, itemId: number) => {
    try {
      await detachEpisodeImage(epId, itemId)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 集级挂图选择对话框（BUG-168）：列出媒体库的 photo 条目，多选后 replace-all 挂载 */
  const [pickingImages, setPickingImages] = useState<MediaEpisode | null>(null)

  /**
   * 集级挂图**放大浏览**（BUG-168）。
   *
   * 行内缩略条只给 48×36 —— 那只是「这一集挂了图」的证据，看不清内容。点缩略图
   * 在这里打开一张大图：只读、不进播放器、不占分集槽（与剧集图册灯箱同一约束）。
   */
  const [epImageView, setEpImageView] = useState<{ src: string; title: string } | null>(null)
  /** 展开「全部挂图」的分集行：默认每行只露前 3 张，其余折叠 —— 一集挂十几张图时
      不能把整条列表撑成图片墙。 */
  const [expandedImgRows, setExpandedImgRows] = useState<number[]>([])
  const toggleImgRow = (epId: number) =>
    setExpandedImgRows((rows) =>
      rows.includes(epId) ? rows.filter((r) => r !== epId) : [...rows, epId],
    )

  // 挂图灯箱：Esc 关闭（DOM 焦点不确定，故挂 window）
  useEffect(() => {
    if (!epImageView) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEpImageView(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [epImageView])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条（整页重排）：返回 + 剧集级操作独立置顶 —— 操作按钮原本挤在
          文字列底部的 `mt-auto` 行里，把头部压得很挤。提出来后头部只承载
          「海报 + 标题/元信息/标签/简介」，操作入口位置在任何宽度下都稳定。 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle/60 px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={onBack}
        >
          ← 返回
        </Button>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            data-testid="series-tag-edit"
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
      {/* 头部：封面 + 元数据 */}
      <div className="flex min-w-0 gap-4 border-b border-border-subtle/60 p-4">
        {/* 极窄窗口下隐藏封面：按钮行的可用宽度不能低于单个按钮（否则出界裁剪） */}
        {/* Hero 海报 320×180（整页重排：原 192×112 太小，撑不起头部视觉重心） */}
        {/* self-start：父级 flex 默认 align-items:stretch 会把海报拉成与右列等高，
            aspect-video 失效（实测 720px 窗口下 320×634）。回到顶部对齐，16:9 任意宽度成立。 */}
        <div className="hidden aspect-video w-80 shrink-0 self-start overflow-hidden rounded-lg bg-surface-2 min-[720px]:block">
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
                {/* 标题允许换行（最多 2 行）：单行 truncate 会把长剧名截成半句 */}
                <h3 className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] line-clamp-2 text-[15px] font-semibold leading-snug text-fg-strong">
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
          {/* 元信息（整页重排：上移到标题正下方 —— 「这是什么」应先于「讲什么」被读到） */}
          <p className="mt-1.5 text-[11px] text-muted">
            {KIND_LABEL[detail.kind] ?? detail.kind}
            {detail.year ? ` · ${detail.year}` : ''} · {detail.episodeCount} 集 ·{' '}
            {detail.seasonCount} 季
          </p>
          {/* 标签 chips：原独立的「标签展示行」合并进 Hero 右列（整页重排） */}
          {detail.tags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-0.5" data-testid="series-hero-tags">
              {detail.tags.map((t) => (
                <TagToken key={t.id} name={t.name} />
              ))}
            </div>
          ) : null}
          {/*
            剧集介绍：**整页只有这一处**。
            Hero 里常驻整段（whitespace-pre-wrap，换行照原文、不截成单行）——
            此前把它搬到聚焦区下方的「本集/全剧」合并区，结果是同一份文案在页面上
            出现两次、且割裂在两处，用户判定「不如之前的左右设计」。改回行式分集列表后，
            介绍也一并回到 Hero 常驻位；分集列表里只保留**本集**介绍 ——
            且与此处逐字相同的那份（TG 抓取常见）不再重复渲染，见下方 showEpDesc。
          */}
          {editingDesc ? (
            <div className="mt-1.5 space-y-1.5">
              <textarea
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                placeholder="剧集介绍…"
                aria-label="剧集介绍"
                data-testid="series-desc-input"
                rows={3}
                className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[11.5px] text-fg-strong"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-6 px-2.5 text-[11px]"
                  disabled={busy}
                  onClick={() => void saveDesc()}
                  data-testid="series-desc-save"
                >
                  保存
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2.5 text-[11px]"
                  onClick={() => setEditingDesc(false)}
                  data-testid="series-desc-cancel"
                >
                  取消
                </Button>
              </div>
            </div>
          ) : detail.description ? (
            <div className="mt-1.5 flex items-start gap-1.5">
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11.5px] leading-relaxed text-muted">
                {detail.description}
              </p>
              <button
                type="button"
                onClick={() => {
                  setDescDraft(detail.description ?? '')
                  setEditingDesc(true)
                }}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                title={t('media.editSeriesDesc')}
                data-testid="series-desc-edit"
              >
                <Pencil className="h-3 w-3" /> 编辑
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDescDraft('')
                setEditingDesc(true)
              }}
              className="mt-1.5 self-start rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
              data-testid="series-desc-edit"
            >
              {t('media.addSeriesDesc')}
            </button>
          )}
        </div>
      </div>

      {editingTags ? (
        <div className="shrink-0 border-b border-border-subtle/60 bg-surface-2/40 px-4 py-3">
          <TagPicker
            tags={tags}
            selected={selected}
            onChange={setSelected}
            onCreate={createTagHere}
          />
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
      ) : null}

      {/* 图片浏览位：图片随内容一起归档进剧集，但**不进播放序列**——它有自己的展位。 */}
      {photoEps.length > 0 ? (
        <div className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">
            图片 · {photoEps.length}
          </h4>
          <div className="flex gap-2 overflow-x-auto pb-1" data-testid="series-gallery">
            {photoEps.map((ep, i) => (
              // 外层用 div 而非 button：每张图里要放「浏览」与「移除」两个按钮，
              // 外层若仍是 button 会形成**嵌套按钮**（HTML 非法，点击语义也会串）。
              <div
                key={ep.id}
                className="group relative h-[120px] w-[160px] shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-2"
              >
                <button
                  type="button"
                  onClick={() => setViewerIndex(i)}
                  title={ep.title || '浏览图片'}
                  data-testid="series-gallery-item"
                  className="block h-full w-full"
                >
                  <img
                    src={mediaItemUrl(ep.itemId)}
                    alt={ep.title || '剧集图片'}
                    loading="lazy"
                    className={`h-full w-full ${coverFit(ep.kind)}`}
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
                  title="从剧集中移除（内容保留在资料库）"
                  aria-label="从剧集中移除（内容保留在资料库）"
                  data-testid="series-gallery-remove"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 分集列表：左右行式（封面在左、标题与操作在右），按季分组。
          改版来回：这一块曾被改成「单集聚焦 + 底部 chip 切换条」，用户判定
          「不符合主流设计 / 越改越丑 / 不如之前的左右设计」，故回到行式。
          唯一保留下来的改动是**封面放大到 160×90**（原 80×44 被形容为「和 ICON 一样小」）。 */}
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
                  const imgs = ep.images ?? []
                  /** 默认只露前 3 张，其余折叠 —— 一集挂十几张图时不能把整条列表撑成图片墙 */
                  const shownImgs = expandedImgRows.includes(ep.id) ? imgs : imgs.slice(0, 3)
                  /* 本集介绍去重：TG 抓取的剧集会把整段剧集简介逐字复制进每一集
                     （实测 series 101：单集、简介与剧集简介 120 字完全相同）。
                     简介已在 Hero 常驻显示，行内再渲染一次就是同一段文案出现两遍 ——
                     逐字相同才隐藏，真有独立本集介绍时照常显示。
                     ⚠️ 只影响展示：编辑入口（episode-slot / episode-edit）始终保留，
                     点开面板仍可读写这一集的 description 字段。 */
                  const seriesDesc = (detail.description ?? '').trim()
                  const epDesc = (ep.description ?? '').trim()
                  const showEpDesc = epDesc.length > 0 && epDesc !== seriesDesc
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
                            className="relative aspect-video w-40 shrink-0 overflow-hidden rounded bg-surface-2"
                            title={ep.kind === 'photo' ? '浏览图片' : '播放'}
                            data-testid="episode-cover"
                          >
                            {ep.poster ? (
                              /* 封面必须走 coverFit：photo → object-contain（图片是内容本身，
                                 裁掉边缘就是丢内容），非 photo → object-cover（封面只是指代） */
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
                            className="flex aspect-video w-40 shrink-0 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-border-subtle bg-surface-2 px-0.5 text-muted"
                            data-testid="episode-nobytes"
                            title={
                              canRecacheFromSource(ep.source)
                                ? t('media.recacheFrom', {
                                    source: t(sourceLabelKey(ep.source)),
                                  })
                                : t('media.fileMissingHint')
                            }
                          >
                            <CloudOff className="h-3.5 w-3.5" />
                            <span className="text-[9px] leading-none">
                              {canRecacheFromSource(ep.source)
                                ? t('media.notCached')
                                : t('media.fileMissing')}
                            </span>
                            {canRecacheFromSource(ep.source) ? (
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
                                <p
                                  className="truncate text-[12.5px] text-fg-strong"
                                  title={ep.title || ''}
                                >
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
                            {/* 集级挂图（BUG-168）：打开图片选择对话框，给这一集挂/换图片 */}
                            <button
                              type="button"
                              onClick={() => setPickingImages(ep)}
                              title={t('media.attachImages')}
                              aria-label={t('media.attachImages')}
                              data-testid="episode-attach-images"
                              className="shrink-0 rounded px-1 text-muted hover:bg-surface-2 hover:text-fg-mid"
                            >
                              <ImagePlus className="h-3 w-3" />
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
                                title={`${t(sourceLabelKey(ep.source))} · ${ep.ref}`}
                              >
                                {' · '}
                                {t(sourceLabelKey(ep.source))}
                              </span>
                            )}
                          </p>
                          {/* 集级挂图缩略条（BUG-168）：每一集的图片就挂在自己这一行里 ——
                              48×36 只作「这一集挂了图」的证据，点开看大图，可单张摘除。
                              缩略源优先用后端已下发的 poster，没有才回退 raw 原图。 */}
                          {imgs.length > 0 ? (
                            <div
                              className="mt-1.5 flex flex-wrap items-center gap-1.5"
                              data-testid="episode-images"
                            >
                              {shownImgs.map((img) => (
                                <div
                                  key={img.itemId}
                                  className="group/img relative h-9 w-12 shrink-0 overflow-hidden rounded border border-border-subtle bg-surface-2"
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEpImageView({
                                        src: img.poster ?? mediaItemUrl(img.itemId),
                                        title: ep.title || '',
                                      })
                                    }
                                    title="查看大图"
                                    aria-label="查看大图"
                                    data-testid="episode-image-open"
                                    className="block h-full w-full"
                                  >
                                    <img
                                      src={img.poster ?? mediaItemUrl(img.itemId)}
                                      alt=""
                                      loading="lazy"
                                      className={`h-full w-full ${coverFit('photo')}`}
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void removeEpisodeImage(ep.id, img.itemId)}
                                    title={t('media.removeEpisodeImage')}
                                    aria-label={t('media.removeEpisodeImage')}
                                    data-testid="episode-image-remove"
                                    className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive focus-visible:opacity-100 group-hover/img:opacity-100"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                              {imgs.length > 3 ? (
                                <button
                                  type="button"
                                  onClick={() => toggleImgRow(ep.id)}
                                  title={
                                    expandedImgRows.includes(ep.id)
                                      ? '收起'
                                      : `还有 ${imgs.length - 3} 张`
                                  }
                                  data-testid="episode-images-toggle"
                                  className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-fg-mid"
                                >
                                  {expandedImgRows.includes(ep.id) ? '收起' : `+${imgs.length - 3}`}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          {editingEp === ep.id ? (
                            <div className="mt-1.5 space-y-1.5">
                              {/* 标题改在行内（与列表同一行），不再单独开一行（BUG-076）。
                                  槽位：允许任意 ≥1 的整数（2、3…不必从 1 连续）。
                                  目标槽被占用时后端对调两条，故这里不拦「号重复」。
                                  「结束集」是合集区间终点：留空即单集（BUG-153）——这是
                                  一个视频装多集时唯一能改终点/退回单集的入口。 */}
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
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
                                <span className="text-muted/70">至</span>
                                <input
                                  type="number"
                                  min={1}
                                  value={epEnd}
                                  onChange={(e) => setEpEnd(e.target.value)}
                                  placeholder="留空=单集"
                                  aria-label="结束集号（留空=单集）"
                                  data-testid="episode-end-input"
                                  className="h-6 w-20 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
                                />
                                <span>集</span>
                                <span className="text-[10px] text-muted/80">
                                  （一条内容装多集时填终点；号被占用时会与那一集互换位置）
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
                          ) : showEpDesc ? (
                            /* 本集介绍：整段显示（不截断）——裁成半句比占两行更糟。
                               与剧集简介逐字相同时不渲染（重复文案由 Hero 常驻那一份承担）。 */
                            <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[10.5px] leading-relaxed text-muted">
                              {epDesc}
                            </p>
                          ) : null}
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
                          data-testid="episode-remove"
                        >
                          移除
                        </Button>
                      </div>
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

      {/* 集级挂图灯箱：点行内缩略图放大这一张。只读浏览 —— 不进播放器、不占分集槽。 */}
      {epImageView ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
          onClick={() => setEpImageView(null)}
          data-testid="episode-image-viewer"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setEpImageView(null)
            }}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={epImageView.src}
            alt={epImageView.title}
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}

      {/* 集级挂图选择对话框（BUG-168） */}
      {pickingImages && (
        <EpisodeImagePickerDialog
          episode={pickingImages}
          onClose={() => setPickingImages(null)}
          onError={onError}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

/**
 * 集级挂图选择对话框（BUG-168）：列出媒体库里 kind=photo 的条目，多选后确认挂载。
 *
 * 后端是 **replace-all** 语义（一次请求重写该集的图片位），这里把「既有挂图 + 新勾选」
 * 一起下发，对用户的观感就是「勾选即追加」，不用理解接口语义。
 * 确认失败走 `onError`（toast），对话框保持打开、勾选不丢。
 */
function EpisodeImagePickerDialog(props: {
  episode: MediaEpisode
  onClose: () => void
  onError: (msg: string) => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const { episode, onClose, onError, onChanged } = props
  const [photos, setPhotos] = useState<MediaItem[] | null>(null)
  /** 预填既有挂图：确认时一并下发（replace-all 下表现为「追加勾选」） */
  const [selected, setSelected] = useState<number[]>(
    episode.images?.map((i) => i.itemId) ?? [],
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    listMediaItems({ kind: 'photo', limit: 200 })
      .then((r) => {
        if (alive) setPhotos(r.items)
      })
      .catch((e: unknown) => {
        if (alive) onError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const confirm = async () => {
    setBusy(true)
    try {
      await attachEpisodeImages(episode.id, selected)
      onChanged()
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="episode-image-picker"
      >
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[13px] font-semibold text-fg-strong">
            {t('media.episodeImagesTitle', { no: episode.episodeNo })}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg-mid"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {photos === null ? (
            <p className="py-8 text-center text-xs text-muted">…</p>
          ) : photos.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">{t('media.noPhotosInLibrary')}</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {photos.map((p) => {
                const on = selected.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    title={p.title}
                    aria-pressed={on}
                    data-testid="episode-image-option"
                    className={`relative overflow-hidden rounded border transition-colors ${
                      on ? 'border-accent ring-1 ring-accent' : 'border-border-subtle hover:border-accent/50'
                    }`}
                  >
                    <img
                      src={mediaItemUrl(p.id)}
                      alt={p.title}
                      loading="lazy"
                      className="aspect-square h-full w-full object-cover"
                    />
                    {on && (
                      <span className="absolute inset-0 flex items-end justify-end bg-accent/20 p-0.5">
                        <span className="rounded-full bg-accent px-1 text-[9px] font-semibold leading-4 text-white">
                          ✓
                        </span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-muted">{t('media.selectedImages', { n: selected.length })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
              {t('media.imagePickerCancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 px-3 text-[11px]"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="episode-image-picker-confirm"
            >
              {t('media.imagePickerConfirm')}
            </Button>
          </div>
        </div>
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
          <p className="flex flex-wrap gap-x-1 gap-y-0.5 pt-0.5">
            {series.tags.map((t) => (
              <TagToken key={t.id} name={tags.find((x) => x.id === t.id)?.name ?? t.name} />
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
