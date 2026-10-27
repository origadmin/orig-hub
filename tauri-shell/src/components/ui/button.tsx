import * as React from 'react'
import { cn } from '../../lib/utils'

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline'
/**
 * BUG-344：`xs` / `icon-sm` 是一等尺寸 token（h-7 = 28px 刻度）。
 * 为什么必须有这两个而不是让调用方传 `className="h-7 …"`：`cn` 是裸 join
 * （无 tailwind-merge），调用方的 h-7 与 sizeClasses 里的 h-8 同在 class 列表，
 * 胜负由**样式表源序**决定（h-8 在 h-7 之后 ⇒ h-8 赢）⇒ 声明 28px 实际渲染
 * 32px，且无声无息。尺寸冲突不许用 override 表达，只能有这一个出处。
 *
 * BUG-363（2026-10-28）：`xs` 原为 `text-[11px]`，低于项目自订可读性阈值
 * 「面板内不得有 <12px 可读文字」（BUG-327 已进门禁）。字号同样属于 token 责任：
 * 逐个调用点补 `text-[12px]` 能生效（`cn` 同组后者赢），但**新写的调用点会静默
 * 继承 11px**，阈值就只能靠人记 —— 故在 token 处上调到 12px。
 * 只允许上调，不允许再下调（下调即违反门禁）。
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
  xs: 'h-7 px-2 text-[12px]',
  'icon-sm': 'h-7 w-7 p-0',
}

/**
 * BUG-269：**语义 → variant 的唯一映射表**。
 *
 * 为什么必须集中在这一处：原先全仓没有「什么语义用哪个 variant」的规则，于是
 * 「次要动作」在两处各写一遍、都写成不同的东西（`MediaLibraryPanel` 一处 `ghost`、
 * 另一处 `outline`），两个都「说得通」，差别只在写的人当时想什么 ⇒ 分叉是必然结果，
 * 不是个别疏忽。调用点现在只声明**语义**，不再自己挑外观：
 *
 * | 语义 `ButtonTone` | variant | 判据 |
 * |---|---|---|
 * | `primary`（保存 / 播放全部 / 确认） | `default` | 实心强调色，一屏最多一个 |
 * | `secondary`（取消 / 返回 / 导出预览 / 取消选择） | `outline` | 有边框、无背景 |
 * | `toolbar`（工具栏 / 行内图标：关闭 / 刷新 / 更多） | `ghost` | 无边框无背景，hover 才出底 |
 * | `danger`（删除 / 移除 / 清除） | `destructive` | 危险实心；行内图标态可 `ghost` + 危险色文字 |
 *
 * 豁免（显式列出，不是遗漏）：播放器控件层（`media/VideoPlayer.tsx` 的 8 颗白色图标
 * 按钮）处在深色视频背景上，语义与库页面不同，**不纳入**本表。
 *
 * 用法：`<Button variant={TONE_VARIANT.secondary}>`。新增按钮先在本表找语义，
 * 找不到语义说明这是新的一类动作 —— 先补表，再写按钮。
 */
export type ButtonTone = 'primary' | 'secondary' | 'toolbar' | 'danger'

export const TONE_VARIANT: Record<ButtonTone, ButtonVariant> = {
  primary: 'default',
  secondary: 'outline',
  toolbar: 'ghost',
  danger: 'destructive',
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
