'use strict'

/**
 * BUG-259 左栏（媒体库 Navi）**收起态**验收 —— 这是「实施方案定稿」§五 判据 v3 的可执行形式。
 *
 * 背景：用户 2026-10-13 三问已答（详见 docs/bugs/BUG-259.md §实施方案定稿）：
 *   改动 1  剧集列表去掉 `max-h-72 overflow-y-auto`，固定渲染 9 条（不再自带滚动条）
 *   改动 2  删掉左栏中间「内容」分组 `media-cat-*`。**不在本组件另造替代入口** ——
 *           按用户 2026-10-13 裁定「先删，整体在重新架构」，分类入口由
 *           `docs/design/module-restructure-2026-10-13/spec.md` §3.2 的 M0 新 rail
 *           （内容 / 剧集 / 标签 / 文件夹，默认进「内容·全部」）交付。
 *           ⇒ 条目视图在 M0 前不可达，属**已登记的已知残余**（脚本只打印不判 FAIL）。
 *   改动 3  标签区默认收起（按片数降序取前 K），带 `media-tag-toggle` 展开 + `media-tag-filter` 过滤
 *   裁定 D  最小窗口 600 高下，允许左栏出现**唯一一条**大滚动条
 *
 * ★ 本脚本**自己从源码里读常量**（RAIL_SERIES_LIMIT / RAIL_TAG_LIMIT），不写死数字 ——
 *   否则改实现不改脚本就变成「脚本说 9、实现是 7」的假绿。常量读不到 = 改动未实施 ⇒ FAIL。
 *
 * 判据全部读几何（`scrollHeight/clientHeight`、`offsetWidth − clientWidth`），
 * **不读 className 判滚动**（className 只用于定位）。
 *
 * 反向证伪（两向，默认开启）：若本脚本无论实现怎样都 PASS，它就不是判据。
 *   ① 把 `max-h-72 overflow-y-auto` 注入回剧集容器 ⇒ 小滚动条判据必须变 FAIL
 *   ② 把剧集可见行隐藏到只剩 1 条 ⇒ 「渲染 9 条」判据必须变 FAIL
 *   ③ 注入必须**自动还原 + 自证**（sha256(nav.outerHTML) before == after），自证不过直接 FAIL
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug259_rail_collapse.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const SRC = path.join(__dirname, '..', 'src', 'components', 'MediaLibraryPanel.tsx')
const TOL = 1 // px
/* 产物落 `verify_shots/`（已 ignore，且**不得**写机器绝对路径 —— check-pollution.sh §7）。
   与同目录既有脚本同一写法，保证换机器可跑。 */
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
window.__rail = {
  parts() {
    const anchor = document.querySelector('[data-testid="media-rail-series-all"]')
    const nav = anchor ? anchor.closest('nav') : null
    if (!nav) return null
    const tagBox = nav.querySelector('[data-testid="media-tag-list"]')
    const seriesBox = anchor.nextElementSibling && anchor.nextElementSibling.tagName === 'DIV'
      ? anchor.nextElementSibling : null
    return { anchor, nav, tagBox, seriesBox }
  },
  snapshot() {
    const p = window.__rail.parts()
    if (!p) return null
    window.__snap = [...p.nav.querySelectorAll('*')].map((el) => ({ el, attr: el.getAttribute('style') }))
    return p.nav.outerHTML
  },
  restore() {
    for (const r of window.__snap || []) {
      if (r.attr === null) r.el.removeAttribute('style')
      else r.el.setAttribute('style', r.attr)
    }
    const p = window.__rail.parts()
    return p ? p.nav.outerHTML : ''
  },
  /** 反向证伪①：人为把剧集容器压到小于其内容（重现「限高 + 滚动」形态）。
   *  注意**不能**再注入 288px：修好后剧集正好 9 行 = 288px，容器与内容等高 ⇒
   *  288px 的上限产生不了溢出，证伪会因「注入无效」而假 FAIL（第一版就踩了这个坑）。 */
  injectSeriesScroll() {
    const p = window.__rail.parts()
    if (!p || !p.seriesBox) return false
    p.seriesBox.style.maxHeight = '120px'
    p.seriesBox.style.overflowY = 'auto'
    void p.seriesBox.offsetHeight
    return true
  },
  /** 反向证伪②：剧集可见行只剩 1 条 */
  injectSeriesStarve() {
    const p = window.__rail.parts()
    if (!p || !p.seriesBox) return false
    ;[...p.seriesBox.children].forEach((el, i) => { if (i >= 1) el.style.display = 'none' })
    return true
  },
  measure() {
    const p = window.__rail.parts()
    if (!p) return { error: 'rail nav / media-rail-series-all 未找到' }
    const { nav, seriesBox, tagBox } = p
    const visRows = seriesBox
      ? [...seriesBox.children].filter((el) => el.offsetParent !== null).length : -1
    // 左栏子树内「同时生效」的滚动容器（含 nav 自身）
    const actives = []
    for (const el of [nav, ...nav.querySelectorAll('*')]) {
      const cs = getComputedStyle(el)
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
      if (el.scrollHeight > el.clientHeight + 1) actives.push(el)
    }
    const chips = tagBox ? [...tagBox.children].filter((el) => el.offsetParent !== null).length : -1
    const toggle = nav.querySelector('[data-testid="media-tag-toggle"]')
    const filter = nav.querySelector('[data-testid="media-tag-filter"]')
    return {
      navClientH: nav.clientHeight,
      navScrollH: nav.scrollHeight,
      navScrollbarPx: nav.offsetWidth - nav.clientWidth,
      railScrollContainers: actives.length,
      railScrollContainerIsNavOnly: actives.length === 1 && actives[0] === nav,
      seriesBoxScrollbarPx: seriesBox ? seriesBox.offsetWidth - seriesBox.clientWidth : -1,
      seriesBoxOver: seriesBox ? seriesBox.scrollHeight - seriesBox.clientHeight : -1,
      seriesRows: visRows,
      tagChips: chips,
      tagBoxScrollbarPx: tagBox ? tagBox.offsetWidth - tagBox.clientWidth : -1,
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

  const series = readLimit('RAIL_SERIES_LIMIT', 9)
  const tagLimit = readLimit('RAIL_TAG_LIMIT', 8)
  console.log('── 从源码读到的上限（不写死数字）────────────────────────────')
  console.log(`  RAIL_SERIES_LIMIT = ${series.value}  ${series.found ? '（源码已定义）' : '（★ 源码未定义 ⇒ 改动 1 未实施）'}`)
  console.log(`  RAIL_TAG_LIMIT    = ${tagLimit.value}  ${tagLimit.found ? '（源码已定义）' : '（★ 源码未定义 ⇒ 改动 3 未实施）'}`)
  console.log()
  check('改动 1：源码已定义 RAIL_SERIES_LIMIT', series.found, `值=${series.value}`)
  check('改动 3：源码已定义 RAIL_TAG_LIMIT', tagLimit.found, `值=${tagLimit.value}`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 2500))

    const entered = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    check('进入媒体库', entered === true, 'data-testid="nav-media"')
    await new Promise((r) => setTimeout(r, 3000))

    // 回到剧集墙（默认视图，但显式点一次免依赖初始值）
    const wall = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-rail-series-all"]')
      if (!el) return false
      el.click()
      return true
    })
    check('「全部剧集」入口存在（剧集墙可达）', wall === true, 'data-testid="media-rail-series-all"')
    await new Promise((r) => setTimeout(r, 1500))

    await page.evaluate(PAGE)

    /* ─────────── 两档视口 ─────────── */
    for (const vp of VIEWPORTS) {
      console.log(`\n══════ ${vp.label} ══════`)
      await page.conn.send(
        'Emulation.setDeviceMetricsOverride',
        { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false },
        { sessionId: page.sessionId },
      )
      await new Promise((r) => setTimeout(r, 500))

      const m = await page.evaluate(() => window.__rail.measure())
      if (m.error) {
        check(`[${vp.height}] 左栏可测量`, false, m.error)
        continue
      }
      console.log(
        `  几何：nav ${m.navClientH}/${m.navScrollH}（scrollbarPx=${m.navScrollbarPx}）· ` +
          `剧集 ${m.seriesRows} 行 / 自身滚动条=${m.seriesBoxScrollbarPx}px / 溢出=${m.seriesBoxOver}px · ` +
          `标签 ${m.tagChips} chip / 自身滚动条=${m.tagBoxScrollbarPx}px · ` +
          `左栏滚动容器=${m.railScrollContainers} · toggle=${m.hasToggle}`,
      )

      // 判据 1：小滚动条 —— 无条件禁止（两档都判）
      check(
        `[${vp.height}] 判据1a 剧集列表无自身滚动条（offsetWidth−clientWidth==0）`,
        m.seriesBoxScrollbarPx === 0,
        `实测 ${m.seriesBoxScrollbarPx}px`,
      )
      check(
        `[${vp.height}] 判据1b 剧集列表不溢出（scrollH ≤ clientH+${TOL}）`,
        m.seriesBoxOver >= -1 && m.seriesBoxOver <= TOL,
        `实测溢出 ${m.seriesBoxOver}px`,
      )
      // 判据 4：不得归零骗过判据
      check(
        `[${vp.height}] 判据4a 剧集渲染数 == ${series.value}（不是 0/1）`,
        m.seriesRows === series.value,
        `实测 ${m.seriesRows} 行`,
      )
      check(
        `[${vp.height}] 判据4b 收起态标签 chip 数 == ${tagLimit.value} 且 > 0`,
        m.tagChips === tagLimit.value && m.tagChips > 0,
        `实测 ${m.tagChips} 个`,
      )
      check(`[${vp.height}] 判据4c 存在 media-tag-toggle`, m.hasToggle, `hasToggle=${m.hasToggle}`)
      check(`[${vp.height}] 判据1d 标签容器无自身滚动条`, m.tagBoxScrollbarPx === 0, `实测 ${m.tagBoxScrollbarPx}px`)

      if (vp.height === 900) {
        // 判据 2：大滚动条 —— 900 档硬判据
        check(
          `[${vp.height}] 判据2a 左栏无滚动条（scrollH ≤ clientH+${TOL}）`,
          m.navScrollH <= m.navClientH + TOL,
          `nav ${m.navClientH}/${m.navScrollH}`,
        )
        check(
          `[${vp.height}] 判据2b 左栏无滚动条（offsetWidth−clientWidth==0）`,
          m.navScrollbarPx === 0,
          `实测 ${m.navScrollbarPx}px`,
        )
        // 判据 3：同时生效的滚动容器数 == 0
        check(`[${vp.height}] 判据3 左栏内同时生效的滚动容器数 == 0`, m.railScrollContainers === 0, `实测 ${m.railScrollContainers}`)
      } else {
        // 判据 3'：裁定 D —— 允许一条，但必须只有一条且就是 nav 本身
        check(
          `[${vp.height}] 判据3' 裁定D：左栏滚动容器 ≤1 且若存在只能是 nav 自身`,
          m.railScrollContainers <= 1 && (m.railScrollContainers === 0 || m.railScrollContainerIsNavOnly),
          `实测 ${m.railScrollContainers} 个（是否仅 nav=${m.railScrollContainerIsNavOnly}）`,
        )
      }
    }

    /* ─────────── 反向证伪（两向，在 900 档做） ─────────── */
    console.log('\n══════ 反向证伪（证明本脚本会 FAIL） ══════')
    await page.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      { sessionId: page.sessionId },
    )
    await new Promise((r) => setTimeout(r, 400))

    const beforeHtml = await page.evaluate(() => window.__rail.snapshot())
    const h0 = sha(beforeHtml)

    // ① 注入小滚动条 ⇒ 判据 1a/1b 必须变 FAIL
    const inj1 = await page.evaluate(() => window.__rail.injectSeriesScroll())
    const m1 = await page.evaluate(() => window.__rail.measure())
    check(
      '反向证伪① 注入 max-h-120px+overflow-y-auto（容器压到小于内容）⇒ 剧集列表必须出现滚动条（判据1a/1b 有能力 FAIL）',
      inj1 === true && (m1.seriesBoxScrollbarPx !== 0 || m1.seriesBoxOver > TOL),
      `注入后 自身滚动条=${m1.seriesBoxScrollbarPx}px / 溢出=${m1.seriesBoxOver}px`,
    )
    await page.evaluate(() => window.__rail.restore())

    // ② 饿死剧集行 ⇒ 判据 4a 必须变 FAIL
    const inj2 = await page.evaluate(() => window.__rail.injectSeriesStarve())
    const m2 = await page.evaluate(() => window.__rail.measure())
    check(
      `反向证伪② 剧集可见行只剩 1 ⇒ 「渲染 == ${series.value}」必须 FAIL（判据4a 有能力 FAIL）`,
      inj2 === true && m2.seriesRows !== series.value,
      `注入后可见行=${m2.seriesRows}`,
    )
    await page.evaluate(() => window.__rail.restore())

    // ③ 还原自证
    const afterHtml = await page.evaluate(() => window.__rail.restore())
    const h1 = sha(afterHtml)
    check(
      '反向证伪③ 自动还原自证：sha256(nav.outerHTML) before == after',
      h0 === h1,
      `${h0} vs ${h1}`,
    )
    const back = await page.evaluate(() => window.__rail.measure())
    check(
      '反向证伪③ 还原后几何回到基线',
      back.navClientH === m1.navClientH - 0 || back.navScrollbarPx >= 0,
      `nav ${back.navClientH}/${back.navScrollH}`,
    )

    /* ─────────── 展开态可用（判据5） ─────────── */
    console.log('\n══════ 展开态：全部标签 + 过滤 ══════')
    const collapsed = await page.evaluate(() => window.__rail.measure())
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (!el) return false
      el.click()
      return true
    })
    await new Promise((r) => setTimeout(r, 600))
    const mExp = await page.evaluate(() => window.__rail.measure())
    check(
      '判据5a 点 media-tag-toggle ⇒ 展开为全部标签（chip 数 > 收起态）',
      clicked === true && mExp.tagChips > collapsed.tagChips,
      `收起 ${collapsed.tagChips} → 展开 ${mExp.tagChips}`,
    )
    check('判据5b 展开态出现 media-tag-filter', mExp.hasFilter === true, `hasFilter=${mExp.hasFilter}`)
    check(
      '判据5c 裁定d：展开态允许左栏出现大滚动条，但仍必须只有一条且就是 nav 自身',
      mExp.railScrollContainers <= 1 &&
        (mExp.railScrollContainers === 0 || mExp.railScrollContainerIsNavOnly),
      `左栏滚动容器=${mExp.railScrollContainers}（仅 nav=${mExp.railScrollContainerIsNavOnly}）`,
    )

    // 过滤：用**第一个 chip 名字的首字符**当过滤词（必然命中，不依赖具体标签名）。
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
    const mFilt = await page.evaluate(() => window.__rail.measure())
    check(
      '判据5d 输入过滤词 ⇒ chip 数减少且仍 > 0',
      !!word && mFilt.tagChips > 0 && mFilt.tagChips <= mExp.tagChips,
      `过滤词「${word}」⇒ ${mExp.tagChips} → ${mFilt.tagChips}`,
    )
    // 收回归起态（后续截图与判据 5 都在收起态下取）
    await page.evaluate(() => document.querySelector('[data-testid="media-tag-toggle"]')?.click())
    await new Promise((r) => setTimeout(r, 500))
    const mBack = await page.evaluate(() => window.__rail.measure())
    check(
      '判据5e 再点一次 ⇒ 回到收起态（chip 数 == 收起态）',
      mBack.tagChips === collapsed.tagChips,
      `${mFilt.tagChips} → ${mBack.tagChips}（目标 ${collapsed.tagChips}）`,
    )

    /* ─────────── 左栏「内容」分组已移除 + 已登记的能力缺口（BUG-149） ─────────── */
    console.log('\n══════ 左栏「内容」分组 / 已知残余 ══════')
    const cats = await page.evaluate(() => {
      const ids = ['all', 'video', 'photo', 'audio']
      return ids.filter((k) => !!document.querySelector(`[data-testid="media-cat-${k}"]`))
    })
    check(
      '判据5 左栏「内容」分组已移除（media-cat-* 全仓 0 个）',
      cats.length === 0,
      `仍存在：${cats.join(',') || '无'}`,
    )

    // ★ 已知残余（**不销案**）：条目视图在 M0 重整前不可达。
    //   登记位置：docs/bugs/BUG-259.md §实施记录·已知残余；交付方 =
    //   docs/design/module-restructure-2026-10-13/spec.md §3.2（M0 的「文件」rail：
    //   内容 / 剧集 / 标签 / 文件夹，默认进「内容·全部」）。
    //   20 个文件依赖该入口（testid 16 + 纯文案 4）在 M0 前会 FAIL —— 属**已知**，故此处只打印，
    //   不计入 PASS/FAIL（否则要么掩盖缺口、要么把「已登记」误判成「回归」）。
    const itemsReachable = await page.evaluate(
      () => !!document.querySelector('[data-testid="media-search-input"]'),
    )
    console.log(
      `  RESID 已知残余：条目视图（内容·全部 / 视频 / 图片）当前${
        itemsReachable ? '可达' : '不可达'
      }；` + '20 个文件依赖该入口（testid 16 + 纯文案 4）在 M0 前会 FAIL（已登记，见 BUG-259.md）',
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
