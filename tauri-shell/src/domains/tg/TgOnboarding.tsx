import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { Button } from '../../components/ui/button'
import { copyToClipboard } from '../../lib/env'

/**
 * TG 采集域的引导空态（模块重整 M0 · BUG-298 / M0-T05）。
 *
 * **入口常驻（BUG-094 口径改变），引导进面板**：侧栏「TG 采集」不再按
 * `resolveTgFeatureReady` 隐藏，用户在任何状态下点进来都必须看到
 * 「为什么是空的 + 怎么修」，而不是一个空白面板把「没登录 / 没启用」
 * 伪装成「没有内容」。
 *
 * 各态与判据（全部取自 TgPanel 内既有原料，**不新增探测、不写第二份判据**
 * —— BUG-177）：
 *
 *   - `disabled`：`tgService.enabled === false` —— 用户主动关着插件。
 *     唯一出口是「启用 Telegram 采集」→ 设置·Telegram（`onEnable`）。
 *     附一行范围说明：打开后会发生什么、不会动什么（BUG-148：只在用户
 *     正因此受阻时出现）。
 *   - `daemonDown`（BUG-389）：`tgService.known === false` —— 连本地引擎
 *     （orig-daemon）都够不到，配置都没取回来。**这不是「正在启动」**：
 *     降级文案以前把「不可达」折叠成「正在启动」，用户等一辈子也等不到。
 *   - `pluginDown`（BUG-389）：`known && enabled && !running` —— 引擎在线，
 *     daemon 明确说 TG 插件没在跑；带 `lastError`（原文，可复制走诊断串）。
 *   - `starting`：`enabled && running` 但会话还没就绪（session 探针未通）——
 *     **只有这一态**允许写「正在启动」，因为它真的在启动。
 *   - `unbound`：服务在跑但没有登录会话（`tgUnbound`）。保留原有
 *     `tg-unbound-*` 文案与 `tg-unbound-guide` 锚点（既有验收脚本按它
 *     空态分流，改动会造假绿），唯一出口「去账号绑定」。
 *
 * 链路故障（`link_down`）**不走本组件**：那是 TgPanel 自己的红色故障卡，
 * 语义是「配好了但连不上」，与「没启用/没登录」不是一类事。
 *
 * BUG-389：三态（daemonDown / pluginDown / starting）都带**可复制的诊断串**
 * （与 BUG-384 同一落地方式），用户报障时不必再凭记忆描述「界面写了什么」。
 */
export type TgOnboardingMode = 'disabled' | 'starting' | 'unbound' | 'daemonDown' | 'pluginDown'

export function TgOnboarding({
  mode,
  onEnable,
  onBind,
  reasonKey,
  showReason,
  lastError,
  diag,
}: {
  mode: TgOnboardingMode
  /** 未启用态唯一出口：跳到设置·Telegram 打开插件 */
  onEnable?: () => void
  /** 未登录态唯一出口：跳到设置·账号绑定 */
  onBind?: () => void
  /** 分类降级后的原因 i18n 键（BUG-088：后端原文只进日志，不进 DOM） */
  reasonKey?: string | null
  showReason?: boolean
  /** 插件未运行时的最近一次拉起失败原因（BUG-389 态②；只作诊断串，不直出正文） */
  lastError?: string | null
  /** 可复制的诊断串（BUG-389：三态必备） */
  diag?: string
}) {
  const { t, language } = useTranslation()
  const [copied, setCopied] = useState(false)
  /**
   * BUG-389：本组文案在 locale 文件里还不存在（新增态需要新键）。
   * 按硬约束不改 `i18n/locales/**`，故就地内联中英两版；键名见交付报告
   * （`tg.onboardDaemonDownTitle` / `tg.onboardDaemonDownHint` /
   * `tg.onboardPluginDownTitle` / `tg.onboardPluginDownHint`）。
   */
  const tx = (zh: string, en: string) => (language === 'en-US' ? en : zh)

  const title =
    mode === 'disabled'
      ? t('tg.onboardDisabledTitle')
      : mode === 'daemonDown'
        ? tx('本地服务未运行', 'Local service is not running')
        : mode === 'pluginDown'
          ? tx('Telegram 插件未运行', 'Telegram plugin is not running')
          : mode === 'starting'
            ? t('tg.onboardStartingTitle')
            : t('tg.unboundTitle')
  const hint =
    mode === 'disabled'
      ? t('tg.onboardDisabledHint')
      : mode === 'daemonDown'
        ? tx(
            '连不上本地下载引擎（daemon），Telegram 采集无法启动。请重新启动应用；若仍不可用，检查引擎进程是否在运行。',
            'Cannot reach the local engine (daemon), so Telegram capture cannot start. Restart the app; if it persists, check that the engine process is running.',
          )
        : mode === 'pluginDown'
          ? tx(
              '引擎在线，但 Telegram 插件没有运行。daemon 会自动重新拉起；长时间未恢复时，可在「设置 → 通用」把 Telegram 插件关掉再打开。',
              'The engine is up but the Telegram plugin is not running. The daemon will restart it automatically; if it stays down, toggle the plugin off and on in Settings → General.',
            )
          : mode === 'starting'
            ? t('tg.onboardStartingHint')
            : t('tg.unboundHint')

  const testId =
    mode === 'disabled'
      ? 'tg-onboard-disabled'
      : mode === 'daemonDown'
        ? 'tg-onboard-daemon-down'
        : mode === 'pluginDown'
          ? 'tg-onboard-plugin-down'
          : mode === 'starting'
            ? 'tg-onboard-starting'
            : 'tg-unbound-guide'

  const copyDiag = async () => {
    if (!diag) return
    const ok = await copyToClipboard(diag)
    setCopied(ok)
    if (ok) window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      data-testid={testId}
      /* BUG-389：降级态本身是 DOM 事实（验收断 data-state，不断译后中文）。 */
      data-state={mode}
    >
      <div className="w-full max-w-md rounded-lg border border-border-subtle bg-surface/60 p-5">
        <h3 className="text-[14px] font-semibold text-fg-strong">{title}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{hint}</p>
        {mode === 'disabled' && (
          <p className="mt-2 text-[12px] leading-relaxed text-muted/80">{t('tg.onboardScope')}</p>
        )}
        {mode === 'unbound' && showReason && reasonKey && (
          <p className="mt-3 rounded-md bg-background px-2 py-1.5 text-[12px] leading-relaxed text-fg-mid">
            {t(reasonKey)}
          </p>
        )}
        {/* BUG-389：诊断串 —— 原文照抄（技术细节），但只是证据不是正文。 */}
        {diag && (mode === 'daemonDown' || mode === 'pluginDown' || mode === 'starting') && (
          <div className="mt-3 rounded-md bg-background px-2 py-1.5" data-testid="tg-onboard-diag">
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-fg-mid">
                {diag}
              </code>
              <button
                type="button"
                onClick={() => void copyDiag()}
                data-testid="tg-onboard-diag-copy"
                className="shrink-0 text-[12px] text-muted underline-offset-2 hover:text-fg-mid hover:underline"
              >
                {copied ? t('global.copied') : t('global.copyDiag')}
              </button>
            </div>
            {lastError ? (
              <p
                className="mt-1 break-all font-mono text-[12px] text-danger/90"
                data-testid="tg-onboard-last-error"
              >
                {lastError}
              </p>
            ) : null}
          </div>
        )}
        {mode === 'disabled' && (
          <div className="mt-5 flex gap-2">
            <Button
              size="sm"
              className="h-8 flex-1 text-xs"
              onClick={() => onEnable?.()}
              data-testid="tg-onboard-enable"
            >
              {t('tg.onboardDisabledAction')}
            </Button>
          </div>
        )}
        {mode === 'unbound' && (
          /*
           * 只留「去绑定」一个出口：**没有重连按钮**（BUG-178）。
           * 重启服务是 daemon 的职责，不是用户的手动项。
           */
          <div className="mt-5 flex gap-2">
            <Button
              size="sm"
              className="h-8 flex-1 text-xs"
              onClick={() => onBind?.()}
              data-testid="tg-onboard-bind"
            >
              {t('tg.unboundAction')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
