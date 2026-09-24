# download-engine/verify — 后端验收脚本

本目录存放 **download-engine 侧的入库验收脚本**（纯标准库优先，无第三方依赖）。
验收**产物**（JSON / 日志 / 库副本）一律落**系统临时目录或仓外**，绝不污染仓库
（AGENTS.md §6 污染防线）。

---

## `verify_delivery_ttfb.py` — 本地投递「首字节延迟（body TTFB）」A/B 验收

### 用途

量化并**回归看护**本地文件投递的**响应体首块延迟**：`orig-tg` 为抑制
Chromium abort-and-re-request 风暴而对播放字节限速，但**限速配额原先每请求从 0 起算**，
于是「响应头秒回、body 第一块要等 `1 MiB / 节流速率`」——每一次拖进度条 / 重新取流
都要重付这笔 TTFB 代价，就是用户抱怨的「播放浏览卡顿异常严重」。

> **为什么必须限速**：本地千兆下不限速会把字节以数百 MB/s 灌给解码器，而 1x 播放每秒
> 只消费「码率」，Chromium 读够 buffer 即 abort 连接另起请求重取同一区域（实测 2x
> 播放 10s 内 **137 请求 / 792 MiB，冗余 63x**），WebView2 直接卡死。限速是**前提**，
> 本脚本要验证的是「在不牺牲稳态限速的前提下消除每请求 TTFB」（BUG-033 背景）。

### 零生产风险（硬性防线）

- 库一律用 **只读快照副本**（`sqlite3.backup`，正确处理 WAL）；默认从
  `%APPDATA%\com.origadmin.orighub\tg\store.db` 快照到系统临时目录。
- 实例一律跑在**非生产端口**：默认 `19879`。显式拒绝 `--port 9877`（orig-tg 真实实例）
  与 `--port 9876`（orig-daemon）；显式拒绝 `--db` 指向
  `%APPDATA%\com.origadmin.orighub`（**报错退出，不是警告**）。
- **绝不误连他人实例**：启动前先验端口空闲（显式端口被占用即报错；用默认端口被占用则
  自动改挑空闲端口），启动后再用 `netstat` 比对监听 socket 归属 PID。
  > 这条防线来自真实踩坑：端口被他人 `orig-tg` 占用时，自起进程 `bind` 失败会**立即退出**，
  但就绪探测存在竞态窗口——脚本可能「读到别人的数据却以为是自己二进制的测量」。
- 任何退出路径（正常 / 异常 / `SIGINT` / `SIGTERM`）都 kill 自起进程、删库副本，不留监听。

### 参数

| 参数 | 说明 |
|---|---|
| `--binary PATH` | `orig-tg` 二进制；给两次即构成 A/B（也可用 `--compare A B`） |
| `--port N` | 隔离端口（默认 19879；被占用自动改挑空闲；拒绝 9876/9877） |
| `--db PATH` | 库路径（默认自动快照真实库副本；不可指向真实库目录） |
| `--label NAME` | 本轮标签（表格 / 产物名） |
| `--items 394,408` | 显式指定 item id（默认**自动选条**，见下） |
| `--top N` | 自动选条数量（默认 4） |
| `--budget SECS` | 每条观测窗口秒数（默认 3） |
| `--out PATH` | JSON 产物路径（默认系统临时目录；**拒绝落仓**） |
| `--a-env K=V` / `--b-env K=V` | 仅注入 A / B 的 env（可重复），用于对照实验 |

**自动选条（不硬编码 id）**：从副本库取
`kind='video' AND file_path 非空 AND size≥20MiB AND duration>0`，
按体积降序取前 N，并**排除** `file_path` 含 `test_videos` 的历史验收夹具
（会污染码率统计）。写死 id 换台机器即失效——本机库演化后就已不是同一批条目。

### 测量

对每条发 `Range: bytes=0-`（主路径）与 `Range: bytes=<≈中点>-`（拖动进度条 / seek），
各记录：① 响应头 TTFB、② **body 首块到达时刻**、③ 前 3 秒收到字节数与实测吞吐、
④ `Content-Range`。输出人类可读表格 + JSON。

### 用法

```sh
cd download-engine

# 基线采集（单二进制，无断言，exit 0）
python verify/verify_delivery_ttfb.py --binary target/release/orig-tg.exe --label baseline

# A/B 对照（修前 vs 修后）
python verify/verify_delivery_ttfb.py --compare \
    target/release/orig-tg.exe target-fixed/release/orig-tg.exe --label fix

# 只跑指定条目 / 指定端口
python verify/verify_delivery_ttfb.py --binary target/release/orig-tg.exe \
    --items 394,408 --port 19880 --label spotcheck
```

### 判据（A/B 模式）

结论行 `PASS` 当且仅当三条**同时**成立：

1. **A（旧行为）body 首块均值 ≥ 200 ms** —— 证明「每请求重付 TTFB」的缺陷确实复现；
2. **B（修复）body 首块均值 ≤ 100 ms** —— 证明修复已消除该延迟；
3. **稳态吞吐未退化 >30%**（`吞吐 B/A ≥ 0.70`）—— 防止「修了 TTFB 却把节流搞坏」
   这类回归被漏掉；不满足则在结论行标 `WARN`。

否则 `FAIL` 并 `sys.exit(1)`。单二进制为基线采集（`BASELINE`，exit 0）。

**退出码**：`0` PASS/基线；`1` 断言失败；`2` 环境/通道问题
（二进制不存在、端口未就绪、无候选条目、端口被占用等）。

> **已知边界（勿误读**）：本判据只拦「吞吐**下降**」。若把限速**整个关掉**
> （`ORIG_TG_DELIVERY_BPS=0`），窗口内受 `OPEN_CHUNK`（32 MiB）封顶，
> 吞吐反而**上升** → 三条全过报 `PASS`。故本脚本**不能**替代「限速仍在生效」的验证，
> 只负责 TTFB 消除是否 + 吞吐是否被改坏。

### 判据「咬人」自证

判据必须**既能判红、也能判绿**，否则等于恒绿空转。三组对照实验（本机，2026-09-24）：

```sh
# (a) 自己比自己 → 必 FAIL（首块不降）
python verify/verify_delivery_ttfb.py --compare \
    target/release/orig-tg.exe target/release/orig-tg.exe --label selfcheck

# (b) 真实验收：旧二进制(A, 未修) vs 修后二进制(B)
python verify/verify_delivery_ttfb.py --compare \
    target/release/orig-tg.exe.bak-1790104771 target/release/orig-tg.exe --label real-fix
```

实测结论行：

```
(a) selfcheck  A首块均值=235ms  B首块均值=235ms  → CONCLUSION: FAIL         (exit 1)
(b) real-fix   A首块均值=234ms  B首块均值= 11ms  → CONCLUSION: PASS         (exit 0)
```

- (a) A 自己当 B 比 → `FAIL`：判据**不是恒绿**（首块没降就报红，exit 1）。
- (b) 真实验收：A（旧二进制）首块均值 234 ms ≥ 200 ms（旧缺陷复现），
  B（修后二进制）首块均值 11 ms ≤ 100 ms（已修复），吞吐未退化 → `PASS`。
- 另：把 B 的限速调慢 30×（`--b-env ORIG_TG_DELIVERY_BPS=1000000`）→
  结论行 `FAIL WARN`（吞吐 B/A=0.12，掉 >30%）——证明 WARN 分支可达。

> 备注：本次会话中 `target/release/orig-tg.exe` 被另一位工程师用修后代码**重建**过
> （`ORIG_TG_DELIVERY_BURST_SECS` 已在二进制中）。旧（未修）本体以
> `target/release/orig-tg.exe.bak-*` 形式留存，故 (b) 用它作 A。

---

## 其它既有脚本

`range_server.py` / `range_server_any.py` / `range_verify_server.py` / `run_verify.sh` /
`verify_http.py`（Range 下载端到端 + sha256）、`verify_cache_scopes.py`、
`verify_multinic.py`、`verify_episode_*`、`verify_bug_*` 等历史验收脚本按原用法使用。
