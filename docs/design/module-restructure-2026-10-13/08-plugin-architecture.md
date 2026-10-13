# 插件架构设计：独立二进制 + 稳定契约 + 前端统一化（TG 为参考插件）

- 日期：2026-10-13
- 目标：把 TG 从「写死在系统里的第二服务」改造为**第一个参考插件**；此后新增采集/来源能力（其他 IM、网盘、RSS、站点采集等）一律以**独立二进制插件**交付，宿主与插件之间只有版本化稳定契约；前端不接受第三方随意改 UI，防止兼容崩坏。
- 上位约束：[07-playback-performance-contract.md](07-playback-performance-contract.md) §6（插件不得位于库内播放热路径）、[02-backend-architecture.md](02-backend-architecture.md) §6（数据写者仲裁）。

---

## 快速概览（TL;DR）

| 问题 | 结论 |
|---|---|
| 插件是什么 | 一个独立可执行文件（`plugin.exe`）+ 一份清单（manifest）；由 orig-daemon 插件宿主按开关拉起/看护/重启；语言无关（TG 继续用 Rust，第三方可用任意语言） |
| 怎么通信 | 环回 HTTP/JSON + SSE，契约前缀 `/plugin/v1/`，每插件独立 Bearer 令牌 + 临时端口；与现有 daemon⇄tg 形态一致，零新技术栈 |
| 稳定性怎么保 | 契约 semver + 握手版本协商；宿主向后兼容 N 个小版本；插件不直接写库、不碰媒体端口、不直接写彼此数据；能力（capabilities）声明式登记 |
| 前端怎么统一 | **v1 插件不允许自带 JS**：UI 由宿主根据 manifest 的「能力描述 + 配置 JSON Schema」用标准组件渲染（导航槽/来源浏览/媒体流/搜索/账号/缓存动作全是宿主标准件）。TG 三栏界面被拆解为这些标准能力的组合，作为参考实现 |
| 字节归谁 | 插件只负责取字节到「交接区」，调宿主 `POST /host/v1/ingest` 交接；归仓后播放/管理与插件进程无关（07 红线） |
| 第三方扩展边界 | v1 只开放「采集来源类」插件一种类型；下载协议/共享目标等类型在 manifest 预留 kind 但 v1 不实现、不承诺 |
| 落地 | 新增 **M6**（M3 之后）：宿主通用化 → TG 契约适配（参考插件）→ 一致性测试套件；前端标准槽位 M0 即按插件化口径预留 |

---

## 1. 设计原则

1. **进程隔离是兼容性的物理基础**：插件崩溃/卡死/升级不拖垮宿主与其他插件；宿主用看门狗（重启退避）而不是 in-process 加载。
2. **契约窄而版本化**：宁少勿多；v1 只暴露「采集来源」必需面；每个接口带版本；删除字段走废弃期，不静默破坏。
3. **单向依赖**：插件 → 宿主（注册、交接字节、读配置、发日志）。宿主不回调插件业务库；插件之间互不感知、禁止互调。
4. **前端只有一套**：宿主拥有导航、播放器、媒体卡片、缓存任务、设置表单全部核心组件；插件提供「描述」，不提供「代码」。第三方无法改出第二套播放/渲染行为（也是性能红线的制度保障）。
5. **示例即标准**：TG 必须在 M6 完成契约化改造，其 manifest、宿主侧适配代码、conformance 报告就是第三方插件的模板与 SLA 基线。
6. **默认最小权限**：每插件独立令牌、独立数据目录、能力逐项授权；只绑环回；插件无任何对外网卡监听权（共享面只属于宿主）。

---

## 2. 运行模型

```
┌─────────────────────────────── Tauri 壳（前端插件宿主） ───────────────────────────────┐
│  Sidebar：核心域（下载/文件/共享/设置）固定                                            │
│   + 「采集」分组：槽位由已启用插件的 manifest 动态生成（TG 采集、网盘 X、…）            │
│  所有插件面板 = 宿主标准组件 + 插件 descriptor 数据（无第三方 JS，v1）                  │
└───────────────────────────────┬──────────────────────────────────────────────────────┘
                                 │ 只跟 daemon 说话（统一 base、统一 token、统一错误模型）
┌───────────────────────────────▼ orig-daemon（插件宿主 / plugin host） ────────────────┐
│  supervisor：发现/拉起/健康检查/退避重启/停用                                          │
│  proxy：/api/plugins/:id/* 控制面与元数据代理（小报文）                                 │
│  ingest：/host/v1/ingest 接收入库（library.db 唯一写者 = 宿主）                         │
│  字节签发：为未归仓预览签发短时 URL（浏览器直连插件，不经宿主转字节，见 §6.3）           │
└───────┬───────────────────────────────┬───────────────────────────────────────────────┘
        │ loopback HTTP /plugin/v1       │ loopback HTTP /plugin/v1
┌───────▼──────────┐            ┌────────▼─────────┐
│ plugins/tg/      │            │ plugins/demo-x/  │
│ orig-tg.exe（参考）│            │ <第三方插件>.exe  │
│ 独立数据目录/令牌  │            │ 独立数据目录/令牌  │
└──────────────────┘            └──────────────────┘
```

与现状差异：现在 daemon 里写死「按 `tg_enabled` 拉起 orig-tg」；M6 后变为通用 supervisor 扫描 `plugins/*/manifest.json`，TG 只是目录里第一个插件。现有进程托管、restart_tg.py Popen+wait 纪律（AGENTS §D4）沉淀为宿主通用能力。

---

## 3. 插件清单 manifest.json（随二进制同目录）

```json
{
  "manifest_version": 1,
  "id": "tg",
  "name": "TG 采集",
  "vendor": "OrigHub",
  "version": "1.4.0",
  "kind": "source",
  "min_host_version": "1.0.0",
  "max_host_version": "<2.0.0",
  "entry": "orig-tg.exe",
  "capabilities": [
    "account.flow:phone-code",
    "source.tree",
    "source.media-stream",
    "source.search",
    "source.monitor",
    "cache.tasks",
    "preview.byte-stream"
  ],
  "ui": {
    "nav": { "group": "sources", "icon": "send", "tint": "sky" },
    "panels": [
      { "slot": "source.tree",        "title_key": "channels" },
      { "slot": "source.media-stream" },
      { "slot": "source.search" }
    ],
    "empty_state": "onboarding"
  },
  "config_schema": { "$schema": "http://json-schema.org/draft-07/schema#", "…": "设置表单由宿主自动渲染" },
  "permissions": ["ingest.media", "cache.dir:512mb"],
  "health_timeout_ms": 8000
}
```

- `id` 全局唯一、小写、安装后不可变；目录名 = id。
- `kind=source` 是 v1 唯一受支持值；解析到未知 kind → 拒绝启用并提示「宿主版本过旧」。
- `capabilities` 是**枚举字符串**（不是自由描述）：宿主只渲染自己认识的能力；插件声明了宿主不认识的能力时，按「忽略未知项 + 兼容标记」处理（老宿主可继续运行新插件的已知部分；破坏性能力升级走 manifest v2）。
- `config_schema` 用 JSON Schema（+ 少量宿主渲染注解）生成设置分区，复用设置·插件区块的统一行组件；插件不提供表单代码。

---

## 4. 二进制生命周期契约

| 阶段 | 宿主动作 | 插件义务 |
|---|---|---|
| 发现 | 扫描 `%LocalAppData%\OrigHub\plugins\<id>\`；校验 manifest 与 exe 签名/哈希（见 §8） | 目录只读、文件名固定 |
| 启动（仅已启用） | 传参：`--host-loopback http://127.0.0.1:<port> --plugin-token <一次性令牌> --data-dir <专属目录> --port 0`（端口可自绑后回读）或由宿主分配；设环境隔离（不继承代理以外的杂散 env） | `health_timeout_ms` 内必须完成 `GET /plugin/v1/health` 200 + 握手 `POST /plugin/v1/register`（回 manifest 摘要 + 实际能力） |
| 运行 | 周期健康检查（指数退避，默认 15s/失败后 2/4/8…封顶 60s）；连续 N 次失败重启，重启上限后标记「插件故障」并在 UI 可见 | 健康检查轻量（不触网）；长任务走 SSE 事件回报，不阻塞健康端点 |
| 更新 | 停用旧进程 → 替换 staged 文件 → 校验 → 启动新版；失败回滚旧目录（保留上一版） | 数据目录内 schema 自迁移（沿用宿主 §D7 纪律：只加列、失败显式退出） |
| 停用/卸载 | 发 `POST /plugin/v1/shutdown`（宽限 5s）→ kill；保留数据目录直到用户显式删除 | 被要求退出时清理子进程（ffmpeg 等子进程必须随插件退出，Windows 作业对象或进程组托管） |

- 令牌每次启动重新颁发；插件→宿主的所有调用带 `Authorization: Bearer <plugin_token>`。
- 插件**不得**要求 UAC、不得写自己目录之外的位置（除宿主显式授予的缓存交接区）。

---

## 5. 接口面（v1，全部版本前缀，环回 + 令牌）

### 5.1 宿主 → 插件（`http://127.0.0.1:<pluginPort>/plugin/v1/...`）

| 接口 | 能力开关 | 说明 |
|---|---|---|
| `GET /health` | 必备 | 存活/就绪两态 |
| `POST /register` | 必备 | 握手：回 manifest 摘要、能力、诊断信息 |
| `POST /shutdown` | 必备 | 优雅退出 |
| `GET /accounts` / 账号流程端点 | `account.flow:*` | 账号列表；登录流类型由能力声明：phone-code（TG）、oauth-token（未来网盘）等；宿主用标准账号组件驱动 |
| `GET /sources/tree` | `source.tree` | 来源导航树（对话/文件夹/频道），标准节点结构（id/title/badge/parent） |
| `GET /sources/items` | `source.media-stream` | 媒体流分页（游标），返回**标准媒体项描述符**（见 §7），不返回 HTML |
| `GET /sources/search` | `source.search` | 全局搜索，同样标准结构 |
| `POST /monitor/...` | `source.monitor` | 监控订阅管理（TG 监控频道语义标准化） |
| `POST /cache/enqueue` `GET /cache/tasks` | `cache.tasks` | 入队/任务查询；任务模型复用宿主标准 CacheTask（done/total/priority/status） |
| `GET /preview/...` | `preview.byte-stream` | **未归仓字节**的短时直连预览（§6.3） |
| `GET /config` `PUT /config` | 必备 | 按 config_schema 读写插件配置（存插件自己的 kv） |
| SSE `/events` | 必备 | 任务进度、账号变化、新项目通知（宿主合并进全局 SSE 模型，前端仍单一数据源） |

约定：所有时间用 Unix 毫秒；分页统一 cursor+limit；错误体统一 `{ "error": { "code", "message_key", "retryable" } }`；`message_key` 必须是 i18n 键，文案由宿主语言包决定（插件不内嵌中文长文案，最多提供自有命名空间下的词条 JSON，宿主校验后合并）。

### 5.2 插件 → 宿主（`--host-loopback`，host 前缀 `/host/v1/`）

| 接口 | 说明 |
|---|---|
| `POST /host/v1/ingest` | **唯一入库通道**：交接字节（source=plugin id、ref 全局唯一、路径在交接区或已落库根、大小/kind/标题/描述快照/时长/尺寸）；语义 = 现「缓存即入库」幂等 upsert；返回 item_id |
| `POST /host/v1/cache/report` | 字节占用与缓存任务状态（可选，SSE 之外的对账通道） |
| `POST /host/v1/logs` | 分级日志归集（统一进宿主日志文件） |
| `POST /host/v1/notify` | 轻量通知（下载/入库完成等，进通知中心标准模型） |
| `GET /host/v1/paths` | 取授予的目录（缓存交接区、插件数据目录） |

- 插件拿不到 library.db 路径，也不允许被告知（物理隔离：环境与参数里不给）。
- 入库后文件所有权归宿主：插件不得再修改/删除已交接字节；删除联动铁律由宿主执行（删来源条目→宿主连字节删除；清缓存→只回收插件交接区字节）。

### 5.3 字节流的特殊安排（性能红线，不经过宿主代理）

- 控制面（树/搜索/任务/配置）：浏览器 → daemon → 插件，小报文代理无碍，且保证前端只见一个 origin、一套令牌刷新。
- **未归仓预览的字节流**（TG 在线流/缓存区预览）：浏览器**直连插件临时端口**。URL 由宿主签发：
  `POST /api/plugins/:id/preview-ticket { ref, ttl }` → `{ url, expires_at }`，票据 ≤ 5 分钟、单次/限次、插件验票。
- 这样既不增加播放热路径跳数（07 §1.2 红线），又不把插件端口长期暴露给前端逻辑（前端 api 层只向宿主取票，播放组件拿到临时 URL 照旧 `<video>`）。
- 已归仓内容的播放永远走 daemon `/api/media/items/:id/raw|stream`，与插件无关。

---

## 6. 标准媒体项描述符（前端统一性的核心数据契约）

插件 `/sources/items` 与 `/search` 必须返回宿主标准结构（示意，最终在 plugin-sdk 头文件/JSON Schema 定）：

```json
{
  "items": [
    {
      "source_ref": "-100123:4821",
      "kind": "video",
      "title": "标题（插件侧已按宿主规则切首行）",
      "caption": "正文",
      "size": 482133912,
      "duration_ms": 3612000,
      "width": 1920, "height": 1080,
      "thumbnail_ticket": { "ref": "thumb:-100123:4821" },
      "group": { "id": "77", "count": 10 },
      "created_at": 1728700000000,
      "actions": ["preview", "enqueue", "enqueue_group"],
      "ingest_state": "none|queued|cached|in_library",
      "library_item_id": null
    }
  ],
  "next_cursor": "…"
}
```

- 缩略图：前端 `<img>` 不直接拼插件地址，统一向宿主换 ticket（宿主侧经 TtlLru 缓存，§D3 纪律在代理层复用）。
- 渲染：宿主用现有 TgCacheEntry/MediaCard 体系泛化出来的**标准 SourceItemCard** 渲染所有插件；TG 的相册组 → `group` 字段标准处理。
- 插件不返回自定义渲染指令（v1 无 rich layout）；`kind` 枚举固定（video/photo/audio/doc/archive/other）。

---

## 7. 前端统一化方案（宿主扩展点清单）

| 扩展点 | 宿主提供 | 插件提供 |
|---|---|---|
| 导航 | 「采集」分组容器 + 槽位渲染 + 角标/未读 | manifest.ui.nav |
| 面板布局 | 三种标准布局：①tree+stream（TG 型）②list（网盘型，M6 后加）③search-only；M6 只实现① | `ui.panels[].slot` |
| 账号 | 标准账号组件：手机号+验证码流、OAuth 令牌流、错误/验证码等待态 | `account.flow` 能力 + 流程端点 |
| 媒体渲染 | SourceItemCard、相册网格、缓存进度条、全局 MediaViewer、VideoPlayer（唯一播放器） | 标准描述符 |
| 缓存任务 | 统一 CacheManagerDialog（tasks/字节两 tab） | cache.tasks 能力 + 状态事件 |
| 搜索 | 全局搜索框结果分区（按插件分组） | search 端点 |
| 设置 | 设置·插件区块：启用开关、自动渲染表单（divider 列表行）、数据目录/占用、卸载 | config_schema |
| 通知 | 通知中心 | notify 事件 |
| 空/故障态 | 未启用引导、未登录引导、插件故障/需升级宿主提示（标准四态） | 能力声明 |

v1 **禁止清单**（第三方插件做不到 = 兼容性保证）：

1. 注入任意 JS/HTML/CSS、自带前端打包物；
2. 替换/包裹播放器、修改核心域导航（下载/文件/共享/设置不可被插件加入同级之外的东西）；
3. 直接持有 library/媒体端点、监听非环回地址、弹窗/系统调用（无 shell bridge 授权）；
4. 自定义动作类型——动作只能取枚举（preview/enqueue/enqueue_group/open_library/open_source/settings）。

**v2 预留（不在承诺内）**：签名校验的 Web Bundle（锁定 host-sdk 大版本、沙箱 iframe、只允许声明式组件），满足个别强定制来源。届时必须先有沙箱与版本锁定设计，再开放。

---

## 8. 安全与供应链

| 面 | 措施 |
|---|---|
| 安装 | 插件包 = zip（manifest + exe + 许可），宿主商店/手动目录两入口；**强制**厂商签名（宿主内置公钥）或 sha256 白名单；未签名插件默认禁止启用（可高级开关，强警告） |
| 运行 | 环回绑定、每插件令牌、能力逐项授权；无对外监听；数据目录隔离 |
| 子进程 | 插件衍生的一切进程必须随插件退出（Windows Job Object）；ffmpeg 类工具由插件自管但纳入其 Job |
| 资源 | 缓存配额（manifest.permissions 声明，默认上限可设）；CPU/网络抢占沿用宿主让行策略 |
| 审核 | 第三方插件上架需过 conformance（§9）+ 安全审计；开源/官方插件（TG）随主版本发布 |

---

## 9. Conformance Kit（契约一致性套件，随 M6 交付）

`download-engine/verify/plugin-conformance/`：

1. 契约测试：用任意插件二进制跑全套 v1 接口（握手/超时/错误体/分页/令牌失效/重复 ingest 幂等）；
2. 描述符校验：items/search 返回符合 JSON Schema，无未知枚举、无 HTML；
3. 生命周期：崩溃自动重启、shutdown 后子进程清零、版本不匹配拒绝启用；
4. 性能：插件预览 ticket 直连路径不经过宿主字节代理（抓连接证据）；入库后 kill 插件，库内播放不中断（复用 07 §5 基线工具）；
5. 前端快照：标准四态 + tree+stream 布局截图（同一份测试插件，所有插件 UI 必须长在同一模板上）。
6. TG 作为第一个被测对象，其报告 `verify_shots/plugin-tg-conformance/` 即第三方模板基线。

---

## 10. TG 参考化改造映射（M6 工作拆解，细节进 tasks.md）

| 现状 | M6 目标 |
|---|---|
| daemon 写死 `/api/tg/restart`、tg_enabled 特判 | 通用 supervisor；TG 变成 `plugins/tg/`（目录与启动参数适配；二进制名可保留 orig-tg.exe） |
| `/api/tg/*` 约 30 个自有形状端点 | 收敛为 `/plugin/v1/*` 标准能力端点；TG 特有概念（folder/monitor）映射标准 tree/monitor；保留 1 个版本兼容层窗口（M6 内删除，不对外承诺） |
| TgPanel 2600 行定制三栏 | 拆成「宿主标准 Source 面板（tree+stream）+ TG 适配器（仅数据映射，无渲染）」；账号流接标准 phone-code 组件 |
| cache.rs upsert media_item | 改调 `/host/v1/ingest`（M3 已先做一次跨进程化，M6 是把目标从特化端点换成通用 host API） |
| `/api/tg/local` 预览 | 保留，改走 preview-ticket 验票；投递仍用 orig-file-serve |
| TG 配置 `/api/tg/config` | config_schema 化，设置表单自动渲染；tg_enabled 并入插件启用状态 |
| 前端 `api/tg.ts` | 改为 `api/plugin.ts`（宿主代理 + ticket 两族），TG 无专属通信模块 |

改造顺序纪律：**先有宿主与 conformance（在一个最小 demo 插件上验证），再改 TG**；不允许「边抽象边拿 TG 试」——避免把 TG 的偶然形状误当通用契约（这是 303996 号经验的同类教训：禁止以现有实现拼凑核心管线）。

---

## 11. 与六期路线的关系

- M0：前端导航预留「采集」分组槽位（TG 先作为组内唯一项），核心域与插件域视觉分组落地。
- M1-M2：不改插件形态；设置分区按未来 config_schema 自动渲染口径整理（减少 M6 差异）。
- M3：媒体/库归 daemon、字节交接先行（`/api/media/ingest` 特化版），为 M6 host API 铺路。
- **M6（新增，M3 之后、M5 可并行）**：宿主通用化 → demo 插件验证 → TG 参考化 → conformance 套件。
- M4/M5 不受插件化影响；M5 共享面只属于宿主，不对插件开放监听权。
- 工作量与风险提示：M6 是比 M3 更大的架构投入，但其价值是「第二个来源插件」起边际成本骤降；若短期无第二个来源计划，可在 M3 后按产品节奏排期，不阻塞 M4/M5。
