import * as React from 'react'
import { cn } from '../../lib/utils'

export interface ProgressProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value?: number
  /** 下载中脉冲动画 */
  animated?: boolean
  /** 宽度过渡时长 ms：轮询间隔大的场景（如 5s）设为接近轮询周期，进度观感近似匀速 */
  smoothMs?: number
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, animated = false, smoothMs = 300, ...props }, ref) => (
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
          'h-full rounded-full bg-accent transition-all ease-out',
          animated && 'animate-pulse-slow',
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, transitionDuration: `${smoothMs}ms` }}
      />
    </div>
  ),
)
Progress.displayName = 'Progress'
