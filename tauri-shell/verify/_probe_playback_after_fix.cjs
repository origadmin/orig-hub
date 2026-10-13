'use strict'

/**
 * BUG-239 Task D (untracked): 抑制封面抽帧后，重测播放 `currentTime` 推进速率。
 *
 * 场景与用户复报一致：**媒体库网格仍挂载**（几十条无封面视频在队列里），在其上打开
 * 播放器播放一条真实视频，测 10s 窗口内 `currentTime` 推进 / 墙钟。
 *
 * 与修复前的对照：QA 早先实测「进入媒体库后播放」仅推进 **0.72×**。修复后，播放器挂载
 * 即 `setPosterExtractionPaused(true)`（让路门），封面抽帧不再启动 —— 本探针量化这一点。
 *
 * 夹具自造自删（复制库内最小视频到临时路径后登记），跑完精确删除。
 *
 *   node tauri-shell/verify/_probe_playback_after_fix.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = 'http://127.0.0.1:5180/'
const DAEMON = 'http://127.0.0.1:19786'
const N_FIX = 40
const SAMPLE_MS = 10000
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(method, url, body, timeoutMs = 15000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

async function main() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  const tgPort = cfg.json && cfg.json.tg_port
  if (!tgPort) throw new Error('cannot resolve tg_port')
  const TG = `http://127.0.0.1:${tgPort}`
  console.log(`[D] tg=${TG}`)

  const pre = await httpJson('GET', `${TG}/api/media/items?sort=recent&limit=120&offset=0`)
  const items = (pre.json && pre.json.items) || []
  // 播放用：一条**大**的真实视频（更有代表性）；夹具来源：最小的有字节视频
  const present = items.filter(
    (it) => it.kind === 'video' && it.bytesPresence === 'present' && it.absolutePath && (it.size || 0) > 0,
  )
  if (!present.length) throw new Error('no present video to play')
  present.sort((a, b) => (b.size || 0) - (a.size || 0))
  const playItem = present[0]
  const srcPath = present[present.length - 1].absolutePath
  console.log(`[D] play item=${playItem.id} size=${playItem.size} kind=${playItem.kind}`)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239rate-'))
  const specs = []
  for (let i = 0; i < N_FIX; i += 1) {
    const p = path.join(dir, `clip${i}.mp4`)
    fs.copyFileSync(srcPath, p)
    specs.push({ path: p, source: 'local', kind: 'video', title: `ZZ-BUG239-RATE-${i}` })
  }
  const cr = await httpJson('POST', `${TG}/api/media/items`, { items: specs }, 20000)
  const fixIds = (cr.json && cr.json.ids) || []
  console.log(`[D] fixtures=${fixIds.length}`)

  let browser = null
  try {
    browser = await cdp.launch({
      headless: false,
      args: [
        '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--autoplay-policy=no-user-gesture-required',
      ],
    })
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load', settleMs: 2000 })
    const bring = () => page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    const keep = setInterval(bring, 2000)

    // 进入媒体库 → 全部内容网格（网格保持挂载）
    await page.evaluate(() => document.querySelector('[data-testid="nav-media"]')?.click())
    await delay(1800)
    await page.evaluate(() => document.querySelector('[data-testid="media-cat-all"]')?.click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="media-card"]').length >= 60, {
      timeout: 25000,
    })
    await delay(3000) // 让首屏候选排入队列（修复下：仅可见的）

    // 打开一条真实视频（点击带封面按钮的卡片）
    const clicked = await page.evaluate((pid) => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      const el = cards.find((c) => Number(c.getAttribute('data-item-id')) === pid)
      const btn = (el && el.querySelector('button')) || null
      if (btn) {
        btn.click()
        return true
      }
      return false
    }, playItem.id)
    await page
      .waitForFunction(
        () => {
          const v = document.querySelector('[data-testid="media-viewer"] video')
          return !!v && v.videoWidth > 0 && v.readyState >= 2
        },
        { timeout: 30000, intervalMs: 250 },
      )
      .catch(() => undefined)
    await delay(1000)

    const res = await page.evaluate(
      async (ms) => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return { ok: false, error: 'no video element' }
        v.muted = true
        v.volume = 0
        try {
          await v.play()
        } catch (_e) {
          /* ignore */
        }
        const src0 = v.src
        const stamps = []
        let stopped = false
        const onFrame = () => {
          stamps.push(performance.now())
          if (!stopped) v.requestVideoFrameCallback(onFrame)
        }
        v.requestVideoFrameCallback(onFrame)
        const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
        const bDrop = q0 ? q0.droppedVideoFrames : 0
        const bTotal = q0 ? q0.totalVideoFrames : 0
        const lt = []
        let ltObs = null
        try {
          ltObs = new PerformanceObserver((l) => {
            for (const e of l.getEntries()) lt.push(Math.round(e.duration))
          })
          ltObs.observe({ entryTypes: ['longtask'] })
        } catch (_e) {
          /* unsupported */
        }
        const t0 = performance.now()
        const ct0 = v.currentTime
        await new Promise((r) => setTimeout(r, ms))
        const t1 = performance.now()
        const ct1 = v.currentTime
        stopped = true
        if (ltObs) ltObs.disconnect()
        const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
        const wall = (t1 - t0) / 1000
        const advanced = ct1 - ct0
        const gaps = []
        for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
        const raw = gaps.slice().sort((a, b) => a - b)
        const at = (p) => (raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * p))].toFixed(1) : null)
        let bufAhead = 0
        try {
          if (v.buffered.length) bufAhead = v.buffered.end(v.buffered.length - 1) - v.currentTime
        } catch (_e) {
          /* ignore */
        }
        return {
          ok: true,
          vw: v.videoWidth,
          vh: v.videoHeight,
          wall: +wall.toFixed(2),
          advanced: +advanced.toFixed(2),
          effRate: +(advanced / wall).toFixed(3),
          elemRate: v.playbackRate || 1,
          presentedFps: +(stamps.length / wall).toFixed(1),
          decodedFps: q1 ? +((q1.totalVideoFrames - bTotal) / wall).toFixed(1) : null,
          dropPct: q1 && q1.totalVideoFrames - bTotal > 0 ? +(((q1.droppedVideoFrames - bDrop) / (q1.totalVideoFrames - bTotal)) * 100).toFixed(1) : 0,
          gapP50: at(0.5),
          gapP95: at(0.95),
          gapP99: at(0.99),
          gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
          gt100: gaps.filter((g) => g > 100).length,
          bufAheadSec: +bufAhead.toFixed(1),
          srcChanged: v.src !== src0,
          longtasks: lt.length,
          longtaskMax: lt.length ? Math.max(...lt) : 0,
          posterStats: window.__origPoster ? window.__origPoster.stats() : null,
        }
      },
      SAMPLE_MS,
    )
    clearInterval(keep)
    console.log('\n[D] === RESULT (grid mounted + player open, extraction paused) ===')
    console.log('[D] ' + JSON.stringify(res))
    if (res.ok) {
      console.log(
        `[D] effRate(currentTime 推进/墙钟)=${res.effRate}  期望≈1.0  (修复前实测 0.72)  ` +
          `presented=${res.presentedFps}fps decoded=${res.decodedFps}fps drop=${res.dropPct}% bufAhead=${res.bufAheadSec}s ` +
          `gap p50/p95/p99/max=${res.gapP50}/${res.gapP95}/${res.gapP99}/${res.gapMax}ms gt100=${res.gt100} ` +
          `longtasks=${res.longtasks}(max ${res.longtaskMax}ms) srcChanged=${res.srcChanged} posterStats=${JSON.stringify(res.posterStats)}`,
      )
    }
  } finally {
    if (browser) await browser.close()
    for (const id of fixIds) await httpJson('DELETE', `${TG}/api/media/items/${id}`).catch(() => undefined)
    // 扫除残留（含超时丢响应产生的孤儿），只按标题前缀匹配
    const all = await httpJson('GET', `${TG}/api/media/items?sort=recent&limit=500&offset=0`, undefined, 20000)
    const leftovers = ((all.json && all.json.items) || []).filter((it) =>
      String(it.title || '').startsWith('ZZ-BUG239'),
    )
    for (const it of leftovers) await httpJson('DELETE', `${TG}/api/media/items/${it.id}`).catch(() => undefined)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (_e) {
      /* ignore */
    }
    console.log(`[D] cleanup fixtures=${fixIds.length} swept=${leftovers.length}`)
  }
}

main().catch((e) => {
  console.error('[D] ERROR', (e && e.stack) || e)
  process.exit(1)
})
