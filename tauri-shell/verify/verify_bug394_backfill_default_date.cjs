#!/usr/bin/env node
/**
 * BUG-394 验收探针：回溯表单日期默认 = 库内最老已入库消息日期。
 *
 * 用户 2026-10-23 原话（截图）：「回溯的严重问题…这里应该默认显示当前的最老数据吧?」
 *
 * 修法：
 *   ① 引擎 `MonitoredChannel` 新增 `oldestMessageDate`（unix 秒，
 *      `MIN(COALESCE(msg_date, created_at))`），随 `/api/tg/monitor/channels` 下发；
 *   ② UI 展开回溯表单时用它预填日期（UTC 口径，`fmtDateOnly`），不再空白猜。
 *
 * 判据：
 *   B1 API wire 层存在 `oldestMessageDate` 数值字段，且真源存在非零样本
 *      （没有入库数据则 Loud FAIL——没有样本就证不了默认值）。
 *   B2 UI：点开首个频道的回溯表单后，`tg-monitor-backfill-date` 的 `value`
 *      == `toISOString` 口径的 `oldestMessageDate` 日期（与服务端
 *      `parse_date_utc` 同一把 UTC 尺）。截图为证。
 *
 * 只读：不发起/不取消回溯，不写库。截图落 `evidence/BUG-394/`。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-394')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 与 TgPanel.fmtDateOnly 同口径：unix 秒 → YYYY-MM-DD（UTC）。 */
function fmtDateOnly(unixSec) {
  if (!unixSec || unixSec <= 0) return ''
  return new Date(unixSec * 1000).toISOString().slice(0, 10)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  const tg = ep.tg

  // ---- B1：API wire 层 ----
  const res = await fetch(`${tg}/api/tg/monitor/channels`)
  const list = await res.json()
  const chans = Array.isArray(list) ? list : list.channels || []
  check(
    'B1-i monitor/channels 带 oldestMessageDate 数值字段（旧引擎无此字段 ⇒ 必败）',
    chans.length > 0 && chans.every((c) => typeof c.oldestMessageDate === 'number'),
    `n=${chans.length}`,
  )
  const withData = chans.filter((c) => (c.oldestMessageDate ?? 0) > 0)
  check(
    'B1-ii 真源存在非零最老数据日期（无入库样本则 Loud FAIL）',
    withData.length > 0,
    `withData=${withData.length}/${chans.length}`,
  )
  if (withData.length === 0) {
    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
    )
    process.exit(1)
  }
  const target = withData[0]
  const expectDate = fmtDateOnly(target.oldestMessageDate)
  console.log(
    `[info] target channel=${target.channelId} title=${target.title} oldest=${target.oldestMessageDate} → ${expectDate}`,
  )

  // ---- B2：UI 层 ----
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
  await sleep(3000)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await sleep(4500)
  // 不做任何模糊文本点击：监控节默认展开（monitorOpen useState(true)），
  // 且模糊 /监控|Monitor/ 正则会误中主列频道头部的「取消监控」按钮——
  // 那是一次真实的 DELETE（本探针第一版就因此把受控频道删了两次）。
  // 只读纪律：验收脚本除了声明过的受控夹具，不得触发任何破坏性动作。

  // 点开首个频道的回溯表单（BUG-394：日期应被预填为最老数据日期）。
  const opened = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    const btns = root
      ? Array.from(root.querySelectorAll('[data-testid="tg-monitor-backfill-open"]'))
      : []
    if (btns.length === 0) return { opened: false, n: 0 }
    btns[0].click()
    return { opened: true, n: btns.length }
  })
  await sleep(1200)

  const ui = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="tg-monitor-backfill-date"]')
    const form = document.querySelector('[data-testid="tg-monitor-backfill-form"]')
    return {
      formVisible: !!form,
      value: input ? input.value : null,
      placeholder: input ? input.placeholder : null,
    }
  })
  check('B2-i TG 面板监控列表渲染且回溯表单可展开', opened.opened === true && ui.formVisible === true, `openBtns=${opened.n}`)
  check(
    'B2-ii 回溯日期默认 = API oldestMessageDate 的 UTC 日期（非空白/非占位符）',
    ui.value === expectDate,
    `ui="${ui.value}" expect="${expectDate}" (placeholder="${ui.placeholder}")`,
  )
  await page.screenshot(path.join(OUT, '01-backfill-default-date.png'))

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  )
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(`[bug394] fatal: ${e && e.message}`)
  process.exit(2)
})
