/** 与 Rust daemon DownloadStatus 对齐的下载状态 */
export type DownloadStatusValue =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface DownloadStatus {
  id: string
  url: string
  filename: string
  dest_path?: string
  total_size: number
  downloaded: number
  progress: number
  speed: number
  status: DownloadStatusValue
  error?: string
  eta: number
  connections: number
  added_at: number
  time_taken: number
  avg_speed: number
  /** SSE Completed 事件附加 */
  hash_sha256?: string
  /** 每连接明细（BUG-002）：每个源一条 */
  connections_detail?: ConnInfo[]
  /** 分块位图（每块状态 0/1/2/3），块过多时为空改用计数 */
  blocks?: number[]
  /** 块总数 */
  blocks_total?: number
  /** 已完成块数 */
  blocks_done?: number
  /** 待下载块数 */
  blocks_pending?: number
  /** 每块负责源下标（255 = 未分配）；与 blocks 同门控，前端按网卡着色用 */
  block_source?: number[]
  /** 是否支持 Range（决定是否分块并发；前端据此判断是否渲染块网格） */
  supports_range?: boolean
  /** 自动分类名（后端按设置 classify_rules 推导；前端「全部文件」按此筛选） */
  category?: string
}

/** 单连接（源）实时状态（BUG-002） */
export interface ConnInfo {
  /** 连接序号 */
  id: number
  /** idle / downloading / error */
  state: string
  /** 当前下载块索引（idle/error 为 null） */
  block: number | null
  /** 瞬时速度 bytes/s */
  speed: number
  /** 绑定网卡名 */
  iface: string
  /** 源下标（主源=0） */
  source_index: number
}

export interface NetworkInterface {
  name: string
  /** Windows 友好名（如 Intel(R) Ethernet Connection），非 Windows 为 null */
  description?: string | null
  /** 主 IPv4；未连接/无地址为 null */
  ip: string | null
  is_default: boolean
  /** 是否已连接（有 IP 且 up）——只有 connected 才能参与加速 */
  connected: boolean
  /** 虚拟网卡（Hyper-V/WSL/隧道/Wi-Fi Direct） */
  is_virtual: boolean
  /** 是否在默认参与池（主网卡 true） */
  enabled: boolean
  /** 权重（≥1，默认 1） */
  weight: number
}

/** daemon AddReq.interfaces 契约：{primary?, primary_weight?, secondaries: {网卡名: 权重}} */
export interface InterfaceSpec {
  /** 指定主网卡（网卡名，可选；缺省自动识别） */
  primary?: string
  /** 主网卡权重份数（默认 2：主网卡占 2 份） */
  primary_weight?: number
  /** 附属网卡名 → 权重份数（默认 1） */
  secondaries?: Record<string, number>
}

export interface AddDownloadRequest {
  url: string
  filename?: string
  output_path?: string
  headers?: Record<string, string>
  interfaces?: InterfaceSpec
  max_connections?: number
  /** 自动分类（R3）：true=强制开启 / false=强制关闭 / 缺省=daemon 配置 */
  classify?: boolean
  /** 覆盖下载：目标文件已存在时先删除再重新下载 */
  overwrite?: boolean
  /** 本次下载代理：缺省用 daemon 配置；{mode:'direct'} 强制直连；{mode:'custom',url} 指定 */
  proxy?: { mode: 'direct' | 'system' | 'custom'; url?: string | null }
}

export interface DaemonStatus {
  alive: boolean
  port: number
  managed: boolean
}

export type ThemeValue = 'dark' | 'light' | 'system'

export type LanguageValue = 'zh-CN' | 'en-US'

/** orig-tg 会话快照（GET /api/tg/session） */
export interface TgSession {
  /** Anonymous | CodeRequired | PasswordRequired | Authorized */
  phase: string
  phone?: string | null
  user_id?: number | null
  /**
   * TG 依赖是否可用。`false` 表示 orig-tg 连不上 Telegram（凭证缺失或 MTProto 失败），
   * 此时 `reason` 给出原因 —— 注意这**不是**「未登录」，二者必须分开显示。
   */
  available?: boolean
  /** 不可用原因（`available === false` 时非空）。 */
  reason?: string | null
}

/**
 * TG 可用性三态（前端内部模型）。
 *
 * - `ok`：依赖可用，登录态由 `phase` 推导
 * - `unavailable`：orig-tg 活着，但它连不上 Telegram（后端给出 `reason`）
 * - `unreachable`：连 orig-tg 进程都够不到
 *
 * 后两态都**不**清空绑定态：不知道 ≠ 没登录（BUG-023 的界面根因）。
 */
export type TgAvailability =
  | { status: 'ok' }
  | { status: 'unavailable'; reason: string | null }
  | { status: 'unreachable' }

/** 频道/订阅会话摘要（GET /api/tg/dialogs） */
export interface TgChannel {
  id: number
  title: string
  username?: string
  /** 频道归属的 TG 分组标题；未归组则为 undefined */
  folder?: string
}

/** TG 自定义分组摘要（GET /api/tg/folders） */
export interface TgFolder {
  id: number
  title: string
  channelIds: number[]
}

/** 频道媒体消息摘要（GET /api/tg/messages/:chat_id） */
export interface TgMediaItem {
  id: number
  caption?: string
  mimeType?: string
  size?: number
  /** 媒体类型（v0.4.0：后端只返回媒体消息，photo/video/audio/file） */
  type?: 'photo' | 'video' | 'audio' | 'file'
  /** 原始文件名 */
  fileName?: string
  /** 消息在 TG 上的原始发布时间（Unix 秒） */
  date?: number
  /** 媒体时长（秒；视频/音频才有，v0.4.1） */
  duration?: number
  /** TG 相册分组 ID（grouped_id；同组消息构成一个相册，v0.4.2） */
  groupId?: number
  /** 是否含媒体附件 */
  hasMedia?: boolean
}

/** 被监控频道（GET/POST/DELETE /api/tg/monitor/channels） */
export interface TgMonitoredChannel {
  channelId: number
  title: string
  username?: string
  addedAt: number
}

/** 已入库媒体消息（GET /api/tg/monitor/messages） */
export interface TgStoredMessage {
  channelId: number
  messageId: number
  caption?: string
  mimeType?: string
  size?: number
  downloaded: boolean
  createdAt: number
  /** 媒体类型（v0.4.0 新列；历史旧行可能缺失，用 mimeType 兜底判型） */
  type?: 'photo' | 'video' | 'audio' | 'file'
  /** TG 原始发布时间（Unix 秒；历史旧行可能缺失，回退 createdAt） */
  date?: number
  /** 媒体时长（秒；视频/音频才有，v0.4.1） */
  duration?: number
  /** 已缓存文件绝对路径（downloaded 时有值，v0.4.1） */
  filePath?: string
  /** TG 相册分组 ID（grouped_id；同组消息构成一个相册，v0.4.2） */
  groupId?: number
}

/** 缓存库聚合行（GET /api/tg/stored）：媒体消息 + 所属频道标题 */
export interface TgStoredItem extends TgStoredMessage {
  /** 所属频道标题（频道取消监控后为 undefined） */
  channelTitle?: string
}

/** 媒体历史分页响应（messages / monitor/messages 统一） */
export interface TgMessagePage<T> {
  items: T[]
  /** 是否还可能有更早的历史页 */
  hasMore: boolean
}

/**
 * 服务端缓存任务（GET /api/tg/cache/tasks）。
 *
 * 状态归属服务端：刷新/切页/关标签页都不会再丢进度，前端只做读视图。
 * `status` 中 `interrupted` = 进程崩溃遗留（已无 worker），前端按「未完成、可继续」处理。
 */
export interface TgCacheTask {
  id: number
  chatId: number
  /** 相册分组 id（单条缓存时缺省） */
  groupId?: number
  /** 去重键：g:{chat}:{group} / m:{chat}:{msg} */
  itemKey: string
  messageIds: number[]
  total: number
  done: number
  status: 'queued' | 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted'
  /** 正在缓存的消息号 */
  currentId?: number
  /** 失败原因（status=failed 时有值） */
  error?: string
  createdAt: number
  updatedAt: number
}

/** orig-tg 运行诊断快照（GET /api/tg/diag） */
export interface TgDiag {
  health: string
  port: number
  /** TG 是否可用（凭证齐备且 MTProto 已连接）。 */
  available: boolean
  /** 可用性标签：`ready` | `unavailable`。 */
  mode: string
  /** 不可用原因（`available === false` 时非空）。 */
  unavailable_reason: string | null
  /** 是否运行在测试 mock 客户端之上（生产构建恒为 false）。 */
  mock: boolean
  api_configured: boolean
  proxy: string | null
  session_phase: string
  log_lines: number
}

/** 账号绑定状态（持久化到 localStorage） */
export interface TgAccount {
  phone: string | null
  bound: boolean
}

/** 全局账号绑定中心（当前仅 Telegram，后续可扩展其他账号） */
export interface AccountsState {
  tg: TgAccount
}

export interface AppSettings {
  maxConnections: number
  downloadDirectory: string
  autoStart: boolean
  notifications: boolean
  theme: ThemeValue
  /** 界面显示语言（文件翻译模式 i18n）；缺省按浏览器环境推断 */
  language: LanguageValue
  /** 指定主网卡（网卡名，可选；缺省自动识别） */
  primaryInterface?: string
  /** 全局启用的附属网卡名单（网卡名 → 权重份数，默认 1）；主网卡始终参与不在此列 */
  enabledInterfaces: Record<string, number>
  /** 自动分类下载（R3）：默认值，可在新建下载时覆盖 */
  autoClassify: boolean
  /** 自动分类规则（R3 优化）：扩展名 → 分类目录名；为空时使用 daemon 内置默认 */
  classifyRules: Record<string, string>
}

/** 全局播放器条目（模块无关）：调用方把媒体归一化后交给 MediaViewer 渲染 */
export interface ViewerItem {
  key: string | number
  chatId: number
  messageId: number
  kind: 'photo' | 'video' | 'audio' | 'file'
  caption?: string | null
  /**
   * 介绍（媒体库条目用）。与 `caption` 的分工：`caption` 是 TG 消息流的原文，
   * `description` 是媒体库条目的介绍字段。两者都有时优先显示 `description` ——
   * 媒体库里的「标题」在返回行，正文必须在正文位，否则同一个标题会显示两遍。
   */
  description?: string | null
  /** 首选媒体地址（已缓存走本地流，未缓存走在线流） */
  src: string
  /** 降级地址（首选失败时回退一次，如本地缺失回退在线流） */
  fallbackSrc?: string
  /**
   * 所属剧集 id（媒体库场景）。有值时播放器展示分集列表，
   * 并支持「自动播下一集」。模块无关：TG 消息流不填即可。
   */
  seriesId?: number | null
  /** 封面（视频海报 / 图片缩略）：自动播下一集浮层与续播用 */
  poster?: string | null
  /** 本条在所属剧集中的集号（1 起）：用于「第 N 集」标注 */
  episodeNo?: number | null
}
