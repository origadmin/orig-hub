import { useState } from 'react'
import { Button } from '../ui/button'
import { detachEpisodeImage, mediaItemUrl, patchEpisode } from '../../api/media'
import type { MediaEpisode, MediaSeriesDetail } from '../../api/media'
import { useTranslation } from '../../i18n'

/**
 * 单集编辑面板：**标题 + 介绍 + 槽位（季号/集号/结束集号）一次提交**。
 *
 * 契约**完全复用现状 `SeriesDetail.tsx:274-331` 的 `saveEp`**（校验 + `endHint`
 * 归一化提示），只换了承载容器，不改逻辑。
 *
 * 位置：**仅在面板内**。R11 判据明确「说明文案出现在行态即违反 P2」——
 * 「标题/介绍取自内容本身」这句话只在用户**正因此受影响**（即将编辑）时出现。
 *
 * 节点名全部沿用（`episode-season-input` / `episode-no-input` / `episode-end-input` /
 * `episode-title-input` / `episode-save`），它们被多处验收脚本断言。
 */
export function EpisodeEditPanel(props: {
  ep: MediaEpisode
  series: MediaSeriesDetail
  onClose: () => void
  onSaved: () => void
  /** 图片增删替后的刷新（只重取详情，**不**退出编辑态/不丢草稿，BUG-204） */
  onChanged: () => void
  /** 打开本集挂图选择器（增 / 替换；replace-all 语义），对话框仍归 SeriesDetail 容器 */
  onPickImages: () => void
  onError: (msg: string) => void
}) {
  const { t } = useTranslation()
  const { ep, onClose, onSaved, onChanged, onPickImages, onError } = props
  /** 本集标题草稿 —— 改的是**这条内容**的标题（分集会跟着显示同一个名字） */
  const [title, setTitle] = useState(ep.title ?? '')
  const [desc, setDesc] = useState(ep.description ?? '')
  /** 槽位草稿（季号/集号）：与标题/介绍一起在同一面板里提交 */
  const [season, setSeason] = useState(String(ep.season))
  const [no, setNo] = useState(String(ep.episodeNo))
  /**
   * 合集区间终点（BUG-153）：预填既有终点（单集为空串）。
   * 不预填等于用户一保存就把区间冲成单集。
   */
  const [end, setEnd] = useState(ep.episodeNoEnd != null ? String(ep.episodeNoEnd) : '')
  const [busy, setBusy] = useState(false)
  /** 图片摘除进行中：禁用全部 × 按钮，避免并发摘除把缩略图列表改乱（BUG-204） */
  const [imgBusy, setImgBusy] = useState(false)

  /**
   * 保存本集：**标题 + 介绍 + 槽位**一次提交。
   *
   * 标题与介绍由后端写穿到所指向的条目 —— 分集不持有内容文案的第二份副本，
   * 所以在剧集里改完，媒体库卡片与播放页看到的就是同一个结果。
   * 标题**允许为空**（BUG-200）：集可以没有标题 —— 剧集已经有名称了，清空后单集层
   * 回落到「S1E3」这类槽位标签。清空时下发 `null`（= 显式清空）：此前下发空串会被引擎
   * 按「不改」处理，表现为「保存了但没变」。
   *
   * 集号允许任意值（2、3…不必从 1 连续）；若目标槽已被同剧另一条占用，后端对调两条的
   * 槽位 —— 所以这里不做「号是否重复」的客户端校验，那会把后端已经能正确处理的情形
   * 变成假报错。只挡明显非法的输入（空/非正整数）。
   *
   * 合集区间终点（`episodeNoEnd`）随本次提交一起下发 —— 两集合装在一个文件里的分集
   * 此前只能改起点，这里是它唯一的编辑入口（BUG-153）。
   */
  const save = async () => {
    const s = Number(season)
    const n = Number(no)
    if (!Number.isInteger(s) || s < 1 || !Number.isInteger(n) || n < 1) {
      onError(t('media.episode.errSlot'))
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
    const endRaw = end.trim()
    let endValue: number | null = null
    let endHint = ''
    if (endRaw !== '') {
      const m = Number(endRaw)
      if (!Number.isInteger(m) || m < 1) {
        onError(t('media.episode.errEnd'))
        return
      }
      if (m <= n) {
        endValue = null
        endHint = t('media.episode.endNormalized', { end: m, start: n })
      } else {
        endValue = m
      }
    }
    setBusy(true)
    try {
      await patchEpisode(ep.id, {
        // 留空 → `null` = 显式清空（集可以没有标题，见 BUG-200）；非空下发 trim 后的值
        title: title.trim() || null,
        description: desc.trim() || null,
        season: s,
        episodeNo: n,
        // 恒定下发：省略字段 = 后端「不改」，清空区间就永远生效不了
        episodeNoEnd: endValue,
      })
      if (endHint) onError(endHint)
      onSaved()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 摘除单张已挂接图片（BUG-204）：DELETE /api/media/episodes/:id/images/:itemId。
   * 只重取详情（`onChanged`）刷新缩略图列表，**不**退出编辑态、不丢草稿 ——
   * 否则用户刚挂好的标题/介绍一并丢失，等于「改图必须先重填本集」。
   */
  const detachImage = async (itemId: number) => {
    setImgBusy(true)
    try {
      await detachEpisodeImage(ep.id, itemId)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setImgBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="episode-edit-panel">
      {/* P5 / R11：改写范围说明**只在面板内**，不进行态 */}
      <p className="text-[10px] leading-relaxed text-muted">{t('media.episode.editAffectsAll')}</p>

      {/* 可见标签：标题**可改可清空**这件事必须看得见（此前只有 placeholder，
          用户据此认为「标题不能修改」，见 BUG-200） */}
      <span className="text-[11px] font-medium text-fg-strong">
        {t('media.episode.editTitle')}
      </span>

      <textarea
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('media.episode.editTitle')}
        aria-label={t('media.episode.editTitle')}
        data-testid="episode-title-input"
        rows={2}
        className="w-full resize-none rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-[12.5px] text-fg-strong [overflow-wrap:anywhere]"
      />

      {/* 槽位：允许任意 ≥1 的整数（2、3…不必从 1 连续）。目标槽被占用时后端对调两条，
          故这里不拦「号重复」。「结束集」是合集区间终点：留空即单集（BUG-153）——
          这是一个视频装多集时唯一能改终点/退回单集的入口。 */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>{t('media.episode.editSeason')}</span>
        <input
          type="number"
          min={1}
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          aria-label={t('media.episode.editSeason')}
          data-testid="episode-season-input"
          className="h-6 w-14 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
        />
        <span>{t('media.episode.editEpisodeNo')}</span>
        <input
          type="number"
          min={1}
          value={no}
          onChange={(e) => setNo(e.target.value)}
          aria-label={t('media.episode.editEpisodeNo')}
          data-testid="episode-no-input"
          className="h-6 w-14 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
        />
        <span className="text-muted/70">→</span>
        <input
          type="number"
          min={1}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          placeholder={t('media.episode.editEpisodeNoEnd')}
          aria-label={t('media.episode.editEpisodeNoEnd')}
          data-testid="episode-end-input"
          className="h-6 w-24 rounded-md border border-border-subtle bg-surface px-1.5 text-[11px] text-fg-strong"
        />
        <span className="text-[10px] text-muted/80">{t('media.episode.endHintRow')}</span>
      </div>

      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder={t('media.descEmptyEp')}
        aria-label={t('media.descEmptyEp')}
        rows={2}
        className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-fg-strong"
      />

      {/* BUG-204：图片纳入统一编辑 —— 「编辑所有内容」名实相符。
          增/替换 = 挂图选择器（replace-all 语义，勾选即新全集）；删 = 每张缩略图 ×。 */}
      <span className="text-[11px] font-medium text-fg-strong">
        {t('media.episode.sectionImages')}
      </span>
      {(ep.images ?? []).length === 0 ? (
        <p className="text-[11px] text-muted/70" data-testid="episode-edit-images-empty">
          {t('media.episode.noImagesAttached')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2" data-testid="episode-edit-images">
          {(ep.images ?? []).map((img) => (
            <span key={img.itemId} className="relative inline-block">
              <img
                src={img.poster ?? mediaItemUrl(img.itemId)}
                alt=""
                loading="lazy"
                className="h-14 w-20 rounded border border-border-subtle object-cover"
              />
              <button
                type="button"
                disabled={imgBusy}
                onClick={() => void detachImage(img.itemId)}
                aria-label={t('media.episode.detachImage')}
                data-testid="episode-image-detach"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border-subtle bg-surface text-[11px] leading-none text-muted hover:bg-destructive/10 hover:text-destructive"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2.5 text-[11px]"
          onClick={onPickImages}
          data-testid="episode-images-manage"
        >
          {t('media.episode.editImages')}
        </Button>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-6 px-2.5 text-[11px]"
          disabled={busy}
          onClick={() => void save()}
          data-testid="episode-save"
        >
          {t('media.save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2.5 text-[11px]"
          onClick={onClose}
        >
          {t('media.cancel')}
        </Button>
      </div>
    </div>
  )
}
