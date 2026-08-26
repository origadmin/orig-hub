import { useEffect, useState } from 'react'

interface Props {
  /** 左侧标题文本 */
  title: string
}

/** 浏览器预览/单元测试场景：未注入 Tauri 时返回 false */
function detectTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function TitleBar({ title }: Props) {
  const [maximized, setMaximized] = useState(false)
  const [tauri, setTauri] = useState(false)

  useEffect(() => {
    if (!detectTauri()) return
    setTauri(true)
    let unlisten: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()
        win.isMaximized().then(setMaximized).catch(() => {})
        win
          .onResized(() => {
            if (cancelled) return
            win.isMaximized().then(setMaximized).catch(() => {})
          })
          .then((fn) => (unlisten = fn))
          .catch(() => {})
      } catch {
        // Tauri 不可用（浏览器预览等），保持按钮可见但无操作
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const handleMinimize = () => {
    if (!tauri) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().minimize().catch(() => {})
    })
  }

  const handleToggleMax = () => {
    if (!tauri) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      win
        .isMaximized()
        .then((m) => (m ? win.unmaximize() : win.maximize()))
        .catch(() => {})
    })
  }

  const handleClose = () => {
    if (!tauri) return
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().close().catch(() => {})
    })
  }

  return (
    <div
      className="titlebar"
      onDoubleClick={handleToggleMax}
      data-tauri={tauri ? 'true' : 'false'}
    >
      <span className="truncate text-xs font-medium tracking-wide text-fg-soft">
        {title}
      </span>
      <div className="ml-auto flex h-full">
        <button className="titlebar-btn" title="最小化" onClick={handleMinimize}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
            <rect x="0" y="5.2" width="12" height="1.6" rx="0.8" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          title={maximized ? '还原' : '最大化'}
          onClick={handleToggleMax}
        >
          {maximized ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <rect x="3.4" y="3.4" width="7" height="7" rx="1" />
              <path d="M8.4 3.4V2.6a1.2 1.2 0 0 0-1.2-1.2H2.6A1.2 1.2 0 0 0 1.4 2.6v4.6a1.2 1.2 0 0 0 1.2 1.2h.8" />
            </svg>
          ) : (
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <rect x="1.4" y="1.4" width="9.2" height="9.2" rx="1" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          title="关闭"
          onClick={handleClose}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
