#!/usr/bin/env node
'use strict'
/**
 * BUG-428 取证：播放器 `video` 的**媒体源形态**与 `duration` 是否收敛。
 *
 * 为什么需要这个：`verify_bug416_autoplay_next.cjs` 三轮都没等到 `ended`。
 * 第三轮 16× 加速的轨迹是决定性的——
 *   t=11ms   currentTime=0.17   duration=9.43
 *   t=2173   currentTime=15.05  duration=26.1
 *   t=64399  currentTime=362.13 duration=366.93
 * `duration` 随 `currentTime` **同步上涨**，两者恒差 4~8s ⇒ 「结尾」是个移动靶，
 * `ended` 永不触发 ⇒ 自动连播倒计时永不出现。
 *
 * 本脚本只取证，回答四个问题：
 *   Q1 `video.currentSrc` 是直投文件还是转码流？带不带 Range 支持？
 *   Q2 `video.duration` / `seekable` 在 10s 内是否收敛？
 *   Q3 `buffered` 是否一直只覆盖到 currentTime 附近（边下边播）？
 *   Q4 1× 自然播放（不 seek、不加速）能否在 90s 内走到 `ended`？
 *
 * 用法：node tauri-shell/verify/_probe_media_stream_shape.cjs [SERIES_INDEX]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-stream-shape'),
)
const SERIES_INDEX = Number(process.argv[2] || 0)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openSeriesDetail(page) {
  // 剧集墙首屏可能因 daemon 忙而慢（实测偶发 >25s）：整体重试 3 轮
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!ok) {
      console.log(`[stream-shape] attempt#${attempt + 1}: nav not found`)
      await delay(2000)
      continue
    }
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
        { timeout: 25000 },
      )
    } catch (e) {
      console.log(`[stream-shape] attempt#${attempt + 1}: series wall timeout`)
      await delay(2000)
      continue
    }
    await delay(1200)
    await page.evaluate((i) => {
      const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
      cards[Math.min(i, cards.length - 1)].click()
    }, SERIES_INDEX)
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    await delay(900)
    return
  }
  throw new Error('series detail not reachable after 3 attempts')
}

function snap() {
  const v = document.querySelector('[data-testid="media-viewer"] video')
  if (!v) return { ok: false, why: 'no video' }
  const rng = (tl) => {
    const out = []
    for (let i = 0; i < tl.length; i++) out.push([+tl.start(i).toFixed(2), +tl.end(i).toFixed(2)])
    return out
  }
  return {
    ok: true,
    currentSrc: v.currentSrc,
    src: v.getAttribute('src') || '',
    duration: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : String(v.duration),
    currentTime: +v.currentTime.toFixed(2),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    ended: v.ended,
    playbackRate: v.playbackRate,
    seekable: rng(v.seekable),
    buffered: rng(v.buffered),
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { seriesIndex: SERIES_INDEX, q: {} }
  try {
    await openSeriesDetail(page)
    const clicked = await page.evaluate(() => {
      const plays = [...document.querySelectorAll('[data-testid="episode-row-play"]')].filter(
        (el) => el.getAttribute('data-kind') === 'video',
      )
      if (!plays.length) return false
      plays[0].click()
      return true
    })
    if (!clicked) throw new Error('no video episode-row-play')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
      timeout: 20000,
    })

    // Q1/Q2/Q3：10s 内每 1s 采样一次
    const samples = []
    for (let i = 0; i < 11; i++) {
      samples.push({ t: i, ...(await page.evaluate(snap)) })
      await delay(1000)
    }
    report.q.samples = samples
    const first = samples.find((s) => s.ok)
    report.q.Q1_currentSrc = first ? first.currentSrc : null

    // Q1 续：直接对 currentSrc 发 HEAD/GET，看 Content-Length 与 Accept-Ranges
    if (first && first.currentSrc) {
      const head = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { method: 'HEAD' })
          const h = {}
          for (const [k, v] of r.headers.entries()) h[k] = v
          return { status: r.status, headers: h }
        } catch (e) {
          return { error: String(e) }
        }
      }, first.currentSrc)
      report.q.Q1_head = head
    }

    const durs = samples.filter((s) => s.ok).map((s) => s.duration)
    report.q.Q2_durations = durs
    report.q.Q2_converged =
      durs.length > 1 && Math.abs(Number(durs[durs.length - 1]) - Number(durs[0])) < 0.01

    // Q4：1× 自然播放等 ended（上限 90s）
    await page.evaluate(async () => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      v.muted = true
      v.playbackRate = 1
      try {
        await v.play()
      } catch {
        /* 已在下文判定 */
      }
    })
    const t0 = Date.now()
    let endedAt = null
    const trail = []
    for (let i = 0; i < 450; i++) {
      const s = await page.evaluate(snap)
      if (i % 20 === 0) trail.push({ t: Date.now() - t0, ct: s.currentTime, d: s.duration })
      if (s.ok && s.ended) {
        endedAt = Date.now() - t0
        break
      }
      await delay(200)
    }
    report.q.Q4_endedAtMs = endedAt
    report.q.Q4_trail = trail
    await page.screenshot(path.join(OUT, 'A-player.png'))
  } catch (e) {
    report.error = e.message
  } finally {
    await browser.close().catch(() => {})
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('=== Q1 currentSrc ===')
  console.log(report.q.Q1_currentSrc)
  console.log(JSON.stringify(report.q.Q1_head, null, 2))
  console.log('\n=== Q2 duration 采样（每秒）===')
  console.log(JSON.stringify(report.q.Q2_durations))
  console.log('converged=' + report.q.Q2_converged)
  console.log('\n=== Q3 首末样本 seekable/buffered ===')
  const ss = report.q.samples || []
  const pick = [ss[0], ss[5], ss[ss.length - 1]].filter(Boolean)
  for (const s of pick) {
    if (!s.ok) continue
    console.log(
      `t=${s.t}s ct=${s.currentTime} d=${s.duration} rs=${s.readyState} ns=${s.networkState} ` +
        `seekable=${JSON.stringify(s.seekable)} buffered=${JSON.stringify(s.buffered)}`,
    )
  }
  console.log('\n=== Q4 1x 自然播放 ===')
  console.log('endedAtMs=' + report.q.Q4_endedAtMs)
  console.log(JSON.stringify(report.q.Q4_trail))
  console.log('\nreport: ' + path.join(OUT, 'report.json'))
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
