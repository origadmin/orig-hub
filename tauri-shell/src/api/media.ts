/**
 * 媒体资料库 API（orig-tg 9877 `/api/media/*`）。
 *
 * 与 TG 流水（`/api/tg/*`）分离：这里是**用户可管理的资料库**——
 * 内容（item）、剧集（series/episode）、标签（tag）。
 */

import { tgBase } from './tg'
import type { GroupManifest } from '../types'

/** 媒体资料库与 TG 服务同进程同端口（orig-tg 9877） */
/** 媒体库基址：每次现算 —— TG 端口由 daemon 下发，可能在运行期变化（BUG-178） */
const mediaBase = () => tgBase()

/** 媒体类型 */
export type MediaKind = 'video' | 'photo' | 'audio' | 'file'

/**
 * 剧集类型 —— 与后端 `media_series.kind` 的合法枚举**逐字对应**
 * （后端 `media::SERIES_KINDS`，枚举外的值 PATCH 一律 422）。
 *
 * 单独导出而不是各处内联字面量：BUG-258 的教训正是「写路径不校验、读路径把未知值
 * 原样透出」两头对不上，于是 `garbage` 能进库并在界面上显示成一个无意义的徽标。
 * 一份定义 + 后端强校验 = 非法状态不可表达。
 */
export type SeriesKind = 'series' | 'collection' | 'album'

/** 剧集类型可选项（下拉顺序即此顺序） */
export const SERIES_KINDS: readonly SeriesKind[] = ['series', 'collection', 'album'] as const

/**
 * 内容类型 → i18n 键。**存的是键，不是文案** —— 双语应用里硬编码中文会让英文界面
 * 混排「视频 / 图片」（BUG-128），渲染时才用 `t()` 求值。
 *
 * 为什么不复用 `media.videos` / `media.photos`：那三个是**复数分类名**（左栏分类按钮
 * 的文案），这里是**单数类型名**，语义不同 —— 复用会让将来改分类名时意外改掉徽标。
 *
 * 单一来源：`MediaCard` 的角标与 `ItemEditDialog` 的只读类型行都从这里取，
 * 免得同一份映射在两个文件里各写一遍、其中一处漏了新类型（BUG-258：内容弹窗此前
 * 直接渲染后端原始枚举 `video/photo/file`，没走 i18n，英文界面里也是裸值）。
 *
 * @param kind 后端 `media_item.kind`
 * @returns i18n 键；**未知类型返回 `null`** —— 「没有对应文案」是一个与
 *   「文案是空的」不同的状态，调用方必须自己决定怎么办（`MediaCard` 选择不画徽标，
 *   `ItemEditDialog` 选择回落到「文档」）。这里**故意不返回原始枚举**：把未知值
 *   透出到界面上会被读成「这是一个合法类型」，正是 BUG-258 的病症之一。
 */
export function kindLabelKey(kind?: string | null): string | null {
  switch (kind) {
    case 'video':
      return 'media.kindVideo'
    case 'photo':
      return 'media.kindPhoto'
    case 'audio':
      return 'media.kindAudio'
    case 'file':
      return 'media.kindFile'
    default:
      return null
  }
}

/**
 * 剧集类型 → i18n 键。与 [`kindLabelKey`] 同构，但走 `media.series.*` 一组。
 *
 * 此前 `SeriesEditPanel` / `SeriesCard` / `SeriesDetail` 三处**各写一遍**同样的
 * 三分支，且都以 `return k` 收尾 —— 未知枚举被原样渲染（BUG-258）。后端现在对
 * 枚举外的值 422，脏值不再产生；但**存量库**里可能已经有（老版本收过任意字符串），
 * 所以读路径仍不得透出原值：回落到「剧集」这个默认值，好过一个界面无法解释的串。
 *
 * @returns i18n 键；未知类型回落到 `media.series.kindSeries`（**绝不**返回原值）
 */
export function seriesKindLabelKey(kind?: string | null): string {
  switch (kind) {
    case 'collection':
      return 'media.series.kindCollection'
    case 'album':
      return 'media.series.kindAlbum'
    case 'series':
    default:
      // `series` 与「未知」共用回落：类型下拉只有这三项，猜错时的最小误导是「剧集」。
      return 'media.series.kindSeries'
  }
}

/** 标签 */
export interface MediaTag {
  id: number
  name: string
  color?: string | null
  itemCount?: number
  seriesCount?: number
}

/** 内容条目 */
export interface MediaItem {
  id: number
  source: 'local' | 'tg' | string
  ref: string
  title: string
  /**
   * **只读来源事实**（D24-A / BUG-310）：这条内容第一次被写下的名字（caption 首行 /
   * 来源原文）。用户改名只写 `title`，本字段永不随改名而变。
   *
   * 显名规则「用户自定义集名 ＞ 剧名+集号 ＞ 来源原文」里的「来源原文」即它 ——
   * 全部显名位置请走 `lib/displayName.ts#resolveDisplayName`，不要各自兜底。
   * 缺省（老后端 / 来源确实无题）时回落 `title`。
   */
  sourceTitle?: string | null
  /** 介绍：与剧集 `description` 同源同切法（caption 首行之外的部分） */
  description?: string | null
  kind: MediaKind
  filePath?: string | null
  /**
   * 字节所有权 P2：文件的真实绝对路径（后端按库根解析链统一解析）。
   * `filePath` 是库内规范形式（归仓成功 = 库根相对路径），展示/导出请用本字段；
   * 条目无字节时两字段同时缺席。
   */
  absolutePath?: string | null
  /**
   * 磁盘字节真值（`present` / `missing` / `unknown`），由后端 `probe_cached_bytes()` 探测。
   * BUG-132：条目视图与分集视图共用它 —— 不要再用 `Boolean(filePath)` 判「有没有字节」，
   * 那是数据库里的承诺，文件被外部删除 / 0 字节时它照样说有。
   */
  bytesPresence?: string | null
  /** 前端生成的封面 data-uri（视频抽帧 / 图片缩略） */
  poster?: string | null
  size?: number | null
  duration?: number | null
  width?: number | null
  height?: number | null
  addedAt: number
  tags: MediaTag[]
  seriesId?: number | null
  seriesTitle?: string | null
  /**
   * 该条目在所属剧集里的槽位（D24-A / BUG-310）。显名规则「剧名+集号」需要集号才能
   * 拼出「剧名 S1E3」；`seriesEpisodeCount === 1` 时显名只用剧名（单集用剧名）。
   * 条目未入剧时全部缺席。
   */
  seriesSeason?: number | null
  seriesEpisodeNo?: number | null
  seriesEpisodeNoEnd?: number | null
  seriesEpisodeCount?: number | null
}

/** 剧集列表项 */
export interface MediaSeries {
  id: number
  title: string
  description?: string | null
  /** series（剧集）/ collection（合集）/ album（图集） */
  kind: SeriesKind
  /** 封面：显式设置优先，否则由后端取首集封面 */
  poster?: string | null
  /** 首集内容 id：封面仍缺失时可回退到该条目原图 */
  coverItemId?: number | null
  /** 首集内容类型：photo 可直接当封面，video 需先抽帧 */
  coverKind?: MediaKind | null
  year?: number | null
  createdAt: number
  updatedAt: number
  episodeCount: number
  seasonCount: number
  /**
   * 剧集内容构成（BUG-250）：主页剧集卡要能体现「有没有视频 / 有没有图片」。
   * 后端 `SeriesView.video_count/photo_count`；0 是有效读数（真的没有），
   * 与「字段缺失（老后端）」语义不同 —— 缺失时前端不得编造 0。
   */
  videoCount?: number
  photoCount?: number
  /**
   * 封面条目是否已有字节（BUG-250）。false ⇒ 不要对 video 封面抽帧
   * （`/raw` 对无字节条目必然失败，实测 404）。老后端不下发该字段时按 true 处理，
   * 保持既有行为不变。
   */
  coverHasBytes?: boolean
  /**
   * 该剧集**是否至少有一个分集条目已落盘**（BUG-304 / D18）。
   *
   * 与 `coverHasBytes` 的**主体**不同：后者只看封面那一条 —— 「封面是张没缓存的图、
   * 正片全在」的剧集会被判 false，与真实可播性不等价。本字段回答「这部剧里有没有东西」，
   * 成品列表据此过滤（文件域只列有字节内容）。
   *
   * 老后端不下发该字段时为 `undefined`，前端按「可能有字节」处理（不过滤）——
   * 与 `coverHasBytes` 的兼容策略一致：宁可多显示，也不要因为字段缺失把库清空。
   */
  hasBytes?: boolean
  tags: MediaTag[]
}

/** 分集 */
export interface MediaEpisode {
  id: number
  itemId: number
  season: number
  episodeNo: number
  /**
   * 内容标题 —— **取自所指向的条目**。
   *
   * 分集只表示「内容在剧集里的位置」，标题与介绍归内容（条目）。
   * 曾经还有一套 `itemTitle` / `itemDescription`：同一份文案两个字段、两个写入路径，
   * 于是同一个视频在剧集页叫旧名、在媒体库里叫新名。现在只有一个名字。
   */
  title?: string | null
  poster?: string | null
  duration?: number | null
  kind?: MediaKind | null
  /** 内容介绍 —— 同样取自所指向的条目。 */
  description?: string | null
  /**
   * 合并溯源：来源剧集标题快照。源剧集在合并时已被删除，故由后端存快照下发。
   * null = 这条不是合并搬过来的。
   */
  originSeriesTitle?: string | null
  /** 合并溯源：并入目标前的原始集号（重编后仍可分辨「这条原来是第几集」） */
  originEpisodeNo?: number | null
  /** 条目来源（'local' / 'tg'）——「同一内容多源导入」时用于分辨 */
  source?: string | null
  /** 条目来源标识（本地路径 / TG ref）—— 分辨重复项的唯一可靠依据，别用标题 */
  ref?: string | null
  /** 合集范围终点（BUG-039）：占用槽位 episodeNo..episodeNoEnd；缺省 = 单集 */
  episodeNoEnd?: number | null
  /** 同槽备用来源（BUG-039）：同一集的其他缓存来源；主条目不在其中 */
  sources?: EpisodeSourceRef[]
  /** 集级挂图（BUG-168）：一集可挂多张图，同一张图也可挂到多集；不进播放序列 */
  images?: EpisodeImageMeta[]
  /**
   * 这一集当前有没有字节（BUG-080；后端 `file_path IS NOT NULL`）。
   * 清缓存只删字节留条目，没有它前端无从分辨「点开能播」与「点了 404」。
   */
  hasBytes?: boolean | null
  /**
   * 这一集是否仍有可重取/可切的 TG 来源（BUG-261 下发步）。
   * 主条目 `source === 'tg'` 且 ref 非空，或任一备用源如此 ⇒ true。
   * true ⇒ 该集无论何时都可缓存/切换来源（缓存引擎端点吃来源 ref）；
   * false ⇒ 纯本地来源，无 ref 坐标，缓存无从下发。
   * 判据不含 hasBytes —— 无字节的 TG 来源正是「要缓存」的对象。
   */
  hasRecacheableSource: boolean
}

/** 剧集分集的备用来源引用 */
export interface EpisodeSourceRef {
  itemId: number
  title?: string | null
  kind?: MediaKind | null
  /** 条目来源（'local' / 'tg'）。只有 'tg' 来源能被缓存引擎按 ref 重取（BUG-261） */
  source?: string | null
  /** 来源标识（TG `chat:msg` ref / 本地路径）—— 按来源下发缓存任务的坐标 */
  ref?: string | null
  /** 字节大小（未落盘为 null） */
  size?: number | null
  /** 时长秒（缺失为 null） */
  duration?: number | null
  /** 该备用源当前有没有字节（与主条目同一套 probe 真值） */
  hasBytes?: boolean | null
}

/** 集级挂图元数据（BUG-168）：`media_episode_image` join `media_item` 的读视图 */
export interface EpisodeImageMeta {
  itemId: number
  /** 原文件落盘路径（TG 图片按规则不落盘时为 null，前端用 raw 端点现取） */
  path?: string | null
  poster?: string | null
  bytes?: number | null
}

/** 合并时被跳过的分集（同一条目已在目标同季） */
export interface MergeSkipped {
  itemId: number
  title?: string | null
  season: number
  episodeNo: number
}

/** 剧集合并结果 */
export interface MergeResult {
  /** 实际搬移的分集数 */
  added: number
  skippedCount: number
  skipped: MergeSkipped[]
}

/** 剧集级「补缺」时被跳过的缺失集（BUG-261：ref 非 tg / 缺失，缓存引擎没有坐标） */
export interface RecacheMissingSkipped {
  itemId: number
  /** 服务端给定的固定英文短串（界面原样透出，不翻译） */
  reason: string
}

/** 剧集级「补缺」结果（BUG-261）：`POST /api/media/series/:id/recache-missing` */
export interface RecacheMissingResult {
  /** 入队的消息数（有字节的集不重复入队） */
  enqueued: number
  /** 按 chat 聚的组数（同 chat 的多集合并为一个缓存任务） */
  groups: number
  /** 无法定位可缓存来源的缺失集（必须带原因，不静默） */
  skipped: RecacheMissingSkipped[]
}

export interface MediaSeriesDetail extends MediaSeries {
  episodes: MediaEpisode[]
}

export interface LibraryStats {
  items: number
  videos: number
  photos: number
  audios: number
  series: number
  tags: number
  totalSize: number
}

/** 扫描到的本地文件 */
export interface ScannedFile {
  path: string
  name: string
  kind: MediaKind
  size: number
  dir: string
}

export interface MediaListResult {
  items: MediaItem[]
  total: number
}

export interface MediaListQuery {
  kind?: MediaKind | ''
  q?: string
  tagId?: number
  seriesId?: number
  unassigned?: boolean
  /**
   * 只列**已落盘**条目（BUG-304 / D18：文件域只列成品）。
   *
   * 过滤在**服务端**做，而不是拿 `bytesPresence` 在客户端筛 ——
   * 客户端筛会让「本页 N 条」与 `total` 各说各话，分页随之错位。
   */
  hasBytes?: boolean
  sort?: 'recent' | 'oldest' | 'title' | 'duration' | 'size'
  limit?: number
  offset?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type 只在**真有请求体**时设置（BUG-241）：它不是 CORS 安全头，GET/HEAD
  // 带上会触发跨源 OPTIONS 预检（by-ref 的 54 次 ≈ 27 张照片 × 2）。由 body 派生而非
  // method，未来调用方不可能写错；init.headers 仍按原顺序合并，覆盖同名键。
  const res = await fetch(`${mediaBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* 保留状态码文案 */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

/** 内容原始文件流地址（支持 Range，可直接喂 <video>/<img>） */
export function mediaItemUrl(id: number): string {
  return `${mediaBase()}/api/media/items/${id}/raw`
}

/**
 * 内容兼容流地址（BUG-208）：浏览器解不动的编码（HEVC 等）走服务端按需实时转码
 * H.264。首次为直播（转码即播），完成后同地址自动命中代理缓存（秒开 + Range 可拖）。
 */
export function mediaItemStreamUrl(id: number): string {
  return `${mediaBase()}/api/media/items/${id}/stream`
}

// ────────────────── 内容 ──────────────────

/**
 * 把列表查询**规范化**成查询串 —— `listMediaItems` 的 URL 与 `fetchCache` 的
 * `cacheKey.mediaList` 键**共用这一份**。
 *
 * 为什么必须是同一个函数（BUG-138）：读缓存的前提是「键能唯一标识那次请求」。
 * 若键在调用方手拼（`kind=${tab}|q=${search}`），它与 `listMediaItems` 内部发的
 * 查询串就是两份独立的真相 —— 改了一处忘了另一处，症状是「缓存命中了但显示的是
 * 另一批数据」，不报错、只在数据错位时看得极难查。由同一函数产出则结构上不可能分叉。
 *
 * 规范化内容：
 *   - **空值不参与**：`''` / `undefined` 一律不发（后端把空串当「不过滤」）。
 *   - **默认值显式化**：`limit` / `offset` 缺省值写进串，故「不传 limit」与
 *     「传 limit=60」命中同一个键 —— 它们本就是同一次请求。
 *   - **字段定序**：按固定顺序拼，不依赖对象键序。
 *
 * 键里出现用户输入（`q=`）不是问题：它是键的一部分，只影响命中率。
 */
export function mediaListParams(q: MediaListQuery = {}): string {
  const sp = new URLSearchParams()
  if (q.kind) sp.set('kind', q.kind)
  if (q.q) sp.set('q', q.q)
  if (q.tagId !== undefined) sp.set('tagId', String(q.tagId))
  if (q.seriesId !== undefined) sp.set('seriesId', String(q.seriesId))
  if (q.unassigned) sp.set('unassigned', 'true')
  // `hasBytes` 在后端是 `Option<bool>`（与 `unassigned` 同一契约）：serde_urlencoded
  // 只认 `true`/`false`，发 `'1'` 会被 400 拒掉（运行时验收实测：
  // "provided string was not `true` or `false`"）⇒ 整页列表加载失败。
  if (q.hasBytes) sp.set('hasBytes', 'true')
  if (q.sort) sp.set('sort', q.sort)
  sp.set('limit', String(q.limit ?? 60))
  sp.set('offset', String(q.offset ?? 0))
  return sp.toString()
}

export async function listMediaItems(q: MediaListQuery = {}): Promise<MediaListResult> {
  return request<MediaListResult>(`/api/media/items?${mediaListParams(q)}`)
}

export async function getMediaItem(id: number): Promise<MediaItem> {
  return request<MediaItem>(`/api/media/items/${id}`)
}

/** 按 (source, ref) 查条目 id；不存在返回 null（BUG-049：图片「已入库」判定用） */
export async function findMediaItemIdByRef(source: string, ref: string): Promise<number | null> {
  const sp = new URLSearchParams({ source, ref })
  const d = await request<{ id: number | null }>(`/api/media/items/by-ref?${sp}`)
  return d.id
}

/** 批量按 (source, ref) 查条目 id（BUG-241 Priority 2）。返回一个 ref→id 映射
 *  （未入库的 ref 不出现）。TG 面板用它**一次请求**覆盖所有图片，消除逐条 N+1。 */
export async function findMediaItemIdsByRefs(
  source: string,
  refs: string[],
): Promise<Record<string, number>> {
  if (refs.length === 0) return {}
  const sp = new URLSearchParams({ source, refs: refs.join(',') })
  const d = await request<{ ids?: Record<string, number> }>(`/api/media/items/by-refs?${sp}`)
  return d.ids ?? {}
}

export async function getLibraryStats(): Promise<LibraryStats> {
  return request<LibraryStats>('/api/media/stats')
}

export interface ImportEntry {
  path?: string
  ref?: string
  source?: 'local' | 'tg'
  title?: string
  kind?: MediaKind
  size?: number
  duration?: number
}

/** 批量导入（按 source+ref 幂等） */
export async function importMediaItems(items: ImportEntry[]): Promise<{ ids: number[]; count: number }> {
  return request('/api/media/items', { method: 'POST', body: JSON.stringify({ items }) })
}

export async function patchMediaItem(
  id: number,
  patch: {
    title?: string
    /** 介绍：`null` = 显式清空（后端 Option<Option<String>> 契约，与剧集一致） */
    description?: string | null
    poster?: string
    duration?: number
    width?: number
    height?: number
    kind?: MediaKind
  },
): Promise<{ ok: boolean }> {
  return request(`/api/media/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** 从资料库移除（不删磁盘原文件） */
export async function deleteMediaItem(id: number): Promise<{ ok: boolean }> {
  return request(`/api/media/items/${id}`, { method: 'DELETE' })
}

export async function setItemTags(id: number, tagIds: number[]): Promise<{ ok: boolean }> {
  return request(`/api/media/items/${id}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tagIds }),
  })
}

// ────────────────── 剧集 ──────────────────

/** 导出完备性单类问题（byte-ownership P5） */
export interface ExportIssue {
  episodeId: number
  /** 展示形集号（"S1E2"） */
  episodeNo: string
  /** bytes（缺字节/文件不存在）| description（缺简介）| image（缺图）| empty（零字节文件） */
  kind: 'bytes' | 'description' | 'image' | 'empty' | string
  detail: string
}

/** 单部剧集的导出完备性报告：issues 为空 = 可导出 */
export interface SeriesExportReport {
  seriesId: number
  title: string
  issues: ExportIssue[]
}

export interface ExportPreviewResult {
  series: SeriesExportReport[]
  summary: {
    seriesTotal: number
    seriesReady: number
    issuesTotal: number
    byKind: Record<string, number>
  }
}

/**
 * GET /api/media/export/preview?seriesIds=1,2 — 导出完备性校验（只读）。
 * `seriesIds` 缺省 = 全库；真正导出动作属 P6 另端点，这里只列问题清单。
 */
export async function previewExport(seriesIds?: number[]): Promise<ExportPreviewResult> {
  const qs =
    seriesIds && seriesIds.length > 0 ? `?seriesIds=${seriesIds.map(encodeURIComponent).join(',')}` : ''
  return request<ExportPreviewResult>(`/api/media/export/preview${qs}`)
}

/** 导出包结果（byte-ownership P6）：`POST /api/media/export` 的响应体。 */
export interface ExportBundleResult {
  targetDir: string
  exportDir: string
  manifestPath: string
  seriesCount: number
  filesCopied: number
}

/** 导出失败（含完备性闸口未过）：`issues` 非空时表示被 ready 校验拦下，可复位到补全视图。 */
export class ExportError extends Error {
  issues?: SeriesExportReport[]
  constructor(message: string, issues?: SeriesExportReport[]) {
    super(message)
    this.name = 'ExportError'
    this.issues = issues
  }
}

/**
 * POST /api/media/export — EE 导出本体（byte-ownership P6）。
 * `seriesIds` 缺省 = 全库；`targetDir` 必须为空或不存在（后端校验，避免覆盖）。
 * 完备性闸口未过 → 422 + issue 清单（通过 ExportError.issues 暴露）。
 */
export async function exportMedia(
  seriesIds: number[] | undefined,
  targetDir: string,
): Promise<ExportBundleResult> {
  const body: { seriesIds?: number[]; targetDir: string } = { targetDir }
  if (seriesIds && seriesIds.length > 0) body.seriesIds = seriesIds
  const res = await fetch(`${mediaBase()}/api/media/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    let issues: SeriesExportReport[] | undefined
    try {
      const b = (await res.json()) as { error?: string; issues?: SeriesExportReport[] }
      if (b?.error) msg = b.error
      if (Array.isArray(b?.issues)) issues = b.issues
    } catch {
      /* 保留状态码文案 */
    }
    throw new ExportError(msg, issues)
  }
  return (await res.json()) as ExportBundleResult
}

/** 列出剧集。`tagId` 用于按标签筛剧集（TG 自动归档的 #标签 落在剧集上）。 */
export async function listSeries(tagId?: number | null): Promise<MediaSeries[]> {
  const qs = tagId == null ? '' : `?tagId=${tagId}`
  const r = await request<{ items: MediaSeries[] }>(`/api/media/series${qs}`)
  return r.items ?? []
}

// ─────────────────── 批量整理（D24-A / BUG-311）───────────────────

/**
 * 模板预设项。mp3tag 风格模板变量：
 * `{剧名}` `{季}`/`{season}` `{集}`/`{episode}` `{集名}` `{来源}` `{日期}` `{ext}`，
 * 格式符如 `{season:02}`（零填充到总宽 2）。
 */
export interface OrganizePreset {
  id: string
  template: string
  label: string
}

/** 预览全表的一行（旧路径→新路径、冲突、动作）。 */
export interface OrganizeRow {
  itemId: number
  displayName: string
  sourcePath?: string | null
  targetPath: string
  /** link（同卷硬链接）/ copy（跨卷副本）/ skip（已就位）/ missing（无字节）/ blocked（失败） */
  action: string
  conflict: boolean
  note?: string | null
}

export interface OrganizeSummary {
  total: number
  link: number
  copy: number
  skip: number
  missing: number
  blocked: number
  written: number
  failed: number
}

export interface OrganizeReport {
  rows: OrganizeRow[]
  summary: OrganizeSummary
}

/**
 * 整理请求（预览与执行同一形状）。
 * `targetDir` 是用户指定的产物根目录；整理**绝不**修改 blob 或条目路径。
 */
export async function organizePreview(
  itemIds: number[],
  template: string,
  targetDir: string,
): Promise<OrganizeReport> {
  return request<OrganizeReport>('/api/media/organize/preview', {
    method: 'POST',
    body: JSON.stringify({ itemIds, template, targetDir }),
  })
}

/** 执行整理（幂等；产物登记为外部发布路径）。 */
export async function organizeApply(
  itemIds: number[],
  template: string,
  targetDir: string,
): Promise<OrganizeReport> {
  return request<OrganizeReport>('/api/media/organize/apply', {
    method: 'POST',
    body: JSON.stringify({ itemIds, template, targetDir }),
  })
}

export async function listOrganizePresets(): Promise<OrganizePreset[]> {
  const r = await request<{ presets: OrganizePreset[] }>('/api/media/organize/presets')
  return r.presets ?? []
}

export async function getSeries(id: number): Promise<MediaSeriesDetail> {
  return request<MediaSeriesDetail>(`/api/media/series/${id}`)
}

export async function createSeries(body: {
  title: string
  description?: string
  kind?: SeriesKind
  year?: number
}): Promise<{ id: number }> {
  return request('/api/media/series', { method: 'POST', body: JSON.stringify(body) })
}

export async function patchSeries(
  id: number,
  patch: {
    title?: string
    /** 介绍：`null` = 显式清空（后端 Option<Option<String>> 契约） */
    description?: string | null
    /**
     * 类型：必须是 `series` / `collection` / `album`。
     * BUG-258：后端对枚举外的值返回 422，脏值不再可能进列。
     */
    kind?: SeriesKind
    poster?: string | null
    /**
     * 年份：`null` = **显式清空**（后端 `Option<Option<i64>>` 契约）。
     * BUG-258：此前类型是 `year?: number`，「清空」与「缺省」不可区分 ——
     * 用户填错后永远改不掉，且前端在字段为空时干脆不发这个键。
     * 键**缺省**仍是「不改」，所以「没碰过这个字段」不会误清别人的值。
     */
    year?: number | null
  },
): Promise<{ ok: boolean }> {
  return request(`/api/media/series/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export async function deleteSeries(id: number): Promise<{ ok: boolean }> {
  return request(`/api/media/series/${id}`, { method: 'DELETE' })
}

export async function setSeriesTags(id: number, tagIds: number[]): Promise<{ ok: boolean }> {
  return request(`/api/media/series/${id}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tagIds }),
  })
}

/**
 * 按槽位加入单集（`episodeNo` 缺省 1 = S1E1）。
 *
 * BUG-129：槽位已被占用且未传 `overwrite: true` 时后端返回 **409**，不覆盖原条目。
 * 「加入剧集」请用 {@link appendEpisodes} —— 顺序追加，不挤占已有槽位。
 */
export async function addEpisode(
  seriesId: number,
  body: { itemId: number; season?: number; episodeNo?: number; overwrite?: boolean },
): Promise<{ id: number }> {
  return request(`/api/media/series/${seriesId}/episodes`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 按顺序批量追加为连续集号 */
export async function appendEpisodes(
  seriesId: number,
  itemIds: number[],
  season = 1,
): Promise<{ added: number }> {
  return request(`/api/media/series/${seriesId}/episodes/append`, {
    method: 'POST',
    body: JSON.stringify({ itemIds, season }),
  })
}

/**
 * 合并剧集：把 `sourceId` 的全部分集搬入 `seriesId` 末尾（各季续编集号）并**删除源剧集**。
 *
 * 后端刻意不做内容级去重：文件名相同而内容不同、同一内容多源导入、`1-2` 与 `1,2` 并存、
 * 每批都带的预告 —— 一律原样保留。只有「同一条目已在目标同季」才跳过，
 * 且跳过明细在 `skipped` 里回传，调用方**必须**呈现给用户。
 */
export async function mergeSeries(seriesId: number, sourceId: number): Promise<MergeResult> {
  return request(`/api/media/series/${seriesId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  })
}

/**
 * 合并**多个**剧集（BUG-186）：把 `sourceIds` 里每个源剧集的**全部分集**搬入 `targetId`
 * 末尾（各季续编集号）并**删除**这些源剧集。
 *
 * 后端契约：`POST /api/media/series/:targetId/merge`，body `{ "sourceIds": [12, 13] }`。
 * 与单源的 `mergeSeries`（`{ sourceId }`）**并存**：后者仍被剧集内页对话框使用，不得破坏。
 *
 * 多源在**同一事务**里全成或全滚 —— 所以前端必须**只发这一个请求**：
 * 在前端循环调单源端点会丢掉原子性（中途失败会留下「合了一半」的中间态）。
 */
export async function mergeSeriesMulti(
  targetId: number,
  sourceIds: number[],
): Promise<MergeResult> {
  return request(`/api/media/series/${targetId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ sourceIds }),
  })
}

/**
 * 剧集级「补缺」（BUG-261）：一次请求把这部剧所有无字节分集的可缓存来源入队。
 *
 * 走引擎原子端点（本仓规约：批量操作禁止前端循环调单条 —— 10 集全缺的剧集
 * 必须是 1 次点击 + 1 个 HTTP 请求，而不是 10 次循环）。无任何可缓存来源的
 * 缺失集由后端回传 `skipped` 明细（带原因），前端照数透出，不静默。
 */
export function recacheSeriesMissing(seriesId: number): Promise<RecacheMissingResult> {
  return request(`/api/media/series/${seriesId}/recache-missing`, { method: 'POST' })
}

/**
 * 剧集级**按组清单真缺口**补缓存（D22-A② / BUG-296）：`POST /api/media/series/:id/recache-gap`。
 *
 * 与 `recacheSeriesMissing` 的分工：后者只收**已存在但无字节**的分集；本函数收组清单里
 * **未编入的序号**（含「连条目都没有」的 `missing` 与「已登记未编入」的
 * `registered_unslotted`），且**排除挂图**（图集是设计不是缺口）。
 */
export function recacheSeriesGap(
  seriesId: number,
): Promise<{ enqueued: number; groups: number }> {
  return request(`/api/media/series/${seriesId}/recache-gap`, { method: 'POST' })
}

/**
 * 剧集级**组清单**（D22-A② / BUG-296）：序号全集 + 每条状态 + 真缺口。
 *
 * 「缺集灰条」的数据源 —— 它比 `missingCount`（无字节分集数）更完整：
 * 后者只数**已存在**的分集，前者还能报出**连条目都没有**的缺失序号
 * （BUG-296 的核心态：`media_item` 有行但无槽位 / 完全没有行）。
 * 剧集不存在 ⇒ 404。
 */
export function getSeriesManifest(seriesId: number): Promise<GroupManifest> {
  return request(`/api/media/series/${seriesId}/manifest`)
}

/** 人工**拆剧**结果（D22-A⑥ / BUG-292 误并出口） */
export interface SplitSeriesResult {
  /** 拆出的新（手工）剧集 id */
  newSeriesId: number
  /** 实际搬移的分集数 */
  moved: number
}

/**
 * 人工**拆剧**（D22-A⑥）：把误并进同一部剧的若干条目移入**新建手工剧集**。
 *
 * 组键统一（D22-A①）后同一频道同名相册幂等同一部，误并的唯一出口就是这个动作
 * （合并的逆操作，不做自动冲突弹窗）。拆出的新剧集 `source_key = NULL`（手工剧集），
 * 否则自动路径会按 key 并回来；源剧集保留其余条目、被搬走的条目记墓碑（不复活）。
 */
export function splitMediaSeries(
  seriesId: number,
  itemIds: number[],
  title: string,
): Promise<SplitSeriesResult> {
  return request(`/api/media/series/${seriesId}/split`, {
    method: 'POST',
    body: JSON.stringify({ itemIds, title }),
  })
}

/**
 * 改单集：标题 / 介绍 / **槽位**（季号与集号）。
 *
 * 集号允许任意值（2、3…不必从 1 连续）；若目标槽已被同剧另一条占用，后端会**对调**
 * 两条的槽位（不会 409）—— 所以「把第 3 集改成第 2 集」的结果是两条互换位置。
 */
export async function patchEpisode(
  id: number,
  patch: {
    /**
     * 标题：`null` = **显式清空**（集可以没有标题 —— 剧集已经有名称了，见 BUG-200）。
     * 省略字段 = 不改；空串会被引擎归一化成清空。
     */
    title?: string | null
    /** 介绍：`null` = 显式清空（与剧集介绍同一契约） */
    description?: string | null
    season?: number
    episodeNo?: number
    /** 合集范围终点：`null` = 改回单集 */
    episodeNoEnd?: number | null
  },
): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** 挂条目为某集的备用来源（BUG-039：同一集多缓存来源；幂等） */
export function attachEpisodeSource(episodeId: number, itemId: number): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${episodeId}/sources`, {
    method: 'POST',
    body: JSON.stringify({ itemId }),
  })
}

/** 主备切换：itemId 必须已是该集备用源；原主条目降级为备用 */
export function switchEpisodeSource(episodeId: number, itemId: number): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${episodeId}/sources/primary`, {
    method: 'POST',
    body: JSON.stringify({ itemId }),
  })
}

/** 摘除备用源（内容保留在资料库） */
export function detachEpisodeSource(episodeId: number, itemId: number): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${episodeId}/sources/${itemId}`, { method: 'DELETE' })
}

/**
 * 挂图（BUG-168）：**replace-all** —— 按 itemIds 顺序重写该集的图片位。
 * 只收 photo 条目（非 photo 后端 422，附明细）；集不存在 404。
 * 追加语义由调用方组合：把既有挂图与新选的一起下发。
 */
export function attachEpisodeImages(
  episodeId: number,
  itemIds: number[],
): Promise<{ ok: boolean; attached: number }> {
  return request(`/api/media/episodes/${episodeId}/images`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  })
}

/** 摘除一张挂图（幂等；removed:0 = 本来就没挂，调用方如实提示） */
export function detachEpisodeImage(
  episodeId: number,
  itemId: number,
): Promise<{ ok: boolean; removed: number }> {
  return request(`/api/media/episodes/${episodeId}/images/${itemId}`, { method: 'DELETE' })
}

// ────────────── 集的统一挂载读模型（D1=B 第一步）──────────────

/**
 * 挂载角色。
 *
 * `segment`（一集拆成多个视频片段）**当前无表承载、不会产出行** ——
 * 它在这里先占位，是为了第二步落地片段时**前端无需再改一次**。
 */
export type EpisodeBindingRole = 'main' | 'alternate' | 'image' | 'segment'

/**
 * 一项「集 ↔ 条目」挂载。
 *
 * 这是把「主条目 / 备用源 / 挂图」收敛后的**唯一**读结构：
 * 前端不再需要知道「角色 = 哪张表」，只按 `role` 分派即可。
 */
export interface EpisodeBinding {
  itemId: number
  role: EpisodeBindingRole
  /** 角色内排序位：`main`/`alternate` 恒 0；`image` = sort_no；`segment` = 播放序 */
  seq: number
  title?: string | null
  kind?: MediaKind | null
  /** 条目来源（'local' / 'tg'） */
  source?: string | null
  /**
   * 条目来源标识（本地路径 / TG `chat:msg`）。
   *
   * **内部标识**：只可用于诊断或「复制坐标」这类显式动作，
   * **不得常驻界面**（BUG-148：实现约束 ≠ 产品信息）。
   */
  ref?: string | null
  poster?: string | null
  duration?: number | null
}

/**
 * `GET /api/media/episodes/:id/bindings` — 集的统一挂载读模型（纯只读）。
 *
 * 后端 UNION 现有三张表后按「主 → 备用源 → 挂图」有序返回；不搬迁任何行。
 * 集不存在 → 404。
 */
export function listEpisodeBindings(
  episodeId: number,
): Promise<{ items: EpisodeBinding[] }> {
  return request(`/api/media/episodes/${episodeId}/bindings`)
}

/**
 * 剧集内换位：与同季相邻的一集交换槽位。
 *
 * `moved: false` = 已在边界（没有相邻分集）——**如实回报**，让界面提示而不是假装成功。
 */
export async function moveEpisode(
  id: number,
  dir: 'up' | 'down',
): Promise<{ ok: boolean; moved: boolean }> {
  return request(`/api/media/episodes/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ dir }),
  })
}

export async function deleteEpisode(id: number): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${id}`, { method: 'DELETE' })
}

// ────────────────── 标签 ──────────────────

export async function listTags(): Promise<MediaTag[]> {
  const r = await request<{ items: MediaTag[] }>('/api/media/tags')
  return r.items ?? []
}

/** 重名幂等：已存在则返回既有 id */
export async function createTag(name: string, color?: string): Promise<{ id: number }> {
  return request('/api/media/tags', { method: 'POST', body: JSON.stringify({ name, color }) })
}

export async function patchTag(
  id: number,
  patch: { name?: string; color?: string },
): Promise<{ ok: boolean }> {
  return request(`/api/media/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export async function deleteTag(id: number): Promise<{ ok: boolean }> {
  return request(`/api/media/tags/${id}`, { method: 'DELETE' })
}

// ────────────────── 本地扫描 ──────────────────

export async function scanDirectory(path: string, max = 5000): Promise<ScannedFile[]> {
  const r = await request<{ items: ScannedFile[] }>('/api/media/scan', {
    method: 'POST',
    body: JSON.stringify({ path, max }),
  })
  return r.items ?? []
}
