import { useEffect, useState } from 'react'
import { getSeries, type MediaSeriesDetail } from '../api/media'
import { cacheKey, cached, peek } from '../lib/fetchCache'

/**
 * 剧集详情（含分集列表）的**单一数据源**。
 *
 * 为什么不是每个组件各自 `getSeries`：同一个 id 有三个消费者 ——
 * 剧集墙里点开详情（`openSeries`）、点播放时把列表扩成整部剧集（`playItems`）、
 * 播放页侧栏（本 hook）。三处各拉一次，进一次剧集 + 点一次播放就发出 5 次
 * 完全相同的请求（实测：详情 2 次 + 播放 3 次，其中 2 次来自 React 严格模式
 * 下的 effect 双调用）。去重机制见 `lib/fetchCache`。
 */
export function loadSeriesDetail(id: number): Promise<MediaSeriesDetail> {
  return cached(cacheKey.seriesDetail(id), () => getSeries(id))
}

/** 同上，但同步取已缓存值（给首屏 state 用，避免先闪一次 loading）。 */
export function peekSeriesDetail(id: number): MediaSeriesDetail | undefined {
  return peek<MediaSeriesDetail>(cacheKey.seriesDetail(id))
}

/**
 * 按剧集 id 取详情（含分集列表），供播放页侧栏与「即将播放 第 N 集」共用。
 *
 * 数据来自 [`loadSeriesDetail`] 的共享缓存，因此「侧栏渲染」与「播放器标注」
 * 读到的必然是同一份，不会一个在 loading、一个已就绪。
 */
export function useSeriesDetail(seriesId: number | null | undefined) {
  const [detail, setDetail] = useState<MediaSeriesDetail | null>(() =>
    seriesId == null ? null : (peekSeriesDetail(seriesId) ?? null),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!seriesId) {
      setDetail(null)
      setLoading(false)
      setError(null)
      return
    }
    // 已缓存：同步取用，不发请求也不闪 loading（切集/返回时不会白一下）。
    const hit = peekSeriesDetail(seriesId)
    if (hit) {
      setDetail(hit)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    loadSeriesDetail(seriesId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [seriesId])

  return { detail, loading, error }
}

/** 分集按 季 → 集 排序（后端顺序不保证，展示需要稳定序） */
export function sortEpisodes<T extends { season?: number | null; episodeNo?: number | null }>(
  episodes: T[],
): T[] {
  return [...episodes].sort(
    (a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episodeNo ?? 0) - (b.episodeNo ?? 0),
  )
}
