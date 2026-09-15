# orig-hub 二进制强制自动化验收规范

> 生效日期：2026-08-27 ｜ 适用范围：任意涉及 `tauri-shell`（壳/前端）或 `download-engine`（内核）的改动
> 对齐原则：用户长期约定「强制自动化验收」——交付必须自带可复现脚本，捕获真实状态码/响应/日志并落盘为证据；UI 改动必须附可看证据（截图/真实渲染）；绝不把验收甩给用户手动点测。

---

## 0. 背景（为什么需要本规范）

- release 二进制与 debug 二进制行为不同：
  - **release**（`target/release/orig-hub.exe`）：通过 `frontendDist` 把前端打包进 exe，走自带资源协议（`tauri://localhost`），**双击即用、不依赖任何 dev server**。
  - **debug**（`target/debug/orig-hub.exe`）：烤入 `devUrl: http://localhost:5180`，**必须**配合 `npm run tauri dev` 启动的 Vite 才能跑；单独双击会因 webview 连不上 `localhost:5180` 而报「localhost 拒绝连接」。
- Tauri 的 `frontendDist` 嵌入有缓存：仅重编前端 `dist` 后直接 `tauri build`，可能复用旧的资源嵌入快照，导致**二进制内前端是旧的**（exe 里搜不到最新 UI 字符串）。这会造成「二进制根本没更新」的假象。
- 验收失败的经典模式：**只测 dev server（curl 5180 + 截图）就宣称二进制通过**。dev server 不等于真实二进制，二者前端来源、运行路径完全不同，该证据无效。

## 1. 适用触发条件

满足任一即须执行本验收：
1. 改动 `tauri-shell/src/**`（前端/壳）或 `tauri-shell/vite.config.ts` / `tauri.conf.json`。
2. 改动 `download-engine/**`（内核/daemon），影响 `target/release/orig-daemon.exe`。
3. 任何声称「已重建二进制」「已修复某二进制运行问题」的交付。

## 2. 验收脚本（唯一事实来源）

`verify_shots/accept_binary.ps1` —— 真正**启动真实 release 二进制**并采集证据，不依赖 dev server。

调用：
```powershell
cd tauri-shell
pwsh ../verify_shots/accept_binary.ps1
```
（脚本内已硬编码 release 二进制路径，产物写入 `verify_shots/acceptance-<timestamp>.json` 与 `.md`。）

## 3. 验收硬指标（全部满足才判 PASS）

| # | 指标 | 通过条件 | 取证方式 |
|---|---|---|---|
| A | 二进制为 release | exe 内含 `tauri://localhost`；**不**存在以 `http://localhost:5180` 为活动导航地址的调试残留 | 静态 grep exe |
| B | 内置前端为最新 | exe 内含关键 UI 字符串：`全部文件`、`下载中`、`Archives` | 静态 grep exe（证明打包的是当前 `dist`，而非缓存旧快照） |
| C | 真实启动 | 启动 `target/release/orig-hub.exe` 后进程存活 ≥ 3s | `Get-Process` 轮询 |
| D | sidecar 自拉起 | 启动后 `:9876` 处于 LISTEN（orig-daemon 被成功拉起） | `Get-NetTCPConnection` |
| E | 不依赖 dev server | 启动全程 exe **不**建立到 `localhost:5180` 的 TCP 连接 | `Get-NetTCPConnection` 轮询 RemotePort=5180 |
| F | UI 真实渲染 | dev 模式 + daemon 运行下 Playwright 截图，含关键文本与交互态（分类菜单展开等） | `verify_shots/shot.cjs` |

> 指标 B 是「二进制到底更新没有」的硬性判据：若 exe 搜不到 `全部文件`，无论构建是否"成功"，一律判 FAIL（即「二进制没更新」）。

## 4. 证据落盘

每次验收产出：
- `verify_shots/acceptance-<timestamp>.json`：结构化结果（每项的 pass/fail、PID、端口、时间戳）。
- `verify_shots/acceptance-<timestamp>.md`：人读摘要。
- UI 证据：`verify_shots/01_sidebar_default.png` 等（Playwright 截图）。
- 不得仅以「构建无报错」或「curl 5180 200」作为二进制验收结论。

## 5. 交付约束

- 重建 release 二进制前，**必须先清理 Tauri 资源嵌入缓存**再构建，否则前端不刷新：
  ```bash
  rm -rf tauri-shell/src-tauri/target/release/build/orig-hub-*
  cd tauri-shell && npm run tauri build -- --no-bundle
  ```
- 验证重建结果：构建后立刻 `grep -ao "全部文件" target/release/orig-hub.exe`，确认内含最新前端。
- 用户运行指引：
  - **双击即用（release）**：`tauri-shell/src-tauri/target/release/orig-hub.exe`
  - **开发模式**：`cd tauri-shell && npm run tauri dev`（会自动启动 Vite；Vite `server.host` 须为 `true` 以兼容 IPv4/IPv6 解析）
  - 严禁把 debug 二进制当成品交付/双击。

## 6. 禁止项

- 禁止仅测 dev server 即宣称二进制验收通过。
- 禁止声称「已重建」但 exe 不含最新前端字符串（指标 B）。
- 禁止把启动/渲染验收甩给用户手动在 GUI 点测。
