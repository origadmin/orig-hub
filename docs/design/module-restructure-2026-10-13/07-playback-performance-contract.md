# 播放流畅度零损失契约（模块重构的性能红线）

- 日期：2026-10-13
- 用户硬性要求（原话要点）：**首先保证播放器播放流畅，性能不能有任何损失；之前改了很多版本才勉强合格。**
- 本文档效力：是 M0-M5 所有模块/接口划分的**上位约束**。任何架构决定与本文冲突，以本文为准；无法证明不劣化的改动不予合并。
- 配套：[02-backend-architecture.md](02-backend-architecture.md)、[06-ffmpeg-integration-analysis.md](06-ffmpeg-integration-analysis.md)、AGENTS.md §5（§D1/D3/D5/D6）

---

## 快速概览（TL;DR）

| 项 | 红线 |
|---|---|
| 总原则 | **能不转就不转，能直连就不多跳**。播放热路径上不允许新增任何进程跳、代理跳、缓冲拷贝 |
| 服务拆分 | M3 把媒体移到 daemon 时，`serve_local_file` 与转码泵**连同函数一起搬**；播放 URL 的连接终点就是文件持有进程——daemon 持库文件后由 daemon 直接吐字节，不存在 daemon→tg 回源 |
| 插件边界 | 插件（TG 及未来插件）**只在「采集/缓存」侧**；一旦字节归仓，播放与插件进程存活与否无关。插件进程退出不得影响任何已入库内容播放 |
| 档级策略 | 原生直出（无 ffmpeg）→ 重封装 `-c copy`（CPU 近零）→ GPU 硬解转码（NVDEC/QSV/D3D11VA）→ 软解兜底；每档有判定与回退 |
| 前端度量 | 卡顿判据只认 `requestVideoFrameCallback` + `getVideoPlaybackQuality()`；禁用 timeupdate/rAF 判卡顿；readyState 满格 ≠ 能播；`decodeHealth` 探测必经 |
| 防回退机制 | **M3 开工前先录制基线机数据**（TTFB/206 间隔/节流倍数/rVFC 掉帧/CPU），重构后同片源同机对比，任一指标回退超阈值即 FAIL |

---

## 1. 播放热路径的物理拓扑（逐跳标注，重构前后对比）

### 1.1 现状（已调优合格的路径）

```
<video src=/api/media/items/:id/raw>  或  /stream
   → orig-tg（媒体+字节同进程持有）
       raw:   serve_local_file（routes.rs:5084）→ 直接文件 IO + 背压节流
       stream: ffmpeg transcode pump（从 .part/文件读，FRC 节流）→ 206/200
```

TG 在线取流（尚未归仓）：`parallel_range_stream`（K=4）→ TtlLru 元数据/缩略图（§D3）。

### 1.2 M3 之后必须保持的形态

```
库内播放（任何来源，含已归仓 TG）：
<video> → orig-daemon → serve_local_file / transcode pump → 库根文件
            （同一进程：连接终点 = 文件持有者；零回源跳）

TG 缓存预览（字节还在 TG 缓存区、未归仓）：
<video> → orig-tg → serve_local_file（orig-file-serve 同一函数）→ 缓存文件

TG 在线流（不落盘直看）：
<video> → orig-tg → parallel_range_stream K=4（不变，留在插件面）
```

**红线判据（M3 代码评审逐条 grep/抓包验证）：**

1. daemon 的 `/api/media/items/:id/raw|stream` 处理函数内**禁止出现任何 HTTP 客户端调用 orig-tg**（回源即零损失违约）；
2. 播放路径上禁止新增序列化边界（不经消息队列、不经临时文件转发、不经第二个 localhost 端口）；
3. `serve_local_file` 两服使用**同 crate 同函数**（不是「行为等价的两份实现」）；
4. 插件进程 kill -9 时，库内视频继续播放不中断（M3 验收实测项）。

> 这同时回答了「拆成两个服务会不会变慢」：慢的前提是跨服务回源。本设计把**字节所有权随服务一起搬**（库根由 daemon 持有/服务），播放路径跳数与现状完全相同（1 跳：浏览器→单进程→文件），变化的只是进程名。

---

## 2. 档级播放策略（Play Ladder，D6 的技术内核）

每个播放请求按顺序选档，命中即停；选择结果可观测（响应头/诊断日志）。

| 档 | 条件 | 服务端成本 | 动作 |
|---|---|---|---|
| L0 原生直出 | 浏览器可播该容器/编码（探测：编码∈H.264/VP9/AV1/HEVC* 且容器兼容） | **零**（无 ffmpeg） | `raw`：serve_local_file 直接发文件 |
| L1 重封装 | 编码可播、容器不兼容（典型：MKV→fMP4/WebM 可接受的容器） | 极低（muxer，单线程几 % CPU） | ffmpeg `-c copy` 流式 remux |
| L2 硬解转码 | 编码浏览器不支持（HEVC/旧格式）且有可用 GPU | GPU 固定功能单元，CPU 个位% | NVDEC/QSV/D3D11VA 解码 + 必要时 NVENC/QSV/AMF 硬编为 H.264/VP9 |
| L3 软解转码 | 无 GPU/探测失败 | 高（现状可接受档） | libavcodec 多线程；UI 明示「软件解码，高分辨率可能卡顿」 |
| L4 不可播 | ffmpeg 缺失且 L0 不命中 | — | 501 带 action 引导 → 设置·播放引擎（M1 起） |

- *HEVC 浏览器支持以客户端实测为准（Edge/系统解码差异），沿用 decodeHealth 探测结论，不信 UA。
- L0/L1 不需要 ffmpeg 在场：**ffmpeg 缺失只影响 L2/L3**，这是「受管安装延后到 M4 也不挡 M0-M3」的性能侧理由。
- 选档只在播放开始时做一次（配合 decodeHealth 会话级缓存），不在每个 Range 请求重复探测。

### 2.1 预转码（离线转码）的定位

在途 draft `playback-delivery-optimal-2026-10-13.md` 提出把编码移出播放路径。本文档结论：

- **不进本次六期范围**（避免在 IA/拆库同时动播放核心）；作为 M4 之后的独立演进，立项即带「后台作业不得与播放争抢资源」的完整预算（见 §4.3）。
- 若决策人要求保留该方向：只允许做「低优先级后台 + 播放插队绝对优先 + 产物缓存与原片共存（不替换原文件）」，并先出独立 spec。

---

## 3. 服务端性能预算（既有纪律的固化，不得放宽）

| 预算项 | 现值/纪律（出处） | 重构后要求 |
|---|---|---|
| Range 无起始 | 200 + 完整文件（§D5） | 不变 |
| `bytes=S-` | 206 + **32MiB 有界块** + 如实 Content-Range | 不变；共享 crate 单测断言 |
| ETag/Last-Modified | 恒定携带 | 不变 |
| MIME | 按扩展名，**禁止 image/jpeg 兜底** | 不变 |
| 投递背压 | 码率 × `DELIVERY_BUDGET_FACTOR`；倍速冗余倍数**个位数**（BUG-033/199） | 两服同函数；非环回（共享 M5）必须回归实测 |
| TG 在线流 | `parallel_range_stream` K=4，禁裸 `iter_download`（§D3） | 留在 orig-tg 原样 |
| 元数据/缩略图 | 必经 `lru.rs::TtlLru`（§D3） | 不变 |
| 首字节 | 现状 pump 直读 `.part` 增长中文件即回 206（routes.rs L4604 段） | 行为保持；M3 后由 daemon 对库根文件做同样处理 |
| 读端点 | 被轮询端点只读内存快照，不碰 DB（§D1） | files/media stats 同纪律 |
| 取消 | 客户端断开即取消 ffmpeg future（ELT-T01 守卫） | 随泵迁 daemon，单测同迁 |

---

## 4. 前端性能纪律（既有调优结论，M0 重组不得破坏）

### 4.1 度量与渲染

1. 卡顿判据：**只**用 `requestVideoFrameCallback` + `video.getVideoPlaybackQuality()`（total/dropped/corruptedVideoFrames）。禁用 timeupdate、禁用 rAF 当帧度量。
2. 能播判据：`videoWidth > 0`（readyState=4 仍可能黑屏）。
3. 编码能力探测走 `lib/decodeHealth.ts` 的 `useDecodeHealth`；不兼容给可行动提示（§2 L4）。
4. 浏览器侧硬解差异验证必须 `BROWSER=msedge`（AGENTS §D6）。

### 4.2 UI 重组的禁区（M0/M2 重点）

- 高频区域（进度条、速度、缓冲）组件必须 `memo`；事件回调用 `useEvent`；进度变化只重渲染该行最小块，不重渲染列表/面板（§D1）。
- 速度单一采样真源在 `run()` 主循环（引擎侧），前端经 SSE 合并且**非活动任务速度 0**；M0 把列表搬进 DownloadPanel 不得新增任何轮询/派生请求（status tab 切换零请求是 M0 明确 AC）。
- MediaViewer/VideoPlayer/Lightbox 从 components/ 迁到 domains/files/shared/ 是**文件移动**，props/状态流一行不改；播放相关组件的改动与目录移动**分提交**。
- 全局 MediaViewer 仍单例挂在 MainLayout；五域切换不卸载播放器内核（切走再切回不重新加载视频）——M0 verify 项。

### 4.3 后台作业与播放争用

- 下载并发、缓存任务、未来预转码：检测到本机有播放会话时，后台作业保持现有让行策略（下载侧已有节流体系）；预转码若立项必须硬隔离信号量。
- ffmpeg 转码并发 v1 = 1（06 文档 §4.2）。

---

## 5. 防回退基线与验收（「勉强合格」成果的制度化保护）

### 5.1 M3 开工前：录制基线（前置任务，建议 M2 末完成）

在固定基线机 + 标准片源集（1080p H.264、4K HEVC 高码率、长音频、相册图、MKV 容器）上，对**当前 orig-tg**录制：

| 指标 | 工具 |
|---|---|
| raw：TTFB、每 206 块到达间隔、总下载时长/片长比（倍速冗余倍数） | `download-engine/verify/` 的 probe_media.py + diag_rate_storm.cjs（现有） |
| stream：首包时间、稳态吞吐、CPU%、ffmpeg 软/硬解两档 | 现有 pump 日志 + 新增采样脚本（M2 末补） |
| 前端：rVFC 掉帧率、帧间隔 P95（卡顿）、seek 恢复时间、播放期间整面板渲染次数 | tauri-shell/verify 现有 `verify_playback_stutter_probe.cjs`、`verify_rate_judder_sweep.cjs`、`verify_playback_io_contention.cjs`、`verify_playback_rate_limit.cjs` 一套 |
| 高负载：多任务下载同时播放的掉帧（io_contention） | verify_playback_io_contention.cjs |
| TG：在线流 K=4 行为、缩略图缓存命中 | verify_slow_stream.cjs、现有 TtlLru 验证 |

产物：`verify_shots/playback-baseline-2026-10-13/result.json`（ignored），作为 M3 后对比基准。

### 5.2 M3 后：同机同片源对比阈值（初拟，基线数据出来后由 dev-plan 标定）

- TTFB、首包时间、206 块间隔 P95：**不得劣化 > 5%**；
- rVFC 掉帧率 / 卡顿事件数：**不得增加**（0 容忍，用户红线）；
- 倍速冗余倍数：保持个位数且 ≤ 基线；
- 播放期间 CPU%：±5% 以内；
- 新增「kill orig-tg 后库内播放不中断」「无 TG 凭证全新环境库内可播」两条正证据。

### 5.3 每期 CI/手跑映射

| 时机 | 必跑 |
|---|---|
| M0 | tauri-shell/verify 全套播放脚本（搬运后行为不变） |
| M1 | 同上 + auto/off 命令行单测 + 501 引导 |
| M3 | probe_media.py（daemon 新位置全项）、diag_rate_storm.cjs、§5.2 全指标对比、sync-sidecars --check、共享 crate 单测 |
| M5 | diag_rate_storm 非环回用例（限速在真实网卡 IP 上复验 BUG-199） |

### 5.4 失败处理

- 任一红线指标回退：M3 不得合并；先修性能再谈功能；禁止「先合并后优化」。
- 回退定位法：先确认热路径是否多跳（§1.2 grep 判据），再查共享 crate 函数是否与原实现逐字一致，最后查调度/缓存——按本次第 3 节顺序排查，不猜。

---

## 6. 对插件架构的约束（与 08 文档呼应）

1. 插件协议（08）**不得定义在播放热路径上的逐块/逐帧回调**；插件只交接「文件已在某受管路径 + 元数据」，之后播放与插件无关。
2. 插件二进制不允许监听/代理媒体端口；不允许包装 `<video>` URL（前端 URL 永远指向 daemon 的 raw/stream）。
3. 插件可以提供自己的「在线预览」端点（如 TG 的 range stream），但该端点仅在插件面板内、未归仓场景使用，且必须复用同一投递 crate。
4. 前端播放器只有一个实现（files 域）；插件域不得自带播放器（防止第三方改出第二套播放行为，这是「前端统一化」在性能上的理由）。
