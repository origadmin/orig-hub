import { useCallback, useEffect, useRef, useState } from 'react'
import { findMediaItemIdByRef, getMediaItem, mediaItemUrl } from '../api/media'
import { useStore } from '../store/useStore'
import type { TgCacheTask, ViewerItem } from '../types'

/**
 * 「去媒体库查看」——入库流水线的**跨视图出口**（BUG-300 复报：下载域原先没有这个出口）。
 *
 * 缓存下来的字节就是媒体库条目的本体（`cache_one` → `mark_downloaded` →
 * `upsert_media_item(source="tg", ref="{chat}:{msg}")`，不存在第二份拷贝），所以
 * 一条入库记录的终点是媒体库里的成品，出口就该通向成品。
 *
 * ## 为什么是共享 hook 而不是各写一份
 *
 * 这个出口有**两个宿主**：缓存管理面板（`components/CacheManagerDialog.tsx`，原有）
 * 与下载域入库行（`domains/download/IngestGroupRow.tsx`，BUG-300 复报新增）。
 * 两侧各实现一遍，ref 约定（`source="tg"`、`"{chat}:{msg}"`）或 ViewerItem 形状
 * 任何一处漂移，就会变成一个宿主能跳、另一个跳错 —— 那是 BUG-082 同款的分裂。
 *
 * ## 行为契约（与缓存管理面板的原实现逐字一致）
 *
 * - 走 by-ref（`source="tg"`、`ref="{chat}:{msg}"`），不按 chat 全量筛 —— 后端
 *   `listMediaItems` 只支持 kind/q/tag/series，不为这个出口新增后端能力。
 * - 命中即**就地起播**（播放器是全屏覆盖层），再把焦点 ref 交给媒体库、切视图，
 *   于是关掉播放器后用户落在成品所在的库里；未命中就由宿主如实写「尚未入库」——
 *   「已入库」却跳不到成品，比不给出这个按钮更让人困惑。
 * - 同一个 ref 只问一次后端（`libRefCache`）：不做列表级 `source="tg"` 筛选，
 *   也不在每次渲染重查 —— by-ref 是幂等读，但十几行一起渲染就会变成十几个请求。
 * - `messageIds` 为空（老数据/下载侧投影）时**静默返回**：没有坐标就无从跳转，
 *   调用方应据此不渲染按钮（见 `hasLibraryLocator`）。
 */
export function useGoLibrary(opts: {
  /** 切到媒体库视图（MainLayout 的 `handleOpenMedia`）。宿主没给时只在本地起播，能力不消失。 */
  onOpenMedia?: () => void
  /** 失败上报（宿主各自渲染错误位） */
  onError?: (msg: string) => void
}) {
  const { openViewer, setPendingMediaFocus } = useStore()
  /** 已查过的 tg ref → 媒体库条目 id（`null` = 查过但不在库里）。 */
  const libRefCache = useRef<Map<string, number | null>>(new Map())
  /** 点过「去媒体库查看」但库里查不到成品的 ref：宿主据此行内如实写「尚未入库」。 */
  const [missRefs, setMissRefs] = useState<Set<string>>(() => new Set())
  const aliveRef = useRef(true)
  // 回调经 ref 间接引用：`goLibrary` 的 identity 因此只取决于 store 的两个恒定
  // 方法 —— 行组件是 memo 的，每次渲染拿到新引用就等于 memo 白做（AGENTS.md §5）。
  const cbRef = useRef(opts)
  cbRef.current = opts

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const goLibrary = useCallback(
    async (task: TgCacheTask) => {
      const msgId = task.messageIds[0]
      if (msgId == null) return
      const ref = `${task.chatId}:${msgId}`
      let id = libRefCache.current.get(ref)
      if (id === undefined) {
        try {
          id = await findMediaItemIdByRef('tg', ref)
        } catch {
          id = null
        }
        libRefCache.current.set(ref, id)
      }
      if (!aliveRef.current) return
      if (id == null) {
        setMissRefs((prev) => (prev.has(ref) ? prev : new Set(prev).add(ref)))
        return
      }
      try {
        const item = await getMediaItem(id)
        if (!aliveRef.current) return
        const viewerItem: ViewerItem = {
          key: `media-${item.id}`,
          chatId: 0,
          messageId: item.id,
          kind: item.kind,
          caption: item.title,
          description: item.description ?? null,
          src: mediaItemUrl(item.id),
          poster: item.poster ?? null,
          seriesId: item.seriesId ?? null,
          // BUG-253：真源总时长随条目下发，播放器据此显示正确总数。
          duration: item.duration,
        }
        setPendingMediaFocus(ref)
        openViewer({ items: [viewerItem], index: 0, title: item.title || undefined })
        cbRef.current.onOpenMedia?.()
      } catch (e) {
        if (aliveRef.current) {
          cbRef.current.onError?.(e instanceof Error ? e.message : String(e))
        }
      }
    },
    [openViewer, setPendingMediaFocus],
  )

  return { goLibrary, missRefs }
}

/**
 * 该任务有没有可跳转的媒体库坐标。
 *
 * `chatId` 为 0 = daemon 聚合层明确标注的「无 TG 频道」（下载侧投影或 orig-tg 老数据），
 * 不是合法频道；`messageIds` 空 = 连消息号都没有。两者缺一就无法拼出
 * `ref="{chat}:{msg}"` —— 此时**不渲染按钮**，而不是渲染一个点了没反应的出口。
 */
export function hasLibraryLocator(task: TgCacheTask): boolean {
  return task.chatId !== 0 && task.messageIds.length > 0
}
