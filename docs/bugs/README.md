# 缺陷追踪（索引）

本文件是缺陷**索引表**。登记规格（标准档／轻量档）、索引行规格、门禁行为、建档要点
一律见 `docs/rules/bug-registry.md` —— 那些内容只在新建／修改登记时需要，不随索引常驻。

速览：每缺陷一个 `BUG-<编号>.md`，编号自 1 起自增；状态机
`open → in_progress → fixed / wontfix → closed`；`fixed` 必须带 `## 验收证据`
（含至少一条跨机器可核验的引用）；`fix` 类提交必须引用 `BUG-<编号>`。

## 进行中 / 待办

| 编号 | 标题 | 状态 | 模块 |
|---|---|---|---|
| BUG-051 | BUG-051 三模块边界失守：展示/缓存/媒体库互相侵入（设计已定稿，P0–P4 实施） | partial | engine+shell |
| BUG-060 | 图片（分集）没有归属建模，剧集图册只能在一条平铺行里浏览 | open | engine+shell |
| BUG-085 | TG 全量缓存任务端点被轮询时读 SQLite，且每次多算一条无用 count | partial | engine |
| BUG-095 | TG 开关无状态建模（不可用/关闭/开启/连接异常）+ 代理恢复后无重试或重启插件机制 | open | engine+shell |
| BUG-098 | TG 入库流水线 → 媒体库端到端流程：媒体库无资产生命周期状态，来源不可跳转、清理不可分层 | open | engine+shell |
| BUG-099 | TG 消息流内容 `#标签` 不高亮、不支持频道内筛选 | open | engine+shell |
| BUG-101 | 监控列表折叠控件不可辨识且与标题耦合 + 「立即同步」按钮语义冗余 | open | engine+shell |
| BUG-102 | 增量同步有三个并发触发源而 `sync_once` 全程无单飞（RPC 预算叠加） | open | engine+shell |
| BUG-113 | 单集多视频**缺「质量」与「主版本」语义** —— 多源结构其实**已经存在**（`media_episode_source`，BUG-039），attach / switch-primary / detach 三个 API 与前端同名函数都在。真正的缺口四条：无质量字段（只有 `size/width/height`，无码率、无 `quality`）；主源仍是**隐式**的 `media_episode.item_id`（无 `is_primary` 列）；备用源按 `created_at ASC` 排序 → **先来的是主**，与质量无关；UI 只有一个「N 源」按钮**盲目把 `sources[0]` 提为主**（`SeriesDetail.tsx:692-709`），用户看不到质量差异也无从选择。**更正**：评审文档 `media-tg-review-2026-09-22.md` 第 20/67-69/204-209 行断言「单集多视频在数据模型上不可能」**是错的** —— 只看了 `episode.item_id` 是 1:1，忽略了已存在的 `media_episode_source`。改造须守住：BUG-044 触发器（备用源只收 video）、`item_id` 全表 UNIQUE、建表批只许新旧库共有列（BUG-032） | open | engine+shell |
| BUG-114 | 在线流零背压 —— `media_file()` 直透下载流，未缓存内容播放卡顿 | open | engine |
| BUG-116 | 入库与落盘行为不一致 —— 4 条图片入库后没有本地字节 | open | engine |
| BUG-117 | 图片的「大图」实际是 Telegram 缩略图，且内容域越界调用传输域 | open | engine |
| BUG-118 | 封面与内容同级 —— `poster` 与 `file_path` 并列，生命周期无法定义 | open | engine |
| BUG-119 | 图片没有归属层级 —— 只能挂在剧集上，无法表达「某一集下某个视频的图片」 | open | engine |
| BUG-120 | 「编辑」与「改名」割裂 —— 实现视角的拆分，改标题要找两个地方 | open | shell |
| BUG-122 | 没有转码 / remux，也没有可播性探测 —— 部分容器下完也播不了（实测 27.6%） | open | engine |
| BUG-125 | 媒体库面板的「占用」是元数据之和，不是磁盘占用 | open | engine+shell |
| BUG-130 | **合集（一个视频含多集）缺时间偏移，且与「单集多源」无法共存** —— 用户 2026-09-22 指出 D1（同集多源归并）隐含了「1 个条目 = 1 集」的假设，对合集不成立。**先说清现状，避免误判成「完全不支持」**：合集链路**是通的** —— `parse_episode_range`（`media.rs:2951`）能解析 `EP01-02`/`第3~4集`/`10-20集合集`，`ranged_items`（`routes.rs:2158`，读 **TG 消息 caption**）已接在自动成剧上，`media_episode.episode_no_end` 存储，占用快照按 `COALESCE(episode_no_end, episode_no)` 展开（注释写明「合集不会被打成单集」），UI 也渲染 `S1E1-2`。**但从未被真实数据走过**：库里 43 个分集**带区间 = 0**，标题含区间的两条（item 355/356）**根本不在任何剧集里** ⇒ 整条链路「通了但空转」，只在单测里走过。**两处真缺口**：① **播放无时间偏移**（全仓零命中 `start_sec`/offset）—— 点合集就是**从头播整个文件**，进度条时间轴是整个文件，想看第 4 集只能手动拖；② **合集与「单独的第 4 集文件」无法共存为多源** —— 合集占着 3、4 槽位，单独的 EP4 会被推到**第 5 集**，而按用户拍板它本该是「第 4 集的另一个源」；更麻烦的是**模型里没有「第 4 集」这一行可挂**（合集是一行 `E3-4`），要支持得展开成 N 行或引入「段」层，且需放宽 `media_episode_source.item_id` 全表 UNIQUE（BUG-039 不变量）。**关键未知：时间区间从哪来** —— 章节元数据最自然但本仓无探测能力（BUG-122 实测无 ffmpeg），手动标注一定能做但要逐条标，按时长等分不可靠；**在拿到时间区间前两条缺口都无法真修**，只能把语义做诚实。取证纪律：我用 `grep` 接 `head` 得出「无生产调用点」是**错的**（`head` 截断 10 行截掉了 `routes.rs:2169`）——**存在性判断不能用 `head`** | open | engine+shell |
| BUG-133 | 媒体库「占用空间」展示登记值——清缓存后数字不变，答不出磁盘真值 | open | engine+shell |
| BUG-139 | 「打开已下载」= 系统默认播放器、「预览」= 内置播放器——同一「打开」动词两种行为 | open | shell |
| BUG-141 | i18n 硬编码中文文案 253 行分布 25 文件——en-US 界面混中文（BUG-128 同病新实例） | open | shell |
| BUG-142 | i18n 孤儿 key 42 个——历史收敛的文案残骸误导维护 | open | shell |
| BUG-158 | 所有 git 钩子在本仓**恒不生效** —— 外层 `core.hooksPath=NUL` 把钩子目录指向不存在的路径，且 `install-hooks.sh` 与 BUG-157 同因装错仓 | open | build |
| BUG-172 | 媒体库被错误部署在 TG 进程内——一个来源插件的生死决定了一等公民功能的可用性 | open | engine |
| BUG-173 | 共享 `store.db` 拆分的前置阻塞——5 处跨域耦合不先改造，拆库即制造数据损伤 | open | engine |
| BUG-174 | 无 BitTorrent 支持——协议抽象层已预留（`SourceKind::Bittorrent` / `DHT` / `PINNING` 全部未实现），但入口与任务模型未就绪… | open | engine |
| BUG-176 | 媒体库整页依赖 TG 服务进程 —— TG 不可达时库「整页失明」，且界面无法区分「没有内容」与「取不到内容」 | open | shell |
| BUG-187 | BUG-187 本地 pre-commit 只跑污染门禁：安装路径写死旧内容，缺陷登记门禁在本地静默不执行 | open | build |
| BUG-190 | `media_item.kind` 可被三条生产路径改写，而挂载表不变量只在 INSERT 侧守护 | open | engine |
| BUG-192 | BUG-192 Telegram 置顶（pinned）频道在应用频道列表里既排不到前面、也认不出来 | open | engine+shell |
| BUG-194 | BUG-194 会话缓存里 156 条 title 为空串：列表渲染成认不出的空白行 | open | engine+shell |
| BUG-218 | 4x 倍速控件层可见期（前约 3 秒）上屏节拍劣化 —— BUG-217 残余 | open | shell |
| BUG-219 | 播放读量爆炸 + 卡顿：no-store 误改把 6× 预读冗余放大到服务端（orig-tg /raw） | in_progress | engine |
| BUG-220 | 入库流水线只显示频道不显示内容，无法知道入库的是什么 | open | shell |
| BUG-222 | 回收临时文件页签选择模型混乱：分档按钮静默丢弃「按频道选定」，且单频道时频道选择整块消失 | open | shell |
| BUG-228 | 外部实例占用端口 + link 断 ⇒ tg_reselect_port 每次重启把端口迁走，形成端口漂移风暴、前端跟着配置来回跳 | open | engine |
| BUG-234 | 下载目录修改完全无效——设置只写 localStorage，引擎无运行时更新链路 | open | engine+shell |
| BUG-235 | 库根目录与下载路径/子目录分类体系脱节——两个互不相干的真实目录树 | open | engine+shell |
| BUG-236 | 语言设置仅中英两个语种，i18n 无语种扩展设计 | open | shell |
| BUG-237 | ffmpeg 设置未实现——引擎有解析链、壳层零呈现，参考项目未分析 | open | engine+shell |
| BUG-238 | 插件化管理框架缺失——TG 开关是孤例，ffmpeg/外置播放器/未来功能无统一模型 | open | engine+shell |
| BUG-240 | 媒体库「大量重复数据」实为不可辨识条目 —— 86/320 条空标题 + 80/320 条无字节，卡片外形一致；**不是**重复行、**不是**重复渲染 | open | engine+shell |
| BUG-241 | TG 面板进入频道即请求爆炸 —— by-ref 逐条 N+1 + 每瓦片一缩略图 + GET 带 `Content-Type` 触发 CORS 预检翻倍；实测 4s 内 90 请求、峰值 78 req/s | partial | shell |
| BUG-248 | 入库顺序倒置——「先入信息、再入字节」未兑现：入队只写任务行，媒体库条目要等 worker 轮到才登记 | open | engine |
| BUG-249 | 入库流水线缺少批量合规操作——大量失败无法批量重试，不合规/残留文件无法批量清理 | open | engine+shell |
| BUG-250 | 媒体库主页在「无字节/无图」时仍发起 raw 请求（video 必 404），且主页不体现内容存在性 | open | engine+shell |
| BUG-259 | 标签编辑入口分散在 5 处、其中 2 处对同一件事等价；标签在数据库/接口/渲染三层都没有任何数量与长度上限，全量渲染无虚拟化，规模上千后单次刷新退化到秒级 | open | engine+shell |
| BUG-262 | 剧集内页没有「整季开播」入口 —— 左栏零播放入口、封面不可点、唯一入口是右栏逐集 ▶；而新增左栏入口与右栏 ▶ 会构成「同一命令的两个主按钮」 | open | shell |
| BUG-264 | 标题携带频道装饰与下载器内部名 —— 8 类污染命中 373 条目中的 156 条（41.8%），而三处编辑入口只做 trim、无任何自动清理 | open | engine+shell |
| BUG-266 | 播放器没有「显示 / 隐藏控件」的常驻入口 —— 控件自动隐藏后整层被移出 DOM，只能靠「在画面上移动指针」叫回 | open | shell |
| BUG-267 | 「视频入口出现图片」—— 图片可成为剧集分集（第 4 轮裁定）与 BUG-044 原始裁定冲突，且落地文档至今相反 | open | engine+shell |
| BUG-268 | 续播（播放进度记忆）—— 全仓无进度存储，属**新能力立项**（非缺陷），用户已点头 | open | engine+shell |
| BUG-269 | 按钮外观割裂 —— 同一语义在不同页面得到「有背景 / 有边框」与「无背景 / 无边框」两种形态 | open | shell |
| BUG-270 | 本集图组**无条件堆叠** —— 用户原裁定是「超出显示才用跑马灯」，实现把前提条件整个漏掉；且堆叠态**没有跑马**（只有逐次点击翻页） | open | shell |
| BUG-272 | 剧集「年份」全库 46/46 为空 —— 字段**没有来源、没有默认、也没有定义语义**（发行年还是收录年？），新增与编辑两端都初始化为空 | open | engine+shell |
| BUG-273 | 播放卡顿（再报）：段级「读写入」串行只存在于**转码代理的增长 `.part`**… | open | engine |
| BUG-274 | 每次新的缓存写入时卡顿一下 —— 缓存记账与播放读**共用一条 SQLite 连接**，且库处于 rollback journal 模式（每次提交都独占 + fsync） | open | engine |
| BUG-276 | 单条目墙钟是**进程内 per-attempt 计时**，orig-tg 重启即清零 ⇒ 慢条目永不判失败、队首被无限占住（实测同一任务占队首 21 小时） | open | engine |
| BUG-278 | `media_item_stream` 把 `proxy_dir` 当成 `tg_data_dir` 传给 ffmpeg 解析链 —— 文档承诺的「`<TG数据目录>/bin/`」落点实为 `proxies/bin/`（死路） | open | engine |
| BUG-279 | 媒体库「未缓存」条目与入库队列任务**无关系联动** —— 看不到它到底在不在队列、是不是失败、还是压根没状态 | open | engine+shell |
| BUG-282 | 后端未启动时前端持续发失败请求 + 资源占用爆炸（无失败退避、无熔断、无请求取消） | open | shell |
| BUG-283 | 存量剧集标题退化成占位名 `TG <chat_id> · <日期>` 且无「按 source_key 重算」通道 —— 同频道多个剧集不可分辨，破坏剧集管理与文件管理 | open | engine |
| BUG-284 | 剧集合并把「同一集的内容」续编成新集号，而非按槽位归并为多源 —— 两条第 1 集合并后变成第 1、2 集，「一集多源」在合并场景永远不可达 | partial | engine+shell |
| BUG-287 | 网页模式（非 Tauri 运行时）下「选择目录」能力缺失 —— BUG-072 只消除了报错（改禁用），未解决可用性；「两模式都要支持」目标下需网页可用的目录选择方案 | open | shell |
| BUG-288 | `/stream` 兼容流「单飞表条目泄漏」—— 一次异常终止的转码会把该变体**永久**钉死在 503（重启 orig-tg 才解） | open | engine |
| BUG-289 | 倍速播放「上屏节拍抖动」与倍速**非单调** —— 3x/4x 稳态即一顿一顿，已排除供数与解码，机制指向「呈现节奏 vs 刷新率」（**未定论**） | open | shell |
| BUG-290 | FRC 变体转码**并发无上限** —— 用户在转码窗口内多点几个倍速即在后台堆起 N 路 ffmpeg，期间 CPU 打满拖慢一切播放 | open | engine |
| BUG-292 | 同一相册被建成**两个剧集**（正常标题 + 占位名标题各一个），同一个 `media_item` 被两条 `media_episode` 同时认领 —— 媒体库同一片子出现两次、文件挂双份 | open | engine |
| BUG-294 | 入库任务**没有逐条状态** —— `done` 是计数器而非事实、`interrupted` 不记「哪几条已完成」、重试把 `done` 归零 ⇒ 任务内的「后续 N 个」是未知黑盒，无法管控、无法补档 | open | engine+shell |
| BUG-295 | 「下载中」任务**找不到** —— `interrupted` 不在「活跃」概念里因而不置顶，116 行扁平列表无分区；且重启会把「下载中」**静默变成「已中断」**（实测复现） | open | engine+shell |
| BUG-296 | 条目已登记但**未编入剧集**（`media_item` 有行、`media_episode` 无槽位）⇒ 媒体库剧集视图查不到、任务不告知、无补档入口 —— 「命名 10 个、入了 2 个、说完成了」的真正机制 | open | engine+shell |
| BUG-297 | 条目（`media_item`）**不承载自己的定位** —— 入库按组、组 id 在手… | open | engine |
| BUG-298 | 前端信息架构失配——一级导航三项（全/TG/设置）与「文件 = 媒体库」的旧心智不符，下载与文件共用一张任务表、无树状分组（模块重整 M0） | in_progress | shell |
| BUG-299 | 文件域只认媒体库——HTTP 下载完成、导入完成与 TG 缓存完成三类成品不自动进入文件域，且成品浏览器不含非媒体文件与无字节「在线」条目（模块重整 M2） | open | engine+shell |
| BUG-300 | 下载页不是全局任务监控——daemon `/api/activity` 五铁律俱备而前端零消费，来源遍历写死引擎+TG，无控制代理，TG 运行行渲染假暂停按钮（模块重整 M3） | in_progress | engine+shell |
| BUG-301 | TG 面板三级钻取过深且账号控件混在工作区——「文件夹→频道→消息」栈式导航易迷路，多文件夹时文件夹行挤成两行，账号 CRUD 与频道监控点击区相邻易误触（模块重整 M4） | open | shell |
| BUG-302 | ffmpeg 不可诊断不可设置——路径/版本/能力无观测面，硬解选择无持久化，缺失时调起转码直出 5xx 而非可行动文案，无受管安装（模块重整 M5） | open | engine+shell |
| BUG-303 | 无局域网只读共享——库内容无法在局域网内安全只读浏览，daemon 无可选独立绑定面，无令牌鉴权与限速证明（模块重整 M6） | open | engine+shell |
| BUG-307 | 撤回「视频/剧集」合并，恢复两者为独立入口；修复标签筛选样式 | in_progress | shell |
| BUG-308 | 入库去重窗口只覆盖活跃任务——任务结束后同一 TG 消息可重复入队（重复下载字节 + 重复入库索引） | open | engine |
| BUG-312 | 下载页「清空历史」将误删 TG 入库记录（前瞻风险：M3 来源合并后逐条 DELETE 不区分来源） | open | shell |
| BUG-316 | 所有页面访问卡顿——前端侧卡顿，根因未定（请求设计/渲染逻辑/dev 未打包三嫌疑并列） | open | shell |
| BUG-317 | 页面设计无统一标准——下载页为标准样式（顶部标题/主按钮/次级信息/三级筛选），大部分页面违反，需重新制定与全站收敛 | open | shell |
| BUG-331 | 验收跑范围外 bug——「只验收当前 BUG」无对照表、无工具裁剪，范围外回归混入本回合结论 | open | docs |
| BUG-332 | 路径显示用正斜杠——Windows 下应显示 `\`，存储妥协（BUG-234 写正斜杠）原样漏给用户 | open | shell |
| BUG-333 | 下载设置三概念主次不明——受管目录/库根目录/默认下载目录平铺并列，用户分不清该改哪个 | open | shell |
| BUG-334 | 文件管理内容混乱——内部库条目流出到成品列表、非受管/无字节条目被显示 | open | shell |
| BUG-335 | 设置保存模式不清楚——同一页两套提交语义（即时 vs 显式保存）并存且无标识，底部保存键管什么不可见 | open | shell |
| BUG-336 | 调试日志路径分隔符混用——同一条路径里 `/` 与 `\` 并存（ORIG_TG_DATA 原样入 PathBuf，join 后混用，原样下发原样展示） | open | engine+shell |
| BUG-337 | 设置「通用」区块命名两套文案、默认优先级倒挂——点进去是「常规设置」，且「通用」高居「下载」之上 | open | shell |
| BUG-339 | 时序用例 `wall_clock_accumulates_across_restarts_instead_of_resetting` 全量并行必然假红（测试基础设施） | open | engine |
| BUG-363 | TG 面板 101 个文字节点 < 12px（70 个 10px、25 个 9px、6 个 11px），低于项目自订可读性阈值 | open | shell |
| BUG-367 | 文件列表同一列里五种命名方式并排，且 `未命名视频 #1574` 在四行上重复 | open | shell |
| BUG-368 | 下载条目「图片无法选择」—— 两个选择面对图片的准入判据不同，缺一个可复现定位点 | open | shell |
| BUG-370 | 过程缺陷 —— 8 份缺陷档 + 13 个验证脚本长期只在工作区，版本控制里查不到；BUG-364 标 fixed 而验收章节为空 | in_progress | docs |
| BUG-373 | TG 重启风暴：daemon TG supervisor（BUG-178）每 15s 探 orig-tg session，3 连败即杀重启（BUG-351 抖动期 5 分钟冷却）——实测 `%TEMP%/orighub-dev-daemon.log` 555 次重启 / 643 次探针失败（BUG-351 修时实测 477 次，现更严重且 02:00–03:00 仍在继续）。每次重启=会话重建+在传队列全变「应用重启：传输被中断」+down 窗口内 `/api/activity` cache 源 available=false ⇒ 下载域 ingest 行整片消失（同时是 BUG-372①「不滚」的触发条件）⇒ 用户侧「TG 完全无效」「进度完全不动」「卡顿」。数据安全原理：任务账与文件在 daemon 存储+D:\OrigDown，orig-tg 只是传输通道 ⇒「系统坏了但数据还在」。触发器未定位（两候选）：① 本机企业代理（HrAppStorePac 设 http_proxy=127.0.0.1:6762）对环回间歇抽风（20 连探 10 次 000 vs 直连 15/15）——但 daemon 探针走 no_proxy 直连，解释不了 daemon 侧 3 连败，它打穿的是尊重 env 代理的消费者；② orig-tg 运行时 stall（down 窗口进程活着但 19787 拒连、无 recovered 行）——候选：dialogs 合并 519 对话+67 频道逐个重试的 CPU 占用、store 同步段。未修，待用户点名后抓 down 窗口进程态定案 | in_progress | engine |
| BUG-382 | 频道回溯「取消」找不到、回溯点不可见——用户无法确认上次回溯到哪 | open | shell |
| BUG-383 | 频道消息流「图/文上下堆叠」占空间，应改左右布局 | open | shell |
| BUG-384 | 错误提示不带数据——不可说明、不可调试、不可跟踪（第 5 次） | open | shell |
| BUG-386 | cat-all 行集口径分裂——下载成品行不参与搜索过滤、按日期混排挤占媒体行 | open | shell |
| BUG-389 | 服务全灭时界面只说「Telegram 正在启动」——不可达被渲染成启动中 | open | shell |
| BUG-403 | 文件管理点击内容应显示详情与可操作功能，而非选中 | fixed | shell |
| BUG-404 | 剧集子标题缺乏层次，应体现层级而非直接堆叠 | open | shell |
| BUG-405 | 标签过滤分两组件布局无整体感，功能按钮位置突兀需重设计 | open | shell |
| BUG-406 | 剧集合并底部选中数量「2」语义不明、显示突兀 | open | shell |
| BUG-409 | 内容详情标题缺层级——缺「剧集→内容」面包屑层次感 | open | shell |
| BUG-410 | 内容详情主卡片功能错位——导出浏览应为当前视频剧集而非总浏览 | open | shell |
| BUG-412 | 视频编辑与显示排版冲突——切换后布局不一致、图文相反 | open | shell |
| BUG-413 | 主卡片播放按钮加时间后排版错乱，需重评估设计 | open | shell |
| BUG-414 | 主卡片「删除剧集」与次卡片「从剧集删除」逻辑混乱 | open | shell |
| BUG-415 | 缺少错误单集多源的拆分功能（含多源视频浏览） | open | shell |
| BUG-416 | 缺少合并播放功能——多短视频合并成一段连续播放去卡顿 | open | shell |
| BUG-417 | 缺少视频跳帧功能——每段前/后跳固定秒数 | open | shell |
| BUG-418 | 缓存任务重跑不幂等——重跑后多出重复条目与分集（单测红灯） | open | engine |
| BUG-419 | 已置顶任务无法取消置顶（422）——优先级端点放行条件漏了 unpin | open | engine |

## 已完成

| 编号 | 标题 | 状态 | 模块 |
|---|---|---|---|
| BUG-001 | 下载文件不自动嗅探 / 不按实际文件类型命名 | fixed | engine |
| BUG-002 | 无法查看每连接状态与分块进度 | fixed | engine+shell |
| BUG-003 | 速度统计失准（完成后仍显示 / 进行中不准） | fixed | engine+shell |
| BUG-004 | 无全局进度状态，状态栏仅计数无实时速度 | fixed | shell |
| BUG-005 | 「打开文件 / 打开目录」按钮无效且样式为纯文字 | closed | shell |
| BUG-006 | 侧边栏「全部文件」展开/收起交互行为不纯 | fixed | shell |
| BUG-007 | 内置分类标签不支持多语言设置 | fixed | shell |
| BUG-008 | 自动分类「新增分类行」布局错乱 | fixed | shell |
| BUG-009 | 自动分类编辑器内置分类名未翻译 | fixed | shell |
| BUG-010 | 前端 BUILTIN_CLASSIFY 与 daemon 规范分类键不一致 | fixed | shell |
| BUG-011 | 运行中反复弹出 Terminal 小窗 | fixed | engine+shell |
| BUG-012 | 无法拉取应用（TG 频道列表失败）且显示已登录但实际会话失效 | fixed | engine |
| BUG-013 | 分组（TG 频道列表）加载极慢、分组缺失、分页停在 50 条 | fixed | engine+shell |
| BUG-014 | 入库媒体看不到图片/视频，无法选择下载/浏览 | fixed | engine+shell |
| BUG-015 | TG 面板交互结构错误：订阅/监控混排、内容无历史分页、非聊天式时序 | fixed | engine+shell |
| BUG-016 | TG api_id/api_hash lost — credentials only lived in process memory and were destroyed by repeated process kills | fixed | engine |
| BUG-017 | Group view missing members — dialog_cache.folder covered only 37/510 channels | fixed | engine |
| BUG-018 | 媒体库长期空白——只显示「TG 已缓存」媒体且无任何管理能力 | fixed | engine+shell |
| BUG-019 | 内容归入多个剧集时，列表出现重复条目（JOIN 扇出） | fixed | engine |
| BUG-020 | 剧集卡片无封面；首集为视频时把视频地址当图片 src，卡片被压扁遮挡标题 | fixed | engine+shell |
| BUG-021 | CORS 未允许 PATCH/PUT —— 封面与元数据保存静默失败 | fixed | engine |
| BUG-022 | PATCH 请求体强制要求 id —— 前端局部更新全部 422 | fixed | engine |
| BUG-023 | TG 连接失败静默退化为 dummy —— 登录态/发码/client id 全体「消失」，且端口冲突直接 panic | fixed | engine+shell |
| BUG-024 | 缓存状态完全丢失 —— 下载任务只活在浏览器内存里，刷新即归零且无法续传 | fixed | engine+shell |
| BUG-025 | `/api/tg/code` 在未登录（含服务不可用）时回「已授权」—— 交验证码即伪造出登录态 | fixed | engine |
| BUG-026 | 缓存任务轮询导致页面卡顿 —— 每秒全量重渲染 + 高频读打 SQLite | fixed | engine+shell |
| BUG-027 | 缓存任务多请求并发 + 派生重取链 —— 1s 多次请求导致页面卡死 | fixed | engine+shell |
| BUG-028 | TG 在线播放视频严重卡顿（单连接串行拉流 + 每 Range 1.2s RPC） | fixed | engine |
| BUG-029 | BUG-029 缓存不入媒体库 + 缓存任务无可观测面 | fixed | engine+shell |
| BUG-030 | task 轮询过频致页面卡顿 | fixed | shell |
| BUG-031 | 已缓存播放仍卡顿 + 组消息缓存不成剧 | fixed | engine+shell |
| BUG-032 | 旧库 + 新代码 → 服务健康但媒体库「全空」 | fixed | engine |
| BUG-033 | 倍速播放触发投递请求风暴 —— 同一块数据被反复重取，页面卡死 | fixed | engine+shell |
| BUG-034 | 播放「非常卡」与倍速失效 —— 解码异常全程静默，播放器不告知也不降级 | fixed | shell |
| BUG-035 | 播放器沿用原生控件、播放时无分集列表；移植参照实现时暴露两处缺陷 | fixed | shell |
| BUG-036 | 剧集里图片被当成视频播——播放序列未按媒体类型分流 | fixed | shell |
| BUG-037 | 分批加入的内容裂成两个剧集，且没有合并能力 | fixed | engine+shell |
| BUG-038 | 监控频道内容在面板内永不更新 | fixed | shell |
| BUG-039 | 媒体库无冲突模型——同集多缓存来源与合集视频无法表达 | fixed | engine+shell |
| BUG-040 | 窄窗口媒体库整体出界裁剪——右侧按钮全消失且无滚动 | fixed | shell |
| BUG-041 | 介绍无法显式清空——PATCH null 语义缺失 | fixed | engine+shell |
| BUG-042 | 筛选空态伪装成「资料库是空的」——误导用户以为数据丢失 | fixed | shell |
| BUG-043 | cache worker 对「已落盘但从未入库」的条目静默跳过 | fixed | engine |
| BUG-044 | 图片混入剧集 —— 「图片不入剧集」规则级缺失 | fixed | engine+shell |
| BUG-045 | TG 内容标签未进入标签收集 | fixed | engine |
| BUG-046 | BUG-046 单视频气泡没有缓存按钮，图片反而有 | fixed | shell |
| BUG-047 | BUG-047 监控搜索框位置错误（应在标题栏标题与按钮之间） | fixed | shell |
| BUG-048 | BUG-048 混编相册（1 封面图 + 1 视频）不成剧 —— 「缓存不入库」 | fixed | engine |
| BUG-049 | BUG-049 图片不需要缓存 —— 最多加入媒体库（缓存/入库语义区分） | fixed | engine+shell |
| BUG-050 | BUG-050 规则失联：无需求模型导致功能互相破坏 | fixed | engine |
| BUG-052 | BUG-052 退役触发器未 DROP：升级库上图片分集被拒 → 剧集建成却 0 分集（静默数据丢失） | fixed | engine+shell |
| BUG-053 | BUG-053 解码提示是「只会置位的闩锁」：不论是否卡顿都常驻「解码吃力」 | fixed | shell |
| BUG-054 | BUG-054 条目没有「介绍位」→ 正文被塞进标题；且标题/介绍无编辑入口、缓存删除无确认无选择 | fixed | engine+shell |
| BUG-055 | BUG-055 Tauri 壳消费的 sidecar 副本从不随 `cargo build` 更新 → 用户启动的 app 跑旧引擎 | fixed | build |
| BUG-056 | 剧集合并丢弃合集范围，且槽位规则与批量追加不一致 | fixed | engine |
| BUG-057 | 媒体库条目卡片没有逐条删除入口，只能「先勾选再批量移除」 | fixed | shell |
| BUG-058 | 导航标签不保证单行 —— 计 0 未省略、长名未截断、计数无界 | fixed | shell |
| BUG-059 | 设置页「清除缓存文件」直达全量清理，无范围选择 | fixed | engine+shell |
| BUG-061 | 引擎产物在仓库里有四处副本，构建不刷新「壳自己的那份」也无陈旧检测 | fixed | build |
| BUG-062 | TG 提交验证码缺 `phone` 字段被 422 拒绝 | fixed | shell |
| BUG-063 | 代理自检误报「不可达」 | fixed | engine |
| BUG-064 | Vite dev server 未监听 0.0.0.0，Tauri webview 连不上（connection refused） | fixed | shell |
| BUG-065 | TG 页签可见性由「插件开关」驱动而非「绑定态」 | fixed | shell |
| BUG-066 | 媒体覆盖层不可 Esc 关闭，且状态色块与按钮样式不统一 | fixed | shell |
| BUG-067 | 缺陷登记与修复提交互不追溯且无门禁 —— 修复只活在 git 历史里 | fixed | docs |
| BUG-068 | 媒体库左栏标签：计数 0 仍渲染 + chip 不保证单行 + 显示的数 ≠ 筛出条数 | fixed | shell |
| BUG-069 | 「剧集里的视频」文案与视频不同源 —— 分集标题改不了、条目介绍在剧集里不显示 | fixed | engine+shell |
| BUG-070 | 播放页不是只读的（有标题编辑按钮）+ 右侧列表装饰性播放图标 + 进播放页重复拉同一部剧集 | fixed | shell |
| BUG-071 | 默认下载目录在 Windows 下解析出 `~`/依赖 `$HOME`，路径不可靠 | fixed | engine |
| BUG-072 | 网页调试模式下「浏览…」选择目录报错（Cannot read properties of undefined (reading 'invoke')） | fixed | shell |
| BUG-073 | 自动分类落盘键/展示名未解耦（手动添加只有名称+类型，无独立磁盘键） | wontfix | engine+shell |
| BUG-074 | 网页调试阶段 orig-tg 离线态未真正生效，且离线在 UI 上表现为红色错误环境 | fixed | engine+shell |
| BUG-075 | `/src/components/TgPanel.tsx?t=...` 直连 .tsx 请求——Vite 开发服务器行为（非缺陷） | wontfix | shell |
| BUG-076 | 剧集分集标题编辑另起一行，且编辑态会被截断导致存错内容 | fixed | shell |
| BUG-077 | 缓存是否应与下载功能结合（TG 缓存路径与普通下载路径的关系） | closed | engine+shell |
| BUG-078 | 缓存任务「重试」新建一条任务 +「删除」确认框出现在面板顶部而非当前任务下 | fixed | engine+shell |
| BUG-079 | 缓存字节面板按频道选择凌乱 +「预计释放」显示全量而非选中内容 | fixed | shell |
| BUG-080 | 缓存清理后媒体库条目仍在但无法播放（字节已删、条目未同步状态） | fixed | engine+shell |
| BUG-081 | 「清理入口在本面板的『缓存字节』页签」提示在本页签自己也显示 | fixed | shell |
| BUG-082 | 左侧 Navi 缺下载队列状态筛选（全部 / 下载中 / 已完成 被开关隐藏，且无替代入口） | fixed | shell |
| BUG-083 | 顶部下载工具栏仅在下载视图渲染，媒体库/TG 下整组消失（是否常显与占位） | fixed | shell |
| BUG-084 | 提交信息混入 CR（`\r`）→ 同内容提交哈希不同、全后代历史整体偏移 | fixed | build |
| BUG-086 | UI 验收通道自身不可执行 —— verify 脚本 require('playwright') 而依赖未声明，且无零依赖替代 | fixed | shell |
| BUG-087 | 连接态指示三处各写各的 —— 上下文栏读 store，底部状态栏/侧栏底部硬编码「已连接/运行中」+恒绿点 | fixed | shell |
| BUG-088 | 「传输中」面板把后端原始 HTTP 报文（404 Not Found）直接渲染进正文 | closed | shell |
| BUG-089 | 分类下钻时「全部文件」行不点亮，顶行失去「我在哪」指示 | fixed | shell |
| BUG-090 | 浏览器开发模式下连接态恒为 offline —— Tauri `invoke` 不可用时失败被静默吞掉，指示器与事实相反 | fixed | shell |
| BUG-091 | tg_start 只看子进程句柄不探端口，会 spawn 出第二个 orig-tg | fixed | engine |
| BUG-092 | /api/interfaces 单次约 1s 阻塞，新建下载弹窗开合卡顿 | fixed | engine |
| BUG-093 | 侧栏 Telegram 导航项消失——9877 上残留着验收脚本以离线模式拉起的 orig-tg | fixed | shell |
| BUG-094 | daemon 拉起 orig-tg 时用错数据目录且拿不到凭据，冷启动必然掉登录态 | fixed | engine |
| BUG-096 | AGENTS.md §5 的「双向删除联动」与代码实际分家（缓存清理规约 vs 实现） | fixed | docs |
| BUG-097 | TG 状态是一次性快照 —— 已登录且服务正常，Navi 却不显示、状态永远「启动中」 | fixed | shell |
| BUG-100 | 监控内容搜索框位于频道标题栏，位置暗示「频道内」而行为是「跨频道」 | fixed | shell |
| BUG-104 | 落盘文件名不含 chat/message 标识 → 两个 media_item 共享同一 file_path，清一条即打掉另一条的字节 | fixed | engine |
| BUG-105 | 「能不能播」判数据库字段不判磁盘 —— 字节被删后仍显示已缓存，且没有重新缓存入口 | fixed | engine |
| BUG-106 | orig-tg 的 sender runner 静默死亡后，所有实时 RPC 恒失败且健康态谎报 ok | fixed | engine |
| BUG-107 | `sync-sidecars.sh` 对缺失目标静默跳过并照旧报 OK（假绿） | fixed | build |
| BUG-108 | 批量操作（全部暂停 / 全部开始 / 清除已完成）失败被双重静默，点击无反应也无提示 | fixed | shell |
| BUG-109 | 清缓存无论成败都报 `removed`，删除失败被静默吞掉 | fixed | engine |
| BUG-110 | 链路已断的 RPC 失败被归类成 400 并裸漏传输层原文 | fixed | engine+shell |
| BUG-111 | 任务失败原因（持久化在 DB）在界面上原样直出传输层原文 | fixed | shell |
| BUG-112 | 剧集里的图片无法从剧集中移除（图册区没有移除入口） | fixed | shell |
| BUG-115 | 「加入媒体库」只入库、不落盘 —— 断网后打不开 | closed | engine+shell |
| BUG-121 | 按钮语义重叠 —— 同一按钮按内容类型变文案，被用户当成两个不同入口 | closed | shell |
| BUG-123 | 点击前没有类型信号 —— 点图片却进入视频播放器 | fixed | shell |
| BUG-124 | 另外三个删除入口同样制造孤儿备用源行 —— 条目被永久锁死（BUG-103 只覆盖合并入口） | fixed | engine |
| BUG-126 | 从剧集移除的分集会被「重新编回」—— 缺 tombstone 负向记录 | fixed | engine |
| BUG-127 | `aria-label` 用了从未落地的 i18n 键 —— 读屏念出 `tg.monitorCollapse` | fixed | shell |
| BUG-128 | 类型徽标文案硬编码中文 —— 英文界面会显示「视频」「图片」 | fixed | shell |
| BUG-129 | `addEpisode` 默认按槽位 upsert —— 静默覆盖该槽位已有条目 | fixed | engine |
| BUG-131 | 媒体库工具条搜索/排序仅 items 视图生效却恒渲染，series 视图产生假筛选态 | fixed | shell |
| BUG-132 | 条目「有无字节」判据分叉——MediaItem 无 has_bytes 恒走 file_path 判定，三态探测未接线 | fixed | engine+shell |
| BUG-134 | 连接态三处重复渲染 + 速度双实现（一处绕过 selectors）+ 灯尺寸不齐 | fixed | shell |
| BUG-135 | 删除媒体条目时文件删除与 clear_downloaded 失败被静默吞——接口假成功 | fixed | engine |
| BUG-136 | cache 接口 external 字段双形状双口径——stats 返数字、clear/preview 返对象 | fixed | engine |
| BUG-137 | TG 内置播放器三入口只传单条/单相册——TG 侧无上一条/下一条 | fixed | shell |
| BUG-138 | media:list 无读缓存——cacheKey 未覆盖条目列表，与既有列表缓存策略不一致 | fixed | shell |
| BUG-140 | TG 分组模式频道过滤搜索框与全局消息搜索并存，无作用域标注 | fixed | shell |
| BUG-143 | ImportDialog 默认目录硬编码 D:\test_videos——开发残留进了生产 UI | fixed | shell |
| BUG-144 | 设计外「视频库」独立导航入口（S4）——挤占 TG 导航并造成回归 | fixed | shell |
| BUG-145 | 媒体库不展示来源名 / 来源离线时无明路（PM 评估 S2/S3 落地） | fixed | shell |
| BUG-146 | 缺陷登记门禁 §13.3 规则冲突——未识别字段名静默失效 + 轻量档减免验收证据 | fixed | docs |
| BUG-147 | 来源可用性探活用了「进程存活」判据——TG 不可用仍给可用的重新缓存按钮 | fixed | shell |
| BUG-148 | 能力限制说明被做成常驻核心元素——搜索框作用域 chip 占据主视觉 | fixed | shell |
| BUG-149 | 入库流水线记录只增不减——已验收的批量清理入口被无编号重构撤掉，且全库无保留策略 | fixed | shell |
| BUG-150 | 图片被当视频播放——播放序列按「可播」而非「同型」构造，图片被编进视频连播 | fixed | shell |
| BUG-151 | 搜索结果点击没有内容浏览，直接进播放器 | fixed | shell |
| BUG-152 | 剧集标题取「首个批次第一条 caption」——后续追加永不更新，首条决定全剧名 | fixed | engine |
| BUG-153 | 合集分集的「结束集号」不可编辑 —— 后端支持全集，前端只传起点 | fixed | shell |
| BUG-154 | 条目 title 为空或原始文件名 —— 分集展示兜底成 `#<itemId>` | fixed | engine+shell |
| BUG-155 | 媒体库工具条四个操作按钮零 view 守卫 —— items 专用选中集合跨视图泄漏 | fixed | shell |
| BUG-156 | 首行以 `#` 开头的 caption 被 `split_caption` 整行吞掉 —— 剧名丢失退化成「频道名 · 日期」 | fixed | engine |
| BUG-157 | 污染门禁的「仓库根白名单」在**外层仓视角下完全失效** —— 仓库根积了 46 个探针残留而门禁恒 PASS | fixed | build |
| BUG-159 | 删除/合并剧集后客户端陈旧 series 引用未失效 + 404 无语义化展示（series not found） | fixed | shell |
| BUG-160 | 相册宫格上限写死 9 —— 满员（10 条）TG 相册的第 10 个内容被折进 `+N` 而从宫格消失 | fixed | shell |
| BUG-161 | 验收/诊断脚本默认直连生产 orig-tg(9877) 写入用户真实库且无守卫、不清理 —— 媒体库留下 `DiagCard_<ms>` 孤儿剧集残留 | fixed | build |
| BUG-162 | `delete_media_item` 在破坏性动作之后才中止 —— 500 文案自称「nothing was deleted」却已把字节删掉 | fixed | engine |
| BUG-163 | 本地投递节流配额每请求从 0 起算 —— body 首块被扣住 440–725 ms，播放与浏览双重卡顿 | fixed | engine |
| BUG-164 | 下载类视图顶栏无连接灯 —— 三角落连接态指示在半数视图缺一 | fixed | shell |
| BUG-165 | 进度条拖拽期每个 pointermove 都提交 seek —— 请求风暴（未松手=未确认态却发请求） | fixed | shell |
| BUG-166 | 「解码吃力」把数据晚到型丢帧误判为解码吞吐不足 —— 无可见卡顿却常驻误导提示 | fixed | shell |
| BUG-167 | 瞬时 TG 传输错误升级为全局「无法连接到 Telegram」toast —— 与三处「实时已连接」灯同屏矛盾的第二真相源 | fixed | shell |
| BUG-168 | 媒体库图片与剧集无集级关联 —— 一集无法挂自己的图，图片只能独立占集 | fixed | engine+shell |
| BUG-169 | 「实时已连接」三处渲染点被用户裁定为「三个状态点未收敛」—— 唯一状态点 = 唯一渲染点 | fixed | shell |
| BUG-170 | 入库过渡窗「缓存→不见了→完成→出现了」—— 条目登记推迟（P1 已修）+ 前端三源状态拼接（本阶段修） | fixed | shell |
| BUG-171 | 剧集详情页同一段简介出现两次 + Hero 海报比例被 flex stretch 顶掉 | fixed | shell |
| BUG-175 | 设置页「默认下载目录」显示 Unix 风格路径（`~/Downloads`），Windows 上完全不可用 | fixed | shell |
| BUG-177 | 「已开启却未连接」被当成合法产品状态 —— TG 入口门控只认开关不认服务 | fixed | shell |
| BUG-178 | TG 进程有两个主人、三套「可用性」—— 同一次会话里「插件运行中」与「Telegram 不可用」并存 | fixed | engine |
| BUG-179 | 调试模式下 TG 与媒体库服务不正常 —— 数据目录分叉 + 离线短路连本地数据一起拒绝 | fixed | engine |
| BUG-180 | 缓存单飞队列被停滞下载饿死 —— 无字节超时看门狗缺失，「添加一个后,后续无法添加」 | fixed | engine |
| BUG-181 | BUG-181 缓存队列「任务1添加，任务2就完全无法添加」——排队任务零呈现 + 条目内进度冻结 | fixed | engine |
| BUG-182 | BUG-182 多源区「摘除备用源」接错端点：按钮在、文案对、testid 在，但能力事实不存在 | fixed | shell |
| BUG-183 | BUG-183 剧集介绍展示位缺失：活的剧集内页不渲染剧集介绍，唯一承载它的 `SeriesHero` 是零 importer 孤儿 | fixed | shell |
| BUG-184 | BUG-184 TG 相册「继续 N/M」在没有任何缓存任务时出现：TG 图片被无条件判为已缓存 | fixed | shell |
| BUG-185 | BUG-185 相册缓存完成后操作行整行消失：完成态零入口、零状态提示 | fixed | shell |
| BUG-186 | BUG-186 剧集合并入口仅存在于剧集内页：媒体库剧集墙无法多选剧集进行合并 | fixed | shell |
| BUG-188 | BUG-188 纯图组的「加入媒体库」排在传输队列里：不需要字节的编目动作被落盘队列延迟 | fixed | shell |
| BUG-189 | 并发下取新行 id 的竞态（**三处**）—— 连接级 `last_insert_rowid()` 被别的请求抢走 | fixed | engine |
| BUG-191 | BUG-191 「在媒体库中查看该内容」打开的是编辑面板：文案承诺「查看」，行为是「编辑」 | fixed | shell |
| BUG-193 | BUG-193 归档（非主文件夹）对话永不进入会话缓存：66 个分组内频道在列表里根本不存在 | fixed | engine |
| BUG-195 | BUG-195 分组成员只读 `include_peers`，丢弃 `pinned_peers`：文件夹内置顶的频道整批丢失 | fixed | engine |
| BUG-196 | BUG-196 分组频道列表：筛选框无 × 清空、pin 频道未置顶 | fixed | shell |
| BUG-197 | BUG-197 剧集内页默认进入编辑态：打开剧集就直接看见编辑表单，主次颠倒 | fixed | shell |
| BUG-198 | BUG-198 剧集内页「来源」是信息展板而非播放来源切换器：塞了 ref/路径/内部 id 噪声 | fixed | shell |
| BUG-199 | BUG-199 播放卡顿：本地播放器流畅而 WEB 卡死、HLS 流畅而当前不流畅 —— 根因是环回口上的全局投递节流 | fixed | engine |
| BUG-200 | BUG-200 集不能没有标题：空标题在后端「不可表达」，清空后保存表现为「保存了但没变」 | fixed | engine+shell |
| BUG-201 | BUG-201 单集有两个编辑入口：「编辑介绍」与「编辑本集」打开的是同一个面板 | fixed | shell |
| BUG-202 | BUG-202 单集编辑入口与标题脱节：唯一入口被埋在右栏底部，用户误判「标题不能改 / 编辑被分开」 | fixed | shell |
| BUG-203 | BUG-203 本集编辑态与静态展示同屏渲染：标题等文本重复两行 | fixed | shell |
| BUG-204 | BUG-204 「编辑所有内容」名实不符：统一编辑面板没有图片管理，图无法增删替 | fixed | shell |
| BUG-205 | BUG-205 自动入库把单集误判为合集（caption 集号范围）：单集优先，合集仅手动编辑 | fixed | engine |
| BUG-206 | BUG-206 播放界面把内部 id 当「无标题」兜底显示：消费面不漏内部主键 | fixed | shell |
| BUG-207 | BUG-207 播放「还是不流畅」的定位与止损：重量级条目为 HEVC，Chromium 0 帧可解却无限风暴拉流 | fixed | shell |
| BUG-208 | BUG-208 HEVC 条目浏览器永远播不了（0 帧解码）——兼容流：按需实时转码 H.264 自动切换 | fixed | engine |
| BUG-209 | BUG-209 倍速播放丢帧：转码档未限帧率 + UI 倍速封顶 2x | fixed | engine |
| BUG-210 | BUG-210 剧集内页主任务错位：播放被埋在「操作」区末行、与描边按钮同尺寸；无备用源时「来源」块仍整块渲染 | fixed | shell |
| BUG-211 | BUG-211 分集移除按钮文案与真实动作相反：可见文案「移出资料库」，实际语义为「内容保留、仅解除归属」 | fixed | shell |
| BUG-212 | BUG-212 倍速下「解码吃力」误报：把呈现丢帧错归因为解码不足 | fixed | shell |
| BUG-213 | BUG-213 验收封装 launch() 恒 headless：意图 headful 的取证脚本静默跑在无 GPU 的 headless 下 | fixed | shell |
| BUG-214 | 剧集墙多选只有「合并/清空」，缺基础批量操作（批量删除必须补），选择条固定顶部随滚动丢失 | fixed | shell |
| BUG-215 | 图片灯箱顶部两按钮（关闭/摘除）被自绘标题栏裁切 —— `fixed inset-0` 锚错参照系 | fixed | shell |
| BUG-216 | BUG-216 播放器 `timeupdate` 触发整棵控件树重渲染 —— 进度条/缓冲段/时间文案状态下沉到叶子组件 | fixed | shell |
| BUG-217 | BUG-217 播放器控件层隐藏态仍参与合成 —— `showControls=false` 时整层 `opacity-0` 控件把 2x/4x 上屏节拍拉到裸 `<video>` 以下 | fixed | shell |
| BUG-221 | 入库流水线看不到进度：单条大文件全程 0%，且无从判断「在下载 / 卡死 / 已恢复」 | fixed | engine+shell |
| BUG-223 | 非 1x 倍速卡顿 —— 服务端 30fps FRC 降低浏览器解码负载 | fixed | engine+shell |
| BUG-224 | 浏览器报「无法解码该格式」——本机明明能放 / 服务端明明能救，两条救生索都没被拉 | fixed | shell |
| BUG-225 | FRC 流上「播放时间不对」—— live fMP4 的 NaN duration 让位置恢复/跳转全部钳回 0:00 | fixed | shell |
| BUG-226 | 冷缓存换档/深位续播「卡」—— live 转码从 0:00 起必须追平全部已播内容；新增 `?t=` 锚点起转 + `?probe=1` 探针 | fixed | engine+shell |
| BUG-227 | daemon 拉 orig-tg 用 5s 全程连通窗口，代理链路慢时把本可成功的启动系统性否决（"exited without listening" 假象） | fixed | engine |
| BUG-229 | 非 1x 倍速无条件切 FRC 转码流 ⇒ 浏览器对 fMP4 代理发起乱序 range 风暴 + 全片转码缓存，用户报「同时几十个 request、缓存差不多整部、不是前面优先」 | fixed | engine+shell |
| BUG-230 | raw 直解路径在本机环境全程卡顿（1x 卡 / 2x 非常卡 / 4x 无法播放），stream 转码流流畅 ⇒ 播放主路径翻转为 stream-first，raw 退役为下载/导出端点 | fixed | shell |
| BUG-231 | TG 侧播放器标题显示**频道名**而非内容标题 —— 用户完全不知道在看什么内容 | fixed | shell |
| BUG-232 | 入库流水线行标题是频道名/裸频道 ID，没有入库内容的标题 | fixed | engine+shell |
| BUG-233 | 设置-关于只有下载引擎（daemon）状态，没有 Telegram 插件状态 | fixed | shell |
| BUG-239 | 进入媒体库请求成倍放大 —— `stats`/`diag` 各发 4 次、`tags`/`series` 各 2 次，且封面抽帧按缺封面条目数线性发 `items/{id}/raw`；切走再回必重发 | fixed | shell |
| BUG-242 | 门禁无作用域 —— 一次纯文档改动被迫跑全量缺陷门禁 6 分 39 秒（399 s），与改动零因果 | fixed | docs |
| BUG-243 | 无「可查的调试日志」—— 引擎把子进程输出丢进 DEVNULL，出错只剩一句「未能启动」 | fixed | engine+shell |
| BUG-244 | 永久失败（二进制缺失）不受 spawn 冷却约束 —— 巡检每 15s 重试一次并追加一行错误 | fixed | engine |
| BUG-245 | 播放器常驻「已切换实时转码兼容流」横幅——stream-first 成为默认路径后，UI 仍把「走转码流」当异常播报 | fixed | shell |
| BUG-246 | 入库流水线「排队中」行标题退回频道名——消息行只在任务**启动时**才落 `media_message`，排队阶段查不到 | fixed | engine |
| BUG-247 | 缺陷门禁逐次 spawn git —— 全量跑 916 次子进程、399 s（最慢 7 分 0.8 秒），而候选集合有限且可预先枚举 | fixed | docs |
| BUG-251 | 剧名已自带书名号时渲染层再套一层，近半数剧集显示成 `《《…》》` | fixed | shell |
| BUG-252 | MergeSeriesDialog 中文硬编码 —— 英文界面里混排中文 | fixed | shell |
| BUG-253 | 播放器总时长取的是实时转码管道的瞬时 duration —— 实测显示 0:07 / 0:08，而真值 4:02 | fixed | shell |
| BUG-254 | 无字节内容在剧集墙/分集列表/播放器三处不可辨 —— 播放器还把「没有视频内容」误诊成「浏览器无法解码」 | fixed | shell |
| BUG-255 | 媒体库剧集集数统计错误 —— 大量多集内容显示为 1 集 | fixed | engine |
| BUG-256 | 临时文件回收页签信息架构失衡 —— 列表上方堆叠 9 个构件（含与本页签无关的「入库统计条」），明细行直接渲染内部标识 `doc--…` 导致不可辨识 | fixed | engine+shell |
| BUG-257 | 入库队列三处缺陷 —— 卡住的条目无法中断（只有 90s 空闲看门狗，且它会把整个任务判失败、放弃剩余条目）；重启把 queued+running 整批降级为 interrupted 且无任何恢复；失败原因被折叠成通用网络文案 | fixed | engine+shell |
| BUG-258 | 剧集「类型」的选择在每次启动后被静默改回「剧集」（3 个选项里 2 个实际不可达）；「年份」全库为空且一旦填入就无法清空；内容编辑弹窗里的同名「类型」是只读且未本地化的原始枚举 | fixed | engine+shell |
| BUG-260 | 分集行把槽位标签渲染两遍 —— `S1E3 S1E3 未缓存` | fixed | shell |
| BUG-261 | 「未缓存」状态没有配套动作 —— 标记不可点、无剧集级批量缓存入口、重缓存判据绑在「当前主源」而非「可用来源」 | fixed | engine+shell |
| BUG-263 | 内容编辑弹窗整体未接 i18n —— 整窗硬编码中文，同窗中英混排 | fixed | shell |
| BUG-265 | 剧集内页「来源」块对所有剧集彻底消失 —— BUG-210 把「信息（正在从哪播）」与「控件（切换备用源）」合并成同一个门控 | fixed | shell |
| BUG-271 | 入库队列缺「慢流」档 —— 90s 空闲看门狗只治「死」不治「慢」，一个每 89s 来一小块的流可无限期占住队首 | fixed | engine |
| BUG-275 | media.rs 事务错误路径的 `ROLLBACK` 漏 `.await` —— Future 从未被 poll，回滚从未发生，失败后事务悬挂持写锁 | fixed | engine |
| BUG-277 | 入库流水线队列**无优先级能力** —— 无法置顶 / 切换 / 提前下载，顺序只能是严格 FIFO（`ORDER BY id ASC`） | fixed | engine+shell |
| BUG-280 | 入库队列任务标题被**无意义文件名**遮蔽 —— 组内靠前的 `file_name` 抢在靠后消息的真 `caption` 之前 | fixed | engine |
| BUG-281 | 相册组的分集内容**不共享组级 caption** —— 每个分集只取「该消息自己的 caption」，组内只有带 caption 的那一条分集有标题/介绍（实测 149 个分集仅 31 个有介绍） | fixed | engine+shell |
| BUG-285 | 媒体库条目/剧集无「跳回 TG 源消息」入口 —— 数据层已存 `(source, ref)` / `source_key` 可精确定位，前端零入口，无标条目无法人工识别与纠正 | fixed | shell |
| BUG-286 | 纯浏览器（网页调试模式）下 Tauri 原生调用缺 `isTauri()` 守卫… | fixed | shell |
| BUG-291 | 转码代理文件名**无编码版本键** —— 改编码档位后**陈旧代理被永久沿用**（实测 4x 代理仍是旧档的 30 fps） | fixed | engine |
| BUG-293 | 转码泵**回压死锁**下「防饿死」守卫**不可达** —— 客户端停读 ⇒ 泵阻塞在 `resp_tx.send()` ⇒ ffmpeg 0% CPU + `.part` 冻结 + 该 `(item, speed)` 变体**永久卡死**… | fixed | engine |
| BUG-304 | 文件域归集不变量与信息层级错位——「未归档」状态本不该存在（视频=剧集）、标签不应有独立 TAB、成品列表混入无字节条目、标签筛选框置于标签列表下方 | fixed | engine+shell |
| BUG-305 | 媒体库「在 TG 中查看」仅落 t.me 外链，缺应用内跳转（插件→对应频道→对应内容） | fixed | shell |
| BUG-306 | 侧栏导航信息架构修正（删冗余组标签 + 父行重命名 + 父子排他选中） | fixed | shell |
| BUG-309 | 无内容 hash 去重——多源/跨频道相同字节视频必然重复占盘，且多源共享字节缺引用计数（重蹈 BUG-100 风险） | fixed | engine |
| BUG-310 | 视频显示名无唯一规则——caption 缺失即空标题，item/episode/series 三层各写各的，同一视频多处名字不一致 | fixed | engine+shell |
| BUG-311 | 缺少批量整理命名能力（mp3tag 式模板命名/归位）——库内改名不动物理文件后，用户无可读命名的对外交付手段 | fixed | engine+shell |
| BUG-313 | 设置页排版规范缺失——区块卡/标题/间距/字号无单一真源，M0 合并后全页不一致 | fixed | shell |
| BUG-314 | 下载侧栏违规新增「已取消」树档——主 NAVI 标准化被破坏（BUG-300 复报③ 引入的回归） | fixed | shell |
| BUG-315 | 条目明细层无控制、无状态、无信息——组清单展开后每行只有「S1E29 / 已登记未编入 / 有字节」 | fixed | engine+shell |
| BUG-318 | 下载域数据丢失——orig-tg 不可用时静默空列表 + daemon 引擎下载纯内存重启全丢 + 聚合层活跃任务被掩蔽 + 聚合拉取用常量端口 | fixed | engine+shell |
| BUG-319 | daemon 引擎下载任务纯内存——进程死亡/重启即全部丢失且不可恢复 | fixed | engine |
| BUG-320 | 入库行「展开/收缩」入口不可见——只有一个装饰性 ▸ 字符，用户找不到明细入口 | fixed | shell |
| BUG-321 | 引擎栈非用户操作地整树消失（daemon+orig-tg 一起没），且无任何退出痕迹可查 | fixed | engine |
| BUG-322 | 引擎下载「来源无关重试」契约未履约 + 双面对齐缺失（下载页栈重启空白）+ 重排队身份错乱（重试后状态回退成 cancelled） | fixed | engine+shell |
| BUG-323 | BUG-323 下载设置「目录路径」无逻辑：默认根=库根（内部 AppData 隐藏路径），WEB 下无法挑目录 | fixed | engine+shell |
| BUG-324 | TG 侧入库入口「编入」术语外泄 + 全应用无下载域跳转出口 + 与下载域重复一份条目级明细 | fixed | shell |
| BUG-325 | 单测把用户真实媒体搬出 `~/Downloads`（27.5 GB 落进 %TEMP% 夹具） | fixed | engine |
| BUG-326 | release APP 启动会杀掉健康的 daemon（wmic 弃用导致 owner 判定恒 false）+ 端口漂移，APP 与 dev 栈同时不可用 | fixed | shell |
| BUG-327 | 入库明细底部面板「看得见却用不了」——默认零选中、全选与行复选框相距 1371px、批量按钮像装饰、正文 10–11px | fixed | shell |
| BUG-328 | 剧集墙与视频网格卡片过小——7 列 163px 卡 + 10px 正文，内容看不清 | fixed | shell |
| BUG-329 | TG 监控增强——频道未读条数 + 文字筛选（每条规则 = 一条虚拟监控） | fixed | engine+shell |
| BUG-330 | TG 面板「频道→监控→筛选」三层逻辑失载——筛选命中无内容信息、规则列表不扩展、进筛选后监控/分组点击无效 | fixed | engine+shell |
| BUG-338 | 纯图片入口仍写「加入媒体库」——违反「图片永不进剧集」硬规则的文案残留（行为本身正确，错在文案） | fixed | shell |
| BUG-340 | TG 二级菜单节头污染——原始计数/监控数文案/后台扫描状态破坏样式，数据未就绪时渲染 "—" | fixed | shell |
| BUG-341 | 筛选命中未按相册组呈现——组结构丢失、组内内容入库缺失 | fixed | engine+shell |
| BUG-342 | 标题入库未清洗特殊符号与书名号——《》、emoji、# 标签原样进标题 | fixed | engine |
| BUG-343 | `/api/activity` 无谓轮询——请求不停、数据不更新、语义不清 | fixed | engine+shell |
| BUG-344 | TG 面板控件无统一尺寸规范——按钮过大、节头右侧文字、搜索/标题/按钮各自为政 | fixed | shell |
| BUG-345 | 相册 group_id 过 JSON 边界被 JS 精度损失污染（item_key/去重键与真值差 1） | fixed | engine+shell |
| BUG-346 | 勾选无行级视觉反馈——选中态在界面上不可表达（点是选非） | fixed | shell |
| BUG-347 | 入库计数恒 0——后端已砍 `counts` 字段，前端仍在按它会存在的方式读取 | fixed | shell |
| BUG-348 | 入库流水线用「下载进度」的语言表达「入库状态」——语义错配 + 排版错乱 | fixed | shell |
| BUG-349 | 同源数据双轮询——TG 视图起两条链各拉一遍全量任务（请求爆炸、页面卡死） | fixed | shell |
| BUG-350 | 剧集详情右栏主次颠倒——核心播放夹在展示流中间，「在 TG 中查看」高亮抢主位且与左栏重复 | fixed | shell |
| BUG-351 | TG 链路瞬时 down 即重启进程 ⇒ 5 分钟一次重启风暴（477 次），而重启事实对外不可见、「关于」页两项恒绿 | fixed | engine+shell |
| BUG-352 | BUG-352 图片静默不下载 —— 「BUG-049 图片不缓存」规则在入口上无从表达 | fixed | engine+shell |
| BUG-353 | 下载域无「选中」控制面 —— 在传内容无法选中、无法批量过滤取消 | fixed | shell |
| BUG-354 | Telegram「采集未启用」逻辑不自恰 —— 服务未启动被误判为用户禁用，且「启用」按钮启动不了服务 | fixed | shell |
| BUG-355 | 下载域横幅谎报——全 outage 下仍写「普通下载不受影响」，把全栈失败渲染成下载正常 | fixed | engine+shell |
| BUG-356 | 默认下载目录显示为裸根「/」——解析链不拒退化路径，下载落点变成文件系统根 | fixed | engine |
| BUG-357 | `/api/config` 下发的路径形态混乱——同一响应里三种斜杠，前端按字符串比较必然误判 | fixed | engine |
| BUG-358 | `/api/config` 契约把插件名写死（`tg_enabled`/`tg_running`/`tg_port`/`tg_last_error`/`tg_link`），违背「插件化、即插即用」 | fixed | engine+shell |
| BUG-359 | TG 图片气泡上压着一个半透明黑框「⬇ 缓存」按钮，与操作行的「缓存」是同一个动作的两个入口 | fixed | shell |
| BUG-360 | TG 筛选行可访问名粘连（"琼明神女录14 条"）、命中计数无分隔、删除钮命中区 28×28 低于阈值 | fixed | shell |
| BUG-361 | `cn()` 是裸 join，尺寸类冲突由**样式表源序**定胜负 ⇒ 同一按钮在不同构建下高/字号不一致 | fixed | shell |
| BUG-362 | TG 无 caption 图片的兜底标题是 `TG 图片 #{msg_id}`，抹掉了「来自哪个 TG 会话」 | fixed | engine |
| BUG-364 | 剧集「在 TG 中查看」冷面板定位竞赛误报 + 入口重复 + 播放按钮不按 kind 分支 | fixed | shell |
| BUG-365 | 剧集详情页「N 集」把集级挂图算进集数，与剧集卡口径互相矛盾 ⇒ 用户判定「1 个文件丢失」 | fixed | engine+shell |
| BUG-366 | 下载域顶部两块常驻占位（概览 + 来源切片）挤压列表，用户报「上面死占 2 垃圾」 | fixed | shell |
| BUG-369 | 剧集详情「播放位置」—— 第五次复报，根因是判据把错误形态钉成了正确形态 | fixed | shell |
| BUG-371 | 弹窗标题两套规格并存 —— 3 个 `h2`/16px、6 个 `h4`/13px，标签级别与字号都不一致 | fixed | shell |
| BUG-372 | 下载域界面缺陷批（滚动不滚 / 标题不在第一行 / 图片无法选择 / 「未知文件」） | fixed | shell |
| BUG-374 | 下载域两个详情 Sheet 外壳漂移（标题不在第一行·第四次 / 顶框有的有有的没有） | fixed | shell |
| BUG-375 | `/api/tg/cache/tasks/all` 读路径打库等锁（用户：「获取现在进度这是毫秒级的需求」） | fixed | engine |
| BUG-376 | TG 相册折叠封面「点击展开」间歇性完全无反应 | fixed | shell |
| BUG-377 | 「已暂停」档不含停止项（失败/取消/错误/中断全不可见） | fixed | shell |
| BUG-378 | 《时停手表》EP1-3 三集裂成两个剧集，EP3「丢失视频」 | fixed | engine |
| BUG-379 | 出网路径 `/` 与 `\` 混用——代码修了（a525bc7），二进制没上线 | fixed | engine |
| BUG-380 | `/api/downloads` 只回一条已完成数据——接口口径没有说明 | fixed | engine |
| BUG-381 | 媒体库方格图偏小且没有可看清的浏览方式 | fixed | shell |
| BUG-385 | 剧集链路没有「跳入 TG 对应消息」的入口（BUG-364 撤档后归零） | fixed | shell |
| BUG-387 | 订阅浏览排版三连——图小文高、上下左右混杂、展开缺收起 | fixed | shell |
| BUG-388 | 新监控频道无 sync_cursor 行时 list_channels 报「Null value」——监控列表整体不可用 | fixed | engine |
| BUG-390 | 文字筛选命中数在无监控频道时全 0，被读成「数据全没了」 | fixed | shell |
| BUG-391 | 相册封面被等高拉伸破坏；展开宫格应在底部纵向拉伸而非分列左右 | fixed | shell |
| BUG-392 | 下载域未按共识统一——列表两个端点、状态变更两个域，`/api/downloads` 只剩遗留 mock 夹具 | fixed | engine+shell |
| BUG-393 | 选择态形态不统一——下载域选择条与剧集墙两套样式，且缺「全选/全不选」 | fixed | shell |
| BUG-394 | 回溯表单日期默认空白——不基于库内已有数据给默认值 | fixed | engine+shell |
| BUG-395 | 下载列表端点混装进程级全局状态——`sources` 不是下载数据，`count` 还随查询参数变 | fixed | engine+shell |
| BUG-396 | 入库流水线「优先」状态可作用于已完成/已取消的任务 | fixed | engine+shell |
| BUG-397 | 频道展示的内容图片被截断（上下丢失） | fixed | shell |
| BUG-398 | 回溯表单无显式「关闭」入口（"无法关闭"） | fixed | shell |
| BUG-399 | 文件列表列头与行内容横向错位（"标题和内容完全不对齐"） | fixed | shell |
| BUG-400 | 文件页工具条信息架构错误（搜索/读数/排序位置） | fixed | shell |
| BUG-401 | 播放已缓存内容回跳仍重新拉流 —— `/stream` 无视 Range、无缓存验证头 | fixed | engine |
| BUG-402 | 验收脚本无分级与索引 —— 开发完成后陷入「未知流程处置」，验证耗时不可预期 | fixed | docs |
| BUG-411 | 集统计错误——多集视频未按区间计数、重叠未去重 | fixed | engine+shell |
| BUG-103 | 合并剧集丢失分集备用源，且孤儿行永久阻塞该条目再挂载 | fixed | engine |
| BUG-407 | 剧集合并逻辑错误——合并后剧集累加、视频集出错 | fixed | engine+shell |
| BUG-408 | 剧集合并保留/删除提示逻辑错误——标题/介绍/视频/图片三种处置混乱 | fixed | engine+shell |
| BUG-420 | 内容 hash 只覆盖 7.9% 的条目——`hash_file` 是死代码，「存量懒纳入」从未实现 | fixed | engine |
| BUG-421 | 旧库根搬迁漏改写 72 条 `file_path`——文件已在新根下，条目却永远播不了、也拿不到 hash | fixed | engine |

## 历史欠账

登记册建立之前的修复提交（19 条 `fix` 无 `BUG-<编号>`）在
`docs/bugs/ARCHIVE-pre-registry.md` 逐条对账。
