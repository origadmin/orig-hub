import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * 区块卡（BUG-313）：设置页「分区卡片」的**单一真源**。
 *
 * 背景：M0 前端模块重整前，区块卡样式在 TSX 里逐处手写，结果同一页面 13 处卡片
 * 出现 4 种间距（space-y-5/4/3/无）、1 处无内边距、圆角三档、字号混用——
 * 排版没有单一真源就没有一致性可言，且没有回归守卫能发现。
 *
 * 本组件只固定「设置/诊断类分区块」的外观契约：
 *   - 容器：rounded-xl border border-border-subtle bg-surface p-5
 *   - 子项节奏：space-y-5
 * 其余场景（弹窗 dialog、列表行、内嵌子面、输入框）**不适用**本组件：
 *   - 弹窗用自身规范（rounded-xl/lg + p-4，见各 *Dialog）；
 *   - 「大卡内的子面」用 bg-surface-2/40 + rounded-lg，与区块卡是两种层级，不得互换；
 *   - 数据表/网格/树列表不是「分区卡」，不得套用。
 *
 * 判据（CDP 回归）：同族区块卡 padding 必须一致；区块卡不得嵌套区块卡；
 * 每页签仅允许一个页级标题（本卡片提供的是区块级，不是页级）。
 */
export interface SectionCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 子项间距节奏；默认 space-y-5（设置页统一节奏） */
  gap?: 'none' | 'sm' | 'md'
}

const GAP_CLASS = {
  none: '',
  sm: 'space-y-3',
  md: 'space-y-5',
} as const

export const SectionCard = React.forwardRef<HTMLDivElement, SectionCardProps>(
  ({ className, gap = 'md', ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-border-subtle bg-surface p-5',
        GAP_CLASS[gap],
        className,
      )}
      {...props}
    />
  ),
)
SectionCard.displayName = 'SectionCard'

/**
 * 区块小标题（页签内的分区标题，**不是**页级标题）。
 * 页级标题（每页签唯一）仍是 `<h3 className="text-lg font-semibold text-fg-strong">`，
 * 由页签容器直接渲染；分区标题一律用本组件，避免再出现「一个页签两个 h3」（BUG-313）。
 */
export function SectionTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('text-[13px] font-medium text-fg-strong', className)}
      {...props}
    />
  )
}

/** 分区标题下的说明文字（单一字号：11px muted） */
export function SectionDesc({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('mt-0.5 text-[11px] text-muted', className)}
      {...props}
    />
  )
}

/** 分区之间的分隔线（与 h-px bg-border-subtle/60 逐字节等价） */
export function SectionDivider({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('h-px bg-border-subtle/60', className)} {...props} />
}
