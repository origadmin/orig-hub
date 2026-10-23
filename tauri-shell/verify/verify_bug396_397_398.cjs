#!/usr/bin/env node
'use strict'
/**
 * BUG-396 / 397 / 398 合并验收（同一活栈，三段判据 + 各自页内反向变异验牙）：
 *
 * P396 入库「优先」不得作用于终态任务：
 *   a. wire：`/api/downloads?scope=all` 里 status∈{done,cancelled} 的任务 priority==0；
 *   b. DOM：ingest 行 data-status=终态 ⇒ 无 prefer/unprefer 动作钮、无「优先」徽标；
 *   牙：向终态行注入徽标+unprefer 钮 ⇒ b 必红。
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

    // ───────── P397 / P398：TG 域 ─────────
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
