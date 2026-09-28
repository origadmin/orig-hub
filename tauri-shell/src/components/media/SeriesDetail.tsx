import { useEffect, useState } from 'react'
import type { MediaEpisode, MediaSeriesDetail, MediaTag } from '../../api/media'
import { mediaItemUrl, switchEpisodeSource, detachEpisodeImage, moveEpisode } from '../../api/media'
import { canRecacheFromSource, recacheFromSource, sourceLabelKey } from '../../lib/mediaSources'
import { partitionEpisodes } from '../../lib/episodePresentation'
import { SeriesHero } from './SeriesHero'
import { EpisodeBoard } from './EpisodeBoard'
import { SeriesEditPanel } from './SeriesEditPanel'
import { EpisodeImagePickerDialog } from './EpisodeImagePickerDialog'
import { Lightbox, type LightboxItem } from './Lightbox'
import { TagPicker } from './TagManagerDialog'
import { Button } from '../ui/button'
import { useTranslation } from '../../i18n'

/** 统一的灯箱状态（设计 §2.3）：items 的范围**收敛到传入数组**（R6） */
interface LightboxState {
  items: LightboxItem[]
  index: number
  isPhotoOnly: boolean
  /** 集级挂图灯箱的归属集（null = 图册，摘除语义不同） */
  episodeId: number | null
}

/**
 * 剧集详情**容器**。只做三件事：拉数据（由父层下发）/ 编排两区 / 转发回调。
 *
 * 不含任何信息位渲染 —— 全剧层在 `SeriesHero`，单集层在 `EpisodeBoard`。
 * 所有对话框（编辑 / 挂图 / 灯箱 / 标签 / 标签编辑）的**状态**归本容器，
 * 因为它们都要弹对话框、都要 `onChanged()`（设计 §2.2「渲染态归叶子、业务态归容器」）。
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
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null)
  const [attachingEpisodeId, setAttachingEpisodeId] = useState<number | null>(null)
  const [editingTags, setEditingTags] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(detail.tags.map((x) => x.id))
  const [lightbox, setLightbox] = useState<LightboxState | null>(null)

  const { playEps, photoEps } = partitionEpisodes(detail)

  /**
   * 单层剧集（R7 / PRD §3.4）：唯一集**默认展开**。
   *
   * 用**推导**而非「挂载时 setState」：子组件 effect 先于父组件执行，
   * 若在 `EpisodeBoard` 里 `onFocusChange(唯一集)`，会被父组件紧随其后的
   * 换剧清态 effect 重置回 `null`，单集剧集永远展不开。唯一集是无歧义的
   * 默认值，直接由数据推导最稳，也天然满足「切剧集时重算」。
   */
  const singleEpisode = detail.episodeCount === 1 && playEps.length === 1 ? playEps[0].id : null
  const effectiveFocusedId = focusedEpisodeId ?? singleEpisode

  // 换剧集时清空所有编辑态 —— 否则上一部剧的面板会「挂着」新剧的数据。
  useEffect(() => {
    setFocusedEpisodeId(null)
    setEditingSeries(false)
    setEditingEpisodeId(null)
    setAttachingEpisodeId(null)
    setEditingTags(false)
    setSelectedTagIds(detail.tags.map((x) => x.id))
    setLightbox(null)
  }, [detail.id])

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

  const gotoItem = (ep: MediaEpisode) => {
    if (props.onGotoItem) props.onGotoItem(ep.itemId)
    else onError(t('media.episode.recacheQueued'))
  }

  const attachingEp = attachingEpisodeId == null
    ? null
    : detail.episodes.find((e) => e.id === attachingEpisodeId) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SeriesHero
        detail={detail}
        tags={tags}
        onBack={props.onBack}
        onEditSeries={() => setEditingSeries(true)}
        onEditTags={() => {
          setSelectedTagIds(detail.tags.map((x) => x.id))
          setEditingTags(true)
        }}
        onMerge={props.onMerge}
        onDelete={props.onDeleteSeries}
        onExport={() => {
          if (props.onExport) props.onExport()
          else onError(t('media.exportPreview'))
        }}
        onOpenCover={() => {}}
      />

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

      {/* 单集层：手风琴序列 */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4">
        <EpisodeBoard
          detail={detail}
          focusedEpisodeId={effectiveFocusedId}
          onFocusChange={setFocusedEpisodeId}
          onPlayEpisode={playEpisode}
          onEditEpisode={(ep) => setEditingEpisodeId(ep ? ep.id : null)}
          onEditSaved={onChanged}
          editingEpisodeId={editingEpisodeId}
          onAttachImages={(ep) => setAttachingEpisodeId(ep.id)}
          onRemoveEpisode={props.onRemoveEpisode}
          onRemoveImage={(ep, itemId) => detachImage(ep.id, itemId)}
          onMove={(ep, dir) => {
            void (async () => {
              try {
                const r = await moveEpisode(ep.id, dir)
                if (!r.moved) {
                  onError(dir === 'up' ? t('media.episode.firstInSeason') : t('media.episode.lastInSeason'))
                } else {
                  onChanged()
                }
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e))
              }
            })()
          }}
          onRecache={recacheEpisode}
          onOpenImages={openEpisodeLightbox}
          onSwitchSource={switchSource}
          onDetachSource={(ep, itemId) => detachImage(ep.id, itemId)}
          onGotoItem={gotoItem}
          onOpenPhotoLightbox={openPhotoLightbox}
          onError={onError}
        />
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

      {/*
        单集编辑面板（R11）**就地在展开块内**渲染（见 `EpisodeBoard` → `EpisodeExpanded`），
        不在这里另起一块：R11 要求「单集展开块中独立编辑入口 ≤ 1」，面板与它所属的
        那一集必须视觉上绑定，浮到页面底部会让用户失去「我在改哪一集」的指示。
      */}

      {/* 集级挂图选择对话框（BUG-168） */}
      {attachingEp ? (
        <EpisodeImagePickerDialog
          episode={attachingEp}
          onClose={() => setAttachingEpisodeId(null)}
          onError={onError}
          onChanged={onChanged}
        />
      ) : null}

      {/* 统一灯箱：图片放大浏览（取代 series-photo-viewer + episode-image-viewer） */}
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

