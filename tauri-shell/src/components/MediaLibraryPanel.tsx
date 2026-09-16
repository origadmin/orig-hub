import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { useTranslation } from '../i18n'
import {
  tgHealth,
  listTgStored,
  clearTgStored,
  downloadTgMessage,
  getTgConfig,
  setTgDownloadDir,
  tgFileUrl,
  tgLocalFileUrl,
  tgThumbUrl,
} from '../api/tg'
import { ensureTg } from '../api/tauri'
import { useStore } from '../store/useStore'
import type { TgStoredItem } from '../types'
import { fmtDuration, fmtSize, fmtTime, guessMediaType } from '../lib/tgmedia'

/**
 * 媒体库（v0.5.0 独立视图）：跨频道聚合的已缓存媒体（原 TgPanel「缓存库」整块迁出）。
 * 检索 + 相册聚合行 + 播放遮罩（本地流优先、在线流降级）+ 下载目录设置。
 */
export function MediaLibraryPanel() {
  const { t } = useTranslation()
  const { setError, openViewer } = useStore()

  // ---- 服务探活：APP 模式由 Tauri 壳托管拉起 ----
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

  const [items, setItems] = useState<TgStoredItem[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [hasMore, setHasMore] = useState(false)
  /** 整组缓存进度（键 g-频道-组，值 已完成/总数）与取消请求 */
  const [albumProgress, setAlbumProgress] = useState<Map<string, { done: number; total: number }>>(
    new Map(),
  )
  const cancelReqsRef = useRef<Set<string>>(new Set())
  /** 缓存中单条（供行内「缓存中」态判断） */
  const [downloading, setDownloading] = useState<Set<number>>(new Set())
  /** 下载目录弹窗 */
  const [dirOpen, setDirOpen] = useState(false)
  const [dlDir, setDlDir] = useState('')
  const [dlDirSaving, setDlDirSaving] = useState(false)

  // 播放器键盘导航（←/→/Esc）由 MediaViewer 组件自持，此处不再监听

  /** 聚合行：同频道同 groupId 聚合为相册行（组内按消息 id 升序），其余单条成行 */
  const rows = useMemo<{ key: string; items: TgStoredItem[] }[]>(() => {
    const map = new Map<string, TgStoredItem[]>()
    const order: string[] = []
    for (const it of items) {
      const k =
        it.groupId != null ? `g-${it.channelId}-${it.groupId}` : `s-${it.channelId}-${it.messageId}`
      if (!map.has(k)) {
        map.set(k, [])
        order.push(k)
      }
      map.get(k)!.push(it)
    }
    return order.map((k) => {
      const group = map.get(k)!
      if (group.length > 1) group.sort((a, b) => a.messageId - b.messageId)
      return { key: k, items: group }
    })
  }, [items])

  /** 归一化聚合行 → 全局播放器条目（本地流优先 + 在线降级；判型带扩展名兜底） */
  const toViewerItems = (group: TgStoredItem[]) =>
    group.map((x) => ({
      key: x.messageId,
      chatId: x.channelId,
      messageId: x.messageId,
      kind: x.type ?? guessMediaType(x.mimeType, x.filePath),
      caption: x.caption,
      src: tgLocalFileUrl(x.channelId, x.messageId),
      fallbackSrc: tgFileUrl(x.channelId, x.messageId),
    }))
  /** 播放器返回行标题：当前行 caption（无则 #id）· 频道名 */
  const viewerTitle = (group: TgStoredItem[]) => {
    const it = group[0]
    const cap = group.find((x) => x.caption?.trim())?.caption
    return (cap?.trim() || `#${it.messageId}`) + (it.channelTitle ? ` · ${it.channelTitle}` : '')
  }

  // 进入视图 / 搜索词变化（300ms 防抖）时重查第一页
  const fetchPage = useCallback(
    async (opts?: { beforeId?: number }) => {
      setLoading(true)
      try {
        const page = await listTgStored({
          q: search.trim() || undefined,
          downloaded: true,
          limit: 50,
          beforeId: opts?.beforeId,
        })
        setItems((prev) => (opts?.beforeId ? [...prev, ...page.items] : page.items))
        setHasMore(page.hasMore)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [search, setError],
  )

  useEffect(() => {
    if (!alive) return
    const h = setTimeout(() => void fetchPage(), items.length ? 300 : 0)
    return () => clearTimeout(h)
    // items.length 仅作防抖判断不触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, search, fetchPage])

  /** 加载更早一页（滚动到底部触发） */
  const loadOlder = useCallback(() => {
    if (loading || !hasMore || items.length === 0) return
    const oldest = items[items.length - 1]
    void fetchPage({ beforeId: oldest.messageId })
  }, [loading, hasMore, items, fetchPage])

  /** 下载（缓存）核心：置缓存中状态 → 调后端 → 错误映射 */
  const downloadCore = async (channelId: number, messageId: number, onDone?: () => void) => {
    setDownloading((s) => new Set(s).add(messageId))
    try {
      const { path } = await downloadTgMessage(channelId, messageId)
      onDone?.()
      return path
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      // 受保护内容/系统拒绝（Windows os error 5）→ 友好提示，不刷原始错误
      setError(/os error 5|拒绝访问|access denied/i.test(raw) ? t('tg.protectedMedia') : raw)
      return undefined
    } finally {
      setDownloading((s) => {
        const next = new Set(s)
        next.delete(messageId)
        return next
      })
    }
  }

  /** 单条缓存：成功后就地刷新该行状态 */
  const downloadOne = async (it: TgStoredItem): Promise<boolean> => {
    const path = await downloadCore(it.channelId, it.messageId, () => {
      setItems((prev) =>
        prev.map((p) =>
          p.channelId === it.channelId && p.messageId === it.messageId
            ? { ...p, downloaded: true, filePath: p.filePath ?? 'cached' }
            : p,
        ),
      )
    })
    return path !== undefined
  }

  /** 相册行整组缓存：只补未缓存项，进度 n 按组内总数计 */
  const downloadGroup = async (group: TgStoredItem[]) => {
    const key = `g-${group[0].channelId}-${group[0].groupId}`
    let done = group.filter((x) => x.downloaded).length
    setAlbumProgress((m) => new Map(m).set(key, { done, total: group.length }))
    try {
      for (const it of group) {
        if (cancelReqsRef.current.has(key)) break
        if (it.downloaded) continue
        const ok = await downloadOne(it)
        if (ok) done += 1
        setAlbumProgress((m) => new Map(m).set(key, { done, total: group.length }))
        if (!ok) break
      }
    } finally {
      cancelReqsRef.current.delete(key)
      setAlbumProgress((m) => {
        const next = new Map(m)
        next.delete(key)
        return next
      })
    }
  }

  /** 取消整组缓存：置取消标记，循环在下一条间隙停止 */
  const cancelAlbum = (key: string) => {
    cancelReqsRef.current.add(key)
  }

  /** 清除缓存行：逐条删落盘文件并复位状态，随后重查聚合视图刷新列表 */
  const clearRows = async (group: TgStoredItem[]) => {
    const done = group.filter((x) => x.downloaded)
    if (done.length === 0) return
    try {
      for (const it of done) {
        await clearTgStored(it.channelId, it.messageId)
      }
      await fetchPage()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 打开下载目录弹窗：拉当前生效目录 */
  const openDirDialog = useCallback(async () => {
    try {
      const cfg = await getTgConfig()
      setDlDir(cfg.downloadDir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setDirOpen(true)
  }, [setError])

  /** 保存下载目录（后端校验可创建并持久化，立即生效） */
  const saveDownloadDir = useCallback(async () => {
    setDlDirSaving(true)
    try {
      const cfg = await setTgDownloadDir(dlDir.trim())
      setDlDir(cfg.downloadDir)
      setDirOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDlDirSaving(false)
    }
  }, [dlDir, setError])

  return (
    <div className="flex h-full min-h-0 flex-1 bg-surface/20">
      {/* 左栏：标题 + 搜索 + 列表 */}
      <div className="flex w-[42%] min-w-[340px] max-w-[560px] shrink-0 flex-col border-r border-border-subtle/60">
      {/* 标题行：媒体库 + 下载目录 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
          ⬇ {t('tg.cachedLib')}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={() => void openDirDialog()}
        >
          ⌂ {t('tg.downloadDir')}
        </Button>
      </header>
      <div className="border-b border-border-subtle/60 px-3 pb-2 pt-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('tg.searchMedia')}
          className="h-8 text-xs"
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) loadOlder()
        }}
      >
        {!alive ? (
          <p className="px-2 py-6 text-center text-xs text-muted">{t('tg.serviceOffline')}</p>
        ) : loading && items.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">{t('tg.historyLoading')}</p>
        ) : items.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">{t('tg.emptyCached')}</p>
        ) : (
          rows.map((row) => {
            const group = row.items
            const it = group[0]
            const isGroup = group.length > 1
            const prog = isGroup
              ? albumProgress.get(`g-${it.channelId}-${it.groupId}`)
              : undefined
            const isBusy = isGroup ? Boolean(prog) : downloading.has(it.messageId)
            const typ = it.type ?? guessMediaType(it.mimeType, it.filePath)
            const thumbMsg =
              group.find((x) => {
                const tp = x.type ?? guessMediaType(x.mimeType, x.filePath)
                return tp === 'video' || tp === 'photo'
              }) ?? it
            const thumbTyp = thumbMsg.type ?? guessMediaType(thumbMsg.mimeType, thumbMsg.filePath)
            const dur = fmtDuration(thumbMsg.duration)
            const doneCount = group.filter((x) => x.downloaded).length
            const allDone = doneCount === group.length
            const caption = group.find((x) => x.caption?.trim())?.caption
            return (
              <div
                key={row.key}
                className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-surface-2/70"
              >
                {/* 缩略图（视频/照片）；音频/文件用图标；单击打开播放遮罩 */}
                <button
                  type="button"
                  onClick={() =>
                    openViewer({ title: viewerTitle(group), index: 0, items: toViewerItems(group) })
                  }
                  className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md bg-surface-2"
                >
                  {thumbTyp === 'photo' || thumbTyp === 'video' ? (
                    <img
                      src={tgThumbUrl(thumbMsg.channelId, thumbMsg.messageId)}
                      alt=""
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-base">
                      {thumbTyp === 'audio' ? '🎵' : '📄'}
                    </span>
                  )}
                  {dur && (
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] text-white">
                      {dur}
                    </span>
                  )}
                </button>
                {/* 标题 + 元信息：相册计数并入元信息行（纯文本，与按钮视觉分离） */}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-fg-strong">
                    {caption || `#${it.messageId}`}
                  </p>
                  <p className="truncate text-[10px] text-muted">
                    {isGroup && `${t('tg.albumN', { n: group.length })} · `}
                    {it.channelTitle ?? `#${it.channelId}`} ·{' '}
                    {fmtSize(group.reduce((s, x) => s + (x.size ?? 0), 0))} ·{' '}
                    {fmtTime(it.date ?? it.createdAt)}
                  </p>
                </div>
                {/* 状态即按钮：⬇缓存 → 缓存中(文字+取消) → ▶播放/▶查看/▶继续(n/N)；清除为固定次级项 */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {isBusy ? (
                    <>
                      <span className="text-[10px] text-muted">
                        {t('tg.cachingProgress', {
                          n: prog?.done ?? 0,
                          total: prog?.total ?? group.length,
                        })}
                      </span>
                      {isGroup && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => cancelAlbum(`g-${it.channelId}-${it.groupId}`)}
                        >
                          {t('tg.cancel')}
                        </Button>
                      )}
                    </>
                  ) : allDone ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() =>
                    openViewer({ title: viewerTitle(group), index: 0, items: toViewerItems(group) })
                  }
                      >
                        {isGroup || typ === 'video' || typ === 'audio'
                          ? t('tg.play')
                          : t('tg.view')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => void clearRows(group)}
                      >
                        {t('tg.clearRow')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() =>
                          isGroup ? void downloadGroup(group) : void downloadOne(it)
                        }
                      >
                        {doneCount > 0
                          ? `${t('tg.continue')} ${doneCount}/${group.length}`
                          : t('tg.download')}
                      </Button>
                      {doneCount > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => void clearRows(group)}
                        >
                          {t('tg.clearRow')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
      </div>

      {/* 右栏：提示区（播放交给全局播放器页，播放时整窗独占） */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <p className="max-w-xs text-center text-sm leading-relaxed text-muted">
            {t('tg.selectToPlay')}
          </p>
        </div>
      </div>

      {/* 下载目录弹窗：查看/修改缓存落地目录（持久化，立即生效） */}
      {dirOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          onClick={() => setDirOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-[13px] font-semibold text-fg-strong">⌂ {t('tg.downloadDir')}</h4>
            <p className="mt-1 text-[11px] text-muted">{t('tg.downloadDirTip')}</p>
            <Input
              value={dlDir}
              onChange={(e) => setDlDir(e.target.value)}
              className="mt-3 h-8 text-xs"
              spellCheck={false}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => setDirOpen(false)}>
                {t('tg.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 px-3 text-xs"
                disabled={dlDirSaving || !dlDir.trim()}
                onClick={() => void saveDownloadDir()}
              >
                {t('tg.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
