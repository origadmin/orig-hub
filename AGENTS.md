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

- **语言（强制）：提交信息（subject 与 body）一律英文，禁止中文。** 这是继承自 EE（orig-cms-ee）的核心规约，优先级高于本文件的格式示例——历史已出现 24/78 中文提交，根因即此规约从未写入本地约定且无门禁拦截。
- **行尾（强制）：提交信息必须 LF，禁止 CR（`\r`）。** git 按**字节**哈希提交对象，message 里的 CR 会原样进入字节内容；LF 才是通用行尾。本仓库根提交 `206ee70` 与 `645d2c7` 内容完全相同（同 tree `09b3465`、同作者同时刻），仅因结尾 CRLF/LF 之差而哈希不同，并让**所有后代哈希全变**（本分支 78 条里 76 条 message 含 CR，见 BUG-084）。
- type：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `style`
- scope：`engine`（内核）/ `shell`（Tauri 壳+前端）/ `docs` / `build`
- 示例：`feat(engine): support Content-Disposition filename sniffing`
- 门禁：`.git/hooks/commit-msg` 会拒绝任何**含中文**或**含 CR** 的提交信息；AGENTS.md 已规定禁止 `--no-verify` 跳过（除非显式授权）。

要求：

- 二进制（sidecar `*.exe`、`target/`、`dist/`、`node_modules/`、`/bin`、`/data`）**绝不入库**（已由根 `.gitignore` 覆盖）。
- 提交前确保 `cargo build`（engine）与 `npm run build`（shell 前端）通过。
- 不 `--no-verify` 跳过钩子，除非显式授权。

## 3. 缺陷追踪

- 每个缺陷一个文件：`docs/bugs/BUG-XXX.md`，编号自增。
- 状态机：`open` → `in_progress` → `fixed` / `wontfix` → `closed`。
- **登记规格（标准档／轻量档）、索引行规格、门禁行为、建档要点**：
  见 `docs/rules/bug-registry.md`。索引表本身在 `docs/bugs/README.md`。

## 4. 分支模型

> **铁律（用户 2026-09-21 裁定，优先级高于本节其余条款）：**
> **远端 `origin/main` 是唯一源。所有开发与所有分支，必须、且只允许从远端 main 出去。**
> 本地不另立基准、不长期持有分叉分支、不以本地分支作为交付依据。

- 主分支 `main`，保护分支，禁止直接 force。
- **开工前先对齐远端**：`git fetch origin` 且以 `origin/main` 为准比对，确认本地在远端之上线性前进（`git rev-list --left-right --count origin/main...main` 左列必须为 0），再动手。
- **交付 = 提交进本地 main + 普通 push 到 origin/main**（fast-forward）。禁止 `push --force` 之外的任何绕过；确需重写历史时须显式授权，并先建墓碑引用。
- 不做长期分叉分支：临时工作若开 `feature/xxx`，必须当日合回 main 并删除。
- **本条只约束新分支的切出基准，不授权清理存量。** 已有的备份 / 归档分支（`backup-before-cr-clean`、`backup/pre-fix-*` 等）是历史资产，
  **未经用户逐条显式确认，一律不得删除** —— 把「新分支必须从 main 出去」读成「删掉已有备份分支」是**误读**，那样做是破坏不是修复。
- **删除任何引用（本地分支 / tag / 远端分支）前必须有显式授权。** 授权要覆盖到具体引用名；「按 AGENTS.md 清理」不构成授权，
  本文件里自行添加的条款更不能自我授权。删前先建墓碑 tag 并在汇报里给出**恢复命令**。
- 禁止保留 `go-backup` / `backup/original-main` 这类迁移残留分支（待清理确认）。

### 4.1 「本地与远端不一致」的排查顺序（先取证，勿重写历史）

现象为「main 脱离 remote / 项目归零」时，**先按此顺序取证，绝大多数是引用陈旧而非代码丢失**：

1. `git ls-remote origin refs/heads/main` —— 远端**真实**值。
2. `git rev-parse HEAD` —— 本地值。
3. `git rev-parse origin/main` —— 本地**跟踪引用**（可能是幽灵旧值）。
4. `git rev-list --left-right --count origin/main...main` —— 左右两列是否都为 0。
5. `git rev-parse --abbrev-ref main@{upstream}` —— **upstream 是否配置**（未配置时 IDE 里会显示成「脱离」，但代码并未脱离）。

修复手段（**均不触碰对象库、不丢代码**）：

- 跟踪引用陈旧 → 直接改 `.git/packed-refs` 中对应行（本环境 `refs/remotes/**` 写入会被静默拦截，`git fetch` / `git update-ref` 可能退出码 0 却不生效，**改完必须回读校验**）。
- upstream 缺失 → `git branch --set-upstream-to=origin/main main`。
- 只有远端确实缺少本地提交时才 push；本地落后时才 pull/merge。**任何一步都不需要 force。**

## 5. 代码层约束

> **本节只放可执行判据（改什么必须怎样）。** 每条规则的「为什么 / 实测数据 / 工具入口」
> 在 **`docs/rules/code-constraints.md` 对应小节**，改动落入该领域时再按需加载。
> 判据以本节为准；依据以细则文件为准。

- 引擎侧：速度采样集中在 `run()` 主循环，`progress()` 只读缓存，避免多消费者抢采样 delta。
- 前端侧：状态统一经 `tauri-shell/src/store/useStore.ts` 的 SSE 合并；非活动任务速度必须为 0。
- 文件名解析顺序：用户显式 `filename` → `Content-Disposition` → URL path → `<id>.bin`，并依据 `Content-Type` 纠正扩展名。

| 规则 | 判据（必须怎样） | 细则 | 关联 |
|---|---|---|---|
| 流畅优先 | 进度类高频数据只影响「正在变化的那一小块 UI」，禁止整面板重渲染；轮询三律（有活才轮／等值短路／失败退避）+ 频率上限 5s + 同一数据单一轮询源；被轮询的读端点不许碰 DB（内存快照）；高频组件必须 `memo`，回调用 useEvent | §D1 | BUG-026 / 030 |
| 单飞呈现 | 进度类端点只返回一个结果（`{task}` 而非 `{tasks[]}`）；执行侧单飞，多任务 FIFO；进度变化零派生请求（重清单刷新只能由任务终态等离散事件触发） | §D2 | BUG-027 |
| TG 拉流 | 在线流式端点禁止裸 `iter_download`，必须 `parallel_range_stream`（K=4）；媒体元数据／缩略图必须过 `lru.rs::TtlLru` | §D3 | BUG-028 |
| 缓存即入库 | 任何缓存成功路径**必须** `upsert_media_item(source="tg", ref="{chat}:{msg}")`；ref 全局唯一 `"<chat_id>:<message_id>"` | §D4 | BUG-029 |
| 删除联动（单向） | **清缓存只回收字节，条目永不删除**（禁止回头删 `media_item`）；**删 TG 来源条目必须连带清字节**（否则按 `source+ref` 幂等 upsert 会「复活」） | §D4 | BUG-051 / 096 |
| 投递契约 | `/api/media/items/:id/raw` 与 `/api/tg/local/:chat/:msg` **必须共用 `serve_local_file`**；无 Range → 200 + 完整文件；`bytes=S-` → 206 + 32MiB 有界块 + 如实 `Content-Range`；恒带 `ETag`/`Last-Modified`；MIME 按扩展名，**禁止 `image/jpeg` 兜底**；改任一路径同步 `probe_media.py` | §D5 | BUG-031 |
| 投递背压 | `serve_local_file` 必须按「码率 × `DELIVERY_BUDGET_FACTOR`」节流；判据是**倍速下冗余倍数在个位数**；新增投递端点同样过背压并纳入 `diag_rate_storm.cjs` 回归 | §D5 | BUG-033 |
| 播放判据 | 判卡顿**必须**用 `requestVideoFrameCallback` + `getVideoPlaybackQuality()`；**禁用** `timeupdate` 与 `rAF`；`readyState` 满格 ≠ 能播（须看 `videoWidth`）；涉编码判断必须 `BROWSER=msedge` | §D6 | BUG-034 |
| 解码健康 | 凡喂 `<video>` 的路径必须经 `decodeHealth.ts` 的 `useDecodeHealth` 探测并提示用户，文案给可行动信息 | §D6 | BUG-034 |
| 迁移与启动 | 建表批只允许出现新旧库都有的列；schema 变更必须配「旧库→新代码」迁移单测；启动期依赖失败必须显式失败（`EXIT_*` + 打印路径），**禁止回落 `:memory:`** | §D7 | BUG-032 |
| TG 重启托管 | `restart_tg.py` 必须以 Popen+wait 托管（Windows `os.execve` 是 spawn+立即退出，父进程退出即回收进程树） | §D4 | — |

## 6. 目录归属与污染防线

- **仓库根只允许 4 个文件**：`.gitignore` / `AGENTS.md` / `README.md` / `download-engine.toml`。
  其余一律进唯一归属目录：

  | 内容 | 归属 |
  |---|---|
  | 文档（设计 / 评估 / 交付记录） | `docs/`（历史交付记录也进 `docs/`，**不进仓库根**） |
  | 下载内核 | `download-engine/` |
  | 桌面壳 + 前端 | `tauri-shell/` |
  | 入库存档的治理脚本 | `scripts/` |
  | **入库的验收脚本**（跨机器可复核） | `download-engine/verify/`（引擎契约）、`tauri-shell/verify/`（UI 真实渲染） |
  | 验收证据产物（截图 / result.json） | `verify_shots/<topic>/`（**ignored**） |
  | 一次性脚本 / dump / AI 报告摘要 | **不入库**（或写入系统临时目录） |

- **禁止在仓内落构建与验证产物**：`vite build` 一律让输出落在仓外临时目录，或使用已 ignore 的输出名
  （`dist/`、`tauri-shell/dist_*/`）。直接 `npm run build` 覆盖 `dist/` 还会撞工作区删除守卫。
- **AI/Agent 工具目录零容忍**：`.trae/ .claude/ .cursor/ .aider/ .kiro/ .cody/ .codex/ .codeium/
  .augment/ .continue/ .sourcegraph/ .windsurfrules CLAUDE.md` 等一律不入库
  （`.gitignore` 已拦；历史上 `.trae/` 曾被误提交）。
- **运行时产物不入库**：SQLite 库（`*.db`）、TG 会话（`*.session`）、日志、`/bin`、`/data`。
  TG 数据（`session.session` + `store.db`）由 `orig-daemon::tg_data_dir()` 落到
  `%LocalAppData%\OrigHub\tg\`，**与启动 CWD 无关** —— 仓库根出现 `tg_store.db` 就说明有人从仓根
  裸跑过 sidecar（`Config::default()` 的 `./tg_store.db`），属残留，直接移出仓库。
- **判定口径**：被 `.gitignore` 忽略 = 可容忍（`target/`、`node_modules/` 物理存在是正常的）；
  **被跟踪**（ignore 对已跟踪文件无效——「先提交、后 ignore」是唯一逃逸路径）或**未忽略** = 违规。

## 7. 门禁与自动化

| 门禁 | 脚本（单一真源） | 覆盖 | 本地钩子 | CI |
|---|---|---|---|---|
| 缺陷登记一致性 | `python scripts/check-bugs.py` | 编号连续 / 索引↔文件双向一致 / 字段枚举 / `fixed` 须有可核证据 / 登记档位（`standard`｜`light`） | pre-commit（必需） | `registry` |
| 登记档位规则 | `python scripts/verify_light_tier.py` | 反向证伪：轻量档缺证据、轻量档写根因、档位值非法、未知字段名**各自必须 FAIL**；合法轻量档**必须零报错** | — | `registry` |
| 提交信息 | `python scripts/check-commit-msgs.py` | 全英文（扫 `%B` 全文，只看 `%s` 会假阴性）；`fix` 必须引用 `BUG-<编号>`；**CRLF 检测**：扫 `%B` 全文，出现 `CR` 即失败（必须 LF，`%B` 按字节取，`text=True` 会吃掉 `\r` 致假阴性）；历史欠账（生效点 `3e85681` 及其祖先）只告警不阻断 | commit-msg（必需） | `registry` |
| 目录污染 | `sh scripts/check-pollution.sh` | 根 4 文件白名单（I1）/ 未跟踪的产物与 AI 目录（I2）/ 未忽略残留（I3） | pre-commit（必需） | `registry` |
| sidecar 一致性 | `sh scripts/sync-sidecars.sh --check` | release 产物不旧于源码 + 四处副本逐字节一致 | — | `engine` |

- 钩子权威副本在 `scripts/hooks/`（**钩子本身不入库**）：新克隆必须 `bash scripts/install-hooks.sh`。
- 任一必需依赖缺失即**失败**，不顺延、不静默跳过。历史教训：pre-commit 曾无条件 `exec` 一个从未入库的
  脚本 → 恒 exit 127 把所有提交锁死；随后改成「缺了就跳过」，污染门禁又长期空转（根目录因此积了残留）。
- CI 与本地钩子调用同一批脚本，CI 是最后一道闸（本地可被 `--no-verify` 绕过）。

## 8. 汇报与决策约定（待拍板项必须可处置）

一次交付**只汇报四件事**：①依据哪条规则 ②改了什么 ③验收结果 ④待拍板项。
技术观察、既有测试翻动、旁支缺陷、实验过程、环境/时区分析**一律不进汇报** —— 它们进
`docs/bugs/` 或本地记忆，不打扰决策人。

**待拍板项禁止只给编号。** 每个待拍板项必须自带三段，缺一段即视为汇报未完成：

| 段 | 必须回答 | 缺失的后果 |
|---|---|---|
| **因果** | 现状是什么 → 根因是什么 → **不决定要付什么代价** | 收件人无法判断该不该现在花时间 |
| **处置** | 具体动哪里（文件/表/端点/界面）、有几种做法、各自影响面与回归风险 | 批准了也不知道会变成什么样 |
| **请求** | 要对方拍的那**一句**（选 A 还是 B / 是否批准执行 / 是否可延后） | 收件人只能回「你说呢」 |

反例（真实发生过）：

> **待拍板**：是否接着做 BUG-057 ＋ BUG-059

收件人手里只有两个编号：不知道这两条在讲什么、不知道答应后哪里会被改、不知道有什么代价 ——
**等于无法处置**，这属于汇报缺陷，不是收件人的理解问题。

正例（同一件事的正确写法）：

> **待拍板：媒体库加单条删除入口（BUG-057）**
> - 因果：卡片上只有「编辑/勾选」，没有删除；删一条必须先勾选再走顶部工具栏，
>   被建模成「大小为 1 的批量」。不改 → 用户每次收尾单条内容都要多两步，且入口靠猜。
> - 处置：`tauri-shell/src/components/media/MediaCard.tsx` 加常驻/悬停删除入口，
>   复用现有 `confirmDelete` 状态机（`kind: 'items'`）；删除范围如实回报「将删除 N 条
>   （其中 M 条已归入剧集）」。改动面 = 1 个组件，无后端改动。
> - 请求：批准即开工（一次提交），或改为「仅悬停显示」再动手。

- 待拍板项一次**不超过 3 条**，按「挡住用户使用」优先排序；能自行定案的不许抛回（见下）。
- **界线**：方案/模式选择 = 待拍板；方案内的执行细节 = 工程师自决，不得回抛（用户口径：
  「目的已定 ⇒ 结论已定」，反例如「third_party 是否需要 tracked」属应结论而未结论）。
- 用户以**问句**提及某事时，一律视为开放待定项显式回抛确认，不得自行记为「已确认」。
