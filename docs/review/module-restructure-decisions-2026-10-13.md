# 模块重整决策清单（2026-10-13，待签字）

- 状态：**待决策人签字**。签字后回填「已选：X + 日期」，并作为 `docs/design/module-restructure-2026-10-13/` 规划包执行依据。
- 上游已拍板决策（2026-10-11，本清单不重议）：文件管理为纲（D1=A）、ffmpeg 应用内受管安装（D2=A）、局域网 HTTP 只读共享 + 认证（D3=A），见 `docs/review/product-direction-decisions-2026-10-09.md`。
- 背景设计：`docs/design/module-restructure-2026-10-13/spec.md`。

---

### D1. 一级导航是否改为五个功能域（下载/文件/TG 采集/共享/设置）？

- **问题**: 一级导航按「功能域」组织还是继续让「下载状态档」与功能模块平级？
- **现状与代价**: 现状 `tauri-shell/src/components/Sidebar.tsx` 的 ViewId 为 `all/downloading/paused/completed/media/tg/settings`——7 个一级入口里 4 个是同一任务集合的筛选档；产品已定为「以媒体/文件管理为核心」，导航里却没有「文件」的位置；「共享」已拍板要做，继续平铺只会更乱。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/spec.md`（§3.1 五域 IA）、`docs/design/module-restructure-2026-10-13/01-frontend-architecture.md`（目录与组件处置）、`docs/design/module-restructure-2026-10-13/05-ui-wireframes.md`（线框）
- **请求**: 选 A、B 还是 C（不做）？

**A. 五域导航：下载/文件/TG 采集/共享/设置，状态档内嵌下载模块（推荐）**

- 涉及: `tauri-shell/src/components/Sidebar.tsx`、`tauri-shell/src/components/MainLayout.tsx`、新建 `tauri-shell/src/nav/index.ts` 与 `tauri-shell/src/domains/{download,files,tg,share,settings}/`；M0 任务全量见 `docs/design/module-restructure-2026-10-13/tasks.md`
- 量化: ViewId 7→5；新增 2 个面板外壳（Files/Share）+ 5 个域目录；移动约 10 个组件；零后端/零 API/零 DB 变更
- 回归风险: 低——M0 只搬运与薄包裹，明令禁止改数据流；主要风险是导入路径与 i18n 漏网，由 UI verify 逐域截图拦截
- 后果: 导航与产品定位一致；后续 M2「文件夹」视图、M5 共享都有现成位置；跨模块跳转统一为 navigate 契约

**B. 状态档内嵌，但保留「媒体库」命名、不引入「文件」域**

- 涉及: `tauri-shell/src/components/Sidebar.tsx`、`tauri-shell/src/components/MainLayout.tsx`、`tauri-shell/src/components/MediaLibraryPanel.tsx`
- 量化: ViewId 7→4；同样要移动下载 4 组件；无 files 域目录
- 回归风险: 中——M2 必须给「文件层为通用事实源（含非媒体文件）」第二次起名字，导航/i18n/用户认知改两次
- 后果: 短期 diff 略小；顶层语义与已拍板的文件管理为纲冲突，文件夹视图上线时仍要二次改名

**C. 不做，维持现状（七项一级导航拍平）**

- 涉及: 无（本期不改任何仓内文件）
- 量化: 0 处代码变更；状态档继续占 4/7 个一级入口
- 回归风险: 零
- 后果: 模块混乱反馈原样保留；共享上线后一级入口 8 项且状态与模块继续混级；本次重整规划包整体作废

---

### D2. 媒体库是否拆出 library.db 并迁入 orig-daemon（给 2026-09-28 推荐路径补拍板）？

- **问题**: 代码层已零 TG 依赖的媒体库（media.rs 6576 行、9 张 media_* 表、整个 /api/media/*）物理上寄宿在需 TG 凭证才启动的 orig-tg 进程里，部署形态选哪条？
- **现状与代价**: 不用 TG 的用户媒体库永远不可用（`docs/bugs/BUG-172.md` open/critical）；自愈拉错服务（probe 9877 / ensure 9876）；媒体/ TG 14+ 表同住 store.db，代码注释自注临时安排。不定 → BUG-172 无法关闭，文件事实层与 ffmpeg/共享的服务归属全部悬置。
- **设计锚点**: `docs/design/media-service-deployment-decision-2026-09-28.md`（推荐 D2-A→D1-B，本文档是补拍板）、`docs/design/module-restructure-2026-10-13/02-backend-architecture.md`、`docs/design/module-restructure-2026-10-13/03-data-model-and-migration.md`、`docs/MEDIA-DESIGN.md`
- **请求**: 选 A、B、C 还是 D（不做）？

**A. 拆库（library.db）+ 媒体迁入 orig-daemon（推荐）**

- 涉及: 新建 `download-engine/crates/orig-file-serve/`；迁移 `download-engine/crates/orig-tg/src/media.rs` 与 `/api/media/*` 路由、transcode_pump、`ffmpeg_caps.rs` 至 `download-engine/crates/orig-daemon/src/modules/`；`store.rs` 拆分；`tauri-shell/src/api/media.ts` base 一行改向；`scripts/sync-sidecars.sh`
- 量化: 迁移约 8-10k 行、9 表 + 触发器；新增 0 个 sidecar/二进制；跨进程写只剩 1 个环回 ingest 端点；前端改向 1 行
- 回归风险: 高但可验——投递契约有 `download-engine/verify/` 与 probe_media.py、迁移有旧库夹具单测、sidecar 有一致性脚本；最大风险点是迁库校验与停机窗口，以复制式迁移 + 校验失败自动回滚覆盖
- 后果: 媒体随应用必然可用，BUG-172 关闭；文件层/ffmpeg/共享全部落在无凭证核心面；两域物理隔离，单写者清晰

**B. 不拆库，共库 + 单写者裁定（daemon 独占库，orig-tg 经 HTTP 访问）**

- 涉及: `download-engine/crates/orig-daemon/src/state.rs`、`download-engine/crates/orig-tg/src/routes.rs`（TG 侧库读写全部改 HTTP 客户端）
- 量化: 0 次数据迁移；新增 1 组跨进程库访问端点（TG 5 表读写代理面）
- 回归风险: 高——所有 TG 本地读写变成网络往返，cache_task 队列/墙钟表延迟敏感；daemon 故障即 TG 读写全挂，插件面反向寄生核心面
- 后果: 免迁移但制造长期跨进程耦合；与「TG 是可替换通道」方向相反

**C. 新建独立 orig-media sidecar，媒体迁入第三个进程**

- 涉及: 新建 `download-engine/crates/orig-media/`；`tauri-shell/src-tauri/src/lib.rs` 新增 spawn；`scripts/sync-sidecars.sh` 清单 +1；仍须先做 A 的拆库
- 量化: 第 4 个 sidecar、约 7-12 MiB 额外磁盘；跨进程重建 serve_local_file 共用契约
- 回归风险: 高——AGENTS.md §D5 要求 raw 与 tg/local 共用同一投递实现，拆三进程后变成跨进程问题；多一个进程的拉起/自愈/版本同步
- 后果: 得到架构上「可插拔」的纯洁性，但付体积与契约重建成本；09-28 文档建议作为 B 之后的演进而非第一步

**D. 不做，维持现状（媒体继续寄宿 orig-tg）**

- 涉及: 无（本决策不触发任何仓内改动）
- 量化: 0 处变更；非 TG 用户媒体库仍 0 可用性
- 回归风险: 零
- 后果: BUG-172 不闭环；M2 文件层在 M3 前只能部分可用；M5 共享依赖 orig-tg 在跑，与「核心能力随 daemon 必可用」矛盾；09-28 决策继续悬挂

---

### D3. ffmpeg「可设置」（持久化路径/硬解覆盖 + 进程内即时生效）放在哪一期？

- **问题**: 现状硬解自动探测已接线（`routes.rs` 的 FFMPEG_CONFIG OnceCell），但用户覆盖只有环境变量 ORIG_TG_HWACCEL，设置无 UI、无持久化、启动后不可改。可设置能力提前到 M1 还是等 M4 受管安装一起？
- **现状与代价**: 硬解兼容问题（HEVC 卡顿/花屏）用户无法在应用内自救，只能改环境变量重启；设置·播放引擎区块若 M1 只读，用户看到诊断结果却无操作可做。
- **设计锚点**: `docs/design/product-direction-and-ffmpeg-2026-10-09.md`（PD-T01 可诊断、PD-T06 硬解默认）、`docs/design/engine-lock-thread-ffmpeg-2026-10-13.md`（ELT-T05/06 可设置缺失）、`docs/design/module-restructure-2026-10-13/04-api-contracts.md`（§1 契约）
- **请求**: 选 A、B 还是 C（不做）？

**A. M1 即做：诊断端点 + 持久化配置 + 转码泵即时生效（推荐）**

- 涉及: `download-engine/crates/orig-tg/src/routes.rs`（新增 /api/ffmpeg/status、/config；OnceCell 改读有效配置）、`download-engine/crates/orig-tg/src/store.rs`（ffmpeg.* 键）、`tauri-shell/src/components/SettingsPanel.tsx`（播放引擎区块）
- 量化: 2 个新端点 + 3 个 setting 键 + 1 个设置区块；新增 4 态命令行单测（auto/soft/manual/device）；ELT-T05/06 同期关闭
- 回归风险: 低-中——转码命令行有单测逐字断言；env 最高优先保持旧行为；探测仍缓存，仅选择改即时读取
- 后果: M1 交付后用户可在应用内切硬解/指定显卡/手动指定路径；M4 只补安装器，范围更纯

**B. M1 只做只读诊断，可设置随 M4 受管安装一起交付**

- 涉及: `download-engine/crates/orig-tg/src/routes.rs`（仅新增只读 status 端点）、`tauri-shell/src/components/SettingsPanel.tsx`（只读区块）
- 量化: 1 个新端点；设置控件推迟到 M4（跨 M2/M3 两期）
- 回归风险: 低
- 后果: 播放引擎区块一期纯展示；硬解问题用户继续依赖环境变量；M4 同时装「安装器 + 可设置」两块，回归面更大

**C. 不做，维持现状（仅 env 覆盖）**

- 涉及: 无（不改仓内文件，不新增端点与 UI）
- 量化: 0 处变更；用户覆盖手段保持 1 个环境变量
- 回归风险: 零
- 后果: PD-T01 可诊断继续欠账；501 与硬解问题无可行动出口；ELT-T05/06 不关闭

---

### D4. ffmpeg 二进制分发与集成方式怎么定？

- **问题**: 用户已裁定「使用编译二进制、只用接口、使用服务」。落地时二进制从哪来、以什么形态被调用，需要一次定死，避免 M4 实施期反复。
- **现状与代价**: 现状外部子进程路线已在转码泵验证可行，但二进制靠用户自行安装/PATH 碰运气，501 高发；能力探测与配置散在 routes.rs/OnceCell；不钉版本与哈希则受管安装没有供应链基线。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/06-ffmpeg-integration-analysis.md`（§3 分发对比、§4 调用模型）、`docs/design/product-direction-and-ffmpeg-2026-10-09.md`（PD-T03/D2=A）
- **请求**: 分发选 A/B/C，调用形态是否批准「按需子进程 + 宿主 ffmpeg 服务模块（不做常驻 ffmpeg 进程）」随 A 一并确认？

**A. 官方静态构建受管下载（gyan/BtbN，版本+sha256 钉死，在线/手动/离线三路径）+ 按需子进程，daemon 内 ffmpeg 服务模块统一接口（推荐）**

- 涉及: `download-engine/crates/orig-daemon/src/modules/ffmpeg/{service,cli,caps,installer}.rs`（M3/M4 新增）、`download-engine/crates/orig-tg/src/ffmpeg_caps.rs` 与转码 spawn 点迁移、`tauri-shell/src/components/SettingsPanel.tsx` 播放引擎区块；安装落 `%LOCALAPPDATA%\OrigHub\bin\ffmpeg.exe`
- 量化: 官方包已含全部主流硬解（NVDEC/NVENC/QSV/AMF/D3D11VA），运行时只需显卡驱动；0 个原生编译链；安装器 4 个阶段端点 + SSE；进程冷启动仅一次/会话（百毫秒级，与现状持平）
- 回归风险: 中——供应链（清单信任根/代理/离线）是主要新增面，以钉版本+哈希+原子替换+失败留旧版覆盖；许可证为 GPLv3 进程调用，About 页声明来源，合规路径成熟
- 后果: M4 可闭环；能力与官方主线同步；「不常驻」避免再多一个需要看护的进程（BUG-172 同类风险）

**B. 自建编译链产出定制二进制（CI 自编译，裁剪/定制硬解）**

- 涉及: 新增 CI 工具链（msys2/mxe 构建环境）、构建脚本与源码补丁仓、`scripts/sync-sidecars.sh` 分发改造
- 量化: 需长期维护一套 Windows 交叉/原生构建链；相对官方构建的实测性能收益通常 <5%（`-march=native` 在分发场景反致跨 CPU 崩溃）
- 回归风险: 高——工具链漂移、补丁跟进、构建机可用性；收益小、责任面大
- 后果: 供应链自控最强，但用持续工程成本换不到可感知的播放收益

**C. 不做受管安装，维持「用户自行安装 + PATH 解析 + env 覆盖」**

- 涉及: 无（不新增安装器、不改分发方式；仅有 M1 诊断/设置另案处理）
- 量化: 0 个安装端点；501 发生率取决于用户环境
- 回归风险: 零
- 后果: 与已拍板 D2=A（ffmpeg 受管组件）冲突；转码能力继续是「高级用户功能」；PD-T03 作废

---

### D5. 第三方插件的前端扩展模式怎么定（配合二进制插件契约）？

- **问题**: 未来 TG 之外的采集插件以独立二进制交付已明确；分歧在「插件能带来多少自己的 UI」——完全由宿主标准渲染（稳定但表现力受限），还是允许插件自带前端包（灵活但宿主升级易被第三方改崩）。
- **现状与代价**: 现状 TgPanel 约 2600 行高度定制，是唯一插件的「特例 UI」；若每个插件照此办理，导航/播放器/缓存/设置会出现 N 套实现，播放性能纪律（07 文档 §6「播放器只有一个」）与 i18n/兼容全部失守。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/08-plugin-architecture.md`（§6 标准描述符、§7 扩展点清单、§9 conformance）、`docs/design/module-restructure-2026-10-13/07-playback-performance-contract.md`
- **请求**: 选 A、B 还是 C？

**A. v1 描述符驱动：插件不带 JS，宿主按 manifest 能力 + 标准描述符统一渲染，TG 先改造成参考插件（推荐）**

- 涉及: `download-engine/crates/orig-daemon/src/modules/plugins/`（supervisor/proxy/ticket，M6 新增）、`download-engine/crates/orig-tg/src/routes.rs`（TG 端点收敛为 `/plugin/v1/*`）、`tauri-shell/src/domains/tg/`（瘦身为标准 Source 面板 + 数据适配器）、新建 `download-engine/verify/plugin-conformance/`
- 量化: 新增 1 套宿主插件面 + 1 套标准面板（tree+stream）；TG 约 30 个自有端点收敛为约 12 个标准能力端点；第三方新插件 UI 工作量 ≈ 0（只需 descriptor）
- 回归风险: 中——TG 改造面大，缓解：先做最小 demo 插件验证契约再改 TG；conformance 套件把「崩溃重启/幂等入库/播放不中断」做成可重复验收
- 后果: 第二个插件起边际成本骤降；宿主升级不被第三方前端绑架；播放器/性能纪律有制度保障；v1 表现力封顶在标准布局（v2 再议签名 web bundle）

**B. v1 即允许插件自带签名 Web Bundle（自带页面代码，宿主只做加载）**

- 涉及: 宿主新增 bundle 加载器/签名校验/沙箱（iframe 或 webview 隔离）、host-sdk 版本锁定与兼容矩阵、插件商店审核流程
- 量化: 需先交付沙箱 + SDK + 版本协商三套设施才能放第一个第三方；TG 仍要先适配；工程量约为 A 的 2 倍
- 回归风险: 高——SDK 大版本升级时 N 个第三方插件的兼容矩阵；沙箱逃逸/样式污染/性能劣化（第二套播放器风险）
- 后果: 表现力最强，但把「统一化防第三方崩坏」的目标推迟到沙箱成熟之后

**C. 不做通用插件模型，维持「TG 写死」，未来新来源逐个定制开发**

- 涉及: 无（不新增插件宿主与契约；新来源出现时再在宿主内硬编码）
- 量化: 0 个契约面；第二个来源 = 再做一遍 TG 量级的前后端定制（数万行/数十端点级）
- 回归风险: 零（短期）
- 后果: 与「后续插件以独立二进制 + 稳定接口交付」的要求直接冲突；每个新来源都是一次性工程，核心面板随插件数膨胀

---

### D6. 播放转码策略采用哪一档作为产品行为？

- **问题**: 07 文档给出 L0 原生直出 → L1 重封装(-c copy) → L2 GPU 硬解转码 → L3 软解兜底的档级策略；需要拍板是否按此实现，以及在途 draft「预转码优先（playback-delivery-optimal）」是否进入本期。
- **现状与代价**: 现状 stream-first 按需转码（501 当 ffmpeg 缺失），多版本调优后流畅度勉强合格；不分档则「能直出的也转码」（性能净损失）或「该兜底的没兜底」（卡死）；预转码虽把编码移出播放路径，但占空间、与播放争抢资源，且与拆库同窗口推进会放大回归面。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/07-playback-performance-contract.md`（§2 档级、§5 基线与阈值）、`docs/design/playback-delivery-optimal-2026-10-13.md`、`docs/design/module-restructure-2026-10-13/06-ffmpeg-integration-analysis.md` §5
- **请求**: 选 A、B 还是 C？

**A. 档级策略：L0 直出优先，L1 -c copy，L2 硬解，L3 软解兜底，L4 引导安装；预转码不进本期（推荐）**

- 涉及: `download-engine/crates/orig-daemon/src/modules/` 选档逻辑（随 M3 媒体迁移落地）、`tauri-shell/src/lib/decodeHealth.ts` 与播放器（沿用现有探测）、`tauri-shell/verify/` 新增分档断言；M2 末先录基线 `verify_shots/playback-baseline-*/result.json`
- 量化: 能直出的片源 ffmpeg 启动次数 = 0（CPU 占用为 0，优于任何硬解）；仅不兼容片源进转码；指标红线：TTFB/首包/206 间隔劣化 ≤5%，rVFC 掉帧 0 增加
- 回归风险: 中——选档正确性是新逻辑（容器/编码误判会走错档），以 decodeHealth + 标准片源集 + 现有播放 verify 全套覆盖；性能侧红线靠基线对比强制
- 后果: 零损失目标可证；ffmpeg 缺失只影响 L2/L3；playback-delivery draft 作为 M4 后独立项保留

**B. 预转码优先：入库后后台先转浏览器友好版本，播放优先命中预转产物**

- 涉及: 后台转码队列、产物存储（与原片共存）、调度与资源让行、UI 转码状态；同时仍需 A 的兜底链
- 量化: 每个不兼容条目多一份转码产物（典型 +20%~50% 空间）；后台作业在无播放时跑、播放插队；工程量与回归面显著大于 A
- 回归风险: 高——IO/CPU 争用、失败重转、产物失效（替换源后）、与 M3 同窗口叠加风险
- 后果: 播放路径最稳（命中时等同直出），但存储成本与调度复杂度高；建议作为独立 spec 在 M4 后评估

**C. 不做分档，维持现状（stream-first 单路径 + 软/硬解现状逻辑）**

- 涉及: 无（不新增选档逻辑；只做 M3 的位置迁移）
- 量化: 0 个新判定；能直出的请求是否转码维持现状行为
- 回归风险: 零（迁移风险另计于 M3）
- 后果: 「零性能损失」依赖现状行为恰好最优，缺少 L0/L1 优先级的制度化保证；基线对比仍会做，但产品无显式分档语义

---

> 以下 D7-D12 为二轮修订（用户 2026-10-13 反馈，见 `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`）。**D11 取代 D1，D8 细化 D5**；D1-D6 中被取代条目不再执行，其余继续有效。

### D7. 下载模块是否升级为全局任务监控（聚合引擎 + TG 及未来全部插件任务）？

- **问题**: 用户要求下载成为全局监控模式，连 TG 缓存任务也纳入。TG 是独立二进制插件，跨进程聚合能否做到、做到什么形态需要拍板。
- **现状与代价**: daemon `GET /api/activity`（`crates/orig-daemon/src/activity.rs`，BUG-077 方案 a）**已在生产代码中聚合引擎任务与 TG 缓存任务**：只读聚合、控制分流、不造假暂停、插件不可达恒 200 五铁律齐备；前端完全未消费。TG 侧快照端点仍读 SQLite（BUG-085，5s 轮询缓解），插件数放大后不可接受。不决定 → 「下载中/暂停/完成」三档继续只反映引擎，TG 任务在 TG 面板自管，每接一个插件任务管理再做一套。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§1 架构调整/扇出预算/红线）、`download-engine/crates/orig-daemon/src/activity.rs`（既有聚合原型）、`docs/design/module-restructure-2026-10-13/08-plugin-architecture.md`
- **请求**: 选 A、B 还是 C（不做）？

**A. 泛化为插件级全局监控：注册表聚合 + jobs 内存快照准入 + daemon 控制代理 + 下载模块统一消费（推荐）**

- 涉及: `download-engine/crates/orig-daemon/src/activity.rs`（id 改 `{plugin_id}:{native_id}`、遍历插件注册表、并发+300ms 超时+1s 快照缓存）、`download-engine/crates/orig-daemon/src/modules/plugins/`（新增 `POST /api/activity/jobs/:gid/:action` 控制代理）、`download-engine/crates/orig-tg/src/cache.rs`/`routes.rs`（补内存快照全量端点，偿还 BUG-085）、`tauri-shell/src/domains/download/`（消费聚合端，状态 tabs + 来源 chips）、TG 工作区移除任务轮询
- 量化: 1 个既有端点泛化 + 1 个控制代理端点 + 1 个 TG 内存快照端点；前端任务列表单一轮询源；轮询 5s 封顶、有活才轮；TG 视图每秒任务轮询归零
- 回归风险: 中——聚合行为有现成单测（activity.rs tests）可扩展；主要风险是多插件扇出延迟，以并发/超时/缓存预算与 conformance 套件强制；播放热路径零接触（红线在 09 §1.4）
- 后果: 任何新插件的任务自动进全局监控；TG 面板只剩浏览负载（卡顿同步缓解）；假暂停/误删除在协议层继续被禁

**B. 只把 TG 一类并入下载监控，硬编码两侧，未来插件逐个再做**

- 涉及: `tauri-shell/src/domains/download/`（消费现有写死 TG 的 /api/activity）、TG 面板去任务轮询；插件注册表与 jobs 准入不建
- 量化: 前端改 1 个数据源；BUG-085 不强制偿还；第三个来源出现时聚合器再改一次
- 回归风险: 中——短期可用，但「稳定插件接口」目标欠债，第二个插件期活动聚合要二次重构
- 后果: 用户要的全局体验当下能拿到；插件生态开工时必有一轮返工

**C. 不做，维持各来源任务各自管理**

- 涉及: 无（不新增聚合消费、不新增端点；TG 任务继续在 TG 面板自管）
- 量化: 0 处变更；用户要在两个以上位置查看「正在取字节」
- 回归风险: 零
- 后果: 与「下载作为全局监控模式」的明确要求直接冲突；既有 /api/activity 继续是无人消费的半成品

---

### D8. 插件前端统一化是否采用「有限标准屏注册表」（细化 D5-A）？

- **问题**: D5-A 定的「描述符驱动、插件不带 JS」方向不变，但一块万能描述符装不下 TG（2600 行定制 UI）；需要把统一化细化为宿主内置的有限标准屏类型。
- **现状与代价**: TgPanel 三栏高度定制，若每插件照此办理则导航/播放器/任务/i18n 出现 N 套实现；生态调查（09 §2.1）显示候选插件收敛为 source/fetcher/drive 三型，对应四类屏幕即可覆盖。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§2.2 分型、§2.4 标准屏注册表）、`docs/design/module-restructure-2026-10-13/08-plugin-architecture.md`（§6/§9）
- **请求**: 选 A、B 还是 C（不做）？

**A. 四块标准屏：source-browser / url-task / drive-tree / accounts-login，宿主统一渲染，插件只给 schema+数据，TG 先换壳（推荐）**

- 涉及: `tauri-shell/src/domains/plugin-screens/`（新建四块标准屏）、`tauri-shell/src/domains/tg/TgPanel.tsx`（换 source-browser 壳，数据模型与 API 保留）、`download-engine/verify/plugin-conformance/`（屏能力断言）；manifest 增加 `screens[]`/`account_schema`
- 量化: 4 块宿主屏覆盖已调查全部候选（TG/yt-dlp/gallery-dl/BBDown/三家网盘）；TG 端点与消息渲染逻辑保留，废弃三栏布局壳；第三方新插件前端工作量≈0
- 回归风险: 中——TG 换壳是主要回归面，以「数据接口不动 + UI 真实渲染 verify 截图」缓解；四块屏外的插件 v1 明确不接收，避免半路扩契约
- 后果: 第三方改不到宿主代码，兼容锁死；播放器/任务/入库/i18n 全部只有一套；v2 再议签名 Web Bundle

**B. 坚持单一万能描述符（D5-A 字面），不为分型建屏**

- 涉及: `tauri-shell/src/domains/plugin-screens/`（一个通用 schema 渲染器）、TG 数据与 UI 双向适配进同一 schema
- 量化: 1 套渲染器；TG 的相册组/文件夹/监控等特例需在 schema 内反复加字段，schema 复杂度不可控
- 回归风险: 高——万能 schema 会随 TG 特例持续膨胀，fetcher/drive 型再撑大一轮，最终退化成「啥都能描述=啥都不好用」
- 后果: 概念最简，实施最易返工；预计在第二个插件期推翻

**C. 不做通用插件屏，维持逐个定制开发**

- 涉及: 无（不建标准屏、不改 TgPanel 壳；新来源出现时各自定制）
- 量化: 0 块标准屏；第二个来源 = 再做一套 TG 量级定制
- 回归风险: 零（短期）
- 后果: 与「前端统一化防止第三方改动破坏兼容」直接冲突；N 套播放器/任务轮询风险回归

---

### D9. 插件的安装 / 注册 / 启动生命周期采用什么模式？

- **问题**: 独立二进制插件如何进系统、何时被拉起需要一次定死。TG 现状是「配置开即常驻」（daemon 拉起 + tg_supervise 看护），但 yt-dlp 类工具不需要常驻，全部常驻会白占内存与进程位。
- **现状与代价**: daemon 已具备进程托管全套机制（端口顺延/就绪等待/Popen 托管/崩溃自愈，`crates/orig-daemon/src/state.rs`），但写死单个 tg_child；无安装/注册流程，第三方二进制没有落位与校验规则。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§2.5 生命周期）、`docs/design/module-restructure-2026-10-13/06-ffmpeg-integration-analysis.md`（受管安装三路径范式）
- **请求**: 选 A、B 还是 C（不做）？

**A. 三路径安装 + manifest 注册门禁 + always/on-demand/manual 三启动模式 + supervisor 泛化（推荐）**

- 涉及: 新增 `%LocalAppData%\OrigHub\plugins\<id>@<ver>\` 布局与 `download-engine/crates/orig-daemon/src/modules/plugins/{registry,supervisor,installer}.rs`、`state.rs` 的 `tg_child` 泛化为 `HashMap<plugin_id,PluginProc>`、设置·插件列表 UI；复用 ffmpeg 安装 SSE 与哈希/原子替换逻辑
- 量化: 1 套注册表 + 3 种启动策略；on-demand 默认空闲约 10 分钟退出（实施期实测调）；未签名/哈希不符不注册；新增插件 0 改 daemon 代码
- 回归风险: 中——supervisor 泛化影响 TG 本体，缓解：TG 作为第一个 always 插件先迁，沿用现有 BUG-177/227 就绪探测与退避；进程托管有既有教训与验证
- 后果: 安装/启停体验统一；fetcher 型不常驻省资源；第三方接入路径清晰可审

**B. 所有插件一律 always 常驻（复制 TG 模式）**

- 涉及: `modules/plugins/supervisor.rs`（仅常驻策略）、注册表；不做空闲回收
- 量化: 1 种启动策略；每装一个插件 = 多一个常驻进程与内存占用
- 回归风险: 低（机制最接近现状），但资源模型随插件数线性恶化，on-demand 以后补要改任务拉起链路
- 后果: 实现最简；装 5 个工具型插件即常驻 5 个进程，用户会用任务管理器质疑

**C. 不做通用生命周期，维持 TG 写死、其他插件以后硬编码**

- 涉及: 无（不新增注册表/安装器；tg_child 保持单写死字段）
- 量化: 0 套通用设施；新插件一次一次性接入
- 回归风险: 零
- 后果: 与独立二进制+稳定接口的要求冲突；插件生态无安装与信任基线

---

### D10. TG 是否两级化、账号全部移入设置，多账户如何分期？

- **问题**: 用户明确禁止第三级 Navi；账号要求完全在设置内且必须支持多账户；同时既有 TG「设计问题不大（主要渲染卡顿）」，要求保留现有数据模型。
- **现状与代价**: TgPanel 用 groupMode/detail/selectedId 三套状态形成「分组→组内频道→消息」三级钻取；账号块在面板左上角，AccountsPanel 在设置内已有登录状态机但仅单账户；缓存任务每秒轮询在视图内，是卡顿来源之一。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§3 两级布局/账号/多账户评估/卡顿治理）、`tauri-shell/src/components/TgPanel.tsx`（L330-343、L1484-1820 现状）
- **请求**: 选 A、B 还是 C（不做）？

**A. 两级布局 + 账号进设置 + 契约/表预留 account_id，多账户排 M7（推荐）**

- 涉及: `tauri-shell/src/components/TgPanel.tsx`（去中栏，segmented+folder chips 过滤同一列表；账号块改只读 chip 跳设置；去任务轮询；消息长列表虚拟化）、设置新增账号分区（复用 AccountsPanel 状态机，列表改多账户结构）、`orig-tg` 表与契约预留可空 account_id（monitored_channel/cache_task 加列迁移，旧行回填默认账户，ref 字符串保持兼容）
- 量化: 导航层级 3→2；TG 视图轮询源减 1（任务轮询移走）；M6 单账户交付，M7 多 session 池+四表作用域
- 回归风险: 中——UI 结构变化大但数据接口不动，以现有 verify + 截图回归；多账户延后避免与参考化叠加
- 后果: 菜单混乱消除；账号管理位置符合用户心智；多账户有确定排期且不阻塞参考插件落地

**B. 两级布局 + 多账户本期一起做（M6 范围扩大）**

- 涉及: A 的全部 + `orig-tg` sessions/<account_id> 多 client 池、端点 account 选路、监控/缓存/媒体条目四表迁移与去重规则、前端账户切换全链路
- 量化: 同窗口交付范围约为 A 的 1.8 倍；Telethon 多 session 无协议障碍但回归面显著变大
- 回归风险: 高——插件参考化与多账户两大迁移叠加，播放/缓存/监控三条敏感链路同窗口变更
- 后果: 一步到位但 M6 周期与回归风险显著增加，违背分期降险

**C. 不做，维持三栏与面板内账号块（仅做渲染性能修补）**

- 涉及: 无导航/账号结构变更；仅 TgPanel 局部 memo 与轮询优化
- 量化: 0 个层级调整；账号继续无多账户位置
- 回归风险: 零
- 后果: 三级 Navi 菜单乱的明确反馈原样保留；多账户无落位；与 source-browser 标准屏（D8-A）不兼容

---

### D11. 一级导航是否定为六项：文件 / 下载 / 媒体库 / TG 采集 / 共享 / 设置（取代 D1）？

- **问题**: D1 原推荐为五域（媒体库并入文件域内 rail）。用户二轮明确要求以现有 Nav 为基础评估下载/文件/媒体库三者，且媒体库现状独立工作良好；需要拍板最终导航。
- **现状与代价**: 现状 7 项（全部文件、下载中、暂停、完成、媒体库、TG、设置）中 3 项是同一任务集合的状态档；缺「共享」位。不决定 → IA 在五域/六域间摇摆，M0 无法开工。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§5 演进映射/层级铁律/三层职责）、`tauri-shell/src/components/Sidebar.tsx`（现状 ViewId）
- **请求**: 选 A、B 还是 C（维持现状）？

**A. 六项：文件/下载/媒体库/TG 采集/共享/设置，三状态档收为下载模块内 tabs，文件为默认首页（推荐）**

- 涉及: `tauri-shell/src/components/Sidebar.tsx`（ViewId 7→6）、`MainLayout.tsx`、新建 `src/domains/{files,download,media,tg,share,settings}/`；下载/媒体/文件面板薄包裹搬运，分类下钻保留在文件域
- 量化: 一级位 7→6（-3 状态档 +1 共享 +1 文件，净 -1）；零后端/API/DB 变更；M0 纯前端搬运 + 全局监控接线见 D7
- 回归风险: 低——搬运不改数据流；tgReady 门控、计数徽标、分类下钻均保留；UI verify 逐项截图
- 后果: 与「文件/媒体管理为主、下载为工具」定位一致；每模块内部 tabs 不算层级，三级钻取被全局禁止

**B. 维持 D1 五域：文件（内含媒体库 rail 视图）/下载/TG/共享/设置**

- 涉及: 同 A 的搬运量，另把 MediaLibraryPanel 全套并入文件域 rail
- 量化: 一级位 5；媒体库失去独立入口，剧集/标签/卡片成为文件页的子视图
- 回归风险: 中——媒体库是现状高频独立面板，并入后用户路径多一次 rail 切换；文件域同时承载事实层与策划层，认知密度高
- 后果: 导航更短，但与用户「参考现有 Nav、媒体库独立评估」的口径不符，媒体库既有交互被降级

**C. 不做，维持现状（七项拍平，无共享位）**

- 涉及: 无（不改 Sidebar/ViewId/目录）
- 量化: 0 处变更；状态档占 3/7 一级位；共享上线时 8 项
- 回归风险: 零
- 后果: 五/六域评估作废；模块混级与共享落位问题原样保留

---

### D12. 共享是否采用两级启用：设置管「共享服务」，共享域管「共享目标」？

- **问题**: 用户提问「设置里面开启插件？然后共享里面开启具体功能？」需要拍板交互与职责切分。
- **现状与代价**: 共享零实现（spec P5）；若只在共享页放一个总开关，则网卡/端口/令牌根等服务配置与目标管理混杂；若只在设置开启，则用户无法管理「共享了什么」。
- **设计锚点**: `docs/design/module-restructure-2026-10-13/09-revision-2026-10-13-v2.md`（§4 两级模型/安全口径）、`docs/design/module-restructure-2026-10-13/04-api-contracts.md`（share 令牌面契约）
- **请求**: 选 A、B 还是 C（不做）？

**A. 两级：设置开服务（网卡/端口/令牌根），共享域管目标（库/剧集/标签/条目集，每目标独立开关令牌二维码有效期）（推荐）**

- 涉及: `download-engine/crates/orig-daemon/src/modules/share/`（内置服务，非第三方二进制；监听生命周期跟设置开关）、`tauri-shell/src/domains/share/`（服务关=onboarding 跳设置；服务开=目标列表+访问记录）、设置·共享服务分区
- 量化: 1 个服务开关 + N 个目标开关；目标令牌独立可撤销；服务停用端口立即关闭、全部目标不可达
- 回归风险: 低——新建模块无存量链路；安全红线（只读/无令牌 401/写方法拒绝/显式网卡）由 verify 脚本锁定
- 后果: 职责清晰：系统级配置与内容级共享互不混杂；与 TG 未启用引导态范式一致

**B. 共享页一个总开关包办：网卡/端口/目标全部堆在共享域**

- 涉及: `tauri-shell/src/domains/share/`（单页含服务配置与目标管理）；设置不出现共享分区
- 量化: 1 处入口；单页信息密度高（服务配置+目标+记录）
- 回归风险: 低；代价是系统级监听配置脱离设置分区，与「设置管服务」的其他模块（插件/ffmpeg）不一致
- 后果: 实现略省，但服务配置散落在业务页

**C. 不做共享**

- 涉及: 无（不新增共享服务与 UI）
- 量化: 0 处变更；已拍板的局域网只读共享（2026-10-11 D3=A）不落地
- 回归风险: 零
- 后果: 与既有拍板冲突；手机/电视只读看库的使用场景无出口
