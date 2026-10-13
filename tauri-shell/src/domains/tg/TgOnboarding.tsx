import { useTranslation } from '../../i18n'
import { Button } from '../../components/ui/button'

/**
 * TG 采集域的引导空态（模块重整 M0 · BUG-298 / M0-T05）。
 *
 * **入口常驻（BUG-094 口径改变），引导进面板**：侧栏「TG 采集」不再按
 * `resolveTgFeatureReady` 隐藏，用户在任何状态下点进来都必须看到
 * 「为什么是空的 + 怎么修」，而不是一个空白面板把「没登录 / 没启用」
 * 伪装成「没有内容」。
 *
 * 三种态与判据（全部取自 TgPanel 内既有原料，**不新增探测、不写第二份判据**
 * —— BUG-177）：
 *
 *   - `disabled`：`tgService.enabled === false` —— 用户主动关着插件。
 *     唯一出口是「启用 Telegram 采集」→ 设置·Telegram（`onEnable`）。
 *     附一行范围说明：打开后会发生什么、不会动什么（BUG-148：只在用户
 *     正因此受阻时出现）。
 *   - `starting`：`enabled && !running` —— daemon 正在拉起 orig-tg。
 *     **故意不给按钮**：拉起/重启归 daemon 独占（BUG-178），手动重试
 *     入口曾经造出「TG 进程两个主人互相 kill」，一条都不留。
 *   - `unbound`：服务在跑但没有登录会话（`tgUnbound`）。保留原有
 *     `tg-unbound-*` 文案与 `tg-unbound-guide` 锚点（既有验收脚本按它
 *     空态分流，改动会造假绿），唯一出口「去账号绑定」。
 *
 * 链路故障（`link_down`）**不走本组件**：那是 TgPanel 自己的红色故障卡，
 * 语义是「配好了但连不上」，与「没启用/没登录」不是一类事。
 */
export type TgOnboardingMode = 'disabled' | 'starting' | 'unbound'

export function TgOnboarding({
  mode,
  onEnable,
  onBind,
  reasonKey,
  showReason,
}: {
  mode: TgOnboardingMode
  /** 未启用态唯一出口：跳到设置·Telegram 打开插件 */
  onEnable?: () => void
  /** 未登录态唯一出口：跳到设置·账号绑定 */
  onBind?: () => void
  /** 分类降级后的原因 i18n 键（BUG-088：后端原文只进日志，不进 DOM） */
  reasonKey?: string | null
  showReason?: boolean
}) {
  const { t } = useTranslation()

  const title =
    mode === 'disabled'
      ? t('tg.onboardDisabledTitle')
      : mode === 'starting'
        ? t('tg.onboardStartingTitle')
        : t('tg.unboundTitle')
  const hint =
    mode === 'disabled'
      ? t('tg.onboardDisabledHint')
      : mode === 'starting'
        ? t('tg.onboardStartingHint')
        : t('tg.unboundHint')

  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      data-testid={
        mode === 'disabled'
          ? 'tg-onboard-disabled'
          : mode === 'starting'
            ? 'tg-onboard-starting'
            : 'tg-unbound-guide'
      }
    >
      <div className="w-full max-w-md rounded-lg border border-border-subtle bg-surface/60 p-5">
        <h3 className="text-[14px] font-semibold text-fg-strong">{title}</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">{hint}</p>
        {mode === 'disabled' && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted/80">{t('tg.onboardScope')}</p>
        )}
        {mode === 'unbound' && showReason && reasonKey && (
          <p className="mt-3 rounded-md bg-background px-2 py-1.5 text-[11px] leading-relaxed text-fg-mid">
            {t(reasonKey)}
          </p>
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
