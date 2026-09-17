# 缺陷追踪约定（BUG-XXX.md）

每个缺陷一个文件，命名 `BUG-<编号>.md`，编号自 `BUG-001` 起自增。模板如下：

```markdown
# BUG-<编号>: <一句话标题>

- 状态: open | in_progress | fixed | wontfix | closed
- 发现日期: YYYY-MM-DD
- 模块: engine | shell
- 严重程度: low | mid | high | critical

## 现象
<用户/测试观察到的现象>

## 根因
<定位到的代码位置与原因，附 file:line>

## 复现
<最小复现步骤 / 验证脚本>

## 修复
<改动摘要 + 验收方式>

## 关联
<相关 BUG / 提交 / 文档>
```

## 当前登记

| 编号 | 标题 | 状态 | 模块 |
|---|---|---|---|
| BUG-001 | 下载文件不自动嗅探/不按实际文件命名 | fixed | engine |
| BUG-002 | 无法查看每连接状态与分块进度 | fixed | engine+shell |
| BUG-003 | 速度统计失准（完成仍显示/进行中不准） | fixed | engine+shell |
| BUG-004 | 无全局进度状态，状态栏仅计数无实时速度 | fixed | shell |
| BUG-005 | 「打开文件/打开目录」按钮无效 + 纯文字样式不一致 | closed | shell |
| BUG-006 | 侧边栏「全部文件」展开/收起交互行为不纯 | fixed | shell |
| BUG-007 | 内置分类标签不支持多语言设置 | fixed | shell |
| BUG-008 | 自动分类「新增分类行」布局错乱（Input w-full 冲突） | fixed | shell |
| BUG-009 | 自动分类编辑器内置分类名未翻译 | fixed | shell |
| BUG-010 | 前端 BUILTIN_CLASSIFY 与 daemon 规范分类键不一致 | fixed | shell |
| BUG-011 | 运行中反复弹出 Terminal 小窗（spawn 控制台命令未隐藏窗口） | fixed | engine+shell |
| BUG-012 | 无法拉取应用（TG 频道列表失败）且显示已登录但实际会话失效 | fixed | engine |
| BUG-013 | 分组（TG 频道列表）加载极慢，单次全量拉取导致前端拿不到分组 | open | engine+shell |
| BUG-014 | 入库媒体看不到图片/视频，无法选择下载/浏览 | open | engine+shell |
| BUG-015 | TG 面板交互结构错误：订阅/监控混排、内容无历史分页、非聊天式时序 | open | engine+shell |
| BUG-016 | TG api_id/api_hash 丢失（凭证仅存活于进程内存，进程被杀即失效） | fixed | engine |
| BUG-017 | 分组视图成员缺失（dialog_cache.folder 只覆盖 37/510 频道） | fixed | engine |
| BUG-018 | 媒体库长期空白——只显示「TG 已缓存」媒体且无任何管理能力 | fixed | engine+shell |
| BUG-019 | 内容归入多个剧集时列表出现重复条目（JOIN 扇出） | fixed | engine |
| BUG-020 | 剧集卡片无封面；首集为视频时把视频地址当图片 src | fixed | engine+shell |
| BUG-021 | CORS 未允许 PATCH/PUT —— 封面与元数据保存静默失败 | fixed | engine |
| BUG-022 | PATCH 请求体强制要求 id —— 前端局部更新全部 422 | fixed | engine |
| BUG-023 | TG 连接失败静默退化为 dummy —— 登录/发码/client id 全体「消失」且端口冲突 panic | fixed | engine+shell |
| BUG-024 | 缓存状态完全丢失 —— 下载任务只活在浏览器内存，刷新即归零且无法续传 | fixed | engine+shell |
| BUG-025 | `/api/tg/code` 在未登录（含服务不可用）时回「已授权」—— 交验证码即伪造出登录态 | fixed | engine |
| BUG-026 | 缓存任务轮询致页面卡顿 —— 每秒整面板重渲染 + 高频读打 SQLite | fixed | engine+shell |
| BUG-027 | 1s 多次请求 + 页面卡死 —— 多任务并发 worker + 进度派发重量级重取链 | fixed | engine+shell |
| BUG-028 | TG 在线播放严重卡顿 —— 单连接串行拉流(0.5MB/s) + 每 Range 1.2s RPC | fixed | engine |
| BUG-029 | 缓存不入媒体库 + 缓存任务无可观测面 —— 缓存即入库(双向删除联动) + 缓存管理面板 | fixed | engine+shell |
| BUG-030 | task 轮询过频致页面卡顿 —— 双源并行轮询 + 无等值短路；改单源接管 + 5s 节拍 + 平滑补偿 | fixed | shell |
| BUG-031 | 已缓存播放仍卡顿 + 大量 raw 请求 + 组消息不成剧 —— raw 契约三缺陷(t 200/8MiB、MIME 硬编码、无 validator) + 两条投递路径分叉；抽 serve_local_file 统一 + 幂等成剧链路 | fixed | engine+shell |
| BUG-032 | 旧库 + 新代码 → 服务健康但媒体库全空 —— 建表批引用待补列致整批迁移失败，Store::open 失败又静默回落内存空库；移序 + 取消兜底改致命退出 | fixed | engine |
| BUG-033 | 倍速播放触发投递请求风暴（同一块数据反复重取、页面卡死）+ 倍速入口按钮小到点不到 —— 服务端灌数据速率远超解码器消费，改按「码率×6」背压节流（2x 冗余 63x→3x、传输量 ↓20.6x）；入口按钮 27×23→40×32 | fixed | engine+shell |
| BUG-034 | 播放「非常卡」+ 倍速失效 —— 排除投递/前端实现/元素重建/GPU 解码后，确证播放器对视频轨的两类**静默失败**（编码不可解时 `videoWidth=0` 且 `readyState=4`、`onError` 不触发；解码吞吐不足时仅表现为丢帧）完全无感知、不提示；新增 `lib/decodeHealth.ts` 健康度探测 + 双播放器提示。**注：本机测量环境有 ~40–43fps 呈现上限，2x 丢帧绝对值不可用于判断真实体感** | fixed | shell |
| BUG-035 | 播放器沿用原生 `controls`、播放时无分集列表 —— 按用户指定参照 EE 播放器（hls.js 双源）移植：剥离 HLS/清晰度/字幕/转码/雪碧图（orig-hub 无对应数据源），保留自绘控件条（进度·缓冲·拖拽 / 倍速 / PiP / 全屏 / 快捷键 / 自动连播倒计时）；新增分集侧栏，**后端与 API 零改动**（走既有 `GET /api/media/series/:id`）。移植中修掉两处缺陷：视频 `max-*` 只缩不放致缩在媒体区一角（480×270→1300×774）、侧栏条件带媒体类型致切到图片集后侧栏消失无法返回 | fixed | shell |
| BUG-036 | 剧集里图片被当成视频播 —— 播放序列未按媒体类型分流：混合剧集（实测 5 视频 + 3 图片）点视频时播放组为 `1/8`（含图片）、播完会自动连播到图片，图片在侧栏与视频同排版（`--:--`、带集号）、详情页图片分集标 `▶ 查看 / 播放`。修：`MediaViewer` 按 `modeOf(kind)` 派生当前组（点视频→只含视频、点图片→只含图片并卸载 video 与控件条），侧栏按类型区分呈现，`?? 'video'` 危险兜底改 `'file'`。验收 `verify_kind_split.cjs`（门禁 4h）22 项断言全通过 | fixed | shell |
| BUG-037 | 分批加入的内容裂成两个剧集且无法合并 —— 自动成剧幂等键是 TG 相册 `group_id`，分批缓存必然产生不同 `group_id`（实测库里 26/27 同名同理），跨相册归并**无可靠信号**故只能由用户表达意图。新增 `POST /api/media/series/:id/merge`（单事务：搬移 + 各季续编集号 + 删源剧集 + 标签并集 + 元数据仅在缺失时继承）+ 详情页「合并到…」两段式确认。**刻意不做内容级去重**：同名不同内容、同内容多源、`1-2` 与 `1,2` 并存、预告一律保留，只有「同一条目已在目标同季」跳过且**如实回报**；新增 `origin_series_title`/`origin_episode_no` 快照供重编后溯源。验收 `verify_series_merge.py`（22 项）+ `shot_merge_series.cjs` | fixed | engine+shell |
