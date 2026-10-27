/**
 * 错误呈现的**唯一**实现（BUG-384）。
 *
 * 三个域（TG / 媒体库 / 下载）此前各自 `setError(e.message)`，界面上只有一句话：
 * 没有对象标识、没有状态码、没有时间、没有可复制串。本组件把这些缺口一次补齐，
 * 且只有这一处实现 —— 新域要用就复用，不许再写第二套。
 *
 * 形态：**一行标题（可读的一句话） + 可展开的结构化详情 + 一键复制诊断串**。
 * 默认不展开：错误不该在正常视野里堆技术细节，但必须「一按就在」。
 */
import { useState } from 'react'
import { useTranslation } from '../i18n'
import { copyToClipboard } from '../lib/env'
import { errorReport, type AppError } from '../lib/appError'

interface Props {
  error: AppError
  /** 稳定锚点，供验收脚本定位（各域传自己的 testid） */
  testId?: string
  /** 可选的重试动作；不给则不渲染重试键 */
  onRetry?: () => void
  className?: string
}

export function ErrorDetail({ error, testId, onRetry, className }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const ok = await copyToClipboard(errorReport(error))
    setCopied(ok)
    // 复制成功的提示是**短时**的：它不该在界面上留下来冒充状态。
    if (ok) window.setTimeout(() => setCopied(false), 1600)
  }

  const rows: Array<[string, string]> = [
    [t('error.source'), error.source ?? '—'],
    [t('error.object'), error.objectRef ?? '—'],
    [t('error.status'), error.status !== undefined ? String(error.status) : '—'],
    [t('error.code'), error.code ?? '—'],
    [t('error.time'), error.at],
  ]

  return (
    <div
      className={`rounded-md border border-danger/40 bg-danger/5 px-2.5 py-2 text-[12px] ${className ?? ''}`}
      data-testid={testId ?? 'error-detail'}
      data-error-status={error.status ?? ''}
      data-error-source={error.source ?? ''}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-danger">{error.message}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-[11px] text-muted underline-offset-2 hover:text-fg-mid hover:underline"
          data-testid="error-detail-toggle"
          aria-expanded={open}
        >
          {t('error.details')}
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 text-[11px] text-muted underline-offset-2 hover:text-fg-mid hover:underline"
            data-testid="error-detail-retry"
          >
            {t('error.retry')}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-1 border-t border-danger/20 pt-2" data-testid="error-detail-body">
          <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px] text-fg-mid">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 break-all">{v}</dd>
              </div>
            ))}
            {error.body && (
              <div className="contents">
                <dt className="text-muted">{t('error.body')}</dt>
                <dd className="min-w-0 break-all">{error.body}</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            onClick={() => void copy()}
            className="text-[11px] text-muted underline-offset-2 hover:text-fg-mid hover:underline"
            data-testid="error-detail-copy"
          >
            {copied ? t('error.copied') : t('error.copy')}
          </button>
        </div>
      )}
    </div>
  )
}
