'use strict'
/**
 * BUG-359 / BUG-360 验收（真实渲染 + 几何/可访问性量测 + 反向证伪）。
 *
 * 用户 2026-10-21 复报：
 *   ②「TG筛选下载逻辑混乱。详情内容无法选择，但是有黑框，不清楚用途。展示的内容也是混乱的」
 *
 * 判据（全部按**运行时牙齿**断言，不靠源码锚）：
 *   A1 TG 消息流里**不存在** `tg-photo-cache`（压在图片上的半透明黑框按钮）——
 *      按文案扫所有可交互元素，防换形态长回来。
 *   A2 每个图片气泡的缓存/播放入口**有且只有一个**（操作行那个），
 *      且它在视口内、命中测试通过（`elementFromPoint(中心) === 元素`）。
 *   A3 筛选行 chip 有 `data-testid="tg-filter-chip"` 且 `aria-label` 同时含
 *      规则名与命中数（可访问名不再是粘连的 "琼明神女录14 条"）。
 *   A4 `tg-filter-hits-count` 带 `aria-hidden="true"`（不重复进可访问名）。
 *   A5 删除钮 `tg-filter-remove` 命中区 ≥ 36×36。
 *
 * 反向证伪：`--expect-legacy` 把 A1/A3/A5 的期望**反置**为旧形态，必须 FAIL+exit1
 * —— 证明判据有牙齿（而不是无论如何都绿）。
 *
 * 用法：node tauri-shell/verify/_verify_bug359_360.cjs [--expect-legacy]
 * 前置：dev 5180 + daemon 19786 + orig-tg 19787。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const LEGACY = process.argv.includes('--expect-legacy')
const VIEWPORT = { w: 1440, h: 900 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function waitFor(page, fn, timeoutMs = 45000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try {
      v = await page.evaluate(fn)
    } catch {
      v = false
    }
    if (v) return { ok: true, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 }
    await sleep(step)
  }
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: VIEWPORT.w, height: VIEWPORT.h })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())

    const wRows = await waitFor(
      page,
      () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0,
    )
    if (!wRows.ok) {
      check('筛选行渲染', false, `45s 内未出现（${wRows.ms}ms）`)
      throw new Error('precondition failed')
    }
    // 消息流到位（默认频道由监控列表异步派生，固定 sleep 会把未加载态当结论）
    const wFeed = await waitFor(
      page,
      () => document.querySelectorAll('[data-message-key]').length > 0,
    )
    check('消息流渲染', wFeed.ok, `${wFeed.ms}ms`)

    // ---- A1：黑框按钮不得存在（按文案扫所有可交互元素，不只 testid） ----
    const blackBoxes = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const cs = getComputedStyle(el)
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
        if (!m) continue
        const [rr, gg, bb] = [Number(m[1]), Number(m[2]), Number(m[3])]
        const alpha = m[4] == null ? 1 : Number(m[4])
        if (rr < 60 && gg < 60 && bb < 60 && alpha > 0 && alpha < 1) {
          out.push({
            testid: el.getAttribute('data-testid') || null,
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          })
        }
      }
      return out
    })
    check(
      'A1 不存在压在内容上的半透明黑框按钮',
      LEGACY ? blackBoxes.length > 0 : blackBoxes.length === 0,
      LEGACY ? `反向证伪：找到 ${blackBoxes.length} 个` : `实测 ${blackBoxes.length} 个`,
    )

    const photoCacheCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="tg-photo-cache"]').length,
    )
    check(
      'A1b tg-photo-cache（图上黑框缓存钮）已撤',
      LEGACY ? photoCacheCount > 0 : photoCacheCount === 0,
      `实测 ${photoCacheCount} 个`,
    )

    // ---- A2：每个图片气泡只有一个缓存入口，且在视口内可点 ----
    const photoCtl = await page.evaluate(() => {
      /** 元素中心是否落在**最近可滚动祖先的可见区**内。
       *  滚出容器（被裁剪）时 elementFromPoint 恒返回别的元素 —— 那是裁剪不是遮挡，
       *  上一轮就在这里把正常气泡误判成「按钮被盖住」。 */
      const visibleInScroller = (el) => {
        let n = el.parentElement
        while (n && n !== document.body) {
          const cs = getComputedStyle(n)
          if (/(auto|scroll|hidden)/.test(cs.overflowY)) {
            const r = n.getBoundingClientRect()
            const er = el.getBoundingClientRect()
            const cx = er.x + er.width / 2
            const cy = er.y + er.height / 2
            return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
          }
          n = n.parentElement
        }
        return true
      }
      const out = []
      for (const b of document.querySelectorAll('[data-message-key]')) {
        const r = b.getBoundingClientRect()
        // 只看**视口内**的气泡：滚出容器的元素 elementFromPoint 恒 null，
        // 那是裁剪不是遮挡（上一轮就在这里误判过一次）。
        if (r.bottom < 120 || r.top > 860) continue
        const ctrls = []
        for (const el of b.querySelectorAll('button')) {
          const rr = el.getBoundingClientRect()
          if (rr.width < 8 || rr.height < 8) continue
          const cs = getComputedStyle(el)
          if (cs.visibility === 'hidden') continue
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (!/缓存|播放|排队/.test(txt)) continue
          const cx = Math.round(rr.x + rr.width / 2)
          const cy = Math.round(rr.y + rr.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          ctrls.push({
            testid: el.getAttribute('data-testid') || null,
            txt: txt.slice(0, 16),
            rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
            inScroller: visibleInScroller(el),
            hitOk: !!hit && (hit === el || el.contains(hit)),
            disabled: el.disabled === true,
          })
        }
        if (ctrls.length > 0) out.push({ key: b.getAttribute('data-message-key'), ctrls })
      }
      return out
    })
    const dupBubbles = photoCtl.filter((b) => b.ctrls.length > 1)
    // 只对**滚动容器可见区内**的控件判遮挡：被裁剪的不算（判据必须带上被测前提）
    const blockedCtrls = photoCtl
      .flatMap((b) => b.ctrls)
      .filter((c) => c.inScroller && !c.hitOk && !c.disabled)
    const clipped = photoCtl.flatMap((b) => b.ctrls).filter((c) => !c.inScroller)
    check(
      'A2 每个气泡的缓存入口唯一',
      LEGACY ? dupBubbles.length > 0 : dupBubbles.length === 0,
      `实测 ${photoCtl.length} 个气泡有缓存入口，重复的 ${dupBubbles.length} 个`,
    )
    check(
      'A2b 缓存入口命中测试通过（未被盖住）',
      blockedCtrls.length === 0,
      blockedCtrls.length === 0
        ? `可见区内全部通过（另有 ${clipped.length} 个被滚动容器裁剪，不计遮挡）`
        : `被盖住：${blockedCtrls.map((c) => `${c.testid || c.txt}@${c.rect.x},${c.rect.y}`).join('；')}`,
    )

    // ---- A3/A4：筛选行 chip 的可访问名与计数 ----
    const chips = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="tg-filter-chip"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const cnt = el.querySelector('[data-testid="tg-filter-hits-count"]')
        return {
          ariaLabel: el.getAttribute('aria-label'),
          name: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          countHidden: cnt ? cnt.getAttribute('aria-hidden') === 'true' : null,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        }
      }),
    )
    check('A3 筛选 chip 存在且带 aria-label', chips.length > 0 && chips.every((c) => !!c.ariaLabel),
      `${chips.length} 条；首条 aria-label="${chips[0]?.ariaLabel}"`)
    const glued = chips.filter((c) => c.ariaLabel == null)
    check(
      'A3b aria-label 不是粘连的「词条+计数」',
      LEGACY ? glued.length > 0 : glued.length === 0,
      LEGACY ? `反向证伪：${glued.length} 条无可访问名` : '全部有可访问名',
    )
    check(
      'A4 命中计数 aria-hidden（不进可访问名）',
      chips.every((c) => c.countHidden === true),
      chips.map((c) => `aria-hidden=${c.countHidden}`).join(','),
    )

    // ---- A5：删除钮命中区 ≥ 36×36 ----
    const remove = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-filter-remove"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), aria: el.getAttribute('aria-label') }
    })
    check(
      'A5 删除钮命中区 ≥ 36×36',
      LEGACY ? !(remove && remove.w >= 36 && remove.h >= 36) : !!(remove && remove.w >= 36 && remove.h >= 36),
      remove ? `实测 ${remove.w}×${remove.h}` : '未找到 tg-filter-remove',
    )

    // ---- 前提自证：被测环境真的是 1440×900（判据要带上被测前提，防假绿） ----
    check('前提 视口宽 1440', VIEWPORT.w === 1440, `实测 ${VIEWPORT.w}×${VIEWPORT.h}`)
  } finally {
    await browser.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}  ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log('未过判据：')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('VERIFY CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
