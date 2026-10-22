import type { DownloadStatusValue } from '../../types'
import type { DlFilter } from '../../nav'

/**
 * 下载域**引擎任务**的树档归属（单一真源，BUG-377）。
 *
 * 为什么要有这个文件：档位语义原先散落在两处各写一份 ——
 * `DownloadPanel` 里的 `engineRows` switch 决定**列表**显示谁，
 * `MainLayout` 里的 `downloads.filter(...)` 决定**侧栏徽标/状态栏**数谁。
 * 两处各写一份条件，改一处就分裂成「徽标 3、列表 0」这种假数据。
 * 现在两者共用本文件，判据 `verify_dl_buckets.mjs` 直接驱动这些纯函数。
 *
 * ## 「已暂停」档的语义 = **所有停止项**（2026-10-22 用户裁定）
 *
 * 用户原话：「全部下载 -> 已暂停没有看到暂停内容（失败、取消、错误），
 * **所有停止项都应该在里面**」。
 *
 * 旧实现只收 `status === 'paused'`，代价是 `error` / `cancelled` / `interrupted`
 * **任何档位都看不见**：不在「下载中」（它们不推进）、不在「已完成」（它们没成），
 * 「已暂停」又不收 ⇒ 用户观感就是「内容丢了」。而 BUG-314 已裁定「取消记录不设
 * 独立树档」（可见性由「全部」承担），所以停止项的家只能是这一档。
 *
 * 档位标签仍叫「已暂停」（用户没要求改名，最小改动）；语义是「非在传、非完成」。
 */

/** 在传：需要看进度。`idle` 是排队前的初态，同样属于「还没结束」。 */
export const ENGINE_ACTIVE: readonly DownloadStatusValue[] = ['downloading', 'queued', 'idle']

/**
 * 已停止：不推进、也不再产生进度 —— 全部收进「已暂停」档。
 *
 * `paused` 是用户主动停的，`error`/`interrupted` 是被动的，`cancelled` 是取消的；
 * 对用户而言都是「这条不在跑了，我要能看见它、能重试/删除」。
 */
export const ENGINE_STOPPED: readonly DownloadStatusValue[] = [
  'paused',
  'error',
  'cancelled',
  'interrupted',
]

/** 引擎任务是否属于该树档。 */
export function engineInBucket(status: DownloadStatusValue, f: DlFilter): boolean {
  switch (f) {
    case 'running':
      return ENGINE_ACTIVE.includes(status)
    case 'paused':
      return ENGINE_STOPPED.includes(status)
    case 'done':
      return status === 'completed'
    case 'all':
    default:
      // 未知状态也归「全部」：宁可多显示一条，也不能让它从所有视图里消失。
      return true
  }
}

/** 该档下的引擎任务行（列表与徽标共用，保证「数出来的 = 筛出来的」）。 */
export function engineRowsInBucket<T extends { status: DownloadStatusValue }>(
  items: readonly T[],
  f: DlFilter,
): T[] {
  return items.filter((d) => engineInBucket(d.status, f))
}

/** 该档下的引擎任务数（侧栏徽标 / 状态栏读数用）。 */
export function countEngineBucket<T extends { status: DownloadStatusValue }>(
  items: readonly T[],
  f: DlFilter,
): number {
  let n = 0
  for (const d of items) if (engineInBucket(d.status, f)) n += 1
  return n
}
