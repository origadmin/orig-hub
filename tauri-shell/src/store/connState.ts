import { useStore } from './useStore'
import { selectConnected, selectDaemonAlive } from './selectors'

/**
 * 连接态**唯一规范来源**（BUG-087）。
 *
 * 曾经三处各写各的：上下文栏读 store，底部状态栏与侧栏底部直接硬编码
 * 「daemon 已连接 / daemon 运行中 + 恒绿点」—— 于是同屏出现「上下文栏说未连接、
 * 底部说已连接」的自相矛盾。**任何新增的连接态指示都必须走这里**，
 * 不得再自行判断 `connected` / `daemon.alive`，更不得写死文案。
 */

/** 连接态三态（设计待明确③ 取 B：降级态可见） */
export type ConnState = 'live' | 'degraded' | 'offline'

/** 三态灯配色：三处指示共用一份，避免「同态不同色」 */
export const CONN_DOT: Record<ConnState, string> = {
  live: 'bg-success',
  degraded: 'bg-warning',
  offline: 'bg-muted',
}

/** 三态文案 i18n key：离线态复用上下文栏既有「daemon 未连接」措辞，不新造一套 */
export const CONN_LABEL: Record<ConnState, string> = {
  live: 'ctx.connected',
  degraded: 'ctx.degraded',
  offline: 'ctx.disconnected',
}

/**
 * 连接态判定（纯函数）：
 *   - daemon 都没起来 → offline（灰）；
 *   - daemon 在但 SSE 断了 → degraded（黄，仍在跑 5s 兜底轮询）；
 *   - 实时链路通 → live（绿）。
 */
export function resolveConnState(
  connected: boolean,
  daemonAlive: boolean,
): ConnState {
  if (!daemonAlive) return 'offline'
  return connected ? 'live' : 'degraded'
}

/**
 * 订阅连接态（低频：仅在 `connected` / `daemon.alive` 翻转时重渲染）。
 * 组件只拿返回值去查 `CONN_DOT` / `CONN_LABEL`，保证文案与配色同源。
 */
export function useConnState(): ConnState {
  const connected = useStore(selectConnected)
  const daemonAlive = useStore(selectDaemonAlive)
  return resolveConnState(connected, daemonAlive)
}
