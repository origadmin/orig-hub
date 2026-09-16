import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import {
  tgHealth,
  listTgDialogs,
  listTgMonitoredChannels,
  addTgMonitoredChannel,
  removeTgMonitoredChannel,
  listTgMonitorMessages,
  listTgMessages,
  listTgDownloaded,
  syncTgMonitor,
  downloadTgMessage,
  tgFileUrl,
  tgLocalFileUrl,
  tgThumbUrl,
} from '../api/tg'
import type { TgChannel, TgMediaItem, TgMonitoredChannel, TgStoredMessage } from '../types'
import { ensureTg, tgSaveConfig } from '../api/tauri'
import { useStore } from '../store/useStore'
import { fmtDuration, fmtSize, fmtTime, guessMediaType, type MediaType } from '../lib/tgmedia'

/** 未分组的内部键（避免与真实分组标题冲突） */
const UNGROUPED = '__ungrouped__'
/** 「全部订阅」分组的内部键 */
const ALL_KEY = '__all__'
/** 右栏媒体历史每页条数 */
const PAGE_SIZE = 30

/** 右栏统一消息视图模型（监控本地消息与在线消息共同映射） */
interface FeedItem {
  key: string
  chatId: number
  messageId: number
  caption?: string
  mimeType?: string
  size?: number
  type: MediaType
  /** TG 原始发布时间（Unix 秒） */
  date?: number
  /** 媒体时长（秒；视频/音频才有，v0.4.1） */
  duration?: number
  /** TG 相册分组 ID（grouped_id；同组相邻消息聚合为一个相册气泡，v0.4.2） */
  groupId?: number
  downloaded?: boolean
}

/** 中栏频道视图行（监控本地记录与订阅缓存共用） */
interface MiddleChannel {
  id: number
  title: string
  username?: string
  folder?: string
}

/**
 * 状态角标（v0.4.4）：与 outline 操作按钮完全同构（rounded-md / h-6 / 边框），
 * 取代 rounded-full 药丸 Badge —— 消除「药丸角标 × 方角按钮」混排的割裂感。
 */
function Chip({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'muted' | 'accent' | 'success'
  children: ReactNode
  className?: string
}) {
  const toneCls =
    tone === 'accent'
      ? 'border-accent/30 text-accent'
      : tone === 'success'
        ? 'border-success/40 text-success'
        : 'border-border-subtle text-fg-mid'
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center rounded-md border px-2 text-[10px] leading-none',
        toneCls,
        className,
      )}
    >
      {children}
    </span>
  )
}

function fromStored(m: TgStoredMessage): FeedItem {
  return {
    key: `s-${m.channelId}-${m.messageId}`,
    chatId: m.channelId,
    messageId: m.messageId,
    caption: m.caption,
    mimeType: m.mimeType,
    size: m.size,
    type: m.type ?? guessMediaType(m.mimeType),
    date: m.date ?? m.createdAt,
    duration: m.duration,
    groupId: m.groupId,
    downloaded: m.downloaded,
  }
}

function fromLive(chatId: number, m: TgMediaItem): FeedItem {
  return {
    key: `l-${chatId}-${m.id}`,
    chatId,
    messageId: m.id,
    caption: m.caption,
    mimeType: m.mimeType,
    size: m.size,
    type: m.type ?? guessMediaType(m.mimeType),
    date: m.date,
    duration: m.duration,
    groupId: m.groupId,
  }
}

/**
 * 相册聚合（v0.4.2）：把相邻且同 (chatId, groupId) 的消息合并为一个相册单元。
 * feed 为旧→新顺序；无 groupId 的消息（历史旧行/单条媒体）各自成单元。
 */
function groupAlbums(feed: FeedItem[]): FeedItem[][] {
  const units: FeedItem[][] = []
  let cur: FeedItem[] = []
  let curKey: string | null = null
  const flush = () => {
    if (cur.length) units.push(cur)
    cur = []
  }
  for (const it of feed) {
    const k = it.groupId != null ? `${it.chatId}:${it.groupId}` : null
    if (k !== null && k === curKey) {
      cur.push(it)
    } else {
      flush()
      cur = [it]
      curKey = k
    }
  }
  flush()
  return units
}

/**
 * TG 频道内容（orig-tg 独立服务，v0.4.0 两栏）。
 * 第一栏上段：监控列表（本地真列表，点击 → 第二栏显示内容，✕ 移除）；
 * 第一栏下段：分组（全部订阅/未分组/自定义分组）→ 组内频道列表 → ＋添加监控；
 * 第二栏：聊天式媒体流（最新在底部，滚到顶按 beforeId 加载更早历史）。
 * 关系链：分组 → 组内列表 → 添加 → 监控列表 → 显示。
 */
export function TgPanel() {
  const { t } = useTranslation()
  const { setError } = useStore()
  const [alive, setAlive] = useState(false)
  const [channels, setChannels] = useState<TgChannel[]>([])
  const [scanning, setScanning] = useState(false)
  const [monitoredList, setMonitoredList] = useState<TgMonitoredChannel[]>([])
  /** 第二列当前显示的分组（分组模式键；null = 内容模式：显示选中监控频道的内容） */
  const [groupMode, setGroupMode] = useState<string | null>(null)
  /** 监控列表折叠状态（默认展开） */
  const [monitorOpen, setMonitorOpen] = useState(true)
  /** 第二列是否处于内容详情模式（true=内容；false=分组列表/空态） */
  const [detail, setDetail] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const [feed, setFeed] = useState<FeedItem[]>([])
  const [feedLoading, setFeedLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  const [syncing, setSyncing] = useState(false)
  const [downloading, setDownloading] = useState<Set<number>>(new Set())
  const [downloadedPaths, setDownloadedPaths] = useState<Map<string, string>>(new Map())
  /** 相册整组缓存进度（键：a-内容流组，值：已完成/总数，v0.4.2；缓存库组进度归 MediaLibraryPanel） */
  const [albumProgress, setAlbumProgress] = useState<Map<string, { done: number; total: number }>>(
    new Map(),
  )
  /** 整组缓存取消请求：逐条间隙检查，命中即停止后续条目（当前条由服务端完成） */
  const cancelReqsRef = useRef<Set<string>>(new Set())
  /** 原图/组内浏览遮罩：unit 为相册组（单条自成一组），index 为当前浏览位置 */
  const [lightbox, setLightbox] = useState<{ unit: FeedItem[]; index: number } | null>(null)

  /** 倍速状态：lightbox 自持；视频重挂载后经 onLoadedMetadata 回填 */
  const [lbRate, setLbRate] = useState(1)
  const lbVideoRef = useRef<HTMLVideoElement | null>(null)
  /** 本地+在线双降级仍失败（如 .mov 浏览器不可解码）→ 遮罩内显示可读提示而非黑屏 */
  const [lbFailed, setLbFailed] = useState(false)
  useEffect(() => {
    if (lbVideoRef.current) lbVideoRef.current.playbackRate = lbRate
  }, [lbRate, lightbox])
  // 切换浏览对象时复位解码失败提示
  useEffect(() => setLbFailed(false), [lightbox])
  /** APP 首启配置（api_id/api_hash 由壳持久化，未配置时显示配置卡） */
  const [needConfig, setNeedConfig] = useState(false)
  const [cfgId, setCfgId] = useState('')
  const [cfgHash, setCfgHash] = useState('')
  const [cfgProxy, setCfgProxy] = useState('socks5://127.0.0.1:7897')
  const [savingCfg, setSavingCfg] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** 首屏/切频道后需要滚到底部 */
  const stickBottomRef = useRef(false)
  /** prepend 历史前的 scrollHeight，用于锚定滚动位置防跳 */
  const prependAnchorRef = useRef<number | null>(null)
  /** 当前 feed 的数据源（loadOlder 闭包内读取，避免陈旧闭包） */
  const feedSourceRef = useRef<{ chatId: number; monitored: boolean } | null>(null)

  // ---- 服务探活：APP 模式由 Tauri 壳托管拉起；未配置凭证时出配置卡 ----
  useEffect(() => {
    const isTauri = '__TAURI_INTERNALS__' in window
    tgHealth()
      .then(() => setAlive(true))
      .catch(async () => {
        if (!isTauri) {
          setAlive(false)
          return
        }
        try {
          await ensureTg()
          setAlive(true)
        } catch {
          setAlive(false)
          // 未配置（壳返回 not-configured）或拉起失败 → 显示 APP 内配置表单
          setNeedConfig(true)
        }
      })
  }, [])

  /** 保存 Telegram 配置并启动服务（壳负责持久化 + 拉起 sidecar） */
  const saveSetup = useCallback(async () => {
    setSavingCfg(true)
    try {
      await tgSaveConfig(cfgId.trim(), cfgHash.trim(), cfgProxy.trim())
      setNeedConfig(false)
      setAlive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingCfg(false)
    }
  }, [cfgId, cfgHash, cfgProxy, setError])

  // ---- 订阅频道：缓存优先；refresh=true 触发后台全量扫描（不清缓存） ----
  const fetchDialogs = useCallback(
    async (refresh: boolean) => {
      try {
        // 后端单页上限 200，必须循环翻页拉全（否则「全部订阅/分组」只剩前 200 频道）。
        const merged = new Map<number, TgChannel>()
        let offset = 0
        let scanning = false
        for (let page = 0; page < 10; page++) {
          const r = await listTgDialogs({ limit: 200, offset, refresh })
          for (const ch of r.items) merged.set(ch.id, ch)
          scanning = Boolean(r.scanning)
          if (!r.hasMore || r.items.length === 0) break
          offset += r.items.length
        }
        setChannels((prev) => {
          const map = new Map<number, TgChannel>()
          for (const ch of prev) map.set(ch.id, ch)
          for (const ch of merged.values()) map.set(ch.id, ch)
          return [...map.values()]
        })
        setScanning(scanning)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [setError],
  )

  useEffect(() => {
    if (!alive) return
    // 首屏强制触发一次后台扫描：修复旧缓存中 folder 为 NULL 的历史数据。
    fetchDialogs(true)
    listTgMonitoredChannels()
      .then(setMonitoredList)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [alive, fetchDialogs, setError])

  // 扫描中轮询（2.5s），直到后端扫描结束。
  useEffect(() => {
    if (!scanning) return
    const h = setTimeout(() => {
      void fetchDialogs(false)
    }, 2500)
    return () => clearTimeout(h)
  }, [scanning, fetchDialogs, channels.length])

  const monitoredSet = useMemo(
    () => new Set(monitoredList.map((c) => c.channelId)),
    [monitoredList],
  )

  // ---- 左栏分组派生（folder 字段来自后端 folders 映射，id 空间已统一） ----
  const folderGroups = useMemo(() => {
    const map = new Map<string, number>()
    for (const ch of channels) {
      if (ch.folder) map.set(ch.folder, (map.get(ch.folder) ?? 0) + 1)
    }
    return [...map.entries()].map(([title, count]) => ({ title, count }))
  }, [channels])

  const ungroupedCount = useMemo(() => channels.filter((c) => !c.folder).length, [channels])

  // ---- 第一栏上段：监控列表（本地真列表，不受网络影响） ----
  const monitoredRows = useMemo<MiddleChannel[]>(
    () =>
      monitoredList.map((m) => ({
        id: m.channelId,
        title: m.title,
        username: m.username,
      })),
    [monitoredList],
  )

  // ---- 第一栏下段：分组手风琴（全部订阅/未分组/自定义分组，仅用于添加监控） ----
  const groupSections = useMemo(
    () => [
      { key: ALL_KEY, title: t('tg.navAll'), count: channels.length },
      { key: UNGROUPED, title: t('tg.ungrouped'), count: ungroupedCount },
      ...folderGroups.map((g) => ({ key: `f:${g.title}`, title: g.title, count: g.count })),
    ],
    [t, channels.length, ungroupedCount, folderGroups],
  )

  const groupChannels = useMemo<MiddleChannel[]>(() => {
    if (groupMode === null) return []
    const base =
      groupMode === ALL_KEY
        ? channels
        : groupMode === UNGROUPED
          ? channels.filter((c) => !c.folder)
          : channels.filter((c) => c.folder === groupMode.slice(2))
    const q = search.trim().toLowerCase()
    if (q === '') return base
    return base.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.username ?? '').toLowerCase().includes(q),
    )
  }, [groupMode, channels, search])

  const activeGroup = useMemo(
    () => (groupMode === null ? undefined : groupSections.find((s) => s.key === groupMode)),
    [groupMode, groupSections],
  )

  // 默认选中：仅初始无选中时落到第一个监控频道；用户从分组点进的未监控频道不被重置。
  useEffect(() => {
    if (selectedId === null) setSelectedId(monitoredRows[0]?.id ?? null)
  }, [monitoredRows, selectedId])

  const selectedMonitored = selectedId !== null && monitoredSet.has(selectedId)
  const selectedChannel = useMemo(
    () =>
      selectedId === null
        ? undefined
        : (monitoredRows.find((c) => c.id === selectedId) ??
          channels.find((c) => c.id === selectedId)),
    [selectedId, monitoredRows, channels],
  )

  /**
   * 缓存状态统一（v0.4.3）：按频道拉 DB 已缓存快照合并进 downloadedPaths。
   * DB 为唯一真相源——feed/翻页后合并，刷新后状态准确；未监控频道（在线流）
   * 也能正确显示缓存状态。快照中不存在的条目会移除（另一视图清除后同步回退）。
   */
  const applyStoredSnapshot = useCallback(
    async (chatId: number, monitored: boolean, msgs: (TgStoredMessage | TgMediaItem)[]) => {
      try {
        const dl = await listTgDownloaded(chatId)
        setDownloadedPaths((prev) => {
          const m = new Map(prev)
          for (const it of msgs) {
            const msgId = monitored ? (it as TgStoredMessage).messageId : (it as TgMediaItem).id
            const key = monitored
              ? `s-${(it as TgStoredMessage).channelId}-${msgId}`
              : `l-${chatId}-${msgId}`
            const p = dl[String(msgId)]
            if (p) m.set(key, p)
            else m.delete(key)
          }
          return m
        })
      } catch {
        // 快照失败不阻塞浏览，保持现状
      }
    },
    [],
  )

  // ---- 右栏：首屏/切频道/监控状态变化时重新加载首页（最新在底） ----
  // v0.4.3：分组内订阅频道可直接点进内容页（在线流浏览）；监控频道仍走本地真列表。
  useEffect(() => {
    if (selectedId === null) {
      setFeed([])
      setHasMore(false)
      feedSourceRef.current = null
      return
    }
    const chatId = selectedId
    const monitored = monitoredSet.has(chatId)
    feedSourceRef.current = { chatId, monitored }
    let cancelled = false
    setFeedLoading(true)
    setFeed([])
    setHasMore(true)
    stickBottomRef.current = true
    void (async () => {
      try {
        if (monitored) {
          const page = await listTgMonitorMessages(chatId, { limit: PAGE_SIZE })
          if (cancelled) return
          setFeed(page.items.map(fromStored).reverse())
          setHasMore(page.hasMore)
          void applyStoredSnapshot(chatId, true, page.items)
        } else {
          const page = await listTgMessages(chatId, { limit: PAGE_SIZE })
          if (cancelled) return
          setFeed(page.items.map((m) => fromLive(chatId, m)).reverse())
          setHasMore(page.hasMore)
          void applyStoredSnapshot(chatId, false, page.items)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setFeedLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // monitoredSet 身份随监控列表变化，增删监控后自动重载
  }, [selectedId, monitoredSet, setError, applyStoredSnapshot])

  // 滚到底 / prepend 锚定（在 DOM 更新后同步执行，避免闪烁）。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stickBottomRef.current && !feedLoading) {
      el.scrollTop = el.scrollHeight
      stickBottomRef.current = false
    }
    if (prependAnchorRef.current !== null) {
      const prev = prependAnchorRef.current
      el.scrollTop = el.scrollHeight - prev
      prependAnchorRef.current = null
    }
  }, [feed, feedLoading])

  /** 滚到顶部：按当前最旧消息 id 加载更早一页并 prepend */
  const loadOlder = useCallback(async () => {
    const src = feedSourceRef.current
    if (!src || loadingOlder || !hasMore || feed.length === 0) return
    setLoadingOlder(true)
    prependAnchorRef.current = scrollRef.current?.scrollHeight ?? 0
    const oldest = feed[0].messageId
    try {
      if (src.monitored) {
        const page = await listTgMonitorMessages(src.chatId, {
          limit: PAGE_SIZE,
          beforeId: oldest,
        })
        const older = page.items.map(fromStored).reverse()
        setFeed((prev) => mergeFeed(older, prev))
        setHasMore(page.hasMore)
        void applyStoredSnapshot(src.chatId, true, page.items)
      } else {
        const page = await listTgMessages(src.chatId, {
          limit: PAGE_SIZE,
          beforeId: oldest,
        })
        const older = page.items.map((m) => fromLive(src.chatId, m)).reverse()
        setFeed((prev) => mergeFeed(older, prev))
        setHasMore(page.hasMore)
        void applyStoredSnapshot(src.chatId, false, page.items)
      }
    } catch (e) {
      prependAnchorRef.current = null
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingOlder(false)
    }
  }, [feed, loadingOlder, hasMore, setError, applyStoredSnapshot])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop < 40) void loadOlder()
  }, [loadOlder])

  // ---- 内容流相册聚合：相邻同 groupId 的消息合并为一个相册气泡（v0.4.2） ----
  const albumUnits = useMemo(() => groupAlbums(feed), [feed])

  // lightbox 键盘导航：←/→ 组内切换，Esc 关闭（v0.4.2 相册浏览）
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setLightbox((s) => (s && s.index > 0 ? { ...s, index: s.index - 1 } : s))
      } else if (e.key === 'ArrowRight') {
        setLightbox((s) => (s && s.index < s.unit.length - 1 ? { ...s, index: s.index + 1 } : s))
      } else if (e.key === 'Escape') {
        setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // ---- 监控增删（本地乐观更新 + 后端持久化） ----
  const refreshMonitored = useCallback(async () => {
    try {
      setMonitoredList(await listTgMonitoredChannels())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setError])

  const addMonitor = async (ch: MiddleChannel) => {
    try {
      await addTgMonitoredChannel({ channelId: ch.id, title: ch.title, username: ch.username })
      await refreshMonitored()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeMonitor = async (id: number) => {
    try {
      await removeTgMonitoredChannel(id)
      await refreshMonitored()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await syncTgMonitor()
      if (selectedId !== null) {
        stickBottomRef.current = true
        if (selectedMonitored) {
          const page = await listTgMonitorMessages(selectedId, { limit: PAGE_SIZE })
          setFeed(page.items.map(fromStored).reverse())
          setHasMore(page.hasMore)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const doDownload = async (item: FeedItem) => {
    const path = await downloadCore(item.chatId, item.messageId)
    if (path) setDownloadedPaths((prev) => new Map(prev).set(item.key, path))
  }

  /** 下载（缓存）核心：置缓存中状态 → 调后端 → 错误映射；成功后 onDone 回调 */
  const downloadCore = async (chatId: number, messageId: number, onDone?: () => void) => {
    setDownloading((s) => new Set(s).add(messageId))
    try {
      const { path } = await downloadTgMessage(chatId, messageId)
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

  /** 相册整组缓存（v0.4.2）：按组内顺序逐条缓存，进度「缓存中 n/N」；单条失败即中止（错误已提示） */
  const downloadAlbum = async (items: FeedItem[]) => {
    const key = `a-${items[0].chatId}-${items[0].groupId}`
    setAlbumProgress((m) => new Map(m).set(key, { done: 0, total: items.length }))
    try {
      for (let i = 0; i < items.length; i++) {
        if (cancelReqsRef.current.has(key)) break
        const it = items[i]
        const path = await downloadCore(it.chatId, it.messageId)
        if (!path) break
        setDownloadedPaths((prev) => new Map(prev).set(it.key, path))
        setFeed((prev) => prev.map((f) => (f.key === it.key ? { ...f, downloaded: true } : f)))
        setAlbumProgress((m) => new Map(m).set(key, { done: i + 1, total: items.length }))
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

  /** 取消整组缓存：置取消标记，循环在下一条间隙停止（当前条由服务端自然完成） */
  const cancelAlbum = (key: string) => {
    cancelReqsRef.current.add(key)
  }

  /** 用系统默认播放器打开已下载文件（Tauri 壳内；浏览器调试环境静默失败） */
  const openDownloaded = async (item: FeedItem) => {
    const path = downloadedPaths.get(item.key)
    if (!path) return
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(path)
    } catch (e) {
      console.error('openPath failed', e)
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      {needConfig && !alive ? (
        /* APP 首启：Telegram 凭证配置（保存后由 Tauri 壳持久化并拉起服务） */
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-5">
            <h3 className="text-[14px] font-semibold text-fg-strong">ⓘ {t('tg.setup')}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{t('tg.setupTip')}</p>
            <label className="mt-4 block text-[11px] text-muted">{t('tg.setupApiId')}</label>
            <Input value={cfgId} onChange={(e) => setCfgId(e.target.value)} className="mt-1 h-8 text-xs" spellCheck={false} />
            <label className="mt-3 block text-[11px] text-muted">{t('tg.setupApiHash')}</label>
            <Input value={cfgHash} onChange={(e) => setCfgHash(e.target.value)} className="mt-1 h-8 text-xs" spellCheck={false} />
            <label className="mt-3 block text-[11px] text-muted">{t('tg.setupProxy')}</label>
            <Input value={cfgProxy} onChange={(e) => setCfgProxy(e.target.value)} className="mt-1 h-8 text-xs" spellCheck={false} />
            <Button
              size="sm"
              className="mt-5 h-8 w-full text-xs"
              disabled={savingCfg || !cfgId.trim() || !cfgHash.trim()}
              onClick={() => void saveSetup()}
            >
              {savingCfg ? t('tg.setupStarting') : t('tg.setupStart')}
            </Button>
          </div>
        </div>
      ) : (
        <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-surface/30">
        {/* 上段：监控列表（本地真列表，点击 → 第二列显示内容；标题行可折叠/展开） */}
        <div className="flex items-center justify-between border-b border-border-subtle/60 px-3 py-2">
          <button
            onClick={() => setMonitorOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <span className="w-3 shrink-0 text-[10px] text-muted">{monitorOpen ? '▾' : '▸'}</span>
            <h3 className="truncate text-[13px] font-semibold text-fg-strong">
              ⭐ {t('tg.navMonitor')} ({monitoredList.length})
            </h3>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={doSync}
            disabled={syncing || monitoredList.length === 0}
          >
            {syncing ? t('tg.syncing') : t('tg.sync')}
          </Button>
        </div>

        {/* 监控行（离线也可读：本地存储的监控列表；随标题行折叠/展开） */}
        {monitorOpen && (
          <div className="max-h-56 shrink-0 overflow-y-auto border-b border-border-subtle/60 p-1.5">
            {monitoredRows.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted">{t('tg.monitorEmpty')}</p>
            ) : (
              monitoredRows.map((ch) => {
                const active = selectedId === ch.id
                return (
                  <div
                    key={ch.id}
                    className={cn(
                      'group flex items-center gap-1 rounded-md pr-1 transition-colors',
                      active ? 'bg-accent/10' : 'hover:bg-surface-2/70',
                    )}
                  >
                    <button
                      onClick={() => {
                        setDetail(true)
                        setSelectedId(ch.id)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg-mid">
                        {(ch.title || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-fg-strong">
                          {ch.title}
                        </p>
                        {ch.username && (
                          <p className="truncate text-[10px] text-muted">@{ch.username}</p>
                        )}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-1.5 text-[10px] text-muted hover:text-danger"
                      onClick={() => void removeMonitor(ch.id)}
                      title={t('tg.unmonitor')}
                    >
                      ✕
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        )}

        {/* 下段：分组列表（点击 → 第二列切换为组内频道列表，进行添加/取消监控） */}
        <div className="flex items-center justify-between px-3 pb-1 pt-2">
          <h3 className="text-[12px] font-semibold text-fg-strong">{t('tg.addMonitor')}</h3>
          {scanning ? (
            <span className="flex items-center gap-1.5 px-1 text-[10px] text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              {t('tg.scanning')}
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => void fetchDialogs(true)}
              disabled={!alive}
            >
              {t('tg.refresh')}
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {groupSections.map((sec) => {
            const active = groupMode === sec.key
            return (
              <button
                key={sec.key}
                onClick={() => {
                  setGroupMode(sec.key)
                  setDetail(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                  active
                    ? 'bg-accent/10 font-medium text-fg-strong'
                    : 'text-fg-mid hover:bg-surface-2/70',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{sec.title}</span>
                <span className="shrink-0 text-[10px] text-muted">{sec.count}</span>
              </button>
            )
          })}
        </div>

      </aside>

      {/* ===== 第二列：分组模式=组内频道列表 / 内容模式=聊天式媒体流（最新在底部） ===== */}
      <section className="flex min-w-0 flex-1 flex-col bg-surface/20">
        {!detail && groupMode !== null && activeGroup ? (
          <>
            {/* 分组模式：组内频道列表（仅添加/取消监控，不浏览内容） */}
            <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
                {activeGroup.title} ({activeGroup.count})
              </h3>
            </header>
            <div className="border-b border-border-subtle/60 px-3 pb-2 pt-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('tg.searchPlaceholder')}
                className="h-8 text-xs"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {groupChannels.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted">
                  {scanning ? t('tg.scanning') : t('tg.emptyGroup')}
                </p>
              ) : (
                groupChannels.map((ch) => {
                  const isMon = monitoredSet.has(ch.id)
                  return (
                    <div
                      key={ch.id}
                      className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-surface-2/70"
                    >
                      {/* 点击频道名直接进内容页（有返回按钮兜底，不怕迷路）；开关仍只管监控 */}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(ch.id)
                          setDetail(true)
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg-mid">
                          {(ch.title || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-fg-strong">
                            {ch.title}
                          </p>
                          {ch.username && (
                            <p className="truncate text-[10px] text-muted">@{ch.username}</p>
                          )}
                        </div>
                      </button>
                      <Switch
                        checked={isMon}
                        onChange={(v) => (v ? void addMonitor(ch) : void removeMonitor(ch.id))}
                      />
                    </div>
                  )
                })
              )}
            </div>
          </>
        ) : selectedChannel ? (
          <>
            {/* 频道标题栏 */}
            <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle/60 px-4 py-2.5">
              {groupMode !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={() => setDetail(false)}
                >
                  ← {t('tg.backToFeed')}
                </Button>
              )}
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold text-fg-mid">
                {(selectedChannel.title || '?').charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-fg-strong">
                  {selectedChannel.title}
                </p>
                {selectedChannel.username && (
                  <p className="truncate text-[10px] text-muted">
                    @{selectedChannel.username}
                  </p>
                )}
              </div>
              {selectedMonitored ? (
                <Chip tone="success">{t('tg.monitoring')}</Chip>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => void addMonitor(selectedChannel)}
                >
                  {t('tg.addMonitor')}
                </Button>
              )}
            </header>

            {/* 消息流（滚动容器） */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
            >
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                {/* 顶部：历史加载状态 */}
                <div className="flex h-6 items-center justify-center">
                  {loadingOlder ? (
                    <span className="text-[11px] text-muted">{t('tg.historyOlder')}</span>
                  ) : feed.length > 0 && !hasMore ? (
                    <span className="text-[11px] text-muted">{t('tg.historyNoMore')}</span>
                  ) : null}
                </div>

                {feedLoading ? (
                  <p className="py-10 text-center text-sm text-muted">{t('tg.historyLoading')}</p>
                ) : feed.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">{t('tg.historyEmpty')}</p>
                ) : (
                  albumUnits.map((unit) =>
                    unit.length === 1 ? (
                      <MessageBubble
                        key={unit[0].key}
                        item={unit[0]}
                        downloading={downloading.has(unit[0].messageId)}
                        downloadedPath={downloadedPaths.get(unit[0].key)}
                        onDownload={() => void doDownload(unit[0])}
                        onOpenDownloaded={() => void openDownloaded(unit[0])}
                        onPreview={() => setLightbox({ unit, index: 0 })}
                      />
                    ) : (
                      <AlbumBubble
                        key={`album-${unit[0].key}`}
                        items={unit}
                        downloadedCount={
                          unit.filter((x) => x.downloaded || downloadedPaths.has(x.key)).length
                        }
                        progress={albumProgress.get(`a-${unit[0].chatId}-${unit[0].groupId}`)}
                        onDownload={() => void downloadAlbum(unit)}
                        onCancel={() => cancelAlbum(`a-${unit[0].chatId}-${unit[0].groupId}`)}
                        onPreview={(index) => setLightbox({ unit, index })}
                      />
                    ),
                  )
                )}
                <div className="h-2 shrink-0" />
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <p className="max-w-xs text-center text-sm leading-relaxed text-muted">
              {!alive ? t('tg.offline') : t('tg.selectChannel')}
            </p>
          </div>
        )}
      </section>


      {/* 原图/相册组内浏览遮罩（v0.4.2）：多元素时 ‹ › 切换 + n/N 计数，←/→ 键盘导航；
          v0.4.4 固定 ✕ 关闭按钮（全屏遮罩必须始终有可见退出，不能只靠点背景） */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-6"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            aria-label={t('tg.close')}
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20"
          >
            ✕
          </button>
          {(() => {
            const cur = lightbox.unit[lightbox.index]
            const many = lightbox.unit.length > 1
            const local = downloadedPaths.get(cur.key)
            return (
              <div className="flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
                <div className="relative flex items-center justify-center">
                  {(cur.type === 'video' || cur.type === 'audio') && (
                    <PlaybackSpeed rate={lbRate} onRate={setLbRate} />
                  )}
                  {many && lightbox.index > 0 && (
                    <button
                      type="button"
                      onClick={() => setLightbox((s) => (s ? { ...s, index: s.index - 1 } : s))}
                      className="absolute -left-14 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20"
                    >
                      ‹
                    </button>
                  )}
                  {cur.type === 'video' || cur.type === 'audio' ? (
                    <video
                      key={cur.key}
                      ref={lbVideoRef}
                      src={
                        local
                          ? tgLocalFileUrl(cur.chatId, cur.messageId)
                          : tgFileUrl(cur.chatId, cur.messageId)
                      }
                      controls
                      autoPlay
                      preload="auto"
                      onLoadedMetadata={(e) => {
                        e.currentTarget.playbackRate = lbRate
                      }}
                      className="max-h-[78vh] max-w-[80vw] rounded-lg bg-black"
                      onError={(e) => {
                        const v = e.currentTarget
                        if (local && !v.dataset.fallback) {
                          v.dataset.fallback = '1'
                          v.src = tgFileUrl(cur.chatId, cur.messageId)
                        } else {
                          // 本地+在线双失败（如 .mov 容器浏览器不可解码）→ 露出可读提示
                          setLbFailed(true)
                        }
                      }}
                    />
                  ) : (
                    <img
                      key={cur.key}
                      src={tgFileUrl(cur.chatId, cur.messageId)}
                      alt={cur.caption || ''}
                      className="max-h-[78vh] max-w-[80vw] rounded-lg object-contain"
                      onError={() => setLbFailed(true)}
                    />
                  )}
                  {many && lightbox.index < lightbox.unit.length - 1 && (
                    <button
                      type="button"
                      onClick={() => setLightbox((s) => (s ? { ...s, index: s.index + 1 } : s))}
                      className="absolute -right-14 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-xl text-white hover:bg-white/20"
                    >
                      ›
                    </button>
                  )}
                </div>
                {lbFailed && (
                  <p className="mt-3 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-center text-xs text-white/85">
                    {t('tg.decodeFail')}
                  </p>
                )}
                {cur.caption && (
                  <p className="mt-3 max-w-2xl text-center text-xs text-white/80">{cur.caption}</p>
                )}
                {many && (
                  <p className="mt-1 text-[11px] text-white/60">
                    {lightbox.index + 1} / {lightbox.unit.length}
                  </p>
                )}
              </div>
            )
          })()}
        </div>
      )}

        </>
      )}
    </div>
  )
}

/** prepend 时按 key 去重合并（older 在前，当前在后，均为旧→新顺序） */
function mergeFeed(older: FeedItem[], current: FeedItem[]): FeedItem[] {
  const seen = new Set<string>()
  const out: FeedItem[] = []
  for (const it of [...older, ...current]) {
    if (seen.has(it.key)) continue
    seen.add(it.key)
    out.push(it)
  }
  return out
}

/** 单条媒体消息气泡（频道风格，全部靠左） */
function MessageBubble(props: {
  item: FeedItem
  downloading: boolean
  downloadedPath?: string
  onDownload: () => void
  onOpenDownloaded: () => void
  onPreview: () => void
}) {
  const { item: m, downloading, downloadedPath, onDownload, onOpenDownloaded, onPreview } = props
  const { t } = useTranslation()
  return (
    <div className="flex flex-col">
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-border-subtle bg-surface p-2.5 shadow-sm">
        {m.type === 'photo' && <PhotoBlock item={m} onPreview={onPreview} />}
        {m.type === 'video' && (
          <VideoBlock
            item={m}
            downloaded={Boolean(m.downloaded || downloadedPath)}
            downloading={downloading}
            onDownload={onDownload}
          />
        )}

        {(m.type === 'audio' || m.type === 'file') && (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2">
            <span className="text-base">{m.type === 'audio' ? '🎵' : '📄'}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg-mid">
              {m.caption || m.mimeType || `#${m.messageId}`}
            </span>
            <span className="shrink-0 text-[10px] text-muted">{fmtSize(m.size)}</span>
          </div>
        )}

        {m.caption && m.type !== 'audio' && m.type !== 'file' && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg-strong">
            {m.caption}
          </p>
        )}

        <div className="mt-1.5 flex items-center gap-2">
          <span className="font-mono text-[9px] text-muted">#{m.messageId}</span>
          {m.size ? <span className="text-[10px] text-muted">{fmtSize(m.size)}</span> : null}
          {(m.downloaded || downloadedPath) && <Chip tone="success">{t('tg.downloaded')}</Chip>}
          <span className="ml-auto text-[10px] text-muted">{fmtTime(m.date)}</span>
          {/* 视频的缓存/播放操作在海报上（点击视频=开始缓存），meta 行不重复放按钮 */}
          {m.type === 'video' ? null : downloadedPath ? (
            <Button variant="secondary" size="sm" className="h-6 px-2 text-[10px]" onClick={onOpenDownloaded}>
              {t('tg.play')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={downloading}
              onClick={onDownload}
            >
              {downloading ? '…' : t('tg.download')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 可选播放速率（倍速菜单项） */
const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/**
 * 倍速控制（v0.4.3）：悬浮在视频容器右上角，点击展开速率菜单（不用原生控件 ... 里藏的倍速）。
 * 速率由父级持有并应用到 <video>.playbackRate（onLoadedMetadata 兜底，视频重挂载后保持）。
 */
function PlaybackSpeed(props: { rate: number; onRate: (r: number) => void }) {
  const { rate, onRate } = props
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div
      className="absolute right-2 top-2 z-10 flex flex-col items-end"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-black/80"
      >
        {rate === 1 ? t('tg.speed') : `${rate}x`}
      </button>
      {open && (
        <div className="mt-1 flex flex-col overflow-hidden rounded-md border border-white/20 bg-black/80 text-[11px] text-white shadow-lg backdrop-blur-sm">
          {PLAYBACK_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onRate(s)
                setOpen(false)
              }}
              className={`min-w-[52px] px-3 py-1 text-center hover:bg-white/20 ${
                s === rate ? 'font-semibold text-accent' : ''
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 相册气泡（v0.4.2）：相邻同 grouped_id 的消息聚合为单个气泡。
 * 组内 2 列缩略图网格 + 「相册 · N 项」角标；点击任一格从该格进入组内浏览
 * （lightbox 左右切换）。整组一键缓存，进行中显示「缓存中 n/N」。
 */
function AlbumBubble(props: {
  items: FeedItem[]
  /** 组内已缓存条数（含本次会话下载成功的） */
  downloadedCount: number
  /** 整组缓存进行中的进度 */
  progress?: { done: number; total: number }
  onDownload: () => void
  /** 取消整组缓存（进行中时操作行显示「取消」） */
  onCancel?: () => void
  onPreview: (index: number) => void
}) {
  const { items, downloadedCount, progress, onDownload, onCancel, onPreview } = props
  const { t } = useTranslation()
  const allDone = downloadedCount >= items.length
  const caption = items.find((it) => it.caption?.trim())?.caption
  const totalSize = items.reduce((s, it) => s + (it.size ?? 0), 0)
  return (
    <div className="flex flex-col">
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-border-subtle bg-surface p-2.5 shadow-sm">
        {/* 状态行：相册计数 + 缓存进度（纯文本弱化，文字归文字、按钮归按钮） */}
        <div className="mb-1.5 flex items-center gap-2 text-[10px]">
          <span className="font-medium text-accent">{t('tg.albumN', { n: items.length })}</span>
          {allDone ? (
            <span className="text-success">{t('tg.downloaded')}</span>
          ) : downloadedCount > 0 ? (
            <span className="text-muted">
              {t('tg.albumPartial', { n: downloadedCount, total: items.length })}
            </span>
          ) : null}
          <span className="ml-auto text-muted">{fmtTime(items[0].date)}</span>
        </div>

        {/* 组内 2 列网格：点击任一格进入组内浏览 */}
        <div className="grid grid-cols-2 gap-1.5">
          {items.map((it, i) => {
            const typ = it.type ?? guessMediaType(it.mimeType)
            const dur = fmtDuration(it.duration)
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onPreview(i)}
                className="relative block aspect-square w-full overflow-hidden rounded-lg bg-surface-2"
              >
                {typ === 'photo' || typ === 'video' ? (
                  <img
                    src={tgThumbUrl(it.chatId, it.messageId)}
                    alt={it.caption || ''}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-lg">
                    {typ === 'audio' ? '🎵' : '📄'}
                  </span>
                )}
                {typ === 'video' && dur && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-medium text-white">
                    {dur}
                  </span>
                )}
                {typ === 'video' && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 pl-0.5 text-xs text-white backdrop-blur-sm">
                      {it.downloaded ? '▶' : '⬇'}
                    </span>
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {caption && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg-strong">
            {caption}
          </p>
        )}

        {/* 操作行：整组缓存 / 进度 / 首条消息号 + 总大小（按钮与缓存库同构：outline h-6） */}
        <div className="mt-1.5 flex items-center gap-2">
          <span className="font-mono text-[9px] text-muted">#{items[0].messageId}</span>
          <span className="text-[10px] text-muted">{fmtSize(totalSize)}</span>
          {progress ? (
            <>
              <span className="ml-auto text-[10px] text-muted">
                {t('tg.cachingProgress', { n: progress.done, total: progress.total })}
              </span>
              {onCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={onCancel}
                >
                  {t('tg.cancel')}
                </Button>
              )}
            </>
          ) : !allDone ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-6 px-2 text-[10px]"
              onClick={onDownload}
            >
              {downloadedCount > 0
                ? `${t('tg.continue')} ${downloadedCount}/${items.length}`
                : t('tg.download')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 图片块：列表用轻量缩略图（自然比例不裁切），点击弹遮罩看原图 */
function PhotoBlock({ item, onPreview }: { item: FeedItem; onPreview: () => void }) {
  const [err, setErr] = useState(false)
  if (err) {
    return (
      <button
        type="button"
        onClick={onPreview}
        className="flex h-28 w-full items-center justify-center rounded-lg bg-surface-2 text-[11px] text-muted"
      >
        <PhotoPlaceholder />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onPreview}
      className="block w-full overflow-hidden rounded-lg bg-surface-2"
    >
      <img
        src={tgThumbUrl(item.chatId, item.messageId)}
        alt={item.caption || ''}
        loading="lazy"
        onError={() => setErr(true)}
        className="mx-auto h-auto w-full max-h-[60vh] object-contain"
      />
    </button>
  )
}

/**
 * 视频块（v0.4.1 缓存三态）：
 * - 未缓存：海报 + ⬇，点击 = 开始缓存；左上角「在线播放」小入口兜底（受保护内容无法缓存时）；
 * - 缓存中：海报 + 转圈 + 「缓存中」；
 * - 已缓存：海报 + ▶，点击播放本地文件流（/api/tg/local，支持 Range），
 *   本地流加载失败自动降级在线流。右下角时长徽标（区分预览片段与完整视频）。
 */
function VideoBlock(props: {
  item: FeedItem
  downloaded: boolean
  downloading: boolean
  onDownload: () => void
}) {
  const { item, downloaded, downloading, onDownload } = props
  const { t } = useTranslation()
  const [playing, setPlaying] = useState<'off' | 'local' | 'online'>('off')
  const [posterErr, setPosterErr] = useState(false)
  const [rate, setRate] = useState(1)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const thumb = tgThumbUrl(item.chatId, item.messageId)
  const dur = fmtDuration(item.duration)

  // 倍速即时生效；视频重挂载（本地↔在线降级）后由 onLoadedMetadata 兜底再应用
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate, playing])

  if (playing !== 'off') {
    return (
      <div className="relative">
        <video
          ref={videoRef}
          src={
            playing === 'local'
              ? tgLocalFileUrl(item.chatId, item.messageId)
              : tgFileUrl(item.chatId, item.messageId)
          }
          poster={posterErr ? undefined : thumb}
          controls
          autoPlay
          preload="auto"
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = rate
          }}
          onError={() => {
            // 本地文件缺失/移动 → 降级在线流（仅降级一次，避免循环）
            if (playing === 'local') setPlaying('online')
          }}
          className="max-h-[70vh] w-full rounded-lg bg-black"
        />
        <PlaybackSpeed rate={rate} onRate={setRate} />
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => {
        // 已缓存→播本地流；缓存中→在线播放（缓存后台继续，不阻塞观看）；未缓存→开始后台缓存
        if (downloaded) setPlaying('local')
        else if (downloading) setPlaying('online')
        else onDownload()
      }}
      className="relative block w-full overflow-hidden rounded-lg bg-black"
    >
      {posterErr ? (
        <span className="flex aspect-video w-full items-center justify-center text-[11px] text-white/50">
          {t('tg.thumbUnavailable')}
        </span>
      ) : (
        <img
          src={thumb}
          alt={item.caption || ''}
          loading="lazy"
          onError={() => setPosterErr(true)}
          className="mx-auto h-auto w-full max-h-[50vh] object-contain"
        />
      )}
      {dur && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {dur}
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        {downloading ? (
          <span className="flex flex-col items-center gap-1.5">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            <span className="text-[10px] text-white/90">{t('tg.caching')}</span>
          </span>
        ) : (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 pl-0.5 text-lg text-white backdrop-blur-sm transition-transform hover:scale-105">
            {downloaded ? '▶' : '⬇'}
          </span>
        )}
      </span>
      {!downloaded && !downloading && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            setPlaying('online')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation()
              setPlaying('online')
            }
          }}
          className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-black/80"
        >
          {t('tg.online')}
        </span>
      )}
    </button>
  )
}

function PhotoPlaceholder() {
  const { t } = useTranslation()
  return <span className="text-muted">{t('tg.thumbUnavailable')}</span>
}
