import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CloudOff,
  Film,
  GitMerge,
  Image as ImageIcon,
  ImagePlus,
  Pencil,
  Play,
  Tag,
  Trash2,
} from 'lucide-react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import type { MediaEpisode, MediaSeriesDetail, MediaTag } from '../../api/media'
import { recacheSeriesMissing } from '../../api/media'
import { getCacheTasksForItems, setCacheTaskPriority } from '../../api/tg'
import type { TgCacheTask } from '../../types'

/**
 * 方向判定 hook：preload 首帧源图，按实际尺寸判竖/横（v3 `isPortrait` 等价实现；
 * 判据 `h > w`，与 DeckImage/parseDims 同一口径）。加载中默认横形（v3 默认 300×169）。
 */
function useImagePortrait(src: string | undefined) {
  const [portrait, setPortrait] = useState(false)
  useEffect(() => {
    setPortrait(false)
    if (!src) return
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setPortrait(img.naturalHeight > img.naturalWidth)
    }
    img.src = src
    return () => {
      alive = false
    }
  }, [src])
  return portrait
}

import {
  mediaItemUrl,
  switchEpisodeSource,
  detachEpisodeImage,
  detachEpisodeSource,
  moveEpisode,
  seriesKindLabelKey,
} from '../../api/media'
import {
  coverFit,
  episodeCacheStatus,
  episodeRecacheCandidates,
  fmtDuration,
  hasMediaBytes,
  recacheFromSource,
  sourceLabelKey,
  sourceMessageUrl,
} from '../../lib/mediaSources'
import {
  episodeDescriptionIsSeriesLevel,
  episodeRowTitle,
  episodeSlotLabel,
  isPhotoEpisode,
  partitionEpisodes,
  resolveSeriesCover,
  shouldRenderEpisodeDescription,
  shouldRenderEpisodeTitle,
  showSeasonHeaders,
} from '../../lib/episodePresentation'
import { Deck, type DeckFrame } from './Deck'
import { EpisodeEditPanel } from './EpisodeEditPanel'
import { SeriesEditPanel } from './SeriesEditPanel'
import { EpisodeImagePickerDialog } from './EpisodeImagePickerDialog'
import { Lightbox, type LightboxItem } from './Lightbox'
import { TagPicker } from './TagManagerDialog'
import { TagToken } from './TagToken'
import { CoverImage } from './CoverImage'
import { Button } from '../ui/button'
import { useTranslation } from '../../i18n'
import { seriesLabel } from '../../lib/displayTitle'

/**
 * 剧集介绍折叠阈值（像素）：超过该高度才给「展开 / 收起」（照抄 `SeriesHero.tsx` 的
 * `DESC_CLAMP_PX`，R4 口径一致 —— 短介绍挂一个折叠按钮是噪音）。
 */
const DESC_CLAMP_PX = 64

/** 统一的灯箱状态（设计 §2.3）：items 的范围**收敛到传入数组**（R6） */
interface LightboxState {
  items: LightboxItem[]
  index: number
  isPhotoOnly: boolean
  /** 集级挂图灯箱的归属集（null = 图册，摘除语义不同） */
  episodeId: number | null
}

/**
 * 剧集详情**容器** —— 形态 = **左右主从（左选集 / 右单集显示与编辑）**。
 *
 * 规范真源：`docs/design/media-episode-image-handover-2026-09-28.md`
 * （用户 2026-09-29 拍板进产品：「最基础的，左右布局，跑马灯」）：
 *   - **左栏** = 剧集总览（海报/标题/标签/剧集级操作）+ **选集器**（§2.5 原话：
 *     「集选择应该在所有(剧集)的左栏」）。
 *   - **右栏** = 当前单集**显示与编辑**（§2.5 原话：「右边作为单集显示编辑」）；
 *     本集图组 = **stacked deck 折叠跑马灯**（§6.1：折叠效果只留右栏）。
 *   - **标题单行省略**（§6.2：标题控制宽度一行显示，超出处理）。
 *
 * 原手风琴形态（PRD 方案 A「两区一态」）由本形态取代；`EpisodeBoard` /
 * `EpisodeExpanded` / `SeriesHero` 上的能力（编辑 / 挂图 / 多源 / 上移下移 /
 * 移除 / 播放 / 前往条目 / 重缓存 / 灯箱 / 标签 / 合并 / 删除 / 导出）逐一迁入。
 *
 * **注意（BUG-183）**：迁移清单曾**漏列「剧集介绍」**，导致该能力（`SeriesHero` 的
 * 剧集介绍展示 + 展开/收起 + 编辑入口）在重构后一度缺失，BUG-183 已补回。
 * ⇒ **按清单逐项核对会漏项** —— 核对须以组件实际能力为准，不能只看清单是否勾完。
 * 所有对话框的状态仍归本容器。
 */
export function SeriesDetail(props: {
  detail: MediaSeriesDetail
  tags: MediaTag[]
  /** 从第 index 集开始播放（整季作为一个播放组，支持 ←/→ 切换） */
  onPlay: (index: number) => void
  onRemoveEpisode: (ep: MediaEpisode) => void
  onDeleteSeries: () => void
  /** 打开「合并到…」对话框 */
  onMerge: () => void
  onBack: () => void
  onChanged: () => void
  onError: (msg: string) => void
  /** 跳到「内容视图」并聚焦该条目（能力 #11 新增，PRD §2.4） */
  onGotoItem?: (itemId: number) => void
  /** 打开导出预览对话框（能力 #21 的迁移落位） */
  onExport?: () => void
  /** 就地新建标签（与 `TagPicker.onCreate` 同契约） */
  onCreateTag: (name: string) => Promise<number | null>
}) {
  const { t } = useTranslation()
  const { detail, tags, onError, onChanged } = props

  const [focusedEpisodeId, setFocusedEpisodeId] = useState<number | null>(null)
  const [editingSeries, setEditingSeries] = useState(false)
  /**
   * 单集内联编辑面板的开关（BUG-197）。**默认 false**：剧集内页是浏览/播放主战场，
   * 编辑是显式二次动作。打开方式见 `openEdit`；关闭走面板内自带的「保存/取消」按钮
   * （面板内 onSaved/onClose 已包好 toggle）。与 `editingSeries`/`editingTags` 同款门控。
   */
  const [editingEpisode, setEditingEpisode] = useState(false)
  const [editNonce, setEditNonce] = useState(0)
  /** 选集列表折叠（规范 §6 左栏 picker 头含「收起」） */
  const [pickerCollapsed, setPickerCollapsed] = useState(false)
  /** 编辑本集区块引用（「编辑介绍」按钮滚动定位用） */
  const editBlockRef = useRef<HTMLDivElement>(null)
  const [attachingEpisodeId, setAttachingEpisodeId] = useState<number | null>(null)
  const [editingTags, setEditingTags] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(detail.tags.map((x) => x.id))
  const [lightbox, setLightbox] = useState<LightboxState | null>(null)
  /**
   * 剧集介绍展示位（BUG-183）：`SeriesHero` 的「介绍展示 + 展开/收起 + 编辑入口」
   * 在重构迁入本组件时漏搬，此处补回。`descOverflowing` 只在介绍真的超过折叠阈值时
   * 才给「展开 / 收起」（与 `SeriesHero` 同款：短介绍挂按钮是噪音）。
   */
  const descRef = useRef<HTMLParagraphElement>(null)
  const [descOverflowing, setDescOverflowing] = useState(false)
  const [descExpanded, setDescExpanded] = useState(false)

  const { playEps, photoEps } = partitionEpisodes(detail)

  /**
   * BUG-279：每集的缓存任务态（按 ref 索引）。未缓存分集据此展示「排队中 / 下载中 /
   * 上次失败（原因）/ 已取消 / 已完成但无字节」。与字节态（`hasMediaBytes`）分别判定后
   * 再合并渲染。**一次批量请求覆盖全部分集**——逐集 N+1 会触发 BUG-241 的请求爆炸
   * （请求数随分集数线性增长），故此处只发一个 `by-item?refs=…` 请求。
   */
  const [cacheTasks, setCacheTasks] = useState<Record<string, TgCacheTask | null>>({})
  /** 一次批量刷新全部分集的任务态（优先下载等操作后重新同步，避免手改本地 state）。 */
  const refreshCacheTasks = useCallback(() => {
    const refs: string[] = []
    for (const ep of detail.episodes) {
      const r = episodeRecacheCandidates(ep)[0]?.ref
      if (r && !refs.includes(r)) refs.push(r)
    }
    if (refs.length === 0) {
      setCacheTasks({})
      return
    }
    getCacheTasksForItems(refs)
      .then(setCacheTasks)
      .catch(() => setCacheTasks({}))
  }, [detail])
  useEffect(() => {
    refreshCacheTasks()
  }, [refreshCacheTasks])

  /**
   * 「优先下载」= 把该集的缓存任务提到队首（当前任务跑完后下一个跑它），**不抢占**、
   * 不弃单（缓存下载无断点续传，抢占会丢弃当前条目已下字节 —— 故不做立即打断）。
   * 再次点击 = 取消优先，回到 FIFO。priority 单一真源（引擎 cache_task.priority）。
   */
  const togglePreferEpisode = (task: TgCacheTask | null) => {
    if (!task) return
    const top = (task.priority ?? 0) <= 0
    setCacheTaskPriority(task.id, top ? { top: true } : { priority: 0 })
      .then(() => refreshCacheTasks())
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /**
   * 单层剧集（R7）：唯一集**默认聚焦**；否则聚焦第一集 —— 左选右看形态下
   * 右栏必须有内容，空右栏是设计空白而非信息。
   */
  const singleEpisode = detail.episodeCount === 1 && playEps.length === 1 ? playEps[0].id : null
  const effectiveFocusedId =
    focusedEpisodeId ?? singleEpisode ?? detail.episodes[0]?.id ?? null
  const cur =
    effectiveFocusedId != null
      ? detail.episodes.find((e) => e.id === effectiveFocusedId) ?? null
      : null

  /**
   * BUG-285：当前集的「跳回 TG 源消息」深链。
   * 只在来源自身能解释定位符时非空（本地来源 ⇒ null ⇒ 不渲染入口）。
   */
  const curTgUrl = cur ? sourceMessageUrl(cur.source, cur.ref) : null

  // 换剧集时清空所有编辑态 —— 否则上一部剧的面板会「挂着」新剧的数据。
  useEffect(() => {
    setFocusedEpisodeId(null)
    setEditingSeries(false)
    setEditingEpisode(false)
    setEditNonce(0)
    setAttachingEpisodeId(null)
    setEditingTags(false)
    setSelectedTagIds(detail.tags.map((x) => x.id))
    setLightbox(null)
    setDescExpanded(false)
  }, [detail.id])

  /** 介绍是否超折叠阈值 —— 只在 `detail.description` 变化时重测（与 `SeriesHero` 同款）。 */
  useEffect(() => {
    const el = descRef.current
    setDescOverflowing(el != null && el.scrollHeight > DESC_CLAMP_PX + 4)
  }, [detail.description])

  /** 播放下标必须相对 `detail.episodes`（父层 `episodesToItems` 用的是全量序列） */
  const playEpisode = (ep: MediaEpisode) => {
    props.onPlay(detail.episodes.indexOf(ep))
  }

  /**
   * 多来源时的**来源选择**（此前是暗箱）：一集有多个可缓存来源时，按钮直接取
   * `episodeRecacheCandidates(ep)[0]` 入队 —— 界面既不显示会走哪个源，也没有别的
   * 选择。现在改为：单来源直接缓存；**多来源先让用户选**，选完再入队。
   */
  const [sourcePick, setSourcePick] = useState<{
    ep: MediaEpisode
    candidates: Array<{ source: string; ref: string }>
  } | null>(null)

  /**
   * 重新缓存某一集（BUG-080；判据 BUG-261 重写；来源选择 BUG-220）。
   *
   * 旧判据绑「当前主源」——主源 local、备用源 tg 时按钮永久禁用且不解释原因。
   * 新判据 = 这一集是否有**任一**可用来源（引擎下发的 `hasRecacheableSource` /
   * 本地按主源+备用源推导）：命中后优先用主源 ref，主源不可用（local / ref 缺失）
   * 则直接用备用源 ref 下发，不再要求用户先「切换来源」再重缓存。
   *
   * **多个来源时不再暗箱取 [0]**：弹出来源选择，让「走哪个源」显式可控。
   */
  const recacheEpisode = (ep: MediaEpisode) => {
    const cands = episodeRecacheCandidates(ep)
    const cand = cands[0]
    if (!cand) {
      // 无任何可缓存坐标：入口必须解释原因，不得静默（BUG-261 判据 4）
      onError(t('media.episode.recacheNoRoute', { source: t(sourceLabelKey(ep.source)) }))
      return
    }
    // 多个来源 ⇒ 先让用户选（此前静默取 [0]，用户无法知道会走哪个源）。
    if (cands.length > 1) {
      setSourcePick({ ep, candidates: cands })
      return
    }
    recacheFromSource(cand.ref, cand.source)
      .then(() => onError(t('media.episode.recacheQueued')))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /** 选定来源后入队（来源选择弹窗的确认动作）。 */
  const recacheFrom = (cand: { source: string; ref: string }) => {
    setSourcePick(null)
    recacheFromSource(cand.ref, cand.source)
      .then(() => onError(t('media.episode.recacheQueued')))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /** 剧集级「补缺」（BUG-261）：缺失 = 无字节的分集数；随详情数据派生，N 随夹具实时变化 */
  const missingCount = detail.episodes.filter((ep) => !hasMediaBytes(ep)).length
  /** 补缺请求在途标记（防重复点击；单请求原子入队，无需前端循环） */
  const [cachingMissing, setCachingMissing] = useState(false)
  /**
   * 「缓存缺失 N 集」（BUG-261）：一次点击 → 引擎原子端点把全部缺失集入队。
   * 成功后复用任务入队提示模式（全局 toast）透出 enqueued / skipped 计数；
   * skipped 明细来自后端（无来源的缺失集），照数透出不静默。
   */
  const cacheMissingEpisodes = () => {
    if (cachingMissing || missingCount === 0) return
    setCachingMissing(true)
    recacheSeriesMissing(detail.id)
      .then((r) => {
        onError(
          t('media.series.cacheMissingQueued', {
            enqueued: r.enqueued,
            skipped: r.skipped.length,
          }),
        )
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCachingMissing(false))
  }

  /** 打开集级挂图灯箱（范围 = **本集** `images`，R6） */
  const openEpisodeLightbox = (ep: MediaEpisode, index: number) => {
    const imgs = ep.images ?? []
    if (imgs.length === 0) return
    setLightbox({
      items: imgs.map((img) => ({
        src: img.poster ?? mediaItemUrl(img.itemId),
        alt: ep.title ?? '',
        itemId: img.itemId,
      })),
      index,
      isPhotoOnly: false,
      episodeId: ep.id,
    })
  }

  /** 打开图册灯箱（范围 = **本组** photo 分集，R6） */
  const openPhotoLightbox = (index: number) => {
    if (photoEps.length === 0) return
    setLightbox({
      items: photoEps.map((ep) => ({
        src: ep.poster ?? mediaItemUrl(ep.itemId),
        alt: ep.title ?? '',
        itemId: ep.itemId,
      })),
      index,
      isPhotoOnly: true,
      episodeId: null,
    })
  }

  /** deck 上的放大入口：photo 集进图册灯箱，视频集进集级挂图灯箱 */
  const openFocusLightbox = (ep: MediaEpisode, index: number) => {
    if (isPhotoEpisode(ep)) openPhotoLightbox(Math.max(0, photoEps.indexOf(ep)))
    else openEpisodeLightbox(ep, index)
  }

  /** 改数据后的统一收尾：成功则通知父层刷新，失败则走 `onError`（不静默） */
  const applyChange = (run: () => Promise<unknown>) => {
    void run()
      .then(() => onChanged())
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /** 切换主版本（显式按钮，不再隐式改数据 —— 设计 §9） */
  const switchSource = (ep: MediaEpisode, itemId: number) =>
    applyChange(() => switchEpisodeSource(ep.id, itemId))

  /** 摘除一张集级挂图：只摘关联，图片条目留在资料库 */
  const detachImage = (epId: number, itemId: number) =>
    applyChange(() => detachEpisodeImage(epId, itemId))

  /**
   * 摘除一个**备用源**：只摘关联行，条目本身留在资料库（可再挂别集或当散片）。
   *
   * 与 `detachImage` 是**两个不同的动作**（BUG-182）：备用源走
   * `DELETE /episodes/:id/sources/:item_id`，挂图走 `.../images/:item_id`。
   * 两者混用会表现为「点了摘除，备用源还在、挂图却被删」。
   */
  const detachSource = (epId: number, itemId: number) =>
    applyChange(() => detachEpisodeSource(epId, itemId))

  const gotoItem = (ep: MediaEpisode) => {
    if (props.onGotoItem) props.onGotoItem(ep.itemId)
    else onError(t('media.episode.recacheQueued'))
  }

  /**
   * 打开本集编辑面板（BUG-197）。已打开时幂等；新打开会把视口滚到表单位置。
   * 不动 `editNonce`：表单内部草稿在挂载时一次性初始化，幂等打开复用同一实例即可。
   */
  const openEdit = () => {
    if (editingEpisode) return
    setEditingEpisode(true)
    // 等 React 把面板挂上去再滚——否则 `editBlockRef.current` 还指着空节点
    setTimeout(() => editBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0)
  }
  /** 关闭本集编辑面板（不改数据）：把 nonce +1 让下次打开时草稿从头来 */
  const closeEdit = () => {
    setEditNonce((v) => v + 1)
    setEditingEpisode(false)
  }
  /** 保存成功 → 容器重取详情 + 退出编辑态回到浏览态 */
  const handleEditSaved = () => {
    onChanged()
    setEditingEpisode(false)
  }

  const attachingEp = attachingEpisodeId == null
    ? null
    : detail.episodes.find((e) => e.id === attachingEpisodeId) ?? null

  const kindLabel = (k: string): string => t(seriesKindLabelKey(k))

  const cover = resolveSeriesCover(detail)
  const showSeasons = showSeasonHeaders(detail)

  /** 当前聚焦集的本集图组帧：集图（poster）为底 + 挂图（images）依次入列 */
  const focusFrames: DeckFrame[] = cur
    ? [
        ...(cur.poster ? [{ src: cur.poster }] : []),
        ...(cur.images ?? []).map((img) => ({
          src: img.poster ?? mediaItemUrl(img.itemId),
        })),
        ...(!cur.poster && !(cur.images ?? []).length && isPhotoEpisode(cur)
          ? [{ src: mediaItemUrl(cur.itemId) }]
          : []),
      ]
    : []

  /** deck 框形方向判定（v3 rightPane：`isPortrait(cur.item?.poster)` 的等价实现 ——
      竖图剧 170×302 竖版大卡，横图 300×169；以首帧实际尺寸为准） */
  const focusPortrait = useImagePortrait(focusFrames[0]?.src)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 标签编辑面板（沿用 TagPicker；不新增对话框组件，能力 #7/#8 不变） */}
      {editingTags ? (
        <div className="shrink-0 border-b border-border-subtle/60 bg-surface-2/40 px-4 py-3">
          <TagPicker
            tags={tags}
            selected={selectedTagIds}
            onChange={setSelectedTagIds}
            onCreate={props.onCreateTag}
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              className="h-7 px-3 text-[11px]"
              onClick={() => setEditingTags(false)}
              data-testid="series-tag-save"
            >
              {t('media.save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-[11px]"
              onClick={() => setEditingTags(false)}
            >
              {t('media.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 返回与剧集级操作（合并/导出/删除）已并入媒体库主区**唯一**的
          `<header>` 工具条（MediaLibraryPanel 详情态分支）——
          页面只允许一条工具条（用户 2026-09-29 裁定：两条 = 设计缺陷）。 */}

      {/*
        左右主从：左 340px（总览 + 选集器）/ 右自适应（单集显示与编辑）。
        `< 1100px` 退化为上下堆叠（壳 minWidth=900 —— 交接文档 §4：900 窗口下
        两左列 + 340 后右栏仅余 ~160px，必须单列退化，v3 已实测）。
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto p-4 pt-3 min-[1100px]:grid-cols-[340px_1fr]">
        {/* ============ 左栏：总览 + 选集器 ============ */}
        <aside className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-3">
          {/* 总览海报：宽高比 ≥ 16:9 + self-start（§3.1.1 / BUG-171 根因 2 沿用） */}
          <div
            className="aspect-video w-full overflow-hidden rounded-lg bg-surface-2 self-start"
            data-testid="series-cover"
          >
            {cover ? (
              <CoverImage
                src={cover}
                alt={detail.title}
                fit={coverFit(detail.coverKind)}
                className="h-full w-full"
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

          {/* 标题：**单行省略**（§6.2 用户原话：标题控制好宽度一行显示超出处理） */}
          <h3
            className="min-w-0 truncate text-[15px] font-semibold leading-snug text-fg-strong"
            title={detail.title}
            data-testid="series-title"
          >
            {detail.title}
          </h3>
          <p className="text-[11px] text-muted" data-testid="series-meta">
            {kindLabel(detail.kind)}
            {detail.year ? ` · ${detail.year}` : ''} ·{' '}
            {t('media.episodeCount', { n: detail.episodeCount })} ·{' '}
            {t('media.series.seasonCount', { n: detail.seasonCount })}
          </p>

          {detail.tags.length > 0 ? (
            <div className="flex flex-wrap gap-x-1.5 gap-y-0.5" data-testid="series-hero-tags">
              {detail.tags.map((tag) => (
                <TagToken key={tag.id} name={tag.name} />
              ))}
            </div>
          ) : null}

          {/*
            剧集介绍展示位（BUG-183 补回）：`SeriesHero` 曾承载「剧集介绍展示 + 展开/收起
            + 编辑入口」，重构迁入 `SeriesDetail` 时**漏搬**（迁移清单本身漏列了「剧集介绍」，
            故按清单核对永远核不出来）。设计文档 V7 定档：位置「在标签之后、动作之前」。
            非空恒渲染（**绝不用首集介绍 `cur.description` 兜底**）；空态给可编辑空位。
          */}
          <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5">
            <span className="text-[11px] font-medium text-fg-strong">{t('media.series.editDesc')}</span>
            {detail.description ? (
              <div className="flex items-start gap-1.5">
                <p
                  ref={descRef}
                  style={!descExpanded ? { maxHeight: DESC_CLAMP_PX, overflow: 'hidden' } : undefined}
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12.5px] leading-relaxed text-muted"
                  data-testid="series-description"
                >
                  {detail.description}
                </p>
                <div className="flex shrink-0 flex-col items-start gap-1">
                  {descOverflowing ? (
                    <button
                      type="button"
                      onClick={() => setDescExpanded((v) => !v)}
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
                      data-testid="series-desc-toggle"
                    >
                      {descExpanded ? t('media.series.descShowLess') : t('media.series.descShowMore')}
                    </button>
                  ) : null}
                  {/* 编辑入口进 `SeriesEditPanel`（介绍与标题/类型/年份/标签一次提交） */}
                  <button
                    type="button"
                    onClick={() => setEditingSeries(true)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                    title={t('media.editSeriesDesc')}
                    data-testid="series-desc-edit"
                  >
                    <Pencil className="h-3 w-3" /> {t('media.series.editMeta')}
                  </button>
                </div>
              </div>
            ) : (
              /* 介绍空态：可编辑空位（R4 判据）—— 不出现首集介绍文本 */
              <button
                type="button"
                onClick={() => setEditingSeries(true)}
                className="self-start rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
                data-testid="series-desc-edit"
              >
                {t('media.addSeriesDesc')}
              </button>
            )}
          </div>

          {/* 总览操作（规范 v3 leftPane：编辑剧集 + 标签，置于总览块内）。
              合并/导出/删除是**本剧集实体**的操作 ⇒ 必须落在实体表面（此卡），
              禁止上提到页面工具栏（工具栏 = 库级语义；用户 2026-09-29 裁定）。 */}
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setEditingSeries(true)}
              data-testid="series-edit"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('media.series.editMeta')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => {
                setSelectedTagIds(detail.tags.map((x) => x.id))
                setEditingTags(true)
              }}
              data-testid="series-tag-edit"
            >
              <Tag className="h-3.5 w-3.5" />
              {t('media.series.editTags')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={props.onMerge}
              title={t('media.series.mergeHint')}
              data-testid="series-merge"
            >
              <GitMerge className="h-3.5 w-3.5" />
              {t('media.series.merge')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                if (props.onExport) props.onExport()
                else onError(t('media.exportPreview'))
              }}
              data-testid="series-export"
            >
              {t('media.exportPreview')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px] text-destructive"
              onClick={props.onDeleteSeries}
              data-testid="series-delete"
            >
              {t('media.series.delete')}
            </Button>
          </div>

          {/* 选集器：全部分集（含 photo 集，标注「图」；图片集不进播放序列 P6）。
              「缓存缺失 N 集」（BUG-261）：剧集级补缺入口 —— 一次点击把全部无字节
              分集的可缓存来源入队（引擎原子端点，1 个请求）。刻意放在选集器头部
              （N 随列表实时派生），**不进右栏来源块**（BUG-265 刚收口的信息/控件
              两层门控，补缺是剧集级动作，不属于单集来源展示）。N=0 时禁用。 */}
          <div className="flex items-center gap-2 border-t border-border-subtle/60 pt-2.5 text-[12px] font-semibold text-fg-mid">
            <span className="flex-1">{t('media.episodeCount', { n: detail.episodeCount })}</span>
            <button
              type="button"
              onClick={cacheMissingEpisodes}
              disabled={missingCount === 0 || cachingMissing}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-normal text-amber-500 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
              title={t('media.series.cacheMissing', { n: missingCount })}
              data-testid="series-recache-missing"
            >
              <CloudOff className="h-3 w-3" />
              {t('media.series.cacheMissing', { n: missingCount })}
            </button>
            <button
              type="button"
              onClick={() => setPickerCollapsed((v) => !v)}
              className="rounded px-1.5 py-0.5 text-[10.5px] font-normal text-muted hover:bg-surface-2 hover:text-fg-mid"
              data-testid="episode-picker-collapse"
            >
              {pickerCollapsed ? t('media.episode.expand') : t('media.episode.collapse')}
            </button>
          </div>
          <div className="flex min-h-0 flex-col gap-px overflow-y-auto" data-testid="episode-picker">
            {!pickerCollapsed &&
              detail.episodes.map((ep, i) => {
              const on = ep.id === cur?.id
              const photo = isPhotoEpisode(ep)
              // BUG-254：字节态决定这一行尾列是「时长」还是「未缓存」。无字节分集不显示时长
              // （那是假信息，会误导用户以为可播），改用 `episode-nobytes` 标记。
              const withBytes = hasMediaBytes(ep)
              const showGroup = showSeasons && (i === 0 || detail.episodes[i - 1].season !== ep.season)
              return (
                <div key={ep.id}>
                  {showGroup ? (
                    <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                      {t('media.series.seasonCount', { n: ep.season })}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setFocusedEpisodeId(ep.id)
                      setEditNonce(0)
                    }}
                    className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                      on ? 'bg-accent/10' : 'hover:bg-surface-2'
                    }`}
                    data-testid="episode-pick"
                    data-episode-id={ep.id}
                  >
                    <span
                      className={`font-mono text-[10.5px] ${on ? 'text-accent' : 'text-muted'}`}
                    >
                      {photo ? '🖼' : episodeSlotLabel(ep)}
                    </span>
                  {/* BUG-260：中列只渲标题，**不回退槽位标签** —— 槽位标签的展位是
                      左列，回退会让无标题分集渲染出 `S1E3S1E3`（与左列逐字重复）。
                      门控为假（标题为空 / 等于剧集标题 / 等于槽位标签）时本函数返回
                      null，React 渲染 nothing，中列留空而非重复。 */}
                  <span
                    className={`min-w-0 truncate text-[12.5px] ${
                      on ? 'font-semibold text-accent' : 'text-fg-mid'
                    }`}
                  >
                    {episodeRowTitle(ep, detail)}
                  </span>
                    {/* BUG-254：有字节 → 显示时长；无字节 → 显示「未缓存」标记（不显时长）。
                        BUG-261（用户裁定「点击缺失内容直接进行缓存」）：标记直接发起缓存。
                        行本身是 `<button episode-pick>`（点击=切右栏），HTML 不允许嵌套
                        button —— 标记保持 span，可缓存时以 role="button" 承载点击并
                        stopPropagation（不触发行聚焦切换）；无可缓存来源时禁用并在
                        title 里说明原因，不得静默。`episode-nobytes` 外壳逐字保留
                        （BUG-254 的回归锚），可点击语义由内层 `episode-nobytes-cache` 承载。 */}
                    {withBytes ? (
                      <span className="font-mono text-[10.5px] text-muted">
                        {!photo && ep.duration != null ? fmtDuration(ep.duration) : ''}
                      </span>
                    ) : (
                      (() => {
                        const candidates = episodeRecacheCandidates(ep)
                        const cacheable = candidates.length > 0
                        const ref = candidates[0]?.ref ?? null
                        const task = ref ? (cacheTasks[ref] ?? null) : null
                        const st = episodeCacheStatus(task)
                        const tone =
                          st.kind === 'failed' ||
                          st.kind === 'interrupted' ||
                          st.kind === 'done-no-bytes'
                            ? 'text-red-500'
                            : st.kind === 'queued' || st.kind === 'running'
                              ? 'text-blue-400'
                              : 'text-amber-500'
                        const label = (() => {
                          switch (st.kind) {
                            case 'no-task':
                              return t('media.notCached')
                            case 'queued':
                              return t('media.episode.cacheQueued')
                            case 'running':
                              return `${t('media.episode.cacheRunning')}${
                                st.task.done != null && st.task.total
                                  ? ` ${st.task.done}/${st.task.total}`
                                  : ''
                              }`
                            case 'failed':
                              return t('media.episode.cacheFailed')
                            case 'interrupted':
                              return t('media.episode.cacheInterrupted')
                            case 'cancelled':
                              return t('media.episode.cacheCancelled')
                            case 'done-no-bytes':
                              return t('media.episode.cacheDoneNoBytes')
                          }
                        })()
                        // 可重试态（失败 / 中断 / 取消 / 完成无字节）且仍可缓存 ⇒ 点击重缓存
                        const retryable =
                          cacheable &&
                          (st.kind === 'failed' ||
                            st.kind === 'interrupted' ||
                            st.kind === 'cancelled' ||
                            st.kind === 'done-no-bytes')
                        const clickable = cacheable || retryable
                        const prioritized = (task?.priority ?? 0) > 0
                        return (
                          <span className="flex items-center gap-1">
                          <span
                            className={`flex items-center gap-0.5 rounded px-0.5 font-mono text-[10.5px] ${tone} ${
                              clickable ? 'cursor-pointer hover:bg-amber-500/10' : 'cursor-not-allowed'
                            }`}
                            data-testid="episode-nobytes"
                            data-status={st.kind}
                            title={
                              st.kind === 'no-task'
                                ? cacheable
                                  ? t('media.episode.cacheThis')
                                  : t('media.episode.recacheNoRoute', {
                                      source: t(sourceLabelKey(ep.source)),
                                    })
                                : retryable
                                  ? t('media.episode.cacheRetry')
                                  : label
                            }
                            {...(clickable
                              ? {
                                  role: 'button' as const,
                                  tabIndex: 0,
                                  onClick: (e: ReactMouseEvent) => {
                                    e.stopPropagation()
                                    recacheEpisode(ep)
                                  },
                                  onKeyDown: (e: ReactKeyboardEvent) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation()
                                      e.preventDefault()
                                      recacheEpisode(ep)
                                    }
                                  },
                                }
                              : {})}
                          >
                            {st.kind === 'failed' || st.kind === 'interrupted' ? (
                              <AlertTriangle className="h-3 w-3" />
                            ) : (
                              <CloudOff className="h-3 w-3" />
                            )}
                            {/* 只显示状态短标签。失败详情（多 KB 原文）只进日志与
                                cache_task.error，不在正常列表里呈现（BUG-220）。 */}
                            <span className="truncate" data-testid="episode-nobytes-cache">
                              {label}
                            </span>
                          </span>
                          {st.kind === 'queued' && task ? (
                            <button
                              type="button"
                              className="rounded px-1 font-mono text-[10.5px] text-accent hover:bg-accent/10"
                              title={t('tg.cachePreferDownloadHint')}
                              data-testid="episode-prefer-download"
                              onClick={(e: ReactMouseEvent) => {
                                e.stopPropagation()
                                togglePreferEpisode(task)
                              }}
                            >
                              {prioritized ? t('tg.cacheCancelPrefer') : t('tg.cachePreferDownload')}
                            </button>
                          ) : null}
                          </span>
                        )
                      })()
                    )}
                  </button>
                </div>
              )
            })}
          </div>
        </aside>

        {/* ============ 右栏：当前单集显示与编辑 ============ */}
        <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-3.5">
          {!cur ? (
            <p className="p-6 text-center text-[12px] text-muted">
              {t('media.descEmptyEp')}
            </p>
          ) : (
            <>
              {/* 头：本集标题（**单行省略** §6.2；被去重门控隐藏时集号即主标识） */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3
                  className="min-w-0 flex-1 truncate text-[16px] font-semibold text-fg-strong"
                  title={editingEpisode
                    ? episodeSlotLabel(cur)
                    : shouldRenderEpisodeTitle(cur, detail)
                      ? cur.title ?? ''
                      : episodeSlotLabel(cur)}
                  data-testid="episode-focus-title"
                >
                  {/* BUG-203：编辑态只显槽位标签 —— 标题正在下方表单里被编辑，
                      顶部再渲染一份就是用户看到的「重叠重复 2 行」。 */}
                  {editingEpisode
                    ? episodeSlotLabel(cur)
                    : shouldRenderEpisodeTitle(cur, detail)
                      ? cur.title
                      : episodeSlotLabel(cur)}
                </h3>
                {/* 单一编辑入口：标题行即编辑按钮，点一下进入本集统一编辑态
                    （标题 / 介绍 / 季号 / 集号 / 结束集号一次提交；集可以没有标题）。
                    此前入口埋在右栏底部、与标题分处两端，用户找不到改标题的入口，
                    于是「标题不能修改」像真的一样（关联 BUG-202：编辑被「拆开」）。 */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 self-start px-1.5 text-[11px]"
                  onClick={editingEpisode ? closeEdit : openEdit}
                  data-testid="episode-edit"
                >
                  <Pencil className="h-3 w-3" />
                  {t('media.episode.editMeta')}
                </Button>
                <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[10.5px] text-accent">
                  {episodeSlotLabel(cur)}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {/* BUG-254：无字节的本集不显示时长（假信息）。 */}
                  {!isPhotoEpisode(cur) && cur.duration != null && hasMediaBytes(cur) ? `${fmtDuration(cur.duration)} · ` : ''}
                  {cur.source ? `${t(sourceLabelKey(cur.source))} · ` : ''}#{cur.itemId}
                </span>
              </div>
              {/* 统一编辑面板：紧贴标题行渲染，编辑态下直接覆盖本集全部可改内容 */}
              {editingEpisode ? (
                <div ref={editBlockRef} className="rounded-lg border border-border-subtle/60 bg-surface-2/30 p-2.5">
                  <EpisodeEditPanel
                    key={`${cur.id}-${editNonce}`}
                    ep={cur}
                    series={detail}
                    onClose={closeEdit}
                    onSaved={handleEditSaved}
                    onPickImages={() => setAttachingEpisodeId(cur.id)}
                    onChanged={onChanged}
                    onError={onError}
                  />
                </div>
              ) : null}

              {/* 本集图组 = **stacked deck 折叠跑马灯**（规范核心；只留右栏 §6.1）。
                  点左半=上一张 / 右半=下一张；⤢ 打开灯箱（能力 R6 保留）。
                  BUG-203/204：编辑态隐藏 —— 图片的增删替在编辑面板内进行
                  （面板图片条 + 挂图选择器），同时再渲染一份跑马灯就成了与
                  面板缩略图重复的第二处「本集图组」。 */}
              {!editingEpisode ? (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5">
                  <h4 className="text-[12px] font-semibold text-fg-strong">
                    {t('media.episode.sectionImages')}
                  </h4>
                  {focusFrames.length > 0 ? (
                    <div className="py-1">
                      <Deck
                        frames={focusFrames}
                        w={focusPortrait ? 170 : 300}
                        h={focusPortrait ? 302 : 169}
                        maxW={420}
                        peek={26}
                        onOpenFrame={(i) => openFocusLightbox(cur, i)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* ▶ 播放本集 = 右栏**唯一实心主按钮**（设计 `episode-internal-ia-v2` §4.2：
                  「▶ 播放本集 ← 唯一实心主按钮，独占一行，位置随集不变」）。
                  播放是高频主任务，前置于浏览主战场：紧跟本集图组 Deck 之后、本集介绍
                  之前 —— 位置由结构固定，不随介绍长度 / 挂图数量漂移。此前它被埋在右栏
                  底部「操作」区、与三个描边按钮同尺寸，主任务被降格为并列操作（BUG-210）。 */}
              <Button
                className="h-9 w-full gap-1.5 text-[13px]"
                disabled={!hasMediaBytes(cur)}
                onClick={() => playEpisode(cur)}
                title={hasMediaBytes(cur) ? t('media.episode.play') : t('media.fileMissingHint')}
                data-testid="episode-play"
              >
                <Play className="h-3 w-3" />
                {t('media.episode.play')}
              </Button>

              {/* 本集介绍（BUG-281 产品裁定：**按来源贴标签，不再按文本隐藏**）。
                  非空即渲染：与剧集介绍逐字相同 ⇒ 贴「剧集介绍」标签（TG 相册组
                  共拥一条组级 caption，重复是显式的、有说明的）；不同 ⇒ 「本集介绍」。
                  旧门控「逐字相同即隐藏」把 36/44 条有介绍的分集藏成了空态，
                  即 BUG-281 报障的「大部分集是没有内容的」。
                  BUG-203：编辑态隐藏 —— 介绍正在编辑面板的 textarea 里，正文再渲染一份
                  就是第二处重复（与标题的 2 行重叠同根因）。 */}
              {!editingEpisode ? (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5">
                  <span
                    className="text-[11px] font-medium text-fg-strong"
                    data-testid="episode-focus-desc-label"
                  >
                    {episodeDescriptionIsSeriesLevel(cur, detail)
                      ? t('media.episode.sectionDescSeries')
                      : t('media.episode.sectionDesc')}
                  </span>
                  {shouldRenderEpisodeDescription(cur, detail) ? (
                    <p
                      className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[12.5px] leading-relaxed text-muted"
                      data-testid="episode-focus-desc"
                    >
                      {cur.description}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted/70">{t('media.descEmptyEp')}</p>
                  )}
                  {/* BUG-201：此处**不再**放第二个编辑按钮 —— 介绍与标题/槽位在同一个
                      `episode-edit` 面板里，两个入口打开的是同一个面板。 */}
                </div>
              ) : null}

              {/* 来源（BUG-265）= 「信息段 + 控件段」两层门控：
                  信息段（区块标题 + 当前播放来源行）**恒渲染** ——「正在从哪播」是信息，
                  不因「没有可切换的备选项」而失去意义（BUG-148：实现约束 ≠ 产品信息）。
                  BUG-210 曾把两段放进同一个门控，而生产库备用源表 0 行 ⇒ 45/45 部剧
                  该块 0 渲染，用户两次报告「来源没有了」。
                  控件段（备用源列表 + 切换 / 摘除）保留 BUG-210 原门控不变：
                  设计 episode-internal-ia-v2 §5 S4「无备用源 ⇒ 不渲染」收窄到只约束
                  **控件** —— 无备用源时 `<ul>` 不进 DOM（非 hidden/opacity-0），
                  既有 2 个 testid（episode-source-switch / episode-source-detach）原样保留。 */}
              <div
                className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5"
                data-testid="episode-source-info"
              >
                <span className="text-[11px] font-medium text-fg-strong">{t('media.episode.sourcesTitle')}</span>
                {/* 主版本 = 当前播放来源（来源只标 TG/local 这种「哪道菜」，不标 ref 路径） */}
                <div className="flex items-center gap-2 rounded border border-accent/40 bg-accent/5 px-2 py-1 text-[11px]">
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                    {t('media.episode.sourcePrimary')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg-strong">{cur.title || `#${cur.itemId}`}</span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {/* BUG-265：无来源回退走 i18n（source.local = 本地 / Local），不再用裸字符串 */}
                    {cur.source ? t(sourceLabelKey(cur.source)) : t('source.local')}
                  </span>
                  {/* BUG-285：「跳回 TG 源消息」入口 —— 贴着它所解释的那条来源（同一行）。
                      坐标是入库时记下的 `ref`（TG 即 `<chat>:<msg>`），数据一直在、
                      只是没有出口；无标内容（占位标题）靠它才能被人工辨认。
                      本地来源解析不出 TG 消息 ⇒ 无入口（点了也没有可跳的坐标）。 */}
                  {curTgUrl ? (
                    <a
                      href={curTgUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-accent hover:bg-surface-2"
                      title={curTgUrl}
                      data-testid="episode-source-view-tg"
                    >
                      {t('media.episode.viewInTg')}
                    </a>
                  ) : null}
                </div>
                {(cur.sources ?? []).length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {(cur.sources ?? []).map((s) => {
                      const sTgUrl = sourceMessageUrl(s.source, s.ref)
                      return (
                        <li
                          key={s.itemId}
                          className="flex items-center gap-2 rounded border border-border-subtle/70 px-2 py-1 text-[11px]"
                        >
                          <span className="min-w-0 flex-1 truncate text-fg-mid">{s.title || `#${s.itemId}`}</span>
                          <button
                            type="button"
                            onClick={() => switchSource(cur, s.itemId)}
                            className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                            data-testid="episode-source-switch"
                          >
                            {t('media.episode.switchPrimary')}
                          </button>
                          <button
                            type="button"
                            onClick={() => detachSource(cur.id, s.itemId)}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                            data-testid="episode-source-detach"
                          >
                            {t('media.episode.detachSource')}
                          </button>
                          {/* BUG-285：备用源行同样贴一个「跳回 TG 源消息」——入口跟着
                              它解释的那条来源走；本地备用源无坐标 ⇒ 不渲染。 */}
                          {sTgUrl ? (
                            <a
                              href={sTgUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-0.5 text-[10px] text-accent hover:bg-surface-2"
                              title={sTgUrl}
                              data-testid="episode-source-view-tg"
                            >
                              {t('media.episode.viewInTg')}
                            </a>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </div>

              {/* 单集结构性操作：上移 / 下移 / 移除（编辑入口已上移到标题行，见右栏头） */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle/60 pt-2.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      void (async () => {
                        try {
                          const r = await moveEpisode(cur.id, 'up')
                          if (!r.moved) onError(t('media.episode.firstInSeason'))
                          else onChanged()
                        } catch (e) {
                          onError(e instanceof Error ? e.message : String(e))
                        }
                      })()
                    }}
                    title={t('media.episode.moveUp')}
                    data-testid="episode-move-up"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      void (async () => {
                        try {
                          const r = await moveEpisode(cur.id, 'down')
                          if (!r.moved) onError(t('media.episode.lastInSeason'))
                          else onChanged()
                        } catch (e) {
                          onError(e instanceof Error ? e.message : String(e))
                        }
                      })()
                    }}
                    title={t('media.episode.moveDown')}
                    data-testid="episode-move-down"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px] text-destructive"
                    onClick={() => props.onRemoveEpisode(cur)}
                    title={t('media.episode.removeFromSeries')}
                    data-testid="episode-remove"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('media.episode.removeFromSeries')}
                  </Button>
                </div>

              {/* 操作（规范 rightPane：挂图(+) / 在媒体库中查看 / 重缓存）。
                  ▶ 播放本集已上移为右栏唯一实心主按钮（见图组之后），此处不再重复。 */}
              <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle/60 pt-2.5">
                <span className="text-[11px] font-medium text-fg-strong">{t('media.episode.actions')}</span>
                {/* BUG-204：图片编辑收进统一面板（episode-images-manage），
                    编辑态不再渲染第二个图片入口；浏览态保留原按钮。 */}
                {!editingEpisode ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={() => setAttachingEpisodeId(cur.id)}
                    data-testid="episode-attach-images"
                  >
                    <ImagePlus className="h-3 w-3" />
                    {t('media.attachImages')}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => gotoItem(cur)}
                  data-testid="episode-goto-item"
                >
                  {t('media.episode.gotoItem')}
                </Button>
                {!hasMediaBytes(cur) ? (
                  (() => {
                    // BUG-261：判据 = 这一集是否有任一可用来源（候选含备用源 ref），
                    // 不再绑「当前主源」——主源 local、备用源 tg 时同样可用。
                    const cand = episodeRecacheCandidates(cur)[0]
                    return (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-[11px]"
                        disabled={!cand}
                        onClick={() => recacheEpisode(cur)}
                        title={
                          cand
                            ? t('media.recache')
                            : t('media.episode.recacheNoRoute', {
                                source: t(sourceLabelKey(cur.source)),
                              })
                        }
                        data-testid="episode-recache"
                      >
                        <CloudOff className="h-3 w-3" />
                        {t('media.recache')}
                      </Button>
                    )
                  })()
                ) : null}
              </div>

              {/* 合并溯源 */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
                {cur.originSeriesTitle || cur.originEpisodeNo != null ? (
                  <span className="text-accent/80">
                    {cur.originSeriesTitle
                      ? t('media.episode.originFrom', { title: seriesLabel(cur.originSeriesTitle) })
                      : t('media.episode.originFromUntitled')}
                    {cur.originEpisodeNo != null
                      ? ` ${t('media.episode.originEpisode', { n: cur.originEpisodeNo })}`
                      : ''}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 剧集编辑面板（R10：title/description/kind/year/tags 一次提交） */}
      {editingSeries ? (
        <SeriesEditPanel
          series={detail}
          tags={tags}
          onClose={() => setEditingSeries(false)}
          onSaved={() => {
            setEditingSeries(false)
            onChanged()
          }}
          onError={onError}
          onCreateTag={props.onCreateTag}
        />
      ) : null}

      {/* 集级挂图选择对话框（BUG-168） */}
      {attachingEp ? (
        <EpisodeImagePickerDialog
          episode={attachingEp}
          onClose={() => setAttachingEpisodeId(null)}
          onError={onError}
          onChanged={onChanged}
        />
      ) : null}

      {/* 统一灯箱：图片放大浏览（含 deck ⤢ 入口与挂图摘除） */}
      {lightbox ? (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          isPhotoOnly={lightbox.isPhotoOnly}
          onIndexChange={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))}
          onClose={() => setLightbox(null)}
          onDetach={
            lightbox.episodeId != null
              ? (itemId) => {
                  detachImage(lightbox.episodeId!, itemId)
                  setLightbox(null)
                }
              : undefined
          }
        />
      ) : null}

      {/* 缓存来源选择（BUG-220）：多个可缓存来源时按下按钮先选来源，不再暗箱取 [0]。
          单来源路径不经过这里（recacheEpisode 直接入队），保持一键缓存。 */}
      {sourcePick ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          data-testid="episode-source-picker"
          onClick={() => setSourcePick(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-sm font-medium text-fg-strong">
              {t('media.episode.pickSourceTitle')}
            </p>
            <p className="mb-3 text-[11px] text-muted">{sourcePick.ep.title}</p>
            <div className="flex flex-col gap-1">
              {sourcePick.candidates.map((c) => (
                <button
                  key={`${c.source}:${c.ref}`}
                  type="button"
                  data-testid="episode-source-option"
                  className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-surface-2"
                  onClick={() => recacheFrom(c)}
                >
                  <span className="min-w-0 truncate text-fg-mid">
                    {t(sourceLabelKey(c.source))}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">{c.ref}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setSourcePick(null)}>
                {t('media.cancel')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
