import { cn } from '../../lib/utils'

interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  disabled?: boolean
  className?: string
  /** 是否显示填充轨道（用于百分比权重分配场景） */
  showRange?: boolean
}

/**
 * 自绘滑块（原生 input[type=range] + CSS 美化，无第三方依赖）。
 * 相比裸数字输入框：直观、可拖拽、无原生 spinner。
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled,
  className,
  showRange = true,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        'slider-input h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
        showRange &&
          '[&::-webkit-slider-runnable-track]:bg-gradient-to-r [&::-webkit-slider-runnable-track]:from-accent [&::-webkit-slider-runnable-track]:to-accent-2',
        className,
      )}
      style={
        showRange
          ? {
              background: `linear-gradient(to right, #10b981 0%, #06b6d4 ${pct}%, #27272a ${pct}%, #27272a 100%)`,
            }
          : undefined
      }
    />
  )
}
