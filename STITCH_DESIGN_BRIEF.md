# Orig Hub — Google Stitch 设计需求文档

## 项目简介

Orig Hub 是一款桌面端下载管理器 + 媒体中心，基于 Wails (Go) + React + Tailwind/shadcn 构建。当前 UI 过于简陋，需要全面重设计，并新增视频播放（接入 orig-cms-ee）、媒体库、悬浮窗、FAB 等核心模块。

---

## 设计风格

- **风格**: 现代、简洁、专业，Dark-first，玻璃拟态点缀，Fluent Design 语言
- **圆角**: 12-16px
- **动画**: 微交互 200-300ms，弹性动画，脉冲动画（下载中）
- **模糊**: backdrop-blur 半透明面板
- **色彩**: 深色 zinc/slate 背景，emerald/cyan 强调色，状态色（绿=成功/琥珀=警告/红=错误），高对比度文字
- **字体**: 系统字体栈，数字用等宽字体，清晰层级，紧凑密度
- **布局**: 侧边栏（48px 折叠 / 200px 展开），内容区 header + 滚动，底部状态栏，浮动叠加层

---

## 需设计的界面

### 1. 主界面 (Main Dashboard)

**侧边栏导航**（可折叠 48px↔200px）：
- Downloading — 活跃下载列表
- Completed — 历史记录
- Library — 媒体库（新增）
- Player — 视频播放器（新增，接入 orig-cms-ee）
- Browser — 内置浏览器/内容发现（新增）
- Scheduler — 定时任务（新增）
- Settings — 设置

**顶部工具栏**：
- 搜索栏
- 筛选标签（协议/状态/类型）
- 视图切换（网格/列表）
- 新建下载、全部暂停/恢复、清除完成、打开目录、限速、校验、浏览器扩展

**内容区**：
- 下载卡片：文件名、进度条、速度、ETA、协议徽章（HTTP/BT/IPFS/Video）、状态图标
- 空状态插图
- 右键上下文菜单

**底部状态栏**：
- 活跃下载数、总速度、带宽占用

---

### 2. 下载状态悬浮窗 (Floating Download Widget) — 3 级渐进展开

单一组件，3 级渐进式展开，越贴边越隐蔽：

#### Level 1 — 贴边态（Edge-Snapped）
```
尺寸：4px 圆点 或 2×20px 竖线（贴屏幕边缘）
位置：吸附在屏幕任意边缘，几乎不可见
内容：仅一个微小的发光指示点/线
  - 下载中：emerald 微光脉冲
  - 空闲：muted 灰点，几乎透明
  - 暂停：amber 静止微光
  - 错误：red 静止微光
触发：鼠标移近屏幕边缘 20px 范围内 → 滑出 Level 2
```

#### Level 2 — 图标态（Icon Circle）
```
尺寸：32×32px 圆形
位置：从屏幕边缘滑出，半露在边缘
内容：
  - 中心：16px 下载图标
  - 外圈：2px SVG 环形进度描边（stroke-dasharray 动画）
  - 下载中：图标脉冲 + emerald 描边动画
  - 空闲：图标静止 + muted 色 + 无描边
  - 暂停：图标静止 + amber 描边
  - 错误：图标静止 + red 描边
触发：鼠标离开 → 300ms 后缩回 Level 1
       鼠标移上图标 → 展开到 Level 3
```

#### Level 3 — 胶囊态（Capsule Expanded）
```
尺寸：~172px 宽 × 28px 高（图标 + 右滑胶囊），pill 造型
位置：图标作为左端锚点，胶囊从右侧弹性滑出
内容：
  - 左端：图标 + 环形进度（保持 Level 2 样式）
  - 右侧胶囊：速度数字（JetBrains Mono 11px）+ 展开箭头（8px）
  - 下载中：⬇ 5.2 MB/s ↗  （emerald 色）
  - 空闲：⬇ Idle ↗          （muted 色）
  - 暂停：⬇ Paused ↗        （amber 色）
  - 错误：⬇ Error ↗         （red 色）
触发：鼠标离开 → 300ms 后缩回 Level 2 → 再 300ms 后缩回 Level 1
       点击展开箭头 → 恢复主窗口
```

#### 展开方向（边缘自适应）
```
贴左边缘 → 图标向右滑出，胶囊向右展开
贴右边缘 → 图标向左滑出，胶囊向左展开
贴上边缘 → 图标向下滑出，胶囊向下展开（竖向胶囊）
贴下边缘 → 图标向上滑出，胶囊向上展开（竖向胶囊）
贴角落   → 图标向屏幕中心方向滑出，胶囊沿边缘方向展开
```

#### 动画参数
```
Level 1→2 滑出：200ms ease-out，从边缘滑出 32px
Level 2→1 缩回：180ms ease-in，滑回边缘
Level 2→3 展开：250ms spring cubic-bezier(0.34,1.56,0.64,1)，轻微过冲
Level 3→2 收起：180ms ease-out
hover-off 延迟：300ms（防误触）
拖拽：按住图标可拖动到任意边缘，松手自动吸附最近边缘
```

---

### 3. 右下角弹出按钮 (FAB / Quick Action)

**默认态**：右下角圆形浮动按钮，带下载图标 + 通知角标

**展开态**（点击后径向菜单）：
- 添加下载
- 粘贴 URL（自动检测剪贴板）
- 拖放区域
- 限速开关
- 最近下载速览

**交互要求**：
- 弹性展开动画
- 剪贴板 URL 自动检测提示
- 拖放文件/链接到 FAB 区域触发下载

---

### 4. 视频播放器 (Video Player — orig-cms-ee 集成) ⭐核心新增

**全屏播放器**：
- 播放/暂停、进度条（缩略图预览）、音量滑块、全屏切换
- 播放速度选择（0.5x-2x）
- 字幕叠加（SRT/ASS）
- 章节标记
- 投屏按钮

**画中画迷你播放器**：
- 悬浮小窗口，始终置顶
- 可拖拽、可调整大小
- 基础控制（播放/暂停/关闭）
- 点击恢复全屏

**播放列表侧边栏**：
- 右侧抽屉式播放列表
- 当前播放高亮
- 拖拽排序
- 循环/随机模式

**orig-cms-ee 接入**：
- HLS/DASH 流媒体播放
- 内容目录浏览（从 orig-cms-ee 拉取）
- 视频详情页（标题/描述/标签/相关推荐）
- 播放进度记忆

---

### 5. 媒体库 (Media Library)

**海报墙**：
- 网格布局，卡片显示缩略图 + 时长徽章 + 观看进度条
- 分类标签：All / Video / Audio / Image / Document
- 筛选、排序、搜索

**特色区域**：
- "继续观看" 横向滚动行
- "最近添加" 区域
- 存储用量指示器（已用/总量进度条）

**文件预览**：
- 点击卡片弹出预览（视频缩略图/音频波形/图片预览）
- 元数据显示（大小/格式/时长/分辨率）

---

### 6. 下载管理增强

- 下载队列优先级拖拽排序
- 批量操作（全选/暂停/恢复/删除）
- 定时下载（设定开始时间）
- 限速器（滑块调节）
- 分类自动归档规则
- 浏览器扩展集成
- 剪贴板 URL 监控
- 多镜像源
- 校验和验证
- 重试策略
- 带宽分配

---

### 7. 设置面板重设计

分组设置页：
- **通用**：语言、主题、开机启动
- **下载**：默认目录、最大连接数、自动开始、分类规则
- **连接**：代理配置、最大带宽、并发限制
- **通知**：完成通知、声音提醒
- **快捷键**：自定义键盘快捷键
- **关于**：版本信息、更新检查、开源协议

**交互**：设置搜索、导入/导出配置、恢复默认

---

## 完整 Stitch Prompt

> Design a desktop download manager & media hub app called "Orig Hub".
>
> Style: Modern dark-first UI with glassmorphism accents, fluent design language, subtle backdrop-blur, rounded corners 12-16px, smooth micro-interactions 200-300ms, spring animations. Color palette: dark zinc/slate backgrounds, emerald/cyan accents, status colors green/amber/red, high contrast text. Typography: system font stack, monospace for numbers, clear hierarchy, compact density. Layout: collapsible sidebar 48px to 200px, content area with header and scroll, bottom status bar, floating overlays.
>
> Screens to design:
>
> 1. Main Dashboard — Left collapsible sidebar navigation with: Downloading, Completed, Library, Player, Browser, Scheduler, Settings. Top toolbar with search bar, filter chips by protocol/status/type, grid/list view toggle, action buttons (new download, pause all, resume all, clear, open folder, speed limit, verify, extension). Content area showing download cards with progress bars, speed, ETA, protocol badges (HTTP/BT/IPFS/Video), status icons. Empty state illustration. Right-click context menus. Bottom status bar with active count, total speed, bandwidth usage.
>
> 2. Floating Download Widget — Single component with 3-level progressive disclosure, edge-snapped behavior. Level 1 (Edge-Snapped): 4px glowing dot or 2×20px line stuck to screen edge, barely visible. Downloading=emerald pulse, Idle=nearly transparent, Paused=amber, Error=red. Mouse approaches within 20px of edge → slides out to Level 2. Level 2 (Icon Circle): 32×32px circle slides out from edge, contains 16px download icon + 2px SVG ring progress stroke (stroke-dasharray animation). Downloading=emerald pulse+ring animates, Idle=muted no ring, Paused=amber ring, Error=red ring. Mouse leaves → 300ms delay → retracts to Level 1. Mouse hovers icon → expands to Level 3. Level 3 (Capsule Expanded): Icon circle becomes left anchor, capsule bar springs out from right side, total ~172px wide × 28px tall pill shape. Capsule shows speed in JetBrains Mono 11px + expand arrow. Downloading=emerald "5.2 MB/s ↗", Idle=muted "Idle ↗", Paused=amber "Paused ↗", Error=red "Error ↗". Mouse leaves → 300ms delay → retracts to Level 2 → 300ms → Level 1. Click arrow → restore main window. Edge-adaptive direction: left edge→expands right, right edge→expands left, top→expands down (vertical capsule), bottom→expands up (vertical capsule), corner→expands toward center. Draggable: hold icon to drag, snap to nearest edge on release. Animations: L1→L2 slide 200ms ease-out, L2→L1 180ms ease-in, L2→L3 spring 250ms cubic-bezier(0.34,1.56,0.64,1) with slight overshoot, L3→L2 180ms ease-out. Background: rgba(24,24,27,0.9) with backdrop-blur(12px), 1px border rgba(255,255,255,0.08).
>
> 3. Quick Action FAB — Bottom-right floating action button with download icon and notification badge. On click: radial menu with Add Download, Paste URL with clipboard auto-detect, Drag-Drop Zone, Speed Limit Toggle, Recent Downloads Peek. Spring animation on expand. Drag files/links onto FAB to trigger download.
>
> 4. Video Player — Full player with playback controls, seek bar with thumbnail preview, volume slider, fullscreen toggle, playback speed 0.5x-2x, subtitle overlay SRT/ASS, chapter markers, cast button. Picture-in-picture mini player: always-on-top floating small window, draggable, resizable, basic controls, click to restore. Playlist sidebar: right drawer, current item highlighted, drag-reorder, loop/shuffle modes. orig-cms-ee integration: HLS/DASH streaming, content catalog browsing, video detail page with title/description/tags/related, playback progress memory.
>
> 5. Media Library — Poster wall grid with thumbnail cards showing duration badge and watch progress bar. Category tabs: All, Video, Audio, Image, Document. Filter, sort, search. Continue Watching horizontal scroll row. Recently Added section. Storage usage progress bar. File preview popup with metadata (size, format, duration, resolution).
>
> 6. Settings Panel — Grouped sections: General (language, theme, startup), Downloads (default dir, max connections, auto-start, category rules), Connection (proxy, max bandwidth, concurrency), Notifications (completion, sound), Shortcuts (custom keyboard shortcuts), About (version, updates, license). Settings search, import/export config, reset to defaults.
>
> Key interactions: Drag-reorder download queue priority, right-click context menus, toast notifications, keyboard shortcuts, URL auto-detection from clipboard, browser extension integration, batch operations.
