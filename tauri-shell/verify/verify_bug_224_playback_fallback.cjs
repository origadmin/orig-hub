'use strict'

/**
 * BUG-224 app-level probe: reproduce what the user actually sees when playing a
 * HEVC entry from the media library, in the real app (vite dev on :5180,
 * real MediaViewer, real localStorage compat memory).
 *
 * Already measured before this probe:
 *   - 30 of 138 video entries are HEVC/hvc1; 108 are H.264.
 *   - `GET /api/media/items/415/raw` plays in this browser: first frame at
 *     0.63s, videoWidth 720, readyState 4. `673` (1080p HEVC) at 0.92s.
 *     => the local Chromium CAN decode these files.
 *   - `.../stream` answers 200 `x-orig-stream: live`, first byte 2.44s,
 *     1.05 MB/s, and the browser sees a ~8s duration instead of 189s.
 *
 * So the failure the user reports cannot be "this machine cannot decode HEVC".
 * This probe reports which mask the app actually shows, which URL the element
 * is really playing, and whether the BUG-208 localStorage memory hijacked the
 * source before playback even started.
 */

const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = process.env.PROBE_ITEM || '395'
const WATCH_MS = Number(process.env.PROBE_WATCH_MS || 30000)
/** Evidence lands in the git-ignored `verify_shots/`, resolved from this file. */
const SHOT_DIR =
  process.env.PROBE_SHOT_DIR || path.join(__dirname, '..', '..', 'verify_shots', 'bug-224')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function snapshot(page, tag) {
  return page.evaluate((t) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const halt = document.querySelector('[data-testid="player-unsupported-halt"]')
    const fatalMask = Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
      /decodeFail|系统播放器|HEVC|解码/i.test(el.textContent || ''),
    )
    return {
      tag: t,
      videoPresent: Boolean(v),
      currentSrc: v ? v.currentSrc : null,
      videoWidth: v ? v.videoWidth : 0,
      videoHeight: v ? v.videoHeight : 0,
      readyState: v ? v.readyState : -1,
      currentTime: v ? Number(v.currentTime.toFixed(2)) : -1,
      duration: v && isFinite(v.duration) ? Number(v.duration.toFixed(2)) : -1,
      paused: v ? v.paused : null,
      error: v && v.error ? `${v.error.code}:${v.error.message || ''}` : null,
      totalFrames: v
        ? (() => {
            try {
              const q = v.getVideoPlaybackQuality()
              return q ? q.totalVideoFrames : -1
            } catch (_e) {
              return -1
            }
          })()
        : -1,
      halted: Boolean(halt),
      haltedText: halt ? (halt.textContent || '').trim() : null,
      fatal: Boolean(fatalMask),
      fatalText: fatalMask ? (fatalMask.textContent || '').trim() : null,
      compatMemory: (() => {
        try {
          return JSON.parse(localStorage.getItem('orighub.compatSrcs') || '[]')
        } catch (_e) {
          return 'unreadable'
        }
      })(),
    }
  }, tag)
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const requests = []
  try {
    const page = await browser.newPage()
    await page.goto(APP, { rootSelector: '#root' })
    // The media library mounts 100+ covers and starts polling on load; give the
    // React tree and its 5s pollers time to settle before injecting.
    await page.waitForFunction(() => Boolean(window.__origStore), { timeout: 60000, intervalMs: 250 })
    await delay(4000)
    const cdpConn = page.conn || null
    if (cdpConn && typeof cdpConn.on === 'function') {
      cdpConn.on('Network.requestWillBeSent', (p) => {
        if (p.params && p.params.request && /\/api\/media\/items\//.test(p.params.request.url)) {
          requests.push(p.params.request.url)
        }
      })
    }

    const out = { item: ITEM, timeline: [] }
    out.timeline.push(await snapshot(page, 'before-open'))

    await page.evaluate(
      (id, tg) => {
        window.__origStore.getState().openViewer({
          items: [
            {
              key: `media-${id}`,
              chatId: 0,
              messageId: Number(id),
              kind: 'video',
              caption: 'BUG-224 probe',
              src: `${tg}/api/media/items/${id}/raw`,
              poster: null,
              seriesId: null,
            },
          ],
          index: 0,
          title: 'BUG-224 probe',
        })
      },
      ITEM,
      TG,
    )

    const deadline = Date.now() + WATCH_MS
    let last = null
    while (Date.now() < deadline) {
      await delay(1500)
      last = await snapshot(page, `t=${((WATCH_MS - (deadline - Date.now())) / 1000).toFixed(1)}s`)
      out.timeline.push(last)
      if (last.halted || last.fatal) break
    }

    out.final = last
    out.requests = Array.from(new Set(requests))
    const fs = require('fs')
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const shot = `${SHOT_DIR}/app-play-item-${ITEM}.png`
    await page.screenshot(shot)
    out.screenshot = shot
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})