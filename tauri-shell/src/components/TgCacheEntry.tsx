import { memo } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import type { IngestOverview } from '../domains/download/ingestGroups'

/**
 * 上下文栏右槽的「入库流水线」入口（缓存管理）。
 *
 * 形态（2026-10-17 用户终裁：「**只留入口按钮**」）：
 *   - **只有这一个按钮**：点它打开最初的「入库流水线」面板（`CacheManagerDialog`）。
 *     面板本体与功能**一个不删** —— 「简易」指的是入口，不是删面板能力。
 *   - **入口上挂简易状态**：在传 / 待处理 / 已缓存 三个小计数（用户原话）。
 *     数据来自 `MainLayout` 的**唯一** `useIngestGroups`（只读快照，本组件不自己拉
 *     —— BUG-082 三处同源纪律：徽标 / 树档 / 列表三处必须同源）。
 *   - **不挂跳转**（2026-10-17 续裁）：`下载状态` / `去媒体库查看` 都是**条目级**动作
 *     —— 「去媒体库查看」在面板里本就是**每行**的动作（`cache-task-golibrary`），
 *     依赖**该条目**的 `ref={chat}:{msg}` 坐标；搬到入口后它指向的是库根，
 *     已经不是同一件事（层级混淆）。它们只留在条目行上（面板每行 / 下载域行内），
 *     入口不重复一份。
 *
 * 原先它独占 `TgPanel` 顶部一整行 —— 1248x41 的容器里只放一个 89x28 的按钮，
 * 视觉上一整行被一个按钮占着。上移到上下文栏后与连接态/速度同一行，不再单独占行。
 *
 * 未授权/不可用时**照样显示**（沿用原判据）：缓存任务与缓存字节是本地数据，
 * TG 连不上时恰恰更需要查看与清理；只有真连不上服务（`running=false`）才隐藏。
 */
export interface TgCacheEntryProps {
  /** 入库概览（在传 / 待处理 / 已缓存）——只读快照，由单一轮询点下传 */
  overview?: IngestOverview
  /** 「取不到」原因（BUG-318）；非空时计数不可信，显示为不可用而不是假 0 */
  unavailable?: string | null
}

export const TgCacheEntry = memo(function TgCacheEntry({
  overview,
  unavailable,
}: TgCacheEntryProps) {
  const { t } = useTranslation()
  const up = useStore(
    // 服务层判据（BUG-178）：进程在不在只由 daemon 回答，前端不再自己探 orig-tg。
    (s) => s.tgService.running,
  )
  const open = useStore((s) => s.setTgCacheManagerOpen)

  if (!up) return null

  return (
    <button
      type="button"
      onClick={() => open(true)}
      title={t('tg.cacheManagerHint')}
      className="flex h-7 shrink-0 items-center gap-1 rounded border border-border-subtle px-2 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-strong"
      data-testid="tg-cache-manager-entry"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20 7.5 12 12 4 7.5m8 4.5v9M4 7.5C4 5.015 7.582 3 12 3s8 2.015 8 4.5M4 7.5v9C4 18.985 7.582 21 12 21s8-2.015 8-4.5v-9"
        />
      </svg>
      {t('tg.cacheManager')}
      {/* 简易状态（用户原话「在传 / 待处理 / 已缓存 的小计数」）：
          与主按钮同处一个可点区域 —— 点它同样打开面板，不新增第二个入口。 */}
      <span
        className="flex items-center gap-1.5 border-l border-border-subtle pl-1.5 text-[10px] tabular-nums"
        data-testid="tg-ingest-status"
      >
        {unavailable ? (
          <span className="text-muted" title={unavailable} data-testid="tg-ingest-unavailable">
            {t('tg.ingestUnavailable')}
          </span>
        ) : (
          <>
            <span title={t('tg.ingestActive')} data-testid="tg-ingest-active">
              {t('tg.ingestActive')} {overview?.active ?? 0}
            </span>
            <span title={t('tg.ingestPending')} data-testid="tg-ingest-pending">
              {t('tg.ingestPending')} {overview?.stalled ?? 0}
            </span>
            <span title={t('tg.ingestDone')} data-testid="tg-ingest-done">
              {t('tg.ingestDone')} {overview?.done ?? 0}
            </span>
          </>
        )}
      </span>
    </button>
  )
})
