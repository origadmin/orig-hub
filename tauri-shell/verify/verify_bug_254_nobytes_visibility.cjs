'use strict'

/*
 * BUG-254 验收：无字节内容在**剧集墙 / 分集列表 / 播放器**三处必须可辨，
 * 且播放器**不得**把「没有内容」说成「浏览器无法解码该格式」。
 *
 * ## 判据的语义边界（先看这段，否则会把设计行为当成缺陷）
 *
 * 「无字节」= 条目只有信息没有磁盘字节（`media_item.file_path IS NULL`），
 * 这是 BUG-170 裁定的设计内态。字节真值来自后端 probe：
 *   - 剧集卡：`SeriesView.coverHasBytes`（布尔）
 *   - 分集：`EpisodeView.hasBytes`（布尔）
 * TG 图片不落盘是设计（BUG-049），`hasMediaBytes()` 对 photo 恒为 true ——
 * 本脚本只针对**视频/音频**这类「真无字节」条目，photo 不作判据。
 *
 * ## 它量什么（成对判据，禁 always-green）
 *
 * 先用**未打补丁的 XHR** 拉真实清单，找出：
 *   - noBytesSeries：`coverHasBytes === false` 的剧集（剧集墙标记的靶子）
 *   - normalSeries：`coverHasBytes !== false` 的剧集（**咬合**反证：必须**无**标记）
 *   - playerSeries：其分集里同时有「无字节视频」与「有字节且有时长的视频」的剧集
 * 没有这些靶子时，「无字节剧集有标记」这句话无法被证伪（脚本会明确报数据不足）。
 *
 * (a) 剧集墙：noBytesSeries 的卡内出现 `series-nobytes`；normalSeries 的卡内**不**出现。
 * (b) 分集列表：playerSeries 详情里无字节分集行出现 `episode-nobytes` 且**不显示时长**（无 mm:ss）；
 *     有字节且有时长的分集行**仍显示时长**且无 `episode-nobytes`。
 * (c) 播放器：先播放一集**有字节**的打开 viewer，再在右侧分集侧栏点选**无字节**分集
 *     ⇒ 出现 `player-nobytes`（「无内容/未缓存」）且**不出现** `player-decode-error`；
 *     点回有字节分集 ⇒ **不**出现 `player-nobytes`（**咬合**）。
 *
 * ## 咬合 / 反向检查（teeth，禁 always-green）
 *
 * a/b/c 每条都配了「反向」那一半（normalSeries 无标记、有字节分集仍显时长、有字节分集无
 * `player-nobytes`）。任何假修复 —— 恒显标记、恒隐标记、抹掉整页渲染 —— 都会让其中一半 FAIL。
 *
 * 想要「把字节态判定翻转 ⇒ 标记消失 ⇒ 脚本退出码非 0」的端到端反证，跑：
 *     VERIFY254_TEETH=1 node verify/verify_bug_254_nobytes_visibility.cjs
 * 该模式在页面里注入 fetch shim，把后端下发的 `coverHasBytes:false` / `hasBytes:false`
 * 翻成 true 并重放（**不改任何源码**），于是正例断言因「标记消失」而 FAIL、退出码非 0，
 * 证明这些断言确实咬在字节态上。清单发现走 XHR，不受 shim 影响。
 *
 * ## 依赖与复跑
 *
 * - vite dev（默认 `http://127.0.0.1:5180/`）+ 运行中的 orig-tg 媒体 API；`lib/cdp.cjs` 自动挑 Edge。
 * - 必须 `Network.setCacheDisabled`（否则 404 被缓存 → 后续不再发请求 → 判据静默失效）。
 * - 跑法：`node verify/verify_bug_254_nobytes_visibility.cjs`
 */

const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP = process.env.VERIFY254_APP || 'http://127.0.0.1:5180/'
const TEETH = process.env.VERIFY254_TEETH === '1'
const WALL_SCROLL_STEPS = Number(process.env.VERIFY254_WALL_SCROLL_STEPS || 4)
const SHOT_DIR = path.join(os.tmpdir(), 'orighub-verify-bug-254')

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
 * 从收集到的请求 URL 里推断**媒体库后端** origin。
 * 必须按 `/api/media/` 前缀取 —— 本进程同时连着 daemon 与 orig-tg，`/api/` 会先命中 daemon。
 */
function inferEngineOrigin(urls) {
  for (const u of urls) {
    const m = /^(https?:\/\/[^/]+)\/api\/media\//.exec(u)
    if (m) return m[1]
  }
  return process.env.VERIFY254_ENGINE || null
}

/** 用 XHR 拉 JSON：绕开 page-side fetch shim，保证「真实数据」发现不被 TEETH 模式污染。 */
async function xhrJson(page, url) {
  return page.evaluate(
    (u) =>
      new Promise((resolve, reject) => {
        const x = new XMLHttpRequest()
        x.open('GET', u, true)
        x.onload = () => {
          try {
            resolve(JSON.parse(x.responseText))
          } catch (e) {
            reject(new Error('json parse failed: ' + e.message))
          }
        }
        x.onerror = () => reject(new Error('xhr failed: ' + u))
        x.send()
      }),
    url,
  )
}

/** TEETH 模式的 page-side shim：把后端下发的「无字节」翻转成「有字节」。不改源码。 */
const TEETH_SHIM = `
(function () {
  var origFetch = window.fetch;
  window.fetch = async function () {
    var res = await origFetch.apply(this, arguments);
    try {
      var input = arguments[0];
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/media/series') !== -1) {
        var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (ct.indexOf('json') !== -1) {
          var data = await res.clone().json();
          if (data && Array.isArray(data.items)) {
            for (var i = 0; i < data.items.length; i++) {
              if (data.items[i] && data.items[i].coverHasBytes === false) data.items[i].coverHasBytes = true;
            }
          }
          if (data && Array.isArray(data.episodes)) {
            for (var j = 0; j < data.episodes.length; j++) {
              if (data.episodes[j] && data.episodes[j].hasBytes === false) data.episodes[j].hasBytes = true;
            }
          }
          return new Response(JSON.stringify(data), {
            status: res.status,
            statusText: res.statusText,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    } catch (_e) { /* fall through to original response */ }
    return res;
  };
})();
`

async function main() {
  console.log(`[verify] app=${APP} teeth=${TEETH}`)
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const sessionId = page.sessionId
  await page.conn.send('Network.enable', {}, { sessionId })
  // 必须禁用 HTTP 缓存：否则首跑失败被缓存，后续不再发请求 → 判据静默变绿。
  await page.conn.send('Network.setCacheDisabled', { cacheDisabled: true }, { sessionId })

  if (TEETH) {
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: TEETH_SHIM }, { sessionId })
    console.log('[verify] teeth shim installed (coverHasBytes/hasBytes false -> true)')
  }

  const allUrls = []
  page.conn.on('Network.requestWillBeSent', (p) => {
    if (p && p.request && p.request.url) allUrls.push(p.request.url)
  })
  page.conn.on('Network.responseReceived', (p) => {
    const u = (p && p.response && p.response.url) || ''
    if (u) allUrls.push(u)
  })

  try {
    // ── 0. 打开媒体库 → 剧集墙 ─────────────────────────────
    await page.goto(APP, { settleMs: 1500 })
    const opened = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    check(opened, 'media library nav entry exists ([data-testid="nav-child-lib-series"])', `clicked=${opened}`)
    if (!opened) throw new Error('media library nav not found — cannot continue')

    // 必须回布尔：直接返回 DOM 元素会让 CDP returnByValue 序列化抛
    // 「Object reference chain is too long」。
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-panel-title"]'), {
      timeout: 25000,
      intervalMs: 300,
    })
    const onWall = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-rail-series-all"]')
      if (!el) return false
      el.click()
      return true
    })
    check(onWall, 'series wall reachable ([data-testid="media-rail-series-all"])', `clicked=${onWall}`)
    if (!onWall) throw new Error('series wall rail button not found — cannot continue')

    await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card-root"]').length > 0, {
      timeout: 25000,
      intervalMs: 300,
    })
    // 剧集卡懒加载：滚几屏把靶子刷进来。
    for (let i = 0; i < WALL_SCROLL_STEPS; i += 1) {
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="series-wall-scroll"]')
        if (c) c.scrollBy(0, Math.max(600, Math.floor(c.clientHeight * 0.9)))
        else window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.9)))
      })
      await sleep(500)
    }

    // ── 1. 真实清单发现（XHR，不受 shim 影响） ──────────────
    const origin = inferEngineOrigin(allUrls)
    check(Boolean(origin), 'engine origin inferred from real traffic', `origin=${origin || 'none'}`)
    if (!origin) throw new Error('cannot infer engine origin: no /api/media/ observed')

    const seriesList = await xhrJson(page, `${origin}/api/media/series?limit=1000`)
    const allSeries = (seriesList && (seriesList.items || seriesList.series)) || []
    console.log(`[verify] series inventory: ${allSeries.length} series`)

    // 找 playerSeries：同时含「无字节视频」与「有字节且有时长的视频」。
    let playerSeries = null
    let playerDetail = null
    const candidates = allSeries.slice(0, 40) // 限量，避免无谓请求
    for (const s of candidates) {
      try {
        const d = await xhrJson(page, `${origin}/api/media/series/${s.id}`)
        const eps = (d && d.episodes) || []
        const noBytesVid = eps.find((e) => e.hasBytes === false && e.kind !== 'photo')
        const bytesVid = eps.find((e) => e.hasBytes === true && e.kind !== 'photo' && e.duration != null)
        if (noBytesVid && bytesVid) {
          playerSeries = s
          playerDetail = d
          break
        }
      } catch (_e) {
        /* 单个剧集详情失败不影响继续找下一个 */
      }
    }

    const noBytesSeries = allSeries.find((s) => s.coverHasBytes === false)
    const normalSeries = allSeries.find((s) => s.coverHasBytes !== false)

    check(
      Boolean(noBytesSeries),
      'data: a series with coverHasBytes===false exists (else (a) cannot prove anything)',
      `noBytesSeries=${noBytesSeries ? noBytesSeries.id : 'none'}`,
    )
    check(
      Boolean(normalSeries),
      'data: a series with coverHasBytes!==false exists (else bite cannot prove anything)',
      `normalSeries=${normalSeries ? normalSeries.id : 'none'}`,
    )
    check(
      Boolean(playerSeries),
      'data: a series with a byte-less video AND a byte-having video w/ duration exists (else (b)/(c) cannot prove)',
      `playerSeries=${playerSeries ? playerSeries.id : 'none'}`,
    )

    // ── 2. (a) 剧集墙标记 ─────────────────────────────────
    if (noBytesSeries && normalSeries) {
      const wall = await page.evaluate((nbId, nmId) => {
        const card = (id) => document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`)
        const has = (c, tid) => (c ? c.querySelector(`[data-testid="${tid}"]`) !== null : null)
        const nb = card(nbId)
        const nm = card(nmId)
        return {
          nobytesCardPresent: nb !== null,
          nobytesHasMarker: has(nb, 'series-nobytes'),
          normalCardPresent: nm !== null,
          normalHasMarker: has(nm, 'series-nobytes'),
        }
      }, noBytesSeries.id, normalSeries.id)
      console.log(`[verify] series wall state: ${JSON.stringify(wall)}`)

      check(
        wall.nobytesCardPresent && wall.nobytesHasMarker,
        '(a) byte-less series card shows [series-nobytes]',
        `seriesId=${noBytesSeries.id} card=${wall.nobytesCardPresent} marker=${wall.nobytesHasMarker}`,
      )
      check(
        wall.normalCardPresent && !wall.normalHasMarker,
        '(a-bite) byte-having series card shows NO [series-nobytes]',
        `seriesId=${normalSeries.id} card=${wall.normalCardPresent} marker=${wall.normalHasMarker}`,
      )
      console.log(`[verify] screenshot: ${await page.screenshot(path.join(SHOT_DIR, 'series-wall.png'), { fullPage: true })}`)
    }

    // ── 3. (b)/(c) 分集列表 + 播放器 ───────────────────────
    if (playerSeries && playerDetail) {
      const eps = playerDetail.episodes
      const noBytesVid = eps.find((e) => e.hasBytes === false && e.kind !== 'photo')
      const bytesVid = eps.find((e) => e.hasBytes === true && e.kind !== 'photo' && e.duration != null)

      // 打开该剧集详情（点剧集墙卡）。
      await page.evaluate((sid) => {
        const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
        if (card) card.click()
      }, playerSeries.id)
      await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-picker"]'), {
        timeout: 25000,
        intervalMs: 300,
      })
      await sleep(800)

      // (b) 分集行：episode-nobytes / 时长
      const rows = await page.evaluate(
        (nbEpId, bEpId) => {
          const readRow = (epId) => {
            const row = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${epId}"]`)
            if (!row) return null
            return {
              present: true,
              hasMarker: row.querySelector('[data-testid="episode-nobytes"]') !== null,
              text: (row.textContent || '').trim(),
            }
          }
          return { nb: readRow(nbEpId), b: readRow(bEpId) }
        },
        noBytesVid.id,
        bytesVid.id,
      )
      const DURATION_RE = /\d{1,2}:\d{2}/

      check(
        rows.nb && rows.nb.present && rows.nb.hasMarker,
        '(b) byte-less episode row shows [episode-nobytes]',
        `epId=${noBytesVid.id} ${JSON.stringify(rows.nb)}`,
      )
      check(
        rows.nb && rows.nb.present && !DURATION_RE.test(rows.nb.text),
        '(b) byte-less episode row shows NO duration (mm:ss must be absent)',
        `text=${JSON.stringify(rows.nb && rows.nb.text)}`,
      )
      check(
        rows.b && rows.b.present && !rows.b.hasMarker && DURATION_RE.test(rows.b.text),
        '(b-bite) byte-having episode row still shows duration and NO [episode-nobytes]',
        `epId=${bytesVid.id} ${JSON.stringify(rows.b)}`,
      )
      console.log(`[verify] screenshot: ${await page.screenshot(path.join(SHOT_DIR, 'episode-list.png'), { fullPage: true })}`)

      // (c) 播放器：先播一集有字节的打开 viewer，再在侧栏点无字节分集。
      const openedViewer = await page.evaluate((bEpId) => {
        const row = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${bEpId}"]`)
        if (row) row.click()
        const play = document.querySelector('[data-testid="episode-play"]')
        if (!play || play.disabled) return 'no-play'
        play.click()
        return 'ok'
      }, bytesVid.id)
      check(openedViewer === 'ok', '(c) viewer opened via a byte-having episode', `result=${openedViewer}`)

      // 等到分集侧栏出现无字节分集项，再点它。
      await page.waitForFunction(
        (itemId) => !!document.querySelector(`[data-testid="episode-list-item-${itemId}"]`),
        { timeout: 20000, intervalMs: 300, args: [noBytesVid.itemId] },
      )
      await page.evaluate((itemId) => {
        const el = document.querySelector(`[data-testid="episode-list-item-${itemId}"]`)
        if (el) el.click()
      }, noBytesVid.itemId)
      await sleep(1500)

      const playerState = await page.evaluate(() => ({
        noContent: document.querySelector('[data-testid="player-nobytes"]') !== null,
        decodeError: document.querySelector('[data-testid="player-decode-error"]') !== null,
        text: (() => {
          const el = document.querySelector('[data-testid="player-nobytes"]')
          return el ? (el.textContent || '').trim() : ''
        })(),
      }))
      console.log(`[verify] player (byte-less) state: ${JSON.stringify(playerState)}`)

      check(
        playerState.noContent,
        '(c) opening a byte-less item shows [player-nobytes] (no-content/uncached state)',
        `text=${JSON.stringify(playerState.text)}`,
      )
      check(
        !playerState.decodeError,
        '(c) byte-less item shows NO [player-decode-error] (not misreported as decode failure)',
        `decodeError=${playerState.decodeError}`,
      )
      console.log(`[verify] screenshot: ${await page.screenshot(path.join(SHOT_DIR, 'player-nobytes.png'))}`)

      // (c-bite) 点回有字节分集 ⇒ 不应出现 player-nobytes。
      await page.evaluate((itemId) => {
        const el = document.querySelector(`[data-testid="episode-list-item-${itemId}"]`)
        if (el) el.click()
      }, bytesVid.itemId)
      await sleep(1500)
      const playerBite = await page.evaluate(() => ({
        noContent: document.querySelector('[data-testid="player-nobytes"]') !== null,
      }))
      check(
        !playerBite.noContent,
        '(c-bite) byte-having item shows NO [player-nobytes] (marker is conditional on byte state)',
        `noContent=${playerBite.noContent}`,
      )
    }

    const pageErrors = page.pageErrors()
    check(pageErrors.length === 0, 'no uncaught page errors', JSON.stringify(pageErrors.slice(0, 2)))
  } finally {
    await browser.close()
  }

  if (TEETH && failed === 0) {
    // TEETH 模式期望正例断言因「标记消失」而 FAIL；全绿说明断言没咬住字节态。
    console.log('[verify] TEETH mode: expected the byte-less assertions to FAIL, but everything passed — the checks may be toothless')
    failed += 1
  }

  console.log(`[verify] total=${passed + failed} passed=${passed} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 2)
}

main().catch((err) => {
  console.error(`[verify] ERROR ${err && err.message ? err.message : err}`)
  process.exit(1)
})
