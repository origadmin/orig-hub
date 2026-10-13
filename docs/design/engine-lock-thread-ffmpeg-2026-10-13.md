---
status: draft
author: 架构分析（AI 协作者）
date: 2026-10-13
topic: delivery
module: engine+shell
decided-by: —
decided-at: —
landed-in: 部分（**ELT-T01 / ELT-T03 已于 2026-10-13 实施并实测**，见 `docs/bugs/BUG-293.md`；ELT-T02 / T04~T07 未开工）
---

# 引擎三问题：锁 / 线程 / ffmpeg 插件化设置

- 日期: 2026-10-13
- 类型: 缺陷归因 + 架构规格 + 任务分解
- 触发: 用户 2026-10-13 明示三条 —— 「**①锁问题 ②线程问题（像 TG 一样不卡线程的）③ffmpeg 设置问题：ffmpeg 采用插件模式，参数通过设置配置，选择硬解，默认开启**」
- 关联缺陷: `BUG-293`（回压死锁，本日新建）/ `BUG-288` / `BUG-273` / `BUG-274` / `BUG-290` / `BUG-289` / `BUG-291`
- 关联设计: `product-direction-and-ffmpeg-2026-10-09.md` §2.5（PD-T06 ffmpeg 组件化）、`playback-delivery-optimal-2026-10-13.md`（播放投递最优形态）
- 取证方式: 全部为**本机 2026-10-13 实测**（进程 CPU 读数、`netstat`、代码位置），逐条可复核

> **定位声明**：本文**不替代**上述两份设计，也不改写它们的结论。
> 它只把用户点名的**三个面**逐条落成「现状实测 → 缺口 → 可核验规格 → 判据 → 任务表」。
> **行号说明**：所引行号取自 2026-10-13 工作区（`routes.rs` 有未提交改动）；**行号会随代码移动**，
> 判定请以**构造名**（`acquire_transcode_role` / `peer_cache` / `stall_limit` / `FFMPEG_CONFIG`）为准。

---

## 0. 结论摘要

| # | 用户点名 | 一句话结论 | 本档任务 |
|---|---|---|---|
| 1 | **锁问题** | 有**两处真实**锁缺陷：①单飞表 `.expect("poisoned")`（一处 panic ⇒ 之后**每次**播放请求 panic）②`peer_cache` 锁**跨网络 `.await`** 持有（串行化 `getChannels`）。**另有**单条 SQLite 连接在播放路径上（BUG-274）。 | ELT-T01 / T02 / T07 |
| 2 | **线程问题**（像 TG） | 我们**并不卡线程**（转码是**子进程**不是线程，CPU 实测 3%/0%/30%）。真正卡住的是**任务模型**：编码器在请求路径上，且**消费者阻塞会反压死锁生产者**（BUG-293）。TG 的形态 = 播放路径上**没有编码器**。 | ELT-T03 / T04 |
| 3 | **ffmpeg 插件化设置** | **能力探测与推荐配置已实现**（PD-T06），**硬解已默认开启**；缺的是**「可设置」** —— 无 UI、无持久化、无显式后端选择、`OnceCell` 进程级一次性缓存改不动。 | ELT-T05 / T06 |

---

## 1. 问题一：锁

### 1.1 现状清单（实测 2026-10-13）

| 锁 | 位置 | 类型 | 毒化处置 | 判定 |
|---|---|---|---|---|
| `TRANSCODE_INFLIGHT` | `routes.rs:4023-4028` | `std::sync::Mutex` | **`:4097` 用 `.expect("transcode map poisoned")`** | **缺陷 L1** |
| `TITLE_BACKFILL_ATTEMPTS` | `routes.rs:1401-1402` | `std::sync::Mutex` | `unwrap_or_else(\|e\| e.into_inner())` | 正确 |
| LRU | `lru.rs:25` | `std::sync::Mutex` | `.lock().ok()?` / 显式处理 | 正确（文件头已声明「临界区内无 await」） |
| `peer_cache` | `grammers.rs:191` | `tokio::sync::Mutex` | — | **缺陷 L2** |
| `pending` | `grammers.rs:188` | `tokio::sync::Mutex` | — | 待复核 |
| `Store.conn` | `store.rs:100-108` | 单条 libsql `Connection`（库 + TG 流水共库） | — | **缺陷**（BUG-274：播放路径每请求打 DB） |
| `FFMPEG_CONFIG` | `routes.rs:4395` | `tokio::sync::OnceCell` | — | 见 §3（不可改） |

### 1.2 缺陷 L1：单飞表 `.expect("poisoned")` ⇒ 一处 panic 让**全部播放**请求 panic

`acquire_transcode_role`（`routes.rs:4096-4104`）：

```rust
fn acquire_transcode_role(key: TranscodeKey) -> Role {
    let mut m = transcode_inflight().lock().expect("transcode map poisoned");
    if let Some(rx) = m.get(&key) { return Role::Wait(rx.clone()); }
    let (tx, rx) = tokio::sync::watch::channel(false);
    m.insert(key, rx);
    Role::Start(tx, Some(TranscodeSlot::new(key)))
}
```

`std::sync::Mutex` 在**持锁线程 panic** 后进入 poisoned 状态；此后**每一次** `.lock()` 都返回 `Err`，
`.expect(...)` ⇒ **panic**。而 `acquire_transcode_role` 在**每个** `/stream` 请求上都会走
⇒ **一次持锁 panic = 该进程内所有播放请求永久失败**（只能重启）。

**与 BUG-288 的关系**：BUG-288 的「待查」列出候选「**持锁期间 panic 毒化互斥锁**」。
本档给出该候选的**具体落点**（`:4097`），把它从「候选」升级为**可判定的缺陷**。
同一文件 `:4069` 的 `reclaim_transcode_slot` 用的是 `if let Ok(mut m) = ...lock()`（**graceful**）
⇒ **同一把锁两种毒化策略**，本身就是不一致。

### 1.3 缺陷 L2：`peer_cache` 锁跨网络 `.await` 持有

`grammers.rs:503` 起：

```rust
let mut cache = self.peer_cache.lock().await;        // :503
if !input_channels.is_empty() {
    match self.inner.invoke(&request).await { ... }  // :513  ← 网络往返，锁仍被持有
    ...
}
```

`cache` 的生命周期覆盖 `invoke().await` ⇒ **一次 MTProto 往返期间整把锁不释放**。
`peer_cache` 的其它使用点（`:338` / `:353` / `:420` / `:797`）都要等这把锁
⇒ 任一次 `getChannels` 慢，会**串行阻塞**所有 peer 解析。
（BUG-193 实测日志「batch failed for 66 channel(s) → per-peer retry ok=3 bad=63」说明该路径确实跑得很久。）

### 1.4 规格

- **S-L1**：全仓 `Mutex` 毒化处置**必须统一且不得 panic**。`transcode_inflight` 改为
  `unwrap_or_else(|e| e.into_inner())`（与 `TITLE_BACKFILL_ATTEMPTS` 一致），或换 `parking_lot`（无毒化概念）。
- **S-L2**：`tokio::sync::Mutex` **不得跨 `.await` 持有**（除非该 await 是被保护资源的固有部分）。
  `peer_cache` 改为「锁内只读写 map，网络调用在锁外」。
- **S-L3**：**播放路径不得做 SQL**。`library_root()` 进程内缓存（BUG-274 修复项 ①）。
- **S-L4**：新增共享状态前，**先答「毒化了怎么办」**再写 `lock()`。

---

## 2. 问题二：线程（「像 TG 一样不卡线程」）

### 2.1 先纠正一个可能的误解：我们**不卡线程**

- 转码是**子进程**（`ffmpeg.exe`，`tokio::process::Command`），**不是线程**；
- 运行时是 `#[tokio::main]` 多线程（`main.rs:149`），worker 默认 = 核数；
- 唯一的 CPU 重活 `enforce_proxy_budget` 已用 `spawn_blocking`（`routes.rs:4882`）。

**实测反证**（用户卡顿时，2026-10-13 04:28）：`orig-tg` **3%**、ffmpeg **0%**、系统 **30%**（20 核）。
⇒ **卡的不是 CPU，是「等」。**

### 2.2 真正卡住的是**任务模型**（对照 TG）

| 维度 | Telegram Web | 本仓现状 |
|---|---|---|
| 播放路径上有编码器吗 | **没有**（上传期已编好） | **有**（每个冷变体实时 ffmpeg） |
| 字节怎么给浏览器 | Service Worker 按 `Range` 回 **206**（0.5 MB 分片），浏览器驱动预取 | `/stream` 冷启动是**单向 fMP4**，实时转码必须跑赢播放头 |
| 生产者/消费者 | **无耦合**（纯读已存字节） | **强耦合**：`resp_tx`（**32 槽**）满 ⇒ 泵阻塞 ⇒ 停读 ffmpeg stdout ⇒ ffmpeg 被反压顶死 |
| 消费者停读时 | 无影响（无生产者） | **永久死锁**（BUG-293），且守卫不可达 |

⇒ **「像 TG 一样」的本质不是「多开线程」，而是「播放路径上没有生产者」。**
只要编码器还在播放路径上，「消费者慢 ⇒ 生产者停 ⇒ 双方互等」这个结构就**必然**存在。

### 2.3 规格

- **S-T1（结构性，最高优先）**：**把编码器移出播放路径** —— 与 `playback-delivery-optimal-2026-10-13.md`
  §3.1 的三档路由同向。**本文不重复该决策**（见 §6 D1 指向该文）。
- **S-T2（结构性，独立于 S-T1）**：生产与消费**必须解耦**，任一侧阻塞**都不得让另一侧永久停摆**：
  - 响应通道**不得**成为生产者的阻塞点：改 `try_send` + 明确策略（丢最旧 / 断开该客户端），
    或把「写客户端」交给**独立转发任务**，泵只负责「读 ffmpeg → 写 `.part` → 投递到可丢缓冲」；
  - 泵的「无进展」判定**必须覆盖泵自身阻塞**（BUG-293 修复项 ①）。
- **S-T3**：单飞表**只锁 map、不锁 IO**（当前已如此，须保持）；`wait_for_transcode` 的 600 s 改为**有界探测 + 快速 503**。
- **S-T4**：转码并发**必须设上限**（BUG-290），且**前台播放优先**。

---

## 3. 问题三：ffmpeg 插件化 + 参数可设置

### 3.1 **已实现**（勿重复做）

| 能力 | 落点 | 状态 |
|---|---|---|
| 静态能力探测（`-hwaccels` / `-encoders` / `nvidia-smi` / WMI） | `ffmpeg_caps.rs`（PD-T06） | ✅ 纯函数、可单测 |
| 推荐配置生成（保守默认 + 可回退） | `ffmpeg_caps.rs::probe_config` | ✅ |
| 多显卡**显式**选后端与设备（**故意不设 `Auto` 变体**） | `HwAccel` 类型设计 | ✅ |
| 接线进转码（输入侧 `-hwaccel` / `-hwaccel_device`） | `routes.rs::ffmpeg_config` → `FfmpegConfig::input_args()` | ✅ |
| **硬解默认开启** | `ffmpeg_config` 默认 `auto`（按探测结果启用） | ✅ **已满足用户「默认开启」** |
| 关闭开关 | env `ORIG_TG_HWACCEL=off` | ✅（但**仅 env**） |
| ffmpeg 路径可指定 | env `ORIG_FFMPEG_PATH` + 6 级解析链（`routes.rs:4321-4348`） | ✅（但**仅 env**） |

### 3.2 缺口（用户要的「可设置」）

| 缺口 | 现状 | 用户诉求 |
|---|---|---|
| **无 UI** | `SettingsPanel.tsx` 只有 downloads / network / proxy / general / about（`:542/:740/:812/:932/:1134`），**无 ffmpeg 段** | 参数通过设置配置 |
| **无持久化** | 只有 env；`app_setting` 表存在但**未用于 ffmpeg** | 参数通过设置配置 |
| **不可选择硬解** | 只有 `auto`（探测决定）与 `off`（env） | **选择**硬解 |
| **配置不可改** | `FFMPEG_CONFIG: OnceCell`（`routes.rs:4395`）**进程级一次性**，改配置必须重启 | 可设置 |
| **「插件模式」未定义** | ffmpeg 是**硬依赖**：缺失 ⇒ `/stream` 直接 **501**（`routes.rs:4522-4527`） | ffmpeg 采用**插件模式** |

### 3.3 规格

**S-F1 设置项 schema**（持久化到 `app_setting`，与 `library_dir` 同链：**env > app_setting > 默认**）

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `ffmpeg.enabled` | `true` / `false` | **`true`** | 插件总开关（关 ⇒ 不做兼容流；可直解内容仍须可播，见 EL-P7） |
| `ffmpeg.path` | 路径串 / 空 | 空（走解析链） | `ORIG_FFMPEG_PATH` 的设置化 |
| `ffmpeg.hwaccel` | `off` / `auto` / `cuda` / `d3d11va` / `dxva2` / `qsv` / … | **`auto`** | **默认开启**：`auto` = 按探测结果启用 |
| `ffmpeg.hwaccel_device` | 设备号串 / 空 | 空（用探测推荐） | 多显卡时显式指定 |
| `ffmpeg.hwencode` | `true` / `false` | **`false`** | 硬编默认**关**（§2.5.2 实测 nvenc / qsv / amf 不可用） |

**S-F2 生效方式**：设置变更 ⇒ **失效 `FFMPEG_CONFIG` 缓存并重新探测**（**不得**要求重启进程）；
探测结果与**最终生效**配置必须**如实展示**（`describe(&cfg)` 已具备）。

**S-F3「插件模式」定义（须拍板，见 §6 D2）**：至少包含
① 可**启用/禁用**（禁用时播放路径不依赖它）；
② 可**替换实现**（自定义路径 / 第三方构建）；
③ 能力与参数**自描述**（探测结果 + 实际生效参数可查，供 diag）；
④ **不因它缺失而使播放整体不可用**（HEVC 直解不可用时给**可行动指引**，而非静默降级）。

**S-F4 不得回退**：硬解**默认必须仍为开启**；`HwAccel` **不得**重新引入 `Auto` 变体
（§2.5.6 实测 `auto` 会选到非独显）。

---

## 4. 判据与反向证伪

| 编号 | 判据 | 反向证伪 |
|---|---|---|
| EL-P1 | 持锁线程 panic 后，`/stream` **仍能返回**（不得 panic） | 改回 `.expect(...)` + 注入持锁 panic ⇒ 请求必 panic ⇒ FAIL |
| EL-P2 | `peer_cache` 在 `invoke().await` 期间**未被持有**（另一任务可在该窗口取得锁） | 改回锁跨 await ⇒ 并发 `getChannels` 必串行 ⇒ FAIL |
| EL-P3 | 客户端**停读**后，泵在 **≤ 2×`stall_limit`** 内杀进程 + 出表 + 清 `.part`（= BUG-293 判据） | 改回守卫置于循环顶部 ⇒ 必挂到 600 s ⇒ FAIL |
| EL-P4 | 泵**不得**因响应通道满而停止读 ffmpeg stdout（`.part` 在客户端停读后按策略推进，或**明确断开**，**不得静默冻结**） | 改回 `send().await` ⇒ `.part` 必冻结 ⇒ FAIL |
| EL-P5 | 改 `ffmpeg.hwaccel` 后**无需重启**即生效，且 `describe()` 与 ffmpeg 实际命令行一致 | 改回 `OnceCell` 不失效 ⇒ 仍用旧配置 ⇒ FAIL |
| EL-P6 | **默认值** = `enabled=true` / `hwaccel=auto`（硬解默认开启） | 把默认改成 `off` ⇒ FAIL |
| EL-P7 | 禁用 ffmpeg（`ffmpeg.enabled=false`）时，**可直解内容仍可播放**（不得整体不可用） | 禁用后一律 501 ⇒ FAIL |

---

## 5. 任务表

| Task ID | 任务名 | 源文件 | 依赖 | 优先级 | 状态 | 负责 |
|---|---|---|---|---|---|---|
| ELT-T01 | 单飞表毒化处置统一（去 `.expect`） | `download-engine/crates/orig-tg/src/routes.rs:4097` | 无 | P0 | **已实施（2026-10-13）** | 本组（用户当日授权改代码） |
| ELT-T02 | `peer_cache` 锁不得跨网络 await | `download-engine/crates/orig-tg/src/grammers.rs:503-513` | 无 | P1 | 未开工 | 待指派 |
| ELT-T03 | 泵/响应解耦 + 「无进展」判定覆盖泵自身阻塞（BUG-293） | `download-engine/crates/orig-tg/src/routes.rs:4815-4857` | 无 | P0 | **已实施（2026-10-13）** | 本组 |
| ELT-T04 | `wait_for_transcode` 有界探测 + 快速 503 | `download-engine/crates/orig-tg/src/routes.rs:4132-4150` | ELT-T03 | P1 | 未开工 | 待指派 |
| ELT-T05 | ffmpeg 设置项 schema + 持久化（`app_setting`） | `download-engine/crates/orig-tg/src/store.rs`、`routes.rs` | 无 | P1 | 未开工 | 待指派 |
| ELT-T06 | 设置 UI（ffmpeg 段）+ 缓存失效重探 | `tauri-shell/src/components/SettingsPanel.tsx`、`routes.rs:4395-4424` | ELT-T05 | P1 | 未开工 | 待指派 |
| ELT-T07 | 播放路径零 SQL（`library_root()` 进程内缓存） | `download-engine/crates/orig-tg/src/store.rs:723-738` | 无 | P1 | 未开工 | 待指派 |

**状态**：ELT-T01 / ELT-T03 已实施并经三段可复现测试验证（`docs/bugs/BUG-293.md` → `## 验收证据`）；
其余 `未开工`。**负责**：已完成项由本组实施（用户 2026-10-13「我只看结果」授权改代码），其余待指派。

**计划外追加（同轮，用户「我只看结果」期间发现）**：`encode_profile` 的 `speed_hundredths >= 300` 档
`fps: 24` → **`fps: 30`**（执行 `docs/bugs/BUG-289.md` 已登记的修法②「输出 fps 取整除刷新率的值」）。
不属原 ELT 任务表，登记在 BUG-289 的「后续复核」节。

---

## 6. 已定与自决（**无新增待拍板**）

> 依据 `docs/rules/decision-spec.md` **§四**：「方案/模式选择 = 待拍板；**方案内的执行细节 = 工程师自决，不得回抛**」，
> 判据是「**选项之间的差别是否影响用户体验 / 数据模型 / 既有能力**」。
> 用户本次指令**已给出方向** ⇒ 按「**目的已定 ⇒ 结论已定**」，下列事项**不再回抛**。

### 6.1 用户已定（2026-10-13 原话照录）

| # | 用户原话 | 落地含义（本档据此写规格） |
|---|---|---|
| ① | 「**锁问题**」 | 锁必须被处置：去毒化 panic（S-L1）、不得跨 `.await` 持有（S-L2）、播放路径零 SQL（S-L3） |
| ② | 「**线程问题（像 TG 一样不卡线程的）**」 | 目标态 = **播放路径上不出现「生产者等消费者」**（TG 的形态：播放路径无编码器 + 字节按 `Range` 直供）。据此定 S-T2（解耦）与 S-T4（并发上限）；**结构性手段**见 `playback-delivery-optimal-2026-10-13.md` §3.1 |
| ③ | 「**ffmpeg 采用插件模式，参数通过设置配置，选择硬解，默认开启**」 | 插件化（S-F3）+ 设置 schema（S-F1）+ 硬解**可选**（`ffmpeg.hwaccel`）+ **默认开启**（默认值 `auto`，EL-P6）。**方向已定，不另开决策项** |

### 6.2 工程师自决（不得回抛）

| 事项 | 自决结论 | 依据 |
|---|---|---|
| `transcode_inflight` 毒化处置方式 | 用 `unwrap_or_else(\|e\| e.into_inner())`（与 `TITLE_BACKFILL_ATTEMPTS` 一致），**不引入新依赖** | 差别不影响 UX / 数据模型 / 既有能力；同文件已有先例 |
| `peer_cache` 解锁写法 | 「锁内只读写 map，网络调用在锁外」两段式 | 同上 |
| 硬解选择的**呈现粒度** | 设置项给 `off` / `auto` / 显式后端 + 设备号；**下拉项由探测结果生成**（探测不到的后端不出现） | 方案内执行细节；`HwAccel` 已无 `Auto` 变体，设置层的 `auto` 只是「按探测推荐」 |
| 「插件模式」的**实现形态** | `ffmpeg.enabled` 开关 + `ffmpeg.path` 覆盖 + `describe()` 自描述；禁用/缺失时给**可行动指引** | 用户已定「插件模式」，其边界由「插件」一词唯一确定 |

### 6.3 与既有裁定的关系（**不改写**）

- ②「像 TG 一样」若理解为**结构性**手段（把编码器移出播放路径），会触及 **BUG-230（2026-10-09 用户裁定 stream-first）**。
  按 `docs/rules/doc-first.md` §2.4 与 BUG-082 先例：**变更既有裁定须「追加节 + 历史锚定」，不改写正文**。
  该议题已在 `playback-delivery-optimal-2026-10-13.md` §6 的 **D1** 提出 —— **本档不另开、不重复询问**。
- 本档 §1–§3 的规格**均不要求**先改 BUG-230：S-L1/L2/L3、S-T2/T3/T4、S-F1~F4 **都在现行架构内可落地**。

---

## 7. 关联

- `docs/bugs/BUG-293.md` —— 回压死锁（本文 §2.2 / §4 EL-P3 的直接对象）
- `docs/bugs/BUG-288.md` —— 其「待查」候选 = 本文 §1.2 的具体落点
- `docs/bugs/BUG-273.md` / `BUG-274.md` / `BUG-290.md` / `BUG-289.md` / `BUG-291.md`
- `docs/design/product-direction-and-ffmpeg-2026-10-09.md` §2.5（PD-T06；本文 §3 建在其上）
- `docs/design/playback-delivery-optimal-2026-10-13.md`（本文 §2.3 S-T1 与 §6 D1 指向该文）
- `AGENTS.md` §5「投递契约」「投递背压」

---

## 变更记录

> 依 `docs/rules/doc-first.md` §2.4：**只追加，不改写既有结论**。

| 日期 | 谁 | 改了哪节的结论 | 为什么 |
|---|---|---|---|
| 2026-10-13 | 架构分析（AI 协作者） | **建立本文**：§0 三问结论摘要、§1 锁（清单 + L1 `.expect` 毒化 panic + L2 `peer_cache` 跨 await + 规格）、§2 线程（先纠正「不卡线程」+ TG 对照 + 规格）、§3 ffmpeg（**已实现 vs 缺口** + 设置 schema + 插件模式定义）、§4 判据 EL-P1~P7、§5 任务表 ELT-T01~T07、§6 **已定与自决**（用户原话照录 + 工程师自决，**无新增待拍板**） | 用户 2026-10-13 明示三条待办（锁 / 线程 / ffmpeg 插件化设置）。本文把三条**逐条落成可核验规格**；不改写既有两份设计的结论。**§6 依 `decision-spec.md` §四「目的已定 ⇒ 结论已定」处理**：用户已给方向（尤其第③条已直接指定「插件模式 / 参数经设置 / 硬解可选 / 默认开启」），**不得再把已定的回抛成待拍板**；唯一触及既有裁定的议题（是否改 BUG-230 的 stream-first）指向既有文档，不另开 |
| 2026-10-13 | 架构分析（AI 协作者） | **追加实施记录**：§5 任务表补 `状态`/`负责` 两列，ELT-T01（毒化不再 panic）与 ELT-T03（泵两处阻塞点各加 30 s `tokio::time::timeout`）标 **已实施**；`landed-in` 由「无」改为「部分」；追加「计划外追加」条目（`encode_profile` ≥3x 档 `fps 24 → 30`） | 用户当日追加指令「**我只看结果**」⇒ 授权直接改代码。三段可复现测试（1x 立即取消 / FRC 续写落盘 / 同键快速 200）+ 反向证伪全部 PASS，详见 `docs/bugs/BUG-293.md` → `## 验收证据`。**本文不改写 §0~§4、§6 的任何既有结论**，只登记实施状态 |
