# BitTorrent 扩展需求评估（2026-09-29）

> **性质**：需求评估 + 缺陷登记前置文档。**不改任何产品代码**。
> **登记**：`docs/bugs/BUG-174.md`（本文件是其根因/复现/范围依据）。
> **用户口径**（2026-09-29）："新的需求 BT 支持，种子，磁链，DHT，等等，评估下需求，添加 BUG。
> **这是下载的功能扩展。**"
>
> **归属裁定**：BT 属**下载引擎域**（`orig-daemon` + `orig-core`），
> 与 TG（`orig-tg`）无耦合。依据：AGENTS.md §5「投递契约」把下载能力置于引擎侧；
> 铁律 5（`orig-daemon/src/activity.rs:435`「9877 挂掉时普通下载任务必须照常返回」）
> 证明下载能力不依赖 TG；`orig-core/src/protocol.rs:3` 头注释原文即为
> 「**关键演进：为支持 HTTP+BT 混合下载**」——BT 早在协议抽象层设计时就是预留目标。

---

## 0. 结论前置

| # | 结论 | 依据 |
|---|---|---|
| **B1** | **协议层已为 BT 预留完整接口，无需改动抽象**。`SourceKind::Bittorrent`（`protocol.rs:270`）、`CapabilitySet::DHT`（`:44`）、`CapabilitySet::MULTI_NODE`（`:46`）、`CapabilitySet::PINNING`（`:48`，"BT 做种/长效保活（Orig 产品特性）"）全部**已存在且未被任何实现使用**。 | 逐符号核对，见 §2.1 |
| **B2** | **但「一个任务 = 一个输出文件」的模型与 BT「一个种子 = 多文件」根本冲突**，这是本扩展的**真正工作量所在**，不是协议实现。`Task` 持有单一 `output: PathBuf`（`engine.rs:220`）、单 `BlockMap`（`:222`）、单 `final_hash`（`:231`）。 | `engine.rs` 全读，见 §2.2 |
| **B3** | **引擎主循环可原样复用**：BT 只需实现 `Source::fetch_block`（把 block 映射到 piece 并向 swarm 请求）。`engine.rs:17` 原文承诺「引擎只跟 `Source`/`BlockMap` 对话，不感知具体协议——**加 BT 不改这里**」。该承诺对**单文件种子**成立，对多文件种子**不成立**（见 B2）。 | `engine.rs:17` vs `engine.rs:220-238` |
| **B4** | **`magnet:` 是 URI scheme，`.torrent` 是本地文件**，二者入口语义不同。当前 `Registry::find_by_scheme`（`registry.rs:23`）只支持 URL scheme 分派，**无「本地文件 → 协议」入口**。 | `registry.rs` / `routes.rs:140-149` |
| **B5** | **DHT 是进程级长生命周期组件，不是 per-task 资源**。当前引擎每任务建 `Source`（`routes.rs:292`），无跨任务共享的 swarm/DHT 状态。DHT 节点表、peer 发现、端口监听都需要**单例 + 启动期初始化**，与「任务即 Source 集合」的当前结构不同构。 | 见 §2.4 |
| **B6** | **做种（seed）是产品能力而非技术能力**：`CapabilitySet::PINNING` 注释写明「Orig 产品特性」，而 `docs/bugs/BUG-082.md:121` 曾裁定「已做种/种子 → 不做」。**该裁定已由用户 2026-09-29 变更为「立为能力」**（见 §5 D1），须修订 BUG-082。注：BT 规约**不要求**客户端做种，纯 leech 亦合规——做种是**策略选择**，非合规必需。 | `docs/bugs/BUG-082.md:121` vs `protocol.rs:48`；§5 D1 |
| **B7** | **零新增依赖的现状**：`download-engine/Cargo.lock` 中**无任何** torrent/magnet/DHT/bencode 相关 crate（实测 grep 全空）。BT 实现需引入 crate（`librqbit` 或 `cratetorrent` 等），**这是本仓首个非 HTTP 网络栈依赖**，须走依赖评审。 | Cargo.lock 实测 |
| **B8** | **前端零改动基础**：`tauri-shell/src/types.ts` 与全部 `.tsx` **无 `protocol` 字段**（实测 grep 全空）——daemon 已下发 `Progress.protocol`（`protocol.rs:358`，`routes.rs:309` 传 `proto.name()`）但前端**从未消费**。`DESIGN_BRIEF.md:41/220` 设计要求「协议徽章（HTTP/BT/IPFS/Video）」。即：**BT 的 UI 展示位是设计要求已定、实现未做**。 | 见 §2.3 |

**一句话结论**：协议抽象层已经备好（B1/B3），前端展示位设计要求已写（B8）。
**真正的阻塞是「单文件任务模型」（B2）、「本地文件入口缺失」（B4）、
「DHT 生命周期错位」（B5）三件结构性改动。**

> **D1/D2/D3 三项已于 2026-09-29 由用户裁定完毕（见 §5）**，本评估自此**无待拍板项**：
> **D1 = 立做种能力（默认关闭）**、**D2 = 专门种子库目录 + 种子/磁链统一存为种子文件 +
> 打开文件阅读入口**、**D3 = 不入媒体库（BT 属基础下载管理）**。

---

## 1. 现状取证（全部实测，非推断）

### 1.1 协议抽象层已有 BT 预留位（一项一项核）

| 符号 | 位置 | 原文 | 被使用？ |
|---|---|---|---|
| `SourceKind::Bittorrent` | `protocol.rs:270` | `Bittorrent,` | 无实现（仅 `Http`/`Mock` 在用） |
| `CapabilitySet::DHT` | `protocol.rs:44` | `/// BT DHT 寻址能力。` `1 << 5` | 无 |
| `CapabilitySet::MULTI_NODE` | `protocol.rs:46` | `/// BT 多 peer 并行。` | HTTP 声明了（多网卡），**语义不符**（见 §1.3） |
| `CapabilitySet::PINNING` | `protocol.rs:48` | `/// BT 做种 / 长效保活（Orig 产品特性）。` | 无 |
| `SourceKind::Ftp` | `protocol.rs:271` | `Ftp,` | 无 |
| `DownloadConfig.mirrors` | `protocol.rs:124` | `/// 镜像源 URL（HTTP 协议用；**BT 协议忽略**）。` | BT 会忽略，需新字段 |
| `ProxyConfig` 注释 | `protocol.rs:101` | `/// 代理配置（HTTP 下载用；**BT/DHT 未来独立配置，同结构复用**）。` | 已预留 |
| daemon config 注释 | `orig-daemon/src/config.rs:249` | `// [proxy] 段（HTTP 下载代理；**BT/DHT 代理未来独立段，同结构**）` | 已预留 |

**判定**：抽象层不是「需要改造以支持 BT」，而是「**当初就是按支持 BT 设计的**，
只是没实现」。`protocol.rs` 头注释（`:3`）与 `lib.rs:5`、`lib.rs:10` 三处独立文本
都写明 BT 是设计目标。

### 1.2 引擎的单文件模型（B2 取证）

```
engine.rs:220   pub output: PathBuf,                    // ← 单一输出文件
engine.rs:222   pub block_map: RwLock<BlockMap>,        // ← 单一完成位图
engine.rs:231   pub final_hash: RwLock<Option<String>>, // ← 单一 sha256
engine.rs:383   let existing = std::fs::metadata(&self.output)  // 续传读单文件长度
engine.rs:416   let hash = compute_sha256(&self.output)         // 完成算单文件 hash
engine.rs:432   let mut file = OpenOptions::new()...open(&self.output)  // 每 worker 单句柄
```

`BlockMap` 的 `total` 是**单文件总字节**（`protocol.rs:155`），`block_at()` 按
`idx × block_size` 算 offset（`:211-224`）——**块偏移空间只有一个**。

BT 的多文件种子：一个 info hash 下有 N 个文件，每个文件有自己的 length，
BT 的 piece 可以**跨文件边界**（一个 piece 覆盖文件 A 尾部 + 文件 B 头部）。
把 N 个文件拼成一个 `BlockMap` 是可行的**实现路径之一**，但随之而来的差异：

| 维度 | HTTP 单文件 | BT 多文件 |
|---|---|---|
| 输出 | 1 个 `PathBuf` | N 个路径（种子内相对路径 + 目录结构） |
| 完成判定 | `BlockMap.all_done()` | 各文件各自完成？整体完成？ |
| sha256 | 1 个 | BT 自带**每 piece 的 SHA-1**（v1）/ SHA-256（v2），与文件级 sha256 不同 |
| 文件名 | `Content-Disposition` 嗅探 | 种子内 `path` 列表（含多级目录） |
| 续传 | 文件长度 → 位图 | 每文件独立 + piece 校验 |
| `.part` 语义 | 单文件后缀 | 需要每文件独立临时态 |

### 1.3 `MULTI_NODE` 与多网卡语义混淆（次要发现）

`HttpProtocol::capabilities()`（`orig-protocol-http/src/lib.rs:630-639`）声明了
`MULTI_NODE`，含义是「**多网卡分流**」（`create_sources` 为每个网卡建一个
`BoundSource`，`lib.rs:657-691`）。而 `protocol.rs:46` 的注释说 `MULTI_NODE` 是
「**BT 多 peer 并行**」。

**同一 bit 被赋予两种不同语义**，且 HTTP 已占用。BT 实现时会撞名。
这是**登记项而非立即修复项**（不影响当前行为），但 BT 动工前须先明确该 bit 归谁，
或为 BT 新增独立 bit（如 `PEERS`）。

---

## 2. 关键结构性差异逐项展开

### 2.1 抽象层：不需要改，直接实现 `BtProtocol` + `BtSource`

`Protocol` trait 要求实现 `name` / `schemes` / `parse_url` / `probe` / `capabilities` /
`create_sources`（`protocol.rs:304-324`）。对 BT：

- `name()` → `"bittorrent"`
- `schemes()` → `&["magnet"]`（`.torrent` 是文件，不走 scheme，见 §2.2）
- `parse_url()` → 解析 magnet URI（`xt=urn:btih:<40hex|32base32>`、`dn`、`tr`、`xl` 等 query）
- `probe()` → **DHT/tracker 会合 + 元数据交换（BEP-9/BEP-10）**，得到 `Metadata.total_size`
  即种子总字节。这是**异步且可能长时间等待**的探测——与 HTTP `probe()` 的
  HEAD/Range 秒级返回差异巨大（见 §2.4）
- `create_sources()` → 一个 `BtSource`（内部管理 swarm，`protocol.rs:317` 原文已写）
- `fetch_block()` → 把 block 映射到 piece，向 peer 请求

**结论**：trait 签名**无需改动**。`BtSource` 可复用现有 `weight()` / `iface_name()`
默认实现（BT 多 peer 与多网卡可正交叠加）。

### 2.2 `.torrent` 本地文件入口缺失（B4）

`routes.rs:140-149`：
```rust
let scheme = req.url.split("://").next().unwrap_or("").to_string();
let proto = match st.registry.find_by_scheme(&scheme) { ... }
```
`.torrent` 文件没有 `://`，`split("://").next()` 返回**整个字符串**（即路径本身），
`find_by_scheme` 找不到 → 400 `unsupported scheme`。

**三条可选入口**（本评估不自行选定，见 §5-D2）：
- (a) 新增 `file` 或 `torrent` scheme：`torrent:///<absolute-path>` 或 `file:///...`
- (b) `AddReq` 增加判别字段（如 `kind: "torrent"`），前端选择文件后带路径提交
- (c) 读取 `.torrent` 二进制后 base64 塞进 URL —— **不推荐**（URL 长度与日志污染）

### 2.3 前端展示位（B8 取证）

实测：
```
tauri-shell/src/types.ts            → grep "protocol" : 0 命中
tauri-shell/src/**/*.tsx            → grep "protocol" : 0 命中
tauri-shell/src/components/AddDownloadDialog.tsx:137
        placeholder="https://example.com/file.zip"
```
而 daemon **已下发**该字段：
```
protocol.rs:358   pub protocol: String,          // Progress 里
routes.rs:309     proto.name().to_string(),      // Task::new 传入
```
`DESIGN_BRIEF.md:41` 与 `:220` 两处设计要求原文：
> 下载卡片：文件名、进度条、速度、ETA、**协议徽章（HTTP/BT/IPFS/Video）**、状态图标

**判定**：协议徽章是**设计要求已写但实现未做**的能力，
且 daemon 侧数据**已经在传**。BT 的 UI 落点是「补齐设计要求」，
不是「为 BT 新造 UI」。这符合 AGENTS.md §5 的「重构不是删能力的授权」反向推论：
**不实现设计要求同样是缺口**。

### 2.4 DHT 生命周期错位（B5）

当前结构：
- `main.rs:30-33`：启动期 `registry.register(...)`，**编译期注册**（`registry.rs:1` 原文
  「编译期注册，引擎按 scheme 查找协议实现」）
- `routes.rs:292`：**每任务**调 `proto.create_sources(&parsed, &cfg)` 建源

DHT 的真实需求：
- **单例**：一个进程一张 DHT 路由表（UDP 端口监听，BEP-5）
- **长生命周期**：跨任务存活，节点表需要时间积累（冷启动几分钟才有可用 peer）
- **启动期开销**：bootstrap 节点连接、端口绑定（**本机 9757-9856 被 WinNAT 保留**，
  BT 默认端口 6881 元组需实测确认未落入保留段——属**开工前必须实测**项）
- **持久化**：节点表落盘可加速下次启动（`dht.dat` 类文件）→ **落入 `download_dir` 域**

`Registry` 是 `Protocol` 的容器，但 `Protocol` 无 `startup()` / `shutdown()` 生命周期钩子。
DHT 需要**新增一个进程级组件**（不是 `Protocol` 实现的内部字段，否则每任务建一次）。

**实现路径**：DHT 作为 `orig-daemon` 的 `AppState` 成员（`state.rs:81` 附近），
`BtProtocol` 持有其 `Arc`。这不改 `Protocol` trait，但改 `AppState` 结构。

---

## 3. 与既有裁定/在途工作的相互作用

| 既有裁定/在途项 | 与 BT 的关系 | 处置 |
|---|---|---|
| **`download_dir` 归下载引擎域**（BUG-173 第 ④ 条，用户已裁定） | BT 落盘根 = `download_dir`，**归属已定，无需再议**。多文件种子的目录结构 = `<download_dir>/<种子名>/<相对路径>` | 直接沿用 |
| **`cache-root-unification` C1–C6**（施工图） | BT 新增**写盘路径**（含种子库目录），须纳入同一「可删区判据」。若 C2 的 `ByteOwner` 三态先落地，BT 直接复用 `classify_bytes` | **依赖**（仅判据，不阻塞开工）：BT 落盘须与之对齐 |
| **BUG-173 A1–A6（归属判据）** | BT 新增 `download_dir` 下的子目录层级（`torrents/` 与种子名目录），**不新增 setting key**，故不扩大 BUG-173 范围 | **无冲突**（D2 裁定后确认） |
| **`BUG-082`（`docs/bugs/BUG-082.md:121`）「已做种/种子 → 不做」** | 该裁定说「本引擎无做种能力」，与用户 D1 裁定「立为做种能力」**直接冲突** | **已处置**：BUG-082 追加「后续变更」节（2026-09-29，历史锚定，不改写正文），变更载体 = 本 BUG-174 |
| **`blob-store-design.md`（C1–C6）** | blob 寻址按 `sha256` 分桶（`<download_dir>/blobs/ab/cd/<64hex>`），是 D2 种子库目录的**范式先例**。BT 的天然校验是 **piece hash（SHA-1/SHA-256）**，与整文件 sha256 **不同源**。多文件种子的存储若走 blob store 需明确「blob = 文件级还是种子级」 | 设计层须对齐（`torrents/` 与 `blobs/` 平级，**不混用**） |
| **`media_item` 入库（TG 侧）** | **D3 已裁定：不入库**。BT 属基础下载管理，不写 `media_item`/`media_episode`、不新增 `source` 枚举值 | **已决**（§5-D3）：不入库，且消除与拆库在途的冲突 |
| DHT 端口 vs WinNAT 保留段 | 本机实测保留 `9757-9856`（见项目记忆）。BT 监听端口须**实测可绑** | 开工前实测 |

---

## 4. 工作量分解（供排期，不含时间估计）

| 层 | 项 | 是否改抽象 | 依赖 |
|---|---|---|---|
| 依赖 | 引入 BT crate（`librqbit` / `cratetorrent` / 自实现） | — | 依赖评审（B7） |
| 协议 | 新增 crate `orig-protocol-bittorrent`（对称于 `orig-protocol-http`） | 否 | 依赖 |
| 协议 | `BtProtocol` 实现六方法 | 否 | ↑ |
| 协议 | magnet URI 解析 | 否 | ↑ |
| 协议 | `.torrent` 文件解析（bencode） | 否 | ↑ |
| 元数据 | BEP-9（ut_metadata）元数据交换 | 否 | ↑ |
| 元数据 | DHT（BEP-5）单例 + bootstrap + 持久化 | **改 AppState** | ↑ |
| 元数据 | Tracker（HTTP/UDP announce） | 否 | ↑ |
| 引擎 | **多文件任务模型**（B2） | **改 `Task` 结构** | 协议 |
| 引擎 | piece ↔ block 映射（含跨文件 piece） | 否 | 引擎 |
| 引擎 | BT piece hash 校验（替代/叠加 sha256） | 否 | 引擎 |
| 入口 | `.torrent` 本地文件入口（B4） | 改 `routes.rs` / `AddReq` | — |
| 入口 | 种子库目录 `<download_dir>/torrents/` + magnet 归一落盘 | 否（由 `download_dir` 派生） | — |
| 入口 | `Registry` 注册（`main.rs:32` 旁） | 否 | 协议 |
| 配置 | `[bittorrent]` 配置段（端口/上传限速/DHT 开关/做种开关） | 否 | — |
| 配置 | BT 代理（独立段，`ProxyConfig` 结构复用） | 否 | — |
| 做种 | 上传调度 + 上传限速 + 一键停止（D1 裁定） | 改 `AppState` | DHT |
| UI | 协议徽章（设计要求已有，B8） | — | 引擎下发 |
| UI | BT 专属字段（peer 数 / 上传速度 / 做种状态） | — | **已决**（D1 立做种 ⇒ 必做） |
| UI | `.torrent` 文件选择入口 | — | 入口 |
| UI | 做种开关（默认关）+ 开启处合规提示 | — | 做种 |
| 存储 | BT 产物落盘判据纳入可删区 | 依赖 C2 | 施工图 |
| 存储 | BT 产物是否入媒体库 | — | **已决**（D3：不入库） |

---

## 5. 裁定结果（用户 2026-09-29 已决）

> 三项均**已裁定**，本节由「待拍板」转为**存档**。原三选项正文保留于下（履历不减），
> 裁定依据写在每项开头的「**裁定**」行。
> 依据 `docs/rules/decision-spec.md` §四：已决事项撤下待拍板区，不得当决策项重复回抛。

| 项 | 裁定 | 用户原话 |
|---|---|---|
| **D1** | **A 立为做种能力**（按 BT 规约，做种是协议必需） | 「D1 按照 BT 规约，这是必须的吧」 |
| **D2** | **专门的种子库目录 + 种子/磁链统一存储 + 打开文件阅读入口** | 「D2 走打开文件阅读，缓存的方式？添加专门的种子库目录，最终磁链等都作为种子存储」 |
| **D3** | **不入媒体库**（BT 属基础下载管理，不是媒体管理） | 「D3 这是基础下载管理不如媒体也可以」 |

> **对 D1 前提的核实（工程师应答，不影响裁定）**：用户问「按照 BT 规约这是必须的吧」。
> **回答：不是「必须」，但用户的方向在工程上成立且更优。** BT 规约（BEP-3/BEP-5/BEP-9）
> **没有要求任何客户端做种**——协议规定的是「若你持有数据且对端请求，应能响应」，
> 而**纯 leech 客户端（下完即断开）完全合规**，libtorrent/aria2/大量客户端均支持
> `seed=false`。**做种不是协议合规的必需项，是「回报 swarm」的策略选择。**
> 但用户裁定 A 的实质理由成立且更强：**BT 是双向协议，只取不予长期会使 swarm 衰减**；
> 且 `protocol.rs:48` 早就把它写成「Orig 产品特性」。
> **因此本项按 A 执行，但须带「默认关闭 + 显式开启」的产品约束**（依据见下方合规提示，
> 该约束不因裁定而取消，属 §3 既定的「实现约束不作为常驻 UI」反向：**风险提示须在开启动作处出现**）。

### D1. 做种（seed / 长效保活）—— **已决：立为能力（原 A）**

`涉及:`：`orig-core/src/protocol.rs:48`（`PINNING` bit 语义落地）；`orig-tg` 无涉；
新增 `orig-daemon` 上传带宽调度；`docs/bugs/BUG-082.md:121`（现状裁定的修订）

`现状与代价`：`protocol.rs:48` 写着「BT 做种 / 长效保活（**Orig 产品特性**）」——
即设计时预留为产品特性。但 `docs/bugs/BUG-082.md:121` 实测裁定「已做种/种子 → **不做**：
本引擎无做种能力，无对应数据源，不臆造」，并按此结论删除了对应 UI 档位。
当前**无上传能力、无上传限速、无做种状态字段**。

选项：

- **A. 立为能力（下载完继续做种，可配做种率/时长）**
  `涉及:` `protocol.rs:48` + 新增上传带宽调度 + `Progress` 增字段（上传速度/peer 数/做种态）
  `量化:` 新增 ≥3 个 `Progress` 字段；`DESIGN_BRIEF.md:41` 协议徽章须加做种态
  `回归风险:` 上传占带宽（与「投递背压」BUG-033 是**相反方向**的资源竞争）；
  用户上行被占满的投诉；种子内容的法律合规面（**见下方合规提示**）
  `后果:` 补齐设计预留能力；但引入持续性后台网络行为，须有显式开关与限速

- **B. 只做下载（leech），不做种；`PINNING` bit 保持未用**
  `涉及:` 无（实现仅到 `completed` 即停）
  `量化:` 0 新增字段；0 上传带宽
  `回归风险:` 无（与现有 HTTP 下载同构）
  `后果:` 实现最小；但与 `protocol.rs:48` 的设计预留不一致，须**修订该注释**说明
  「预留但未立」

- **C. 不做**（BT 仅评估不实现）
  `涉及:` 无（0 行代码改动）
  `量化:` 0
  `回归风险:` 0
  `后果:` 用户需求「BT 支持」不落地

`请求:` 已裁定 **A**（用户 2026-09-29）。
`设计锚点:` `download-engine/crates/orig-core/src/protocol.rs:48`；
`docs/bugs/BUG-082.md:121`

> ⚠️ **合规提示（不因裁定而取消）**：P2P 做种意味着**向他人上传内容**。
> 在中国大陆法域下，BT 做种常被用于侵权作品分发，**做种功能本身可能使用户处于法律风险中**。
> 裁定为 A 之后，该风险由「是否做」转为「**如何做**」：**必须默认关闭 + 显式开启 +
> 开启动作处给出如实提示 + 可配总上传限速 + 可随时一键停止做种**。
> 依 §3 的 UI 信息层级规则，该提示属「用户正因此受阻/正要承担后果」的时点，
> **在开启控件处出现是允许的**；但**不得做成常驻横幅**。

### D2. `.torrent` 本地文件入口形态 —— **已决：专门种子库目录 + 种子/磁链统一存储 + 打开文件阅读入口（原 A 的强化版）**

**裁定内容（用户原话）**：「走**打开文件阅读，缓存**的方式？**添加专门的种子库目录**，
最终**磁链等都作为种子存储**。」

**裁定解读（工程师按字面 + 与既有设计一致性推导，逐条列明）**：

| # | 裁定要点 | 工程含义 |
|---|---|---|
| D2-1 | **新增专门的种子库目录** | `download_dir` 下新增专用子目录（如 `<download_dir>/torrents/`），**对称于** `blob-store-design.md` C1 的 `<download_dir>/blobs/`。**不是** TG 那种点前缀内部目录（`.media-cache/`）——种子是「用户可见的资产」，不是「实现细节的缓存」 |
| D2-2 | **种子文件与磁链统一作为「种子」存储** | `.torrent` 文件与 `magnet:` 链接**归一为同一实体**：都落成种子库目录下的 `.torrent` 文件。`magnet:` 需先经 BEP-9 元数据交换**取到 info-dict → 合成 `.torrent`**，再落盘。即**磁链是种子的「来源」之一，不是独立存储形态** |
| D2-3 | **走「打开文件阅读」入口** | 交互形态 = **用户打开（选择）一个 `.torrent` 文件** ⇒ 走**本地文件路径**，不走 URL scheme 伪装。**这裁定原 A 与 B 之争：选 B 的语义方向**（文件就是文件），而非 A 的「路径伪装成 URL」 |
| D2-4 | **「缓存的方式」** | 种子的**缓存语义** = 种子文件落盘到种子库目录后**长期保留**（可复用、可重新下载、可查看），**不是**用完即弃的临时输入 |

**由裁定衍生的必须明确项（工程师须自决，不得回抛）**：

- **种子库目录的命名与位置**：`<download_dir>/torrents/`（与 `blobs/` 平级）。
  依据：`blob-store-design.md` 已确立「`download_dir` 下一级子目录 = 一类字节资产」的范式
  （`blobs/` 正式 blob、`blobs/_tmp/` 临时区）。种子库纳入同范式。
  **候补命名**：`torrents/`（选它，与 `blobs/` 同为复数名词、语义直白）。
- **种子库目录内的布局**：种子以 **info_hash 命名**（`<download_dir>/torrents/<40hex>.torrent`），
  依据：**info_hash 是 BT 规约（BEP-3）定义的种子唯一身份**，天然去重
  （同一内容的不同磁链/不同 tracker 的种子归一）。**不用用户可见名**——
  同名不同内容会互相覆盖（`blob-store-design.md` §1.1 的教训同源）。
- **DHT / 节点表持久化位置**：`<download_dir>/torrents/dht.dat`（同目录，随种子库走）。
  依据：D2-4 的「缓存」语义 + §2.4「DHT 持久化落 `download_dir` 域」。
- **文件入口的传输形态**：**依 D2-3 选原 B 的实现路径** —— `AddReq` 增判别字段
  （前端选文件后传本地路径），**不采用** `torrent:///` scheme 伪装。
  理由：裁定明确「打开文件阅读」，且路径含中文/特殊字符时 scheme 伪装需转义、易误切分（原 A 的回归风险）。
- **magnet 输入仍保留**：D2-2 说「磁链都作为种子存储」，即**磁链是合法输入**，
  只是**存储形态归一为种子文件**。故 `BtProtocol::schemes()` 仍须含 `"magnet"`。
  ⇒ **入口有两条**：① 打开 `.torrent` 文件（本地路径）；② 粘贴 `magnet:` 链接。
  **二者最终都落成种子库目录下的 `<info_hash>.torrent`。**

**已失效的原选项（保留作履历）**：

- **A. 新增 `torrent:///` scheme** —— **不采用**（与「打开文件阅读」的裁定相抵，且转义风险）
- **B. `AddReq` 增判别字段** —— **采用**（即 D2-3 的实现路径）
- **C. 不做本地文件入口** —— **不采用**（与裁定直接相抵）

`涉及:` `orig-daemon/src/routes.rs:45-68`（`AddReq` 增字段）；
`orig-daemon/src/routes.rs:140-149`（magnet 仍走 scheme 分派）；
新增种子库目录读写（`download_dir` 域）；`tauri-shell` 文件选择入口
`量化:` `AddReq` +1 字段；新目录 `<download_dir>/torrents/`；1 个文件选择 UI；0 新增 setting key
（目录由 `download_dir` 派生，**不新增 `app_setting` key** ⇒ 不扩大 BUG-173 的 A1–A6 范围）
`回归风险:` 低。① 种子库目录须纳入可删区判据（依赖 `cache-root-unification` C2 的 `ByteOwner` 三态）；
② `.torrent` 解析失败须**显式报错**（不得静默当普通下载）；③ 中文路径须验（Windows 中文路径编码）
`后果:` 种子可复用、可查看、可重新下载；`download_dir` 下新增一类「用户可见资产」，
须与 `blobs/`（实现细节）在 UI 上区分呈现
`请求:` 已裁定（用户 2026-09-29）。
`设计锚点:` `download-engine/crates/orig-daemon/src/routes.rs:140`；
`docs/design/blob-store-design.md` C1（`<download_dir>/blobs/` 同范式先例）

### D3. BT 下载产物是否自动入媒体库（`media_item`）—— **已决：不入库（原 B）**

**裁定内容（用户原话）**：「D3 这是**基础下载管理**不如媒体也可以」。

**裁定解读**：BT 属**基础下载管理**能力（下载引擎域），**不是媒体管理**能力（库域）。
故 BT 产物**不进 `media_item`**，与现有 HTTP 下载产物同构处理。

**该裁定的额外价值（消除一个在途风险）**：原 D3-A（入库）会与 **BUG-173 拆库在途**冲突
（`media_item.source` 新增 `bt` 值会扩大 A1–A6 归属判据面）。裁定为 B 后
**该冲突不存在**，BT 实现**不再依赖 BUG-173 落地**（唯一剩余依赖是可删区判据，
见 D2 的 `回归风险`）。

**边界（须守）**：
- BT 产物落 `<download_dir>`（含多文件种子的 `<download_dir>/<种子名>/…`），
  **不写 `media_item`**、**不写 `media_episode`**、**不新增 `source` 枚举值**。
- 「缓存即入库」（AGENTS.md §5 / BUG-029）**仍只适用 TG 缓存**，不扩到 BT。
- 若日后要立「BT 产物入库」，须**新立 BUG** 并**先等 BUG-173 落地**，不得顺手加。

`涉及:` 无入媒体库代码改动（0 行 `media.rs` 改动）；BT 产物只落 `download_dir`
`量化:` 0 新枚举值；0 `media_item` 迁移
`回归风险:` 0（与现有 HTTP 下载同构）
`后果:` 实现最小；用户仍可在文件管理器打开；媒体库看不到 BT 产物（**符合裁定语义**）

**已失效的原选项（保留作履历）**：

- **A. BT 产物入库，新增 `source="bt"`** —— **不采用**（与「基础下载管理」的域判定相抵，且与拆库在途冲突）
- **B. 不入库，BT 产物只是普通下载文件** —— **采用**
- **C. 不入库，且不评估入库** —— **部分不采用**：裁定为「本轮不做」，
  但保留了「日后新立 BUG 可重启」的路径，故非「关闭讨论线」

`请求:` 已裁定（用户 2026-09-29）。
`设计锚点:` AGENTS.md §5（编目与落盘正交）；`docs/bugs/BUG-173.md`（拆库 A1–A6）

---

## 6. 明确边界（本扩展**不做**什么）

- **不改 `Protocol` / `Source` trait 签名** —— 抽象层已够用（B1/B3）。
- **不实现 IPFS / FTP** —— `DESIGN_BRIEF.md:41` 提到 IPFS 徽章，
  但 `SourceKind` 无 `Ipfs` 变体，且用户本次只提 BT。**不顺手扩**。
- **不改 TG 侧任何代码** —— BT 与 `orig-tg` 零耦合。
- **BT 产物不入媒体库**（D3 裁定）—— 不写 `media_item`/`media_episode`，
  **不新增 `source` 枚举值**，不扩「缓存即入库」的适用范围。
- **不做种默认开启**（D1 裁定的配套约束）—— 默认关闭 + 显式开启 + 可一键停 + 可限速。
- **不动 BUG-173 的 A1–A6 范围** —— 种子库目录由 `download_dir` **派生**，
  **不新增 `app_setting` key**（D2 的 `量化:` 字段已声明），故不扩大判据面。
  唯一依赖是 `cache-root-unification` 的 `ByteOwner` 三态（可删区判据）。
- **不采用 `torrent:///` scheme 伪装**（D2 裁定选原 B 路径）—— 但 **`magnet:` scheme 仍保留**
  （D2-2：磁链是合法输入，只归一到种子文件形态）。

---

## 6.1 裁定后的施工顺序（依赖关系）

```
L0 依赖评审（引入 BT crate）
 │
 ├─> L1 orig-protocol-bittorrent crate（BtProtocol / BtSource / magnet / .torrent / BEP-9）
 │    │
 │    ├─> L5 DHT 进程级单例接入 AppState + 持久化 <download_dir>/torrents/dht.dat
 │    │        └─> D1 做种能力（PINNING 落地：上传调度 + 限速 + Progress 增字段）
 │    │
 │    └─> L2 引擎多文件任务模型（改 Task 结构；piece 跨文件映射 + BT piece hash 校验）
 │             └─> L4 前端协议徽章（补齐 DESIGN_BRIEF:41/220）+ BT 专属字段（peer 数/上传速度/做种态）
 │
 └─> L3 种子库目录 + 入口：<download_dir>/torrents/ + AddReq 判别字段（打开 .torrent 文件）+ magnet 归一落盘

外部依赖：L2/L3 的落盘须纳入 cache-root-unification C2 的 ByteOwner 三态（可删区判据）
            —— 不阻塞开工，但落盘判据须与之对齐
不再依赖：BUG-173 落地（D3 裁定为 B 后，拆库与 BT 无耦合）
```

## 7. 与既有文档的一致性核对

| 文档 | 相关条目 | 本评估的处置 |
|---|---|---|
| `AGENTS.md` §5 投递契约 | BT 是下载能力，属引擎侧 | 一致 |
| `AGENTS.md` §5 缓存即入库 | 该规则限于 TG 缓存（ref = chat:msg） | **D3 裁定不入库 ⇒ 不扩用** |
| `AGENTS.md` §5 删除联动 | 清缓存只回收字节，条目永不删 | BT 不入库 ⇒ 本条不适用；但**种子库文件与下载产物**的删除须守同精神（删来源连带清字节） |
| `AGENTS.md` §5 编目与落盘正交 | 下载（传输域）与编目（内容域）两模块 | **D3 裁定吻合**：BT 只做传输域，不越界编目 |
| `docs/bugs/BUG-082.md:121` | 「已做种/种子 → 不做」 | **须修订**（D1 裁定为立做种能力，须写明变更依据与日期） |
| `DESIGN_BRIEF.md:41/220` | 协议徽章 HTTP/BT/IPFS/Video | 设计要求已有，实现缺口（B8）；**纳入 L4** |
| `protocol.rs:3/48/101/124` | BT 设计预留 | 一致，本扩展即落地（D1 使 `:48` 的 `PINNING` 注释兑现） |
| `docs/design/cache-root-unification-2026-09-28.md` | 可删区判据多根 | BT 落盘须纳入（依赖 C2 `ByteOwner`） |
| `docs/bugs/BUG-173.md` | download_dir 归引擎域 | BT 沿用；**D2 不新增 setting key ⇒ 不扩 A1–A6 范围** |
| `docs/design/blob-store-design.md` | `<download_dir>/blobs/` 内容寻址 | **D2-1 的范式先例**（`<download_dir>/torrents/` 与之平级）；piece hash ≠ 文件 sha256 仍须对齐 |

---

## 附：本评估的取证清单（可复核）

| 结论 | 复核命令 |
|---|---|
| B1 预留位存在 | `grep -n "Bittorrent\|DHT\|PINNING\|MULTI_NODE" download-engine/crates/orig-core/src/protocol.rs` |
| B2 单文件模型 | `grep -n "pub output\|pub block_map\|pub final_hash" download-engine/crates/orig-core/src/engine.rs` |
| B3 引擎不改承诺 | `sed -n '17p' download-engine/crates/orig-core/src/engine.rs` |
| B4 无本地文件入口 | `grep -n "find_by_scheme\|split(\"://\")" download-engine/crates/orig-daemon/src/routes.rs` |
| B5 DHT 无生命周期钩子 | `grep -n "pub trait Protocol\|fn name\|fn schemes" download-engine/crates/orig-core/src/protocol.rs` |
| B6 做种裁定 | `grep -n "已做种\|做种" docs/bugs/BUG-082.md` |
| B7 零 BT 依赖 | `grep -iE "torrent\|magnet\|dht\|bencode" download-engine/Cargo.lock`（应空） |
| B8 前端无 protocol 字段 | `grep -rn "protocol" tauri-shell/src/`（应空） |
| D2 范式先例（`blobs/` 平级） | `grep -n "download_dir>/blobs\|_tmp" docs/design/blob-store-design.md` |
| D3 不新增 setting key | `grep -c "app_setting" docs/design/bittorrent-extension-assessment-2026-09-29.md`（仅出现在「不新增」语境） |

---

## 附二：本评估的裁定留痕（回答「D1 按 BT 规约必须吗」）

**用户问**：「D1 按照 BT 规约，这是必须的吧」

**工程回答**：**不是**。逐条对照 BT 规约：

| 规约 | 要求 | 是否要求做种 |
|---|---|---|
| BEP-3（The BitTorrent Protocol Specification） | 定义 peer 间交换 piece | **否**。它描述「持有数据的 peer 应能响应 request」，未规定下载方必须转为做种方 |
| BEP-5（DHT Protocol） | 提供无 tracker 的 peer 发现 | **否**。DHT 是**发现机制**，与是否做种无关 |
| BEP-9（Extension for Peers to Send Metadata Files） | magnet 元数据交换 | **否**。元数据取自 peer，与做种无关 |
| BEP-10（Extension Protocol） | 扩展消息协商 | **否** |

**结论**：**纯 leech 客户端（下完即断开、不做种）完全合规**，
`aria2` 的 `--seed-time=0`、libtorrent 的 `seed_mode=false` 均为标准做法。
**做种不是协议合规的必需项，是「回报 swarm」的策略选择。**

**但用户裁定 A 的实质理由成立且更优**：BT 是双向协议，只取不予长期会使 swarm 衰减；
且 `protocol.rs:48` 早已把它写成「Orig 产品特性」。
**故按 A 执行，附带「默认关闭 + 显式开启 + 可限速 + 可一键停」的产品约束**——
该约束即合规提示的落地形态，不因裁定而取消。
