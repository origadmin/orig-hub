/** 与 Rust daemon DownloadStatus 对齐的下载状态 */
/**
 * 引擎侧状态词。**必须与后端 `engine_task.status` 的取值集合一致** —— 少一个
 * 就等于类型层不承认它存在，于是没人给它写分支，它就会被 `?? fallback` 吞成
 * 别的状态（`interrupted` 曾被吞成「空闲」，那是在撒谎）。
 */
export type DownloadStatusValue =
  | 'idle'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'
  // BUG-319：进程消失留下的行。后端会真的下发这个词。
  | 'interrupted'

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
  /**
   * 该行**真实具备**的传输控制动词（后端 `actions_for` 计算，唯一真源）。
   *
   * 前端必须按它渲染按钮，不许按 `status` 自己推 —— 按 status 推等于把
   * 「哪个状态有哪些能力」这条契约复制进 UI，新增来源（未来的第 N 个协议/插件）
   * 就得改一遍前端；按 actions 渲染则新来源只改后端一处。
   *
   * 注意它**不含删除**：删除是资产操作（删下载 = 删用户文件），契约刻意不把它
   * 混进传输动词，留在行内独立的删除按钮上。
   */
  actions?: string[]
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
   * Telegram 链路是否可用。`false` 表示 orig-tg 连不上 Telegram（凭证缺失或 MTProto 失败），
   * 此时 `reason` 给出原因 —— 注意这**不是**「未登录」，二者必须分开显示。
   */
  available?: boolean
  /** 不可用原因（`available === false` 时非空）。 */
  reason?: string | null
  /**
   * MTProto 凭证（api_id/api_hash）是否已配置（BUG-178）。
   *
   * 没有它时，「没配凭证」与「Telegram 连不上」被压成同一个 `available=false`，
   * 前端只能一律喊「Telegram 不可用」—— 于是**待用户完成的动作**被说成了故障。
   */
  api_configured?: boolean
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
/**
 * TG **服务层**状态（orig-tg 进程）：唯一真源是 daemon `/api/config`。
 *
 * 与链路层（Telegram 侧）严格分开（BUG-178）：以前两者共用一个 `available` 词，
 * 于是「设置页说插件可用且开启」与「面板里到处说 Telegram 不可用」同时为真 —— 它们
 * 本来就在说两件事。进程层只回答「服务在不在」，进程不在 = 模块不显示。
 */
export interface TgServiceState {
  /**
   * 是否已从 daemon 取得过**确定性**的 `enabled` 结论。
   *
   * 为什么必须有它（BUG-354）：`enabled` 初始为 `false`，而 `refreshTgState`
   * 仅在 `getConfig()` **成功**时落盘；daemon 不可达 / 配置尚未加载时 `getConfig`
   * 抛错、提前 return，`tgService` 保留初始 `enabled:false`。若「未启用」卡直接读
   * `!enabled`，则「服务未启动 / daemon 不可达」会被错误地渲染成「用户把插件关了」，
   * 并给出只能跳设置页、按核心设计本就启动不了服务的「启用」按钮（逻辑不自恰）。
   *
   * `known` 把两种根因不同的 `enabled:false` 区分开：
   *  - `known && !enabled` → 用户确实关了插件，给「启用」出口（合法）；
   *  - `!known`（配置未确认 / daemon 不可达）→ 归 daemon 职责，渲染「正在启动 / 正在连接」
   *    而非「采集未启用」，绝不给用户一个启动不了服务的死按钮。
   */
  known: boolean
  /** 用户开关（持久化在 download-engine.toml） */
  enabled: boolean
  /** 进程是否真的在服务（daemon 探活，不是前端猜的） */
  running: boolean
  /** daemon 下发的实际端口（真源；可能因保留区顺延） */
  port: number | null
  /** 最近一次拉起/自愈失败的原因（null = 最近一次成功） */
  lastError: string | null
  /**
   * 链路健康 + 自愈历史（BUG-351）：daemon 巡检**连续确认**链路不可用后才重启
   * orig-tg，并把这段历史下发。
   *
   * 为什么必须有它：只有瞬时 `running` 时，「系统每 5 分钟重启一次 TG」在界面上
   * 完全不可见（重启窗口仅几百 ms）—— 用户看到的是「TG 莫名挂了」与关于页两个
   * 绿点并存。界面据此如实呈现「最近重启过 N 次」，不再恒绿。
   */
  link?: TgLinkHealth | null
}

/** daemon 侧链路健康快照（`GET /api/config` 的 `tg_link`） */
export interface TgLinkHealth {
  /** 当前是否判为链路不可用（连续确认前的瞬时值也如实下发） */
  link_down: boolean
  /** 已连续判定不可用的轮数（达到 `confirms_required` 才重启） */
  down_streak: number
  /** 触发一次重启所需的连续确认轮数 */
  confirms_required: number
  /** 自 daemon 启动以来因链路断而重启 orig-tg 的次数 */
  restarts: number
  /** 最近一次重启的墙钟（epoch 秒；null = 从未重启） */
  last_restart_at: number | null
  /** 最近一次判定不可用时的原因（null = 当前健康/无记录） */
  reason: string | null
}

/**
 * TG **链路层**状态（Telegram 侧）：真源是 orig-tg `/api/tg/session`。
 *
 * - `needs_config` / `needs_login`：**待用户完成的动作**，不是故障 ——
 *   绝不能再渲染成「Telegram 不可用」（BUG-178 的直接观感问题）。
 * - `link_down`：真故障（已配凭证但连不上），如实报原因，重启由 daemon 负责。
 * - `unknown`：服务不在或还没探测到，链路无从谈起。
 */
export type TgLinkState =
  | 'ready'
  | 'needs_config'
  | 'needs_login'
  | 'link_down'
  | 'unknown'

export interface TgLinkInfo {
  state: TgLinkState
  /** 仅 `link_down` / `needs_config` 带原因（供诊断，不直接喂给用户） */
  reason: string | null
}

/** @deprecated 由 `TgServiceState` + `TgLinkInfo` 两层取代（BUG-178）。 */
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
  /**
   * TG 相册分组 ID（grouped_id；同组消息构成一个相册，v0.4.2）。
   *
   * **string 而非 number**（BUG-345）：group_id 量级 ~1.4e16 > JS
   * `Number.MAX_SAFE_INTEGER`（2^53-1），以 JSON number 过界会被 `JSON.parse`
   * 舍入成相邻双精度（活库实证 62/70 个组键缓存任务的 item_key 因此比真值差
   * 1）。后端串界序列化 + 宽容反序列化；本类型及其余 4 处 groupId 同此。
   */
  groupId?: string
  /** 是否含媒体附件 */
  hasMedia?: boolean
}

/** 被监控频道（GET/POST/DELETE /api/tg/monitor/channels） */
export interface TgMonitoredChannel {
  channelId: number
  title: string
  username?: string
  addedAt: number
  /**
   * **自上次点开以来**新增的媒体条数（服务端每频道已读游标派生）。
   * 不是「库里共几条」，也不是「本轮同步加了几条」——口径见 docs/bugs/BUG-329.md。
   */
  newCount: number
  /**
   * 回溯目标日期（unix 秒，0/缺省 = 该频道没有待回溯）。
   *
   * 2026-10-22 用户第 2 点：增量同步只向新，频道数据只会加载最新一窗。
   * 回溯是长跑（后台每轮每频道只翻一页），所以进度必须能从列表里看见——
   * 否则用户点了「回溯到 1 月」之后毫无反馈，只会以为按钮没生效。
   */
  backfillUntil?: number
  /**
   * 回溯游标（向旧翻到的最新消息号，0 = 还没开始翻/没有待回溯）。
   * BUG-382：「已回溯至哪」的真值 —— 只有目标日期时界面说得出「要到哪」、
   * 说不出「已到哪」，用户无法确认回溯进度。
   */
  backfillBeforeId?: number
  /** 增量同步游标（最新已同步消息号）——「最新」边界（BUG-382）。 */
  lastMessageId?: number
  /**
   * 库内最老已入库消息日期（unix 秒；0/缺省 = 该频道还没有入库数据）。
   * BUG-394：回溯表单默认日期的真源 —— 展开表单时用它预填（UTC 口径），
   * 用户不再凭记忆猜「回溯到几号」。
   */
  oldestMessageDate?: number
}

/** 文字筛选规则（GET/POST /api/tg/monitor/filters）。
 *
 *  一条规则 = 一条虚拟监控（用户 2026-10-19 裁定「多次作为多条」）：各自算命中、
 *  各自成条目，不合并成单频道内的 AND/OR 复合条件。 */
export interface TgMonitorFilter {
  id: number
  /** 显示名（缺省等于 keyword） */
  label: string
  /** 匹配关键词（子串；匹配 caption 或 file_name） */
  keyword: string
  createdAt: number
  /** 命中条数（跨全部监控频道） */
  hits: number
  /** 自上次点开该规则以来新增的命中条数（BUG-330 / TGM-06；0 不渲染徽标） */
  newHits: number
}

/** 筛选命中行（GET /api/tg/monitor/filters/:id/messages） */
export interface TgMonitorFilterHit {
  channelId: number
  messageId: number
  caption?: string
  /** TG 原始文件名：大量视频没有 caption，标题要靠它兜底（BUG-220） */
  fileName?: string
  type?: 'photo' | 'video' | 'audio' | 'file'
  size?: number
  duration?: number
  date?: number
  downloaded: boolean
  channelTitle?: string
  /** TG 相册分组 id（同组消息构成一个相册；无则单条）。前端据此「按组入库」而非按单条扁平化。 */
  groupId?: string
  /** MIME 类型（BUG-330 / TGM-05：命中行展开预览的数据基础） */
  mimeType?: string
  /** 落盘路径（无 = 未缓存；「缺字节」判据，BUG-080） */
  filePath?: string
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
  groupId?: string
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
  groupId?: string
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
  /**
   * 条目内字节进度（BUG-181，仅 running 且归属当前任务时有值）：
   * 一条 200MB 视频下载数分钟，此前 `done` 在条目边界才更新，UI 全程冻结。
   */
  itemBytes?: number
  itemBytesTotal?: number
  /**
   * 字节心跳（BUG-221，仅 running 且已收到字节时有值）。
   *
   * 与上两个字段的区别：`itemBytes*` 要求**总量已知**（否则 0/0 没有意义），
   * 而这里的 `progressBytes` **总量未知也要下发** —— 「未知总量」不能退化成
   * 「无数据」，否则又回到「0/1 恒 0%」。`progressAt` 是字节最后一次推进的
   * 墙钟（ms epoch），是前端区分「在下载 / 已停滞」的唯一依据：
   * `cache_task.updated_at` 只在消息边界与状态变更时写，条目内下载期间不动。
   */
  progressAt?: number
  progressBytes?: number
  /** 总量未知时服务端显式下发 `null`（不是 0）：据此显示「已下载 X MB」而非假百分比 */
  progressBytesTotal?: number | null
  /**
   * 入库内容标题（BUG-232 v2）：该任务覆盖的第一条消息的 caption，
   * 服务端从消息同步时已落库的 `media_message` 带出（/tasks/all 与 /tasks/:id）。
   * 与任务成败无关 —— failed/queued 同样有值；为空时才退回频道链。
   */
  title?: string
  /**
   * 队列优先级（BUG-277）：越大越先跑，`0` = 未置顶。
   *
   * 语义是「**当前任务跑完后下一个跑它**」，**不是**抢占：置顶不会打断正在跑的
   * 任务，也不会让队列里出现两个进度。
   *
   * 缺省按 0 处理：引擎加列前（未集成的旧版本）下发的任务里没有这一列，
   * 壳端不得因为字段缺失就崩，也不得据此假装「可置顶」。
   */
  priority?: number
  /**
   * 组清单摘要（D22-A② / BUG-296）：该任务覆盖消息的编入状态计数。
   *
   * 只在 `/api/tg/cache/tasks/all`（缓存管理面板）注入；`/tasks` 与 `/tasks/:id`
   * 不带（轮询路径不做这个聚合）。缺省 = 未注入，前端不得据此假装「已全部编入」。
   */
  manifest?: ManifestSummary
}

/**
 * 排队任务覆盖摘要（BUG-181，GET /api/tg/cache/tasks 的 `queued` 数组项）。
 * 单飞呈现仍是「一个进度」：排队任务不带进度，只带覆盖集合，前端据此把
 * 排队条目呈现为「排队中」——此前排队任务在该端点完全不可见，用户入队
 * 第二组时呈现为「无法添加」。
 */
export interface TgQueuedTask {
  id: number
  chatId: number
  groupId?: string
  messageIds: number[]
  total: number
}

/**
 * 组清单**摘要**（D22-A② / BUG-296）：任务列表轮询路径随每条 `TgCacheTask` 下发。
 *
 * 语义是「这批消息编入了几条」，**不是**「字节在不在」——字节真值由逐条明细给出。
 * `total` = 序号全集（`cache_task.items` 的长度），`slotted` = 已编入剧集，
 * `registeredUnslotted` = 已登记未编入（BUG-296 的核心态），`missing` = 无条目。
 * 三态之和恒等于 `total`。
 */
export interface ManifestSummary {
  total: number
  slotted: number
  registeredUnslotted: number
  missing: number
}

/** 组清单的逐条状态：`slotted` 已编入 | `registered_unslotted` 已登记未编入 | `missing` 无条目 */
export type ManifestState = 'slotted' | 'registered_unslotted' | 'missing'

/**
 * 组清单的**一条**（D22-A② / BUG-296）。
 *
 * `hasBytes` 是**独立标志**（可与任一态并存）：「无字节」不是独立状态。
 * `episodeId/season/episodeNo` 仅在 `state === 'slotted'` 时有值。
 */
export interface ManifestEntry {
  messageId: number
  state: ManifestState
  hasBytes: boolean
  episodeId?: number
  season?: number
  episodeNo?: number
  /** BUG-315 信息补齐：文件名（media_message.file_name） */
  fileName?: string | null
  /** BUG-315 信息补齐：消息文案（media_message.caption） */
  caption?: string | null
  /** BUG-315 信息补齐：字节数（media_message.size）；无字节时为 null */
  size?: number | null
  /** BUG-315 信息补齐：消息时间（Unix 秒，media_message.msg_date） */
  msgDate?: number | null
  /** BUG-315 信息补齐：媒体类型（video/photo/...） */
  mediaType?: string | null
  /** BUG-315 信息补齐：时长（秒） */
  duration?: number | null
  /** BUG-315 状态补齐：在途尝试起始时间戳（Unix 毫秒）；有值=正在传 */
  startedAt?: number | null
  /** BUG-315 状态补齐：已结束尝试累计墙钟（毫秒） */
  accumMs?: number | null
}

/**
 * 组清单（D22-A② / BUG-296）：**序号全集 + 每条状态 + 缺口**。
 *
 * 派生读、不新建业务表。序号全集取 `cache_task.items`（TG 侧真值的一部分）。
 * `gap` = **真缺口** = 未编入数 − 挂图数（先减 `imageCount`：图集是设计不是丢失）。
 */
export interface GroupManifest {
  chatId: number
  /** 参与合成的任务 id（剧集级可能由多批缓存合成，如 EP1-5 + EP6-10） */
  taskIds: number[]
  total: number
  slotted: number
  registeredUnslotted: number
  missing: number
  /** 该组在剧集内的挂图数（`media_episode_image`） */
  imageCount: number
  /** 真缺口 = 未编入数 − 挂图数 */
  gap: number
  entries: ManifestEntry[]
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
  /**
   * 真源总时长（秒，BUG-253）：来自 `GET /api/media/items/<id>` 的 `duration`，
   * 是片长的唯一可靠真值。播放器据此显示正确总数，不取 live 转码流的瞬时
   * `video.duration`（会随转码推进抖动增长，绝不能当总数）。
   */
  duration?: number | null
  /**
   * 字节态（BUG-254）：本条目当前是否有可播放的字节。
   * `false` ⇒ 播放器渲染专属「无内容 / 未缓存」态，与「浏览器无法解码该格式」
   * 明确区分，并给出「重新缓存」入口；`true`/`undefined` ⇒ 走正常播放 / 解码失败路径。
   * 由 `hasMediaBytes` 在构造处统一推导，避免各消费点重复判定逻辑。
   */
  hasBytes?: boolean | null
  /**
   * 来源定位符（BUG-254）：无字节时驱动「重新缓存」入口
   * （`recacheFromSource(ref, source)`）。缺省 = 无法定位来源，隐藏入口。
   */
  ref?: string | null
  /** 来源标识（BUG-254）：'local' / 'tg' 等，决定重缓存走哪条适配器。 */
  source?: string | null
}
