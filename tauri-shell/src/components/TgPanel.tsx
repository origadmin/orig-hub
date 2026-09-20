import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import { useEvent } from '../hooks/useEvent'
import { decodeStateKey, useDecodeHealth } from '../lib/decodeHealth'
import {
  tgHealth,
  listTgDialogs,
  listTgMonitoredChannels,
  addTgMonitoredChannel,
  removeTgMonitoredChannel,
  listTgMonitorMessages,
  searchTgMonitorMessages,
  listTgMessages,
  listTgDownloaded,
  syncTgMonitor,
  tgFileUrl,
  tgLocalFileUrl,
  tgThumbUrl,
  getCacheTask,
  enqueueCacheTask,
  cancelCacheTask,
} from '../api/tg'
import { findMediaItemIdByRef, importMediaItems } from '../api/media'
import type {
  TgCacheTask,
  TgChannel,
  TgMediaItem,
  TgMonitoredChannel,
  TgStoredMessage,
} from '../types'
import { ensureTg, tgSaveConfig } from '../api/tauri'
import { CacheManagerDialog } from './CacheManagerDialog'
import { useStore } from '../store/useStore'
import {
  ALBUM_MAX_TILES,
  albumGridClass,
  coverFit,
  fmtDuration,
  fmtSize,
  fmtTime,
  guessMediaType,
  type MediaType,
} from '../lib/tgmedia'

/**
 * 后端原因 → i18n 键的**分类降级**（BUG-088 通用规则）。
 *
 * `reason` 是后端原文，可能是 `MTProto connect failed: request error: read 0 bytes`
 * 这种传输层报文 —— 它既不是给用户看的，也不该直接进 DOM（术语、英文、无行动指引）。
 * 这里只做分类映射，原文一律只进日志（`logTgReason`）。
 * 匹配顺序即优先级：越具体的先试，兜底为 `tg.reasonUnknown`。
 *
 * @param reason 后端 `available === false` 时给出的原文（可能为空）
 * @returns i18n 键（调用方再 `t(key)` 取双语文案）
 */
function classifyTgReason(reason: string | null | undefined): string {
  const raw = (reason ?? '').trim()
  if (!raw) return 'tg.reasonUnknown'
  if (/flood|rate limit|too many|retry after|FLOOD_WAIT/i.test(raw)) return 'tg.reasonFlood'
  if (/api_id|api_hash|api credential|not configured|missing api|credentials/i.test(raw))
    return 'tg.reasonConfig'
  if (/unauthoriz|auth key|session|credential|phone|password|login|code/i.test(raw))
    return 'tg.reasonAuth'
  if (
    /mtproto|connect|network|proxy|socks|timeout|timed out|eof|refused|reset by peer|dns|read 0 bytes|unreachable|i\/o|transport/i.test(
      raw,
    )
  )
    return 'tg.reasonNetwork'
  return 'tg.reasonUnknown'
}

/** 原文只进日志（不渲染）：保留排查所需信息，又不把报文抛到界面上。 */
function logTgReason(reason: string | null | undefined): void {
  const raw = (reason ?? '').trim()
  if (!raw) return
  console.debug('[tg] availability reason (raw, not rendered):', raw)
}

/** 未分组的内部键（避免与真实分组标题冲突） */
const UNGROUPED = '__ungrouped__'
/** 「全部订阅」分组的内部键 */
const ALL_KEY = '__all__'
/** 右栏媒体历史每页条数 */
const PAGE_SIZE = 30

/**
 * 稳定事件回调（useEvent 模式）收敛到 `hooks/useEvent.ts` 的**唯一实现**，本文件改为导入。
 *
 * 语义不变：引用恒定、行为永远取最新闭包 —— 子组件 `memo` 生效要求 props 引用稳定；
 * 用内联箭头 `onDownload={() => do(item)}` 每次渲染都是新引用，memo 形同虚设，
 * 于是每秒一次的进度轮询会把整列消息气泡全部重渲染（卡顿根源）。
 * 子组件回传自己的数据（如 `onDownload(item)`），父级用本钩子提供恒定引用，
 * 点击时再取最新状态，杜绝陈旧闭包。
 */

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
export function TgPanel({ onOpenAccounts }: { onOpenAccounts?: () => void } = {}) {
  const { t } = useTranslation()
  const { setError, openViewer, tgAvailability, accounts } = useStore()
  /**
   * TG 依赖故障（不可用/不可达）：直接以「不可用 + 原因」取代面板内容。
   *
   * 面板里的每一次拉取都依赖 TG 连接，故障时展示一个空列表会让人以为「频道没了」；
   * 明确说出原因，才能把「连不上 Telegram」与「没有内容」区分开（BUG-023）。
   */
  const tgBroken = tgAvailability !== null && tgAvailability.status !== 'ok'
  /** 调试期离线短路（orig-tg 以 ORIG_TG_OFFLINE=1 启动，跳过 MTProto 连接）：
   *   预期态，不是故障。渲染成中性「调试模式」面板而非红色错误框，否则网页调试阶段
   *   一打开 TG 就满屏红错，等于没有调试环境。 */
  const tgDebugOffline =
    tgAvailability?.status === 'unavailable' &&
    /offline debug mode/.test(tgAvailability.reason ?? '')
  /**
   * orig-tg 服务是否在跑（进程可达）。
   *
   * `unavailable` 的语义是「进程活着、连不上 Telegram」—— 它仍算服务在跑，
   * 而且正是最需要留在这里修（改代理 / 重新登录）的状态。
   */
  const tgServiceUp = tgAvailability === null || tgAvailability.status !== 'unreachable'
  /**
   * 未绑定态（BUG-094）：服务在跑，但没有可用登录会话。
   * 此时渲染引导区而不是频道列表 —— 频道列表在没有会话时必然是空的，
   * 空列表会把「没登录 / 连不上」伪装成「没有内容」。
   */
  const tgUnbound = tgServiceUp && !accounts.tg.bound
  /** 后端原文（仅用于日志与分类），绝不直接渲染 */
  const rawReason =
    tgAvailability !== null && tgAvailability.status === 'unavailable'
      ? tgAvailability.reason
      : null
  const showReason = Boolean(rawReason && rawReason.trim())
  /** 分类降级后的 i18n 键（BUG-088） */
  const reasonKey = classifyTgReason(rawReason)

  // 原文只进日志：保留排查信息，又不把传输层报文抛给用户
  useEffect(() => {
    logTgReason(rawReason)
  }, [rawReason])
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
  /** 监控频道新内容：后台增量同步到的未展示条数（点击提示条才刷新，避免拽走滚动位置） */
  const [pendingNew, setPendingNew] = useState(0)
  /** 显式刷新信号：提示条点击时触发消息流重载 */
  const [feedReloadTick, setFeedReloadTick] = useState(0)
  /**
   * 监控内容查找（唯一搜索框，在频道标题栏）：跨全部监控频道筛内容。
   * 输入非空时第二列切换为结果视图（按频道分组）；清空即回到原视图。
   */
  const [globalSearchInput, setGlobalSearchInput] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalHits, setGlobalHits] = useState<
    (TgStoredMessage & { channelTitle?: string })[]
  >([])
  const [globalSearching, setGlobalSearching] = useState(false)

  const [syncing, setSyncing] = useState(false)
  const [downloadedPaths, setDownloadedPaths] = useState<Map<string, string>>(new Map())
  /**
   * 图片入库状态（BUG-049 规则：图片不缓存，最多加入媒体库）：
   * 已入库图片的 ref 集合（`<chatId>:<messageId>`）。feed 变化时对未见过的图片
   * 逐个 by-ref 查询；查过的记入 photoCheckedRef 不再重复请求。
   */
  const [photoLibRefs, setPhotoLibRefs] = useState<Set<string>>(new Set())
  const photoCheckedRef = useRef<Set<string>>(new Set())
  /**
   * 缓存任务（服务端任务态）：缓存由 orig-tg 的后台 worker 执行并落库，前端只读状态。
   *
   * 此前进度存在组件内存（`downloading` Set / `albumProgress` Map），且整组缓存由浏览器
   * 逐条循环驱动——两者都活在页面里，刷新/切页即整体消失（「缓存状态完全丢失」的根因）。
   * 现在任务的入队、进度、取消、失败原因全在服务端，刷新后重新拉取即可恢复。
   */
  /** 当前唯一缓存任务（后端单飞：任意时刻至多一个在呈现；设计裁定「task 只返回一个结果」） */
  const [cacheTask, setCacheTask] = useState<TgCacheTask | null>(null)
  /** 缓存管理面板开关（BUG-029：缓存任务的可观测面——数量/进度/状态） */
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false)
  /** 已提示过的失败任务：避免轮询把同一个错误反复弹给用户 */
  const reportedFailuresRef = useRef<Set<number>>(new Set())
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
        return merged.size
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return 0
      }
    },
    [setError],
  )

  useEffect(() => {
    if (!alive) return
    // 依赖不可用时不做任何拉取：这些请求必然 503，只会刷无谓的错误提示，
    // 而面板已用「不可用 + 原因」把情况说清楚了（BUG-023：避免故障被读成一堆零散报错）。
    if (tgBroken) return
    // 订阅列表**缓存优先**：频道变化极少，每次进面板都全量扫描既慢又让人迷惑
    // （「缓存还是实时同步？」）。缓存即所得；只有冷启动（缓存为空）才自动补一次
    // 扫描，之后一律走「重新扫描订阅」手动刷新。真正的持续监控点是**内容**，
    // 由监控频道的同步/消息流承担，与这份静态列表解耦。
    void (async () => {
      const cached = await fetchDialogs(false)
      // 冷启动：缓存为空 → 自动补一次后台扫描（后端 total==0 时同样会自扫，双保险）
      if (cached === 0) void fetchDialogs(true)
    })()
    listTgMonitoredChannels()
      .then(setMonitoredList)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [alive, tgBroken, fetchDialogs, setError])

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

  // ---- 缓存任务：读服务端状态（刷新/切页后由此恢复，不再依赖页面内存） ----

  /** 活跃任务（queued/running）；`interrupted` 属已结束（进程崩溃遗留），不参与轮询。 */
  const activeTask =
    cacheTask && (cacheTask.status === 'queued' || cacheTask.status === 'running')
      ? cacheTask
      : null

  /**
   * 正在写盘的消息号集合（驱动「缓存中」转圈）。
   * 整组任务同一时刻只有 `currentId` 在写盘，故只把它算作进行中——否则整组会一起转圈。
   */
  const downloading = useMemo(() => {
    const s = new Set<number>()
    if (activeTask) {
      if (activeTask.groupId === undefined || activeTask.groupId === null)
        activeTask.messageIds.forEach((id) => s.add(id))
      else if (activeTask.currentId !== undefined) s.add(activeTask.currentId)
    }
    return s
  }, [activeTask])

  /** 整组缓存进度（键与渲染处一致：`a-{chatId}-{groupId}`；单飞下至多一项） */
  const albumProgress = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>()
    if (activeTask && activeTask.groupId !== undefined && activeTask.groupId !== null) {
      m.set(`a-${activeTask.chatId}-${activeTask.groupId}`, {
        done: activeTask.done,
        total: activeTask.total,
      })
    }
    return m
  }, [activeTask])

  /**
   * 轮询签名：id/status/done/currentId/error 任一变化才算「状态真的变了」。
   * 快照返回新对象但内容没变（下载一条要几秒，1s 轮询绝大多数是空转）时
   * **直接跳过 setState**——零重渲染。这是流畅度规则「等值短路」的落点。
   */
  const cacheTasksSigRef = useRef('')
  const refreshCacheTasks = useCallback(async () => {
    try {
      const task = await getCacheTask()
      const sig = task
        ? `${task.id}:${task.status}:${task.done}:${task.currentId ?? ''}:${task.error ?? ''}`
        : ''
      if (sig === cacheTasksSigRef.current) return
      cacheTasksSigRef.current = sig
      setCacheTask(task)
    } catch {
      // 任务查询失败不影响浏览；下次轮询/操作会重试
    }
  }, [])

  /** 挂载即拉一次：刷新/切页后由此恢复「缓存中 n/N」与已完成标记（本 BUG 的正解）。 */
  useEffect(() => {
    if (tgBroken) return
    void refreshCacheTasks()
  }, [tgBroken, refreshCacheTasks])

  /** 有活跃任务时才轮询（无任务零开销）：5s 一次、固定节拍（BUG-030：1s 过频致卡顿）。
   *  依赖只用布尔 `hasActive`——任务进度变化不会重建 interval，节拍恒定不抖动。
   *  缓存管理面板打开时主轮询暂停：面板自轮 tasks/all（5s），避免双源重复请求。 */
  const hasActiveTask = activeTask !== null
  useEffect(() => {
    if (tgBroken || !hasActiveTask || cacheManagerOpen) return
    const timer = setInterval(() => void refreshCacheTasks(), 5000)
    return () => clearInterval(timer)
  }, [tgBroken, hasActiveTask, cacheManagerOpen, refreshCacheTasks])

  /** feed 最新值（供不依赖 feed 身份的进度刷新读取） */
  const feedRef = useRef<FeedItem[]>([])
  useEffect(() => {
    feedRef.current = feed
  }, [feed])

  /** 任务终态触发一次「已缓存」快照刷新（▶ 及时出现）。
   *  设计裁定：进度变化**绝不**派发重请求——1s 恰好 1 个 cache/tasks 轮询，
   *  全量 downloaded 清单只在任务收尾时拉一次。多任务排队时逐个触发。 */
  const prevTaskRef = useRef<{ id: number; status: string } | null>(null)
  useEffect(() => {
    const prev = prevTaskRef.current
    prevTaskRef.current = cacheTask ? { id: cacheTask.id, status: cacheTask.status } : null
    const src = feedSourceRef.current
    if (!src || !cacheTask) return
    const wasActive = prev && (prev.status === 'queued' || prev.status === 'running')
    const isTerminal =
      cacheTask.status === 'done' ||
      cacheTask.status === 'failed' ||
      cacheTask.status === 'cancelled' ||
      cacheTask.status === 'interrupted'
    // 同一任务从活跃 → 终态：收尾刷一次；新任务开始（id 变化）不刷。
    if (!(wasActive && isTerminal && prev.id === cacheTask.id)) return
    let cancelled = false
    void (async () => {
      try {
        const dl = await listTgDownloaded(src.chatId)
        if (cancelled) return
        setDownloadedPaths((m) => {
          const next = new Map(m)
          for (const it of feedRef.current) {
            const p = dl[String(it.messageId)]
            if (p) next.set(it.key, p)
            else next.delete(it.key)
          }
          return next
        })
      } catch {
        // 快照失败不阻塞浏览
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cacheTask])

  /** 任务失败必须显式告知（此前失败只留在前端 catch 里，刷新后连痕迹都没有）。 */
  useEffect(() => {
    if (!cacheTask || cacheTask.status !== 'failed') return
    if (reportedFailuresRef.current.has(cacheTask.id)) return
    reportedFailuresRef.current.add(cacheTask.id)
    const raw = cacheTask.error ?? ''
    setError(
      /os error 5|拒绝访问|access denied/i.test(raw)
        ? t('tg.protectedMedia')
        : raw || t('tg.cacheFailed'),
    )
  }, [cacheTask, setError, t])


  // v0.4.3：分组内订阅频道可直接点进内容页（在线流浏览）；监控频道仍走本地真列表。
  // （搜索词为全局状态，切频道时保留——结果视图跨频道，无需串台清理。）

  // 全局监控查找：防抖 300ms → 跨全部监控频道查本地已同步消息
  useEffect(() => {
    const h = setTimeout(() => setGlobalSearch(globalSearchInput.trim()), 300)
    return () => clearTimeout(h)
  }, [globalSearchInput])
  useEffect(() => {
    if (!globalSearch) {
      setGlobalHits([])
      setGlobalSearching(false)
      return
    }
    let cancelled = false
    setGlobalSearching(true)
    searchTgMonitorMessages(globalSearch)
      .then((hits) => {
        if (!cancelled) setGlobalHits(hits)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setGlobalSearching(false)
      })
    return () => {
      cancelled = true
    }
  }, [globalSearch, setError])

  /** 点全局命中 → 打开预览（已缓存走本地流，未缓存在线流），标题带频道名 */
  const onGlobalHitPreview = useEvent((hit: TgStoredMessage & { channelTitle?: string }) => {
    const item: FeedItem = {
      key: `g-${hit.channelId}-${hit.messageId}`,
      chatId: hit.channelId,
      messageId: hit.messageId,
      caption: hit.caption,
      mimeType: hit.mimeType,
      size: hit.size,
      type: hit.type ?? guessMediaType(hit.mimeType),
      date: hit.date ?? hit.createdAt,
      duration: hit.duration,
      groupId: hit.groupId,
      downloaded: hit.downloaded,
    }
    openViewer({
      title: hit.channelTitle,
      index: 0,
      items: toViewerItems([item]),
    })
  })

  /** 命中按频道分组（保持时间倒序的频道首次出现顺序） */
  const globalGroups = useMemo(() => {
    const map = new Map<string, typeof globalHits>()
    for (const h of globalHits) {
      const k = h.channelTitle || `#${h.channelId}`
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(h)
    }
    return [...map.entries()]
  }, [globalHits])

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
    setPendingNew(0)
    stickBottomRef.current = true
    void (async () => {
      try {
        if (monitored) {
          const page = await listTgMonitorMessages(chatId, {
            limit: PAGE_SIZE,
          })
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
    // monitoredSet 身份随监控列表变化，增删监控后自动重载；
    // feedReloadTick 为提示条点击的显式刷新。
  }, [selectedId, monitoredSet, feedReloadTick, setError, applyStoredSnapshot])

  // 监控频道内容新鲜度：消息流本地满页即不回网，若没有任何主动同步动作，
  // 停留在面板里永远看不到新内容（BUG-038）。这里补上「内容即监控点」的主动轮：
  // 进入监控频道立即触发一轮全局增量同步，停留期间每 60s 一轮；
  // 同步到新条目不粗暴重载（会拽走滚动位置），累计进「有新内容」提示条。
  useEffect(() => {
    if (selectedId === null || !monitoredSet.has(selectedId)) return
    let cancelled = false
    const run = async () => {
      try {
        const r = await syncTgMonitor()
        if (!cancelled && r.added > 0) setPendingNew((n) => n + r.added)
      } catch {
        // 同步失败不打扰内容浏览（服务不可达时面板顶部已有整体提示）
      }
    }
    void run()
    const h = setInterval(run, 60_000)
    return () => {
      cancelled = true
      clearInterval(h)
    }
  }, [selectedId, monitoredSet])

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

  // BUG-049：feed 里每张未见过的图片查一次「是否已入库」，驱动图片气泡的
  // 「加入媒体库 / 已入库」状态（图片不缓存，这是图片唯一的落库路径标记）。
  useEffect(() => {
    const todos = feed
      .filter((f) => f.type === 'photo')
      .map((f) => `${f.chatId}:${f.messageId}`)
      .filter((r) => !photoCheckedRef.current.has(r))
    if (todos.length === 0) return
    let alive = true
    void (async () => {
      for (const r of todos) {
        photoCheckedRef.current.add(r)
        try {
          const id = await findMediaItemIdByRef('tg', r)
          if (alive && id != null) setPhotoLibRefs((prev) => new Set(prev).add(r))
        } catch {
          /* 服务不可用：静默，按钮保持可点击 */
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [feed])

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

  /** 归一化 feed 条目 → 全局播放器条目（已缓存走本地流并带在线降级，未缓存直连在线流） */
  const toViewerItems = (unit: FeedItem[]) =>
    unit.map((u) => {
      const local = downloadedPaths.get(u.key)
      return {
        key: u.key,
        chatId: u.chatId,
        messageId: u.messageId,
        kind: u.type,
        caption: u.caption,
        src: local ? tgLocalFileUrl(u.chatId, u.messageId) : tgFileUrl(u.chatId, u.messageId),
        fallbackSrc: local ? tgFileUrl(u.chatId, u.messageId) : undefined,
      }
    })

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

  /**
   * 单条缓存：入队服务端任务后立即返回。
   *
   * 不再 `await` 整个下载——那会把任务寿命绑在这次 fetch 上，刷新即断。
   * 进度由 `cacheTasks` 轮询呈现。
   */
  const doDownload = async (item: FeedItem) => {
    try {
      await enqueueCacheTask({ chatId: item.chatId, messageIds: [item.messageId] })
      await refreshCacheTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 相册整组缓存：整批交给服务端 worker（顺序 / 进度 / 失败中止 / 取消都在后端）。
   *
   * 此前后端循环在浏览器内存里跑，切页即消失；现在刷新页面任务照跑，回来即可见进度。
   * 已缓存条目由 worker 幂等跳过 → 与「继续」按钮的语义一致（续跑剩余，不重下）。
   */
  const downloadAlbum = async (items: FeedItem[]) => {
    if (items.length === 0) return
    try {
      await enqueueCacheTask({
        chatId: items[0].chatId,
        messageIds: items.map((it) => it.messageId),
        groupId: items[0].groupId,
      })
      await refreshCacheTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 取消整组缓存：取消服务端任务（worker 在下一条目间隙退出）。 */
  const cancelAlbum = async (key: string) => {
    // 单飞模型：当前任务就是该组时才可取消（其它组在排队，无进度可取消）。
    if (!activeTask || `a-${activeTask.chatId}-${activeTask.groupId}` !== key) return
    try {
      await cancelCacheTask(activeTask.id)
      await refreshCacheTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
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

  /**
   * 图片加入媒体库（BUG-049 规则：图片不缓存，最多入库为浏览条目）。
   * 按 (source=tg, ref) 幂等；条目无本地文件，浏览字节由服务端现场代理缩略图。
   */
  const importPhoto = async (item: FeedItem) => {
    const ref = `${item.chatId}:${item.messageId}`
    try {
      await importMediaItems([
        {
          source: 'tg',
          ref,
          kind: 'photo',
          title: item.caption?.trim() || undefined,
          size: item.size ?? undefined,
        },
      ])
      setPhotoLibRefs((prev) => new Set(prev).add(ref))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 稳定回调（useEvent）：子气泡全部 memo 化后，回调引用必须恒定。
   * 子组件回传自己的数据（item / items / index），这里点击时再取最新闭包，
   * 既保住 memo 的浅比较，又不产生陈旧闭包。
   */
  const onBubbleDownload = useEvent((item: FeedItem) => void doDownload(item))
  const onBubbleImportPhoto = useEvent((item: FeedItem) => void importPhoto(item))
  const onBubbleOpen = useEvent((item: FeedItem) => void openDownloaded(item))
  const onBubblePreview = useEvent((item: FeedItem) =>
    openViewer({
      title: selectedChannel?.title,
      index: 0,
      items: toViewerItems([item]),
    }),
  )
  const onAlbumDownload = useEvent((items: FeedItem[]) => void downloadAlbum(items))
  const onAlbumCancel = useEvent((items: FeedItem[]) =>
    void cancelAlbum(`a-${items[0].chatId}-${items[0].groupId}`),
  )
  const onAlbumPreview = useEvent((index: number, items: FeedItem[]) =>
    openViewer({
      title: selectedChannel?.title,
      index,
      items: toViewerItems(items),
    }),
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      {tgDebugOffline && tgAvailability ? (
        /* 调试期离线：预期态，中性呈现，不报警 */
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border-subtle bg-surface/60 p-5">
            <h3 className="text-[14px] font-semibold text-foreground">
              {t('tg.debugOfflineTitle')}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {t('tg.debugOfflineHint')}
            </p>
            {tgAvailability.reason && (
              <p className="mt-3 break-all rounded-md bg-background px-2 py-1.5 font-mono text-[10px] text-muted">
                {tgAvailability.reason}
              </p>
            )}
          </div>
        </div>
      ) : tgUnbound ? (
        /*
         * 未绑定引导区（BUG-094）：入口已按「服务可用即显示」放行，这里必须说清
         * 「没登录 / 为什么连不上」并给出可行动出口 —— 否则点进来是一个空面板，
         * 用户既不知道发生了什么，也没有任何路径把它修回来。
         *
         * 原因走 `classifyTgReason` 分类降级（BUG-088）：后端原文是传输层报文，
         * 只进日志，界面上是中文可行动文案。
         */
        <div
          className="flex flex-1 items-center justify-center p-6"
          data-testid="tg-unbound-guide"
        >
          <div className="w-full max-w-md rounded-lg border border-border-subtle bg-surface/60 p-5">
            <h3 className="text-[14px] font-semibold text-fg-strong">
              {t('tg.unboundTitle')}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {t('tg.unboundHint')}
            </p>
            {showReason && (
              <p className="mt-3 rounded-md bg-background px-2 py-1.5 text-[11px] leading-relaxed text-fg-mid">
                {t(reasonKey)}
              </p>
            )}
            <Button
              size="sm"
              className="mt-5 h-8 w-full text-xs"
              onClick={() => onOpenAccounts?.()}
            >
              {t('tg.unboundAction')}
            </Button>
          </div>
        </div>
      ) : tgBroken && tgAvailability ? (
        /* 依赖故障：说明「为什么用不了」，而不是给一个空列表 */
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-danger/30 bg-danger/10 p-5">
            <h3 className="text-[14px] font-semibold text-danger">
              {tgAvailability.status === 'unreachable'
                ? t('accounts.tgUnreachable')
                : t('accounts.tgUnavailable')}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-danger/90">
              {/* 面板内不自带「连接诊断」，故用面板专属文案（不指向账号页才有的区块） */}
              {tgAvailability.status === 'unreachable'
                ? t('tg.unreachableHint')
                : t('tg.unavailableHint')}
            </p>
            {/* 原文不进 DOM（BUG-088）：只渲染分类降级后的中文文案 */}
            {showReason && (
              <p className="mt-3 rounded-md bg-surface/60 px-2 py-1.5 text-[10px] leading-relaxed text-danger">
                {t(reasonKey)}
              </p>
            )}
          </div>
        </div>
      ) : needConfig && !alive ? (
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
      <section className="relative flex min-w-0 flex-1 flex-col bg-surface/20">
        {globalSearch ? (
          <>
            {/* 全局监控内容查找结果：跨全部监控频道，按频道分组（新→旧混排后归组）。
                搜索框与频道标题栏是同一个输入（autoFocus 接管焦点，切视图不打断输入）。 */}
            <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-4 py-2.5">
              <input
                autoFocus
                type="search"
                value={globalSearchInput}
                onChange={(e) => setGlobalSearchInput(e.target.value)}
                placeholder={t('tg.globalSearchPlaceholder')}
                className="h-8 min-w-0 flex-1 rounded-md border border-border-subtle bg-surface-2/60 px-3 text-[12px] text-fg-strong outline-none placeholder:text-muted focus:border-accent/60"
              />
              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                {globalHits.length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() => setGlobalSearchInput('')}
              >
                {t('tg.globalSearchClear')}
              </Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {globalSearching ? (
                <p className="px-2 py-6 text-center text-xs text-muted">{t('tg.searching')}</p>
              ) : globalGroups.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-muted">{t('tg.searchNoMatch')}</p>
                  <p className="mt-1 text-[10px] text-muted/80">{t('tg.globalSearchScope')}</p>
                </div>
              ) : (
                globalGroups.map(([title, hits]) => (
                  <div key={title} className="mb-2">
                    <p className="sticky top-0 z-10 truncate bg-surface/95 px-2 py-1 text-[10px] font-semibold text-muted backdrop-blur-sm">
                      {title} · {hits.length}
                    </p>
                    {hits.map((hit) => {
                      const typ = hit.type ?? guessMediaType(hit.mimeType)
                      return (
                        <button
                          key={`${hit.channelId}-${hit.messageId}`}
                          type="button"
                          onClick={() => onGlobalHitPreview(hit)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2/70"
                        >
                          <span className="w-10 shrink-0 text-center text-[9px] text-muted">
                            {typ === 'photo' ? '图片' : typ === 'video' ? '视频' : typ === 'audio' ? '音频' : '文件'}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-fg-mid">
                            {hit.caption}
                          </span>
                          {hit.downloaded && (
                            <span className="shrink-0 text-[9px] text-success">
                              {t('tg.downloaded')}
                            </span>
                          )}
                          <span className="shrink-0 text-[9px] tabular-nums text-muted">
                            {fmtTime(hit.date ?? hit.createdAt)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </>
        ) : !detail && groupMode !== null && activeGroup ? (
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
              {/* 监控内容搜索：跨全部监控频道（顶部标题与按钮之间；输入非空 → 第二列切结果视图） */}
              <input
                type="search"
                value={globalSearchInput}
                onChange={(e) => setGlobalSearchInput(e.target.value)}
                placeholder={t('tg.globalSearchPlaceholder')}
                className="h-8 w-48 shrink-0 rounded-md border border-border-subtle bg-surface-2/60 px-3 text-[12px] text-fg-strong outline-none placeholder:text-muted focus:border-accent/60"
              />
              <button
                type="button"
                onClick={() => setCacheManagerOpen(true)}
                title={t('tg.cacheManager')}
                className="flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-strong"
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
              </button>
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

            {/* 监控内容搜索已上移到标题栏（跨全部监控频道）；单频道过滤是它的子集，不再单设一框 */}

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
                        photoInLibrary={photoLibRefs.has(`${unit[0].chatId}:${unit[0].messageId}`)}
                        onDownload={onBubbleDownload}
                        onImportPhoto={onBubbleImportPhoto}
                        onOpenDownloaded={onBubbleOpen}
                        onPreview={onBubblePreview}
                      />
                    ) : (
                      <AlbumBubble
                        key={`album-${unit[0].key}`}
                        items={unit}
                        downloadedCount={
                          unit.filter((x) => x.downloaded || downloadedPaths.has(x.key)).length
                        }
                        progress={albumProgress.get(`a-${unit[0].chatId}-${unit[0].groupId}`)}
                        groupHasVideo={unit.some((x) => x.type === 'video')}
                        groupInLibrary={unit.every(
                          (x) =>
                            x.type !== 'photo' ||
                            x.downloaded ||
                            photoLibRefs.has(`${x.chatId}:${x.messageId}`),
                        )}
                        onDownload={onAlbumDownload}
                        onCancel={onAlbumCancel}
                        onPreview={onAlbumPreview}
                      />
                    ),
                  )
                )}
                <div className="h-2 shrink-0" />
              </div>
            </div>
            {/* 有新内容提示条：点击才刷新（重载会重置滚动位置，不自动执行） */}
            {pendingNew > 0 && selectedMonitored ? (
              <div className="pointer-events-none absolute bottom-3 left-0 right-0 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setPendingNew(0)
                    setFeedReloadTick((v) => v + 1)
                  }}
                  className="pointer-events-auto rounded-full bg-accent px-3 py-1 text-[11px] font-medium text-white shadow-md transition-transform hover:scale-[1.03]"
                >
                  {t('tg.newContent').replace('{n}', String(pendingNew))}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <p className="max-w-xs text-center text-sm leading-relaxed text-muted">
              {!alive ? t('tg.offline') : t('tg.selectChannel')}
            </p>
          </div>
        )}
      </section>




        </>
      )}
      {cacheManagerOpen ? (
        <CacheManagerDialog channels={channels} onClose={() => setCacheManagerOpen(false)} />
      ) : null}
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
/**
 * 单条消息气泡。**memo 化 + 数据回传式回调**（流畅度规则）：
 * 回调携带自己的数据（`onDownload(item)`），父级用 useEvent 提供恒定引用，
 * 这样轮询引发的父级重渲染在浅比较时被整体跳过，不再拖累整列气泡。
 */
const MessageBubble = memo(function MessageBubble(props: {
  item: FeedItem
  downloading: boolean
  downloadedPath?: string
  /** BUG-049：图片已入库（图片不缓存，入库即终态） */
  photoInLibrary: boolean
  onDownload: (item: FeedItem) => void
  onImportPhoto: (item: FeedItem) => void
  onOpenDownloaded: (item: FeedItem) => void
  onPreview: (item: FeedItem) => void
}) {
  const {
    item: m,
    downloading,
    downloadedPath,
    photoInLibrary,
    onDownload,
    onImportPhoto,
    onOpenDownloaded,
    onPreview,
  } = props
  const { t } = useTranslation()
  return (
    <div className="flex flex-col">
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-border-subtle bg-surface p-2.5 shadow-sm">
        {m.type === 'photo' && <PhotoBlock item={m} onPreview={() => onPreview(m)} />}
        {m.type === 'video' && (
          <VideoBlock
            item={m}
            downloaded={Boolean(m.downloaded || downloadedPath)}
            downloading={downloading}
            onDownload={() => onDownload(m)}
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
          {/* 缓存/播放按钮：视频与图片同构（BUG-046）——此前视频只靠海报上的 ⬇ 图标，
              图片却有显式「缓存」按钮，逻辑倒置。海报点击行为不变（已缓存=播放，
              缓存中=在线播放，未缓存=开始缓存），按钮是明确的兜底入口。 */}
          {/* 操作按钮（BUG-049 区分视频/图片）：视频=缓存/播放；图片=加入媒体库/已入库
              （图片不缓存；历史已落盘的图片保留「播放」）；其余类型照旧缓存。 */}
          {downloadedPath || m.downloaded ? (
            <Button variant="secondary" size="sm" className="h-6 px-2 text-[10px]" onClick={() => onOpenDownloaded(m)}>
              {t('tg.play')}
            </Button>
          ) : m.type === 'photo' ? (
            photoInLibrary ? (
              <Chip tone="success">{t('tg.inLibrary')}</Chip>
            ) : (
              <Button variant="secondary" size="sm" className="h-6 px-2 text-[10px]" onClick={() => onImportPhoto(m)}>
                {t('tg.addToLibrary')}
              </Button>
            )
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={downloading}
              onClick={() => onDownload(m)}
            >
              {downloading ? t('tg.caching') : t('tg.download')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
})

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
      className="absolute right-3 top-3 z-10 flex flex-col items-end"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 入口按钮必须够大够显眼（BUG-033）：此前 22×18 的贴边小字用户找不到。
          最小可点击目标 24×24，这里取 32 高并加描边提高与黑底的对比度。 */}
      <button
        type="button"
        aria-label={`playback speed ${rate}x`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 min-w-[2.5rem] items-center justify-center rounded-md bg-black/70 px-2 text-[11px] font-semibold text-white ring-1 ring-white/30 backdrop-blur-sm hover:bg-black/85"
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
              className={`min-h-[32px] min-w-[64px] px-3 text-center hover:bg-white/20 ${
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
 *
 * memo + 自定义比较：`progress` 对象每次进度重建都是新引用，但多数相册的
 * done/total 并没变——按**值**比较，只有真正在推进的那一组才重渲染。
 * 回调为 useEvent 恒定引用，不参与比较。
 */
const AlbumBubble = memo(function AlbumBubble(props: {
  items: FeedItem[]
  /** 组内已缓存条数（含本次会话下载成功的） */
  downloadedCount: number
  /** 整组缓存进行中的进度 */
  progress?: { done: number; total: number }
  /** BUG-049：组内是否有视频 —— 决定按钮语义（缓存 vs 加入媒体库） */
  groupHasVideo: boolean
  /** BUG-049：组内图片是否全部已入库（纯图组全入库后按钮收起） */
  groupInLibrary: boolean
  onDownload: (items: FeedItem[]) => void
  /** 取消整组缓存（进行中时操作行显示「取消」） */
  onCancel?: (items: FeedItem[]) => void
  onPreview: (index: number, items: FeedItem[]) => void
}) {
  const {
    items,
    downloadedCount,
    progress,
    groupHasVideo,
    groupInLibrary,
    onDownload,
    onCancel,
    onPreview,
  } = props
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

        {/*
         * 组内宫格：列数**按数量自适应**（1→单图 / 2→2列 / 3→3列 / 4→2×2 /
         * 5..9→3 列，即 5/6/7/8/9 宫格），图片一律 `object-contain`。
         *
         * 两处都改必然性、而非调数值：
         *  - 旧版固定 `grid-cols-2` + `aspect-square` + `object-cover`：4 图以上永远
         *    2 列（9 张图排成 5 行的长条），且 cover 把每张图**裁掉边缘** —— 用户报的
         *    「图片被截取、没有九宫格」就是这个组合造成的。宫格形状是数量决定的函数，
         *    不是写死的常量。
         *  - 超过 9 张按平台惯例折进第 9 格的 `+N`，其余图片在全屏浏览页里连翻
         *    （该页本来就遍历整组，不存在看不到的图）。
         */}
        <div
          data-testid="album-grid"
          className={cn('grid gap-1.5', albumGridClass(items.length))}
        >
          {items.slice(0, ALBUM_MAX_TILES).map((it, i) => {
            const typ = it.type ?? guessMediaType(it.mimeType)
            const dur = fmtDuration(it.duration)
            const overflow = items.length - ALBUM_MAX_TILES
            const isLastTile = i === ALBUM_MAX_TILES - 1 && overflow > 0
            const single = items.length === 1
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onPreview(i, items)}
                className={cn(
                  'relative block w-full overflow-hidden rounded-lg bg-surface-2',
                  // 单图给自然比例（整幅呈现）；多图用方形格保证网格整齐
                  single ? '' : 'aspect-square',
                  isLastTile && 'ring-1 ring-inset ring-white/10',
                )}
              >
                {typ === 'photo' || typ === 'video' ? (
                  <img
                    src={tgThumbUrl(it.chatId, it.messageId)}
                    alt={it.caption || ''}
                    loading="lazy"
                    className={cn(
                      // 单图：自然比例、不放大（`w-auto` 而非 `w-full`，避免小图被拉糊）
                      single ? 'mx-auto h-auto max-h-[60vh] w-auto max-w-full' : 'h-full w-full',
                      coverFit(typ),
                    )}
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
                {isLastTile && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-semibold text-white">
                    +{overflow}
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
                  onClick={() => onCancel(items)}
                >
                  {t('tg.cancel')}
                </Button>
              )}
            </>
          ) : !allDone ? (
            /* BUG-049：按钮语义按组构成区分 —— 含视频=「缓存」（图片由 worker 顺带入库，
               不落盘）；纯图组=「加入媒体库」，全入库后按钮收起改显「已入库」。 */
            !groupHasVideo && groupInLibrary ? (
              <span className="ml-auto text-[10px] text-success">{t('tg.inLibrary')}</span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-6 px-2 text-[10px]"
                onClick={() => onDownload(items)}
              >
                {!groupHasVideo
                  ? t('tg.addToLibrary')
                  : downloadedCount > 0
                    ? `${t('tg.continue')} ${downloadedCount}/${items.length}`
                    : t('tg.download')}
              </Button>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}, (a, b) =>
  a.items === b.items &&
  a.downloadedCount === b.downloadedCount &&
  a.progress?.done === b.progress?.done &&
  a.progress?.total === b.progress?.total &&
  a.groupHasVideo === b.groupHasVideo &&
  a.groupInLibrary === b.groupInLibrary,
)

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
        className="mx-auto h-auto max-h-[60vh] w-auto max-w-full object-contain"
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
  /** 视频轨解不出来 / 解码吃力 —— 两种 onError 抓不到的静默失败（BUG-034）。
   *  倍速入 key：改速即重设基线，否则「调低速度」这个建议本身不会清掉提示（BUG-053）。 */
  const decode = useDecodeHealth(videoRef, `${playing}-${item.messageId}-${rate}`)

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
        {/* 解码异常提示：视频轨解不出来 / 丢帧严重时不再静默（BUG-034） */}
        {decode !== 'ok' && (
          <p className="absolute bottom-2 left-1/2 z-10 max-w-[80%] -translate-x-1/2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-center text-xs text-white/85">
            {t(decodeStateKey(decode) ?? 'tg.decodeFail')}
          </p>
        )}
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
