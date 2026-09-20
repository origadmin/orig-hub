/**
 * 媒体资料库 API（orig-tg 9877 `/api/media/*`）。
 *
 * 与 TG 流水（`/api/tg/*`）分离：这里是**用户可管理的资料库**——
 * 内容（item）、剧集（series/episode）、标签（tag）。
 */

import { TG_BASE } from './tg'

/** 媒体资料库与 TG 服务同进程同端口（orig-tg 9877） */
const MEDIA_BASE = TG_BASE

/** 媒体类型 */
export type MediaKind = 'video' | 'photo' | 'audio' | 'file'

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
  /** 介绍：与剧集 `description` 同源同切法（caption 首行之外的部分） */
  description?: string | null
  kind: MediaKind
  filePath?: string | null
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
}

/** 剧集列表项 */
export interface MediaSeries {
  id: number
  title: string
  description?: string | null
  /** series（剧集）/ collection（合集）/ album（图集） */
  kind: 'series' | 'collection' | 'album' | string
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
  /**
   * 这一集当前有没有字节（BUG-080；后端 `file_path IS NOT NULL`）。
   * 清缓存只删字节留条目，没有它前端无从分辨「点开能播」与「点了 404」。
   */
  hasBytes?: boolean | null
}

/** 剧集分集的备用来源引用 */
export interface EpisodeSourceRef {
  itemId: number
  title?: string | null
  kind?: MediaKind | null
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
  sort?: 'recent' | 'oldest' | 'title' | 'duration' | 'size'
  limit?: number
  offset?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MEDIA_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
  return `${MEDIA_BASE}/api/media/items/${id}/raw`
}

// ────────────────── 内容 ──────────────────

export async function listMediaItems(q: MediaListQuery = {}): Promise<MediaListResult> {
  const sp = new URLSearchParams()
  if (q.kind) sp.set('kind', q.kind)
  if (q.q) sp.set('q', q.q)
  if (q.tagId !== undefined) sp.set('tagId', String(q.tagId))
  if (q.seriesId !== undefined) sp.set('seriesId', String(q.seriesId))
  if (q.unassigned) sp.set('unassigned', '1')
  if (q.sort) sp.set('sort', q.sort)
  sp.set('limit', String(q.limit ?? 60))
  sp.set('offset', String(q.offset ?? 0))
  return request<MediaListResult>(`/api/media/items?${sp}`)
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

/** 列出剧集。`tagId` 用于按标签筛剧集（TG 自动归档的 #标签 落在剧集上）。 */
export async function listSeries(tagId?: number | null): Promise<MediaSeries[]> {
  const qs = tagId == null ? '' : `?tagId=${tagId}`
  const r = await request<{ items: MediaSeries[] }>(`/api/media/series${qs}`)
  return r.items ?? []
}

export async function getSeries(id: number): Promise<MediaSeriesDetail> {
  return request<MediaSeriesDetail>(`/api/media/series/${id}`)
}

export async function createSeries(body: {
  title: string
  description?: string
  kind?: 'series' | 'collection' | 'album'
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
    kind?: string
    poster?: string
    year?: number
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

export async function addEpisode(
  seriesId: number,
  body: { itemId: number; season?: number; episodeNo?: number },
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
 * 改单集：标题 / 介绍 / **槽位**（季号与集号）。
 *
 * 集号允许任意值（2、3…不必从 1 连续）；若目标槽已被同剧另一条占用，后端会**对调**
 * 两条的槽位（不会 409）—— 所以「把第 3 集改成第 2 集」的结果是两条互换位置。
 */
export async function patchEpisode(
  id: number,
  patch: {
    title?: string
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
