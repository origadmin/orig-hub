# HTTP API 契约（新增/迁移）

- 配套：[02-backend-architecture.md](02-backend-architecture.md)
- 约定：
  - 鉴权沿用现状：管理面 Bearer token 或 `?token=`（仅绑环回）；M5 共享面独立令牌（见 §6）。
  - 错误体沿用现有 `/api/*` 形态（执行前以现有 handler 为准核对，禁止新造第二套 envelope）；本文用 `{"error":{...}}` 仅作示意。
  - 所有时间戳为 Unix 毫秒整数；路径用绝对路径字符串返回。
- **对 spec 的一处细化（M2 服务归属）**：文件事实端点 M2 即落在 **orig-daemon**（而非 spec tasks 稿写的「orig-tg 期」）。
  理由：文件层属核心面（D1=A），daemon 天然拥有下载根与任务记录；媒体投影在 M3 前经现有批量端点
  `/api/media/items/by-refs` 跨服 enrich、M3 后改本地读——只搬一次。M3 前 TG 关闭时文件夹视图仅覆盖下载根，
  UI 明示部分可用；M3 后全量（该限制随 BUG-172 一起消失）。

---

## 1. ffmpeg 诊断与配置（M1，先落 orig-tg；M3 原样迁 daemon，路径不变）

### 1.1 `GET /api/ffmpeg/status`

能力探测（昂贵，进程级缓存；用户配置不影响本结果）。

```json
{
  "ok": true,
  "resolved_path": "C:\\Users\\x\\AppData\\Local\\OrigHub\\bin\\ffmpeg.exe",
  "resolve_chain": [
    { "step": "env ORIG_FFMPEG_PATH", "hit": false, "checked": null },
    { "step": "sidecar_dir", "hit": false },
    { "step": "tg_data/bin", "hit": false },
    { "step": "localappdata/OrigHub/bin", "hit": true,  "checked": "C:\\...\\bin\\ffmpeg.exe" },
    { "step": "PATH", "hit": false }
  ],
  "version": "ffmpeg 7.1 full_build",
  "probes": { "hwaccels": ["cuda", "dxva2", "d3d11va", "qsv"], "decoders": ["hevc_cuvid", "h264_cuvid"] },
  "gpus": [ { "index": 0, "name": "NVIDIA RTX 4060", "kind": "nvidia" },
            { "index": 1, "name": "Intel(R) UHD Graphics 770", "kind": "intel" } ],
  "recommended": { "mode": "auto", "hwaccel": "cuda", "device": "0" },
  "effective":   { "mode": "auto", "hwaccel": "cuda", "device": "0", "source": "persisted" },
  "env_override": null
}
```

- ffmpeg 不存在：HTTP 200 + `"ok": false`（不是 5xx），`resolve_chain` 每步如实给出，`recommended` 给出安装引导（`"action": {"type":"install","anchor":"settings.engine"}`）。
- `env_override`：当 `ORIG_FFMPEG_PATH` / `ORIG_TG_HWACCEL` 生效时回显，前端提示「当前被环境变量覆盖」。
- 优先级：env > persisted > 探测默认（auto 软解兜底）。

### 1.2 `GET /api/ffmpeg/config`

```json
{ "path": "C:\\...\\ffmpeg.exe", "mode": "auto", "hwaccel": null, "device": null, "writable": true }
```

### 1.3 `PUT /api/ffmpeg/config`

```json
// 请求（字段均可部分提交）
{ "path": "D:\\tools\\ffmpeg.exe", "mode": "soft" }
```

- `mode`: `"auto" | "soft" | "manual"`；manual 时必须带 `hwaccel`（如 `cuda`/`qsv`/`dxva2`），可选 `device`。
- 服务端校验：path 存在且 `ffmpeg -version` 可执行，否则 400（带回显原因，不落配置）；manual 后端点做一次能力匹配，硬件后端不在 probes 列表 → 409（允许确认后强制？v1 拒绝，避免写入必坏配置）。
- 成功：`200` 返回同 1.2；**下一次转码即生效**（进程不重启，AC：auto→off 命令行断言）。
- 持久化：M1 写 tg_store `app_setting` 键 `ffmpeg.path|ffmpeg.hwaccel|ffmpeg.device`；M3 迁 library.db。

---

## 2. 文件事实层（M2，orig-daemon）

### 2.1 `GET /api/files/roots`

```json
{
  "roots": [
    { "id": "library", "kind": "library", "path": "C:\\Users\\x\\OrigHubLibrary", "available": true,
      "owner": "daemon", "origin_ready": true },
    { "id": "download:videos", "kind": "download", "label": "Videos", "path": "D:\\Downloads\\Videos",
      "available": true, "owner": "daemon" },
    { "id": "download:others", "kind": "download", "label": "Others", "path": "D:\\Downloads",
      "available": true, "owner": "daemon" }
  ],
  "partial": false
}
```

- M3 前若 orig-tg 离线：library 根可能缺席或仅能给路径不能给投影，`partial: true`，前端显示降级提示（复用「来源服务未连接」文案体系）。

### 2.2 `GET /api/files/facts`

查询参数：`root`（可重复/逗号）、`kind=video|photo|audio|doc|archive|other`、`origin=download|tg|import|unknown`、`q`（路径/文件名模糊）、`limit`（默认 200，上限 500）、`cursor`。

```json
{
  "snapshot_version": 1728790012000,
  "total_matched": 1320,
  "items": [
    {
      "fact_id": "library:8f31c2",
      "root_id": "library",
      "rel_path": "Movies/2026/demo.mkv",
      "name": "demo.mkv",
      "size": 482133912,
      "mtime": 1728700000000,
      "kind": "video",
      "origin": { "type": "tg", "chat": -100123, "msg": 4821 },
      "media_item_id": 331,
      "health": "ok"
    },
    {
      "fact_id": "download:others:a91bd0",
      "root_id": "download:others",
      "rel_path": "manual.zip",
      "name": "manual.zip",
      "size": 204812,
      "mtime": 1728600000000,
      "kind": "archive",
      "origin": { "type": "download", "task_id": "TRC-00012-1" },
      "media_item_id": null,
      "health": "ok"
    }
  ],
  "next_cursor": "bHM6MTMyMA=="
}
```

- 健康标记：`ok | orphan_entry | unmanaged`（命名最终定；orphan=有条目无文件、unmanaged=有文件无条目）。
- **性能契约**：读端点只读内存快照，不现场扫盘/不现场查库；快照由事件与低频后台刷新维护（§D1）。
- 幂等：同一 snapshot_version 下翻页结果稳定。

### 2.3 操作（M2 范围内只读 + 既有动作复用）

- M2 **不新发明**删除/移动端点：条目操作继续走 `/api/media/items/*` 既有接口；非媒体文件的管理动作（打开所在位置等）走 Tauri 本地能力（`api/tauri.ts`）。后续是否需要纯文件删除端点，待 FoldersView 使用反馈另立决策，不在本期。

---

## 3. 媒体入库内部端点（M3，仅环回 + daemon token）

### 3.1 `POST /api/media/ingest`

```json
{
  "source": "tg",
  "ref": "-100123:4821",
  "title": "首行标题",
  "description": "caption 正文快照",
  "kind": "video",
  "file_path": "C:\\...\\Library\\Movies/xx.mkv",
  "size": 482133912,
  "duration": 3612,
  "width": 1920,
  "height": 1080,
  "group_id": 77,
  "captured_at": 1728700000000
}
```

- 语义等同现缓存成功路径的 upsert：`UNIQUE(source,ref)` 幂等；成功返回 `{ "item_id": 331, "created": false }`。
- 自动成剧（source_key `tg:group:{chat}:{group_id}`）、相册组继承等既有服务端规则不变，随 media.rs 一起迁入 daemon。
- 失败：5xx 可重试；orig-tg cache 侧按现有任务失败/重试纪律处理，不得自行删字节。
- 永不绑到共享面；永不接受外部网卡请求。

---

## 4. 既有媒体端点迁移（M3，无契约变更）

- 全部 `/api/media/*`（stats、items 系列含 raw/stream/by-ref(s)/tags、series/episodes/sources、tags、scan、export）路径与 JSON 不变，仅服务方改为 daemon。
- 例外允许：501（ffmpeg 缺失）文案体结构在 M1 已升级为带 `action` 引导（§1.2）。
- 前端改动面：`api/media.ts` base 一行；`by-refs` 批量端点 M2 被文件层复用（§2 细化）。

---

## 5. ffmpeg 受管安装（M4，daemon）

### 5.1 `GET /api/ffmpeg/install/plan`

```json
{
  "manifest_version": "7.1-20261013",
  "target_path": "C:\\...\\OrigHub\\bin\\ffmpeg.exe",
  "packages": [
    { "source": "network", "url": "https://.../ffmpeg-release.7z", "size": 94000000,
      "sha256": "…", "via_proxy": true },
    { "source": "local-dir", "hint": "把离线包放入指定目录或选择目录" }
  ],
  "proxy": { "configured": true, "endpoint": "http://127.0.0.1:7897" }
}
```

### 5.2 `POST /api/ffmpeg/install/start`

```json
{ "source": "network" }                         // 或 { "source": "local-dir", "dir": "D:\\pkg" }
// → 202 { "job_id": "ffinst-1" }
```

### 5.3 `GET /api/ffmpeg/install/events`（SSE）

```
event: progress
data: {"phase":"download","done":31000000,"total":94000000}

event: progress
data: {"phase":"verify"}

event: log
data: {"message":"extracting to staging …"}

event: done
data: {"version":"ffmpeg 7.1 full_build","path":"C:\\...\\bin\\ffmpeg.exe"}
```

- 阶段机：`download → verify(sha256) → extract(staging) → probe(-version/caps) → activate(原子 rename) → done`。
- 失败事件：`event: error` + `{"phase":"verify","code":"sha256_mismatch"}`；规则：校验不过不 activate、不删旧 ffmpeg、staging 清理；任何阶段失败旧版本保持可用。
- `POST /api/ffmpeg/install/cancel`：仅 download/extract 可取消；verify 之后不可取消。
- 安全：清单信任根（清单 URL/签名策略）在 dev-plan 期安全评审定稿；下载必须复用 daemon 代理配置；离线包同样强制 sha256。

---

## 6. 局域网共享（M5，daemon）

### 6.1 管理面（环回 + 主 token）

- `GET /api/share/status`

```json
{ "enabled": false, "listener": null, "lan_url": null,
  "last_enabled_at": null, "token_last_rotated_at": null, "active_connections": 0 }
```

- `GET /api/share/config`：`{ "bind_interface": null, "port": 8080, "allowed_roots": ["library"] }`
- `PUT /api/share/config`：写入后不自动启用；`{"enabled":true}` 必须**同时**显式带 interface 与 port；缺失 → 400（杜绝默认绑 0.0.0.0）。
  - 启用响应：`200 { "enabled": true, "listener": {"ip":"192.168.1.20","port":8080}, "lan_url": "http://192.168.1.20:8080/s/", "token_last_rotated_at": … }`
- `POST /api/share/token/rotate`：`{ "token": "…（仅完整回显一次）" }`；旧令牌立即失效。
- `GET /api/share/access-events?limit=100`：时间/IP/路径/结果（允许或 401）。
- 停用：`PUT {"enabled":false}` → 立即关闭监听（netstat 可证）。

### 6.2 对外面（选定网卡，只读；无写方法）

| 方法/路径 | 语义 |
|---|---|
| `GET /s/browse?path=` | 浏览允许根的目录与可播条目（JSON，不含设置/任务/TG 信息） |
| `HEAD /s/items/:id/raw` / `GET /s/items/:id/raw` | 文件投递，全走 orig-file-serve 同一函数（Range/206/ETag/MIME/背压） |

- 认证：`Authorization: Bearer <share_token>` 或 `?token=`；无/错令牌一律 401，不泄露条目是否存在。
- 白名单方法之外（POST/PUT/DELETE/PATCH…）→ 405；越出 `allowed_roots` 的 path → 404。
- 响应头安全基线：不回显内部绝对路径以外的敏感信息；`Content-Disposition` 文件名沿用现有嗅探纪律。

---

## 7. 版本与兼容矩阵

| 端点组 | M0 | M1 | M2 | M3 | M4 | M5 |
|---|---|---|---|---|---|---|
| `/api/ffmpeg/status`、`/config` | — | tg | tg | **迁 daemon，路径不变** | daemon | daemon |
| `/api/files/*` | — | — | **daemon（projection 走 tg HTTP）** | daemon（投影本地化） | daemon | daemon |
| `/api/media/ingest` | — | — | — | daemon 新增 | daemon | daemon |
| `/api/media/*` 既有 | tg | tg | tg | **迁 daemon** | daemon | daemon |
| `/api/ffmpeg/install/*` | — | — | — | — | daemon | daemon |
| `/api/share/*`、`/s/*` | — | — | — | — | — | daemon |
| `/api/tg/*`、`/api/cache/*` | tg | tg | tg | tg（local 投递改共享 crate） | tg | tg |
