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
 * `MediaLibraryPanel` 等媒体库组件只允许 import 本文件，不得再碰 TG。
 */
import { enqueueCacheTask, tgHealth } from '../api/tg'
import { ensureTg } from '../api/tauri'
import { fmtSize, isRawFileName, parseTgRef } from './tgmedia'

export type SourceType = 'tg' | 'oss' | 's3' | 'netdisk' | 'local'

export interface SourceAdapter {
  type: SourceType
  /** 展示名（纯文本；i18n 化留待 S2） */
  label: string
  /** 是否支持「原路重新缓存」（只有来源本身就是下载地址的才支持） */
  canRecache: boolean
  /** 重新缓存：把 ref 交回来源后端重新拉取字节 */
  recache(ref: string): Promise<void>
  /** 后端健康探活 */
  health(): Promise<boolean>
  /** 确保来源后端可用（如 TG 需先登录） */
  ensureAvailable(): Promise<void>
}

/**
 * TG 适配器：当前唯一实装。OSS / S3 / 网盘 后续按同形状接入——
 * 各自实现 `SourceAdapter` 并注册到 ADAPTERS 即可，媒体库零改动。
 */
const tgAdapter: SourceAdapter = {
  type: 'tg',
  label: 'TG',
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
}

const ADAPTERS: Record<string, SourceAdapter> = { tg: tgAdapter }

export function getSourceAdapter(source: string): SourceAdapter | null {
  return ADAPTERS[source] ?? null
}

/** 该来源是否支持原路重新缓存（媒体库据此禁用「重新缓存」入口，而非静默失败） */
export function canRecacheFromSource(source: string): boolean {
  return getSourceAdapter(source)?.canRecache ?? false
}

/** 原路重新缓存；来源不支持时抛错（由调用方转成非致命提示） */
export async function recacheFromSource(ref: string, source: string): Promise<void> {
  const adapter = getSourceAdapter(source)
  if (!adapter || !adapter.canRecache) {
    throw new Error('这条内容的来源不支持原路重新缓存')
  }
  await adapter.recache(ref)
}

/** 后端（守护进程，与媒体 API 同进程）健康探活 —— 媒体库「服务是否活着」的统一入口 */
export async function probeIngestBackend(): Promise<boolean> {
  return tgAdapter.health()
}

/** 确保后端可用（TG 场景即确保已登录） */
export async function ensureIngestBackend(): Promise<void> {
  await tgAdapter.ensureAvailable()
}

/** 来源展示名；未知来源回退到来源字符串本身 */
export function sourceLabel(source: string): string {
  return getSourceAdapter(source)?.label ?? source
}

// 泛型展示工具：实现源自 `lib/tgmedia`，但媒体库只当通用工具用（不引入 TG 语义）。
// 集中在这里 re-export，媒体库组件统一从本文件取，避免再 import `lib/tgmedia`。
export { fmtSize, isRawFileName }
