import * as React from 'react'
import { cn } from '../../lib/utils'

export interface ProgressProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value?: number
  /** 下载中脉冲动画 */
  animated?: boolean
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, animated = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'relative h-1.5 w-full overflow-hidden rounded-full bg-surface-2',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-all duration-300 ease-out',
          animated && 'animate-pulse-slow',
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  ),
)
Progress.displayName = 'Progress'
