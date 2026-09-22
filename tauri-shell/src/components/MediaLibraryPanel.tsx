import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import {
  deleteMediaItem,
  deleteEpisode,
  deleteSeries,
  findMediaItemIdByRef,
  getLibraryStats,
  getMediaItem,
  listMediaItems,
  listSeries,
  listTags,
  mediaItemUrl,
  patchMediaItem,
  patchSeries,
  setItemTags,
} from '../api/media'
import { loadSeriesDetail } from '../hooks/useSeriesDetail'
import { cacheKey, cached, invalidateCache } from '../lib/fetchCache'
import type {
  LibraryStats,
  MediaItem,
  MediaKind,
  MediaSeries,
  MediaSeriesDetail,
  MediaTag,
} from '../api/media'
import { MediaCard } from './media/MediaCard'
import { SeriesCard, SeriesDetail } from './media/SeriesDetail'
import { ImportDialog } from './media/ImportDialog'
import { BulkTagDialog, TagManagerDialog } from './media/TagManagerDialog'
import { AddToSeriesDialog, CreateSeriesDialog, MergeSeriesDialog } from './media/SeriesDialog'
import { ItemEditDialog } from './media/ItemEditDialog'
import {
  fmtSize,
  isRawFileName,
  canRecacheFromSource,
  recacheFromSource,
  probeIngestBackend,
  ensureIngestBackend,
} from '../lib/mediaSources'
import type { ViewerItem } from '../types'

type Tab = 'all' | MediaKind
type View = 'items' | 'series' | 'seriesDetail'

const PAGE = 120

/**
 * 单个内容条目 → 播放项。
 *
 * 模块级（而非组件内箭头函数）：「去媒体库查看」的跳转焦点消费发生在 effect 里，
 * 闭包里若捕获每次渲染都新建的函数，effect 依赖要么漂移、要么只能靠禁用依赖来压住。
 * 与下面组件内的 `toViewerItems` 是同一份映射的两形态（单条 / 列表），不各写一套。
 */
function toViewerItem(i: MediaItem): ViewerItem {
  return {
    key: `media-${i.id}`,
    chatId: 0,
    messageId: i.id,
    kind: i.kind,
    caption: i.title,
    // 介绍单独下发：返回行显示标题、底部行显示介绍，两处不重复。
    description: i.description ?? null,
    src: mediaItemUrl(i.id),
    poster: i.poster ?? null,
    seriesId: i.seriesId ?? null,
  }
}

/**
 * 媒体资料库（v0.6.0）：**用户可管理的**内容目录，替代原先只读的 TG 缓存列表。
 *
 * 结构（对齐主流媒体站）：
 *   左栏 分类/剧集/标签导航 → 主区 海报墙（内容）或 剧集墙/剧集详情
 * 能力：本地目录导入、剧集（季/集）编排、标签交叉归类、图片（图集）管理、多选批量操作。
 * 播放统一交给全局播放器页（openViewer），不在本面板内嵌。
 */
export function MediaLibraryPanel() {
  const { t } = useTranslation()
  const { setError, openViewer, pendingMediaFocus, setPendingMediaFocus } = useStore()

  // ---- 服务探活（媒体资料库与 TG 同进程；APP 模式由壳托管拉起）----
  const [alive, setAlive] = useState(false)
  useEffect(() => {
    const isTauri = '__TAURI_INTERNALS__' in window
    probeIngestBackend()
      .then(() => setAlive(true))
      .catch(async () => {
        if (!isTauri) return
        try {
          await ensureIngestBackend()
          setAlive(true)
        } catch {
          setAlive(false)
        }
      })
  }, [])

  // ---- 数据 ----
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [series, setSeries] = useState<MediaSeries[]>([])
  /** 无条件剧集总数（「全部剧集」徽标）——与 `series` 分开：后者可能被标签筛过。 */
  const [seriesTotal, setSeriesTotal] = useState(0)
  const [tags, setTags] = useState<MediaTag[]>([])
  const [detail, setDetail] = useState<MediaSeriesDetail | null>(null)
  const [loading, setLoading] = useState(false)

  // ---- 视图状态 ----
  const [tab, setTab] = useState<Tab>('all')
  /** 落地视图 = 剧集墙：剧集是一级实体，内容挂在它下面（见左栏层级说明） */
  const [view, setView] = useState<View>('series')
  const [activeSeriesId, setActiveSeriesId] = useState<number | null>(null)
  const [activeTagId, setActiveTagId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'oldest' | 'title' | 'duration' | 'size'>('recent')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** 剧集收 video / photo（图片是浏览位内容）——全都不是 audio/未知类型才放行。 */
  const selectedJoinable =
    selected.size > 0 &&
    [...selected].every((id) => {
      const k = items.find((i) => i.id === id)?.kind
      return k === 'video' || k === 'photo'
    })

  // ---- 弹窗 ----
  const [importOpen, setImportOpen] = useState(false)
  const [tagMgrOpen, setTagMgrOpen] = useState(false)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [addToOpen, setAddToOpen] = useState(false)
  /** 「合并到…」对话框（把另一个剧集并入当前打开的剧集） */
  const [mergeOpen, setMergeOpen] = useState(false)
  const [editing, setEditing] = useState<MediaItem | null>(null)
  /**
   * 删除确认（唯一状态机，单条与批量共用）。
   *
   * `ids` 是**显式目标集**：卡片上的逐条删除与工具栏的批量删除走同一条确认路径，
   * 区别只在目标集从哪来 —— 避免两套删除流程各写一遍（BUG-057）。
   */
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: 'items' | 'series'
    id?: number
    ids?: number[]
  } | null>(null)

  // ---------- 加载 ----------
  const loadMeta = useCallback(async () => {
    try {
      // 剧集列表与「剧集墙」共用同一份缓存：徽标要的是**无条件总数**，
      // 但那是同一份数据 —— 各拉一次就是启动时两次相同请求（实测）。
      const [s, tg, sr] = await Promise.all([
        getLibraryStats(),
        listTags(),
        cached(cacheKey.seriesList(null), () => listSeries()),
      ])
      setStats(s)
      setTags(tg)
      // `series` 是**当前显示**的（可能被标签筛过），故这里只取无条件总数当徽标，
      // 不覆盖列表 —— 否则「按标签筛剧集」会被无条件结果冲掉。
      setSeriesTotal(sr.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setError])

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listMediaItems({
        kind: tab === 'all' ? '' : tab,
        q: search.trim() || undefined,
        tagId: activeTagId ?? undefined,
        unassigned: unassignedOnly,
        sort,
        limit: PAGE,
        offset: 0,
      })
      setItems(r.items)
      setTotal(r.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [tab, search, activeTagId, unassignedOnly, sort, setError])

  const loadSeries = useCallback(async () => {
    try {
      const list = await cached(cacheKey.seriesList(activeTagId), () => listSeries(activeTagId))
      setSeries(list)
      // 无筛选时「显示数 == 总数」，顺手校正徽标（新增/删除剧集后不必整页刷新）。
      if (activeTagId == null) setSeriesTotal(list.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [activeTagId, setError])

  useEffect(() => {
    if (!alive) return
    void loadMeta()
  }, [alive, loadMeta])

  useEffect(() => {
    if (!alive || view !== 'items') return
    const h = setTimeout(() => void loadItems(), 250)
    return () => clearTimeout(h)
  }, [alive, view, loadItems])

  // 剧集列表跟随标签筛选：`loadSeries` 依赖 `activeTagId`，故切换标签即自动重取。
  // 这让 TG 自动归档到剧集的 `#标签` 真正可用（此前标签只能筛「内容」，筛不到剧集）。
  useEffect(() => {
    if (!alive || view !== 'series') return
    void loadSeries()
  }, [alive, view, loadSeries])

  const openSeries = useCallback(
    async (id: number) => {
      try {
        const d = await loadSeriesDetail(id)
        setDetail(d)
        setActiveSeriesId(id)
        setView('seriesDetail')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [setError],
  )

  // ---------- 播放（交给全局播放器页）----------
  /** 内容条目 → 播放项；带 seriesId 的条目会让播放器挂出分集列表 */
  const toViewerItems = (list: MediaItem[]): ViewerItem[] => list.map(toViewerItem)

  /**
   * 分集 → 内容条目：剧集详情页入口与网格入口共用同一映射。
   *
   * 标题与介绍**直接取分集字段**：后端已把分集的 `title`/`description` 收敛为
   * 「它指向条目的那一份」（分集只表示位置）。这里不再做 `ep.title || ep.itemTitle`
   * 之类的兜底链 —— 那正是「同一个视频两个名字、介绍一边有一边空」的来源。
   */
  const episodesToItems = (d: MediaSeriesDetail): MediaItem[] =>
    d.episodes.map((e) => ({
      id: e.itemId,
      source: 'local',
      ref: String(e.itemId),
      // 原始文件名（photo--123_456）不是标题：留空交给展示层给可读占位。
      title: isRawFileName(e.title) ? '' : (e.title ?? ''),
      description: e.description ?? null,
      // **不**兜底成 'video'：后端对每条内容必下发 kind，兜底成视频会把图片静默当视频播
      // （正是「加入剧集后图片全被当视频」的成因之一）。未知类型归入 'file'，
      // 由播放器显示「不支持预览」——让异常可见，而不是伪装成可播内容。
      kind: (e.kind ?? 'file') as MediaKind,
      poster: e.poster,
      duration: e.duration,
      addedAt: 0,
      tags: [],
      seriesId: d.id,
      seriesTitle: d.title,
    }))

  /**
   * 打开一组条目。
   *
   * 关键：若选中项属于某个剧集，传入的列表必须扩成**整部剧集**。
   * 播放器右侧分集列表的点击是在这份列表内按 itemId 定位的，
   * 若只含一条，那些点击会全部落空（表现为「点了没反应」）。
   *
   * 注意这里传的是**全量**（图片 + 视频都含）：
   * 「播放序列只含同类内容」由 `MediaViewer` 按 kind 派生分组实现 ——
   * 点视频 → 组内只有视频（连着播）；点图片 → 组内只有图片（连着翻）。
   * **不要在这一层过滤**，否则侧栏会缺项，用户也无法从图片切回视频。
   */
  // `useCallback`：卡片 `memo` 化的前提（BUG-026）。依赖项只有 `openViewer`
  // —— 其余（`toViewerItems` / `episodesToItems` / `loadSeriesDetail`）都是纯函数或模块级导入。
  const playItems = useCallback(
    async (list: MediaItem[], index: number, title?: string) => {
      if (list.length === 0) return
      const picked = list[index]
      const sid = picked?.seriesId
      if (sid) {
        try {
          // 与剧集详情共用同一份缓存：这里刚看过的那部剧集不该再拉一次
          const d = await loadSeriesDetail(sid)
          const all = episodesToItems(d)
          const start = Math.max(0, all.findIndex((x) => x.id === picked.id))
          openViewer({ items: toViewerItems(all), index: start, title: d.title })
          return
        } catch {
          // 拉剧集失败不阻断播放：退回原列表
        }
      }
      openViewer({ items: toViewerItems(list), index, title })
    },
    [openViewer],
  )

  /** 卡片入口：按 item 定位序号（稳定引用，卡片 `memo` 才不会白做）。 */
  const openItem = useCallback(
    (item: MediaItem) => {
      const idx = items.findIndex((x) => x.id === item.id)
      void playItems(items, Math.max(0, idx), item.title)
    },
    [items, playItems],
  )
  /** 逐条删除入口（稳定引用，同上）。 */
  const deleteItem = useCallback((item: MediaItem) => {
    setConfirmDelete({ kind: 'items', ids: [item.id] })
  }, [])

  /**
   * 消费「入库流水线 → 媒体库」的跳转焦点（`pendingMediaFocus` = tg ref）。
   *
   * 流水线的「去媒体库查看」**先就地起播、再切视图**：播放器是全屏覆盖层，
   * 所以用户点下去的第一眼是成品在播；切过来时播放器若还在，这里就只清标记 ——
   * 再开一次等于把用户刚打开的那一次播放顶掉（关不掉的感觉就从这儿来）。
   * 播放器已关（或由别的路径带焦点进来）时才按 ref 重新起播。
   *
   * 按 ref 现查而不是在当前页列表里找：列表受分页与筛选限制，**不在当前页不等于
   * 不在库里**；在列表里找不到的分支若一直挂着标记，会在用户翻页时突然弹一次播放。
   */
  useEffect(() => {
    if (!pendingMediaFocus) return
    const ref = pendingMediaFocus
    setPendingMediaFocus(null)
    if (useStore.getState().viewer) return
    let alive = true
    void (async () => {
      try {
        const id = await findMediaItemIdByRef('tg', ref)
        if (!alive || id == null) return
        openViewer({ items: [toViewerItem(await getMediaItem(id))], index: 0 })
      } catch {
        /* 媒体库已在此处，查不到就停在库里，不弹错 */
      }
    })()
    return () => {
      alive = false
    }
  }, [pendingMediaFocus, openViewer, setPendingMediaFocus])

  const playEpisode = (index: number) => {
    if (!detail) return
    void playItems(episodesToItems(detail), Math.max(0, index), detail.title)
  }

  /**
   * 重新缓存（BUG-080）：条目被清掉字节后**原路取回**。
   *
   * 只有 TG 来源有「原路」——`ref` 里的 `chat:msg` 就是下载地址。本地导入的文件
   * 丢了就是丢了，给一个必然失败的入口不如如实标「文件已丢失」。
   */
  const recacheItem = useCallback(
    (item: MediaItem) => {
      if (!canRecacheFromSource(item.source)) return
      recacheFromSource(item.ref, item.source)
        .then(() => setError('已重新入队缓存，完成后字节会回到资料库'))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [setError],
  )

  // ---------- 选择 ----------
  // `useCallback`：卡片已 `memo` 化（BUG-026），回调每次渲染换新引用会让 memo 全落空。
  const toggleSelect = useCallback((id: number, _shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = () => setSelected(new Set())

  const visibleIds = useMemo(() => items.map((i) => i.id), [items])

  // ---------- 操作 ----------
  const onPosterReady = useCallback(
    (patch: { id: number; poster: string; duration?: number }) => {
      // 静默回写：失败不影响展示（内存里已有封面）
      void patchMediaItem(patch.id, {
        poster: patch.poster,
        duration: patch.duration,
      }).catch(() => undefined)
      setItems((prev) =>
        prev.map((i) =>
          i.id === patch.id
            ? { ...i, poster: patch.poster, duration: patch.duration ?? i.duration }
            : i,
        ),
      )
    },
    [],
  )

  const refreshAll = async () => {
    await loadMeta()
    // 写操作之后必须作废读缓存，否则会看着「刚改完的标题又变回去了」
    // （缓存里存的是改动前那一份，且它不会自己过期）。
    invalidateCache()
    if (view === 'items') await loadItems()
    else if (view === 'series') await loadSeries()
    else if (view === 'seriesDetail' && activeSeriesId) await openSeries(activeSeriesId)
  }

  /**
   * 删除指定条目 —— 单条与批量的**唯一执行路径**。
   *
   * 单条删除曾经不存在：只能「勾选一条 → 再去工具栏点移除」，选择态成了前置仪式。
   * 现在目标集由调用方给出（卡片传 `[id]`，工具栏传所选集合），执行链完全一致。
   */
  const doDeleteItems = async (ids: number[]) => {
    if (ids.length === 0) return
    try {
      for (const id of ids) await deleteMediaItem(id)
      clearSelection()
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doDeleteSeries = async (id: number) => {
    try {
      await deleteSeries(id)
      setView('series')
      setDetail(null)
      setActiveSeriesId(null)
      await refreshAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const switchTab = (next: Tab) => {
    setTab(next)
    setView('items')
    setDetail(null)
    clearSelection()
  }

  // ---------- 渲染 ----------
  const railBtn = (active: boolean) =>
    [
      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
      active
        ? 'bg-accent/10 font-medium text-accent'
        : 'text-fg-strong hover:bg-surface-2/70',
    ].join(' ')

  const clearFilters = useCallback(() => {
    setActiveTagId(null)
    setSearch('')
    setUnassignedOnly(false)
  }, [])

  // BUG-131：`activeTagId` 对 series 视图同样生效（`loadSeries` 消费它），故不加视图条件；
  // `unassignedOnly` 只在 items 视图渲染；`search` 只在 items 视图真正参与过滤 ——
  // 否则 series 视图会呈现「已过滤」的假象（显示「清除筛选」却没有过滤发生）。
  const filterActive =
    activeTagId !== null || (view === 'items' && search.trim() !== '') || unassignedOnly

  /**
   * 删除确认的目标集：卡片逐条 = `[id]`，工具栏批量 = 当前勾选。
   *
   * 用**显式集合**而不是「每次都读 selected」，同一套确认状态机才能服务两种入口
   * （单条删除不再是「大小为 1 的批量」，而是同一路径的另一种目标集来源）。
   */
  const confirmTargetIds =
    confirmDelete?.kind === 'items' ? (confirmDelete.ids ?? [...selected]) : []
  /**
   * 目标集里**已归入剧集**的条数。
   *
   * 删掉剧集的最后一集会让剧集变成空壳 —— 这是用户看不见的隐性状态，
   * 必须在按下确认**之前**报出来，而不是删完才发现少了个剧集。
   */
  const confirmGroupedCount = items.filter(
    (i) => confirmTargetIds.includes(i.id) && i.seriesTitle,
  ).length

  // 空态必须区分「库真的空」（引导导入）与「筛选无结果」（引导清筛选）——
  // 把后者渲染成"资料库是空的 + 导入目录"会误导用户以为数据丢了。
  // 判据用**库级统计** stats.items，不能用列表响应的 total：
  // total 是筛选后总数（标签筛空时为 0），会让"无匹配"伪装成"库空"。
  const libraryEmpty = (stats?.items ?? 0) === 0
  const emptyState = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10">
      {libraryEmpty ? (
        <>
          <p className="text-sm text-muted">{loading ? t('media.loading') : t('media.empty')}</p>
          {!loading && (
            <>
              <p className="max-w-sm text-center text-[11px] leading-relaxed text-muted">
                {t('media.emptyHint')}
              </p>
              <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setImportOpen(true)}>
                {t('media.importDir')}
              </Button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{t('media.noMatch')}</p>
          {filterActive && (
            <Button size="sm" variant="outline" className="h-8 px-3 text-xs" onClick={clearFilters}>
              {t('media.clearFilter')}
            </Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-surface/20">
      {/* ───────── 左栏导航 ───────── */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border-subtle/60">
        <div className="shrink-0 border-b border-border-subtle/60 px-3 py-2.5">
          <h3 className="truncate text-[13px] font-semibold text-fg-strong">🎬 {t('media.title')}</h3>
          {stats ? (
            <p className="mt-0.5 truncate text-[10px] text-muted">
              {stats.items} 项 · {fmtSize(stats.totalSize)}
            </p>
          ) : null}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {/*
           * 层级：**剧集 = 一级，内容 = 二级**（此前相反 —— 内容四个类型在最上，
           * 剧集只是并列的第二个分组，于是「库」的主语变成了散条目，剧集反而像筛选器）。
           *
           * 一级（剧集）：全部剧集 → 剧集墙；下列每个剧集直接进它的内容（二级）。
           * 二级（内容）：按类型看**全局内容**（含未归档散片）——这是「兜底视角」，
           *   故下沉到剧集之后，并用 `media.contentAll` 明确其范围。
           */}
          <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.series')}
          </p>
          <button
            type="button"
            className={railBtn(view === 'series' && activeTagId === null)}
            onClick={() => {
              setView('series')
              setDetail(null)
              // 只清筛选，重取交给跟随 `activeTagId` 的 effect —— 在此直接
              // `loadSeries()` 会用到本次 setState **之前**的旧 tagId（闭包快照），
              // 白跑一次被筛过的请求。
              setActiveTagId(null)
              clearSelection()
            }}
          >
            <span className="min-w-0 flex-1 truncate">{t('media.allSeries')}</span>
            <span className="shrink-0 text-[10px] text-muted">{seriesTotal}</span>
          </button>
          {series.length > 0 && (
            /* 剧集列表有界滚动：剧集可能很多，不能把下面「内容/标签」挤出可视区 */
            <div className="mt-0.5 max-h-72 space-y-0.5 overflow-y-auto">
              {series.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setActiveTagId(null)
                    clearSelection()
                    void openSeries(s.id)
                  }}
                  title={s.title}
                  className={railBtn(view === 'seriesDetail' && activeSeriesId === s.id)}
                >
                  <span className="min-w-0 flex-1 truncate pl-3">{s.title}</span>
                  <span className="shrink-0 text-[10px] text-muted">{s.episodeCount}</span>
                </button>
              ))}
            </div>
          )}

          <p className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.contentAll')}
          </p>
          {(() => {
            const all: [Tab, string, number][] = [
              ['all', t('media.all'), stats?.items ?? 0],
              ['video', t('media.videos'), stats?.videos ?? 0],
              ['photo', t('media.photos'), stats?.photos ?? 0],
              ['audio', t('media.audios'), stats?.audios ?? 0],
            ]
            const on = view === 'items' && activeTagId === null
            /*
             * 计数 0 的分类**不渲染**（BUG-068）：
             * 点它必然得到空列表 —— 渲染等于向用户承诺一个兑现不了的入口。
             * 例外：当前选中的那一项即使降为 0 也要留着，否则「选中态」在界面上
             * 消失，用户既看不到自己在筛什么、也没有可点的取消入口。
             */
            const visible = all.filter(([key, , count]) => count > 0 || (on && tab === key))
            if (visible.length === 0) {
              return <p className="px-2 text-[10px] text-muted">—</p>
            }
            return visible.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                data-testid={`media-cat-${key}`}
                className={railBtn(on && tab === key)}
                onClick={() => {
                  setActiveTagId(null)
                  switchTab(key)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted">{count}</span>
              </button>
            ))
          })()}

          <p className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.tags')}
          </p>
          <div className="flex flex-wrap gap-1 px-1" data-testid="media-tag-list">
            {(() => {
              /*
               * 标签 chip 的两条规则（BUG-068）：
               *
               * 1) **0 计数不渲染**。删除条目/剧集只清关联表、不 GC `media_tag` 行，
               *    于是每次删除都会留下一批 0/0 孤儿标签，越积越多 —— 界面上表现为
               *    「底部一大片全是 0」。孤儿在数据层无害，但**渲染它们等于给出一排
               *    点了必空的入口**，所以过滤放在渲染层。例外的只有当前选中项（同上）。
               *
               * 2) **当前侧的计数必须就是筛选结果的条数**。旧式 `itemCount + seriesCount`
               *    在内容侧把剧集挂载也算进去，而内容侧筛选只匹配条目 —— 显示 8、点开
               *    6 条。现在两侧各算各的（内容=itemCount，剧集=seriesCount），
               *    「显示的数 = 点下去得到的数」。
               */
              const seriesSide = view === 'series' || view === 'seriesDetail'
              const withCount = tags.map((tag) => ({
                tag,
                count: seriesSide ? (tag.seriesCount ?? 0) : (tag.itemCount ?? 0),
              }))
              const visible = withCount.filter(
                ({ tag, count }) => count > 0 || activeTagId === tag.id,
              )
              if (visible.length === 0) {
                return <p className="px-1 text-[10px] text-muted">—</p>
              }
              return visible.map(({ tag, count }) => {
                const on = activeTagId === tag.id
                const title = `${t('media.items')} ${tag.itemCount ?? 0} · ${t('media.series')} ${tag.seriesCount ?? 0}`
                return (
                  <button
                    key={tag.id}
                    type="button"
                    title={title}
                    data-testid={`media-tag-chip-${tag.id}`}
                    onClick={() => {
                      setActiveTagId(on ? null : tag.id)
                      if (!seriesSide) {
                        setView('items')
                      }
                      setDetail(null)
                      clearSelection()
                    }}
                    className={[
                      // 单行原语：`whitespace-nowrap` 禁折行、名称 `truncate`（需 min-w-0）
                      // 允许截断、计数 `shrink-0` 永不先被压掉、`max-w-full` 封顶不撑破容器。
                      'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] transition-colors',
                      on ? 'text-white' : 'text-fg-strong hover:bg-surface-2',
                    ].join(' ')}
                    style={
                      on
                        ? { background: tag.color ?? '#64748b', borderColor: tag.color ?? '#64748b' }
                        : { borderColor: `${tag.color ?? '#64748b'}55` }
                    }
                  >
                    <span className="min-w-0 truncate">{tag.name}</span>
                    <span className="shrink-0 tabular-nums opacity-70">{count}</span>
                  </button>
                )
              })
            })()}
          </div>
        </nav>
      </aside>

      {/* ───────── 主区 ───────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具条 */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle/60 px-3 py-2">
          {/* BUG-131：搜索与排序只对 items 视图生效，故只在 items 视图渲染 ——
              恒渲染但恒无效，等于控件在撒谎（同排「仅未归集」早已是这种守卫写法）。 */}
          {view === 'items' ? (
            <div className="w-44 min-w-0">
              <Input
                data-testid="media-search-input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('media.search')}
                className="h-7 text-xs"
              />
            </div>
          ) : null}
          {view === 'items' ? (
            <select
              data-testid="media-sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="h-7 rounded-md border border-border-subtle bg-surface px-2 text-[11px] text-fg-strong"
            >
              <option value="recent">{t('media.sortRecent')}</option>
              <option value="oldest">{t('media.sortOldest')}</option>
              <option value="title">{t('media.sortTitle')}</option>
              <option value="duration">{t('media.sortDuration')}</option>
              <option value="size">{t('media.sortSize')}</option>
            </select>
          ) : null}
          {view === 'items' ? (
            <label className="flex items-center gap-1 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={unassignedOnly}
                onChange={(e) => setUnassignedOnly(e.target.checked)}
                className="h-3 w-3"
              />
              {t('media.unassignedOnly')}
            </label>
          ) : null}

          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {selected.size > 0 ? (
              <>
                <span className="mr-1 text-[11px] text-muted">
                  {t('media.selected', { n: selected.size })}
                </span>
                {/* 剧集收 video / photo（图片入浏览位）。含 audio/未知类型时禁用（后端 422 兜底） */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={!selectedJoinable}
                  title={
                    selectedJoinable
                      ? undefined
                      : t('media.addToSeriesVideoOnly')
                  }
                  onClick={() => setAddToOpen(true)}
                >
                  {t('media.addToSeries')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setBulkTagOpen(true)}
                >
                  {t('media.bulkTag')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px] text-destructive"
                  onClick={() => setConfirmDelete({ kind: 'items' })}
                >
                  {t('media.remove')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={clearSelection}
                >
                  {t('media.clearSel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setSelected(new Set(visibleIds))
                  }}
                >
                  {t('media.selectAll')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setImportOpen(true)}
                >
                  ⬇ {t('media.importDir')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setCreateOpen(true)}
                >
                  ＋ {t('media.newSeries')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setTagMgrOpen(true)}
                >
                  🏷 {t('media.manageTags')}
                </Button>
              </>
            )}
          </div>
        </header>

        {/* 内容区 */}
        {!alive ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-10">
            <p className="text-sm text-muted">{t('media.offline')}</p>
          </div>
        ) : view === 'seriesDetail' && detail ? (
          <SeriesDetail
            detail={detail}
            tags={tags}
            onPlay={playEpisode}
            onRemoveEpisode={async (ep) => {
              try {
                await deleteEpisode(ep.id)
                if (activeSeriesId) await openSeries(activeSeriesId)
                await loadMeta()
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            }}
            onDeleteSeries={() => setConfirmDelete({ kind: 'series', id: detail.id })}
            onMerge={() => setMergeOpen(true)}
            onBack={() => {
              setView('series')
              setDetail(null)
              setActiveSeriesId(null)
              void loadSeries()
            }}
            onChanged={() => void refreshAll()}
            onError={(m) => setError(m)}
          />
        ) : view === 'series' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {series.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20">
                {filterActive ? (
                  <>
                    <p className="text-sm text-muted">{t('media.noMatch')}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-3 text-xs"
                      onClick={clearFilters}
                    >
                      {t('media.clearFilter')}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted">{t('media.noSeries')}</p>
                    <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setCreateOpen(true)}>
                      ＋ {t('media.newSeries')}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                {series.map((s) => (
                  <SeriesCard
                    key={s.id}
                    series={s}
                    tags={tags}
                    onOpen={() => void openSeries(s.id)}
                    onDelete={() => setConfirmDelete({ kind: 'series', id: s.id })}
                    onCoverReady={(id, poster) => {
                      void patchSeries(id, { poster }).catch(() => undefined)
                      setSeries((prev) =>
                        prev.map((x) => (x.id === id ? { ...x, poster } : x)),
                      )
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : items.length === 0 && !loading ? (
          emptyState
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div
                data-testid="media-grid"
                className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3"
              >
                {items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onSelectToggle={toggleSelect}
                    onOpen={openItem}
                    onEdit={setEditing}
                    // 逐条删除：目标集显式给 `[id]`，与工具栏批量走同一条确认路径
                    onDelete={deleteItem}
                    onPosterReady={onPosterReady}
                    // 无字节且来自 TG 时给「重新缓存」（BUG-080）
                    onRecache={recacheItem}
                  />
                ))}
              </div>
              {total > items.length ? (
                <p className="py-3 text-center text-[11px] text-muted">
                  {t('media.showing', { n: items.length, total })}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* ───────── 弹窗 ───────── */}
      {importOpen ? (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async (n) => {
            clearSelection()
            await refreshAll()
            setError(`已导入 ${n} 项`)
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {tagMgrOpen ? (
        <TagManagerDialog
          tags={tags}
          onClose={() => setTagMgrOpen(false)}
          onChanged={() => void loadMeta()}
          onError={(m) => setError(m)}
        />
      ) : null}

      {bulkTagOpen ? (
        <BulkTagDialog
          count={selected.size}
          tags={tags}
          onClose={() => setBulkTagOpen(false)}
          onApply={async (tagIds) => {
            for (const id of selected) await setItemTags(id, tagIds)
            clearSelection()
            await refreshAll()
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateSeriesDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            await refreshAll()
            void openSeries(id)
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {addToOpen ? (
        <AddToSeriesDialog
          itemIds={[...selected]}
          series={series}
          onClose={() => setAddToOpen(false)}
          onDone={async () => {
            clearSelection()
            await refreshAll()
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {mergeOpen && detail ? (
        <MergeSeriesDialog
          target={{ id: detail.id, title: detail.title, episodeCount: detail.episodeCount }}
          series={series}
          onClose={() => setMergeOpen(false)}
          onDone={async (res, sourceTitle) => {
            await refreshAll()
            if (activeSeriesId) await openSeries(activeSeriesId)
            // 跳过明细必须说出来：合并里唯一「少搬了东西」的地方，
            // 静默会让用户以为全搬完了（与「已导入 N 项」同一反馈位）。
            setError(
              res.skippedCount > 0
                ? `已把《${sourceTitle}》的 ${res.added} 集并入，${res.skippedCount} 集因已在剧中而跳过`
                : `已把《${sourceTitle}》的 ${res.added} 集并入`,
            )
          }}
          onError={(m) => setError(m)}
        />
      ) : null}

      {editing ? (
        <ItemEditDialog
          item={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={() => void refreshAll()}
          onError={(m) => setError(m)}
        />
      ) : null}

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-[13px] font-semibold text-fg-strong">
              {confirmDelete.kind === 'items'
                ? confirmTargetIds.length === 1
                  ? t('media.confirmRemoveOne')
                  : t('media.confirmRemoveItems')
                : t('media.confirmDeleteSeries')}
            </h4>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              {confirmDelete.kind === 'items'
                ? t('media.confirmRemoveItemsHint', { n: confirmTargetIds.length })
                : t('media.confirmDeleteSeriesHint')}
            </p>
            {/* 归属告知：删到最后一条会让剧集变空，这是用户看不见的隐性状态 */}
            {confirmDelete.kind === 'items' && confirmGroupedCount > 0 ? (
              <p
                className="mt-1.5 text-[11.5px] leading-relaxed text-amber-500"
                data-testid="confirm-grouped-warn"
              >
                {t('media.confirmGroupedWarn', { m: confirmGroupedCount })}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setConfirmDelete(null)}
                data-testid="media-confirm-no"
              >
                {t('tg.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={async () => {
                  const k = confirmDelete
                  setConfirmDelete(null)
                  if (k.kind === 'items') await doDeleteItems(k.ids ?? [...selected])
                  else if (k.id !== undefined) await doDeleteSeries(k.id)
                }}
                data-testid="media-confirm-yes"
              >
                {t('media.confirm')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
