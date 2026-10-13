# 模块重整规划包（2026-10-13）— 索引

本目录是「文件 / 下载 / 媒体库 / TG 采集 / 共享 / 设置」六模块重整的**代码前完整规划包**（二轮修订口径，见 09）。
本轮只出文档与计划，不写生产代码。所有文档为配套关系，单独阅读任一篇可能丢失上下文。

## 阅读顺序

| # | 文档 | 读者 | 内容 |
|---|---|---|---|
| 1 | [spec.md](spec.md) | 决策人 | TL;DR、现状诊断（带证据）、目标 IA、六期分期与每期二值 AC、待拍板项 |
| 2 | [tasks.md](tasks.md) | 执行 AI/工程师 | 按 M0-M5 拆分的可提交任务：精确文件、改动边界、验证命令 |
| 3 | [01-frontend-architecture.md](01-frontend-architecture.md) | 前端执行 | 目录域划分、全量 77 个前端文件处置表、组件树、状态边界、导航契约 |
| 4 | [02-backend-architecture.md](02-backend-architecture.md) | 后端执行 | 双服务拓扑目标、21 个 Rust 文件归属、全部 HTTP 端点现状→目标映射、共享投递 crate、sidecar 生命周期 |
| 5 | [03-data-model-and-migration.md](03-data-model-and-migration.md) | 后端执行/DBA | 16 张表现状清点、library.db 目标 schema、app_setting 键拆分、FileFact 模型、迁移与回滚手册 |
| 6 | [04-api-contracts.md](04-api-contracts.md) | 全栈 | M1/M2/M4/M5 新增端点的 JSON 请求/响应契约、错误语义、鉴权 |
| 7 | [05-ui-wireframes.md](05-ui-wireframes.md) | 前端/设计 | 五域 + 设置七区块的线框与交互约定 |
| 8 | [06-ffmpeg-integration-analysis.md](06-ffmpeg-integration-analysis.md) | 后端/决策人 | ffmpeg：外部二进制+接口化调用、分发方案对比（官方静态/自编译）、硬解支持矩阵、性能与可行性 |
| 9 | [07-playback-performance-contract.md](07-playback-performance-contract.md) | 全员（红线） | **播放零性能损失契约**：热路径拓扑、L0-L4 档级策略、性能预算、基线录制与防回退阈值 |
| 10 | [08-plugin-architecture.md](08-plugin-architecture.md) | 架构/后端/前端 | 二进制插件模型（manifest/生命周期/稳定契约）、前端描述符统一渲染、TG 参考插件改造、M6 |
| 11 | [09-revision-2026-10-13-v2.md](09-revision-2026-10-13-v2.md) | 全员（**最新**） | **二轮修订（最高优先）**：六项 IA、全局下载监控（/api/activity 泛化）、插件生态调查/标准屏/三启动模式、TG 两级化与账号多账户分期、共享两级启用；含对 01/05/08/spec 的取代映射 |
| 12 | [prototype/index.html](prototype/index.html) | 决策人/设计 | 六项导航可浏览高保真静态原型（mock 数据，无后端，已按 09 修订） |
| 13 | [../review/module-restructure-decisions-2026-10-13.md](../review/module-restructure-decisions-2026-10-13.md) | 决策人 | 十二条待签字决策（D1-D6 + 二轮 D7-D12；**D11 取代 D1、D8 细化 D5**），门禁合规格式 |

> **二轮修订效力**：09 文档与 D7-D12 为最新口径；spec/01/05/08 中与之冲突处以 09 §7 取代映射为准。

## 状态

- 规划包：**待决策人签字**。
- 签字方式：在决策文档三条 `### D<n>.` 上批复选项（A/B/C），或口头裁定后由执行方回填。
- 已拍板的上游决策（2026-10-11 D1/D2/D3，文件管理为纲 / ffmpeg 受管 / 局域网共享）本包不再重议。

## 流程前置（非决策项，Q4）

当前工作区存在大量未提交改动（含 routes.rs/store.rs/多个前端组件的 M 状态，以及 BUG-293~296、
三份 2026-10-13 draft、临时 verify 产物等未跟踪文件）。M0 首个代码提交前必须：

1. 在途 BUG 修复按「修一条 → 提交一条」入库；
2. 在途 draft（ingest-fact-layer / engine-lock-thread / playback-delivery-optimal）评审后提交或移出；
3. 临时 probe 产物归 `verify_shots/`（ignored）或系统临时目录；
4. `git fetch origin` 且 `git rev-list --left-right --count origin/main...main` 左列为 0。

本规划包文档本身可作为第一批提交（docs/ 路径免门禁，decision 文档需过 `check-decisions.py`）。

## 规划包内术语

| 术语 | 含义 |
|---|---|
| 域（domain） | 一级功能单位：下载 / 文件 / TG 采集 / 共享 / 设置 |
| 文件事实（FileFact） | 受管字节的通用记录：路径/大小/时间/类型/来源；文件层 v1 由 FS+任务+media_item 派生，不建表 |
| 领域视图 | 文件事实经媒体投影后的视图（内容/剧集/标签）= 现媒体库 |
| 核心面 | orig-daemon：无凭证必启动，承载下载/文件/媒体/ffmpeg/共享（目标态） |
| 插件面 | orig-tg：以 TG 凭证为前置，只承载会话/采集/缓存过程态（目标态） |
