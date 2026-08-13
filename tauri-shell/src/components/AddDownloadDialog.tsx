import { useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Stepper } from './ui/stepper'
import { DirectoryPicker } from './DirectoryPicker'
import {
  InterfacePickerDialog,
  type InterfaceSelection,
} from './InterfacePickerDialog'
import { useStore } from '../store/useStore'
import { filenameFromUrl } from '../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

export function AddDownloadDialog({ open, onClose }: Props) {
  const { addDownload, setError, settings } = useStore()
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [maxConnections, setMaxConnections] = useState(8)
  const [submitting, setSubmitting] = useState(false)

  // 多网卡：弹窗选择（全局设置默认带入，纯选择）
  const [ifaces, setIfaces] = useState<InterfaceSelection>({
    primary: settings.primaryInterface,
    enabledNames: Object.keys(settings.enabledInterfaces),
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  if (!open) return null

  const handleUrlChange = (v: string) => {
    setUrl(v)
    // 自动从 URL 推断文件名
    if (!filename) {
      const fn = filenameFromUrl(v)
      if (fn && fn !== v) setFilename(fn)
    }
  }

  const handleSubmit = async () => {
    if (!url.trim()) {
      setError('请输入下载 URL')
      return
    }
    // 组装 interfaces：主网卡权重 2 份，附属各 1 份（公式 N+1，主 2 份）
    const secondaries: Record<string, number> = {}
    for (const name of ifaces.enabledNames) {
      secondaries[name] = 1
    }
    const hasSecondaries = Object.keys(secondaries).length > 0
    setSubmitting(true)
    try {
      await addDownload({
        url: url.trim(),
        filename: filename.trim() || undefined,
        output_path: outputPath.trim() || undefined,
        max_connections: maxConnections,
        interfaces:
          hasSecondaries || ifaces.primary
            ? {
                primary: ifaces.primary || undefined,
                primary_weight: 2,
                secondaries: hasSecondaries ? secondaries : undefined,
              }
            : undefined,
      })
      setUrl('')
      setFilename('')
      setOutputPath('')
      setIfaces({ primary: undefined, enabledNames: [] })
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
            <Stepper
              value={maxConnections}
              onChange={setMaxConnections}
              min={1}
              max={64}
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
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="break-all text-zinc-300">
                      {ifaces.primary && (
                        <span className="font-medium text-accent">
                          {ifaces.primary}（主） +{' '}
                        </span>
                      )}
                      {ifaces.enabledNames.join('、')}
                      {!ifaces.primary && ifaces.enabledNames.length === 0 && (
                        <span className="text-muted">仅主网卡参与（自动识别）</span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPickerOpen(true)}
                  >
                    选择网卡
                  </Button>
                </div>
                <p className="pt-1 text-[10px] leading-relaxed text-muted">
                  勾选参与网卡；权重按公式自动分配（主 2 份 / 附属 1 份）。
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

        <InterfacePickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          selected={ifaces}
          onConfirm={(sel) => setIfaces(sel)}
        />
      </div>
    </div>
  )
}
