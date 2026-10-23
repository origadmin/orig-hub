'use strict'

/**
 * BUG-299 · M2-T01a —— 文件域父行（cat-all）= Explorer 列表，绝不作视频海报墙。
 *
 * 用户裁定（2026-10-15）：「文件管理是列表，是 Explorer 显示，但绝对不可能是视频！」
 * 本脚本是这句话的**可证伪验收**：
 *
 * 正向（渲染真发生了）：
 *   ① cat-all 下 `file-list` / `file-list-header` 存在，行数 > 0；
 *   ② 行数 == 媒体页（PAGE 上限）+ 受管下载成品（`/api/files`，按绝对路径去重，
 *      与 `catAllRows` 同口径）—— 双源实算，不是估值（牙：任一端点有数而 UI 少行 = FAIL）；
 *   ③ 列头含「名称/类型/大小/日期/来源」五列（文案从 locale 源码读，不从页面猜）；
 *   ④ 每行复选框常驻（BUG-040：禁纯 hover 显形）；
 *   ⑤ **单击行 = 打开内容详情，不是选中**（BUG-403，2026-10-23 用户裁定推翻
 *      本脚本原先的「单击行 = 选中」判据 —— 见下方 ⑤ 段内注释）。
 *
 * 共通性（BUG-299 判据 7 的 UI 半，M2-T00a 读端点落地后新增）：
 *   ⑧ 「下载」成品行数 == `/api/files` 去重后期望数（`data-source` DOM 锚，不靠文案匹配），
 *      且成品中含非媒体类别（zip/exe/pdf）⇒ 全量 = 共通 + 兼容性真的成立。
 *
 * 互斥（「绝对不可能是视频」的本体判据）：
 *   ⑥ cat-all 下 `media-grid` 必须**不存在**（0）。
 *
 * 2026-10-16 BUG-316 段②适配：cat-all 改窗口化渲染（`file-list-scroll` 挂
 * data-total 契约，DOM 只渲染视口 ± overscan 行）。②⑧ 的全列行数断言随之
 * 改为「data-total == API 期望」+「滚到底累积数 == data-total」两道 ——
 * 窗口化丢行必红，全量渲染（旧形态）亦必红（渲染行数会 == data-total 但
 * longtask 回归，见 verify_bug316_segment2_render.cjs）。
 *
 * 反证（证明⑥不是「列表恒显/墙恒隐」的假绿，分派真的挂在 cat-all 上）：
 *   ⑦ 切到分类子行「视频」（cat:video → tab='video'）：`media-grid` 存在（>0）、
 *      `file-list` 不存在（0）—— 与⑥互为互斥类，一处渲染另一处必须消失。
 *   ⑨ 文件树子项顺序：剧集行在视频行之前（2026-10-15 用户裁定「剧集作为核心」，
 *      DOM 文档序断言；换位即 FAIL）。
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
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
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
// 分派牙齿：cat-all 分支必须由 `tab === 'all'` 守卫、渲染 FileListView、行集取
// `catAllRows`（媒体页 ∪ 受管下载成品 —— 2026-10-15 M2-T00a 后的形状）。
// 三类缺一即 FAIL：条件漂移 / 不渲染列表 / 行集退回纯媒体。
const branchOk = /view === 'items' && tab === 'all' && catAllRows\.length > 0/.test(SRC.panel)
  && /<FileListView\b/.test(SRC.panel)
  && /items=\{catAllRows\}/.test(SRC.panel)
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
      page: ${PAGE},
      present(sel) { return document.querySelectorAll(sel).length },
      async api(p) {
        const r = await fetch('${TG}' + p, { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
        return r.json()
      },
      async apiDaemon(p) {
        const r = await fetch('${DAEMON}' + p, { headers: { accept: 'application/json' } })
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
      /**
       * 滚动全程累积所有行（BUG-316 段② 窗口化后适配）。
       * 窗口化下 DOM 里只有视口 ± overscan 行；「行数 == 双源口径」这类**全列**
       * 断言改为：滚到底逐步收集（按 data-item-id 去重），收集数必须 == 容器
       * data-total（契约），容器 data-total 必须 == API 期望 —— 两道都过才证明
       * 「既不少行（窗口化丢行 = FAIL）也不多行」。
       */
      async collectAll() {
        const scroll = document.querySelector('[data-testid="file-list-scroll"]')
        if (!scroll) return { ok: false }
        const seen = new Map()
        const collect = () => {
          for (const el of document.querySelectorAll('[data-testid="' + this.sel.row + '"]')) {
            const id = el.getAttribute('data-item-id')
            if (id != null && !seen.has(id)) {
              seen.set(id, el.getAttribute('data-source') || '')
            }
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
          download: [...seen.values()].filter((s) => s === 'download').length,
        }
      },
      scrollFileListToTop() {
        const el = document.querySelector('[data-testid="file-list-scroll"]')
        if (!el) return false
        el.scrollTop = 0
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
    /*
     * ⑤ **判据已翻转**（BUG-403，2026-10-23 用户裁定）：
     * 「文件管理点击内容应显示详情与可操作功能，而非选中」。
     *
     * 旧判据「单击行 = 选中（Explorer 语义）」与现诉求方向**相反** —— 留着它
     * 就等于要求实现做用户明确否掉的事（BUG-320 同型：判据与诉求相反＝白改）。
     * 现行判据：单击 ⇒ 详情对话框出现 + 选中数**仍为 0**；选中只由复选框触发。
     */
    const clicked = await page.evaluate(() => window.__b299.clickFirstRow())
    const afterClick = await page.evaluate(() => {
      const s = window.__b299.sel
      return {
        dialog: window.__b299.present('[data-testid="item-detail-dialog"]'),
        sel: document.querySelectorAll(`[data-testid="${s.row}"][data-selected="true"]`).length,
        name: (document.querySelector('[data-testid="item-detail-name"]') || {}).textContent || '',
        actions: document.querySelectorAll('[data-testid^="item-detail-"]').length,
      }
    })
    check('⑤ 单击行 = 打开内容详情（BUG-403）',
      clicked === true && afterClick.dialog === 1, `clicked=${clicked} dialog=${afterClick.dialog}`)
    check('⑤ 单击行**不**改选中（选中只走复选框）', afterClick.sel === 0, `selected=${afterClick.sel}`)
    check('⑤ 详情给出名称与可操作入口', afterClick.name.trim().length > 0 && afterClick.actions >= 2,
      `name=${afterClick.name} actions=${afterClick.actions}`)

    await page.evaluate(() => document.querySelector('[data-testid="item-detail-close"]')?.click())
    const afterCheck = await page.evaluate(async () => {
      const s = window.__b299.sel
      const cb = document.querySelector(`[data-testid="${s.row}"] input[type="checkbox"]`)
      if (!cb) return { sel: -1, dialog: -1 }
      cb.click()
      await new Promise((r) => setTimeout(r, 300))
      return {
        sel: document.querySelectorAll(`[data-testid="${s.row}"][data-selected="true"]`).length,
        dialog: window.__b299.present('[data-testid="item-detail-dialog"]'),
      }
    })
    check('⑤ 复选框 = 选中（显式动作，且不弹详情）',
      afterCheck.sel === 1 && afterCheck.dialog === 0,
      `selected=${afterCheck.sel} dialog=${afterCheck.dialog}`)
    // 复位选中：后续断言（尤其「选择模式下打开按钮禁用」）不该受这里影响。
    await page.evaluate(async () => {
      const s = window.__b299.sel
      document.querySelector(`[data-testid="${s.row}"] input[type="checkbox"]`)?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    /* ── ② 行数 vs 双源列表端点（牙：API 有数而 UI 空 = FAIL） ──
     * cat-all 行集 = 媒体页（PAGE 上限）∪ 受管下载成品（`/api/files`，按绝对路径去重，
     * 与 `catAllRows` 同一口径）。期望值在 Node 侧用两个端点实算 —— 不是估值。
     *
     * BUG-316 段②窗口化适配：DOM 里只渲染窗口行（全列断言必须滚动累积）。
     * 判据两道：① 容器 data-total（契约）== API 期望；② 滚到底累积数 == data-total
     * （窗口化既不丢行也不多渲染）。 */
    const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase()
    const mediaPage = await page.evaluate(async () => {
      const r = await window.__b299.api(
        '/api/media/items?hasBytes=true&sort=recent&limit=' + window.__b299.page + '&offset=0',
      )
      return r
    })
    const facts = await page.evaluate(async () => {
      const r = await window.__b299.apiDaemon('/api/files')
      return r.files || []
    })
    const taken = new Set(
      (mediaPage.items || []).map((i) => norm(i.absolutePath ?? i.filePath)).filter(Boolean),
    )
    const expectFacts = facts.filter((f) => !taken.has(norm(f.path)))
    const expectRows = (mediaPage.items || []).length + expectFacts.length
    const collected = await page.evaluate(() => window.__b299.collectAll())
    check('② 容器 data-total == 媒体页 + 受管成品（双源同口径，含路径去重）',
      collected.ok && collected.total === expectRows,
      `ui=${collected.total} media=${(mediaPage.items || []).length} facts=${expectFacts.length}`)
    check('② 滚到底累积行数 == data-total（窗口化不丢行、不多渲染）',
      collected.ok && collected.count === collected.total,
      `collected=${collected.count} total=${collected.total}`)
    // 滚回顶部（截图与后续行级断言以列表首屏为语境）
    await page.evaluate(() => window.__b299.scrollFileListToTop())

    /* ── ⑧ 共通性（BUG-299 判据 7 的可见半）：
     * 「下载」成品真的与媒体同列表、同动作；且成品中含非媒体类别（zip/exe/pdf）
     * ⇒ 「全量 = 共通 + 兼容性」在 UI 层成立，不只是后端能力。
     * 窗口化适配：download 源行数在滚动全程累积集里数（data-source DOM 锚）。 */
    const nonMedia = expectFacts.filter((f) => f.kind !== 'video' && f.kind !== 'photo' && f.kind !== 'audio')
    check('⑧ 成品行 = 受管下载成品数（下载↔文件域联动生效；滚动全程累积）',
      expectFacts.length > 0 && collected.ok && collected.download === expectFacts.length,
      `ui=${collected.download} api=${expectFacts.length}（牙：非空跑）`)
    check('⑧ 非媒体成品（zip/exe/pdf 等）与媒体同一列表（共通+兼容性）',
      nonMedia.length > 0, `nonMediaFacts=${nonMedia.length} kinds=${[...new Set(nonMedia.map((f) => f.category))].join(',')}`)

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

    /* ── ⑨ 文件树子项顺序：剧集在视频之前 ──
     * 2026-10-15 用户裁定「剧集作为核心」：文件域组织形态以剧集为纲，普通下载的
     * 扁平视频库次之。判据用 DOM 文档序（compareDocumentPosition），换回去即 FAIL。 */
    const order = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="nav-child-lib-series"]')
      const v = document.querySelector('[data-testid="nav-child-cat-video"]')
      if (!s || !v) return null
      return {
        seriesBeforeVideo: !!(s.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING),
      }
    })
    check('⑨ 文件树子项顺序：剧集在视频之前（剧集为核心）',
      order !== null && order.seriesBeforeVideo === true,
      order ? `seriesBeforeVideo=${order.seriesBeforeVideo}` : 'rows=missing')
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
