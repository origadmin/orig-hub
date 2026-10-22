---
status: decided
author: 架构分析（AI 协作者）
date: 2026-10-22
topic: download
module: engine+shell
decided-by: 用户（2026-10-22 连报裁定：BUG-380「接口到底干什么的」）
landed-in: docs/design/download-activity-api-contract-2026-10-22.md（本文档）；产品代码无改动（口径澄清，非缺陷修复）
---

# 下载域 API 口径契约：`/api/downloads`（原生面）与 `/api/activity`（聚合面）

> **来源**：用户 2026-10-22 报障原话：「api/downloads->bug322ui.bin，为什么返回的
> 只有一条数据，而且这个是已经完成的，这个接口到底干什么的?」
>
> **结论**：两个端点服务两个面，**都不是缺陷**——
> `/api/downloads` 是 daemon **引擎任务原生面**（本机确实只有一条 mock 样板），
> TG 入库任务活在 orig-tg、不经 daemon；界面下载域看到的水位来自
> `/api/activity` 聚合面。此前没有任何一处把这个口径写清楚，用户拿 API 返回值
> 与界面行数对不上是**必然**。本文档把口径写成契约，后续探针/前端/文档同引。

## 一、两个面的分工

| 面 | 端点 | 内容 | 消费者 |
|---|---|---|---|
| 引擎原生面 | `GET /api/downloads`（daemon 19786） | 仅 daemon 引擎任务（HTTP 直下 / mock / BT 单文件），带分块/连接明细 | 控制动作（pause/resume/cancel/retry 按原生 id）、下载详情 Sheet |
| 只读聚合面 | `GET /api/activity`（daemon 19786） | 引擎任务 + orig-tg 缓存任务合并呈现 | UI 下载域（`useIngestGroups`）、活动横幅 |

架构裁定（BUG-077 方案 a，`download-engine/crates/orig-daemon/src/activity.rs`
模块头五铁律）：两侧存储与引擎**不统一**，聚合面只统一**呈现**——
① 只读聚合不写任何一侧存储；② 写操作各走原路径（按 `control` 分流）；
③ 不造统一删除（缓存删副本 vs 下载删用户资产，误删不可逆）；
④ 不造假暂停/继续（TG 无真续传，cache 侧活跃时无动作、其余仅 retry）；
⑤ 跨进程容错——orig-tg 不可达时端点**恒 200**，降级为 `sources` 记录。

## 二、`/api/downloads` 契约（引擎原生面）

- **只含 daemon 引擎任务**。TG 入库（缓存）任务活在 orig-tg 的 `cache_task` 表，
  **不经 daemon**——本机该数组长度 1（`mock://bug322ui.bin` 样板）是**正确读数**，
  不是丢数据。
- 行字段：`id`（uuid）/ `url` / `filename` / `dest_path` / `total_size` /
  `downloaded` / `progress` / `speed` / `status` / `connections` /
  `connections_detail` / `blocks*` / `actions`。
- `status` 用引擎原生词：`downloading|queued|idle|paused|completed|interrupted|error|cancelled`。
  已 `completed` 的行仍返回（记录是结果，不是待办，BUG-319）。
- 出网路径统一 `/`（`orig_core::paths::to_wire`，BUG-379）；`\` 是回归。
- 写操作：`POST /api/downloads/:id?action=pause|resume|cancel`、
  `POST /api/downloads/:id/retry`（限 interrupted|error|cancelled）、
  `DELETE /api/downloads/:id`。

## 三、`/api/activity` 契约（只读聚合面）

### 查询参数

| 参数 | 取值 | 语义 |
|---|---|---|
| `scope` | `active`（**默认**） | 在途过滤（见下） |
| `scope` | `all` | 两侧已知全部（含已结束） |
| 未知值 | — | 回落 `active`，不 500 |

「在途」判定**跨侧故意不同口径**（两侧异构，不归一化）：

- `download`：`downloading|queued|idle`（与侧栏「下载中」档同口径，BUG-082）；
- `cache`：`queued|running|failed|interrupted`——failed/interrupted 是
  **停滞的在途**（无真续传只能整任务重跑），必须让用户看见，故意纳入。

### 响应体

```jsonc
{
  "tasks": [ TaskView… ],      // 在途优先 → updated_at 新→旧 → id 字典序
  "sources": [                 // 恒 2 条，顺序固定：download 在前、cache 在后
    { "kind": "download", "available": true,  "error": null, "count": 1 },
    { "kind": "cache",    "available": true,  "error": null, "count": 148 }
  ],
  "generated_at": 1792607456
}
```

`TaskView` 关键字段（异构痕迹**刻意保留**，见五铁律）：

| 字段 | 口径 |
|---|---|
| `kind` | `download` \| `cache`（小写） |
| `id` | `dl:<uuid>` / `tg:<i64>`，**仅供视图定位**；写操作用 `control` |
| `groupKey` | cache = orig-tg `itemKey`（同一内容多次入库前端合并成一行，BUG-300）；download = 任务 id 自身 |
| `unit` | download = `bytes`；cache = `items`（条目数，防把「N 条消息」读成「N 字节」） |
| `status` | **各侧原生词，不跨侧归一化**（归一化即宣称两侧同构） |
| `speed` | download 运行态有采样、非运行态 0；cache 恒 `null`（无采样——不是 0） |
| `actions` | 只列该侧**真实具备**的动词；两侧永不含删除类 |
| `control` | `{side: daemon\|tg, native_id}`——写操作指回原端点的分流凭证 |
| `chatId`/`messageIds` | 仅 cache 有（TG 定位坐标）；download 为 `null`/`[]` |

`sources` 是**可用性显式通道**（BUG-176「取不到 ≠ 没有」同源纪律）：
orig-tg 不可达 ⇒ `sources[1].available=false` + `error` 原因，`tasks` 里
就是没有 cache 条，但端点仍 200、download 条照常。前端必须把
`available=false` 渲染成 banner，**不许**渲染成「没有任务」。

### 探针口径（BUG-377 教训，写进来防再犯）

- UI「已暂停/停止」档读数 = `/api/activity?scope=all`（对齐 UI 口径）。
  裸取 `/api/activity`（默认 active）会少算终态 ⇒ 假红。
- 响应里 `kind` 混装两侧：算「入库任务」必须 `kind === 'cache'` 过滤，
  否则引擎 `completed` 行会被当成停止组（BUG-377 探针曾因此假红 +8）。

## 四、UI 下载域数据源（前端合并点）

`src/domains/download/useIngestGroups.ts`（单一数据源 + 单一轮询点，BUG-300/M3）：

- 读 daemon `GET /api/activity?scope=all`（合并由 daemon 聚合面完成，
  前端**不**自己并发打两个端点拼列表）；
- `groupKey` 合并同一内容多次入库为一行；`control` 分流写操作
  （`side=tg` ⇒ orig-tg `/api/cache/*`；`side=daemon` ⇒ `/api/downloads/:id`）；
- 轮询三律（AGENTS.md §5）：有活才轮（在传 queued/running）、等值短路不
  setState、来源不可用时续轮（BUG-318 例外——未知状态停轮 = 恢复后不回血）。

## 五、关联与开放项

- BUG-077（聚合面五铁律）、BUG-300（groupKey 合并）、BUG-318（端口顺延 +
  不可用续轮）、BUG-319（内存 ∪ 库）、BUG-355（下载源可用性真实化）、
  BUG-379（出网路径 `/` 规范化，已上线实证 `dest_path="D:/OrigDown/bug322ui.bin"`）。
- **开放项 BUG-386**：cat-all 行集里下载成品行不参与搜索过滤、按 mtime
  混排挤占媒体行（下载域/并发写者辖区，拟独立登记跟踪）。

## 变更记录

- 2026-10-22 初版：两口径契约 + 探针口径 + UI 数据源（用户连报裁定，
  活栈 19786/19787 实证：`/api/downloads` 长度 1 = 引擎任务全集；
  `/api/activity?scope=all` 149 条 = 1 download + 148 cache）。
