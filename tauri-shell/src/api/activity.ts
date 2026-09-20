/**
 * 传输中聚合视图 API（BUG-077 方案 (a)）。
 *
 * 端点 `GET /api/activity` 是 daemon 侧的**只读聚合**：把普通下载任务与 TG 缓存任务
 * 合并成统一 `TaskView`。三条铁律直接体现在这个契约里，改前端时不要绕过：
 *
 * 1. **只读**：本模块只有 GET，没有任何写端点。
 * 2. **控制分流**：写操作按 `control.side` 各回原路径 ——
 *    `daemon` 走 `/api/downloads/:id?action=...`，`tg` 走 `/api/cache/tasks/:id/retry`。
 * 3. **不给统一删除**：`actions` 里**没有**删除类动词，两侧都没有
 *    （同一列表里「删除」在缓存是删副本、在下载是删用户资产）。
 * 4. **不造假暂停/继续**：TG 侧 `actions` 至多是 `retry`，永不含 pause/resume。
 */
import { DAEMON_BASE } from './daemon'

/** 任务来源：普通下载 / TG 缓存（存储与引擎不统一，只统一呈现） */
export type ActivityTaskKind = 'download' | 'cache'

/** 计量单位：下载按字节、TG 缓存按条目数 —— 混读会失真 */
export type ActivityUnit = 'bytes' | 'items'

/** 控制动词：只列该侧真实具备的能力 */
export type ActivityAction = 'pause' | 'resume' | 'cancel' | 'retry'

/** 写操作归属侧 */
export type ActivityControlSide = 'daemon' | 'tg'

/** 写操作该往哪发（聚合视图自己不提供写端点） */
export interface ActivityControl {
  side: ActivityControlSide
  /** 该任务在本侧的原生 id（download = uuid；cache = 整型 id 的字符串形式） */
  native_id: string
}

/** 统一传输视图（只读聚合的最小公共面） */
export interface ActivityTaskView {
  /** `dl:<uuid>` / `tg:<i64>`，仅供视图定位；写操作请用 `control` */
  id: string
  kind: ActivityTaskKind
  /** 各侧原生名（文件名 / TG itemKey） */
  name: string
  unit: ActivityUnit
  total: number
  done: number
  /**
   * 瞬时速度 bytes/s。**缺键或 null = 该侧无速度采样**（不是 0）——
   * Rust 侧 `Option<f64>` 为 None 时字段被跳过，故也可能是 `undefined`。
   */
  speed?: number | null
  /** 进度百分比 0-100 */
  progress: number
  /** 各侧原生状态词（不做跨侧归一化） */
  status: string
  /** 该任务真实具备的控制动词；空数组 = 该状态下无可行动作 */
  actions: ActivityAction[]
  control: ActivityControl
  updated_at: number
  error?: string | null
}

/** 单个来源的健康状况：聚合是跨进程的，必须看得见「哪一侧没取到」 */
export interface ActivitySource {
  kind: ActivityTaskKind
  available: boolean
  /** 不可用原因（可直出给用户看） */
  error?: string | null
  count: number
}

export interface ActivitySnapshot {
  tasks: ActivityTaskView[]
  /** 恒含 download / cache 两条 */
  sources: ActivitySource[]
  generated_at: number
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${DAEMON_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
  }
  return res.json() as Promise<T>
}

/**
 * GET /api/activity — 传输中聚合视图。
 *
 * @param scope `active`（默认，在途）/ `all`（两侧已知全部）
 */
export function fetchActivity(
  scope: 'active' | 'all' = 'active',
): Promise<ActivitySnapshot> {
  return request<ActivitySnapshot>(
    `/api/activity?scope=${encodeURIComponent(scope)}`,
  )
}

/**
 * 快照签名（等值短路用，AGENTS.md §5 轮询三律）：
 * 只有**展示会变**的字段参与，未变则不 setState。
 */
export function activitySignature(snap: ActivitySnapshot | null): string {
  if (!snap) return ''
  const tasks = snap.tasks
    .map(
      (t) =>
        `${t.id}|${t.status}|${t.done}/${t.total}|${t.speed ?? '-'}|${t.progress.toFixed(1)}|${t.error ?? ''}`,
    )
    .join(';')
  const sources = snap.sources
    .map((s) => `${s.kind}:${s.available ? 1 : 0}:${s.error ?? ''}`)
    .join(';')
  return `${tasks}#${sources}`
}
