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
- **禁止入库**：AI/Agent 工具目录（`.trae/`、`.claude/` 等）、临时/处理文件、AI 报告与摘要（详见 §6）。

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

## 6. 目录归属与污染防线（防再发铁律）

> 事故背景（2026-09-18）：AI 执行过程中，大量临时/处理文件被写入**仓库根目录**与**任意工作目录**；创建的非核心脚本、说明、报告**无归类、散落各处**。本节把"什么放哪"钉死——任何写文件前先对照本节归位。

### 6.1 唯一根 —— 写入前先归位，禁止越界

| 类别 | 唯一位置 | 允许内容 | 禁止 |
|---|---|---|---|
| 文档 | `docs/` | 架构 / 设计 / BUG / 验收 / 基线 / 标准（`.md`） | 根目录或 `docs/` 之外的任何文档 |
| 下载内核 | `download-engine/` | Rust workspace 源码 + `verify/` 契约验证脚本 | 临时/调试脚本 |
| 桌面壳 | `tauri-shell/` | Tauri 壳 + React 源码 | 探针/临时脚本、日志 |
| 治理脚本 | `scripts/` | 门禁/治理脚本（入版本管理） | 业务逻辑 |
| 验证证据 | `verify_shots/<topic>/`（gitignore） | 截图、日志、探针产物 | **入库（绝不）** |
| 临时/一次性产物 | `.scratch/`（gitignore）或系统临时目录 | 处理中脚本、dump、草稿 | **仓库根 / 任意工作目录** |

**铁律**

- ❌ **禁止在仓库根目录新增任何文件**。根目录**只允许**以下受版本管理的文件：`.gitignore`、`AGENTS.md`、`README.md`、`download-engine.toml`（daemon 运行时配置）。其余一律不得落根。
- ❌ **禁止在工作目录落临时文件**：在 `docs/`、`download-engine/`、`tauri-shell/` 内工作时产生的临时/处理/调试产物，**不得**留在该目录。
- ✅ 临时文件的**唯一出口**：一次性脚本 → 系统临时目录（`%TEMP%` / `$TMPDIR`）；需跨步骤复用的草稿 → 仓库根 `.scratch/`（已 gitignore）；需长期保留的验证证据 → `verify_shots/<topic>/`（已 gitignore）。

### 6.2 非核心产物三分法

| 产物性质 | 去处 | 入库？ |
|---|---|---|
| 交付代码（被源码引用、长期维护的脚本） | 归属舱（如 `download-engine/verify/`） | ✅ |
| 验证/验收脚本（本地跑、不交付） | `verify_shots/<topic>/` | ❌ gitignore |
| 一次性处理脚本 / dump / 草稿 | 系统临时目录 或 `.scratch/` | ❌ gitignore |
| AI 报告 / 评估 / 交付摘要 / 说明 | **不入库**；确需保留的正式文档 → `docs/` 且正式命名 | ❌ |

### 6.3 AI 工具目录（ZERO TOLERANCE）

`.trae/` `.claude/` `.cursor/` `.aider/` `.kiro/` `.cody/` `.codex/` `.codeium/` `.windsurfrules` `CLAUDE.md` 等 AI/Agent 工具运行态目录**一律不得入库**，已由 `.gitignore` 拦截；提交它们 = 规范事故。

### 6.4 .gitignore 铁律（对齐 EE §6.1）

- **禁止写裸目录名**（`analysis/` 这类）：Git 会在**任意层级**匹配，会把源码/文档黑洞掉（文件在磁盘上却对 `git ls-files` 隐形，改了等于没改）。构建产物/运行目录一律**根锚定**：写 `/bin/` 不写 `bin`。
- 改 `.gitignore` 后必须自查：`git check-ignore -v <path>`。
- 审计仓库完整性时 `git ls-files` **不可信**，须同时跑 `find` 与 `git status --ignored` 对账。

## 7. 提交前污染防线（自动门禁）

- 本地钩子 `.git/hooks/pre-commit` → 调用受版本管理的 `scripts/check-pollution.sh`，拦截：根目录非白名单文件、AI 工具目录、临时文件（`*.tmp/*.bak/*~/*.orig/*.log`）、工作目录内残留的探针/临时脚本。
- 拦截即**修根因**（归位 / 删临时 / 补 `.gitignore`），**禁止 `--no-verify` 绕过**。
- 钩子本身不入库：新克隆后执行 `bash scripts/install-hooks.sh` 安装（一键装 `pre-commit` 污染门禁 + `commit-msg` 英文门禁）。
