import { cn } from '../../lib/utils'

interface StepperProps {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
}

/**
 * 数字步进器：− [数值] +，替代原生 number input 的 spinner（WebView 里样式难看）。
 * 支持键盘输入（失焦校验 + 上下方向键微调）。
 */
export function Stepper({
  value,
  onChange,
  min = 1,
  max = 64,
  step = 1,
  disabled,
  className,
}: StepperProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)))

  const stepTo = (dir: 1 | -1) => onChange(clamp(value + dir * step))

  return (
    <div
      className={cn(
        'inline-flex h-9 items-center overflow-hidden rounded-md border border-border-subtle bg-surface',
        disabled && 'opacity-50',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => stepTo(-1)}
        disabled={disabled || value <= min}
        className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="减少"
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/[^\d]/g, ''))
          if (!Number.isNaN(n)) onChange(clamp(n))
        }}
        onBlur={(e) => {
          const n = Number(e.target.value)
          if (Number.isNaN(n) || n < min) onChange(min)
          else if (n > max) onChange(max)
          else onChange(clamp(n))
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepTo(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepTo(-1)
          }
        }}
        className="h-full w-10 border-x border-border-subtle bg-transparent text-center text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50"
      />
      <button
        type="button"
        onClick={() => stepTo(1)}
        disabled={disabled || value >= max}
        className="flex h-full w-8 items-center justify-center text-muted transition-colors hover:bg-surface-2 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="增加"
      >
        +
      </button>
    </div>
  )
}
