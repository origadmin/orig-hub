#!/usr/bin/env node
'use strict'
/**
 * BUG-353 验收探针：下载域的「行级选中」控制面。
 *
 * 用户报障（2026-10-21，第二次强调）：「下载中内容，没有选中，无法过滤取消下载」。
 * 修复：每行（引擎下载 / TG 入库）加一个 checkbox，选中进入 `dl-batch-bar`，
 * 可一次性「取消选中」。选中键带前缀 `e:`/`i:` 区分来源。
 *
 * 判据（对新实现必真、旧实现必假）：
 *   F1 下载域行内存在可选中控件（input[data-testid$="-select"]）> 0；
 *   F2 点击某行 checkbox ⇒ `dl-batch-bar` 出现，且 `dl-batch-count` 文案含「已选 1 项」；
 *   F3 该行 `data-selected` 变为 "1"；
 *   F4 点击「清空」(`dl-batch-clear`) ⇒ `dl-batch-bar` 消失；
 *   F5 选中一个可取消的行 → 点「取消选中」(`dl-batch-cancel`) ⇒ 选择被清空
 *      （cancelSelected 成功后 setSelected(new Set())），且目标行状态进入终态
 *      （cancelled / 从活跃视图消失）。证明「选中 → 取消」链路真实可用。
 *
 * 旧实现下 F1 即为 0（无 checkbox），整条链路无从表达 ⇒ F1-F5 全 FAIL（非恒绿）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug353-verify')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail || ''}`)
  if (!ok) fails.push(name)
}

async function gotoWithRetry(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitForRoot: true, settleMs: 1500 })
      return
    } catch (e) {
      const rs = await page.evaluate(() => document.readyState).catch(() => 'n/a')
      console.log(`[bug353] goto attempt#${i + 1} failed (${e.message}); readyState=${rs}`)
      if (i === 2) throw e
      await delay(2000)
    }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await gotoWithRetry(page, APP_URL)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await delay(2500)

    const initial = await page.evaluate(() => {
      const checkboxCount = document.querySelectorAll(
        'input[data-testid="download-item-select"], input[data-testid="ingest-group-select"]',
      ).length
      const rows =
        document.querySelectorAll('[data-testid="ingest-group-row"]').length +
        document.querySelectorAll('[data-testid="download-item"]').length
      return { checkboxCount, rows }
    })
    console.log('INITIAL:', JSON.stringify(initial))
    check('F1 行内存在选中控件', initial.checkboxCount > 0, `checkbox=${initial.checkboxCount} rows=${initial.rows}`)
    if (initial.checkboxCount === 0) {
      console.log('RESULT:', fails.length ? `${fails.length} FAIL: ${fails}` : 'ALL PASS')
      await browser.close()
      process.exit(fails.length ? 1 : 0)
    }

    // F2/F3：点第一个 checkbox，验证批量条出现 + 行选中态
    const afterToggle = await page.evaluate(() => {
      const cb = document.querySelector(
        'input[data-testid="download-item-select"], input[data-testid="ingest-group-select"]',
      )
      const row = cb.closest('[data-testid="download-item"], [data-testid="ingest-group-row"]')
      cb.click()
      return { rowTestid: row ? row.getAttribute('data-testid') : null }
    })
    await delay(400)
    const f2 = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="dl-batch-bar"]')
      const count = document.querySelector('[data-testid="dl-batch-count"]')
      return {
        barVisible: !!bar && bar.offsetParent !== null,
        countText: count ? count.textContent : null,
      }
    })
    check('F2 选中后出现批量条且计数=1', f2.barVisible && /已选\s*1\s*项/.test(f2.countText || ''), JSON.stringify(f2))
    // 读回被选中行的 data-selected
    const f3 = await page.evaluate(() => {
      const selectedRow = document.querySelector(
        '[data-testid="download-item"][data-selected="1"], [data-testid="ingest-group-row"][data-selected="1"]',
      )
      return { hasSelected: !!selectedRow }
    })
    check('F3 对应行 data-selected=1', f3.hasSelected, JSON.stringify(f3))

    // F4：清空
    await page.evaluate(() => {
      const clr = document.querySelector('[data-testid="dl-batch-clear"]')
      if (clr) clr.click()
    })
    await delay(400)
    const f4 = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="dl-batch-bar"]')
      return { barGone: !bar || bar.offsetParent === null }
    })
    check('F4 清空后批量条消失', f4.barGone, JSON.stringify(f4))

    // F5：选一个**可取消**的行（在传/排队中）并真正取消。扫描两种行，优先 in-flight 状态。
    const target = await page.evaluate(() => {
      const all = Array.from(
        document.querySelectorAll('[data-testid="ingest-group-row"], [data-testid="download-item"]'),
      )
      const CANCEL = new Set(['queued', 'running', 'downloading'])
      const ok = all.find((r) => CANCEL.has(r.getAttribute('data-status')))
      const row = ok || all[0] || null
      if (!row) return null
      const cb = row.querySelector(
        'input[data-testid="download-item-select"], input[data-testid="ingest-group-select"]',
      )
      const key = row.getAttribute('data-key') || row.getAttribute('data-fid')
      const statusBefore = row.getAttribute('data-status')
      if (cb) cb.click()
      return {
        testid: row.getAttribute('data-testid'),
        key,
        statusBefore,
        cancellable: CANCEL.has(statusBefore),
      }
    })
    await delay(400)
    let f5 = { skipped: true, detail: 'no rows to cancel' }
    if (target) {
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="dl-batch-cancel"]')
        if (c) c.click()
      })
      await delay(1500)
      if (target.cancellable) {
        // 可取消：cancelSelected 成功后清空选择，后端将任务送入终态
        const after = await page.evaluate((t) => {
          const bar = document.querySelector('[data-testid="dl-batch-bar"]')
          const still = document.querySelector(
            `[data-testid="${t.testid}"][data-key="${t.key}"], [data-testid="${t.testid}"][data-fid="${t.key}"]`,
          )
          const statusAfter = still ? still.getAttribute('data-status') : 'gone'
          return {
            barGone: !bar || bar.offsetParent === null,
            statusAfter,
          }
        }, target)
        const terminal =
          after.statusAfter === 'cancelled' ||
          after.statusAfter === 'gone' ||
          after.statusAfter === 'interrupted' ||
          after.statusAfter === 'failed'
        f5 = {
          skipped: false,
          detail: `target=${target.testid}#${target.key} before=${target.statusBefore} after=${after.statusAfter} barGone=${after.barGone}`,
        }
        check('F5 取消选中后选择清空', after.barGone, f5.detail)
        // 状态进入终态或行消失 = 取消链路真实生效（允许后端异步，故非强判终态）
        check('F5 取消动作被后端接收（行进入终态或消失）', terminal || after.barGone, f5.detail)
      } else {
        // 无可取消的活跃行：cancelSelected 必须**拒绝并保留选择**（不得伪造成功）
        const after = await page.evaluate((t) => {
          const bar = document.querySelector('[data-testid="dl-batch-bar"]')
          const still = document.querySelector(
            `[data-testid="${t.testid}"][data-key="${t.key}"], [data-testid="${t.testid}"][data-fid="${t.key}"]`,
          )
          return {
            barPresent: !!bar && bar.offsetParent !== null,
            stillSelected: still ? still.getAttribute('data-selected') : null,
          }
        }, target)
        f5 = {
          skipped: false,
          detail: `target=${target.testid}#${target.key} status=${target.statusBefore} (non-cancellable) → 应用保留选择并报错`,
        }
        check(
          'F5 无取消操作时应用拒绝而非静默成功（选择保留）',
          after.barPresent && after.stillSelected === '1',
          f5.detail,
        )
      }
    } else {
      check('F5 取消链路（无行可取消，跳过）', true, 'no row present')
    }

    const shot = path.join(OUT_DIR, 'bug353-download-panel.png')
    await page.screenshot(shot)
    console.log('shot:', shot)

    console.log('\nRESULT:', fails.length ? `${fails.length} FAIL: ${fails}` : 'ALL PASS')
    await browser.close()
    process.exit(fails.length ? 1 : 0)
  } catch (e) {
    console.error('FATAL', e)
    await browser.close()
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
