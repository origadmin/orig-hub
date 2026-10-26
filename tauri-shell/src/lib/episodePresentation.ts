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
 * 判定（三条全部满足才渲染）：
 *   1. 标题 trim 后非空；
 *   2. 与剧集标题 trim 后的结果不逐字相等；
 *   3. **与槽位标签不逐字相等**（BUG-260）。
 *
 * 第 3 条的由来：分集选择行的左列已经渲染槽位标签（`episodeSlotLabel`），中列若再
 * 渲染一个逐字等于槽位标签的「标题」，用户就读到两遍同一个 `S1E3` —— BUG-260 的
 * 报障原象 `S1E3S1E3未缓存`。槽位标签的唯一展位在左列；「标题恰好等于槽位标签」
 * 是无信息量的展示，判据直接拒绝（让错误状态不可表达）。
 *
 * 注意 2/3 都是 `!==` 全等判定，不是「不包含」——`第 1 集 序章` 相对 `序章`、
 * `S1E3 重制版` 相对 `S1E3` 都是有信息量的补充，不该被判为重复。
 */
export function shouldRenderEpisodeTitle(ep: MediaEpisode, series: MediaSeriesDetail): boolean {
  const epTitle = (ep.title ?? '').trim()
  return (
    epTitle.length > 0 &&
    epTitle !== (series.title ?? '').trim() &&
    epTitle !== episodeSlotLabel(ep)
  )
}

/**
 * 分集选择行**中列**应渲染的标题文本（BUG-260）。
 *
 * 门控为真（`shouldRenderEpisodeTitle`）⇒ 返回 `ep.title`；为假 ⇒ 返回 `null`
 * （React 渲染 nothing）—— **绝不回退槽位标签**。
 *
 * 裁定背景（活体取证，2026-10-12）：BUG-260 文档原根因假设「BUG-246/BUG-200 把
 * 无标题分集的 ep.title 回填成槽位标签」——该前提不成立：BUG-200 的裁定恰是
 * 「集可以没有标题、空标题可显式清空」，实测 series 315 的 8 集里 7 集
 * `media_item.title` 就是空串。真正的重复机制是**中列回退**：旧代码
 * `shouldRenderEpisodeTitle(ep, detail) ? ep.title : episodeSlotLabel(ep)`
 * 在标题为空时把槽位标签渲进中列，与左列逐字重复（实测行文本 `S1E3S1E3未缓存`）。
 *
 * 修复 = 双保险：中列不再回退（本函数）+ 门控增加「标题 != 槽位标签」判据
 * （`shouldRenderEpisodeTitle` 第 3 条）。数据侧零改动：标题回填行为、
 * `episodeSlotLabel`、编辑入口（R3：标题/介绍恒可读写）全部原样。
 *
 * ⚠️ 右栏聚焦面板的 `episode-focus-title` **不**用本函数：面板内没有左列，
 * 不存在重复；其「同名时退化为槽位标签」的回退是布局回归断言（TL-21 R5）的
 * 既定行为，保持原样。
 */
export function episodeRowTitle(ep: MediaEpisode, series: MediaSeriesDetail): string | null {
  return shouldRenderEpisodeTitle(ep, series) ? ep.title ?? null : null
}

/**
 * 单集介绍是否需要在单集层（右栏聚焦面）渲染。
 *
 * 2026-10-24 裁定（用户复报「简介出现两次」）：**剧集级介绍不在右栏重复渲染**。
 *
 * 演进：
 *  - 旧规则（BUG-171）：与剧集介绍逐字相同 ⇒ 隐藏。缺陷：TG 相册组只有一条组级
 *    caption，36/44 条分集逐字等于剧集介绍 ⇒ 右栏几乎每集都空态「本集暂无介绍」
 *    （BUG-281 报障「大部分集是没有内容的」）。
 *  - BUG-281 裁定（2026-10-12）：改为「非空即渲染 + 贴『剧集介绍』标签」，让重复
 *    可见、有说明。
 *  - 2026-10-24 复报：可见的重复仍是重复 —— 用户判定「没修」。此时左栏总览已**恒常驻**
 *    展示剧集介绍（BUG-183 补回的 `series-description`），剧集级文案在左栏有一份权威
 *    展示位，右栏再贴一份就是纯冗余。
 *
 * 现行规则（与左栏总览分工，内容只出现一次）：
 *  - 空 ⇒ 右栏走空态 `media.descEmptyEp`（此时左栏也没有，确实没有）；
 *  - 与剧集介绍 trim 后逐字相同（剧集级）⇒ **右栏不渲染**（已在左栏总览展示）；
 *  - 其余（分集独有介绍）⇒ 右栏渲染，标签恒为「本集介绍」。
 *
 * 编辑入口从不问这些函数（设计约束，文件头）；这是渲染期规则，绝不为了去重去改
 * 数据（P5 单一真源）。`series` 现在参与判定（剧集级去重的依据）。
 */
export function shouldRenderEpisodeDescription(
  ep: MediaEpisode,
  series: MediaSeriesDetail,
): boolean {
  const epDesc = (ep.description ?? '').trim()
  if (epDesc.length === 0) return false
  // 剧集级介绍：左栏总览已常驻展示，右栏不再重复（消除「同一段简介出现两次」）。
  if (epDesc === (series.description ?? '').trim()) return false
  return true
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
