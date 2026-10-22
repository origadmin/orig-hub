import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Plus } from 'lucide-react'
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
  listTgFolders,
  listTgMonitoredChannels,
  addTgMonitoredChannel,
  removeTgMonitoredChannel,
  markTgChannelRead,
  listTgMonitorFilters,
  startTgMonitorBackfill,
  cancelTgMonitorBackfill,
  addTgMonitorFilter,
  removeTgMonitorFilter,
  markTgFilterRead,
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
import type {
  TgCacheTask,
  TgChannel,
  TgFolder,
  TgMediaItem,
  TgMonitoredChannel,
  TgMonitorFilter,
  TgQueuedTask,
  TgStoredMessage,
} from '../types'
import { tgSaveConfig } from '../api/tauri'
import { isTauri, copyToClipboard } from '../lib/env'
import { CacheManagerDialog } from './CacheManagerDialog'
import { TgFilterPanel } from './TgFilterPanel'
import { TgOnboarding } from '../domains/tg/TgOnboarding'
import { useStore } from '../store/useStore'
import type { TgMode } from '../nav'
import { resolveTgFeatureReady } from '../store/selectors'
import { useTgSearch } from '../store/tgSearch'
import { classifyTgReason, describeTgFailure, logTgReason } from '../lib/tgReason'
import { deriveEntryState } from '../lib/entryState'
import type { EntryState } from '../lib/entryState'
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
 * unix 秒 → `YYYY-MM-DD`（**UTC**，与 `monitor::parse_date_utc` 同一口径）。
 *
 * 不用 `toLocaleDateString()`：那会按浏览器时区算，回溯边界与服务端的 UTC
 * 解释差一天，用户会看到「我选 1 月 1 日，状态显示 12 月 31 日」。
 */
function fmtDateOnly(unixSec: number): string {
  if (!unixSec || unixSec <= 0) return ''
  return new Date(unixSec * 1000).toISOString().slice(0, 10)
}

/** 未分组的内部键（避免与真实分组标题冲突） */
const UNGROUPED = '__ungrouped__'
/** 「全部订阅」分组的内部键 */
const ALL_KEY = '__all__'
/** 右栏媒体历史每页条数 */
const PAGE_SIZE = 30

/**
 * BUG-305：定位循环参数 —— 轮询间隔（ms）与有界翻页上限（每页 30 条）。
 *
 * 为什么有上限：源消息可能已被删除或早于可加载范围，无界翻页会把「定位」
 * 变成一次拉全历史的请求风暴；有界放弃 + 如实反馈（`tg.locateFailed`）
 * 好过无限转圈（BUG-239 的预算纪律同源）。
 */
const LOCATE_TICK_MS = 300
const LOCATE_MAX_PAGES = 20

/**
 * 相册级缓存进度（BUG-181 扩展）：
 * - `queued`：该组在单飞队列中排队（本轮跑不到它，呈现「排队中」而非「缓存中」）；
 * - `itemBytes/itemBytesTotal`：当前条目内字节进度（一条 200MB 视频下载数分钟，
 *   仅靠 `done` 计数会全程冻结，对用户等价于「系统死了」）。
 */
interface AlbumProgress {
  done: number
  total: number
  queued?: boolean
  itemBytes?: number
  itemBytesTotal?: number
}

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
  /**
   * 已缓存文件的绝对路径（BUG-150）。
   *
   * 判型兜底需要它：历史行 `type` 与 `mime` 可能双缺（后端 `keep_serializing_if`
   * 会把 `Option::None` 的 `type` 整个省掉），此时落盘扩展名是最后一道判型依据 ——
   * 「已下载的 .jpg 被判成 file/视频」正是漏了它造成的。
   */
  filePath?: string
  /**
   * TG 相册分组 ID（grouped_id；同组相邻消息聚合为一个相册气泡，v0.4.2）。
   *
   * **string**（BUG-345）：group_id ~1.4e16 > JS 2^53，number 过 JSON 界即丢
   * 精度（活库 62/70 个组键任务被污染差 1）；后端串界序列化 + 宽容反序列化。
   */
  groupId?: string
  downloaded?: boolean
}

/** 中栏频道视图行（监控本地记录与订阅缓存共用） */
interface MiddleChannel {
  id: number
  title: string
  username?: string
  folder?: string
  /** 仅监控行有值：自上次点开以来新增条数（未读徽标） */
  newCount?: number
  /** 仅监控行有值：回溯目标日期（unix 秒，0/缺省 = 没有待回溯） */
  backfillUntil?: number
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
  tone?: 'muted' | 'accent' | 'success' | 'warn'
  children: ReactNode
  className?: string
}) {
  const toneCls =
    tone === 'accent'
      ? 'border-accent/30 text-accent'
      : tone === 'success'
        ? 'border-success/40 text-success'
        : tone === 'warn'
          ? 'border-red-500/40 text-red-600 dark:text-red-400'
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
    type: m.type ?? guessMediaType(m.mimeType, m.filePath),
    date: m.date ?? m.createdAt,
    duration: m.duration,
    filePath: m.filePath,
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
    // `TgMediaItem` 没有落盘路径列（该端点不返回 filePath），兜底只用 mime ——
    // 这是有意的：不能传一个不存在的字段来假装满足判型契约。
    type: m.type ?? guessMediaType(m.mimeType),
    date: m.date,
    duration: m.duration,
    groupId: m.groupId,
  }
}

/** 全局命中 → feed 视图模型（与 `fromStored` 同构，键前缀 `g-` 区分来源） */
function fromHit(h: TgStoredMessage): FeedItem {
  return {
    key: `g-${h.channelId}-${h.messageId}`,
    chatId: h.channelId,
    messageId: h.messageId,
    caption: h.caption,
    mimeType: h.mimeType,
    size: h.size,
    type: h.type ?? guessMediaType(h.mimeType, h.filePath),
    date: h.date ?? h.createdAt,
    duration: h.duration,
    filePath: h.filePath,
    groupId: h.groupId,
    downloaded: h.downloaded,
  }
}

/**
 * 能否进内置播放器（BUG-137 邻居序列的准入判据）。
 *
 * `MediaViewer` 内部按 `modeOf(kind)` 分流：photo → 浏览、video/audio → 连播，
 * 而 `file` 是 `none`（没有可呈现形态）。把 `file` 塞进序列，‹ › 就会在两个
 * 「不支持预览」的条目之间空翻 —— 那不是邻居，是噪音。
 */
function isPlayable(u: FeedItem): boolean {
  return u.type !== 'file'
}

/**
 * 同型序列的准入判据（BUG-150）。
 *
 * `isPlayable` 只回答「能不能呈现」，**不回答「是不是同一种呈现」**——而邻居序列要的是
 * 后者：点图片时 ‹ › 应当只在图片间翻，点视频时只在视频间连播。把 photo 与 video 编进
 * 同一个序列，与把 `file` 编进去的后果在性质上完全一样：‹ › 会翻到「不是这个模式」的
 * 东西（播完一段视频，下一"条"是张图），用户感知为「图片被当视频播放」。
 *
 * `MediaViewer.tsx:18-21` 已写明这条设计（「若把图片也编进播放序列，播完第 2 集会
 * 自动连播到第 3 集（图片）」），但它只落在播放器内部的 `modeOf` 分流上 —— 分流发生在
 * 序列构造之后，管不住序列本身。本函数把同一条约束**前移到数据侧**。
 */
function isSameKind(a: FeedItem, b: FeedItem): boolean {
  if (!isPlayable(a) || !isPlayable(b)) return false
  // video 与 audio 共用播放态（`modeOf` 同为 'play'），互为邻居；photo 独立成组。
  const group = (t: FeedItem['type']) => (t === 'video' || t === 'audio' ? 'play' : 'browse')
  return group(a.type) === group(b.type)
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
export function TgPanel(
  {
    tgMode,
    onTgModeChange,
    onOpenAccounts,
    onOpenMedia,
  }: {
    /**
     * TG 域内选择（BUG-330 / TGM-01/03；二级菜单 → 主列的唯一分流判据）。
     * 与 FilesPanel 的 `nav.fmode` 同构：单一真源在 MainLayout 的 nav state，
     * 面板只读 + 经 `onTgModeChange` 写回（禁止组件里再存一份 view）。
     */
    tgMode: TgMode
    onTgModeChange: (mode: TgMode) => void
    onOpenAccounts?: () => void
    /**
     * 入库流水线的「去媒体库查看」出口：切到媒体库视图。
     * `view` 是 MainLayout 的局部 state，面板自己切不了，只能由宿主给。
     */
    onOpenMedia?: () => void
  },
) {
  const { t } = useTranslation()
  const { setError, setToast, openViewer, tgService, tgLink, accounts, refreshTgState } = useStore()
  /**
   * BUG-305：媒体库 → TG 面板的跳转焦点（`pendingMediaFocus` 的正向对应）。
   *
   * 入口（媒体库卡片 / 列表行 / 剧集详情来源块）解析出 `(chatId, messageId)` 后
   * 设本焦点并 `navigate('tg')`；本面板可见时消费它：选频道 → 定位消息 → 高亮。
   * 消费与清理都只此一处（单一真源，不允许第二支 effect 也去清它）。
   */
  const pendingTgFocus = useStore((s) => s.pendingTgFocus)
  const setPendingTgFocus = useStore((s) => s.setPendingTgFocus)
  /**
   * 链路真断了才叫故障（BUG-178）。
   *
   * 分层是这次的核心：以前「没配凭证 / 没登录 / 连不上」塌成一个 `available=false`，
   * 面板一律渲染「Telegram 不可用」，而设置页同时显示「插件：运行中」—— 两个真源各说各话。
   * 现在只有 `link_down` 走故障卡；`needs_config` / `needs_login` 是**待办**，给引导。
   */
  const tgBroken = tgLink.state === 'link_down'
  /** 服务层：进程是否在跑（daemon 说了算，前端不再自己探端口） */
  const tgServiceUp = tgService.running
  /**
   * 未绑定态（BUG-094）：服务在跑，但没有可用登录会话。
   * 此时渲染引导区而不是频道列表 —— 频道列表在没有会话时必然是空的，
   * 空列表会把「没登录 / 连不上」伪装成「没有内容」。
   */
  const tgUnbound = tgServiceUp && !accounts.tg.bound && tgLink.state !== 'needs_config'
  /**
   * M0-T05：**入口常驻**（BUG-094 口径改变）后，门控判据移入本面板自己算。
   *
   * 判据仍是同一处选择器 `resolveTgFeatureReady`（BUG-177：不写第二份），
   * 但拆成两个读数 ——「开着」与「开着且起来了」必须分开呈现：
   * 「主动关着」要劝用户去启用，「正在拉起」只需要等（daemon 独占进程
   * 生命周期，无手动重试入口，BUG-178）。二者混为空面板就是假象。
   */
  /**
   * 「采集未启用」卡（带「启用 Telegram 采集」按钮）只应在**已确认用户主动关掉插件**
   * 时出现：`known && !enabled`。`!known`（配置尚未确认 / daemon 不可达 / 服务未启动）
   * 一律不算「用户禁用」，归 daemon 职责，落到下方 `!tgReady` 的「正在启动」提示，
   * 绝不给一个按核心设计本就启动不了服务的死按钮（BUG-354）。
   */
  const tgDisabled = tgService.known && !tgService.enabled
  const tgReady = resolveTgFeatureReady(tgService)
  /** 后端原文（仅用于日志与分类），绝不直接渲染 */
  const rawReason = tgBroken ? tgLink.reason : null
  const showReason = Boolean(rawReason && rawReason.trim())
  /** 分类降级后的 i18n 键（BUG-088） */
  const reasonKey = classifyTgReason(rawReason)

  // 原文只进日志：保留排查信息，又不把传输层报文抛给用户
  useEffect(() => {
    logTgReason(rawReason, 'tg-panel')
  }, [rawReason])

  // 进入 TG 面板时补一次状态刷新（BUG-097 的事件驱动信号源之一）：仅在挂载时触发一次，
  // 不新增轮询；失败由 refreshTgState 内部 `logTgReason` 分类留痕，不静默吞掉。
  useEffect(() => {
    void refreshTgState()
  }, [refreshTgState])

  /**
   * **没有「重试连接」按钮**（BUG-178）。
   *
   * orig-tg 只在启动时连一次 Telegram，所以「连不上」确实需要重启才能恢复 ——
   * 但那是 **daemon 的职责**：巡检发现链路断了会自己重启，凭证保存后也会自动重启。
   * 以前把这个动作做成按钮挂在界面上（壳 `ensure_tg` + 前端「重试连接」两条路径），
   * 结果是 TG 进程有两个主人、互相 kill，而用户还得替系统干活。现在一条都不留。
   */
  const [alive, setAlive] = useState(false)
  const [channels, setChannels] = useState<TgChannel[]>([])
  /** 用户自定义分组（含 channelIds = Telegram pin 顺序，用于组内 pin 置顶排序） */
  const [folders, setFolders] = useState<TgFolder[]>([])
  const [scanning, setScanning] = useState(false)
  const [monitoredList, setMonitoredList] = useState<TgMonitoredChannel[]>([])
  /** 监控列表折叠状态（默认展开） */
  const [monitorOpen, setMonitorOpen] = useState(true)
  /**
   * 回溯表单：正在填日期的那一行（channel id）；null = 未展开。
   *
   * 2026-10-22 用户第 2 点：增量同步只向新 ⇒ 频道数据只有最新一窗。
   * 回溯是**条目级动作**，所以表单挂在**行下方**（不上提到节头）——
   * 层级纪律：条目级动作不得上提到入口级（BUG-324 裁定）。
   */
  const [backfillFor, setBackfillFor] = useState<number | null>(null)
  /** 回溯目标日期（`YYYY-MM-DD`）。空串 = 用户还没选。 */
  const [backfillDate, setBackfillDate] = useState('')
  /** 回溯请求在飞：只锁按钮，不锁整个面板。 */
  const [backfillBusy, setBackfillBusy] = useState(false)
  /**
   * 已展开的相册（键 = `album-{首条 key}`）。
   *
   * 2026-10-22 用户第 3 点：默认只给 1 张封面，点击才加载整组。
   * 展开态放在面板层（不是 AlbumBubble 内部）：气泡会随 feed 重渲染/重排，
   * 状态留在内部会被重置，用户展开完一滚动又收回去。
   */
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(() => new Set())
  const toggleAlbum = useCallback((key: string) => {
    setExpandedAlbums((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  /**
   * 频道节折叠状态（BUG-330 TGM-02，设计 §2.6 优先级三机制）：
   * 频道 = 消费序最底、偶尔动作 ⇒ **默认折叠**。折叠是优先级表达，不是功能隐藏——
   * 节头计数与入口常驻可点（BUG-320）。
   */
  const [channelOpen, setChannelOpen] = useState(false)
  /**
   * 文字筛选规则（BUG-329）：每条 = 一条虚拟监控（用户 2026-10-19 裁定
   * 「多次作为多条，不是单一过滤。一条相当于一条监控」）⇒ 与监控频道**并列**
   * 渲染成多个条目，不是单频道内的复合条件。
   */
  const [filters, setFilters] = useState<TgMonitorFilter[]>([])
  const [filterOpen, setFilterOpen] = useState(true)
  /** 新建筛选的输入（弹窗内；旧版是节内常驻一行 Input+按钮，用户「严重破坏整体设计」） */
  const [filterDraft, setFilterDraft] = useState('')
  /** 弹窗内的显示名（可选；不填则后端 label 缺省同 keyword ⇒ 前端按此去重渲染） */
  const [filterLabelDraft, setFilterLabelDraft] = useState('')
  /** 「+ 新建」弹窗开关 */
  const [filterDlgOpen, setFilterDlgOpen] = useState(false)
  /** 节内规则检索（常驻；BUG-320：入口可见性不搞「多了才出现」） */
  const [filterQuery, setFilterQuery] = useState('')
  /** 规则超 K 折叠：false = 只渲染前 K 条 */
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [filterAdding, setFilterAdding] = useState(false)
  const [search, setSearch] = useState('')
  /**
   * TGM-03：主列分流判据从四个独立状态（`activeFilter` / `groupMode` / `detail` /
   * `selectedId`）+ `activeFilter ? … : …` 优先级链，收敛为**单一 `tgMode` 五值**
   * （与文件域 `fmode` 同构，nav/index.ts）。下面全部是从 tgMode 的**只读派生**：
   * 「筛选激活 + 分组已选」这类错误态在类型上不可表达。
   */
  const tgFilterId = tgMode.startsWith('filter:') ? Number(tgMode.slice(7)) : null
  const activeFilter = useMemo(
    () => (tgFilterId === null ? null : filters.find((f) => f.id === tgFilterId) ?? null),
    [filters, tgFilterId],
  )
  /** 分组 key ↔ tgMode：ALL_KEY/UNGROUPED 是面板内部分组键，不进 nav 契约 */
  const groupMode = useMemo<string | null>(() => {
    if (tgMode === 'channels') return ALL_KEY
    if (tgMode.startsWith('group:')) {
      const g = tgMode.slice(6)
      return g === '__ungrouped__' ? UNGROUPED : `f:${g}`
    }
    return null
  }, [tgMode])
  const tgModeOfGroupKey = (key: string): TgMode =>
    key === ALL_KEY ? 'channels' : key === UNGROUPED ? 'group:__ungrouped__' : `group:${key.slice(2)}`
  /** 内容视图 ⇔ `channel:<id>`；selectedId 只读派生，不再有第二处写入方 */
  const selectedId = tgMode.startsWith('channel:') ? Number(tgMode.slice(8)) : null
  /*
   * 瞬态模式（全局搜索 'search' / 筛选 'filter:<id>'）的前模式：
   * 关闭/清除时回到进来之前的那一屏（频道内容或分组列表），不是永远回全部。
   */
  const preTransientModeRef = useRef<TgMode | null>(null)
  const enterTransient = (m: TgMode) => {
    if (preTransientModeRef.current === null) {
      preTransientModeRef.current =
        tgMode === 'search' || tgMode.startsWith('filter:') ? 'channels' : tgMode
    }
    onTgModeChange(m)
  }
  const exitTransient = () => {
    const back = preTransientModeRef.current ?? 'channels'
    preTransientModeRef.current = null
    onTgModeChange(back)
  }
  /** 从分组列表进内容页的来源 tgMode（「← 返回」回到那个分组；直接落频道时为 null，不显示返回） */
  const cameFromListRef = useRef<TgMode | null>(null)
  /**
   * BUG-305：待定位的源消息（频道已选，但目标消息可能还没随 feed 到达）。
   * 用 state 而非 ref：定位循环的启停由它驱动（见下方定位 effect）。
   */
  const [locateReq, setLocateReq] = useState<{ chatId: number; messageId: number } | null>(null)
  /** BUG-305：当前高亮的消息 key（定位成功后滚进可视区并高亮；null = 无高亮） */
  const [highlightKey, setHighlightKey] = useState<string | null>(null)

  const [feed, setFeed] = useState<FeedItem[]>([])
  const [feedLoading, setFeedLoading] = useState(false)
  /**
   * 内容流加载失败的**面板内联**提示（BUG-167）：只在内容区展示、不升级为全局 toast。
   * 全局可用性表述的唯一真相源是**链路层** `tgLink`（服务层由 daemon 托管，与三处连接灯同源诚实）；
   * 瞬时传输错误在这里降级为「可重试的局部失败」，绝不产生与之矛盾的「无法连接」断言。
   */
  const [feedError, setFeedError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  /** 监控频道新内容：后台增量同步到的未展示条数（点击提示条才刷新，避免拽走滚动位置） */
  const [pendingNew, setPendingNew] = useState(0)
  /** 显式刷新信号：提示条点击时触发消息流重载 */
  const [feedReloadTick, setFeedReloadTick] = useState(0)
  /**
   * 监控内容查找：跨全部监控频道筛内容，输入非空时第二列切换为结果视图（按频道分组）。
   *
   * 搜索框已上移到顶部上下文栏（`TgGlobalSearch`，BUG-100 方案 A），状态落在
   * `store/tgSearch`。这里**只订阅防抖后的 `committed`** —— 若订阅输入框原文，
   * 每次按键都会重渲染本面板（2000+ 行），AGENTS.md §5 明令禁止。
   */
  const globalSearch = useTgSearch((s) => s.committed)
  const globalHits = useTgSearch((s) => s.hits)
  const globalSearching = useTgSearch((s) => s.searching)
  const setGlobalHits = useTgSearch((s) => s.setHits)
  const setGlobalSearching = useTgSearch((s) => s.setSearching)
  const clearGlobalSearch = useTgSearch((s) => s.clear)
  /**
   * 搜索结果里**已展开**的那条命中（BUG-151）。
   *
   * 此前点命中行直接开播放器，用户没有「先看清这是不是我找的那条」的机会（正文、
   * 类型、时间、大小全看不到），对无可播媒体的命中更是只能看到「不支持预览」。
   * 现在点行 = 就地展开内容；播放退为展开态内的显式二次动作。
   *
   * 用 ref 键（`chatId:messageId`）而不是索引：结果列表会随关键词变化重排。
   */
  const [expandedHit, setExpandedHit] = useState<string | null>(null)
  const hitKeyOf = (h: TgStoredMessage) => `${h.channelId}:${h.messageId}`

  const [syncing, setSyncing] = useState(false)
  const [downloadedPaths, setDownloadedPaths] = useState<Map<string, string>>(new Map())
  /**
   * BUG-170 过渡窗标记：任务从活跃转终态后、字节快照回来前为 true。
   * 此窗口内单源派生**持有旧态**（事实静默 ≠ 新事实），不再出现
   * 「既不在缓存中也不在已完成」的空洞。
   */
  const awaitingSnapshotRef = useRef(false)
  /** 单源派生的旧态持有表（key → 上一渲染的 EntryState），驱动前向渲染。 */
  const entryStateHoldRef = useRef(new Map<string, EntryState>())
  /**
   * 相册进度持有表（BUG-170）：进度行是「缓存中」呈现的载体之一——任务终态 →
   * 字节快照到达的过渡窗内 `activeTask` 已消失，若进度行跟着消失，相册会闪回
   * 「既无进度也无已缓存」的空洞（跨源 intermediate 态，禁止）。进度在此持有，
   * 由条目派生状态驱动清除（全部离开 caching 才释放）。
   */
  const albumProgressHoldRef = useRef(
    new Map<string, AlbumProgress>(),
  )
  /**
   * BUG-352：原「图片入库状态」集合（`photoLibRefs`）已删除 —— 图片与视频同样落盘
   * （BUG-049 的「图片不缓存、最多加入图片库」已废），图片的入库与否由
   * **字节真值 + 任务态**单一派生（`entryStateFor`），不再有第二套「编目」账本。
   */
  /**
   * 缓存任务（服务端任务态）：缓存由 orig-tg 的后台 worker 执行并落库，前端只读状态。
   *
   * 此前进度存在组件内存（`downloading` Set / `albumProgress` Map），且整组缓存由浏览器
   * 逐条循环驱动——两者都活在页面里，刷新/切页即整体消失（「缓存状态完全丢失」的根因）。
   * 现在任务的入队、进度、取消、失败原因全在服务端，刷新后重新拉取即可恢复。
   */
  /** 当前唯一缓存任务（后端单飞：任意时刻至多一个在呈现；设计裁定「task 只返回一个结果」） */
  const [cacheTask, setCacheTask] = useState<TgCacheTask | null>(null)
  /**
   * 排队任务覆盖摘要（BUG-181）：单飞端点此前对排队任务零呈现——用户入队第二组时
   * 下一拍就被 running 任务覆盖回「未缓存」，看起来「无法添加」。排队组据此点亮
   * 「排队中」。与 cacheTask 同一请求、同一事实源，不新增轮询。
   */
  const [queuedTasks, setQueuedTasks] = useState<TgQueuedTask[]>([])
  /** 缓存管理面板开关（BUG-029：缓存任务的可观测面——数量/进度/状态）。
   *  入口在上下文栏，故开关提到 store（跨子树共享）。 */
  const cacheManagerOpen = useStore((s) => s.tgCacheManagerOpen)
  const setCacheManagerOpen = useStore((s) => s.setTgCacheManagerOpen)
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

  /*
   * 服务探活（BUG-178）：**只观察，不拉起**。
   *
   * 以前这里在探活失败时自己调 `ensureTg()` 去 spawn orig-tg —— 于是 TG 进程有了
   * 两个主人（daemon 一个、桌面壳一个），互相 kill，状态随之乱跳。现在进程生命周期
   * 归 daemon 独占：这里只回答「现在通不通」，不通就出配置/引导卡，拉起由 daemon 的
   * 启动拉起与巡检自愈负责。
   */
  useEffect(() => {
    tgHealth()
      .then(() => setAlive(true))
      .catch(() => {
        setAlive(false)
        // 未配置凭证 → 出 APP 内配置表单；服务没起来 → 交给 daemon 自愈，这里不代劳。
        if (tgLink.state === 'needs_config') setNeedConfig(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 保存 Telegram 配置：壳写 `tg/config.json` 并请 daemon 重启 orig-tg。
   *
   * 前端不碰进程（BUG-178）—— 凭证只在 orig-tg 启动时读取，重启这一步由 daemon 执行。
   */
  const saveSetup = useCallback(async () => {
    // BUG-286：写壳配置 + 请 daemon 重启两步都只在桌面客户端存在。纯浏览器里
    // `invoke('tg_save_config')` 直接抛 raw undefined.invoke，这里先拦掉，换成一句人话。
    if (!isTauri()) {
      setError('保存 Telegram 配置需在桌面客户端中完成（网页调试模式无法写入壳配置并重启服务）')
      return
    }
    setSavingCfg(true)
    try {
      await tgSaveConfig(cfgId.trim(), cfgHash.trim(), cfgProxy.trim())
      setNeedConfig(false)
      // 重启后状态由 daemon 重报：走唯一刷新入口，不在这里猜结果。
      await refreshTgState()
      setAlive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingCfg(false)
    }
  }, [cfgId, cfgHash, cfgProxy, setError, refreshTgState])

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
        // BUG-167：这里不再升级为全局 toast —— 调用方分岔：挂载/扫描轮询（后台）静默
        // （原文已由 `tgFailureMessage` 记日志）；用户主动「重新扫描订阅」才给可见反馈。
        throw e instanceof Error ? e : new Error(String(e))
      }
    },
    [],
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
      try {
        const cached = await fetchDialogs(false)
        // 冷启动：缓存为空 → 自动补一次后台扫描（后端 total==0 时同样会自扫，双保险）
        if (cached === 0) await fetchDialogs(true)
      } catch {
        // BUG-167：后台加载失败静默 —— 面板顶部的可用性横幅（引擎真相源）已如实表述，
        // 瞬时传输错误不得再弹全局 toast 与三处连接灯矛盾（原文已记日志）。
      }
    })()
    listTgMonitoredChannels()
      .then((m) => {
        setMonitoredList(m)
      })
      .catch(() => {
        // BUG-167：同上，后台监控列表加载失败静默，不打脸连接灯。
      })
    // 自定义分组（含 pin 顺序）：驱动组内频道 pin 置顶排序（BUG-196 缺陷②）。
    listTgFolders()
      .then(setFolders)
      .catch(() => {
        // BUG-167：后台分组加载失败静默，不打脸连接灯。
      })
  }, [alive, tgBroken, fetchDialogs])

  // 扫描中轮询（2.5s），直到后端扫描结束。
  useEffect(() => {
    if (!scanning) return
    const h = setTimeout(() => {
      // BUG-167：后台轮询失败静默（原文已记日志），不断轮询链、不弹全局 toast。
      void fetchDialogs(false).catch(() => {})
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
        newCount: m.newCount,
        backfillUntil: m.backfillUntil,
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
    // 组内 pin 置顶：folder.channelIds 即 Telegram 的 pin 顺序（BUG-196 缺陷②）。
    // 仅自定义分组（f:<title>）内成立；全部/未分组模式不按 pin 排序（语义本就只在分组内）。
    let ordered = base
    if (groupMode.startsWith('f:')) {
      const folderTitle = groupMode.slice(2)
      const folder = folders.find((f) => f.title === folderTitle)
      const order = folder ? new Map(folder.channelIds.map((id, idx) => [id, idx])) : null
      if (order && order.size > 0) {
        ordered = [...base].sort((a, b) => {
          const ai = order.has(a.id) ? (order.get(a.id) as number) : Number.MAX_SAFE_INTEGER
          const bi = order.has(b.id) ? (order.get(b.id) as number) : Number.MAX_SAFE_INTEGER
          return ai - bi // 同序（都未 pin）保持原相对顺序（稳定排序）
        })
      }
    }
    const q = search.trim().toLowerCase()
    if (q === '') return ordered
    return ordered.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.username ?? '').toLowerCase().includes(q),
    )
  }, [groupMode, channels, search, folders])

  const activeGroup = useMemo(
    () => (groupMode === null ? undefined : groupSections.find((s) => s.key === groupMode)),
    [groupMode, groupSections],
  )

  /*
  /*
   * 数据驱动首落点（TGM-03；nav/index.ts::DEFAULT_TG_MODE 注释同源）：
   * 默认 tgMode='channels' 且本会话还没为用户选过屏时，落到第一个监控频道
   * （老行为：默认选中第一个监控频道显示其内容流）。一旦用户亲自选过
   * （任何非默认点击）就置位不再干预 —— 用户显式停在 'channels' 时不被拽走。
   */
  const autoLandedRef = useRef(false)
  useEffect(() => {
    if (autoLandedRef.current) return
    if (tgMode !== 'channels') {
      autoLandedRef.current = true
      return
    }
    if (monitoredRows.length === 0) return
    autoLandedRef.current = true
    onTgModeChange(`channel:${monitoredRows[0].id}`)
  }, [tgMode, monitoredRows, onTgModeChange])

  /*
   * TGM-03：上下文栏全局搜索（BUG-100）↔ `tgMode='search'` 的**单一闭环** effect。
   * 搜索框在顶部上下文栏（TgGlobalSearch 写 store 的 `committed`），主列按 tgMode
   * 分流 ⇒ 提交即进 'search' 瞬态模式，清词即退回进入前的那一屏。不用优先级链
   * （`activeFilter ? … : globalSearch ? …`）—— 那正是本轮删掉的东西。
   *
   * **为什么进场/撤场必须同一个 effect 且记 prevTgMode**（实测教训，曾在这里
   * 形成互撤环）：点左栏行离开搜索的那一拍，store 的 committed 还是旧值（清词
   * 的 setState 尚未落地），若只按「committed 非空 ⇒ 进 search」判，会立刻把
   * 用户拽回搜索模式，下一拍 exit 又弹回进搜索前的频道 ⇒ 用户点分组行永远
   * 出不去（M6 探针抓到的就是这个环）。按「上一拍确实是 search」区分
   * 「主动进搜索」与「被点行带出搜索」，环才断。
   */
  const prevTgModeRef = useRef<TgMode>(tgMode)
  useEffect(() => {
    const prev = prevTgModeRef.current
    prevTgModeRef.current = tgMode
    if (prev === 'search' && tgMode !== 'search') {
      // 被其它入口带出搜索（点左栏行/规则）⇒ 清掉搜索词，断掉回拉
      if (globalSearch) clearGlobalSearch()
      return
    }
    if (globalSearch) {
      if (tgMode !== 'search' && tgFilterId === null) enterTransient('search')
    } else if (tgMode === 'search') {
      exitTransient()
    }
  }, [globalSearch, tgMode, tgFilterId, onTgModeChange, clearGlobalSearch])

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
        // 字节快照已回来：单源事实到位，解除「任务终态 → 快照」过渡窗的旧态持有
        //（BUG-170）。此前的任何持有都只到这一刻为止。
        awaitingSnapshotRef.current = false
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
   * 「正在写盘」的消息号集合——已被 `entryStateFor`（单源派生，BUG-170）取代：
   * 状态只从 `deriveEntryState` 出，不再由本集合在渲染点拼接。保留注释说明
   * 演进史，集合本身删除以免出现第二套「缓存中」判据。
   */

  /** 整组缓存进度（键与渲染处一致：`a-{chatId}-{groupId}`；单飞下至多一项 running + 若干排队）
   *  BUG-181：排队组以 `queued:true` 进表（呈现「排队中」）；running 组带条目内字节。 */
  const albumProgress = useMemo(() => {
    const m = new Map<string, AlbumProgress>()
    if (activeTask && activeTask.groupId !== undefined && activeTask.groupId !== null) {
      m.set(`a-${activeTask.chatId}-${activeTask.groupId}`, {
        done: activeTask.done,
        total: activeTask.total,
        itemBytes: activeTask.itemBytes,
        itemBytesTotal: activeTask.itemBytesTotal,
      })
    }
    for (const q of queuedTasks) {
      if (q.groupId === undefined || q.groupId === null) continue
      const k = `a-${q.chatId}-${q.groupId}`
      if (!m.has(k)) m.set(k, { done: 0, total: q.total, queued: true })
    }
    return m
  }, [activeTask, queuedTasks])

  /** 单条任务的条目内字节（BUG-181）：单条 running 时把字节映射到它的消息号上 */
  const singleProgress = useMemo(() => {
    const m = new Map<number, { itemBytes?: number; itemBytesTotal?: number }>()
    if (
      activeTask &&
      activeTask.status === 'running' &&
      activeTask.messageIds.length === 1
    ) {
      m.set(activeTask.messageIds[0], {
        itemBytes: activeTask.itemBytes,
        itemBytesTotal: activeTask.itemBytesTotal,
      })
    }
    return m
  }, [activeTask])

  /**
   * 条目呈现状态**单源派生**（BUG-170）：气泡/相册的「未缓存/缓存中/已缓存/
   * 缺字节/失败」一律走 [`deriveEntryState`]，禁止在渲染点重写
   * `Boolean(downloaded || path)` 一类的三源拼接。
   *
   * 输入映射：字节真值 = `downloadedPaths`（后端 `downloaded_map` 已按磁盘探测
   * 过滤，Presence 即真值）；任务态 = 覆盖该消息的 `cacheTask`（含终态——失败
   * 信号全靠它）；过渡窗 = `awaitingSnapshotRef`（任务终态 → 快照到达之间持有旧态）。
   */
  const entryStateFor = useCallback(
    (item: FeedItem): EntryState => {
      const taskStatus = cacheTask &&
        cacheTask.chatId === item.chatId &&
        cacheTask.messageIds.includes(item.messageId)
          ? cacheTask.status
          : // BUG-181：不在当前任务里时看排队覆盖——入队第二组的下一拍即点亮
            // 「排队中」，不再被打回「未缓存」（呈现为「无法添加」的根因）。
            queuedTasks.some(
              (q) => q.chatId === item.chatId && q.messageIds.includes(item.messageId),
            )
            ? 'queued'
            : null
      const prev = entryStateHoldRef.current.get(item.key) ?? null
      const next = deriveEntryState({
        bytesPresence: downloadedPaths.has(item.key) ? 'present' : undefined,
        taskStatus,
        downloadedFlag: item.downloaded,
        kind: item.type,
        source: 'tg',
        prev,
        factPending: awaitingSnapshotRef.current,
      })
      entryStateHoldRef.current.set(item.key, next)
      return next
    },
    [cacheTask, queuedTasks, downloadedPaths],
  )

  /**
   * 轮询签名：id/status/done/currentId/itemBytes/queued/error 任一变化才算
   * 「状态真的变了」（BUG-181：itemBytes 进了签名，长条目下载期间每拍都触发
   * 重渲染，字节进度才可见）。快照返回新对象但内容没变（下载一条要几秒，
   * 5s 轮询绝大多数是空转）时**直接跳过 setState**——零重渲染。
   * 这是流畅度规则「等值短路」的落点。
   */
  const cacheTasksSigRef = useRef('')
  const refreshCacheTasks = useCallback(async () => {
    try {
      const { task, queued } = await getCacheTask()
      const queuedSig = queued.map((q) => q.id).join(',')
      const sig = task
        ? `${task.id}:${task.status}:${task.done}:${task.currentId ?? ''}:${task.itemBytes ?? ''}:${task.error ?? ''}:${queuedSig}`
        : ''
      if (sig === cacheTasksSigRef.current) return
      cacheTasksSigRef.current = sig
      setCacheTask(task)
      setQueuedTasks(queued)
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
    // BUG-170：终态事件本身不是字节事实——先进入过渡窗（持有旧态），
    // 直到下方快照落库（awaitingSnapshotRef 复位）才允许状态前进。
    awaitingSnapshotRef.current = true
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
        // 快照落库：单源事实到位，解除过渡窗持有。
        awaitingSnapshotRef.current = false
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
    // 原文只进日志（`describeTgFailure` 是纯函数，不留痕 —— 避免同一条原因被记两遍）。
    logTgReason(raw, 'tg-task')
    setError(describeTgFailure(raw, t))
  }, [cacheTask, setError, t])


  // v0.4.3：分组内订阅频道可直接点进内容页（在线流浏览）；监控频道仍走本地真列表。
  // （搜索词为全局状态，切频道时保留——结果视图跨频道，无需串台清理。）

  // 全局监控查找：`committed` 由 `TgGlobalSearch` 防抖 300ms 写入，本面板只负责查询
  useEffect(() => {
    if (!globalSearch) {
      setGlobalHits([])
      setGlobalSearching(false)
      return
    }
    // 关键词变了 → 结果集换了，上一轮展开的那条可能已不在列表里（BUG-151）。
    // 收起而不按 ref 保留：留着会出现「没有一行是展开态，却记着一个展开键」的悬空状态。
    setExpandedHit(null)
    let cancelled = false
    setGlobalSearching(true)
    searchTgMonitorMessages(globalSearch)
      .then((hits) => {
        if (!cancelled) setGlobalHits(hits)
      })
      .catch((e) => {
        // BUG-167：搜索是后台查询流，失败静默（结果区为空即信号）；
        // 瞬时传输错误不升级为全局「无法连接」断言与连接灯矛盾。原文已记日志。
        if (!cancelled) console.error('[tg] global search failed', e)
      })
      .finally(() => {
        if (!cancelled) setGlobalSearching(false)
      })
    return () => {
      cancelled = true
    }
  }, [globalSearch, setError, setGlobalHits, setGlobalSearching])

  /**
   * 命中集里的**可播**子集 —— 全局搜索预览的邻居序列（BUG-137）。
   *
   * 顺序即命中顺序（用户看到的那一行行结果），不按频道重排。
   * BUG-150：它只用于「这条能不能打开播放器」的准入判断；真正的邻居序列必须再按
   * 点击项的 kind 收窄（`sameSeqOf`），否则点图片会串到视频。
   */
  const playableHits = useMemo(() => globalHits.map(fromHit).filter(isPlayable), [globalHits])

  /** 命中集里与 `item` 同型的子序列（BUG-150，跨频道搜索结果版）。 */
  const sameKindOfHits = useEvent((item: FeedItem): FeedItem[] =>
    playableHits.filter((u) => isSameKind(u, item)),
  )

  /** 点全局命中 → 打开预览（已缓存走本地流，未缓存在线流）。
   * BUG-231：播放器标题必须是**内容标题**（命中消息的 caption），绝不能是频道名 ——
   * 用户裁定「要求是记录标题，不是频道；现在是显示频道，完全不知道内容」。
   * 频道名只用于结果分组（`globalGroups` 的 key），不进播放器标题。
   * 与本文件其他 openViewer 调用点（1286/1318 `item.caption?.trim()`）同一约定：
   * caption 为空时标题留空，由播放器内部兜底，不拿频道名顶替。 */
  const onGlobalHitPreview = useEvent((hit: TgStoredMessage & { channelTitle?: string }) => {
    const item = fromHit(hit)
    // BUG-137：命中集就是邻居序列（跨频道搜索结果按命中顺序）。此前这里只传
    // `[item]`，于是 TG 侧永远没有上一条/下一条，而同一个播放器在媒体库侧能连播整剧。
    // BUG-150：序列按点击项 kind 收窄 —— 点图片只在图片命中间翻，不串到视频。
    const seq = sameKindOfHits(item)
    const idx = seq.findIndex((u) => u.key === item.key)
    openViewer({
      title: hit.caption?.trim() || undefined,
      // 点击项不可播（file）时它不在序列里 —— 单条打开，不谎报位置。
      index: idx < 0 ? 0 : idx,
      items: toViewerItems(idx < 0 ? [item] : seq),
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
    setFeedError(null)
    setHasMore(true)
    setPendingNew(0)
    stickBottomRef.current = true
    // BUG-305：切频道即清高亮 —— 上一条频道的定位高亮不该跟到新频道来
    // （新频道的定位由 locateReq 重新驱动，见下方定位循环）。
    setHighlightKey(null)
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
        // BUG-167：内容流加载失败 → 面板内联提示（可重试的局部失败），
        // 不再升级为全局 toast——可用性唯一真相源是引擎横幅与三处连接灯。
        if (!cancelled)
          setFeedError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setFeedLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // monitoredSet 身份随监控列表变化，增删监控后自动重载；
    // feedReloadTick 为提示条点击的显式刷新。
  }, [selectedId, monitoredSet, feedReloadTick, applyStoredSnapshot])

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
        if (!cancelled && r.added > 0) {
          setPendingNew((n) => n + r.added)
          // 新内容可能命中筛选规则、也会抬高未读徽标 ⇒ 两个数字都要跟着走，
          // 否则用户看到的是「同步完了但数字没动」。
          // 直接调 API 而不复用 refreshMonitored/refreshFilters：那两个 useCallback
          // 声明在本 effect **之后**，写进依赖数组会在渲染期踩 TDZ。
          void listTgMonitorFilters()
            .then((f) => {
              if (!cancelled) setFilters(f)
            })
            .catch(() => {})
          void listTgMonitoredChannels()
            .then((m) => {
              if (!cancelled) setMonitoredList(m)
            })
            .catch(() => {})
        }
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

  // BUG-352：原「feed 图片逐个 by-ref 查是否已入库」的 effect 已删除 —— 图片的入库
  // 状态由字节真值与任务态派生，不需要第二套查询账本（也顺带去掉首屏 N+1 → 批量
  // 请求那一整条链）。

  /** 滚到顶部：按当前最旧消息 id 加载更早一页并 prepend */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const src = feedSourceRef.current
    // BUG-364：返回值 = 「这一轮是否真的发起了一次翻页」。定位循环据此计预算：
    // 面板未就绪（feed 空）/ 上一页仍在途 / 已无更多历史时的早退是**空转**，
    // 旧实现里这些空转也消耗 `LOCATE_MAX_PAGES` 预算 —— 冷面板下 300ms×20≈6s
    // 就烧光 20 页，而首屏要 4–19s 才到，循环在「加载媒体中…」的同屏里误报
    // `tg.locateFailed`。现在空转不计数，预算只对真实翻页生效。
    if (!src || loadingOlder || !hasMore || feed.length === 0) return false
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
      // BUG-167：滚动触发的翻页失败静默（原文已记日志）；失败后可再次滚动重试，
      // 不弹全局 toast 与连接灯矛盾。
      prependAnchorRef.current = null
      console.error('[tg] load older failed', e)
    } finally {
      setLoadingOlder(false)
    }
    // 翻页已发起（哪怕后端失败）—— 对定位循环记一次真实预算，防无限重试。
    return true
  }, [feed, loadingOlder, hasMore, setError, applyStoredSnapshot])

  /*
   * BUG-305：定位循环要读「最新一版」的 hasMore 与 loadOlder —— 它按 interval
   * 轮询，闭包若捕获旧值会对着上一页的 hasMore 翻页（陈旧闭包）。用 ref 转发，
   * 每体渲染更新一次，值永远是最新的，而 loadOlder 的身份不必进 effect 依赖
   * （否则每翻一页 feed 变、loadOlder 变、定位循环重启，永远找不到东西）。
   */
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder
  // BUG-364：定位循环的「面板就绪」判据 —— 首屏已落定**且**有内容（或确认无更多）。
  // 渲染期镜像（与 hasMoreRef 同款）：切频道后 feedLoading=true ⇒ 未就绪，循环
  // 只等待不翻页；首屏到达（或频道确实为空 / 加载失败已由 feedErrorRef 另行处理）
  // 后才进入翻页。冷面板首屏 4–19s 的窗口由此不再烧预算。
  const feedReadyRef = useRef(false)
  feedReadyRef.current = !feedLoading && (feed.length > 0 || !hasMore)
  // BUG-364：面板内联加载失败（BUG-167 的面板内提示）—— 定位循环见到即如实
  // 中止并 surfaced 该失败，绝不把「面板没加载出来」说成「消息找不到」。
  const feedErrorRef = useRef(feedError)
  feedErrorRef.current = feedError

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop < 40) void loadOlder()
  }, [loadOlder])

  // ---- 内容流相册聚合：相邻同 groupId 的消息合并为一个相册气泡（v0.4.2） ----
  const albumUnits = useMemo(() => groupAlbums(feed), [feed])

  /**
   * 按点击项的 kind 取**同型**邻居序列（BUG-150）。
   *
   * 此前这里是 `playableFeed = feed.filter(isPlayable)` —— 照片与视频混在一个序列里，
   * 于是点图片后 ‹ › 会翻到视频（用户报的「图片被当视频播放」）。
   *
   * 顺序与 feed 一致：`albumUnits` 是按 feed 顺序切出来的，展平即 feed 本身，
   * 所以相册的最后一张之后能走到**下一个同型单元**（相邻相册 / 下一条同型单发），
   * 而不是走到组内末尾就断。
   */
  const sameKindSeq = useMemo(() => {
    const cache = new Map<string, FeedItem[]>()
    return (item: FeedItem | undefined): FeedItem[] => {
      if (!item || !isPlayable(item)) return []
      const k = item.type
      let seq = cache.get(k)
      if (!seq) {
        seq = feed.filter((u) => isSameKind(u, item))
        cache.set(k, seq)
      }
      return seq
    }
  }, [feed])

  /**
   * 打开内置播放器并带上邻居序列（BUG-137）。
   *
   * 三处入口此前各自只传单条或单相册，于是 TG 侧永远没有上一条/下一条，而媒体库侧
   * 同一个播放器能连播整部剧集 —— 同一播放器两种能力，用户感知为「时好时坏」。
   * 这里统一按「点击项在**同型**序列中的真实位置」给 `index`（BUG-150：序列必须同型，
   * `MediaViewer` 内部按 kind 再分流只保证不跨型连播，管不住序列本身混型）。
   *
   * 点击项本身不可播（`file`）时它不在序列里 —— 此时退回调用方给的兜底列表
   * （单条或本相册），**不拿 0 顶上去**：那会打开另一条，等于谎报位置。
   */
  const openPlayable = useEvent(
    (item: FeedItem | undefined, fallback: FeedItem[], fallbackIndex: number) => {
      const seq = sameKindSeq(item)
      const idx = item ? seq.findIndex((u) => u.key === item.key) : -1
      // BUG-231：播放器标题必须是**内容标题**（条目 caption），绝不能是频道名 ——
      // 用户裁定「要求是记录标题，不是频道；现在是显示频道，完全不知道内容」。
      // 此前两处都传 `selectedChannel?.title`，频道消息流点播时播放器标题栏
      // 永远是频道名。频道名属于第一栏的频道列表，不进播放器标题。
      const contentTitle = item?.caption?.trim() || undefined
      if (!item || idx < 0) {
        openViewer({
          title: contentTitle,
          index: fallbackIndex,
          items: toViewerItems(fallback),
        })
        return
      }
      openViewer({ title: contentTitle, index: idx, items: toViewerItems(seq) })
    },
  )

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
        // BUG-253：真源总时长随条目下发，播放器据此显示正确总数。
        duration: u.duration,
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

  /**
   * 点开监控频道 = 已读（BUG-329）。
   *
   * 本地先把徽标归零（乐观），再让服务端推进该频道的已读游标。失败**不弹错**：
   * 这是一次后台尽力而为的记账，下一次拉监控列表会回到服务端的真值——
   * 不会出现「本地假归零、服务端永远记着」的分叉。
   */
  const openMonitored = useCallback(
    (id: number) => {
      // TGM-03：点监控行 = 互斥切入 `channel:<id>`（不再有第二份 selectedId/detail）
      cameFromListRef.current = null
      onTgModeChange(`channel:${id}`)
      setMonitoredList((prev) =>
        prev.map((c) => (c.channelId === id && c.newCount !== 0 ? { ...c, newCount: 0 } : c)),
      )
      void markTgChannelRead(id).catch(() => {
        // BUG-167 纪律：后台记账失败静默，不打脸连接灯。
      })
    },
    [onTgModeChange, setMonitoredList],
  )

  // ---- 文字筛选（BUG-329） ----
  const refreshFilters = useCallback(async () => {
    try {
      setFilters(await listTgMonitorFilters())
    } catch {
      // BUG-167：后台加载失败静默（顶部可用性横幅是唯一真相源）。
    }
  }, [])

  const addFilter = async () => {
    const keyword = filterDraft.trim()
    if (!keyword || filterAdding) return
    setFilterAdding(true)
    try {
      const label = filterLabelDraft.trim()
      await addTgMonitorFilter({ keyword, label: label || undefined })
      setFilterDraft('')
      setFilterLabelDraft('')
      setFilterDlgOpen(false)
      await refreshFilters()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFilterAdding(false)
    }
  }

  /*
   * 筛选节渲染派生（TGM-04）：
   * - `shownRules`：检索框过滤后的规则（纯客户端，量级 ≤ 几百）
   * - K 折叠：> K 条时默认只渲染前 K，其余收进「+N 条规则 ▾」（真控件）；
   *   节头计数恒显全量（BUG-125/133：折叠不改计数口径）
   * K 按最矮受支持窗口 900×600 下的首屏预算取（实现弧量几何后定，先 8）。
   */
  const FILTER_FOLD_K = 8
  const shownRules = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (q === '') return filters
    return filters.filter(
      (f) =>
        f.label.toLowerCase().includes(q) || f.keyword.toLowerCase().includes(q),
    )
  }, [filters, filterQuery])
  const rulesFolded = !filterExpanded && shownRules.length > FILTER_FOLD_K
  const visibleRules = rulesFolded ? shownRules.slice(0, FILTER_FOLD_K) : shownRules

  const removeFilter = async (id: number) => {
    try {
      await removeTgMonitorFilter(id)
      // 删掉的正是当前打开的那条 ⇒ 第二列必须退回进入筛选之前的那一屏，
      // 否则会停在一个已经不存在的筛选结果上（点什么都对不上）。
      if (tgFilterId === id) exitTransient()
      await refreshFilters()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // 挂载即拉一次筛选规则（命中数由服务端算，前端不重算一遍口径）。
  // 同步到新内容后也会重拉（见下方增量同步 effect），否则命中数会停在旧值。
  useEffect(() => {
    if (!alive) return
    void refreshFilters()
  }, [alive, refreshFilters])

  /**
   * BUG-305：消费「媒体库 → TG 面板」的跳转焦点。
   *
   * 与 `MediaLibraryPanel` 消费 `pendingMediaFocus`（流水线 → 媒体库）同构，
   * 方向相反：媒体库的「在 TG 中查看」入口把 `ref` 解析成 `(chatId, messageId)`
   * 设进 store，再 `navigate('tg')` 切来；本 effect 负责落地：
   *   ① 频道未监控 ⇒ 先从订阅（dialogs）列表找到它并加监控 —— 监控频道的
   *      消息流是本地真列表（键 `s-<chat>-<msg>`），可定位；
   *   ② 选中该频道并进内容态；
   *   ③ 把消息坐标交给定位循环（下一个 effect）滚动 + 高亮；
   *   ④ 焦点置回 null（一次性契约：迟到/重复焦点不二次消费）。
   *
   * 订阅列表尚未加载完（`channels` 为空）时**不判失败** —— `channels` 是本 effect
   * 的依赖，加载完成会自动重跑；列表已加载却没有该频道 ⇒ 坐标无效，清焦点并如实
   * 反馈（`tg.locateNoChannel`），不静默假装成功。
   */
  useEffect(() => {
    const focus = pendingTgFocus
    if (!focus) return
    const { chatId, messageId } = focus
    let cancelled = false
    void (async () => {
      if (!monitoredSet.has(chatId)) {
        const ch = channels.find((c) => c.id === chatId)
        if (!ch) {
          if (channels.length > 0) {
            setPendingTgFocus(null)
            setError(t('tg.locateNoChannel'))
          }
          return
        }
        try {
          await addTgMonitoredChannel({ channelId: ch.id, title: ch.title, username: ch.username })
          await refreshMonitored()
        } catch (e) {
          if (!cancelled) {
            setPendingTgFocus(null)
            setError(e instanceof Error ? e.message : String(e))
          }
          return
        }
      }
      if (cancelled) return
      // TGM-03：定位焦点 = 互斥切入 `channel:<chatId>`（单一写面）
      cameFromListRef.current = null
      onTgModeChange(`channel:${chatId}`)
      setHighlightKey(null)
      setLocateReq({ chatId, messageId })
      setPendingTgFocus(null)
    })()
    return () => {
      cancelled = true
    }
  }, [pendingTgFocus, monitoredSet, channels, refreshMonitored, setError, setPendingTgFocus, t])

  /**
   * BUG-305：定位循环 —— 在消息流里找 `s-/l-<chatId>-<messageId>`，
   * 命中即滚进可视区并高亮；不在当前页且仍有更早历史时有界翻页（每页 30 条，
   * 上限 `LOCATE_MAX_PAGES` 页）；翻完仍没有 ⇒ 停表、清状态并如实反馈
   * （`tg.locateFailed`）—— 不无限轮询、不静默。
   *
   * 为什么是轮询而不是「等 feed 变化」：切频道后 feed 异步到达，且目标消息
   * 可能不在第一页（要连续翻几页）；一个循环同时覆盖「等加载 / 翻页 / 命中」。
   *
   * BUG-364（误报根因修法）：旧循环把「没命中 + hasMore」一律当「该翻页」，
   * 而 `loadOlder` 在 feed 为空（面板未就绪）时早退 —— 早退不翻页却**照扣
   * 预算**，300ms×20≈6s 烧光 20 页，冷面板首屏（4–19s）还没到就判
   * `tg.locateFailed`（toast 与「加载媒体中…」同屏，且消息实证在库）。
   * 新契约四态分离，每态只做自己该做的事：
   *   ① 命中            ⇒ 高亮 + 滚动 + 清焦点（成功路径不变）；
   *   ② 面板加载失败    ⇒  surfaced 失败本身（`feedError`），不伪装成「找不到」；
   *   ③ 面板未就绪      ⇒ **只等待**（locateReq 仍在 ⇒ 界面显示「正在定位」），
   *                        不翻页、不扣预算；用户切走/回列表 ⇒ 焦点失效静默取消；
   *   ④ 就绪后翻页      ⇒ 只有 `loadOlder` 真发起了一次翻页才扣一页预算；
   *      预算尽/无更多   ⇒ 此时「不在可加载范围内」才是事实，才报 locateFailed。
   */
  useEffect(() => {
    if (!locateReq) return
    const { chatId, messageId } = locateReq
    const keys = [`s-${chatId}-${messageId}`, `l-${chatId}-${messageId}`]
    let cancelled = false
    let busy = false
    let pages = 0
    const findHit = () => {
      for (const k of keys) {
        const el = document.querySelector(`[data-message-key="${k}"]`)
        if (el) return { k, el }
      }
      return null
    }
    const tick = async () => {
      if (cancelled || busy) return
      busy = true
      try {
        const hit = findHit()
        if (hit) {
          setHighlightKey(hit.k)
          setLocateReq(null)
          // 下一帧再滚：等高亮态渲染进 DOM，滚动目标才是最终形态
          requestAnimationFrame(() => hit.el.scrollIntoView({ block: 'center' }))
          return
        }
        // ② 面板内容流加载失败 ⇒ 定位无从谈起：如实 surfaced 失败原因，
        //    绝不把「面板没加载出来」写成「消息找不到」（误报的直接来源）。
        if (feedErrorRef.current) {
          setLocateReq(null)
          setError(feedErrorRef.current)
          return
        }
        // ③ 面板已离开目标频道（用户切到别的频道 / 回列表）⇒ 焦点失效，
        //    静默取消——不拿旧频道的结论报新频道的案，也不误报「找不到」。
        const src = feedSourceRef.current
        if (!src || src.chatId !== chatId) {
          setLocateReq(null)
          return
        }
        // ③b 目标频道首屏未就绪 ⇒ 只等待。冷面板首屏 4–19s，旧实现在这里
        //      空转烧光预算；现在预算一分不花，界面持续显示「正在定位」。
        if (!feedReadyRef.current) return
        // ④ 就绪后翻页：仅当 loadOlder 真发起了一次翻页才扣预算
        //      （空转/在途/无更多都不扣 —— 预算只对真实翻页生效）。
        if (hasMoreRef.current && pages < LOCATE_MAX_PAGES) {
          const started = await loadOlderRef.current()
          if (started) {
            pages += 1
          }
          return
        }
        // ④b 走到这里 = 面板就绪、真实翻页已尽（或本就可加载范围已穷）：
        //      「不在可加载范围内」此时才是事实。
        setLocateReq(null)
        setError(t('tg.locateFailed'))
      } finally {
        busy = false
      }
    }
    const h = setInterval(() => void tick(), LOCATE_TICK_MS)
    return () => {
      cancelled = true
      clearInterval(h)
    }
  }, [locateReq, setError, t])

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
   * 开始回溯：只登记目标 + 服务端立刻翻一页，剩下的由后台 tick 慢慢翻。
   *
   * `kicked=false` **不是失败**（另一路同步正在跑，下一轮接着翻）⇒ 不报错。
   * 回执里的 `backfillUntil` 直接写回本地行，用户马上能看到「回溯中」状态。
   */
  const doBackfill = async (channelId: number) => {
    if (backfillBusy) return
    if (!backfillDate) {
      setError(t('tg.backfillInvalidDate'))
      return
    }
    setBackfillBusy(true)
    try {
      const res = await startTgMonitorBackfill(channelId, backfillDate)
      setMonitoredList((prev) =>
        prev.map((c) =>
          c.channelId === channelId ? { ...c, backfillUntil: res.backfillUntil } : c,
        ),
      )
      setBackfillFor(null)
      setBackfillDate('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackfillBusy(false)
    }
  }

  /** 取消回溯：只停翻页，已入库的历史消息保留（不回滚）。 */
  const doCancelBackfill = async (channelId: number) => {
    if (backfillBusy) return
    setBackfillBusy(true)
    try {
      await cancelTgMonitorBackfill(channelId)
      setMonitoredList((prev) =>
        prev.map((c) => (c.channelId === channelId ? { ...c, backfillUntil: 0 } : c)),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackfillBusy(false)
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
      const res = await enqueueCacheTask({ chatId: item.chatId, messageIds: [item.messageId] })
      // BUG-308（D22-A②）：该条已入库（字节在盘）⇒ 后端拦下，不重下、不新建任务行。
      if (res.alreadyIngested) {
        setToast(t('tg.alreadyIngested'))
        return
      }
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
      const res = await enqueueCacheTask({
        chatId: items[0].chatId,
        messageIds: items.map((it) => it.messageId),
        groupId: items[0].groupId,
      })
      // BUG-308（D22-A②）：整组已入库 ⇒ 后端拦下（零字节重下、零新任务行）。
      if (res.alreadyIngested) {
        setToast(t('tg.alreadyIngested'))
        return
      }
      await refreshCacheTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 取消整组缓存：取消服务端任务（worker 在下一条目间隙退出；排队任务直接出队）。 */
  const cancelAlbum = async (key: string) => {
    // 单飞模型：当前任务或任一排队任务覆盖该组时都可取消（BUG-181：排队前也可撤）。
    const target =
      (activeTask && `a-${activeTask.chatId}-${activeTask.groupId}` === key ? activeTask : null) ??
      queuedTasks.find((q) => `a-${q.chatId}-${q.groupId}` === key)
    if (!target) return
    try {
      await cancelCacheTask(target.id)
      await refreshCacheTasks()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 用系统默认播放器打开已下载文件（Tauri 壳内；网页调试环境降级为复制路径，BUG-286） */
  const openDownloaded = async (item: FeedItem) => {
    const path = downloadedPaths.get(item.key)
    if (!path) return
    if (!isTauri()) {
      // 没有 opener 通道 ⇒ 至少把文件所在路径交到用户手上（失败即静默：这条入口本来就只在壳内有意义）。
      await copyToClipboard(path)
      return
    }
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener')
      await openPath(path)
    } catch (e) {
      console.error('openPath failed', e)
    }
  }

  /**
   * 稳定回调（useEvent）：子气泡全部 memo 化后，回调引用必须恒定。
   * 子组件回传自己的数据（item / items / index），这里点击时再取最新闭包，
   * 既保住 memo 的浅比较，又不产生陈旧闭包。
   */
  const onBubbleDownload = useEvent((item: FeedItem) => void doDownload(item))
  const onBubbleOpen = useEvent((item: FeedItem) => void openDownloaded(item))
  const onBubblePreview = useEvent((item: FeedItem) => openPlayable(item, [item], 0))
  const onAlbumDownload = useEvent((items: FeedItem[]) => void downloadAlbum(items))
  const onAlbumCancel = useEvent((items: FeedItem[]) =>
    void cancelAlbum(`a-${items[0].chatId}-${items[0].groupId}`),
  )
  /**
   * 相册预览：`items` 是**一个**相册单元，序列却要覆盖**相邻单元**（BUG-137）。
   *
   * 组内位置 `index` 是单元内下标，不能直接拿去当全流下标：换算交给
   * `openPlayable`（按 key 在可播序列里定位）。走到组内最后一张之后因此还能继续
   * 翻到下一个单元，而不是像此前那样断在相册边界。
   */
  const onAlbumPreview = useEvent((index: number, items: FeedItem[]) =>
    openPlayable(items[index], items, index),
  )

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="tg-panel-root"
    >
      {/*
        原先这里的顶部工具条只为「缓存管理」一个按钮而存在：1248x41 的容器里只有
        一个 89x28 的按钮 —— 一整行被单个按钮占着。入口已上移到上下文栏右槽
        （`TgCacheEntry`，与连接态/速度同处一行），本行整条删除，不留空 div 占位。
      */}
      <div className="flex min-h-0 flex-1">
      {/*
        M0-T05：五路分流（按优先级从上到下）。
        1. `tgUnbound`：服务在跑、没有登录会话 → 未绑定引导（判据见上）。
        2. `tgBroken`：链路真断 → 红色故障卡（这是「配好了但连不上」，
           与「没启用」不是一类事，故排在启用态之前）。
        3. `tgDisabled`（`known && !enabled`）：用户主动关着插件 → 引导去启用。
           （`!known` 的「服务未启动 / daemon 不可达」不算禁用，归下方「正在启动」。）
        4. `needConfig && !alive`：APP 首启缺凭证 → 原有配置表单。
        5. `!tgReady`：开着但 daemon 还没拉起 → 「正在启动」。
        6. 其余：正常两栏。
        历史：「TG 不可用就把用户弹回文件域」的 effect 已删（见 MainLayout），
        入口在任何状态下都不消失，改由这里的空态把原因说清。
      */}
      {tgUnbound ? (
        <TgOnboarding
          mode="unbound"
          onBind={onOpenAccounts}
          reasonKey={reasonKey}
          showReason={showReason}
        />
      ) : tgBroken ? (
        /* 链路故障：说明「为什么用不了」，而不是给一个空列表 */
        <div className="flex flex-1 items-center justify-center p-6" data-testid="tg-panel-broken">
          <div className="w-full max-w-md rounded-lg border border-danger/30 bg-danger/10 p-5">
            <h3 className="text-[14px] font-semibold text-danger" data-testid="tg-panel-broken-title">
              {t('tg.linkDown')}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-danger/90">
              {/* 面板内不自带「连接诊断」，故用面板专属文案（不指向账号页才有的区块） */}
              {t('tg.linkDownHint')}
            </p>
            {/* 原文不进 DOM（BUG-088）：只渲染分类降级后的中文文案 */}
            {showReason && (
              <p className="mt-3 rounded-md bg-surface/60 px-2 py-1.5 text-[10px] leading-relaxed text-danger">
                {t(reasonKey)}
              </p>
            )}
          </div>
        </div>
      ) : tgDisabled ? (
        /*
         * 插件未启用（M0-T05）：入口常驻后这里必须给出行动出口。
         * 「启用 Telegram 采集」跳到设置·Telegram —— 复用唯一的开关实现，
         * 不在这里另起一套启停逻辑。
         */
        <TgOnboarding mode="disabled" onEnable={onOpenAccounts} />
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
      ) : !tgReady ? (
        /*
         * 开着但还没起来（M0-T05）：daemon 正在拉起 orig-tg（`probeTg` 有界重试）。
         * **刻意无按钮** —— 手动重试入口曾让 TG 进程有两个主人互相 kill（BUG-178）。
         * 这一态以前会直接落到下面那个空的两栏面板，看起来像「没有内容」。
         */
        <TgOnboarding mode="starting" />
      ) : (
        <>
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-surface/30">
        {/*
         * 单一滚动容器（设计 §2.1）：撤掉监控节的 max-h-56 与分组节的 flex-1 各自限高
         * ——「规则多了挤垮分组」在结构上不可能发生（诉求②的结构性修法）。
         * 消费序：③ 筛选（每日第一眼）→ ② 监控 → ① 频道（默认折叠 = 优先级表达）。
         * （BUG-330 第三次复报：监听链状态条与 ①②③ 漏斗编号为无授权元素，已撤——
         *  元素授权台账见 BUG-330 复报记录；常量计数仍与 API 真值同源。）
         */}
        {/*
         * 单一滚动容器（设计 §2.1）：撤掉监控节的 max-h-56 与分组节的 flex-1 各自限高
         * ——「规则多了挤垮分组」在结构上不可能发生（诉求②的结构性修法）。
         * 消费序：③ 筛选（每日第一眼）→ ② 监控 → ① 频道（默认折叠 = 优先级表达）。
         */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* ===== ③ 筛选 · 我需要监听的内容（消费序①，默认展开） ===== */}
          <section id="tg-section-filter" className="border-b border-border-subtle/60">
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              {/*
               * BUG-101：折叠指示器此前是 10px 纯文本字符（读起来像装饰）且与标题共用
               * 同一个 <button>（点标题就折叠）。现为独立 lucide chevron 真控件
               *（热区 24×24），标题文字本身不可点（BUG-320）。
               */}
              <button
                type="button"
                aria-label={filterOpen ? t('tg.filterCollapse') : t('tg.filterExpand')}
                aria-expanded={filterOpen}
                aria-controls="tg-filter-list-body"
                data-testid="filter-collapse-toggle"
                onClick={() => setFilterOpen((v) => !v)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
              >
                {filterOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
                {t('tg.filterHeading')}
              </h3>
              {/*
               * 节头动作钮 token（BUG-344）：h-7 + 有边框有底色（secondary）。
               * BUG-327「存在≠可用」与 BUG-344「按钮过大/右边还有文字」的共同解 =
               * **可见性由边框+底色承担，不由尺寸+文字承担**：v3 的 h-9 图标+文字是
               * 对 BUG-327 的过度矫正（把「看得见」错当成「要大要有字」）；收敛为
               * 28px 图标钮 + secondary 边框底色后，既是真按钮又不占版面。
               * v3 新建入口（用户 2026-10-20 裁定）：节标题右上角图标钮 → 弹窗。
               * 撤掉规则列表下方常驻的「一行 Input + 添加按钮」——用户原话「当前下方
               * 一行的方式严重破坏了整体设计」。弹窗内控件沿用 BUG-329 既有 testid
               * （验收 selector 不变）。
               */}
              <div className="relative shrink-0">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={t('tg.filterNewDlgTitle')}
                  aria-expanded={filterDlgOpen}
                  aria-haspopup="dialog"
                  data-testid="tg-filter-new"
                  onClick={() => setFilterDlgOpen((v) => !v)}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                {filterDlgOpen && (
                  <div
                    role="dialog"
                    aria-label={t('tg.filterNewDlgTitle')}
                    data-testid="tg-filter-dialog"
                    className="absolute right-0 top-full z-20 mt-1 w-60 rounded-md border border-border-subtle bg-surface p-2 shadow-lg"
                  >
                    <p className="px-1 pb-1.5 text-[12px] font-semibold text-fg-strong">
                      {t('tg.filterNewDlgTitle')}
                    </p>
                    <Input
                      autoFocus
                      value={filterDraft}
                      onChange={(e) => setFilterDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addFilter()
                        if (e.key === 'Escape') setFilterDlgOpen(false)
                      }}
                      placeholder={t('tg.filterKeywordPlaceholder')}
                      aria-label={t('tg.filterKeyword')}
                      data-testid="tg-filter-input"
                      className="h-8 text-[13px]"
                    />
                    <Input
                      value={filterLabelDraft}
                      onChange={(e) => setFilterLabelDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void addFilter()
                        if (e.key === 'Escape') setFilterDlgOpen(false)
                      }}
                      placeholder={t('tg.filterLabelDlgPlaceholder')}
                      aria-label={t('tg.filterLabelPlaceholder')}
                      data-testid="tg-filter-label-input"
                      className="mt-1 h-8 text-[13px]"
                    />
                    <div className="mt-1.5 flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-[12px]"
                        onClick={() => setFilterDlgOpen(false)}
                      >
                        {t('tg.cancel')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 px-2 text-[12px]"
                        onClick={() => void addFilter()}
                        disabled={!filterDraft.trim() || filterAdding}
                        data-testid="tg-filter-add"
                      >
                        {filterAdding ? t('tg.filterAdding') : t('tg.filterAdd')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {filterOpen && (
              <div id="tg-filter-list-body" className="px-1.5 pb-1.5">
                {/* 节内检索框（常驻）：规则量级 ≤ 几百，纯客户端过滤。
                    BUG-320 纪律：入口可见性不搞「规则多了才出现」。 */}
                <div className="px-1 pb-1">
                  <Input
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder={t('tg.filterSearchPlaceholder')}
                    aria-label={t('tg.filterSearchPlaceholder')}
                    data-testid="tg-filter-search"
                    className="h-7 text-[12px]"
                  />
                </div>
                {/* 文字筛选（BUG-329）：每条规则是**并列的一个条目**（用户裁定
                    「一条相当于一条监控」），不是单频道内叠加条件的复合过滤器。 */}
                <div className="space-y-1" data-testid="tg-filter-list">
                  {filters.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">
                      {t('tg.filterEmpty')}
                    </p>
                  ) : shownRules.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] leading-relaxed text-muted">
                      {t('tg.filterNoRulesMatch')}
                    </p>
                  ) : (
                    visibleRules.map((f) => {
                      const active = activeFilter?.id === f.id
                      /* label≡keyword 去重（v3）：routes.rs label 缺省 = keyword、前端旧版
                         不传 label ⇒ UI 所建规则 100% 同词，标题行 + 副行渲染出"同一文字
                         2 串"（用户投诉）。判据：两者相同 ⇒ 只留标题行；用户自起显示名
                         （两者不同）时才两行都显。 */
                      const sameAsKeyword = f.label === f.keyword
                      return (
                        <div
                          key={f.id}
                          data-testid="tg-filter-row"
                          className={cn(
                            'flex items-center gap-1 rounded-md pr-1 transition-colors',
                            active ? 'bg-accent/10' : 'hover:bg-surface-2/70',
                          )}
                        >
                          <button
                            onClick={() => {
                              enterTransient(`filter:${f.id}`)
                              /* 点开这条规则 = 已读（TGM-04，同频道 mark read 范式）：
                                 本地先乐观归零，再让服务端推进游标；失败静默回真值。 */
                              setFilters((prev) =>
                                prev.map((x) =>
                                  x.id === f.id && (x.newHits ?? 0) > 0
                                    ? { ...x, newHits: 0 }
                                    : x,
                                ),
                              )
                              void markTgFilterRead(f.id).catch(() => {})
                            }}
                            aria-label={t('tg.filterRowA11y', {
                              label: f.label,
                              n: f.hits,
                            })}
                            data-testid="tg-filter-chip"
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium text-fg-strong">
                                {f.label}
                              </p>
                              {!sameAsKeyword && (
                                <p className="truncate text-[12px] text-muted">“{f.keyword}”</p>
                              )}
                            </div>
                            {/* +N 新命中徽标（TGM-04 新增；0 不渲染——同 BUG-329 徽标纪律） */}
                            {f.newHits && f.newHits > 0 ? (
                              <span
                                data-testid="tg-filter-new-badge"
                                data-count={f.newHits}
                                title={t('tg.filterNewBadge', { n: f.newHits })}
                                className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-accent"
                              >
                                +{f.newHits}
                              </span>
                            ) : null}
                            {/* 命中计数（BUG-360）：`aria-hidden` —— 它已由行的 aria-label
                                说明（「命中 N 条」）。不藏的话辅助技术会把标签与计数读成
                                一串无分隔的文字（"琼明神女录14 条"），正是用户报的
                                「展示的内容也是混乱的」在可访问性上的同一件事。 */}
                            <span
                              data-testid="tg-filter-hits-count"
                              aria-hidden="true"
                              className="shrink-0 rounded-md border border-border-subtle px-1.5 py-0.5 text-[12px] tabular-nums text-fg-mid"
                            >
                              {t('tg.filterHits', { n: f.hits })}
                            </span>
                          </button>
                          {/* 删除钮（BUG-360）：命中区从 28×28 提到 36×36（BUG-327 的
                              「整行可点、命中区 ≥36px」对行内次要动作同样成立）——
                              28px 的 ✕ 在 192px 侧栏里既难点中也读不出是按钮。 */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0 text-muted hover:text-danger"
                            onClick={() => void removeFilter(f.id)}
                            title={t('tg.filterRemove')}
                            aria-label={t('tg.filterRemove')}
                            data-testid="tg-filter-remove"
                          >
                            ✕
                          </Button>
                        </div>
                      )
                    })
                  )}
                </div>
                {/* 规则超 K 折叠（v3，用户「多个显示超出规则后的折叠和展示」）：
                    真 button + aria-expanded/aria-controls（BUG-320）；节头计数恒显全量
                    （折叠不改计数口径，BUG-125/133）。 */}
                {shownRules.length > FILTER_FOLD_K && (
                  <button
                    type="button"
                    aria-expanded={filterExpanded}
                    aria-controls="tg-filter-list"
                    data-testid="tg-filter-fold-toggle"
                    onClick={() => setFilterExpanded((v) => !v)}
                    className="mt-1 flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-surface-2/70"
                  >
                    {filterExpanded ? (
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {filterExpanded
                      ? t('tg.filterCollapseRules')
                      : t('tg.filterMoreRules', { n: shownRules.length - FILTER_FOLD_K })}
                  </button>
                )}
              </div>
            )}
          </section>
          {/* ===== ② 监控 · 只检查这些频道的更新（消费序②，只读投影 §2.7） ===== */}
          <section id="tg-section-monitor" className="border-b border-border-subtle/60">
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <button
                type="button"
                aria-label={monitorOpen ? t('tg.monitorCollapse') : t('tg.monitorExpand')}
                aria-expanded={monitorOpen}
                aria-controls="tg-monitor-list"
                data-testid="monitor-collapse-toggle"
                onClick={() => setMonitorOpen((v) => !v)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
              >
                {monitorOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              {/* 设计 §2.1 图标纪律：节头禁 emoji —— 原此处 `⭐`（全仓唯一节头 emoji）已清除 */}
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
                {t('tg.navMonitor')}
              </h3>
              <Button
                variant="secondary"
                size="xs"
                onClick={doSync}
                disabled={syncing || monitoredList.length === 0}
              >
                {syncing ? t('tg.syncing') : t('tg.sync')}
              </Button>
            </div>
            {monitorOpen && (
              <div
                id="tg-monitor-list"
                data-testid="tg-monitor-list"
                className="p-1.5"
              >
                {monitoredRows.length === 0 ? (
                  <p className="px-2 py-4 text-center text-xs text-muted">{t('tg.monitorEmpty')}</p>
                ) : (
                  monitoredRows.map((ch) => {
                    const active = selectedId === ch.id && !activeFilter
                    const backfillOpen = backfillFor === ch.id
                    const backfillRunning = (ch.backfillUntil ?? 0) > 0
                    return (
                      <div key={ch.id}>
                      <div
                        className={cn(
                          'group flex items-center gap-1 rounded-md pr-1 transition-colors',
                          active ? 'bg-accent/10' : 'hover:bg-surface-2/70',
                        )}
                      >
                        <button
                          onClick={() => openMonitored(ch.id)}
                          data-testid="tg-monitor-row"
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg-mid">
                            {(ch.title || '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-fg-strong">
                              {ch.title}
                            </p>
                          </div>
                          {/* 未读徽标（BUG-329）：口径 =「自上次点开以来新增」。
                              0 条时不渲染 —— 一排「+0」既占位又暗示有新内容。 */}
                          {ch.newCount && ch.newCount > 0 ? (
                            <span
                              data-testid="tg-monitor-new-badge"
                              data-count={ch.newCount}
                              title={t('tg.monitorNewHint', { n: ch.newCount })}
                              className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-accent"
                            >
                              +{ch.newCount}
                            </span>
                          ) : null}
                        </button>
                        {/* 回溯入口：**条目级动作**，只在这一行，不上提到节头
                            （层级纪律 BUG-324）。未在回溯时也渲染，只是不再展开表单。 */}
                        <Button
                          variant="ghost"
                          size="xs"
                          data-testid="tg-monitor-backfill-open"
                          aria-expanded={backfillOpen}
                          title={t('tg.backfill')}
                          disabled={backfillBusy}
                          onClick={() => {
                            setBackfillFor(backfillOpen ? null : ch.id)
                            setBackfillDate('')
                          }}
                          className="h-9 shrink-0 px-2 text-[12px]"
                        >
                          {t('tg.backfill')}
                        </Button>
                        {/* §2.7 单一写面：行尾 ✕ 已撤 —— 取消监控的唯一入口上移到
                            主列频道实体行（与分组管理列表的 Switch 同写面）。 */}
                      </div>
                      {/*
                       * 回溯进行中：进度**必须可见**。回溯是长跑（后台每轮一页），
                       * 不显示状态的话用户点了「回溯到 1 月」之后毫无反馈，
                       * 只会以为按钮没生效（BUG-327「存在≠可用」的同一个坑）。
                       */}
                      {backfillRunning ? (
                        <div
                          data-testid="tg-monitor-backfill-progress"
                          data-until={ch.backfillUntil}
                          className="mb-1 flex items-center gap-2 rounded-md bg-surface-2/60 px-2 py-1.5"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-fg-mid">
                            {t('tg.backfillRunning', { date: fmtDateOnly(ch.backfillUntil ?? 0) })}
                          </span>
                          <Button
                            variant="ghost"
                            size="xs"
                            data-testid="tg-monitor-backfill-cancel"
                            title={t('tg.backfillCancelHint')}
                            disabled={backfillBusy}
                            onClick={() => void doCancelBackfill(ch.id)}
                            className="h-9 shrink-0 px-2 text-[12px]"
                          >
                            {t('tg.backfillCancel')}
                          </Button>
                        </div>
                      ) : null}
                      {/* 表单挂在行下方（不是弹窗）：弹窗要处理定位/遮挡/关闭，
                          而这只是「选个日期 + 一个按钮」，内联更稳也更好测。 */}
                      {backfillOpen ? (
                        <div
                          data-testid="tg-monitor-backfill-form"
                          className="mb-1 rounded-md border border-border-subtle bg-surface-2/40 p-2"
                        >
                          <p className="mb-1.5 text-[12px] leading-relaxed text-muted">
                            {t('tg.backfillHint')}
                          </p>
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor={`tg-backfill-date-${ch.id}`}
                              className="shrink-0 text-[12px] text-fg-mid"
                            >
                              {t('tg.backfillDateLabel')}
                            </label>
                            <input
                              id={`tg-backfill-date-${ch.id}`}
                              type="date"
                              data-testid="tg-monitor-backfill-date"
                              value={backfillDate}
                              onChange={(e) => setBackfillDate(e.target.value)}
                              className="h-9 min-w-0 flex-1 rounded-md border border-border-subtle bg-surface px-2 text-[13px] text-fg-strong"
                            />
                          </div>
                          <div className="mt-2 flex justify-end">
                            <Button
                              variant="secondary"
                              size="xs"
                              data-testid="tg-monitor-backfill-start"
                              disabled={backfillBusy}
                              onClick={() => void doBackfill(ch.id)}
                              className="h-9 px-3 text-[12px]"
                            >
                              {t('tg.backfillStart')}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </section>

          {/* ===== ① 频道 · 来源（消费序③，默认折叠） ===== */}
          <section id="tg-section-channels">
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <button
                type="button"
                aria-label={channelOpen ? t('tg.channelCollapse') : t('tg.channelExpand')}
                aria-expanded={channelOpen}
                aria-controls="tg-channel-list"
                data-testid="channel-collapse-toggle"
                onClick={() => setChannelOpen((v) => !v)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
              >
                {channelOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
                {t('tg.navChannels')}
              </h3>
              {/*
               * BUG-340（2026-10-20 夜用户报障）：节头原有三样全撤——① `(524)` dialogs
               * 全量扫描原始计数（用户原话「数字…全是错误内容」）；②「N 个监控中」
               * （监控规模归监控节，这里是重复且易误读的二手数）；③「正在后台扫描订阅
               * 列表…」+ 脉冲点（后台状态文本，用户判定破坏样式）。连同筛选/监控节头的
               * `(N)` 计数与 `—` 兜底一并撤除（v4 元素授权台账：面板只放用户点过名的
               * 元素；数据未就绪 = 不渲染，从来没有 `(-)` 的需求——BUG-318 纪律）。
               * 节头只留标题 + 动作钮（刷新）。
               */}
              <Button
                variant="secondary"
                size="xs"
                onClick={() =>
                  // BUG-167：用户主动重扫失败仍给全局反馈（这是用户在等的动作结果，
                  // 与后台静默加载不同）；后台加载路径见挂载/轮询 effect 的静默分支。
                  void fetchDialogs(true).catch((e) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  )
                }
                disabled={!alive}
              >
                {t('tg.refresh')}
              </Button>
            </div>
            {channelOpen && (
              <div id="tg-channel-list" className="p-1.5">
                {groupSections.map((sec) => {
                  const active = groupMode === sec.key
                  return (
                    <button
                      key={sec.key}
                      data-testid="tg-group-row"
                        onClick={() => {
                          onTgModeChange(tgModeOfGroupKey(sec.key))
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
            )}
          </section>
        </div>
      </aside>

      {/* ===== 第二列：单一 tgMode 五分支（TGM-03：删四态与优先级链） ===== */}
      <section className="relative flex min-w-0 flex-1 flex-col bg-surface/20">
        {tgFilterId !== null && activeFilter ? (
          /* `filter:<id>`：这条规则的命中工作台。互斥切换 —— 它在场时其它模式
             不可表达（老优先级链 `activeFilter ? … : …` 删掉的原因）。 */
          <TgFilterPanel
            filter={activeFilter}
            onClose={() => exitTransient()}
            onIngested={() => {
              void refreshFilters()
            }}
          />
        ) : tgMode === 'search' ? (
          <>
            {/* 全局监控内容查找结果：跨全部监控频道，按频道分组（新→旧混排后归组）。
                搜索框已上移到上下文栏（BUG-100），这里只留范围说明 / 命中数 / 清除，
                避免同一 state 出现第二个输入框。 */}
            <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-4 py-2.5">
              {/* 原此处常驻「仅搜索已同步到本地的监控消息」（03bf4d4 引入）。
                  同 TgGlobalSearch：能力限制说明不做常驻元素，改在空态按需解释。 */}
              <span className="min-w-0 flex-1" />
              <span className="shrink-0 text-[11px] tabular-nums text-muted">
                {globalHits.length}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0"
                onClick={() => {
                  clearGlobalSearch()
                  // TGM-03：清除 = 退出瞬态 'search' 模式，回到进来之前的那一屏
                  // （不清 mode 的话，分支判据仍是 'search'，清除后停在一张空搜索台上）
                  if (tgMode === 'search') exitTransient()
                }}
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
                      const typ = hit.type ?? guessMediaType(hit.mimeType, hit.filePath)
                      const rk = hitKeyOf(hit)
                      const open = expandedHit === rk
                      const item = fromHit(hit)
                      const playable = isPlayable(item)
                      return (
                        <div key={rk} className="mb-0.5">
                          {/* 行 = 「展开这条内容」；播放是展开态里的二次动作（BUG-151）。
                              此前整行 onClick 直接开播放器，用户没有核对内容的机会。 */}
                          <button
                            type="button"
                            onClick={() => setExpandedHit(open ? null : rk)}
                            aria-expanded={open}
                            data-testid="tg-hit-row"
                            data-message-id={hit.messageId}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2/70',
                              open && 'bg-surface-2/70',
                            )}
                          >
                            <span className="w-6 shrink-0 text-center text-[9px] text-muted">
                              {open ? '▾' : '▸'}
                            </span>
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

                          {/* 展开态：复用 feed 的气泡呈现（同一份内容一个样子），
                              播放按钮只在**可播**时给出 —— 对纯文本/无媒体命中给播放按钮
                              等于把用户送进「不支持预览」。 */}
                          {open ? (
                            <div className="px-2 pb-1 pt-0.5" data-testid="tg-hit-detail">
                              <MessageBubble
                                item={item}
                                state={entryStateFor(item)}
                                downloadedPath={downloadedPaths.get(item.key)}
                                onDownload={onBubbleDownload}
                                onOpenDownloaded={onBubbleOpen}
                                onPreview={onBubblePreview}
                              />
                              {playable ? (
                                <div className="mt-1 flex justify-end">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() => onGlobalHitPreview(hit)}
                                    data-testid="tg-hit-play"
                                  >
                                    {t('tg.play')}
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </>
        ) : groupMode !== null && activeGroup ? (
          /* `channels` | `group:<x>`：分组管理列表（仅添加/取消监控，不浏览内容） */
          <>
            {/* 分组模式：组内频道列表（仅添加/取消监控，不浏览内容） */}
            <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg-strong">
                {activeGroup.title} ({activeGroup.count})
              </h3>
            </header>
            <div className="border-b border-border-subtle/60 px-3 pb-2 pt-2">
              <span
                className="mb-1 block text-[10px] text-muted"
                data-testid="tg-group-search-scope"
              >
                {t('tg.channelSearchScope')}
              </span>
              <div className="relative">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('tg.searchPlaceholder')}
                  className="h-8 pr-7 text-xs"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    aria-label={t('tg.globalSearchClear')}
                    data-testid="tg-group-search-clear"
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[11px] text-muted hover:bg-surface-2 hover:text-fg-strong"
                  >
                    x
                  </button>
                ) : null}
              </div>
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
                          // 从分组列表进内容页：记住来源，「← 返回」回到这个分组
                          cameFromListRef.current = tgMode
                          onTgModeChange(`channel:${ch.id}`)
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
            <header
              className="flex shrink-0 items-center gap-3 border-b border-border-subtle/60 px-4 py-2.5"
              /* BUG-305：当前频道的 DOM 事实（供跨视图跳转验收断言
                 `selectedChannel.channelId === chatId`，不读 className 推断）。 */
              data-testid="tg-channel-header"
              data-channel-id={selectedChannel.id}
            >
              {cameFromListRef.current !== null && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0"
                  onClick={() => {
                    // 回到进来之前的分组列表（TGM-03：瞬态前模式同款语义）
                    const back = cameFromListRef.current ?? 'channels'
                    cameFromListRef.current = null
                    onTgModeChange(back)
                  }}
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
                <>
                  <Chip tone="success">{t('tg.monitoring')}</Chip>
                  {/*
                   * §2.7 单一写面（BUG-330 TGM-02）：左栏 ② 监控节改为只读投影后，
                   * 「取消监控」的唯一入口随频道实体行落在这里（此前只有一个只读 Chip，
                   * 没有任何取消动作，取消只能去左栏行尾 ✕ / 分组管理列表 Switch）。
                   */}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="shrink-0 text-muted hover:text-danger"
                    onClick={() => {
                      if (selectedId !== null) void removeMonitor(selectedId)
                    }}
                    title={t('tg.unmonitor')}
                    aria-label={t('tg.unmonitor')}
                  >
                    {t('tg.unmonitor')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void addMonitor(selectedChannel)}
                >
                  {t('tg.addMonitor')}
                </Button>
              )}
            </header>

            {/* 监控内容搜索已上移到顶部上下文栏（跨全部监控频道，BUG-100 方案 A）；
                单频道过滤是它的子集，此处不再单设一框，也不再与结果视图头部各留一份。 */}

            {/* 消息流（滚动容器） */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
            >
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                {/* 顶部：历史加载状态 / 定位中（BUG-364） */}
                <div className="flex h-6 items-center justify-center">
                  {locateReq ? (
                    <span className="text-[11px] text-accent" data-testid="tg-locating">
                      {t('tg.locating')}
                    </span>
                  ) : loadingOlder ? (
                    <span className="text-[11px] text-muted">{t('tg.historyOlder')}</span>
                  ) : feed.length > 0 && !hasMore ? (
                    <span className="text-[11px] text-muted">{t('tg.historyNoMore')}</span>
                  ) : null}
                </div>

                {feedLoading ? (
                  <p className="py-10 text-center text-sm text-muted">{t('tg.historyLoading')}</p>
                ) : feedError ? (
                  /* BUG-167：内联失败提示（局部、可随重选频道消失），不升全局 toast */
                  <p className="py-10 text-center text-sm text-muted">{t('tg.feedLoadFailed')}</p>
                ) : feed.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">{t('tg.historyEmpty')}</p>
                ) : (
                  albumUnits.map((unit) =>
                    unit.length === 1 ? (
                      <MessageBubble
                        key={unit[0].key}
                        item={unit[0]}
                        state={entryStateFor(unit[0])}
                        downloadedPath={downloadedPaths.get(unit[0].key)}
                        progress={singleProgress.get(unit[0].messageId)}
                        highlighted={highlightKey === unit[0].key}
                        onDownload={onBubbleDownload}
                        onOpenDownloaded={onBubbleOpen}
                        onPreview={onBubblePreview}
                      />
                    ) : (
                      <AlbumBubble
                        key={`album-${unit[0].key}`}
                        items={unit}
                        highlighted={unit.some((u) => u.key === highlightKey)}
                        expanded={expandedAlbums.has(`album-${unit[0].key}`)}
                        onToggleExpand={() => toggleAlbum(`album-${unit[0].key}`)}
                        cacheTargets={
                          /* BUG-352：分母 = 组内**全部**条目（图片与视频都要落盘）。
                             此前把 photo 排除在外（BUG-049「图片不缓存」），代价是
                             纯图组的分母恒为 0 ⇒ 完成/进度两条判据同时失真。 */
                          unit.length
                        }
                        cachedTargets={
                          /* BUG-352：分子与分母同源 —— 同一把字节真值尺子
                             （`entryStateFor`，BUG-170 单源派生），图片不特殊。 */
                          unit.filter((x) => entryStateFor(x) === 'cached').length
                        }
                        progress={(() => {
                          // BUG-170：进度行持有——终态后快照到达前继续显示最后的
                          // 「缓存中 n/N」，条目全部离开 caching 才释放（不闪空洞）。
                          const k = `a-${unit[0].chatId}-${unit[0].groupId}`
                          const live = albumProgress.get(k)
                          if (live) albumProgressHoldRef.current.set(k, live)
                          const held = albumProgressHoldRef.current.get(k)
                          const stillCaching = unit.some((x) => entryStateFor(x) === 'caching')
                          if (!live && !stillCaching) albumProgressHoldRef.current.delete(k)
                          return live ?? (stillCaching ? held : undefined)
                        })()}
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
      </div>
      {cacheManagerOpen ? (
        <CacheManagerDialog
          channels={channels}
          onClose={() => setCacheManagerOpen(false)}
          onOpenMedia={onOpenMedia}
        />
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
  /** BUG-170：呈现状态由单源派生（deriveEntryState），本组件不再自行拼接 */
  state: EntryState
  /** 字节快照路径（播放按钮的事实依据；与 state 互补——photo 恒 cached 但未必有本地文件） */
  downloadedPath?: string
  /** BUG-049：图片已入库（图片不缓存，入库即终态） */
  /** 条目内字节进度（BUG-181）：单条任务下载中时展示 `已传/总量`，避免长下载全程冻结 */
  progress?: { itemBytes?: number; itemBytesTotal?: number }
  /**
   * BUG-305：是否是「媒体库 → TG 面板」跳转的定位目标。
   * 高亮是**给用户看**的落点确认；DOM 事实走 `data-tg-highlight` 属性
   * （验收断言读属性，不读 className 推断语义）。
   */
  highlighted?: boolean
  onDownload: (item: FeedItem) => void
  onOpenDownloaded: (item: FeedItem) => void
  onPreview: (item: FeedItem) => void
}) {
  const {
    item: m,
    state,
    downloadedPath,
    progress,
    highlighted = false,
    onDownload,
    onOpenDownloaded,
    onPreview,
  } = props
  const { t } = useTranslation()
  const cached = state === 'cached'
  const caching = state === 'caching'
  const queued = state === 'queued'
  return (
    <div
      className="flex flex-col"
      /* BUG-305：消息 key 的 DOM 事实（定位锚点 = `s-/l-<chatId>-<messageId>`）。 */
      data-message-key={m.key}
      data-tg-highlight={highlighted ? 'true' : undefined}
    >
      <div
        className={cn(
          'max-w-[88%] rounded-2xl rounded-tl-md border bg-surface p-2.5 shadow-sm',
          // BUG-305：定位高亮只做「描边」一层 —— 不改布局、不抢内容的戏
          highlighted ? 'border-accent ring-2 ring-accent/70' : 'border-border-subtle',
        )}
      >
        {m.type === 'photo' && (
          /* BUG-359：图片块只做预览；缓存入口在下方操作行（与视频同构的一处），
             不再往图上压一个黑框按钮 —— 同一动作两个入口就是「不清楚用途」的来源。 */
          <PhotoBlock item={m} onPreview={() => onPreview(m)} />
        )}
        {m.type === 'video' && (
          <VideoBlock
            item={m}
            downloaded={cached}
            downloading={caching || queued}
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
          {/* 条目内字节（BUG-181）：下载中时 `已传/总量` 是唯一活着的证据 */}
          {caching && progress?.itemBytesTotal ? (
            <span className="text-[10px] text-accent" data-testid="bubble-item-bytes">
              {fmtSize(progress.itemBytes ?? 0)}/{fmtSize(progress.itemBytesTotal)}
            </span>
          ) : null}
          {/* 呈现状态角标（BUG-170 单源派生）：已缓存 / 缺字节 / 失败 三态如实呈现 */}
          {cached && <Chip tone="success">{t('tg.downloaded')}</Chip>}
          {state === 'bytesMissing' && <Chip tone="warn">{t('tg.bytesMissing')}</Chip>}
          {state === 'failed' && <Chip tone="warn">{t('tg.statusFailed')}</Chip>}
          <span className="ml-auto text-[10px] text-muted">{fmtTime(m.date)}</span>
          {/* 缓存/播放按钮：视频与图片同构（BUG-046）——此前视频只靠海报上的 ⬇ 图标，
              图片却有显式「缓存」按钮，逻辑倒置。海报点击行为不变（已缓存=播放，
              缓存中=在线播放，未缓存=开始缓存），按钮是明确的兜底入口。 */}
          {/* 操作按钮（BUG-352：图片与视频同一把尺子）——已落盘=播放；否则=缓存/排队中/
              重试缓存。BUG-049 的「图片=加入图片库/已入库」分支已删除：图片同样是内容，
              同样落盘（不成「剧集」这一点不变，那是 BUG-044 的规则）。 */}
          {downloadedPath || m.downloaded ? (
            <Button variant="secondary" size="sm" className="h-6 px-2 text-[10px]" onClick={() => onOpenDownloaded(m)}>
              {t('tg.play')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={caching || queued}
              onClick={() => onDownload(m)}
            >
              {/* 缺字节/失败 = 条目在、字节未就绪 → 动词是「重试缓存」（BUG-170 语义定稿）；
                  排队中（BUG-181）= 在单飞队列等待，禁用按钮防止重复入队误导。 */}
              {caching
                ? t('tg.caching')
                : queued
                  ? t('tg.queued')
                  : state === 'bytesMissing' || state === 'failed'
                    ? t('tg.retryCache')
                    : t('tg.download')}
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
  /** BUG-352：组内**需要落盘**的条目数（= 组内全部条目，图片计入） */
  cacheTargets: number
  /** BUG-352：其中已落盘的条数（字节真值派生）。与 `cacheTargets` **同源** */
  cachedTargets: number
  /** 整组缓存进行中的进度（BUG-181：含排队态与条目内字节） */
  progress?: AlbumProgress
  /**
   * BUG-305：组内是否含「媒体库 → TG 面板」跳转的定位目标消息。
   * 相册是多个消息的聚合气泡：命中组内任一条即高亮整组（用户要的是
   * 「回到这条内容」，它在哪个相册里就该亮哪个相册）。
   */
  highlighted?: boolean
  onDownload: (items: FeedItem[]) => void
  /** 取消整组缓存（进行中时操作行显示「取消」） */
  onCancel?: (items: FeedItem[]) => void
  onPreview: (index: number, items: FeedItem[]) => void
  /**
   * 是否已展开（2026-10-22 用户第 3 点）。
   *
   * 折叠态**只渲染 1 张封面**：一个 10 张图的相册原本一次性发 10 个缩略图请求，
   * 而服务端 `thumb` 端点**没有缓存**（每次实时回源 Telegram）⇒ 滚一屏就是
   * 几十个 RPC。用户要的是「过滤下载」而不是「聊天浏览」，所以列表只给识别线索，
   * 点了才加载整组。
   */
  expanded?: boolean
  /**
   * 展开/收起回调。
   *
   * **没给就恒展开**（不是「给了个点不动的按钮」）：宿主没接线时组件必须保持
   * 旧行为，否则「能渲染的按钮做不了它承诺的事」——BUG-324 复报的死按钮。
   */
  onToggleExpand?: () => void
}) {
  const {
    items,
    cacheTargets,
    cachedTargets,
    progress,
    highlighted = false,
    onDownload,
    onCancel,
    onPreview,
    expanded = false,
    onToggleExpand,
  } = props
  const { t } = useTranslation()
  /* BUG-352：完成判据只有一条 —— **全部条目都有字节**。此前按组构成分叉
     （纯图组改判「图片是否已入库」），那是因为图片当时不落盘；现在图片与视频同样
     落盘，分叉就成了两套互斥的「完成」定义（同一组可以按一个口径算完成、按另一个
     算未完成）。分母恒为 `cacheTargets`（= 组内条目数，图片计入）。 */
  const allDone = cacheTargets > 0 && cachedTargets >= cacheTargets
  /*
   * 折叠判据三选一：
   *  - 宿主没给回调 ⇒ 恒展开（不留点不动的按钮）；
   *  - 定位高亮（BUG-305）⇒ 强制展开：用户要的是「回到这条内容」，
   *    把目标藏在折叠态里等于定位失败；
   *  - 单条 ⇒ 本身就是 1 张封面，没有「展开」可言。
   */
  const collapsible = items.length > 1 && !!onToggleExpand
  const open = expanded || highlighted || !collapsible
  const cover = items[0]
  const coverTyp = cover.type ?? guessMediaType(cover.mimeType, cover.filePath)
  const caption = items.find((it) => it.caption?.trim())?.caption
  const totalSize = items.reduce((s, it) => s + (it.size ?? 0), 0)
  return (
    <div className="flex flex-col" data-tg-highlight={highlighted ? 'true' : undefined}>
      <div
        className={cn(
          'max-w-[88%] rounded-2xl rounded-tl-md border bg-surface p-2.5 shadow-sm',
          // BUG-305：定位高亮只做「描边」一层（同 MessageBubble）
          highlighted ? 'border-accent ring-2 ring-accent/70' : 'border-border-subtle',
        )}
      >
        {/* 状态行：相册计数 + 缓存进度（纯文本弱化，文字归文字、按钮归按钮） */}
        <div className="mb-1.5 flex items-center gap-2 text-[10px]">
          <span className="font-medium text-accent">{t('tg.albumN', { n: items.length })}</span>
          {allDone ? (
            <span className="text-success">{t('tg.downloaded')}</span>
          ) : cachedTargets > 0 ? (
            <span className="text-muted">
              {/* BUG-184：分子分母同源（都只算需要落盘的条目） */}
              {t('tg.albumPartial', { n: cachedTargets, total: cacheTargets })}
            </span>
          ) : null}
          {collapsible && open ? (
            <button
              type="button"
              onClick={onToggleExpand}
              data-testid="album-collapse"
              className="ml-auto text-[11px] text-fg-mid transition-colors hover:text-fg-strong"
            >
              {t('tg.albumCollapse')}
            </button>
          ) : null}
          <span className={cn('text-muted', collapsible && open ? '' : 'ml-auto')}>
            {fmtTime(items[0].date)}
          </span>
        </div>

        {/*
         * 组内宫格：列数**按数量自适应**（1→单图 / 2→2列 / 3→3列 / 4→2×2 /
         * 5..10→3 列，即 5–10 宫格），图片一律 `object-contain`。
         *
         * 两处都改必然性、而非调数值：
         *  - 旧版固定 `grid-cols-2` + `aspect-square` + `object-cover`：4 图以上永远
         *    2 列（9 张图排成 5 行的长条），且 cover 把每张图**裁掉边缘** —— 用户报的
         *    「图片被截取、没有九宫格」就是这个组合造成的。宫格形状是数量决定的函数，
         *    不是写死的常量。
         *  - `ALBUM_MAX_TILES` **必须 ≥ 10**（BUG-160）：TG 相册上限 10，宫格上限一旦低于
         *    平台上限，满员相册的第 10 个内容就会被折进 `+N`、不作为独立瓦片出现（用户报
         *    的「最多 9 个内容 / 第 10 个被拆出去」）。现为 10 ⇒ 真实相册恒显示全量；
         *    `+N` 只对「> 10」起防御作用，其余图片在全屏浏览页里连翻。
         */}
        {!open ? (
          /*
           * 折叠态：**只发一个缩略图请求**。点击 = 展开整组，不是打开大图 ——
           * 用户原话「列表点击加载整个组内容」，所以第一次点击的语义是"把组摊开"。
           */
          <button
            type="button"
            onClick={onToggleExpand}
            data-testid="album-cover"
            data-count={items.length}
            data-chat-id={cover.chatId}
            data-message-id={cover.messageId}
            className="relative block w-full overflow-hidden rounded-lg bg-surface-2"
          >
            {coverTyp === 'photo' || coverTyp === 'video' ? (
              <img
                src={tgThumbUrl(cover.chatId, cover.messageId)}
                alt={cover.caption || ''}
                loading="lazy"
                className={cn(
                  'mx-auto h-auto max-h-[40vh] w-auto max-w-full',
                  coverFit(coverTyp),
                )}
              />
            ) : (
              <span className="flex aspect-video w-full items-center justify-center text-lg">
                {coverTyp === 'audio' ? '🎵' : '📄'}
              </span>
            )}
            {/* 数量角标：让用户在**展开之前**就知道这是一组，而不是一张 */}
            <span
              data-testid="album-cover-count"
              className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white"
            >
              {items.length}
            </span>
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white/90">
              {t('tg.albumExpandHint', { n: items.length })}
            </span>
          </button>
        ) : (
        <div
          data-testid="album-grid"
          className={cn('grid gap-1.5', albumGridClass(items.length))}
        >
          {items.slice(0, ALBUM_MAX_TILES).map((it, i) => {
            const typ = it.type ?? guessMediaType(it.mimeType, it.filePath)
            const dur = fmtDuration(it.duration)
            const overflow = items.length - ALBUM_MAX_TILES
            const isLastTile = i === ALBUM_MAX_TILES - 1 && overflow > 0
            const single = items.length === 1
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onPreview(i, items)}
                data-testid={`tg-album-tile-${i}`}
                data-message-id={it.messageId}
                /* BUG-305：瓦片也带消息 key —— 相册内单条消息同样是定位锚点 */
                data-message-key={it.key}
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
        )}

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
              {progress.queued ? (
                /* BUG-181：排队组——本轮还没轮到它，如实呈现「排队中」而非假装在缓存 */
                <span className="ml-auto text-[10px] text-muted" data-testid="album-queued">
                  {t('tg.queued')}
                </span>
              ) : (
                <span className="ml-auto text-[10px] text-muted" data-testid="album-progress">
                  {t('tg.cachingProgress', { n: progress.done, total: progress.total })}
                  {/* 条目内字节（BUG-181）：长条目下载期间 done 冻结，字节是唯一活着的证据 */}
                  {progress.itemBytesTotal
                    ? ` · ${fmtSize(progress.itemBytes ?? 0)}/${fmtSize(progress.itemBytesTotal)}`
                    : ''}
                </span>
              )}
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
            /* BUG-352：按钮语义不再按组构成分叉 —— 整组一个出口 `onDownload`
               （worker 落盘，图片与视频同等）。部分已下时给「继续 n/N」，
               分子分母同源（都按字节真值派生），没有任务时不会出现「继续 1/6」。 */
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-6 px-2 text-[10px]"
              onClick={() => onDownload(items)}
            >
              {cachedTargets > 0
                ? `${t('tg.continue')} ${cachedTargets}/${cacheTargets}`
                : t('tg.download')}
            </Button>
          ) : (
            /* BUG-185：完成态**不得落 null** —— 此前整行消失，用户无法区分
               「已完成」与「这个页面不支持缓存」。给明确标识 + 可点击出口，
               与单条完成后的「播放」按钮对称。 */
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-success" data-testid="album-done">
                {t('tg.downloaded')}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => onPreview(0, items)}
                data-testid="album-open"
              >
                {t('tg.play')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}, (a, b) =>
  a.items === b.items &&
  a.cacheTargets === b.cacheTargets &&
  a.cachedTargets === b.cachedTargets &&
  // BUG-364：`highlighted` 必须参与比较——定位命中时只有它翻转（false→true），
  // 漏了它 = 比较器判「相等」⇒ React 跳过重渲染 ⇒ 相册根拿不到
  // `data-tg-highlight`，「在 TG 中查看」点了不亮（单条消息走默认浅比较不受害，
  // 所以这个缺陷只在相册目标上现形，极易漏测）。
  a.highlighted === b.highlighted &&
  a.progress?.done === b.progress?.done &&
  a.progress?.total === b.progress?.total &&
  a.progress?.queued === b.progress?.queued &&
  a.progress?.itemBytes === b.progress?.itemBytes &&
  a.progress?.itemBytesTotal === b.progress?.itemBytesTotal &&
  true,
)

/** 图片块：列表用轻量缩略图（自然比例不裁切），点击弹遮罩看原图 */
/**
 * 图片块：**只做预览**（BUG-359）。
 *
 * 图片与视频是**两条互不相干的分支**（2026-10-21 用户裁定）：
 * - **剧集线（EP）**：图片永不进入（BUG-044 的触发器硬门）——「图片不入剧集」的
 *   全部含义到此为止，它**不**推导出「不下载」；
 * - **展示线**：图片必须能展示，而可靠展示依赖**本地字节**：未落盘时只能靠 `/raw`
 *   现场代理 TG，链路一断整库图片全瞎。所以图片同样要缓存，只是不参与成剧。
 *
 * 历史包袱：BUG-049 曾把「不入剧集」误扩成「不缓存」，气泡只剩预览、没有任何动作；
 * 引擎侧已由 BUG-352 改正（图片照常落盘）。入口补在**气泡操作行**（与视频同构，
 * 见 `MessageBubble` 尾部那一行）—— 不在图上再压一个黑框按钮：同一个动作两个入口、
 * 其中一个是压在内容上的半透明黑片，正是 BUG-359 用户报的「有黑框，不清楚用途」。
 */
function PhotoBlock(props: {
  item: FeedItem
  onPreview: () => void
}) {
  const { item, onPreview } = props
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
    <div className="relative">
      <button
        type="button"
        onClick={onPreview}
        className="block w-full overflow-hidden rounded-lg bg-surface-2"
        data-testid="tg-photo-preview"
        data-message-id={item.messageId}
      >
        <img
          src={tgThumbUrl(item.chatId, item.messageId)}
          alt={item.caption || ''}
          loading="lazy"
          onError={() => setErr(true)}
          className="mx-auto h-auto max-h-[60vh] w-auto max-w-full object-contain"
        />
      </button>
      {/*
        BUG-359：撤掉压在图上的「⬇ 缓存」黑框按钮。
        原形态是 `absolute right-1.5 top-1.5` + `bg-black/65` 的半透明黑片，与气泡
        操作行里那个「缓存」按钮是**同一个动作的两个入口** —— 用户原话
        「详情内容无法选择，但是有黑框，不清楚用途」：图上一个黑框、图下一行按钮，
        同一件事给两个控件，其中一个是压在内容上的装饰性黑块，自然读不出用途。
        判据（BUG-328 同族）：压在内容上的常驻动作条不进 DOM，动作只留流式那一处。
        缓存三态在图上一并撤掉：气泡操作行已有 Chip（已缓存/缺字节/失败）与按钮文案
        （缓存中/排队中/重试缓存/缓存）承载同一组状态，不因撤掉黑框丢信息。
      */}
    </div>
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
