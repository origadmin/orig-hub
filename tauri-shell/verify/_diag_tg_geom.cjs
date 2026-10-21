'use strict'
/**
 * TG 面板几何/命中诊断（BUG-359 / BUG-360 复测）。
 *
 * 与 `_diag_tg_layout.cjs` 的差别（都是上一轮实测踩到的坑）：
 *   1. **有界等待**替代固定 sleep：筛选规则/监控列表由 API 异步到达，
 *      2.5s 固定等待会把正常首屏读成空态（实测 14.5s 才到）。
 *   2. **禁用 ≠ 被盖住**：Tailwind `disabled:pointer-events-none` 让禁用的 button
 *      计算样式也是 `pointer-events:none`，旧脚本把两类混为一谈 ⇒ 假红。
 *      现在分别记录 `disabled` 与 `covered`（`elementFromPoint(中心)!==元素`）。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 有界等待条件成立（超时仍如实返回实测耗时，不吞失败）。 */
async function waitFor(page, fn, timeoutMs = 30000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn)
    if (v) return { ok: true, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 }
    await sleep(step)
  }
}

const rect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())

    const w1 = await waitFor(
      page,
      () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0,
    )
    console.log(`筛选行到位：ok=${w1.ok} ${w1.ms}ms`)

    // ---- 筛选行几何 + 命中测试 ----
    const rows = await page.evaluate(() => {
      const out = []
      for (const row of document.querySelectorAll('[data-testid="tg-filter-row"]')) {
        const kids = []
        for (const el of row.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          const cs = getComputedStyle(el)
          const cx = Math.round(r.x + r.width / 2)
          const cy = Math.round(r.y + r.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          kids.push({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid') || null,
            cls: (el.getAttribute('class') || '').slice(0, 70),
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            disabled: el.disabled === true,
            covered: !!hit && hit !== el && !el.contains(hit),
            coveredBy: hit && hit !== el ? hit.tagName.toLowerCase() : null,
          })
        }
        out.push({ testid: row.getAttribute('data-testid'), kids })
      }
      return out
    })
    for (const row of rows) {
      console.log(`\n--- ${row.testid} ---`)
      for (const k of row.kids) {
        console.log(
          `  ${k.tag}${k.testid ? `[${k.testid}]` : ''} "${k.txt}" rect=${JSON.stringify(k.rect)}` +
            `${k.disabled ? ' DISABLED' : ''}${k.covered ? ` COVERED-BY-${k.coveredBy}` : ''}`,
        )
      }
    }

    // ---- 整面板不可交互元素（区分禁用/被盖） ----
    const blocked = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, input, [role="button"], a')) {
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const cx = Math.round(r.x + r.width / 2)
        const cy = Math.round(r.y + r.height / 2)
        const hit = document.elementFromPoint(cx, cy)
        const covered = !!hit && hit !== el && !el.contains(hit)
        if (!covered && cs.pointerEvents !== 'none') continue
        out.push({
          testid: el.getAttribute('data-testid') || null,
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          disabled: el.disabled === true,
          covered,
          coveredBy: covered ? hit.tagName.toLowerCase() : null,
          fontSize: cs.fontSize,
        })
      }
      return out
    })
    console.log('\n===== 不可交互元素（禁用 or 被盖）=====')
    for (const b of blocked) {
      console.log(
        `${b.testid ? `[${b.testid}] ` : ''}"${b.txt}" rect=${JSON.stringify(b.rect)}` +
          ` ${b.disabled ? 'DISABLED(正常禁用)' : ''}${b.covered ? ` COVERED-BY-${b.coveredBy}(真缺陷)` : ''}` +
          `${!b.disabled && !b.covered ? ' pointer-events:none(既没禁用也没被盖⇒异常)' : ''}`,
      )
    }
    if (blocked.length === 0) console.log('（无）')

    await page.screenshot(path.resolve(__dirname, '..', '..', 'verify_shots', 'tg-layout', '04-tg-filters.png'))
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
