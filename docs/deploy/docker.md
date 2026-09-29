# Docker 部署与远程管理

## 动机

- **不再占线程、测完也不停**：原来的 `orig-daemon` 由桌面壳作为 sidecar 子进程拉起，跟着终端/外壳走，一关就停。Docker 以 `restart: unless-stopped` 常驻，容器 detach 运行，调试结束也不会死。
- **支持远程管理下载**：守护进程现在可绑定 `0.0.0.0` 并经 Bearer token 鉴权；除桌面壳外，可用 `orig-ctl` CLI 或指向远程地址的前端管控。

## 1. 构建镜像

```bash
cd download-engine
docker build -t orig-hub-engine:local .
```

镜像内含 `orig-daemon` 与 `orig-tg` 两个二进制（daemon 负责拉起/托管 orig-tg）。

## 2. 直接运行（含数据卷）

```bash
docker run -d --name orig-hub-engine \
  -p 19786:19786 \
  -e ORIG_DAEMON_HOST=0.0.0.0 \
  -e SURGE_TOKEN='你的强token' \
  -e ORIG_CORS_ORIGINS='http://localhost:5180' \
  -v orig-hub-data:/data \
  --restart unless-stopped \
  orig-hub-engine:local
```

## 3. 用 compose（推荐）

```bash
cd download-engine
export ORIG_HUB_TOKEN='你的强token'
export ORIG_HUB_CORS='http://localhost:5180,https://your-ui.example.com'
docker compose up -d
```

`docker-compose.yml` 已设 `restart: unless-stopped`，容器崩溃/宿主机重启都会自动拉起。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `ORIG_DAEMON_HOST` | 监听地址，`0.0.0.0` 接受外部连接 | `127.0.0.1` |
| `SURGE_TOKEN` / `ORIG_DAEMON_TOKEN` | Bearer token；**绑定非回环地址时必填**，否则 daemon 拒绝启动 | 空（不鉴权） |
| `ORIG_CORS_ORIGINS` | 允许的跨域源，逗号/空格分隔 | 桌面端白名单 |
| `PORT` | 监听端口 | `19786` |
| `SURGE_DOWNLOAD_DIR` | 下载落盘目录 | `/data/downloads` |
| `ORIG_TG_DATA` | TG 会话/库目录 | `/data/tg` |
| `ORIG_TG_ENABLED` | 是否拉起 orig-tg 子服务 | `true` |

数据落在卷 `orig-hub-data`（compose）或 `-v` 挂载的 `/data`，宿主机可直读。

## 4. 远程管理

### 4.1 orig-ctl CLI

```bash
# 指向远端守护进程
export ORIG_DAEMON_URL='http://host:19786'
export ORIG_DAEMON_TOKEN='你的token'

orig-ctl health
orig-ctl list
orig-ctl add 'https://example.com/file.zip' --filename out.zip
orig-ctl pause <id>
orig-ctl resume <id>
orig-ctl cancel <id>
orig-ctl remove <id>
orig-ctl config
orig-ctl watch          # 每 2s 轮询一次进度
```

### 4.2 前端指向远程

桌面/网页前端设 `VITE_DAEMON_URL` 即可把同一套 UI 当成远程控制台：

```bash
VITE_DAEMON_URL='http://host:19786' npm run dev
```

SSE 因浏览器 `EventSource` 不能带自定义头，鉴权 token 经 `?token=` 透传（daemon 已支持）。

## 5. 安全

- 绑定 `0.0.0.0` 但 **未设 token** → daemon 启动即退出（防裸奔）。
- 公网暴露务必：强 token + 反向代理 HTTPS + `ORIG_CORS_ORIGINS` 仅放可信源。
- 桌面端默认仍 `127.0.0.1`、无 token，行为与旧版一致，不受 Docker 改动影响。
