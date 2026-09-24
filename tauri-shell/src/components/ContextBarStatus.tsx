import { memo } from 'react'
import { useStore } from '../store/useStore'
import {
  selectActiveCount,
  selectActiveSpeedLabel,
  selectHasActiveSpeed,
} from '../store/selectors'
import { useTranslation } from '../i18n'

/**
 * 上下文栏右槽（非下载视图）：聚合速度 + 进行中数量。
 *
 * 高频值**不走 props**：`SpeedChip` / `ActiveCount` 各自订阅标量切片，
 * 一次 SSE progress 最多重渲染一个文本节点，上下文栏与内容面板完全不动。
 *
 * 连接状态点**不在这里**（BUG-169 终裁）：唯一渲染点在 MainLayout 底栏右下角
 * （`statusbar-conn`）——底栏根部单次渲染、无按视图分叉的漏接风险；
 * 此处曾有的 `ConnLight` 已随三处收敛移除。
 */

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
  return (
    <span className="flex items-center gap-2">
      <SpeedChip />
      {showActiveCount && <ActiveCount />}
    </span>
  )
})
