#!/usr/bin/env node
'use strict'
/**
 * 复报审计探针（不是验收脚本）：用户 2026-10-26 复报「下面这些BUG我感觉全部丢失了」，
 * 其中 6 条在登记册里被标成 `fixed`。本探针在**真实渲染**里逐条量一遍，
 * 用来决定「退回 open」还是「保持 fixed + 向用户要复现步骤」。
 *
 * 只覆盖能在 dev 环境无损复现的四条：
 *   A BUG-403 文件管理单击行 ⇒ 应弹内容详情，且不得进入选择态
 *   B BUG-406 剧集墙选中 2 条 ⇒ 底部计数须是「已选 N 条」，不得是裸数字
 *   C BUG-411 集数口径 ⇒ sid 485 应为 7、sid 118 应为 15
 *   D BUG-412 编辑态顺序 ⇒ 图片区块 y 必须小于介绍 textarea y
 *
 * BUG-407 / BUG-408 是合并写操作（破坏库），本探针不碰，另用单测核对。
 *
 * 用法（先起 dev 栈 5180）：
 *   node tauri-shell/verify/_probe_reopen_audit.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-reopen'),
)
const TG_PORT = Number(process.env.TG_PORT || 19787)
const NAV_TIMEOUT = 90000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
function rec(id, ok, detail) {
  rows.push({ id, ok, detail })
  console.log(`${ok ? 'YES ' : 'NO  '} ${id}  ${detail}`)
}

async function boot(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
  console.log('  [stage] goto done')
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid^="nav-child-"]'),
    { timeout: 25000 },
  )
  console.log('  [stage] sidebar ready')
}

async function clickNav(page, testid, waitTestid) {
  const hit = await page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
  console.log(`  [stage] click ${testid} -> ${hit}`)
  // 注意：本库的 `waitForFunction(fn, opts)` **不支持传参** —— 第二个位置就是
  // 选项对象，写成 `(t) => ...` 会把 `t` 收成 `{timeout}`，选择器变成
  // `[data-testid="[object Object]"]`，于是恒等不到（实测白等 25s）。
  // 需要带值时用闭包 + `page.evaluate`，或用字符串选择器版。
  const sel = `[data-testid="${waitTestid}"]`
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate((q) => !!document.querySelector(q), sel)) break
    await delay(500)
  }
  const ready = await page.evaluate((q) => !!document.querySelector(q), sel)
  if (!ready) throw new Error(`${waitTestid} not rendered after click ${testid}`)
  console.log(`  [stage] ${waitTestid} ready`)
}

async function openSeries(page, sid) {
  await boot(page)
  await clickNav(page, 'nav-child-lib-series', 'series-card')
  await delay(1200)
  const clicked = await page.evaluate((id) => {
    const c = document.querySelector(`[data-testid="series-card"][data-series-id="${id}"]`)
    if (!c) return false
    c.click()
    return true
  }, sid)
  if (!clicked) return false
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
    await delay(500)
  }
  await delay(800)
  return page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  // `newPage()` 不带 viewport 时视口为 0×0，`waitForRoot` 永远等不到 ⇒ 必须显式给。
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  let errors = []

  try {
    // ---------- A / BUG-403 ----------
    try {
      await boot(page)
      await clickNav(page, 'nav-files', 'file-list')
      await delay(1500)
      const before = await page.evaluate(
        () => document.querySelectorAll('[data-testid="file-list-row"]').length,
      )
      if (before === 0) {
        rec('BUG-403', false, `ENV: 全部文件列表为空（rows=0），无法判定`)
      } else {
        await page.evaluate(() => document.querySelector('[data-testid="file-list-row"]').click())
        await delay(900)
        const s = await page.evaluate(() => {
          const dlg = document.querySelector('[data-testid="item-detail-dialog"]')
          const name = document.querySelector('[data-testid="item-detail-name"]')
          // 选择态特征：出现「已选 N 项/条」的计数条，或行上出现选中环
          const body = document.body.innerText || ''
          const selHit = body.match(/已选\s*\d+\s*[项条]/)
          const checks = [...document.querySelectorAll('[data-testid^="file-list-check-"]')]
          const checked = checks.filter((el) => el.checked || el.getAttribute('aria-checked') === 'true')
          return {
            dialog: !!dlg,
            name: name ? (name.textContent || '').trim() : null,
            actions: [...document.querySelectorAll('[data-testid^="item-detail-"]')].map((e) =>
              e.getAttribute('data-testid'),
            ),
            selHit: selHit ? selHit[0] : null,
            checkedCount: checked.length,
          }
        })
        await page.screenshot(path.join(OUT, 'A_bug403_row_click.png'))
        const ok = s.dialog && s.name && s.actions.length >= 4 && s.checkedCount === 0 && !s.selHit
        rec(
          'BUG-403',
          ok,
          `dialog=${s.dialog} name=${JSON.stringify(s.name)} actions=${s.actions.length} ` +
            `checked=${s.checkedCount} selectionBar=${JSON.stringify(s.selHit)}`,
        )
      }
    } catch (e) {
      rec('BUG-403', false, `EXC ${e.message}`)
    }

    // ---------- B / BUG-406 ----------
    try {
      await boot(page)
      await clickNav(page, 'nav-child-lib-series', 'series-card')
      await delay(1200)
      // 选中必须走卡片上的勾选框（`series-card-select`），点卡片本体是「打开详情」
      const picked = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('[data-testid="series-card-select"]')].slice(0, 2)
        for (const b of boxes) b.click()
        return boxes.length
      })
      await delay(1500)
      const s406 = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="selection-bar"]')
        const txt = bar ? (bar.innerText || '').replace(/\s+/g, ' ').trim() : null
        const body = document.body.innerText || ''
        return {
          bar: !!bar,
          barText: txt,
          labels: body.match(/已选\s*\d+\s*[项条]/g) || [],
        }
      })
      await page.screenshot(path.join(OUT, 'B_bug406_selection_bar.png'))
      const ok = picked >= 2 && s406.labels.length > 0
      rec(
        'BUG-406',
        ok,
        `picked=${picked} bar=${s406.bar} barText=${JSON.stringify(s406.barText)} labels=${JSON.stringify(s406.labels)}`,
      )
    } catch (e) {
      rec('BUG-406', false, `EXC ${e.message}`)
    }

    // ---------- C / BUG-411 ----------
    // 剧集墙是懒加载的，485/118 不一定在首批卡片里 ⇒ 直接问接口（真值来源）。
    try {
      const got = {}
      for (const sid of [485, 118]) {
        const r = await fetch(`http://127.0.0.1:${TG_PORT}/api/media/series/${sid}`)
        if (!r.ok) {
          got[sid] = null
          continue
        }
        const d = await r.json()
        got[sid] = { ep: d.episodeCount, video: (d.episodes || []).length }
      }
      const ok = (got[485] && got[485].ep === 7) || (got[118] && got[118].ep === 15)
      rec(
        'BUG-411',
        ok,
        `485 episodeCount=${got[485] ? got[485].ep : 'absent'}（应 7） ` +
          `118 episodeCount=${got[118] ? got[118].ep : 'absent'}（应 15）`,
      )
    } catch (e) {
      rec('BUG-411', false, `EXC ${e.message}`)
    }

    // ---------- D / BUG-412 ----------
    try {
      const opened = await openSeries(page, 219)
      if (!opened) {
        rec('BUG-412', false, 'ENV: 剧集 219 详情打不开')
      } else {
        await page.evaluate(() => document.querySelector('[data-testid="episode-edit"]')?.click())
        await page.waitForFunction(
          () => !!document.querySelector('[data-testid="episode-desc-input"]'),
          { timeout: 20000 },
        )
        await delay(900)
        const s = await page.evaluate(() => {
          const img = document.querySelector('[data-testid="episode-edit-images"]')
          const desc = document.querySelector('[data-testid="episode-desc-input"]')
          const r = (el) => (el ? Math.round(el.getBoundingClientRect().y * 100) / 100 : null)
          return { imgY: r(img), descY: r(desc), img: !!img, desc: !!desc }
        })
        await page.screenshot(path.join(OUT, 'D_bug412_edit_order.png'))
        const ok = s.img && s.desc && s.imgY < s.descY
        rec('BUG-412', ok, `imgY=${s.imgY} descY=${s.descY}（图片须在上）`)
      }
    } catch (e) {
      rec('BUG-412', false, `EXC ${e.message}`)
    }

    errors = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon/i.test(String(e)),
    )
    console.log(`\nconsole errors: ${errors.length}`)
    if (errors.length) console.log(errors.slice(0, 5).join('\n'))
  } finally {
    await browser.close()
    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ rows, errors, at: new Date().toISOString() }, null, 2),
    )
    console.log(`\n[out] ${OUT}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
