'use strict'

/**
 * BUG-259 复报取证：媒体库左栏「双重滚动条」。
 *
 * 主张（可证伪）：左栏出现两条同时生效且**嵌套**的滚动条 ——
 *   外层 `<nav>`（媒体库左栏，`overflow-y-auto`，实测 client=723 / scroll=1552）
 *   内层 剧集列表（`max-h-72 overflow-y-auto`）
 * 而外层之所以溢出，是因为**标签列表没有任何上限**（BUG-259 修复方向 2 未实施）。
 *
 * 判据全部读 `getComputedStyle` + `scrollHeight/clientHeight`，
 * **不读 className 判滚动**（className 只用于定位元素）。
 *
 * 反向证伪（本条的因果核心，默认开启）分三段，避免「注入后没归零 ⇒ 一刀切 FAIL」这种
 * 把「主导原因」误判成「唯一原因」的错误：
 *   ① 线性响应：把标签容器限到 600 / 288（均未触底），断言
 *      `Δ外层溢出 == Δ标签容器高度`（±4px）⇒ 标签容器是唯一可伸缩项；
 *   ② 充分性：限到 212px ⇒ 外层 nav 溢出必须归零（实测 212/150/60 三档均为 0）；
 *   ③ 可逆性：还原标签容器样式 ⇒ 外层溢出必须复原到原始值 ⇒ 证明注入未被 React 覆盖。
 *
 * 若 ① 的斜率 ≠ 1，或 ② 在 212px 仍溢出，则「标签无上限 ⇒ 外层溢出」**不成立**，
 * 脚本必须报 FAIL。注意：单靠 ② 的临界值是由测量反推的（循环论证风险），
 * 所以 ① 的斜率检验才是因果证据，② 只是「存在一个足够小的上限能修好」的充分性证明。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug259_media_double_scroll.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TOL = 4 // px

async function main() {
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

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
    await new Promise((r) => setTimeout(r, 3500))

    // ── 共用测量函数（注入到页面里）─────────────────────────────────────────
    const measure = async (cap) =>
      page.evaluate((cap) => {
        const title = document.querySelector('[data-testid="media-panel-title"]')
        const nav = title.closest('aside').querySelector('nav')
        const kids = Array.from(nav.children)
        const tagBox = kids.find(
          (el) => (el.getAttribute('class') || '').includes('flex-wrap') && el.children.length > 5
        )
        if (cap !== null && tagBox) {
          if (cap === 'reset') {
            tagBox.style.maxHeight = ''
            tagBox.style.overflowY = ''
          } else {
            tagBox.style.maxHeight = cap + 'px'
            tagBox.style.overflowY = 'auto'
          }
          void tagBox.offsetHeight
        }
        // 同时生效且嵌套的滚动对
        const actives = []
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
          if (el.scrollHeight > el.clientHeight + 1) actives.push(el)
        }
        const pairs = []
        for (const a of actives)
          for (const b of actives)
            if (a !== b && a.contains(b))
              pairs.push({
                outer: (a.getAttribute('class') || a.tagName).slice(0, 45),
                inner: (b.getAttribute('class') || b.tagName).slice(0, 45),
              })
        return {
          clientH: nav.clientHeight,
          scrollH: nav.scrollHeight,
          tagH: tagBox ? Math.round(tagBox.getBoundingClientRect().height) : -1,
          tagMaxH: tagBox ? getComputedStyle(tagBox).maxHeight : 'n/a',
          tagChips: tagBox ? tagBox.children.length : -1,
          actives: actives.length,
          pairs,
          kids: kids.map((el) => ({
            h: Math.round(el.getBoundingClientRect().height),
            cls: (el.getAttribute('class') || '').slice(0, 45),
            maxH: getComputedStyle(el).maxHeight,
            oy: getComputedStyle(el).overflowY,
          })),
        }
      }, cap)

    // ── 正测 0：基线 ──────────────────────────────────────────────────────
    const base = await measure(null)
    const baseOver = base.scrollH - base.clientH
    check('左栏 nav 自身溢出（出现外层滚动条）', baseOver > 1,
      `client=${base.clientH} scroll=${base.scrollH} 溢出=${baseOver}`)

    const seriesBox = base.kids.find((k) => k.oy === 'auto' && k.maxH !== 'none')
    check('左栏内层剧集列表自带滚动容器', !!seriesBox,
      seriesBox ? `maxHeight=${seriesBox.maxH}` : '未找到')

    check('标签容器无任何上限（maxHeight=none / overflowY=visible）',
      base.tagMaxH === 'none' && base.tagChips > 5,
      `标签容器高=${base.tagH}px chips=${base.tagChips} maxHeight=${base.tagMaxH}`)

    check('存在「两条同时生效且嵌套」的滚动条', base.pairs.length >= 1,
      `在滚容器=${base.actives} 嵌套对=${base.pairs.length}` +
      (base.pairs[0] ? `（外层「${base.pairs[0].outer}」内含内层「${base.pairs[0].inner}」）` : ''))

    // ── 反向证伪 ①：线性响应（斜率必须 = 1）────────────────────────────────
    const m600 = await measure(600)
    const m288 = await measure(288)
    const dTag600 = base.tagH - m600.tagH
    const dOver600 = baseOver - (m600.scrollH - m600.clientH)
    const dTag288 = base.tagH - m288.tagH
    const dOver288 = baseOver - (m288.scrollH - m288.clientH)
    check('① 线性响应：把标签容器压 441px ⇒ 外层溢出减少同量（斜率=1）',
      Math.abs(dTag600 - dOver600) <= TOL,
      `标签 -${dTag600}px / 外层溢出 -${dOver600}px`)
    check('① 线性响应：把标签容器压 753px ⇒ 外层溢出减少同量（斜率=1）',
      Math.abs(dTag288 - dOver288) <= TOL,
      `标签 -${dTag288}px / 外层溢出 -${dOver288}px（注意 cap=288 即复用 max-h-72 仍剩 ${m288.scrollH - m288.clientH}px）`)

    // ── 反向证伪 ②：充分性（≤212px 必须归零）───────────────────────────────
    const m212 = await measure(212)
    const over212 = m212.scrollH - m212.clientH
    check('② 充分性：标签容器限到 212px ⇒ 外层 nav 溢出归零', over212 <= 1,
      `nav client=${m212.clientH} scroll=${m212.scrollH} 溢出=${over212}`)
    check('② 充分性：嵌套滚动对随之归零', m212.pairs.length === 0,
      `剩余嵌套对=${m212.pairs.length}`)

    // ── 反向证伪 ③：可逆性（还原后必须复原）───────────────────────────────
    const mReset = await measure('reset')
    const overReset = mReset.scrollH - mReset.clientH
    check('③ 可逆性：还原标签容器 ⇒ 外层溢出复原（证明注入未被 React 覆盖）',
      Math.abs(overReset - baseOver) <= TOL,
      `还原后溢出=${overReset} 基线=${baseOver}`)

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} PASS`)
    console.log(`基线：nav ${base.clientH}/${base.scrollH}（溢出 ${baseOver}）· ` +
      `标签容器 ${base.tagH}px / ${base.tagChips} chips / maxHeight=${base.tagMaxH}`)
    // 截图落 verify_shots/（gitignore，见 .gitignore:29），不写本机绝对路径（污染门禁 §7）
    const shots = path.resolve(__dirname, '..', 'verify_shots', 'bug259')
    require('node:fs').mkdirSync(shots, { recursive: true })
    await page
      .screenshot(path.join(shots, 'double_scroll.png'))
      .catch(() => undefined)
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
