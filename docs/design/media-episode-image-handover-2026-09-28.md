# 交接文档：媒体库剧集详情页 · 图片展示与布局（2026-09-28）

> **交接对象**：下一个接手的 AI 会话。
> 本文档自包含：**不需要读取任何历史会话**，按「范围 → 事实 → 文件路径 → 待办」即可续作。
> 范围：`tauri-shell` 媒体库「剧集详情页」的**图片展示形态**。目前停在**静态原型阶段**（`verify_shots/`，ignored 不入库），**未动任何产品代码**。

---

## 0. 一句话现状

用户要的形态已收敛为：**左栏（总览 + 选集器）/ 右栏（单集显示与编辑）**，图片跑马灯要**「书页右侧翻」折叠效果（stacked deck）**；v3 静态页已实现并 24/24 验收通过，但用户最新反馈指出三处问题（见 §6），**下一步是改 v3 → v3.1，不是开新东西**。

---

## 1. 任务范围与边界

- **只做**：剧集详情页的图片展示（跑马灯/折叠效果）、横竖图适配、左右栏分工。
- **不做**：播放页、TG 抓取、入库链路、产品代码实现（拍板前不进 `tauri-shell/src/`）。
- 所有产出物在 `verify_shots/layout_v2/`、`verify_shots/layout_v3/`（`.gitignore` 覆盖，**不入库**）。

---

## 2. 用户需求演进（原话摘录，判据以原话为准）

1. 「剧集主图和整体图感觉可以合并成跑马灯…主图的横纵显示,现在纵图变成了裁剪,我觉得应该缩放嵌入的. 图的显示应该首推超出显示使用跑马灯模式.」
2. 「没有任何一集超过 1 张 这是错误收集导致的问题. TG图(某一集)->入库->进入剧集(成为主图) ! 实际是集图.」← **纠正了我此前的错误分析**
3. 「集图进入剧集问题不大,剧集进入集图(可以用户手动删除)问题感觉有,但应该也不大?」← 用户对图片错挂的态度：可容忍，可手动删
4. 「出静态浏览图,评估下. 有多个方案更好. 考虑中菜单,媒体库菜单,这些本身存在的情况.」← 要带真外壳（ContextBar + 媒体库左栏）
5. 「主图跑马灯要那种折叠效果的. 集选择应该在所有(剧集)的左栏,右边作为单集显示编辑」→ 追问确认：折叠效果 = **「书页右侧翻」**（专业名 stacked deck，层叠卡片）；左栏 = **总览 + 剧集选择**。
6. **最新（未处理）**：「你别说,这个接近了.但是**这点我要的只是右边的折叠效果**,你现在**都变形了,莫名的复杂化**. 还有**标题要控制好宽度 一行显示,超出处理.如果没法控制感觉就显示集**. **右边的显示就有问题了,和之前讨论的布局方案就完全不匹配了.**」

**诚实备注**：用户曾问「这不是之前定好的方案吗」——**左选右看形态从未写入 PRD、从未实现**，只在口头讨论出现过。PRD 定稿是另一形态（见 §7）。不要顺着说「早定好了」。

---

## 3. 图片数据模型（实测事实，改判据前先复核）

| 概念 | 真源字段 | 实测 |
|---|---|---|
| **集图** | `media_episode.item_id` → `media_item.poster` | 46/46 集全有（**这是主体，不是 `media_episode_image`**） |
| **剧集图** | `media_series.poster` 独立列 | S1/S2/S3 有值；S4/5/80/86/100/101 为 NULL。与任何集图指纹全不同 ⇒ 两类可各自独立存在 |
| **挂图** | `media_episode_image` 表 | 全库仅 5 行（ep 145/146/399/400/422 各 1 张），罕见 |
| coverItemId/coverKind | `list_series_filtered` 的 SQL 聚合派生（`media.rs:1432-1449`） | 是「**指认**」不是「拥有」 |

**方向实测**（推翻过一次早前判断，注意）：竖 **8** / 横 **46**（不是 27/25）。竖图只在 **S80（240×320、480×853）/ S101（480×853）** + 5 张挂图；S1–S3「码率阶梯」测试语料**全是 480×270 横图**。
⇒ **任何固定单向框形必伤一半**。v2/v3 的做法：`isPortrait(src)` 判定 → 竖图 `object-contain`（完整嵌入）、横图 `object-cover`，**fit 类必须互斥替换**（`object-cover object-contain` 并存时由样式表顺序决定，是坑）。

**画像分层**：剧集层 = 剧集图(0/1) + 各集集图（S1 = 15 帧）；单集层 = 集图(1) + 挂图(0..n)。多数单集只有 1 帧。

---

## 4. 外壳几何（实测，静态页必须复刻）

| 部件 | 宽/高 | 出处 |
|---|---|---|
| TitleBar | **40px** | `TitleBar.tsx:70`（非 Tailwind） |
| Sidebar（应用侧栏） | **192px**（折叠 48） | — |
| ContextBar（中菜单） | **48px** | `grid-cols-[1fr_auto_1fr]` |
| 媒体库左栏 | **208px**（`w-52`，纯文字、只分类+标签、无行图标） | — |
| 底栏 | **32px** | — |

- 媒体视图有两个左列 = **400px**；1900 窗内容区 ≈ 1500px；**900 最小窗（`tauri.conf.json:19 minWidth=900`）只剩 ≈ 500px**。
- 900px 下方案 T（v2）撑不住；v3 用 `.app.narrow` 单列退化，实测通过。

---

## 5. 产出物清单（全部在 `verify_shots/`，ignored 不入库）

### v2（`verify_shots/layout_v2/`）— 6 方案带真外壳
`index.html` / `styles.css` / `app.js` / `data.json`（真实库导出）/ `shoot.cjs`。方案 P/Q/R/T/U/V，18/18 PASS。
关键函数：`poster(src,cls,shape,mode)`（fit 互斥）、`seriesFrames(s)`、`episodeFrames(ep)`、`reel(frames,…)`（横向跑马）、外壳 `shellHtml()`。
**v2 的左栏做成了「剧集概览」而非选集器 —— 形态被用户否定，被 v3 取代**；但其 `data.json` 与外壳几何仍被 v3 复用。

### v3（`verify_shots/layout_v3/`）— 当前工作区 ★
| 文件 | 说明 |
|---|---|
| `data.json` | 复制自 v2，真实库导出 |
| `index.html` | 入口，4 方案切换按钮 W/X/Y/Z |
| `styles.css` | 358 行；v2 基础 + `.deck/.deck-card/.deck-count` + `.md/.md-left/.md-list/.md-ep/.md-right/.md-edit-grid` + 末尾 `.app.narrow` 窄屏退化 |
| `app.js` | `deckBlock(frames,{w,h,maxW,peek})` ≈160 行；`leftPane` ≈186；`rightPane` ≈222；`renderW` ≈283；`renderX` ≈293；`renderY` ≈327；`renderZ` ≈361；`bindPicks` 绑 `[data-pick]` → `S.focusEpisodeId`；状态 `S={variant,seriesId,shell,narrow,focusEpisodeId}` |
| `deck.js` | 书页翻交互：`initDecks` 读 `data-peek`（不硬编码）；`visible=min(n,6)`；点左半 prev / 右半 next；计数 `h+1 / n`；`transform-origin:left center` |
| `shoot.cjs` | 24 断言 + 2 反向证伪（仅内容区 `.side` 必须消失；死端口 59999 必须无 stage） |
| 截图 | `v3_W_S1_full.png`、`v3_W_S1_deck_flipped.png`（计数 1/15→2/15）、`v3_W_S101_portrait.png`（竖图 contain 无裁剪，`cover:0`）、`v3_W_S1_narrow.png`（900px 单列）、`v3_X/Y/Z_S1_full.png` |

**deckBlock 宽度约束（踩过坑）**：总宽**固定不随帧数增长**——`visible=min(n,6)`，`p=max(8, min(peek, round((maxW-w)/max(1,visible-1))))`。初版 `left=i*peek` 让 S1 的 15 帧×30px=450px 撑破 340px 左栏。
调用参数：左栏剧集级 `{w:288,h:162,maxW:316,peek:10}`（app.js ≈204 行）；X 折叠态 ≈312 行；右栏单集级 `{w:isP?170:300,h:isP?302:169,maxW:420,peek:26}`（≈236/338/372 行）。

---

## 6. ★ 最新用户反馈 = 下一个 AI 的第一件事（未开始）

用户原话（见 §2 第 6 条），拆成三个待办：

1. **折叠效果只保留在右栏**。「我要的只是右边的折叠效果,你现在都变形了,莫名的复杂化」——v3 把 deck 同时放在了左栏（剧集级）和右栏（单集级）。**改法**：左栏撤掉 `deckBlock`（app.js ≈204 行），换静态主图或普通展示；deck 只留右栏单集图组。X/Y/Z 变体若因此失去对比意义可精简。注：「变形」也可能指 deck 固定宽高导致图片观感变形，改时顺带核查 img 的 fit。
2. **标题单行 + 超出处理**。「标题要控制好宽度 一行显示,超出处理. 如果没法控制感觉就显示集」——右栏 `.md-right-h h3`、左栏 `.md-ep .tt` 等加 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` + `max-width`；若长标题控制不住就降级显示集号（如 `S1E3`）。
3. **右栏布局与「之前讨论的布局方案」不匹配**。用户没具体说哪里不匹配。**最可能的读法**：右栏当前堆了五大块（图组/介绍/多源/编辑表单/操作），与「右边作为单独集**显示**」的原始表述（§2 第 5 条）不符——信息过载。**动手前先与用户核对右栏到底该有哪些块，不要自猜重排**（本次会话已因自作主张被纠偏两次）。
4. 改完**重跑 `shoot.cjs`**：左栏 deck 相关断言要随改动迁移到右栏；断言数会变，不追求保持 24。

---

## 7. PRD / 设计文档状态（拍板项的锚点）

- **PRD 定稿（现状）**：`docs/design/media-library-layout-prd-2026-09-28.md` §3.1「两区一态」= **全剧概览区（常驻）+ 分集序列区（行态/展开态手风琴 ≤1 集）**，纵向堆叠。**≠ 左选右看**。§2.3 流程图 91-93 行的「分集侧栏选集」是**播放页**语境，别混淆。
- **设计文档**：`docs/design/media-library-layout-design-2026-09-28.md` §3.0 五方案对比（**方案 A 12/12 全绿、已采用**）；§3.1.1 海报宽高比硬规则 R-A/R-B/R-C；TL-1~TL-23 任务表（TL-15 涉及播放页 `EpisodeList` 侧栏）。
- **待拍板**：若用户确认采用 W（左选右看），需**回写 PRD §3.1**再进实现；PRD 与新形态冲突点要显式列出。

---

## 8. 验收方法（复现命令）

headless Edge + CDP，服务与脚本**必须同一次 Bash 调用内**起：

```bash
D="D:/workspace/project/golang/origadmin/framework/projects/orig-hub/verify_shots/layout_v3"
python -m http.server 8099 --bind 127.0.0.1 --directory "$D" >/dev/null 2>&1 &
SRV=$!; sleep 1.5
curl -s --noproxy '*' -o /dev/null -w "pre=%{http_code}\n" http://127.0.0.1:8099/index.html
node "$D/shoot.cjs" 2>&1 | tail -40
kill $SRV 2>/dev/null
```

判据口径：
- 读 **`getComputedStyle`**，不读 className；UI 断言锚在 `[data-testid]` / `data-*` 属性，不用位置下标。
- **反向证伪必做**（改错地址必须 FAIL，否则断言假绿）；验证脚本自身也要反向证伪。
- **`curl 200` 什么都不能证明**；白屏是最核心失败模式，绝不许报成「环境问题」。
- 端口：daemon 18760 / tg 18761 / 前端 5180 / CDP 9222 / 对比页 8099。

---

## 9. 环境坑（本机实测，必读）

- **`&` 起的后台服务随 Bash 调用返回被回收** → 服务与 harness 同一次调用内起；`cmd & SRV=$!` 会切断后续 `&&` 链的 cwd → node/python 一律**绝对路径**（python 用 `--directory <abs>`）。
- headless Edge 必须 `run_in_background` 起，`--remote-debugging-port=9222`；新标签页用 `PUT /json/new?<url>` 再 attach。
- `npm run dev` 只起前端 5180 **不拉后端**；联调需手动起 `orig-daemon.exe`(9876)/`orig-tg.exe`(9877)。`ORIG_TG_OFFLINE=1` 是调试态不是产品态。
- **git monorepo 陷阱**：在 `orig-hub/` 下跑 git 实际操作的是外层 `framework/.git`；提交信息**全英文 + LF**，`fix` 必须引用 `BUG-<编号>`；**所有 git 钩子恒不执行**（BUG-158，open）→ 规则靠自觉遵守。
- 一次性脚本/dump 不入库；`verify_shots/` 已 ignore。

---

## 10. 用户偏好与协作铁律

- **「我不看方案,只看结果」**——汇报给实测数字与可复核证据，不铺方案让用户选。
- **保留所有数据是核心需求**；不删除，多出来错出来的都不能删。
- **实现约束 ≠ 产品信息**（BUG-148）；**重构不是删能力的授权**（BUG-149）——撤入口/能力前查验收档案。
- **诚实边界**：没记录就说没记录，不许假装修好；本轮已因表述让用户误解过一次（「这不是之前定好的方案吗」），第二次被纠偏是「都变形了,莫名的复杂化」。
- **动手前先与用户核对**，不要自猜产品判断；一次交付待拍板项 ≤3 条。
- 验收断言不许改断言迁就实现（改断言 = 伪造验收）。

---

## 11. 待拍板项（移交时状态）

1. **形态**：采用 W（左选右看）并回写 PRD，还是维持 PRD 方案 A？——用户说「接近了」，倾向 W，但**未拍板**。
2. **右栏内容构成**：等用户核对（§6 第 3 条）。
3. **窄屏策略**：900px 单列退化（已实现）vs 规定媒体视图最小宽度 —— 未拍板，不阻塞。

---

## 12. 仓库杂项（背景，不阻塞）

- `docs/design/*.md` 与 `docs/bugs/BUG-172/173/174.md` 未跟踪待入库；BUG-158（钩子不执行）open。
- 记忆文件：`.workbuddy-ai/memory/2026-09-28.md`（当日全过程）、`MEMORY.md` §十一/十二/十三（图片数据模型、外壳几何、后台服务与验收铁律）。
