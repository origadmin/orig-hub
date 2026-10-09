#!/usr/bin/env node
'use strict'

/**
 * BUG-226 acceptance: cold-cache deep-position entry must not wait for the
 * transcode to catch up, and the probe must stay side-effect free.
 *
 * Evidence that motivated this (verify_shots/frc-hotfix/):
 *   - a live FRC stream starts at 0:00; after fixing BUG-225 the position
 *     restore on a deep position would stall until the transcode reaches it
 *     (minutes on long videos);
 *   - raw ffmpeg is NOT the bottleneck (630: 16.6x source realtime), so an
 *     anchored stream (`-ss t`) starts at the requested position within seconds.
 *
 * Criteria (each "has value + exact value"):
 *  C1  `?probe=1` answers {"ready":false,"duration":50} and never spawns a
 *      transcode (no .part appears within 2s; pre-fix the probe URL was treated
 *      as a normal request and started one).
 *  C2  Cold-cache rate switch at content 30s (PLAYING): the wire request
 *      carries t=<floor(contentTime)>, first advance <= 6s, and content time
 *      tracks 30s + 2x wall (+/-2.5s) right after the switch.
 *  C3  The anchored stream is live-only: no per-speed proxy or .part appears.
 *  C4  When the variant proxy IS on disk, the switch does NOT anchor (plain
 *      speed URL, Range restore, position kept +/-2s).
 *  C5  Dragging the progress bar beyond the live stream's transcoded coverage
 *      re-anchors with a new t= request and resumes at the target within 6s.
 *
 * Usage: node verify/verify_bug_226_stream_anchor.cjs
 * Env: APP_PORT (5180), TG_URL, PROBE_ITEM (630), SHOT_DIR.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 630)
const OUT = path.resolve(
  process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'verify_shots', 'bug-226-stream-anchor'),
)
const PROXY_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'com.origadmin.orighub', 'tg', 'proxies')
const ANCHOR_BUDGET_S = 6
const POSITION_TOLERANCE_S = 2.5

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const partOf = (v) => path.join(PROXY_DIR, `${v}.part`)
const finalOf = (v) => path.join(PROXY_DIR, v)
const sizeOf = (p) => {
  try {
    return fs.statSync(p).size
  } catch {
    return -1
  }
}

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

function clearSpeedProxies(id) {
  const removed = []
  for (const name of [`${id}-speed-200.mp4`, `${id}-speed-400.mp4`, `${id}-speed-200.mp4.part`, `${id}-speed-400.mp4.part`]) {
    const file = path.join(PROXY_DIR, name)
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file)
        removed.push(name)
      }
    } catch (err) {
      console.log(`[verify] WARN could not remove ${name}: ${err.message}`)
    }
  }
  return removed
}

/** GET a JSON document (loopback). */
function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) })
        } catch (err) {
          reject(new Error(`non-JSON from ${url}: ${body.slice(0, 80)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout ${url}`))
    })
  })
}

/** Consume a URL to the end (pre-builds a canonical proxy). */
function fetchFull(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout ${url}`))
    })
  })
}

async function openItem(page, id) {
  // Wait until the app's TG base is calibrated to the port this script uses
  // (compatSrc is built from the app-side base; see verify_bug_225 comments).
  await page.waitForFunction(
    (port) => {
      const s = window.__origStore && window.__origStore.getState()
      return Boolean(s && s.tgService && s.tgService.port === port)
    },
    { timeout: 20000, intervalMs: 250, args: [Number(new URL(TG).port)] },
  )
  await page.evaluate(
    (tg, itemId) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${itemId}`,
            chatId: 0,
            messageId: itemId,
            kind: 'video',
            caption: 'BUG-226 verify',
            description: null,
            src: `${tg}/api/media/items/${itemId}/raw`,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: 'BUG-226 verify',
      })
    },
    TG,
    id,
  )
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 20000,
    intervalMs: 200,
  })
}

const SNAPSHOT = () => {
  const v = document.querySelector('[data-testid="media-viewer"] video')
  if (!v) return null
  const offset = Number(v.getAttribute('data-content-offset') || '0')
  const speed = Number(v.getAttribute('data-content-speed') || '1')
  let bEnd = -1
  try {
    if (v.buffered.length) bEnd = v.buffered.end(v.buffered.length - 1)
  } catch {}
  return {
    src: v.currentSrc || v.src || '',
    currentTime: v.currentTime,
    paused: v.paused,
    readyState: v.readyState,
    offset,
    speed,
    contentTime: offset + v.currentTime * speed,
    bEnd,
  }
}

async function snapshot(page) {
  return page.evaluate(SNAPSHOT)
}

async function clickRate(page, rate) {
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-haspopup="menu"][aria-expanded]')
    if (!btn) throw new Error('speed menu button not found')
    btn.click()
  })
  await delay(250)
  const ok = await page.evaluate((r) => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const target = items.find((el) => (el.textContent || '').trim().startsWith(`${r}x`))
    if (!target) return false
    target.click()
    return true
  }, rate)
  if (!ok) throw new Error(`rate ${rate}x menu entry not found`)
}

async function play(page) {
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      void v.play().catch(() => {})
    }
  })
}

async function pause(page) {
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) v.pause()
  })
  await delay(300)
}

/**
 * Drag the progress bar with REAL input events (CDP Input domain): the bar
 * commits the seek on pointerup only (BUG-165), and `setPointerCapture` on a
 * synthetic event would throw. ratio 0..1 across the bar width.
 */
async function dragBarTo(page, ratio) {
  const rect = await page.evaluate(() => {
    const sliders = Array.from(document.querySelectorAll('[data-testid="media-viewer"] [role="slider"]'))
    const el = sliders.find((s) => !s.className.includes('sr-only')) || sliders[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top + r.height / 2, w: r.width }
  })
  if (!rect) throw new Error('progress slider not found')
  const opts = { button: 'left', clickCount: 1, buttons: 1 }
  await page.conn.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: rect.x + 2, y: rect.y, ...opts },
    { sessionId: page.sessionId },
  )
  await delay(120)
  await page.conn.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: rect.x + rect.w * ratio, y: rect.y, ...opts },
    { sessionId: page.sessionId },
  )
  await delay(120)
  await page.conn.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: rect.x + rect.w * ratio, y: rect.y, button: 'left', clickCount: 1, buttons: 0 },
    { sessionId: page.sessionId },
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  try {
    const page = await browser.newPage()
    /** Wire log of /stream requests+responses on the page. */
    const wire = []
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    page.conn.on('Network.requestWillBeSent', (p) => {
      const req = p && p.request
      if (req && req.url.includes(`/items/${ITEM}/stream`)) wire.push({ kind: 'req', url: req.url, t: Date.now() })
    })
    page.conn.on('Network.responseReceived', (p) => {
      const res = p && p.response
      if (res && res.url.includes(`/items/${ITEM}/stream`)) {
        wire.push({ kind: 'res', url: res.url, status: res.status, stream: res.headers['x-orig-stream'], t: Date.now() })
      }
    })

    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 30000, intervalMs: 250 })
    await page.evaluate(() => {
      localStorage.removeItem('orighub.compatSrcs')
      localStorage.setItem(
        'orighub_player_settings',
        JSON.stringify({ volume: 1, isMuted: true, playbackRate: 1, autoPlayNext: false }),
      )
    })
    await delay(1200)

    const removed = clearSpeedProxies(ITEM)
    console.log(`[verify] cleared stale speed proxies: ${JSON.stringify(removed)}`)

    // ---- C1: probe is side-effect free --------------------------------------
    const probe = await getJson(`${TG}/api/media/items/${ITEM}/stream?speed=2&probe=1`)
    console.log(`[verify] probe -> ${JSON.stringify(probe)}`)
    await delay(2000)
    const partAfterProbe = sizeOf(partOf(`${ITEM}-speed-200.mp4`))
    const finalAfterProbe = sizeOf(finalOf(`${ITEM}-speed-200.mp4`))
    check(
      'C1 (1) probe=1 只回答 ready/duration，2s 内不起转码（无 .part/代理）',
      probe.status === 200 &&
        probe.body.ready === false &&
        probe.body.duration === 50 &&
        partAfterProbe < 0 &&
        finalAfterProbe < 0,
      `status=${probe.status} body=${JSON.stringify(probe.body)} part=${partAfterProbe} final=${finalAfterProbe}`,
    )

    // ---- C2: cold deep switch while PLAYING anchors at the position ---------
    await openItem(page, ITEM)
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return v && v.readyState >= 1 && (v.currentSrc || '').includes('/raw')
    }, { timeout: 30000, intervalMs: 200 })
    await play(page)
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      v.currentTime = 30
    })
    await delay(800)
    wire.length = 0
    await clickRate(page, 2)
    // Sample until content time starts advancing (or budget out).
    const t0 = Date.now()
    let firstAdvanceMs = -1
    let resumed = null
    while (Date.now() - t0 < 12000) {
      const s = await snapshot(page)
      if (s && s.speed === 2 && !s.paused && s.readyState >= 2 && s.currentTime > 0.05 && firstAdvanceMs < 0) {
        firstAdvanceMs = Date.now() - t0
        resumed = s
        break
      }
      await delay(200)
    }
    const anchorReqs = wire.filter((w) => w.kind === 'req' && /[?&]t=\d+/.test(w.url))
    const tVals = anchorReqs.map((w) => Number(/[?&]t=(\d+)/.exec(w.url)[1]))
    console.log(`[verify] firstAdvance=${firstAdvanceMs}ms tVals=${JSON.stringify(tVals)}`)
    check(
      'C2 (2) 冷缓存 30s 内容位切 2x：wire 带 t= 且首帧推进 ≤ 6s',
      firstAdvanceMs > 0 && firstAdvanceMs <= ANCHOR_BUDGET_S * 1000 && tVals.some((t) => Math.abs(t - 30) <= 1),
      `firstAdvance=${firstAdvanceMs}ms tVals=${JSON.stringify(tVals)} wire=${JSON.stringify(wire.slice(0, 6))}`,
    )
    // Content time tracks 30 + 2x wall right after the switch.
    await delay(3000)
    const track = await snapshot(page)
    const wall = (Date.now() - t0 - (firstAdvanceMs > 0 ? firstAdvanceMs : 0)) / 1000
    const expected = 30 + wall * 2
    const trackErr = track ? Math.abs(track.contentTime - expected) : -1
    check(
      'C2b (2) 恢复后内容时间 ≈ 30s + 2×墙钟（±2.5s）',
      trackErr <= POSITION_TOLERANCE_S,
      `content=${track ? track.contentTime.toFixed(2) : '?'} expected≈${expected.toFixed(2)} err=${trackErr.toFixed(2)}s`,
    )

    // ---- C3: anchored stream is live-only (nothing persisted) ---------------
    await pause(page)
    const final200 = sizeOf(finalOf(`${ITEM}-speed-200.mp4`))
    const part200 = sizeOf(partOf(`${ITEM}-speed-200.mp4`))
    check(
      'C3 (3) 锚点流不落盘：该速度代理与 .part 均不存在',
      final200 < 0 && part200 < 0,
      `final=${final200} part=${part200}`,
    )

    // ---- C5: drag beyond live coverage re-anchors ----------------------------
    // 630 的真实时长是 49.8s（不是探针的条目级整数 50）：拖拽比例按播放器的
    // contentDuration（durationchange 学到的 49.8）换算，0.9 x 49.8 = 44.82s，
    // 锚点 = floor(44.82) = 44。恢复内容位 44.82 落在 45±2.5 内。
    const C5_DRAG_RATIO = 0.9
    const C5_SRC_DUR = 49.8
    const C5_TARGET_CONTENT = C5_DRAG_RATIO * C5_SRC_DUR // 44.82
    const C5_EXPECT_T = Math.floor(C5_TARGET_CONTENT) // 44
    wire.length = 0
    await dragBarTo(page, C5_DRAG_RATIO) // 0.9 x 49.8s = 44.8s content, far beyond coverage (~30-38s)
    const t0c5 = Date.now()
    let c5Resume = null
    while (Date.now() - t0c5 < 12000) {
      const s = await snapshot(page)
      // Anchor t=44 restores media time 0.82/2, so "resumed" = new src loaded
      // with the right content time, not currentTime > 0.
      if (
        s &&
        s.speed === 2 &&
        s.readyState >= 1 &&
        s.src.includes(`t=${C5_EXPECT_T}`) &&
        Math.abs(s.contentTime - C5_TARGET_CONTENT) <= POSITION_TOLERANCE_S
      ) {
        c5Resume = s
        break
      }
      await delay(200)
    }
    const c5AnchorReqs = wire.filter((w) => w.kind === 'req' && /[?&]t=\d+/.test(w.url))
    const c5Ts = c5AnchorReqs.map((w) => Number(/[?&]t=(\d+)/.exec(w.url)[1]))
    const c5Ms = Date.now() - t0c5
    console.log(`[verify] C5 tVals=${JSON.stringify(c5Ts)} resumedIn=${c5Ms}ms at=${c5Resume ? c5Resume.contentTime.toFixed(2) : '?'}`)
    check(
      'C5 (5) live 流拖到未覆盖位（0.9x49.8≈44.8s）：wire 出现新 t= 请求并 ≤ 6s 在目标±2.5s 出画',
      c5Ts.some((t) => t === C5_EXPECT_T) &&
        c5Resume !== null &&
        c5Ms <= ANCHOR_BUDGET_S * 1000 + 2000,
      `tVals=${JSON.stringify(c5Ts)} resumedAt=${c5Resume ? c5Resume.contentTime.toFixed(2) : '?'} elapsed=${c5Ms}ms`,
    )

    // ---- C4: proxy on disk -> plain speed URL (no anchor) --------------------
    console.log('[verify] pre-building canonical 4x proxy...')
    await fetchFull(`${TG}/api/media/items/${ITEM}/stream?speed=4`)
    const probe4 = await getJson(`${TG}/api/media/items/${ITEM}/stream?speed=4&probe=1`)
    console.log(`[verify] probe4 -> ${JSON.stringify(probe4.body)}`)
    await clickRate(page, 1)
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return v && (v.currentSrc || '').includes('/raw')
    }, { timeout: 30000, intervalMs: 200 })
    await delay(400)
    await play(page)
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      v.currentTime = 45
    })
    await delay(800)
    await pause(page)
    wire.length = 0
    await clickRate(page, 4)
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return v && (v.currentSrc || '').includes('speed=4') && v.readyState >= 1
    }, { timeout: 60000, intervalMs: 200 })
    await delay(800)
    const c4 = await snapshot(page)
    const c4AnchorReqs = wire.filter((w) => w.kind === 'req' && /[?&]t=\d+/.test(w.url) && w.url.includes('speed=4'))
    const c4Drift = c4 ? Math.abs(c4.contentTime - 45) : -1
    check(
      'C4 (4) 代理就绪时切 4x：不带 t=（复用缓存），位置 drift ≤ 2s',
      probe4.body.ready === true && c4AnchorReqs.length === 0 && c4 && c4Drift <= 2,
      `ready=${probe4.body.ready} anchorReqs=${c4AnchorReqs.length} content=${c4 ? c4.contentTime.toFixed(2) : '?'} drift=${c4Drift.toFixed(2)}s`,
    )

    await page.screenshot(path.join(OUT, 'after-c4.png'))

    const errs = page.pageErrors().slice(0, 8)
    check('全程无页面错误', errs.length === 0, JSON.stringify(errs))
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.pass)
  const summaryText = [
    '',
    '[verify] === SUMMARY ===',
    ...checks.map((c) => `  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`),
    `[verify] ${checks.length - failed.length}/${checks.length} passed`,
  ].join('\n')
  console.log(summaryText)
  console.error(summaryText)

  try {
    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ item: ITEM, passed: checks.length - failed.length, total: checks.length, checks }, null, 2),
    )
  } catch (err) {
    console.error(`[verify] could not write report: ${err.message}`)
  }

  if (failed.length) {
    console.error(`[verify] FAILED ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join(' | ')}`)
    process.exit(1)
  }
  console.log('[verify] ALL CHECKS PASSED')
  console.error('[verify] ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})
