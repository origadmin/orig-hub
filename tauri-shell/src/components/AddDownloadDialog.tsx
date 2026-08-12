import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { DirectoryPicker } from './DirectoryPicker'
import { useStore } from '../store/useStore'
import { listInterfaces } from '../api/daemon'
import { filenameFromUrl } from '../lib/utils'
import type { NetworkInterface } from '../types'

interface Props {
  open: boolean
  onClose: () => void
}

export function AddDownloadDialog({ open, onClose }: Props) {
  const { addDownload, setError } = useStore()
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [maxConnections, setMaxConnections] = useState('8')
  const [submitting, setSubmitting] = useState(false)

  // 多网卡：所有候选 + 勾选状态 + 权重
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [weights, setWeights] = useState<Record<string, string>>({})
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    if (!open) return
    listInterfaces()
      .then(({ primary, secondaries }) => {
        const all = [primary, ...(secondaries ?? [])].filter(Boolean)
        setIfaces(all)
        const en: Record<string, boolean> = {}
        const w: Record<string, string> = {}
        for (const nic of all) {
          en[nic.name] = nic.is_default || nic.enabled
          w[nic.name] = String(nic.weight || 1)
        }
        setEnabled(en)
        setWeights(w)
      })
      .catch(() => {})
  }, [open])

  if (!open) return null

  const handleUrlChange = (v: string) => {
    setUrl(v)
    // 自动从 URL 推断文件名
    if (!filename) {
      const fn = filenameFromUrl(v)
      if (fn && fn !== v) setFilename(fn)
    }
  }

  const toggleIface = (name: string, isDefault: boolean) => {
    if (isDefault) return // 主网卡固定参与
    setEnabled((e) => ({ ...e, [name]: !e[name] }))
  }

  const handleSubmit = async () => {
    if (!url.trim()) {
      setError('请输入下载 URL')
      return
    }
    // 组装 interfaces（仅当有附属网卡被启用时提交）
    const secondaries: Record<string, number> = {}
    for (const nic of ifaces) {
      if (nic.is_default) continue
      if (enabled[nic.name]) {
        secondaries[nic.name] = Math.max(1, Number(weights[nic.name]) || 1)
      }
    }
    setSubmitting(true)
    try {
      await addDownload({
        url: url.trim(),
        filename: filename.trim() || undefined,
        output_path: outputPath.trim() || undefined,
        max_connections: Number(maxConnections) || undefined,
        interfaces:
          Object.keys(secondaries).length > 0
            ? { secondaries }
            : undefined,
      })
      setUrl('')
      setFilename('')
      setOutputPath('')
      setEnabled({})
      setWeights({})
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md animate-spring rounded-xl border border-border-subtle bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">新建下载</h2>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted">URL *</label>
            <Input
              placeholder="https://example.com/file.zip"
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">文件名（可选）</label>
            <Input
              placeholder="留空自动从 URL 推断"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">保存目录（可选）</label>
            <DirectoryPicker
              value={outputPath}
              onChange={setOutputPath}
              placeholder="留空使用默认下载目录"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">最大连接数</label>
            <Input
              type="number"
              min={1}
              max={64}
              value={maxConnections}
              onChange={(e) => setMaxConnections(e.target.value)}
            />
          </div>

          {/* 高级：多网卡 */}
          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted hover:text-zinc-200"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span
                className={`inline-block transition-transform ${
                  showAdvanced ? 'rotate-90' : ''
                }`}
              >
                ▶
              </span>
              多网卡分流
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-1.5 rounded-md border border-border-subtle bg-surface-2/40 p-2.5">
                {ifaces.length === 0 && (
                  <p className="text-xs text-muted">未检测到网卡</p>
                )}
                {ifaces.map((nic) => (
                  <div
                    key={nic.name}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <label
                      className={`flex flex-1 cursor-pointer items-center gap-2 ${
                        nic.is_default ? '' : 'cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={enabled[nic.name] ?? nic.is_default}
                        disabled={nic.is_default}
                        onChange={() => toggleIface(nic.name, nic.is_default)}
                        className="accent-accent"
                      />
                      <span className="font-medium text-zinc-200">{nic.name}</span>
                      {nic.is_default && (
                        <span className="text-[9px] text-accent">主</span>
                      )}
                      <span className="font-mono text-muted">{nic.ip}</span>
                    </label>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted">权重</span>
                      <Input
                        type="number"
                        min={1}
                        max={99}
                        value={weights[nic.name] ?? '1'}
                        onChange={(e) =>
                          setWeights((w) => ({
                            ...w,
                            [nic.name]: e.target.value,
                          }))
                        }
                        disabled={!(enabled[nic.name] ?? nic.is_default)}
                        className="h-6 w-14 px-1.5 text-xs"
                      />
                    </div>
                  </div>
                ))}
                <p className="pt-1 text-[10px] leading-relaxed text-muted">
                  主网卡固定参与；勾选附属网卡并按权重分配并发连接（默认 1:1）。
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? '添加中…' : '开始下载'}
          </Button>
        </div>
      </div>
    </div>
  )
}
