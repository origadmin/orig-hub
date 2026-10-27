import type {
  AddDownloadRequest,
  DownloadStatus,
  DownloadStatusValue,
  NetworkInterface,
} from '../types'

/** orig-daemon 起始端口（与 Rust 侧 DAEMON_PORT 一致；仅作**初值**） */
export const DAEMON_PORT = 19786

/**
 * daemon **实际**端口的初值。
 *
 * 为什么不再是常量（BUG-178）：daemon 落在 Windows 动态保留区时会自己顺延端口，
 * 硬编码 9876 就会连到一个不存在（或属于别人）的服务上。真源只有两个 ——
 * 桌面壳给的 `daemon_status().port`，或 daemon 自己回的 `/api/config` 的 `port`；
 * 这里的值只是首次请求之前的占位，随后立即被真源覆盖。
 */
const remoteDaemonUrl = (import.meta.env.VITE_DAEMON_URL as string | undefined)
  ?.trim()
  .replace(/\/+$/, '')

let daemonPort = Number(import.meta.env.VITE_DAEMON_PORT ?? DAEMON_PORT)

/** 用真源端口覆盖初值（桌面壳 / `/api/config` 各调一次，幂等） */
export function setDaemonPort(port: number) {
  if (Number.isFinite(port) && port > 0 && port !== daemonPort) daemonPort = port
}

/** daemon 基址（**每次现算**）。
 * - 设了 `VITE_DAEMON_URL` → 指向远程守护进程（容器/另一台机器），即远程管理模式。
 * - 否则回退桌面端 `http://127.0.0.1:<port>`。 */
export function daemonBase(): string {
  if (remoteDaemonUrl) return remoteDaemonUrl
  return `http://127.0.0.1:${daemonPort}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Content-Type 只在**真有请求体**时设置（BUG-241，与 api/tg.ts、api/media.ts 同模式）：
  // 它是非 CORS 安全头，GET（/health、/api/config、/api/downloads…）带上会触发跨源
  // OPTIONS 预检。由 body 派生而非 method，未来调用方不可能写错。
  const res = await fetch(`${daemonBase()}${path}`, {
    headers: init?.body != null ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * GET /api/downloads?scope=all — **统一列表**（全来源快照 `{tasks, sources}`，BUG-392）。
 *
 * BUG-466：主列表此前误走 `/api/downloads/native`（引擎单源）——那个 native 端点
 * 是统一改造时自己造出来的分裂端点，既违反「下载只有一个列表接口」的裁定，又让
 * 引擎行与入库行分裂成两个来源。native 端点已删除；统一 `/api/downloads` 的
 * download 行现已携带引擎原生细节（`destPath`/`url`/`connections`…），这里只过滤
 * `kind === 'download'` 并映射回 `DownloadStatus`，**单一端点即完整真源**。
 */
export function listDownloads(): Promise<DownloadStatus[]> {
  return fetchDownloads('all').then((snap) =>
    snap.tasks
      .filter((t) => t.kind === 'download')
      .map((t): DownloadStatus => ({
        // 统一视图 id 形如 `dl:<uuid>`；引擎动作端点吃的是原生 id，故剥掉前缀。
        id: t.id.startsWith('dl:') ? t.id.slice(3) : t.id,
        url: t.url ?? '',
        filename: t.name,
        dest_path: t.destPath,
        total_size: t.totalSize ?? t.total,
        downloaded: t.downloaded ?? t.done,
        progress: t.progress,
        speed: t.speed ?? 0,
        status: t.status as DownloadStatusValue,
        error: t.error ?? undefined,
        eta: t.eta ?? 0,
        connections: t.connections ?? 0,
        added_at: t.addedAt ?? t.updated_at,
        time_taken: t.timeTaken ?? 0,
        avg_speed: t.avgSpeed ?? t.speed ?? 0,
      })),
  )
}

/** GET /api/downloads/:id */
export function getDownload(id: string): Promise<DownloadStatus> {
  return request(`/api/downloads/${encodeURIComponent(id)}`)
}

/** POST /api/downloads — 新增下载任务（返回 {id}，非完整状态） */
export function addDownload(req: AddDownloadRequest): Promise<{ id: string }> {
  return request('/api/downloads', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** POST /api/downloads/:id?action=pause|resume|cancel */
export function downloadAction(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<DownloadStatus> {
  return request(
    `/api/downloads/${encodeURIComponent(id)}?action=${action}`,
    { method: 'POST' },
  )
}

/**
 * POST /api/downloads/:id/retry — 重试一条停住的行（interrupted | error | cancelled）。
 *
 * 与 pause/resume/cancel 分开成端点：那三个作用于内存活体，retry 作用于记录。
 * 响应里的 `resume: false` 是后端明说的「无真续传，整任务重跑」，前端据此
 * 把它讲成「重试」而不是「继续」。
 */
export function retryDownload(
  id: string,
): Promise<{ status: string; id: string; resume: boolean }> {
  return request(`/api/downloads/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  })
}

/** DELETE /api/downloads/:id — 删除任务（含磁盘文件？由 daemon 决定） */
export function removeDownload(id: string): Promise<void> {
  return request(`/api/downloads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

/** GET /api/interfaces — 网卡列表（{primary, secondaries}，均已含 enabled/weight） */export async function listInterfaces(): Promise<{
  primary: NetworkInterface
  secondaries: NetworkInterface[]
}> {
  const raw = await request<unknown>('/api/interfaces')
  if (Array.isArray(raw)) {
    // 兼容旧返回（数组）
    const arr = raw as NetworkInterface[]
    return {
      primary: arr[0],
      secondaries: arr.slice(1),
    }
  }
  return raw as { primary: NetworkInterface; secondaries: NetworkInterface[] }
}

/** daemon 配置（GET /api/config） */
export interface DaemonConfig {
  /** daemon 实际监听端口（可能与起始端口不同：保留区顺延，BUG-178）。真源。 */
  port?: number
  download_dir: string | null
  /**
   * **受管库根**（BUG-323）= `<生效下载路径>/library` —— **派生值，不可独立配置**。
   *
   * 用户裁定：「库根跟下载走，所有文件不允许脱离下载路径，下载路径是所有权限的限制路径」。
   * 因此设置页只**展示**它，库根没有自己的写入口（`PUT /api/config/library` 恒 422）。
   */
  library_root: string
  /**
   * **生效下载路径** = 受管根 / 权限边界：配置的 `download_dir` → 否则内容默认根
   * （用户 2026-10-19 裁定「所有内容写 D 盘」⇒ Windows 恒 `D://OrigDown`）。
   * 设置页的「当前生效」直出它，前端不自己拼（拼出来必然与引擎漂移）。
   */
  effective_download_root: string
  /**
   * 手动下载**未配置** `download_dir` 时的实际默认根 = 内容默认根
   * （`orig_core::paths::default_download_dir()`）。前端用它作占位，不自己拼路径。
   */
  manual_download_root: string
  /**
   * **名义**系统默认下载目录（Windows = `C:\Users\<user>\Downloads）。
   * 用户 2026-10-19 裁定「~/Downloads是默认设置,但是不使用,改用加载配置的D盘设置」⇒
   * 它只是名义值，**不得当写点**；实际落点看 `manual_download_root` /
   * `effective_download_root`（C: 一律改道到 D 盘内容根）。
   */
  default_download_dir: string
  max_connections: number
  classify_enabled: boolean
  /** 扩展名（小写，无点）→ 分类目录名（已合并内置默认 + 用户自定义） */
  classify_rules: Record<string, string>
  /** 代理配置：mode=direct|system|custom；url 仅 custom 模式有值 */
  proxy: {
    mode: 'direct' | 'system' | 'custom'
    url: string | null
  }
  /**
   * **插件清单**（BUG-358）—— `/api/config` 里**不再**出现 `tg_enabled` 这类把插件名
   * 写进契约的键。
   *
   * 用户裁定（2026-10-21，原话）：「"tg_enabled"这些都是什么？毫无共通性，最初定义就是
   * 以共通插件化来做…我把TG改成BB，这个还能用吗？插件是要即插即用的」。
   *
   * ⇒ 前端只按 `id` 取自己那一份（[`TG_PLUGIN_ID`]），**不认识的 id 直接跳过**；
   * 换插件（TG→BB）时前端零改动，只换 id 常量或按 id 匹配到的实现。
   */
  plugins?: DaemonPlugin[]
  /**
   * 调试日志路径（BUG-243）：由 daemon 下发**绝对路径**，设置-关于页直接展示，
   * 用户出错时照路径就能翻到日志，不必先问「日志在哪」。前端不拼路径——
   * 拼接权在引擎（`state::log_dir()` 是唯一真源），否则两端各拼一套必然漂移。
   *  - `orig-tg.log`：orig-tg 子进程完整 stdout/stderr（启动失败原因在这里）；
   *  - `errors.log`：daemon 记录的核心错误（append-only，超 8 MiB 滚动一代）。
   */
  logs?: {
    dir: string
    orig_tg: string
    errors: string
  }
}

/**
 * 一个可选插件的运行态（`/api/config` 的 `plugins[]` 元素）。
 *
 * 字段与插件无关：新增插件（BB/其他）走同一形状，前端渲染逻辑不用改。
 */
export interface DaemonPlugin {
  /** 稳定标识（`tg` / `bb` …）—— 前端**唯一**的识别依据 */
  id: string
  /** 展示名（界面文案真源，前端不自己写「Telegram」） */
  label: string
  /** 用户是否开启（持久化在 daemon 配置里） */
  enabled: boolean
  /** 子服务是否实际在跑（daemon 探活） */
  running: boolean
  /** 子服务实际监听端口（daemon 是唯一真源；可能被 env 迁移或保留区顺延） */
  port?: number
  /** 最近一次拉起/自愈失败的原因（null = 最近一次成功） */
  lastError?: string | null
  /**
   * 链路健康 + 自愈历史（BUG-351）：`restarts`/`lastRestartAt` 让界面能如实说
   * 「最近重启过 N 次」—— 只有瞬时 `running` 时，「系统每 5 分钟重启一次」
   * 完全不可见（重启窗口仅几百 ms），关于页因此恒绿。
   */
  health?: {
    linkDown: boolean
    downStreak: number
    confirmsRequired: number
    restarts: number
    lastRestartAt: number | null
    reason: string | null
  } | null
}

/** TG 插件的 id —— 前端唯一允许出现 `tg` 字面量的地方（换插件只改这里）。 */
export const TG_PLUGIN_ID = 'tg'

/** 从 `/api/config` 的 `plugins[]` 里按 id 取一个；没有就返回 `undefined`。 */
export function findPlugin(
  cfg: { plugins?: DaemonPlugin[] } | null | undefined,
  id: string = TG_PLUGIN_ID,
): DaemonPlugin | undefined {
  return cfg?.plugins?.find((p) => p.id === id)
}

/** 代理配置（HTTP 下载） */
export interface ProxyConfig {
  mode: 'direct' | 'system' | 'custom'
  url?: string | null
}

/** 目录浏览（GET /api/fs/dirs，BUG-323 缺陷③）——只读、只列子目录。 */
export interface FsDirEntry {
  name: string
  /** 绝对路径（选中后原样交给保存端点，前端不拼路径） */
  path: string
}

/** 快捷锚点：`key` 是语义键（展示文案由前端给），不是路径别名。 */
export interface FsDirRoot {
  key: 'default_download' | 'home' | 'current' | 'library' | string
  path: string
}

export interface FsDirListing {
  /** 当前目录；null = 正在列「此电脑」（文件系统根） */
  path: string | null
  /** 上级目录；null = 已到顶（前端据此禁用「上一级」） */
  parent: string | null
  entries: FsDirEntry[]
  truncated: boolean
  roots: FsDirRoot[]
}

/**
 * GET /api/fs/dirs — 只读目录浏览（WEB 替代系统原生对话框，BUG-323 缺陷③）。
 *
 * 不传 `path` = 列文件系统根（Windows 为盘符）。失败带可读原因
 * （404 不存在 / 422 非绝对或非目录 / 403 无权读取），前端必须直出，不得
 * 把失败渲染成「这里没有子目录」。
 */
export function listDirs(path?: string): Promise<FsDirListing> {
  const p = path?.trim()
  return request<FsDirListing>(`/api/fs/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`)
}

/**
 * GET /api/config — 读取 daemon 配置。
 *
 * BUG-316：设置页单次挂载会并发/重复拉取本端点多达 8 次（StrictMode 双挂 + 多组件各拉
 * `loadClassify`/`loadProxy`/`Promise.all` + `useStore` 初始化 + `refreshTgState`），每次都是
 * 一次真实网络请求 ⇒ 页面卡顿。这里做「在途去重 + 短 TTL」：并发调用共享同一个 promise；
 * TTL 内复用，过期后下一次调用重新拉取。写配置后立即 `invalidateConfig()` 保证回读最新。
 */
const CONFIG_TTL_MS = 4000
let configCache: { p: Promise<DaemonConfig>; at: number } | null = null

export function getConfig(): Promise<DaemonConfig> {
  const now = Date.now()
  if (configCache && now - configCache.at < CONFIG_TTL_MS) return configCache.p
  const p = request<DaemonConfig>('/api/config')
  configCache = { p, at: now }
  // 失败不缓存：下一次调用可重试，避免把「一次性的网络抖动」误当成「配置不可达」。
  p.catch(() => {
    if (configCache?.p === p) configCache = null
  })
  return p
}

/** 使 /api/config 缓存失效（配置写入成功后调用） */
export function invalidateConfig() {
  configCache = null
}

/** PUT /api/config/proxy — 保存代理配置（运行时生效 + 持久化） */
export function saveProxyConfig(req: ProxyConfig): Promise<{
  ok: boolean
  proxy: { mode: string; url: string | null }
}> {
  return request<{ ok: boolean; proxy: { mode: string; url: string | null } }>('/api/config/proxy', {
    method: 'PUT',
    body: JSON.stringify(req),
  }).then((r) => {
    invalidateConfig()
    return r
  })
}

/** POST /api/proxy/verify — 验证代理连通性（对 api.telegram.org 探测），返回耗时与状态 */
export function verifyProxy(req: {
  mode: string
  url?: string | null
}): Promise<{ ok: boolean; latency_ms: number; status: number; target: string }> {
  return request('/api/proxy/verify', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/** PUT /api/config/classify — 保存自动分类规则（运行时生效 + 持久化） */
export function saveClassifyConfig(req: {
  enabled: boolean
  rules: Record<string, string>
}): Promise<{ ok: boolean; classify_enabled: boolean; classify_rules: Record<string, string> }> {
  return request<{ ok: boolean; classify_enabled: boolean; classify_rules: Record<string, string> }>(
    '/api/config/classify',
    {
      method: 'PUT',
      body: JSON.stringify(req),
    },
  ).then((r) => {
    invalidateConfig()
    return r
  })
}

/**
 * PUT /api/config/download — 保存下载目录（运行时生效 + 持久化）。
 *
 * BUG-234：此前目录只写 localStorage，引擎从不收到 —— 设置页改了目录，下载照旧落原处。
 * `dir` 传空串 = 清除设置，回退系统默认下载目录。
 *
 * **BUG-323**：下载路径是全部文件的唯一容器（库根 = 其下 `library`）。daemon 保存后
 * **立即把生效路径下发给 orig-tg**，`tg_synced/tg_error` 回报这次同步的结果 ——
 * 失败不静默（原因直出界面），也不再需要「改完重启引擎」。
 */
export function saveDownloadConfig(req: { dir: string }): Promise<{
  ok: boolean
  download_dir: string | null
  default_download_dir: string
  effective_download_root: string
  library_root: string
  tg_synced: boolean
  tg_error: string | null
}> {
  return request<{
    ok: boolean
    download_dir: string | null
    default_download_dir: string
    effective_download_root: string
    library_root: string
    tg_synced: boolean
    tg_error: string | null
  }>('/api/config/download', {
    method: 'PUT',
    body: JSON.stringify(req),
  }).then((r) => {
    invalidateConfig()
    return r
  })
}

/**
 * `PUT /api/config/library` — **已废（BUG-323）**：库根是 `<下载路径>/library` 的派生值，
 * 不可独立配置（该端点现在恒 422）。此处**刻意不提供封装** —— 任何试图恢复「单独写库根」
 * 的调用都应在编译期失败，而不是跑到运行期拿一个 422。
 */

/**
 * `PUT /api/plugins/:id/enabled` — 启停一个可选插件（运行时生效 + 持久化；
 * 同时拉起/终止它托管的子服务）。
 *
 * BUG-358：路径与入参都与插件无关，`id` 是唯一区分。旧路径 `PUT /api/config/tg`
 * 仍可用（daemon 侧是别名），但新代码一律走这里 —— 换插件不用改函数名。
 */
export function setPluginEnabled(
  id: string,
  req: { enabled: boolean },
): Promise<{ ok: boolean; plugins?: DaemonPlugin[] }> {
  return request<{ ok: boolean; plugins?: DaemonPlugin[] }>(
    `/api/plugins/${encodeURIComponent(id)}/enabled`,
    {
      method: 'PUT',
      body: JSON.stringify(req),
    },
  ).then((r) => {
    invalidateConfig()
    return r
  })
}

/**
 * POST /api/plugins/:id/restart — 请 daemon 重启它托管的子服务（**daemon 是唯一执行者**）。
 *
 * 为什么前端还要留这个口（BUG-178）：凭证保存 / 网络修好后必须重启子服务才生效
 * （它只在启动时连一次）。但动作是 daemon 执行的 —— 前端只是**请求**，
 * 不再自己 spawn/kill 进程，也不再让用户去点「启动服务」。
 */
export function restartPlugin(
  id: string,
): Promise<{ ok: boolean; plugins?: DaemonPlugin[] }> {
  return request<{ ok: boolean; plugins?: DaemonPlugin[] }>(
    `/api/plugins/${encodeURIComponent(id)}/restart`,
    { method: 'POST', body: '{}' },
  ).then((r) => {
    invalidateConfig()
    return r
  })
}

/** GET /health */
export function health(): Promise<{ status: string }> {
  return request('/health')
}

/**
 * GET /api/activity — 传输中聚合视图（BUG-077 方案 (a)）。
 *
 * BUG-300（2026-10-15）复报后切回此处作为**单一聚合入口**：两侧任务（引擎下载 +
 * orig-tg 缓存）只读聚合并排呈现。`cache` 任务的 `groupKey` == orig-tg `itemKey`，
 * 前端据此把「同一内容的多次入库」合并成一行（BT 的「种子」粒度）。
 *
 * 调用方约定：
 *   - `scope=active`（默认）= 在途；`scope=all` = 两侧已知全部（含已结束）。
 *   - 写操作仍走原路径：`control.side` 指向归属侧 + `control.native_id` 指向该侧原生 id，
 *     本视图不提供写端点。
 *   - TG 不可达时端点恒 200，仅 `sources` 里 cache 一条标 `available:false`。
 */
export type ActivityKind = 'download' | 'cache'
export type ActivityUnit = 'bytes' | 'items'
export type ActivityAction = 'pause' | 'resume' | 'cancel' | 'retry'

export interface ActivityControl {
  side: 'daemon' | 'tg'
  native_id: string
}

export interface ActivityTask {
  id: string
  kind: ActivityKind
  name: string
  /** 聚合键：cache = orig-tg `itemKey`；download = 下载 id（唯一）。 */
  groupKey: string
  /**
   * TG 频道 id（BUG-300 复报：「去媒体库查看」拼 `ref = {chat}:{msg}` 用；
   * 相册/批量组的 `itemKey` 给不出 msg，只有载荷里的坐标可用）。
   * 下载侧无此概念 ⇒ 字段缺失（不是 0 —— 0 会被读成一个真实频道）。
   */
  chatId?: number | null
  /** 任务覆盖的消息号（按缓存顺序）。下载侧无此概念 ⇒ 空数组。 */
  messageIds: number[]
  /** 优先下载优先级（BUG-277）：越大越先跑，0 = 未置顶。下载侧恒 0。 */
  priority: number
  unit: ActivityUnit
  total: number
  done: number
  speed: number | null
  progress: number
  status: string
  actions: ActivityAction[]
  control: ActivityControl
  updated_at: number
  error: string | null
  /**
   * BUG-466：引擎原生细节已并入统一列表（native 端点删除后无处可取）。
   * 仅 `kind === 'download'` 的行填充；TG 缓存侧无对应概念 ⇒ 缺省值。
   */
  url?: string
  destPath?: string
  totalSize?: number
  downloaded?: number
  connections?: number
  eta?: number
  avgSpeed?: number
  addedAt?: number
  timeTaken?: number
}

export interface ActivitySourceHealth {
  kind: ActivityKind
  available: boolean
  error: string | null
}

/** BUG-395 第二步：各来源纳入条数（已从 `ActivitySourceHealth.count` 上移，依赖 scope）。 */
export interface SourceCounts {
  download: number
  cache: number
}

/** BUG-395 第一步：来源健康独立端点 `GET /api/sources` 的响应。 */
export interface SourcesSnapshot {
  sources: ActivitySourceHealth[]
  counts: SourceCounts
  generated_at: number
}

export interface ActivitySnapshot {
  tasks: ActivityTask[]
  sources: ActivitySourceHealth[]
  /** BUG-395 第二步：顶层计数（替代旧 `sources[].count`）。 */
  counts: SourceCounts
  generated_at: number
}

/**
 * GET /api/downloads?scope=active|all — **统一列表接口**（BUG-392）。
 *
 * 全来源（插件/TG 入库 + 原生引擎 + BT）一个端点：此前与本函数等价的
 * `/api/activity` 被读成「另一个列表端点」，而 UI 名义上的列表接口
 * `/api/downloads` 实际只回引擎原生面（于是它只挂着 1 条遗留 mock 夹具）。
 * 现在两者合流：列表只有 `/api/downloads`，`/api/activity` 退为已废弃别名
 * （仅既有探针依赖，产品代码不再调用）。
 */
export function fetchDownloads(scope: 'active' | 'all' = 'active'): Promise<ActivitySnapshot> {
  return request<ActivitySnapshot>(`/api/downloads?scope=${scope}`)
}

/**
 * BUG-395 第一步：来源健康独立端点 `GET /api/sources`。
 *
 * 把「横幅要不要显示」这个全局判据从 58KB 任务列表里摘出来：本端点只有约 200B，
 * 与 `fetchDownloads` 的任务列表解耦。健康口径与 `ActivitySnapshot.sources` 逐字一致。
 */
export function fetchSources(): Promise<SourcesSnapshot> {
  return request<SourcesSnapshot>(`/api/sources`)
}

/**
 * 统一**状态变更**接口（BUG-392）：`/api/downloads/:id`，按行 id 前缀
 * （`dl:` = 原生引擎 / `tg:` = TG 插件入库）由服务端分流。
 *
 * 此前 TG 行的取消/重试/优先下载由前端直连 orig-tg，UI 同时认两个域 ——
 * orig-tg 重启顺延端口后动作全打到空端口。现在 UI 只认这一个入口。
 */
export function downloadControl(
  id: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry' | 'prefer' | 'unprefer',
): Promise<{ id: string; action: string }> {
  return request(
    `/api/downloads/${encodeURIComponent(id)}?action=${action}`,
    { method: 'POST' },
  )
}

/**
 * 订阅 SSE 事件流（下载进度 / 状态变更）。
 * 返回取消函数；连接断开自动重连（指数退避）。
 *
 * 退避上限 60s 而不是 10s（BUG-282）：daemon 全关是**常态场景**（用户没开就进了界面），
 * 10s 封顶等于稳态 6 次/分钟的失败重连永不停，而 60s 封顶把同样的无意义流量压到 1/6。
 * 连接一旦成功 `retryMs` 立刻回 1s，所以「服务回来了」不会因为退避而慢一拍。
 */
export function subscribeEvents(
  onEvent: (evt: { event: string; data: DownloadStatus | DownloadStatus[] }) => void,
  onOpen?: () => void,
  onError?: (err: Error) => void,
): () => void {
  let closed = false
  let retryMs = 1000
  let timer: number | undefined
  let es: EventSource | null = null

  // daemon 发送的是命名事件：progress/completed/error/paused/resumed/deleted
  const EVENT_NAMES = ['progress', 'completed', 'error', 'paused', 'resumed', 'deleted'] as const

  const handle = (event: string) => (msg: MessageEvent) => {
    try {
      const data = JSON.parse(msg.data as string) as DownloadStatus | DownloadStatus[]
      onEvent({ event, data })
    } catch {
      // 忽略无法解析的消息
    }
  }

  const connect = () => {
    if (closed) return
    es = new EventSource(`${daemonBase()}/api/events`)
    es.onopen = () => {
      retryMs = 1000
      onOpen?.()
    }
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, handle(name))
    }
    es.onerror = () => {
      es?.close()
      es = null
      if (!closed) {
        onError?.(new Error('SSE connection lost'))
        timer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 60000)
      }
    }
  }

  connect()
  return () => {
    closed = true
    if (timer) window.clearTimeout(timer)
    es?.close()
  }
}
