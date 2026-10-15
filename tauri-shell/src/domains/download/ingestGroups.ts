import type { TgCacheTask } from '../../types'

/**
 * TG 入库任务的**聚合层**（BUG-300 / M3 修正）。
 *
 * 为什么要有这一层：`cache_task` 是**一次入库操作**的记录，不是内容对象。
 * 同一批内容被重复点入库，库里就会留下多条 `itemKey` 相同的行 —— 实测
 * 137 条任务只有 104 个键，最多的键重复 7 次。按原始任务行平铺，用户会把
 * 「同一内容的 7 次入库」读成 7 个不同任务；而另一端把每条消息单列，又退化成
 * 「把种子里的每个文件都当顶层行」。
 *
 * BT 类比（本缺陷的判据来源）：种子是一个顶层行，里面的文件是明细；
 * 重复下载同一内容合并为一个种子。故这里把**同键的批次合并为一个入库对象**：
 * `latest` 代表当前状态，其余进 `history` 折叠展示；条目级明细（文件清单）
 * 由展开时按任务 id 拉取（BUG-296 组清单）。
 *
 * 纯函数、无 React 依赖 —— 排序与合组都能被单测直接驱动。
 */

/** `cache_task` 原生状态词。 */
export type CacheStatus = TgCacheTask['status']

/** 一个入库对象（= BT 里的一个种子）。 */
export interface IngestGroup {
  /** 聚合键（`cache_task.itemKey`）；空键回退任务 id，保证唯一。 */
  key: string
  /** 代表任务 = 同键里**最新**的一条（先比 `updatedAt`，再比 id）。 */
  latest: TgCacheTask
  /** 同键的其余历史批次（新→旧）。 */
  history: TgCacheTask[]
  /** 该对象被入队的次数（= 1 + history.length）。 */
  runs: number
}

/** 排队/在传：需要看到进度。 */
export function isCacheActive(status: string): boolean {
  return status === 'queued' || status === 'running'
}

/**
 * 待处理：失败 / 中断。
 *
 * 它们不是「已结束」而是**停滞的在途**（TG 无真续传，只能整任务重跑），
 * 不摊在概览里用户就不知道有活卡住了。
 */
export function isCacheStalled(status: string): boolean {
  return status === 'failed' || status === 'interrupted'
}

/** 已结束且无需处理。 */
export function isCacheSettled(status: string): boolean {
  return status === 'done' || status === 'cancelled'
}

/** 排行序：在传 → 停滞 → 已结束。 */
function rank(status: string): number {
  if (isCacheActive(status)) return 0
  if (isCacheStalled(status)) return 1
  return 2
}

/**
 * 按 `itemKey` 聚合成入库对象，并按「活跃 → 停滞 → 新→旧」排序。
 *
 * 排序键与服务端 `merge()` 的口径一致（在途优先、时间倒序、键定序），
 * 避免前端再排一套导致行序在两次请求间抖动。
 */
export function groupIngestTasks(tasks: TgCacheTask[]): IngestGroup[] {
  const buckets = new Map<string, TgCacheTask[]>()
  for (const t of tasks) {
    const key = t.itemKey?.trim() || `tg:${t.id}`
    const list = buckets.get(key)
    if (list) list.push(t)
    else buckets.set(key, [t])
  }

  const groups: IngestGroup[] = []
  for (const [key, list] of buckets) {
    const sorted = [...list].sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return b.id - a.id
    })
    const [latest, ...history] = sorted
    groups.push({ key, latest, history, runs: sorted.length })
  }

  groups.sort((a, b) => {
    const byRank = rank(a.latest.status) - rank(b.latest.status)
    if (byRank !== 0) return byRank
    if (b.latest.updatedAt !== a.latest.updatedAt) {
      return b.latest.updatedAt - a.latest.updatedAt
    }
    return a.key.localeCompare(b.key)
  })

  return groups
}

/**
 * itemKey（`g:{chat}:{group}` / `m:{chat}:{msg}` / `b:{chat}:{first}`）→ 人话。
 *
 * 它是**存储层的定位键**，不是给用户看的；服务端标题缺失时前端才需要它兜底，
 * 这里只做展示层翻译，真源不变。
 */
export function describeItemKey(key: string): string {
  const m = /^([gmb]):(-?\d+):(.+)$/.exec(key)
  if (!m) return key
  const [, prefix, chat, tail] = m
  const kind = prefix === 'g' ? '相册组' : prefix === 'b' ? '批量组' : '消息'
  return `${kind} ${tail} · 频道 ${chat}`
}

/** 入库对象标题：优先入库内容标题，缺失才把定位键翻成人话。 */
export function ingestDisplayName(task: TgCacheTask): string {
  const title = (task.title ?? '').trim()
  if (title) return title
  return describeItemKey(task.itemKey ?? '') || '未知内容'
}

/** 概览口径（「笼统的数据」）：一批内容算**一个对象**，不是 N 条记录。 */
export interface IngestOverview {
  /** 全部入库对象数 */
  total: number
  /** 在传（queued | running） */
  active: number
  /** 待处理（failed | interrupted） */
  stalled: number
  /** 已完成 */
  done: number
  /** 已取消 */
  cancelled: number
}

export function summarizeGroups(groups: IngestGroup[]): IngestOverview {
  const o: IngestOverview = {
    total: groups.length,
    active: 0,
    stalled: 0,
    done: 0,
    cancelled: 0,
  }
  for (const g of groups) {
    const s = g.latest.status
    if (isCacheActive(s)) o.active += 1
    else if (isCacheStalled(s)) o.stalled += 1
    else if (s === 'done') o.done += 1
    else o.cancelled += 1
  }
  return o
}

/**
 * 该入库对象**真实具备**的动作（与缓存管理面板 `RETRYABLE`/`ACTIVE_STATUS` 同口径）。
 *
 * - 活跃（queued/running）→ 取消（orig-tg `DELETE /api/tg/cache/tasks/:id`）；
 * - 终态（failed/interrupted/cancelled）→ 重试（按 id 复位整行，无真续传）；
 * - **永不返回 pause/resume**（TG 无真续传，给了就是假按钮）。
 */
export function ingestActionsFor(status: string): IngestAction[] {
  if (isCacheActive(status)) return ['cancel']
  if (isCacheStalled(status) || status === 'cancelled') return ['retry']
  return []
}

/** 入库对象可执行动作（见 `ingestActionsFor`）。 */
export type IngestAction = 'retry' | 'cancel'

/** 树档过滤：入库对象归入哪个状态档（`paused` 无对应 ⇒ 恒不显示）。 */
export function groupInBucket(
  status: string,
  f: 'all' | 'running' | 'paused' | 'done',
): boolean {
  switch (f) {
    case 'running':
      return isCacheActive(status)
    case 'paused':
      return false
    case 'done':
      return status === 'done'
    case 'all':
    default:
      return true
  }
}
