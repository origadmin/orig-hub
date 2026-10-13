'use strict'

/**
 * Minimal, single-launch probe: what refresh rate does a *headful, GPU-composited*
 * browser actually get on this machine?
 *
 * Why: the earlier "display is 60Hz" conclusion may be an artifact of BUG-213 --
 * `cdp.launch` used to force `--disable-gpu` in BOTH branches, so the probe ran on
 * software compositing, which caps rAF at 60Hz. Windows reports the panel at 165Hz.
 * This probe must distinguish "panel really is 60Hz" from "our probe was capped".
 *
 * One browser, ~5s, no page load (about:blank), then exits.
 */

const cdp = require('./lib/cdp.cjs')

async function main() {
  const browser = await cdp.launch({ headless: false })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank', { waitForRoot: false, settleMs: 300 })
    // rAF 在后台/被遮挡的页面会被节流甚至完全停摆 —— 必须先提到前台。
    await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId })
    await new Promise((r) => setTimeout(r, 400))

    const info = await page.evaluate(() => {
      const out = {
        ua: navigator.userAgent,
        headless: /HeadlessChrome/.test(navigator.userAgent),
        dpr: window.devicePixelRatio,
        screenW: window.screen.width,
        screenH: window.screen.height,
        availW: window.screen.availWidth,
        availH: window.screen.availHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        webgl: 'n/a',
      }
      try {
        const c = document.createElement('canvas')
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info')
          out.webgl = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
        } else {
          out.webgl = 'no-webgl-context'
        }
      } catch (e) {
        out.webgl = 'err:' + String(e && e.message)
      }
      return out
    })

    // Measure rAF cadence for ~3s.
    const raf = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ts = []
          const t0 = performance.now()
          function tick(t) {
            ts.push(t)
            if (performance.now() - t0 < 3000) {
              requestAnimationFrame(tick)
            } else {
              const d = []
              for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1])
              d.sort((a, b) => a - b)
              const sum = d.reduce((a, b) => a + b, 0)
              resolve({
                frames: ts.length,
                durationMs: Math.round(performance.now() - t0),
                avgMs: d.length ? +(sum / d.length).toFixed(2) : null,
                medianMs: d.length ? +d[Math.floor(d.length / 2)].toFixed(2) : null,
                p95Ms: d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * 0.95))].toFixed(2) : null,
                minMs: d.length ? +d[0].toFixed(2) : null,
                maxMs: d.length ? +d[d.length - 1].toFixed(2) : null,
              })
            }
          }
          requestAnimationFrame(tick)
        })
    )

    const hz = raf.avgMs ? +(1000 / raf.avgMs).toFixed(1) : null
    console.log(JSON.stringify({ info, raf, hz }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
