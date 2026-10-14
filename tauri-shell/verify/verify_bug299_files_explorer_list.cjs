'use strict'

/**
 * BUG-299 · M2-T01a —— 文件域父行（cat-all）= Explorer 列表，绝不作视频海报墙。
 *
 * 用户裁定（2026-10-15）：「文件管理是列表，是 Explorer 显示，但绝对不可能是视频！」
 * 本脚本是这句话的**可证伪验收**：
 *
 * 正向（渲染真发生了）：
 *   ① cat-all 下 `file-list` / `file-list-header` 存在，行数 > 0；
 *   ② 行数 ≤ min(API total, 分页页大小) —— 与列表端点同一口径对数（牙：API total>0
 *      而 UI 0 行 = FAIL，证明「有行」不是蒙的）；
 *   ③ 列头含「名称/类型/大小/日期/来源」五列（文案从 locale 源码读，不从页面猜）；
 *   ④ 每行复选框常驻（BUG-040：禁纯 hover 显形）；
 *   ⑤ 单击行 = 选中（Explorer 语义，与网格的全选 toolbar 并行不互斥）。
 *
 * 互斥（「绝对不可能是视频」的本体判据）：
 *   ⑥ cat-all 下 `media-grid` 必须**不存在**（0）。
 *
 * 反证（证明⑥不是「列表恒显/墙恒隐」的假绿，分派真的挂在 cat-all 上）：
 *   ⑦ 切到分类子行「视频」（cat:video → tab='video'）：`media-grid` 存在（>0）、
 *      `file-list` 不存在（0）—— 与⑥互为互斥类，一处渲染另一处必须消失。
 *
 * 脚本自身证伪纪律：判据①③⑤⑥的常量全部从**源码**读（组件/locale 文件），
 * 读不到直接 FAIL —— 不靠「页面上有这个东西」倒推源码没漂移。
 *
 * 用法：node tauri-shell/verify/verify_bug299_files_explorer_list.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；产物落 verify_shots/bug299-file-list/）
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  fileList: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'media', 'FileListView.tsx'), 'utf8'),
  panel: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'MediaLibraryPanel.tsx'), 'utf8'),
  zh: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json'), 'utf8'),
}
const OUT = process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug299-file-list')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
/** 分页页大小：与 MediaLibraryPanel 的 `PAGE` 同源（源码读，见源码常量段）。 */
const PAGE = (() => {
  const m = SRC.panel.match(/^const PAGE = (\d+)$/m)
  if (!m) throw new Error('源码读不到 MediaLibraryPanel 的 PAGE 常量')
  return Number(m[1])
})()

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 源码常量（判据锚点：页面 testid / 分派条件 / 列头文案） ── */
const T = {
  list: 'file-list',
  header: 'file-list-header',
  row: 'file-list-row',
  grid: 'media-grid',
}
const branchOk = /view === 'items' && tab === 'all' && items\.length > 0/.test(SRC.panel)
const fileListMounted = new RegExp(`data-testid="${T.list}"`).test(SRC.fileList)
  && new RegExp(`data-testid="${T.row}"`).test(SRC.fileList)
const zh = JSON.parse(SRC.zh)
const COLS = ['name', 'kind', 'size', 'date', 'source'].map((k) => zh[`media.fileList.${k}`])

async function main() {
  check(`源码：FileListView 挂 ${T.list}/${T.row} testid`, fileListMounted)
  check(`源码：MediaLibraryPanel 分派条件 tab==='all' → 列表`, branchOk)
  check(`源码：locale 五列文案齐全`, COLS.every((c) => typeof c === 'string' && c.length > 0), COLS.join('/'))
  if (!fileListMounted || !branchOk) throw new Error('源码常量缺失，运行时判据全部作废')

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    // 等应用就绪（壳先探活再渲染侧栏）。
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="nav-files"]'),
      { timeout: 30000 },
    )

    const PAGE_JS = `
    window.__b299 = {
      sel: ${JSON.stringify(T)},
      present(sel) { return document.querySelectorAll(sel).length },
      async api(p) {
        const r = await fetch('${TG}' + p, { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
        return r.json()
      },
      async enterCatAll() {
        document.querySelector('[data-testid="nav-files"]')?.click()
        await new Promise((r) => setTimeout(r, 1500))
      },
      async enterCatVideo() {
        // 分类子行只在 filesOpen 时渲染；未展开先点 chevron。
        if (!document.querySelector('[data-testid="nav-child-cat-video"]')) {
          document.querySelector('[data-testid="files-chevron"]')?.click()
          await new Promise((r) => setTimeout(r, 400))
        }
        document.querySelector('[data-testid="nav-child-cat-video"]')?.click()
        await new Promise((r) => setTimeout(r, 1500))
      },
      async clickFirstRow() {
        const row = document.querySelector('[data-testid="' + this.sel.row + '"]')
        if (!row) return false
        row.click()
        await new Promise((r) => setTimeout(r, 400))
        return true
      },
    }
    `
    await page.evaluate(PAGE_JS)

    /* ── ① ⑤ ⑥：cat-all = 列表 ── */
    await page.evaluate(() => window.__b299.enterCatAll())
    const all = await page.evaluate(() => {
      const s = window.__b299.sel
      return {
        list: window.__b299.present(`[data-testid="${s.list}"]`),
        header: window.__b299.present(`[data-testid="${s.header}"]`),
        rows: window.__b299.present(`[data-testid="${s.row}"]`),
        grid: window.__b299.present(`[data-testid="${s.grid}"]`),
        checks: document.querySelectorAll(`[data-testid="${s.list}"] input[type="checkbox"]`).length,
        selectedRows: document.querySelectorAll(`[data-testid="${s.row}"][data-selected="true"]`).length,
        headerText: (document.querySelector(`[data-testid="${s.header}"]`) || {}).innerText || '',
      }
    })
    check('① cat-all 渲染 file-list（Explorer 容器）', all.list === 1, `count=${all.list}`)
    check('① cat-all 渲染列头 file-list-header', all.header === 1, `count=${all.header}`)
    check('① cat-all 行数 > 0', all.rows > 0, `rows=${all.rows}`)
    check('⑥ cat-all 下 media-grid 不存在（绝不视频海报墙）', all.grid === 0, `count=${all.grid}`)
    check('④ 每行复选框常驻可见（BUG-040）',
      all.rows > 0 && all.checks === all.rows, `checkbox=${all.checks} / rows=${all.rows}`)
    const clicked = await page.evaluate(() => window.__b299.clickFirstRow())
    const sel = await page.evaluate(() => {
      const s = window.__b299.sel
      return {
        sel: document.querySelectorAll(`[data-testid="${s.row}"][data-selected="true"]`).length,
      }
    })
    check('⑤ 单击行 = 选中（Explorer 语义）',
      clicked === true && sel.sel === 1, `clicked=${clicked} selected=${sel.sel}`)

    /* ── ②：行数 vs 列表端点（牙：API 有数而 UI 空 = FAIL） ── */
    const api = await page.evaluate(async () => {
      const r = await window.__b299.api('/api/media/items?hasBytes=true&limit=500')
      return { total: r.total, got: (r.items || []).length }
    })
    const expectRows = Math.min(api.total, PAGE)
    check('② UI 行数与列表端点同口径（≤ min(total, PAGE)）',
      all.rows > 0 && all.rows <= expectRows,
      `ui=${all.rows} apiTotal=${api.total} PAGE=${PAGE}（牙：api 返回 ${api.got} 条）`)

    /* ── ③：列头五列（文案锚 locale 源码） ── */
    check('③ 列头含 名称/类型/大小/日期/来源 五列',
      COLS.every((c) => all.headerText.includes(c)),
      `header="${all.headerText.replace(/\n/g, ' ')}"`)

    await page.screenshot(path.join(OUT, '01_cat_all_list.png'))

    /* ── ⑦ 反证：分类子行仍是网格（互斥类的另一半） ── */
    await page.evaluate(() => window.__b299.enterCatVideo())
    const vid = await page.evaluate(() => {
      const s = window.__b299.sel
      return {
        list: window.__b299.present(`[data-testid="${s.list}"]`),
        grid: window.__b299.present(`[data-testid="${s.grid}"]`),
        cards: document.querySelectorAll(`[data-testid="${s.grid}"] > *`).length,
      }
    })
    check('⑦ 反证：视频分类子行渲染 media-grid（分派挂 cat-all，非恒列表）',
      vid.grid === 1 && vid.cards > 0, `grid=${vid.grid} cards=${vid.cards}`)
    check('⑦ 反证：视频分类子行不渲染 file-list', vid.list === 0, `count=${vid.list}`)
    await page.screenshot(path.join(OUT, '02_cat_video_grid.png'))

    const errs = page.pageErrors()
    check('无未捕获页面错误', errs.length === 0, errs.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — BUG-299 M2-T01a：文件域=Explorer 列表`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
