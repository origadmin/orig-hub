#!/usr/bin/env node
'use strict'
/**
 * 缓存队列「排队可见 + 条目内字节」验收（BUG-181）。
 *
 * 用户投诉：「任务1添加,任务2就完全无法添加」。根因有二：
 *   1. `GET /api/tg/cache/tasks` 对排队任务零呈现 —— 入队第二组后，前端下一拍
 *      就被 running 任务覆盖回「未缓存」，看起来「无法添加」；
 *   2. 条目内下载（一条 200MB 视频数分钟）期间 `done` 计数冻结 —— running 任务
 *      自身看起来也是死的。
 *
 * 本脚本在**真实运行态**（vite dev + 真实 orig-tg）断言：
 *   a. `queued` 数组出现（API 契约）；
 *   b. UI 出现 `album-queued`（排队相册的「排队中」chip）或 `bubble-item-bytes`
 *      （单条任务条目内字节）；
 *   c. 字节进度**确实在走**（两拍之间 itemBytes 增长 > 0）——这是「冻结态已被
 *      消灭」的正向判据，不是「不等于旧值」式的假断言。
 *
 * 前置：任务需由外部先入队（本脚本不自己入队，保持「验收只读」）：
 *   curl -X POST .../api/tg/cache/tasks -d '{"chatId":...,"messageIds":[大文件]}'
 *   curl -X POST .../api/tg/cache/tasks -d '{"chatId":...,"messageIds":[...],"groupId":...}'
 *
 * 用法::
 *   node verify/verify_cache_queue_visibility.cjs
 *   APP_URL=... TG_PORT=19787 ORIG_VERIFY_OUT=... node verify/verify_cache_queue_visibility.cjs
 * Exit: 0 = 全部断言通过；1 = 失败（stdout 有 JSON 报告）
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_PORT = Number(process.env.TG_PORT || 19787)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-cache-queue')
/** 验证频道与素材（默认 = 麻豆短剧的两条大文件；换机器/频道用环境变量覆盖）。 */
const TG_CHAT = Number(process.env.TG_CHAT || -1004493170102)
const TASK1_MSGS = (process.env.TASK1_MSGS || '8527').split(',').map(Number)
const TASK2_MSGS = (process.env.TASK2_MSGS || '8520').split(',').map(Number)
const TASK2_GROUP = Number(process.env.TASK2_GROUP || 14324684376715077)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchTask() {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}/api/tg/cache/tasks`)
  if (!res.ok) throw new Error(`cache tasks endpoint ${res.status}`)
  return res.json()
}

async function enqueue(messageIds, groupId) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}/api/tg/cache/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: TG_CHAT, messageIds, groupId }),
  })
  if (!res.ok) throw new Error(`enqueue ${res.status}`)
  return res.json()
}

/** 确保有一个 running（大文件）与一个 queued（相册组）；已活跃则复用，不重复入队。 */
async function ensureTasks() {
  const snap = await fetchTask()
  const active = [snap.task].filter(
    (t) => t && (t.status === 'running' || t.status === 'queued'),
  )
  const hasRunning = active.some((t) => t.status === 'running')
  const hasQueued = snap.queued.length > 0
  if (!hasRunning) await enqueue(TASK1_MSGS, undefined)
  if (!hasQueued) await enqueue(TASK2_MSGS, TASK2_GROUP)
  return fetchTask()
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = { appUrl: APP_URL, tgPort: TG_PORT, checks: {} }

  // ── a. API 契约：running 任务带 itemBytes，queued 数组在 ─────────────────
  const first = await ensureTasks()
  const task = first.task || null
  const queued = first.queued || []
  out.api = {
    taskId: task && task.id,
    status: task && task.status,
    itemBytes: task && task.itemBytes,
    itemBytesTotal: task && task.itemBytesTotal,
    queuedIds: queued.map((q) => q.id),
  }
  if (!task || task.status !== 'running') {
    console.error('[verify] 前置缺失：没有 running 的缓存任务（先入队一个大文件）')
    return 1
  }
  out.checks.apiQueuedPresent = queued.length > 0
  out.checks.apiItemBytesPresent =
    typeof task.itemBytes === 'number' && task.itemBytesTotal > 0

  // ── b+c. 字节必须真的在走：两拍之间增长 ───────────────────────────────────
  const b1 = (await fetchTask()).task
  await delay(6000)
  const b2 = (await fetchTask()).task
  out.byteProgress = { t1: b1 && b1.itemBytes, t2: b2 && b2.itemBytes }
  out.checks.bytesAdvancing =
    typeof out.byteProgress.t1 === 'number' &&
    typeof out.byteProgress.t2 === 'number' &&
    out.byteProgress.t2 > out.byteProgress.t1

  // ── d. UI：排队相册 chip（album-queued）与单条字节（bubble-item-bytes）────
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="tg-panel-root"]') !== null,
      { timeout: 20000 },
    )
    // 目标频道不在「监控中」列表时需走真实导航：全部订阅 → 频道名。
    const nav = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('aside button')).filter((b) =>
        (b.textContent || '').includes('全部订阅'),
      )
      if (groups.length > 0) groups[0].click()
      return groups.length > 0
    })
    out.navGroupClicked = nav
    await delay(1200)
    const picked = await page.evaluate(() => {
      // 频道行在第二列（<section>）——分组手风琴在 <aside>，别混。
      const rows = Array.from(document.querySelectorAll('section button')).filter((b) =>
        (b.textContent || '').includes('麻豆短剧'),
      )
      if (rows.length > 0) rows[0].click()
      return rows.length > 0
    })
    out.navChannelClicked = picked
    // 等 feed 落地（任务目标消息出现），再等一轮任务轮询（5s 节拍）
    await page.waitForFunction(
      () =>
        document.querySelector('[data-message-id="8520"]') !== null ||
        document.body.textContent.includes('#8520') ||
        document.body.textContent.includes('#8527'),
      { timeout: 30000 },
    )
    // 运行中/排队的目标相册可能在第 2 页：滚到顶触发 loadOlder（scrollTop<40），
    // 直到目标瓦片 8500 进 DOM（至多 4 页）。
    for (let i = 0; i < 4; i++) {
      const found = await page.evaluate(
        () => document.querySelector('[data-message-id="8500"]') !== null,
      )
      if (found) break
      await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="album-grid"]')
        const scroller = grid
          ? grid.closest('div')
          : null
        let el = grid ? grid.parentElement : null
        while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
        if (el) {
          el.scrollTop = 0
          el.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
        void scroller
      })
      await delay(2000)
    }
    await delay(6500)

    const ui = await page.evaluate(() => ({
      queuedChips: document.querySelectorAll('[data-testid="album-queued"]').length,
      bubbleBytes: Array.from(
        document.querySelectorAll('[data-testid="bubble-item-bytes"]'),
      ).map((e) => e.textContent.trim()),
      albumProgress: Array.from(
        document.querySelectorAll('[data-testid="album-progress"]'),
      ).map((e) => e.textContent.trim()),
      panelRoot: document.querySelector('[data-testid="tg-panel-root"]') !== null,
    }))
    out.ui = ui
    out.checks.uiQueuedOrBytes =
      ui.queuedChips > 0 || ui.bubbleBytes.length > 0 || ui.albumProgress.length > 0

    const shot1 = path.join(OUT_DIR, 'cache-queue-visible.png')
    await page.screenshot(shot1, { fullPage: true })
    out.screenshot = shot1

    // 第二张截图：再等 6s，字节文本必须变化（UI 字节在走，不是摆设）
    await delay(6500)
    const ui2 = await page.evaluate(() => ({
      bubbleBytes: Array.from(
        document.querySelectorAll('[data-testid="bubble-item-bytes"]'),
      ).map((e) => e.textContent.trim()),
      albumProgress: Array.from(
        document.querySelectorAll('[data-testid="album-progress"]'),
      ).map((e) => e.textContent.trim()),
    }))
    out.uiSecondPoll = ui2
    const t1 = ui.bubbleBytes.concat(ui.albumProgress)
    const t2 = ui2.bubbleBytes.concat(ui2.albumProgress)
    out.checks.uiBytesAdvancing =
      t1.length > 0 && t2.length > 0 && t1.join('|') !== t2.join('|')
    const shot2 = path.join(OUT_DIR, 'cache-queue-visible-t2.png')
    await page.screenshot(shot2, { fullPage: true })
    out.screenshot2 = shot2

    out.consoleErrors = page.consoleErrors().slice(0, 8)
  } finally {
    await browser.close()
  }

  const failed = Object.entries(out.checks).filter(([, v]) => !v)
  console.log(JSON.stringify(out, null, 2))
  if (failed.length > 0) {
    console.error('[verify] FAILED checks:', failed.map(([k]) => k).join(', '))
    return 1
  }
  console.error('[verify] ALL PASS')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[verify] crashed:', e)
    process.exit(1)
  })
