import { useCallback, useEffect, useState } from 'react'
import { Folder } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { listDirs } from '../api/daemon'
import type { FsDirListing } from '../api/daemon'

interface Props {
  open: boolean
  /** 打开时的起始目录（通常是输入框里的值或当前生效目录）；空 = 「此电脑」 */
  initialPath?: string
  onClose: () => void
  onPick: (dir: string) => void
}

/** 快捷锚点语义键 → 展示文案（label 归前端，daemon 只给 key）。 */
const ROOT_LABEL: Record<string, string> = {
  default_download: '系统下载目录',
  home: '主目录',
  current: '当前下载目录',
  library: '媒体库根',
}

/**
 * 应用内目录浏览器（**网页调试模式**下的「浏览…」）。
 *
 * BUG-323 缺陷③：桌面壳的「浏览…」走 `@tauri-apps/plugin-dialog`（系统原生对话框），
 * 浏览器里根本没有 ⇒ 同一产品的两种运行方式出现两套可用性语义（BUG-179 禁止）。
 * 这里把「挑目录」这条路搬到应用内，数据来自 daemon 的只读端点 `GET /api/fs/dirs`
 * （只列子目录）。桌面壳仍用原生对话框（体验更好）。
 *
 * 失败必须直出原因（404 不存在 / 403 无权）：把「读不到」渲染成「没有子目录」
 * 正是 BUG-176 / BUG-318 那类「数据丢失幻觉」的成因。
 */
export function DirectoryBrowserDialog({ open, initialPath, onClose, onPick }: Props) {
  const [listing, setListing] = useState<FsDirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 手输路径（前进用；UNC / 长路径用导航点太慢） */
  const [jump, setJump] = useState('')

  const go = useCallback(async (target: string) => {
    setLoading(true)
    setErr(null)
    try {
      const r = await listDirs(target)
      setListing(r)
      setJump(r.path ?? '')
    } catch (e) {
      // daemon 的错误体是 `{"code","message"}`：优先直出 message 原文，
      // 退化为原始异常串（不吞错、不编造）。**保留上一次成功的 listing** ——
      // 否则一次跳转失败就把整个对话框变成死屏（连盘符都点不到了）。
      const raw = e instanceof Error ? e.message : String(e)
      const m = /"message"\s*:\s*"([^"]+)"/.exec(raw)
      setErr(m ? m[1] : raw)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      // 先取一次「此电脑」（锚点 + 盘符），保证任何情况下都有可点的东西；
      // 再跳到起始目录。起始目录失效（被改动/删除）时只报错，不把屏清空。
      await go('')
      if (!alive) return
      const target = initialPath?.trim()
      if (target) await go(target)
    })()
    return () => {
      alive = false
    }
    // initialPath 只在打开瞬间取值（打开后再变不应打断用户当前浏览位置）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dir-browser"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="选择目录"
        className="w-full max-w-xl animate-spring rounded-xl border border-border-subtle bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-fg-strong">选择目录</h2>

        {/* 快捷锚点 */}
        {listing && listing.roots.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {listing.roots.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => void go(r.path)}
                title={r.path}
                data-testid={`dir-browser-root-${r.key}`}
                className="max-w-[16rem] truncate rounded-md border border-border-subtle bg-surface-2 px-2 py-1 text-[11px] text-fg-mid transition-colors hover:bg-surface-2/70"
              >
                {ROOT_LABEL[r.key] ?? r.key}
              </button>
            ))}
          </div>
        )}

        {/* 当前位置 + 上一级 + 手输跳转 */}
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void go(listing.parent)}
            data-testid="dir-browser-up"
          >
            上一级
          </Button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-mid"
            title={listing?.path ?? undefined}
            data-testid="dir-browser-path"
          >
            {listing?.path ?? '此电脑'}
          </span>
        </div>

        <div className="mt-2 flex gap-1.5">
          <Input
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void go(jump)
            }}
            placeholder="直接输入绝对路径后回车"
            data-testid="dir-browser-input"
          />
          <Button
            type="button"
            variant="secondary"
            className="shrink-0"
            onClick={() => void go(jump)}
            data-testid="dir-browser-go"
          >
            前往
          </Button>
        </div>

        {/* 子目录列表 */}
        <div className="mt-3 h-64 overflow-y-auto rounded-md border border-border-subtle bg-surface-2/40">
          {err && (
            <p className="border-b border-border-subtle px-3 py-2 text-xs text-danger" data-testid="dir-browser-error">
              无法读取该目录：{err}
            </p>
          )}
          {loading && <p className="px-3 py-2 text-xs text-muted">读取中…</p>}
          {!loading && !err && listing?.entries.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted" data-testid="dir-browser-empty">
              该目录下没有子目录
            </p>
          )}
          {!loading &&
            listing?.entries.map((e, i) => (
              <button
                key={e.path}
                type="button"
                onClick={() => void go(e.path)}
                title={e.path}
                data-testid={`dir-browser-entry-${i}`}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-surface-2"
              >
                <Folder size={13} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-fg-mid">{e.name}</span>
              </button>
            ))}
        </div>

        {listing?.truncated && (
          <p className="mt-1.5 text-[11px] text-muted">
            子目录过多，仅显示前 1000 个（可直接在上方输入完整路径跳转）
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="dir-browser-close">
            取消
          </Button>
          <Button
            disabled={!listing?.path || loading}
            onClick={() => {
              if (listing?.path) onPick(listing.path)
            }}
            data-testid="dir-browser-pick"
          >
            选择此目录
          </Button>
        </div>
      </div>
    </div>
  )
}
