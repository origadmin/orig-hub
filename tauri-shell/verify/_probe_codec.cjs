'use strict'

/**
 * Decisive probe: does this Chromium hardware-decode HEVC / H.264?
 *
 * `MediaCapabilities.decodingInfo()` is the browser's own answer, and it is the only
 * one that matters -- `powerEfficient: true` means hardware decode, `false` means the
 * frames are produced on the CPU. That single bit decides whether a 10 Mbps HEVC
 * source can sustain 2x/4x, or whether only the H.264 compat stream can.
 *
 * One headful launch, no page load, ~5s.
 */

const cdp = require('./lib/cdp.cjs')

const CASES = [
  ['hevc 720p60 11.8Mbps (2403-media.mp4)', 'video/mp4; codecs="hev1.1.6.L120.90"', 1280, 720, 11828294, 60],
  ['hevc 720p60 @2x demand 120fps', 'video/mp4; codecs="hev1.1.6.L120.90"', 1280, 720, 11828294, 120],
  ['hevc 720p60 @4x demand 240fps', 'video/mp4; codecs="hev1.1.6.L120.90"', 1280, 720, 11828294, 240],
  ['hevc 1080p30 10.2Mbps (2895 EP6)', 'video/mp4; codecs="hev1.1.6.L120.90"', 1920, 1080, 10192915, 30],
  ['hevc 1080p30 @2x demand 60fps', 'video/mp4; codecs="hev1.1.6.L120.90"', 1920, 1080, 10192915, 60],
  ['hevc 1080p30 @4x demand 120fps', 'video/mp4; codecs="hev1.1.6.L120.90"', 1920, 1080, 10192915, 120],
  ['h264 1080p30 2.9Mbps (2375-media.mp4)', 'video/mp4; codecs="avc1.640028"', 1920, 1080, 2902971, 30],
  ['h264 1080p30 @4x demand 120fps', 'video/mp4; codecs="avc1.640028"', 1920, 1080, 2902971, 120],
  ['h264 1080p30 6Mbps (compat target)', 'video/mp4; codecs="avc1.640028"', 1920, 1080, 6000000, 30],
]

async function main() {
  const browser = await cdp.launch({ headless: false })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank', { waitForRoot: false, settleMs: 300 })
    await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId })
    await new Promise((r) => setTimeout(r, 300))

    const results = await page.evaluate(async (cases) => {
      const out = []
      for (const [label, contentType, width, height, bitrate, framerate] of cases) {
        let r
        try {
          r = await navigator.mediaCapabilities.decodingInfo({
            type: 'file',
            video: { contentType, width, height, bitrate, framerate },
          })
        } catch (e) {
          r = { error: String(e && e.message) }
        }
        out.push({
          label,
          supported: r.supported,
          smooth: r.smooth,
          powerEfficient: r.powerEfficient,
          error: r.error,
        })
      }
      return out
    }, CASES)

    for (const r of results) {
      const tag = r.powerEfficient === true ? 'HW' : r.powerEfficient === false ? 'SW' : '??'
      console.log(
        `${r.powerEfficient === true ? '硬解' : r.powerEfficient === false ? '软解' : '未知'} | ` +
          `supported=${r.supported} smooth=${r.smooth} | ${r.label}` +
          (r.error ? ` (err ${r.error})` : '')
      )
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
