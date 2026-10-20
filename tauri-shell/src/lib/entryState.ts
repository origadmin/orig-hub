/**
 * 条目呈现状态**单源派生**（byte-ownership P4 / BUG-170）。
 *
 * ## 根因（BUG-170「缓存→不见了→完成→出现了」）
 *
 * 修复前条目徽标由三个源各按各的节奏拼接：
 *   1. 缓存任务轮询（`/api/tg/cache/tasks`，驱动「缓存中」）；
 *   2. 已缓存快照（`/api/tg/downloaded/:chat`，驱动「已缓存 ▶」）；
 *   3. feed 消息行自带的 DB `downloaded` 标志。
 * 任务终态到快照刷新之间存在**时间差**：轮询先说「任务结束了」，快照还没回来，
 * 三个源此刻一致地「都不认识这条」——用户看到空洞（既不在缓存中也不在已完成）。
 * P1 已把登记前移（条目 T0 起就在库），本模块修剩下的一半：**呈现状态永远由一个
 * 纯函数从单一事实派生，过渡窗内持有旧态，禁止跨源推 intermediate 态**。
 *
 * ## 派生规则（决策表，勿在各消费点重写）
 *
 * 1. tg 图片（BUG-049 代理语义）：raw 端点现场代理 TG 缩略图字节 → **即时点亮**，
 *    永远 `cached`，没有「缺字节」态；
 * 2. 字节真值 `present` → `cached`（磁盘事实是唯一「能播」判据，BUG-132）；
 * 3. 任务活跃（queued/running，且覆盖该条目）→ `queued` / `caching`（新事实压过
 *    一切旧态；queued 是排队——本轮跑不到它，呈现上与正在下载分开，BUG-181）；
 * 4. 字节真值 `missing` → 任务失败 = `failed`（条目在 + 流水线 failed），否则
 *    `bytesMissing`（禁播 + 可重试缓存，复用 bytesPresence 三态）；
 * 5. 事实静默（真值源没说这条）+ `factPending`（任务刚终态、快照未回）→ **持有旧态
 *    `prev`**——这正是过渡规则的落点：终态事件本身**不是**字节事实，等快照源开口；
 * 6. 其余静默：任务失败态 → `failed`；DB 承诺 `downloadedFlag` → `cached`（旧口径
 *    兜底，后端会在探测缺失时复位该标志）；否则 `registered`（条目在库、无字节）。
 *
 * `prev`（上一渲染的派生态）由消费方回传，本函数保持**纯**：不存状态、不碰 IO。
 */

/** 条目呈现状态（展示层唯一状态词汇表）。 */
export type EntryState =
  /** 登记在库、字节未就绪（T0；与「缺字节」同渲染：⬇/可重试） */
  | 'registered'
  /** 在单飞队列中排队（BUG-181：入队即有反馈，此前排队任务对条目零呈现） */
  | 'queued'
  /** 缓存任务进行中（转圈） */
  | 'caching'
  /** 字节在盘，可播（▶） */
  | 'cached'
  /** 字节真值缺失（曾登记/曾缓存但盘上没有；禁播 + 「重试缓存」） */
  | 'bytesMissing'
  /** 覆盖该条目的任务失败/中断（条目保留 + 流水线 failed） */
  | 'failed'

/** 后端 `bytesPresence` 三态（BUG-132）。 */
export type BytesPresence = 'present' | 'missing' | 'unknown'

/** 缓存任务状态（任务机词汇，与 `TgCacheTask.status` 一致）。 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface EntryStateInput {
  /** 字节真值；`undefined` = 真值源没有这条目的事实（静默，不构成新事实） */
  bytesPresence?: BytesPresence | null
  /** 覆盖该条目的缓存任务状态；`undefined` = 没有任务覆盖它 */
  taskStatus?: TaskStatus | null
  /** DB `downloaded` 承诺标志（不是字节真值；仅作静默时的旧口径兜底） */
  downloadedFlag?: boolean | null
  /**
   * 媒体类型（保留在输入契约里：消费点按条目字段整体传参，删字段会牵动全部调用点）。
   * BUG-352 起**不再参与判定** —— 图片与视频同一把尺子（字节真值）。
   */
  kind?: string | null
  /** 来源（同上，保留契约、不参与判定） */
  source?: string | null
  /** 上一渲染的派生态：`factPending` 过渡窗内持有 */
  prev?: EntryState | null
  /**
   * 过渡窗标记：任务刚从活跃转终态、字节快照尚未回来。此时**禁止**让终态事件
   * （跨源）把状态推进到任何 intermediate 值——持有 `prev` 直到快照源开口。
   */
  factPending?: boolean | null
}

/** 任务是否活跃（进行中的缓存动作）。 */
export function isActiveTask(s?: TaskStatus | null): boolean {
  return s === 'queued' || s === 'running'
}

/** 任务是否失败终态（failed / interrupted；cancelled 属用户主动，归缺字节档）。 */
function isFailedTask(s?: TaskStatus | null): boolean {
  return s === 'failed' || s === 'interrupted'
}

/**
 * 派生条目呈现状态——**唯一**入口，消费点（TgPanel 气泡/相册、CacheManagerDialog
 * 任务行）一律改走这里，禁止再写 `Boolean(downloaded || path)` 一类的本地拼接。
 */
export function deriveEntryState(input: EntryStateInput): EntryState {
  const { bytesPresence, taskStatus, downloadedFlag, prev, factPending } = input
  // 1) 磁盘字节真值：唯一「能播」判据（BUG-132）。
  //    BUG-352：此处的「tg 图片恒 cached」旧规则已删除 —— 图片与视频同样落盘
  //    （BUG-049 的「图片不缓存」已废），把图片无条件点亮会让「从未下载」的图片
  //    永远显示已缓存、永远进不了缺字节集合、永远不会被勾选入库。
  if (bytesPresence === 'present') return 'cached'
  // 3) 任务活跃：新事实压过一切旧态（重跑已缓存条目时不倒退）。
  //    queued 与 running 分开呈现（BUG-181）：排队条目显示「排队中」，
  //    不与正在下载的「缓存中」混为一谈——但同属活跃，同样压过旧态。
  if (taskStatus === 'queued') return 'queued'
  if (isActiveTask(taskStatus)) return 'caching'
  // 4) 真值明确缺失：失败 = 条目在 + 流水线 failed；其余 = 缺字节可重试。
  if (bytesPresence === 'missing') {
    return isFailedTask(taskStatus) ? 'failed' : 'bytesMissing'
  }
  // 5) 事实静默 + 过渡窗：持有旧态（BUG-170 的核心规则——终态事件不是字节事实）。
  if (factPending && prev) return prev
  // 6) 静默、无过渡窗：任务失败如实呈现；否则按 DB 承诺兜底（后端会在字节
  //    真值缺失时复位该标志，所以它不算「假有」）；无任何信号 = 仅登记。
  if (isFailedTask(taskStatus)) return 'failed'
  if (downloadedFlag) return 'cached'
  return 'registered'
}
