import { ShareIcon } from './ShareIcon'
import { useTranslation } from '../../i18n'

/**
 * 共享域占位页（模块重整 M0 · BUG-298 / M0-T06）。
 *
 * **M0 只放一张说明卡**：D12=A（两级：服务开关 / 共享目标）与 D15=A（内容区
 * segmented）的完整实现在 M6（BUG-303）——受管绑定面、`/s/*` 只读路由、令牌鉴权
 * 都要先在 daemon 侧成立，前端提前做只会得到一个假界面。
 *
 * 硬约束（tasks.md 原文）：**无控件、无请求** —— 不放「开启」按钮（那会让用户以为
 * 点了有用），也不探测任何端点（M0 零后端改动）。
 */

export function SharePanel() {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid="share-panel">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 text-accent">
        <ShareIcon />
      </div>
      <h2 className="mt-4 text-base font-semibold text-fg-strong">{t('share.title')}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{t('share.comingSoon')}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-muted/80">{t('share.scopeHint')}</p>
    </div>
  )
}
