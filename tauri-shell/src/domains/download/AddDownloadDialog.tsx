import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Stepper } from '../../components/ui/stepper'
import { DirectoryPicker } from '../../components/DirectoryPicker'
import {
  InterfacePickerDialog,
  type InterfaceSelection,
} from '../../components/InterfacePickerDialog'
import { Switch } from '../../components/ui/switch'
import { useStore } from '../../store/useStore'
import { getConfig } from '../../api/daemon'
import { filenameFromUrl, cn } from '../../lib/utils'
import { useTranslation } from '../../i18n'

interface Props {
  open: boolean
  onClose: () => void
}

export function AddDownloadDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const { addDownload, setError, settings } = useStore()
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [maxConnections, setMaxConnections] = useState(8)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 多网卡：弹窗选择（全局设置默认带入，纯选择）
  const [ifaces, setIfaces] = useState<InterfaceSelection>({
    primary: settings.primaryInterface,
    enabledNames: Object.keys(settings.enabledInterfaces),
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [classify, setClassify] = useState(settings.autoClassify)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [overwrite, setOverwrite] = useState(false)
  // 本次下载代理：direct=用全局配置 / custom=指定代理
  const [proxyMode, setProxyMode] = useState<'global' | 'custom'>('global')
  const [proxyUrl, setProxyUrl] = useState('')
  // 内容默认根（用户 2026-10-19 裁定「禁止往C盘写入任何数据,所有内容应该写D盘」
  // ⇒ Windows 恒 `D:\OrigDown`）：未显式指定保存目录时作占位/回退。
  const [defaultDir, setDefaultDir] = useState('')

  // 打开时拉一次内容默认根（daemon 下发，替代写死的 ~/Downloads）。
  useEffect(() => {
    if (!open) return
    getConfig()
      .then((c) => setDefaultDir(c.default_download_dir ?? ''))
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

  const handleSubmit = async () => {
    setFormError(null)
    if (!url.trim()) {
      setFormError(t('download.addDialog.urlRequired'))
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
        classify,
        overwrite,
        // 代理：global → 不传（用 daemon 配置）；custom → 指定代理
        ...(proxyMode === 'custom' && proxyUrl.trim()
          ? { proxy: { mode: 'custom' as const, url: proxyUrl.trim() } }
          : {}),
      })
      setUrl('')
      setFilename('')
      setOutputPath('')
      setIfaces({ primary: undefined, enabledNames: [] })
      setClassify(settings.autoClassify)
      setProxyMode('global')
      setProxyUrl('')
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 尝试从 JSON 响应提取 detail（daemon 错误带 detail 字段）
      let friendly = msg
      const m = msg.match(/: (\{[\s\S]*\})$/)
      if (m) {
        try {
          const parsed = JSON.parse(m[1])
          if (parsed.detail) friendly = String(parsed.detail)
          else if (parsed.error) friendly = String(parsed.error)
        } catch {
          // 保持原始消息
        }
      }
      // 弹窗内就地显示错误（不再只写全局 error——会被弹窗遮住）
      setFormError(friendly)
      setError(friendly)
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
        className="w-full max-w-md animate-spring rounded-xl border border-border-subtle bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-fg-strong">{t('download.addDialog.title')}</h2>

        {formError && (
          <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
            {formError}
          </div>
        )}

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
            <label className="mb-1 block text-xs text-muted">{t('download.addDialog.filenameLabel')}</label>
            <Input
              placeholder={t('download.addDialog.filenamePlaceholder')}
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">{t('download.addDialog.saveDirLabel')}</label>
            <DirectoryPicker
              value={outputPath}
              onChange={setOutputPath}
              placeholder={outputPath || defaultDir || t('download.addDialog.defaultDirPlaceholder')}
              onError={setError}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">{t('download.addDialog.maxConnLabel')}</label>
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
              className="flex items-center gap-1 text-xs text-muted hover:text-fg-mid"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span
                className={`inline-block transition-transform ${
                  showAdvanced ? 'rotate-90' : ''
                }`}
              >
                ▶
              </span>
              {t('download.addDialog.multiNic')}
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-1.5 rounded-md border border-border-subtle bg-surface-2/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="break-all text-fg-mid">
                      {ifaces.primary && (
                        <span className="font-medium text-accent">
                          {ifaces.primary}
                          {t('download.addDialog.primaryBadge')} +{' '}
                        </span>
                      )}
                      {ifaces.enabledNames.join('、')}
                      {!ifaces.primary && ifaces.enabledNames.length === 0 && (
                        <span className="text-muted">{t('download.addDialog.primaryOnly')}</span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPickerOpen(true)}
                  >
                    {t('download.addDialog.selectNic')}
                  </Button>
                </div>
                <p className="pt-1 text-[10px] leading-relaxed text-muted">
                  {t('download.addDialog.nicHint')}
                </p>
              </div>
            )}
          </div>

          {/* 代理：本次下载覆盖全局配置 */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2/40 p-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-fg-mid">{t('download.addDialog.proxy')}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
                {proxyMode === 'global'
                  ? t('download.addDialog.proxyGlobal')
                  : t('download.addDialog.proxyCustom')}
              </p>
              {proxyMode === 'custom' && (
                <Input
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder={t('download.addDialog.proxyPlaceholder')}
                  className="mt-1.5 font-mono"
                />
              )}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                type="button"
                onClick={() => setProxyMode('global')}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  proxyMode === 'global'
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:text-fg-mid',
                )}
              >
                {t('download.addDialog.proxyFollowGlobal')}
              </button>
              <button
                type="button"
                onClick={() => setProxyMode('custom')}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] transition-colors',
                  proxyMode === 'custom'
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:text-fg-mid',
                )}
              >
                {t('download.addDialog.proxySpecify')}
              </button>
            </div>
          </div>

          {/* 自动分类（R3） */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2/40 p-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg-mid">{t('download.addDialog.autoClassify')}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted">{t('download.addDialog.autoClassifyHint')}</p>
            </div>
            <Switch checked={classify} onChange={setClassify} />
          </div>

          {/* 覆盖下载 */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2/40 p-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg-mid">{t('download.addDialog.overwrite')}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted">{t('download.addDialog.overwriteHint')}</p>
            </div>
            <Switch checked={overwrite} onChange={setOverwrite} />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('download.addDialog.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('download.addDialog.submitting') : t('download.addDialog.start')}
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
