import { memo, useState } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import { useConnState, CONN_LABEL } from '../store/connState'
import { selectActiveSpeedLabel, selectHasActiveSpeed } from '../store/selectors'
import { fetchSources, fetchDownloads, health } from '../api/daemon'

/**
 * 底部状态栏的「调试」入口（D4.1：app 态下速度/任务态/错误追踪/接口调用完全不可追踪）。
 *
 * fd 没有等价面板，但 orig-hub 状态跨 3 进程（daemon / orig-tg / shell），
 * 出错时用户在 app 里**什么痕迹都看不到**——只有 console 里一行 logTgReason。
 * 这里把「接口调用可见」做成一个常驻入口：点开抽屉即拉 /api/sources、/api/activity、
 * /api/health 原始响应，外加连接态 / TG 服务态 / 聚合速度 / 最近错误与提示。
 *
 * 抽屉走右滑浮层（fixed right-0），不挤占 32px 高的状态栏本身。
 */

type RawState = 'idle' | 'loading' | 'ok' | 'error'

export const StatusBarDebug = memo(function StatusBarDebug() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<string>('')
  const [activity, setActivity] = useState<string>('')
  const [healthRaw, setHealthRaw] = useState<string>('')
  const [stateSources, setStateSources] = useState<RawState>('idle')
  const [stateActivity, setStateActivity] = useState<RawState>('idle')
  const [stateHealth, setStateHealth] = useState<RawState>('idle')
  const [errAll, setErrAll] = useState<string | null>(null)

  const connState = useConnState()
  const tgService = useStore((s) => s.tgService)
  const error = useStore((s) => s.error)
  const toast = useStore((s) => s.toast)
  const hasSpeed = useStore(selectHasActiveSpeed)
  const speedLabel = useStore(selectActiveSpeedLabel)

  const refresh = async () => {
    setErrAll(null)
    setStateSources('loading')
    setStateActivity('loading')
    setStateHealth('loading')
    const [s, a, h] = await Promise.allSettled([
      fetchSources().then((r) => JSON.stringify(r, null, 2)),
      fetchDownloads('all').then((r) => JSON.stringify(r, null, 2)),
      health().then((r) => JSON.stringify(r, null, 2)),
    ])
    if (s.status === 'fulfilled') {
      setSources(s.value)
      setStateSources('ok')
    } else {
      setSources(String(s.reason))
      setStateSources('error')
    }
    if (a.status === 'fulfilled') {
      setActivity(a.value)
      setStateActivity('ok')
    } else {
      setActivity(String(a.reason))
      setStateActivity('error')
    }
    if (h.status === 'fulfilled') {
      setHealthRaw(h.value)
      setStateHealth('ok')
    } else {
      setHealthRaw(String(h.reason))
      setStateHealth('error')
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          if (!open) void refresh()
        }}
        title={t('statusbar.debugTitle')}
        className="flex h-6 items-center gap-1 rounded border border-border-subtle px-1.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-strong"
        data-testid="statusbar-debug"
      >
        <span className="font-mono">{'</>'}</span>
        {t('statusbar.debug')}
      </button>

      {open && (
        <div className="fixed right-0 top-0 z-[60] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-border-subtle bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
            <span className="text-sm font-semibold text-fg-strong">{t('statusbar.debugTitle')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 text-[11px] text-muted hover:bg-surface-2"
              data-testid="statusbar-debug-close"
            >
              {t('statusbar.debugClose')}
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-auto p-3 text-[11px]">
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('statusbar.debugConn')} value={t(CONN_LABEL[connState])} />
              <Field
                label={t('statusbar.debugTg')}
                value={
                  tgService.running
                    ? `running:${tgService.port ?? '?'}`
                    : tgService.enabled
                      ? 'enabled/offline'
                      : 'disabled'
                }
              />
              <Field
                label={t('statusbar.debugSpeed')}
                value={hasSpeed ? speedLabel : '—'}
              />
              <Field
                label={t('statusbar.debugError')}
                value={error ?? '—'}
                danger
              />
            </div>
            <Field label={t('statusbar.debugToast')} value={toast ?? '—'} />
            {tgService.lastError && (
              <Field label="TG lastError" value={tgService.lastError} danger />
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="font-medium text-fg-mid">{t('statusbar.debugRaw')}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded border border-border-subtle px-2 py-0.5 text-[10px] text-fg-muted hover:bg-surface-2"
                data-testid="statusbar-debug-refresh"
              >
                {t('statusbar.debugRefresh')}
              </button>
            </div>

            <RawBlock label={t('statusbar.debugHealth')} state={stateHealth} text={healthRaw} />
            <RawBlock label={t('statusbar.debugSources')} state={stateSources} text={sources} />
            <RawBlock label={t('statusbar.debugActivity')} state={stateActivity} text={activity} />
            {errAll && <div className="text-[10px] text-danger">{errAll}</div>}
          </div>
        </div>
      )}
    </>
  )
})

function Field({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="min-w-0 rounded border border-border-subtle bg-background/40 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`truncate font-mono text-[11px] ${danger ? 'text-danger' : 'text-fg-strong'}`}>
        {value}
      </div>
    </div>
  )
}

function RawBlock({ label, state, text }: { label: string; state: RawState; text: string }) {
  const color =
    state === 'error' ? 'text-danger' : state === 'loading' ? 'text-muted' : 'text-fg-mid'
  return (
    <div className="min-w-0">
      <div className={`mb-0.5 text-[10px] ${color}`}>
        {label} · {state}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-border-subtle bg-background/40 p-2 font-mono text-[10px] text-fg-strong">
        {text || '—'}
      </pre>
    </div>
  )
}
