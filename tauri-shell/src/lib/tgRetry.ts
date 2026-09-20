import { useState } from 'react'
import { useEvent } from '../hooks/useEvent'
import { ensureTg } from '../api/tauri'
import { useStore } from '../store/useStore'
import { logTgReason } from './tgReason'

/**
 * 「重试连接」——BUG-094 的最后一块。
 *
 * orig-tg 只在**启动时**连一次 Telegram，失败后不再重试：服务会永远停在
 * `unavailable`，登录按钮永远 disabled，用户除了重启应用没有任何出口。
 * 这正是「坏了修不回来」—— 哪怕他把代理修好了也回不来。
 *
 * 出口即 `ensure_tg`（`src-tauri/src/lib.rs:499`）：`alive but unavailable`
 * 分支会 kill + respawn，正是「重连」语义；已健康则直接返回 `already-running`，
 * 不会顶掉一个已 `Authorized` 的实例，所以重复点击是安全的。
 *
 * **降级必须可见**（BUG-090 的教训）：`ensureTg` 是 Tauri Rust 命令，
 * 纯浏览器开发模式（直接开 dev server、无桌面宿主）下不可用。
 * 这里**绝不** `.catch(() => {})` 静默吞掉 —— 那会让「点了没反应」变成谜案；
 * 必须返回一个可分类的结果，由调用方给出明确文案，原文只进日志。
 */

/** 重试结果：成功 / 环境不支持（非桌面壳） / 失败（Rust 侧报错） */
export type TgRetryOutcome = 'ok' | 'unsupported' | 'failed'

/** 结果对应的 i18n 键（'ok' 无需展示文案：状态会自己刷新） */
export type TgRetryNoteKey = 'tg.retryUnsupported' | 'tg.retryFailed' | null

/**
 * 是否运行在 Tauri 桌面壳里（`invoke` 可用）。
 *
 * 浏览器开发模式下 `window.__TAURI_INTERNALS__` 不存在，`invoke` 必然失败；
 * 与其等它抛错再猜原因，不如**先探测**——结果确定，且不用靠异常文案做判断
 * （异常文案是英文原文，同样不能喂给用户）。
 */
export function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  return Boolean(w.__TAURI_INTERNALS__)
}

/**
 * 重试连接 orig-tg，并在成功后刷新会话/可用性（一次，不是轮询）。
 *
 * @returns 可分类的结果；失败原因的**原文只进日志**
 */
export async function retryTgConnection(): Promise<TgRetryOutcome> {
  if (!isTauriShell()) {
    logTgReason('Tauri shell not detected: ensure_tg unavailable in browser dev mode', 'tg-retry')
    return 'unsupported'
  }
  try {
    await ensureTg()
  } catch (e) {
    // 原文只进日志：Rust 侧报文（如 "not-configured"）不进界面
    logTgReason(e instanceof Error ? e.message : String(e), 'tg-retry')
    return 'failed'
  }
  // 重建后拉一次最新状态：让用户立刻看到结果（启动/操作触发，非轮询）
  try {
    await useStore.getState().refreshTgSession()
  } catch (e) {
    logTgReason(e instanceof Error ? e.message : String(e), 'tg-retry-refresh')
  }
  return 'ok'
}

/**
 * 重试按钮的共享状态机：loading 态（防连点）+ 结果文案键。
 *
 * 抽成 hook 是为了让 TgPanel 与 AccountsPanel 共用**同一份**判定与文案，
 * 而不是各写一份（BUG-087：同语义多处各写各的，最后会齐刷刷错成同一个值）。
 */
export function useTgRetry(): {
  busy: boolean
  noteKey: TgRetryNoteKey
  retry: () => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [noteKey, setNoteKey] = useState<TgRetryNoteKey>(null)

  const retry = useEvent(async () => {
    if (busy) return
    setBusy(true)
    setNoteKey(null)
    try {
      const outcome = await retryTgConnection()
      setNoteKey(outcome === 'ok' ? null : outcome === 'unsupported' ? 'tg.retryUnsupported' : 'tg.retryFailed')
    } finally {
      setBusy(false)
    }
  })

  return { busy, noteKey, retry }
}
