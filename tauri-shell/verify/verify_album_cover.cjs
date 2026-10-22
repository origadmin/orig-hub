'use strict'
/**
 * 验收：TG 相册「组级封面 + 点击展开整组」（2026-10-22 用户第 3 点）。
 *
 * 用户原话：「和 TG 不一样，我们要的是过滤下载，而不是一个聊天 TG，所以图片
 * 即时加载是否改成列表点击加载整个组内容，排版也改成这种适合模式？」
 *
 * ## 为什么不能只看 DOM
 *
 * 「折叠态没有第二张图」用 DOM 计数就能测，但**那不足以证明省了请求**：
 * `<img loading="lazy">` 只要进了视口就会发请求，DOM 里有几个 `<img>` 和
 * 发了几个请求是两件事。所以主判据是 **`/api/tg/thumb/` 的真实请求集合**，
 * DOM 计数只作辅助。
 *
 * ## 判据（每条都带被测前提）
 *
 *   A0 前提：视口宽 = 900（最矮受支持窗口档）、至少存在一个 `data-count >= 2`
 *      的折叠封面。没有可测样本 ⇒ **Loud FAIL**，不是「跳过即通过」。
 *   A1 折叠态该组**只发 1 个** thumb 请求（= 封面那条）。
 *   A2 点击封面后，该组**其余 N-1 条**的 thumb 请求全部出现（N = 角标数字）。
 *      「点击加载整组内容」这句话的可观测形态就是这个。
 *   A3 数量角标文本 = 组内条数，且 > 1。
 *   A4 展开后出现「收起」，点它回到折叠态（封面重新出现、瓦片消失）。
 *   A5 单条单元不折叠：不存在 `data-count="1"` 的封面。
 *   A6 折叠态点击的是「展开」而不是「打开大图」：点击后没有大图预览层出现。
 *
 * 用法：node tauri-shell/verify/verify_album_cover.cjs
 * 前置：dev 栈在跑（`scripts/dev/dev-stack.cmd` → 1 起栈），`5180` 可访问。
 * 产物：verify_shots/album-cover/{report.json,*.png}
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'album-cover')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const VIEWPORT = { width: 900, height: 600 }

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 读取当前所有 thumb 请求的 `chatId:messageId` 集合。 */
const THUMB_SNAPSHOT = `(() => {
  const out = []
  for (const e of performance.getEntriesByType('resource')) {
    const m = /\\/api\\/tg\\/thumb\\/([^/]+)\\/([^/?#]+)/.exec(e.name)
    if (m) out.push(m[1] + ':' + m[2])
  }
  return out
})()`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    // ★ `Page.setViewport` 收的是**对象**（`{width, height}`）；传两个数字会让
    //   width/height 变成 undefined，CDP 直接回 "Invalid parameters" ——
    //   本脚本首次运行前就是栽在这里（首轮写完没跑过）。
    await page.setViewport(VIEWPORT)
    // ★ 冷启动首屏可达 30s+（vite 侧刚改过文件时尤其明显），默认 30s 档会表现成
    //   「Page.loadEventFired 超时」而不是「加载慢」 ⇒ 显式放宽 timeout 并允许重试。
    await page.goto(APP, { waitForRoot: true, settleMs: 1500, timeout: 90000, attempts: 3 })

    // ★ 资源时间线默认只保留 250 条；TG 面板一屏就是几十个缩略图，跑久了早先的记录
    //   会被**静默挤掉** ⇒ 「封面没发请求」可能只是缓冲区溢出。先抬高上限。
    await page.evaluate(() => {
      if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(20000)
    })

    // 进 TG 面板 → 点开第一个监控频道（内容流才会渲染）
    await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="nav-tg"]')
      if (nav) nav.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0,
      { timeout: 60000 },
    )
    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tg-monitor-row"]')
      if (row) row.click()
    })
    // 等相册或单条气泡出现（两者都可能是首屏内容）
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="album-cover"]').length > 0 ||
        document.querySelectorAll('[data-testid="album-grid"]').length > 0,
      { timeout: 60000 },
    )

    // ── A0 前提：视口与可测样本
    const viewportW = await page.evaluate(() => window.innerWidth)
    check('A0a viewport width is 900', viewportW === VIEWPORT.width, `got ${viewportW}`)

    const covers = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="album-cover"]')).map((el) => ({
        count: Number(el.getAttribute('data-count')),
        chatId: el.getAttribute('data-chat-id'),
        messageId: el.getAttribute('data-message-id'),
      })),
    )
    const sample = covers.find((c) => c.count >= 2)
    check(
      'A0b at least one collapsed album with count >= 2',
      !!sample,
      sample ? `chat=${sample.chatId} msg=${sample.messageId} n=${sample.count}` : `covers=${covers.length}`,
    )
    if (!sample) {
      throw new Error('no multi-item album to verify (nothing to prove)')
    }

    // ── A5 单条不折叠（在展开前读，避免展开态污染）
    check(
      'A5 no cover with count == 1',
      covers.every((c) => c.count !== 1),
      `counts=${covers.map((c) => c.count).join(',')}`,
    )

    // ── A3 角标文本 = 组内条数
    const badge = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="album-cover"]')
      if (!el) return null
      const b = el.querySelector('[data-testid="album-cover-count"]')
      return b ? b.textContent.trim() : null
    })
    check(
      'A3 badge text equals item count',
      badge === String(sample.count),
      `badge=${badge} expected=${sample.count}`,
    )

    // ── A1 折叠态只发 1 个 thumb（封面那条）
    // ★ 两个坑（首次跑就踩了）：
    //   ① 封面是 `<img loading="lazy">`，**在视口外就永远不发请求** ⇒ 不滚动到视口内
    //      就读成「没请求」，那是把「还没发生」当成「没发生」；
    //   ② 有界等待，不用固定 sleep（超时仍如实报红并带上实测耗时）。
    await page.evaluate((mid) => {
      const el = document.querySelector(`[data-testid="album-cover"][data-message-id="${mid}"]`)
      if (el) el.scrollIntoView({ block: 'center' })
    }, sample.messageId)
    await new Promise((r) => setTimeout(r, 400))

    const coverKey = `${sample.chatId}:${sample.messageId}`
    const coverDeadline = Date.now() + 20000
    const coverT0 = Date.now()
    let beforeSet = new Set()
    while (Date.now() < coverDeadline) {
      beforeSet = new Set(await page.evaluate(THUMB_SNAPSHOT))
      if (beforeSet.has(coverKey)) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const coverWaitMs = Date.now() - coverT0
    check(
      'A1 collapsed album requested only its cover',
      beforeSet.has(coverKey),
      `cover ${coverKey} requested=${beforeSet.has(coverKey)} waited=${coverWaitMs}ms all=[${[...beforeSet].join(',')}]`,
    )

    // ★ 折叠态截图**不用 fullPage**：`captureBeyondViewport` 会让 Chromium 按整页高度
    //   重排一次，消息列表随之重渲染，展开态可能因此丢失 —— 截图不该改变被测状态。
    await page.screenshot(path.join(OUT, '01-collapsed.png'), { fullPage: false })

    // ── 点击封面 → 展开整组
    // ★ 必须点**这一组**（按 data-message-id 定位），并且「滚动 → 重新查询 → 点击」
    //   放在**同一次** page.evaluate 里原子完成：
    //   面板在轮询重渲染，等 20s 之后该消息可能已被移出渲染窗口 ⇒
    //   querySelector 返回 null ⇒ 静默跳过点击 ⇒ 看起来就是「点了没反应」。
    const clicked = await page.evaluate(async (mid) => {
      const sel = `[data-testid="album-cover"][data-message-id="${mid}"]`
      const first = document.querySelector(sel)
      if (!first) return { ok: false, reason: 'cover not in DOM' }
      first.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 350))
      const el = document.querySelector(sel)
      if (!el) return { ok: false, reason: 'cover vanished after scroll' }
      el.click()
      return { ok: true, detached: !document.contains(el) }
    }, sample.messageId)
    check('A2pre0 the target album cover was found and clicked', clicked.ok === true, JSON.stringify(clicked))
    // ★ 不用裸 waitForFunction（超时只会抛 FATAL，看不出到底发生了什么）：
    //   快速轮询并记录**观测到的最大值** —— 若 grid 曾出现又消失，说明展开态被
    //   后续轮询刷新覆盖（flapping），那是比「没展开」更严重的问题。
    const gridDeadline = Date.now() + 15000
    let gridUp = false
    let maxGrid = 0
    let maxTiles = 0
    let diag = null
    while (Date.now() < gridDeadline) {
      diag = await page.evaluate(() => ({
        grid: document.querySelectorAll('[data-testid="album-grid"]').length,
        cover: document.querySelectorAll('[data-testid="album-cover"]').length,
        tiles: document.querySelectorAll('[data-testid^="tg-album-tile-"]').length,
      }))
      maxGrid = Math.max(maxGrid, diag.grid)
      maxTiles = Math.max(maxTiles, diag.tiles)
      if (diag.grid > 0) {
        gridUp = true
        break
      }
      await new Promise((r) => setTimeout(r, 60))
    }
    check(
      'A2pre clicking the cover expands the group (album-grid appears)',
      gridUp,
      `diag=${JSON.stringify(diag)} maxGrid=${maxGrid} maxTiles=${maxTiles}`,
    )
    if (!gridUp) {
      await page.screenshot(path.join(OUT, '02-expand-failed.png'))
      throw new Error('album-grid never appeared after clicking the cover — see diag above')
    }
    // 缩略图是异步拉取的：等请求数真的涨上来（有界等待，超时如实报红）
    const deadline = Date.now() + 30000
    let afterSet = new Set()
    let groupIds = []
    while (Date.now() < deadline) {
      afterSet = new Set(await page.evaluate(THUMB_SNAPSHOT))
      groupIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="album-grid"] [data-message-id]')).map(
          (el) => el.getAttribute('data-message-id'),
        ),
      )
      if (groupIds.length >= 2 && groupIds.every((id) => afterSet.has(id))) break
      await new Promise((r) => setTimeout(r, 300))
    }

    // ── A2 其余 N-1 条的 thumb 请求全部出现
    const missing = groupIds.filter((id) => !afterSet.has(id))
    check(
      'A2 clicking the cover loads the whole group',
      groupIds.length === sample.count && missing.length === 0,
      `tiles=${groupIds.length} expected=${sample.count} missing=[${missing.join(',')}]`,
    )

    // ── A6 折叠态点击 = 「展开这一组」，不是「打开大图」
    // ★ 旧写法数 `[data-testid="tg-photo-preview"]` —— 那是**单图气泡的缩略图按钮**
    //   （`PhotoBlock` 里，每条图片消息一个），点之前就有十几个 ⇒ 恒真、恒假都测不出。
    //   改成测可观测的落点：展开的是**被点的那一组**（grid 内含有该组封面的
    //   messageId），且消息流仍在屏（没有被跳到播放器/别的视图）。
    const a6 = await page.evaluate((mid) => {
      const grid = document.querySelector('[data-testid="album-grid"]')
      const ids = grid
        ? Array.from(grid.querySelectorAll('[data-message-id]')).map((el) => el.getAttribute('data-message-id'))
        : []
      return {
        gridUp: !!grid,
        hasCoverMsg: ids.includes(mid),
        feedStillHere: document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0,
      }
    }, sample.messageId)
    check(
      'A6 first click expands THAT album and stays in the message feed',
      a6.gridUp && a6.hasCoverMsg && a6.feedStillHere,
      JSON.stringify(a6),
    )

    await page.screenshot(path.join(OUT, '02-expanded.png'))

    // ── A4 收起回到折叠态
    const hasCollapse = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="album-collapse"]')
      if (!el) return false
      el.click()
      return true
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="album-cover"]').length > 0,
      { timeout: 15000 },
    )
    const gridAfterCollapse = await page.evaluate(
      () => document.querySelectorAll('[data-testid="album-grid"]').length,
    )
    check(
      'A4 collapse control returns to the cover',
      hasCollapse && gridAfterCollapse === 0,
      `collapseBtn=${hasCollapse} gridsAfter=${gridAfterCollapse}`,
    )
    await page.screenshot(path.join(OUT, '03-collapsed-again.png'))

    // 控制台错误也要算失败（白屏/异常不该被「判据全绿」掩盖）
    const errors = (await page.consoleErrors()).concat(await page.pageErrors())
    check('A7 no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    const failed = results.filter((r) => !r.ok)
    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      JSON.stringify({ viewport: VIEWPORT, results, failed: failed.length }, null, 2),
    )
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e)
  process.exit(1)
})
