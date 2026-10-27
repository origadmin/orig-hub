#!/usr/bin/env node
'use strict'
/**
 * BUG-412 真实 UI 验收：编辑态与显示态的「图片 / 介绍」上下顺序必须一致。
 *
 * ## 缺陷
 * 显示态是「本集图组 → 本集介绍」，编辑态（EpisodeEditPanel）却是「介绍 → 图片」——
 * 一进编辑，图文位置完全相反，用户找不到原来的内容/控件（多次报障）。
 *
 * ## 修复
 * 把编辑面板的图片区块前移到介绍之前，使两态都是「图片 → 介绍」。
 *
 * ## 判据（全部通过才算修复）
 *  1. 编辑态：图片区块（episode-edit-images 或空态提示）的 top < 介绍输入
 *     （episode-desc-input）的 top。
 *  2. 显示态：本集图组标题 top < 本集介绍（episode-focus-desc）top；
 *     显示态无图/无介绍时记 N/A（不误判）。
 *  3. 两态结论一致（都图片在前）。
 *  4. 全程无页面错误。
 *
 * 用法：先起开发态服务（dev 栈 5180），再 `node verify/verify_bug412_edit_layout_order.cjs`。
 * 证据目录：ORIG_VERIFY_OUT（默认系统临时目录 orighub-verify-bug412-layout）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug412-layout'),
)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function clickTid(page, tid) {
  return page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, tid)
}
async function waitTid(page, tid, timeout = 12000) {
  await page.waitForFunction((t) => !!document.querySelector(`[data-testid="${t}"]`), {
    timeout,
    args: [tid],
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await waitTid(page, 'nav-child-lib-series', 15000)
    await clickTid(page, 'nav-child-lib-series')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
      { timeout: 15000 },
    )
    await delay(800)
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="series-card"]')
      if (c) { c.scrollIntoView({ block: 'center' }); c.click() }
    })
    // BUG-476e：独立「本剧标签」入口已拆除（标签编辑唯一入口 = SeriesEditPanel），
    // 详情就绪信号改用 `series-edit`（标题行编辑钮）。
    await waitTid(page, 'series-edit', 15000)
    await delay(1000)
    await page.evaluate(() => { const p = document.querySelector('[data-testid="episode-pick"]'); if (p) p.click() })
    await delay(600)

    // 显示态顺序：本集图组标题 vs 本集介绍
    const disp = await page.evaluate(() => {
      const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null)
      const desc = document.querySelector('[data-testid="episode-focus-desc"]')
      const imgHead = Array.from(document.querySelectorAll('h4')).find((h) =>
        /本集图组|Images/i.test(h.textContent || ''),
      )
      if (!imgHead || !desc) return { na: true, imgTop: top(imgHead), descTop: top(desc) }
      return { na: false, imgTop: top(imgHead), descTop: top(desc), imagesBeforeDesc: top(imgHead) < top(desc) }
    })

    const hasEdit = await page.evaluate(() => !!document.querySelector('[data-testid="episode-edit"]'))
    if (hasEdit) await clickTid(page, 'episode-edit')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-edit-panel"]'), { timeout: 10000 }).catch(() => {})
    await delay(700)

    const edit = await page.evaluate(() => {
      const top = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null }
      const imgSel = document.querySelector('[data-testid="episode-edit-images"]')
        ? '[data-testid="episode-edit-images"]'
        : '[data-testid="episode-edit-images-empty"]'
      const imgTop = top(imgSel)
      const descTop = top('[data-testid="episode-desc-input"]')
      return { imgTop, descTop, imagesBeforeDesc: imgTop != null && descTop != null && imgTop < descTop }
    })

    check('edit panel mounted', await page.evaluate(() => !!document.querySelector('[data-testid="episode-edit-panel"]')))
    check('1: edit mode — images block above description input',
      edit.imagesBeforeDesc === true,
      `imgTop=${edit.imgTop} descTop=${edit.descTop}`)
    check('2: display mode — images block above description (N/A if absent)',
      disp.na === true || disp.imagesBeforeDesc === true,
      disp.na ? 'N/A (no frames or no description on this episode)' : `imgTop=${disp.imgTop} descTop=${disp.descTop}`)
    check('3: both states agree (images before description)',
      edit.imagesBeforeDesc === true && (disp.na === true || disp.imagesBeforeDesc === true),
      `display=${disp.imagesBeforeDesc} edit=${edit.imagesBeforeDesc}`)

    const errs = page.pageErrors().slice(0, 10)
    const cerrs = page.consoleErrors().slice(0, 10).filter((e) => !/favicon/i.test(String(e || '')))
    check('4: no page errors', errs.length === 0, JSON.stringify(errs))
    check('4: no console errors (favicon excluded)', cerrs.length === 0, JSON.stringify(cerrs))

    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ app: APP_URL, disp, edit, checks, at: new Date().toISOString() }, null, 2),
    )
    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    console.log('[verify] artifacts at', OUT)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    await browser.close()
  }
}
main().catch((e) => { console.error('[verify] ERROR', e && e.message ? e.message : e); process.exit(1) })
