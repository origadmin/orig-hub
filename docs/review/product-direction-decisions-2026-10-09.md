# 待拍板决策清单（产品方向 · 2026-10-09）

> **格式真源**：`docs/rules/decision-spec.md`。机器门禁 `scripts/check-decisions.py`。
> **背景文档**：`docs/design/product-direction-and-ffmpeg-2026-10-09.md`（评估、优先度、里程碑）。
>
> **读法**：每条是「A / B / 不做」三选一，各带 `涉及 / 量化 / 回归风险 / 后果`。
> **你只需判断取舍，不需要补充信息。**

---

## 一、待拍板（3 项）

### D1. 文件管理与媒体库：谁为纲？

- **问题**: 「文件管理」是独立于媒体库的通用模块（文件为纲），还是媒体库的一个磁盘视图（媒体为纲）？
- **现状与代价**: 现状**没有任何通用文件管理能力** —— 所有「文件」操作都被媒体域包裹
  （`download-engine/crates/orig-tg/src/routes.rs:168` 的 `/api/media/scan`、`:88-89` 导入、
  `:132-135` 剧集内移动）。而媒体库已被裁定为**独立核心模块、不依赖 TG**
  （`docs/MEDIA-DESIGN.md:11-16`、`docs/design/media-service-deployment-decision-2026-09-28.md:5-6`）。
  产品负责人的表述是「核心在文件管理（视频为主，其他次之）」——**「其他次之」在当前架构里没有家**。
  不定 → 无法开工 P2；先做后定则很可能做出与媒体库**两套事实**（同一文件在两个模块里各有状态）。
- **设计锚点**: `docs/design/product-direction-and-ffmpeg-2026-10-09.md` §3.2「张力一」
  - 冲突: `docs/MEDIA-DESIGN.md:11-16` 把 M3 媒体库定为「唯一事实源」；
    若文件管理另立事实源，与该条冲突，须先显式改写该条。
- **请求**: 选 A 还是 B？

**A. 文件管理为纲：通用文件模块为主，媒体库成为其上的领域视图**

- 涉及: `tauri-shell/src/components/Sidebar.tsx`（一级导航重排）、
  `tauri-shell/src/components/MediaLibraryPanel.tsx`、
  `tauri-shell/src/components/media/`（视图挂载点）、
  `download-engine/crates/orig-daemon/src/routes.rs`（**将新建**通用文件端点）
- 量化: 新增 1 组通用文件端点（浏览/移动/删除，估 4~6 个）+ 1 个一级导航位；
  重排 `Sidebar.tsx` 现有三档下载导航；影响 2 个既有面板
- 回归风险: 高 —— 触碰已验收的剧集内页信息架构（`docs/design/media-episode-image-handover-2026-09-28.md`
  是当前形态真源）与「媒体库唯一事实源」裁定
- 后果: 最贴合你的表述，「其他次之」的文件有家；但需要一次信息架构重写，
  且必须同步改写 `docs/MEDIA-DESIGN.md:11-16` 的「唯一事实源」条款。**部分可逆**（导航可回退，数据模型改动不可逆）

**B. 媒体库为纲：文件管理只作为「媒体落盘目录的运维视图」**

- 涉及: `tauri-shell/src/components/MediaLibraryPanel.tsx`（**将新建**存储/文件子视图）、
  `download-engine/crates/orig-tg/src/store.rs`（复用既有 `proxy_dir`/落盘目录）、
  `download-engine/crates/orig-tg/src/routes.rs`（**将新建** 2~3 个文件操作端点）
- 量化: 1 个新子视图 + 2~3 个端点；**不新增事实源**
- 回归风险: 低 —— 不碰导航结构、不碰「唯一事实源」裁定
- 后果: 增量最小、最快可用；但「其他次之」的非视频文件仍然没有家，
  与你的表述只对上一半。**可逆**

**C. 不做（维持现状）**

- 涉及: 无
- 量化: 0
- 回归风险: 无新增（但既有问题保留）
- 后果: 「文件管理」这项核心定位长期只有媒体域，用户想整理非视频文件只能出到资源管理器；
  一旦真出现这类需求，仍要付一次上面 A 或 B 的成本

---

### D2. ffmpeg 的获取策略：应用内自动安装，还是检测后指路？

- **问题**: ffmpeg 缺失时，是产品自己下载安装，还是检测到并引导用户安装？
- **现状与代价**: BUG-230 把播放翻转为 stream-first 后，**ffmpeg 是唯一播放路径**，
  但产品里没有安装、没有版本管理、没有一个设置项（`docs/design/product-direction-and-ffmpeg-2026-10-09.md` §1.1）。
  缺失时 orig-tg 回 501（`download-engine/crates/orig-tg/src/routes.rs:3438-3443`），
  前端停载遮罩，文案却让用户「确认后台服务正在运行」（`tauri-shell/src/i18n/locales/zh-CN.json:316`）——**指错方向**。
  不定 → 每台新机器第一次播放都失败，且用户无从下手。
- **设计锚点**: `docs/design/product-direction-and-ffmpeg-2026-10-09.md` §2.2 / §2.3
- **请求**: 选 A 还是 B？

**A. 应用内自动安装 / 更新（受管理组件）**

- 涉及: `download-engine/crates/orig-tg/src/`（**将新建**安装与校验模块）、
  `download-engine/crates/orig-daemon/src/routes.rs`（**将新建**下载代理端点）、
  `tauri-shell/src/components/SettingsPanel.tsx`、
  `tauri-shell/src/i18n/locales/zh-CN.json`
- 量化: 首次下载约 80–120 MB；新增 3~4 个端点 + 1 个版本常量；
  落点复用既有解析链第 4 位（`download-engine/crates/orig-tg/src/routes.rs:3323-3325`），**无需改解析链**
- 回归风险: 中 —— 引入供应链信任（镜像可信度与 sha256 校验）、
  代理链路（本机是 SOCKS5 `127.0.0.1:7897` 场景，见 `download-engine/crates/orig-tg/src/config.rs:30-32`）、
  离线可用性；受影响既有能力 = 设置页与启动流程
- 后果: 用户零操作即可播放，「默认播放组件」名副其实；但产品从此背上**分发与信任责任**
  （下载源失效/被投毒都会变成产品事故）。**可逆**（可退回 B）

**B. 检测 + 一键指路（不自带下载）**

- 涉及: `download-engine/crates/orig-tg/src/routes.rs`（复用 `:3286-3343` 解析链，加 diag 字段）、
  `tauri-shell/src/components/SettingsPanel.tsx`、
  `tauri-shell/src/i18n/locales/zh-CN.json`、`tauri-shell/src/i18n/locales/en-US.json`
- 量化: 1 个 diag 字段 + 1 个设置区块 + 2~3 处文案；**0 下载、0 新端点**
- 回归风险: 低 —— 只加只读状态与文案，不碰转码链路
- 后果: 用户知道「缺什么、装哪、放哪」，也能指定已有 ffmpeg 路径（`ORIG_FFMPEG_PATH`）；
  但**仍需自己装一次**，对非技术用户是硬门槛。**完全可逆**

**C. 不做（维持现状：只改文案）**

- 涉及: 无
- 量化: 0
- 回归风险: 无新增（但既有问题保留）
- 后果: 播放主路径继续依赖一个用户看不见、装不了、查不到的组件；
  用户遇到「什么都放不了」时，文案仍可能把他引向「检查后台服务」。
  一旦这类反馈出现，会被迫回头做 A 或 B

---

### D3. 共享的第一形态：局域网 HTTP 只读，还是 FTP？

- **问题**: 共享先做局域网 HTTP 只读，还是先做 FTP/SFTP，还是不做？
- **现状与代价**: 共享**零实现**。orig-tg 默认 `bind = "127.0.0.1"`（注释明写「仅本机」，
  `download-engine/crates/orig-tg/src/config.rs:14`），daemon 同理；且已裁定
  **媒体投递节流只在非环回生效**（BUG-199，环回返回 0 = 不限速）。
  也就是说：一旦监听非环回，**限速 / 背压 / 并发会立刻从「不存在的问题」变成真问题**，
  还缺认证、绑定策略、防火墙引导、TLS。
  不定 → P3 无法开工；先做后定则可能先上线一个**无认证的局域网服务**，是安全事故而非功能。
- **设计锚点**: `docs/design/product-direction-and-ffmpeg-2026-10-09.md` §3.2「张力二」
- **请求**: 选 A 还是 B？

**A. 局域网 HTTP 只读共享（本机起服务，链接/扫码观看）**

- 涉及: `download-engine/crates/orig-tg/src/config.rs`（**将新建**共享绑定配置，与现有 `bind` 分离）、
  `download-engine/crates/orig-tg/src/routes.rs`（**将新建**共享端点组 + 认证）、
  `tauri-shell/src/components/SettingsPanel.tsx`（开关与二维码）
- 量化: 1 个新监听配置 + 1 组共享端点 + 1 个设置区块；**首次出现非环回监听**
- 回归风险: 高 —— 首次变更安全姿态；受影响既有能力 = 投递节流（BUG-199 的判据必须在共享路径上复验）、
  端口选择（BUG-178/227/228 的端口漂移史）
- 后果: 手机/电视可直接看电脑上的片子，与「媒体为核心」最契合；
  但必须先完成认证与绑定策略裁定，否则等于把媒体库暴露到局域网。**可逆**（关掉开关即可）

**B. FTP / SFTP 服务**

- 涉及: `download-engine/crates/orig-tg/src/`（**将新建** FTP 服务端或引入 crate）、
  `tauri-shell/src/components/SettingsPanel.tsx`
- 量化: 比 A 更大 —— 需引入 FTP 服务端依赖并处理被动端口范围（防火墙规则数量级更多）
- 回归风险: 中 —— 不碰既有 HTTP 投递链路，但引入新的长驻监听与依赖
- 后果: 通用性最强（任何文件管理器都能挂载），但观看体验差（无流式 seek 适配）、
  与「看视频」这个主目标不匹配；且 FTP 明文传输，仍需单独处理安全。**可逆**

**C. 不做（维持现状）**

- 涉及: 无
- 量化: 0
- 回归风险: 无新增（但既有问题保留）
- 后果: 你的「强化功能」之一长期缺位，跨设备观看只能靠手工拷文件；
  若用户实际提出跨设备观看诉求，会被迫回头做，届时仍要先付一次安全裁定成本

---

## 二、依赖顺序

- **D2 与 D1、D3 无依赖**，可同时拍板。
- **D1 拍完**才能开工 P2（文件管理）。
- **D3 拍完**才能开工 P3（共享）。
- 三条都不阻塞 P0（播放引擎可见性）与 P1 的定位对齐。

---

## 三、已决（存档）

（无 —— 本清单首次建立。）
