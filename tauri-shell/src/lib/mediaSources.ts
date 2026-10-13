/**
 * 媒体库「来源抽象层」。
 *
 * 设计意图（用户 2026-09-23 拍板）：媒体库是管理「下载后内容」的中心，TG 只是诸多
 * 来源之一（监控/下载源）。库本身**完全不感知任何具体来源**——它只认识：
 *   1. 一个可扩展的「来源类型」字符串（`media_item.source`：tg / oss / s3 / netdisk / local）；
 *   2. 一个统一的 `SourceAdapter` 抽象接口。
 * 新增来源 = 在下方注册一个 adapter，媒体库代码零改动。这是 BUG-098「TG 概念不进资产域」
 * 的前端落地：TG 的全部知识封死在本文件内，外部只看到接口。
 *
 * 注意：本文件是**唯一** import TG 模块（`api/tg`、`api/tauri`、`lib/tgmedia`）的地方。
 * `MediaLibraryPanel` / `MediaCard` / `SeriesDetail` 等媒体库组件只允许 import 本文件，
 * 不得再碰 `lib/tgmedia`（即使只是通用格式化工具，也已在本文件 re-export，统一从这里取）。
 */
import { clearCacheItem, enqueueCacheTask, tgDiag } from '../api/tg'
import type { TgCacheTask } from '../types'
import { ensureDaemon } from '../api/tauri'
import { restartTgService } from '../api/daemon'
import { getLibraryStats } from '../api/media'
import { cacheKey, cached, invalidateCache } from './fetchCache'
import {
  coverFit,
  fmtDuration,
  fmtSize,
  hasMediaBytes,
  isRawFileName,
  parseTgRef,
} from './tgmedia'

export type SourceType = 'tg' | 'oss' | 's3' | 'netdisk' | 'local'

export interface SourceAdapter {
  type: SourceType
  /** 展示名 i18n 键（见 locales 的 `source.*`） */
  labelKey: string
  /** 是否支持「原路重新缓存」（只有来源本身就是下载地址的才支持） */
  canRecache: boolean
  /** 重新缓存：把 ref 交回来源后端重新拉取字节 */
  recache(ref: string): Promise<void>
  /** 后端健康探活 */
  health(): Promise<boolean>
  /** 确保来源后端可用（如 TG 需先登录） */
  ensureAvailable(): Promise<void>
  /** 解析来源内定位符（TG 为 chat:msg）；不支持返回 null */
  parseRef?(ref: string): { chatId: number; messageId: number } | null
}

/**
 * TG 适配器：当前唯一实装。OSS / S3 / 网盘 后续按同形状接入——
 * 各自实现 `SourceAdapter` 并注册到 ADAPTERS 即可，媒体库零改动。
 */
const tgAdapter: SourceAdapter = {
  type: 'tg',
  labelKey: 'source.tg',
  canRecache: true,
  async recache(ref: string) {
    const tg = parseTgRef(ref)
    if (!tg) throw new Error('这条内容的来源标识不是 chat:msg，无法重新缓存')
    await enqueueCacheTask({ chatId: tg.chatId, messageIds: [tg.messageId] })
  },
  /**
   * 探的是**可用性**，不是进程存活。
   *
   * `GET /health` 只要进程在就 200 —— 于是「orig-tg 在跑但 TG 没连上（未登录/离线调试/
   * 连接失败）」会被判成健康，媒体库据此给出「重新缓存」活按钮，用户点了才吃一个 503。
   * 判「能不能原路取回字节」必须问 `/api/tg/diag` 的 `available`：它才是 TG 客户端
   * 真实可用与否的真值（未登录 / MTProto 断连时 false，并带 `unavailable_reason`）。
   */
  async health() {
    try {
      // 走读缓存（BUG-239 根因 4）：存活态在一次会话内复用一份，`alive` 翻转 /
      // 切走再回都不重发 `/api/tg/diag`。**为什么能缓存而不失真**：这是一次
      // 「能不能原路取回字节」的**粗粒度**判断，缓存里的 `available` 至多让入口
      // 短暂偏保守（点了重缓存才吃 503）；而它偏乐观的代价由用户点「重连」兜底
      // ——`probeRecacheBackends(true)` 会强制失效本 key 拿实时结果。
      const d = await cached(cacheKey.tgDiag(), () => tgDiag())
      return Boolean(d.available)
    } catch {
      return false
    }
  },
  /**
   * 「确保来源可用」= **请 daemon 重启它托管的 orig-tg**（BUG-178）。
   *
   * 以前这里调桌面壳的 `ensureTg()` 自己 spawn 进程，与 daemon 形成两个主人。
   * 现在前端只发请求、daemon 执行。
   */
  async ensureAvailable() {
    await restartTgService()
  },
  parseRef(ref) {
    return parseTgRef(ref)
  },
}

const ADAPTERS: Record<string, SourceAdapter> = { tg: tgAdapter }

/**
 * 来源可能为 null/undefined（分集、条目在旧数据里可能没有来源）——统一按「本地」处理：
 * 本地来源没有可重新拉取的地址，行为与「不支持重缓存」一致，不抛错、不崩渲染。
 */
export function getSourceAdapter(source?: string | null): SourceAdapter | null {
  return source ? (ADAPTERS[source] ?? null) : null
}

/** 该来源是否支持原路重新缓存（媒体库据此禁用「重新缓存」入口，而非静默失败） */
export function canRecacheFromSource(source?: string | null): boolean {
  return getSourceAdapter(source)?.canRecache ?? false
}

/**
 * 集级「可缓存」判据（BUG-261）：这一集是否仍有**任一**可用来源。
 *
 * 优先信引擎下发的 `hasRecacheableSource`（主源 tg 有 ref，或任一备用源 tg ⇒ true；
 * 判据与字节态无关 —— 无字节的 TG 来源正是「要缓存」的对象）。字段缺失
 * （老后端 / 本地构造的假数据）时回退本地推导，**不再**绑死「当前主源」：
 * 主源 local、备用源 tg 的集同样可缓存（那正是 BUG-261 现象 3 的潜伏缺陷形态）。
 */
export function canRecacheEpisode(
  ep:
    | {
        hasRecacheableSource?: boolean
        source?: string | null
        ref?: string | null
        sources?: Array<{ source?: string | null; ref?: string | null }> | null
      }
    | null
    | undefined,
): boolean {
  if (!ep) return false
  if (typeof ep.hasRecacheableSource === 'boolean') return ep.hasRecacheableSource
  return episodeRecacheCandidates(ep).length > 0
}

/**
 * 收集一集**可缓存来源**候选（主源优先、备用源次之；只收「适配器支持重取且
 * ref 非空」的来源）。缓存下发用第一个候选：「有字节可切换、无字节可缓存」
 * 用的是同一个 ref 集合，不再要求用户先「切换来源」再重缓存（BUG-261）。
 */
export function episodeRecacheCandidates(
  ep:
    | {
        source?: string | null
        ref?: string | null
        sources?: Array<{ source?: string | null; ref?: string | null }> | null
      }
    | null
    | undefined,
): Array<{ source: string; ref: string }> {
  if (!ep) return []
  const out: Array<{ source: string; ref: string }> = []
  const push = (source?: string | null, ref?: string | null) => {
    if (source && ref && ref.trim() && canRecacheFromSource(source)) {
      out.push({ source, ref })
    }
  }
  push(ep.source, ep.ref)
  for (const s of ep.sources ?? []) push(s.source, s.ref)
  return out
}

/**
 * 集级缓存任务态判别（BUG-279）——与字节态（hasMediaBytes，lib/tgmedia.ts）分别
 * 判定后再合并：**任务态只答「它在队列 / 正在下 / 上次失败（原因）/ 被取消 /
 * 已完成但无字节」，不答「有没有字节」**。
 *
 * - `task === null` ⇒ `no-task`：这条视频从未入队 / 记录已删（与「失败 / 取消」严格区分）。
 * - `done` 但调用方已确认无字节 ⇒ `done-no-bytes`（异常，不掩盖）；
 *   `interrupted` 并入失败类提示并带原因。
 * 字节态真源始终是 `hasMediaBytes`；本函数只管「任务态」这一面。
 */
export type EpisodeCacheStatus =
  | { kind: 'no-task' }
  | { kind: 'queued'; task: TgCacheTask }
  | { kind: 'running'; task: TgCacheTask }
  | { kind: 'failed'; task: TgCacheTask }
  | { kind: 'cancelled'; task: TgCacheTask }
  | { kind: 'done-no-bytes'; task: TgCacheTask }
  | { kind: 'interrupted'; task: TgCacheTask }

export function episodeCacheStatus(task: TgCacheTask | null): EpisodeCacheStatus {
  if (!task) return { kind: 'no-task' }
  switch (task.status) {
    case 'queued':
      return { kind: 'queued', task }
    case 'running':
      return { kind: 'running', task }
    case 'failed':
      // BUG-220：状态判别**不再携带失败原因**。失败详情（条目级汇总是多 KB 原文）
      // 属于诊断信息，只进日志（引擎逐条 `item failed` 已记）与 cache_task.error，
      // 界面只呈现「缓存失败」——错误长文本不该污染正常列表。
      return { kind: 'failed', task }
    case 'interrupted':
      return { kind: 'interrupted', task }
    case 'cancelled':
      return { kind: 'cancelled', task }
    case 'done':
      return { kind: 'done-no-bytes', task }
    default:
      return { kind: 'no-task' }
  }
}

/** 原路重新缓存；来源不支持时抛错（由调用方转成非致命提示） */
export async function recacheFromSource(
  ref?: string | null,
  source?: string | null,
): Promise<void> {
  const adapter = getSourceAdapter(source)
  if (!adapter || !adapter.canRecache) {
    throw new Error('这条内容的来源不支持原路重新缓存')
  }
  if (!ref) throw new Error('这条内容没有来源定位符，无法重新缓存')
  await adapter.recache(ref)
}

/**
 * **资料库后端**探活 —— 媒体库「服务是否活着」的唯一判据。
 *
 * 这里刻意**不碰 TG**：媒体库管的是「入库之后的字节」，它的存活性只取决于
 * 资料库 API（`getLibraryStats`）。TG 挂掉 / 从未登录 / 未配置凭证，都不该让
 * 媒体库变成空面板——那是把「一个下载源不可用」误报成「整个库不可用」。
 */
export async function probeLibraryBackend(): Promise<boolean> {
  try {
    // 与 `loadMeta` 共用同一份 stats 缓存（BUG-239 根因 2）：探活与首屏徽标读的是
    // **同一份数据**，不该各发一次。失败不入缓存（`cached` 的错误路径），
    // 故「后端挂了 → 重试」仍会真发请求。
    await cached(cacheKey.libraryStats(), () => getLibraryStats())
    return true
  } catch {
    return false
  }
}

/** 确保资料库后端可用（Tauri 模式下拉起 daemon；非 Tauri 无托管手段，抛错由调用方降级） */
export async function ensureLibraryBackend(): Promise<void> {
  await ensureDaemon()
}

/**
 * **来源后端**探活（如 TG 服务）。只用于决定「重新缓存」入口是否可用，
 * **绝不**用于媒体库的存活性判断——来源只是入库通道，不是库本身。
 */
export async function probeSourceBackend(source?: string | null): Promise<boolean> {
  const adapter = getSourceAdapter(source)
  if (!adapter) return false
  try {
    return await adapter.health()
  } catch {
    return false
  }
}

/** 确保来源后端可用（TG 即确保已登录/已拉起） */
export async function ensureSourceBackend(source?: string | null): Promise<void> {
  const adapter = getSourceAdapter(source)
  if (!adapter) throw new Error('未知来源，无法连接')
  await adapter.ensureAvailable()
}

/** 所有支持「原路重新缓存」的来源：媒体库据此批量探活，决定重缓存入口的可用态 */
export function recacheCapableSources(): string[] {
  return Object.values(ADAPTERS)
    .filter((a) => a.canRecache)
    .map((a) => a.type)
}

/**
 * 批量探测可重缓存来源的存活态，形如 `{ tg: true }`。
 *
 * `force`（默认 false）：命中读缓存直接返回，不重发探活请求 —— 媒体库进入 /
 * `alive` 翻转复用同一份存活态，否则每次都要重发 `/api/tg/diag`（BUG-239 根因 4）。
 * 用户显式点「重连」时传 `true`：那次探活**必须**打到后端拿实时结果，
 * 否则缓存里的旧值会把「重连」顶回去，表现为点了没反应。
 */
export async function probeRecacheBackends(force = false): Promise<Record<string, boolean>> {
  if (force) invalidateCache(cacheKey.tgDiag())
  const out: Record<string, boolean> = {}
  await Promise.all(
    recacheCapableSources().map(async (s) => {
      out[s] = await probeSourceBackend(s)
    }),
  )
  return out
}

/**
 * 清除条目的磁盘字节（记录保留，可重新缓存）。
 * 走的是资料库 `/api/cache` 端点，与来源无关——「清缓存」是库的动作，不是 TG 的动作。
 */
export async function clearCachedBytes(itemId: number): Promise<{ ok: boolean; freed: number }> {
  return clearCacheItem(itemId)
}

/**
 * 来源展示名 i18n 键；未知来源回退到 `source.<source>`（由 i18n 兜底为原字符串本身）。
 * 同进程多来源可在此扩展：新增一行 `source.xxx` 文案即可，调用方只管 `t(sourceLabelKey(s))`。
 */
export function sourceLabelKey(source?: string | null): string {
  return getSourceAdapter(source)?.labelKey ?? `source.${source ?? 'local'}`
}

/** 解析来源内定位符；来源无适配器或不支持时返回 null（调用方据 `canRecacheFromSource` 判） */
export function parseSourceRef(
  ref: string,
  source: string,
): { chatId: number; messageId: number } | null {
  return getSourceAdapter(source)?.parseRef?.(ref) ?? null
}

/**
 * 「跳回源消息」深链（BUG-285）——把来源定位符还原成一条人类可点的地址。
 *
 * 入库坐标（`MediaEpisode.ref` / `EpisodeSourceRef.ref`，TG 即 `<chat>:<msg>`）
 * 一直存在，但前端零入口把它交给用户：无标内容（标题是占位名）就此永久沉积，
 * 用户既看不出它是什么，也没有任何通道回源头辨认。本函数把坐标翻成 t.me 深链。
 *
 * 只有**来源自身能解释该定位符**时才产出地址（`parseSourceRef` 判据）：
 * 本地来源没有 TG 消息可跳 ⇒ null，调用方据此**不渲染**入口。
 *
 * 注意：本文件是唯一 import `lib/tgmedia` 的地方，深链形状（t.me/c/...）作为
 * TG 知识封死在此；组件只见「来源 → 可点地址」这一层接口。
 */
export function sourceMessageUrl(source?: string | null, ref?: string | null): string | null {
  if (!source || !ref) return null
  const at = parseSourceRef(ref, source)
  if (!at) return null
  return `https://t.me/c/${at.chatId}/${at.messageId}`
}

// 泛型展示工具：实现源自 `lib/tgmedia`，但媒体库只当通用工具用（不引入 TG 语义）。
// 集中在这里 re-export，媒体库组件统一从本文件取，避免再 import `lib/tgmedia`。
export { coverFit, fmtDuration, fmtSize, hasMediaBytes, isRawFileName }
