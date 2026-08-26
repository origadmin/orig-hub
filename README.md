# Orig Hub

Orig Hub —— 基于 Surge 架构参考的桌面端下载管理器（YouTube Studio 风格）。

## 架构

| 舱 (crate/app) | 职责 | 技术栈 |
|---|---|---|
| `download-engine/` | 下载内核：多连接、分块、断点续传、镜像、多网卡调度 | Rust（Cargo workspace，5 个 crate） |
| `tauri-shell/` | 桌面壳：将下载内核作为 sidecar 嵌入，提供 GUI | Tauri v2 + React + TypeScript |

> 历史：`ui/` 为早期 Wails/Go 前端残留，已于 2026-08-26 清理；项目自 Go 迁移至 Rust。

## 构建与运行

```bash
# 下载内核
cd download-engine && cargo build --release

# 桌面壳（前端 + Tauri）
cd tauri-shell && npm install && npm run tauri dev
```

## 工程约定

- 提交信息遵循约定式格式：`feat/fix/refactor/docs/chore(scope): 描述`，scope 取 `engine` / `shell` / `docs`。
- 缺陷追踪：`docs/bugs/BUG-XXX.md`（参考 orig-cms-ee 约定）。
- 协作约定详见 `AGENTS.md`。

## 目录

```
orig-hub/
├── download-engine/   # Rust 下载内核（Cargo workspace）
├── tauri-shell/       # Tauri v2 桌面壳（Rust + React）
├── docs/              # 文档与缺陷追踪
├── .gitignore
├── AGENTS.md
└── README.md
```
