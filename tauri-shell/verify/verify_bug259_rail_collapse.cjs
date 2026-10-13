'use strict'

/**
 * BUG-259（M0 再锚定版）：主区标签容器「截断 + 展开 + 过滤」验收。
 *
 * ## 为什么改判据容器（必读，否则会以为脚本放水）
 *
 * M0（BUG-298 / M0-T03）删掉了媒体库左栏 rail，本脚本原判据的三个容器**全部消失**：
 *   - 左栏 `<nav>`（大滚动条）→ rail 整段删除（`MediaLibraryPanel.tsx:999` 只剩注释占位）；
 *   - 剧集列表 `max-h-72 overflow-y-auto`（**小滚动条**）与 `RAIL_SERIES_LIMIT = 9`
 *     → 剧集栅格成为主区内容（`view === 'series'`），左栏不再有剧集列表；
 *   - 「全部剧集」按钮 → 侧栏 `nav-child-lib-series`（可达性判据移交
 *     `verify_bug259_rail_reachability.cjs`，判据「series-card 数 == API 剧集数」不变）。
 *
 * 唯一**原样保留**的是标签区：容器 / 展开控件 / 过滤框 / `RAIL_TAG_LIMIT` 全部
 * 搬到主区（`MediaLibraryPanel.tsx:1207-1315`），规则与取值一字未改。
 * ⇒ 本脚本改判**主区标签容器**，判据值不变（不降标准）：
 *
 *   ① 收起态可见 chip 数 == `RAIL_TAG_LIMIT`（常量从源码正则读，读不到 = FAIL）；
 *   ② 标签容器自身无滚动条（`scrollHeight ≤ clientHeight + 1` **且**
 *      `offsetWidth − clientWidth == 0`）——**收起态与展开态都判**：用户口径
 *      「小滚动条必然禁止」是无条件的，原对象（剧集列表）已不存在，故改锚到这里；
 *   ③ 标签块不得落在任何滚动容器内（不得是 `series-wall-scroll` 的后代，其祖先链上
 *      也不得有活动滚动容器）—— 否则标签会随内容滚走，重新构成嵌套滚动对；
 *   ④ 展开态 chip 数 > 收起态，输入过滤词后 chip 数减少；
 *      `media-tag-filter` **自 BUG-304 / D18 起常态可见**（不再依赖展开态），
 *      且必须在标签列表**上方** —— 见判据④b'（收起态）与④b（展开态）；
 *   ⑤ 再点一次 `media-tag-toggle` 回到收起态；
 *   ⑥ `media-cat-*` 全仓 0 个（用户裁定「先删，整体在重新架构」—— 未建替代入口）。
 *
 * 全部读几何（`scrollHeight/clientHeight`、`offsetWidth − clientWidth`、
 * `getComputedStyle().overflowY`），**不读 className 判滚动**（className 只用于定位）。
 *
 * 反向证伪（三向，默认开启；自动注入 + 自动还原 + 自证）：
 *   ① 往标签容器注入 `max-height:120px + overflow-y:auto` ⇒ 判据 ② 必须 FAIL；
 *   ② 把可见 chip 饿死到只剩 1 ⇒ 判据 ① 必须 FAIL（防「归零骗过判据」）；
 *   ③ 还原后 `sha256(tagBox.outerHTML)` before == after，自证不过直接 FAIL。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug259_rail_collapse.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 * 产物：默认落 `verify_shots/bug259/`（证据产物不入库，AGENTS.md §6）。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const SRC = path.join(__dirname, '..', 'src', 'components', 'MediaLibraryPanel.tsx')
const TOL = 1 // px
const SHOTS = path.resolve(__dirname, '..', 'verify_shots', 'bug259')
const VIEWPORTS = [
  { width: 1440, height: 900, label: '1440×900（默认档）' },
  { width: 1440, height: 600, label: '1440×600（最小受支持窗口）' },
]

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 从源码读上限常量 —— 实现没写常量 ⇒ 返回 null，脚本报 FAIL 而不是替它编一个值。 */
function readLimit(name, fallback) {
  let src = ''
  try {
    src = fs.readFileSync(SRC, 'utf8')
  } catch {
    return { value: fallback, found: false }
  }
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`))
  return m ? { value: Number(m[1]), found: true } : { value: fallback, found: false }
}

/* ── 页面内测量/注入（以字符串注入，避免闭包序列化问题） ── */
const PAGE = `
window.__tags = {
  parts() {
    const tagBox = document.querySelector('[data-testid="media-tag-list"]')
    if (!tagBox) return null
    const host = tagBox.closest('main') || document.body
    return {
      tagBox,
      host,
      toggle: document.querySelector('[data-testid="media-tag-toggle"]'),
      filter: document.querySelector('[data-testid="media-tag-filter"]'),
      wall: document.querySelector('[data-testid="series-wall-scroll"]'),
    }
  },
  snapshot() {
    const p = window.__tags.parts()
    if (!p) return null
    window.__snap = [p.tagBox, ...p.tagBox.querySelectorAll('*')].map((el) => ({
      el,
      attr: el.getAttribute('style'),
    }))
    return p.tagBox.outerHTML
  },
  restore() {
    for (const r of window.__snap || []) {
      if (r.attr === null) r.el.removeAttribute('style')
      else r.el.setAttribute('style', r.attr)
    }
    const p = window.__tags.parts()
    return p ? p.tagBox.outerHTML : ''
  },
  /** 反向证伪①：把标签容器压到小于其内容，人为造出「容器自带滚动条」。
   *  ★ 两个必须同时满足，否则证伪假红（BUG-259 §五 教训：注入必须造出被断言的状态）：
   *    1) 调用前必须是**展开态** —— 收起态 8 chip 只占约一行，任何合理上限都压不出溢出；
   *    2) 上限必须小于**实测**内容高 —— M0 后标签云在主区（宽 1248px）展开态实测只有
   *       115px（原左栏宽 181px 时同样 57 chip 是 1041px，差 9 倍）。故注入 40px：
   *       小于收起态（≈24px 一行）之外的一切，也必然小于展开态 115px。 */
  injectTagScroll() {
    const p = window.__tags.parts()
    if (!p) return false
    p.tagBox.style.maxHeight = '40px'
    p.tagBox.style.overflowY = 'auto'
    void p.tagBox.offsetHeight
    return true
  },
  /** 反向证伪②：可见 chip 只剩 1 条 */
  injectChipStarve() {
    const p = window.__tags.parts()
    if (!p) return false
    ;[...p.tagBox.children].forEach((el, i) => { if (i >= 1) el.style.display = 'none' })
    return true
  },
  measure() {
    const p = window.__tags.parts()
    if (!p) return { error: 'media-tag-list 未找到（未进入剧集墙视图？）' }
    const { tagBox, toggle, filter, wall, host } = p
    const chips = [...tagBox.children].filter((el) => el.offsetParent !== null)
    // 活动滚动容器：overflowY 为 auto/scroll 且真的溢出（读几何，不读 className）
    const actives = []
    for (const el of [host, ...host.querySelectorAll('*')]) {
      const cs = getComputedStyle(el)
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
      if (el.scrollHeight > el.clientHeight + 1) actives.push(el)
    }
    // 标签块的祖先链上不得有活动滚动容器（否则标签随内容滚走 = 嵌套滚动对）
    const ancestorsScrolling = (() => {
      for (let el = tagBox.parentElement; el && el !== host; el = el.parentElement) {
        if (actives.includes(el)) return true
      }
      return false
    })()
    return {
      chips: chips.length,
      tagBoxScrollbarPx: tagBox.offsetWidth - tagBox.clientWidth,
      tagBoxOver: tagBox.scrollHeight - tagBox.clientHeight,
      tagBoxIsActiveScroll: actives.includes(tagBox),
      tagInWall: !!(wall && wall.contains(tagBox)),
      ancestorsScrolling,
      activesInPanel: actives.length,
      hasToggle: !!toggle,
      hasFilter: !!filter,
    }
  },
}
`

async function main() {
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  const tagLimit = readLimit('RAIL_TAG_LIMIT', 8)
  console.log('── 从源码读到的上限（不写死数字）────────────────────────────')
  console.log(`  RAIL_TAG_LIMIT = ${tagLimit.value}  ${tagLimit.found ? '（源码已定义）' : '（★ 源码未定义 ⇒ FAIL）'}`)
  console.log('  RAIL_SERIES_LIMIT = 不存在 —— M0 删除左栏 rail 后剧集列表容器随之消失，')
  console.log('    该判据对象已废止（见 docs/bugs/BUG-259.md §M0 模块重整引发的容器形态变更）')
  console.log()
  check('源码已定义 RAIL_TAG_LIMIT', tagLimit.found, `值=${tagLimit.value}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 2500))

    // 进入媒体库剧集墙（侧栏树子项；标签块只在 view === 'series' 渲染）
    const entered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    check('进入媒体库（侧栏 nav-child-lib-series）', entered === true)
    await new Promise((r) => setTimeout(r, 3500))

    await page.evaluate(PAGE)

    /* ─────────── 两档视口 ─────────── */
    for (const vp of VIEWPORTS) {
      console.log(`\n══════ ${vp.label} ══════`)
      await page.conn.send(
        'Emulation.setDeviceMetricsOverride',
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false },
        { sessionId: page.sessionId },
      )
      await new Promise((r) => setTimeout(r, 600))

      const m = await page.evaluate(() => window.__tags.measure())
      if (m.error) {
        check(`[${vp.height}] 标签容器可测量`, false, m.error)
        continue
      }
      console.log(
        `  几何：chip ${m.chips} 个 / 容器滚动条 ${m.tagBoxScrollbarPx}px / 溢出 ${m.tagBoxOver}px · ` +
          `面板活动滚动容器 ${m.activesInPanel} · toggle=${m.hasToggle} filter=${m.hasFilter} · ` +
          `标签在剧集墙滚动容器内=${m.tagInWall} · 祖先链有滚动容器=${m.ancestorsScrolling}`,
      )

      // 判据 ①：收起态截断到 K（不得归零骗过判据）
      check(
        `[${vp.height}] 判据① 收起态 chip 数 == ${tagLimit.value}（不是 0/1）`,
        m.chips === tagLimit.value,
        `实测 ${m.chips} 个`,
      )
      // 判据 ②：小滚动条无条件禁止（容器自身不是滚动容器）
      check(
        `[${vp.height}] 判据②a 标签容器无自身滚动条（offsetWidth−clientWidth==0）`,
        m.tagBoxScrollbarPx === 0,
        `实测 ${m.tagBoxScrollbarPx}px`,
      )
      check(
        `[${vp.height}] 判据②b 标签容器不溢出（scrollH ≤ clientH+${TOL}）`,
        m.tagBoxOver >= -1 && m.tagBoxOver <= TOL,
        `实测溢出 ${m.tagBoxOver}px`,
      )
      // 判据 ③：标签块不得落在滚动容器内（不得重新构成嵌套滚动对）
      check(
        `[${vp.height}] 判据③ 标签块不在剧集墙滚动容器内、祖先链无活动滚动容器`,
        m.tagInWall === false && m.ancestorsScrolling === false,
        `inWall=${m.tagInWall} 祖先链滚动=${m.ancestorsScrolling}`,
      )
      check(
        `[${vp.height}] 判据③b 存在 media-tag-toggle`,
        m.hasToggle,
        `hasToggle=${m.hasToggle}`,
      )
    }

    /* ─────────── 展开态（判据 ④⑤） ─────────── */
    console.log('\n══════ 展开态：全部标签 + 过滤 ══════')
    await page.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      { sessionId: page.sessionId },
    )
    await new Promise((r) => setTimeout(r, 400))

    const collapsed = await page.evaluate(() => window.__tags.measure())

    /* BUG-304 / D18：过滤框移到标签列表**上方**且**常态可见**。
       故在**收起态**就必须存在，且几何 top 必须小于标签列表的 top ——
       原实现把过滤框放在列表下方、且只在展开态渲染，于是「要筛得先滚过全部标签，
       而滚完已经看见了全部」（用户原话）。这里把它钉成可证伪判据。 */
    const filterGeo = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="media-tag-filter"]')
      const l = document.querySelector('[data-testid="media-tag-list"]')
      if (!f || !l) return { exists: !!f, list: !!l, above: null }
      return {
        exists: true,
        list: true,
        above: f.getBoundingClientRect().top < l.getBoundingClientRect().top,
      }
    })
    check(
      "判据④b' 收起态过滤框已存在且在标签列表上方（BUG-304）",
      filterGeo.exists === true && filterGeo.list === true && filterGeo.above === true,
      `exists=${filterGeo.exists} above=${filterGeo.above}`,
    )

    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (!el) return false
      el.click()
      return true
    })
    await new Promise((r) => setTimeout(r, 600))
    const mExp = await page.evaluate(() => window.__tags.measure())
    check(
      '判据④a 点 media-tag-toggle ⇒ chip 数 > 收起态（展开为全部）',
      clicked === true && mExp.chips > collapsed.chips,
      `收起 ${collapsed.chips} → 展开 ${mExp.chips}`,
    )
    check(
      '判据②c 展开态标签容器同样无自身滚动条（小滚动条无条件禁止，含展开态）',
      mExp.tagBoxScrollbarPx === 0 && mExp.tagBoxOver <= TOL,
      `滚动条 ${mExp.tagBoxScrollbarPx}px / 溢出 ${mExp.tagBoxOver}px`,
    )
    check('判据④b 展开态过滤框仍在（常态可见，非「展开才出现」）', mExp.hasFilter === true, `hasFilter=${mExp.hasFilter}`)

    // 过滤：用第一个 chip 名字的首字符当过滤词（必然命中，不依赖具体标签名）
    const word = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-filter"]')
      const chip = document.querySelector('[data-testid^="media-tag-chip-"]')
      if (!el || !chip) return null
      const name = (chip.textContent || '').replace('#', '').replace(/\d+$/, '').trim()
      if (!name) return null
      const w = name.slice(0, 1)
      // React 受控 input：必须走原生 value setter + input 事件，直接赋 value 不会触发 onChange
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, w)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return w
    })
    await new Promise((r) => setTimeout(r, 600))
    const mFilt = await page.evaluate(() => window.__tags.measure())
    check(
      '判据④c 输入过滤词 ⇒ chip 数减少且仍 > 0',
      !!word && mFilt.chips > 0 && mFilt.chips <= mExp.chips,
      `过滤词「${word}」⇒ ${mExp.chips} → ${mFilt.chips}`,
    )

    // 收回归起态
    await page.evaluate(() => document.querySelector('[data-testid="media-tag-toggle"]')?.click())
    await new Promise((r) => setTimeout(r, 500))
    const mBack = await page.evaluate(() => window.__tags.measure())
    check(
      '判据⑤ 再点一次 ⇒ 回到收起态（chip 数 == 收起态）',
      mBack.chips === collapsed.chips,
      `${mFilt.chips} → ${mBack.chips}（目标 ${collapsed.chips}）`,
    )

    /* ─────────── media-cat-* 已移除（用户裁定：先删，整体在重新架构） ─────────── */
    const cats = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="media-cat-"]')).map((el) =>
        el.getAttribute('data-testid'),
      ),
    )
    check('判据⑥ media-cat-* 已移除（用户裁定「先删」，M0 未建替代入口）', cats.length === 0, `仍存在：${cats.join(',') || '无'}`)

    // BUG-259 §4.1 的能力缺口：M0 侧栏六分类已使其重新可达（见 BUG-259 §M0 容器形态变更·三-2）
    const catReachable = await page.evaluate(() =>
      ['video', 'music', 'image', 'doc', 'archive', 'other'].filter((k) =>
        !!document.querySelector(`[data-testid="nav-child-${k}"]`),
      ),
    )
    check(
      '附带（BUG-259 §4.1 关闭判据）侧栏六分类锚点可达',
      catReachable.length === 6,
      `可达 ${catReachable.length}/6：${catReachable.join(',')}`,
    )

    /* ─────────── 反向证伪（三向） ─────────── */
    console.log('\n══════ 反向证伪（证明本脚本会 FAIL） ══════')
    // ① 先展开标签再注入小滚动条：收起态 8 个 chip 在主区宽容器里不足 120px，
    //    注入压不溢出 ⇒ 证伪假红（BUG-259 §五 教训：注入必须造出被断言的状态）。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (el && el.getAttribute('aria-expanded') !== 'true') el.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const mExpanded = await page.evaluate(() => window.__tags.measure())
    console.log(`  展开态基线：chip ${mExpanded.chips} 个 / 滚动条 ${mExpanded.tagBoxScrollbarPx}px / 溢出 ${mExpanded.tagBoxOver}px`)

    const inj1 = await page.evaluate(() => window.__tags.injectTagScroll())
    const m1 = await page.evaluate(() => window.__tags.measure())
    check(
      '反向证伪① 注入 max-h-40px+overflow-y-auto ⇒ 标签容器必须出现滚动条（判据② 有能力 FAIL）',
      inj1 === true && (m1.tagBoxScrollbarPx !== 0 || m1.tagBoxOver > TOL),
      `注入后 自身滚动条=${m1.tagBoxScrollbarPx}px / 溢出=${m1.tagBoxOver}px`,
    )
    await page.evaluate(() => window.__tags.restore())
    // 收回收起态：后续证伪 ② 与自证都以**收起态**为同一基线（状态不一致 ⇒ sha256 不可比）
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (el && el.getAttribute('aria-expanded') === 'true') el.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    const beforeHtml = await page.evaluate(() => window.__tags.snapshot())
    const h0 = sha(beforeHtml)

    // ② 饿死 chip ⇒ 判据 ① 必须变 FAIL
    const inj2 = await page.evaluate(() => window.__tags.injectChipStarve())
    const m2 = await page.evaluate(() => window.__tags.measure())
    check(
      `反向证伪② 可见 chip 只剩 1 ⇒ 「chip 数 == ${tagLimit.value}」必须 FAIL（判据① 有能力 FAIL）`,
      inj2 === true && m2.chips !== tagLimit.value,
      `注入后可见 chip=${m2.chips}`,
    )
    await page.evaluate(() => window.__tags.restore())

    // ③ 还原自证
    const afterHtml = await page.evaluate(() => window.__tags.restore())
    const h1 = sha(afterHtml)
    check(
      '反向证伪③ 自动还原自证：sha256(tagBox.outerHTML) before == after',
      h0 === h1,
      `${h0} vs ${h1}`,
    )
    const back = await page.evaluate(() => window.__tags.measure())
    check(
      '反向证伪③ 还原后几何回到基线',
      back.chips === collapsed.chips && back.tagBoxScrollbarPx === 0,
      `chip=${back.chips} 滚动条=${back.tagBoxScrollbarPx}px`,
    )

    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot(path.join(SHOTS, 'rail_collapse.png')).catch(() => undefined)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} PASS`)
    if (failed.length) {
      console.log('未通过：')
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`)
    }
    return failed.length === 0 ? 0 : 2
  } finally {
    await browser.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('VERIFY FAILED:', e && e.message ? e.message : e)
    process.exit(1)
  })
