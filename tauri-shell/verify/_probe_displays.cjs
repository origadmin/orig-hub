'use strict'

/**
 * Enumerate the displays this machine actually exposes, and the refresh rate each one
 * really composites at.
 *
 * Why: `Win32_VideoController` claims the Intel adapter is running 2560x1440 @ 165Hz
 * while the NVIDIA one is 1920x1080 @ 60Hz, and `WmiMonitorID` lists three panels
 * (SGT3200 / CMN152A / VSCAD33). But our probe window measured `screen = 2560x1080`
 * and rAF = exactly 60.0Hz. So at least one active display is 60Hz -- and the 165Hz
 * one, if it is real and reachable, is the single highest-leverage fix for 2x/4x
 * judder: 2x of a 60fps source needs 120fps, 4x of a 30fps source needs 120fps, both
 * of which fit inside 165Hz but not inside 60Hz.
 *
 * Method: move the same browser window across the virtual desktop and, at each
 * position, read which screen it landed on plus the actual rAF cadence. No guessing
 * from WMI.
 *
 * ONE browser launch.
 */

const cdp = require('./lib/cdp.cjs')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const POSITIONS = [
  [0, 0],
  [2560, 0],
  [1920, 0],
  [3840, 0],
  [0, 1080],
  [0, 1440],
  [-2560, 0],
]

const RAF = () =>
  new Promise((resolve) => {
    const ts = []
    const t0 = performance.now()
    function tick(t) {
      ts.push(t)
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick)
      else {
        const d = []
        for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1])
        d.sort((a, b) => a - b)
        const sum = d.reduce((a, b) => a + b, 0)
        resolve({
          frames: ts.length,
          avgMs: d.length ? +(sum / d.length).toFixed(2) : null,
          medianMs: d.length ? +d[Math.floor(d.length / 2)].toFixed(2) : null,
          minMs: d.length ? +d[0].toFixed(2) : null,
          maxMs: d.length ? +d[d.length - 1].toFixed(2) : null,
          screenW: window.screen.width,
          screenH: window.screen.height,
          availW: window.screen.availWidth,
          availH: window.screen.availHeight,
          screenLeft: window.screenLeft,
          screenTop: window.screenTop,
          isExtended: window.screen.isExtended,
        })
      }
    }
    requestAnimationFrame(tick)
  })

async function main() {
  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank', { waitForRoot: false, settleMs: 300 })
    await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId })
    await delay(500)

    let winId = null
    try {
      const w = await page.conn.send('Browser.getWindowForTarget', {}, { sessionId: page.sessionId })
      winId = w && w.windowId
    } catch (_e) {
      /* fall through */
    }
    console.log('[display] windowId =', winId)

    const seen = new Map()
    for (const [left, top] of POSITIONS) {
      if (winId != null) {
        try {
          await page.conn.send(
            'Browser.setWindowBounds',
            { windowId: winId, bounds: { left, top, width: 1440, height: 900, windowState: 'normal' } },
            { sessionId: page.sessionId },
          )
        } catch (e) {
          console.log(`  move to (${left},${top}) failed: ${e.message}`)
          continue
        }
      }
      await delay(900)
      await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
      await delay(300)
      let r
      try {
        r = await page.evaluate(RAF)
      } catch (e) {
        console.log(`  (${left},${top}) sample failed: ${e.message}`)
        continue
      }
      const hz = r.avgMs ? +(1000 / r.avgMs).toFixed(1) : null
      console.log(
        `  asked(${left},${top}) -> screen=${r.screenW}x${r.screenH} avail=${r.availW}x${r.availH} ` +
          `winAt=(${r.screenLeft},${r.screenTop}) extended=${r.isExtended} ` +
          `rAF avg=${r.avgMs}ms med=${r.medianMs} min=${r.minMs} max=${r.maxMs} => ${hz}Hz`,
      )
      const key = `${r.screenW}x${r.screenH}@${hz}`
      if (!seen.has(key)) seen.set(key, { left, top })
    }

    console.log('\n=== distinct display signatures ===')
    for (const [k, v] of seen) console.log(`  ${k}  (first seen when asked to move to ${v.left},${v.top})`)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
