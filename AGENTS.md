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

- 每个缺陷一个文件：`docs/bugs/BUG-XXX.md`（编号自增，参考 `docs/bugs/README.md` 模板）。
- 状态机：`open` → `in_progress` → `fixed` / `wontfix` → `closed`。

## 4. 分支模型

> **铁律（用户 2026-09-21 裁定，优先级高于本节其余条款）：**
> **远端 `origin/main` 是唯一源。所有开发与所有分支，必须、且只允许从远端 main 出去。**
> 本地不另立基准、不长期持有分叉分支、不以本地分支作为交付依据。

- 主分支 `main`，保护分支，禁止直接 force。
- **开工前先对齐远端**：`git fetch origin` 且以 `origin/main` 为准比对，确认本地在远端之上线性前进（`git rev-list --left-right --count origin/main...main` 左列必须为 0），再动手。
- **交付 = 提交进本地 main + 普通 push 到 origin/main**（fast-forward）。禁止 `push --force` 之外的任何绕过；确需重写历史时须显式授权，并先建墓碑引用。
- 不做长期分叉分支：临时工作若开 `feature/xxx`，必须当日合回 main 并删除。**禁止在本地留备份分支充当「第二基准」**（`backup-before-cr-clean`、`backup/pre-fix-*` 这类一律不留——需要可逆性请用 tag 墓碑，不用分支）。
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

- 引擎侧：速度采样集中在 `run()` 主循环，`progress()` 只读缓存，避免多消费者抢采样 delta。
- 前端侧：状态统一经 `tauri-shell/src/store/useStore.ts` 的 SSE 合并；非活动任务速度必须为 0。
- 文件名解析顺序：用户显式 `filename` → `Content-Disposition` → URL path → `<id>.bin`，并依据 `Content-Type` 纠正扩展名。
- **流畅优先（BUG-026）**：进度类高频数据只允许影响「正在变化的那一小块 UI」，禁止整面板重渲染。
  - 轮询三律：有活才轮（终态即停）；等值短路（快照签名未变不 setState）；失败退避。
  - 轮询频率上限 5s（BUG-030）：任务/列表类轮询不得高于 5s 一次；同一数据只允许一个轮询源——
    多面板（如 TgPanel 主轮询与缓存管理面板）并存时，打开面板即由面板接管，主轮询暂停；进度条
    用 `Progress smoothMs≈轮询周期` 做视觉平滑补偿，不得靠缩短轮询间隔换流畅。
  - 被轮询的读端点**不许碰 DB**——内存快照（唯一写者在 DB 变更后刷新），SQLite 只承担写入。
  - 高频路径组件必须 `memo` 化；回调用 useEvent（引用恒定 + 数据回传式 `on(item)`），禁止内联箭头。
- **单飞呈现（BUG-027）**：进度类任务的端点**只返回一个结果**（`{task}` 而非 `{tasks[]}`）；
  执行侧单飞——同一时刻至多一个 worker 在跑，多任务一律排队 FIFO 接续。
- **进度变化零派生请求（BUG-027）**：轮询周期内只允许轮询本身的请求（1s = 1 请求）；
  任何重清单刷新只能由任务终态等**离散事件**触发，禁止由每次进度变化触发。
- **TG 拉流并行 + 元数据缓存（BUG-028）**：在线流式端点禁止裸 `iter_download` 串行吐流
  （单流吞吐 = chunk/RTT ≈ 0.5MB/s，播放器必然卡顿），必须走 `parallel_range_stream`
  （K=4 分片并行、按序合并）；媒体元数据/缩略图必须过 `lru.rs::TtlLru` 缓存——
  同一 `(chat,msg)` 的 seek/续 Range/重渲染不得重复付出 `get_messages_by_id` RPC（~1.2s）。
- **缓存即入库 + 双向删除联动（BUG-029）**：任何缓存成功路径（worker/手动）**必须**
  `upsert_media_item(source="tg", ref="{chat}:{msg}", ...)`——媒体库是缓存的主视图，
  只写 `media_message` 等于内容对用户不可见。删除必须**双向联动**：清缓存 → 删对应
  media_item；删 TG 来源条目 → 清缓存副本。单向删除会在下次缓存 upsert 时「复活」，
  表现为删不掉。ref 约定全局唯一：`source="tg"`、`ref="<chat_id>:<message_id>"`。
- **restart_tg.py 必须以 Popen+wait 托管**：Windows 的 `os.execve` 是「spawn+立即退出(0)」
  的模拟，父进程退出即被任务托管判定结束并回收进程树（服务刚连上就被杀）。
- **投递契约铁律（BUG-031）**：`/api/media/items/:id/raw`（媒体库）与 `/api/tg/local/:chat/:msg`
  （TG 已缓存）**必须共用同一实现**（`serve_local_file`）——两条路径都直接喂 `<video>`，
  分叉即意味着「其中一条会退化」。契约：无 Range → 200 + **完整文件**（绝不只给前 N 字节）；
  `bytes=S-` → 206 + 32MiB 有界块 + 如实 `Content-Range`；`bytes=S-E` → 206 + 尊重请求；
  恒带 `ETag`/`Last-Modified`（缺了 Chromium 会重复下载已取字节）；MIME 按扩展名判定，
  **禁止 `image/jpeg` 之类兜底值**（会把视频误标成静态图导致拒播）。
  新增/修改任一路径，必须同步 `probe_media.py` 的「delivery path」两组断言。
- **迁移与启动期依赖（BUG-032）**：建表批（`execute_batch`）里**只允许出现新旧库都存在的列**——
  引用待 `ALTER TABLE` 补上的列会让整批迁移失败，且 SQLite 报错位置与真实原因（顺序）无关。
  凡 schema 变更，必须配一条「旧库 → 新代码」迁移单测（造旧 schema + 塞旧数据 → `open` 成功 +
  数据仍在，例：`media::tests::legacy_db_migrates_without_failing_open`）。
  启动期依赖（存储库、会话、客户端）打开失败一律**显式失败**（`EXIT_*` 退出码 + 打印实际路径），
  **禁止回落空实现** —— `:memory:` 兜底会把 schema 错误伪装成「用户数据全没了」。
- **投递问题先出线上字节账，再谈优化（BUG-031 / BUG-033）**：「大量 raw 请求 / 播放卡死」
  类现象先跑 `verify_shots/diag_rate_storm.cjs`（CDP 逐请求落地字节 + 落地区间并集去重 +
  `loadstart`/`emptied` 计数），并且**必须分别在 1x 与倍速下各记一段** ——
  1x 完全正常的通路在 2x 下可能放大数十倍（实测 2→137 请求、冗余 2x→63x）。
  已实测否定、**勿再调参**的候选：回包块大小（1/4/8/32MiB/EOF）、前端
  `preload`（auto/metadata/none）、浏览器缓存开关、按 Range 形态分流
  （seek 与顺序播放同为 open-ended `bytes=S-`，不可区分）。
- **投递必须做背压（BUG-033）**：本地千兆下服务端灌数据的速率（数百 MB/s）远超解码器消费速率
  （码率 × `playbackRate`），Chromium 会读满 buffer 即 abort 并在**同一区域反复重取** ——
  实测 2x 播放 10s 内 137 请求 / 792 MiB / 冗余 63x，在 WebView2 里就是界面卡死。
  `serve_local_file` 必须按「码率 × `DELIVERY_BUDGET_FACTOR`」节流（`duration` 不可得时回落
  `DELIVERY_FALLBACK_BPS`），可用 `ORIG_TG_DELIVERY_BPS` 覆盖以便 A/B，无需重编。
  判断标准：**倍速下的冗余倍数应在个位数**（当前 3–4x）。新增任何投递端点必须同样过背压，
  并纳入 `diag_rate_storm.cjs` 回归。
- **判「播放卡顿」必须量真实上屏帧，禁止用代理指标（BUG-034）**：
  - **禁用** `timeupdate` 判停顿（约 4Hz，几百 ms 的卡顿直接漏检）；**禁用** `rAF` 判帧率
    （它测的是合成帧——video 画面冻住时照样 60fps，等于没测）。
  - 必须用 `video.requestVideoFrameCallback`（真实上屏帧：墙钟间隔 + `mediaTime` 步长）
    配合 `video.getVideoPlaybackQuality()`（`droppedVideoFrames`）。
  - **先量合成器时钟**（空载 rAF 频率）：若「需求 fps = 源fps × 倍率」> 刷新率，瓶颈在
    **呈现层**而非解码——两者修法完全不同，不分清就会修错地方。
  - **`readyState` 满格 ≠ 能播**：视频轨编码不可解时它同样是 4（实测 `videoWidth=0`、
    `duration` 正常、**`onError` 从不触发**）。判断「能不能播」必须另看 `videoWidth`。
  - `navigator.mediaCapabilities` 的 `supported/smooth/powerEfficient` 是**声明式**的，
    偏乐观，不能替代实测。
  - 凡做 GPU 对照实验，必须把 WebGL `UNMASKED_RENDERER` 记进证据，否则「换独显无改善」
    可能只是根本没换成功。
  - **Playwright 自带 Chromium 不含 HEVC/AAC 等专有编解码器**，其对编码相关问题的表现
    ≠ WebView2；涉编码的判断必须用 `BROWSER=msedge`（与 WebView2 同引擎）。
  - 工具：`diag_playback_smooth.cjs`（上屏帧账）、`probe_mp4_codec.py`（轨道/codec 探测）、
    `probe_decode_caps.cjs`（解码能力 + GPU）、`diag_seek_latency.cjs`（跳转回填）。
- **解码异常不许静默（BUG-034）**：`<video>` 的两类失败都不触发 `onError`——
  视频轨不可解（黑屏但控制条在走）与解码吞吐不足（仅丢帧）。凡是喂 `<video>` 的路径，
  必须经 `tauri-shell/src/lib/decodeHealth.ts` 的 `useDecodeHealth` 探测并向用户提示，
  文案要给出可行动信息（如「调低播放速度会更流畅」），不得只报错误码或什么都不说。

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
| 缺陷登记一致性 | `python scripts/check-bugs.py` | 编号连续 / 索引↔文件双向一致 / 字段枚举 / `fixed` 须有可核证据 | pre-commit（必需） | `registry` |
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
