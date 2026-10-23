#!/usr/bin/env node
'use strict'
/**
 * S1 冒烟（BUG-402 三级验收）：交付任何改动**必跑**的唯一门槛，目标 < 60s。
 *
 * 只回答一个问题——「产品现在能不能用」：
 *   M1. daemon 19786 / orig-tg 19787 / vite 5180 三端口可达；
 *   M2. 前端真渲染：文件域列表出真实行（不是白屏/错误页）；
 *   M3. 统一下载快照端点 200 且带 tasks+sources（BUG-392 契约的最低限）。
 *
 * 失败 ⇒ 不许进入 S2/S3，不许提交汇报。用法:: node verify/smoke.cjs
 * Exit: 0 = 冒烟通过；1 = 任一项失败
 */

const http = require('node:http')

const DAEMON = process.env.DAEMON_PORT || 19786
const TG = process.env.TG_PORT || 19787
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
      res.resume()
      resolve(res.statusCode > 0)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) })
        } catch (_e) {
          resolve({ status: res.statusCode, json: null })
        }
      })
    })
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null })
    })
  })
}

async function main() {
  const t0 = Date.now()
  const results = {}
  const problems = []
  const check = (name, ok, detail) => {
    results[name] = ok ? 'PASS' : `FAIL ${detail || ''}`
    if (!ok) problems.push(name)
  }

  // M1 三端口
  check('M1_daemon_19786', await probePort(DAEMON))
  check('M1_origtg_19787', await probePort(TG))
  check('M1_vite_5180', await probePort(new URL(APP_URL).port || '5180'))

  // M2 前端真渲染（CDP：文件域出真实行）
  const cdp = require('./lib/cdp.cjs')
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    let rows = 0
    try {
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="file-list-row"], [data-testid="media-card"], [data-testid="series-card"]').length > 0,
        { timeout: 20000 },
      )
      rows = await page.evaluate(
        () =>
          document.querySelectorAll('[data-testid="file-list-row"], [data-testid="media-card"], [data-testid="series-card"]').length,
      )
    } catch (_e) {
      /* rows 保持 0 */
    }
    check('M2_files_view_renders', rows > 0, `rows=${rows}`)
    results.M2_rows = rows
    const errs = page.pageErrors()
    check('M2_no_page_errors', errs.length === 0, errs.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }

  // M3 统一下载快照
  const dl = await fetchJson(`http://127.0.0.1:${DAEMON}/api/downloads?scope=all`)
  check(
    'M3_unified_downloads_snapshot',
    dl.status === 200 && !!dl.json && Array.isArray(dl.json.tasks) && Array.isArray(dl.json.sources),
    `status=${dl.status}`,
  )

  results.elapsedMs = Date.now() - t0
  results.verdict = problems.length === 0 ? 'PASS' : `FAIL (${problems.join(', ')})`
  console.log(JSON.stringify(results, null, 2))
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e && e.message ? e.message : e)
  process.exit(1)
})
