import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { cn } from '../lib/utils'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'
import { getTgSession, startTgLogin, submitTgCode, tgDiag, tgLogs } from '../api/tg'
import type { TgDiag, TgSession } from '../types'

type LoginStep = 'idle' | 'phone' | 'code'

/** 常见国际区号（默认 +86；可自行输入其他 +区号） */
const COUNTRY_CODES = ['+86', '+852', '+853', '+886', '+1', '+44', '+81', '+82', '+65', '+60']

/** 规范化手机号到 E.164：去空格/横线；非 `+` 开头时按所选区号拼接；输入了 `+` 时原样保留。 */
function normalizeE164(countryCode: string, national: string): string {
  const trimmed = national.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('+')) return '+' + trimmed.replace(/[\s-]/g, '')
  const digits = trimmed.replace(/[\s-]/g, '')
  if (!digits) return ''
  return countryCode.replace(/\s/g, '') + digits
}

/**
 * 账号绑定中心（设置页「账号」标签）。
 * 当前仅 Telegram（orig-tg 独立服务），后续可扩展其他账号。
 * 登录为一步步状态机：手机号 → 验证码 → （可能）两步验证密码。
 * 绑定后 `setTgAccount({ bound: true })` 触发侧边栏出现「TG」Tab。
 */
export function AccountsPanel() {
  const { t } = useTranslation()
  const { accounts, setTgAccount, setError, refreshTgSession } = useStore()
  const tg = accounts.tg

  // 挂载时校准一次登录态：后端会话已 Authorized（含持久化加载的会话）则自动恢复为「已绑定」。
  // refreshTgSession 幂等——只在绑定态或 phase 变化时才写 store；后端不可达时保持现状并静默。
  useEffect(() => {
    refreshTgSession().catch(() => {})
  }, [refreshTgSession])

  // 登录流程本地状态
  const [step, setStep] = useState<LoginStep>('idle')
  const [countryCode, setCountryCode] = useState('+86')
  const [phone, setPhone] = useState(tg.phone ?? '')
  /** start 时使用的 E.164 完整号码；code/password 阶段必须原样回传后端 */
  const [e164Phone, setE164Phone] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<TgSession['phase']>()

  // 诊断面板状态
  const [showDiag, setShowDiag] = useState(false)
  const [diag, setDiag] = useState<TgDiag | null>(null)
  const [diagLogs, setDiagLogs] = useState<string[]>([])
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagErr, setDiagErr] = useState('')

  /** 加载诊断快照 + 最近日志 */
  const loadDiag = async () => {
    setDiagBusy(true)
    setDiagErr('')
    try {
      const [d, logs] = await Promise.all([tgDiag(), tgLogs(50)])
      setDiag(d)
      setDiagLogs(logs)
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDiagBusy(false)
    }
  }

  /** 第一步：请求发送验证码（手机号经区号规范化为 E.164）。缓存 e164 供后续阶段原样回传。 */
  const handleRequestCode = async () => {
    const e164 = normalizeE164(countryCode, phone)
    if (!e164) return
    setBusy(true)
    try {
      await startTgLogin(e164)
      setE164Phone(e164)
      const s = await getTgSession()
      setPhase(s?.phase)
      setStep('code')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 第二步：提交验证码 / 两步验证密码。必须带上 start 时的完整 e164 phone。 */
  const handleSubmitCode = async () => {
    if (!code.trim() || !e164Phone) return
    setBusy(true)
    try {
      const s = await submitTgCode(e164Phone, code.trim())
      if (s?.phase === 'PasswordRequired') {
        // 需要两步验证密码：复用验证码输入框，提示清空后输入密码
        setCode('')
        setPhase('PasswordRequired')
        return
      }
      setTgAccount({ bound: true, phone: e164Phone })
      setStep('idle')
      setCode('')
      setE164Phone('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    setStep('idle')
    setCode('')
    setE164Phone('')
    setPhase(undefined)
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-fg-strong">{t('accounts.heading')}</h3>
        <p className="mt-0.5 text-xs text-muted">{t('accounts.sub')}</p>
      </div>

      {/* Telegram 账号 */}
      <div className="space-y-5 rounded-xl border border-border-subtle bg-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-500">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 11.25L5.343 19.5c.52-3.64 9.344-7.798 14.865-10.2 1.14.86 2.94 2.22 3.855 3.468-.27 2.22-4.44 12.72-6.225 16.662l-6.163-1.08M7.5 11.25l9.33-6.53c.9-.63 2.13-.18 2.362.586l.9 2.944M7.5 11.25l4.89 4.11" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-fg-strong">{t('accounts.tg')}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">
                {tg.phone ?? t('accounts.tgNotBound')}
              </p>
            </div>
          </div>
          <Badge variant={tg.bound ? 'success' : 'secondary'} className="shrink-0">
            {tg.bound ? t('accounts.bound') : t('accounts.unbound')}
          </Badge>
        </div>

        <div className="h-px bg-border-subtle/60" />

        {tg.bound ? (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setTgAccount({ bound: false, phone: null })}>
              {t('accounts.unbind')}
            </Button>
          </div>
        ) : step === 'idle' ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setStep('phone')}>
              {t('accounts.login')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {step === 'phone' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={countryCode}
                    onChange={(e) => setCountryCode(e.target.value)}
                    disabled={busy}
                    className="h-9 w-24 shrink-0 rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm text-fg-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 transition-colors"
                  >
                    {COUNTRY_CODES.map((cc) => (
                      <option key={cc} value={cc}>
                        {cc}
                      </option>
                    ))}
                  </select>
                  <div className="flex-1">
                    <Input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder={t('accounts.phonePlaceholder')}
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRequestCode()
                      }}
                    />
                  </div>
                  <Button size="sm" disabled={busy || !phone.trim()} onClick={handleRequestCode}>
                    {busy ? t('settings.saving') : t('accounts.sendCode')}
                  </Button>
                </div>
                <p className="text-[11px] text-muted">{t('accounts.nationalOnly')}</p>
              </div>
            )}

            {step === 'code' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder={
                        phase === 'PasswordRequired'
                          ? t('accounts.passwordPlaceholder')
                          : t('accounts.codePlaceholder')
                      }
                      disabled={busy}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSubmitCode()
                      }}
                    />
                  </div>
                  <Button size="sm" disabled={busy || !code.trim()} onClick={handleSubmitCode}>
                    {busy ? t('settings.saving') : t('accounts.confirm')}
                  </Button>
                </div>
                {phase === 'PasswordRequired' && (
                  <p className="text-[11px] text-muted">{t('accounts.passwordHint')}</p>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={cancel}>
                {t('accounts.cancel')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 连接诊断面板 */}
      <div className="rounded-xl border border-border-subtle bg-surface p-5">
        <button
          type="button"
          onClick={() => {
            const next = !showDiag
            setShowDiag(next)
            if (next) loadDiag()
          }}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-fg-strong">{t('accounts.diag')}</p>
            <p className="mt-0.5 text-[11px] text-muted">{t('accounts.diagDesc')}</p>
          </div>
          <span
            className={cn(
              'shrink-0 text-muted transition-transform',
              showDiag && 'rotate-180',
            )}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </button>

        {showDiag && (
          <div className="mt-4 space-y-3">
            {diagErr && (
              <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {t('accounts.diagFail')}（{diagErr}）
              </div>
            )}

            {diag && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted">{t('accounts.diagHealth')}</dt>
                  <dd>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                        diag.health === 'ok'
                          ? 'bg-success/15 text-success'
                          : 'bg-danger/15 text-danger',
                      )}
                    >
                      {diag.health}
                    </span>
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted">{t('accounts.diagMode')}</dt>
                  <dd className="text-fg-strong">
                    {diag.api_mode === 'real' ? t('accounts.diagModeReal') : t('accounts.diagModeDummy')}
                  </dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted">{t('accounts.diagProxy')}</dt>
                  <dd className="text-fg-strong">{diag.proxy ?? t('accounts.diagProxyDirect')}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                  <dt className="text-muted">{t('accounts.diagPhase')}</dt>
                  <dd className="text-fg-strong">{diag.session_phase}</dd>
                </div>
              </dl>
            )}

            <div>
              <p className="mb-1.5 text-[11px] font-medium text-muted">
                {t('accounts.diagLogs')}
                {!diagBusy && diag ? ` (${diag.log_lines})` : ''}
              </p>
              <pre className="max-h-56 overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed text-fg-strong whitespace-pre-wrap">
                {diagLogs.length > 0 ? diagLogs.join('\n') : t('accounts.diagEmpty')}
              </pre>
            </div>

            <div className="flex justify-end">
              <Button size="sm" variant="outline" disabled={diagBusy} onClick={loadDiag}>
                {diagBusy ? t('accounts.diagLoad') : t('accounts.diagRefresh')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-muted">{t('accounts.note')}</p>
    </div>
  )
}