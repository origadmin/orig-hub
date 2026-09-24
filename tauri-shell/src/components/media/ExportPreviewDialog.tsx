import { useMemo, useState } from 'react'
import { Button } from '../ui/button'
import {
  previewExport,
  type ExportPreviewResult,
  type MediaSeries,
} from '../../api/media'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'

/** issue 类型 → 徽标样式（颜色即语义：红=字节阻断，橙=元数据缺失） */
const ISSUE_STYLE: Record<string, string> = {
  bytes: 'border-destructive/40 bg-destructive/10 text-destructive',
  empty: 'border-destructive/40 bg-destructive/10 text-destructive',
  description: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
  image: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
}

/**
 * 导出预览（byte-ownership P5）：选剧集 → 调只读 preview 端点 → 问题清单表格。
 * 这里**没有**导出动作本体 —— 校验是「能不能导出」的事前检查，P6 才做交付。
 */
export function ExportPreviewDialog(props: {
  series: MediaSeries[]
  onClose: () => void
  onError: (msg: string) => void
}) {
  const { series, onClose, onError } = props
  const { t } = useTranslation()
  const [checked, setChecked] = useState<Set<number>>(() => new Set(series.map((s) => s.id)))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportPreviewResult | null>(null)

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async () => {
    setBusy(true)
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

  const allChecked = checked.size === series.length
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

        {/* 结果区：汇总行 + 按剧集分组的问题清单 */}
        {result && (
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

        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
            {t('media.exportClose')}
          </Button>
        </div>
      </div>
    </div>
  )
}
