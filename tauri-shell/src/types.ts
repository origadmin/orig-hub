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

export interface AppSettings {
  maxConnections: number
  downloadDirectory: string
  autoStart: boolean
  notifications: boolean
  theme: ThemeValue
  /** 指定主网卡（网卡名，可选；缺省自动识别） */
  primaryInterface?: string
  /** 全局启用的附属网卡名单（网卡名 → 权重份数，默认 1）；主网卡始终参与不在此列 */
  enabledInterfaces: Record<string, number>
  /** 自动分类下载（R3）：默认值，可在新建下载时覆盖 */
  autoClassify: boolean
  /** 自动分类规则（R3 优化）：扩展名 → 分类目录名；为空时使用 daemon 内置默认 */
  classifyRules: Record<string, string>
}
