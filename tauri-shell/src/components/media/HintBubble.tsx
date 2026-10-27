import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

/**
 * BUG-461：常驻说明 → 「带圈 ?」按钮 + 点击后**短时**浮出的气泡。
 *
 * 根因：说明文案与控件同级常驻，看一次之后就是纯版面税。这里把说明搬进气泡：
 *   - 默认只占一个 15px 圆钮（不是一行文字）；
 *   - 点击浮出，5s 后自动消失，或点击别处即刻消失（不记忆「已展开」）；
 *   - 可键盘聚焦（原生 button）、再点一次可收起。
 *
 * 文案本身不丢：仍由调用方传入既有 i18n 文本（不新增语义键）。
 */
export function HintBubble(props: {
  /** 气泡正文（既有 i18n 文本原样传入，不改写、不截断） */
  text: string
  /** 屏幕阅读器标签；缺省直接读正文，避免再造一个 aria 键 */
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => setOpen(false), 5000)
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocDown)
    }
  }, [open])

  return (
    <span
      ref={wrapRef}
      className={cn('relative inline-flex shrink-0 items-center', props.className)}
    >
      <button
        type="button"
        aria-label={props.label ?? props.text}
        aria-expanded={open}
        data-testid="hint-bubble-toggle"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border text-[9px] leading-none transition-colors',
          open
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border-subtle text-muted hover:bg-surface-2 hover:text-fg-mid',
        )}
      >
        ?
      </button>
      {open ? (
        <span
          role="tooltip"
          data-testid="hint-bubble-text"
          className="absolute left-0 top-5 z-30 w-64 rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[10.5px] font-normal leading-relaxed text-muted shadow-lg"
        >
          {props.text}
        </span>
      ) : null}
    </span>
  )
}
