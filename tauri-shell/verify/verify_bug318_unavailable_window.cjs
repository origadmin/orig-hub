'use strict'

/**
 * BUG-318 —— 下载域「数据丢失」的活栈实验：**orig-tg 不可用窗口**。
 *
 * 用户报（2026-10-15）：「全部下载 好像有点问题,数据经常丢失,……」
 *
 * 实证路径（全部真实栈，无 mock）：
 *   1. 打开下载页，记录入库行数与首行 key（last-known 基线）；
 *   2. **杀 orig-tg 并占住 19787**（daemon 的 tg_supervise 拉起的进程绑不上端口，
 *      制造一个受控的「orig-tg 不可用」窗口 —— 自然重启只有 ~1s，抓不到）；
 *   3. 窗口内必须发生（BUG-318 修复后的正确行为）：
 *        - daemon `/api/activity` 仍恒 200，但 `sources.cache.available=false`；
 *        - UI 出现「TG 入库任务暂时无法读取」banner（取不到 ≠ 没有）；
 *        - **行不消失**（last-known 快照保留）—— 旧行为是整页变「暂无传输任务」；
 *   4. 释放端口 ⇒ orig-tg 被监督重新拉起 ⇒ **不手动刷新**，banner 必须自动消失、
 *      行数恢复（未知态续轮的回报）。
 *
 * 反向证伪（验牙）由调用方执行：把 `useIngestGroups` 的 sources 读取临时还原成
 * 旧行为（只读 tasks），本脚本第 3 步的 banner/行保留断言必须转红。
 *
 * 用法：node tauri-shell/verify/verify_bug318_unavailable_window.cjs
 *   （需 vite :5180 + orig-daemon :19786 + orig-tg :19787 在跑；
 *     产物落 verify_shots/bug318-unavailable-window/）
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT =
  process.env.ORIG_SHOT_OUT ||
  path.resolve(ROOT, 'verify_shots', 'bug318-unavailable-window')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
/**
 * orig-tg 端口**运行时解析**（BUG-178 纪律）：19787 绑不上时 orig-tg 会顺延
 * （实验里的端口占用/释放就会触发），硬编码 19787 会杀错/占错端口。
 * `VERIFY_TG_PORT` 仍可显式覆盖。在 main() 开头赋值（.cjs 无顶层 await）。
 */
let TG_PORT = 19787

const T = {
  navDownload: 'nav-download',
  sourceFilter: 'dl-source-filter',
  row: 'ingest-group-row',
  tgDown: 'dl-tg-unavailable',
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 页面内 helper（每次导航后重新注入；testid 以参数传入）。 */
const installHelpers = (page) =>
  page.evaluate(
    (rowSel, downSel) => {
      const w = window
      w.__rows = () =>
        Array.from(document.querySelectorAll(rowSel)).map((el) => ({
          key: el.getAttribute('data-key') || '',
          status: el.getAttribute('data-status') || '',
        }))
      w.__click = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return false
        el.click()
        return true
      }
      w.__exists = (sel) => !!document.querySelector(sel)
      w.__downText = () => {
        const el = document.querySelector(downSel)
        return el ? (el.textContent || '').trim() : ''
      }
    },
    `[data-testid="${T.row}"]`,
    `[data-testid="${T.tgDown}"]`,
  )

/** 19787 当前 LISTENING 的 PID（orig-tg 真身）。 */
function tgPid() {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    if (!new RegExp(`:${TG_PORT} `).test(line)) continue
    const pid = Number(line.trim().split(/\s+/).pop())
    if (Number.isFinite(pid) && pid > 0) return pid
  }
  return null
}

/** 杀掉 orig-tg 并占住端口，制造受控不可用窗口。返回释放函数。
 *
 *  两个坑（都实测踩过）：
 *  1. `server.close()` 的回调要等**所有已接受连接**关闭才触发 —— 窗口内 daemon
 *     每 5s 来轮询一次，连接进来没人关，close 回调永远不触发 ⇒ 脚本挂死。
 *     故连接进来即 `destroy()`（daemon 侧拿到的就是「连不上」，正是要模拟的），
 *     释放时再兜底 1s 超时。
 *  2. 必须先杀后占：占着端口时 orig-tg（daemon 的 tg_supervise 会反复重拉）
 *     绑不上 19787，才能形成持续窗口。
 */
async function openUnavailableWindow() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pid = tgPid()
    if (pid == null) throw new Error(`port ${TG_PORT} has no listener (orig-tg not running?)`)
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } catch {
      // 可能刚好被 daemon 重启掉（pid 易手）—— 重读重试
    }
    const srv = await new Promise((resolve) => {
      const s = net.createServer()
      // 连接即拒：不积压任何 socket，close() 才能立刻回调
      s.on('connection', (c) => c.destroy())
      s.once('error', () => resolve(null))
      s.listen(TG_PORT, '127.0.0.1', () => resolve(s))
    })
    if (srv) {
      return () =>
        new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (!done) {
              done = true
              resolve()
            }
          }
          srv.close(finish)
          setTimeout(finish, 1000) // 兜底：绝不因为 close 回调挂死整个脚本
        })
    }
  }
  throw new Error('could not hold the orig-tg port (lost the race 3 times)')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 端口运行时解析（BUG-178）：顺延后以 daemon /api/config 的 tg_port 为真源
  if (process.env.VERIFY_TG_PORT) {
    TG_PORT = Number(process.env.VERIFY_TG_PORT)
  } else {
    try {
      const cfg = await (await fetch(`${DAEMON}/api/config`)).json()
      TG_PORT = Number(cfg.tg_port || 19787)
    } catch {
      TG_PORT = 19787
    }
  }
  console.log(`[setup] orig-tg port resolved: ${TG_PORT}`)

  // 窗口前的 daemon 侧真相（对照用）
  const before = await (await fetch(`${DAEMON}/api/activity?scope=all`)).json()
  const beforeCache = before.sources.find((s) => s.kind === 'cache')
  check(
    '前置：窗口前 cache 来源 available=true',
    beforeCache && beforeCache.available === true,
    `count=${beforeCache && beforeCache.count}`,
  )

  const browser = await cdp.launch()
  let release = null
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    await installHelpers(page)

    await page.evaluate((sel) => window.__click(sel), `[data-testid="${T.navDownload}"]`)
    await page.waitForFunction((sel) => window.__exists(sel), {
      args: [`[data-testid="${T.sourceFilter}"]`],
      timeout: 10000,
    })
    await page.waitForFunction(() => window.__rows().length > 0, { timeout: 14000 })
    const base = await page.evaluate(() => window.__rows())
    check(
      `前置：下载页入库行已渲染（last-known 基线 ${base.length} 行）`,
      base.length > 0,
      `rows=${base.length} firstKey=${base[0] && base[0].key}`,
    )

    // ── 制造受控不可用窗口 ────────────────────────────────────────────
    release = await openUnavailableWindow()

    // 窗口内 daemon 侧真相：恒 200 + cache available=false + count=0
    let duringCache = null
    for (let i = 0; i < 10; i += 1) {
      const snap = await (await fetch(`${DAEMON}/api/activity?scope=all`)).json()
      duringCache = snap.sources.find((s) => s.kind === 'cache')
      if (duringCache && duringCache.available === false) break
      await sleep(500)
    }
    check(
      '窗口内 daemon：/api/activity 恒 200 且 sources.cache.available=false（取不到 ≠ 没有）',
      duringCache && duringCache.available === false,
      `available=${duringCache && duringCache.available} count=${duringCache && duringCache.count} error=${duringCache && duringCache.error}`,
    )

    // UI 侧：banner 必须出现（前端轮询 3s 一拍，窗口 ≥ 数拍）
    let banner = false
    try {
      await page.waitForFunction((sel) => window.__exists(sel), {
        args: [`[data-testid="${T.tgDown}"]`],
        timeout: 15000,
      })
      banner = true
    } catch {
      banner = false
    }
    const downText = banner ? await page.evaluate(() => window.__downText()) : ''
    check(
      'UI：窗口内出现「TG 入库任务暂时无法读取」banner（旧行为：静默空列表）',
      banner && downText.length > 0,
      `text=${downText.slice(0, 120)}`,
    )

    // 行必须保留（last-known 快照）—— 旧行为是整页「暂无传输任务」
    const during = await page.evaluate(() => window.__rows())
    const kept =
      during.length === base.length &&
      base.every((b, i) => during[i] && during[i].key === b.key)
    check(
      `UI：窗口内入库行不消失（last-known ${base.length} 行原样保留）`,
      kept,
      `before=${base.length} during=${during.length}`,
    )
    await page.screenshot(path.join(OUT, '01-unavailable-window.png'))

    // ── 释放端口 ⇒ 监督重启 orig-tg ⇒ 不手动刷新必须自动回血 ──────────
    await release()
    release = null

    let recovered = false
    try {
      await page.waitForFunction((sel) => !window.__exists(sel), {
        args: [`[data-testid="${T.tgDown}"]`],
        timeout: 60000,
      })
      recovered = true
    } catch {
      recovered = false
    }
    check(
      'UI：释放端口后 banner 自动消失（未知态续轮 ⇒ 无需手动刷新即回血）',
      recovered,
    )
    const after = await page.evaluate(() => window.__rows())
    check(
      `UI：回血后入库行数恢复（${base.length}）`,
      after.length === base.length,
      `after=${after.length}`,
    )
    await page.screenshot(path.join(OUT, '02-recovered.png'))

    const errs = page.pageErrors()
    check('UI：运行期无未捕获页面异常', errs.length === 0, errs.join(' | '))
  } finally {
    if (release) await release()
    await browser.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — evidence: ${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
