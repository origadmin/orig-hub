# 细则：代码层约束（AGENTS.md §5 展开）

> **权威链**：本文件是 `AGENTS.md` §5 的**展开细则**。§5 保留每条规则的**可执行判据**，
> 本文件保留**为什么这么定 + 实测数据 + 工具入口**。
> 两者冲突时以 `AGENTS.md` §5 为准（§5 是判据来源，本文件是依据来源）。
>
> **何时加载**：只在改动落入对应领域时加载对应小节，不要整篇读入。
> 逐条实现/验收时若与本节冲突，先回到 `AGENTS.md` §5 核对判据。

## 目录

| 小节 | 适用场景 | 关联 BUG |
|---|---|---|
| §D1 流畅优先 | 改进度/轮询/高频渲染 | BUG-026 / BUG-030 |
| §D2 单飞呈现 | 改进度类端点/任务队列 | BUG-027 |
| §D3 TG 拉流与元数据缓存 | 改在线流式/缩略图 | BUG-028 |
| §D4 缓存与删除联动 | 改缓存/媒体库删除 | BUG-029 / BUG-051 / BUG-096 |
| §D5 投递契约与背压 | 改 `serve_local_file` / Range / MIME | BUG-031 / BUG-033 |
| §D6 播放判据与解码健康 | 改播放/测卡顿/编码问题 | BUG-034 |
| §D7 迁移与启动期依赖 | 改 schema / 启动流程 | BUG-032 |

---

## §D1 流畅优先（BUG-026 / BUG-030）

**判据（AGENTS.md §5）**：进度类高频数据只允许影响「正在变化的那一小块 UI」，禁止整面板重渲染。

实测依据：整面板重渲染会把每次进度 tick 变成全树 diff，直接拖垮主线程，表现为「播放中界面卡死」。
轮询本身不是瓶颈，**因轮询触发的重渲染才是**。

- 轮询三律：有活才轮（终态即停）；等值短路（快照签名未变不 setState）；失败退避。
- 频率上限 5s，且**同一数据只允许一个轮询源**：多面板（如 TgPanel 主轮询与缓存管理面板）并存时，
  打开面板即由面板接管，主轮询暂停。
- 进度条用 `Progress smoothMs≈轮询周期` 做视觉平滑补偿 —— **不得靠缩短轮询间隔换流畅**，
  那是把渲染开销换成网络与 DB 开销，方向错了。
- 被轮询的读端点**不许碰 DB**：内存快照（唯一写者在 DB 变更后刷新），SQLite 只承担写入。
- 高频路径组件必须 `memo` 化；回调用 useEvent（引用恒定 + 数据回传式 `on(item)`），禁止内联箭头。

## §D2 单飞呈现（BUG-027）

**判据**：进度类任务的端点**只返回一个结果**（`{task}` 而非 `{tasks[]}`）；执行侧单飞，多任务一律排队 FIFO。

- 「单飞呈现」是**呈现层契约**：既然同时只有一个 worker 在跑，返回数组就是在撒谎，
  前端还得写「挑哪个」的逻辑，两份复杂度都白付。
- **进度变化零派生请求**：轮询周期内只允许轮询本身的请求（1s = 1 请求）。
  任何重清单刷新只能由任务终态等**离散事件**触发，禁止由每次进度变化触发。
  实测教训：由进度变化触发的清单刷新会让请求数随任务时长线性增长。

## §D3 TG 拉流并行 + 元数据缓存（BUG-028）

**判据**：在线流式端点禁止裸 `iter_download`，必须走 `parallel_range_stream`（K=4）；
媒体元数据/缩略图必须过 `lru.rs::TtlLru`。

- 为什么：单流吞吐 = chunk/RTT ≈ **0.5MB/s**，播放器必然卡顿。K=4 分片并行、按序合并是下限。
- 元数据缓存的意义：同一 `(chat,msg)` 的 seek / 续 Range / 重渲染**不得重复付出
  `get_messages_by_id` RPC（~1.2s）**。1.2s 的 RPC 放在播放路径上就是肉眼可见的卡顿。

## §D4 缓存即入库 + 单向删除联动（BUG-029 / BUG-051 / BUG-096）

**判据**：任何缓存成功路径（worker/手动）**必须**
`upsert_media_item(source="tg", ref="{chat}:{msg}", ...)`。

- 为什么必须：媒体库是缓存的主视图。只写 `media_message` 等于**内容对用户不可见** ——
  字节在盘上，用户在界面上找不到。
- ref 约定全局唯一：`source="tg"`、`ref="<chat_id>:<message_id>"`。

**删除联动是单向的**（BUG-051 定下的边界：缓存是「订阅内容 → 媒体库」的**入库准备物**，
清掉准备物不等于删掉成品）：

1. **清缓存只回收字节** —— 条目退回「仅入库」态（`file_path` 置空、`downloaded` 清零）、
   可重新缓存；**条目本身永不删除**（`cache.rs::purge_item` 只 unlink 字节，
   `cache.rs::clear` 的注释即这条不变量）。
   **禁止为「清了缓存」而回头删 media_item** —— 那条正向级联是错的，
   历史上为它写的 `delete_media_item_by_ref` 已因零调用被移除（BUG-096）。
2. **删 TG 来源条目必须连带清字节** —— `orig-tg/src/routes.rs:1951` 的 `delete_media_item`
   先删下载目录内的文件、再对 `source=="tg"` 解 ref 后 `clear_downloaded`。
   缺这一步，下次缓存 upsert（按 `source+ref` 幂等）会把条目「复活」，表现为**删不掉**。

> 这两个方向相反，别记混：**清缓存 ≠ 删条目**（只回收字节）；**删条目 ⇒ 必须清字节**（否则复活）。

**restart_tg.py 必须以 Popen+wait 托管**：Windows 的 `os.execve` 是「spawn+立即退出(0)」的模拟，
父进程退出即被任务托管判定结束并回收进程树（服务刚连上就被杀）。

## §D5 投递契约与背压（BUG-031 / BUG-033）

**判据**：两条投递路径必须共用同一实现 `serve_local_file`。

- 契约细节：无 Range → 200 + **完整文件**（绝不只给前 N 字节）；
  `bytes=S-` → 206 + 32MiB 有界块 + 如实 `Content-Range`；`bytes=S-E` → 206 + 尊重请求；
  恒带 `ETag`/`Last-Modified`（缺了 Chromium 会重复下载已取字节）；MIME 按扩展名判定，
  **禁止 `image/jpeg` 之类兜底值**（会把视频误标成静态图导致拒播）。
- 为什么必须共用：两条路径都直接喂 `<video>`，分叉即意味着「其中一条会退化」。
  新增/修改任一路径，必须同步 `probe_media.py` 的「delivery path」两组断言。

**背压（BUG-033）** —— 这是本项目最反直觉的一条：

- 实测：本地千兆下服务端灌数据的速率（数百 MB/s）远超解码器消费速率（码率 × `playbackRate`），
  Chromium 会读满 buffer 即 abort 并在**同一区域反复重取** ——
  2x 播放 10s 内 **137 请求 / 792 MiB / 冗余 63x**，在 WebView2 里就是界面卡死。
- 实现：`serve_local_file` 按「码率 × `DELIVERY_BUDGET_FACTOR`」节流
  （`duration` 不可得时回落 `DELIVERY_FALLBACK_BPS`），
  可用 `ORIG_TG_DELIVERY_BPS` 覆盖以便 A/B，无需重编。
- **判断标准：倍速下的冗余倍数应在个位数**（当前 3–4x）。新增任何投递端点必须同样过背压，
  并纳入 `diag_rate_storm.cjs` 回归。

**投递问题先出线上字节账，再谈优化**：「大量 raw 请求 / 播放卡死」类现象先跑
`verify_shots/diag_rate_storm.cjs`（CDP 逐请求落地字节 + 落地区间并集去重 + `loadstart`/`emptied` 计数），
并且**必须分别在 1x 与倍速下各记一段** —— 1x 完全正常的通路在 2x 下可能放大数十倍（实测 2→137 请求、冗余 2x→63x）。

**已实测否定、勿再调参**的候选（避免后人重复劳动）：
回包块大小（1/4/8/32MiB/EOF）、前端 `preload`（auto/metadata/none）、浏览器缓存开关、
按 Range 形态分流（seek 与顺序播放同为 open-ended `bytes=S-`，不可区分）。

## §D6 播放判据与解码健康（BUG-034）

**判据**：判「播放卡顿」必须量真实上屏帧，禁止用代理指标。

- **禁用** `timeupdate` 判停顿：约 4Hz，几百 ms 的卡顿直接漏检。
- **禁用** `rAF` 判帧率：它测的是**合成帧** —— video 画面冻住时照样 60fps，**等于没测**。
- 必须用 `video.requestVideoFrameCallback`（真实上屏帧：墙钟间隔 + `mediaTime` 步长）
  配合 `video.getVideoPlaybackQuality()`（`droppedVideoFrames`）。
- **先量合成器时钟**（空载 rAF 频率）：若「需求 fps = 源fps × 倍率」> 刷新率，
  瓶颈在**呈现层**而非解码 —— 两者修法完全不同，不分清就会修错地方。
- **`readyState` 满格 ≠ 能播**：视频轨编码不可解时它同样是 4（实测 `videoWidth=0`、`duration` 正常、
  **`onError` 从不触发**）。判断「能不能播」必须另看 `videoWidth`。
- `navigator.mediaCapabilities` 的 `supported/smooth/powerEfficient` 是**声明式**的，偏乐观，
  不能替代实测。
- 凡做 GPU 对照实验，必须把 WebGL `UNMASKED_RENDERER` 记进证据，
  否则「换独显无改善」可能只是根本没换成功。
- **Playwright 自带 Chromium 不含 HEVC/AAC 等专有编解码器**，其对编码相关问题的表现 ≠ WebView2；
  涉编码的判断必须用 `BROWSER=msedge`（与 WebView2 同引擎）。

**解码异常不许静默**：`<video>` 的两类失败都不触发 `onError` ——
视频轨不可解（黑屏但控制条在走）与解码吞吐不足（仅丢帧）。凡是喂 `<video>` 的路径，
必须经 `tauri-shell/src/lib/decodeHealth.ts` 的 `useDecodeHealth` 探测并向用户提示，
文案要给出可行动信息（如「调低播放速度会更流畅」），**不得只报错误码或什么都不说**。

**工具入口**：`diag_playback_smooth.cjs`（上屏帧账）、`probe_mp4_codec.py`（轨道/codec 探测）、
`probe_decode_caps.cjs`（解码能力 + GPU）、`diag_seek_latency.cjs`（跳转回填）。

## §D7 迁移与启动期依赖（BUG-032）

**判据**：建表批里只允许出现新旧库都存在的列；schema 变更必须配「旧库→新代码」迁移单测；
启动期依赖失败必须**显式失败**。

- 为什么：建表批（`execute_batch`）里引用待 `ALTER TABLE` 补上的列会让**整批迁移失败**，
  且 **SQLite 报错位置与真实原因（顺序）无关** —— 排错成本极高。
- 必配单测：造旧 schema + 塞旧数据 → `open` 成功 + 数据仍在。
  例：`media::tests::legacy_db_migrates_without_failing_open`。
- 启动期依赖（存储库、会话、客户端）打开失败一律**显式失败**
  （`EXIT_*` 退出码 + 打印实际路径），**禁止回落空实现** ——
  `:memory:` 兜底会把 schema 错误伪装成「用户数据全没了」，
  这是把**可诊断的错误**换成**让用户恐慌的假象**。
