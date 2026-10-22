#!/usr/bin/env node
'use strict'

/**
 * 诊断探针：dev 栈白屏时先分诊「应用 vs 通道」。
 * 输出：HTTP 状态、`#root` 子节点数、`document.title`、全部 console / pageerror。
 *
 * Usage: node verify/_probe_blank.cjs
 * Env:   APP_PORT(默认5180)
 */

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    const resp = await page.goto(APP_URL, { waitForRoot: false, settleMs: 0 })
    console.log('[probe] goto status =', resp && resp.status)
    await delay(6000)
    const facts = await page.evaluate(() => ({
      title: document.title,
      rootChildren: (document.getElementById('root') || {}).childElementCount ?? -1,
      bodyLen: (document.body.innerHTML || '').length,
      testids: Array.from(document.querySelectorAll('[data-testid]'))
        .map((e) => e.getAttribute('data-testid'))
        .slice(0, 20),
      scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src')),
    }))
    console.log('[probe] facts =', JSON.stringify(facts, null, 2))
    console.log('[probe] PAGE_ERRORS =', JSON.stringify(page.pageErrors ? page.pageErrors() : []))
    console.log('[probe] CONSOLE_ERRORS =', JSON.stringify(page.consoleErrors ? page.consoleErrors() : []))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
