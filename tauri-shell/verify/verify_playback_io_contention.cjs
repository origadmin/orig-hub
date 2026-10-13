'use strict'

/**
 * BUG-219 validation — playback vs cache-write disk I/O contention (REAL app, single session).
 *
 * The previous browser benchmarks were invalid (wrong 50fps proxy content, headless MediaSuspend
 * disabled, mostly bare <video> with no app overhead). This one measures the REAL app:
 *
 *   1. open the real VideoPlayer on ITEM at RATE (toolbar asserted hidden first)
 *   2. phase BASELINE : no disk write      -> droppedVideoFrames ratio + decode fps
 *   3. phase WRITE    : start a sustained sequential write to the SAME volume (C:, via os.tmpdir)
 *                       -> measure again (simulates cache .part landing + rename-to-library)
 *   4. phase RECOVER  : stop the write     -> measure again (should drop back)
 *
 * If droppedRatio spikes in WRITE and recovers in RECOVER, the volume-level I/O contention root
 * cause is confirmed. We also probe /raw read throughput with a ranged GET during each phase as a
 * backend-side cross-check.
 *
 * Env: ITEM=472  RATE=4  SAMPLE_MS=8000
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const ITEM = Number(process.env.ITEM || 472)
const RATE = Number(process.env.RATE || 4)
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 8000)
const WARMUP_MS = 4500

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- sustained same-volume write (simulates cache landing + rename) ----
const WRITE_PATH = path.join(os.tmpdir(), 'orighub-io-contention-test.bin')
const CHUNK = Buffer.alloc(1024 * 1024, 0xab)
let writing = false
let writeBytes = 0
let writeStream = null
async function startWrite() {
  writing = true
  writeBytes = 0
  try {
    writeStream = fs.createWriteStream(WRITE_PATH)
    while (writing) {
      await new Promise((res, rej) => writeStream.write(CHUNK, (e) => (e ? rej(e) : res())))
      writeBytes += CHUNK.length
    }
  } catch (_e) {
    /* ignore */
  }
}
function stopWrite() {
  writing = false
  try {
    if (writeStream) writeStream.end()
  } catch (_e) {}
}

// ---- backend /raw read throughput (ranged GET) ----
async function rawThroughputMBps() {
  const t0 = Date.now()
  try {
    const r = await fetch(`${TG}/api/media/items/${ITEM}/raw`, { headers: { Range: 'bytes=0-67108863' } })
    if (!r.ok && r.status !== 206) return null
    const buf = Buffer.alloc(0)
    let got = 0
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
    }
    const secs = (Date.now() - t0) / 1000
    return +(got / 1024 / 1024 / secs).toFixed(1)
  } catch (_e) {
    return null
  }
}

const MEASURE = async (vsel, rsel, rate, warmMs, sampleMs) => {
  const v = document.querySelector(vsel)
  const root = document.querySelector(rsel)
  if (!v) return { ok: false, error: 'no video' }
  v.muted = true
  v.volume = 0
  v.playbackRate = rate
  try {
    await v.play()
  } catch (e) {
    return { ok: false, error: 'play: ' + String((e && e.message) || e) }
  }
  await new Promise((r) => setTimeout(r, warmMs))
  // assert toolbar hidden
  const tb = document.querySelector('[data-testid="media-viewer"] [role="toolbar"]')
  const cs = tb ? getComputedStyle(tb) : null
  if (!tb || cs.display !== 'none') return { ok: false, assertFailed: true, reason: 'toolbar not hidden', disp: cs && cs.display }
  const q0 = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null
  const t0 = performance.now()
  await new Promise((r) => setTimeout(r, sampleMs))
  const wall = (performance.now() - t0) / 1000
  const q1 = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null
  const total = q1 && q0 ? q1.totalVideoFrames - q0.totalVideoFrames : null
  const dropped = q1 && q0 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null
  return {
    ok: true,
    wall: +wall.toFixed(1),
    decodeRate: total != null && wall > 0 ? +((total) / wall).toFixed(1) : null,
    dropped,
    total,
    droppedRatio: total != null && total > 0 ? +(dropped / total).toFixed(3) : null,
  }
}

async function openApp(page, url) {
  await page.evaluate(
    (u, it) => {
      window.__origStore.getState().openViewer({
        items: [{ key: `media-${it}`, chatId: 0, messageId: it, kind: 'video', caption: '', description: null, src: u, poster: null, episodeNo: null, seriesId: null }],
        index: 0,
        title: '',
      })
    },
    url,
    ITEM,
  )
  await page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 25000, intervalMs: 250 },
  )
}

async function main() {
  console.log(`IO CONTENTION VALIDATION: ITEM=${ITEM} RATE=${RATE} SAMPLE_MS=${SAMPLE_MS} writePath=${WRITE_PATH}`)
  console.log('NOTE: ITEM 472 is a 50fps proxy; the contention theory is fps-agnostic (volume-level), but user content is 30fps — treat droppedRatio delta as the signal.')

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
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    await openApp(page, `${TG}/api/media/items/${ITEM}/raw?rep=${Date.now()}`)

    const run = async (label, doWrite) => {
      if (doWrite) startWrite()
      await delay(1200)
      const rawMbps = await rawThroughputMBps()
      const m = await page.evaluate(MEASURE, '[data-testid="media-viewer"] video', '[data-testid="media-viewer"]', RATE, 0, SAMPLE_MS)
      if (doWrite) stopWrite()
      console.log(
        `${label.padEnd(9)} app: ok=${m.ok} decodeRate=${m.decodeRate} dropped=${m.dropped} total=${m.total} dropRatio=${m.droppedRatio} | /raw read=${rawMbps} MB/s`,
      )
      return { m, rawMbps }
    }

    const base = await run('BASELINE', false)
    await delay(2000)
    const wr = await run('WRITE', true)
    await delay(2500)
    const rec = await run('RECOVER', false)

    clearInterval(keep)

    // verdict
    const b = base.m.droppedRatio
    const w = wr.m.droppedRatio
    const r = rec.m.droppedRatio
    console.log('\n=== CONTENTION VERDICT ===')
    console.log(`baseline dropRatio=${b}  write dropRatio=${w}  recover dropRatio=${r}`)
    const spiked = w != null && b != null && w - b > 0.1
    console.log(spiked ? `CONFIRMED: disk write causes playback drop spike (Δ=${+(w - b).toFixed(3)})` : 'NOT CONFIRMED: no drop spike under write (contention not reproduced here)')
    console.log(`/raw read MB/s: baseline=${base.rawMbps} write=${wr.rawMbps} recover=${rec.rawMbps}`)
    if (base.rawMbps && wr.rawMbps) {
      const drop = +(((base.rawMbps - wr.rawMbps) / base.rawMbps) * 100).toFixed(0)
      console.log(`/raw read degraded ${drop}% during write ${drop > 20 ? '(CONFIRMS backend stall)' : '(minor)'}`)
    }
    console.log('\nJSON ' + JSON.stringify({ base, wr, rec }))
  } finally {
    try {
      fs.unlinkSync(WRITE_PATH)
    } catch (_e) {}
    await browser.close()
  }
}

main().catch((e) => {
  console.error('CONTENTION_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
