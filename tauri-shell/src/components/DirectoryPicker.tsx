import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { getRecentDirs, addRecentDir, removeRecentDir } from '../lib/recentDirs'
import { isTauri } from '../lib/env'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** 是否展示历史下拉（设置页默认开，新建对话框也开） */
  showHistory?: boolean
  disabled?: boolean
  /** 选择失败时的回调（用于全局 toast 提示，避免“点击无反应”） */
  onError?: (msg: string) => void
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
  onError,
}: Props) {
  const [recent, setRecent] = useState<string[]>([])
  const [openList, setOpenList] = useState(false)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 网页调试模式（纯浏览器、无 Tauri 运行时）不支持系统原生目录对话框。
  const inTauri = isTauri()

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
    // 网页调试模式（纯浏览器、无 Tauri 运行时）没有系统原生对话框：
    // @tauri-apps/plugin-dialog 底层 invoke 为 undefined，直接调会抛
    // "Cannot read properties of undefined (reading 'invoke')"。
    // 软失败 + 提示，而不是让整个设置页炸成错误现场（BUG-072）。
    // 手动输入与历史下拉在网页模式下仍可用，不影响调试。
    if (!isTauri()) {
      const msg = '目录选择需在桌面客户端中使用（网页调试模式不支持系统原生对话框，可直接输入路径或选历史）'
      setLocalErr(msg)
      onError?.(msg)
      return
    }
    setLocalErr(null)
    try {
      const dir = await open({ directory: true, multiple: false })
      if (typeof dir === 'string' && dir) {
        onChange(dir)
        setRecent(addRecentDir(dir))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLocalErr(`选择目录失败：${msg}`)
      onError?.(`选择目录失败：${msg}`)
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
        />
        {showHistory && recent.length > 0 && (
          <button
            type="button"
            onClick={() => setOpenList((v) => !v)}
            disabled={disabled}
            title="历史目录"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface-2 text-muted transition-colors hover:bg-surface-2/80 hover:text-fg-strong disabled:opacity-50"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
        <Button
          type="button"
          variant="secondary"
          onClick={pick}
          disabled={disabled || !inTauri}
          title={inTauri ? undefined : '网页调试模式不支持系统原生目录对话框（可直接输入路径或选历史）'}
          className="shrink-0"
        >
          浏览…
        </Button>
      </div>

      {localErr && (
        <p className="mt-1 text-[11px] text-danger" title={localErr}>
          {localErr}
        </p>
      )}

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
              <span className="truncate font-mono text-fg-mid">{d}</span>
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
