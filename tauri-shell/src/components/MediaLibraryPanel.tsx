import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useTranslation } from '../i18n'
import { useStore } from '../store/useStore'
import { tgHealth } from '../api/tg'
import { ensureTg } from '../api/tauri'
import {
  deleteMediaItem,
  deleteEpisode,
  deleteSeries,
  getLibraryStats,
  getSeries,
  listMediaItems,
  listSeries,
  listTags,
  mediaItemUrl,
  patchMediaItem,
  patchSeries,
  setItemTags,
} from '../api/media'
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
import { AddToSeriesDialog, CreateSeriesDialog } from './media/SeriesDialog'
import { ItemEditDialog } from './media/ItemEditDialog'
import { fmtSize, isRawFileName } from '../lib/tgmedia'
import type { ViewerItem } from '../types'

type Tab = 'all' | MediaKind
type View = 'items' | 'series' | 'seriesDetail'

const PAGE = 120

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
  const { setError, openViewer } = useStore()

  // ---- 服务探活（媒体资料库与 TG 同进程；APP 模式由壳托管拉起）----
  const [alive, setAlive] = useState(false)
  useEffect(() => {
    const isTauri = '__TAURI_INTERNALS__' in window
    tgHealth()
      .then(() => setAlive(true))
      .catch(async () => {
        if (!isTauri) return
        try {
          await ensureTg()
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
  const [tags, setTags] = useState<MediaTag[]>([])
  const [detail, setDetail] = useState<MediaSeriesDetail | null>(null)
  const [loading, setLoading] = useState(false)

  // ---- 视图状态 ----
  const [tab, setTab] = useState<Tab>('all')
  const [view, setView] = useState<View>('items')
  const [activeSeriesId, setActiveSeriesId] = useState<number | null>(null)
  const [activeTagId, setActiveTagId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'oldest' | 'title' | 'duration' | 'size'>('recent')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // ---- 弹窗 ----
  const [importOpen, setImportOpen] = useState(false)
  const [tagMgrOpen, setTagMgrOpen] = useState(false)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [addToOpen, setAddToOpen] = useState(false)
  const [editing, setEditing] = useState<MediaItem | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ kind: 'items' | 'series'; id?: number } | null>(
    null,
  )

  // ---------- 加载 ----------
  const loadMeta = useCallback(async () => {
    try {
      const [s, tg, sr] = await Promise.all([getLibraryStats(), listTags(), listSeries()])
      setStats(s)
      setTags(tg)
      setSeries(sr)
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
      setSeries(await listSeries())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setError])

  useEffect(() => {
    if (!alive) return
    void loadMeta()
  }, [alive, loadMeta])

  useEffect(() => {
    if (!alive || view !== 'items') return
    const h = setTimeout(() => void loadItems(), 250)
    return () => clearTimeout(h)
  }, [alive, view, loadItems])

  const openSeries = useCallback(
    async (id: number) => {
      try {
        const d = await getSeries(id)
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
  const toViewerItems = (list: MediaItem[]): ViewerItem[] =>
    list.map((i) => ({
      key: `media-${i.id}`,
      chatId: 0,
      messageId: i.id,
      kind: i.kind,
      caption: i.title,
      src: mediaItemUrl(i.id),
      poster: i.poster ?? null,
      seriesId: i.seriesId ?? null,
    }))

  /** 分集 → 内容条目：剧集详情页入口与网格入口共用同一映射 */
  const episodesToItems = (d: MediaSeriesDetail): MediaItem[] =>
    d.episodes.map((e) => ({
      id: e.itemId,
      source: 'local',
      ref: String(e.itemId),
      // 原始文件名（photo--123_456）不是标题：留空交给展示层给可读占位。
      // 否则侧栏说「图片 1」而底部 caption 说「photo--1004418016251_2000」——同一实体两个名字。
      title: e.title || (isRawFileName(e.itemTitle) ? '' : e.itemTitle) || '',
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
  const playItems = async (list: MediaItem[], index: number, title?: string) => {
    if (list.length === 0) return
    const picked = list[index]
    const sid = picked?.seriesId
    if (sid) {
      try {
        const d = await getSeries(sid)
        const all = episodesToItems(d)
        const start = Math.max(0, all.findIndex((x) => x.id === picked.id))
        openViewer({ items: toViewerItems(all), index: start, title: d.title })
        return
      } catch {
        // 拉剧集失败不阻断播放：退回原列表
      }
    }
    openViewer({ items: toViewerItems(list), index, title })
  }

  const playEpisode = (index: number) => {
    if (!detail) return
    void playItems(episodesToItems(detail), Math.max(0, index), detail.title)
  }

  // ---------- 选择 ----------
  const toggleSelect = (id: number, _shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
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
    if (view === 'items') await loadItems()
    else if (view === 'series') await loadSeries()
    else if (view === 'seriesDetail' && activeSeriesId) await openSeries(activeSeriesId)
  }

  const doDeleteSelected = async () => {
    const ids = [...selected]
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

  const emptyState = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10">
      <p className="text-sm text-muted">{loading ? t('media.loading') : t('media.empty')}</p>
      {!loading && total === 0 ? (
        <>
          <p className="max-w-sm text-center text-[11px] leading-relaxed text-muted">
            {t('media.emptyHint')}
          </p>
          <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setImportOpen(true)}>
            {t('media.importDir')}
          </Button>
        </>
      ) : null}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-1 bg-surface/20">
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
          <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.sectionContent')}
          </p>
          {(
            [
              ['all', t('media.all'), stats?.items ?? 0],
              ['video', t('media.videos'), stats?.videos ?? 0],
              ['photo', t('media.photos'), stats?.photos ?? 0],
              ['audio', t('media.audios'), stats?.audios ?? 0],
            ] as [Tab, string, number][]
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              className={railBtn(view === 'items' && tab === key && activeTagId === null)}
              onClick={() => {
                setActiveTagId(null)
                switchTab(key)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 text-[10px] text-muted">{count}</span>
            </button>
          ))}

          <p className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.series')}
          </p>
          <button
            type="button"
            className={railBtn(view === 'series')}
            onClick={() => {
              setView('series')
              setDetail(null)
              setActiveTagId(null)
              clearSelection()
              void loadSeries()
            }}
          >
            <span className="min-w-0 flex-1 truncate">{t('media.allSeries')}</span>
            <span className="shrink-0 text-[10px] text-muted">{series.length}</span>
          </button>

          <p className="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted">
            {t('media.tags')}
          </p>
          <div className="flex flex-wrap gap-1 px-1">
            {tags.length === 0 ? (
              <p className="px-1 text-[10px] text-muted">—</p>
            ) : (
              tags.map((tag) => {
                const on = activeTagId === tag.id
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => {
                      setActiveTagId(on ? null : tag.id)
                      setView('items')
                      setDetail(null)
                      clearSelection()
                    }}
                    className={[
                      'rounded-full border px-2 py-0.5 text-[10.5px] transition-colors',
                      on ? 'text-white' : 'text-fg-strong hover:bg-surface-2',
                    ].join(' ')}
                    style={
                      on
                        ? { background: tag.color ?? '#64748b', borderColor: tag.color ?? '#64748b' }
                        : { borderColor: `${tag.color ?? '#64748b'}55` }
                    }
                  >
                    {tag.name}
                    <span className="ml-1 opacity-70">{tag.itemCount ?? 0}</span>
                  </button>
                )
              })
            )}
          </div>
        </nav>
      </aside>

      {/* ───────── 主区 ───────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 工具条 */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle/60 px-3 py-2">
          <div className="w-44 min-w-0">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('media.search')}
              className="h-7 text-xs"
            />
          </div>
          <select
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

          <div className="ml-auto flex items-center gap-1.5">
            {selected.size > 0 ? (
              <>
                <span className="mr-1 text-[11px] text-muted">
                  {t('media.selected', { n: selected.size })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
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
                <p className="text-sm text-muted">{t('media.noSeries')}</p>
                <Button size="sm" className="h-8 px-3 text-xs" onClick={() => setCreateOpen(true)}>
                  ＋ {t('media.newSeries')}
                </Button>
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
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {items.map((item, idx) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onSelectToggle={toggleSelect}
                    onOpen={() => void playItems(items, idx, item.title)}
                    onEdit={setEditing}
                    onPosterReady={onPosterReady}
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
              {confirmDelete.kind === 'items' ? t('media.confirmRemoveItems') : t('media.confirmDeleteSeries')}
            </h4>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
              {confirmDelete.kind === 'items'
                ? t('media.confirmRemoveItemsHint')
                : t('media.confirmDeleteSeriesHint')}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setConfirmDelete(null)}
              >
                {t('tg.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={async () => {
                  const k = confirmDelete
                  setConfirmDelete(null)
                  if (k.kind === 'items') await doDeleteSelected()
                  else if (k.id !== undefined) await doDeleteSeries(k.id)
                }}
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
