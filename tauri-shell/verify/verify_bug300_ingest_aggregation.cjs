'use strict'

/**
 * BUG-300 · M3 —— 下载域的 TG 入库：**按内容对象聚合**，不是按任务记录平铺。
 *
 * 用户复报（2026-10-15）：「现在针对的是个体而不是笼统的数据，合并显示的实现是
 * 完全错误的……也可以看做和 BT 文件夹下载一样，但是这个度没有控制好。」
 *
 * 判据（BT 类比推到底）：
 *   种子 = 顶层行（一批内容）  /  文件 = 展开明细（每集消息）
 *   重复下载同一内容 ⇒ 合并为一个种子，不是一行一个文件。
 *
 * 数据现实（只读取证，非夹具）：`cache_task` 137 条记录只对应 **104 个唯一
 * `itemKey`**，最多的键重复 7 次。故：
 *   - 顶层行数 **必须等于** 104（不是 137）—— 证明合并真的发生了；
 *   - 历史批次折叠进底部明细 Sheet（DLU-T01：「共 N 次」徽标 + Sheet 内历史清单；
 *     2026-10-16 用户裁定「改用底部弹出」——行内展开打穿窗口化 estimate 已废除）；
 *   - 顶部给**概览口径**（在传 / 待处理 / 已完成 / 已取消的对象数）= 「笼统的数据」。
 *
 * 断言共 43 条，分九组：源码锚点 13（含 BUG-320 复报「明细入口按钮不存在」/ BUG-315 条目级下载接线）/
 * 接口 9（orig-tg /all + daemon /api/activity 双真源，含 chatId/messageIds/priority 转发无损）/
 * UI 挂载 1 / 聚合 5 / 概览 1 / 明细 4（含运行期「明细按钮 0 个」）/
 * 补齐能力 8（去媒体库查看 / 优先下载 / 取消记录可见 / 端到端起播 / BUG-318 可用性感知）/
 * 反证 2 / 运行期 1。
 *
 * 2026-10-15 二次复报（用户五条逻辑问题）后本脚本覆盖：
 *   ① 下载中的 TG 没有状态控制 ⇒ 动作按钮常驻可见（hover 不显形）；
 *   ② 图片/视频混用「集」⇒ 引擎侧回归 video-only（另见 orig-tg 单测与 BUG-300.md）；
 *   ③ 取消后记录消失 ⇒ 记录留在「全部」档 + 概览「已取消」计数（BUG-314 已撤销
 *     曾越权增设的「已取消」独立树档 —— 用户诉求是记录可见，不是新导航位）；
 *   ④ 入库流水线没有跳转查看 ⇒ 「去媒体库查看」（by-ref 起播 + 落媒体库）；
 *   ⑤ 流水线功能应搬到下载域 ⇒ 优先下载 / 取消优先 / 优先徽标一并补齐。
 *
 * 2026-10-15 四次复报（「展开/收缩根本看不到，展开内容下载、停止、控制」）后覆盖：
 *   - BUG-320：明细入口必须是真 button（aria-expanded + 「明细 N」文案），
 *     反向锚点 = 装饰性 `▸`/`▾` span 形态不得存在；
 *   - BUG-315：条目级「下载」接线（单条入队 + 后端幂等），且**不提供**条目级停止。
 *   这两条另有独立活栈脚本 verify_bug320_expand_toggle.cjs（11 断言，含双向验牙）。
 *
 * 2026-10-20 三次明确（用户：「明细按钮删除没有修复，原因是什么？明确过 3 次了」）：
 *   前两轮（10-16 改样式/位置、10-19 只删条目级下载按钮）都**没删**这个入口按钮。
 *   本轮删除 `ingest-group-toggle`，Sheet 唯一入口回归折叠头整块；判据随之翻转为
 *   「按钮 0 个」（源码锚 + 运行期 DOM 计数双验），换形态长回来必须红。
 *
 * 2026-10-16 五次复报（「明细按钮位置样式有问题，随 mock 那条改用底部弹出」）适配：
 *   明细从行内展开改为底部弹出 Sheet（DLU-T01）——条目/历史/下载按钮 testid
 *   迁至 ingest-sheet-*，运行时「点开首行」改点折叠头开 Sheet；合并样本点开前
 *   先关首个 Sheet（行各自 sheetOpen，双 Sheet 同开会干扰历史计数）。
 *
 * 用法：node tauri-shell/verify/verify_bug300_ingest_aggregation.cjs
 *   （需 vite :5180 + orig-daemon :19786 + orig-tg :19787 在跑；
 *     产物落 verify_shots/bug300-ingest-aggregation/）
 *
 * 2026-10-16 BUG-316 段②适配：入库组行改窗口化渲染（dl-group-list 挂
 * data-total 契约，DOM 只渲染视口 ± overscan 行）。全列断言（行数/状态集/
 * Σruns/动作结构/cancelled 计数）改走 __collectAll 滚动累积集（按 data-key
 * 去重，收集数 == data-total ⇒ 不丢行不多渲染）；合并样本行用 __revealKey
 * 滚进视口后再点折叠头。窗口化被拆掉（全量渲染）时的性能回归由
 * verify_bug316_segment2_render.cjs 的反向证伪拦截。
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT =
  process.env.ORIG_SHOT_OUT ||
  path.resolve(ROOT, 'verify_shots', 'bug300-ingest-aggregation')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
/**
 * orig-tg 基址**运行时解析**（BUG-178 纪律，与前端同口径）：端口以 daemon
 * `/api/config` 的 `tg_port` 为真源 —— 19787 绑不上时 orig-tg 会顺延（如 19788），
 * 硬编码 19787 的脚本会在顺延后全部打空。`VERIFY_TG_BASE` 仍可显式覆盖。
 */
async function resolveTgBase() {
  if (process.env.VERIFY_TG_BASE) return process.env.VERIFY_TG_BASE
  try {
    const cfg = await (await fetch(`${DAEMON}/api/config`)).json()
    return `http://127.0.0.1:${cfg.tg_port || 19787}`
  } catch {
    return 'http://127.0.0.1:19787'
  }
}

const SRC = {
  panel: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'DownloadPanel.tsx'),
    'utf8',
  ),
  groups: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'ingestGroups.ts'),
    'utf8',
  ),
  row: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'IngestGroupRow.tsx'),
    'utf8',
  ),
  sheet: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'IngestDetailSheet.tsx'),
    'utf8',
  ),
  layout: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'shell', 'MainLayout.tsx'),
    'utf8',
  ),
  hook: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'useIngestGroups.ts'),
    'utf8',
  ),
  golibrary: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'hooks', 'useGoLibrary.ts'),
    'utf8',
  ),
  sidebar: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'shell', 'Sidebar.tsx'),
    'utf8',
  ),
  nav: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'nav', 'index.ts'),
    'utf8',
  ),
}

let failures = 0
/** 断言计数纪律：下面的调用点数即最终 N，不凭记忆写。 */
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const T = {
  navDownload: 'nav-download',
  navChildDl: 'nav-child-dl',
  navChildLibSeries: 'nav-child-lib-series',
  sourceFilter: 'dl-source-filter',
  sourceAll: 'dl-source-all',
  sourceDownload: 'dl-source-download',
  overviewTotal: 'dl-overview-total',
  overviewCancelled: 'dl-overview-cancelled',
  // BUG-366：来源切片与概览撤除后，面板挂载锚改用这三个仍存在的契约元素之一
  ingestGroupRow: 'ingest-group-row',
  downloadItem: 'download-item',
  dlEmpty: 'dl-empty',
  row: 'ingest-group-row',
  name: 'ingest-group-name',
  progress: 'ingest-group-progress',
  runs: 'ingest-group-runs',
  entries: 'ingest-sheet-entries',
  entry: 'ingest-sheet-entry',
  // BT 式选择（2026-10-19 用户裁定）：逐条「下载」按钮已移除，改为复选框 + 批量动作
  entryCheckbox: 'ingest-sheet-entry-checkbox',
  selectAll: 'ingest-sheet-select-all-box',
  bulkBar: 'ingest-sheet-bulk-bar',
  bulkDownload: 'ingest-sheet-download-selected',
  sheet: 'ingest-detail-sheet',
  sheetClose: 'ingest-detail-sheet-close',
  header: 'ingest-group-header',
  history: 'ingest-sheet-history',
  historyItem: 'ingest-sheet-history-item',
  actions: 'ingest-group-actions',
  golibrary: 'ingest-group-golibrary',
  prioritized: 'ingest-group-prioritized',
  viewer: 'media-viewer',
  tgDown: 'dl-tg-unavailable',
}

/**
 * 页面内 helper：每次导航后是新 document，必须重新注入。
 *
 * 走**函数**而非字符串：`evaluate` 会把字符串包成 `return (<expr>)`，多语句的
 * helper 会被 `;` 打断。testid 以**参数**传入 —— 函数体在页面端执行，
 * 拿不到 Node 端的 `T`，插值须在页面端用模板字符串完成。
 */
const installHelpers = (page) =>
  page.evaluate(
    (rowSel, nameSel, progSel, runsSel) => {
      const w = window
      const attr = (el, a) => el.getAttribute(a) || ''
      const txt = (sel) => {
        const n = document.querySelector(sel)
        return n ? (n.textContent || '').trim() : ''
      }
      w.__q = (sel) => Array.from(document.querySelectorAll(sel))
      w.__rows = () =>
        w.__q(rowSel).map((el) => ({
          key: attr(el, 'data-key'),
          status: attr(el, 'data-status'),
          runs: Number(attr(el, 'data-runs') || '1'),
          name: txt(nameSel),
          progress: txt(progSel),
          runsLabel: txt(runsSel),
        }))
      /**
       * 滚动全程累积所有入库行（BUG-316 段② 窗口化适配）。
       * 窗口化下 DOM 只渲染视口 ± overscan 行；「顶层行数 == 唯一 itemKey 数」
       * 等**全列**断言改为：滚到底逐步收集（按 data-key 去重，含行结构），
       * 收集数必须 == 容器 data-total（契约）。
       */
      w.__collectAll = async () => {
        const scroll = document.querySelector('[data-testid="dl-group-list"]')
        if (!scroll) return { ok: false }
        const seen = new Map()
        const collect = () => {
          for (const el of w.__q(rowSel)) {
            const key = attr(el, 'data-key')
            if (!key || seen.has(key)) continue
            const has = (s) => !!el.querySelector(s)
            seen.set(key, {
              key,
              status: attr(el, 'data-status'),
              runs: Number(attr(el, 'data-runs') || '1'),
              goLib: has('[data-testid="ingest-group-golibrary"]'),
              prefer: has('[data-testid="ingest-group-action-prefer"]'),
              unprefer: has('[data-testid="ingest-group-action-unprefer"]'),
              retry: has('[data-testid="ingest-group-action-retry"]'),
              cancel: has('[data-testid="ingest-group-action-cancel"]'),
              prioritized: has('[data-testid="ingest-group-prioritized"]'),
            })
          }
        }
        const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)))
        collect()
        for (let i = 0; i < 400; i += 1) {
          if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) break
          scroll.scrollTop = Math.min(
            scroll.scrollTop + Math.max(300, scroll.clientHeight - 120),
            scroll.scrollHeight,
          )
          await frame()
          collect()
        }
        collect()
        return {
          ok: true,
          total: Number(scroll.getAttribute('data-total') || NaN),
          count: seen.size,
          rows: Array.from(seen.values()),
        }
      }
      /** 把指定 key 的行滚进视口（窗口化后目标行可能不在 DOM 里）。 */
      w.__revealKey = async (key) => {
        const scroll = document.querySelector('[data-testid="dl-group-list"]')
        if (!scroll) return false
        const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)))
        for (let i = 0; i < 400; i += 1) {
          const el = document.querySelector(rowSel + '[data-key="' + key + '"]')
          if (el) {
            el.scrollIntoView({ block: 'start' })
            await frame()
            return true
          }
          if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) break
          scroll.scrollTop = Math.min(
            scroll.scrollTop + Math.max(300, scroll.clientHeight - 120),
            scroll.scrollHeight,
          )
          await frame()
        }
        return false
      }
      /** 入库列表滚回顶部（collectAll 后复位首屏语境；等一帧让窗口化重渲染）。 */
      w.__scrollTop = async () => {
        const el = document.querySelector('[data-testid="dl-group-list"]')
        if (!el) return false
        el.scrollTop = 0
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)))
        return true
      }
      w.__click = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return false
        el.click()
        return true
      }
      w.__exists = (sel) => !!document.querySelector(sel)
      w.__count = (sel) => document.querySelectorAll(sel).length
      w.__text = (sel) => txt(sel)
    },
    `[data-testid="${T.row}"]`,
    `[data-testid="${T.name}"]`,
    `[data-testid="${T.progress}"]`,
    `[data-testid="${T.runs}"]`,
  )

/** 与前端同口径的聚合（BUG-318 后）：同 `itemKey` **有活跃取最新活跃**，否则取最新。
 * 与 `ingestGroups.groupIngestTasks` 逐字同源 —— 两边规则分裂就会一个显示排队中、
 * 另一个说已完成（旧的「纯取最新」在终态行被 bump updated_at 后会掩蔽活跃任务）。 */
function aggregate(tasks) {
  const byKey = new Map()
  for (const t of tasks) {
    const key = (t.itemKey || '').trim() || `tg:${t.id}`
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, t)
      continue
    }
    const active = (x) => x.status === 'queued' || x.status === 'running'
    // 活跃永远压过终态（不论新旧）；同级比 updatedAt，再比 id。
    if (active(t) !== active(cur)) {
      if (active(t)) byKey.set(key, t)
      continue
    }
    if (
      t.updatedAt > cur.updatedAt ||
      (t.updatedAt === cur.updatedAt && t.id > cur.id)
    ) {
      byKey.set(key, t)
    }
  }
  return byKey
}

async function main() {
  // orig-tg 基址运行时解析（BUG-178）：端口可能顺延，以 daemon /api/config 为真源
  const TG = await resolveTgBase()
  // ── ①-④ 源码锚点 ────────────────────────────────────────────────────
  const groupsOk =
    /export function groupIngestTasks\(/.test(SRC.groups) &&
    /export function summarizeGroups\(/.test(SRC.groups) &&
    /export function ingestActionsFor\(/.test(SRC.groups)
  check('源码：ingestGroups.ts 提供聚合 / 概览 / 动作三个纯函数', groupsOk)

  const rowOk =
    new RegExp(`data-testid="${T.row}"`).test(SRC.row) &&
    /getCacheTaskItems\(/.test(SRC.sheet)
  check(`源码：IngestGroupRow 挂 ${T.row} 且明细 Sheet 拉组清单（getCacheTaskItems 在 Sheet 内懒加载）`, rowOk)

  const panelOk =
    /ingest: UseIngestGroupsResult/.test(SRC.panel) &&
    new RegExp(`data-testid="${T.sourceFilter}"`).test(SRC.panel) &&
    new RegExp(`data-testid="${T.overviewTotal}"`).test(SRC.panel)
  check('源码：DownloadPanel 收 ingest、渲染来源切片与概览', panelOk)

  // 单一轮询点：壳体拉、面板收。两处各拉一份 = 轮询两次 + 两个时刻的状态
  // ⇒ 「徽标数 ≠ 点进去的条数」（BUG-082 三处同源纪律）。
  // 2026-10-16 门控锚点：MainLayout 的调用必须带 `view === 'download'`
  // （用户裁定「不在其位不谋其政」—— 非下载域不拉 /api/activity）；
  // 门控被拆掉（enabled 恒 true）时本锚点即红。
  const singleSource =
    /useIngestGroups\([^)]*view === 'download'/.test(SRC.layout) &&
    !/useIngestGroups\(/.test(SRC.panel)
  check('源码：单一轮询点 = MainLayout（DownloadPanel 不自拉；带视图在场门控）', singleSource)

  // ── ①-d 补齐能力锚点（2026-10-15 二次复报的五条逻辑问题）──────────────
  // 动作按钮的 testid 由模板生成（`ingest-group-action-${a}`），源码里不会有
  // 字面量；可锚定的是**判定点**——必须按 (status, priority) 两个参数判，
  // 只传 status 的旧签名判不出「已优先 ⇒ 可取消优先」。
  const rowActsOk =
    new RegExp(`data-testid="${T.golibrary}"`).test(SRC.row) &&
    new RegExp(`data-testid="${T.prioritized}"`).test(SRC.row) &&
    /ingestActionsFor\(latest\.status, latest\.priority/.test(SRC.row)
  check(
    '源码：IngestGroupRow 有去媒体库查看 / 优先徽标，动作按 (status, priority) 判定',
    rowActsOk,
  )
  const panelWireOk =
    /useGoLibrary\(/.test(SRC.panel) &&
    /onGoLibrary=/.test(SRC.panel) &&
    /onOpenMedia/.test(SRC.panel)
  check('源码：DownloadPanel 接线 useGoLibrary / onGoLibrary / onOpenMedia', panelWireOk)
  // 定位坐标与优先级必须**原样透传**（上一版写死 chatId:0 / messageIds:[]，
  // 导致「去媒体库查看」拿不到 ref、优先下载永远显未优先）。
  const passthruOk =
    /chatId: t\.chatId \?\? 0/.test(SRC.hook) &&
    /messageIds: t\.messageIds/.test(SRC.hook) &&
    /priority: t\.priority/.test(SRC.hook)
  check('源码：toCacheTask 透传 chatId / messageIds / priority（不写死）', passthruOk)
  // BUG-314 撤档锚点：侧栏下载树**不得**再有「已取消」独立档（2026-10-15 曾越权
  // 增设），`DlFilter` 恰为四项（all/running/paused/done）。三项否定断言 + 一项
  // 肯定断言，少任一项都能被「换个写法又加回去」蒙混。
  const noCancelledBucketOk =
    !/cancelled: 'download\.cancelled'/.test(SRC.sidebar) &&
    !/counts\.cancelled/.test(SRC.sidebar) &&
    !/case 'cancelled':/.test(SRC.groups) &&
    /DL_FILTERS: readonly DlFilter\[\] = \['all', 'running', 'paused', 'done'\]/.test(SRC.nav)
  check(
    '源码（BUG-314）：侧栏/树档无「已取消」独立档，DL_FILTERS 恰四项',
    noCancelledBucketOk,
  )
  // 撤档不撤记录：可见性改由既有标准化机制承担 —— 「全部」档保留 cancelled 行，
  // 概览「已取消」计数保留（两处缺一即「记录不可见/不可数」复现）。
  const retentionOk =
    /d\.status === 'cancelled'/.test(SRC.panel) &&
    /overview\.cancelled/.test(SRC.panel) &&
    /o\.cancelled \+= 1/.test(SRC.groups)
  check(
    '源码（BUG-314）：取消记录由「全部」档承载 + 概览「已取消」计数保留',
    retentionOk,
  )
  // BUG-318 锚点（下载域数据丢失）：**取不到 ≠ 没有**。hook 必须读 `/api/activity`
  // 的 `sources`——orig-tg 不可用时端点恒 200 但 cache 零条，只读 tasks 就会把
  // 「取不到」渲染成「暂无传输任务」（无 banner、行全消、停轮后不自动回血）。
  // 聚合层代表任务必须「有活跃取最新活跃」——终态行被「取消优先」bump
  // updated_at 后，更早的活跃任务会被掩蔽进 history（下载中档看不到、无取消按钮）。
  const sourcesOk =
    /data\?\.sources/.test(SRC.hook) &&
    /s\.kind === 'cache'/.test(SRC.hook) &&
    /available === false/.test(SRC.hook) &&
    /sourceUnknown/.test(SRC.hook) &&
    /\|\| sourceUnknown\.current/.test(SRC.hook) &&
    /const active = sorted\.filter/.test(SRC.groups) &&
    /active\[0\] : sorted\[0\]/.test(SRC.groups)
  check(
    '源码（BUG-318）：读 sources 可用性（取不到不清空 + 未知态续轮）；聚合代表=最新活跃',
    sourcesOk,
  )
  // BUG-320 复报（2026-10-20 用户第三次明确「明细按钮删除」）：入口按钮**不得存在**
  // （`ingest-group-toggle`、「明细 N」文案、Chevron 都不许回来），Sheet 的唯一入口
  // 是折叠头整块（`ingest-group-header` 的 onClick）。前两次只改样式/位置、只删
  // 旁边的条目级按钮 ⇒ 诉求没被满足，所以这里的判据是「不存在」而不是「换了形态」。
  // 明细仍必须走**底部 Sheet**（2026-10-16 用户裁定）：条件渲染 IngestDetailSheet、
  // onClose 回关 sheetOpen；行内展开面板（ingest-group-panel）必须不存在 ——
  // 行内展开会打穿窗口化列表的 estimate（BUG-316 段②），被拆回 inline 必须红。
  const toggleOk =
    !/ingest-group-toggle/.test(SRC.row) &&
    !/`明细 \$\{latest\.total\}`/.test(SRC.row) &&
    /data-testid="ingest-group-header"/.test(SRC.row) &&
    /onClick=\{\(\) => setSheetOpen\(true\)\}/.test(SRC.row) &&
    /sheetOpen && \(/.test(SRC.row) &&
    /<IngestDetailSheet[\s\S]{0,300}onClose=\{\(\) => setSheetOpen\(false\)\}/.test(SRC.row) &&
    !/'收起'/.test(SRC.row) &&
    !/ingest-group-panel/.test(SRC.row)
  check(
    '源码（BUG-320 复报）：明细入口按钮不存在（折叠头整块是唯一入口），明细走底部 Sheet 条件渲染，无行内展开面板',
    toggleOk,
  )
  // BT 式选择（2026-10-19 用户裁定「下载明细不需要按钮,只需要选择,只有选中的
  // 才下载」）：Sheet 内逐条「下载」按钮已整体移除；判据改为缺字节条目带复选框、
  // 头部全选、底部批量动作仅宿主接线时渲染；且**没有**条目级停止按钮（传输最小
  // 单位是任务，假按钮必须不存在）。
  const entryCtlOk =
    /data-testid="ingest-sheet-entry-checkbox"/.test(SRC.sheet) &&
    /downloadable && \(/.test(SRC.sheet) &&
    /data-testid="ingest-sheet-select-all-box"/.test(SRC.sheet) &&
    /data-testid="ingest-sheet-download-selected"/.test(SRC.sheet) &&
    /onDownloadSelected && manifest && \(/.test(SRC.sheet) &&
    /onDownloadSelected=\{onDownloadSelected\}/.test(SRC.row) &&
    /onDownloadSelected=\{\(chatId, messageIds\)/.test(SRC.panel) &&
    /enqueueCacheTask\(\{ chatId, messageIds: \[messageId\] \}\)/.test(SRC.panel) &&
    !/data-testid="ingest-sheet-entry-download"/.test(SRC.sheet) &&
    !/onEntryDownload/.test(SRC.sheet + SRC.row + SRC.panel)
  check(
    '源码（BT 式选择）：缺字节条目复选框 + 全选 + 批量「下载选中」，逐条下载按钮与旧 prop 已移除',
    entryCtlOk,
  )
  // 共享 hook：两个宿主同一份实现（漂移 = 一个能跳另一个跳错）。
  const sharedHookOk =
    /findMediaItemIdByRef\('tg', ref\)/.test(SRC.golibrary) &&
    /setPendingMediaFocus\(ref\)/.test(SRC.golibrary) &&
    /openViewer\(/.test(SRC.golibrary) &&
    /useGoLibrary/.test(
      fs.readFileSync(
        path.join(ROOT, 'tauri-shell', 'src', 'components', 'CacheManagerDialog.tsx'),
        'utf8',
      ),
    )
  check('源码：useGoLibrary 为缓存面板与下载域共用（by-ref + 焦点 + 起播一份实现）', sharedHookOk)

  if (!groupsOk || !rowOk || !panelOk || !singleSource) {
    throw new Error('源码锚点缺失，运行时断言全部作废')
  }
  if (
    !rowActsOk ||
    !panelWireOk ||
    !passthruOk ||
    !noCancelledBucketOk ||
    !retentionOk ||
    !sourcesOk ||
    !toggleOk ||
    !entryCtlOk ||
    !sharedHookOk
  ) {
    throw new Error('补齐能力锚点缺失，运行时断言全部作废')
  }

  // ── ⑤-⑥ 接口断言（真实 orig-tg）──────────────────────────────────────
  const res = await fetch(`${TG}/api/tg/cache/tasks/all`)
  check('接口：GET /api/tg/cache/tasks/all → HTTP 200', res.status === 200, `status=${res.status}`)

  const payload = await res.json()
  const apiTasks = Array.isArray(payload?.tasks) ? payload.tasks : []
  check(
    '接口：任务记录数 > 0（断言非空跑）',
    apiTasks.length > 0,
    `records=${apiTasks.length}`,
  )

  const byKey = aggregate(apiTasks)
  const expectStatuses = [...byKey.values()].map((t) => t.status).sort().join(',')

  // ── ⑤-b 聚合入口断言（2026-10-15 复报后切回 daemon /api/activity 作为单一聚合入口）──
  // 该端点必须**下发 groupKey**，且 groupKey 集合 == orig-tg `itemKey` 集合 ——
  // 否则前端按 groupKey 合并会与「按 itemKey 直连」两处口径分裂（BUG-300 复报的根因）。
  const actRes = await fetch(`${DAEMON}/api/activity?scope=all`)
  check(
    '接口：GET /api/activity?scope=all → HTTP 200',
    actRes.status === 200,
    `status=${actRes.status}`,
  )
  const act = await actRes.json().catch(() => null)
  const actCache = Array.isArray(act?.tasks) ? act.tasks.filter((t) => t.kind === 'cache') : []
  check(
    '接口：/api/activity 的 cache 任务数 == /all 记录数（同一真源，未丢未重）',
    actCache.length === apiTasks.length,
    `activity=${actCache.length} all=${apiTasks.length}`,
  )
  const allHaveKey =
    actCache.length > 0 &&
    actCache.every((t) => typeof t.groupKey === 'string' && t.groupKey.length > 0)
  check('接口：每个 cache 任务都带非空 groupKey（合并键已下发）', allHaveKey)
  const actKeys = new Set(actCache.map((t) => t.groupKey).sort())
  const allKeys = new Set(apiTasks.map((t) => (t.itemKey || '').trim()).filter(Boolean))
  const sameKeys =
    actKeys.size === allKeys.size && [...actKeys].every((k) => allKeys.has(k))
  check(
    '接口：/api/activity 的 groupKey 集合 == /all 的 itemKey 集合（两处去重键同口径）',
    sameKeys,
    `activity=${actKeys.size} all=${allKeys.size}`,
  )

  // ── ⑤-c 定位坐标 / 优先下载字段转发（2026-10-15 二次复报）──────────────
  // 「去媒体库查看」要 ref={chat}:{msg}（相册/批量组的 itemKey 给不出 msg），
  // 「优先下载」要 priority —— 两者只能来自 orig-tg 任务载荷，聚合层必须转发。
  const fieldsOk =
    actCache.length > 0 &&
    actCache.every(
      (t) =>
        Array.isArray(t.messageIds) &&
        typeof t.priority === 'number' &&
        (t.chatId === undefined || t.chatId === null || typeof t.chatId === 'number'),
    )
  check(
    '接口：每个 cache 任务都带 messageIds 数组与 priority 数值（跳转/优先下载的原料已下发）',
    fieldsOk,
  )
  // 转发**无损**：按任务 id 逐条比对 /all 与 /api/activity 的三个字段。
  const allById = new Map(apiTasks.map((t) => [String(t.id), t]))
  const fwdMismatch = actCache.filter((t) => {
    const src = allById.get(String(t.control?.native_id))
    if (!src) return true
    return (
      (t.chatId ?? null) !== (src.chatId ?? null) ||
      JSON.stringify(t.messageIds ?? []) !== JSON.stringify(src.messageIds ?? []) ||
      (t.priority ?? 0) !== (src.priority ?? 0)
    )
  })
  check(
    '接口：chatId/messageIds/priority 与 orig-tg /all 逐条一致（聚合层转发无损）',
    fwdMismatch.length === 0,
    `mismatch=${fwdMismatch.length}/${actCache.length}`,
  )
  // 下载侧**诚实缺省**：没有 TG 频道却下发 chatId=0，前端会拿 0 拼出
  // `ref="0:123"` 查到别人的频道上去 —— 这是「不造假」判据的反向一面。
  const actDownload = Array.isArray(act?.tasks) ? act.tasks.filter((t) => t.kind === 'download') : []
  const dlHonest = actDownload.every(
    (t) =>
      (t.chatId === undefined || t.chatId === null) &&
      Array.isArray(t.messageIds) &&
      t.messageIds.length === 0 &&
      t.priority === 0,
  )
  check(
    '接口：下载侧任务三项诚实缺省（无 chatId / 空 messageIds / priority=0）',
    dlHonest,
    `downloadTasks=${actDownload.length}`,
  )

  // ── ⑦-⑭ UI 断言（真实渲染 + 截图）────────────────────────────────────
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    await installHelpers(page)

    const clickedNav = await page.evaluate(
      (sel) => window.__click(sel),
      `[data-testid="${T.navDownload}"]`,
    )
    await page.waitForFunction(
      (sels) => sels.some((sel) => window.__exists(sel)),
      {
        args: [[
          `[data-testid="${T.ingestGroupRow}"]`,
          `[data-testid="${T.downloadItem}"]`,
          `[data-testid="${T.dlEmpty}"]`,
        ]],
        timeout: 10000,
      },
    )
    check(
      `UI：点 ${T.navDownload} 后下载域挂载（行/空态出现；来源切片已按 BUG-366 撤除）`,
      clickedNav === true,
    )

    // 等轮询落地（异步：接口已确认有行，UI 需 ≥1 轮 3s 轮询）
    await page.waitForFunction(
      () => {
        const r = window.__rows()
        return r.length > 0 && r.every((x) => x.status !== '' && x.key !== '')
      },
      { timeout: 14000 },
    )
    const rows = await page.evaluate(() => window.__rows())

    // BUG-316 段② 窗口化适配：全列断言改走滚动累积集。dl-group-list 挂
    // data-total 契约；滚到底按 data-key 去重收集（含行结构），收集数 ==
    // data-total ⇒ 窗口化既不丢行也不多渲染。把窗口化拆掉（全量渲染）时
    // 渲染行数 == data-total，性能回归由 verify_bug316_segment2_render.cjs
    // 的反向证伪拦截（见其 longtask 阈值）。
    const collected = await page.evaluate(() => window.__collectAll())
    if (!collected.ok) throw new Error('dl-group-list 容器不存在（窗口化契约缺失）')
    // 收集后容器在底部；滚回顶部再取首屏行（首行展开/截图以首屏为语境）
    await page.evaluate(() => window.__scrollTop())
    const topRows = await page.evaluate(() => window.__rows())

    check(
      `UI：顶层行数 == 唯一 itemKey 数（聚合生效：${byKey.size}）`,
      collected.total === byKey.size && collected.count === collected.total,
      `dataTotal=${collected.total} collected=${collected.count} keys=${byKey.size}`,
    )
    check(
      `反证：顶层行数 < 任务记录数（证明不是平铺：${collected.total} < ${apiTasks.length}）`,
      collected.total < apiTasks.length,
      `rows=${collected.total} records=${apiTasks.length}`,
    )
    check(
      'UI：每行 data-status 与接口按 itemKey 聚合后的状态集合一致（联动）',
      collected.rows.map((r) => r.status).sort().join(',') === expectStatuses,
    )

    // 合并**无损**判据：各行运行次数之和必须等于原始记录数。
    // 少了 = 吞掉记录；多了 = 同一条记录了两次。
    const sumRuns = collected.rows.reduce((s, r) => s + r.runs, 0)
    const maxRuns = collected.rows.reduce((m, r) => Math.max(m, r.runs), 0)
    check(
      `UI：Σ各行运行次数 == 记录总数（合并无损：${sumRuns} == ${apiTasks.length}）`,
      sumRuns === apiTasks.length,
      `sum=${sumRuns} records=${apiTasks.length}`,
    )
    // 有重复批次才谈得上「合并」—— 实测最多的键重复 7 次
    check(
      `UI：存在被合并的重复批次行（runs ≥ 2，实测 ${maxRuns}）`,
      maxRuns >= 2,
      `maxRuns=${maxRuns}`,
    )

    // BUG-366：概览块已撤（用户 2026-10-22「上面死占2垃圾」）。
    // 原判据「概览『入库对象 N』== 顶层行数」随块一起作废 —— 不是能力回退，
    // 是呈现件撤销。同源性改由 `collected.count` 与 data-total 契约承担（下方已有）。
    check(
      `UI：概览块已按 BUG-366 撤除（不再占首屏）`,
      !(await page.evaluate((sel) => window.__exists(sel), `[data-testid="${T.overviewTotal}"]`)),
      'dl-overview-total 不存在',
    )
    check(
      `UI：顶层行数自身可数（data-total 契约）`,
      collected.count > 0,
      `rows=${collected.count}`,
    )

    await page.screenshot(path.join(OUT, '01-ingest-aggregated.png'))

    // ── 明细（DLU-T01 底部 Sheet）：点开首行，条目清单条数 == 该批次 total ──
    // （BT 的「文件清单」层）。点**折叠头**：onClick 只挂在它上面。
    // 运行期复核（2026-10-20 用户第三次明确）：明细入口按钮**必须 0 个** ——
    // 源码锚点会被注释/条件分支绕开，真实 DOM 计数才是用户看到的东西。
    const toggleCount = await page.evaluate(
      (sel) => window.__count(sel),
      '[data-testid="ingest-group-toggle"]',
    )
    const mingxiInteractive = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button,a,[role="button"],[onclick]')).filter((el) =>
        /明细/.test(el.textContent || ''),
      ).length,
    )
    check(
      `UI（BUG-320 复报）：明细入口按钮不存在（toggle=${toggleCount}、带「明细」文案的可交互控件=${mingxiInteractive}，均应为 0）`,
      toggleCount === 0 && mingxiInteractive === 0,
      `toggle=${toggleCount} interactive=${mingxiInteractive}`,
    )
    const firstKey = topRows[0]?.key
    const firstTask = byKey.get(firstKey)
    const clickedRow = await page.evaluate(
      (sel) => window.__click(sel),
      `[data-testid="${T.header}"]`,
    )
    if (clickedRow !== true) throw new Error('点不到入库行折叠头')
    await page.waitForFunction((sel) => window.__exists(sel), {
      args: [`[data-testid="${T.sheet}"]`],
      timeout: 10000,
    })
    await page.waitForFunction((sel) => window.__exists(sel), {
      args: [`[data-testid="${T.entries}"]`],
      timeout: 10000,
    })
    const entryCount = await page.evaluate(
      (sel) => window.__count(sel),
      `[data-testid="${T.entry}"]`,
    )
    check(
      `UI：点开首行 Sheet → 条目清单条数 == 该批次 total（${firstTask?.total}）`,
      entryCount === firstTask?.total,
      `entries=${entryCount} total=${firstTask?.total}`,
    )

    const firstRuns = topRows[0]?.runs ?? 1
    const historyShown = await page.evaluate(
      (sel) => window.__count(sel),
      `[data-testid="${T.history}"] [data-testid="${T.historyItem}"]`,
    )
    check(
      `UI：首行 Sheet 内历史批次条数 == 运行次数−1（${firstRuns}−1）`,
      historyShown === Math.max(0, firstRuns - 1),
      `history=${historyShown} runs=${firstRuns}`,
    )

    await page.screenshot(path.join(OUT, '02-ingest-sheet.png'))

    // 关掉首行 Sheet：每行各自 sheetOpen，双 Sheet 同时开会干扰后续计数
    await page.evaluate((sel) => window.__click(sel), `[data-testid="${T.sheetClose}"]`)
    await page.waitForFunction((sel) => !window.__exists(sel), {
      args: [`[data-testid="${T.sheet}"]`],
      timeout: 8000,
    })

    // ── 真实合并样本：点开一行 runs > 1 的，Sheet 内历史批次必须列出（runs−1）条 ──
    // 窗口化适配：合并行在累积集里找（key），再 __revealKey 滚进视口后点它的
    // 折叠头（目标行可能不在初始窗口里，els[i] 全列索引已失效）。
    const mergedRow = collected.rows.find((r) => r.runs > 1)
    if (!mergedRow) throw new Error('样本里没有重复批次，本断言无法成立（数据已变）')
    const revealed = await page.evaluate((k) => window.__revealKey(k), mergedRow.key)
    if (revealed !== true) throw new Error('合并行滚不进视口（revealKey 失败）')
    const clickedMerged = await page.evaluate(
      (key) => {
        const el = document.querySelector(
          '[data-testid="ingest-group-row"][data-key="' + key + '"] [data-testid="ingest-group-header"]',
        )
        if (!el) return false
        el.click()
        return true
      },
      mergedRow.key,
    )
    if (clickedMerged !== true) throw new Error('点不到合并行折叠头')
    await page.waitForFunction(
      (key, sel) => !!document.querySelector(
        '[data-testid="ingest-group-row"][data-key="' + key + '"] ' + sel,
      ),
      { args: [mergedRow.key, `[data-testid="${T.history}"]`], timeout: 10000 },
    )
    const mergedHistory = await page.evaluate(
      (key, sel) =>
        window.__count(
          '[data-testid="ingest-group-row"][data-key="' + key + '"] ' + sel,
        ),
      mergedRow.key,
      `[data-testid="${T.history}"] > [data-testid="${T.historyItem}"]`,
    )
    check(
      `UI：合并行 Sheet 内历史批次条数 == runs−1（${mergedRow.runs}−1）`,
      mergedHistory === mergedRow.runs - 1,
      `history=${mergedHistory} runs=${mergedRow.runs}`,
    )
    // 截图必须**看得见**这行（合并行在列表下方）：revealKey 已滚到它并 settle，
    // 补一拍等展开动画落地再拍。
    await new Promise((r) => setTimeout(r, 400))
    await page.screenshot(path.join(OUT, '03-ingest-merged-history.png'))

    // ── 反证（BUG-366 supersede）────────────────────────────────────────
    // 原反证 = 点来源 chip 看行数变化；chip 已撤 ⇒ 反证改为「面板里再也搜不到
    // 来源切片控件」。撤能力必须留下「它真的不在了」的判据，否则下次又长回来。
    const sliceGone = await page.evaluate(
      (sel) => !window.__exists(sel),
      `[data-testid="${T.sourceFilter}"]`,
    )
    check('反证（BUG-366）：来源切片控件已不存在（不会静默长回来）', sliceGone)
    await new Promise((r) => setTimeout(r, 400))
    // 窗口化适配：「行恢复」的判据 = data-total 契约回到全量档（切片切走时
    // VirtualList 整体卸载、状态清空；切回重挂后 data-total 必须 == 聚合数）。
    const restored = await page.evaluate(() => window.__rows())
    const restoredTotal = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dl-group-list"]')
      return el ? Number(el.getAttribute('data-total') || NaN) : null
    })
    check(
      '反证：切回「全部」⇒ 入库行恢复（非一次性清空）',
      restored.length > 0 && restoredTotal === byKey.size,
      `restored=${restored.length} dataTotal=${restoredTotal} keys=${byKey.size}`,
    )

    // ── 补齐能力 ①：动作结构（去媒体库查看 / 优先下载按状态分派）──────────
    // 判据是**逐行结构**，不是「页面上有这几个按钮」：done 行必须有跳转出口、
    // 未完成行必须没有（没入库完成就给按钮 = 点了播不出东西）；排队行必须能
    // 优先下载、在跑的行不能（后端 prioritizable 同源，给了就是假按钮）。
    // 窗口化适配：结构取自滚动全程累积集（104 行全量，非首屏 12 行）。
    const actionStruct = collected.rows
    const goLibMismatch = actionStruct.filter((r) => r.goLib !== (r.status === 'done'))
    check(
      `UI：去媒体库查看只出现在已完成行（done=${actionStruct.filter((r) => r.status === 'done').length}，违例=${goLibMismatch.length}）`,
      actionStruct.length > 0 && goLibMismatch.length === 0,
      goLibMismatch.map((r) => `${r.status}:goLib=${r.goLib}`).join(' '),
    )
    const preferMismatch = actionStruct.filter((r) => {
      if (r.status === 'queued') return !r.prioritized && !r.prefer
      if (r.status === 'running') return r.prefer || r.unprefer
      return false
    })
    check(
      'UI：排队行可优先下载、在跑行不能（与后端 prioritizable 同源）',
      preferMismatch.length === 0,
      preferMismatch.map((r) => r.status).join(' '),
    )
    const retryMismatch = actionStruct.filter((r) =>
      ['failed', 'interrupted', 'cancelled'].includes(r.status) ? !r.retry : r.retry,
    )
    check(
      'UI：终态行（失败/中断/取消）才有重试，活跃行没有',
      retryMismatch.length === 0,
      retryMismatch.map((r) => r.status).join(' '),
    )

    // ── BUG-314 撤档后：取消记录的可见性由「全部」档 + 概览计数承担 ──────────
    // 判据三条：① 侧栏**没有** nav-child-dl-cancelled（独立档已撤，主 NAVI 回三项）；
    // ② 概览「已取消 N」读数仍在（次级信息，非导航）；③ 「全部」档里 cancelled
    // 入库行数 == N（记录可见且可数）。当前就在「全部」档（下载根项，来源=全部）。
    const bucketGone = await page.evaluate(
      (sel) => !window.__exists(sel),
      `[data-testid="${T.navChildDl}-cancelled"]`,
    )
    // BUG-366：概览「已取消 N」已撤 ⇒ 读数改从滚动全程累积集自身取（同一真源）。
    // 窗口化适配：cancelled 行数在滚动全程累积集里数（全列，非首屏窗口）。
    const visibleCancelled = collected.rows.filter((r) => r.status === 'cancelled').length
    const cancelledN = visibleCancelled
    check(
      `UI（BUG-314）：侧栏无「已取消」树档；取消行在「全部」档可见且可数（实列 ${visibleCancelled}；概览已按 BUG-366 撤除）`,
      bucketGone === true && Number.isFinite(cancelledN) && visibleCancelled === cancelledN,
      `bucketGone=${bucketGone} overview=${cancelledText} visible=${visibleCancelled}`,
    )
    await page.screenshot(path.join(OUT, '04-ingest-cancelled-bucket.png'))

    // ── 补齐能力 ③：端到端「去媒体库查看」── 起播 + 落媒体库 ─────────────
    // 这是用户原话「入库流水线里面没有跳转查看」的正面证据：点按钮 ⇒ 播放器
    // 覆盖层出现（by-ref 命中、就地起播）⇒ 焦点 ref 交给媒体库并切视图。
    // 窗口化适配：按钮只挂在 done 行上，先取累积集里的一个 done 行，
    // revealKey 滚进视口后再点它的按钮（els[0] 全列索引已失效）。
    const doneRow = collected.rows.find((r) => r.status === 'done')
    if (!doneRow) throw new Error('累积集里没有已完成行，端到端断言前提不成立（数据已变）')
    const revealedDone = await page.evaluate((k) => window.__revealKey(k), doneRow.key)
    if (revealedDone !== true) throw new Error('已完成行滚不进视口（revealKey 失败）')
    const clickedGoLib = await page.evaluate(
      (key) => {
        const el = document.querySelector(
          '[data-testid="ingest-group-row"][data-key="' + key + '"] [data-testid="ingest-group-golibrary"]',
        )
        if (!el) return false
        el.click()
        return true
      },
      doneRow.key,
    )
    check(
      'UI：已完成行存在「去媒体库查看」按钮且可点',
      clickedGoLib === true,
    )
    let viewerOpened = false
    try {
      await page.waitForFunction((sel) => window.__exists(sel), {
        args: [`[data-testid="${T.viewer}"]`],
        timeout: 15000,
      })
      viewerOpened = true
    } catch {
      viewerOpened = false
    }
    check('UI：点「去媒体库查看」⇒ 播放器覆盖层出现（by-ref 命中并起播）', viewerOpened)
    if (viewerOpened) {
      await page.screenshot(path.join(OUT, '05-ingest-golibrary-viewer.png'))
      // 关掉播放器后用户必须**落在媒体库**（lib-series 子项激活）—— 否则
      // 「查看」只是一次播放器弹出，从没到达过成品所在的地方。
      // 走 CDP 原生按键（cdp.cjs `pressKey`）：驱动浏览器真实投递，跑的是
      // MediaViewer 自己的 keydown 处理器，不是页面里合成的事件。
      await page.pressKey('Escape')
      await page.waitForFunction((sel) => window.__exists(sel), {
        args: [`[data-testid="${T.navChildLibSeries}"]`],
        timeout: 8000,
      })
      const libActive = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        return !!el && (el.className || '').includes('text-accent')
      }, `[data-testid="${T.navChildLibSeries}"]`)
      check('UI：关闭播放器后落在媒体库剧集视图（焦点 ref 已交接）', libActive === true)
      await page.screenshot(path.join(OUT, '06-ingest-golibrary-library.png'))
    }

    const errs = page.pageErrors()
    check('UI：运行期无未捕获页面异常', errs.length === 0, errs.join(' | '))
  } finally {
    await browser.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — evidence: ${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
