import * as React from 'react'
import { cn } from '../../lib/utils'

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-border-subtle bg-surface px-3 py-1 text-sm text-zinc-100 placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 transition-colors',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'
