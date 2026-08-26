# Orig Hub 项目评估与整治方案（对标 orig-cms-ee）

> 评估日期：2026-08-26 ｜ 评估范围：目录结构 / Git / 文档 / 四项功能缺陷
> 对标基准：`orig-cms-ee`（同框架下的成熟管理范式）

---

## 0. 执行摘要

`orig-hub` 是一个 **Rust 下载内核（download-engine）+ Tauri v2 桌面壳（tauri-shell，Rust+React）** 的项目，正处于 **Go → Rust 迁移收尾期**。当前最突出的三类问题是：

1. **工程治理零散**：无根目录 `.gitignore`、无 `AGENTS.md`、31 个改动未提交、存在迁移残留（`go.work`/`go.work.sum`、`go-backup` 分支）与废弃前端（`ui/`，Wails 遗留）。
2. **目录/构建目录“多”是假象**：实际活跃代码只有 2 个舱（`download-engine`、`tauri-shell`），“多目录”来自迁移残留与废弃产物；“多构建目录”是 Rust(Tauri 双重编译)+前端 Vite 的正常产物 + 废弃 `ui/` 的叠加。
3. **四项功能缺陷根因已定位**（见第 5 节），均为引擎/前端具体代码问题，可逐项修复。

**建议优先级**：先立标准（建根 `.gitignore`/`AGENTS.md`，对标 orig-cms-ee）→ 再清残留（删 `ui/`、`go.work*`）→ 分批提交 Git → 最后按 Bug1→Bug3→Bug4→Bug2 顺序修功能。

---

## 1. 目录结构诊断

### 1.1 活跃 vs 废弃/残留

| 目录/文件 | 性质 | 说明 | 处置 |
|---|---|---|---|
| `download-engine/` | ✅ 活跃 | Rust 下载内核（Cargo workspace，5 个 crate：libsurge/surge-net/surge-protocol-*/surge-daemon） | 保留 |
| `tauri-shell/` | ✅ 活跃 | Tauri v2 + React 桌面壳（`src-tauri/`=Rust 壳，`src/`=React 前端） | 保留 |
| `ui/` | ❌ 废弃 | **Wails/Go 前端遗留**：`package.json` 为空，仅剩 `wailsjs/`、`bindings/`、`dist/`、`node_modules/` 残留 | **删除** |
| `go.work` / `go.work.sum` | ❌ 残留 | Go 工作区文件，项目已纯 Rust+UI，无 Go 代码 | **删除** |
| `bin/` | ⚠️ 运行时产物 | 含 `.exe`/`.zip`（sidecar 二进制） | 应 `.gitignore` 忽略 |
| `data/` | ⚠️ 运行时产物 | `.orighub`/`.db` 运行数据 | 应 `.gitignore` 忽略 |
| `proxy-test-file.bin` / `coverage` | ⚠️ 临时 | 测试/覆盖率产物 | 应忽略或移入 `tmp/` |
| `_docs/orig-hub/` | ⚠️ 文档 | 文档存放处（下划线前缀非标准） | 归一为 `docs/` 约定 |
| `.beads/` `.task/` `.team/` `.code-review-graph/` | ⚠️ 工具元数据 | 任务/评审工具生成，不应入库 | 应忽略 |

### 1.2 “为什么构建目录这么多”

正常且不可避免的：

- `download-engine/target/` —— 引擎 Cargo 构建产物
- `tauri-shell/src-tauri/target/` —— Tauri Rust 壳构建产物（**Tauri 应用需把下载引擎作为 sidecar 编译进壳，因此 Rust 实际编译两次**）
- `tauri-shell/dist/` + `tauri-shell/node_modules/` —— 前端 Vite 构建/依赖

**不必要的叠加**（迁移残留）：

- `ui/dist/`、`ui/node_modules/` —— 废弃 Wails 前端的构建产物，删 `ui/` 后消失。

> 结论：目录“多”= 迁移残留 + 废弃前端；构建目录“多”= Tauri 双重 Rust 编译（正常）+ 前端构建（正常）+ 废弃 `ui/`（可消除）。**核心代码并不乱，是“历史包袱”在撑场面。**

---

## 2. Git 状态诊断

| 项目 | 现状 | 问题 |
|---|---|---|
| 分支 | `main`（活跃）、`backup/original-main`、`go-backup` | 两个迁移残留分支未清理 |
| 工作树 | 31 个文件已修改未提交（download-engine 12 + tauri-shell 19） | 全量未提交，缺少逻辑拆分 |
| 未跟踪 | `.beads/`、`.task/` | 工具目录未忽略 |
| 根 `.gitignore` | **无** | 仅子目录有 `.gitignore`；`bin/`、`data/`、`proxy-test-file.bin`、`coverage` 靠外层/父级忽略规则兜底，标准不统一 |
| 约定式提交 | 无 | 提交信息无 `feat/fix/...` scope 规约 |
| 已跟踪文件 | 仅 93 个 | 说明历史提交很少，大部分是近期未提交的大改动 |

**风险**：工作树长期脏、残留分支与 Go 文件会污染后续“用 orig-cms-ee 方式管理”的目标态。

---

## 3. 文档现状

- 子目录各有零散 `README.md`（`download-engine/README.md`、`tauri-shell/README.md`）。
- 设计简报已归位 `docs/DESIGN_BRIEF.md`（原顶层 `STITCH_DESIGN_BRIEF.md`，含 `STITCH_` 门禁词，已按 EE 规范改名）；文档统一收敛至 `docs/`，`_docs/` 已废弃移除。
- **已补**（2026-08-26）：根 `AGENTS.md`/`README.md`/`.gitignore` 已建立，统一 `docs/bugs/BUG-XXX.md` 缺陷追踪已落地（见 `docs/bugs/README.md`）。

---

## 4. 对标 orig-cms-ee 的管理标准（目标态）

| 维度 | orig-cms-ee（基准） | orig-hub（现状） | 整治动作 |
|---|---|---|---|
| 根 `.gitignore` | ✅ 有 | ❌ 无 | 新建，覆盖 `target/`、`dist/`、`node_modules/`、`bin/`、`data/`、`*.bin`、logs |
| 约定式提交 | ✅ `feat/fix/refactor/docs(scope)` | ❌ 无 | 启用以 scope 区分 engine/shell/docs |
| 分支模型 | 单 `main` + 临时 feature | 含 `go-backup` 等残留 | 清理残留分支 |
| 缺陷追踪 | `docs/bugs/BUG-XXX.md` | 无 | 建立 `docs/bugs/` 约定 |
| 协作约定 | `AGENTS.md` | 无 | 新建 |
| 目录归一 | `cmd/ internal/ web/ docs/` | `download-engine/`+`tauri-shell/` 合理，但混有 `ui/`、`go.work*` | 删除残留 |
| 文档结构 | `docs/{api,architecture,bugs,design,...}` | `_docs/orig-hub/` | 收敛为 `docs/` |

> 说明：orig-hub 是桌面二进制（非 Web 服务），无需照搬 `cmd/internal/web` 的 Web 分层；**应保留 `download-engine/`(引擎舱) + `tauri-shell/`(壳舱) 的双舱结构**，重点是补齐治理文件与清残留，而非盲目重命名。

---

## 5. 四项功能缺陷根因分析（含代码证据）

### Bug 1 — 下载文件不会自动嗅探、不会按实际文件命名

**根因（已定位）**：文件名仅从 URL 路径推导，从不解析 `Content-Disposition`，也不做 `Content-Type → 扩展名` 嗅探。

- `download-engine/crates/surge-protocol-http/src/lib.rs:522`：`Metadata.filename` 由 `url.path.rsplit('/').next()` 得到（纯 URL 段）。
- `download-engine/crates/surge-daemon/src/routes.rs:174-186`：文件名解析顺序为 `req.filename` → URL path → `<id>.bin`，**无 Content-Disposition 解析、无 Content-Type 嗅探**。
- `surge-protocol-http/src/lib.rs:497`：`probe()` 已读取 `Content-Type`（用于 HTML 防误下判断），但该信息**未回传给命名逻辑**。

**修复方向**：在 `probe()` 阶段解析响应头 `Content-Disposition: attachment; filename="..."` 得到真实文件名（用户显式 `filename` 仍优先覆盖）；并依据 `Content-Type` 对缺失/错误扩展名做纠正（如服务器返回 `image/jpeg` 但 URL 无扩展名 → 补 `.jpg`）。需同步把 `Metadata.filename` 透传到 `routes.rs` 的解析链。

### Bug 2 — 无法查看详细内容（每连接状态、区块进度、文件信息）

**根因（已定位）**：引擎状态模型只暴露**聚合字段**，无每连接/分块明细。

- `download-engine/crates/surge-daemon/src/status.rs` 的 `DownloadStatus`：仅有 `downloaded/total/connections(仅数量)/speed/eta`，**无每连接状态、无分块进度**。
- `download-engine/crates/libsurge/src/protocol.rs:312` 的 `Progress`：同样只有聚合 `downloaded/total/speed`。
- `engine.rs` 内部存在 `block_map`（分块完成位图）与多 `Source`（连接），但**未序列化对外暴露**；前端 `DownloadItem.tsx` 也无详情展开区。

**修复方向**：在 `Progress`/`DownloadStatus` 增加 `blocks: [{index, start, end, done, downloading}]` 与 `connections: [{id, speed, state, bytes}]`；`DownloadItem.tsx` 增加可展开“详情”面板渲染连接/分块。工作量最大（引擎+前端+类型），建议放最后。

### Bug 3 — 速度统计不准确，已完成文件仍显示速度

**根因（两处，均已定位）**：

1. **完成时速度不归零**：`engine.rs:283-291` 的 `progress()` 在 `Completed/Paused/Cancelled/Error` 时仍调用 `self.speed.sample(downloaded)`，`SpeedTracker` 的 EMA（engine.rs:204，`prev*0.7 + inst*0.3`）**残留一个衰减但非零的值**；`status.rs:79` 直接透传 `prog.speed`，从不置 0。前端 `useStore.ts:107-124` 的 `completed/paused/error` 事件处理**也未把 `speed` 归零**，状态对象保留陈旧速度。
2. **多消费者“偷走”采样 delta（进行中速度失准的主因）**：`SpeedTracker.sample()`（engine.rs:170-207）依赖 `last_bytes/last_time` 计算瞬时速度；但 **多个调用方各自调用 `progress()`**：
   - `list` 端点 `routes.rs:109`（前端每 5s 轮询 `listDownloads()`，见 `MainLayout.tsx:27`）
   - `get_one` 端点 `routes.rs:354`
   - 引擎内部 `run()` 广播循环

   轮询 `list` 调用 `progress()` 会把 `last_bytes` 推进到当前总量，导致紧接着的引擎广播采样看到近 0 delta → 瞬时速度≈0 → EMA 被拉低/抖动。**结果：进行中速度被低估且不稳定。**

**修复方向**：
- `progress()` 仅在 `Downloading` 时返回采样速度，其余状态返回 `0`（同时 `status.rs` 透传即可）。
- 将**速度采样从 `progress()` 解耦**：仅在 `run()` 主循环内按固定节拍采样并缓存到 `Task` 字段；`list`/`get_one` 等轮询端点只读缓存值，不再调用 `sample()`，消除多消费者干扰。
- 前端 `useStore.ts` 的 `completed/paused/error` 分支显式置 `speed: 0`。

### Bug 4 — 无全局进度状态，状态栏仅显示数量、无实时速度更新

**根因（已定位）**：

- `MainLayout.tsx:34`：`totalSpeed = active.reduce((s,d)=>s+(d.speed||0),0)`，仅对“下载中+排队中”求和。
- `MainLayout.tsx:130-141`（footer 状态栏）：只显示 `活动/暂停/完成` 计数 + 条件性 `totalSpeed`（且 `totalSpeed>0` 才显示），**无全局聚合进度条（Σdownloaded/Σtotal）**；其 `totalSpeed` 又直接依赖 Bug3 中失准的 per-item `speed`。

**修复方向**（依赖 Bug3 先修）：基于修正后的 per-item 速度，计算**全局聚合进度**（Σ downloaded / Σ total）与**实时总速度**，状态栏展示“总进度 % + 实时总速度 + 活动/暂停/完成计数”，并增加一条全局进度条。

---

## 6. 整治方案（按优先级）

| 序 | 工作项 | 对应任务 | 性质 | 风险 |
|---|---|---|---|---|
| 1 | 新建根 `.gitignore`、`AGENTS.md`，确立约定式提交与 `docs/bugs/` 约定 | #1 | 非破坏 | 低 |
| 2 | 删除废弃 `ui/`（Wails 遗留）与 `go.work`/`go.work.sum` | #2 | **破坏（删目录）** | 需确认 |
| 3 | 清理 `go-backup`/`backup/original-main` 残留分支 | #3 | **破坏（删分支）** | 需确认 |
| 4 | 按逻辑分批提交 31 个改动（engine / shell / docs） | #3 | 非破坏 | 低 |
| 5 | Bug1 文件名嗅探（Content-Disposition + Content-Type） | #4 | 非破坏 | 中（需回归验证） |
| 6 | Bug3 速度修复（归零 + 采样解耦 + store 归零） | #6 | 非破坏 | 中 |
| 7 | Bug4 全局进度 + 状态栏实时速度 | #7 | 非破坏 | 低（依赖 #6） |
| 8 | Bug2 每连接/分块明细 + 详情面板 | #5 | 非破坏 | 高（引擎+前端改动大） |

---

## 7. 待确认项（破坏性动作需你拍板）

1. **删除 `ui/` 目录**：确认其为废弃 Wails 前端（已验证 `package.json` 为空、仅 `wailsjs`/`bindings`/`dist` 残留），可安全删除？
2. **删除 `go.work` / `go.work.sum`**：确认项目无 Go 代码依赖，可删除？
3. **删除 `go-backup` / `backup/original-main` 分支**：确认无需回滚到 Go 版本，可清理？
4. **分批提交的拆分粒度**：按 `engine` / `shell` / `docs` 三批，是否认可？

> 以上确认后，我将从任务 #1（建标准）开始落地，并每完成一项即时验证、汇报。
