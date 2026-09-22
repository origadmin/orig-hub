import { useMemo, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { importMediaItems, scanDirectory } from '../../api/media'
import type { ScannedFile } from '../../api/media'
import { fmtSize } from '../../lib/mediaSources'
import { getRecentDirs } from '../../lib/recentDirs'

const KIND_LABEL: Record<string, string> = {
  video: '视频',
  photo: '图片',
  audio: '音频',
  file: '文件',
}

/**
 * 导入本地目录：扫描 → 勾选 → 导入资料库。
 *
 * 只登记文件（写库），**不复制/移动磁盘原文件**；重复导入按路径幂等。
 */
export function ImportDialog(props: {
  onClose: () => void
  onImported: (count: number) => void
  onError: (msg: string) => void
}) {
  const { onClose, onImported, onError } = props
  // BUG-143：原先硬编码 `D:\test_videos`（开发期调试残留，会带到用户机器上）。
  // 改为「上次用过的目录，没有就留空」—— 复用现成的 recentDirs，不新造一套持久化。
  const [dir, setDir] = useState(() => getRecentDirs()[0] ?? '')
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<ScannedFile[] | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const selected = useMemo(
    () => (found ?? []).filter((f) => !excluded.has(f.path)),
    [found, excluded],
  )

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const f of found ?? []) c[f.kind] = (c[f.kind] ?? 0) + 1
    return c
  }, [found])

  const runScan = async () => {
    setScanning(true)
    try {
      const list = await scanDirectory(dir.trim())
      setFound(list)
      setExcluded(new Set())
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      setFound([])
    } finally {
      setScanning(false)
    }
  }

  const runImport = async () => {
    if (selected.length === 0) return
    setImporting(true)
    try {
      const res = await importMediaItems(
        selected.map((f) => ({
          path: f.path,
          source: 'local' as const,
          kind: f.kind,
          size: f.size,
        })),
      )
      onImported(res.count)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  const toggle = (path: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <h4 className="text-[13px] font-semibold text-fg-strong">导入本地目录</h4>
          <p className="mt-0.5 text-[11px] text-muted">
            扫描目录中的视频/图片/音频并登记到资料库，原文件保留在原位不会被移动。
          </p>
        </header>

        <div className="shrink-0 px-4 pt-3">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="选择要导入的目录"
                className="h-8 text-xs"
                spellCheck={false}
              />
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={scanning || !dir.trim()}
              onClick={() => void runScan()}
            >
              {scanning ? '扫描中…' : '扫描'}
            </Button>
          </div>
          {found ? (
            <p className="mt-2 text-[11px] text-muted">
              共 {found.length} 个媒体文件
              {Object.entries(counts).map(([k, v]) => ` · ${KIND_LABEL[k] ?? k} ${v}`).join('')}
              {' · 已选 '}
              <span className="font-medium text-fg-strong">{selected.length}</span>
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {found === null ? (
            <p className="py-8 text-center text-xs text-muted">输入目录后点击「扫描」</p>
          ) : found.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">该目录下没有可识别的媒体文件</p>
          ) : (
            <ul className="space-y-0.5">
              {found.map((f) => {
                const off = excluded.has(f.path)
                return (
                  <li key={f.path}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-2/70">
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={() => toggle(f.path)}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-strong">
                        {f.dir ? `${f.dir}/` : ''}
                        {f.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">{KIND_LABEL[f.kind]}</span>
                      <span className="w-16 shrink-0 text-right text-[10px] text-muted">
                        {fmtSize(f.size)}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border-subtle/60 px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => {
              if (found && found.length) setExcluded(new Set(found.map((f) => f.path)))
              else setExcluded(new Set())
            }}
          >
            全不选
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setExcluded(new Set())}
          >
            全选
          </Button>
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={importing || selected.length === 0}
            onClick={() => void runImport()}
          >
            {importing ? '导入中…' : `导入 ${selected.length} 项`}
          </Button>
        </footer>
      </div>
    </div>
  )
}
