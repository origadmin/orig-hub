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
import { clearCacheItem, enqueueCacheTask, tgHealth } from '../api/tg'
import { ensureDaemon, ensureTg } from '../api/tauri'
import { getLibraryStats } from '../api/media'
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
  async health() {
    try {
      await tgHealth()
      return true
    } catch {
      return false
    }
  },
  async ensureAvailable() {
    await ensureTg()
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
    await getLibraryStats()
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

/** 批量探测可重缓存来源的存活态，形如 `{ tg: true }` */
export async function probeRecacheBackends(): Promise<Record<string, boolean>> {
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

// 泛型展示工具：实现源自 `lib/tgmedia`，但媒体库只当通用工具用（不引入 TG 语义）。
// 集中在这里 re-export，媒体库组件统一从本文件取，避免再 import `lib/tgmedia`。
export { coverFit, fmtDuration, fmtSize, hasMediaBytes, isRawFileName }
