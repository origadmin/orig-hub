/**
 * 内容**显名唯一解析函数**（D24-A / BUG-310）。
 *
 * 规则（用户 2026-10-14 拍板，`docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md` §15.1）：
 *
 * ```
 * 用户自定义集名  ＞  剧名 + 集号（单集用剧名）  ＞  来源原文
 * ```
 *
 * ## 为什么必须有这一个函数
 *
 * BUG-310 的原象是「同一个视频在文件域卡片、剧集详情、下载记录三处显示不同名字」——
 * 三处各自写了一段兜底链（空串 → 槽位标签 → 磁盘名），彼此不相等。
 * 判定下沉到这里之后，渲染层只问「这个名字是什么」，不再各写各的兜底。
 *
 * ## 三层各自的真源（都来自后端，本函数只做优先级选择）
 *
 * - **用户自定义集名** = `item.title`，且与 `item.sourceTitle` **不同**（用户改过）。
 *   后端 `media_item.title` 是唯一的可写名字；`sourceTitle` 是只读来源事实。
 *   两者相等 ⇒ 从未被改名 ⇒ 落入下一层。
 * - **剧名 + 集号** = `series.title`（+ 槽位标签）。提供 `episode` 且该剧为多集时拼
 *   `剧名 S{season}E{no}`；单集剧只给剧名（「第 1 季」不携带区分信息）。
 * - **来源原文** = `item.sourceTitle`，缺省回落 `item.title`。
 *
 * ## 与「行内去重」的关系（不是同一条规则）
 *
 * 剧集详情页的分集**行**（`EpisodeList` / `SeriesDetail` 行态）左列已渲染槽位标签，
 * 那里用的是 `episodePresentation.ts#episodeRowTitle` 的**行内去重**规则
 * （与槽位标签 / 剧名逐字相等即不渲染）—— 那是「同一行内不要重复」，与本函数的
 * 「一个内容叫什么」是两条不同的规则。本函数用于需要**一个规范名**的位置：
 * 文件域卡片、剧集详情右栏聚焦标题、展开态标题、播放器分集列表、条目编辑弹窗。
 */
import { episodeSlotLabel } from './episodePresentation'

/** `resolveDisplayName` 的输入：三层字段都可缺省（缺省 = 该层不参与判定）。 */
export interface DisplayNameInput {
  /**
   * 内容条目：`title` 为可写名，`sourceTitle` 为只读来源事实。
   * 可一并携带后端下发的剧集槽位派生字段（`seriesTitle` / `seriesSeason` /
   * `seriesEpisodeNo` / `seriesEpisodeNoEnd` / `seriesEpisodeCount`）——
   * 有它们时无需再单独传 `series` / `episode`。
   */
  item?: {
    title?: string | null
    sourceTitle?: string | null
    seriesTitle?: string | null
    seriesSeason?: number | null
    seriesEpisodeNo?: number | null
    seriesEpisodeNoEnd?: number | null
    seriesEpisodeCount?: number | null
  } | null
  /** 分集：提供 season/episodeNo 时剧名层会拼槽位标签 */
  episode?: {
    season?: number | null
    episodeNo?: number | null
    episodeNoEnd?: number | null
    /** 分集自带的标题（= 所指向条目的标题，后端已收敛为同一份） */
    title?: string | null
  } | null
  /** 剧集：只读 `title` */
  series?: { title?: string | null } | null
  /** 该剧集的分集总数（用于「单集用剧名」判定）；缺省按多集处理 */
  seriesEpisodeCount?: number | null
  /**
   * 全部层都取不到时的兜底文案（如 `#12`）。缺省返回空串 ——
   * 调用方按需再兜（不要在本函数里编造「未命名」这类文案，那是 i18n 的事）。
   */
  fallback?: string
}

function trimOrEmpty(v: string | null | undefined): string {
  return (v ?? '').trim()
}

/**
 * 解析内容的规范显示名（三层优先级见文件头）。永不抛错，最差返回 `fallback ?? ''`。
 *
 * 输入可以只给 `item`（自带剧集派生字段），也可以给 `item` + `episode`/`series`
 * 上下文；显式传入的上下文优先于 `item` 上的派生字段。
 */
export function resolveDisplayName(input: DisplayNameInput): string {
  const it = input.item ?? null
  const effective = trimOrEmpty(it?.title) || trimOrEmpty(input.episode?.title)
  const source = trimOrEmpty(it?.sourceTitle) || effective

  // 1) 用户自定义集名：有效名非空，且与来源事实**不同**（被改名过）。
  //    相等 ⇒ 从未改名（TG 自动入库时 title 就是来源原文）⇒ 让位给剧名层。
  if (effective && effective !== source) return effective

  // 2) 剧名 + 集号（单集用剧名）。
  const seriesTitle = trimOrEmpty(input.series?.title) || trimOrEmpty(it?.seriesTitle)
  if (seriesTitle) {
    const season = input.episode?.season ?? it?.seriesSeason
    const episodeNo = input.episode?.episodeNo ?? it?.seriesEpisodeNo
    const episodeNoEnd = input.episode?.episodeNoEnd ?? it?.seriesEpisodeNoEnd
    const count = input.seriesEpisodeCount ?? it?.seriesEpisodeCount
    const hasSlot = Number.isFinite(season) && Number.isFinite(episodeNo)
    // 「单集用剧名」：分集总数恰为 1 时只用剧名，不拼集号（「第 1 季」不携带区分信息）。
    const single = count === 1
    if (!single && hasSlot) {
      return `${seriesTitle} ${episodeSlotLabel({
        season: season as number,
        episodeNo: episodeNo as number,
        episodeNoEnd: episodeNoEnd ?? null,
      })}`
    }
    return seriesTitle
  }

  // 3) 来源原文。
  return source || input.fallback || ''
}
