import { memo } from 'react'
import { useStore } from '../store/useStore'
import {
  selectActiveCount,
  selectActiveSpeedLabel,
  selectConnected,
  selectDaemonAlive,
  selectHasActiveSpeed,
} from '../store/selectors'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'

/**
 * 上下文栏右槽（非下载视图）：连接态灯 + 聚合速度 + 进行中数量。
 *
 * 高频值**不走 props**：`SpeedChip` / `ActiveCount` 各自订阅标量切片，
 * 一次 SSE progress 最多重渲染一个文本节点，上下文栏与内容面板完全不动。
 */

/** 连接态三态（设计待明确③ 取 B：降级态可见） */
export type ConnState = 'live' | 'degraded' | 'offline'

const CONN_DOT: Record<ConnState, string> = {
  live: 'bg-success',
  degraded: 'bg-warning',
  offline: 'bg-muted',
}

const CONN_LABEL: Record<ConnState, string> = {
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

/** 聚合速度：无传输时不渲染（与原先 `busy && speed` 的表现一致） */
export const SpeedChip = memo(function SpeedChip() {
  const { t } = useTranslation()
  const visible = useStore(selectHasActiveSpeed)
  const label = useStore(selectActiveSpeedLabel)
  if (!visible) return null
  return (
    <span
      className="font-mono text-xs text-accent"
      title={t('ctx.speedHint')}
      data-testid="context-speed"
    >
      {label}
    </span>
  )
})

/** 进行中数量：为 0 时整块消失（不占一个「进行中 0」的位置） */
export const ActiveCount = memo(function ActiveCount() {
  const { t } = useTranslation()
  const count = useStore(selectActiveCount)
  if (count <= 0) return null
  return (
    <span
      className="font-mono text-[11px] text-fg-soft"
      title={t('ctx.activeHint')}
      data-testid="context-active"
    >
      {t('ctx.active', { n: count })}
    </span>
  )
})

export interface ContextBarStatusProps {
  /** 是否渲染「进行中 N」（默认 true） */
  showActiveCount?: boolean
}

export const ContextBarStatus = memo(function ContextBarStatus({
  showActiveCount = true,
}: ContextBarStatusProps) {
  const { t } = useTranslation()
  const connected = useStore(selectConnected)
  const daemonAlive = useStore(selectDaemonAlive)
  const state = resolveConnState(connected, daemonAlive)
  const label = t(CONN_LABEL[state])

  return (
    <span
      className="flex items-center gap-2"
      title={label}
      data-testid="context-conn"
      data-conn-state={state}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', CONN_DOT[state])} />
        <span className="text-[11px] text-muted">{label}</span>
      </span>
      <SpeedChip />
      {showActiveCount && <ActiveCount />}
    </span>
  )
})
