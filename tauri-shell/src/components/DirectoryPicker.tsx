import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { getRecentDirs, addRecentDir, removeRecentDir } from '../lib/recentDirs'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** 是否展示历史下拉（设置页默认开，新建对话框也开） */
  showHistory?: boolean
  disabled?: boolean
}

/**
 * 目录选择输入框：
 * - 「浏览…」→ 系统原生目录选择对话框（tauri-plugin-dialog）
 * - 聚焦/点击 → 历史目录下拉（localStorage 持久化，可单条删除）
 */
export function DirectoryPicker({
  value,
  onChange,
  placeholder,
  showHistory = true,
  disabled,
}: Props) {
  const [recent, setRecent] = useState<string[]>([])
  const [openList, setOpenList] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setRecent(getRecentDirs())
  }, [])

  // 点击外部关闭下拉
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpenList(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const pick = async () => {
    try {
      const dir = await open({ directory: true, multiple: false })
      if (typeof dir === 'string' && dir) {
        onChange(dir)
        setRecent(addRecentDir(dir))
      }
    } catch {
      /* 非 Tauri 环境（浏览器预览）忽略 */
    }
  }

  const chooseHistory = (d: string) => {
    onChange(d)
    setRecent(addRecentDir(d))
    setOpenList(false)
  }

  const removeOne = (e: React.MouseEvent, d: string) => {
    e.stopPropagation()
    setRecent(removeRecentDir(d))
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex gap-1.5">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setOpenList(true)}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={pick}
          disabled={disabled}
          className="shrink-0"
        >
          浏览…
        </Button>
      </div>

      {showHistory && openList && recent.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border-subtle bg-surface shadow-xl">
          <p className="px-3 pt-2 text-[10px] uppercase tracking-wide text-muted">
            最近使用
          </p>
          {recent.map((d) => (
            <div
              key={d}
              className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-surface-2"
              onClick={() => chooseHistory(d)}
              title={d}
            >
              <span className="truncate font-mono text-zinc-300">{d}</span>
              <button
                className="shrink-0 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                onClick={(e) => removeOne(e, d)}
                title="从历史移除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
