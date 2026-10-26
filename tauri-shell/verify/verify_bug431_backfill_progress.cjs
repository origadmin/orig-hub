#!/usr/bin/env node
'use strict'
/**
 * BUG-431 真实 UI 验收：数据回溯进度块的文案与进度可见性。
 *
 * ## 用户诉求（2026-10-26 原话 + 截图）
 *   「数据回溯展示问题：文字有严重问题，进度也不可见。」
 *   截图里那一行同时有三处硬伤：
 *     · 标题被截成「回溯中（至 2026-01-01…」；
 *     · 副行写着「回溯尚未开始 · 最新 #9719」—— 与「回溯中」自相矛盾；
 *     · 取消按钮直接渲染出键名 `tg.backfillCancel`（zh-CN 漏定义）。
 *
 * ## 判据
 *  431-A 可见文本里不出现原始 i18n 键名（`tg.` 前缀的裸键）。
 *  431-B 状态不矛盾：含「回溯中」，且不含「尚未开始」。
 *  431-C 目标日期完整可见：文本含完整 `YYYY-MM-DD`，且该元素未被截断
 *        （scrollWidth <= clientWidth + 1）。
 *  431-D 进度可见：出现「已回溯至 <日期>」与「还差 N 天」，N 与 API 的
 *        oldestMessageDate / backfillUntil 同源（允许 ±1 天取整误差）。
 *  431-E 进度指示条存在且尺寸 > 0（宽 ≥ 40px、高 ≥ 2px）。
 *  431-F 无页面 / console 错误（favicon 噪声除外）。
 *  RF1   把进度行容器压到 120px ⇒ 431-C 必须 FAIL（截断判据灵敏）。
 *  RF2   还原容器宽度 ⇒ 复绿。
 *
 * 431-A 的静态半边由 `scripts/check-i18n-keys.py` 覆盖（缺键即红，已双向验过），
 * 这里只判「渲染结果里没有裸键」。
 *
 * 用法（先起 dev 栈 5180 + 媒体 API 19787）：
 *   node tauri-shell/verify/verify_bug431_backfill_progress.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const TG_PORT = Number(process.env.TG_PORT || 19787)
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug431-backfill'),
)
const NAV_TIMEOUT = 90000
const DAY = 86400

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 直接读媒体 API：真值来源，UI 的日期/天数必须与它同源 */
async function readRunning() {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}/api/tg/monitor/channels`)
  if (!res.ok) throw new Error(`monitor/channels HTTP ${res.status}`)
  const list = await res.json()
  const chans = Array.isArray(list) ? list : list.channels || []
  return chans.filter((c) => (c.backfillUntil ?? 0) > 0)
}

/** 打开 TG 面板（监控区默认展开，**不要**去点折叠开关——点了反而收起） */
async function openMonitor(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
  const ok = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!ok) throw new Error('nav-tg not found')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
    timeout: 25000,
  })
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="tg-monitor-backfill-progress"]'),
    { timeout: 30000 },
  )
  await delay(900)
}

/** 量进度块：文本、截断、条尺寸 */
function readBlock() {
  const row = document.querySelector('[data-testid="tg-monitor-backfill-progress"]')
  if (!row) return { exists: false }
  const target = row.querySelector('[data-testid="tg-monitor-backfill-target"]')
  const reached = row.querySelector('[data-testid="tg-monitor-backfill-reached"]')
  const remain = row.querySelector('[data-testid="tg-monitor-backfill-remaining"]')
  const bounds = row.querySelector('[data-testid="tg-monitor-backfill-bounds"]')
  const bar = row.querySelector('[data-testid="tg-monitor-backfill-bar"]')
  const text = (row.innerText || '').replace(/\s+/g, ' ').trim()
  const br = bar ? bar.getBoundingClientRect() : null
  const ir = bar && bar.firstElementChild ? bar.firstElementChild.getBoundingClientRect() : null
  const overflow = (el) => {
    if (!el) return null
    return { sw: el.scrollWidth, cw: el.clientWidth }
  }
  return {
    exists: true,
    text,
    targetText: target ? (target.textContent || '').trim() : null,
    reachedText: reached ? (reached.textContent || '').trim() : null,
    remainText: remain ? (remain.textContent || '').trim() : null,
    targetBox: overflow(target),
    reachedBox: overflow(reached),
    boundsBox: overflow(bounds),
    barW: br ? Math.round(br.width) : 0,
    barH: br ? Math.round(br.height) : 0,
    fillW: ir ? Math.round(ir.width) : 0,
    until: Number(row.getAttribute('data-until') || 0),
    oldest: Number(row.getAttribute('data-oldest') || 0),
    daysLeft: Number(row.getAttribute('data-days-left') || -1),
  }
}

/** 把进度行还原成「旧的截断形态」：窄宽 + nowrap + overflow hidden（RF 用） */
async function squeeze(page, px) {
  return page.evaluate((w) => {
    const row = document.querySelector('[data-testid="tg-monitor-backfill-progress"]')
    if (!row) return null
    const bounds = row.querySelector('[data-testid="tg-monitor-backfill-bounds"]')
    const prev = {
      rowW: row.style.width,
      wrap: bounds ? bounds.style.flexWrap : '',
      ov: bounds ? bounds.style.overflow : '',
    }
    row.style.width = `${w}px`
    if (bounds) {
      bounds.style.flexWrap = 'nowrap'
      bounds.style.overflow = 'hidden'
    }
    return prev
  }, px)
}

async function restore(page, prev) {
  await page.evaluate((p) => {
    const row = document.querySelector('[data-testid="tg-monitor-backfill-progress"]')
    if (!row) return
    row.style.width = (p && p.rowW) || ''
    const bounds = row.querySelector('[data-testid="tg-monitor-backfill-bounds"]')
    if (bounds) {
      bounds.style.flexWrap = (p && p.wrap) || ''
      bounds.style.overflow = (p && p.ov) || ''
    }
  }, prev)
}

/** 「日期完整 + 三处都不溢出」= 未被截断 */
function notClipped(b) {
  const box = (x) => !!x && x.sw <= x.cw + 1
  return (
    /至\s*\d{4}-\d{2}-\d{2}/.test(b.targetText || '') &&
    box(b.targetBox) &&
    box(b.reachedBox) &&
    box(b.boundsBox)
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ---- 环境闸门：必须真的有一条在回溯，否则判据无意义 ----
  const running = await readRunning()
  if (running.length === 0) {
    console.log('ENV FAIL: 当前没有回溯中的频道，无法判定（这不是通过）')
    process.exit(1)
  }
  const api = running[0]
  const expectDays = Math.max(0, Math.ceil((api.oldestMessageDate - api.backfillUntil) / DAY))
  console.log(
    `[env] channel=${api.channelId} until=${api.backfillUntil} before=${api.backfillBeforeId} ` +
      `latest=${api.lastMessageId} oldest=${api.oldestMessageDate} expectDays=${expectDays}`,
  )

  const browser = await cdp.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await openMonitor(page)
    const b = await page.evaluate(readBlock)
    await page.screenshot(path.join(OUT, '01-progress-row.png'))
    console.log('[ui] ' + JSON.stringify(b))

    // 431-A 裸键
    const bareKey = /(^|\s)tg\.[a-zA-Z]/.test(b.text)
    check('431-A 可见文本无原始 i18n 键名', b.exists && !bareKey, `text="${b.text}"`)

    // 431-B 不自相矛盾
    const noContradict = /回溯中/.test(b.text) && !/尚未开始/.test(b.text)
    check('431-B 状态文案不自相矛盾', noContradict, `text="${b.text}"`)

    // 431-C 目标日期完整且未截断
    check(
      '431-C 目标日期完整可见且未被截断',
      notClipped(b),
      `target="${b.targetText}" boxes=${JSON.stringify([b.targetBox, b.reachedBox, b.boundsBox])}`,
    )

    // 431-D 进度可见且与 API 同源
    const hasReached = /已回溯至\s*\d{4}-\d{2}-\d{2}/.test(b.reachedText || '')
    const m = (b.remainText || '').match(/还差\s*(\d+)\s*天/)
    const daysOk = !!m && Math.abs(Number(m[1]) - expectDays) <= 1
    check(
      '431-D 进度可见（已回溯至日期 + 还差天数）且与 API 同源',
      hasReached && daysOk && b.daysLeft >= 0,
      `reached="${b.reachedText}" remain="${b.remainText}" apiDays=${expectDays} uiDays=${b.daysLeft}`,
    )

    // 431-E 进度条可见
    check(
      '431-E 进度指示条存在且尺寸 > 0',
      b.barW >= 40 && b.barH >= 2 && b.fillW >= 40,
      `bar=${b.barW}x${b.barH} fill=${b.fillW}`,
    )

    // ---- RF1：还原成旧的截断形态 ⇒ 431-C 必须红 ----
    const prevW = await squeeze(page, 120)
    await delay(400)
    const sq = await page.evaluate(readBlock)
    await page.screenshot(path.join(OUT, '02-rf1-truncated.png'))
    check(
      'RF1 还原旧的 nowrap 截断形态时 431-C 必须 FAIL（判据灵敏）',
      notClipped(sq) === false,
      `truncated target="${sq.targetText}" boxes=${JSON.stringify([sq.targetBox, sq.reachedBox, sq.boundsBox])}`,
    )
    await restore(page, prevW)
    await delay(400)
    const back = await page.evaluate(readBlock)
    check('RF2 还原后复绿', notClipped(back), `restored target="${back.targetText}"`)

    // 431-F 错误
    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon/i.test(String(e)),
    )
    check('431-F 无页面 / console 错误', errs.length === 0, `errors=${JSON.stringify(errs.slice(0, 3))}`)
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.pass)
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ date: new Date().toISOString(), api, checks }, null, 2),
  )
  console.log(`\ntotal=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  console.log(`evidence: ${OUT}`)
  if (failed.length) {
    console.log('FAILED CHECKS:')
    for (const c of failed) console.log(`  - ${c.name} — ${c.detail}`)
    process.exit(1)
  }
  console.log('ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
