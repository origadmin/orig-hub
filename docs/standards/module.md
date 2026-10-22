---
status: active
scope: 全仓（download-engine + tauri-shell）
date: 2026-10-23
enforced-by: 目录归属规则（AGENTS.md §6）+ 门禁
---

# 模块标准（分层与归属）

> 立项原因（用户 2026-10-23）：「当前缺少开发,样式,模块各方面的标准文档」。

## 1. 双舱边界

| 舱 | 目录 | 职责 | 禁区 |
|---|---|---|---|
| 引擎舱 | `download-engine/`（orig-daemon 19786、orig-tg 19787） | 下载执行、TG 接入、入库、字节与记录 | 不直接改壳的 UI 状态 |
| 壳 | `tauri-shell/`（vite 5180） | 呈现、交互、领域聚合 | 不绕过 daemon 直连 sidecar 的控制端点（BUG-392） |
| 验收 | `tauri-shell/verify/`、`download-engine/**/tests`、仓库根 `scripts/` | 取证的**唯一**落点 | 验收脚本不得改产品行为 |

`framework/` 是 submodule：**只可 commit，禁止任何业务改动**。

## 2. 目录归属（新增代码先选舱再选目录）

- `tauri-shell/src/domains/<domain>/`：领域逻辑（聚合、分档、动作谓词），**不含**通用控件。
- `tauri-shell/src/components/ui/`：跨域通用控件（样式标准的落点）。
- `tauri-shell/src/components/media/`、`components/`：媒体域/通用业务组件。
- `tauri-shell/src/api/`：端点封装（一个端点一个函数，注释写明动词与副作用）。
- `tauri-shell/src/store/`：全局状态（SSE 合并），**窄选择器只返回标量**。
- `download-engine/crates/<crate>/src/`：`routes.rs`（端点与路由）、`store.rs`（持久化）、
  领域模块（`activity.rs`、`cache.rs`…）。

## 3. 分层依赖方向（单向，禁止反向）

```
components/ui  ←  components/*  ←  domains/*  ←  shell/*
        ↑                ↑              ↑
     （无领域知识）   （可含领域组件）  （可含业务聚合）
   api/* ← 被 domains 与 components 调用
```

- `ui/*` **不得** import 领域模块（一旦引用就不再是通用件）。
- `api/*` **不得** import 组件；`store/*` 不得 import 组件。
- 领域模块之间禁止循环引用；共享口径上提到 `lib/` 或 `ui/`。

## 4. 单一真源清单（改动必须改这一处）

| 事实 | 唯一定义处 |
|---|---|
| 下载分档谓词（列表/徽标/状态栏共用） | `domains/download/dlBuckets.ts` |
| 入库分档谓词 | `domains/download/ingestGroups.ts` |
| 选择形态（条/全选/行框） | `components/ui/selection-bar.tsx` |
| 下载域列表与状态变更端点 | daemon `/api/downloads`（`routes.rs`） |
| TG 端口真源 | daemon `st.tg_port_state()` → `/api/config.tg_port` |
| 路径出网形态 | `orig_core::paths::to_wire` |

## 5. 新增模块/端点的准入

1. 先回答「既有的哪个模块已经是它」——是则扩展，不新建。
2. 新端点必须写明：动词、作用域、失败语义（422/404/降级 200）、是否被 UI 调用
   （无人调用即死端点，不得新增）。
3. 新域必须自带：验收探针 + 至少一个**非恒绿**判据 + 证据目录。
4. 引擎侧新增列/表必须配「旧库→新代码」迁移单测（建表批只允许新旧库都有的列）。
