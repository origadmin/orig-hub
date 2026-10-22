/**
 * 选择条 + 行选择框：**全仓唯一标准形态**（BUG-393）。
 *
 * 为什么抽这一个组件：此前「选中之后的那条栏」每个域各写一份 ——
 * 剧集墙是底部居中的胶囊条（`items-selection-bar`，`rounded-full` +
 * `bg-surface/95 backdrop-blur`），下载域是顶部的方块条（`dl-batch-bar`，
 * `rounded-lg bg-accent/5`），文案与按钮尺寸也各不相同（`text-[11px]` vs
 * `text-sm`、`h-7 px-2` vs `size="sm"`）。用户 2026-10-23 裁定：
 * 「全部下载的选择又出现了样式不一致情况，应该和剧集一样，样式就应该统一」。
 *
 * 标准形态（与剧集墙逐项对齐，见 `docs/standards/style.md` §选择条）：
 *   - 位置：可视区**底部居中**浮层（`absolute bottom-4 left-1/2 -translate-x-1/2`）；
 *   - 容器：`rounded-full border border-accent/40 bg-surface/95 shadow-lg backdrop-blur-md`；
 *   - 计数：`text-[11px] font-medium text-fg-strong`；
 *   - 按钮：`size="sm"`，`h-7 px-2 text-[11px]`（次要动作 `variant="ghost"`）。
 *
 * 只做容器与计数，**批量动作由调用方以 children 传入**（各域动作不同，
 * 塞进组件里就会长出「一批用不上的按钮」）。
 */
import type { ReactNode } from 'react'
import { Button } from './button'

export function SelectionBar({
  count,
  testId,
  countTestId,
  children,
}: {
  /** 已选数量。0 时不渲染（「没选东西却挂着一条栏」= 噪音）。 */
  count: number
  /** 容器 testid（各域沿用既有契约，避免打断验收脚本） */
  testId: string
  countTestId: string
  children?: ReactNode
}) {
  if (count <= 0) return null
  return (
    <div
      data-testid={testId}
      /* `fixed` 而非 `absolute`：两域的包含块不同（剧集墙的条挂在带内边距的面板
         里，实测落点比下载域右偏 96px、上移 32px）—— 用 absolute 写同一串类名
         也得不到同一个落点（BUG-393 S1b 实测）。视口相对才谈得上「同一形态」。 */
      className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-accent/40 bg-surface/95 px-3 py-2 shadow-lg backdrop-blur-md"
    >
      <span data-testid={countTestId} className="text-[11px] font-medium text-fg-strong">
        {count}
      </span>
      {children}
    </div>
  )
}

/**
 * 全选 / 全不选：**成对出现**（只有「全选」没有「全不选」= 用户勾错一条后
 * 只能逐条取消，BUG-155 后的既有纪律）。
 */
export function SelectAllButtons({
  onSelectAll,
  onSelectNone,
  allLabel,
  noneLabel,
  allTestId,
  noneTestId,
}: {
  onSelectAll: () => void
  onSelectNone: () => void
  allLabel: string
  noneLabel: string
  allTestId: string
  noneTestId: string
}) {
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-[11px]"
        data-testid={allTestId}
        onClick={onSelectAll}
      >
        {allLabel}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        data-testid={noneTestId}
        onClick={onSelectNone}
      >
        {noneLabel}
      </Button>
    </>
  )
}

/** 行级选择框：全仓只有这一个尺寸与配色（BUG-393）。 */
export function RowCheckbox({
  checked,
  onChange,
  testId,
  ariaLabel,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  testId: string
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      className="h-4 w-4 cursor-pointer accent-accent"
      data-testid={testId}
      aria-label={ariaLabel}
    />
  )
}
