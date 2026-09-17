import { useEffect, useState } from 'react'
import { getSeries, type MediaSeriesDetail } from '../api/media'

/**
 * 按剧集 id 取详情（含分集列表）。
 *
 * 为什么上提成独立 hook 而不是让侧栏组件自己拉：
 * 分集数据的消费者有两个 —— 侧栏的列表渲染，以及播放器的「即将播放 第 N 集」
 * 标注。两处各自请求会重复打接口，且状态可能不一致（一个在 loading、
 * 一个已就绪）。收敛到单一来源后，两个消费者读同一份数据。
 */
export function useSeriesDetail(seriesId: number | null | undefined) {
  const [detail, setDetail] = useState<MediaSeriesDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!seriesId) {
      setDetail(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getSeries(seriesId)
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
