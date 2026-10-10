import { useEffect, useRef, useState } from 'react'
import {
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
import type { MediaEpisode, MediaSeriesDetail, MediaTag } from '../../api/media'

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
  canRecacheFromSource,
  coverFit,
  fmtDuration,
  hasMediaBytes,
  recacheFromSource,
  sourceLabelKey,
} from '../../lib/mediaSources'
import {
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
   * 重新缓存某一集（BUG-080）。清缓存只删字节、留条目：这一集仍在列表里，
   * 却以「可播」外观呈现、点下去 raw 端点 404。这里给支持原路取回的来源一个
   * 入口（TG 的 `ref` 里 `chat:msg` 就是下载地址）；本地导入文件没有原路。
   */
  const recacheEpisode = (ep: MediaEpisode) => {
    if (!canRecacheFromSource(ep.source)) {
      onError(t('media.episode.recacheNoRoute', { source: t(sourceLabelKey(ep.source)) }))
      return
    }
    recacheFromSource(ep.ref, ep.source)
      .then(() => onError(t('media.episode.recacheQueued')))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
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

          {/* 选集器：全部分集（含 photo 集，标注「图」；图片集不进播放序列 P6） */}
          <div className="flex items-center gap-2 border-t border-border-subtle/60 pt-2.5 text-[12px] font-semibold text-fg-mid">
            <span className="flex-1">{t('media.episodeCount', { n: detail.episodeCount })}</span>
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
                    <span
                      className={`min-w-0 truncate text-[12.5px] ${
                        on ? 'font-semibold text-accent' : 'text-fg-mid'
                      }`}
                    >
                      {shouldRenderEpisodeTitle(ep, detail) ? ep.title : episodeSlotLabel(ep)}
                    </span>
                    {/* BUG-254：有字节 → 显示时长；无字节 → 显示「未缓存」标记（不显时长）。 */}
                    {withBytes ? (
                      <span className="font-mono text-[10.5px] text-muted">
                        {!photo && ep.duration != null ? fmtDuration(ep.duration) : ''}
                      </span>
                    ) : (
                      <span
                        className="flex items-center gap-0.5 font-mono text-[10.5px] text-amber-500"
                        data-testid="episode-nobytes"
                        title={t('media.notCached')}
                      >
                        <CloudOff className="h-3 w-3" />
                        {t('media.notCached')}
                      </span>
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

              {/* 本集介绍（R2 门控：与剧集介绍逐字相同则不重复渲染）。规范：块标题 + 编辑介绍按钮
                  BUG-203：编辑态隐藏 —— 介绍正在编辑面板的 textarea 里，正文再渲染一份
                  就是第二处重复（与标题的 2 行重叠同根因）。 */}
              {!editingEpisode ? (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5">
                  <span className="text-[11px] font-medium text-fg-strong">{t('media.episode.sectionDesc')}</span>
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

              {/* 来源 = 切换视频来源来播放（BUG-198）：不是信息展板。剥掉 ref / 内部 id
                  这类「这道菜怎么烧」的噪声，只留「当前播放来源 + 备用版本一键切换」。
                  设计 `episode-internal-ia-v2` §5 S4：「无备用源 ⇒ 来源区整块不渲染」
                  （原则「无选择即无控件」）—— 无备用源时本块在 DOM 中**完全不存在**，
                  而非 hidden/opacity-0。「正在从哪播」已由标题行 meta 的 source 徽标承载，
                  故门控不丢失信息（BUG-210）。 */}
              {(cur.sources ?? []).length > 0 ? (
                <div className="flex flex-col gap-1.5 border-t border-border-subtle/60 pt-2.5">
                  <span className="text-[11px] font-medium text-fg-strong">{t('media.episode.sourcesTitle')}</span>
                  {/* 主版本 = 当前播放来源（来源只标 TG/local 这种「哪道菜」，不标 ref 路径） */}
                  <div className="flex items-center gap-2 rounded border border-accent/40 bg-accent/5 px-2 py-1 text-[11px]">
                    <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      {t('media.episode.sourcePrimary')}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg-strong">{cur.title || `#${cur.itemId}`}</span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {cur.source ? t(sourceLabelKey(cur.source)) : 'local'}
                    </span>
                  </div>
                  {(cur.sources ?? []).length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {(cur.sources ?? []).map((s) => (
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
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

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
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={!canRecacheFromSource(cur.source)}
                    onClick={() => recacheEpisode(cur)}
                    title={canRecacheFromSource(cur.source) ? t('media.recache') : t('media.fileMissingHint')}
                    data-testid="episode-recache"
                  >
                    <CloudOff className="h-3 w-3" />
                    {t('media.recache')}
                  </Button>
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
    </div>
  )
}
