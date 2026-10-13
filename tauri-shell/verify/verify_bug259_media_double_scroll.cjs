'use strict'

/**
 * BUG-259 · 媒体库「双重滚动条」回归判据（M0 再锚定版）。
 *
 * ## 本脚本的性质变更（必读）
 *
 * 原版是**「缺陷存在」取证脚本**：断言左栏 `<nav>` 自身溢出 + 与剧集列表
 * （`max-h-72 overflow-y-auto`）构成同时生效且**嵌套**的滚动对，并用「限标签容器」的
 * 三段注入证明因果关系。头部原告警：「修复落地后它会开始报 FAIL —— 那是修复成功的信号」。
 *
 * M0（BUG-298 / M0-T03）让该告警**作废**：左栏 rail 整段删除，取证的三个容器
 * （左栏 nav、剧集列表、标签容器的左栏父级）全部消失 ⇒ **双重滚动在这个形态上
 * 已不可能重现**。原判据不是被放宽，而是随容器一起退役。
 *
 * ⇒ 本脚本转为**修复后判据**（回归守卫），判的是同一类缺陷在新容器上的复活：
 *
 *   ① 媒体库面板子树内**不得存在同时生效且嵌套的滚动对**
 *      （外层 overflowY ∈ {auto, scroll} 且 `scrollHeight > clientHeight + 1`，
 *       且外层 `contains(inner)`；全部读几何，不读 className）；
 *   ② 标签容器（`media-tag-list`）**不得是**活动滚动容器（收起态）；
 *   ③ 标签块的祖先链（到面板根为止）不得有活动滚动容器 —— 否则标签会随内容滚走。
 *
 * 反向证伪（三向，自动注入 + 自动还原 + 自证 sha256）：
 *   ① 人为制造嵌套对：把剧集墙滚动容器压到 160px、再给内部网格注入
 *      `max-height:80px + overflow-y:auto` ⇒ 判据 ① 必须 FAIL；
 *   ② 往标签容器注入 `max-height:120px + overflow-y:auto` ⇒ 判据 ② 必须 FAIL；
 *   ③ 还原后 `sha256(main.outerHTML)` before == after，自证不过直接 FAIL。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug259_media_double_scroll.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const path = require('node:path')
const crypto = require('node:crypto')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TOL = 1 // px

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

/* ── 页面内测量/注入 ── */
const PAGE = `
window.__ds = {
  parts() {
    const tagBox = document.querySelector('[data-testid="media-tag-list"]')
    const wall = document.querySelector('[data-testid="series-wall-scroll"]')
    const host = tagBox ? (tagBox.closest('main') || document.body) : null
    // 剧集墙内的内层容器：items 视图是有 testid 的 media-grid；剧集视图是墙的第一个
    // 子元素（无 testid 的 grid div）—— 证伪①要往**墙内**注入，故两者都要能取到。
    const inner = wall
      ? wall.querySelector('[data-testid="media-grid"]') || wall.firstElementChild
      : null
    return { tagBox, wall, host, grid: inner }
  },
  snapshot() {
    const p = window.__ds.parts()
    if (!p || !p.host) return null
    window.__snap = [p.host, ...p.host.querySelectorAll('*')].map((el) => ({
      el,
      attr: el.getAttribute('style'),
    }))
    return p.host.outerHTML
  },
  restore() {
    for (const r of window.__snap || []) {
      if (r.attr === null) r.el.removeAttribute('style')
      else r.el.setAttribute('style', r.attr)
    }
    const p = window.__ds.parts()
    return p && p.host ? p.host.outerHTML : ''
  },
  measure() {
    const p = window.__ds.parts()
    if (!p || !p.host) return { error: '媒体库面板未找到（未进入剧集墙视图？）' }
    const { tagBox, wall, host, grid } = p
    const actives = []
    for (const el of [host, ...host.querySelectorAll('*')]) {
      const cs = getComputedStyle(el)
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
      if (el.scrollHeight > el.clientHeight + 1) actives.push(el)
    }
    const pairs = []
    for (const a of actives)
      for (const b of actives)
        if (a !== b && a.contains(b))
          pairs.push({
            outer: a.getAttribute('data-testid') || a.tagName,
            inner: b.getAttribute('data-testid') || b.tagName,
          })
    const chipCount = tagBox ? [...tagBox.children].filter((el) => el.offsetParent !== null).length : -1
    return {
      actives: actives.length,
      activeIds: actives.map((el) => el.getAttribute('data-testid') || el.tagName),
      pairs,
      tagChips: chipCount,
      tagIsActiveScroll: !!tagBox && actives.includes(tagBox),
      tagAncestorsScrolling: (() => {
        if (!tagBox) return null
        for (let el = tagBox.parentElement; el && el !== host; el = el.parentElement) {
          if (actives.includes(el)) return true
        }
        return false
      })(),
      wallActive: !!wall && actives.includes(wall),
      wallClientH: wall ? wall.clientHeight : -1,
      innerScrollH: grid ? grid.scrollHeight : -1,
      hasGrid: !!grid,
    }
  },
  /** 反向证伪①：人工造出「外层 wall + 内层 grid」的嵌套滚动对（原缺陷的同形态复刻）。
   *
   *  ★ 关键约束（实测踩过）：**内层一旦被裁，外层就不再溢出** —— 若把内层压得比外层
   *    可视区还矮，外层 content 只剩内层的渲染高 ⇒ 外层不滚 ⇒ 造不出对。
   *    故内层上限必须**高于**外层可视区、同时低于自己的内容高：运行时按外层当前高度
   *    取 wallH+80px。真库 79 剧集（内容 ≈2670px vs 外层 ≈545px）下必然成立；
   *    内容比外层还矮的库**物理上造不出双重滚动**，此时注入无效 = 证伪未执行 ⇒ 判 FAIL
   *    （不静默通过：没跑过的证伪不能用来宣称判据有能力 FAIL）。 */
  injectNestedPair() {
    const p = window.__ds.parts()
    if (!p || !p.wall || !p.grid) return { ok: false, reason: 'series-wall-scroll 或其内层容器未找到' }
    const h = Math.round(p.wall.getBoundingClientRect().height)
    p.grid.style.maxHeight = h + 80 + 'px'
    p.grid.style.overflowY = 'auto'
    void p.wall.offsetHeight
    return { ok: true, wallH: h }
  },
  /** 反向证伪②：把标签容器变成滚动容器。
   *  ★ 调用前必须是**展开态**：收起态 8 个 chip 实测只有 20px 高（主区宽容器、单行），
   *    任何 ≥20px 的上限都压不出溢出 ⇒ 证伪假红（BUG-259 §五 教训）。 */
  injectTagScroll() {
    const p = window.__ds.parts()
    if (!p || !p.tagBox) return false
    p.tagBox.style.maxHeight = '12px'
    p.tagBox.style.overflowY = 'auto'
    void p.tagBox.offsetHeight
    return true
  },
}
`

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
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    check('进入媒体库（侧栏 nav-child-lib-series）', entered === true)
    await new Promise((r) => setTimeout(r, 3500))

    await page.evaluate(PAGE)

    /* ─────────── 正测：不得有嵌套滚动对 ─────────── */
    const m = await page.evaluate(() => window.__ds.measure())
    if (m.error) {
      check('媒体库面板可测量', false, m.error)
      await browser.close()
      return 2
    }
    console.log(
      `  面板活动滚动容器 ${m.actives} 个：${JSON.stringify(m.activeIds)} · 嵌套对 ${m.pairs.length} · ` +
        `标签 chip ${m.tagChips} · 标签容器是滚动容器=${m.tagIsActiveScroll} · ` +
        `标签祖先链滚动=${m.tagAncestorsScrolling} · 剧集墙在滚=${m.wallActive}`,
    )

    check('判据① 面板内无同时生效且嵌套的滚动对（双重滚动不复活）', m.pairs.length === 0, JSON.stringify(m.pairs))
    check('判据② 标签容器不是活动滚动容器（收起态）', m.tagIsActiveScroll === false, `isActive=${m.tagIsActiveScroll}`)
    check(
      '判据③ 标签块祖先链无活动滚动容器（不随内容滚走）',
      m.tagAncestorsScrolling === false,
      `ancestorsScrolling=${m.tagAncestorsScrolling}`,
    )

    /* ─────────── 展开态再判一次（原口径「无条件禁止」不含状态例外） ─────────── */
    const toggled = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (!el) return false
      el.click()
      return true
    })
    await new Promise((r) => setTimeout(r, 600))
    const mExp = await page.evaluate(() => window.__ds.measure())
    check(
      '判据②b 展开态标签容器同样不是活动滚动容器',
      mExp.tagIsActiveScroll === false && mExp.pairs.length === 0,
      `isActive=${mExp.tagIsActiveScroll} 嵌套对=${mExp.pairs.length}`,
    )
    // 收回归起态
    if (toggled) await page.evaluate(() => document.querySelector('[data-testid="media-tag-toggle"]')?.click())
    await new Promise((r) => setTimeout(r, 500))

    /* ─────────── 反向证伪（三向） ─────────── */
    console.log('\n══════ 反向证伪（证明本脚本会 FAIL） ══════')
    // 展开标签：收起态容器实测只有 20px 高，注入压不出溢出 ⇒ 假红
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-tag-toggle"]')
      if (el && el.getAttribute('aria-expanded') !== 'true') el.click()
    })
    await new Promise((r) => setTimeout(r, 600))

    const before = await page.evaluate(() => window.__ds.snapshot())
    const h0 = sha(before)

    // ① 人造嵌套对 ⇒ 判据 ① 必须 FAIL
    const inj1 = await page.evaluate(() => window.__ds.injectNestedPair())
    const m1 = await page.evaluate(() => window.__ds.measure())
    check(
      '反向证伪① 注入「内层 grid 限高 wallH+80 + 自身滚动」⇒ 嵌套滚动对必须 ≥1（判据① 有能力 FAIL）',
      inj1.ok === true && m1.pairs.length >= 1,
      inj1.ok
        ? `wallH=${inj1.wallH} 内层内容高=${m1.innerScrollH} ⇒ 嵌套对=${m1.pairs.length} ${JSON.stringify(m1.pairs)}`
        : `注入未执行：${inj1.reason}`,
    )
    await page.evaluate(() => window.__ds.restore())

    // ② 标签容器注入滚动 ⇒ 判据 ② 必须 FAIL
    const inj2 = await page.evaluate(() => window.__ds.injectTagScroll())
    const m2 = await page.evaluate(() => window.__ds.measure())
    check(
      '反向证伪② 注入标签容器 max-h-12px+overflow-y-auto（展开态）⇒ 判据② 必须 FAIL（有能力 FAIL）',
      inj2 === true && m2.tagIsActiveScroll === true,
      `注入后 isActive=${m2.tagIsActiveScroll}`,
    )
    await page.evaluate(() => window.__ds.restore())

    // ③ 还原自证
    const after = await page.evaluate(() => window.__ds.restore())
    const h1 = sha(after)
    check('反向证伪③ 自动还原自证：sha256(main.outerHTML) before == after', h0 === h1, `${h0} vs ${h1}`)
    const back = await page.evaluate(() => window.__ds.measure())
    check(
      '反向证伪③ 还原后回到基线（嵌套对 0、标签容器不在滚）',
      back.pairs.length === 0 && back.tagIsActiveScroll === false,
      `嵌套对=${back.pairs.length} 标签在滚=${back.tagIsActiveScroll}`,
    )

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
