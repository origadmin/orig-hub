---
status: active
scope: 全仓（download-engine + tauri-shell）
date: 2026-10-23
enforced-by: AGENTS.md（强制引用）+ 门禁脚本 + 验收探针
---

# 开发标准（全开发/AI 必读必守）

> 立项原因（用户 2026-10-23）：「当前缺少开发,样式,模块各方面的标准文档,需要整理一下,
> 并发放所有开发遵守」。
>
> 三份文档：**本文件（开发标准）** + [`style.md`](./style.md)（样式标准） +
> [`module.md`](./module.md)（模块标准）。冲突时以 **AGENTS.md §5–§8** 为准
> （它是真源，本文档是它的可执行展开）。

## 1. 缺陷登记：说必记，记必改（最高规则）

1. 用户提出的**每一个**问题/现象，先入 `docs/bugs/BUG-NNN.md` 再动手，回复回执写「现象→BUG-N」。
2. 建档前 `python scripts/check-bugs.py` 取最新号；字段必须用枚举值：
   `模块 ∈ {build, docs, engine, engine+shell, shell}`、`严重程度 ∈ {critical, high, mid, low}`，
   且必须含 `- 状态` / `- 发现日期` / `- 模块` / `- 严重程度`。
3. **`fixed` 必须有非空「## 验收证据」**，且证据是**库内可核**的：探针路径 + PASS 数 +
   验牙（装回旧实现必红）+ 截图落 `tauri-shell/verify/evidence/BUG-NNN/`。
4. 严禁把用户诉求改写成「口径澄清/不是缺陷」来规避实现（BUG-392 的直接教训：
   共识被写成文档结论，实现队列里从未出现 ⇒ 用户第二次报「为什么没修」）。
   文档只能记录**已实施**的结论，未实施的必须留 `open` 并给出修法。

## 2. 验收：真实运行栈 + 自动化，绝不甩给用户手点

1. 真实栈：`python scripts/dev/dev_stack.py start`（dev 侧 daemon **29786** + orig-tg **29787** + vite 5180）。
   端口一律从 `/api/config` 的 `tg_port` 解析，**禁止硬编码**。
   > **dev 与 release 并存（2026-10-27）**：release 壳固定 `19786` 起扫 64 个端口
   > （`tauri-shell/src-tauri/src/lib.rs::DAEMON_PORT`），dev 栈若也用 19786，壳的
   > `ensure_daemon` 会把 dev 的 daemon 当成自己的复用之（`already-running`），
   > 任一方被停都让另一方失去后端。故 dev 栈端口整体上移到 29786/29787。
   > **数据根共用**（`%APPDATA%\com.origadmin.orighub`：`tg/store.db`、媒体文件、
   > `download-engine.toml`），**运行态分离**：`daemon.dev.endpoint` /
   > `engine_tasks.dev.db` / `logs/dev/`。
   > 会话**不分离**（2026-10-28 反转 BUG-474 的隔离设计）：dev 与 release 共用真实
   > `tg/session.session`（同一份登录凭证）。注意：dev 与 release 两套 orig-tg 同时在线
   > 会触发同一 auth key 双连接被 Telegram 互踢，故不要同时跑两套栈。
2. UI 结论必须 `tauri-shell/verify/lib/cdp.cjs` 真实截图 + **量化断言**（几何读
   `getBoundingClientRect`，不读 className）；贴边/居中一律**视口相对**，禁止父容器相对。
3. 新断言必须**验牙**：装回旧实现确认必红、还原后复绿（还原后比对文件指纹一致）。
4. 夹具纪律：受控样本用完即清，并以「残留=0」断言收尾；禁止在用户数据上做破坏性验证。
5. 引擎改动走 redeploy 握手：`--stop` → `cargo build --release -p <crate>`（**在
   `download-engine/` 下执行**）→ `sh scripts/sync-sidecars.sh` → `--start`。

## 3. 提交与协作

1. 提交信息**全英文**（`commit-msg` 门禁禁中文）；暂存文件**不得含本机绝对路径字面量**
   （运行时构造替代）。
2. 未批准禁止 `push`；禁止 `git reset/checkout/restore` 回退（用副本文件 + 指纹比对还原）。
3. 最小差异：只改达成判据所必需的那几行；顺手重构/格式整理一律不做。

## 4. 契约铁律（接口）

1. **一动词一端点**（pause/resume/cancel/retry 各自独立，不塞 `?action=` 的语义混合）；
   非法/空值 422；实时读端点只读。
2. **同一域的同一个业务对象，只能有一个列表接口与一个状态变更接口**（BUG-392）：
   来源差异由**服务端按 id 前缀分流**，前端不得直连多个服务。
3. 路径字段出网统一 `/`（`orig_core::paths::to_wire`）；`\` 是回归。
4. 命名不超行为：端点名不得暗示它不提供的能力；死端点（无人调用）必须退役并在文档标注。

## 5. 数据呈现铁律

1. **取不到 ≠ 没有**：不可用 = 保留 last-known + banner 直出原因 + 续轮重试；
   不可写「暂无」掩盖不可达（BUG-389/390）。
2. 计数必须有**作用域可见性**：作用域受限的 0 必须自带解释（BUG-390）。
3. 单一真源：同一事实（谓词/常量/口径）只有一处定义，其余引用；禁止复制粘贴式同步。

## 6. 本地钩子：装了没用 ≠ 装了（BUG-158）

1. 安装：`sh scripts/install-hooks.sh`。脚本**由自身位置推仓根**（不用
   `git rev-parse --show-toplevel`），发现当前目录不是本仓的 worktree 顶层就**直接失败** ——
   装进超仓的 `.git/hooks` 等于没装。
2. 脚本只用 `git config --local` 把 `core.hooksPath` 钉到**本仓自己**的钩子目录，
   绝不写 `--global` / `--system`，也不动超仓（framework）的配置。
3. 排查任何「钩子没拦」的第一步：`git rev-parse --path-format=absolute --git-path hooks`。
   `NUL` 是 Windows 空设备名 —— 一旦 `core.hooksPath=NUL`，git **只**去那个不存在的目录找钩子，
   静默什么都不跑（本仓历史上就是这样恒不生效的）。
4. 「已安装」只认可执行证据：`git hook run commit-msg -- <msgfile>` 必须真的执行；
   用一条中文提交信息验红、一条英文验绿（同一环境内两条都要成立，只验一条会被恒拒/恒过骗过）。

## 7. 文案与语种：加一个语言包，不改代码（BUG-236 / BUG-141）

1. **新增语种 = 放一个文件**：`tauri-shell/src/i18n/locales/<BCP-47>.json`（如 `de-DE.json`）。
   语言包的键集合由目录自动发现（`import.meta.glob`），语言选择列表、缺键回退链
   （当前语种 → `zh-CN` → 调用方 fallback → key）都在 `i18n/index.ts` 一处，无需改代码。
2. 新语种必须**键完备**：缺的键运行期会回退 `zh-CN`（不会渲染空白），但
   `python scripts/check-i18n-keys.py` 按所有语种的并集比对，缺键即红 —— 回退是兜底，
   不是「可以只翻一半」的许可。该门禁同时校验占位符一致（`{name}` 改名会直出花括号）与空值。
3. **禁止硬编码文案**：`python scripts/check_i18n_hardcoded.py` 扫描非注释行的中文字面量；
   新增/修改 UI 文案一律 `t('ns.key')` 并同时补 `zh-CN` / `en-US`。
4. 组件内用 `useTranslation()`（订阅 `settings.language`），不要裸 `t()`
   —— `t` 不订阅语言，被 `memo` 包住的组件切语种不会重渲染。纯函数模块可以用 `t()`
   （调用方组件负责订阅）。

## 三级验收（BUG-402，2026-10-23 用户裁定）

开发完成后的验证**只按下面三档走**，不许漫跑全量、不许凭感觉挑：

- **S1 冒烟**（`node verify/smoke.cjs`）：交付**任何**改动前必跑，目标 < 60s。
  内容 = 三端口可达 + 文件域真渲染 + 统一下载快照契约。失败即停：不进 S2、不提交、不汇报。
- **S2 域回归**：只跑**被改域**的脚本，范围从 `verify/MANIFEST.md` 查表（脚本×域×档位）。
  新增脚本必须入表。
- **S3 全量**：只在发布前或用户点名时跑。交付汇报若未跑 S3，必须显式写「S3 未跑」。

AI 交付汇报只引用 S1/S2 的实际结果与耗时；「可能相关的脚本都跑一遍」属于未知流程处置，禁止。
