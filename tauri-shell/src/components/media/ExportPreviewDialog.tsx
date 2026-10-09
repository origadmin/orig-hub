import { useMemo, useState } from 'react'
import { Button } from '../ui/button'
import {
  previewExport,
  exportMedia,
  ExportError,
  type ExportBundleResult,
  type ExportPreviewResult,
  type MediaSeries,
} from '../../api/media'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { DirectoryPicker } from '../DirectoryPicker'

/** issue 类型 → 徽标样式（颜色即语义：红=字节阻断，橙=元数据缺失） */
const ISSUE_STYLE: Record<string, string> = {
  bytes: 'border-destructive/40 bg-destructive/10 text-destructive',
  empty: 'border-destructive/40 bg-destructive/10 text-destructive',
  description: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  image: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
}

/**
 * 导出预览 + 导出本体（byte-ownership P5 + P6）。
 * - 先调只读 preview 端点列问题清单；
 * - 全部可导出（issuesTotal===0）时，展示「导出目录」选择 + 「开始导出」按钮，
 *   点击走 POST /api/media/export 真正交付（复制视频/图片 + 写 manifest）。
 */
export function ExportPreviewDialog(props: {
  /**
   * 导出候选 = **全库剧集**（不是某一子集）。
   *
   * BUG-214：剧集墙的「批量导出」只预勾选选中集，**不**收窄候选 —— 因为下面
   * `run()` / `doExport()` 里 `ids.length === series.length ? undefined : ids` 是
   * 「全选 ⇔ 全库」短路；一旦把 `series` 换成子集，「子集恰好全勾」就会被当成
   * 「导出全库」，是危险的语义错误。
   */
  series: MediaSeries[]
  /** 预勾选的剧集 id（BUG-214 批量导出入口）；缺省 = 全选（既有行为） */
  preselect?: number[]
  onClose: () => void
  onError: (msg: string) => void
}) {
  const { series, preselect, onClose, onError } = props
  const { t } = useTranslation()
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(preselect && preselect.length > 0 ? preselect : series.map((s) => s.id)),
  )
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportPreviewResult | null>(null)

  // P6 导出动作态
  const [targetDir, setTargetDir] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<ExportBundleResult | null>(null)

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async () => {
    setBusy(true)
    setExportResult(null)
    try {
      const ids = [...checked]
      // 无勾选 = 全库校验（与端点契约一致：缺省 seriesIds = 全库）
      setResult(await previewExport(ids.length === series.length ? undefined : ids))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openExportDir = async (dir: string) => {
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(dir)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const doExport = async () => {
    setExporting(true)
    try {
      const ids = [...checked]
      const r = await exportMedia(
        ids.length === series.length ? undefined : ids,
        targetDir,
      )
      setExportResult(r)
    } catch (e) {
      if (e instanceof ExportError && e.issues && e.issues.length > 0) {
        // 完备性闸口拦截（race 安全网）：复位回问题视图，让用户先补全再导。
        setResult({
          series: e.issues,
          summary: {
            seriesTotal: e.issues.length,
            seriesReady: 0,
            issuesTotal: e.issues.reduce((acc, s) => acc + s.issues.length, 0),
            byKind: {},
          },
        })
        onError(t('media.exportBlockedByReadiness'))
      } else {
        onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setExporting(false)
    }
  }

  const allChecked = checked.size === series.length
  const allReady = result != null && result.summary.issuesTotal === 0
  const summaryLine = useMemo(() => {
    if (!result) return ''
    const { seriesTotal, seriesReady, issuesTotal } = result.summary
    return t('media.exportSummary', {
      total: seriesTotal,
      ready: seriesReady,
      issues: issuesTotal,
    })
  }, [result, t])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="export-preview-dialog"
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">{t('media.exportPreview')}</h4>

        {/* 选择区：勾选要校验的剧集（默认全选；全选 = 全库校验） */}
        <div className="mt-3 flex items-center justify-between">
          <button
            type="button"
            className="text-[11px] text-accent hover:underline"
            onClick={() =>
              setChecked(allChecked ? new Set() : new Set(series.map((s) => s.id)))
            }
          >
            {allChecked ? t('media.exportUnselectAll') : t('media.exportSelectAll')}
          </button>
          <Button
            size="sm"
            className="h-7 px-3 text-[11px]"
            disabled={busy || series.length === 0}
            onClick={run}
            data-testid="export-preview-run"
          >
            {busy ? t('media.exportChecking') : t('media.exportCheck')}
          </Button>
        </div>
        <div className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border-subtle bg-surface-2/30 p-1.5">
          {series.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-muted">{t('media.exportNoSeries')}</p>
          )}
          {series.map((s) => (
            <label
              key={s.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-surface-2/60"
            >
              <input
                type="checkbox"
                checked={checked.has(s.id)}
                onChange={() => toggle(s.id)}
                className="accent-accent"
              />
              <span className="min-w-0 flex-1 truncate text-fg-strong">{s.title}</span>
              <span className="text-muted">{t('media.episodeCount', { n: s.episodeCount })}</span>
            </label>
          ))}
        </div>

        {/* 成功视图：导出已写入磁盘 */}
        {exportResult && (
          <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="export-result-success">
            <p className="text-[12px] font-medium text-emerald-500">{t('media.exportSuccess')}</p>
            <p className="mt-1 text-[11px] text-muted">
              {t('media.exportDoneSummary', {
                n: exportResult.seriesCount,
                f: exportResult.filesCopied,
              })}
            </p>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">
              {t('media.exportManifest', { path: exportResult.manifestPath })}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 px-3 text-[11px]"
              onClick={() => openExportDir(exportResult.exportDir)}
            >
              {t('media.exportOpenFolder')}
            </Button>
          </div>
        )}

        {/* 结果区：汇总行 + 按剧集分组的问题清单 */}
        {result && !exportResult && (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto" data-testid="export-preview-result">
            <p className="mb-2 text-[11px] text-muted">{summaryLine}</p>
            <div className="space-y-1.5">
              {result.series.map((r) => {
                const ready = r.issues.length === 0
                return (
                  <div
                    key={r.seriesId}
                    className={cn(
                      'rounded-md border p-2',
                      ready
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-border-subtle bg-surface-2/30',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-strong">
                        {r.title}
                      </span>
                      {ready ? (
                        <span
                          className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500"
                          data-testid={`export-ready-${r.seriesId}`}
                        >
                          {t('media.exportReady')}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted">
                          {t('media.exportIssueCount', { n: r.issues.length })}
                        </span>
                      )}
                    </div>
                    {r.issues.length > 0 && (
                      <table className="mt-1 w-full text-[11px]">
                        <tbody>
                          {r.issues.map((iss, i) => (
                            <tr key={`${iss.episodeId}-${i}`} className="align-top">
                              <td className="w-14 py-0.5 pr-2 font-mono text-muted">
                                {iss.episodeNo}
                              </td>
                              <td className="w-16 py-0.5 pr-2">
                                <span
                                  className={cn(
                                    'inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium',
                                    ISSUE_STYLE[iss.kind] ?? 'border-border-subtle text-muted',
                                  )}
                                >
                                  {t(`media.exportIssue.${iss.kind}`)}
                                </span>
                              </td>
                              <td className="py-0.5 text-muted">{iss.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 导出区：全部可导出时才出现（readiness 闸门已通过） */}
        {result && allReady && !exportResult && (
          <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3" data-testid="export-action">
            <p className="text-[12px] font-medium text-fg-strong">{t('media.exportTarget')}</p>
            <p className="mt-0.5 text-[11px] text-muted">{t('media.exportTargetHint')}</p>
            <div className="mt-2">
              <DirectoryPicker
                value={targetDir}
                onChange={setTargetDir}
                placeholder={t('media.exportDirPlaceholder')}
                onError={onError}
              />
            </div>
            <Button
              size="sm"
              className="mt-2 h-7 px-3 text-[11px]"
              disabled={exporting || targetDir.trim().length === 0}
              onClick={doExport}
              data-testid="export-run"
            >
              {exporting ? t('media.exporting') : t('media.exportStart')}
            </Button>
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
            {t('media.exportClose')}
          </Button>
        </div>
      </div>
    </div>
  )
}
