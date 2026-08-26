# AGENTS.md — Orig Hub 协作约定

本文件定义 AI 智能体与协作者在本仓库工作的统一规则，对标 `orig-cms-ee` 的治理范式。

## 1. 仓库结构（双舱）

| 舱 | 路径 | 说明 |
|---|---|---|
| 下载内核 | `download-engine/` | Rust Cargo workspace，crate：`orig-core`(引擎)、`orig-net`、`orig-protocol-{http,virtual}`、`orig-daemon`(REST/SSE 守护进程) |
| 桌面壳 | `tauri-shell/` | Tauri v2 壳，`src-tauri/`(Rust) + `src/`(React 前端) |

> 不在仓库保留 Wails/Go 残留（`ui/`、`go.work*` 已清理）。内核通过 sidecar 模式被 Tauri 壳调用，**非 cgo FFI**。

## 2. 提交约定（强制）

格式：`<type>(<scope>): <subject>`

- type：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `style`
- scope：`engine`（内核）/ `shell`（Tauri 壳+前端）/ `docs` / `build`
- 示例：`feat(engine): 支持 Content-Disposition 文件名嗅探`

要求：

- 二进制（sidecar `*.exe`、`target/`、`dist/`、`node_modules/`、`/bin`、`/data`）**绝不入库**（已由根 `.gitignore` 覆盖）。
- 提交前确保 `cargo build`（engine）与 `npm run build`（shell 前端）通过。
- 不 `--no-verify` 跳过钩子，除非显式授权。

## 3. 缺陷追踪

- 每个缺陷一个文件：`docs/bugs/BUG-XXX.md`（编号自增，参考 `docs/bugs/README.md` 模板）。
- 状态机：`open` → `in_progress` → `fixed` / `wontfix` → `closed`。

## 4. 分支模型

- 主分支 `main`，保护分支，禁止直接 force。
- 临时工作用 `feature/xxx`，合并后删除。
- 禁止保留 `go-backup` / `backup/original-main` 这类迁移残留分支（待清理确认）。

## 5. 代码层约束

- 引擎侧：速度采样集中在 `run()` 主循环，`progress()` 只读缓存，避免多消费者抢采样 delta。
- 前端侧：状态统一经 `tauri-shell/src/store/useStore.ts` 的 SSE 合并；非活动任务速度必须为 0。
- 文件名解析顺序：用户显式 `filename` → `Content-Disposition` → URL path → `<id>.bin`，并依据 `Content-Type` 纠正扩展名。
