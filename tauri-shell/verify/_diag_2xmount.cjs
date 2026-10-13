'use strict'
const cdp = require('./lib/cdp.cjs')
const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = 673
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch({
    headless: false,
    args: ['--disable-features=CalculateNativeWinOcclusion,MediaSuspend', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required'],
  })
  const errs = []
  try {
    const page = await browser.newPage()
    page.on && page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
    page.on && page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message))
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    setInterval(bring, 2000)

    await page.evaluate((it) => {
      window.__origStore.getState().openViewer({
        items: [{ key: `media-${it}`, chatId: 0, messageId: it, kind: 'video', caption: '', description: null, src: `http://127.0.0.1:19787/api/media/items/${it}/raw`, poster: null, episodeNo: null, seriesId: null }],
        index: 0, title: '',
      })
    }, ITEM)

    console.log('t(s) | readyState | vw | ct | bufEnd | cs | src(tail) | decode')
    for (let i = 0; i < 30; i++) {
      const s = await page.evaluate(() => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return { none: true }
        let bufEnd = null
        try { if (v.buffered.length) bufEnd = +(v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) } catch (_e) {}
        return {
          rs: v.readyState,
          vw: v.videoWidth,
          ct: +v.currentTime.toFixed(2),
          bufEnd,
          cs: v.dataset?.contentSpeed || '?',
          src: (v.currentSrc || v.src || '').split('/').slice(-2).join('/'),
          muted: v.muted,
        }
      }).catch((e) => ({ err: String(e) }))
      if (s.none) console.log(`${i} | NO VIDEO ELEMENT`)
      else console.log(`${i} | ${s.rs} | ${s.vw} | ${s.ct} | ${s.bufEnd} | cs=${s.cs} | ${s.src} | muted=${s.muted}`)
      await delay(1000)
    }
    console.log('\n=== console errors (' + errs.length + ') ===')
    errs.slice(0, 20).forEach((e) => console.log(' - ' + e))
  } finally {
    await browser.close()
  }
}
main().catch((e) => { console.error('DIAG_FAILED', e && e.stack ? e.stack : e); process.exit(1) })
