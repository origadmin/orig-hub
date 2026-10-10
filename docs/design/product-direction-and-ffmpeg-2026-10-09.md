---
status: draft
author: 高见远（架构师）
date: 2026-10-09
topic: governance
module: docs
decided-by: D1/D2/D3 均由产品负责人裁定为 A（2026-10-11，见 `docs/review/product-direction-decisions-2026-10-09.md`）
decided-at: 2026-10-11
landed-in: D3 取证见 `docs/review/shared-d3-forensics-2026-10-11.md`（本文为评估与计划；PD-T01~PD-T06 均未开工）
---

# 产品主体重定位 + ffmpeg 组件化：评估、方案、任务分解与里程碑

- 日期: 2026-10-09
- 类型: 产品定位评估 + 依赖组件化设计 + 执行计划
- 状态: draft —— D1/D2/D3 已于 2026-10-11 全部裁定为 A（本文为评估与计划，PD-Txx 均未开工；各任务落地前须先落定对应裁定解读里的强制前置）
- 关联待拍板清单: `docs/review/product-direction-decisions-2026-10-09.md`
- 关联任务表: 本文 **§4.2**（`PD-T01`~`PD-T05`，含源文件/依赖/优先级/状态/负责）
- `topic` 取值说明: 本文是**产品定位与路线图**，故取 `governance`；其中 ffmpeg 分发（档 B）与共享（D3）的落地细节属 `deployment` 域，届时另开 `docs/design/*` 档并在 `docs/README.md` 登记
- 触发: 产品负责人 2026-10-09 提出两项：
  ① **ffmpeg 将作为默认播放组件或插件** —— 需要设计安装、设置、提供服务的方案；
  ② 结合当前的改名，**工具主体是否应调整为「以媒体为核心的下载/上传/共享/管理工具」** ——
  核心是**文件管理（视频为主，其他次之）**，**上传**（EE 平台，后期做）与**共享**（本地共享 / FTP / HTTP 或其他）是强化功能。要求评估 + 整体方案 + 优先度 + 里程碑。
- 取证: 两路只读取证（ffmpeg 依赖现状 / 产品定位与能力现状）。本文所有「现状」结论均带 `文件:行`，可复核。

---

## 0. 结论摘要

| # | 结论 | 严重度 |
|---|---|---|
| 1 | **BUG-230 把 raw 退役为下载/导出端点之后，ffmpeg 已从「可选兜底」变成「唯一播放路径」** —— 但产品里**没有安装、没有版本管理、没有一个设置项**；缺失时 orig-tg 回 501（`download-engine/crates/orig-tg/src/routes.rs:3481-3486`），前端只显示停载遮罩，文案还把用户引向「检查后台服务」（`tauri-shell/src/i18n/locales/zh-CN.json:323`）—— **指错了方向**。这是本轮最该先补的缺口 | 高 |
| 2 | 你的三项新能力里，**上传与共享是零实现**，**通用文件管理也是新能力**（现有「文件」能力全被媒体域包裹）。所以这不是「调整主体」，是**新增三个模块** | 高 |
| 3 | 「共享」在语义上要求**首次把服务暴露到非环回地址**。现状 orig-tg 与 daemon 均只绑 `127.0.0.1`（`download-engine/crates/orig-tg/src/config.rs:14`），且投递节流**只在非环回生效**（BUG-199）。共享不是「加个端点」，是**首次变更安全姿态**，必须先有裁定 | 高 |
| 4 | 定位表述与你的表述**已经不一致**：`./README.md:3` 与 `tauri-shell/src/components/Sidebar.tsx:8` 都写「下载管理器 / APP 核心是下载工具」，而 `docs/DESIGN_BRIEF.md:5` 早已写「下载管理器 **+ 媒体中心**」。**先把定位对齐（零代码风险）比先写代码更能决定后续排序** | 中 |
| 5 | 「改名」的仓库证据只有**内核 crate `surge-*` → `orig-*`**（`6f2a62a`）与两处文档改名；**产品名 Orig Hub 未变**。若你要的是产品级改名，波及面要单独列清单（sidecar 名 / appData 目录 / 环境变量 / localStorage 键 / HTTP 头），见 §3.3 | 中 |
| 6 | **不存在任何产品级路线图文档**（全库无 roadmap/milestone）。既有「计划」载体都是功能级/缺陷级（`docs/design/*-plan.md`、`docs/bugs/BACKLOG-*.md`）。本文的 §4 是第一份 | 中 |

---

## 1. 事实底座（可复核）

> **引用锚定说明（2026-10-09）**：本节及全文所有 `文件:行号` 引用**锚定于 2026-10-09 的工作区状态**。
> 当时 `download-engine/crates/orig-tg/src/routes.rs`、`download-engine/crates/orig-daemon/src/routes.rs`、
> `download-engine/crates/orig-tg/src/store.rs` 三个文件**含有未提交的在途改动**
> （`git diff --numstat` 分别为 `+52/-9`、`+44/-0`、`+31/-0`），本次已按工作区重新锚定，
> 映射见文末「变更记录」。
> **行号会随代码移动而失效，构造名不会** —— 引用对不上时请按**构造名**检索，不要按行号找：
> `resolve_ffmpeg_path`（ffmpeg 解析链）、`transcode_pump`（唯一 spawn 点）、`media_item_stream`（stream 端点）、
> `encode_profile`（编码档位）、`proxy_dir`（产物落盘目录）。

### 1.1 ffmpeg 现状：一个完全隐式的运行期外部依赖

| 维度 | 事实 | 证据 |
|---|---|---|
| 调用点 | 全仓**唯一** spawn ffmpeg 的地方是 orig-tg 的转码泵；**ffprobe 在产品代码中零调用** | `download-engine/crates/orig-tg/src/routes.rs:3648`（`transcode_pump` 内，3614-3848） |
| 用途 | 服务端实时转码：H.264 兼容流 + 按倍速的 FRC 变体（fMP4 直播流 / 落盘代理） | 参数构造 `download-engine/crates/orig-tg/src/routes.rs:3655-3710` |
| 端点 | `GET /api/media/items/:id/stream`（命中代理直接投递，冷启动才 spawn） | `download-engine/crates/orig-tg/src/routes.rs:3413-3602` |
| 定位方式 | **无 bundled sidecar**。解析链：`ORIG_FFMPEG_PATH` → 可执行文件同目录 → `<TG 数据目录>/bin/` → `%LOCALAPPDATA%\OrigHub\bin` → `<TG 数据目录>/../bin/` → `PATH` | `download-engine/crates/orig-tg/src/routes.rs:3329-3386`（env 读于 `:3330`，候选目录 `:3362-3384`） |
| 缺失时 | 返回 **501 NOT_IMPLEMENTED**，文案要求用户自行安装或设 env | `download-engine/crates/orig-tg/src/routes.rs:3481-3486` |
| 前端表现 | 拿不到兼容流 → 停载遮罩 + 致命态 | `tauri-shell/src/components/media/VideoPlayer.tsx:738-760`、`:1040` |
| 安装/版本管理 | **不存在**。无下载代码、无校验、无最低版本断言 | `scripts/sync-sidecars.sh:73` 只同步 `orig-tg`/`orig-daemon`；`tauri-shell/src-tauri/tauri.conf.json:34` `externalBin` 不含 ffmpeg；`.github/workflows/ci.yml` 无 ffmpeg 步骤 |
| 设置面 | 前端**无任何** ffmpeg / 转码 / 清晰度设置项 | `tauri-shell/src/components/SettingsPanel.tsx` 无匹配；`tauri-shell/src/hooks/usePlayerSettings.ts:11` 注释明写「无多档转码，不存在清晰度概念」 |
| 可调项 | 仅 3 个 env；编码档位**硬编码在代码里** | `ORIG_FFMPEG_PATH` `download-engine/crates/orig-tg/src/routes.rs:3330`；`ORIG_TG_PROXY_MAX_BYTES` `download-engine/crates/orig-tg/src/routes.rs:3861`；`ORIG_TG_DELIVERY_BPS` `download-engine/crates/orig-tg/src/routes.rs:3974`；`encode_profile` `download-engine/crates/orig-tg/src/routes.rs:3281-3287` |
| 产物落盘 | `<TG 数据目录>/proxies/`，命名 `<id>.mp4` / `<id>-speed-<百分之一倍速>.mp4` | `download-engine/crates/orig-tg/src/store.rs:750-761`、`download-engine/crates/orig-tg/src/routes.rs:3439-3441` |
| 本机现状 | 唯一「落地」是人工记录：ffmpeg 9.0.2 手工放在 `%LocalAppData%\OrigHub\bin\ffmpeg.exe` | `docs/bugs/BUG-208.md:48-49` |

> **一句话**：ffmpeg 是「用户看不见、装不了、查不到、也关不掉」的组件，而它现在承载着**全部播放**。

### 1.2 产品定位现状

| 位置 | 表述 |
|---|---|
| `./README.md:3` | 「Orig Hub —— 基于 Surge 架构参考的**桌面端下载管理器**（YouTube Studio 风格）」 |
| `tauri-shell/src/components/Sidebar.tsx:8` | 「**APP 核心是下载工具**，下载队列按 `download.status` 的七态拆成三档导航」 |
| `docs/DESIGN_BRIEF.md:5` | 「Orig Hub 是一款**桌面端下载管理器 + 媒体中心**……新增视频播放（接入 orig-cms-ee）、媒体库、悬浮窗、FAB 等核心模块」 |
| `download-engine/README.md:1` | 「orig-hub 下载内核」 |

**已写下的模块边界裁定**（与「媒体为核心」方向一致，是既有地基）：

- `docs/MEDIA-DESIGN.md:11-16`：M1 展示 / M2 缓存 / M3 媒体库 三模块职责与**禁区**；M3 的禁区含「**不依赖 TG 会话**」。
- `docs/design/media-service-deployment-decision-2026-09-28.md:6-8`：裁定「**媒体库是独立核心模块；Telegram 只是可替换的采集/传输通道**」。

**未写下**：任何产品级的「本产品不做 X」非目标声明。

### 1.3 能力盘点

| 能力 | 你的定位 | 现状 | 证据 |
|---|---|---|---|
| 下载 | 既有 | ✅ 已实现（CRUD + SSE + activity） | `download-engine/crates/orig-daemon/src/routes.rs:925-931` |
| 播放 | 隐含（「视频为主」） | ✅ 已实现，但**硬依赖 ffmpeg**（BUG-230 后） | `download-engine/crates/orig-tg/src/routes.rs:96`（raw）、`:98`（stream） |
| 媒体库 | （未提，但已存在） | ✅ 已成型：条目 / 剧集 / 标签 / 相册 / 导出 | `tauri-shell/src/components/MediaLibraryPanel.tsx`、`components/media/*`、`download-engine/crates/orig-tg/src/routes.rs:86-167` |
| **文件管理（通用）** | **核心** | ❌ **无**。现有「文件」能力**全部被媒体域包裹**：`/api/media/scan`（`download-engine/crates/orig-tg/src/routes.rs:168`）、导入（`download-engine/crates/orig-tg/src/routes.rs:88-89`）、剧集内移动（`download-engine/crates/orig-tg/src/routes.rs:132-135`）。没有通用浏览/移动/删除/去重端点 | 同上 |
| **上传** | 强化（EE 平台，后期） | ❌ **无**。只有「**导出**本地目录供 orig-studio-ee 上传」一侧，上传本体在产品之外 | `docs/design/ee-export-p6-2026-09-25.md:3` |
| **共享（本地/FTP/HTTP）** | 强化 | ❌ **无**。`SourceKind::Ftp` 是**下载协议枚举**不是共享服务；FTP 在下载侧也只是「未来插件」 | `download-engine/crates/orig-core/src/protocol.rs:271`；`download-engine/README.md:108` |

---

## 2. 第①问：ffmpeg 作为默认播放组件 / 插件

### 2.1 为什么它现在必须先做

BUG-230 之前，raw 直解是主路径，ffmpeg 只是「浏览器解不了时的兜底」——缺失只影响少数源。
BUG-230 之后（`docs/bugs/BUG-230.md`，用户裁定），**播放一律 stream-first**，raw 退役为下载/导出端点。于是：

- ffmpeg 缺失 = **什么视频都放不了**，而不是「个别格式放不了」；
- 而用户看到的文案是「请确认 OrigHub 后台服务（orig-tg）正在运行」（`tauri-shell/src/i18n/locales/zh-CN.json:323`）——
  后台服务明明在跑，**文案把用户引向了一个不会出错的方向**；
- 501 的原文（`download-engine/crates/orig-tg/src/routes.rs:3484`）虽然说了要装 ffmpeg，但它是**HTTP 响应体**，不是用户可见的 UI 文案。

**结论：这不是「新功能」，是一个由 BUG-230 直接引出的既有缺陷。** 它排 P0。

### 2.2 三档能力（它们不是同一个方案）

**档 A — 可诊断（最小）**

- 启动自检：复用既有解析链 `download-engine/crates/orig-tg/src/routes.rs:3329-3386`，在 `/api/tg/diag` 增加 ffmpeg 字段
  （是否找到 / 路径 / 版本）。
- 前端：设置页显示「播放引擎：已安装 v9.0.2（路径…）/ **未安装**」；
  把 501 翻译成能行动的文案（装什么、放哪里、或点哪个按钮）。
- 涉及: `download-engine/crates/orig-tg/src/routes.rs:3329-3386`（复用，不重写）、
  `tauri-shell/src/components/SettingsPanel.tsx`、`tauri-shell/src/i18n/locales/zh-CN.json`、
  `tauri-shell/src/i18n/locales/en-US.json`
- 量化: 1 个 diag 字段 + 1 个设置区块 + 2~3 处文案；**0 新增依赖、0 新端点**
- 回归风险: 低 —— 只加只读状态与文案，不碰转码链路
- 后果: 用户第一次遇到「放不了」时知道原因；但仍需**自己**去装

**档 B — 受管理组件（"默认播放组件"的实质）**

- 应用内一键安装/更新：下载静态构建 → **校验 sha256** → 落到
  `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`。
  **注意：这个位置已经是既有解析链的第 4 位（`download-engine/crates/orig-tg/src/routes.rs:3366-3368`），装进去即生效，无需改解析链。**
- 版本记录 + 最低版本断言（代码已依赖 `-fpsmax` 与 `atempo` 的段界行为，
  见 `download-engine/crates/orig-tg/src/routes.rs:3675-3677`、`:3293-3306`，但没有任何版本护栏）。
- 设置面：转码开关、缓存预算（`ORIG_TG_PROXY_MAX_BYTES` 已有 env，`download-engine/crates/orig-tg/src/routes.rs:3861`）、
  编码档位（现硬编码 `download-engine/crates/orig-tg/src/routes.rs:3281-3287`）。
- 涉及: `download-engine/crates/orig-tg/src/`（**将新建**安装模块）、
  `download-engine/crates/orig-daemon/src/routes.rs`（下载代理端点，**将新建**）、
  `tauri-shell/src/components/SettingsPanel.tsx`
- 量化: 首次约 80–120 MB 下载；新增 3~4 个端点；1 个版本常量
- 回归风险: 中 —— 引入供应链信任（镜像可信度）、代理（本机是 SOCKS5 `127.0.0.1:7897` 场景，
  见 `download-engine/crates/orig-tg/src/config.rs:30-32`）、离线可用性
- 后果: 用户零操作即可播；但产品从此背上**分发与信任责任**

**档 C — 插件化（可替换后端）**

- 把 spawn 点 `download-engine/crates/orig-tg/src/routes.rs:3648` 与 `encode_profile`/`speed_video_filter` 抽象为 provider trait，
  允许 ffmpeg 之外的实现（硬件编码器、远程转码）。
- 量化: **无法量化收益** —— 现在没有第二个后端，抽象是为不存在的需求付成本
- 后果: 增加一层间接，且会拖慢 A/B

### 2.3 推荐

**做 A（立刻）+ 做 B（紧随）**，**不做 C**。

理由：A 修的是一个真实缺陷（P0）；B 才是「默认播放组件」的实质，且它的落点
（`%LOCALAPPDATA%\OrigHub\bin`）**已经被现有解析链预留**，改造成本比看起来低；
C 需要第二个后端才有意义，现在做就是过度设计。

### 2.4 边界（明确不做）

- **不做转码参数的用户可见"画质档位"**：`tauri-shell/src/hooks/usePlayerSettings.ts:11` 已裁定「本地文件直投，不存在清晰度概念」；
  B 档暴露的是**开关与预算**，不是"1080p/720p"这种伪档位。
- **不把 ffmpeg 塞进 Tauri `externalBin`**：那会让安装包膨胀且把 GPL/LGPL 分发义务带进主包；
  独立安装到用户数据目录同时解决了体积与许可两个问题。

---

### 2.5 硬件解码与配置推荐（2026-10-10 用户指令；本节为**追加**，不改 §2.1–§2.4 的结论）

**用户指令原文**：

> 1. 先加 ffmpeg 插件设置，**硬解作为默认配置启用项目，当前为多显卡**。
> 2. **性能可以提前评估，根据配置大致估算出来吧？不需要实际去跑**，只需要根据性能推荐配置，
>    ffmpeg 根据配置去处理任务。
> 3. 所以 ffmpeg 插件这块**需要提升优先级了**。

#### 2.5.1 现状（可复核）

| 维度 | 事实 | 证据 |
|---|---|---|
| 硬件解码 | **完全没有** —— 全 crate 搜 `hwaccel` **0 命中** | `download-engine/crates/orig-tg/src/routes.rs:4004-4059`（ffmpeg 参数构造） |
| 输出缩放 | **完全没有** —— `scale=` 0 命中 ⇒ 输出分辨率 = 源分辨率 | 同上 |
| 编码档位 | 硬编码两档（`≥3x` → ultrafast/crf28/fps24；否则 veryfast/crf23/fps30） | `encode_profile`（`download-engine/crates/orig-tg/src/routes.rs:3621-3636`） |
| 本机 GPU | **多显卡**：Intel iGPU + RTX3060 Laptop | 本机 `ffmpeg -hwaccels` = `cuda vaapi dxva2 qsv d3d11va d3d12va amf` |
| 本机后端选择 | `-hwaccel auto` 实测选中 **`dxva2`**，**未做显式设备选择** | 2026-10-10 实测（verbose 证实） |

#### 2.5.2 实测依据（决定「推荐什么」）

条目 673（HEVC 1080p，403s）`-t 60` 串行采样，同机：

| 配置 | x 源实时 | 结论 |
|---|---|---|
| 4x 档基线（纯软解软编） | 3.37–3.59（全片 4.12） | 恰在 4x 边缘 |
| **4x 档 + `-hwaccel auto`** | **6.76** | ✅ 唯一有效、零画质代价 |
| 4x 档 + 降 720p（单独 / 叠加硬解） | 3.97 / 6.82 | ❌ **降分辨率无增益** |
| 硬件编码 | nvenc 驱动不足 / qsv 慢于软编 / amf 无卡 | ❌ 不可用 |

⇒ **只做硬解**。**不做分辨率切换**（无收益）；**不做「自动最佳分辨率」**（无收益的自适应是白做工）。

#### 2.5.3 与 §2.4 边界的一致性（必须写明，否则与既有裁定冲突）

§2.4 已裁定「**不做转码参数的用户可见"画质档位"**」。本节的「推荐配置」**不违反**它，因为二者不同：

| | §2.4 禁止的 | 本节要做的 |
|---|---|---|
| 决策者 | **用户**在「1080p / 720p」这类伪档位里挑 | **系统**按机器能力自动选 |
| 用户可见性 | 常驻选择控件 | 设置页里的**后端/设备覆盖项**（默认「自动」），平时不出现 |
| 依据 | 用户的画质偏好 | 机器的**能力**（是否支持硬解、有哪些 GPU） |

⇒ 本节是 **系统自动配置**，不是用户可见画质档位。§2.4 的裁定**不变**。

#### 2.5.4 设计：能力探测 → 推荐配置 → ffmpeg 按配置执行

**三段式**（用户指令 #2 的落地形态）：

**① 能力探测（静态，不跑基准）** —— 复用既有解析链拿到 ffmpeg 后，一次性采集：

| 探测项 | 手段 | 产出 |
|---|---|---|
| 可用硬解后端 | `ffmpeg -hwaccels` | 枚举（`d3d11va` / `dxva2` / `cuda` / `qsv` / `amf` / `vaapi`…） |
| 可用硬件编码器 | `ffmpeg -encoders` | 枚举（`h264_nvenc` / `h264_qsv` / `h264_amf`…） |
| 有哪些 GPU、哪个是独显 | `nvidia-smi -L` / WMI `Win32_VideoController`（Windows） | GPU 列表 + 厂商 + 显存 |
| 探测结果缓存 | 落 `app_setting` 或 diag 内存态 | 避免每次播放都探测 |

**② 推荐配置（保守默认）**：

| 情形 | 推荐 |
|---|---|
| 有独显（NVIDIA/AMD） | 显式后端 + **显式设备**（`-hwaccel d3d11va`/`cuda` + `-hwaccel_device`），不依赖 `auto` 的选择 |
| 只有核显 | 该核显支持的后端（`d3d11va` / `qsv`） |
| 无可用硬解 | 软解（现状），并在设置页**如实显示**「未启用硬件解码」 |
| 硬件编码器可用 | **仍默认软编**（`libx264`）—— 本机实测 qsv 比软编**慢**，且质量/兼容性未验；作为**可选项**提供，不作默认 |

**③ ffmpeg 按配置执行**：转码参数构造处（`download-engine/crates/orig-tg/src/routes.rs:4004-4059`）
在 `-i` 之前插入硬解参数；**其余参数不变**（preset/crf/fps 仍由 `encode_profile` 决定）。

**★ 硬约束：必须保留软件回退。** 硬解初始化失败、或输出像素格式与滤镜链不兼容时，
**自动回落软解重试一次**，并把降级写进日志与 diag。**不得让「硬解失败」表现为「放不了」**
—— 这是 BUG-237 的「未安装降级」原则在硬解上的同一形态。

#### 2.5.5 ★ 能力边界（不许把「配置估算」说成「性能预测」）

用户问「根据配置大致估算出来吧？」——**分两半回答，不许含糊**：

- **能估算**（布尔/枚举，静态即可得）：**能不能**硬解、支持**哪些**后端、哪些 codec 可硬解、
  有**哪些** GPU、有没有硬件编码器。
- **不能估算**（需实测）：**吞吐 / 能跑几倍速**。同机同档位，不同内容实测相差 **5 倍**
  （720p H.264 = 16.6x vs 1080p HEVC = 3.5x）—— 差异来自**内容**，不来自配置。

⇒ 「推荐配置」是**保守默认 + 可回退 + 可覆盖**，**不是**「算出能跑几倍速」。
若日后要真实数字，那属于**基准**（BUG-226 的 `-t 60` 方法），不属于配置。

#### 2.5.6 多显卡的特别说明

- 多显卡机器上 `-hwaccel auto` 的**选择不由我们决定**（实测选中 `dxva2`，未必是独显）⇒
  **不能靠 `auto` 兑现「多显卡感知」**，必须显式指定后端与设备。
- **无独显时的选择**：优先 `d3d11va`（Windows 上比 `dxva2` 新）；两者都不可用再软解。
- **不做**「跨 GPU 负载均衡」—— 单条转码流是单线程解码，跨卡调度无收益且引入复杂度。

#### 2.5.7 接线设计（`run_transcode`）（2026-10-10 追加）

本节是 §2.5.4 ③「ffmpeg 按配置执行」的**落地规格**。**不改 §2.5.1–§2.5.6 任何既有结论**。

已实现的**纯逻辑核心**在 `download-engine/crates/orig-tg/src/ffmpeg_caps.rs`（`PD-T06` 前两段：
解析层「文本进、结构出」+ 探测采集层「跑命令拿文本」）。本节规定它如何接进生产转码参数构造处 ——
**接线动作本身尚未执行**，待 `download-engine/crates/orig-tg/src/routes.rs` 的在途改动
（BUG-277 / BUG-278）落地、工作区干净后再做，以免与并行会话撞车。

##### ① 插入位置：输入侧，`-i` 之前

| 项 | 规定 |
|---|---|
| 代码位置 | `download-engine/crates/orig-tg/src/routes.rs:4014` 起 `run_transcode` 的 `tokio::process::Command::new(&ffmpeg)` |
| 既有输入侧参数 | `-ss <秒>`（BUG-226 的输入侧快 seek） |
| 插入点 | `-ss` **之后**、`-hide_banner -loglevel error -i <src>` **之前** |

⇒ 输入侧顺序**固定**为：`-ss` → `-hwaccel <后端>` → `-hwaccel_device <设备>` → 全局选项 → `-i <src>`。

★ `-hwaccel` 是**输入侧**选项，**必须在 `-i` 之前**；放在 `-i` 之后即失效（判据 P1 专门守这条）。

参数由 `FfmpegConfig::input_args()` 产出（顺序已由单测固定：`-hwaccel` 先于 `-hwaccel_device`），
接线处**不得**自行拼装、也不得顺手改档位参数（见 ④）。

##### ② 两档都启用（1x 基础流与非 1x 的 FRC 变体）

**不做**「只在 1x 启用」的限制 —— 依据是 §2.5.2 的实测：**6.76x 那一档正是带 `-vf` / `-af`
倍速滤镜的 4x 档**，实测可用 ⇒ 硬解与倍速滤镜链在本机是相容的。

**已知风险（登记，不作为默认处理）**：带滤镜链时，若硬解后端返回**硬件帧**（帧驻留显存），
滤镜链需在入口显式 `hwdownload` + `format` 才能接软滤镜。本机 `-hwaccel auto` 实测**未**触发该问题
⇒ **默认不插入** `hwdownload` / `format`，不给未触发的场景白白加一次显存→内存回传。
③ 的**回落机制是它的兜底**：一旦触发，表现是转码失败 ⇒ 自动回落软解重试一次 ⇒ 用户侧仍然播得出来。

##### ③ 回落（★ 硬约束，不得简化）

| 要素 | 规定 |
|---|---|
| 触发条件 | 转码进程**退出码非 0**，**或**开播后一个有限窗口内**产出字节数 = 0**；**且**当前配置 `!is_software()` |
| 动作 | `tracing::warn!` 记一条**含后端名与原错误**的原因，用 `FfmpegConfig::fallback()`（恒等于软解）重跑一次 |
| 次数 | **只重试一次**；再失败则按现状报错 —— **不得**无限重试、**不得**静默吞掉 |
| 可观测 | 进程内**计数**（回落次数 / 后端名 / 最近一次原因），供 diag 暴露 |
| 原则同源 | §2.5.4「硬解失败自动回落软解」+ BUG-237「未安装降级」的**同一形态** —— **不得让「硬解失败」表现为「放不了」** |

##### ④ 不回退清单（接线时一点都不许动）

- `encode_profile` 的 preset / crf / fps —— 仍归它独管，硬解**不参与**档位决策；
- `-pix_fmt yuv420p` —— 保留；
- 输出仍为 **CFR 30fps H.264 + AAC**（BUG-230 stream-first 裁定）；
- BUG-223「不传 `-r`」的约束 —— 保留。

##### ⑤ 验收判据 P1–P6（每条都要能反向证验）

| 判据 | 断言 | 反向证验（装上旧行为必 FAIL） |
|---|---|---|
| **P1** | 硬解启用时 `-hwaccel <后端>` 位于 `-i` **之前** | 把 `-hwaccel` 插到 `-i` 之后 ⇒ P1 必 FAIL |
| **P2** | 硬解进程失败 ⇒ 自动以软解**重跑一次**并成功（夹具：第一次失败、第二次成功；断言最终有字节 + 日志含回落原因） | 去掉「只重试一次」的限制 ⇒ P2 的重试次数断言必 FAIL |
| **P3** | 软解路径的命令行与今日**逐字一致**（防改坏现状） | 删/加任一参数 ⇒ 必 FAIL |
| **P4** | 探测失败 ⇒ software，命令行与今日**逐字一致** | 探测失败时仍塞 `-hwaccel` ⇒ 必 FAIL |
| **P5** | 实测吞吐（条目 673，4x，`-t 60`）：硬解 ≥ 软解基线 ×1.5（本机软解实测 3.37–3.59x ⇒ 门槛约 **5.1x**；已知 **6.76x**） | 硬解未真正启用 ⇒ 落到软解数值 ⇒ 必 FAIL |
| **P6** | 强制关掉后端（env 覆盖为软解）⇒ 仍可播 | 覆盖失效、仍走硬解且硬解不可用 ⇒ 必 FAIL |

★ P1 的断言手段必须是**假 ffmpeg 夹具抓 argv**（同 `ffmpeg_caps.rs` 现有测试的做法：临时 `.cmd` / `.sh`
脚本记录 argv 后断言其顺序），**不靠肉眼**看命令行。

##### ⑥ 待定项

- 探测结果的**进程内 `OnceCell` 缓存**（`cached_config()`）**留到接线时再加**：key 用 **ffmpeg 路径**
  （路径变了要重探），**不落 `app_setting`** —— BUG-173 A3 的封闭 key 集新增 key 须登记归属表，
  为一个只读派生缓存去扩它不划算。
- 重启重探一次的成本可接受：三条命令各带超时（见 `PROBE_TIMEOUT` = 5s），最坏 15s 且只发生一次。

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
| 共享 | 强化 | ❌ 无 | **新模块 + 安全姿态变更** | D3 已定为 A（局域网 HTTP 只读，2026-10-11） |

### 3.2 三个必须先解决的张力

**张力一：文件管理 vs 媒体库 —— 是「同一件事的两个视图」，还是「两个模块」？**

- 媒体库管的是**领域模型**（条目 / 剧集 / 来源），且已裁定为独立核心模块、
  明确「不依赖 TG」（`docs/MEDIA-DESIGN.md:11-16`、`docs/design/media-service-deployment-decision-2026-09-28.md:6-8`）。
- 「文件管理」管的是**磁盘上的字节**（浏览 / 移动 / 删除 / 去重 / 占用）。
- 两者关系必须选一种，否则做出来会互相打架：
  - 若文件管理 = 媒体库的一个**视图**（只看媒体文件在磁盘上的呈现）→ 增量小，
    但你说的「其他次之」的**非视频文件没有家**；
  - 若文件管理是**纲**、媒体库是其上的领域视图 → 最贴合你的表述，
    但要重写信息架构（`Sidebar.tsx` 一级导航 + `MediaLibraryPanel.tsx`）。

→ **待拍板 D1**。

**张力二：共享 = 首次把服务暴露到局域网**

- 现状：orig-tg `download-engine/crates/orig-tg/src/config.rs:14` 默认 `bind = "127.0.0.1"`（注释明写「仅本机」）；daemon 同理。
- BUG-199 已裁定：媒体投递节流**只在非环回生效**（环回时返回 0 = 不限速）。
  一旦监听非环回，**限速 / 背压 / 并发会立刻从"不存在的问题"变成真问题**。
- 另外还缺：认证（谁能看）、绑定策略（`0.0.0.0` 还是指定网卡）、防火墙引导、TLS。
- 结论：共享不是「加个端点」，是**首次变更安全姿态**。

→ **D3 已拍板 = A（2026-10-11）**。

**张力三：上传 = 导出包的直传升级（所以它排最后不亏）**

- 现状 `docs/design/ee-export-p6-2026-09-25.md:3` 的形态是「导出本地目录供 orig-studio-ee 上传」——
  **上传发生在产品之外**，但导出产物已经可用。
- 所以「上传」不是从零发明，而是把**已存在的导出产物**直接推给 EE。
  这也意味着它延后做，用户不会「什么都没有」。

### 3.3 若确要产品级改名：波及清单

仓库里**已发生**的改名只有内核 crate：`6f2a62a refactor(download-engine): rename entire Rust kernel from surge-* to orig-*`
（`libsurge→orig-core`、`surge-daemon→orig-daemon`、`surge-net→orig-net`、`surge-protocol-*→orig-protocol-*`），
以及两处文档改名。**产品名「Orig Hub」在 `./README.md:1`、`docs/DESIGN_BRIEF.md:5` 一致，未变。**

若要做产品级改名，以下标识符会被波及（**这些比文档改名贵得多**）：

| 类别 | 现状 | 证据 |
|---|---|---|
| sidecar 名 | `orig-daemon`、`orig-tg` | `tauri-shell/src-tauri/tauri.conf.json:34`、`tauri-shell/src-tauri/src/lib.rs:16` |
| appData 目录 | `%APPDATA%\com.origadmin.orighub`（`daemon.endpoint` 真源） | 运行时实测 |
| 环境变量 | 旧名残留 `SURGE_DOWNLOAD_DIR`/`SURGE_MAX_CONNECTIONS`/`SURGE_TOKEN`；新名 `ORIG_*` 一组 | `download-engine/README.md:49,64,73` |
| localStorage 键 | `orighub_player_settings`；`orighub.compatSrcs`（已废） | `tauri-shell/src/hooks/usePlayerSettings.ts:20` |
| HTTP 头 | `x-orig-stream` | `download-engine/crates/orig-tg/src/routes.rs:3476` |

**判定：改名本身不产生用户价值，但会产生一次全量回归风险**（旧 appData 目录里的会话/凭据/缓存会"丢失"，
旧 env 失效）。除非有外部约束（品牌 / 上架），建议**只统一用户可见的产品名与文档表述，不动标识符**。

---

## 4. 计划：优先度、任务分解、里程碑

> **本节是本文的可执行部分。**
> 本文首版（2026-10-09）只有散文式优先级（P0–P4）与里程碑表 —— **没有任务、没有依赖、没有负责**。
> 产品负责人同日指出「无管理、无计划、完全脱离、不符合规范流程」，§4.2~§4.5 即为该缺口的补齐：
> **§4.2 = 任务（谁、做什么、改哪个文件、卡在谁身上）**，**§4.3 = 里程碑与任务的对应**，
> **§4.4 = 与缺陷登记册的接口**，**§4.5 = 这份计划本身怎么被维护**。
>
> 表列沿用本仓既有计划范式 `docs/design/store-db-split-design-2026-09-29.md` §7
> （`Task ID | 任务名 | 源文件 | 依赖 | 优先级`），并按「无管理」的批评补 `状态` 与 `负责` 两列。

### 4.1 排序依据（不是偏好，是依赖）

1. 「视频为主」的前提是**播放能用** → ffmpeg 缺口必须先补（P0，且它本身是缺陷）。
2. 定位对齐**零代码风险**，且决定后续每件事的排序（不先做，之后每件事都要重新争论「这算核心还是强化」）→ P1。
3. 三个新能力里，按**你的表述**排序：核心（文件管理）→ 强化（共享）→ 后期（上传）。
   只把「共享」的**拍板**提前到 P1（因为它是唯一要变更安全姿态的，前置裁定成本最高），
   但它的**实现**仍排在文件管理之后。

| 优先级 | 事项 | 为什么在这个位置 |
|---|---|---|
| **P0** | 播放引擎可见性（档 A）+ **硬件解码默认 + 多显卡 + 静态能力评估（`PD-T06`，2026-10-10 用户指令）** + 播放主线收尾（BUG-223~230 全部 `fixed`、门禁绿） | 视频为主的工具，播放不能放；且这是既有缺陷。**2026-10-10 用户把 ffmpeg 插件（含硬解默认）提为优先**，故 `PD-T06` 与档 A 同档 |
| **P1** | 定位对齐（`README.md` / `Sidebar.tsx` / 导航 / 非目标声明）+ ffmpeg 受管理组件（档 B）+ **D1/D2/D3 三个拍板** | 零代码风险，且解锁后面所有排序。**档 B 依用户 2026-10-10 指令明确为本档首位**（原已在 P1） |
| **P2** | **文件管理**（视频为主，其他次之） | 你的「核心」；形态由 D1 拍板后即可动工 |
| **P3** | **共享最小可用**（局域网 HTTP 只读） | 你的「强化」；安全裁定已在 P1 完成 |
| **P4** | **上传**（EE 直传，导出包升级） | 你自己定的「后期」；且导出包已能过渡 |

### 4.2 任务清单（5 项，按依赖排序）

| Task ID | 任务名 | 源文件 | 依赖 | 优先级 | 状态 | 负责 |
|---|---|---|---|---|---|---|
| **PD-T01** | **播放引擎可见性（档 A）**：`/api/tg/diag` 增 ffmpeg 字段（找到/路径/版本）；设置页显示「播放引擎」状态；把 501 翻译成可行动文案（改掉把用户引向「检查后台服务」的 `tauri-shell/src/i18n/locales/zh-CN.json:323`） | `download-engine/crates/orig-tg/src/routes.rs:3329-3386`（复用解析链，**不重写**）、`tauri-shell/src/components/SettingsPanel.tsx`、`tauri-shell/src/i18n/locales/zh-CN.json`、`tauri-shell/src/i18n/locales/en-US.json` | — | P0 | 未开工 | 工程师（engine+shell） |
| **PD-T02** | **定位对齐**：`README.md`/`Sidebar.tsx`/`DESIGN_BRIEF.md` 三处表述统一到「媒体为核心的文件管理工具」，并在 `DESIGN_BRIEF.md` 追加「非目标声明」节（本文 §2.4 / §3.2 的边界沉淀为常驻条文） | `./README.md:3`、`tauri-shell/src/components/Sidebar.tsx:8`、`docs/DESIGN_BRIEF.md:5` | —（与 PD-T01 无依赖，可并行） | P1 | 未开工 | PM + 架构师（纯文档，0 代码风险） |
| **PD-T03** | **ffmpeg 受管理组件（档 B）**：应用内下载 → **sha256 校验** → 落 `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`（该位置已是既有解析链第 4 位，**无需改解析链**）；版本记录 + 最低版本断言；设置面暴露开关与缓存预算（`ORIG_TG_PROXY_MAX_BYTES`） | `download-engine/crates/orig-tg/src/`（**新建**安装/校验模块）、`download-engine/crates/orig-daemon/src/routes.rs`（**新建**下载代理端点）、`tauri-shell/src/components/SettingsPanel.tsx` | **D2 拍板**（已决=A 2026-10-11；**实现前须先落定 A 的前置**：供应链 sha256 校验 / 本机代理链路 / 离线可用性） | P1 | 未开工 | 工程师（engine+shell） |
| **PD-T04** | **文件管理**（视频为主，其他次之）：通用浏览/移动/删除，形态由 D1 决定 —— A 档为纲（一级导航重排 + daemon 通用文件端点组），B 档为视图（媒体库内存储子视图 + 2~3 个端点） | **依 D1**：A → `tauri-shell/src/components/Sidebar.tsx` + `download-engine/crates/orig-daemon/src/routes.rs`（**新建**端点组）；B → `tauri-shell/src/components/MediaLibraryPanel.tsx` + `download-engine/crates/orig-tg/src/routes.rs`（**新建** 2~3 端点） | **D1 拍板**（已决=A 2026-10-11⇒按 A 档为纲；**实现前须先显式改写 `docs/MEDIA-DESIGN.md:11-16`「唯一事实源」为「文件层通用事实源 + 媒体库为其上的领域视图」**，否则两套事实）、PD-T02 | P2 | 未开工 | 工程师（engine+shell） |
| **PD-T05** | **共享最小可用**：局域网 HTTP 只读 + 认证；共享绑定与现有 `bind` **分离**；非环回投递限速（BUG-199 判据）在共享路径上复验 | `download-engine/crates/orig-tg/src/config.rs`（**新建**共享绑定，与 `:14` 的 `bind` 分离）、`download-engine/crates/orig-tg/src/routes.rs`（**新建**共享端点组 + 认证）、`tauri-shell/src/components/SettingsPanel.tsx` | ~~D3 拍板~~（已决=A 2026-10-11；**实现前须先落定 A 的 3 条前置**：认证 / 绑定策略 / 共享路径限速复验）、PD-T03 | P3 | 未开工 | 工程师（engine+shell） |

| **PD-T06** | **硬件解码默认 + 多显卡 + 静态能力评估**（2026-10-10 用户指令）：探测 `ffmpeg -hwaccels` / `-encoders` + GPU 枚举 → 生成**推荐配置**（**显式**后端与设备，不依赖 `auto`）→ 在 `-i` 之前插入硬解参数；**必须保留软件回退**；设置页可覆盖后端 / 设备。**不跑基准、不做分辨率切换、不做「自动最佳分辨率」** | `download-engine/crates/orig-tg/src/routes.rs:4004-4059`（硬解参数插入点）、`download-engine/crates/orig-tg/src/`（**新建**能力探测模块）、`tauri-shell/src/components/SettingsPanel.tsx` | —（与 `PD-T01` 无依赖，可并行；`PD-T03` 的安装能力可复用） | **P0** | 未开工 | 工程师（engine+shell） |

> **任务数 = 6** —— `store-db-split-design-2026-09-29.md` §7 的 **5 行上限被 2026-10-10 用户指令突破**：
> `PD-T06` 是用户**直接指令**的 P0 项，不得因版面限制而删。下次合并 / 重估任务时优先复核本表长度。
> **P4（上传）刻意不在此表** —— 它的前置是 **EE 侧接口**（`docs/design/ee-export-p6-2026-09-25.md`），
> 接口未定前拆解出来的任务必返工。接口定稿后在本表新增 `PD-T06`，并同步 §4.3 的 M4 行。
>
> **依赖图**（`A → B` 读作「A 完成后才能开工 B」）：
>
> ```mermaid
> graph LR
>     D1[D1 已决=A 文件管理形态] --> PD-T04
>     D2[D2 已决=A ffmpeg 获取] --> PD-T03
>     D3[D3 已决=A 共享形态] --> PD-T05
>     PD-T02[PD-T02 定位对齐] --> PD-T04
>     PD-T03[PD-T03 ffmpeg 受管理组件] --> PD-T05
>     PD-T01[PD-T01 播放引擎可见性 P0] --> PD-T05
>     PD-T06[PD-T06 硬解默认 + 配置推荐 P0]
> ```
>
> **可并行**：PD-T01 与 PD-T02 无依赖，可同时开工。D1/D2/D3 已全部裁定（均为 A），
> `PD-T03`/`PD-T04`/`PD-T05` 的拍板阻塞均已解除；各自落地前先落定对应裁定解读里的**强制前置**
> （PD-T03：sha256/代理/离线；PD-T04：改写 MEDIA-DESIGN 唯一事实源；PD-T05：认证/绑定/限速复验）。

### 4.3 里程碑（与任务的对应）

| 里程碑 | 对应任务 | 内容 | 完成判据（可证伪） |
|---|---|---|---|
| **M0 收尾** | `PD-T01`、`PD-T06` | 播放主线冻结 + ffmpeg 可诊断 + **硬件解码默认启用** | ① `docs/bugs/` 中 BUG-223~230 状态与代码一致、`check-bugs.py` 绿；② 断开 ffmpeg（临时改 env 指向不存在路径）后，设置页明确显示「未安装」，播放失败文案指向安装而不是「检查后台服务」；③ **冷缓存 4x 播放的转码吞吐 ≥ 基线 × 1.5**（条目 673 实测 3.5x → 6.76x），且**强制关掉硬解后端时自动回落软解仍可播**（回退判据） |
| **M1 定位与引擎** | `PD-T02`、`PD-T03` | 定位对齐 + ffmpeg 受管理组件 + 三个拍板落定 | ① `README.md`/`Sidebar.tsx` 表述与裁定一致；② 一台**没装过 ffmpeg** 的机器上，从零到能播放不需要命令行操作；③ 三个 D 项在 `docs/review/` 标为已决并写明裁定 |
| **M2 文件管理** | `PD-T04` | 通用文件浏览/移动/删除 + 视频优先视图 | ① 非媒体文件（如 `.pdf`/`.zip`）可浏览、可移动、可删除；② 视频仍走既有媒体库视图，**两处不出现同一文件的两套事实** |
| **M3 共享** | `PD-T05` | 局域网 HTTP 只读共享 | ① 同网段另一台设备能播放；② 非环回时投递限速**确实生效**（BUG-199 的判据在共享路径上复验）；③ 未授权设备拿不到内容 |
| **M4 上传** | （未拆解，待 EE 接口定稿后新增 `PD-T06`） | EE 直传 | ① 导出包可直接推送到 EE，无需手工搬运；② 失败可重试且不重复上传 |

### 4.4 与缺陷登记册的接口（本文**不**吞缺陷）

本文 §1.3 的「媒体库」一栏只写了「已成型」，**没有写它的性能缺陷** —— 那会让本文变成一张与
`docs/bugs/` 脱节的表。为避免「完全脱离」，此处显式登记**本文成稿后同日新发现的 3 条缺陷**
及其与本计划的关系：

| 缺陷 | 归属域 | 与本计划的关系 |
|---|---|---|
| `docs/bugs/BUG-239.md` 媒体库请求成倍放大 | `shell` | **不进本任务表**（缺陷走缺陷流程）。但它直接影响 M0「播放主线冻结」的体验基线 —— 若 P0 期间用户报「媒体库卡」，应先按 BUG-239 处置，再回本计划 |
| `docs/bugs/BUG-240.md` 媒体库「大量重复数据」实为不可辨识条目 | `engine+shell` | 同上。与 PD-T04（文件管理）**不同域**：BUG-240 治的是「卡片不可辨识」，PD-T04 治的是「文件没有家」，**不得混为一次改动** |
| `docs/bugs/BUG-241.md` TG 面板挂载即请求爆炸 | `shell` | 同上。它是 `tg` 域的结构性缺陷（内容量 × 每项 N+1），**不由 D1/D2/D3 任一条裁定解除** |

> **边界声明**：本计划（PD-T01~PD-T05）**只含产品方向与依赖组件化**，不含缺陷修复。
> 缺陷一律在 `docs/bugs/` 登记、按 `docs/rules/bug-registry.md` 走状态机。
> 两边的**唯一接口**是本节的这张表 + §4.5 的维护约定 —— **不允许把缺陷塞进 PD-Txx**（那会让任务表变成第二本缺陷册）。

### 4.5 这份计划本身的维护约定

1. **每完成一个 `PD-Txx`** ⇒ ① 回填 §4.2 该行 `状态`；② 若该任务由设计文档驱动，在对应 `docs/design/*` 的 front-matter 填 `landed-in`（commit 短 hash 或 `file:line`）；③ 同步 `docs/README.md` §3.6 的「落地证据」列。
2. **front-matter 状态迁移**（依 `docs/rules/doc-first.md` §2.3）：
   `draft`（现在）→ `decided`（**D1/D2/D3 三条全部裁定**后，由主理人回填 `decided-by`/`decided-at`）
   → `implemented`（`PD-T01`~`PD-T05` 全部落地并填 `landed-in`）。
3. **新增/删除任务**必须同步三处：§4.2 任务表、§4.3 里程碑「对应任务」列、§4.4 缺陷接口表（若涉及）。
4. **不新建第二份计划文档**。本文是**唯一**的产品级计划载体；后续修订一律在文末 `## 变更记录` 追加，**不改写既有结论**（BUG-082 惯例 + `doc-first.md` §2.4）。

---

## 5. 待拍板

三条，见 `docs/review/product-direction-decisions-2026-10-09.md`：

- **D1** 文件管理与媒体库的关系（纲 / 视图 / 维持现状）
- **D2** ffmpeg 的获取策略（应用内自动安装 / 检测+一键指路 / 仅补文案）
- **D3** 共享的第一形态（局域网 HTTP 只读 / FTP / 不做）

依赖顺序：**D2 与 D1/D3 无依赖，可同时拍**；D1 拍完才能开工 P2，D3 拍完才能开工 P3。
**三条全部裁定前**，本文件 front-matter 保持 `status: draft`、`decided-by: —` —— 新会话读到它不得当既成事实执行。

---

## 6. 关联

- `docs/bugs/BUG-230.md`（播放主路径 stream-first 翻转 —— 本文结论 #1 的前提）
- `docs/bugs/BUG-208.md`（ffmpeg 本机手工安装的唯一记录）
- `docs/bugs/BUG-239.md` / `BUG-240.md` / `BUG-241.md`（本文成稿后同日登记的 3 条缺陷 —— 与本文的接口见 §4.4）
- `docs/MEDIA-DESIGN.md`（M1/M2/M3 模块边界，既有地基）
- `docs/design/media-service-deployment-decision-2026-09-28.md`（媒体库独立核心模块裁定）
- `docs/design/ee-export-p6-2026-09-25.md`（EE 导出包形态 —— 上传的前身）
- `docs/design/store-db-split-design-2026-09-29.md` §7（本文 §4.2 任务表的**列格式来源**）
- `docs/rules/doc-first.md`（本文 front-matter 与状态机的规范来源）
- `docs/review/product-direction-decisions-2026-10-09.md`（本文三条待拍板的强制格式版）
- `docs/README.md` §3.6（本文在文档地图中的登记位）

---

## 变更记录

> 依 `docs/rules/doc-first.md` §2.4：**只追加，不改写既有结论**。旧结论若被推翻，在此写明「当年立足点对，变的是前提」。

| 日期 | 谁 | 改了哪节的结论 | 为什么 |
|---|---|---|---|
| 2026-10-09 | 高见远（架构师） | **建立本文**：§0 结论摘要、§1 事实底座、§2 ffmpeg 三档方案（推荐 A+B、不做 C）、§3 主体调整评估（含 D1/D3 两个张力）、§4 优先度 P0–P4 + 里程碑 M0–M4、§5 三条待拍板 | 产品负责人提出两项：ffmpeg 作为默认播放组件的安装/设置/服务方案；工具主体是否调整为「以媒体为核心的下载/上传/共享/管理工具」 |
| 2026-10-09 | 高见远（架构师） | **规范化改造**（不改 §0–§3 与 §5–§6 的任何结论）：① 补全 front-matter 全部字段（原只有 `status: draft` 一行，不合 `doc-first.md` §2.1）；② §4 由「散文式 P0–P4 + 里程碑」改为**可执行计划** —— 新增 §4.2 任务表（`PD-T01`~`PD-T05`，列 `Task ID \| 任务名 \| 源文件 \| 依赖 \| 优先级 \| 状态 \| 负责`）、§4.3 里程碑加「对应任务」列、§4.4 与缺陷登记册的接口、§4.5 计划维护约定；③ 新增本节 | 产品负责人指出本文「无管理、无计划、完全脱离、不符合规范流程」 |
| 2026-10-09 | 高见远（架构师） | **引用重新锚定 + 路径补全**（不改任何结论文字）：① **30 处裸文件名**（`routes.rs:…` 等 —— 仓内有 `orig-daemon` 与 `orig-tg` **两个** `routes.rs`，裸名不可判定）补全为仓库根起算的完整路径；② `download-engine/crates/orig-tg/src/routes.rs` **16 处 +43**（`3281-3287` / `3293-3306` / `3329-3386` / `3330` / `3362-3384` / `3366-3368` / `3413-3602` / `3439-3441` / `3476` / `3481-3486` / `3484` / `3648` / `3655-3710` / `3675-3677` / `3861` / `3974`），`transcode_pump` 括注 `3571-3805` → `3614-3848`；③ `download-engine/crates/orig-daemon/src/routes.rs:884-897` → `:925-931`；④ `download-engine/crates/orig-tg/src/store.rs:724` → `:750-761`；⑤ `tauri-shell/src/i18n/locales/zh-CN.json:316` → `:323`、`docs/design/media-service-deployment-decision-2026-09-28.md:5-6` → `:6-8`；⑥ §1 增「引用锚定说明」 | 独立核验发现：原引用**对 HEAD 是正确的**，但对**当前工作区**已漂移 —— 漂移量恰等于并行会话三个文件的未提交增量（`+52/-9`、`+44/-0`、`+31/-0`），即漂移由在途改动造成，非原引用写错 |
| 2026-10-10 | fix-ffmpeg-hw（依 team-lead 裁定） | **新增 §2.5.7「接线设计（`run_transcode`）」**：① 插入位置（`-ss` 之后、`-i` 之前的输入侧）；② **两档都启用**（含带 `-vf`/`-af` 的 FRC 变体）+ 硬件帧/`hwdownload` 已知风险登记；③ 回落硬约束（失败或零字节 ⇒ `fallback()` 重跑**一次** + warn 日志 + 进程内计数供 diag，再失败按现状报错）；④ 不回退清单（preset/crf/fps、`-pix_fmt yuv420p`、CFR 30fps H.264+AAC、BUG-223 不传 `-r`）；⑤ 验收判据 **P1–P6** 及各自反向证验；⑥ 待定项（`cached_config()` 进程内 `OnceCell`，key 用 ffmpeg 路径，不落 `app_setting`）。**只追加** —— 不改 §2.5.1–§2.5.6 与 §0–§4 任何既有结论 | 落实 §2.5.4 ③「ffmpeg 按配置执行」的落地规格：`ffmpeg_caps.rs` 的解析层与探测采集层已就绪（纯逻辑、未接线），需先固定接线的**位置、范围、回落与验收判据**；接线动作待 `download-engine/crates/orig-tg/src/routes.rs` 在途改动（BUG-277 / BUG-278）落地、工作区干净后执行，避免与并行会话撞车 |
| 2026-10-10 | team-lead（依产品负责人指令） | **新增 §2.5「硬件解码与配置推荐」**；§4.1 的 P0 纳入 `PD-T06`、P1 明确 ffmpeg 档 B 为本档首位；§4.2 新增 `PD-T06`（任务数 5 → 6）；§4.3 的 M0 纳入 `PD-T06` 与「硬解提速 + 软解回退」两条判据；§4.2 依赖图加 `PD-T06`。**不改 §0–§3 既有结论、不改 §2.4 边界**（§2.5.3 专门论证「系统自动选配置 ≠ 用户可见画质档位」） | 产品负责人 2026-10-10 三条指令：① 先加 ffmpeg 插件设置、**硬解作为默认配置启用**、**当前为多显卡**；② **性能可按配置静态估算、不需要实际去跑**，按性能推荐配置、ffmpeg 按配置执行；③ **ffmpeg 插件这块需要提升优先级** |
