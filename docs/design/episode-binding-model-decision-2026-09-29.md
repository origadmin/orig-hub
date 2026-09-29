# 挂载模型重估：选 A（继续加独立表）是否在堆债务？

> **建档日期**：2026-09-29
> **建档原因**：用户 2026-09-29 明确指令 ——
> > 「从扩展性,设计优雅考虑正确方案.不要历史债务堆叠.」
> 这是针对「剧集的多来源 / 多片段 / 挂图」这套数据模型提的。本文档**正面回答**：
> 我此前在 `episode-segment-model-2026-09-29.md` §2.3 推荐的 **A（新增独立表）** 是不是在堆债务。
> **本文档不重复** §2.2 那张代价对比表；它论证的是**趋势**与**此刻的真实代价差**。
> **只读**：本文所有在产库数字为 2026-09-29 只读实测（`%APPDATA%\com.origadmin.orighub\tg\store.db`），
> **未动在产库**；所有代码事实均带 `文件:行号`。

---

## 一、正面回答「A 是否在堆债务」

### 1.1 三张挂载表的**实际列**（逐列复核，来自 `media.rs` 建表段，非转引）

| 表 | 建表位置 | 实际列 | 唯一约束 | 角色（隐式） |
|---|---|---|---|---|
| `media_episode_source` | `media.rs:367-377` | `id` PK autoincr、`episode_id`、`item_id`、`created_at` | `item_id` UNIQUE；`UNIQUE(episode_id,item_id)` | 备用**版本**（video） |
| `media_episode_image` | `media.rs:389-396` | `episode_id`、`item_id`、`sort_no` DEFAULT 0、`created_at` | `PRIMARY KEY(episode_id,item_id)` | **浏览位**（photo） |
| `media_episode_segment`（将新建，设计 §4.1） | —— | `episode_id`、`item_id`、`seq`、`title`、`created_at` | `item_id` UNIQUE；`PK(episode_id,item_id)`；`UNIQUE(episode_id,seq)` | **片段**（video，有序） |

**共同结构（这就是「同形」的定义）**：三张表都是 `(episode_id, item_id, <排序位>, created_at)`。
它们**唯一的结构差异**是：

- **排序位的名字与约束**：source 无排序位；image 的 `sort_no`（可重复）；segment 的 `seq`（**集内唯一**）；
- **一个可选展示字段**：segment 的 `title`（source/image 没有）。

**关键事实：「角色」不是一列，而是「表名」。** `role ∈ {版本, 浏览位, 片段}` 这个语义在**数据里根本不存在**，
只存在于「这行在哪张表」。这是下面两条结构债务的根。

### 1.2 每新增一个角色要付的**固定成本**（按现有两表的实际足迹实测）

| 成本项 | `media_episode_source`（实测） | `media_episode_image`（实测） | 每角色 |
|---|---|---|---|
| 建表 DDL | 1（`media.rs:367`） | 1（`media.rs:389`） | 1 |
| 触发器 | 3（`video_only_ins/upd` `:542/:549` + `cleanup_sources` `:580`） | 3（`cleanup_episode` `:398`、`cleanup_item` `:405`、`photo_only_ins` `:419`） | **3** |
| 端点（`routes.rs`） | 3（`:132`/`:136`/`:140`） | 2（`:145`/`:149`） | **2–3** |
| Store 方法 | 3（`attach`/`switch`/`detach` `media.rs:2664/2696/2751`） | 4（`attach_images`/`add_image`/`detach_image`/`list_images` `:2768/2818/2836/2848`） | **3–4** |
| 前端 API 函数 | 3（`api/media.ts:486/494/502`） | 2（`:511/522`） | **2–3** |
| 前端组件 | 1（`SeriesDetail.tsx` 多源区） | 1（`EpisodeImagePickerDialog.tsx`） | 1 |
| 单测 | ≥3（`media.rs:5264/5467/5935`） | ≥1（`:6328` 相关） | **2–3** |

⇒ **每个新角色 ≈ 1 表 + 3 触发器 + 2.5 端点 + 3.5 Store 方法 + 2.5 前端 API + 1 组件 + 2.5 单测 ≈ 16 个改动点。**
第 4 个角色（音轨 / 字幕 / 多语言版本）来的时候，这 16 个点要**再付一遍**。

> **触发器的完整归属（episode 家族实为 8 个，逐条复核 `media.rs`；上表「每角色 3」只覆盖角色专属的 6 个）**：
> - **source 角色专属 3**：`trg_media_episode_source_video_only_ins` `:542`、`..._upd` `:549`、
>   `trg_media_episode_cleanup_sources` `:580`（挂在 `media_episode` 上清 source）；
> - **image 角色专属 3**：`trg_media_episode_image_cleanup_episode` `:398`、
>   `..._cleanup_item` `:405`（挂在 `media_item`）、`..._photo_only_ins` `:419`；
> - **`media_episode` 本体 item_id 类型约束 2**：`trg_media_episode_media_only_ins` `:526`、
>   `..._upd` `:534`（**上表未计入，本节补记**）。
>
> ⇒ **8 个里 6 个是角色专属、2 个是父表 `media_episode` 本体的 item_id 约束。**
> 这 2 个的存在**加强**了下面的 O(N²) 论点：绑定项的 item_id 类型约束不仅散在每张角色表上，
> **父表也要设卡** —— 类型约束的表达面随「绑定位置数」增长，不随角色数收敛。
> （另：`media.rs:5123` 的 `trg_media_episode_video_only_ins` 在测试模块内、`:674` 的
> `trg_media_series_cleanup_removed` 属 series，均不计入。）

### 1.3 真正的债务不在「表的数量」，在这两条（可量化、与数据量无关）

**(a) 跨角色不变量的成本是 O(N²)。**
「一个文件在全库只能有一种角色」这条不变量（我在 `episode-segment-model-2026-09-29.md` §1 已定为
「统一关系」在数据层的实质体现）在「角色 = 表名」的模型里，**只能靠每张表各写触发器去查其余表**来表达：
N 张表 ⇒ 每张表的 insert/update 都要查另外 N−1 张 ⇒ **N×(N−1) 个检查点**。

- 现状 2 张表（source / image）：这条不变量**根本没被表达** —— 所以一个 video 条目理论上能**同时**进 source 与 segment；
- 加 segment 变 3 张表：要补 **3 组**互斥检查（每张表查另外两张）；
- 加第 4 张：**4 组**，且每组要**回头改前面所有表**的触发器。

⇒ **这是 N² 的增长，与数据量无关。** 它不会因为「库里只有 28 行」而变小。

**(b) 读模型是 N 路 UNION，且「角色」要靠「来自哪张表」反推。**
统一读模型 `GET .../bindings` 要合成 M1（主）/ M2（版本）/ M3（片段）/ M5（挂图）⇒
存储层每多一张表，UNION 就多一路，且每路的列要**手工对齐**（source 无 seq、image 的 seq 叫 `sort_no`、
segment 的 seq 唯一）。因为「角色」不在数据里，**每次读都要靠「行来自哪张表」反推 role**。

### 1.4 正面回答

**是，选 A 是在堆债务 —— 但堆的不是「表多了一张」这种表面债务，而是上面两条结构债务（O(N²) 不变量 + N 路 UNION）。**

**而且真正的临界点不是「第 4 张表」，是「第 3 张表」**：1→2 张时还可以说「两个恰好同形的特例」；
**2→3 张时「同形」已经变成「模式」** —— 再往上就是「明知有模式却继续复制」。**我们现在正站在这个临界点上。**

**但是**：债务的**代价**必须与**此刻的真实数据**一起看。下面算清。

### 1.5 在「source 0 行、image 28 行」这个**具体时刻**，A 与 B 的真实代价差（量化）

| 维度 | A（加第 3 张表） | B（统一 `media_episode_binding`） | 差 |
|---|---|---|---|
| 新增表 | 1（segment） | 1（binding） | 0 |
| **改动既有表** | **0** | **2**（source、image 退役） | **+2** |
| **迁移行数** | **0** | **28**（image 28 + source 0） | **+28** |
| 新触发器 | 4 | 1–2（role 分支） | −2 |
| **重写既有触发器** | **0** | **8**（source 3 + image 3 + `media_episode` 本体 2） | **+8** |
| **改既有端点** | **0** | **5**（source 3 + image 2） | **+5** |
| 改既有 Store 方法 | 0 | 5（`:2664/2696/2751` + images 4 中的 3–4） | +4–5 |
| 改既有前端 API | 0 | 5（`media.ts:486/494/502/511/522`） | +5 |
| 改既有组件 | 0 | 2–3（`SeriesDetail.tsx`、`EpisodeImagePickerDialog.tsx`、`Lightbox.tsx`/`Deck.tsx`） | +2–3 |
| **重写既有单测** | **0** | **≥4**（`media.rs:5264/5467/5935/6328`） | **+4** |
| 迁移脚本 / 回滚脚本 | 0 | 1 + 1 | +2 |
| **回归面（已落地能力）** | **0** | **2**（BUG-039 多源、BUG-168 挂图） | **+2** |

**读数**：

- **A 的改动面 ≈ 11 个新增点**（1 表 + 4 触发器 + 3 端点 + 类型 + 组件），**零改动既有对象、零迁移**。
- **B 的改动面 ≈ 1 新表 + 改 2 表 + 8 触发器重写 + 5 端点改 + 5 Store 方法改 + 5 前端 API 改 + ≥4 单测重写 + 迁 28 行 + 1 套回滚**。
- ⇒ **此刻 A 的改动面约为 B 的 1/2 到 1/3；但 A 每加一个角色就要再付约 16 点，B 只付一次。**

**关键不对称（决定推荐的关键）**：

- **source 表 = 0 行**，且其前端入口**当前是坏的**（BUG-182 open：`SeriesDetail.tsx:583` 摘除按钮接错端点）
  ⇒ 把 source 并进 B **不损失任何在用的能力**（0 行 + 坏 UI）。
- **image 表 = 28 行、在用**（BUG-168 已落地，`EpisodeImagePickerDialog.tsx` 可用）
  ⇒ **B 唯一真实的回归面就是它。**

⇒ **B 的「贵」不在数据（只有 28 行），在代码（重写 8 触发器 + 5 端点 + 5 Store 方法 + 5 前端 API + ≥4 单测）。**

---

## 二、正确方案（给一个，不给清单）

### 2.1 推荐：**B —— 统一 `media_episode_binding` —— 但分 3 步走；第一步只做「读模型统一」，不动存储**

理由（按重要性排序）：

1. **用户要的是扩展性与优雅**：`role` 变成一列后，第 4/5 个角色 = **加一个枚举值**，不再付 16 点；
   跨角色不变量从 **O(N²) 降到 O(1)**（一个 role 分支触发器）。这是「不再堆叠」的唯一根治。
2. **此刻迁移代价最低**：source 0 行（且 UI 是坏的），image 28 行。
   **这是本项目历史上迁移成本最低的时刻** —— 每往后拖一轮（source 被用起来、segment 落地），B 的迁移面就更大。
3. **临界点已到**：2→3 张表就是「特例变模式」的那一步（§1.4）。

**目标表结构（B 的形制）**：

```sql
-- 单独 execute，绝不进建表批（BUG-032 铁律）
CREATE TABLE IF NOT EXISTS media_episode_binding (
    episode_id INTEGER NOT NULL,
    item_id    INTEGER NOT NULL,
    role       TEXT    NOT NULL,             -- 'alternate' | 'segment' | 'image'
    seq        INTEGER NOT NULL DEFAULT 0,   -- 片段=播放序；挂图=sort_no；备用源=0（无序）
    title      TEXT,                         -- 片段标题；备用源/挂图 NULL
    created_at INTEGER NOT NULL,
    PRIMARY KEY (episode_id, item_id, role)
);
-- 角色内全局唯一：一个文件只能是某一集的「备用源」或「片段」（挂图可挂多集）
CREATE UNIQUE INDEX IF NOT EXISTS idx_binding_item_unique_role
    ON media_episode_binding(item_id) WHERE role IN ('alternate','segment');
-- 片段序集内唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_binding_segment_seq
    ON media_episode_binding(episode_id, seq) WHERE role = 'segment';
CREATE INDEX IF NOT EXISTS idx_binding_episode ON media_episode_binding(episode_id);
```

- 角色内的**全局唯一**用 SQLite **部分唯一索引**表达（`WHERE role IN (...)`）—— 这是 B 相对 A 唯一「表达力下降」处，但**可表达**，不是不可表达。
- **跨角色互斥**只需**一个**触发器（查 `item_id` 是否已有别的 role），**O(1)**，不再 O(N²)。
- kind 约束（备用源/片段=video，挂图=photo）只需**一个** role 分支触发器，替代现有两个语义相反的表。

### 2.2 分步（每步都能单独停下且不留半成品）

**第一步（本轮，P0，纯增量、零迁移、零改既有表）—— 统一读模型 `GET /api/media/episodes/:id/bindings`。**
把 M1（主）/ M2（source）/ M3（segment，新）/ M5（image）合成**一个**有序列表，每项带 `role`。

- 数据来源：**直接 UNION 现有三张表**（source、image、新建的 segment），**不搬迁任何行**。
- 这一步**立刻兑现「前端只认一个结构」**，且**不碰** BUG-039 / BUG-168 的任何写路径。
- 收益：即便存储层暂时仍是三张表，**「角色」这个语义已被收敛到一处**（读模型），不再散在前端。

**第二步（B 的存储统一，P1，等第一步稳定后）—— 建 `media_episode_binding`，一次性搬迁 28 行。**

1. 先建新表（单独 `execute`，**绝不进建表批** —— **BUG-032**）；
2. `INSERT INTO media_episode_binding SELECT ... FROM media_episode_image`（28 行）
   + `... FROM media_episode_source`（0 行），**在同一事务内**；
3. 迁移后**保留旧表一版**（只读镜像）以防回滚，写路径切到新表；
4. **旧触发器必须显式 DROP**（**BUG-044**：`CREATE TRIGGER IF NOT EXISTS` 不刷新旧定义，也不会让另一个名字的旧触发器失效）。

**第三步（收尾）—— DROP 旧表与旧触发器 + 前端组件改读 `bindings`。**

**第一步为什么能「既收敛又不动太多」**：它只**加一个读端点**，不建表、不迁移、不改任何既有写路径；
而它已经消掉了「读模型 N 路 UNION」这条债务。**存储层的统一因此从「紧迫」降为「可排期」。**

### 2.3 「统一读模型能否与存储层解耦」——**明确表态**

**能，且这正是分步的基础。** 读模型统一后，三张表对前端「不可见」，存储的分散退化成**实现细节**，
不是用户可感知的债务；此时可以安全地把存储统一（第二步）排到第一步稳定之后。

**但不改变最终应收敛到 B 的判断** —— 因为 **O(N²) 的跨角色不变量成本仍在后端**，
只是暂时不外泄到前端。⇒ **读模型统一是「止血」，存储统一是「根治」；先止血，但不停在止血。**

### 2.4 若用户仍选 A（保留独立表）：**触发转 B 的可判定门槛**（不是感觉）

**满足以下任一条，即必须停止加表、转 B：**

1. **出现第 4 张挂载表**（音轨 / 字幕 / 多语言版本**任一被立项**）；
2. **跨角色不变量要覆盖 ≥3 个角色**（即需要写第 3 组互斥触发器时）；
3. **热路径出现 ≥3 路 UNION**（例如「播放准备」一次要同时读 source + segment + image）；
4. 单次改动中，**同一形状的 DDL / 触发器 / 端点模板第 3 次被复制**。

> 这四条都是**可判定**的（数表数 / 数触发器组数 / 数 UNION 路数 / 数模板复制次数），不是主观判断。

---

## 三、必须诚实登记的风险

### R1. B 要动 `media_episode_image`（28 行**真实数据**）—— 本轮唯一有真实数据的表

- **迁移失败后果**：`INSERT ... SELECT` 在事务内失败 ⇒ 回滚 ⇒ 28 行挂图**仍在旧表，不丢**；
  但**若写路径已切新表而迁移未提交**，会出现「新表空、旧表有」的窗口 ⇒ 前端挂图消失。
  ⇒ **迁移与写路径切换必须在同一事务 / 同一提交内完成。**
- **回滚手段**：
  1. 迁移前 `COPY` 一份 `store.db`（在产库只读副本）；
  2. 旧表**不立即 DROP**，保留一版作只读镜像，回滚 = 把写路径切回旧表；
  3. 迁移脚本自带逆操作（`INSERT INTO media_episode_image SELECT ... FROM media_episode_binding WHERE role='image'`）。
- **触发面（与 BUG-168 直接相关）**：B 要重写/审计 **8** 个 episode 家族触发器
  （6 个角色专属 + 2 个 `media_episode` 本体约束，见 §1.2 注）；其中 `trg_media_episode_image_*`
  3 个正是 BUG-168 的守门触发器（`photo_only_ins` 与两个 cleanup），并表时它们必须由 `role` 分支重写、
  且旧定义须**显式 DROP**（BUG-044）—— 这是本风险里最容易「改了没生效」的一处。

### R2. 可逆性论证（用户核心需求：**保留所有数据**）

- 迁移是 **28 行的 INSERT（纯复制，不删源）**，源行在切换成功前**始终存在**
  ⇒ **迁移本身可逆**（逆操作是同样的 INSERT，方向相反）。
- **唯一不可逆的是第三步的 DROP**：一旦 DROP 旧表，逆操作失去数据源。
  ⇒ **第三步必须晚于第二步稳定运行至少一个验证周期**，且 DROP 前再 `COPY` 一份库。
- **最坏情况**：全链路失败 ⇒ 丢弃新表、保留旧表 ⇒ **回到现状，0 数据损失**（因为源行从未被删）。

### R3. 半成品风险（分步的代价）

第一步（读模型）与第二步（存储统一）之间若中断，系统处于「前端读统一、后端仍分散」——
**这是可用且自洽的中间态**（`bindings` 端点 UNION 三表即可），不是半成品。
这是分步设计的**刻意选择**，不是疏漏。**但要求**：`bindings` 端点的 UNION 必须在第一步就覆盖**全部三种角色**
（含尚未落地的 segment 占位），否则第二步落地 segment 时前端要再改一次。

### R4. 数据不搬迁的角色（source）—— 诚实说明

source 表 **0 行**、且其前端入口当前是坏的（BUG-182）。**这不构成「并表无损」的充分理由** ——
它只说明**此刻**并表不丢数据。若在 B 落地前用户开始用多源（BUG-182 修复后），
source 就可能长出真实数据，届时第二步的迁移面会增大。**故 B 的迁移应尽早，不宜拖到 source 被用起来之后。**

---

## 四、待拍板项（2 条，decision-spec 六段九条）

> **依赖顺序**：D2 依赖 D1 的结论 —— **若 D1 选 C（不做），D2 无意义**。

### D1. 挂载模型的存储形态：继续加独立表（A），还是收敛到统一绑定表（B）？

- **问题**: 「一集 ↔ 多文件」的三种角色（备用源 / 片段 / 挂图）用**三张同形独立表**承载，还是收敛到**一张 `media_episode_binding`**（`role` 列）承载？
- **现状与代价**: 现状 `media_episode_source`（0 行）与 `media_episode_image`（28 行）是两张同形表（`(episode_id, item_id, 排序?, created_at)`，§1.1），「角色」只存在于表名；跨角色不变量成本 **O(N²)**（§1.3a），读模型是 **N 路 UNION**（§1.3b）。**不定**的代价：片段（T01）无法开工；且第 3 张同形表一旦落地，「特例变模式」即成事实，将来转 B 的迁移面更大。
- **设计锚点**: `docs/design/episode-segment-model-2026-09-29.md` §2.2/§2.3（原推荐 A）、`docs/design/episode-binding-model-decision-2026-09-29.md` §一/§二（本重估）
  - 冲突: **本项与 `docs/design/episode-segment-model-2026-09-29.md` §2.3 的「推荐 A」冲突** —— 本项按用户 2026-09-29「从扩展性 / 设计优雅 / 不堆债务」的新指令重估；若采纳 B，则原 §2.3 与 §4.1 的 segment 独立表设计作废。
- **请求**: 选 A 还是 B？

**A. 继续加第 3 张独立表 `media_episode_segment`（原推荐）**
- 涉及: `download-engine/crates/orig-tg/src/media.rs`（新表，`media.rs:367` 同款写法 + 4 触发器）、`download-engine/crates/orig-tg/src/routes.rs`（3 新端点）、`tauri-shell/src/api/media.ts`、`tauri-shell/src/components/media/SeriesDetail.tsx`
- 量化: 1 新表、4 新触发器、3 新端点、约 **11 个新增点**；**0 改既有表、0 迁移、0 改既有端点**
- 回归风险: **低** —— 纯增量，不碰 BUG-039 / BUG-168；但**结构性债务 +1**（第 4 个角色要再付约 16 点，跨角色不变量仍 O(N²)）
- 后果: 片段立即可用；表数量 → 3，同形表从「特例」变「模式」。**可逆**（删表回退，数据无损失）

**B. 收敛到统一 `media_episode_binding`（本文档推荐）**
- 涉及: `download-engine/crates/orig-tg/src/media.rs`（新表 + 迁移 `media_episode_source`/`media_episode_image` + 重写 8 触发器 + DROP 旧表）、`download-engine/crates/orig-tg/src/routes.rs`（5 端点改语义）、`tauri-shell/src/api/media.ts`（5 函数）、`tauri-shell/src/components/media/SeriesDetail.tsx`、`tauri-shell/src/components/media/EpisodeImagePickerDialog.tsx`
- 量化: 1 新表、**迁移 28 行**（image 28 + source 0）、重写/审计 **8** 个 episode 家族触发器（6 个角色专属须重写 + 2 个 `media_episode` 本体 item_id 约束须回归验证）、改 5 端点 + 5 Store 方法 + 5 前端 API、重写 ≥4 单测、1 套回滚脚本
- 回归风险: **中高** —— 直接重动 BUG-168（挂图，28 行真实数据、在用）；BUG-039（多源）0 行且 UI 当前坏（BUG-182），故其回归面 ≈ 0；`video_only`/`photo_only` 两个语义相反的触发器并表后须由 role 分支重写，旧定义须显式 DROP（BUG-044）
- 后果: 跨角色不变量降到 O(1)，第 4 个角色 = 加枚举值；表数 −1。**数据可逆**（迁移是复制不删源）；**DROP 后不可逆**（故 DROP 须延后一步，见 D2）

**C. 不做（维持现状：只有 source + image 两张表，不新增片段）**
- 涉及: 无
- 量化: 0 改动
- 回归风险: 无新增（但既有问题保留）
- 后果: 片段需求无法实现；用户继续把 Part1/Part2 编成两集 ⇒ 集号被挤占、整集连播在 Part1/Part2 之间弹「下一集」倒计时。只要用户还有「一集两个视频」的内容就会反复撞到；届时仍需付同样的建模成本，且 source 若在此期间被用起来，B 的迁移面更大

---

### D2. 迁移节奏：是否采纳「先统一读模型、后统一存储」的三步走，以及第三步 DROP 的时点？

- **问题**: 收敛到 B 是「一次性大爆炸」，还是「先读模型统一（本轮）→ 存储统一（稳定后）→ DROP 旧表（再后）」三步走？
- **现状与代价**: B 的代码回归面（8 触发器 + 5 端点 + 5 Store 方法 + ≥4 单测）压在**刚落地**的 BUG-168 上（§三 R1）。一次性做完 ⇒ 回归面与迁移面**叠加在同一个提交**，出问题难二分定位。**不定** ⇒ 无法决定本轮先交付什么、BUG-168 何时算「稳定」、DROP 何时可做。
- **设计锚点**: `docs/design/episode-binding-model-decision-2026-09-29.md` §2.2（分步）、§三（可逆性）
- **请求**: 选 A 还是 B？

**A. 三步走（本文档推荐）**
- 涉及: `download-engine/crates/orig-tg/src/routes.rs`（第一步新增 `bindings` 端点）、`download-engine/crates/orig-tg/src/media.rs`（第二 / 三步）
- 量化: 第一步 1 端点、0 迁移；第二步迁移 28 行 + 1 套回滚；第三步 DROP 2 表 + 退役 8 个 episode 家族触发器
- 回归风险: **低** —— 每步独立可停；中间态「前端统一 / 后端分散」自洽可用
- 后果: 本轮交付面小、可随时停；根治延后一个周期。**可逆**（DROP 前全程可回退）

**B. 一次性大爆炸（同一提交建表 + 迁 28 行 + 改全部端点/触发器 + DROP 旧表）**
- 涉及: `download-engine/crates/orig-tg/src/media.rs`、`download-engine/crates/orig-tg/src/routes.rs`、`tauri-shell/src/api/media.ts`、`tauri-shell/src/components/media/SeriesDetail.tsx`、`tauri-shell/src/components/media/EpisodeImagePickerDialog.tsx`
- 量化: 1 次提交覆盖 28 行迁移 + 8 触发器 + 5 端点 + ≥4 单测；**0 个可停点**
- 回归风险: **高** —— 迁移面与回归面叠加，BUG-168 一旦被拖坏与迁移失败难区分
- 后果: 一步到位、表最干净；但出问题无法二分定位。**DROP 后不可逆**

**C. 不做（本轮不碰存储统一，只按 D1 选 A 加独立表）**
- 涉及: 无
- 量化: 0 改动
- 回归风险: 无新增
- 后果: 结构债务保留；第 4 个角色出现时被迫转 B，届时迁移面更大

---

## 附：本文档与既有文档的关系

| 文档 | 关系 |
|---|---|
| `episode-segment-model-2026-09-29.md` §2.2/§2.3 | **本文档重估其推荐**：§2.3 推荐 A；本文档按用户新指令重估，推荐 **B + 分步**。若采纳 B，原 §4.1（segment 独立表）作废，改由本文档 §2.1 的 `binding` 表承载。 |
| `episode-segment-model-2026-09-29.md` §4.2（4 触发器） | 若采纳 B，触发器改为 §2.1 的 role 分支形制（数量 4→1~2）。 |
| `episode-segment-model-2026-09-29.md` §5.1（读模型 `bindings`） | **保留并前移为第一步**：无论 A/B，读模型统一都独立成立。 |
| `episode-multi-source-design-2026-09-22.md` | 其「source = 备用版本」语义被本文档 §2.1 的 `role='alternate'` 吸收；其 `PrimaryPicker` 若 B 落地则改为 `WHERE role='alternate'` 单条件。 |
| `docs/bugs/BUG-032.md`（纪律） | 第二步建表必须单独 `execute`，不进建表批。 |
| `docs/bugs/BUG-044.md`（纪律） | 第二步退役旧触发器必须**显式 DROP**。 |
