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
 *   - 历史批次折叠进展开区（「共 N 次」徽标 + 历史清单）；
 *   - 顶部给**概览口径**（在传 / 待处理 / 已完成 / 已取消的对象数）= 「笼统的数据」。
 *
 * 断言共 15 条，分五组：源码锚点 4 / 接口 2 / 聚合 3 / 明细 2 / 反证 3 / 运行期 1。
 *
 * 用法：node tauri-shell/verify/verify_bug300_ingest_aggregation.cjs
 *   （需 vite :5180 + orig-daemon :19786 + orig-tg :19787 在跑；
 *     产物落 verify_shots/bug300-ingest-aggregation/）
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT =
  process.env.ORIG_SHOT_OUT ||
  path.resolve(ROOT, 'verify_shots', 'bug300-ingest-aggregation')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'

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
  layout: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'shell', 'MainLayout.tsx'),
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
  sourceFilter: 'dl-source-filter',
  sourceAll: 'dl-source-all',
  sourceDownload: 'dl-source-download',
  overviewTotal: 'dl-overview-total',
  row: 'ingest-group-row',
  name: 'ingest-group-name',
  progress: 'ingest-group-progress',
  runs: 'ingest-group-runs',
  entries: 'ingest-group-entries',
  entry: 'ingest-group-entry',
  header: 'ingest-group-header',
  history: 'ingest-group-history',
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

/** 与前端同口径的聚合：同 `itemKey` 取最新一条为代表。 */
function aggregate(tasks) {
  const byKey = new Map()
  for (const t of tasks) {
    const key = (t.itemKey || '').trim() || `tg:${t.id}`
    const cur = byKey.get(key)
    if (
      !cur ||
      t.updatedAt > cur.updatedAt ||
      (t.updatedAt === cur.updatedAt && t.id > cur.id)
    ) {
      byKey.set(key, t)
    }
  }
  return byKey
}

async function main() {
  // ── ①-④ 源码锚点 ────────────────────────────────────────────────────
  const groupsOk =
    /export function groupIngestTasks\(/.test(SRC.groups) &&
    /export function summarizeGroups\(/.test(SRC.groups) &&
    /export function ingestActionsFor\(/.test(SRC.groups)
  check('源码：ingestGroups.ts 提供聚合 / 概览 / 动作三个纯函数', groupsOk)

  const rowOk =
    new RegExp(`data-testid="${T.row}"`).test(SRC.row) &&
    /getCacheTaskItems\(/.test(SRC.row)
  check(`源码：IngestGroupRow 挂 ${T.row} 且展开拉组清单`, rowOk)

  const panelOk =
    /ingest: UseIngestGroupsResult/.test(SRC.panel) &&
    new RegExp(`data-testid="${T.sourceFilter}"`).test(SRC.panel) &&
    new RegExp(`data-testid="${T.overviewTotal}"`).test(SRC.panel)
  check('源码：DownloadPanel 收 ingest、渲染来源切片与概览', panelOk)

  // 单一轮询点：壳体拉、面板收。两处各拉一份 = 轮询两次 + 两个时刻的状态
  // ⇒ 「徽标数 ≠ 点进去的条数」（BUG-082 三处同源纪律）。
  const singleSource =
    /useIngestGroups\(\)/.test(SRC.layout) &&
    !/useIngestGroups\(\)/.test(SRC.panel)
  check('源码：单一轮询点 = MainLayout（DownloadPanel 不自拉）', singleSource)

  if (!groupsOk || !rowOk || !panelOk || !singleSource) {
    throw new Error('源码锚点缺失，运行时断言全部作废')
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
    await page.waitForFunction((sel) => window.__exists(sel), {
      args: [`[data-testid="${T.sourceFilter}"]`],
      timeout: 10000,
    })
    check(
      `UI：点 ${T.navDownload} 后下载域挂载（${T.sourceFilter} 出现）`,
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

    check(
      `UI：顶层行数 == 唯一 itemKey 数（聚合生效：${byKey.size}）`,
      rows.length === byKey.size,
      `ui=${rows.length} keys=${byKey.size}`,
    )
    check(
      `反证：顶层行数 < 任务记录数（证明不是平铺：${rows.length} < ${apiTasks.length}）`,
      rows.length < apiTasks.length,
      `ui=${rows.length} records=${apiTasks.length}`,
    )
    check(
      'UI：每行 data-status 与接口按 itemKey 聚合后的状态集合一致（联动）',
      rows.map((r) => r.status).sort().join(',') === expectStatuses,
    )

    // 合并**无损**判据：各行运行次数之和必须等于原始记录数。
    // 少了 = 吞掉记录；多了 = 同一条记录了两次。
    const sumRuns = rows.reduce((s, r) => s + r.runs, 0)
    const maxRuns = rows.reduce((m, r) => Math.max(m, r.runs), 0)
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

    // 概览 = 「笼统的数据」：对象总数必须与顶层行数同源
    const overviewText = await page.evaluate(
      (sel) => window.__text(sel),
      `[data-testid="${T.overviewTotal}"]`,
    )
    check(
      `UI：概览「入库对象 N」== 顶层行数（同源）`,
      overviewText === `入库对象 ${rows.length}`,
      `overview="${overviewText}" rows=${rows.length}`,
    )

    await page.screenshot(path.join(OUT, '01-ingest-aggregated.png'))

    // ── 明细：展开首行，条目清单条数 == 该批次 total（BT 的「文件清单」层）──
    const firstKey = rows[0]?.key
    const firstTask = byKey.get(firstKey)
    // 点**折叠头**：onClick 只挂在它上面（外层还包着展开区，点外层不会向下传递）
    const clickedRow = await page.evaluate(
      (sel) => window.__click(sel),
      `[data-testid="${T.header}"]`,
    )
    if (clickedRow !== true) throw new Error('点不到入库行折叠头')
    await page.waitForFunction((sel) => window.__exists(sel), {
      args: [`[data-testid="${T.entries}"]`],
      timeout: 10000,
    })
    const entryCount = await page.evaluate(
      (sel) => window.__count(sel),
      `[data-testid="${T.entry}"]`,
    )
    check(
      `UI：展开首行 → 条目清单条数 == 该批次 total（${firstTask?.total}）`,
      entryCount === firstTask?.total,
      `entries=${entryCount} total=${firstTask?.total}`,
    )

    const firstRuns = rows[0]?.runs ?? 1
    const historyShown = await page.evaluate(
      (sel) => window.__count(sel),
      `[data-testid="${T.history}"] [data-testid="ingest-group-history-item"]`,
    )
    check(
      `UI：历史批次折叠区条数 == 运行次数−1（${firstRuns}−1）`,
      historyShown === Math.max(0, firstRuns - 1),
      `history=${historyShown} runs=${firstRuns}`,
    )

    await page.screenshot(path.join(OUT, '02-ingest-expanded.png'))

    // ── 真实合并样本：展开一行 runs > 1 的，历史批次区必须列出（runs−1）条 ──
    const mergedIdx = rows.findIndex((r) => r.runs > 1)
    if (mergedIdx < 0) throw new Error('样本里没有重复批次，本断言无法成立（数据已变）')
    await page.evaluate(
      (sel, i) => {
        const els = document.querySelectorAll(sel)
        if (els[i]) els[i].click()
      },
      `[data-testid="${T.header}"]`,
      mergedIdx,
    )
    await page.waitForFunction((sel) => !!document.querySelector(sel), {
      args: [`[data-testid="${T.history}"]`],
      timeout: 10000,
    })
    const mergedHistory = await page.evaluate(
      (sel) => window.__count(`${sel} > [data-testid="ingest-group-history-item"]`),
      `[data-testid="${T.history}"]`,
    )
    check(
      `UI：合并行的历史批次条数 == runs−1（${rows[mergedIdx].runs}−1）`,
      mergedHistory === rows[mergedIdx].runs - 1,
      `history=${mergedHistory} runs=${rows[mergedIdx].runs}`,
    )
    // 截图必须**看得见**这行（合并行在列表下方）：先滚到它再拍，
    // 否则「有历史批次」只有断言数字、没有可核的视觉证据。
    await page.evaluate(
      (sel, i) => {
        const els = document.querySelectorAll(sel)
        if (els[i]) els[i].scrollIntoView({ block: 'start' })
      },
      `[data-testid="${T.header}"]`,
      mergedIdx,
    )
    await new Promise((r) => setTimeout(r, 400))
    await page.screenshot(path.join(OUT, '03-ingest-merged-history.png'))

    // ── 反证：来源切片真的在分派 ────────────────────────────────────────
    await page.evaluate(
      (sel) => window.__click(sel),
      `[data-testid="${T.sourceDownload}"]`,
    )
    await page.waitForFunction(() => window.__rows().length === 0, {
      timeout: 6000,
    })
    check('反证：切来源「下载」⇒ 入库行 0（chip 真在分派）', true)

    await page.evaluate(
      (sel) => window.__click(sel),
      `[data-testid="${T.sourceAll}"]`,
    )
    await page.waitForFunction(() => window.__rows().length > 0, {
      timeout: 6000,
    })
    const restored = await page.evaluate(() => window.__rows())
    check(
      '反证：切回「全部」⇒ 入库行恢复（非一次性清空）',
      restored.length === rows.length,
      `restored=${restored.length}`,
    )

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
