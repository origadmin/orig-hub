/**
 * 「清空历史」的来源分流（BUG-312 / 决策 D21=A④）。
 *
 * 为什么需要这一层：下载列表在 M3 起会把 **orig-tg 的入库任务**（`cache_task`）
 * 与引擎下载任务合并展示。两者都能进入「终态」，但「清空」对它们的语义不同：
 *
 *   - 引擎任务：删掉它 = 删掉一条下载记录（字节与媒体库条目另有自己的入口），可清；
 *   - 入库任务：`cache_task` 同时是**「TG 全部下载索引」**，删了记录 = 索引丢失，
 *     它的管理入口只有一个 —— 设置 → Telegram → 缓存管理。
 *
 * 因此判据不能写在「谁调用 DELETE」那一行上（现状 `useStore.clearCompleted`
 * 就是逐条 DELETE、不看来源），而必须由**来源能力位**决定：插件注册时声明
 * `clearable`，引擎恒 true、TG 恒 false（M7 起由 manifest 声明）。
 * 本模块是该判据的唯一真源，任何「批量清理下载历史」的入口都必须先过它，
 * 否则同一条规则会在第二个入口处走样（BUG-392 的教训）。
 *
 * 保守默认：**缺能力位时按来源判断**，来源也缺失才当可清 —— 现状只有引擎任务
 * 会进这张列表，缺省为 true 不改变现网行为；一旦某行标了 `tg`/`ingest`，
 * 它就绝不能被「清空历史」碰到。
 */

/** 判据所需的最小字段集合（`DownloadStatus` 的超集，便于未来契约直接透传）。 */
export interface ClearHistoryRow {
  id: string
  /** 来源能力位：`false` = 该行不可被「清空历史」删除（插件 manifest 声明）。 */
  clearable?: boolean
  /** 来源标识：`download`（引擎） / `tg`（orig-tg 入库任务）。 */
  source?: string
}

/** 入库任务的来源标识（大小写不敏感比较）。 */
const INGEST_SOURCES = new Set(['tg', 'telegram', 'ingest', 'cache'])

/** 该行能否被「清空历史」删除。 */
export function isClearableByClearHistory(row: ClearHistoryRow): boolean {
  // 能力位优先：插件显式声明「不可清」时，来源写法再怎么变都不删。
  if (row.clearable === false) return false
  const src = (row.source ?? '').trim().toLowerCase()
  if (src && INGEST_SOURCES.has(src)) return false
  return true
}

/**
 * 把候选行拆成「可清」与「须保留」两堆。
 *
 * 调用方（`clearCompleted`）只对 `clearable` 发 DELETE，`kept` 用于给出
 * 「TG 入库记录在 设置→Telegram→缓存管理 中管理」的提示 —— 静默保留等于
 * 让用户以为按钮坏了。
 */
export function splitClearHistoryRows<T extends ClearHistoryRow>(
  rows: T[],
): { clearable: T[]; kept: T[] } {
  const clearable: T[] = []
  const kept: T[] = []
  for (const row of rows) {
    if (isClearableByClearHistory(row)) clearable.push(row)
    else kept.push(row)
  }
  return { clearable, kept }
}
