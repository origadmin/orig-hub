# 分类菜单功能交付概述

## 完成内容
- **后端（download-engine）**：每个下载任务新增 `category` 字段，任务创建时按配置 `classify_rules` 计算分类名（如 `.tar.gz` → `Archives`），并随 `/api/downloads` 返回。
- **前端（tauri-shell）**：左侧 Sidebar 新增可展开「全部文件」父节点，子项从 daemon 配置中推导（Archives / Documents / Images / Music / Videos）；MainLayout 按选中的分类过滤下载列表。
- **加固**：`tauri-shell/src-tauri/src/lib.rs` 的 `ensure_daemon` 会校验 9876 监听进程名，拒绝复用残留旧 daemon。

## 验证结果
- dev 模式 Playwright 截图显示：
  - 默认 Sidebar 出现「全部文件、下载中、已完成、设置」；
  - 「全部文件」展开后显示 5 个分类子项；
  - 选中 `Archives` 后，列表仅显示分类为 Archives 的 nginx 任务。
- `curl /api/downloads` 返回 JSON 含 `"category": "Archives"`。
- Commit: `9832b4a` feat(sidebar): implement expandable All Files category menu with backend category tagging.

## 关键坑点
- `npm run tauri dev` 使用的 sidecar `tauri-shell/src-tauri/target/debug/orig-daemon.exe` 不会自动刷新；本次验证中曾因它仍是旧二进制导致 `/api/downloads` 没有 `category` 字段，已手动覆盖为新编译的二进制。

# 2026-08-27 修复：Tauri 二进制 localhost 拒绝连接

## 根因
- debug 构建的 `tauri-shell/src-tauri/target/debug/orig-hub.exe` 烤入了 devUrl `http://localhost:5180`，单独运行没有 Vite 服务时，webview 连不上即报 localhost 拒绝连接。
- release 构建 `tauri-shell/src-tauri/target/release/orig-hub.exe` 通过 `frontendDist` 打包内置前端，双击即用，不依赖 localhost。

## 修复
- `tauri-shell/vite.config.ts`：`server.host` 从 `host || false` 改为 `host || true`，Vite dev 监听 `0.0.0.0`，兼容 `localhost` 解析到 127.0.0.1 或 ::1。
- 已重新构建自包含的 release `orig-hub.exe`（内置 dist + orig-daemon sidecar）。

## 验证
- `curl 127.0.0.1:5180` 与 `curl localhost:5180` 均返回 HTTP 200。
- Playwright 截图 `verify_shots/01_sidebar_default.png` 显示应用正常渲染，无 localhost 拒绝连接错误。
- 新 release 二进制：`tauri-shell/src-tauri/target/release/orig-hub.exe`（11.4MB，2026-08-27 15:58）。

## 正确使用方式
- 双击即用（release）：`tauri-shell/src-tauri/target/release/orig-hub.exe`
- 开发模式：`cd tauri-shell && npm run tauri dev`（会同时启动 Vite）

# 2026-08-27 交付：内置分类多语言 + 侧栏展开交互拆分

## 完成内容
- **文件翻译模式 i18n**：新建 `tauri-shell/src/i18n/locales/zh-CN.json`、`en-US.json` 与 `tauri-shell/src/i18n/index.ts`（`t()` / `useTranslation()` / `setLanguage()` / `applyLanguage()`）。
- **语言设置持久化**：`AppSettings` 增加 `language: 'zh-CN' | 'en-US'`，默认按 `navigator.language` 检测；设置 → 常规增加即时生效的语言切换器。
- **侧栏「全部文件」交互拆分**：文字/图标区域点击 = 切到全部视图并展开子菜单；右侧 chevron 按钮点击 = 仅翻转子菜单展开/收起，不影响当前视图/分类筛选。`data-testid="category-chevron"` 用于自动化测试。
- **内置分类多语言**：分类规范化 key（Videos / Music / Images / Documents / Archives）作为磁盘子目录和筛选值保持不动，侧栏下钻与设置页文案通过 `category.<Key>` 本地化（中文：`视频/音乐/图片/文档/压缩包`）。
- **UI 文案 i18n 覆盖**：侧栏导航、设置页全部 Tab、MainLayout 顶部工具栏与状态栏均支持中英文切换。

## 改动文件
- 新增：`tauri-shell/src/i18n/locales/zh-CN.json`、`tauri-shell/src/i18n/locales/en-US.json`、`tauri-shell/src/i18n/index.ts`
- 修改：`tauri-shell/src/types.ts`、`tauri-shell/src/store/useStore.ts`、`tauri-shell/src/main.tsx`
- 修改：`tauri-shell/src/components/Sidebar.tsx`、`tauri-shell/src/components/SettingsPanel.tsx`、`tauri-shell/src/components/MainLayout.tsx`

## 验证结果
- `tsc --noEmit` 通过。
- Playwright 真实渲染验证（接真实 daemon 127.0.0.1:9876，浏览器 locale=zh-CN）：
  - `verify_shots/01-zh-default.png`：默认中文侧栏 + 状态栏。
  - `verify_shots/02-zh-chevron-expands-submenu-while-still-downloading.png`：在「下载中」视图下点 chevron，子菜单展开且视图仍停在「下载中」；子菜单显示本地化分类 `视频/音乐/图片/文档/压缩包`。
  - `verify_shots/03b-zh-settings-general.png`：设置 → 常规，含新增「语言」切换器。
  - `verify_shots/04-en-settings-general.png`：切英文后设置页/侧栏整体英文。
  - `verify_shots/05-en-sidebar.png`：英文侧栏分类显示 `Archives/Documents/Images/Music/Videos`。

## 已知后续
- 下载列表卡片内状态文案（如「已完成」「连接」「块」「均速」）尚未纳入 i18n，属于 `DownloadList` 组件，本次未改动。

# 2026-08-27 交付：自动分类设置页修复（布局 / 翻译 / 规范 key 对齐）

## 完成内容
- **修复新增分类行布局错乱（BUG-008）**：`Input` 组件硬编码 `w-full`，而 `cn()` 无 `tailwind-merge`，新增行传入 `w-28`/`flex-1` 产生宽度冲突。修复：`SettingsPanel.tsx` 用外层 `div` 控制宽度，`Input` 仅负责填满 wrapper，避免同场冲突。
- **修复内置分类未翻译（BUG-009）**：编辑器内分类名用裸 `<input value={c.category}>`，归档提示 `catDir` 直接插值英文 key。修复：内置分类名以只读翻译标签展示（`t('category.'+key)`），`catDir` 插值也经 `t()` 翻译；自定义分类仍可编辑。
- **对齐 daemon 规范 key（BUG-010）**：前端 `BUILTIN_CLASSIFY` 自造了 `Audio/Programs/Discs/Torrents/Data/Web`，与 daemon `ClassifyConfig::defaults()`（Videos/Music/Images/Documents/Archives）不一致，会导致音频被拆、出现 daemon 不会创建的幽灵分类。修复：前端 `BUILTIN_CLASSIFY` 完全对齐 daemon，音频统一为 `Music`，`csv→Documents`，`iso→Archives`，删除幽灵分类。
- **新增 `BUILTIN_CATEGORY_KEYS`**：用于判定哪些分类是规范 key（只读 + 翻译展示），防止用户重命名规范 key 后与 daemon 脱节产生双重目录。
- **登记 BUG**：按 `docs/bugs/README.md` 模板新增 BUG-008/009/010，更新追踪表。

## 改动文件
- `tauri-shell/src/components/SettingsPanel.tsx`（BUILTIN_CLASSIFY 对齐、BUILTIN_CATEGORY_KEYS、内置分类只读翻译标签、catDir 翻译、新增行布局）
- `verify_shots/verify_auto_classify.py`（Playwright 验证脚本）
- `docs/bugs/BUG-008.md`、`docs/bugs/BUG-009.md`、`docs/bugs/BUG-010.md`、`docs/bugs/README.md`
- `.workbuddy/memory/2026-08-27.md`、`.workbuddy/memory/MEMORY.md`

## 验证结果
- `npm run build`（tsc + vite build）通过，EXIT=0。
- Playwright 真实渲染验证（系统 Chrome，Python playwright 1.62，Vite dev localhost:5180）：
  - 中文下内置分类显示 `压缩包/文档/图片/音乐/视频`，归档提示 `归档到子目录 视频`。
  - 英文下内置分类显示 `Archives/Documents/Images/Music/Videos`，归档提示 `Archived to subfolder Videos`。
  - 新增行两输入框宽度正常（112px / 466px），`添加分类` / `Add category` 按钮可见。
  - 截图：`verify_shots/auto-classify-zh.png`、`auto-classify-add-row-zh.png`、`auto-classify-en.png`、`auto-classify-add-row-en.png`。
  - 仅 `favicon.ico` 404（benign）。
- `npm run tauri build` 成功生成 release 二进制与 MSI；`verify_shots/accept_binary.ps1` **PASS**（A/B/C/D/E 全绿）。

## 交付产物
- `tauri-shell/src-tauri/target/release/orig-hub.exe`（自包含 release 二进制，双击即用）
- `tauri-shell/src-tauri/target/release/bundle/msi/Orig Hub_0.1.0_x64_en-US.msi`
- `tauri-shell/src-tauri/target/release/bundle/nsis/Orig Hub_0.1.0_x64-setup.exe`

## 关键坑点 / 防再发
- `cn()` 只是字符串拼接，无 tailwind-merge。任何给 `Input` 等基础组件传 `w-*` 宽度类时，必须先确认是否与其基础 `w-full` 冲突；系统级根治是引入 `tailwind-merge`。
- 内置分类的规范 key 同时是磁盘子目录、`classify_rules` 键、前端 `categoryFilter` 值，必须三方对齐。前端展示层只通过 `category.<Key>` 翻译，**不要**把 key 本身替换为翻译串。
- 用户已明确决策/方案必须按字面执行，不得自行加「顺带」副作用（参见侧栏拆分教训）。

