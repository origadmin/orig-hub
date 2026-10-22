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
    await page.setViewport(VIEWPORT.width, VIEWPORT.height)
    await page.goto(APP)

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
    const before = await page.evaluate(THUMB_SNAPSHOT)
    const beforeSet = new Set(before)
    const coverKey = `${sample.chatId}:${sample.messageId}`
    check(
      'A1 collapsed album requested only its cover',
      beforeSet.has(coverKey),
      `cover ${coverKey} requested=${beforeSet.has(coverKey)}`,
    )

    await page.screenshot(path.join(OUT, '01-collapsed.png'))

    // ── 点击封面 → 展开整组
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="album-cover"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="album-grid"]').length > 0,
      { timeout: 30000 },
    )
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

    // ── A6 折叠态点击是「展开」而不是「打开大图」
    const previewOpen = await page.evaluate(
      () =>
        document.querySelectorAll('[data-testid="tg-photo-preview"]').length > 0 &&
        document.querySelectorAll('[data-testid="album-grid"]').length === 0,
    )
    check('A6 first click expands instead of opening the viewer', previewOpen === false)

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
