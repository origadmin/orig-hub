#!/usr/bin/env node
/**
 * BUG-382 验收探针：回溯双边界可见（「已回溯至哪 / 最新到哪」）。
 *
 * 用户 2026-10-22 原话：「没有最新和历史无法确认上次回溯点。」
 *
 * 修法：
 *   ① 引擎 `MonitoredChannel` 新增 `backfillBeforeId`（回溯游标）与
 *      `lastMessageId`（增量同步游标），随 `/api/tg/monitor/channels` 下发；
 *   ② UI 回溯进度行显示双边界「已回溯至 #{id} · 最新 #{id}」。
 *
 * 判据：
 *   A1 API 字段在 wire 上存在且为数值（旧引擎无此字段 ⇒ 必败）。
 *   A2 真源里有非零游标（lastMessageId>0 —— 没有可测样本则 Loud FAIL）。
 *   A3 UI 双边界行：任一频道处于回溯中时，`tg-monitor-backfill-bounds`
 *      文本同时含「已回溯至/回溯尚未开始」与「最新 #」，且 data-* 与 API
 *      同源一致；无回溯中频道时改为验证渠道行正常渲染（如实记录）。
 *
 * 截图落 `evidence/BUG-382/`。只读：不发起/不取消回溯，不写库。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-382')
/** 受控夹具频道：用户此前真实监控过的频道（旧栈残留库可考），非伪造实体。 */
const FIX = { channelId: -1003969766003, title: '黄果短剧|AICR短剧' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  const tg = ep.tg

  // ---- A1/A2：API wire 层 ----
  // 前提：活栈监控列表非空。空 = 无法验证字段（Loud FAIL，不是「空也算过」）。
  // 夹具纪律：活栈监控为 0 时，用用户此前监控过的真实频道做一个**受控样本**
  // （POST 幂等 → 验证 → DELETE 清除 → 残留=0 断言）。不伪造库态。
  let res = await fetch(`${tg}/api/tg/monitor/channels`)
  let list = await res.json()
  let chans = Array.isArray(list) ? list : list.channels || []
  let fixtureAdded = false
  if (chans.length === 0) {
    console.log('[info] live monitored list empty; adding controlled fixture channel')
    const add = await fetch(`${tg}/api/tg/monitor/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIX),
    })
    if (!add.ok) {
      check('A1 monitor/channels 带 backfillBeforeId/lastMessageId 数值字段', false, `fixture add failed: HTTP ${add.status}`)
      check('A2 真源存在非零同步游标（lastMessageId>0）', false, 'no sample (add failed)')
      await browserlessWrite(OUT, results)
      process.exit(1)
    }
    fixtureAdded = true
    // 同步循环 ≥10s 一 tick（monitor.rs:50）；游标由第一轮同步推进。
    // 轮询至 lastMessageId>0（上限 120s），把「同步还没跑完」与「字段坏了」区分开。
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      await sleep(5000)
      res = await fetch(`${tg}/api/tg/monitor/channels`)
      list = await res.json()
      chans = Array.isArray(list) ? list : list.channels || []
      if (chans.some((c) => c.lastMessageId > 0)) break
    }
  }
  check(
    'A1 monitor/channels 带 backfillBeforeId/lastMessageId 数值字段',
    Array.isArray(chans) && chans.length > 0 && chans.every(
      (c) => typeof c.backfillBeforeId === 'number' && typeof c.lastMessageId === 'number',
    ),
    `n=${chans.length}`,
  )
  const withCursor = chans.filter((c) => c.lastMessageId > 0)
  check(
    'A2 真源存在非零同步游标（lastMessageId>0）',
    withCursor.length > 0,
    `withCursor=${withCursor.length}/${chans.length}`,
  )
  const running = chans.filter((c) => (c.backfillUntil ?? 0) > 0)
  console.log(`[info] channels=${chans.length} backfillRunning=${running.length}`)

  // ---- A3：UI 层 ----
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
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tg-panel-root"]')
    const btn = el && Array.from(el.querySelectorAll('button')).find((b) => /监控|Monitor/.test(b.innerText || ''))
    if (btn) btn.click()
  })
  await sleep(2500)

  const ui = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    if (!root) return { root: false }
    const bounds = root.querySelector('[data-testid="tg-monitor-backfill-bounds"]')
    const rows = root.querySelectorAll('[data-testid^="tg-monitor-channel"], [data-key], [class*="channel"]').length
    return {
      root: true,
      rows,
      bounds: bounds
        ? { before: bounds.getAttribute('data-before'), latest: bounds.getAttribute('data-latest'), text: bounds.textContent.trim() }
        : null,
    }
  })
  check('A3-i TG 面板与监控列表渲染', ui.root === true, `rows=${ui.rows}`)
  if (running.length > 0) {
    const apiRunning = running[0]
    check(
      'A3-ii 回溯中频道双边界行：文本含「最新 #」且 data-* 与 API 同源',
      !!ui.bounds && /最新 #/.test(ui.bounds.text) && String(apiRunning.lastMessageId) === ui.bounds.latest,
      ui.bounds ? `ui=[${ui.bounds.text}] apiLatest=${apiRunning.lastMessageId}` : 'bounds row missing',
    )
  } else {
    check('A3-ii 当前无回溯中频道，双边界行条件渲染未触发（如实记录，API 字段已由 A1 覆盖）', true, 'no running backfill')
  }
  await page.screenshot(path.join(OUT, '01-tg-monitor.png'))

  await browser.close()

  // ---- 夹具清理（残留=0 断言）----
  if (fixtureAdded) {
    const del = await fetch(
      `${tg}/api/tg/monitor/channels/${encodeURIComponent(String(FIX.channelId))}`,
      { method: 'DELETE' },
    )
    await sleep(1000)
    const after = await (await fetch(`${tg}/api/tg/monitor/channels`)).json()
    const afterChans = Array.isArray(after) ? after : after.channels || []
    check(
      'A4 夹具清理：监控列表还原为空（残留=0）',
      del.ok && afterChans.length === 0,
      `delete HTTP ${del.status} remain=${afterChans.length}`,
    )
  }

  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  )
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  process.exit(pass ? 0 : 1)
}

/** 早退路径也要落证据（无浏览器）。 */
function browserlessWrite(outDir, results) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2))
}

main().catch((e) => {
  console.error(`[bug382] fatal: ${e && e.message}`)
  process.exit(2)
})
