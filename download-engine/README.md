# download-engine（orig-hub 下载内核 · Rust sidecar）

按既定标准，把 orig-hub 的 Go 下载内核迁移为 Rust sidecar：独立进程，通过
**HTTP REST + SSE** 与 orig-hub（Go/Wails 外壳）通信，零 cgo、零 FFI。

核心抽象（v2）：`BlockMap`（文件切片 + 完成位图）+ `Source`（一种取字节方式：
HTTP / BT / FTP / Mock）。HTTP Range 与 BT piece 都归约为「往 offset 写一段字节」，
混合下载 = 一任务多种 Source 调度填块，续传 = 跨协议块位图。BT/FTP 是未来插件
（统一 `Registry`/`Protocol` trait），加协议不改引擎。

## 目录结构

```
download-engine/
  Cargo.toml              workspace（成员：libsurge / surge-protocol-* / surge-daemon）
  .cargo/config.toml      rsproxy.cn 国内镜像（构建免翻墙）
  rust-toolchain.toml     stable
  crates/
    libsurge/             核心：BlockMap + Source + engine 并发调度 + Registry
    surge-protocol-virtual/  零网络自检源（mock://，确定性字节）
    surge-protocol-http/      真实 HTTP 源（reqwest Range 并发 + 429 退避 + 镜像回退）
    surge-daemon/         axum HTTP REST + SSE 守护进程
  verify/                 verify_http.py（自动化验收）+ run_verify.sh
```

## REST 契约（严格对齐 orig-hub `internal/core/api.go` / `api_test.go`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | `{"status":"ok"}`；配置 token 后也需 `Bearer` 鉴权 |
| GET  | `/api/downloads` | 返回 `[DownloadStatus]` |
| POST | `/api/downloads` | body `{"url","output_path"?,"filename"?,"mirrors"?,"headers"?}` → `{"id":"..."}` (201) |
| GET  | `/api/downloads/:id` | `DownloadStatus`（不存在 → 404） |
| POST | `/api/downloads/:id?action=pause\|resume\|cancel` | `{"status":"paused"\|"resumed"\|"cancelled","id":"..."}` |
| DELETE | `/api/downloads/:id` | `{"status":"deleted","id":"..."}` |
| GET  | `/api/events` | SSE 实时进度（REST+SSE 设计补充；Go 端当前由 Wails 轮询，此处补齐） |

`DownloadStatus` 字段名/json tag 与 orig-hub `engine/types/models.go` 完全一致：
`id,url,filename,dest_path(omitempty),total_size,downloaded,progress,speed,status,
error(omitempty),eta,connections,added_at,time_taken,avg_speed`。
状态词：`idle/queued/downloading/paused/completed/error/cancelled`。

## 下载目录三层解析（既定标准）

```
请求 output_path  →  配置 download_dir  →  平台默认目录（~/Downloads）
```

- 配置层：`SURGE_DOWNLOAD_DIR` 环境变量 或 `download-engine.toml` 的 `download_dir`。
- 前端「默认下载路径」设置落到该配置；「首次是默认、之后按配置」= 配置持久化后每次读它，
  仅配置为空才用平台默认。
- 仅当三者皆空才落当前目录（极端兜底）。
- **`output_path` / `download_dir` 均为目录**；最终落盘路径 = `目录 / URL 派生文件名`
  （与 orig-hub `OutputDir + UrlFilename` 完全一致）。URL 派生文件名取 `path.rsplit('/')`
  最后一段，请求可带 `filename` 覆盖。验证脚本 `verify_http.py` 的测试 B 即按此
  「目录 + 派生文件名」断言。
- 并发数默认 8（`SURGE_MAX_CONNECTIONS` / `max_connections`）。

## 构建 / 运行

```sh
cd download-engine
cargo build                              # 国内 rsproxy 镜像，免翻墙

# 运行（守护进程，监听 9876）
SURGE_DOWNLOAD_DIR=~/Downloads PORT=9876 cargo run -p surge-daemon

# 鉴权（可选）
SURGE_TOKEN=secret cargo run -p surge-daemon   # 此后所有路由含 /health 需 Bearer
```

> **Windows 构建陷阱**：若上一次 `surge-daemon` 进程没退出，会锁住
> `target/debug/incremental` 导致 `cargo build` 报 `os error 5`。
> 先释放进程再构建：`taskkill //F //IM surge-daemon.exe`；
> 或设置 `CARGO_INCREMENTAL=0` 规避坏增量缓存。

## 自动化验收（强制）

```sh
./verify/run_verify.sh
# 等价于：cargo build && python3 verify/verify_http.py --daemon target/debug/surge-daemon
```

验收门：
1. 真实 HTTP（Range GET）端到端跑通；
2. 不传 `output_path` 时文件落**配置目录**（验证三层解析规则 2）；
3. 显式 `output_path` 覆盖生效（规则 1）；
4. 完成文件 size 与 sha256 与源**完全一致**（正确性校验）。

## 已知限制（下一轮补齐）

- 请求 `headers` 已接入 API 但**尚未透传到 HTTP 请求**（Phase 1.5）。
- `speed` 当前恒为 0（引擎未做实时采样），UI 速率待补。
- `/api/events` SSE 是 REST+SSE 设计的补充，orig-hub 当前 Go 守护进程用 Wails 轮询；
  二者并存不冲突。
- 断点续传：引擎按已有文件长度恢复完成位图（跨协议位图），重启用例待补充验收。

## 下一步

- Phase 1.5：与 orig-hub Go 侧行为差异对比（分块边界 / 续传 / 429 / 镜像回退）。
- 协议插件：`surge-protocol-bittorrent`、`surge-protocol-ftp`。
- UI 迁移：Tauri v2（悬浮窗 + 系统托盘）。
