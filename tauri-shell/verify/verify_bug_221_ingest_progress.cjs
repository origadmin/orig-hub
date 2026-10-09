#!/usr/bin/env node
'use strict'

/**
 * BUG-221 UI 层验收：入库流水线「看得到进度、分得出在下载/卡死/已恢复」。
 *
 * ## 判据（三条，全部为真值断言 —— 禁 always-green）
 *
 *   ① 字节百分比：`cache-task-bytes-pct` 存在，值是**具体数字**，且随两次采样
 *      **单调增长**（打印前后值）。同时断言该值 > 0：本 BUG 的病态就是
 *      `done/total = 0/1` 恒 0%，旧实现在这里必然拿不到 >0 的百分比。
 *   ② 速度：`cache-task-speed` 是具体速率串（形如 `1.2 MB/s`），打印字符串；
 *      不是 `—`，不是空。
 *   ③ 停滞成对：字节不再推进时 `cache-task-stalled` **出现**（且文案含 ≥15 的秒数），
 *      恢复推进后**消失**。
 *
 * ## 数据源：受控 stub（诚实说明覆盖范围）
 *
 * 本脚本在**页面里拦截 `window.fetch`**，让 `/api/tg/cache/tasks/all` 返回一个
 * 受控的合成任务（字节按拍推进 / 冻结），其余请求原样放行。
 *
 *   - 覆盖：**前端派生层** —— 字节优先百分比、速度、剩余时间、停滞判据、
 *     恢复即消失。这四件事全是前端从 `progressBytes/progressAt` 派生的，
 *     用受控数据源能确定性地构造「推进 / 停滞 / 恢复」三态（真实 TG 下载
 *     无法按需卡死，也无法按需恢复）。
 *   - 不覆盖：后端注入本身。`progressBytes/progressAt/progressBytesTotal`
 *     是否真的随下载推进，由 `cargo test -p orig-tg` 的
 *     `progress_heartbeat_is_injected_while_bytes_advance` /
 *     `progress_bytes_survive_unknown_total` /
 *     `progress_heartbeat_is_not_injected_for_queued_task` 三条例证。
 *     真实 TG 大文件下载链路**本脚本不作证**。
 *
 * ## 反空跑（没有这些，三条判据会因「面板压根没渲染」而恒绿）
 *
 *   - 任务行存在且 `data-status="running"`；
 *   - stub 真的被消费过（`feed.calls > 0`）；
 *   - 全程 `pageErrors` 为 0。
 *
 * 用法：先起开发态服务（vite dev 5180 + daemon），再
 *   node verify_bug_221_ingest_progress.cjs
 * 可调：`APP_PORT`（默认 5180）、`ORIG_VERIFY_OUT`（默认系统临时目录，不入库）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`

/** 面板轮询节拍（CacheManagerDialog 活跃时 5s）与判据等待上限。 */
const POLL_MS = 5000
const WAIT_MS = 30000

/** 合成任务的总量（200MB）与每拍推进步长：足够让两拍之间算出非零速率。 */
const FEED_TOTAL = 200 * 1024 * 1024
const FEED_STEP = 12 * 1024 * 1024

/** 停滞模式下的心跳年龄（>15s 阈值）。 */
const STALL_AGE_MS = 20000

const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug-221'),
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

/** 读行内四个读数（+ 反空跑用的行状态）。只看 running 那一行（合成数据里有两行）。 */
function readRow(page) {
  return page.evaluate(() => {
    const txt = (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      return el ? String(el.textContent || '').trim() : null
    }
    const rowEl = document.querySelector('[data-testid="cache-task-row"][data-status="running"]')
    const raw = txt('cache-task-bytes-pct')
    const num = raw === null ? null : Number(String(raw).replace('%', ''))
    return {
      rows: document.querySelectorAll('[data-testid="cache-task-row"]').length,
      status: rowEl ? rowEl.getAttribute('data-status') : null,
      pctRaw: raw,
      pctNum: Number.isFinite(num) ? num : null,
      bytes: txt('cache-task-bytes'),
      speed: txt('cache-task-speed'),
      eta: txt('cache-task-eta'),
      stalled: txt('cache-task-stalled'),
      preparing: txt('cache-task-preparing'),
      feedCalls: window.__bug221Feed ? window.__bug221Feed.calls : -1,
      feedBytes: window.__bug221Feed ? window.__bug221Feed.bytes : -1,
    }
  })
}

/**
 * BUG-220 回退判据用：读两行的标题（行首 `span.truncate` 的内容）。
 *
 * - `titled` = running 行（合成数据给了 `title`）：必须**原样**以它开头，且不得被 `#` 污染；
 * - `untitled` = done 行（`title: null`、`messageIds: [1234]`）：必须带上 `#1234`
 *   且**不等于**纯频道名。
 */
function readTitles(page) {
  return page.evaluate(() => {
    const titleOf = (status) => {
      const row = document.querySelector(`[data-testid="cache-task-row"][data-status="${status}"]`)
      const span = row ? row.querySelector('span.truncate') : null
      return span ? String(span.textContent || '').replace(/\s+/g, ' ').trim() : null
    }
    return { titled: titleOf('running'), untitled: titleOf('done') }
  })
}

/** 切数据源模式：`grow` = 字节推进；`stall` = 字节冻结且心跳停在 20s 前。 */
function setFeedMode(page, mode) {
  return page.evaluate((m) => {
    if (window.__bug221Feed) window.__bug221Feed.mode = m
    return Boolean(window.__bug221Feed)
  }, mode)
}

/**
 * 注入受控数据源：只拦 `/api/tg/cache/tasks/all`，其余请求原样放行。
 *
 * 之所以在**页面里**拦而不是起 mock server：面板走的是 `window.fetch` 到
 * orig-tg 的真实端口，改端口/起服务都牵动别处；这里只替换这一个读端点，
 * 面板的轮询、等值短路、memo 行渲染全都是真实代码路径。
 */
async function installFeed(page) {
  return page.evaluate(
    (total, step, stallAge) => {
      const FEED = {
        calls: 0,
        bytes: 0,
        total: total,
        step: step,
        stallAge: stallAge,
        mode: 'grow',
      }
      window.__bug221Feed = FEED
      const orig = window.fetch.bind(window)
      window.fetch = function patched(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (!String(url).includes('/api/tg/cache/tasks/all')) return orig(input, init)
        FEED.calls++
        if (FEED.mode === 'grow') {
          FEED.bytes = Math.min(FEED.total, FEED.bytes + FEED.step)
        }
        const now = Date.now()
        // 停滞模式：字节冻结 + 心跳停在 stallAge 之前 —— 这就是「卡死」的可观测形态。
        const at = FEED.mode === 'stall' ? now - FEED.stallAge : now
        const task = {
          id: 99001,
          chatId: -1000000000001,
          itemKey: 'm:-1000000000001:1',
          messageIds: [1],
          // 消息级读数故意是最刁钻的形态：单条任务 total=1、done=0 —— 旧实现在
          // 这里恒 0%，直到下载结束才跳 100%。
          total: 1,
          done: 0,
          status: 'running',
          currentId: 1,
          createdAt: Math.floor(now / 1000) - 60,
          updatedAt: Math.floor(now / 1000) - 60,
          title: 'BUG-221 验收合成任务',
          progressBytes: FEED.bytes,
          progressBytesTotal: FEED.total,
          progressAt: at,
        }
        // BUG-220 回退判据用：**没有 caption**（title 为 null）的任务 —— 老实现
        // 在这里退化成纯频道名，一排同频道的行长得一模一样。
        const untitled = {
          id: 99002,
          chatId: -1000000000001,
          itemKey: 'm:-1000000000001:1234',
          messageIds: [1234],
          total: 1,
          done: 1,
          status: 'done',
          createdAt: Math.floor(now / 1000) - 600,
          updatedAt: Math.floor(now / 1000) - 300,
          title: null,
        }
        const body = JSON.stringify({ tasks: [task, untitled], counts: { running: 1, done: 1 } })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }
      return true
    },
    FEED_TOTAL,
    FEED_STEP,
    STALL_AGE_MS,
  )
}

/** 打开入库流水线面板（TG 视图 → 面板）。 */
async function openPanel(page) {
  const nav = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-tg"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!nav) throw new Error('nav-tg 未找到（TG 视图入口缺失）')
  await delay(1500)
  // 直接置 store（比点上下文栏入口稳：入口在 TG 服务不可达时会整个隐藏），
  // 面板挂载后由它自己的轮询取数。
  const opened = await page.evaluate(() => {
    const s = window.__origStore && window.__origStore.getState()
    if (!s || typeof s.setTgCacheManagerOpen !== 'function') return false
    s.setTgCacheManagerOpen(true)
    return true
  })
  if (!opened) throw new Error('store.setTgCacheManagerOpen 不可用')
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="cache-manager"]'),
    { timeout: WAIT_MS },
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({ headless: false })
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
    console.log('[verify] app ready at', APP_URL)

    await installFeed(page)
    await openPanel(page)

    // ── 反空跑：任务行真的渲染了，且数据源真的被消费了 ──
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="cache-task-row"]')
        return !!el && el.getAttribute('data-status') === 'running'
      },
      { timeout: WAIT_MS },
    )
    const first = await readRow(page)
    console.log('[verify] first row sample:', JSON.stringify(first))
    check('0a: running 任务行已渲染', first.rows >= 1 && first.status === 'running',
      `rows=${first.rows} status=${first.status}`)
    check('0b: 受控数据源被真实消费（面板确实在轮询它）', first.feedCalls > 0,
      `feedCalls=${first.feedCalls} feedBytes=${first.feedBytes}`)

    // ── BUG-220 剩余缺口：无标题行的回退必须可辨认（带消息号）──
    const BARE_CHANNEL = '频道 -1000000000001'
    const MSG_TAG = '#1234'
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="cache-task-row"]').length >= 2,
      { timeout: WAIT_MS },
    )
    const titles = await readTitles(page)
    console.log('[verify] row titles:', JSON.stringify(titles))
    check('5a: 无标题行回退带消息号且不等于纯频道名',
      typeof titles.untitled === 'string' &&
        titles.untitled.includes(MSG_TAG) &&
        !titles.untitled.startsWith(`${BARE_CHANNEL} ·`),
      `untitled=${JSON.stringify(titles.untitled)} 纯频道形态应为 ${JSON.stringify(BARE_CHANNEL + ' · 单条 · 1 条')}`)
    check('5b: 有标题行原样呈现（不被 # 污染）',
      typeof titles.titled === 'string' &&
        titles.titled.startsWith('BUG-221 验收合成任务') &&
        !titles.titled.includes('#'),
      `titled=${JSON.stringify(titles.titled)}`)

    // ── 判据 ①：字节百分比是具体数字，且随采样单调增长 ──
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="cache-task-bytes-pct"]')
        if (!el) return false
        const n = Number(String(el.textContent || '').replace('%', ''))
        return Number.isFinite(n) && n > 0
      },
      { timeout: WAIT_MS },
    )
    const s1 = await readRow(page)
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('[data-testid="cache-task-bytes-pct"]')
        if (!el) return false
        const n = Number(String(el.textContent || '').replace('%', ''))
        return Number.isFinite(n) && n > prev
      },
      { timeout: WAIT_MS, args: [s1.pctNum] },
    )
    const s2 = await readRow(page)
    console.log(`[verify] pct: ${s1.pctRaw} (bytes=${s1.feedBytes}) -> ${s2.pctRaw} (bytes=${s2.feedBytes})`)
    check('1a: cache-task-bytes-pct 是具体数字（非「准备中」/非缺失）',
      s1.pctNum !== null && s2.pctNum !== null,
      `s1=${JSON.stringify(s1.pctRaw)} s2=${JSON.stringify(s2.pctRaw)}`)
    check('1b: 百分比随字节推进单调增长',
      s1.pctNum !== null && s2.pctNum !== null && s2.pctNum > s1.pctNum,
      `${s1.pctNum}% -> ${s2.pctNum}% (+${(s2.pctNum - s1.pctNum).toFixed(2)})`)
    check('1c: 反回归——不再是 done/total 的 0%（单条任务 done=0/1 的病态值）',
      s2.pctNum !== null && s2.pctNum > 0,
      `pct=${s2.pctNum}% (旧实现恒为 0.0%)`)
    check('1d: 字节读数同时给出（总量已知 ⇒ 已收/总量）',
      typeof s2.bytes === 'string' && s2.bytes.includes('/'),
      `bytes=${JSON.stringify(s2.bytes)}`)

    await page.screenshot(path.join(OUT, 'bug221-progress-growing.png'))

    // ── 判据 ②：速度是具体速率串（相邻两拍字节差派生）──
    let speedSample = null
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="cache-task-speed"]')
          if (!el) return false
          const s = String(el.textContent || '').trim()
          return /^\d+(\.\d+)?\s(B|KB|MB|GB)\/s$/.test(s)
        },
        { timeout: WAIT_MS },
      )
    } catch (_err) { /* 交给下面 check 判定 */ }
    speedSample = await readRow(page)
    console.log('[verify] speed sample:', JSON.stringify({
      speed: speedSample.speed, eta: speedSample.eta, pct: speedSample.pctRaw,
    }))
    check('2a: cache-task-speed 是具体速率串（不是「—」/不缺失）',
      typeof speedSample.speed === 'string' && speedSample.speed !== '—' &&
        /^\d+(\.\d+)?\s(B|KB|MB|GB)\/s$/.test(speedSample.speed),
      `speed=${JSON.stringify(speedSample.speed)}`)
    check('2b: 剩余时间同步给出（总量已知 ⇒ 可估）',
      typeof speedSample.eta === 'string' && /\d/.test(String(speedSample.eta)),
      `eta=${JSON.stringify(speedSample.eta)}`)

    // ── 判据 ③：停滞出现 / 恢复消失（成对）──
    await setFeedMode(page, 'stall')
    let stalledSample = null
    try {
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="cache-task-stalled"]'),
        { timeout: WAIT_MS },
      )
    } catch (_err) { /* 交给下面 check 判定 */ }
    stalledSample = await readRow(page)
    const stallSec = stalledSample.stalled ? Number(String(stalledSample.stalled).replace(/\D+/g, '')) : null
    console.log('[verify] stalled sample:', JSON.stringify({
      stalled: stalledSample.stalled, speed: stalledSample.speed, pct: stalledSample.pctRaw,
    }))
    check('3a: 字节不再推进时 cache-task-stalled 出现',
      typeof stalledSample.stalled === 'string' && stalledSample.stalled.length > 0,
      `stalled=${JSON.stringify(stalledSample.stalled)}`)
    check('3b: 停滞文案含具体秒数且 >= 15（阈值判据，非恒真文案）',
      Number.isFinite(stallSec) && stallSec >= 15,
      `n=${stallSec} (阈值 15s，构造年龄 ${STALL_AGE_MS / 1000}s)`)
    check('3c: 停滞时不再谎报速度（旧速率不得继续显示）',
      stalledSample.speed === null,
      `speed=${JSON.stringify(stalledSample.speed)}`)
    await page.screenshot(path.join(OUT, 'bug221-stalled.png'))

    await setFeedMode(page, 'grow')
    let resumed = null
    try {
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="cache-task-stalled"]'),
        { timeout: WAIT_MS },
      )
      resumed = await readRow(page)
    } catch (_err) {
      resumed = await readRow(page)
    }
    console.log('[verify] resumed sample:', JSON.stringify({
      stalled: resumed.stalled, speed: resumed.speed, pct: resumed.pctRaw, bytes: resumed.bytes,
    }))
    check('3d: 恢复推进后 cache-task-stalled 消失（成对断言的另一半）',
      resumed.stalled === null,
      `stalled=${JSON.stringify(resumed.stalled)} pct=${JSON.stringify(resumed.pctRaw)}`)
    await page.screenshot(path.join(OUT, 'bug221-resumed.png'))

    // ── 全程无未捕获异常 ──
    const errs = page.pageErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(errs))
    check('4: no uncaught page errors', errs.length === 0, JSON.stringify(errs))

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] evidence dir: ${OUT}`)
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
