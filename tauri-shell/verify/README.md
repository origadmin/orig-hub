# tauri-shell/verify — UI 验收脚本

本目录存放**入库的验收脚本**（AGENTS.md §6：`tauri-shell/verify/` = UI 真实渲染类）。
验收**产物**（截图 / DOM 快照 / result.json）一律落仓外或 `verify_shots/`（ignored），
**绝不污染仓库**。

---

## 0. 前置步骤（按序，缺一即验收无意义）

1. **安装依赖**（必须先做，且是本目录多数故障的根源）
   ```sh
   cd tauri-shell
   npm install --no-audit --no-fund
   ```
   `node_modules` 不完整时（典型症状：`npm ls` 大量 `extraneous`、`@babel/core` 缺失），
   `@vitejs/plugin-react` 无法转译 JSX，页面会白屏并报
   `Failed to resolve import "@babel/core"` —— **此时 dev server 仍返回 200**，
   所以「curl 200」不能当作验收结论。

2. **启动 daemon / orig-tg**（前端首屏依赖这两个后端端口：9876 / 9877）。

3. **启动 dev server**
   ```sh
   npm run dev        # vite.config.ts: port 5180, strictPort: true
   ```

4. **跑验收**（见下）。

> 端口说明：daemon 的 CORS 白名单按 origin 收口，**只有规范开发源 `http://127.0.0.1:5180`**
> 能正常访问后端。用别的端口起 dev server（例如 5199）会因 CORS 预检失败而刷出
> `Access to fetch ... blocked by CORS policy` 及其伴随的 `net::ERR_FAILED`。
>
> 这类 **CORS 噪音不会让验收 FAIL**（UI 本身渲染是好的），但**也不会被静默吞掉**：
> 会以 `--- WARNINGS ---` 逐条打印，并提示「daemon 按 origin 收口，请用 5180」。
> 豁免范围**仅限**被 CORS 拦截的那个 host 上的请求失败 —— 应用自身 origin 或 CDN 上
> 真实的资源加载失败照样 FAIL。
>
> 所以：`verify:ui` 默认且应当指向 5180；看到 CORS warning 就说明端口不对，后端数据没连上。

---

## 1. 零依赖真实渲染验收（推荐，`npm run verify:ui`）

```sh
cd tauri-shell
npm run verify:ui                                  # 默认 http://127.0.0.1:5180
APP_URL=http://127.0.0.1:5180/ npm run verify:ui   # 显式指定
ORIG_VERIFY_OUT=<临时目录> npm run verify:ui        # 指定产物目录
```

- 脚本：`verify/verify_ui_render.cjs`，驱动：`verify/lib/cdp.cjs`。
- **零第三方依赖**：只用 Node 内置 `WebSocket`（Node ≥ 22，实测 `typeof WebSocket === 'function'`）
  与标准库，直连本机 Edge/Chrome 的 Chrome DevTools Protocol。
- 自动探测浏览器（优先级）：`EDGE_PATH` / `CHROME_PATH` 环境变量 →
  `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` →
  `C:/Program Files/Microsoft/Edge/Application/msedge.exe` → Chrome 路径 → 平台默认路径。
- 调试端口**随机探测空闲端口**（不硬编码 9333，避免并行跑互相抢占），
  轮询 `/json/version` 直到就绪，超时报错退出（不静默挂起）；`close()` 必杀进程树（不留孤儿）。
- 断言的是**JS 执行后**的 DOM，不是 HTTP 状态码。
- **退出码语义（两类失败严格分开，别搞混）**：
  | 退出码 | 含义 | 典型文案 |
  |---|---|---|
  | `0` | 全部断言通过 | `RESULT: PASS` |
  | `1` | **被测页面有问题** —— 断言失败 | `#root has 0 children (app did not mount / white screen)` |
  | `2` | **环境/通道有问题** —— 浏览器找不到、dev server 不可达、导航失败 | `dev server unreachable` |
- **白屏属于 `1`，不属于 `2`**：返回 200 但 `#root` 为空（React 未挂载）是本工具最核心的失败模式，
  必须报成断言失败。若被归到 `2`（环境问题），排查方向会被彻底带偏。
  导航阶段因此**不等待** `#root`，挂载情况由独立断言项判定。
- 失败路径也会先打印已记录的 PASS/FAIL 清单，再退出 —— 不会只甩一个 stack。

断言项（20 项）：`#root` 存在且有子节点、`body.innerText` 非空、
无 `vite-error-overlay` / `Failed to resolve` / `Uncaught`、无未捕获异常、无 console error
（忽略 `favicon` 一类环境噪音）、12 个关键 `data-testid` 命中、关键子集二次校验。

产物默认写入系统临时目录 `%TEMP%/orighub-verify-ui/`（仓外）。
脚本会**拒绝**把产物写进仓库目录（AGENTS.md §6 污染防线）。

---

## 2. playwright 截图脚本（需额外安装，离线环境不可用）

`shot_*.cjs` 共 6 个：

| 脚本 | 用途 |
|---|---|
| `shot_clear_center.cjs` | 中心区清空态截图 |
| `shot_context_bar.cjs` | 顶部上下文栏截图 |
| `shot_item_cache.cjs` | 条目缓存态截图 |
| `shot_media_delete.cjs` | 媒体库删除交互截图 |
| `shot_media_tags.cjs` | 媒体库标签截图 |
| `shot_series_text_edit.cjs` | 剧集文案编辑截图 |

**为什么需要额外安装**：这些脚本 `require('playwright')`，而 `package.json`
**刻意不声明** playwright 依赖 —— 它要额外下载浏览器二进制，在没有外网 / 代理不可用的机器上
会让 `npm install` 直接失败（引入新故障）。因此它只作为**可选**工具存在。

未安装 playwright 时，脚本会打印中文说明并 **exit 2**（不再是裸的 `MODULE_NOT_FOUND` 崩溃）：

```
[verify] 未安装 playwright，本脚本无法执行：需要真实浏览器截图，非网络不可。
[verify] 安装方式：cd tauri-shell && npm i -D playwright && npx playwright install chromium
[verify] 零依赖的真实渲染验收请改用：npm run verify:ui
```

需要截图时（在能联网的机器上）：

```sh
cd tauri-shell
npm i -D playwright            # 会写进 package.json，属临时改动，用完请还原
npx playwright install chromium
node verify/shot_context_bar.cjs
```

产物落到 `verify_shots/`（ignored）。

---

## 3. 常用排障

| 现象 | 判据 | 处置 |
|---|---|---|
| 页面白屏 | `dev server 200` 但 `#root` 子节点为 0 | `npm install` 补 `@babel/core` |
| `Failed to resolve import` | DOM 文本里出现该串 | 同上（依赖不完整，非源码缺陷） |
| `net::ERR_CONNECTION_REFUSED` | dev server 没起 | `npm run dev` |
| CORS warning 刷屏 | 端口不是 5180 | 回到 5180（不 FAIL，但后端数据没连上，验收不充分） |
| `RESULT: FAIL` 且含 `white screen` | 200 但 React 未挂载 | 查依赖是否装全（`@babel/core`）、控制台报错；**这是页面问题不是环境问题** |
| `RESULT: UNREACHABLE (exit 2)` | 端口无监听 / 浏览器起不来 | `npm run dev`；或设 `EDGE_PATH` |
| 找不到浏览器 | `CDP: no local Edge/Chrome found` | 设 `EDGE_PATH` 指向本机 Edge |
| 浏览器起不来 | DevTools 超时 | 确认没有残留 `--remote-debugging-port` 实例占端口 |
