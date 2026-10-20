import * as React from 'react'
import { cn } from '../../lib/utils'

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline'
/**
 * BUG-344：`xs` / `icon-sm` 是一等尺寸 token（h-7 = 28px 刻度）。
 * 为什么必须有这两个而不是让调用方传 `className="h-7 …"`：`cn` 是裸 join
 * （无 tailwind-merge），调用方的 h-7 与 sizeClasses 里的 h-8 同在 class 列表，
 * 胜负由**样式表源序**决定（h-8 在 h-7 之后 ⇒ h-8 赢）⇒ 声明 28px 实际渲染
 * 32px，且无声无息。尺寸冲突不许用 override 表达，只能有这一个出处。
 */
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'xs' | 'icon-sm'

const variantClasses: Record<ButtonVariant, string> = {
  default:
    'bg-accent text-white hover:bg-accent/90 shadow-sm font-medium',
  secondary:
    'bg-surface-2 text-fg-strong hover:bg-surface-2/80 border border-border-subtle',
  ghost: 'text-fg-mid hover:bg-surface-2 hover:text-fg-strong',
  destructive: 'bg-danger text-white hover:bg-danger/90',
  outline:
    'border border-border-subtle bg-transparent text-fg-mid hover:bg-surface-2',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'h-9 px-4 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-11 px-6 text-base',
  icon: 'h-9 w-9',
  xs: 'h-7 px-2 text-[11px]',
  'icon-sm': 'h-7 w-7 p-0',
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
