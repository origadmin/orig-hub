#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for BUG-137: the TG panel must hand the built-in viewer a
 * NEIGHBOUR SEQUENCE, not a single item / a single album.
 *
 * 缺陷现场：同一个 `MediaViewer`，从媒体库打开能连播整部剧集（MediaLibraryPanel
 * 会 `loadSeriesDetail` 展开整部再传 `items`），从 TG 面板打开却永远没有
 * 上一条/下一条 —— 三处 `openViewer` 只传 `toViewerItems([item])` 或单个相册单元。
 * 组件内 `group`/`prevItem`/`nextItem` 都是**从 items 派生**的，items 只有一条
 * 时那些点击全部落空。所以这不是播放器缺陷，是**调用方没给序列**。
 *
 * 修复（`src/components/TgPanel.tsx`）：三处入口统一走 `openPlayable`，
 * 序列取「当前流 / 命中集」里的**可播**子集，`index` 按 key 定位到点击项的真实位置：
 *   - 全局搜索命中 → `playableHits`（命中集）
 *   - 单条气泡预览 → `playableFeed`（当前频道流）
 *   - 相册预览     → `playableFeed`（**跨相册**：组内最后一张能翻到相邻单元）
 *
 * 为什么必须在真实浏览器里断言：
 *   序列是 React 里的派生值，DOM 上只看得到「‹ › 在不在」与「第 n/总数」。
 * 用单测重写一份 `openPlayable` 再断言，无论页面上怎么传都会通过 —— 那是测
 * 「我以为的代码」，不是测「跑起来的页面」。
 *
 * 非循环的判据（关键）：
 *   「序列长度」不读组件内部状态，而是拿**后端消息列表**当地面真值
 *   （`/api/tg/monitor/messages`：`type !== 'file'` 的条数 = 期望分母），
 *   再与页面上 `viewer-position` 的 `n/total` 交叉核对。分母来自后端，
 *   与 `TgPanel.tsx` 无关。
 *
 * 反向证伪（本项目硬要求，两轮）：
 *   1. **边界**：点相册最后一张（组内第 3 张）后，`›` 必须还在且能走到**下一个单元**
 *      （第 4 条 = 相册外的单发）。修复前序列只有相册那 3 条 → 走到组尾就没了，
 *      这条断言会红。
 *   2. **单条无邻居**：用只命中 1 条内容的关键词做全局搜索并打开，断言
 *      `‹`/`›` **都不出现**（`ORIG_VERIFY_SINGLE_QUERY`）。这条防的是「箭头恒显示」
 *      —— 没有它，一个永远渲染两个箭头的实现也能全绿。
 *
 * Usage:
 *   node verify/verify_tg_viewer_sequence.cjs                  # APP 5180 / orig-tg 9877
 *   APP_URL=http://127.0.0.1:5180/ node verify/verify_tg_viewer_sequence.cjs
 *   ORIG_TG_API=http://127.0.0.1:9877 node verify/verify_tg_viewer_sequence.cjs
 *   ORIG_VERIFY_OUT=<临时目录> node verify/verify_tg_viewer_sequence.cjs
 *   APP_URL=http://127.0.0.1:59999 node verify/verify_tg_viewer_sequence.cjs  # 死端口 → exit 2
 *
 * Exit codes: 0 = 全部断言通过, 1 = 断言失败（页面问题）,
 *             2 = 环境/通道问题（dev server 或 orig-tg 不可达、浏览器起不来）。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

/** 被测页面地址（override 用 APP_URL）。 */
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
/** orig-tg 地址（地面真值：监控消息列表）。 */
const TG_API = process.env.ORIG_TG_API || 'http://127.0.0.1:9877'
/** 产物目录：必须在 tauri-shell 之外（AGENTS.md §6）。 */
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-tg-viewer')
/** 只命中 1 条内容的搜索词（反向证伪 2：单条序列不得给上下条入口）。 */
const SINGLE_QUERY = process.env.ORIG_VERIFY_SINGLE_QUERY || 'Mock single video'
/** 命中多条的搜索词（正向：命中集即邻居序列）。 */
const MULTI_QUERY = process.env.ORIG_VERIFY_MULTI_QUERY || 'Mock'

const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
const UI_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_UI_TIMEOUT || 25000)

/** 环境噪音，不算应用缺陷（favicon / DevTools / 未起的 daemon 9876）。 */
const BENIGN_CONSOLE = [/favicon/i, /DevTools/i, /9876/i, /ERR_CONNECTION_REFUSED/i]

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -- ${item.detail || 'n/a'}`}`)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:tg-viewer] ${results.length - failed}/${results.length} assertions passed`)
}

function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const shellRoot = path.resolve(__dirname, '..')
  if (resolved === shellRoot || resolved.startsWith(shellRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside tauri-shell (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory (AGENTS.md §6).',
    )
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
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
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
        } catch (_err) {
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

/** 点一个 data-testid 元素。 */
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
  await page.waitForFunction(
    id => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    { timeout: timeoutMs, intervalMs: 200, args: [testid] },
  )
}

/** 点第 n 个 data-testid 元素（0-based）。 */
async function clickTestIdAt(page, testid, n) {
  return Boolean(
    await page.evaluate(
      (id, i) => {
        const els = Array.from(document.querySelectorAll(`[data-testid="${id}"]`))
        const el = els[i]
        if (!el) return false
        el.click()
        return true
      },
      testid,
      n,
    ),
  )
}

/**
 * 点文案等于/包含 text 的元素（频道行不是 button/a 而是可点的 div ——
 * 等值匹配落在 button/[role]/a 上会落空，那是验收脚本的定位问题，不是应用缺陷）。
 *
 * 用 **TreeWalker 走文本节点**再点其父元素：不猜标签、不猜层级；事件沿祖先冒泡，
 * React 的 onClick 在祖先上也能触发。优先精确匹配，退而求其次用包含匹配。
 */
async function clickContainingText(page, text) {
  return Boolean(
    await page.evaluate(txt => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let exact = null
      let partial = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = (node.textContent || '').trim()
        if (!value) continue
        if (value === txt) {
          exact = node
          break
        }
        if (!partial && value.includes(txt)) partial = node
      }
      const target = (exact || partial)
      if (!target || !target.parentElement) return false
      target.parentElement.click()
      return true
    }, text),
  )
}

/**
 * 读播放器当前状态：是否打开、当前 messageId、位置文案、‹ › 是否存在。
 *
 * 刻意不读任何 React 内部状态 —— 只读渲染出来的 DOM 与 `data-*` 锚点。
 */
function readViewerState() {
  const viewer = document.querySelector('[data-testid="media-viewer"]')
  if (!viewer) return { open: false }
  const pos = viewer.querySelector('[data-testid="viewer-position"]')
  return {
    open: true,
    messageId: Number(viewer.getAttribute('data-message-id') || 0),
    title: (viewer.querySelector('[data-testid="viewer-title"]') || {}).textContent || '',
    position: pos ? String(pos.textContent || '').trim() : null,
    hasPrev: Boolean(viewer.querySelector('[data-testid="viewer-prev"]')),
    hasNext: Boolean(viewer.querySelector('[data-testid="viewer-next"]')),
  }
}

/** 关掉播放器（点返回），让下一轮从干净状态点开。 */
async function closeViewer(page) {
  await page.evaluate(() => {
    const viewer = document.querySelector('[data-testid="media-viewer"]')
    if (!viewer) return
    const btn = Array.from(viewer.querySelectorAll('button')).find(b =>
      (b.textContent || '').includes('←'),
    )
    if (btn) btn.click()
  })
  try {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="media-viewer"]'),
      { timeout: 10000, intervalMs: 200 },
    )
  } catch (_err) {
    /* 由调用方的断言如实报告 */
  }
}

/** React 受控输入：必须用原生 setter + input 事件，直接赋 value 不会触发 onChange。 */
async function typeInto(page, testid, text) {
  return Boolean(
    await page.evaluate(
      (id, value) => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      testid,
      text,
    ),
  )
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[verify:tg-viewer] app: ${APP_URL}`)
  console.log(`[verify:tg-viewer] orig-tg: ${TG_API}`)
  console.log(`[verify:tg-viewer] artifacts: ${OUT_DIR}`)

  const app = new URL(APP_URL)
  const appPort = Number(app.port || (app.protocol === 'https:' ? 443 : 80))
  if (!(await tcpProbe(app.hostname, appPort))) {
    console.error(`[verify:tg-viewer] dev server unreachable: nothing on ${app.host}`)
    console.error('[verify:tg-viewer] start it with `npm run dev` (vite: 127.0.0.1:5180)')
    dumpResults()
    console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const tg = new URL(TG_API)
  if (!(await tcpProbe(tg.hostname, Number(tg.port || 80)))) {
    console.error(`[verify:tg-viewer] orig-tg unreachable: nothing on ${tg.host}`)
    dumpResults()
    console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
    return 2
  }

  // ---- 地面真值：后端监控消息（与 TgPanel.tsx 无关）----
  const channels = await httpGetJson(`${TG_API}/api/tg/monitor/channels`)
  const list = Array.isArray(channels) ? channels : (channels && channels.items) || []
  const channel = list[0]
  if (!channel || channel.channelId === undefined) {
    console.error('[verify:tg-viewer] no monitored channel: seed one before running')
    dumpResults()
    console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const chatId = channel.channelId
  const msgs = await httpGetJson(
    `${TG_API}/api/tg/monitor/messages?channelId=${encodeURIComponent(String(chatId))}&limit=50`,
  )
  const items = (msgs && Array.isArray(msgs.items) ? msgs.items : []) || []
  // 可播 = `type !== 'file'`（与 `TgPanel.isPlayable` 同判据，但取自后端）
  const playable = items.filter(m => (m.type || 'file') !== 'file')
  const albumMembers = playable.filter(m => m.groupId != null)
  const outsideAlbum = playable.filter(m => m.groupId == null)
  const expectedTotal = playable.length

  console.log(
    `[verify:tg-viewer] backend truth: channel=${chatId} (${channel.title}) ` +
      `items=${items.length} playable=${expectedTotal} album=${albumMembers.length} ` +
      `outsideAlbum=${outsideAlbum.length}`,
  )
  if (expectedTotal < 2 || albumMembers.length < 2 || outsideAlbum.length < 1) {
    console.error(
      '[verify:tg-viewer] fixture too small: need >=2 album members and >=1 message outside the album',
    )
    dumpResults()
    console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
    return 2
  }

  const browser = await cdp.launch()
  console.log(`[verify:tg-viewer] browser: ${browser.executable} (port ${browser.port})`)

  try {
    const page = await browser.newPage()
    try {
      await page.goto(APP_URL, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
        settleMs: 1500,
        waitForRoot: false,
      })
    } catch (err) {
      console.error(`[verify:tg-viewer] navigation failed: ${err && err.message ? err.message : err}`)
      dumpResults()
      console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
      return 2
    }

    // ---------- 进入 TG 面板并打开监控频道 ----------
    try {
      await waitForTestId(page, 'nav-tg', 15000)
    } catch (_err) {
      check('侧栏 [data-testid="nav-tg"] 存在', false, '页面未渲染出 TG 入口（白屏或 TG 服务不可用）')
      fs.writeFileSync(path.join(OUT_DIR, 'dom-no-nav-tg.html'), await page.content(), 'utf8')
      dumpResults()
      console.log('[verify:tg-viewer] RESULT: FAIL (app did not render)')
      return 1
    }
    check('侧栏 [data-testid="nav-tg"] 存在', true)
    await clickTestId(page, 'nav-tg')
    await waitForTestId(page, 'tg-panel-root', UI_TIMEOUT_MS)

    // 频道列表是异步拉取的：先等标题真的渲染出来再找节点点（否则 TreeWalker 找不到，
    // 而页面此时可能已自动选中频道 —— 那会掩盖「点击入口可用性」这条断言）。
    try {
      await page.waitForFunction(
        t => Boolean(document.body && document.body.innerText.includes(t)),
        { timeout: UI_TIMEOUT_MS, intervalMs: 200, args: [String(channel.title)] },
      )
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    const openedChannel = await clickContainingText(page, String(channel.title))
    check(`打开监控频道「${channel.title}」（文案包含匹配）`, openedChannel)
    await waitForTestId(page, 'album-grid', UI_TIMEOUT_MS)
    const tileCount = Number(
      await page.evaluate(
        () => document.querySelectorAll('[data-testid^="tg-album-tile-"]').length,
      ),
    )
    check(
      '相册宫格渲染出相册成员（tg-album-tile-*）',
      tileCount === albumMembers.length,
      `dom=${tileCount} backend_album=${albumMembers.length}`,
    )
    await page.screenshot(path.join(OUT_DIR, '01-tg-feed.png'))

    // ---------- 正向：相册**最后一张**必须能翻到相册之外 ----------
    console.log('')
    console.log('--- 正向：相册最后一张 → 下一条（BUG-137 核心）---')

    const lastTile = albumMembers.length - 1
    await clickTestId(page, `tg-album-tile-${lastTile}`)
    await waitForTestId(page, 'media-viewer', UI_TIMEOUT_MS)
    const atLastTile = await page.evaluate(readViewerState)
    await page.screenshot(path.join(OUT_DIR, '02-viewer-last-album-tile.png'))

    check(
      '点相册最后一张 → 播放器打开',
      atLastTile.open,
      JSON.stringify(atLastTile),
    )
    check(
      `★ 位置分母 = 整个可播流（${albumMembers.length}/${expectedTotal}），不是相册长度 ` +
        `（修复前会是 ${albumMembers.length}/${albumMembers.length}）`,
      atLastTile.position === `${albumMembers.length}/${expectedTotal}`,
      `position=${JSON.stringify(atLastTile.position)}`,
    )
    check(
      '★ 相册最后一张仍有「下一条」（序列跨出了相册）',
      atLastTile.hasNext,
      JSON.stringify(atLastTile),
    )

    // 点 › → 必须走到**相册之外**的那一条
    await clickTestId(page, 'viewer-next')
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"]')
        return Boolean(v && v.getAttribute('data-message-id'))
      },
      { timeout: UI_TIMEOUT_MS, intervalMs: 150 },
    )
    const afterNext = await page.evaluate(readViewerState)
    await page.screenshot(path.join(OUT_DIR, '03-viewer-after-next.png'))

    check(
      '★ 点「下一条」走到相册之外的条目（按 messageId 与后端核对）',
      outsideAlbum.some(m => Number(m.messageId) === afterNext.messageId),
      `viewer.messageId=${afterNext.messageId} outsideAlbum=${JSON.stringify(
        outsideAlbum.map(m => m.messageId),
      )}`,
    )
    check(
      `末位位置为 ${expectedTotal}/${expectedTotal} 且不再有「下一条」（序列到此为止）`,
      afterNext.position === `${expectedTotal}/${expectedTotal}` && !afterNext.hasNext,
      JSON.stringify(afterNext),
    )
    check('末位仍有「上一条」（序列不是只有一条）', afterNext.hasPrev, JSON.stringify(afterNext))

    await closeViewer(page)

    // ---------- 正向：相册第一张 → 有下一条、无上一条 ----------
    console.log('')
    console.log('--- 正向：相册第一张（头部边界）---')
    await clickTestId(page, 'tg-album-tile-0')
    await waitForTestId(page, 'media-viewer', UI_TIMEOUT_MS)
    const atFirst = await page.evaluate(readViewerState)
    check(
      `相册第一张位置为 1/${expectedTotal}`,
      atFirst.position === `1/${expectedTotal}`,
      JSON.stringify(atFirst),
    )
    check('首项无「上一条」', !atFirst.hasPrev, JSON.stringify(atFirst))
    check('首项有「下一条」', atFirst.hasNext, JSON.stringify(atFirst))
    await closeViewer(page)

    // ---------- 正向：全局搜索命中集 = 邻居序列 ----------
    console.log('')
    console.log('--- 正向：全局搜索命中（第二入口）---')
    const search = await httpGetJson(
      `${TG_API}/api/tg/monitor/search?q=${encodeURIComponent(MULTI_QUERY)}&limit=60`,
    )
    const hits = (search && Array.isArray(search.items) ? search.items : []) || []
    const hitCount = hits.length
    console.log(`[verify:tg-viewer] search "${MULTI_QUERY}" → ${hitCount} hits`)

    if (hitCount >= 2) {
      const typed = await typeInto(page, 'tg-global-search-input', MULTI_QUERY)
      check('全局搜索框存在且可输入', typed)
      try {
        await waitForTestId(page, 'tg-hit-preview', UI_TIMEOUT_MS)
      } catch (_err) {
        /* 由下面的断言如实报告 */
      }
      const domHits = Number(
        await page.evaluate(
          () => document.querySelectorAll('[data-testid="tg-hit-preview"]').length,
        ),
      )
      check('命中列表渲染（tg-hit-preview）', domHits === hitCount, `dom=${domHits} api=${hitCount}`)
      await page.screenshot(path.join(OUT_DIR, '04-global-hits.png'))

      await clickTestIdAt(page, 'tg-hit-preview', 1)
      await waitForTestId(page, 'media-viewer', UI_TIMEOUT_MS)
      const atHit = await page.evaluate(readViewerState)
      await page.screenshot(path.join(OUT_DIR, '05-viewer-from-hit.png'))
      check(
        `★ 点第 2 条命中 → 位置 2/${hitCount}（命中集即序列，修复前是 1/1 且无上下条）`,
        atHit.position === `2/${hitCount}`,
        JSON.stringify(atHit),
      )
      check('命中序列里有「下一条」', atHit.hasNext, JSON.stringify(atHit))
      await closeViewer(page)
    } else {
      check('全局搜索命中 >= 2 条（前置）', false, `hits=${hitCount}`)
    }

    // ---------- 反向证伪：单条序列不得给上下条入口 ----------
    console.log('')
    console.log('--- 反向证伪：只命中 1 条时，‹ › 都不出现（防「箭头恒显示」）---')
    const single = await httpGetJson(
      `${TG_API}/api/tg/monitor/search?q=${encodeURIComponent(SINGLE_QUERY)}&limit=60`,
    )
    const singleHits = (single && Array.isArray(single.items) ? single.items : []) || []
    console.log(`[verify:tg-viewer] search "${SINGLE_QUERY}" → ${singleHits.length} hits`)

    if (singleHits.length === 1) {
      await typeInto(page, 'tg-global-search-input', SINGLE_QUERY)
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="tg-hit-preview"]').length === 1,
        { timeout: UI_TIMEOUT_MS, intervalMs: 200 },
      )
      await clickTestIdAt(page, 'tg-hit-preview', 0)
      await waitForTestId(page, 'media-viewer', UI_TIMEOUT_MS)
      const atSingle = await page.evaluate(readViewerState)
      await page.screenshot(path.join(OUT_DIR, '06-viewer-single-no-neighbours.png'))
      check(
        '★ 序列只有 1 条时不给上一条/下一条入口',
        atSingle.open && !atSingle.hasPrev && !atSingle.hasNext,
        JSON.stringify(atSingle),
      )
      await closeViewer(page)
    } else {
      check(
        '单条搜索词恰好命中 1 条（前置）',
        false,
        `query=${JSON.stringify(SINGLE_QUERY)} hits=${singleHits.length}`,
      )
    }

    // ---------- 运行时健康 ----------
    console.log('')
    console.log('--- 运行时健康 ---')
    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
    const realConsole = page.consoleErrors().filter(m => !BENIGN_CONSOLE.some(re => re.test(m)))
    check('无 console error（忽略 favicon / 未起的 daemon 9876）', realConsole.length === 0, JSON.stringify(realConsole.slice(0, 3)))

    // ---------- 产物 ----------
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.writeFileSync(path.join(OUT_DIR, `dom-${stamp}.html`), await page.content(), 'utf8')
    fs.writeFileSync(
      path.join(OUT_DIR, `result-${stamp}.json`),
      JSON.stringify(
        {
          appUrl: APP_URL,
          tgApi: TG_API,
          backend: {
            channelId: chatId,
            items: items.length,
            playable: expectedTotal,
            album: albumMembers.length,
            outsideAlbum: outsideAlbum.length,
          },
          observed: { atLastTile, afterNext, atFirst },
          results,
        },
        null,
        2,
      ),
      'utf8',
    )
    console.log(`[verify:tg-viewer] artifacts: ${OUT_DIR}`)

    console.log('')
    const failed = results.filter(r => !r.ok)
    console.log(`[verify:tg-viewer] ${results.length - failed.length}/${results.length} assertions passed`)
    if (failed.length > 0) {
      console.log('')
      console.log('--- FAILURES ---')
      for (const item of failed) console.log(`  - ${item.name}: ${item.detail || 'n/a'}`)
      console.log('[verify:tg-viewer] RESULT: FAIL')
      return 1
    }
    console.log('[verify:tg-viewer] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:tg-viewer] ERROR: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    console.error('[verify:tg-viewer] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  })
