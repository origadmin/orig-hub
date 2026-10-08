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
 *
 * ## Two mutually exclusive modes (EXPECT_COMPAT_STREAM)
 *
 * BUG-224 has two *opposite* acceptance targets, so the wire-log criterion is
 * parameterized. Picking the wrong mode is the most likely misuse of this
 * script, hence the table:
 *
 * | mode                                | correct for                | wire log must show         |
 * |-------------------------------------|----------------------------|----------------------------|
 * | `EXPECT_COMPAT_STREAM=1` (default)  | sources the browser REJECTS | `/stream` requested         |
 * | `EXPECT_COMPAT_STREAM=0`            | sources the browser PLAYS  | only `/raw`, never `/stream`|
 *
 *   - mode 1, e.g. **item 395** (MPEG-TS masquerading as .mp4, `format_name=mpegts`):
 *     the container cannot be demuxed, `error.code=4` within ~1.5s, and the
 *     server compatibility stream is the only way to get pictures at all.
 *   - mode 0, e.g. **item 415** (HEVC/hvc1 in .mov, ffprobe 189.61s): this
 *     browser decodes it natively (first frame 0.63s, videoWidth 720). Switching
 *     to the compatibility stream here is the *bug*, not the fix -- it costs a
 *     real-time transcode and reports a bogus short duration.
 *
 * Mode 0 additionally pins two facts nothing else guarded: the element reports
 * the FULL source duration (189.61s for 415), which is what rules out the
 * compatibility stream's ~8s figure, and `videoWidth > 0` with an advancing
 * playhead, which distinguishes "decoding on screen" from "waiting on black".
 *
 * Env: PROBE_ITEM, PROBE_WATCH_MS, EXPECT_COMPAT_STREAM,
 *      PROBE_EXPECT_DURATION (source seconds; needed by mode 0),
 *      PROBE_SHOT_DIR.
 */

const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = process.env.PROBE_ITEM || '395'
const WATCH_MS = Number(process.env.PROBE_WATCH_MS || 30000)
/**
 * Which behaviour this run asserts. See the mode table in the header.
 * Default 1 keeps the historical semantics ("an undecodable source must be
 * handed to /stream"); mode 0 is its exact opposite and is the ONLY correct
 * setting for a source this browser already plays.
 */
const EXPECT_COMPAT_STREAM = process.env.EXPECT_COMPAT_STREAM !== '0'
/**
 * Full source duration in seconds, required by mode 0.
 *
 * Deliberately NOT defaulted per item: a hardcoded table would quietly pass for
 * a known id while leaving every other id unchecked, which is the same
 * always-green trap the criterion exists to close. In mode 0 an unknown item
 * must fail loudly and say what to pass.
 */
const EXPECT_DURATION = Number(process.env.PROBE_EXPECT_DURATION || NaN)
/** Mode 0 tolerance: +/-1% of the source duration. */
const DURATION_TOLERANCE = 0.01
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
  let offNetwork = null
  try {
    const page = await browser.newPage()
    await page.goto(APP, { rootSelector: '#root' })
    // The media library mounts 100+ covers and starts polling on load; give the
    // React tree and its 5s pollers time to settle before injecting.
    await page.waitForFunction(() => Boolean(window.__origStore), { timeout: 60000, intervalMs: 250 })
    await delay(4000)

    // `cdp.cjs` dispatches CDP events with `msg.params` already unwrapped, so the
    // handler receives the params object directly -- `p.params.request.url` is
    // always undefined and would silently leave `requests` empty.
    if (page.conn && typeof page.conn.send === 'function') {
      await page.conn.send('Network.enable', {}, { sessionId: page.sessionId }).catch(() => {})
      offNetwork = page.conn.on('Network.requestWillBeSent', (p) => {
        const url = p && p.request && p.request.url
        if (url && /\/api\/media\/items\//.test(url)) requests.push(url)
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
    out.mode = EXPECT_COMPAT_STREAM ? 'expect-compat-stream' : 'expect-raw-only'
    const fs = require('fs')
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const shot = `${SHOT_DIR}/app-play-item-${ITEM}${EXPECT_COMPAT_STREAM ? '' : '-raw-only'}.png`
    await page.screenshot(shot)
    out.screenshot = shot
    console.log(JSON.stringify(out, null, 2))

    /*
     * Verdict, common to both modes: no mask, a real decoded frame, no media
     * error, and the playhead moved. The wire log decides *which source* was
     * acceptable -- a video element reporting `videoWidth > 0` alone could come
     * from a stale source, so the URL evidence is the part with teeth.
     */
    const f = out.final || {}
    const streamUrls = out.requests.filter((u) => /\/api\/media\/items\/\d+\/stream/.test(u))
    const rawUrls = out.requests.filter((u) => /\/api\/media\/items\/\d+\/raw/.test(u))
    const checks = [
      ['no fatal mask', f.fatal === false, String(f.fatalText)],
      ['no halted mask', f.halted === false, String(f.haltedText)],
      ['element reports a decoded frame', f.videoWidth > 0, `videoWidth=${f.videoWidth}`],
      ['element is not errored', f.error === null, String(f.error)],
      ['playhead advanced', typeof f.currentTime === 'number' && f.currentTime > 1, `currentTime=${f.currentTime}`],
    ]

    if (EXPECT_COMPAT_STREAM) {
      // Mode 1: the browser rejects this source, so /stream MUST be requested.
      checks.push([
        'wire log shows the compatibility stream was requested',
        streamUrls.length > 0,
        out.requests.join(' | ') || '(no requests captured)',
      ])
    } else {
      /*
       * Mode 0: this browser decodes the source natively, so requesting /stream
       * is itself the defect -- it triggers a real-time transcode and replaces a
       * 189.61s timeline with a ~8s one. Assert the ABSENCE of /stream, and
       * require /raw to have actually been fetched (absence of /stream alone
       * would also be satisfied by a player that requested nothing at all).
       */
      checks.push([
        'wire log shows NO compatibility stream was requested',
        streamUrls.length === 0,
        streamUrls.join(' | ') || '(none, as required)',
      ])
      checks.push([
        'wire log shows the original /raw source was fetched',
        rawUrls.length > 0,
        rawUrls.join(' | ') || '(no /raw captured)',
      ])

      if (Number.isFinite(EXPECT_DURATION) && EXPECT_DURATION > 0) {
        const drift = Math.abs(f.duration - EXPECT_DURATION) / EXPECT_DURATION
        checks.push([
          `duration is the full source duration (${EXPECT_DURATION}s +/-1%), not the compat stream's short one`,
          typeof f.duration === 'number' && f.duration > 0 && drift <= DURATION_TOLERANCE,
          `duration=${f.duration}s drift=${(drift * 100).toFixed(2)}%`,
        ])
      } else {
        // Fail rather than skip: a silently skipped duration check is exactly
        // the hole this mode was added to close.
        checks.push([
          'duration checked against the full source duration',
          false,
          `PROBE_EXPECT_DURATION not set (item ${ITEM}); pass the ffprobe duration in seconds`,
        ])
      }

      // Native decode must be visibly on screen and progressing, not a paused
      // black frame that merely reports a non-zero videoWidth.
      checks.push([
        'native playback is on screen and progressing (frames decoded)',
        typeof f.totalFrames === 'number' && f.totalFrames > 0 && f.currentTime > 1 && f.paused === false,
        `videoWidth=${f.videoWidth} totalFrames=${f.totalFrames} currentTime=${f.currentTime} paused=${f.paused}`,
      ])
    }

    const failed = checks.filter((c) => !c[1])
    for (const c of checks) console.log(`${c[1] ? 'PASS' : 'FAIL'} ${c[0]}${c[2] ? '  <- ' + c[2] : ''}`)
    console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
    if (failed.length) process.exit(1)
  } finally {
    if (typeof offNetwork === 'function') offNetwork()
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})