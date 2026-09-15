import { useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { useStore } from '../store/useStore'
import { useTranslation } from '../i18n'
import { getTgSession, startTgLogin, submitTgCode } from '../api/tg'
import type { TgSession } from '../types'

type LoginStep = 'idle' | 'phone' | 'code'

/**
 * 账号绑定中心（设置页「账号」标签）。
 * 当前仅 Telegram（orig-tg 独立服务），后续可扩展其他账号。
 * 登录为一步步状态机：手机号 → 验证码 → （可能）两步验证密码。
 * 绑定后 `setTgAccount({ bound: true })` 触发侧边栏出现「TG」Tab。
 */
export function AccountsPanel() {
  const { t } = useTranslation()
  const { accounts, setTgAccount, setError } = useStore()
  const tg = accounts.tg

  // 登录流程本地状态
  const [step, setStep] = useState<LoginStep>('idle')
  const [phone, setPhone] = useState(tg.phone ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<TgSession['phase']>()

  /** 第一步：请求发送验证码 */
  const handleRequestCode = async () => {
    const p = phone.trim()
    if (!p) return
    setBusy(true)
    try {
      await startTgLogin(p)
      const s = await getTgSession()
      setPhase(s?.phase)
      setStep('code')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 第二步：提交验证码 / 两步验证密码 */
  const handleSubmitCode = async () => {
    if (!code.trim()) return
    setBusy(true)
    try {
      const s = await submitTgCode(code.trim())
      if (s?.phase === 'PasswordRequired') {
        // 需要两步验证密码：复用验证码输入框，提示清空后输入密码
        setCode('')
        setPhase('PasswordRequired')
        return
      }
      setTgAccount({ bound: true, phone: phone.trim() })
      setStep('idle')
      setCode('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    setStep('idle')
    setCode('')
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
              <div className="flex items-center gap-2">
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
      <p className="text-[11px] leading-relaxed text-muted">{t('accounts.note')}</p>
    </div>
  )
}