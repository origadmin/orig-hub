'use strict'

/**
 * BUG-304 · 文件域四点逻辑错位 —— UI 侧验收（活栈 CDP）。
 *
 * 判据（全部来自 docs/bugs/BUG-304.md「出口判据」，可反向证伪）：
 *   ② 侧栏不存在 `nav-child-lib-tags` / `nav-child-lib-unfiled`（空转入口 + 缺陷固化口）；
 *   ③ 文件域列表 `[data-testid="item-nobytes"]` = 0、剧集墙 `[data-testid="series-nobytes"]` = 0；
 *      （2026-10-14 BUG-306 修订：视频分类墙入口被合并裁定移除 ⇒ 改验「全部成品墙」
 *        + 图片分类墙；API 级 kind=video 牙齿见 verify_bug304_engine_runtime.py）
 *   ④ `media-tag-filter` 的 top < `media-tag-list` 的 top，且**收起态就可见**
 *      （筛选项出现在列表之后 = 功能自相矛盾）；
 *   ⑤ 剧集详情内缺失分集仍可见且带 `episode-nobytes` 标记（用户补充口径：
 *      「剧集内显示缺失」——无字节条目不是被删，是不再进成品列表）。
 *
 * 牙齿（数据级反向证伪，不靠「看起来没有」）：
 *   - ③ 的牙：同一端点**不加** `hasBytes` 时列表里确实存在无字节条目（> 0），
 *     加了之后为 0 —— 证明「UI 里看不到」是**服务端过滤**的功劳，不是数据本来就没有。
 *   - ③ 剧集墙的牙：API 确实存在 `hasBytes === false` 的剧集（> 0），
 *     前端 `loadSeries` 的 `s.hasBytes !== false` 过滤把它们挡在墙外。
 *   - ⑤ 的牙：剧集详情里 `episode-nobytes` > 0（有缺失才验得到）；
 *     找不到带缺失的剧集时**明确 FAIL**（不静默跳过——那会把「没验」包装成「通过」）。
 *
 * 引擎侧判据（unassigned=0 / 行数不变）由 cargo test + 运行时 API 探针另行验收
 * （verify_bug304_engine_runtime.py）。
 *
 * 用法：node tauri-shell/verify/verify_bug304_files_domain.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
const TOL = 1 // px

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 页面内：导航 / 几何 / API 取数 ── */
const PAGE = `
window.__b304 = {
  async api(p) {
    const r = await fetch('${TG}' + p, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
    return r.json()
  },
  present(sel) { return document.querySelectorAll(sel).length },
  rect(sel) {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }
  },
  visible(sel) {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  },
  async enterFiles() {
    // 文件树子项只在 filesOpen 时渲染；默认展开，未展开则点 chevron。
    if (!document.querySelector('[data-testid="nav-child-lib-series"]')) {
      document.querySelector('[data-testid="files-chevron"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
    }
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    await new Promise((r) => setTimeout(r, 1200))
    return true
  },
  async enterCategory(cat) {
    const el = document.querySelector('[data-testid="nav-child-' + cat + '"]')
    if (!el) return false
    el.click()
    await new Promise((r) => setTimeout(r, 1200))
    return true
  },
  async openSeriesCard(nth) {
    // 卡片根是 div（series-card-root），点击进详情；选择框/删除键不冒泡，不会被误点。
    const cards = Array.from(document.querySelectorAll('[data-testid="series-card-root"]'))
    const el = cards[nth]
    if (!el) return false
    el.click()
    await new Promise((r) => setTimeout(r, 1200))
    return true
  },
  async backToWall() {
    document.querySelector('[data-testid="series-back"]')?.click()
    await new Promise((r) => setTimeout(r, 1000))
  },
}
`

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    await page.evaluate(PAGE)

    // ── 进入文件域（剧集墙） ──
    const entered = await page.evaluate(() => window.__b304.enterFiles())
    check('进入文件域（nav-child-lib-series）', entered === true)
    if (!entered) throw new Error('无法进入文件域，后续判据全部作废')

    // ── 判据②：空转入口与缺陷固化口已删 ──
    const treeCounts = await page.evaluate(() => ({
      tags: window.__b304.present('[data-testid="nav-child-lib-tags"]'),
      unfiled: window.__b304.present('[data-testid="nav-child-lib-unfiled"]'),
      series: window.__b304.present('[data-testid="nav-child-lib-series"]'),
    }))
    check('判据② 侧栏无「标签」树项（空转入口）', treeCounts.tags === 0, `count=${treeCounts.tags}`)
    check('判据② 侧栏无「未归档」树项（缺陷固化口）', treeCounts.unfiled === 0, `count=${treeCounts.unfiled}`)
    check('判据②「剧集」树项仍在（过滤维度留在剧集墙）', treeCounts.series === 1, `count=${treeCounts.series}`)

    // ── 判据③（剧集墙）：无「未缓存」标 + API 牙 ──
    const wall = await page.evaluate(async () => {
      const nobytes = window.__b304.present('[data-testid="series-nobytes"]')
      // 响应包裹是 {items: [...]}（listSeries 同款），不是 {series: ...}。
      const all = await window.__b304.api('/api/media/series?limit=500')
      const list = all.items || []
      return {
        nobytes,
        total: list.length,
        noBytesSeries: list.filter((s) => s.hasBytes === false).length,
        undefSeries: list.filter((s) => s.hasBytes === undefined).length,
        diverge: list.filter((s) => s.coverHasBytes === false && s.hasBytes === true).length,
      }
    })
    check('判据③ 剧集墙无 series-nobytes 标记', wall.nobytes === 0, `count=${wall.nobytes}`)
    check('判据③（牙）API 确有 hasBytes=false 的剧集（证明过滤在干活）',
      wall.noBytesSeries > 0, `noBytes=${wall.noBytesSeries}/${wall.total}（undefined=${wall.undefSeries}）`)
    check('判据③（牙）存在「封面无字节但剧集有内容」的剧集（新旧谓词分叉）',
      wall.diverge > 0, `coverHasBytes=false && hasBytes=true: ${wall.diverge}`)

    // ── 判据③（分类墙）：图片 ──
    // 分类 → API kind 映射（MediaLibraryPanel CATEGORY_TO_KIND）：image→photo。
    // 为什么没有 video：BUG-306 / D19-⑦（2026-10-14）把视频分类入口与剧集合并为单一
    // 「视频」入口（fmode=lib-series）⇒ `cat:video` 墙不再可达。其 UI 判据由
    // 「剧集墙无 series-nobytes」（上方）+「全部成品墙无 item-nobytes」（下方）接替；
    // API 级 hasBytes 过滤（kind=video 0/309）仍由 verify_bug304_engine_runtime.py 验收。
    const CAT_KIND = { image: 'photo' }
    for (const cat of Object.keys(CAT_KIND)) {
      const kind = CAT_KIND[cat]
      const ok = await page.evaluate((c) => window.__b304.enterCategory(c), cat)
      check(`进入分类 ${cat}`, ok === true)
      if (!ok) continue
      const r = await page.evaluate(async (k) => {
        const ui = window.__b304.present('[data-testid="item-nobytes"]')
        const cards = window.__b304.present('[data-testid="media-grid"] > *')
        const unfiltered = await window.__b304.api(`/api/media/items?kind=${k}&limit=500`)
        const filtered = await window.__b304.api(`/api/media/items?kind=${k}&hasBytes=true&limit=500`)
        const missing = (it) => it.bytesPresence != null
          ? it.bytesPresence !== 'present'
          : (it.hasBytes === false || (!it.filePath && it.hasBytes == null))
        return {
          ui,
          cards,
          unfilteredTotal: unfiltered.total,
          unfilteredMissing: (unfiltered.items || []).filter(missing).length,
          filteredTotal: filtered.total,
          filteredMissing: (filtered.items || []).filter(missing).length,
        }
      }, kind)
      check(`判据③ ${cat} 墙无 item-nobytes 占位`, r.ui === 0, `ui=${r.ui} / cards=${r.cards}`)
      check(`判据③（牙）${cat} 不过滤时确有无字节条目`, r.unfilteredMissing > 0,
        `unfiltered ${r.unfilteredMissing}/${r.unfilteredTotal}`)
      check(`判据③（牙）${cat} hasBytes=true 时无字节条目为 0`,
        r.filteredMissing === 0, `filtered ${r.filteredMissing}/${r.filteredTotal}`)
    }

    // ── 判据③（全部成品墙 cat-all）：混合墙同样不得混入无字节条目 ──
    // 这颗牙接替被 BUG-306 合并裁定移除的 video 分类墙：全部成品墙混合渲染各 kind
    // （含视频扁平条目），不过滤时确有大量无字节条目，过滤后必须为 0。
    const allWall = await page.evaluate(async () => {
      document.querySelector('[data-testid="nav-files"]')?.click()
      await new Promise((r) => setTimeout(r, 1200))
      const ui = window.__b304.present('[data-testid="item-nobytes"]')
      const cards = window.__b304.present('[data-testid="media-grid"] > *')
      const unfiltered = await window.__b304.api('/api/media/items?limit=500')
      const filtered = await window.__b304.api('/api/media/items?hasBytes=true&limit=500')
      const missing = (it) => it.bytesPresence != null
        ? it.bytesPresence !== 'present'
        : (it.hasBytes === false || (!it.filePath && it.hasBytes == null))
      return {
        ui,
        cards,
        unfilteredMissing: (unfiltered.items || []).filter(missing).length,
        unfilteredTotal: unfiltered.total,
        filteredMissing: (filtered.items || []).filter(missing).length,
        filteredTotal: filtered.total,
      }
    })
    check('判据③ 全部成品墙无 item-nobytes 占位', allWall.ui === 0, `ui=${allWall.ui} / cards=${allWall.cards}`)
    check('判据③（牙）全部成品不过滤时确有无字节条目', allWall.unfilteredMissing > 0,
      `unfiltered ${allWall.unfilteredMissing}/${allWall.unfilteredTotal}`)
    check('判据③（牙）全部成品 hasBytes=true 时无字节条目为 0',
      allWall.filteredMissing === 0, `filtered ${allWall.filteredMissing}/${allWall.filteredTotal}`)

    // ── 判据④：标签筛选框置顶 + 收起态可见 ──
    await page.evaluate(() => window.__b304.enterFiles())
    const geom = await page.evaluate(() => {
      const filter = window.__b304.rect('[data-testid="media-tag-filter"]')
      const list = window.__b304.rect('[data-testid="media-tag-list"]')
      const toggle = document.querySelector('[data-testid="media-tag-toggle"]')
      return {
        filter,
        list,
        filterVisible: window.__b304.visible('[data-testid="media-tag-filter"]'),
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      }
    })
    check('判据④ 筛选框在收起态即可见（不依赖展开）', geom.filterVisible === true,
      `aria-expanded=${geom.expanded}`)
    check('判据④ 筛选框位于标签列表上方',
      !!geom.filter && !!geom.list && geom.filter.bottom <= geom.list.top + TOL,
      `filter.bottom=${geom.filter && geom.filter.bottom} list.top=${geom.list && geom.list.top}`)

    // ── 判据⑤：剧集详情内缺失分集仍可见 ──
    // 先用 API 找一部「确有缺失分集」的剧集（hasMediaBytes 同款判据：tg photo 恒有字节），
    // 再按 data-series-id 点它的卡 —— 不按顺序试前 N 部（那会把「没验到」包装成「没有」）。
    const target = await page.evaluate(async () => {
      const missingEp = (ep) => {
        if (ep.source === 'tg' && ep.kind === 'photo') return false
        if (ep.bytesPresence != null) return ep.bytesPresence !== 'present'
        if (ep.hasBytes != null) return ep.hasBytes === false
        return !ep.filePath
      }
      const list = (await window.__b304.api('/api/media/series?limit=500')).items || []
      for (const s of list.slice(0, 60)) {
        const d = await window.__b304.api(`/api/media/series/${s.id}`)
        const miss = (d.episodes || []).filter(missingEp).length
        if (miss > 0) return { id: s.id, title: s.title, miss, total: (d.episodes || []).length }
      }
      return null
    })
    if (!target) {
      check('判据⑤ 找到带缺失分集的剧集', false, '前 60 部剧集都没有缺失分集（库态变了？）')
    } else {
      await page.evaluate(() => window.__b304.enterFiles())
      const opened = await page.evaluate(async (sid) => {
        // 可点元素是卡内的 series-card 按钮（root div 没有 onClick）。
        const el = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
        if (!el) return false
        el.click()
        await new Promise((r) => setTimeout(r, 1500))
        return true
      }, target.id)
      check(`判据⑤ 打开剧集 ${target.id}（${target.miss}/${target.total} 分集缺失）`, opened === true)
      const detail = await page.evaluate(() => ({
        inDetail: window.__b304.present('[data-testid="series-back"]'),
        nobytes: window.__b304.present('[data-testid="episode-nobytes"]'),
        recache: window.__b304.present('[data-testid="series-recache-missing"]'),
      }))
      check('判据⑤ 已进入剧集详情', detail.inDetail === 1, `series-back=${detail.inDetail}`)
      check('判据⑤ 剧集详情内缺失分集可见且带标记',
        detail.nobytes > 0 && detail.recache === 1,
        `episode-nobytes=${detail.nobytes}, recache-missing=${detail.recache}`)
    }

    // ── 页面错误 ──
    const errs = page.pageErrors()
    check('无未捕获页面错误', errs.length === 0, errs.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — BUG-304 UI 判据`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
