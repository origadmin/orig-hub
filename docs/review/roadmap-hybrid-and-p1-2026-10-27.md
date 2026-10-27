# 混合架构 + 四项高优先级：现状取证与落地设计（内部）

> 状态：内部文档，不公开。日期 2026-10-27。
> 关联：`gpui-feasibility-2026-10-27.md`（GPUI 是否可行）、`fluxdown-pages-2026-10-27.md`（页面差距 F-*）、`fluxdown-settings-catalog-2026-10-27.md`（设置全量）。
> 本文只做**取证 + 设计**，不改代码。所有结论带 `文件:行号`，可复核。

---

## 0. 先说三个会改变判断的实测结论

| # | 你以为 | 实际 |
| --- | --- | --- |
| 1 | 托盘要新做 | **托盘已经有了**（`lib.rs:555` `TrayIconBuilder`，菜单「显示 / 退出」）。缺的是「常驻」的四件事，不是托盘本身 |
| 2 | 下载协议要新建插件架构 | **抽象、注册表、分发点全都在**（`orig_core::protocol::{Protocol,Source}` + `orig_core::registry::Registry`），已有 2 个实现。缺的是**第 3、4 个实现** |
| 3 | ffmpeg 支持基本为零 | **硬解探测已经接线并生效**（`routes.rs:5503` → `probe_config` → `5831` `cfg.input_args()`），6 级路径解析链也有。缺的是**受管安装 + 用户可配 + 设置页** |

这三条决定了后面四项的排期完全不同：**没有一项需要动架构**。

---

## 1. 混合架构：原生播放 + WebView 管理面，能不能做

### 1.1 能。而且我们已经有它的全部前置条件

```
┌─────────────────────────────────────────┐
│  Orig Hub 主壳（Tauri v2 + WebView2）    │  ← 管理面：媒体库/文件/下载/TG/设置
│  ─ 257 个验收脚本 / 167 个走 CDP 全部保住 │
└───────────────┬─────────────────────────┘
                │ HTTP（已有协议，不新增）
┌───────────────▼─────────────────────────┐
│  orig-daemon sidecar（Rust，已有）        │  ← 下载引擎，零改动
└───────────────┬─────────────────────────┘
                │ HTTP 流（已有 /api/tg/media）
┌───────────────▼─────────────────────────┐
│  orig-player sidecar（GPUI，新增）        │  ← 只做播放这一个窗口
└─────────────────────────────────────────┘
```

为什么这是最省的接法，三条硬理由：

1. **引擎本来就是独立进程**。`tauri.conf.json` 的 `bundle.externalBin` 已经是 `orig-daemon` + `orig-tg`。再拉一个 `orig-player` 和拉 `orig-daemon` 是**同一类动作**，进程模型不用改。
2. **UI 与引擎之间只有 HTTP**。播放器拿到的流地址和 WebView 里 `<video src>` 拿的是同一个 URL，**不需要新协议**。
3. **可回滚**。播放器起不来 / 效果不好，删掉 sidecar 引用就回到今天的状态，不留技术债。

### 1.2 三种接法的取舍（供选，不替你定）

| | A. 独立播放器窗口（推荐） | B. 原生子窗口嵌进 WebView 窗口 | C. GPUI 里嵌 WebView |
| --- | --- | --- | --- |
| 做法 | 主壳拉起 GPUI 进程，两个顶层窗口 | HWND 重父化到 WebView 窗口 | 主壳换成 GPUI，内嵌 webview |
| 稳定性 | **高**（两进程互不影响） | 低（重父化在 Windows 上随 WebView2 更新易碎） | 低（等于全量换壳） |
| 全屏/画中画 | 天然支持 | 要自己同步窗口几何 | 要自己做 |
| 拖拽/焦点/Z 序 | 要协调（见下） | 要协调 | 要自己做 |
| 验收 | 播放器单独一套判据 | 极难 | 极难 |

**A 的协调成本**（必须承认，不是零）：

- 主窗关闭 → 播放器必须跟着退（否则留孤儿进程）
- 播放器位置：默认居中于主窗，用户拖动后记住
- 全屏：播放器自己 `set_fullscreen`，不需要主窗配合
- 焦点：主窗失焦不等于播放器失焦，各自独立
- 观感：播放器窗口无边框 + 自绘控件，和主壳共用设计 token，否则会像两个软件

### 1.3 但这件事**不该现在做**

理由在 `gpui-feasibility-2026-10-27.md`：能不能播这件事还没验证（中文输入法一票否决项 S-6 未测）。**先做 spike，spike 过了再谈窗口接法。**

你把这条标成「优先级不高」是对的——它是 spike 的下游，不是上游。

---

## 2. P1-2.1 ffmpeg 完整设置支持

### 2.1 FluxDown 的真身不是「设置项」，是「受管组件」

我读了 FluxDown 的 `native/engine/src/components/`（1816 行，`ffmpeg.rs` 783 + `ytdlp.rs` 396 + `mod.rs` 637）。它的「ffmpeg 设置」由三块组成，**不是一排开关**：

**① 路径来源模型**（`ComponentSource`，`mod.rs:60`）

```
Manual（用户显式指定，最高优先）
  → Managed（数据目录 bin/ 下，用户主动安装的版本）
    → System（PATH 里探测到的）
      → None
```
配两个 config 键：`component.ffmpeg.path`（手动路径）、`component.ffmpeg.managed_version`（钉住的版本号）。

**② 受管安装**（`ffmpeg.rs:1` 模块文档）

- 从 BtbN/FFmpeg-Builds 的 GitHub `latest` Release 下载静态构建
- 那个 Release **同时携带多个 `n<major.minor>` 资产** ⇒ 一次请求就能列出全部可钉版本（`list_versions`），用户可选「钉 7.1」或「跟最新」
- 解压取单文件；ffprobe 一并装（`managed_ffprobe_path`）
- **macOS 无 BtbN 构建** ⇒ `managed_supported = false`，UI 隐藏安装入口，只引导 PATH / 手动指定（**不弹「不支持安装」**）
- **组件不随安装包分发**，由用户在设置页主动触发下载（合规边界，`mod.rs:3`）

**③ 国内可用的镜像基址**（`mod.rs:38`，注释里写得非常直白）

> GitHub Release API 未认证匿名限流 **60 请求/小时**，公司网络/部分地区直连 `api.github.com` 可能被 403/超时。用户可填一个反代基址，非空时替换掉 `https://api.github.com` / `https://github.com` 前缀。

**④ 状态快照**（`FfmpegStatus`，`ffmpeg.rs:26`）

`source` / `path` / `version`（`ffmpeg -version` 探测）/ `managed_version` / `system_path` / `managed_supported` —— **六个字段，正好是设置页要显示的全部内容**。注意它刻意把「生效路径」和「托管安装版本」分开：生效的可能是系统 PATH，用户钉的是托管版本，两者不同时必须能说清。

> **和插件的关系**（`mod.rs:5`）：组件与插件沙箱（QuickJS）是**两套正交的信任模型**，本模块不与插件脚本执行交互；但已安装组件可被**授权插件**经 `flux.ffmpeg` / `flux.ytdlp` 门面调用。

### 2.2 我们现在的实际状态（逐项对账）

| 能力 | 我们 | 证据 |
| --- | --- | --- |
| 硬解探测（`-hwaccels` / `-encoders` / GPU） | ✅ 有，且**已接线生效** | `ffmpeg_caps.rs` 全文件；`routes.rs:5503` `ffmpeg_config()` → `:5831` `cfg.input_args()` |
| 硬解推荐 + 回落软解 | ✅ 有（类型上禁止 `auto`） | `ffmpeg_caps.rs:586` `recommend()`；`HwAccel` 无 `Auto` 变体 |
| 路径解析链 | ✅ 有，**6 级** | `routes.rs:5435` `resolve_ffmpeg_path` |
| 用户可配路径 | ⚠️ **只有 env** `ORIG_FFMPEG_PATH` | `routes.rs:5436`。普通用户改不了 |
| 受管安装（下载/校验/解压） | ❌ 无 | grep `install_ffmpeg` 零命中 |
| 版本钉住 | ❌ 无 | 同上 |
| 镜像基址 | ❌ 无 | 同上 |
| `ffmpeg -version` 状态展示 | ❌ 无 | 无 `ffmpeg_status` 对应物 |
| ffprobe 一并管理 | ❌ 无 | 只找 `FFMPEG_EXE`（`routes.rs:5424`） |
| 设置页控件 | ❌ **故意留空** | `zh-CN.json:121`：「这里还没有安装状态探测、路径指定与硬件加速选项，因此**不放任何控件**——摆一排点了不动的开关比留空更糟」 |

**那句 i18n 是诚实的，也是欠账的凭据。** 2.1 就是把这笔账还上。

### 2.3 落地设计（分三步，每步独立可验收）

**Step 1 — 让 ffmpeg 从「env」变成「可配」（最小闭环）**

- 新增配置键 `ffmpeg.path` / `ffmpeg.managed_version`，落 daemon 配置（与现有 config 同一处）
- `resolve_ffmpeg_from` 的 `explicit` 入参从 `env` 改为「配置值 → env → 兜底」，**env 保留为开发期覆盖**
- 新增只读端点 `GET /api/ffmpeg/status` → 返回六个字段（对齐 `FfmpegStatus`）
- 设置页出现**只读**状态卡：来源徽章（手动/托管/系统/未找到）+ 路径 + 版本 + 硬解结论（复用 `ffmpeg_caps::describe`，那行文案已经有了）

> 验收判据：手动填一个不存在的路径 ⇒ 状态显示「未找到」且**不崩**；填一个真路径 ⇒ 徽章变「手动」且版本号出现。**反向证伪**：删掉该文件后重查 ⇒ 必须回落，不能缓存住旧结论。

**Step 2 — 受管安装**

- 从 BtbN Release 列版本 → 选版本 → 下载 → 解压取单文件 → 落 `<数据目录>/bin/`
- **先做镜像基址，再做下载**。国内直连 GitHub 大概率失败，先有镜像才有可测性（顺序反了会得到「在我机器上能装」的假结论）
- `managed_supported`：Windows/Linux 显示安装入口，macOS 隐藏（照抄 FD 的处理，不要弹错误）
- 进度/失败原因要能显示（下载是长动作，不能静默）

> 验收判据：**断网安装 ⇒ 必须给出可读失败原因 + 重试入口**，不能白屏或无限转圈。这条比「能装成功」更重要——装成功只能证明一次，失败路径每天都会遇到。

**Step 3 — 硬解开关的「可见不可怕」**

- 硬解结论已经在跑（`describe()` 一行文案），但用户看不见
- 设置页给：当前结论 + 「强制软解」开关（出问题时的手动逃生门）
- **不要**给「选后端」下拉。`ffmpeg_caps.rs:46` 的设计已经用类型系统论证过：多显卡上 `auto` 选的不一定对，让用户手选等于把决策外包给不懂的人

### 2.4 明确不做

- ❌ 硬件**编码**开关（我们 `hw_encode` 恒 `false`，`ffmpeg_caps.rs:38` 有实测依据：nvenc 驱动不足 / qsv 慢于软编 / amf 无卡）
- ❌ 分辨率/码率预设面板（`ffmpeg_caps.rs:35`：降分辨率无增益，做自适应是白做工）
- ❌ 任意 ffmpeg 参数透传（等于把命令行当 API，用户一填错就是「放不了」）

---

## 3. P1-2.2 下载功能模块化插件支持

### 3.1 先纠正一个事实：FluxDown 的 BT/eD2K 不是插件

我核对了 FluxDown 源码：

| 它有什么 | 在哪 | 是不是「插件」 |
| --- | --- | --- |
| BT 下载器 | `native/engine/src/bt_downloader.rs`（**6600+ 行**）+ `bt_config/bt_partfile/bt_seeding/bt_sparse/bt_verify` | ❌ **内置 Rust 模块** |
| eD2K 下载器 | `native/engine/src/ed2k/`（client/hash/kad/peer/proto/server/upnp，**10 个文件**） | ❌ **内置 Rust 模块** |
| 协议分发 | `download_manager.rs:595-700`：`is_magnet` / `is_bt_url` / `is_ed2k_url` 前缀判定 + 分支 | ❌ 字符串嗅探 |
| 编译期剔除 | `#[cfg(feature = "bt")]` / `#[cfg(feature = "ed2k")]`，无该 feature 时返回 `UNSUPPORTED_PROTOCOL_MESSAGE` | ✅ **feature 门控** |
| 插件系统 | `native/engine/src/plugin/`（QuickJS 沙箱，19 个模块：audit/bridge/consent/install/market/semver/sniff_pack…） | ✅ 但这是**站点解析插件**，与下载协议无关 |

**结论**：FluxDown 的「模块化」是 **Cargo feature 门控 + URL 前缀分发**，不是运行时插件。BT 和 eD2K 是**硬编码的协议后端**，只是可以被编译掉。

这个区别很重要，因为「模块化」有两种做法，成本差一个数量级：

- **编译期模块化**（FD 的做法）：加一个协议 = 加一个 crate + 改分发分支 + 加 feature。**简单、可控、可裁剪体积**。
- **运行时插件**（QuickJS 那种）：加一个协议 = 用户可以装。**复杂、有沙箱/信任/审计成本**。

对一个桌面下载器，**协议后端应该是编译期模块化**。运行时插件留给「站点解析规则」（今天加个网站明天改版那种），两者别混。

### 3.2 我们已经有的，比想象中多

```rust
// orig-core/src/protocol.rs:304
/// 协议插件：引擎总线上的扩展点。从 URL 创建一个 `Source` 集合。
pub trait Protocol: Send + Sync {
    fn name(&self) -> &'static str;
    fn schemes(&self) -> &[&'static str];
    async fn parse_url(&self, raw: &str) -> Result<ParsedUrl>;
    async fn probe(&self, url: &ParsedUrl, proxy: Option<&ProxyConfig>) -> Result<Metadata>;
    fn capabilities(&self) -> CapabilitySet;
    async fn create_sources(&self, url: &ParsedUrl, cfg: &DownloadConfig)
        -> Result<Vec<Box<dyn Source>>>;
}

// orig-core/src/protocol.rs:283  — 源抽象：一种获取字节的方式
pub trait Source: Send + Sync {
    fn source_kind(&self) -> SourceKind;   // Http / Bittorrent / Ftp / Mock
    fn capabilities(&self) -> CapabilitySet;
    fn weight(&self) -> u32;
    fn iface_name(&self) -> &str;
    async fn fetch_block(&self, block: &Block, token: &CancellationToken,
                         writer: &mut (dyn AsyncWrite + Unpin + Send)) -> Result<()>;
}
```

```rust
// orig-core/src/registry.rs:5 — 插件总线，按 scheme 查找
pub struct Registry { protocols: RwLock<Vec<Arc<dyn Protocol>>> }
impl Registry {
    pub fn register(&self, p: Arc<dyn Protocol>);
    pub fn find_by_scheme(&self, scheme: &str) -> Option<Arc<dyn Protocol>>;
    pub fn list(&self) -> Vec<String>;
}
```

现有实现 2 个：`orig-protocol-http`（`lib.rs:440`）、`orig-protocol-virtual`（`lib.rs:130`）。
注册点：`orig-daemon/src/main.rs:116-119`。
分发点：`orig-daemon/src/routes.rs:360`。

**这个抽象的设计质量高于 FluxDown**：`Source` 把「拿字节」抽成「给我一个 Block，我流式写进 writer」，天然支持多源混合（HTTP 主源 + 镜像 + BT piece 同任务），而 FD 是每个协议各自一个 downloader 模块 + 分支。我们不该退回去抄 FD。

### 3.3 缺的是什么（就三样）

| 缺 | 具体 |
| --- | --- |
| **① `orig-protocol-bt`** | 实现 `Protocol` + 一个 `BtSource`。`SourceKind::Bittorrent` 枚举已留位（`protocol.rs:270`） |
| **② `orig-protocol-ed2k`** | 同上，需要新加 `SourceKind::Ed2k` |
| **③ 装配与门控** | `Cargo.toml` feature（`bt` / `ed2k`）+ `main.rs` 条件注册 + 未编译时的**明确拒绝**（不是静默失败） |

### 3.4 顺序建议：先 BT，后 eD2K，中间插一刀

**BT 优先**，理由不是「更常用」，是**它和现有调度器的契合度不同**：

- BT 的 piece 可以映射到 `Block`，`fetch_block` 语义天然对齐 ⇒ **复用现有调度器**
- eD2K 是**多源同一文件、按 chunk 从不同 peer 拉**，它的「源」概念是动态的（peer 来来去去），和 `Vec<Box<dyn Source>>` 的静态集合有张力。**先做 BT 会把这个张力暴露出来**，而不是等做完 eD2K 才发现抽象要改

**中间那一刀**：BT 做完之后，回头检查 `Protocol` trait 是否需要加「源集合可变」的能力。这个检查要在 eD2K 之前做，否则 eD2K 会变成一堆 `unwrap` 和特例。

**明确不做**：运行时加载 `.so`/`.dll` 协议插件。协议后端是**可信代码**，走编译期；运行时装的是**不可信规则**，走插件沙箱。两条路混在一起，信任边界就没了。

---

## 4. P1-2.2b TG 入库性能：先量，再改

### 4.1 现在的入库链路（逐行读出来的）

```
monitor::spawn (monitor.rs:49)          interval = monitor_interval_secs（默认 30s，config.rs:58）
  └ loop:
      sync_once()      ← 单飞门禁 claim_sync（state.rs:352，全局一把锁）
      └ run_sync_pass  ← for ch in channels        （monitor.rs:129，**频道串行**）
            └ messages(ch, 100, None)              （monitor.rs:137，一页 100 条，Telegram clamp）
            └ for it in items:                     （monitor.rs:145，**逐条串行**）
                  upsert_message(...).await        （store.rs:1330，**每条一次 execute**）
      backfill_once()  ← 同一把单飞门禁
      └ run_backfill_pass                          （每频道每轮**只翻一页**）
```

### 4.2 六个瓶颈（按可疑度排序）

| # | 瓶颈 | 证据 | 为什么可疑 |
| --- | --- | --- | --- |
| B-1 | **逐条 upsert，无事务批量** | `monitor.rs:145-168` 循环里每条一次 `execute`；`store.rs` 全文只有迁移用了 `execute_batch`（885 / 4921），**业务写入零批量** | 100 条 = 100 次 DB 往返。批量后是 1 次事务。**这是最便宜、收益最确定的一刀** |
| B-2 | **单连接** | `store.rs:275` `pub(crate) conn: Connection`（libsql，一条） | BUG-375 已实测同一形态的后果：worker 持写事务时读排队，同一请求 **3.18s / 0.03s / 13.70s**（无竞争时三条 SQL 合计 36ms） |
| B-3 | **回溯每轮只翻一页** | `monitor.rs` 文档：「每轮每频道只翻一页：回溯是长跑」 | 一个 5 万条媒体的频道，回溯 = 500 页 = 500 tick × 30s ≈ **4.2 小时**。这就是「入库慢」的算术来源 |
| B-4 | **增量与回溯共用一把全局锁** | `monitor.rs:196` 注释：两条腿打同一个 RPC 预算 | 回溯期间增量被挡（或反之）。两个方向相反的需求共用一个名额 |
| B-5 | **频道串行** | `monitor.rs:129` `for ch in channels` | 10 个频道 = 10 次 RPC 串行，一轮的墙钟时间被频道数线性放大 |
| B-6 | **前端 60s 轮询写端点** | `TgPanel.tsx:1301` `POST /api/tg/monitor/sync`（BUG-038 引入） | 被单飞挡住后是无效尝试，但**它占的是同一把锁的判定**，且让「到底谁在触发」变得难查 |

### 4.3 五个杠杆（按「收益/风险」排序）

| 杠杆 | 改什么 | 预期 | 风险 |
| --- | --- | --- | --- |
| **L-1 批量 upsert** | `upsert_message` 加一个 `upsert_messages(&[Msg])`，单事务多行 `INSERT ... ON CONFLICT` | 100 次往返 → 1 次。**对 B-1/B-2 同时生效**（一次事务占锁时间从「100 次往返」压到「1 次」） | 低。SQL 语义不变，冲突策略逐字保留 |
| **L-2 回溯按时间预算而非页数** | 「每轮一页」改成「每轮最多翻 K 页或最多 5 秒，先到者停」 | 回溯从 4.2h 量级降到分钟量级（受 flood-wait 约束） | 中。**必须与 flood-wait 联动**，否则账号被打进等待 |
| **L-3 读写分离** | 读路径用第二个连接（或 WAL 读快照） | 消掉 B-2 的争抢 | 中。libsql 单文件多连接要先验证行为 |
| **L-4 频道有限并发** | `for ch` → `buffer_unordered(K)`（K=3~4） | 一轮墙钟时间 ÷ K | 中高。**RPC 预算是全局的**，并发频道会叠加消耗，必须与 flood-wait 联动 |
| **L-5 去掉前端写轮询** | 前端不再 `POST sync`，改由 SSE/轮询**读**端点拿「有 N 条新内容」 | 去掉一路无效触发，触发源从 3 降到 2 | 低。但要改前端提示条的数据来源 |

### 4.4 先量什么（不改代码，先有数字）

**别先改。** 上面五个杠杆里，只有 L-1 是「不用量也知道该做」的，其余三个（L-2/L-3/L-4）都需要先知道**一轮的时间花在哪**。

要采的四个数（一轮 = 一个 tick）：

| 指标 | 怎么采 | 用来判断 |
| --- | --- | --- |
| 一轮总耗时 | tick 开始/结束时间戳 | 是否已经超过 30s 间隔（超了就是自身叠加） |
| RPC 耗时占比 | `messages()` 前后打点 | 如果 RPC 占 80%，那 L-2/L-4 才有意义；如果 DB 占 80%，只有 L-1/L-3 有意义 |
| DB 写入耗时 | 100 次 upsert 累计 | 同上 |
| 单轮实际入库条数 | 已有 `added` 计数（`monitor.rs:179`） | 算真实吞吐：条/秒 |

**这四个数采集成本很低**（现有 `push_log` 通道就能打点），但没有它们，改哪个杠杆都是猜。

> 一条纪律：**「入库慢」不能靠体感判定**。慢在 RPC 还是慢在 DB，对应完全不同的修法。先量，再动。

---

## 5. P1-2.3 二进制稳定性

### 5.1 三个具体缺口（不是「感觉不稳」）

**缺口 1：`/health` 不报版本 ⇒ 更新后跑的是旧引擎**

```rust
// orig-daemon/src/routes.rs:122
async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok"}))   // ← 只有 ok
}
```

后果链条：

1. 用户装了新版本 → `orig-daemon.exe` 换了
2. 旧 daemon 进程**还在跑**（上次没退）
3. 新壳 `ensure_daemon` → `daemon_alive_on(port)` → `/health` 返回 `ok`
4. `port_owner_is_daemon_on` 判定「是本项目的 daemon」→ **复用**
5. ⇒ **用户体感：更新了但没变化**

这和 `sync-sidecars.sh` 开头记的「四处副本 + 陈旧静默」是**同一类缺陷的两个面**：一个在构建期，一个在运行期。

**修法**：`/health` 返回 `{"status":"ok","version":env!("CARGO_PKG_VERSION"),"build":"<git sha 或构建时间>","pid":...}`；壳侧比较 version，**不匹配就杀掉重启**（并把这次替换写进 trace，让「为什么重启了」可查）。

> 验收判据：**手工把 daemon 换成旧版二进制 ⇒ 启动壳 ⇒ 必须自动替换并留下一条 trace**。反向：版本一致时**不许**重启（否则每次开 APP 都杀一次引擎，把正在下载的任务全打断）。

**缺口 2：没有任何崩溃监管**

`lib.rs` 全文 grep：`RunEvent` / `try_wait` / `ExitRequested` / `on_window_event` **零命中**。

- daemon 崩了 → 壳不知道，前端每个请求 `Failed to fetch`，用户只看到「什么都点不动」
- 壳退了 → `stop_daemon` 只有前端主动调用时才杀（`lib.rs:425`），**关窗口不会自动杀** ⇒ 孤儿进程

**修法**：`app.run()` 换 `build().run(|app, event| ...)`，在 `RunEvent::ExitRequested` / `Exit` 里 kill child；加一个轻量 watchdog（复用现有 `daemon_alive_on`，10s 一次），连续 N 次失败 ⇒ 自动重启 + 记 trace + 前端显示「引擎已重启」。

> 注意：watchdog 必须**幂等且退让**——已有 `ensure_daemon` 的「三态判定」教训（`lib.rs:299-309`：wmic 不可用导致健康 daemon 被误杀，dev 栈和 APP 一起挂）。watchdog 不能重犯。

**缺口 3：四处副本的陈旧判定只在构建期**

`sync-sidecars.sh` 已经解决了构建期（`--check` 会在源比二进制新时失败），但**运行期没有对应机制**——装了新包、旧进程还在跑，就是缺口 1。

**修法**：缺口 1 的 version 握手就是运行期的解。两者合起来才闭环：

```
构建期：源 vs 二进制  → sync-sidecars.sh --check（已有）
运行期：包版本 vs 进程版本 → /health.version 握手（缺）
```

### 5.2 顺带记一条：`orig-tg` 的生命周期已经有主人了

`lib.rs:490` 的注释写得很清楚（BUG-178）：**桌面壳不再自己拉起或杀死 orig-tg**，进程生命周期归 daemon 独占——「两个主人会互相 kill」，「谁去重启它」不该是留给用户点的按钮。

这条纪律要延伸到新的播放器 sidecar：**一个进程只能有一个主人**。别让壳和 daemon 都能管播放器。

---

## 6. P1-2.4 托盘常驻

### 6.1 已经有的（`lib.rs:549` setup 内，托盘在 `:555`）

```rust
let show = MenuItem::with_id(app, "show", "显示 Orig Hub", ...)?;
let quit = MenuItem::with_id(app, "quit", "退出", ...)?;
let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(...)   // show → 显示+聚焦；quit → app.exit(0)
    .build(app)?;
```

依赖也已开：`tauri = { features = ["tray-icon", "image-png"] }`（`Cargo.toml`）。

**所以「右下角 ICON」这件事本身已经做完了。** 缺的是「常驻」——现在点 X 就退出了，根本没有「常驻」可言。

### 6.2 「常驻」缺的四件事

| # | 缺什么 | 现状 | 为什么必须有 |
| --- | --- | --- | --- |
| T-1 | **关窗不退出** | 无 `on_window_event` / `CloseRequested` 处理 ⇒ 点 X = 退出 | 这是「常驻」的定义。没有它，托盘只是个多余的图标 |
| T-2 | **托盘状态提示** | 只有静态图标，无 tooltip | 用户不看主窗时，要知道「在下什么、多快、几条在跑」。**这是常驻的唯一价值** |
| T-3 | **托盘快捷动作** | 菜单只有「显示 / 退出」 | 至少要有：暂停全部 / 继续全部 / 打开下载目录 / 打开主窗。否则每次都要开窗 |
| T-4 | **开机自启** | 无 | 常驻的另一半。不自启 = 每次开机手动点 |

补充两条容易被漏的：

- **T-5 单实例已有**（`tauri_plugin_single_instance`，`lib.rs:537`）——二次启动聚焦主窗。常驻后要确认这条仍然成立（最小化到托盘时二次启动应当**显示**窗口，而不是什么都不做）。
- **T-6 首次「关窗到托盘」要给一次提示**，否则用户以为关不掉，会去任务管理器杀。**只提示一次**，别每次烦。

### 6.3 落地顺序

```
T-1 关窗不退出  ←  必须先做，否则 T-2/T-3 没有意义
   ↓
T-3 快捷动作（数据源已有：daemon 的 /api/activity 就是干这个的）
   ↓
T-2 状态提示（托盘 tooltip 要节流，别每 5s 刷一次图标；图标闪烁在 Windows 上是性能陷阱）
   ↓
T-4 开机自启（最后做：它把一个「可能会崩」的软件变成「每次开机都崩」）
```

> T-4 放最后不是因为它难，是因为**它把故障从「用户主动打开」变成「开机自动发生」**。在 2.3 的崩溃监管做完之前上自启，等于把不稳定放大到每次开机。

### 6.4 一个必须提前定的产品决策

**关窗到托盘之后，正在下载的任务继续跑，还是暂停？**

- 继续跑：符合下载器常识，但用户「关了还在跑」会有意见（流量/电费）
- 暂停：符合「我关了」的直觉，但常驻就失去意义

FluxDown 的做法可以参考：`native/agent/src/shell/tray_model.rs:29` 里托盘可见性 = `snapshot.shell.tray_available && snapshot.shell.resident`，而且它有 **`power` 状态和「关机倒计时」** —— 说明它的托盘承担「下载完成后关机」这个场景。

**这条要你定，不能我们猜。**

---

## 7. 依赖顺序（不含时间估计）

```
                    ┌─────────────────────────────────┐
                    │ 2.3 二进制稳定性（/health 版本握手）│  ← 所有后续的地基
                    └───────────────┬─────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐        ┌──────────────────┐
│ 2.4 T-1 关窗常驻│         │ 2.1 Step1 可配   │        │ 2.2b 先量四个数    │
└───────┬───────┘         └────────┬────────┘        └────────┬─────────┘
        ▼                          ▼                          ▼
┌───────────────┐         ┌─────────────────┐        ┌──────────────────┐
│ 2.4 T-3/T-2   │         │ 2.1 Step2 受管安装│        │ 2.2b L-1 批量 upsert│
└───────┬───────┘         └────────┬────────┘        └────────┬─────────┘
        ▼                          ▼                          ▼
┌───────────────┐         ┌─────────────────┐        ┌──────────────────┐
│ 2.4 T-4 自启   │         │ 2.1 Step3 硬解可见│        │ 2.2b L-2/L-3/L-4  │
└───────────────┘         └─────────────────┘        └──────────────────┘

        ┌──────────────────────────────────────────────┐
        │ 2.2a BT 协议（独立轨，与上面并行不冲突）        │
        │   → 中间检查 Protocol trait 是否要改            │
        │   → eD2K                                       │
        └──────────────────────────────────────────────┘

        ┌──────────────────────────────────────────────┐
        │ 播放器 GPUI spike（§1 的下游，S-6 一票否决）    │  ← 独立轨，不阻塞上面
        └──────────────────────────────────────────────┘
```

三条判断：

1. **2.3 必须最先**。它不改功能，但它是「其他所有东西能不能被信任」的前提。版本握手不做，后面每一条的验收都可能是在测一个旧引擎。
2. **2.4 的 T-1 是 15 分钟的事，但它解锁 T-2/T-3 的全部价值**。先做。
3. **2.2a（协议）和 2.2b（TG 提速）是两条独立的腿**，不要串起来排——一个动 `orig-core` 的 trait，一个动 `orig-tg` 的 store/monitor，改的文件几乎不重叠。

---

## 8. 需要你定的三件事

| # | 决策 | 选项 |
| --- | --- | --- |
| D-1 | 关窗到托盘后，下载**继续**还是**暂停**？ | 继续（下载器常识）/ 暂停（用户直觉）/ 可配置（默认哪个？） |
| D-2 | 2.2b 先改哪一刀？ | 先量再改（稳，多一轮）/ 先上 L-1 批量 upsert（不用量也知道该做） |
| D-3 | 2.1 受管安装的**下载源**用哪家？ | BtbN 官方（照抄 FD，国内需镜像）/ 国内镜像为主（自建或指定）/ 只支持手动指定路径（最省，但用户体验差） |

---

## 9. 复核命令（每条结论都能自己验）

```bash
# 托盘已存在
grep -n "TrayIconBuilder" tauri-shell/src-tauri/src/lib.rs          # → 555

# 无崩溃监管
grep -n "RunEvent\|on_window_event\|ExitRequested" tauri-shell/src-tauri/src/lib.rs   # → 0 命中

# /health 不报版本
grep -n -A3 "async fn health" download-engine/crates/orig-daemon/src/routes.rs        # → 只有 status:ok

# 协议抽象 + 注册表已在
grep -n "pub trait Protocol\|pub trait Source" download-engine/crates/orig-core/src/protocol.rs
grep -rn "impl Protocol for" download-engine/crates/                                  # → http / virtual 两个

# 逐条串行 upsert
sed -n '129,181p' download-engine/crates/orig-tg/src/monitor.rs

# 单连接
grep -n "conn: Connection" download-engine/crates/orig-tg/src/store.rs                 # → 275

# 硬解已接线（不是只有定义）
grep -n "ffmpeg_config\|input_args" download-engine/crates/orig-tg/src/routes.rs       # → 5503 / 5831

# 设置页故意留空
grep -n "engine.placeholderHint" tauri-shell/src/i18n/locales/zh-CN.json               # → 121
```
