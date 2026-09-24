#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for **BUG-160**: a 10-member TG album must render 10 tiles.
 *
 * 缺陷：`ALBUM_MAX_TILES = 9` < TG 相册平台上限 10，被 `TgPanel` 的
 * `items.slice(0, ALBUM_MAX_TILES)` 消费 → 10 成员相册只渲染 9 个瓦片，第 10 个被
 * 折进 `+N`。修成 10 后 `albumGridCols(10)=3` → 3+3+3+1。
 *
 * 为什么必须在真实浏览器里断言：`ALBUM_MAX_TILES` 是模块常量，单测里重写一份
 * `slice` 再断言，无论页面上怎么传都会通过 —— 那是测「我以为的代码」。
 * 这里数的是 DOM 上真渲染出来的瓦片，地面真值（成员数/消息号）来自后端
 * `/api/tg/monitor/messages`，与前端组件无关。
 *
 * 反向证伪（验牙）：把 `ALBUM_MAX_TILES` 改回 9 时必须**变红**
 * （9 瓦片 + 折叠标记 `+1`），恢复 10 后必须**变绿**。
 * 用 `ORIG_VERIFY_EXPECT_FOLD=1` 表达「本轮的期望是折叠态」，这样同一支脚本
 * 既能证明绿、也能证明红 —— 一个恒绿的断言是**不能用**来证明它在验牙的。
 *
 * Usage:
 *   APP_URL=http://127.0.0.1:5180/ ORIG_TG_API=http://127.0.0.1:19878 \
 *     node verify/verify_tg_album10_tiles.cjs                 # 期望 10 瓦片、无折叠
 *   ORIG_VERIFY_EXPECT_FOLD=1 ... node verify/verify_tg_album10_tiles.cjs   # 期望 9 瓦片 + 折叠（验牙）
 *
 * Exit codes: 0 = 全部断言通过, 1 = 断言失败, 2 = 环境/通道问题。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = process.env.ORIG_TG_API || 'http://127.0.0.1:9877'
/** 产物目录：默认 orig-hub/verify_shots（ignored，AGENTS.md §6）。 */
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, '..', '..', 'verify_shots')
/** 期望折叠态（验牙用：ALBUM_MAX_TILES 被临时改回 9 时置 1）。 */
const EXPECT_FOLD = process.env.ORIG_VERIFY_EXPECT_FOLD === '1'
/** 10 成员相册频道 / 3 成员相册频道（回归对照）。 */
const ALBUM10 = { id: -1009876543211, title: 'Mock Album (10)', groupId: 9002, members: 10 }
const ALBUM3 = { id: -1009876543210, title: 'Mock Channel', groupId: 9001, members: 3 }

const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
const UI_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_UI_TIMEOUT || 25000)
const BENIGN_CONSOLE = [/favicon/i, /DevTools/i, /9876/i, /ERR_CONNECTION_REFUSED/i]
/** 折叠标记的形状：瓦片上那个 `+N` 角标。 */
const FOLD_RE = /^\+\d+$/

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}
function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` -- ${r.detail || 'n/a'}`}`)
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:album10] ${results.length - failed}/${results.length} assertions passed`)
}
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const shellRoot = path.resolve(__dirname, '..')
  if (resolved === shellRoot || resolved.startsWith(shellRoot + path.sep)) {
    throw new Error(`Refusing to write artifacts inside tauri-shell (${resolved}).`)
  }
}
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let done = false
    const finish = ok => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false
    const finish = v => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => {
        body += c
      })
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null)
        try {
          finish(JSON.parse(body))
        } catch (_e) {
          finish(null)
        }
      })
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
  })
}
async function clickTestId(page, testid) {
  return Boolean(
    await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return false
      el.click()
      return true
    }, testid),
  )
}
async function waitForTestId(page, testid, timeoutMs = UI_TIMEOUT_MS) {
  await page.waitForFunction(id => Boolean(document.querySelector(`[data-testid="${id}"]`)), {
    timeout: timeoutMs,
    intervalMs: 200,
    args: [testid],
  })
}
/** 点文本等于/包含 text 的元素（TreeWalker 走文本节点再点其父元素）。 */
async function clickContainingText(page, text) {
  return Boolean(
    await page.evaluate(txt => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let exact = null
      let partial = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = (n.textContent || '').trim()
        if (!v) continue
        if (v === txt) {
          exact = n
          break
        }
        if (!partial && v.includes(txt)) partial = n
      }
      const t = exact || partial
      if (!t || !t.parentElement) return false
      t.parentElement.click()
      return true
    }, text),
  )
}
/** 读宫格：瓦片数 + 每个瓦片的 messageId + 是否出现折叠角标。
 * 注意：`page.evaluate` 的函数是**序列化后**在页面里跑的，外层作用域的常量（如
 * `FOLD_RE`）到不了页面里，正则必须写在函数体内部。 */
function readGrid() {
  const foldRe = /^\+\d+$/
  const tiles = Array.from(document.querySelectorAll('[data-testid^="tg-album-tile-"]'))
  const ids = tiles.map(t => Number(t.getAttribute('data-message-id') || 0))
  // 折叠角标是瓦片**内部**的一个 span（覆盖层）。必须按元素自身的 textContent 判，
  // 不能用瓦片的整体 innerText —— 那会把时长/下载角标和 `+1` 粘成一串，永远匹配不上。
  const foldSpans = Array.from(
    document.querySelectorAll('[data-testid^="tg-album-tile-"] span'),
  ).filter(s => foldRe.test((s.textContent || '').trim()))
  return {
    tiles: tiles.length,
    ids,
    hasFold: foldSpans.length > 0,
    foldText: foldSpans.length ? String(foldSpans[0].textContent || '').trim() : null,
  }
}

async function openChannel(page, title) {
  await page.goto(APP_URL, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS, settleMs: 1500, waitForRoot: false })
  await waitForTestId(page, 'nav-tg', 15000)
  await clickTestId(page, 'nav-tg')
  await waitForTestId(page, 'tg-panel-root', UI_TIMEOUT_MS)
  try {
    await page.waitForFunction(t => Boolean(document.body && document.body.innerText.includes(t)), {
      timeout: UI_TIMEOUT_MS,
      intervalMs: 200,
      args: [title],
    })
  } catch (_e) {
    /* 由断言如实报告 */
  }
  const opened = await clickContainingText(page, title)
  await waitForTestId(page, 'album-grid', UI_TIMEOUT_MS)
  return opened
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  console.log(`[verify:album10] app=${APP_URL} tg=${TG_API} out=${OUT_DIR} expectFold=${EXPECT_FOLD}`)

  const app = new URL(APP_URL)
  const appPort = Number(app.port || (app.protocol === 'https:' ? 443 : 80))
  if (!(await tcpProbe(app.hostname, appPort))) {
    console.error(`[verify:album10] dev server unreachable: ${app.host}`)
    return 2
  }
  const tg = new URL(TG_API)
  if (!(await tcpProbe(tg.hostname, Number(tg.port || 80)))) {
    console.error(`[verify:album10] orig-tg unreachable: ${tg.host}`)
    return 2
  }

  // 地面真值：后端消息（与前端组件无关）
  const truth = {}
  for (const ch of [ALBUM10, ALBUM3]) {
    const msgs = await httpGetJson(`${TG_API}/api/tg/monitor/messages?channelId=${ch.id}&limit=50`)
    const items = (msgs && Array.isArray(msgs.items) ? msgs.items : []) || []
    const members = items.filter(m => Number(m.groupId) === ch.groupId)
    truth[ch.id] = { items, members, memberIds: members.map(m => Number(m.messageId)).sort((a, b) => a - b) }
    console.log(`[verify:album10] backend ch=${ch.id} items=${items.length} group=${ch.groupId} members=${members.length}`)
    check(
      `后端夹具：频道 ${ch.id} 有 ${ch.members} 个 groupId=${ch.groupId} 成员（前置）`,
      members.length === ch.members,
      `members=${members.length}`,
    )
  }

  const browser = await cdp.launch()
  console.log(`[verify:album10] browser: ${browser.executable} (port ${browser.port})`)
  try {
    const page = await browser.newPage()

    // ── 主用例：10 成员相册 ──
    const opened = await openChannel(page, ALBUM10.title)
    check(`打开「${ALBUM10.title}」频道`, opened)
    await page.screenshot(path.join(OUT_DIR, `album10-${EXPECT_FOLD ? 'falsify' : 'fixed'}.png`))
    const grid = await page.evaluate(readGrid)
    console.log(`[verify:album10] DOM grid=${JSON.stringify(grid)}`)

    if (EXPECT_FOLD) {
      // 验牙：ALBUM_MAX_TILES 被改回 9 时的期望（必须红）
      check('★[验牙] 折叠态：瓦片数 = 9（修复前行为）', grid.tiles === 9, `tiles=${grid.tiles}`)
      check('★[验牙] 折叠态：出现 `+N` 折叠角标', grid.hasFold, `foldText=${grid.foldText}`)
      check('★[验牙] 折叠态：瓦片数 != 后端成员数（断言确实会红）', grid.tiles !== truth[ALBUM10.id].members.length, `dom=${grid.tiles} backend=${truth[ALBUM10.id].members.length}`)
    } else {
      check(
        `★ 10 成员相册渲染出 ${ALBUM10.members} 个瓦片（tileCount === albumMembers）`,
        grid.tiles === ALBUM10.members && grid.tiles === truth[ALBUM10.id].members.length,
        `dom=${grid.tiles} backend=${truth[ALBUM10.id].members.length}`,
      )
      const missing = []
      for (let i = 0; i < ALBUM10.members; i++) {
        const ok = await page.evaluate(
          id => Boolean(document.querySelector(`[data-testid="${id}"]`)),
          `tg-album-tile-${i}`,
        )
        if (!ok) missing.push(i)
      }
      check('★ tg-album-tile-0..9 全部存在', missing.length === 0, `missing=${JSON.stringify(missing)}`)
      check(
        '★ 瓦片 messageId 集合与后端成员逐一对应',
        JSON.stringify([...grid.ids].sort((a, b) => a - b)) === JSON.stringify(truth[ALBUM10.id].memberIds),
        `dom=${JSON.stringify([...grid.ids].sort((a, b) => a - b))} backend=${JSON.stringify(truth[ALBUM10.id].memberIds)}`,
      )
      check('★ 10 成员时**不得**出现 `+N` 折叠角标（上限=10，无溢出）', !grid.hasFold, `foldText=${grid.foldText}`)
    }

    // ── 回归对照：原频道仍是 3 瓦片 ──
    const opened3 = await openChannel(page, ALBUM3.title)
    check(`打开回归频道「${ALBUM3.title}」`, opened3)
    await page.screenshot(path.join(OUT_DIR, 'album3-regression.png'))
    const grid3 = await page.evaluate(readGrid)
    console.log(`[verify:album10] regression grid=${JSON.stringify(grid3)}`)
    check(
      `回归：原频道仍为 ${ALBUM3.members} 个瓦片（不多不少）`,
      grid3.tiles === ALBUM3.members,
      `dom=${grid3.tiles} backend=${truth[ALBUM3.id].members.length}`,
    )
    check('回归：原频道无折叠角标', !grid3.hasFold, `foldText=${grid3.foldText}`)

    // ── 运行时健康 ──
    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
    const realConsole = page.consoleErrors().filter(m => !BENIGN_CONSOLE.some(re => re.test(m)))
    check('无 console error（忽略 favicon / 未起的 daemon 9876）', realConsole.length === 0, JSON.stringify(realConsole.slice(0, 3)))

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.writeFileSync(
      path.join(OUT_DIR, `album10-result-${stamp}.json`),
      JSON.stringify(
        { appUrl: APP_URL, tgApi: TG_API, expectFold: EXPECT_FOLD, grid, grid3, truth: Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, { members: v.members.length, memberIds: v.memberIds }])), results },
        null,
        2,
      ),
      'utf8',
    )
    const failed = results.filter(r => !r.ok)
    console.log('')
    console.log(`[verify:album10] ${results.length - failed.length}/${results.length} assertions passed`)
    if (failed.length) {
      console.log('--- FAILURES ---')
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail || 'n/a'}`)
      console.log('[verify:album10] RESULT: FAIL')
      return 1
    }
    console.log('[verify:album10] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:album10] ERROR: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    process.exit(2)
  })
