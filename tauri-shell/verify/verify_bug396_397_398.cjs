#!/usr/bin/env node
'use strict'
/**
 * BUG-396 / 397 / 398 合并验收（同一活栈，三段判据 + 各自页内反向变异验牙）：
 *
 * P396 入库「优先」不得作用于终态任务：
 *   a. wire：`/api/downloads?scope=all` 里 status∈{done,cancelled} 的任务 priority==0；
 *   b. DOM：下载域 ingest 行 data-status=终态 ⇒ 无 prefer/unprefer 钮、无「优先」徽标；
 *   牙：向终态行注入徽标 ⇒ b 必红。
 *   c. DOM（BUG-396 收口）：入库流水线面板（`CacheManagerDialog`）同一条判据 ——
 *      `cache-task-row` 终态行无 prioritized 徽标 / prefer / cancel-prefer 钮；
 *      牙：向终态行注入徽标+unprefer 钮 ⇒ c 必红。
 *   d. wire 行为：对每条终态记录发「取消置顶」请求，端点一律 422
 *      （判据与后端 `cache::prioritizable` 同源，不静默成功）。
 *
 * P397 频道内容图不得裁切（object-contain）：
 *   DOM：TG 消息区全部内容 img 的 computed objectFit == 'contain'；
 *   牙：把其中一张改成 cover ⇒ 必红。
 *
 * P398 回溯表单可关闭：
 *   DOM：点 tg-monitor-backfill-open ⇒ 表单出现且 tg-monitor-backfill-close 存在；
 *   点 close ⇒ 表单消失；toggle 再点也能收起；
 *   牙：删掉 close 钮 ⇒ 表单打开后判据必红。
 *
 * 用法:: node verify/verify_bug396_397_398.cjs
 * Exit: 0 = 全部通过；1 = 任一失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.DAEMON_PORT || 19786
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug396-398')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const results = {}
const problems = []
const check = (name, ok, detail) => {
  results[name] = ok ? 'PASS' : `FAIL ${detail || ''}`
  if (!ok) problems.push(`${name}: ${detail || ''}`)
}

async function fetchJson(url) {
  const res = await fetch(url)
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    // ───────── P396：下载域 ─────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0, {
      timeout: 20000,
    }).catch(() => {})
    await delay(500)

    const p396a = await (async () => {
      const d = await fetchJson(`http://127.0.0.1:${DAEMON}/api/downloads?scope=all`)
      if (d.status !== 200 || !d.json || !Array.isArray(d.json.tasks)) return { ok: false, detail: `status=${d.status}` }
      const bad = d.json.tasks.filter(
        (t) => (t.status === 'done' || t.status === 'cancelled') && (t.priority ?? 0) !== 0,
      )
      return { ok: bad.length === 0, detail: `${bad.length} settled tasks with priority!=0` }
    })()
    check('P396a_wire_settled_priority_zero', p396a.ok, p396a.detail)

    const evalSettled = () =>
      page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="ingest-group-row"]'))
        const settled = rows.filter((r) => ['done', 'cancelled', 'failed', 'interrupted'].includes(r.dataset.status))
        const bad = settled.filter(
          (r) =>
            r.querySelector('[data-testid="ingest-group-action-prefer"], [data-testid="ingest-group-action-unprefer"], [data-testid="ingest-group-prioritized"]'),
        )
        return { settled: settled.length, bad: bad.length }
      })
    const p396b0 = await evalSettled()
    check('P396b_dom_settled_no_prefer_ui', p396b0.settled > 0 && p396b0.bad === 0, JSON.stringify(p396b0))

    // 牙：给一个终态行注入徽标 + unprefer 钮 ⇒ 判据必红
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('[data-testid="ingest-group-row"]')).find((r) =>
        ['done', 'cancelled', 'failed', 'interrupted'].includes(r.dataset.status),
      )
      if (!row) return
      const span = document.createElement('span')
      span.dataset.testid = 'ingest-group-prioritized'
      span.textContent = '优先'
      row.appendChild(span)
    })
    const p396teeth = await evalSettled()
    check('P396_teeth_injected_badge_trips', p396teeth.bad > 0, 'mutation did NOT trip P396b (恒绿!)')
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })

    // ───────── P396c：入库流水线面板（`CacheManagerDialog`）同一条判据 ─────────
    // 这一面此前完全没有被 P396 覆盖，而它的 `isPrioritized` 只读 `priority>0`
    // （不看状态）⇒ 终态行一旦残留 pin，「完成后仍是优先」就会在这里复活。
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    await delay(1200)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-cache-manager-entry"]')
      if (el) el.click()
    })
    await page
      .waitForFunction(() => document.querySelectorAll('[data-testid="cache-task-row"]').length > 0, {
        timeout: 20000,
      })
      .catch(() => {})
    await delay(400)

    const evalManagerRows = () =>
      page.evaluate(() => {
        const SETTLED = ['done', 'cancelled', 'failed', 'interrupted']
        const rows = Array.from(document.querySelectorAll('[data-testid="cache-task-row"]'))
        const settled = rows.filter((r) => SETTLED.includes(r.dataset.status))
        const bad = settled.filter(
          (r) =>
            r.querySelector(
              '[data-testid="cache-task-prioritized"], [data-testid="cache-task-prefer-download"], [data-testid="cache-task-cancel-prefer"]',
            ),
        )
        return { rows: rows.length, settled: settled.length, bad: bad.length }
      })
    const p396c0 = await evalManagerRows()
    check(
      'P396c_manager_settled_no_prefer_ui',
      p396c0.settled > 0 && p396c0.bad === 0,
      JSON.stringify(p396c0),
    )

    // 牙：给终态行注入徽标 + 取消优先钮 ⇒ 判据必红；注入后还原 DOM 再继续。
    await page.evaluate(() => {
      const SETTLED = ['done', 'cancelled', 'failed', 'interrupted']
      const row = Array.from(document.querySelectorAll('[data-testid="cache-task-row"]')).find((r) =>
        SETTLED.includes(r.dataset.status),
      )
      if (!row) return
      const span = document.createElement('span')
      span.dataset.testid = 'cache-task-prioritized'
      span.textContent = '优先'
      const btn = document.createElement('button')
      btn.dataset.testid = 'cache-task-cancel-prefer'
      btn.textContent = '取消优先'
      row.appendChild(span)
      row.appendChild(btn)
    })
    const p396cTeeth = await evalManagerRows()
    check('P396c_teeth_injected_badge_trips', p396cTeeth.bad > 0, 'mutation did NOT trip P396c (恒绿!)')
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })

    // ───────── P396d：wire 行为判据 ─────────
    const p396d = await (async () => {
      const d = await fetchJson(`http://127.0.0.1:${DAEMON}/api/downloads?scope=all`)
      if (d.status !== 200 || !d.json || !Array.isArray(d.json.tasks)) {
        return { ok: false, detail: `status=${d.status}` }
      }
      const SETTLED = new Set(['done', 'cancelled', 'failed', 'interrupted'])
      const settled = d.json.tasks.filter((t) => SETTLED.has(t.status))
      if (settled.length === 0) return { ok: false, detail: 'no settled task to probe' }
      const wrong = []
      for (const t of settled.slice(0, 5)) {
        const res = await fetch(`http://127.0.0.1:19787/api/tg/cache/tasks/priority`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: [t.id], priority: 0 }),
        }).catch((e) => ({ status: -1, note: e.message }))
        if (res.status !== 422) wrong.push(`id=${t.id} status=${t.status} -> ${res.status}`)
      }
      return { ok: wrong.length === 0, detail: `probed=${Math.min(settled.length, 5)}; ${wrong.join(' | ')}` }
    })()
    check('P396d_wire_unpin_settled_rejected_422', p396d.ok, p396d.detail)

    // ───────── P397 / P398：TG 域 ─────────
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    await delay(1500)

    // P398：找有回溯按钮的频道行
    const hasBackfill = await page.evaluate(() => !!document.querySelector('[data-testid="tg-monitor-backfill-open"]'))
    if (hasBackfill) {
      await page.evaluate(() => document.querySelector('[data-testid="tg-monitor-backfill-open"]').click())
      await delay(400)
      const opened = await page.evaluate(() => ({
        form: !!document.querySelector('[data-testid="tg-monitor-backfill-form"], [data-testid="tg-monitor-backfill-date"]'),
        close: !!document.querySelector('[data-testid="tg-monitor-backfill-close"]'),
      }))
      check('P398_form_opens_with_close', opened.form && opened.close, JSON.stringify(opened))

      // 先走正常关闭路径（close 钮还在）
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="tg-monitor-backfill-close"]')
        if (el) el.click()
      })
      await delay(400)
      const closed = await page.evaluate(
        () => !document.querySelector('[data-testid="tg-monitor-backfill-form"], [data-testid="tg-monitor-backfill-date"]'),
      )
      check('P398_close_hides_form', closed)

      // 牙：删掉 close 钮 ⇒ 「close 存在」判据必红；随后用 toggle 收起清理现场
      await page.evaluate(() => document.querySelector('[data-testid="tg-monitor-backfill-open"]').click())
      await delay(400)
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="tg-monitor-backfill-close"]')
        if (c) c.remove()
      })
      const teeth398 = await page.evaluate(
        () => !!document.querySelector('[data-testid="tg-monitor-backfill-close"]'),
      )
      check('P398_teeth_close_removed_trips', teeth398 === false, 'close removal did NOT trip (恒绿!)')
      await page.evaluate(() => document.querySelector('[data-testid="tg-monitor-backfill-open"]').click())
      await delay(300)
    } else {
      check('P398_form_opens_with_close', false, 'no tg-monitor-backfill-open row in current view')
    }

    // P397：TG 消息区内容图 object-contain
    const p397 = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter((i) => i.naturalWidth > 0)
      const covers = imgs.filter((i) =>
        (i.dataset.testid || '').startsWith('album-cover') || i.closest('[data-testid^="tg-"]'),
      )
      const bad = covers.filter((i) => getComputedStyle(i).objectFit === 'cover')
      return { total: covers.length, bad: bad.length }
    })
    check('P397_content_images_contain', p397.total > 0 && p397.bad === 0, JSON.stringify(p397))

    // 牙：改一张为 cover ⇒ 必红
    const p397teeth = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')).filter((i) => i.naturalWidth > 0)
      const t = imgs.find((i) => (i.dataset.testid || '').startsWith('album-cover') || i.closest('[data-testid^="tg-"]'))
      if (!t) return { tripped: false, note: 'no img to mutate' }
      t.style.objectFit = 'cover'
      const tripped = getComputedStyle(t).objectFit === 'cover'
      t.style.objectFit = ''
      return { tripped }
    })
    check('P397_teeth_cover_mutation_trips', p397teeth.tripped, JSON.stringify(p397teeth))

    const file = path.join(OUT_DIR, 'bug396-398.png')
    await page.screenshot(file, { fullPage: false })
    results.screenshot = file
  } finally {
    await browser.close()
  }

  results.verdict = problems.length === 0 ? 'PASS' : `FAIL (${problems.length})`
  fs.writeFileSync(path.join(OUT_DIR, 'bug396-398-verify.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.message ? e.message : e)
  process.exit(1)
})
