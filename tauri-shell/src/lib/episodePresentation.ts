/**
 * 剧集 / 单集两层的**展示判定纯函数**（BUG-171）。
 *
 * 设计约束（`docs/design/media-library-layout-design-2026-09-28.md` §4）：
 *   1. 去重 = **判定归属**，不是隐藏。判定下沉到这里，渲染层只问「该不该渲染这段文本」。
 *   2. **只判 trim 后逐字全等**，绝不做模糊 / 包含 / 相似度匹配 —— 模糊匹配会误杀
 *      真有独立内容的集（PRD §3.2）。
 *   3. **编辑入口从不问这些函数**：`episode-edit` / `episode-slot` / 面板内的
 *      `title` / `description` 字段恒在、恒可读写（R3）。去重只影响展示。
 *   4. 去重是**渲染期规则，不是写入期规则**：绝不因为两层相同就去改数据
 *      （会毁 P5 单一真源、丢用户数据）。
 *
 * 调用点（全量，仅此 2 处）：`EpisodeRow`（行态标题）、`EpisodeExpanded`（展开态介绍）。
 * `EpisodePhotoGrid` 不调用 —— 宫格无文案位。
 */
import type { MediaEpisode, MediaSeriesDetail } from '../api/media'
import { mediaItemUrl } from '../api/media'

/**
 * 单集标题是否需要在单集层渲染。
 *
 * 现状来源：`SeriesDetail.tsx:705-707` 的内联 `showEpDesc`（BUG-171 修复痕迹）只覆盖了
 * **介绍**；标题一侧当时仍恒显，于是「剧集标题 == 单集标题」（TG 自动成剧常见）时
 * 用户读到两遍同一个名字。本函数把标题去重补上（R5）。
 *
 * 判定：标题 trim 后非空，**且**与剧集标题 trim 后的结果不逐字相等。
 * 注意这里是 `!==`，不是「不包含」——`第 1 集 序章` 相对 `序章` 是有信息量的补充，
 * 不该被判为重复。
 */
export function shouldRenderEpisodeTitle(ep: MediaEpisode, series: MediaSeriesDetail): boolean {
  const epTitle = (ep.title ?? '').trim()
  return epTitle.length > 0 && epTitle !== (series.title ?? '').trim()
}

/**
 * 单集介绍是否需要在单集层渲染。
 *
 * BUG-281 产品裁定（2026-10-12，用户定）：**按来源贴标签，不再按文本隐藏**。
 *
 * 旧规则（BUG-171 / series 101 实测）是「与剧集介绍逐字相同 ⇒ 隐藏」，理由是
 * 「同一段文案在剧集层与单集层各显示一遍」。但 TG 相册组只带**一条**组级
 * caption：实测全库 44 条有介绍的分集里 **36 条逐字等于剧集介绍**（series 315
 * EP6 即 232 字全等）⇒ 旧门控把唯一的内容入口也隐藏了，用户在几乎每一集上
 * 读到空态「本集暂无介绍」—— 这正是 BUG-281 的报障原话「大部分集是没有内容的」。
 *
 * 新规则：单集介绍 **trim 后非空即渲染**。与剧集介绍逐字相同的那部分不再消失，
 * 而是由渲染层按 `episodeDescriptionIsSeriesLevel` 贴上「剧集介绍」标签 ——
 * 与剧集头那段重复现在是**可见的、有说明的**，而不是被藏掉。只有连文本都没有时
 * 才走空态 `media.descEmptyEp`。
 *
 * 设计约束（文件头）不变：编辑入口从不问这些函数；这是**渲染期规则**；
 * 绝不为了去重去改数据（P5 单一真源）。
 *
 * `_series` 保留在签名里（下划线 = 不再参与判定）：两层展示判定的 (ep, series)
 * 参数对是模块的既有契约，调用点（`SeriesDetail` / `EpisodeExpanded`）不因本次
 * 裁定而改形；来源判定已移交给 `episodeDescriptionIsSeriesLevel`。
 */
export function shouldRenderEpisodeDescription(
  ep: MediaEpisode,
  _series: MediaSeriesDetail,
): boolean {
  return (ep.description ?? '').trim().length > 0
}

/**
 * 单集介绍是**剧集级**文案：非空**且**与剧集介绍 trim 后逐字相等。
 *
 * BUG-281：TG 相册组共拥一条组级 caption（`first_caption` 同时喂给剧集级与
 * 带 caption 的那条分集，其余分集经引擎回填继承），逐字相等即「剧集级」。
 * 渲染层据此把区块标签从「本集介绍」换成「剧集介绍」—— 重复被标注，不被隐藏。
 *
 * 与 `shouldRenderEpisodeDescription` 的旧判据是同一个比较，但语义相反：
 * 那里曾经用它**隐藏**，这里用它**说明来源**。只判 trim 后逐字全等，
 * 绝不做模糊 / 包含匹配（会误杀真有独立内容的集）。
 */
export function episodeDescriptionIsSeriesLevel(
  ep: MediaEpisode,
  series: MediaSeriesDetail,
): boolean {
  const epDesc = (ep.description ?? '').trim()
  return epDesc.length > 0 && epDesc === (series.description ?? '').trim()
}

/**
 * 集号槽位标签：`S{season}E{episodeNo}`，合集区间（`episodeNoEnd > episodeNo`）追加 `-{end}`。
 *
 * 只返回**结构化的槽位串**（不返回自然语言），便于 `EpisodeRow` 直接渲染、
 * 也便于验收脚本按 `S1E1` 断言。
 */
export function episodeSlotLabel(ep: Pick<MediaEpisode, 'season' | 'episodeNo' | 'episodeNoEnd'>): string {
  const base = `S${ep.season}E${ep.episodeNo}`
  return ep.episodeNoEnd != null && ep.episodeNoEnd > ep.episodeNo
    ? `${base}-${ep.episodeNoEnd}`
    : base
}

/** 这一集是图片（photo 分集）—— 图片有自己的展位，不进播放序列（P6）。 */
export function isPhotoEpisode(ep: Pick<MediaEpisode, 'kind'>): boolean {
  return ep.kind === 'photo'
}

/**
 * 这部「剧集」整体是图片形态：`kind === 'album'`，**或**全部分集都是 photo。
 *
 * 全部分集都是 photo 时同样按图册呈现（否则会得到一列「没有时长、点不开」的行）。
 * 空分集不满足第二条 —— 空的 album 剧集仍由第一条命中。
 */
export function isPhotoOnlySeries(detail: Pick<MediaSeriesDetail, 'kind' | 'episodes'>): boolean {
  if (detail.kind === 'album') return true
  return detail.episodes.length > 0 && detail.episodes.every(isPhotoEpisode)
}

/**
 * 是否渲染季分组头。
 *
 * **只信后端聚合字段**（PRD §2.3）：`seasonCount > 1 && episodeCount > 1`。
 * 单季剧集不渲染「第 1 季」——「第 1 季」在单季剧里不携带任何区分信息，
 * 反而让「全剧 / 单集」两层的层级看起来多了一层（R7）。
 *
 * ⚠️ 已知影响：单季剧集不再有分组头，会让依赖「第 1 季」存在的旧验收脚本失败，
 * 那是本次**有意**的行为变化（设计 §13.2 回归点 #1），由脚本侧改挂多季剧集。
 */
export function showSeasonHeaders(detail: Pick<MediaSeriesDetail, 'seasonCount' | 'episodeCount'>): boolean {
  return detail.seasonCount > 1 && detail.episodeCount > 1
}

/**
 * 剧集封面**唯一**回退链（R12 单点收敛）。
 *
 * ```
 * coverKind === 'photo' && coverItemId ? mediaItemUrl(coverItemId)
 *   ?? detail.poster
 *   ?? playEps[0]?.poster
 *   ?? null（渲染层给占位图标）
 * ```
 *
 * 现状这条链在 `SeriesDetail`（:185-190）与 `SeriesCard`（:1357-1360）**各写了一遍**，
 * 已出现「列表卡与剧集头两种结果」的隐患。本函数是唯一实现，两处都调它。
 *
 * 字段来源已核实：`coverItemId` / `coverKind` 是后端 `list_series_filtered` 的
 * **SQL 聚合派生字段**（`download-engine/crates/orig-tg/src/media.rs:1432-1449`），
 * 经 `SeriesDetail` 的 `serde(flatten)` 下发 —— **只读，不可假设可写**。
 * `detail.poster`（显式封面列）优先级低于 photo 类型首集的原因：`poster` 可能是
 * 历史上自动抽帧回写的视频帧（甚至黑帧），有图片集时原图才是最忠实的封面。
 *
 * 视频地址绝不进 `<img>` —— 视频封面只能走抽帧回写（与 `SeriesCard` 同一约束）。
 */
export function resolveSeriesCover(
  detail: Pick<MediaSeriesDetail, 'coverKind' | 'coverItemId' | 'poster' | 'episodes'>,
): string | null {
  const photoEp =
    detail.coverKind === 'photo' && detail.coverItemId != null
      ? detail.coverItemId
      : null
  if (photoEp != null) return mediaItemUrl(photoEp)
  if (detail.poster) return detail.poster
  const firstPlayable = detail.episodes?.find((e) => !isPhotoEpisode(e))
  return firstPlayable?.poster ?? null
}

/** 分集按形态分桶：可播序列 / 图片序列（P6：图片永不进播放序列）。 */
export interface EpisodePartition {
  playEps: MediaEpisode[]
  photoEps: MediaEpisode[]
}

/**
 * 把 `detail.episodes` 分成「可播」与「图片」两桶。
 *
 * 现状是 `SeriesDetail.tsx:151-158` 的两个 `useMemo`，本函数是其收敛版
 * —— 一次遍历，两桶结果对同一输入恒一致。
 *
 * 注意：**不做排序**。后端下发的 `episodes` 顺序即展示顺序（`SeriesDetail`
 * 用 `detail.episodes.indexOf(ep)` 定位播放下标），在这里重排会让播放序号与
 * 行序错位。
 */
export function partitionEpisodes(
  detail: Pick<MediaSeriesDetail, 'episodes'>,
): EpisodePartition {
  const playEps: MediaEpisode[] = []
  const photoEps: MediaEpisode[] = []
  for (const ep of detail.episodes) {
    if (isPhotoEpisode(ep)) photoEps.push(ep)
    else playEps.push(ep)
  }
  return { playEps, photoEps }
}
