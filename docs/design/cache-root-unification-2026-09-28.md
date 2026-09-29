# TG 缓存落盘根统一 + 可删区判据多根兼容（施工图）

> 状态：**已定案，待批施工**。本文件不改动任何代码。
> 上游决策：`docs/review/pending-decisions-2026-09-22.md` **D3**（本轮拍板：**A + 多根兼容前置**）。
> 上游设计：`docs/design/telegram-cache-storage-redesign.md` §3.5 / §9 D3；
> `docs/design/blob-store-design.md` C1。
> 前置缺陷档：`docs/bugs/BUG-173.md`（`download_dir` 归**下载引擎域**；本图即其 T04 落地形态）。
> 约束来源：`AGENTS.md` §5（投递契约、缓存即入库、单向删除联动）、`docs/design/byte-ownership-amendment-2026-09-24.md` I1–I6。

---

## 0. 结论前置

| # | 结论 | 一句话理由 |
|---|---|---|
| **R1** | 缓存落盘根统一为**通用下载目录**（`download_dir`） | 与 §3.5 / C1 两条已裁定设计同向；TG 专属目录与之相抵 |
| **R2** | `ORIG_TG_DOWNLOAD_DIR` 的**默认值来源收敛到 `orig_core::paths::default_download_dir()`**，删除 `orig-tg` 侧手工拼接复制品 | 现状 3 处在算同一个值（壳注入 / orig-tg 手工拼 / DB `app_setting`），多源 = 多结论 |
| **R3** | **可删区判据必须支持多根**（`dir` + `lib_root` + **历史根**），不是「选一个根」 | 实测**双根裂缝已经存在**：37 条 TG 条目分属两个根。单根判据对区外条目**静默失效** |
| **R4** | **判据形态从 `bool` 改为三态**（`Owned{root}` / `External` / `Unresolvable`） | `inside_dir` 在 `canonicalize` 失败时返回 `false`，把「无法判定」与「确实在区外」混为一谈 —— 后者**永不删是安全的**，前者**永不删是静默故障** |
| **R5** | **存量绝对路径不改写**（不做数据迁移），改为**判据侧兼容** | 改 `file_path` 会让「已写进库的路径」与「磁盘实际位置」错位（BUG-104 §47 已裁「只影响新建，存量一律不动」） |

---

## 1. 现状实测（判据的唯一依据）

### 1.1 在产库指纹核对

| 候选库 | 大小 | `media_item` | `media_message` | 判定 |
|---|---|---|---|---|
| `%APPDATA%/com.origadmin.orighub/tg/store.db` | 4.0 MB | **137** | **3014** | **在产库** |
| `<repo>/tg_store.db` | 147 KB | 0 | 0 | 空壳（AGENTS.md §6 残留） |
| `%LOCALAPPDATA%/OrigHub/tg/store.db` | 479 KB | 0 | 1003 | 非在产 |

> ⚠️ **空壳库会给出「一切正常」的假象** —— 任何「现状如何」的判断都必须先过这一步指纹核对。

### 1.2 双根裂缝已既成事实

在产库 `source` 分布：`local` 94 / `tg` 43（其中 37 条有 `file_path`）。

| 落点 | 条数 | 归属 |
|---|---|---|
| `%APPDATA%\com.origadmin.orighub\tg\downloads\*` | ~36 | 壳注入的 **TG 专属目录** |
| `C:\Users\godcong\Downloads\doc--1001341930464_206934.mp4` | ≥1 | **通用下载目录** |
| `D:\test_videos\*`（`source=local`，94 条） | 94 | **用户自备素材，不属任何缓存根 —— 本图不受其牵连** |

⇒ **同一 `source='tg'` 集合分属两个根**。且 37 条**全是绝对路径**
（`cache.rs:79-86 resolve_item_path()` 注释自认「存量条目仍是绝对路径」）。

### 1.3 ★ 判据现状：四个调用点，**三种不同口径**（这才是真正的缺陷）

`inside_dir(dir, p) -> bool`（`cache.rs:217-231`）：`canonicalize(dir)` 失败**直接 `false`**；
成功则 `probe.starts_with(dir)`。

| # | 调用点 | 判定用的根 | 与「多根」的关系 |
|---|---|---|---|
| 1 | `cache.rs:292`（`/api/cache/items/:id/clear`，单条清） | **仅 `dir`** | ❌ **单根** —— 库根内条目与历史根条目全部落 `CONFLICT` 拒删 |
| 2 | `cache.rs:425 / 431`（`purge_item`） | `lib_root` **或** `dir` | ✅ **双根**（I3 让位已实现） |
| 3 | `cache.rs:790`（`clear_preview` 预览） | **仅 `dir`** | ❌ **单根** —— 与 #4 口径不一致 → **同一条目在预览与统计里数不一样** |
| 4 | `cache.rs:1075`（清理统计） | `dir` **或** `lib_root` | ✅ **双根** |
| 5 | `routes.rs:2678-2679`（`delete_media_item`） | `dir` **或** `lib_root` | ✅ **双根** |

**⇒ 同一套「谁拥有这段字节」的问题，在 5 个点上给出了 3 种答案。**
这不是「哪个根对」的问题，是**判据本身没有单一真源**。

**故障后果（可复现的静默失效）**：
- 走 #1（单条清）时，**库根内**的归仓条目恒被判「区外」→ 返回 `409 CONFLICT "file is outside the cache dir"`，
  用户点「清除」永远失败，且错误信息把责任归给「文件在缓存目录外」（**归因错误**）。
- 走 #3（预览）与 #4（统计）时口径不同 → **预览说可释放 N 个，实际清掉 M 个**（N≠M）。
- 走 #2/#4/#5 时缺**历史根**维度 → 落在 TG 专属目录的 ~36 条，在「改用通用下载目录」后
  全部落入区外 → 清理**静默跳过**、字节永不回收（`purge_item` 只计 `failed` 不报错）——
  **与 BUG-173 ④ 同型**。

---

## 2. 目标形态

### 2.1 单一根（R1/R2）

```
缓存字节的三个概念上不同的位置：

  download_dir   ── 通用下载目录（用户可改；**缓存字节的产出根**）
  library_root   ── 库根（归仓字节的所在；byte-ownership P2）
  historic roots ── 历史根（曾经是 download_dir，存量绝对路径指向它）
```

**R1**：新缓存字节一律落 `download_dir`（与 §3.5 的 `<download_dir>/.media-cache/`、
C1 的 `<download_dir>/blobs/` 同向）。

**R2**：默认值**唯一真源** = `orig_core::paths::default_download_dir()`。

| 现状来源 | 处置 |
|---|---|
| `orig-tg/src/config.rs:52-63` 手工拼 `HOME`/`USERPROFILE` | **删**，改委托 `orig_core::paths::default_download_dir()` |
| `tauri-shell/src-tauri/src/lib.rs:418/436-439` 注入 `ORIG_TG_DOWNLOAD_DIR` | **删**该注入（保留 `SESSION`/`DB` 等其余注入不动） |
| `app_setting.download_dir`（用户显式设置） | **保留**（它是「用户意志」，优先级最高，`cache.rs:59-69` 现状成立） |

优先级链保持现状（**不改**）：
`请求 dir` > `app_setting.download_dir` > `config.download_dir`(= `orig_core::paths` 默认)。

### 2.2 多根判据（R3/R4）

**新接口**（`cache.rs`，替换 `inside_dir`）：

```rust
/// 字节归属（三态，非布尔）。
///
/// 三态的理由：`inside_dir` 把「无法判定」（canonicalize 失败）与
/// 「确实在区外」都返回 false —— 后者永不删**是安全的**（外部文件不归我们），
/// 前者永不删**是静默故障**（我们拥的字节清不掉，却报成功）。
pub enum ByteOwner {
    /// 属于本系统，且落在某个已知根内。`root` 为其所属根（诊断用）。
    Owned { root: PathBuf },
    /// 外部文件（导入/扫描贴进来的用户文件）—— **永不删**。
    External,
    /// 无法判定（根不存在 / canonicalize 失败 / 路径不可解析）。
    /// **不得等价于 External**：清理必须**如实上报**这一态，不得静默跳过。
    Unresolvable { reason: String },
}

/// 判定入口：**所有**「这段字节能不能删」的问题都必须过这一个函数。
/// `roots` = 全部已知根（download_dir / library_root / 历史根）。
pub fn classify_bytes(roots: &[PathBuf], p: &str) -> ByteOwner;
```

**五处调用点全部改走它**，消除 §1.3 的三口径分叉：

| # | 调用点 | 改后行为 |
|---|---|---|
| 1 | `cache.rs:292` | `Owned{..}` → 允许删；`External` → `409`（**文案改为「外部文件，永不删除」**，不再说「在缓存目录外」）；`Unresolvable` → `500` + 原因（**不得 409 静默） |
| 2 | `cache.rs:425/431`（`purge_item`） | `External`/`Unresolvable` → `skipped` 分列计数（**两类分开**，见 §3.2） |
| 3 | `cache.rs:790`（预览） | 与 #4 **共用同一函数** → 预览与统计口径**逐条一致** |
| 4 | `cache.rs:1075`（统计） | 同 #3 |
| 5 | `routes.rs:2678` | `Owned{..}` → 删字节；其余二态 → 不动 |

**历史根**（`historic roots`）来源：**不新增表、不新增列** ——
由 `app_setting` 里**曾经出现过的 `download_dir` 值**构成是不可能的（只存当前值）。
因此历史根采用**显式清单 + 显式配置**（见 §3.3 的取舍说明）。

---

## 3. 施工任务

> 依赖顺序：`C1 → C2 → {C3, C4} → C5 → C6`。C1/C2 是其余任务的前置。

### C1. 默认值来源收敛（R2）

- **文件**：`download-engine/crates/orig-tg/src/config.rs`
- **改动**：`:52-63 default_download_dir()` 手写实现 → 委托 `orig_core::paths::default_download_dir()`；
  保留函数名与签名（调用点 `:45` 不变）。
- **删除**：`tauri-shell/src-tauri/src/lib.rs:418-419`（`dl_dir` 及其 `create_dir_all`）
  与 `:436-439`（`ORIG_TG_DOWNLOAD_DIR` 注入）。
  **⚠️ 只删这两处，其余注入（`API_ID`/`API_HASH`/`SESSION`/`DB`/`PROXY`）一律不动。**
- **验收**：`C1-A`（见 §4）。反向证伪：故意让 `orig_core::paths` 返回 `None`，
  必须**降级到 `.` 并 `tracing::warn!`**（BUG-071 的既有降级链），不得 panic、不得静默。
- **回归风险**：**中** —— 默认落点从 `%AppData%/…/tg/downloads` 变为 `~/Downloads`（或 `app_setting` 值）。
  **存量字节不搬**（见 C3）。

### C2. 判据函数替换（R4）

- **文件**：`download-engine/crates/orig-tg/src/cache.rs`
- **改动**：新增 `ByteOwner` 枚举 + `classify_bytes(&[PathBuf], &str)`；
  保留 `inside_dir` 但**降级为内部辅助**（仅供既有单测与需要布尔语义的边界场景），
  **新增生产调用一律走 `classify_bytes`**。
- **删除**：`inside_dir` 的**生产调用点**（§1.3 的 5 处）全部替换。
- **验收**：`C2-A` + `C2-B`（见 §4）。
- **回归风险**：**低** —— 纯判据重构，不改删字节动作。

### C3. 历史根支持（R3/R5）

- **背景（必须先读）**：存量 37 条绝对路径指向**两个**历史位置
  （TG 专属目录 ~36 条、通用下载目录 ≥1 条）。改默认根之后，这些条目的 `file_path`
  **不需要改**（R5），但判据**必须认得它们**，否则它们永远清不掉。
- **改动**：`classify_bytes` 的 `roots` 参数由调用方构造；

  **历史根清单来源（两种形态，择一）**：
  - **(a) 内置常量 + `app_setting` 可选覆盖**：把已知历史根（`<appData>/tg/downloads`）
    作为**内置候选**参与判定。零配置，但硬编码一个部署路径。
  - **(b) `app_setting` 新增 key `download_dir_historic`（JSON 数组）**：由迁移一次性写入
    当前 `config.download_dir` 的旧值。显式、可审计，但多一个 key（与 BUG-173 的
    「未登记 key 显式失败」契约联动，须同步登记）。

  > **取舍说明（不是待拍板项）**：本图**采用 (b)**，理由是与 `AGENTS.md` §四
  > 「保留所有数据 = 核心需求」一致 —— 历史根是**显式登记**的资产，不是隐式推断；
  > 且 (a) 的硬编码会在 D1-B（归入 daemon）形态下指向错误路径。
  > 该 key 须同步加入 BUG-173 的 `owner_of()` 常量表（归 **library.db** 还是 TG 库
  > **随 BUG-173 的 T02 一并裁定** —— 本图不擅自决定，标记为依赖）。
- **量化**：1 个新 key；影响 §1.3 的 5 个调用点（构造 `roots` 时追加历史根）。
- **验收**：`C3-A`（见 §4）。
- **回归风险**：**中** —— 若历史根清单为空且存量条目仍在旧位置，清理对其静默失效
  （**正是本次要修的问题**），故 C3 与 C1 **必须同批上线**，不可分批。

### C4. `Unresolvable` 的如实上报（R4 的落地）

- **文件**：`cache.rs` 的 5 个调用点 + 各自返回结构
- **改动**：返回体新增两个**分列**计数（与既有 `external` 并列，**不得合并**）：

  | 字段 | 含义 | 用户可行动信息 |
  |---|---|---|
  | `external` | 外部文件（**永不删，设计如此**） | 「N 个文件不属于缓存，不会删除」（既有语义，不变） |
  | `unresolvable` | 无法判定（根缺失 / canonicalize 失败） | 「N 个条目无法判定位置，未删除；请检查下载目录是否存在」 |

- **验收**：`C4-A`（见 §4）。反向证伪：把 `download_dir` 配成**不存在的路径**后清缓存，
  `unresolvable` 必须 **> 0**；若为 0 且 `ok:true`，则 C4 未生效（**假绿**）。
- **回归风险**：**低** —— 纯增量字段；但须同步前端展示（否则用户看不到）。

### C5. 预览与统计口径合一（消除 §1.3 的 N≠M）

- **文件**：`cache.rs:782-810`（`clear_preview`）、`cache.rs:1066-1084`（统计）
- **改动**：两处**共用同一个归类函数**，不再各写一遍 `inside_dir` 调用。
- **验收**：`C5-A`（见 §4）—— 预览的 `count/bytes` 与实际清理的 `removed/bytesFreed` 必须一致。
- **回归风险**：**低**。

### C6. 前端文案与状态

- **文件**：`tauri-shell/src/components/`（缓存管理面板）、`tauri-shell/src/i18n/locales/*.json`
- **改动**：
  - `unresolvable` 的分列展示（**仅在 > 0 时出现** —— 按 BUG-148「实现约束 ≠ 产品信息」，
    **不得做成常驻构件**）；
  - 修正 `cache.rs:295` 的 409 文案（「在缓存目录外」→ 区分「外部文件」与「无法判定」）。
- **回归风险**：**低** —— 但**必须同时验 happy path**（无可删条目时不得显示任何异常提示）。

---

## 4. 判据（每条含反向证伪）

> 反向证伪 = **换掉被验证的对象后必须 FAIL**，否则断言假绿（`MEMORY.md`「反向证伪是验收的验收」）。

| 判据 | 内容 | 反向证伪 |
|---|---|---|
| **C1-A** | 同时以「壳启动」与「daemon 启动」两种方式拉起后，`GET /api/config` 返回的 `download_dir` **逐字节相同** | 若两者不同 → FAIL（说明仍有第二处在算默认值） |
| **C2-A** | 对同一条目，5 个调用点给出的归属判定**完全一致**（构造一条库根内条目 + 一条下载目录内条目 + 一条外部条目，三态各一） | 若任一点与其判定不同 → FAIL（§1.3 的三口径分叉复发） |
| **C2-B** | `canonicalize` 失败（根不存在）时返回 `Unresolvable`，**不得**返回 `External` | 若返回 `External` → FAIL（把静默故障伪装成安全设计） |
| **C3-A** | 存量 37 条 TG 条目（含落在 TG 专属目录的 ~36 条与落在通用下载目录的 ≥1 条）**均可被清理**；`removed + skipped + external + unresolvable == selected` | 若任一存量条目既不在 `removed` 也不在任一分列计数中 → FAIL（静默漏项） |
| **C4-A** | `download_dir` 指向不存在路径时清缓存，`unresolvable > 0` 且**有可见提示** | 若 `unresolvable == 0` 而 `ok:true` → FAIL（假绿） |
| **C5-A** | 预览的 `count/bytes` == 实际清理的 `removed/bytesFreed`（同一次操作前后各取一次） | 若 N ≠ M → FAIL |
| **C6-A** | **happy path**：库中无可清理条目时，面板**不出现任何** `unresolvable` / 异常提示 | 若出现 → FAIL（BUG-148 常驻构件复发） |
| **C6-B** | 库根内条目走单条清（`/api/cache/items/:id/clear`）**必须成功**，返回不得为 409 | 若返回 409 → FAIL（§1.3 #1 的归因错误未修） |

**证据落盘要求**：判据须落在被 git 跟踪的入库路径（`download-engine/crates/orig-tg/src/` 的
`#[cfg(test)]` 或 `download-engine/verify/`）。仅 `verify_shots/` 引用不构成跨机器可核验证据。

### 4.1 拆库依赖（**不得绕过**）

`C3` 引入的新 key（`download_dir_historic`）必须**同时**登记进 BUG-173 的
`owner_of()` 常量表 —— 否则拆库后它会成为「未登记 key」，
按 BUG-173 的 A3 契约**运行期写入必须显式 `Err`**，
即：**C3 的新 key 会让拆库后的启动迁移拒绝写入**。

⇒ **依赖顺序**：`BUG-173 的 T02（归属机制）→ 本图 C3`。
若 BUG-173 未先做，C3 **必须**把该 key 一并写入其常量表，作为**同批改动**。

---

## 5. 不做的事（明确边界）

- **不迁移存量字节**（R5）：不改 `media_item.file_path`、不搬文件。
  归仓（byte-ownership P2）已有相对路径机制，存量绝对路径由其自然演进。
- **不新增产品行为**：本图只修「判据」与「默认值来源」，
  **不新增**清理档位、不新增通知、不改清理触发条件（`AGENTS.md` §四 / BUG-148）。
- **不动表结构**（除 C3 的 1 个 `app_setting` key）。
- **不改优先级链**（请求 > 用户设置 > 默认）。
- **不做**「清缓存顺便搬字节到新根」—— 那是另一个需求（归仓），不是本图范围。

---

## 6. 与既有文档的一致性

| 既有裁定 | 出处 | 本图是否一致 |
|---|---|---|
| 缓存落盘 = 下载目录 + 点前缀内部缓存目录 | `telegram-cache-storage-redesign.md` §3.5 / §9 D3 | ✅ R1 一致 |
| 落盘改内容寻址 `<download_dir>/blobs/…` | `blob-store-design.md` C1 | ✅ R1 一致（本图为其前置：先统根，再改布局） |
| 库根内字节一律跳过（I3 让位） | `byte-ownership-amendment-2026-09-24.md` I3 | ✅ C2 保留该语义，且**推广到全部 5 个调用点**（现状只有 3 处实现） |
| `download_dir` 归**下载引擎域** | `BUG-173.md`（用户 2026-09-28 裁定） | ✅ R2 与之一致；**且本图消除了 BUG-173 的 T04 TODO** |
| 「保留所有数据 = 核心需求」 | `AGENTS.md` §四 | ✅ C3 采显式登记历史根（不推断、不丢弃） |
| 实现约束 ≠ 产品信息 | `BUG-148` | ✅ C6 的 `unresolvable` 仅 > 0 时出现，不做常驻构件 |
| 判据必须打在真实调用链上 | `BUG-156` | ✅ §4 全部判据锚在 5 个真实调用点，非内层函数 |

---

## 附：本图为谁销账

| 销谁的账 | 方式 |
|---|---|
| `BUG-173` 的 T04（`download_dir` 落地形态） | R1/R2 定案并给出施工项 |
| `ingest-pipeline-assessment.md` §3.9（默认下载目录两份） | C1 收敛到单一真源 |
| `ingest-pipeline-assessment.md` §3.4（改过下载目录 → 旧字节永不删） | C3 历史根 |
| `ingest-pipeline-assessment.md` §3.5（目录不存在 → 清理全线静默失效） | C4 `Unresolvable` |
| `ingest-pipeline-assessment.md` §3.6（磁盘账三套口径） | C5 口径合一 |
| `docs/review/pending-decisions-2026-09-22.md` D3 | 本图即其施工落地 |
