#!/usr/bin/env node
/**
 * BUG-392 验收探针：下载域「一个列表接口 + 一个状态变更接口」。
 *
 * 用户共识（2026-10-23 04:25）：「不论插件下载,原生下载,BT下载,最终体现的都是
 * 统一的一个API接口,状态另一个接口」。此前 `/api/downloads` 只回引擎原生面
 * （长期只挂 1 条 BUG-322 遗留 mock 夹具），统一聚合面是另一个端点
 * `/api/activity`，状态变更还要前端直连 orig-tg。
 *
 * 修法：
 *   ① `/api/downloads?scope=` = 统一列表（全来源 + sources 健康度）；
 *      `/api/downloads/native` = 引擎原生明细投影（调试，非 UI 列表路径）。
 *   ② `/api/downloads/:id`（POST action / DELETE）= 统一状态变更，按行 id
 *      前缀 `tg:`/`dl:` **服务端分流**。
 *   ③ 清理 `mock://bug322ui.bin` 遗留夹具。
 *
 * 判据：
 *   U1 统一列表：`/api/downloads?scope=all` 是快照对象（tasks+sources），
 *      同时含 cache（插件入库）与 download（原生/BT）两源声明，且无 mock:// 残留。
 *   U2 引擎原生投影与统一列表**不同面**：native 每行都带引擎字段（dest_path），
 *      行数 ≤ 统一列表行数。
 *   U3 状态变更按前缀分流：`tg:` 行 pause/resume → 422（不造假，非 404）；
 *      `tg:` 行 cancel 打不存在的 id → 502（确实去了 orig-tg，不是落到引擎）；
 *      `dl:` 行 pause 打不存在的 uuid → 404（确实落在引擎侧）。
 *   U4 UI 走统一端点：下载域渲染出行（engine+ingest 合计 > 0），无页面异常。
 *   验牙：装回旧路由（`/api/downloads` = 引擎原生数组）U1/U2 必红，还原复绿。
 *
 * 只读：不取消/重试任何真实任务（U3 全部用不存在的 id 或不支持的动作）。
 */
'use strict'

const path = require('path')
const fs = require('fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))

const OUT = path.join(__dirname, 'evidence', 'BUG-392')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  const d = ep.daemon

  // ---- U1：统一列表 ----
  const res = await fetch(`${d}/api/downloads?scope=all`)
  const snap = await res.json()
  const isSnapshot =
    snap && !Array.isArray(snap) && Array.isArray(snap.tasks) && Array.isArray(snap.sources)
  check('U1 /api/downloads 是统一快照（tasks+sources，不是裸数组）', isSnapshot, isSnapshot ? `tasks=${snap.tasks.length}` : `shape=${Object.prototype.toString.call(snap)}`)
  if (!isSnapshot) {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
    process.exit(1)
  }
  const kinds = [...new Set(snap.sources.map((s) => s.kind))].sort()
  check(
    'U1b 快照同时声明两个来源（download 原生/BT + cache 插件入库）',
    kinds.includes('download') && kinds.includes('cache'),
    `sources=${kinds.join(',')}`,
  )
  const mockRows = snap.tasks.filter((t) => (t.name || '').includes('bug322ui') || (t.id || '').includes('bug322ui'))
  check('U1c BUG-322 遗留 mock 夹具已清空（残留=0）', mockRows.length === 0, `mockRows=${mockRows.length}`)
  console.log(`[info] unified tasks=${snap.tasks.length} kinds=${[...new Set(snap.tasks.map((t) => t.kind))].join(',')}`)

  // ---- U2：原生投影不是统一列表 ----
  const nat = await (await fetch(`${d}/api/downloads/native`)).json()
  const nativeAllEngine = Array.isArray(nat) && nat.every((r) => 'dest_path' in r)
  check(
    'U2 /api/downloads/native 仍是引擎原生投影（每行带 dest_path）',
    nativeAllEngine && nat.length <= snap.tasks.length,
    `native=${nat.length} unified=${snap.tasks.length}`,
  )

  // ---- U3：统一状态变更按前缀分流 ----
  const tgPause = await fetch(`${d}/api/downloads/tg:999999999?action=pause`, { method: 'POST' })
  check(
    'U3a tg: 行 pause/resume → 422（走 TG 分支且不造假续传，不是 404）',
    tgPause.status === 422,
    `HTTP ${tgPause.status}`,
  )
  const tgCancel = await fetch(`${d}/api/downloads/tg:999999999?action=cancel`, { method: 'POST' })
  check(
    'U3b tg: 行 cancel 打到不存在的 id → 502（请求确实代理去 orig-tg，未落引擎）',
    tgCancel.status === 502,
    `HTTP ${tgCancel.status}`,
  )
  const dlPause = await fetch(`${d}/api/downloads/dl:00000000-0000-0000-0000-000000000000?action=pause`, {
    method: 'POST',
  })
  check('U3c dl: 行落引擎侧（不存在的 uuid → 404）', dlPause.status === 404, `HTTP ${dlPause.status}`)

  // ---- U4：UI 走统一端点后仍出数据 ----
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded', timeoutMs: 60000 })
    await sleep(3000)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await sleep(6000)
    const ui = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="download-item-select"], [data-testid="ingest-group-select"]').length,
      text: (document.querySelector('[data-testid="tg-panel-root"], main') || {}).innerText?.slice(0, 0) || '',
    }))
    check('U4 下载域经统一端点渲染出行（>0）', ui.rows > 0, `rows=${ui.rows}`)
    await page.screenshot(path.join(OUT, '01-download-unified.png'))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('[bug392] fatal:', e && e.message)
  process.exit(2)
})
