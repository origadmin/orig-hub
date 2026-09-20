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
| BUG-038 | 监控频道内容在面板内永不更新 —— 消息流本地满页即不回网 + 面板对后台同步零消费；改进频道即同步 + 60s 轮询 + 「有 N 条新内容」提示条（点击才刷新，不拽滚动位置） | fixed | shell |
| BUG-039 | 媒体库无冲突模型：同集多缓存来源只能占假位置、合集视频（1-2 集）无法表达 —— 新增 `episode_no_end` 区间列（占用区间/下一可用位按终点计算）+ `media_episode_source` 备用源表（挂载/切主/摘除，单事务）+ caption 集号区间解析接入自动成剧；内容同一性不做自动判定（沿用 BUG-037 裁定） | fixed | engine+shell |
| BUG-040 | 窄窗口媒体库整体出界裁剪（无滚动条、右侧按钮全消失）—— flex 链缺 `min-w-0`/`flex-wrap`，min-content 钉死 670px；补面板/头部/工具栏三处 + <720px 隐藏头部封面 | fixed | shell |
| BUG-041 | 介绍无法显式清空 —— PATCH `null` 反序列化成「不改」；`description` 改 `Option<Option<String>>` 契约 + 前端空串发 null | fixed | engine+shell |
| BUG-042 | 筛选空态伪装成「资料库是空的 + 导入目录」—— 判据用筛选后 `total`；改库级 `stats.items` + 新增「无匹配/清除筛选」空态 | fixed | shell |
| BUG-043 | cache worker 对「已落盘但从未入库」条目静默跳过 —— 永远进不了媒体库；抽 `import_cached_file` 补导入 | fixed | engine |
| BUG-044 | 图片混入剧集（规则级）：「图片是浏览点，与视频无关，播放视频永远不能播到图片」无任何一层在守 —— 数据层触发器不变量（分集/备用源 kind 必须 video，含不存在条目）+ 启动修复迁移（摘除非视频分集、纯图剧清除）+ 自动成剧只取视频（纯图组不成剧，不再派生 album/collection）+ 手动入口 422 + 前端「加入剧集」禁用非视频选择；顺带修 mime 兜底 kind `image`→`photo`。验收 28/28 单测 + 实例 HTTP/截图 | fixed | engine+shell |
| BUG-045 | TG 内容标签未进入标签收集：收集只在「≥2 条成组」分支且只归档剧集，单条缓存标签整体丢失、剧集删除后成孤儿（实测 11 标签全 0 关联）—— 收集与成剧解耦（每次缓存都收集），无剧集时并集落到内容条目标签（`add_item_tags_by_name`，union 语义同剧集版） | fixed | engine |
| BUG-046 | 单视频气泡无「缓存」按钮（只靠海报 ⬇ 图标），图片却有显式按钮，逻辑倒置 —— meta 行按钮与图片同构：未缓存=缓存（缓存中禁用+「缓存中」）、已缓存=播放；海报点击行为不变 | fixed | shell |
| BUG-047 | 监控搜索框在第一栏单独一行且存在冗余单频道搜索框 —— 唯一搜索框上移到标题栏（标题与按钮之间），结果视图同一输入 autoFocus 不丢焦点，删 feedSearch 状态链与冗余行 | fixed | shell |
| BUG-048 | 混编相册（1 封面图+1 视频）不成剧 → 「缓存不入库」：BUG-044 门槛 `video_pairs>=2` 把 1 视频组一并杀掉 —— 门槛按组形态区分（相册组 ≥1 视频即成剧；无组多选 ≥2；纯图组不成剧但留日志），存量孤儿视频重放 4 组修复（series 59-62），修复后孤儿视频=0 | fixed | engine |
| BUG-049 | 图片不需要缓存 —— worker 对 photo 消息不再下载落盘，只入库为浏览条目（`file_path=NULL`，raw 现场代理 TG 缩略图）；前端图片气泡「加入媒体库/已入库」、纯图组按钮语义区分（缓存 vs 入库）；新增 by-ref 查询端点 | fixed | engine+shell |
| BUG-050 | 规则失联：需求模型未成文 → 逐轮补丁互相破坏（BUG-044 门槛杀掉 BUG-031 成剧、迁移摘图不重算 kind 残留「相集」徽标）—— 规则成文 `docs/MEDIA-RULES.md`（单一真源）+ 全规则对账 + 启动迁移补 kind 重算（真实库 11 剧全部回归 series） | fixed | engine |
| BUG-051 | 三模块边界失守（展示/缓存/媒体库互相侵入）—— 相册网格写死 aspect-square+object-contain 余白/瘸腿行、无标题与标签、状态四套真源；缓存挂 /api/tg/ 且 clear 名不副实、COALESCE 粘住旧路径、两条清理链非事务；多源仅剧集页有、1-2 区间侧栏/播放页取单点、播放页无分集导航；设计定稿 docs/MEDIA-DESIGN.md，按 P0–P4 实施（P0/P1 已落地） | partial | engine+shell |
| BUG-052 | 退役触发器未 DROP → 升级库上图片分集被拒、剧集建成却 0 分集（静默数据丢失）：`CREATE TRIGGER IF NOT EXISTS` 只防同名重复创建，不会让**另一个名字**的旧 `trg_media_episode_video_only_*` 失效 —— 单测全跑全新库故 34/34 全绿却测不出，真实库上「图片归档」能力 0 覆盖（10 剧无一 photo 分集）；修：迁移显式 DROP 旧触发器（播放源 `source_video_only` 保留）+ 成剧步骤内回滚空剧集（挂载失败/0 集不再伪装成功）+ 补「旧库→新代码」迁移单测。验收 35/35 单测 + 图片 e2e 13/13 + UI 10/10 + 回归 13/13、12/12 | fixed | engine+shell |
| BUG-053 | 解码提示是「只会置位的闩锁」→ 不论是否卡顿都常驻「解码吃力」：`setState('strained')` 之后无任何路径回到 `'ok'`，任何一次瞬时抖动（起播预热/拖动进度/改倍速）都把它永久钉住；且 `resetKey` 不含倍速 —— 提示建议「调低播放速度」而照做恰恰清不掉它（实测 1x 丢帧 0/486 也照样提示）。修：改成带迟滞的实时状态（`CALM_STREAK` 恢复撤销 + `WARMUP_MS` 预热静默期 + 事件重设基线 + 采样量下限 + 画面尺寸出现撤销 `unsupported`），并把倍速并入调用点 `resetKey`。验收 4 Phase（0 真实播放不误报／A 干净样本不误报／B 持续丢帧必报／C 丢帧停止必须撤销）+ 验牙（旧实现 Phase C 必败） | fixed | shell |
| BUG-054 | 条目没有「介绍位」→ 正文被塞进标题（剧集侧有 `description`、条目侧没有，同一份 caption 被切成两种形状，即「剧集对、视频错」）；剧集标题**完全没有**编辑路径、视频编辑入口 `opacity-0 group-hover` 不可发现；「清除缓存文件」错位挂在记录级缓存面板；缓存删除只有 `scope=all\|failed` 档位枚举、无勾选无确认。修：`media_item.description` 列 + 一次性回填迁移（`app_setting` 键收口，保守规则不覆盖已编辑值）+ `EpisodeView.item_description`（播放页与条目同源）；**空标题不可表达**（归一化保留旧值 + 路由 422）而介绍空值 = 显式清空；编辑入口常驻 + 介绍多行 `textarea` + 剧集改名 + 播放页 `requestEditItem(id)` 跨层联动；清磁盘动作归位设置页 TG 模块（带实时占用读数 + 确认）；`Store::delete_cache_tasks_by_ids` + `DELETE /api/cache/tasks?ids=`（非法/空选择一律 422）+ 勾选/全选/确认条。验收 42/42 单测 + e2e 19/19 + UI 真实渲染 44/44（含 `elementFromPoint` 验「常驻可见」、取消后占用逐字未变） | fixed | engine+shell |
| BUG-055 | Tauri 壳消费的 sidecar 副本从不随 `cargo build` 更新 → 用户启动的 app 跑旧引擎。`externalBin` 给的是不含三元组的 `.../release/orig-tg`，Tauri 运行期按平台追加成 `orig-tg-x86_64-pc-windows-msvc.exe`，而 `cargo build` 只写 `orig-tg.exe` —— **两个名字是两个文件**（实测副本旧 4 天、小 2.5MB，第 5–8 轮引擎修复全不在用户进程里）；验收脚本一律直拉 `orig-tg.exe` 故始终读新二进制 ⇒「开发者全绿 / 用户体感不变」被两份文件隔开。处置：`cp -f orig-tg.exe orig-tg-x86_64-pc-windows-msvc.exe`（daemon 同款）+ `md5sum` 对账，并写入 MEMORY 铁律 | fixed | build |
| BUG-056 | 剧集合并丢弃合集范围（`episode_no_end` 未随搬移）且槽位规则与批量追加不一致 → 1-2 合集合并后退化为单集、后继集号与合集区间撞位；多个「第1集」既不同槽多源也不如实回报 | open | engine |
| BUG-057 | 媒体库条目卡片无逐条删除入口 —— 删除只能退化成「大小为 1 的批量」，动作条又挂在选择态之下（未选中时界面上不存在删除） | fixed | shell |
| BUG-058 | 导航标签不保证单行 —— 计 0 未省略、长名未截断、计数无界；chip 内部折行，Sidebar 标签缺 `truncate` | in_progress | shell |
| BUG-059 | 设置页「清除缓存文件」直达全量清理、无范围选择 —— 字节侧缺「按集合清理」，任务记录侧已有 `?ids=` 与 `?scope=` 互斥契约而字节侧未跟进 | fixed | engine+shell |
| BUG-060 | 图片（分集）无归属建模 —— 剧集图册只有一条平铺行，合并后不同视频的图片混在一起；`media_message.group_id` 未透传到媒体库模型 | open | engine+shell |
| BUG-061 | 引擎产物四处副本而 `cargo build` 只更新一处 —— `tauri-shell/src-tauri/target/{debug,release}/orig-tg.exe` 冻结在 09-16，用户进程跑旧引擎（条目介绍写不进、剧集正常即其表现）；构建无同步亦无陈旧检测 | fixed | build |
| BUG-062 | TG 提交验证码缺 `phone` 字段被 422 拒绝（恢复自提交 `88f6a10`，事后追认） | fixed | shell |
| BUG-063 | 代理自检误报「不可达」—— 走本地 DNS 与默认 TLS 栈，改 rustls + socks5h 远端 DNS（恢复自提交 `049de71`） | fixed | engine |
| BUG-064 | Vite dev server 未监听 0.0.0.0 致 Tauri webview 连接被拒（恢复自提交 `38abc59`） | fixed | shell |
| BUG-065 | TG 页签可见性由插件开关驱动而非绑定态（恢复自提交 `f979b19`，反向校准见 `f31295a`） | fixed | shell |
| BUG-066 | 媒体覆盖层不可 Esc 关闭 + 状态 chip 与按钮样式不统一（恢复自提交 `0921056`） | fixed | shell |
| BUG-067 | 缺陷登记与修复提交互不追溯且无门禁 —— 22 条 fix 中 19 条无编号、索引行不指向提交、fixed 无证据校验、门禁脚本可悬空缺失 | fixed | docs |
| BUG-068 | 媒体库左栏标签：计数 0 仍渲染（28 个标签里 10 个 0/0 孤儿 —— 删条目只清关联表、不 GC `media_tag` 行）+ chip 无 `truncate`/`max-w`/`whitespace-nowrap` 长名折行 + 内容侧计数`itemCount+seriesCount` 而筛选只匹配条目（显示 8、点开 6）。修：每侧只算该侧计数；计数 0 不渲染（唯一例外 = 当前选中项，否则选中态消失且无取消入口）；chip 单行原语 `whitespace-nowrap` + 名称`min-w-0 truncate` + 计数 `shrink-0 tabular-nums` + `max-w-full`；**隐藏 ≠ 删除**（数据层原样保留）。验收 18/18：33 字超长名 + 计数 1 时 chip 高 21.8px 单行、名称截断生效、计数未被压掉；计数 94 未被裁切；点 chip 得到的卡片数 = 显示的数；10 个孤儿在 DOM 中零出现而数据层仍在 | fixed | shell |
| BUG-069 | 「剧集里的视频」文案与视频**不同源** —— `media_episode` 自带 `title`/`description` 构成第二套真源（实测分集介绍非空 1/45 行、条目介绍非空 7/110 行，两条写路径已漂移，即「内容剧集和视频天差地远」）；分集编辑面板**没有标题字段** ⇒ 剧集路径下标题根本不可改。修：分集只是**位置**，文案唯一真源 = 条目 —— `EpisodeView` 删 `itemTitle`/`itemDescription`、`title`/`description` 直接来自 `media_item`，`update_episode` **写穿**到条目，`add_episode`/`merge_series` 不再写分集列；一次性迁移 `collapse_episode_text` 只搬介绍**不搬标题**（条目 title 是 NOT NULL 必有值，分集标题只是无权威的快照）；前端分集面板补标题输入框 + 空标题前端即拦。验收 15/15 契约 + 18/18 UI + 50/50 单测（新增 4 项） | fixed | engine+shell |
| BUG-070 | 播放页**不是只读的**（`viewer.editable` 驱动的编辑按钮 —— 只读是一次性 props 判断而非结构约束）+ 右侧分集行尾部一个**无 `onClick` 的装饰性 `<Play>` 图标**（长得像按钮却点了没反应）+ 同一部剧集被**三个消费者各拉一次**（openSeries / playItems / useSeriesDetail，StrictMode 再翻倍，实测 5 次）。修：删 `viewer.editable`/`editItemId`/`requestEditItem` 让「播放页可写」**不可表达**；去掉装饰图标；新增 `lib/fetchCache.ts` 会话内共享 Promise（并发合流，**不做时间过期**、写操作后显式 `invalidateCache()`）。验收：播放页按钮集合无任何编辑入口、右侧行内 svg=0、按阶段请求计数 A-open=1 / B-play=0 / C-refresh=1。**两条首轮失败系探针自身缺陷**（扫了播放器**背后**仍在 DOM 的媒体库面板；把 CORS 预检计入真实请求），已改为作用域锚 `[data-testid="media-viewer"]` + 排除 `preflight` | fixed | shell |
| BUG-071 | 默认下载目录在 Windows 下解析出 `~`/依赖 `$HOME`，路径不可靠 | open | engine |
| BUG-072 | 网页调试模式下「浏览…」选择目录报错（invoke undefined）—— 纯浏览器无 Tauri 运行时，`@tauri-apps/plugin-dialog` 的 `invoke` 为 undefined 抛 `Cannot read properties of undefined (reading 'invoke')`；抽共享 `isTauri()`（`src/lib/env.ts`），`DirectoryPicker.pick` 与按钮在网页模式软失败+禁用+提示，手动输入与历史下拉仍可用 | fixed | shell |
| BUG-073 | 自动分类落盘键/展示名未解耦（手动添加仅名称+类型，无独立磁盘键） | wontfix | engine+shell |
| BUG-074 | 网页调试态 orig-tg 离线短路未真正生效（跑的是旧 sidecar 副本，diag 仍 `api_mode:dummy`）+ 离线在 UI 被渲染成红色错误（toast / 红框）。修：重建+同步四副本+`restart_tg.py` 离线重启（diag `mode:unavailable`）；`refreshTgSession` 后台探测失败不再弹红 toast；`TgPanel` 离线态渲染中性「调试模式」面板；状态端点返 200（数据端点仍 503，BUG-023 不矛盾）。验收 `verify_debug_offline.py` 7/7 | fixed | engine+shell |
| BUG-075 | `/src/**.tsx?t=...` 直连 .tsx 请求 —— Vite dev server 按需转译 + HMR 缓存穿透（`vite.config.ts` port 5180），**非缺陷** | wontfix | shell |
| BUG-076 | 剧集分集标题编辑另起一行 + 编辑态沿用 `truncate` 致长标题存错内容。修：标题输入移入**分集行内**同一槽位，改 `textarea`（`rows=2` + `[overflow-wrap:anywhere]`）自动换行、**编辑态零截断**；只读态保留 `truncate` 并补 `title` 悬浮全文 | fixed | shell |
| BUG-077 | 缓存是否应与下载结合 —— 结论：**部分能，只统一视图不统一引擎/存储**。统一任务列表/进度 UI 可行且代价低（daemon 只读聚合 + 统一 `TaskView`）；落盘目录**已事实统一**但清理必须分开；**缓存复用下载引擎不可行**（MTProto chunk 对齐 + FloodWait/DC 迁移，且 orig-tg 已自建 K 路并行分片）。最小方案 = daemon 新增 `activity.rs` 只读聚合 + `GET /api/activity`，控制仍分流（**已实施**，见 BUG-077 修复节）。强行统一会破坏清理/断点/产物所有权语义 | fixed | engine+shell |
| BUG-078 | 缓存任务「重试」新建一条任务 +「删除」确认框出现在面板顶部而非当前任务下。修：新增 `Store::retry_cache_task(id)`（只复位终态、复用同一 id）+ `POST /api/cache/tasks/:id/retry`；前端改调 `retryCacheTask`；`confirm` 升为 `{kind:'one'|'batch', id?}`，单条内联到该任务行 | fixed | engine+shell |
| BUG-079 | 缓存字节：频道 chip `truncate` 截名致同名难辨 +「预计释放」显示全量而非选中量。修：新增 `tg.bytesSelected` 由**选中集合**求和即时反馈（`cache-bytes-selected-preview`）；chip 改 `whitespace-nowrap` 不截名 | fixed | shell |
| BUG-080 | 缓存清理后媒体库条目仍在且外观如常，但 `file_path=NULL` → `/api/media/items/:id/raw` 返回 404，点了播不了且无提示。修：`EpisodeView.has_bytes`（`file_path IS NOT NULL`，**不新增列**）+ `hasMediaBytes()` 唯一判据入口；无字节时占位、不给播放按钮，TG 源给「重新缓存」、非 TG 标「文件已丢失」。**关键例外：TG 图片不落盘（BUG-049），`file_path` 空 ≠ 丢失，判据优先级必须把 `source=tg && kind=photo` 排在最前** | fixed | engine+shell |
| BUG-081 | 「清理入口在本面板的『缓存字节』页签」提示在**本页签自己也显示**（自指）。修：仅 `view !== 'bytes'` 时渲染（`cache-purge-hint`） | fixed | shell |
| BUG-082 | 左侧 Navi 缺「下载中/已完成」—— 被 `DOWNLOAD_MODULE_HIDDEN` 开关整体隐藏（`Sidebar.tsx:30`），且**无替代筛选入口**。评估（已推翻旧结论）：**APP 核心是下载工具**，缺的是**下载队列**状态筛选，与 TG 无关；三档不够，引擎七态中 `paused`/`error`/`cancelled` 无归宿，建议定档五档（全部/下载中/已暂停/已完成/失败·已取消）；状态与分类应改为正交下钻而非同级互斥。待拍板 3 项（①已定案五档） | fixed | shell |
| BUG-083 | 顶部下载工具栏仅 `isDownloadView` 下渲染，媒体库/TG 下整行空白（`<header>` 常驻定高，**布局不跳动，无需额外占位**）。评估：媒体库/TG **不显示**下载按钮（按钮语义指向 daemon 队列，而媒体库条目与 TG 缓存任务都不是其对象，常显会误导）。建议把该栏改为「上下文栏」：低改本放视图标题+全局态，中成本把内容区工具条上行合并。待拍板：工具条上行还是留在内容区 | fixed | shell |
| BUG-084 | 提交信息混入 CR（CRLF）：同内容提交哈希不同（`206ee70` vs `645d2c7` 同 tree 仅差结尾行尾）、后代哈希全变，78 条里 76 条 message 含 CR。修：门禁加 CR 检测——`check-commit-msgs.py` 按字节取 `%B` + 生效点基线（历史欠账只告警、新增阻断）+ `--self-test`，`commit-msg` 钩子用字面 CR + `grep -U`；AGENTS.md §2/§7 同步。存量 76 条待重写，见待拍板 | fixed | build |
| BUG-085 | BUG-077 的 `/api/activity` 轮询打到 TG 全量端点 `/api/tg/cache/tasks/all`，该端点**每次两次 SQLite**（`list_cache_tasks` + `count_cache_tasks`，`orig-tg/src/routes.rs:986-1005`），其中 `counts` daemon 侧**根本不消费**（`activity.rs:157-161`）。根因是 TG 缺「内存快照版全量端点」——内存端点契约只返回一条（单飞），而 `is_in_transit` 需含 failed/interrupted 的全量。已在 `activity.rs:305` 留 §5 豁免注释。待拍板：(a) TG 新增内存全量端点（建议）/ (b) `?counts=0` 止血 / (c) 维持 | open | engine |
| BUG-086 | UI 验收通道自身不可执行 —— `tauri-shell/verify/` 6 个 `shot_*.cjs` 均 `require('playwright')` 而 `package.json` 未声明该依赖（`node_modules/playwright*` 不存在），任何机器首跑即 `MODULE_NOT_FOUND` 崩溃，产出「验证失败」假象；次生为 `node_modules` 残缺缺 `@babel/core`（`@vitejs/plugin-react` 依赖）致白屏而 dev server 仍返 200。修：6 脚本改 try/catch 优雅降级（exit 2 + 中文提示，不删改业务逻辑）+ 新增零依赖 CDP 驱动 `verify/lib/cdp.cjs`（Node 内置 WebSocket）+ 真实渲染验收 `verify_ui_render.cjs`（20/20 PASS）+ `npm run verify:ui` + `verify/README.md` | fixed | shell |
| BUG-087 | 连接态指示三处各写各的 —— 上下文栏读 store，底部状态栏硬编码「daemon 已连接」+恒绿点（`MainLayout.tsx:283-284`）、侧栏底部硬编码「daemon 运行中」+恒绿点（`Sidebar.tsx:349-354`），同屏出现「一个说未连接、两个说已连接」。修：抽唯一规范来源 `store/connState.ts`（`resolveConnState` + `CONN_DOT` + `CONN_LABEL` + `useConnState`），三处同读并各带 `data-conn-state` | fixed | shell |
| BUG-088 | 「传输中」面板把后端原始 HTTP 报文直渲染进正文（`ActivityPanel.tsx:236-240` 原样出 `failed` 字符串，实测正文显示「404 Not Found」），且错误态下仍按退避反复请求同一必然失败的端点。修：失败只存分类 `failKind`（4xx/5xx→`unavailable`）绝不直出报文 + 中文降级文案 + 「重新加载」可行动出口 + 空态兜底 + `MAX_FAILS=4` 熔断停轮询；`activity.sourceDown` 的 `{reason}` 同源降级 | fixed | shell |
| BUG-089 | 分类下钻时「全部文件」行不点亮 —— `Sidebar.tsx:150` 的 `allActive` 额外要求 `categoryFilter === null`，点「视频」后标题已是「全部文件 · 视频」而顶行无 `bg-accent/15`。修：`allActive = view === 'all'`，下钻时顶行保持面包屑态点亮 | fixed | shell |
| BUG-091 | `tg_start` 只看 `tg_child` 子进程句柄不探端口 —— 9877 实跑（`/health` 200）时 `/api/config` 仍回 `tg_running:false`，此刻点「启动 TG」会 spawn 第二个 orig-tg（bind 失败/双进程）。修：`tg_is_running` 改为「托管句柄 + 127.0.0.1:TG_PORT TCP 探测」双路径，端口被占则不 spawn 且如实回 true | fixed | engine |
| BUG-092 | `/api/interfaces` 单次约 1s 阻塞（`list_all_adapters` 同步 `GetAdaptersAddresses`），而新建下载弹窗一打开就拉它 → 弹窗开合卡顿。修：30s TTL 内存缓存 + 重算丢 `spawn_blocking` + `?refresh=1` 手动失效；实测第二次起 4-8ms | fixed | engine |
| BUG-093 | 侧栏 Telegram 导航项消失 —— `Sidebar.tsx:316` 门控依赖 `tgBound`，而 9877 上跑着 PID 22956（2026-09-20 16:23 启动，被 `verify_shots/restart_tg.py:33-34` 以 `ORIG_TG_OFFLINE=1` 拉起），`offline_short_circuit()`(`orig-tg/src/main.rs:119-133`) 跳过 MTProto → `phase:"Anonymous"` → `nav-tg` 被过滤（实测只剩 7 项）。门控本身由 `06e7a8e` 引入、非本轮回退。修：停残留实例后以 `ORIG_TG_ONLINE=1` 重新托管拉起；实测 `phase:"Authorized"`、`user_id:523058983`，浏览器实测 `nav-tg` 回归（8 项） | fixed | shell |
| BUG-094 | daemon 拉起 orig-tg 用错数据目录且拿不到凭据 —— `tg_data_dir()`(`state.rs:186-215`) 返回 `%LOCALAPPDATA%\OrigHub`，而真实已登录会话与凭据在 `%APPDATA%\com.origadmin.orighub\tg\`（`session.session` 65536B / `config.json` 含 api_id+api_hash+proxy）；且三处 `download-engine.toml` 均无 `[tg]` 段 → `tg_api_id/hash` 恒 `None`（`config.rs:94-96`），`state.rs:163-172` 不注入。冷启动必然掉登录态。BUG-093 的旁路脚本一直在掩盖本条。修：壳 `spawn_daemon()` 注入 `ORIG_TG_DATA=app_data_dir()`（父目录）+ daemon `resolve_tg_env()` 回退读 `tg/config.json` 凭据 + `setup` 补一次 `ensure_tg()` 破自救死循环；待端到端验收 | in_progress | engine |
| BUG-090 | 浏览器开发模式下连接态恒 offline —— `ensureDaemon()`/`daemonStatus()` 是 Tauri Rust 命令，无宿主时 `invoke` reject 被 `.catch(() => {})` 静默吞掉，`daemon` 恒 null → 三处一致显示「daemon 未连接」，而 `/health`、`/api/downloads` 实测均 200（指示器说谎）。修：启动期一次性 `GET /health` 兜底播种 alive（失败不再吞）+ 新增 `setDaemonAlive`：SSE onOpen / 既有 `refresh()` 成功→alive，失败→不 alive，复用既有请求信号、零新增轮询 | fixed | shell |

## 历史欠账

登记册建立之前的修复提交（19 条 `fix` 无 `BUG-<编号>`）在 `docs/bugs/ARCHIVE-pre-registry.md`
逐条对账：12 条映射回已登记 BUG，5 条正式立档（BUG-062~066），2 条判定为非缺陷/迁移前遗留。

## 门禁

```sh
python scripts/check-bugs.py     # 编号连续 / 索引双向一致 / 字段枚举 / 证据可核
bash scripts/install-hooks.sh    # 安装 pre-commit 与 commit-msg（钩子不入库）
```

`fix` 类提交必须引用 `BUG-<编号>`，否则 `commit-msg` 拒绝 —— 让「绕过登记直接修」不可表达。
