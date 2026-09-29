# 媒体服务部署形态决策（BUG-172 前置）

> 触发：用户 2026-09-28 追问「媒体服务未运行」背后的设计逻辑，并追加要求：
> **评估媒体服务应该是「插件（单独服务）」还是「hub 的功能（内置服务）」。**
>
> 定位：本次**不是**新立架构主张。`docs/MEDIA-DESIGN.md` §0 早已裁定 M3 媒体库的
> 禁区是「**不依赖 TG 会话**」，`docs/review/media-tg-review-2026-09-22.md` 早已裁定
> 「媒体库是独立核心模块；Telegram 只是一个可替换采集/传输通道」。
> **本决策要定的是：把这个既定职责，落到哪种部署形态上。**
>
> 关联缺陷：`docs/bugs/BUG-172.md`（open / critical）。

## 0. 前置事实（本次实测，均为仓内可复核证据）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `media.rs`（6576 行）对 TG 客户端引用次数 = **0** | `grep -c "st\.client\|self\.client\|state\.client" media.rs` → `0` |
| F2 | `media.rs` 全部外部依赖仅 6 项：`std` / `libsql` / `serde` / `crate::cache` / `crate::store` | `media.rs:10-18` 的 `use` 段，**无任何 TG 类型** |
| F3 | `cache.rs`、`store.rs` 同样对 TG 客户端引用 = **0** | 同上 grep，两文件均 `0` |
| F4 | 媒体库路由**不做 `ensure_authorized`** | `routes.rs:82` stats 注册点无鉴权；TG 端点 `:348/:450/:577/:612/:651/:816/:1060` 全有 |
| F5 | 二进制体积：`orig-tg.exe` **12.23 MiB** vs `orig-daemon.exe` **7.23 MiB**，差 **5.00 MiB** | `download-engine/target/release/` 实测；差值即 grammers/MTProto/crypto 栈 |
| F6 | 前端以 **HTTP `fetch`** 访问媒体库（非 Tauri `invoke`） | `api/media.ts:195`、`:359` |
| F7 | 媒体库面板已存在**正确**的产品语义文案，未被使用 | `media.sourceOfflineHint`「来源服务未连接（{sources}）：库内内容照常可播可管理，仅「重新缓存」暂不可用。」 |

**F1–F4 合起来说明**：媒体库在代码层已完全脱离 TG，四个文件（`media.rs`/`cache.rs`/`store.rs`/媒体路由）
构成一个自洽的、只依赖 SQLite 的模块。**它不缺少解耦，它缺少自己的运行位置。**

**F5 是本次反直觉的关键**：媒体库自身几乎不需要 TG 那 5 MiB 依赖栈。
任何「为媒体库单开进程」的方案，都要先回答**这 5 MiB 是否值得**。

---

## 决策项

### D1. 媒体服务应作为「可插拔独立服务」还是「hub 内置能力」？

- **问题**: 媒体库应以哪种部署形态存在——**独立进程（插件式）**、**归入 orig-daemon（内置服务）**、
  **壳内嵌（子线程/同进程 API）**，三者选哪个？
- **现状与代价**: 现状是第四种、且是唯一没人主动选过的形态——**寄宿在 TG 进程里**。
  于是「媒体库可用」被等价为「`orig-tg` 在跑」，而未绑 TG 的用户永远起不来 `orig-tg`
  （`lib.rs:407` 以凭证为前置），自愈又拉错服务（probe 9877 / ensure 9876）。
  不定 → BUG-172 无法进入实现，且「重试按钮该拉起谁」永远无解（`media.offline` 语义不拆）。
- **设计锚点**: `docs/MEDIA-DESIGN.md` §0（M3 媒体库禁区 = **不依赖 TG 会话**）
  - 冲突: 无冲突。本决策是**执行**该锚点；现状（寄宿 TG 进程）才是对它的**违反**。
  - 补充锚点: `docs/review/media-tg-review-2026-09-22.md`（「TG 只是可替换通道」）、
    `docs/design/byte-ownership-amendment-2026-09-24.md`（库根与归仓 = 库侧的字节所有权）
- **请求**: 选 A、B、C 还是 D？

---

**A. 独立进程（真插件式）：新建 `orig-media` sidecar，`/api/media/*` 迁入**

- 涉及: `download-engine/crates/orig-media/`（**将新建**）、
  `download-engine/crates/orig-tg/src/{media.rs,cache.rs,store.rs,routes.rs}`（迁出）、
  `tauri-shell/src/api/media.ts`（base 改指向新端口）、
  `tauri-shell/src-tauri/src/lib.rs`（新增 `spawn_media`）、`scripts/sync-sidecars.sh`（sidecar 清单 +1）
- 量化: 移出约 **10k 行**（media 6576 + cache 1402 + store 1763 + 媒体路由段）；
  第 4 个 sidecar 二进制（另增约 7–12 MiB 磁盘占用）；
  **需新增一份 SQLite 连接归属决策**——库库（`store.db`）当前由 `orig-tg` 持有
- 回归风险: **高** — ①`serve_local_file` 投递契约（BUG-031/033，`/api/media/items/:id/raw` 与
  `/api/tg/local/:chat/:msg` **必须共用**）被**物理切断**，需改为跨进程共享或抽公共 crate；
  ②`store.db` 单写者假设被破坏（两个进程同开一库）；③`sync-sidecars.sh` 四处副本同步链 +1 处
- 后果: 媒体库获得**最长时的可用性保证**（无任何前置条件即可启动）；
  代价是一个真插件所需的全部基础设施（跨进程契约、库写权、投递共用）。
  **部分可逆**（迁回成本 ≈ 迁出成本，但投递契约改动需再改一次）

**B. 归入 `orig-daemon`（hub 内置服务）：`/api/media/*` 挂在 9876**

- 涉及: `download-engine/crates/orig-daemon/src/routes.rs`（挂载媒体路由）、
  `download-engine/crates/orig-tg/src/{media.rs,cache.rs,store.rs}`（迁为共享 crate）、
  `tauri-shell/src/api/media.ts:11`（`MEDIA_BASE` 由 `TG_BASE` 改为 `DAEMON_BASE`）
- 量化: 移出约 **10k 行**；**不新增进程、不新增二进制**（daemon 已随应用启动且**无凭证前置**）；
  `tauri-shell/src/api/media.ts:11` **一行**完成前端改向
- 回归风险: **中** — ①daemon 与 orig-tg 将**同写 `store.db`**，需先解决单写者
  （或把库文件归属明确给 daemon，orig-tg 经 HTTP 访问）；
  ②daemon 启动期不得引入新前置条件（否则等于把 TG 门禁换成另一个门禁）
- 后果: 媒体库**随应用必然可用**（daemon 已无凭证前置，是现状唯一不需门禁就能起的后端）；
  复用 `orig-daemon` 既有的 sidecar 托管、`sync-sidecars.sh` 条目、`probe_media.py` 验收链。
  **可逆**（改 base 与挂载点即可回退）

**C. 壳内嵌（子线程 / 同进程 API）：作为 Tauri 壳的内部能力**

- 涉及: `tauri-shell/src-tauri/src/lib.rs`（内嵌媒体路由）、
  `download-engine/crates/orig-tg/src/{media.rs,cache.rs,store.rs}`（改为被壳依赖的 crate）、
  `tauri-shell/src/api/media.ts:195`（`fetch` 改 `invoke`）
- 量化: 移出约 **10k 行**；**零新增进程**（但壳进程体积**增加**媒体模块 + libsql）；
  前端调用形态从 HTTP `fetch` 改为 Tauri `invoke`（按 F6，**全部调用点需改写**）
- 回归风险: **高** — ①`agent-browser` / `verify/` 下的 UI 验收链**全部依赖 HTTP 可达**
  （`MEMORY.md`：验收走 headless Edge + CDP 取 DOM，后端需 `curl` 可探），
  改 `invoke` 后**验收通道失效**，等于自毁验收能力；
  ②`serve_local_file` 的 Range/206/背压契约需在 Tauri IPC 上**重新实现一遍**
  （BUG-031/033 的全部断言作废）；③壳崩溃 = 媒体库崩溃，可用性反而**下降**
- 后果: 对**纯壳内**能力确实最省事，但对**媒体库这种需要被播放器 `<video>` 直接
  以 URL 拉流**的模块是错配——`<video src=...>` 无法走 `invoke`。
  **高度可逆性差**（IPC 契约与 HTTP 契约不可互换）

**D. 不做（维持现状：媒体库继续寄宿在 `orig-tg`）**

- 涉及: 无
- 量化: 0
- 回归风险: 无新增（但 BUG-172 的 J1/J2/J3 三条判据继续全部成立）
- 后果: 未绑 TG 的用户**永久进不去媒体库**；TG 失效时本地库被误报为「媒体服务未运行」；
  自愈按钮继续拉错服务。**这不是稳定的中间态**——每新增一个来源
  （OSS/S3/网盘，`mediaSources.ts` 已支持该抽象）都会再叠一层同类问题，
  届时仍要回来做本决策，且届时改动面更大

---

### D2. 媒体库与 TG 是否应从同一个 `store.db` 拆成两个库？

- **问题**: `media_*` 表（库域）与 `media_message`/`monitored_channel`/`sync_cursor`/`dialog_cache`/`cache_task`（TG 域）
  现同住 `store.db`，应**继续共库**还是**拆为两个库文件**？
- **现状与代价**: 现状是**一个库装两个域**，`store.rs:361` 的注释原文即承认这是临时安排：
  > `// 媒体资料库（内容/剧集/标签）：与 TG 流水同库、职责分离。`

  `media.rs:220` 亦写「与 TG 流水表同库，表名统一 `media_*` 前缀但语义独立」。
  **同库不构成 BUG-172 的主因**（TG 只是不启动、不删库；库文件本身不依赖 TG 进程），
  但它**构成 A/B 两方案的实现前置**：媒体服务的拥有者变成 daemon 后，
  若仍共库，就出现两个进程同写一个 SQLite 文件。不定 → A/B 无法落实现。
- **设计锚点**: `docs/MEDIA-DESIGN.md` §0（M3 边界 = 媒体库的唯一事实源，**禁区：不依赖 TG 会话**）
  - 冲突: **现状违反该边界的"物化"层面**——边界已在表命名与模块划分上体现（`media_*` 前缀独立、
    `media.rs` 零 TG 依赖），却在**存储物理层**未落。这是"逻辑已分、物理未分"。
- **请求**: 选 A、B 还是 C？

### 前置技术事实（本次实测）

**F8｜daemon 目前没有自己的库**：`grep "\.db|sqlite|Store::open" orig-daemon/src/*.rs` 仅 1 处命中——
`orig-daemon/src/state.rs:163` `cmd.env("ORIG_TG_DB", data_dir.join("tg/store.db"))`，
**是 daemon 把库路径注入给 orig-tg 子进程**，daemon 自身不持有任何 SQLite 连接。
⇒ 若媒体服务归入 daemon，**要么 daemon 新开这个库（→ 双写者），要么拆库**。

**F9｜跨域读取实际点共 4 处（全部为「库→TG」单向）**：

| 位置 | 所属函数 | 读什么 |
|---|---|---|
| `media.rs:48` | `caption_of_ref()` | `media_message.caption` |
| `media.rs:3502` | `collect_hash_tags()` | `media_message.caption` |
| `media.rs:3532` | `first_caption()` | `media_message.caption` |
| `media.rs:3465` 附近 | （`set_series_tags` 邻域） | `media_message.caption` |

**全部 4 处只读一个字段：`media_message.caption`**，且都是「TG 来源条目的标题/介绍回填」用途。
**反向（TG 读 `media_*`）为 0 处**——`media_message` 表结构里没有任何 `media_*` 引用。
⇒ 跨域耦合是**窄而单向**的，这是拆库成本可控的关键依据。

**F10｜两域表清单**：

- **TG 域**（`store.rs:302-353`）：`monitored_channel`、`media_message`、`sync_cursor`、
  `dialog_cache`、`cache_task`
- **库域**（`media.rs:224-389, 630`）：`media_item`、`media_series`、`media_episode`、
  `media_tag`、`media_item_tag`、`media_series_tag`、`media_episode_source`、
  `media_episode_image`、`media_episode_removed`
- **共享**：`app_setting`（键值表，**两域都用**——`library_dir`/`download_dir` 在库域，
  其余设置属 TG 侧；这是拆库时唯一需要裁定的共享资产）

**选项**

**A. 拆为两库（`tg_store.db` + `library.db`）**
- 涉及: `download-engine/crates/orig-tg/src/store.rs`（库域表迁出 + `app_setting` 分流）、
  `download-engine/crates/orig-tg/src/media.rs`（4 处跨域读改走新连接/新库）、
  `download-engine/crates/orig-daemon/src/state.rs:163`（新增库路径注入）、
  `tauri-shell/src-tauri/src/lib.rs`（sidecar env 增参）
- 量化: 迁 **9 张库域表** + 1 张共享表分流；4 处跨域读取点需改造；
  **1 次数据迁移**（存量 `store.db` 的 `media_*` 行需搬到新库，且必须可回滚）；
  新增 1 个库文件
- 回归风险: **中** — ①迁移必须幂等且保留原库（`AGENTS.md` §四「保留所有数据 = 核心需求」，
  宁留多余不删）；②`app_setting` 分流若切错，`library_dir`/`download_dir` 读取会静默回默认值
  （直接触发 BUG-172「假空库」隐患）；③`caption_of_ref` 等 4 处改造后，
  存量条目的标题回填行为必须保持逐字节一致
- 后果: 两域**物理隔离**，媒体库拥有自己的库文件——**B 方案的"随应用必然可用"才真正成立**
  （否则 daemon 起来了但没有库可读）。可逆（保留原库即可退回）

**B. 不拆，共库 + 单写者裁定（daemon 独占库，orig-tg 经 HTTP 访问）**
- 涉及: `download-engine/crates/orig-daemon/src/state.rs:163`、
  `download-engine/crates/orig-tg/src/routes.rs`（TG 侧库访问改 HTTP 调用）
- 量化: **0 次数据迁移**；但需新增 **1 组跨进程库访问端点**（TG 域的全部读写要么代理、
  要么上移到 daemon）；orig-tg 的 `store.rs` 1763 行访问路径需评估改造面
- 回归风险: **高** — TG 域读写极其密集（`media_message` 是流水账、`sync_cursor` 每轮同步写、
  `cache_task` 高频更新），改 HTTP 后**同步吞吐与延迟均受影响**；
  且 `AGENTS.md` §5「被轮询的读端点不许碰 DB（内存快照）」类约束会与代理端点冲突
- 后果: 无迁移风险，但把「同库」问题换成了「跨进程高频访问」问题，
  可能比拆库更贵。**部分可逆**

**C. 不拆，也不改写者（维持共库 + 维持现状）**
- 涉及: 无
- 量化: 0
- 回归风险: 无新增（但 SQLite 双写者风险保留：daemon 与 orig-tg 同开一个 `.db` 文件，
  当前 `libsql` 连接未做跨进程锁协调，写冲突表现为偶发 `SQLITE_BUSY` 或数据竞争）
- 后果: **B 方案无法安全落地**（媒体服务拥有者若为 daemon，必然形成双写者）。
  若最终选 D1-A（独立 orig-media 进程），同样面临双写者问题。
  **即：C 实际等于否决了 D1 的 A 与 B 两个选项**，只剩壳内嵌（C）与维持现状（D）

---

## 分析结论（供拍板参考，非代替拍板）

**关于 D2 —— 本项实际是 D1 的前置，建议先定。**

`store.db` 里住着两个域的共 **14 张表**（TG 域 5 张 + 库域 9 张，另 `app_setting` 共享），
而「同库」这件事**项目自己就标注为临时安排**（`store.rs:361` 注释：
「与 TG 流水同库、职责分离」；`media.rs:220`：「与 TG 流水表同库，表名统一 `media_*`
前缀但语义独立」）。

**「逻辑已分、物理未分」是本项的精确定位**——表名有 `media_*` 前缀、模块有
`media.rs` 零 TG 依赖、路由不做 `ensure_authorized`，唯独**存储物理层没落**。
因此「TG 与 daemon 各管一个库」不是新主张，是把已记录在案的分工**补完**。

**D2 与 D1 的联动（关键）**：

| 若 D1 选 | 则 D2 必须 |
|---|---|
| B（归入 daemon） | **必须先做 D2-A（拆库）**，否则 daemon 与 orig-tg 形成双写者 |
| A（独立 orig-media 进程） | 同样**必须先做 D2-A**，理由相同 |
| C（壳内嵌） | 亦须 D2-A（壳与 orig-tg 仍会双写） |
| D2-C（不拆不裁） | **实际等于否决 D1 的 A、B 两选项** |

拆库成本**可控**，依据是跨域耦合**窄且单向**：4 处读取点全部只读
`media_message.caption` 一个字段，反向引用为 0（见 F9）。

**关于 D1（部署形态）——「插件 vs 内置」是伪二选一**，因为 A（真插件）被两个物理事实削弱：

1. **F5 的体积账**：媒体库几乎不用 TG 依赖栈（`media.rs` 对 TG 引用 = 0，
   而 TG 栈独占 5.00 MiB），却要为一个独立进程付出跨进程契约、
   库写权仲裁、`serve_local_file` 共用契约的重建成本；
2. **投递契约的硬约束**：按 `AGENTS.md` §5，`/api/media/items/:id/raw` 与
   `/api/tg/local/:chat/:msg` **必须共用 `serve_local_file`**（BUG-031/033 的全部断言
   建立在此之上）。A 把这个「必须共用」变成了**跨进程**问题。

**C（壳内嵌）可直接排除**：媒体库的核心消费方式是 `<video>` 以 URL 拉流
（`api/media.ts:214` 生成 `/api/media/items/{id}/raw` 给播放器），
`invoke` 无法服务 `<video src>`；且会摧毁现有 HTTP 验收链。

**推荐路径：D2-A（拆库）→ D1-B（归入 `orig-daemon`）**，理由可验证：

- `orig-daemon` 是**现状唯一无需任何凭据前置就能启动的后端**（`ensure_daemon` 无门禁），
  媒体库放这里 = **随应用必然可用**，直接满足 BUG-172 的 P1；
- 拆库后媒体库拥有自己的库文件，**无跨进程写权争议**；
- 不新增进程、不新增二进制，前端**一行**改向（`media.ts:11`）；
- 复用既有的 sidecar 同步与验收链，回归面最小。

**若你要「可插拔」的架构纯洁性，选 D1-A**——但须接受先解决
`serve_local_file` 跨进程共用，且**仍须先做 D2-A 拆库**；
建议作为 D1-B 之后的演进目标，而非第一步。

> **另注（与 D1/D2 正交）**：无论选哪个，`media.offline` 都应拆成
> 「库不可用」与「服务不可用」两条状态——否则「重试」按钮该拉起谁的语义
> 仍然无法定案（见 BUG-172「次因 B」）。

## 与既有设计的一致性核对

| 既有裁定 | 出处 | 本决策是否一致 |
|---|---|---|
| M3 媒体库禁区 =「不依赖 TG 会话」 | `docs/MEDIA-DESIGN.md` §0 | ✅ A/B/C 均一致；**现状 D 违反** |
| 「媒体库是独立核心模块；TG 只是可替换通道」 | `docs/review/media-tg-review-2026-09-22.md` | ✅ A/B 一致；C 部分（可用性寄于壳） |
| 归仓 = 移动；库根持有字节所有权 | `docs/design/byte-ownership-amendment-2026-09-24.md` | ✅ 三选项均不改所有权模型 |
| `/api/media/items/:id/raw` 与 `/api/tg/local/*` 必须共用 `serve_local_file` | `AGENTS.md` §5（BUG-031/033） | ⚠️ **A 需特别处理**（跨进程共用）；B 无碍 |
