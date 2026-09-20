import { memo } from 'react'
import { Button } from './ui/button'
import { SpeedChip } from './ContextBarStatus'
import { useStore } from '../store/useStore'
import {
  selectActiveCount,
  selectHasCompleted,
  selectHasPaused,
} from '../store/selectors'
import { useTranslation } from '../i18n'
// 仅类型导入（编译期擦除，不构成运行时循环依赖）：回调契约定义在 ContextBar.tsx
import type { OnAction } from './ContextBar'

/**
 * 上下文栏右槽（下载类视图）：聚合速度 + 新建 / 全部暂停 / 全部开始 /（已完成页）清空。
 *
 * 按钮文案、图标、尺寸、变体沿用原 header 内联按钮组（BUG-083 只搬位置，不改语义）。
 * disabled 依据**由本组件自己订阅**（`selectActiveCount` / `selectHasPaused` /
 * `selectHasCompleted`），父级不传高频值进来；回调全部是 `useEvent` 恒定引用。
 */

export interface ContextBarActionsProps {
  /** 仅 completed 视图显示「清空」 */
  showClear: boolean
  onNewDownload: OnAction
  onPauseAll: OnAction
  onResumeAll: OnAction
  onClearCompleted: OnAction
}

export const ContextBarActions = memo(function ContextBarActions({
  showClear,
  onNewDownload,
  onPauseAll,
  onResumeAll,
  onClearCompleted,
}: ContextBarActionsProps) {
  const { t } = useTranslation()
  const activeCount = useStore(selectActiveCount)
  const hasPaused = useStore(selectHasPaused)
  const hasCompleted = useStore(selectHasCompleted)
  const busy = activeCount > 0

  return (
    <>
      <SpeedChip />
      <Button size="sm" onClick={onNewDownload}>
        <svg
          className="mr-1 h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        {t('main.newDownload')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onPauseAll}
        disabled={!busy}
        title={t('main.pauseAllHint')}
      >
        <svg
          className="mr-1 h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 5v14M16 5v14" />
        </svg>
        {t('main.pauseAll')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onResumeAll}
        disabled={!hasPaused}
        title={t('main.resumeAllHint')}
      >
        <svg
          className="mr-1 h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86a1 1 0 00-1.5.86z"
          />
        </svg>
        {t('main.resumeAll')}
      </Button>
      {showClear && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onClearCompleted}
          disabled={!hasCompleted}
          title={t('main.clearHint')}
        >
          {t('main.clear')}
        </Button>
      )}
    </>
  )
})
