/**
 * 受管下载根成品事实（BUG-299 M2-T00a）。
 *
 * 数据源是 orig-daemon 的 `GET/DELETE /api/files`（**不是** orig-tg 的媒体端点）——
 * 文件域父行（cat-all） = 已登记媒体（orig-tg `media_item`） ∪ 本端点枚举的受管成品。
 * 合并在 `MediaLibraryPanel` 做：媒体条目与文件事实按绝对路径去重，一侧都不许
 * 把另一侧「吃掉」。
 *
 * 为什么 downloads 成品不走 `media_item`：ingest 写入要跨进程写 orig-tg 的库
 * （BUG-299 任务表 M2-T01b，需 BUG-172 或等价决策）；**读通路没有这个依赖** ——
 * 受管根就在 daemon 配置里，FS 元数据当场可采。用户手动放入受管根的文件同样算
 * 成品（出口判据 8），这是读端点相对「完成即入库」的严格更强项。
 */

import { daemonBase } from './daemon'

/** 受管成品的一行事实（wire = daemon snake_case）。 */
export interface FileFact {
  /** 绝对路径（「打开目录 / 打开 / 删除」都以它为准）。 */
  path: string
  /** 文件名（展示名）。 */
  name: string
  /** 扩展名（小写无点；无扩展名为空串）。 */
  ext: string
  /** 自动分类名（Videos/Music/Images/Documents/Archives/Others；daemon classify 规则输出）。 */
  category: string
  /** 粗类型：video|photo|audio|doc|archive|other（行内图标/行为用）。 */
  kind: string
  /** 字节数（0 = 空文件，照常显示并带「缺字节」标记）。 */
  size: number
  /** mtime（unix 秒；0 = 取不到，前端不显示 1970）。 */
  modified_at: number
}

/** GET /api/files 响应。 */
export interface FilesResponse {
  /** 实际参与枚举的受管根（空 = 没有受管根，与「根下没有成品」是两件事）。 */
  roots: string[]
  files: FileFact[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemonBase()}${path}`, {
    headers: init?.body != null ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** GET /api/files — 受管下载根的成品事实（含用户手动放入的文件）。 */
export function listFiles(): Promise<FilesResponse> {
  return request<FilesResponse>('/api/files')
}

/**
 * DELETE /api/files?path=<abs> — 删除受管成品（文件本体）。
 *
 * daemon 侧守卫：路径必须规范化后落在某个受管根内（否则 403），必须是普通文件
 * （否则 404）。任务记录（内存态）由 daemon 同步清理。
 */
export function deleteFile(path: string): Promise<{ ok: boolean; path: string }> {
  return request(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
}
