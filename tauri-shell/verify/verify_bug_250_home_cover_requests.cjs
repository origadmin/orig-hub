'use strict'

/*
 * BUG-250 验收：媒体库主页**不得**对「无字节的视频条目」发起 raw 请求，也不得出现 404。
 *
 * ## 判据的语义边界（先看这段，否则会把设计行为当成缺陷）
 *
 * 「无字节」对两类条目含义不同：
 *
 * - **TG 图片（kind=photo）不落盘是设计**（BUG-049）：raw 端点现场代理 TG 缩略图，
 *   `filePath` 为空也照常显示，前端 `hasMediaBytes()` 对它恒为 true。所以
 *   photo+missing 的 raw 请求**是正常的**（实测 200），本脚本只观测、不判负。
 * - **视频（kind=video）无字节 = 真的播不了**：raw 必然失败（实测 404），
 *   抽帧/缩略图请求只会刷错误。这才是本条判据针对的对象。
 *
 * ## 它量什么（成对判据，禁 always-green）
 *
 * 1. 先解析出 `kind=video && bytesPresence=missing` 的 id 集合 —— 没有这个集合，
 *    「没有对无字节视频发请求」这句话无法被证伪（任何干净页面都恒过）。
 * 2. 打开媒体库 → 切到 items 视图（`nav-child-cat-video`，M0 后 media-cat-all 废止）→ **滚动到底**
 *    （封面是 IntersectionObserver 懒触发的，只测首屏等于没测），
 *    用 CDP `Network.responseReceived` 收集每一条 `/api/media/items/:id/raw`。
 * 3. A：items 视图对 `video+missing` 的 raw 请求数必须为 **0**（修复前 > 0 且 404）；
 *    A2：items 视图 raw 响应里 404 数必须为 **0**；
 *    B：对**有字节**条目仍必须出现 200 的 raw 请求 —— 堵死「把请求全删掉」的假修复。
 *
 * ## 覆盖边界
 *
 * - **剧集墙（SeriesCard）不在判据内**：它的封面门控依赖后端新字段 `coverHasBytes`，
 *   要引擎重启后才生效。脚本只把它的请求作为**观测**打印出来（标注 not-gated），
 *   不用它判定成败。`MediaCard` 的 items 视图部分不依赖新字段，可立即判定。
 * - 只覆盖主页。详情页（剧集详情/集图组/编辑面板）的 `mediaItemUrl` 兜底不在本次范围。
 *
 * ## 依赖与复跑
 *
 * - vite dev（默认 `http://127.0.0.1:5180/`）+ 运行中的引擎；`lib/cdp.cjs`（自动挑 Edge）。
 * - 可直接跑：`node verify/verify_bug_250_home_cover_requests.cjs`
 *
 * ## 验牙（摘掉 `MediaCard.tsx` 里 video effect 的 `if (!playable) return`）
 *
 * 摘掉后 A/A2 必 FAIL（对 video+missing 出现 raw 请求且状态 404），而 B 仍 PASS ——
 * 失败可干净归因到门控，而不是「页面没加载」。
 */

const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP = process.env.VERIFY250_APP || 'http://127.0.0.1:5180/'
const OBSERVE_MS = Number(process.env.VERIFY250_OBSERVE_MS || 8000)
const SCROLL_STEPS = Number(process.env.VERIFY250_SCROLL_STEPS || 5)

let passed = 0
let failed = 0

function check(ok, label, detail) {
  if (ok) {
    passed += 1
    console.log(`[verify] PASS - ${label}${detail ? ' :: ' + detail : ''}`)
  } else {
    failed += 1
    console.log(`[verify] FAIL - ${label}${detail ? ' :: ' + detail : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 从收集到的请求 URL 里推断**媒体库后端**的 origin。
 *
 * 注意：本进程同时连着 daemon 与 orig-tg 两个后端，`/api/media/*` 只在 orig-tg 上
 * （前端 `api/media.ts` 的 `MEDIA_BASE = TG_BASE`）。所以必须按 `/api/media/` 前缀取，
 * 取到第一个 `/api/` 会命中 daemon（那里的 `/api/media/...` 不是 JSON，会炸在解析上）。
 */
function inferEngineOrigin(urls) {
  for (const u of urls) {
    const m = /^(https?:\/\/[^/]+)\/api\/media\//.exec(u)
    if (m) return m[1]
  }
  return null
}

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const sessionId = page.sessionId
  await page.conn.send('Network.enable', {}, { sessionId })
  /*
   * 必须禁用 HTTP 缓存：否则第一次跑挂了 404，浏览器把它缓存下来，
   * 后续运行**根本不发那条请求** —— A/A2 会因为「没请求」而恒过，
   * 判据静默失效（典型的 always-green 陷阱）。2026-10-10 实测：不禁用时
   * 第二次跑对 missing 条目的请求数从 101 掉到 1。
   */
  await page.conn.send('Network.setCacheDisabled', { cacheDisabled: true }, { sessionId })

  const rawResponses = []
  const allUrls = []
  let phase = 'series-wall'

  page.conn.on('Network.requestWillBeSent', (p) => {
    if (p && p.request && p.request.url) allUrls.push(p.request.url)
  })
  page.conn.on('Network.responseReceived', (p) => {
    const res = (p && p.response) || {}
    const url = String(res.url || '')
    if (url) allUrls.push(url)
    if (/\/api\/media\/items\/\d+\/raw(\?|$)/.test(url)) {
      rawResponses.push({ url, status: Number(res.status || 0), phase })
    }
  })

  try {
    await page.goto(APP, { settleMs: 1500 })
    const opened = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    check(opened, 'media library nav entry exists ([data-testid="nav-child-lib-series"])', `clicked=${opened}`)

    // 阶段一：剧集墙（观测用，不作判据 —— 依赖后端新字段，待引擎重启）
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="series-card-root"]').length > 0 ||
        document.querySelectorAll('[data-testid="media-card"]').length > 0,
      { timeout: 25000, intervalMs: 300 },
    )
    await sleep(4000)
    phase = 'items-view'
    // M0（BUG-298）：`media-cat-all` 已废止，入口改名 `nav-child-cat-video`。
    // BUG-422：旧代码点的还是废止的 media-cat-all（恒 clicked=false）——
    // 新入口优先、旧入口回落。
    const switched = await page.evaluate(() => {
      const el =
        document.querySelector('[data-testid="nav-child-cat-video"]') ||
        document.querySelector('[data-testid="media-cat-all"]')
      if (!el) return false
      el.click()
      return true
    })
    check(switched, 'items view reachable ([data-testid="nav-child-cat-video"])', `clicked=${switched}`)

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="media-card"]').length > 0,
      { timeout: 25000, intervalMs: 300 },
    )
    for (let i = 0; i < SCROLL_STEPS; i += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.9))))
      await sleep(700)
    }
    await sleep(OBSERVE_MS)

    const cards = await page.evaluate(
      () => document.querySelectorAll('[data-testid="media-card"]').length,
    )
    check(cards > 0, 'media cards really rendered (non-emptiness guard)', `cards=${cards}`)

    const origin = inferEngineOrigin(allUrls)
    check(Boolean(origin), 'engine origin inferred from real traffic', `origin=${origin || 'none'}`)
    if (!origin) throw new Error('cannot infer engine origin: no /api/ request observed')

    const inv = await page.evaluate(async (base) => {
      const res = await fetch(base + '/api/media/items?limit=1000')
      const data = await res.json()
      const items = data.items || []
      const pick = (f) => items.filter(f).map((x) => x.id)
      return {
        total: Number(data.total || items.length),
        videoMissing: pick((x) => x.kind === 'video' && x.bytesPresence === 'missing'),
        photoMissing: pick((x) => x.kind === 'photo' && x.bytesPresence === 'missing'),
        present: pick((x) => x.bytesPresence !== 'missing'),
      }
    }, origin)

    console.log(
      `[verify] inventory: total=${inv.total} videoMissing=${inv.videoMissing.length} ` +
        `photoMissing=${inv.photoMissing.length} present=${inv.present.length}`,
    )
    check(
      inv.videoMissing.length > 0,
      'byte-less videos exist (otherwise this check cannot prove anything)',
      `videoMissing=${inv.videoMissing.length}`,
    )

    const videoMissing = new Set(inv.videoMissing)
    const photoMissing = new Set(inv.photoMissing)
    const present = new Set(inv.present)
    const idOf = (u) => {
      const m = /\/api\/media\/items\/(\d+)\/raw/.exec(u)
      return m ? Number(m[1]) : null
    }

    const itemsRaw = rawResponses.filter((r) => r.phase === 'items-view')
    const hitsVideoMissing = itemsRaw.filter((r) => videoMissing.has(idOf(r.url)))
    const hitsPhotoMissing = itemsRaw.filter((r) => photoMissing.has(idOf(r.url)))
    const okAny = itemsRaw.filter((r) => r.status === 200)
    const onPresent = itemsRaw.filter((r) => present.has(idOf(r.url)))
    const notFound = itemsRaw.filter((r) => r.status === 404)

    console.log(
      `[verify] items view raw: total=${itemsRaw.length} onVideoMissing=${hitsVideoMissing.length} ` +
        `onPhotoMissing=${hitsPhotoMissing.length}(design-allowed) http200=${okAny.length} ` +
        `onPresent=${onPresent.length} http404=${notFound.length}`,
    )
    if (hitsVideoMissing.length > 0) {
      console.log(
        '[verify] video-missing raw samples: ' +
          JSON.stringify(hitsVideoMissing.slice(0, 5).map((r) => ({ id: idOf(r.url), status: r.status }))),
      )
    }

    check(
      hitsVideoMissing.length === 0,
      'A: no raw request for byte-less VIDEO items',
      `onVideoMissing=${hitsVideoMissing.length} videoMissingIds=${inv.videoMissing.length}`,
    )
    check(notFound.length === 0, 'A2: no 404 from /raw in the items view', `http404=${notFound.length}`)

    /*
     * B 不能用「对 present 条目有 raw 请求」当判据：有字节的条目大多**已经有封面**
     * （`item.poster` 是库里存的 dataURL），本来就不该发 raw —— 那样断言等于要求
     * 「没必要的请求必须存在」。也不能用「有 200 的 raw 响应」：修复后 items 视图
     * 合法地一条 raw 都不发（实测 total=0），该断言会恒 FAIL。
     *
     * 真正要防的假绿是「把整页渲染干掉，于是 A 恒过」。所以判据锚在**渲染证据**上：
     * 卡片在、封面 `<img>` 在，且至少有一张**真的解码成功**（naturalWidth > 0）。
     * 反向验证时它是绿的（页面本身正常），修复后也是绿的 —— 它只负责证明「不是空白页」。
     */
    const coverImgs = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('[data-testid="media-card"] img')]
      return { total: imgs.length, decoded: imgs.filter((i) => i.naturalWidth > 0).length }
    })
    check(
      coverImgs.decoded > 0,
      'B: media cards really render decoded cover images (guards against a blank-page fix)',
      `cardImgs=${coverImgs.total} decoded=${coverImgs.decoded} http200raw=${okAny.length}`,
    )

    const wall404 = rawResponses.filter((r) => r.phase === 'series-wall' && r.status === 404)
    console.log(
      `[verify] OBSERVATION (not gated) series wall raw=${rawResponses.filter((r) => r.phase === 'series-wall').length} http404=${wall404.length} ` +
        `ids=${JSON.stringify([...new Set(wall404.map((r) => idOf(r.url)))].slice(0, 8))}`,
    )

    const pageErrors = page.pageErrors()
    check(pageErrors.length === 0, 'no uncaught page errors', JSON.stringify(pageErrors.slice(0, 2)))

    const shot = path.join(os.tmpdir(), 'orighub-verify-bug-250', 'media-home-cover-requests.png')
    console.log(`[verify] screenshot: ${await page.screenshot(shot)}`)
  } finally {
    await browser.close()
  }

  console.log(`[verify] total=${passed + failed} passed=${passed} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 2)
}

main().catch((err) => {
  console.error(`[verify] ERROR ${err && err.message ? err.message : err}`)
  process.exit(1)
})
