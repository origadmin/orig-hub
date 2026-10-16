'use strict'

/**
 * BUG-316 段② 验收：渲染长任务收敛（窗口化）。
 *
 * 段②根因（2026-10-15 定位）：下载/文件两视图**全量同步渲染**——
 *   下载域 104 个入库组行（~108px/行）+ 文件域 cat-all 671 行（34px/行），
 *   一次渲染上千节点 ⇒ nav 切换 longtask 243+107 / 97+234ms。
 * 修复：`components/ui/virtual-list.tsx` 动态行高窗口化（measure-and-cache），
 *   两视图只渲染视口 ± overscan 行，上下 spacer 占位；容器挂 data-total 契约。
 *
 * 判据（全部实读，不靠记忆）：
 *   ① 自证：页面真实渲染（root 有可见文本；白屏 = FAIL）；
 *   ② 文件域：data-total == API 实算期望行数（媒体页 + 受管成品，路径去重）；
 *      渲染行数 < data-total（窗口化生效）；渲染行数 ≥ 1 且 ≤ WINDOW_MAX；
 *      nav-files longtask 总和 < LT.filesFirst；
 *      滚到底后 data-total 不变、渲染行数仍在窗口量级（滚动不触发全量渲染）；
 *   ③ 下载域：data-total == API 实算唯一 itemKey 数；
 *      渲染行数 < data-total；首访 longtask < LT.downloadFirst；回切 < LT.downloadRevisit；
 *   ④ 其余 nav（tg/settings）longtask 不回归（本修复未触及，防劣化）；
 *   ⑤ 运行期无未捕获页面异常。
 *
 * 反向证伪（「验收的验收」）：
 *   - 把窗口化拆掉（恢复全量渲染）⇒ ②③ 的「渲染行数 < data-total」必 FAIL，
 *     且 longtask 回归 331/350ms ⇒ 超阈值 FAIL（两条独立路径都红）；
 *   - data-total 契约缺失（容器无该属性）⇒ ②③ 的 API 对比拿不到数，FAIL（不静默过）；
 *   - API 无数据（端点挂）⇒ 期望值为 0，脚本**抛错**而非 0 过（前提不成立 ≠ 通过）；
 *   - 阈值取值均高于实测、低于修复前读数（见 LT 常量注释）——喂旧码必红。
 *
 * 用法：node tauri-shell/verify/verify_bug316_segment2_render.cjs
 * 前置：dev 栈（:5180 vite + :19786 daemon + :19787 orig-tg）；
 * 产物落 verify_shots/bug316-segment2-render/。
 */

const fs = require('node:fs')
const path = require('node:path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  vl: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'ui', 'virtual-list.tsx'),
    'utf8',
  ),
  fileList: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'media', 'FileListView.tsx'),
    'utf8',
  ),
  dlPanel: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'DownloadPanel.tsx'),
    'utf8',
  ),
}
const OUT =
  process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug316-segment2-render')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
/**
 * orig-tg 基址**运行时解析**（BUG-178 纪律，与前端同口径）：端口以 daemon
 * `/api/config` 的 `tg_port` 为真源 —— 19787 绑不上时 orig-tg 会顺延（如 19788），
 * 硬编码的脚本会在顺延后全部打空。`VERIFY_TG_BASE` 仍可显式覆盖。
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

/** 分页页大小：与 MediaLibraryPanel 的 PAGE 同源（源码读）。 */
const PAGE = (() => {
  const m = fs
    .readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'MediaLibraryPanel.tsx'), 'utf8')
    .match(/^const PAGE = (\d+)$/m)
  if (!m) throw new Error('源码读不到 MediaLibraryPanel 的 PAGE 常量')
  return Number(m[1])
})()

/**
 * longtask 阈值（ms，单次 nav 全窗口总和）。取值纪律：高于实测读数、
 * 低于修复前读数（非窗口化必红）。实测（2026-10-16，1440×900，dev+StrictMode）：
 *   downloadFirst 211-242（修复前 350）、filesFirst 140-150（修复前 331）、
 *   tg 177-199（本修复未触及，防回归）、settings 0、downloadRevisit 76-105（修复前 349）。
 */
const LT = {
  downloadFirst: 300,
  filesFirst: 220,
  tg: 300,
  settings: 100,
  downloadRevisit: 200,
}
/** 渲染行数上限：视口行 + 2×overscan 在 1440×900 下的量级（实测 files 31 / download 12）。 */
const WINDOW_MAX = 80

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 页面侧探针：常量随注入脚本进页面（evaluate 序列化丢 Node 作用域）。 */
const PAGE_JS = `
window.__b316r = {
  sel: ${JSON.stringify({
    navDownload: '[data-testid="nav-download"]',
    navFiles: '[data-testid="nav-files"]',
    navTg: '[data-testid="nav-tg"]',
    navSettings: '[data-testid="nav-settings"]',
    fileListScroll: '[data-testid="file-list-scroll"]',
    fileRow: '[data-testid="file-list-row"]',
    dlGroupList: '[data-testid="dl-group-list"]',
    ingestRow: '[data-testid="ingest-group-row"]',
  })},
  installObserver() {
    window.__longtasks = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__longtasks.push({ d: Math.round(e.duration) })
        }
      }).observe({ entryTypes: ['longtask'] })
      return true
    } catch (e) { return String(e) }
  },
  takeLongtasks() {
    const lt = (window.__longtasks || []).slice()
    window.__longtasks = []
    return lt
  },
  ltSum() {
    return (window.__longtasks || []).reduce((s, l) => s + l.d, 0)
  },
  click(sel) {
    const el = document.querySelector(sel)
    if (!el) return 'MISSING ' + sel
    el.click()
    return 'ok'
  },
  counts() {
    const q = (s) => document.querySelectorAll(s).length
    const fs = document.querySelector(this.sel.fileListScroll)
    const dg = document.querySelector(this.sel.dlGroupList)
    return {
      fileRows: q(this.sel.fileRow),
      fileTotal: fs ? Number(fs.getAttribute('data-total') || NaN) : null,
      ingestRows: q(this.sel.ingestRow),
      dlTotal: dg ? Number(dg.getAttribute('data-total') || NaN) : null,
      domNodes: document.querySelectorAll('*').length,
    }
  },
  scrollFileListToBottom() {
    const el = document.querySelector(this.sel.fileListScroll)
    if (!el) return false
    el.scrollTop = el.scrollHeight
    return true
  },
  visibleText() {
    const root = document.querySelector('#root') || document.body
    return (root.innerText || '').slice(0, 120)
  },
}
`

/** cat-all 期望行数（与 catAllRows 同口径：媒体页 ∪ 受管成品，按规范化路径去重）。
 *  注意：evaluate 回调序列化后丢 Node 作用域，基址必须当参数传。 */
async function expectCatAllRows(page, tgBase, daemonBase) {
  const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase()
  const mediaPage = await page.evaluate(async (base, p) => {
    const r = await fetch(base + p, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
    return r.json()
  }, tgBase, `/api/media/items?hasBytes=true&sort=recent&limit=${PAGE}&offset=0`)
  const facts = await page.evaluate(async (base, p) => {
    const r = await fetch(base + p, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
    const j = await r.json()
    return j.files || []
  }, daemonBase, '/api/files')
  const taken = new Set(
    (mediaPage.items || []).map((i) => norm(i.absolutePath ?? i.filePath)).filter(Boolean),
  )
  const expectFacts = facts.filter((f) => !taken.has(norm(f.path)))
  return (mediaPage.items || []).length + expectFacts.length
}

/**
 * 入库组行期望数（与前端 useIngestGroups/ingestGroups 同口径）：
 * `/api/activity?scope=all` → `{tasks, sources, generated_at}`；
 * sources 找 kind=cache 判可用性（BUG-318：取不到 ≠ 没有），tasks 过滤 cache
 * 类后按 groupKey（= orig-tg itemKey，聚合键）去重计数。
 */
async function expectIngestGroups(page, daemonBase) {
  const snap = await page.evaluate(async (base) => {
    const r = await fetch(base + '/api/activity?scope=all', {
      headers: { accept: 'application/json' },
    })
    if (!r.ok) throw new Error('/api/activity -> HTTP ' + r.status)
    return r.json()
  }, daemonBase)
  const cacheSrc = (snap.sources || []).find((s) => s.kind === 'cache')
  if (!cacheSrc || cacheSrc.available === false) {
    throw new Error('daemon cache 来源不可用，无法取得入库真源（BUG-318：取不到 ≠ 没有）')
  }
  const tasks = (snap.tasks || []).filter((t) => t.kind === 'cache')
  const keys = new Set(tasks.map((t) => (t.groupKey || '').trim() || `tg:${t.id}`))
  return keys.size
}

async function main() {
  // orig-tg 基址运行时解析（BUG-178）：端口可能顺延，以 daemon /api/config 为真源
  const TG = await resolveTgBase()
  // ── 源码锚点：窗口化真的接进了两个视图 ──
  check(
    '源码：virtual-list.tsx 存在且含 data-total 契约',
    /data-total=\{items\.length\}/.test(SRC.vl) && /data-vl-row/.test(SRC.vl),
  )
  check(
    '源码：FileListView 用 VirtualList（testId=file-list-scroll，滚动容器契约）',
    /<VirtualList\b/.test(SRC.fileList) && /testId="file-list-scroll"/.test(SRC.fileList),
  )
  check(
    '源码：DownloadPanel 用 VirtualList（testId=dl-group-list）',
    /<VirtualList[\s\S]{0,120}?testId="dl-group-list"/.test(SRC.dlPanel) &&
      /items=\{ingestRows\}/.test(SRC.dlPanel),
  )
  if (failures > 0) throw new Error('源码锚点缺失，运行时判据全部作废')

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="nav-download"]'),
      { timeout: 30000 },
    )
    await sleep(1500)
    await page.evaluate(PAGE_JS)

    // ① 自证：真实渲染（白屏是最核失败）
    const installed = await page.evaluate('window.__b316r.installObserver()')
    const text = await page.evaluate('window.__b316r.visibleText()')
    check('① 页面真实渲染（root 有可见文本，非白屏）', installed === true && (text || '').length >= 10,
      `observer=${installed} text=${JSON.stringify((text || '').slice(0, 40))}`)

    // ── ③ 下载域（首访）：数据真源先取，再清空读数、点击、收读数 ──
    const expectGroups = await expectIngestGroups(page, DAEMON)
    if (expectGroups === 0) throw new Error('API 入库组数为 0，验收前提不成立（端点/数据异常）')
    const expectRows = await expectCatAllRows(page, TG, DAEMON)
    if (expectRows === 0) throw new Error('API cat-all 行数为 0，验收前提不成立（端点/数据异常）')

    await page.evaluate('window.__b316r.takeLongtasks()')
    const clickDl = await page.evaluate('window.__b316r.click(window.__b316r.sel.navDownload)')
    await sleep(2500)
    const dlLt = await page.evaluate('window.__b316r.takeLongtasks()')
    const dlLtSum = dlLt.reduce((s, l) => s + l.d, 0)
    const dlCounts = await page.evaluate('window.__b316r.counts()')

    check(`③ 下载域挂载（点击 ${clickDl}）`, clickDl === 'ok')
    check(
      `③ data-total == API 唯一 itemKey 数（${expectGroups}）`,
      dlCounts.dlTotal === expectGroups,
      `ui=${dlCounts.dlTotal} api=${expectGroups}`,
    )
    check(
      `③ 窗口化生效：渲染行数 < data-total（${dlCounts.ingestRows} < ${dlCounts.dlTotal}）`,
      dlCounts.ingestRows >= 1 && dlCounts.ingestRows < dlCounts.dlTotal,
      `rendered=${dlCounts.ingestRows} total=${dlCounts.dlTotal}`,
    )
    check(
      `③ 渲染行数在窗口量级（≤ ${WINDOW_MAX}）`,
      dlCounts.ingestRows <= WINDOW_MAX,
      `rendered=${dlCounts.ingestRows}`,
    )
    check(
      `③ 首访 longtask 总和 < ${LT.downloadFirst}ms（修复前 350：全量 104 行）`,
      dlLtSum < LT.downloadFirst,
      `tasks=[${dlLt.map((l) => l.d).join(',')}] sum=${dlLtSum}ms`,
    )
    await page.screenshot(path.join(OUT, '01-download-windowed.png'))

    // ── ② 文件域（首访）──
    await page.evaluate('window.__b316r.takeLongtasks()')
    const clickFs = await page.evaluate('window.__b316r.click(window.__b316r.sel.navFiles)')
    await sleep(2500)
    const fsLt = await page.evaluate('window.__b316r.takeLongtasks()')
    const fsLtSum = fsLt.reduce((s, l) => s + l.d, 0)
    const fsCounts = await page.evaluate('window.__b316r.counts()')

    check(`② 文件域挂载（点击 ${clickFs}）`, clickFs === 'ok')
    check(
      `② data-total == API 实算期望行数（${expectRows}）`,
      fsCounts.fileTotal === expectRows,
      `ui=${fsCounts.fileTotal} api=${expectRows}`,
    )
    check(
      `② 窗口化生效：渲染行数 < data-total（${fsCounts.fileRows} < ${fsCounts.fileTotal}）`,
      fsCounts.fileRows >= 1 && fsCounts.fileRows < fsCounts.fileTotal,
      `rendered=${fsCounts.fileRows} total=${fsCounts.fileTotal}`,
    )
    check(
      `② 渲染行数在窗口量级（≤ ${WINDOW_MAX}）`,
      fsCounts.fileRows <= WINDOW_MAX,
      `rendered=${fsCounts.fileRows}`,
    )
    check(
      `② nav-files longtask 总和 < ${LT.filesFirst}ms（修复前 331：全量 671 行）`,
      fsLtSum < LT.filesFirst,
      `tasks=[${fsLt.map((l) => l.d).join(',')}] sum=${fsLtSum}ms`,
    )
    await page.screenshot(path.join(OUT, '02-files-windowed.png'))

    // ② 续：滚到底 ⇒ data-total 不变、渲染行数仍在窗口量级（滚动不触发全量渲染）
    await page.evaluate('window.__b316r.scrollFileListToBottom()')
    await sleep(1200)
    const fsBottom = await page.evaluate('window.__b316r.counts()')
    check(
      `② 滚到底：data-total 不变（${expectRows}）且渲染行数仍 < data-total`,
      fsBottom.fileTotal === expectRows &&
        fsBottom.fileRows >= 1 &&
        fsBottom.fileRows < fsBottom.fileTotal,
      `rendered=${fsBottom.fileRows} total=${fsBottom.fileTotal}`,
    )
    await page.screenshot(path.join(OUT, '03-files-scrolled-bottom.png'))

    // ── ④ 其余 nav 不回归（本修复未触及 tg/settings，防劣化）──
    for (const [key, sel, limit] of [
      ['tg', 'navTg', LT.tg],
      ['settings', 'navSettings', LT.settings],
    ]) {
      await page.evaluate('window.__b316r.takeLongtasks()')
      await page.evaluate(`window.__b316r.click(window.__b316r.sel.${sel})`)
      await sleep(2500)
      const lt = await page.evaluate('window.__b316r.takeLongtasks()')
      const sum = lt.reduce((s, l) => s + l.d, 0)
      check(
        `④ nav-${key} longtask 总和 < ${limit}ms（防回归）`,
        sum < limit,
        `tasks=[${lt.map((l) => l.d).join(',')}] sum=${sum}ms`,
      )
    }

    // ── ③ 续：回切下载（热路径）──
    await page.evaluate('window.__b316r.takeLongtasks()')
    await page.evaluate('window.__b316r.click(window.__b316r.sel.navDownload)')
    await sleep(2500)
    const backLt = await page.evaluate('window.__b316r.takeLongtasks()')
    const backSum = backLt.reduce((s, l) => s + l.d, 0)
    const backCounts = await page.evaluate('window.__b316r.counts()')
    check(
      `③ 回切下载 longtask 总和 < ${LT.downloadRevisit}ms（修复前 349）`,
      backSum < LT.downloadRevisit,
      `tasks=[${backLt.map((l) => l.d).join(',')}] sum=${backSum}ms`,
    )
    check(
      `③ 回切后窗口化仍在（渲染 ${backCounts.ingestRows} < data-total ${backCounts.dlTotal}）`,
      backCounts.ingestRows >= 1 && backCounts.ingestRows < backCounts.dlTotal,
      `rendered=${backCounts.ingestRows} total=${backCounts.dlTotal}`,
    )

    // ⑤ 运行期无未捕获页面异常
    check('⑤ 运行期无未捕获页面异常', page.pageErrors().length === 0, page.pageErrors().join(' | '))
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
