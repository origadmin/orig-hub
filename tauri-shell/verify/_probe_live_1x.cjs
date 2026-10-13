'use strict'

/**
 * 冷启动 1x 直播路径流畅度探针（BUG-293 修复后的「结果」取证）。
 *
 * 与 `_probe_app_realrate.cjs` 的区别：**只测冷变体**（该 item 在该倍速下无磁盘代理），
 * 从而走 `/stream` 的**实时转码直播**分支，而不是磁盘代理回放。
 * 之前那次测到 `bufAhead=561.9s` ⇒ 命中磁盘代理 ⇒ 根本没测到用户卡的那条路。
 *
 * 判据（预先声明，不事后放宽）：
 *   - gt100 == 0 且 effRate ∈ [0.98, 1.02] 且 reloads == 0 且 longtasks == 0  → 冷 1x 直播流畅
 *   - 否则逐行报出违规信号
 * 附带：先在页面里 fetch 一次该 URL 读 `x-orig-stream` 头，确认服务端真的走了 `live`（而非 `proxy`）。
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const SAMPLE_MS = 20000

// 只选**无该倍速代理**的条目 ⇒ 强制走实时转码直播。
// 用法：node _probe_live_1x.cjs [ids 逗号分隔] [rate]
const _ids = (process.argv[2] || '1425,673,1446')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n))
const RATE = Number(process.argv[3] || '1')
const ITEMS = _ids.map((id) => ({ id, label: `${id} cold@${RATE}x` }))

/** 点真实倍速菜单，把组件切到目标倍速（FRC 路径）。 */
async function setRate(page, target) {
  if (target === 1) {
    const cur = await page.evaluate(
      () =>
        document.querySelector('[data-testid="media-viewer"] video')?.dataset?.contentSpeed || '1',
    )
    if (cur === '1') return true
  }
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="media-viewer"] button')].find((x) =>
      /^\d+(\.\d+)?x$/.test((x.textContent || '').trim()),
    )
    if (!b) return false
    b.click()
    return true
  })
  if (!opened) return false
  await delay(250)
  await page.evaluate((t) => {
    const items = [
      ...document.querySelectorAll('[data-testid="media-viewer"] [role="menuitemradio"]'),
    ]
    const it = items.find((el) => (el.textContent || '').trim().startsWith(`${t}x`))
    if (it) it.click()
  }, target)
  await page
    .waitForFunction(
      (t) => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return false
        const cs = Number(v.dataset?.contentSpeed || '1')
        return v.videoWidth > 0 && v.readyState >= 2 && cs === t
      },
      { timeout: 30000, intervalMs: 250 },
      target,
    )
    .catch(() => {})
  await delay(800)
  return true
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function probeHeader(page, id, rate) {
  // 用 `probe=1`：只回答「该变体代理是否已就绪」，**绝不** spawn ffmpeg（否则会污染冷启动测试）。
  const q = rate && rate !== 1 ? `speed=${rate}&probe=1` : 'probe=1'
  return page.evaluate(async (url) => {
    try {
      const r = await fetch(url)
      const j = await r.json()
      return { status: r.status, ready: j.ready, duration: j.duration }
    } catch (e) {
      return { error: String(e) }
    }
  }, `${TG}/api/media/items/${id}/stream?${q}`)
}

async function openItem(page, item) {
  const src = `${TG}/api/media/items/${item.id}/raw`
  await page.evaluate(
    (url, it) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${it}`,
            chatId: 0,
            messageId: it,
            kind: 'video',
            caption: '',
            description: null,
            src: url,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    },
    src,
    item.id,
  )
  await page.waitForFunction(
    () => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 40000, intervalMs: 250 },
  )
}

async function closeViewer(page) {
  try {
    await page.evaluate(() => window.__origStore.getState().closeViewer())
  } catch (_e) {}
  await delay(600)
}

async function measure(page, ms) {
  return page.evaluate(
    async (dur) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { ok: false, error: 'no video element' }
      v.muted = true
      v.volume = 0
      try {
        await v.play()
      } catch (_e) {}

      const p = (window.__probe = { loadstart: 0, loadedmetadata: 0, loadeddata: 0 })
      const onLS = () => (p.loadstart += 1)
      const onLM = () => (p.loadedmetadata += 1)
      const onLD = () => (p.loadeddata += 1)
      v.addEventListener('loadstart', onLS)
      v.addEventListener('loadedmetadata', onLM)
      v.addEventListener('loadeddata', onLD)

      const lt = []
      let ltObs = null
      try {
        ltObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) lt.push(Math.round(e.duration))
        })
        ltObs.observe({ entryTypes: ['longtask'] })
      } catch (_e) {}

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
      const t0 = performance.now()
      const ct0 = v.currentTime
      const src0 = v.src

      await new Promise((res) => setTimeout(res, dur))

      const t1 = performance.now()
      const ct1 = v.currentTime
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      stopped = true
      if (ltObs) ltObs.disconnect()
      v.removeEventListener('loadstart', onLS)
      v.removeEventListener('loadedmetadata', onLM)
      v.removeEventListener('loadeddata', onLD)

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0
      const elemRate = v.playbackRate || 1
      let bufAhead = 0
      try {
        if (v.buffered.length) bufAhead = v.buffered.end(v.buffered.length - 1) - v.currentTime
      } catch (_e) {}

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      const raw = gaps.slice().sort((a, b) => a - b)
      const at = (pc) =>
        raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * pc))].toFixed(1) : null
      const over = (th) => gaps.filter((g) => g > th).length

      return {
        ok: true,
        vw: v.videoWidth,
        vh: v.videoHeight,
        contentSpeed: Number(v.dataset?.contentSpeed || '1'),
        elemRate,
        presentedFps: +(stamps.length / wall).toFixed(1),
        decodedFps: +(total / wall).toFixed(1),
        dropPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : 0,
        effRate: +(advanced / wall / (elemRate || 1)).toFixed(3),
        bufAheadSec: +bufAhead.toFixed(1),
        frames: stamps.length,
        gapP50: at(0.5),
        gapP99: at(0.99),
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
        gt50: over(50),
        gt100: over(100),
        gt250: over(250),
        loadstart: p.loadstart,
        loadedmetadata: p.loadedmetadata,
        srcChanged: v.src !== src0,
        longtasks: lt.length,
        longtaskMax: lt.length ? Math.max(...lt) : 0,
      }
    },
    ms,
  )
}

async function main() {
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
  const rows = []
  let keep = null
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () =>
      page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    keep = setInterval(bring, 2000)

    for (const it of ITEMS) {
      // 先读响应头，确认服务端确实走 live（而非磁盘代理）
      const h = await probeHeader(page, it.id, RATE)
      console.log(`[hdr] item ${it.id}: ${JSON.stringify(h)}`)
      await openItem(page, it)
      await setRate(page, RATE)
      process.stdout.write(`[app] ${it.label} ... `)
      let res
      try {
        res = await measure(page, SAMPLE_MS)
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) }
      }
      if (!res.ok) {
        console.log(`FAILED: ${res.error}`)
      } else {
        console.log(
          `cs=${res.contentSpeed} elemRate=${res.elemRate} presented=${res.presentedFps} decoded=${res.decodedFps} ` +
            `drop=${res.dropPct}% effRate=${res.effRate} bufAhead=${res.bufAheadSec}s ` +
            `src=${res.vw}x${res.vh} ` +
            `gap p50/p99/max=${res.gapP50}/${res.gapP99}/${res.gapMax}ms ` +
            `gt50=${res.gt50} gt100=${res.gt100} gt250=${res.gt250} ` +
            `loadstart=${res.loadstart} srcChanged=${res.srcChanged} longtasks=${res.longtasks}(max ${res.longtaskMax}ms)`,
        )
      }
      rows.push({ item: it.label, header: h, ...res })
      await closeViewer(page)
    }
  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }

  console.log('\n=== SUMMARY ===')
  for (const r of rows) {
    const verdict =
      r.ok && r.gt100 === 0 && r.effRate >= 0.98 && r.effRate <= 1.02 && !r.srcChanged && r.longtasks === 0
        ? 'SMOOTH'
        : 'NOT-SMOOTH'
    console.log(
      `${r.item} proxyReady=${r.header && r.header.ready} effRate=${r.effRate} gt100=${r.gt100} gt250=${r.gt250} srcChanged=${r.srcChanged} longtasks=${r.longtasks} -> ${verdict}`,
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
