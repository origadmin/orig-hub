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
  title?: string | null
  itemTitle?: string | null
  poster?: string | null
  duration?: number | null
  kind?: MediaKind | null
  description?: string | null
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
  patch: { title?: string; poster?: string; duration?: number; width?: number; height?: number; kind?: MediaKind },
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

export async function listSeries(): Promise<MediaSeries[]> {
  const r = await request<{ items: MediaSeries[] }>('/api/media/series')
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
  patch: { title?: string; description?: string; kind?: string; poster?: string; year?: number },
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
  body: { itemId: number; season?: number; episodeNo?: number; title?: string },
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

export async function patchEpisode(
  id: number,
  patch: { title?: string; description?: string },
): Promise<{ ok: boolean }> {
  return request(`/api/media/episodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
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
