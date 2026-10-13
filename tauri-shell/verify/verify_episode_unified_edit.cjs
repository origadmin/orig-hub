#!/usr/bin/env node
'use strict'

/**
 * BUG-203 / BUG-204 真实 UI 验收：本集统一编辑面板 —— 不重复渲染、图片可管理。
 *
 * ## 缺陷回顾（用户 2026-09-30 反馈「本集编辑立马重叠重复2行」「图无法替换增删改」）
 *
 * BUG-203：点「编辑本集」进入编辑态后，右栏**静态展示层**（标题 h3、本集介绍、
 * 本集图组、独立挂图按钮）没有被隐藏，与 `EpisodeEditPanel` 的输入控件**同时渲染**
 * —— 同一标题文本在 DOM 里出现两次（h3 + input），视觉上「重叠重复 2 行」。
 *
 * BUG-204：统一编辑面板里**没有图片管理**——增/替只能退出编辑态去点面板外的
 * 「给这一集挂图」，删图根本没有入口，「编辑所有内容」名实不符。
 *
 * ## 修复要点
 *
 * - SeriesDetail：编辑态下隐藏静态标题文本（h3 改显槽位标签）、本集介绍块、
 *   本集图组块与独立挂图按钮（`!editingEpisode` 门控）。
 * - EpisodeEditPanel：新增「本集图组」区——缩略图 + 每张 ×（detach，
 *   `DELETE /api/media/episodes/:id/images/:itemId`）+「管理本集图片」按钮
 *   （打开挂图选择器，replace-all 语义）；增删后经 `onChanged` 只重取详情，
 *   **不退出编辑态、不丢草稿**。
 *
 * ## 判据（全部通过才算修复）
 *
 * 1. 点 `episode-edit` 后 `episode-edit-panel` 唯一挂载。
 * 2. 本集标题文本在 DOM 中**恰好出现 1 次**（= 标题输入框；BUG-203 的重复行消失）。
 * 3. 编辑态下静态 h3 不再显示标题文本（改显槽位标签）。
 * 4. 面板内 `episode-images-manage` 在场，且有缩略图（`episode-edit-images`）
 *    或空态提示（`episode-edit-images-empty`）。
 * 5. 编辑态下独立的 `episode-attach-images` 不再渲染（能力已收进面板）。
 * 6. 点 `episode-images-manage` 能打开挂图选择器 `episode-image-picker`。
 * 7. 全程无页面错误。
 *
 * 用法：先起开发态服务（`python scripts/dev_services.py` + vite dev 5180），
 * 再 `node verify/verify_episode_unified_edit.cjs`。
 * 证据目录：`ORIG_VERIFY_OUT`（默认系统临时目录 `orighub-verify-episode-unified-edit`）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-episode-unified-edit'),
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
async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try { size = fs.statSync(f).size } catch (_e) {}
  console.log(`[verify] shot ${name} -> ${f} (${size} bytes)`)
  return f
}

async function main() {
  const resolved = OUT.toLowerCase()
  if (resolved.includes(`${path.sep}orig-hub${path.sep}`) || resolved.includes('orig-hub')) {
    // 证据产物不入库：拒绝把截图 / result 写进仓库（AGENTS.md §6）
    console.error(`[verify] Refusing to write artifacts inside the repo (${OUT}). Set ORIG_VERIFY_OUT to a temp directory.`)
    process.exit(2)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    console.log('[verify] navigated to', APP_URL)

    // 媒体库 → 打开第一部剧集
    await waitTid(page, 'nav-child-lib-series', 15000)
    await clickTid(page, 'nav-child-lib-series')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
      { timeout: 15000 },
    )
    await delay(1000)
    const opened = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="series-card"]')
      if (!card) return false
      card.scrollIntoView({ block: 'center' })
      card.click()
      return true
    })
    if (!opened) throw new Error('no series-card to open')
    await waitTid(page, 'series-tag-edit', 15000)
    await delay(1200)
    await page.evaluate(() => {
      const pick = document.querySelector('[data-testid="episode-pick"]')
      if (pick) pick.click()
    })
    await delay(800)
    await shot(page, 'v1-series-detail.png')

    // 进入本集编辑态
    const hasEditBtn = await page.evaluate(() => !!document.querySelector('[data-testid="episode-edit"]'))
    console.log('[verify] episode-edit button present:', hasEditBtn)
    if (hasEditBtn) {
      await clickTid(page, 'episode-edit')
      await page
        .waitForFunction(() => !!document.querySelector('[data-testid="episode-edit-panel"]'), { timeout: 10000 })
        .catch(() => {})
      await delay(900)
    }

    // 结构探针
    const probe = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length
      const txt = (s) => { const el = document.querySelector(s); return el ? (el.textContent || '').trim() : null }
      const val = (s) => { const el = document.querySelector(s); return el ? (el.value !== undefined ? el.value : null) : null }
      const titleVal = val('[data-testid="episode-title-input"]')
      const h3 = txt('[data-testid="episode-focus-title"]')
      const norm = (s) => String(s || '').replace(/\s+/g, '')
      const n = norm(titleVal)
      let titleOccurrences = 0
      if (n && n.length > 0) {
        for (const el of Array.from(document.querySelectorAll('h3,textarea,input,p'))) {
          const v = el.value !== undefined && el.value !== '' ? el.value : (el.textContent || '')
          if (norm(v) === n) titleOccurrences++
        }
      }
      return {
        episode_edit_panel: q('[data-testid="episode-edit-panel"]'),
        episode_title_input: q('[data-testid="episode-title-input"]'),
        h3_text: h3,
        title_input_value: titleVal,
        title_occurrences_in_dom: titleOccurrences,
        images_manage_btn: q('[data-testid="episode-images-manage"]'),
        images_thumbnails: q('[data-testid="episode-edit-images"] img'),
        images_empty_hint: q('[data-testid="episode-edit-images-empty"]'),
        stray_attach_button: q('[data-testid="episode-attach-images"]'),
      }
    })
    console.log('[verify] edit-mode probe:', JSON.stringify(probe, null, 1))
    await shot(page, 'v2-episode-edit-panel.png')

    check('unified edit panel mounted', probe.episode_edit_panel === 1, `episode-edit-panel=${probe.episode_edit_panel}`)
    // BUG-203：标题文本必须恰好出现 1 次（= 输入框），重复行消失
    check('episode title rendered once (BUG-203 duplicate row gone)',
      probe.title_occurrences_in_dom === 1,
      `title="${probe.title_input_value}" occurrences=${probe.title_occurrences_in_dom}`)
    check('static h3 no longer shows the title (slot label instead)',
      probe.h3_text !== probe.title_input_value,
      `h3="${probe.h3_text}" vs title="${probe.title_input_value}"`)
    // BUG-204：图片管理收进统一面板
    check('image manage button present in unified panel', probe.images_manage_btn === 1, `episode-images-manage=${probe.images_manage_btn}`)
    check('image block present in panel (thumbs or empty hint)',
      probe.images_thumbnails >= 1 || probe.images_empty_hint === 1,
      `thumbs=${probe.images_thumbnails} emptyHint=${probe.images_empty_hint}`)
    check('no stray standalone attach button while editing', probe.stray_attach_button === 0,
      `episode-attach-images=${probe.stray_attach_button}`)

    // 从面板内打开挂图选择器（增 / 替换入口）
    const openedPicker = await clickTid(page, 'episode-images-manage')
    console.log('[verify] clicked episode-images-manage:', openedPicker)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-image-picker"]'), { timeout: 8000 }).catch(() => {})
    await delay(800)
    const picker = await page.evaluate(() => ({
      open: !!document.querySelector('[data-testid="episode-image-picker"]'),
      options: document.querySelectorAll('[data-testid="episode-image-option"]').length,
      confirm: !!document.querySelector('[data-testid="episode-image-picker-confirm"]'),
    }))
    console.log('[verify] image picker:', JSON.stringify(picker))
    await shot(page, 'v3-image-picker-from-panel.png')
    check('image picker opens from unified panel', picker.open === true, `options=${picker.options} confirm=${picker.confirm}`)

    // favicon 404 是浏览器默认请求、与本修复无关，剔除后再判
    const benign = (u) => /favicon\.ico/.test(String(u || ''))
    const errs = page.pageErrors().slice(0, 10)
    const cerrs = page.consoleErrors().slice(0, 10).filter((e) => !benign(e))
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(errs))
    console.log('[verify] CONSOLE_ERRORS(non-benign):', JSON.stringify(cerrs))
    check('no page errors', errs.length === 0, JSON.stringify(errs))
    check('no console errors (favicon excluded)', cerrs.length === 0, JSON.stringify(cerrs))

    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ app: APP_URL, probe, picker, checks, at: new Date().toISOString() }, null, 2),
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
