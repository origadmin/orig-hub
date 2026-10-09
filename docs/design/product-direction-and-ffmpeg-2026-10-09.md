---
status: draft
---

# 产品主体重定位 + ffmpeg 组件化：评估、方案、优先度与里程碑

- 日期: 2026-10-09
- 类型: 产品定位评估 + 依赖组件化设计
- 状态: draft —— 含 **3 条待拍板**，见 `docs/review/product-direction-decisions-2026-10-09.md`
- 触发: 产品负责人 2026-10-09 提出两项：
  ① **ffmpeg 将作为默认播放组件或插件** —— 需要设计安装、设置、提供服务的方案；
  ② 结合当前的改名，**工具主体是否应调整为「以媒体为核心的下载/上传/共享/管理工具」** ——
  核心是**文件管理（视频为主，其他次之）**，**上传**（EE 平台，后期做）与**共享**（本地共享 / FTP / HTTP 或其他）是强化功能。要求评估 + 整体方案 + 优先度 + 里程碑。
- 取证: 两路只读取证（ffmpeg 依赖现状 / 产品定位与能力现状）。本文所有「现状」结论均带 `文件:行`，可复核。

---

## 0. 结论摘要

| # | 结论 | 严重度 |
|---|---|---|
| 1 | **BUG-230 把 raw 退役为下载/导出端点之后，ffmpeg 已从「可选兜底」变成「唯一播放路径」** —— 但产品里**没有安装、没有版本管理、没有一个设置项**；缺失时 orig-tg 回 501（`routes.rs:3438-3443`），前端只显示停载遮罩，文案还把用户引向「检查后台服务」（`zh-CN.json:316`）—— **指错了方向**。这是本轮最该先补的缺口 | 高 |
| 2 | 你的三项新能力里，**上传与共享是零实现**，**通用文件管理也是新能力**（现有「文件」能力全被媒体域包裹）。所以这不是「调整主体」，是**新增三个模块** | 高 |
| 3 | 「共享」在语义上要求**首次把服务暴露到非环回地址**。现状 orig-tg 与 daemon 均只绑 `127.0.0.1`（`config.rs:14`），且投递节流**只在非环回生效**（BUG-199）。共享不是「加个端点」，是**首次变更安全姿态**，必须先有裁定 | 高 |
| 4 | 定位表述与你的表述**已经不一致**：`README.md:3` 与 `Sidebar.tsx:8` 都写「下载管理器 / APP 核心是下载工具」，而 `DESIGN_BRIEF.md:5` 早已写「下载管理器 **+ 媒体中心**」。**先把定位对齐（零代码风险）比先写代码更能决定后续排序** | 中 |
| 5 | 「改名」的仓库证据只有**内核 crate `surge-*` → `orig-*`**（`6f2a62a`）与两处文档改名；**产品名 Orig Hub 未变**。若你要的是产品级改名，波及面要单独列清单（sidecar 名 / appData 目录 / 环境变量 / localStorage 键 / HTTP 头），见 §3.3 | 中 |
| 6 | **不存在任何产品级路线图文档**（全库无 roadmap/milestone）。既有「计划」载体都是功能级/缺陷级（`docs/design/*-plan.md`、`docs/bugs/BACKLOG-*.md`）。本文的 §4 是第一份 | 中 |

---

## 1. 事实底座（可复核）

### 1.1 ffmpeg 现状：一个完全隐式的运行期外部依赖

| 维度 | 事实 | 证据 |
|---|---|---|
| 调用点 | 全仓**唯一** spawn ffmpeg 的地方是 orig-tg 的转码泵；**ffprobe 在产品代码中零调用** | `download-engine/crates/orig-tg/src/routes.rs:3605`（`transcode_pump` 内，3571-3805） |
| 用途 | 服务端实时转码：H.264 兼容流 + 按倍速的 FRC 变体（fMP4 直播流 / 落盘代理） | 参数构造 `routes.rs:3612-3667` |
| 端点 | `GET /api/media/items/:id/stream`（命中代理直接投递，冷启动才 spawn） | `routes.rs:3370-3559` |
| 定位方式 | **无 bundled sidecar**。解析链：`ORIG_FFMPEG_PATH` → 可执行文件同目录 → `<TG 数据目录>/bin/` → `%LOCALAPPDATA%\OrigHub\bin` → `<TG 数据目录>/../bin/` → `PATH` | `routes.rs:3286-3343`（env 读于 `:3287`，候选目录 `:3319-3341`） |
| 缺失时 | 返回 **501 NOT_IMPLEMENTED**，文案要求用户自行安装或设 env | `routes.rs:3438-3443` |
| 前端表现 | 拿不到兼容流 → 停载遮罩 + 致命态 | `tauri-shell/src/components/media/VideoPlayer.tsx:738-760`、`:1040` |
| 安装/版本管理 | **不存在**。无下载代码、无校验、无最低版本断言 | `scripts/sync-sidecars.sh:73` 只同步 `orig-tg`/`orig-daemon`；`tauri-shell/src-tauri/tauri.conf.json:34` `externalBin` 不含 ffmpeg；`.github/workflows/ci.yml` 无 ffmpeg 步骤 |
| 设置面 | 前端**无任何** ffmpeg / 转码 / 清晰度设置项 | `tauri-shell/src/components/SettingsPanel.tsx` 无匹配；`tauri-shell/src/hooks/usePlayerSettings.ts:11` 注释明写「无多档转码，不存在清晰度概念」 |
| 可调项 | 仅 3 个 env；编码档位**硬编码在代码里** | `ORIG_FFMPEG_PATH` `routes.rs:3287`；`ORIG_TG_PROXY_MAX_BYTES` `routes.rs:3818`；`ORIG_TG_DELIVERY_BPS` `routes.rs:3931`；`encode_profile` `routes.rs:3238-3244` |
| 产物落盘 | `<TG 数据目录>/proxies/`，命名 `<id>.mp4` / `<id>-speed-<百分之一倍速>.mp4` | `crates/orig-tg/src/store.rs:724`、`routes.rs:3396-3398` |
| 本机现状 | 唯一「落地」是人工记录：ffmpeg 9.0.2 手工放在 `%LocalAppData%\OrigHub\bin\ffmpeg.exe` | `docs/bugs/BUG-208.md:48-49` |

> **一句话**：ffmpeg 是「用户看不见、装不了、查不到、也关不掉」的组件，而它现在承载着**全部播放**。

### 1.2 产品定位现状

| 位置 | 表述 |
|---|---|
| `README.md:3` | 「Orig Hub —— 基于 Surge 架构参考的**桌面端下载管理器**（YouTube Studio 风格）」 |
| `tauri-shell/src/components/Sidebar.tsx:8` | 「**APP 核心是下载工具**，下载队列按 `download.status` 的七态拆成三档导航」 |
| `docs/DESIGN_BRIEF.md:5` | 「Orig Hub 是一款**桌面端下载管理器 + 媒体中心**……新增视频播放（接入 orig-cms-ee）、媒体库、悬浮窗、FAB 等核心模块」 |
| `download-engine/README.md:1` | 「orig-hub 下载内核」 |

**已写下的模块边界裁定**（与「媒体为核心」方向一致，是既有地基）：

- `docs/MEDIA-DESIGN.md:11-16`：M1 展示 / M2 缓存 / M3 媒体库 三模块职责与**禁区**；M3 的禁区含「**不依赖 TG 会话**」。
- `docs/design/media-service-deployment-decision-2026-09-28.md:5-6`：裁定「**媒体库是独立核心模块；Telegram 只是可替换的采集/传输通道**」。

**未写下**：任何产品级的「本产品不做 X」非目标声明。

### 1.3 能力盘点

| 能力 | 你的定位 | 现状 | 证据 |
|---|---|---|---|
| 下载 | 既有 | ✅ 已实现（CRUD + SSE + activity） | `download-engine/crates/orig-daemon/src/routes.rs:884-897` |
| 播放 | 隐含（「视频为主」） | ✅ 已实现，但**硬依赖 ffmpeg**（BUG-230 后） | `crates/orig-tg/src/routes.rs:96`（raw）、`:98`（stream） |
| 媒体库 | （未提，但已存在） | ✅ 已成型：条目 / 剧集 / 标签 / 相册 / 导出 | `tauri-shell/src/components/MediaLibraryPanel.tsx`、`components/media/*`、`crates/orig-tg/src/routes.rs:86-167` |
| **文件管理（通用）** | **核心** | ❌ **无**。现有「文件」能力**全部被媒体域包裹**：`/api/media/scan`（`routes.rs:168`）、导入（`routes.rs:88-89`）、剧集内移动（`routes.rs:132-135`）。没有通用浏览/移动/删除/去重端点 | 同上 |
| **上传** | 强化（EE 平台，后期） | ❌ **无**。只有「**导出**本地目录供 orig-studio-ee 上传」一侧，上传本体在产品之外 | `docs/design/ee-export-p6-2026-09-25.md:3` |
| **共享（本地/FTP/HTTP）** | 强化 | ❌ **无**。`SourceKind::Ftp` 是**下载协议枚举**不是共享服务；FTP 在下载侧也只是「未来插件」 | `download-engine/crates/orig-core/src/protocol.rs:271`；`download-engine/README.md:108` |

---

## 2. 第①问：ffmpeg 作为默认播放组件 / 插件

### 2.1 为什么它现在必须先做

BUG-230 之前，raw 直解是主路径，ffmpeg 只是「浏览器解不了时的兜底」——缺失只影响少数源。
BUG-230 之后（`docs/bugs/BUG-230.md`，用户裁定），**播放一律 stream-first**，raw 退役为下载/导出端点。于是：

- ffmpeg 缺失 = **什么视频都放不了**，而不是「个别格式放不了」；
- 而用户看到的文案是「请确认 OrigHub 后台服务（orig-tg）正在运行」（`zh-CN.json:316`）——
  后台服务明明在跑，**文案把用户引向了一个不会出错的方向**；
- 501 的原文（`routes.rs:3441`）虽然说了要装 ffmpeg，但它是**HTTP 响应体**，不是用户可见的 UI 文案。

**结论：这不是「新功能」，是一个由 BUG-230 直接引出的既有缺陷。** 它排 P0。

### 2.2 三档能力（它们不是同一个方案）

**档 A — 可诊断（最小）**

- 启动自检：复用既有解析链 `routes.rs:3286-3343`，在 `/api/tg/diag` 增加 ffmpeg 字段
  （是否找到 / 路径 / 版本）。
- 前端：设置页显示「播放引擎：已安装 v9.0.2（路径…）/ **未安装**」；
  把 501 翻译成能行动的文案（装什么、放哪里、或点哪个按钮）。
- 涉及: `download-engine/crates/orig-tg/src/routes.rs:3286-3343`（复用，不重写）、
  `tauri-shell/src/components/SettingsPanel.tsx`、`tauri-shell/src/i18n/locales/zh-CN.json`、
  `tauri-shell/src/i18n/locales/en-US.json`
- 量化: 1 个 diag 字段 + 1 个设置区块 + 2~3 处文案；**0 新增依赖、0 新端点**
- 回归风险: 低 —— 只加只读状态与文案，不碰转码链路
- 后果: 用户第一次遇到「放不了」时知道原因；但仍需**自己**去装

**档 B — 受管理组件（"默认播放组件"的实质）**

- 应用内一键安装/更新：下载静态构建 → **校验 sha256** → 落到
  `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`。
  **注意：这个位置已经是既有解析链的第 4 位（`routes.rs:3323-3325`），装进去即生效，无需改解析链。**
- 版本记录 + 最低版本断言（代码已依赖 `-fpsmax` 与 `atempo` 的段界行为，
  见 `routes.rs:3632-3634`、`:3250-3263`，但没有任何版本护栏）。
- 设置面：转码开关、缓存预算（`ORIG_TG_PROXY_MAX_BYTES` 已有 env，`routes.rs:3818`）、
  编码档位（现硬编码 `routes.rs:3238-3244`）。
- 涉及: `download-engine/crates/orig-tg/src/`（**将新建**安装模块）、
  `download-engine/crates/orig-daemon/src/routes.rs`（下载代理端点，**将新建**）、
  `tauri-shell/src/components/SettingsPanel.tsx`
- 量化: 首次约 80–120 MB 下载；新增 3~4 个端点；1 个版本常量
- 回归风险: 中 —— 引入供应链信任（镜像可信度）、代理（本机是 SOCKS5 `127.0.0.1:7897` 场景，
  见 `crates/orig-tg/src/config.rs:30-32`）、离线可用性
- 后果: 用户零操作即可播；但产品从此背上**分发与信任责任**

**档 C — 插件化（可替换后端）**

- 把 spawn 点 `routes.rs:3605` 与 `encode_profile`/`speed_video_filter` 抽象为 provider trait，
  允许 ffmpeg 之外的实现（硬件编码器、远程转码）。
- 量化: **无法量化收益** —— 现在没有第二个后端，抽象是为不存在的需求付成本
- 后果: 增加一层间接，且会拖慢 A/B

### 2.3 推荐

**做 A（立刻）+ 做 B（紧随）**，**不做 C**。

理由：A 修的是一个真实缺陷（P0）；B 才是「默认播放组件」的实质，且它的落点
（`%LOCALAPPDATA%\OrigHub\bin`）**已经被现有解析链预留**，改造成本比看起来低；
C 需要第二个后端才有意义，现在做就是过度设计。

### 2.4 边界（明确不做）

- **不做转码参数的用户可见"画质档位"**：`usePlayerSettings.ts:11` 已裁定「本地文件直投，不存在清晰度概念」；
  B 档暴露的是**开关与预算**，不是"1080p/720p"这种伪档位。
- **不把 ffmpeg 塞进 Tauri `externalBin`**：那会让安装包膨胀且把 GPL/LGPL 分发义务带进主包；
  独立安装到用户数据目录同时解决了体积与许可两个问题。

---

## 3. 第②问：主体调整评估

### 3.1 你的提议 vs 现状（差距矩阵）

| 能力 | 你的定位 | 现状 | 差距性质 | 前置依赖 |
|---|---|---|---|---|
| 下载 | 既有 | ✅ 已实现 | — | — |
| 播放 | 「视频为主」的前提 | ✅ 已实现，但硬依赖 ffmpeg | **组件不可见** | 第①问（P0） |
| 媒体库 | 未提，但已存在 | ✅ 已成型 | — | — |
| 文件管理（通用） | **核心** | ❌ 无 | **新模块** | 需先定它与媒体库的关系（D1） |
| 上传 | 强化 / 后期 | ❌ 无（只有导出包） | **新模块** | EE 侧接口（D 之外） |
| 共享 | 强化 | ❌ 无 | **新模块 + 安全姿态变更** | 需先定形态（D3） |

### 3.2 三个必须先解决的张力

**张力一：文件管理 vs 媒体库 —— 是「同一件事的两个视图」，还是「两个模块」？**

- 媒体库管的是**领域模型**（条目 / 剧集 / 来源），且已裁定为独立核心模块、
  明确「不依赖 TG」（`docs/MEDIA-DESIGN.md:11-16`、`media-service-deployment-decision-2026-09-28.md:5-6`）。
- 「文件管理」管的是**磁盘上的字节**（浏览 / 移动 / 删除 / 去重 / 占用）。
- 两者关系必须选一种，否则做出来会互相打架：
  - 若文件管理 = 媒体库的一个**视图**（只看媒体文件在磁盘上的呈现）→ 增量小，
    但你说的「其他次之」的**非视频文件没有家**；
  - 若文件管理是**纲**、媒体库是其上的领域视图 → 最贴合你的表述，
    但要重写信息架构（`Sidebar.tsx` 一级导航 + `MediaLibraryPanel.tsx`）。

→ **待拍板 D1**。

**张力二：共享 = 首次把服务暴露到局域网**

- 现状：orig-tg `config.rs:14` 默认 `bind = "127.0.0.1"`（注释明写「仅本机」）；daemon 同理。
- BUG-199 已裁定：媒体投递节流**只在非环回生效**（环回时返回 0 = 不限速）。
  一旦监听非环回，**限速 / 背压 / 并发会立刻从"不存在的问题"变成真问题**。
- 另外还缺：认证（谁能看）、绑定策略（`0.0.0.0` 还是指定网卡）、防火墙引导、TLS。
- 结论：共享不是「加个端点」，是**首次变更安全姿态**。

→ **待拍板 D3**。

**张力三：上传 = 导出包的直传升级（所以它排最后不亏）**

- 现状 `docs/design/ee-export-p6-2026-09-25.md:3` 的形态是「导出本地目录供 orig-studio-ee 上传」——
  **上传发生在产品之外**，但导出产物已经可用。
- 所以「上传」不是从零发明，而是把**已存在的导出产物**直接推给 EE。
  这也意味着它延后做，用户不会「什么都没有」。

### 3.3 若确要产品级改名：波及清单

仓库里**已发生**的改名只有内核 crate：`6f2a62a refactor(download-engine): rename entire Rust kernel from surge-* to orig-*`
（`libsurge→orig-core`、`surge-daemon→orig-daemon`、`surge-net→orig-net`、`surge-protocol-*→orig-protocol-*`），
以及两处文档改名。**产品名「Orig Hub」在 `README.md:1`、`DESIGN_BRIEF.md:5` 一致，未变。**

若要做产品级改名，以下标识符会被波及（**这些比文档改名贵得多**）：

| 类别 | 现状 | 证据 |
|---|---|---|
| sidecar 名 | `orig-daemon`、`orig-tg` | `tauri-shell/src-tauri/tauri.conf.json:34`、`src-tauri/src/lib.rs:16` |
| appData 目录 | `%APPDATA%\com.origadmin.orighub`（`daemon.endpoint` 真源） | 运行时实测 |
| 环境变量 | 旧名残留 `SURGE_DOWNLOAD_DIR`/`SURGE_MAX_CONNECTIONS`/`SURGE_TOKEN`；新名 `ORIG_*` 一组 | `download-engine/README.md:49,64,73` |
| localStorage 键 | `orighub_player_settings`；`orighub.compatSrcs`（已废） | `tauri-shell/src/hooks/usePlayerSettings.ts:20` |
| HTTP 头 | `x-orig-stream` | `crates/orig-tg/src/routes.rs:3433` |

**判定：改名本身不产生用户价值，但会产生一次全量回归风险**（旧 appData 目录里的会话/凭据/缓存会"丢失"，
旧 env 失效）。除非有外部约束（品牌 / 上架），建议**只统一用户可见的产品名与文档表述，不动标识符**。

---

## 4. 优先度与里程碑

### 4.1 排序依据（不是偏好，是依赖）

1. 「视频为主」的前提是**播放能用** → ffmpeg 缺口必须先补（P0，且它本身是缺陷）。
2. 定位对齐**零代码风险**，且决定后续每件事的排序（不先做，之后每件事都要重新争论「这算核心还是强化」）→ P1。
3. 三个新能力里，按**你的表述**排序：核心（文件管理）→ 强化（共享）→ 后期（上传）。
   只把「共享」的**拍板**提前到 P1（因为它是唯一要变更安全姿态的，前置裁定成本最高），
   但它的**实现**仍排在文件管理之后。

| 优先级 | 事项 | 为什么在这个位置 |
|---|---|---|
| **P0** | 播放引擎可见性（档 A）+ 播放主线收尾（BUG-223~230 全部 `fixed`、门禁绿） | 视频为主的工具，播放不能放；且这是既有缺陷 |
| **P1** | 定位对齐（`README.md` / `Sidebar.tsx` / 导航 / 非目标声明）+ ffmpeg 受管理组件（档 B）+ **D1/D2/D3 三个拍板** | 零代码风险，且解锁后面所有排序 |
| **P2** | **文件管理**（视频为主，其他次之） | 你的「核心」；形态由 D1 拍板后即可动工 |
| **P3** | **共享最小可用**（局域网 HTTP 只读） | 你的「强化」；安全裁定已在 P1 完成 |
| **P4** | **上传**（EE 直传，导出包升级） | 你自己定的「后期」；且导出包已能过渡 |

### 4.2 里程碑

| 里程碑 | 内容 | 完成判据（可证伪） |
|---|---|---|
| **M0 收尾** | 播放主线冻结 + ffmpeg 可诊断 | ① `docs/bugs/` 中 BUG-223~230 状态与代码一致、`check-bugs.py` 绿；② 断开 ffmpeg（临时改 env 指向不存在路径）后，设置页明确显示「未安装」，播放失败文案指向安装而不是「检查后台服务」 |
| **M1 定位与引擎** | 定位对齐 + ffmpeg 受管理组件 + 三个拍板落定 | ① `README.md`/`Sidebar.tsx` 表述与裁定一致；② 一台**没装过 ffmpeg** 的机器上，从零到能播放不需要命令行操作；③ 三个 D 项在 `docs/review/` 标为已决并写明裁定 |
| **M2 文件管理** | 通用文件浏览/移动/删除 + 视频优先视图 | ① 非媒体文件（如 `.pdf`/`.zip`）可浏览、可移动、可删除；② 视频仍走既有媒体库视图，**两处不出现同一文件的两套事实** |
| **M3 共享** | 局域网 HTTP 只读共享 | ① 同网段另一台设备能播放；② 非环回时投递限速**确实生效**（BUG-199 的判据在共享路径上复验）；③ 未授权设备拿不到内容 |
| **M4 上传** | EE 直传 | ① 导出包可直接推送到 EE，无需手工搬运；② 失败可重试且不重复上传 |

---

## 5. 待拍板

三条，见 `docs/review/product-direction-decisions-2026-10-09.md`：

- **D1** 文件管理与媒体库的关系（纲 / 视图 / 维持现状）
- **D2** ffmpeg 的获取策略（应用内自动安装 / 检测+一键指路 / 仅补文案）
- **D3** 共享的第一形态（局域网 HTTP 只读 / FTP / 不做）

依赖顺序：**D2 与 D1/D3 无依赖，可同时拍**；D1 拍完才能开工 P2，D3 拍完才能开工 P3。

---

## 6. 关联

- `docs/bugs/BUG-230.md`（播放主路径 stream-first 翻转 —— 本文结论 #1 的前提）
- `docs/bugs/BUG-208.md`（ffmpeg 本机手工安装的唯一记录）
- `docs/MEDIA-DESIGN.md`（M1/M2/M3 模块边界，既有地基）
- `docs/design/media-service-deployment-decision-2026-09-28.md`（媒体库独立核心模块裁定）
- `docs/design/ee-export-p6-2026-09-25.md`（EE 导出包形态 —— 上传的前身）
- `docs/review/product-direction-decisions-2026-10-09.md`（本文三条待拍板的强制格式版）
