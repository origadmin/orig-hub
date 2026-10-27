import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { DirectoryBrowserDialog } from './DirectoryBrowserDialog'
import { getRecentDirs, addRecentDir, removeRecentDir } from '../lib/recentDirs'
import { isTauri } from '../lib/env'
import { displayPath, storagePath } from '../lib/pathDisplay'
import { useTranslation } from '../i18n'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** 是否展示历史下拉（设置页默认开，新建对话框也开） */
  showHistory?: boolean
  disabled?: boolean
  /** 应用内浏览器的起始目录（网页调试模式用；通常传「当前生效目录」） */
  initialPath?: string
  /** 选择失败时的回调（用于全局 toast 提示，避免“点击无反应”） */
  onError?: (msg: string) => void
}

/**
 * 目录选择输入框：
 * - 「浏览…」→ 桌面壳走**系统原生对话框**（tauri-plugin-dialog）；
 *   **网页调试模式**走**应用内目录浏览器**（daemon `GET /api/fs/dirs`，BUG-323 缺陷③）
 * - 聚焦/点击 → 历史目录下拉（localStorage 持久化，可单条删除）
 */
export function DirectoryPicker({
  value,
  onChange,
  placeholder,
  showHistory = true,
  disabled,
  initialPath,
  onError,
}: Props) {
  const { t } = useTranslation()
  const [recent, setRecent] = useState<string[]>([])
  const [openList, setOpenList] = useState(false)
  const [localErr, setLocalErr] = useState<string | null>(null)
  /** 应用内目录浏览器（网页调试模式） */
  const [browserOpen, setBrowserOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 网页调试模式（纯浏览器、无 Tauri 运行时）不支持系统原生目录对话框。
  // BUG-286：IPC 桥可能晚于首帧注入，若把这一判定冻结成首帧常量，下面「浏览…」
  // 按钮的 disabled 会一直停在首帧结论上。故挂载后复测一次，让组件响应运行期变化。
  const [inTauri, setInTauri] = useState(isTauri())

  // 上面只是首帧初值；IPC 桥的注入时机由壳决定（理论上早于业务脚本，但不做假设）：
  // 挂载后复测一次，并在页面重新可见/获得焦点时再测一遍 —— 让 :126 的禁用态
  // 跟着运行期环境走，而不是冻结在首帧结论上（BUG-286）。
  useEffect(() => {
    const sync = () => setInTauri(isTauri())
    sync()
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

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
    //
    // BUG-323 缺陷③：不再「软失败 + 提示」了事 —— 那等于网页模式下**根本没有**
    // 挑目录的入口（同一产品两套可用性语义，BUG-179 禁止）。改为打开**应用内目录
    // 浏览器**（数据来自 daemon 只读端点 `GET /api/fs/dirs`）。
    if (!isTauri()) {
      setLocalErr(null)
      setBrowserOpen(true)
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
      // 原生通道失败（权限/插件未注册）也不留死路：降级到应用内浏览器。
      // 同时上报全局提示（BUG-167：用户主动操作的失败不可静默）。
      const msg = e instanceof Error ? e.message : String(e)
      setLocalErr(t('dir.nativeUnavailable', { msg }))
      onError?.(t('dir.nativeUnavailableToast', { msg }))
      setBrowserOpen(true)
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
        {/* BUG-332：状态里始终是存储形式（正斜杠），这里只做展示归一化；
            写回时再折回正斜杠 —— 两个方向成对，缺一个就会把反斜杠存进配置。 */}
        <Input
          value={displayPath(value)}
          onChange={(e) => onChange(storagePath(e.target.value))}
          placeholder={displayPath(placeholder)}
          disabled={disabled}
        />
        {showHistory && recent.length > 0 && (
          <button
            type="button"
            onClick={() => setOpenList((v) => !v)}
            disabled={disabled}
            title={t('dir.historyTitle')}
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
          disabled={disabled}
          data-testid="dir-picker-browse"
          title={inTauri ? undefined : t('dir.webDebugHint')}
          className="shrink-0"
        >
          {t('dir.browse')}
        </Button>
      </div>

      <DirectoryBrowserDialog
        open={browserOpen}
        initialPath={initialPath || value}
        onClose={() => setBrowserOpen(false)}
        onPick={(dir) => {
          onChange(dir)
          setRecent(addRecentDir(dir))
          setBrowserOpen(false)
        }}
      />

      {localErr && (
        <p className="mt-1 text-[11px] text-danger" title={localErr}>
          {localErr}
        </p>
      )}

      {showHistory && openList && recent.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border-subtle bg-surface shadow-xl">
          <p className="px-3 pt-2 text-[10px] uppercase tracking-wide text-muted">
            {t('dir.recent')}
          </p>
          {recent.map((d) => (
            <div
              key={d}
              className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-surface-2"
              onClick={() => chooseHistory(d)}
              title={displayPath(d)}
            >
              <span className="truncate font-mono text-fg-mid">{displayPath(d)}</span>
              <button
                className="shrink-0 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                onClick={(e) => removeOne(e, d)}
                title={t('dir.removeHistory')}
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
