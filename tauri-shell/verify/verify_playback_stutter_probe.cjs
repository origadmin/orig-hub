'use strict'
/**
 * verify_playback_stutter_probe.cjs
 *
 * 复现用户「正常(2x FRC)播放卡顿 + 缓存条快满但像没用到缓存」的现场。
 *
 * 关键：用户的 2x 路径是 FRC 转码流 `/stream?speed=2`（浏览器侧 playbackRate 仍为 1，
 * 时间压缩发生在服务端），不是原生 /raw 的浏览器时域缩放。本探针分别测：
 *   - 1x 原生：  /raw  + playbackRate=1
 *   - 2x FRC：   /stream?speed=2 + playbackRate=1   （= 用户真实 2x 体验）
 *   - 4x FRC：   /stream?speed=4 + playbackRate=1
 *
 * 判据：
 *   - effRate = 实际推进秒 / 墙钟秒 / 档位；<0.9 = 管线饿死/卡顿（BUG-212 主判据）。
 *   - loadstart 次数 >1 = 播放中被反复重载 src（=「缓存没被用到」的直接证据）。
 *   - buffered 前沿 vs currentTime：缓存远远领先仍卡 = 解码/渲染瓶颈，非网络。
 *   - dropPct：丢帧比例；gaps：rVFC 帧间隔长尾（>100ms 即肉眼卡顿）。
 */
const cdp = require('./lib/cdp.cjs')

const TG = 'http://127.0.0.1:19787'
const SAMPLE_MS = 12000
const ITEMS = [
  { id: 438, label: '438 HEVC 720x1280 6Mbps' },
  { id: 472, label: '472 HEVC 720p60 11.8Mbps' },
  { id: 673, label: '673 HEVC 1080p30 10.2Mbps' },
]
const PATHS = [
  { name: '1x-native', rate: 1, q: '' },
  { name: '2x-frc', rate: 1, q: '?speed=2' }, // 浏览器 1x，服务端 2x 压缩
  { name: '4x-frc', rate: 1, q: '?speed=4' },
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(page, item, path) {
  const src = `${TG}/api/media/items/${item.id}/raw${path.q}`
  return page.evaluate(
    async (url, rate, ms) => {
      const v = document.createElement('video')
      v.src = url
      v.muted = true
      v.volume = 0
      v.playsInline = true
      v.playbackRate = rate
      document.body.appendChild(v)
      const loadstarts = []
      v.addEventListener('loadstart', () => loadstarts.push(performance.now()))
      let started = false
      try {
        await v.play()
        started = true
      } catch (e) {
        return { ok: false, error: 'play failed: ' + String(e && e.message) }
      }
      // 等首帧
      await new Promise((res) => {
        if (v.readyState >= 2 && v.videoWidth > 0) return res()
        const t = setInterval(() => {
          if (v.readyState >= 2 && v.videoWidth > 0) {
            clearInterval(t)
            res()
          }
        }, 100)
        setTimeout(() => {
          clearInterval(t)
          res()
        }, 8000)
      })
      if (!started || v.videoWidth === 0) {
        v.remove()
        return { ok: false, error: 'no first frame (vw=0, rs=' + v.readyState + ')' }
      }

      const stamps = []
      let stopped = false
      const onFrame = () => {
        stamps.push(performance.now())
        if (!stopped && v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame)
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame)

      const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      const bDrop = q0 ? q0.droppedVideoFrames : 0
      const bTotal = q0 ? q0.totalVideoFrames : 0
      const t0 = performance.now()
      const ct0 = v.currentTime
      const bufSamples = []
      let maxBuf = 0
      const sampler = setInterval(() => {
        try {
          const b = v.buffered
          let e = 0
          if (b && b.length) e = b.end(b.length - 1)
          maxBuf = Math.max(maxBuf, e)
          bufSamples.push({ ct: v.currentTime, buf: e, rs: v.readyState })
        } catch (_) {}
      }, 250)

      await new Promise((res) => setTimeout(res, ms))
      const t1 = performance.now()
      const ct1 = v.currentTime
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      stopped = true
      clearInterval(sampler)
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => {})

      const wall = (t1 - t0) / 1000
      const advanced = ct1 - ct0
      const dropped = q1 ? q1.droppedVideoFrames - bDrop : 0
      const total = q1 ? q1.totalVideoFrames - bTotal : 0
      const effRate = +(advanced / wall / rate).toFixed(3)
      const reloads = Math.max(0, loadstarts.length - 1)

      const gaps = []
      for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1])
      const raw = gaps.slice().sort((a, b) => a - b)
      const at = (p) => (raw.length ? +raw[Math.min(raw.length - 1, Math.floor(raw.length * p))].toFixed(1) : null)
      const over = (t) => gaps.filter((g) => g > t).length
      const last = bufSamples[bufSamples.length - 1] || { ct: 0, buf: 0 }
      const bufAhead = last.buf - last.ct
      v.remove()
      return {
        ok: true,
        src: v.currentSrc || url,
        vw: v.videoWidth,
        vh: v.videoHeight,
        effRate,
        advanced: +advanced.toFixed(1),
        wall: +wall.toFixed(1),
        presentedFps: +(stamps.length / wall).toFixed(1),
        dropPct: total > 0 ? +((dropped / total) * 100).toFixed(1) : 0,
        reloads,
        gapP50: at(0.5),
        gapP95: at(0.95),
        gapP99: at(0.99),
        gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null,
        gt100: over(100),
        bufMax: +maxBuf.toFixed(1),
        bufAheadEnd: +bufAhead.toFixed(1),
      }
    },
    src,
    path.rate,
    SAMPLE_MS,
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
  try {
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:5180/', { waitForRoot: true, settleMs: 1500 }).catch(() => {})
    console.log('[probe] started')
    for (const it of ITEMS) {
      for (const path of PATHS) {
        process.stdout.write(`[probe] ${it.label} ${path.name} ... `)
        let res
        try {
          res = await measure(page, it, path)
        } catch (e) {
          res = { ok: false, error: String((e && e.message) || e) }
        }
        if (!res.ok) {
          console.log(`FAILED: ${res.error}`)
        } else {
          console.log(
            `effRate=${res.effRate} presentedFps=${res.presentedFps} drop=${res.dropPct}% ` +
              `reloads=${res.reloads} gap p95/p99/max=${res.gapP95}/${res.gapP99}/${res.gapMax}ms gt100=${res.gt100} ` +
              `bufMax=${res.bufMax}s bufAheadEnd=${res.bufAheadEnd}s src=${res.src.split('/').pop()}`,
          )
        }
        rows.push({ item: it.label, path: path.name, ...res })
        await delay(800)
      }
    }
  } finally {
    await browser.close()
  }
  console.log('\n=== SUMMARY (csv) ===')
  console.log('item,path,effRate,presentedFps,dropPct,reloads,gapP95,gapP99,gapMax,gt100,bufMax,bufAheadEnd')
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.item},${r.path},ERR,${r.error}`)
      continue
    }
    console.log(
      [r.item, r.path, r.effRate, r.presentedFps, r.dropPct, r.reloads, r.gapP95, r.gapP99, r.gapMax, r.gt100, r.bufMax, r.bufAheadEnd].join(','),
    )
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
