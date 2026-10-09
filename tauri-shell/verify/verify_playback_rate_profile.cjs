#!/usr/bin/env node
'use strict'

/**
 * BUG-209 取证：播放「倍速丢帧」归因画像（呈现预算 P / 解码 D / 转码投递 T）。
 *
 * ## 用户报的现象
 *
 * 「播放依然不流畅：解码吃力：画面在丢帧，**调低播放速度会明显更流畅**。
 *   主要问题体现在 2x、4x 等高速播放上。」
 *
 * 「调低速度就流畅」= 需求 > 供给。供给瓶颈有三种可能，**修法完全不同**：
 *
 *   (P) 呈现预算不足 —— 需要呈现的帧率 = 源帧率 × 倍速 > 显示器刷新率，
 *       丢帧是调度器为对齐刷新率做的物理丢弃（`droppedVideoFrames` 涨，
 *       但 `buffered` 充足、无 `waiting`）。
 *   (D) 解码不足 —— CPU 软解吞吐 < 源帧率 × 倍速（`readyState` 掉、可能 `waiting`）。
 *   (T) 转码/投递不足 —— 兼容流 ffmpeg 实时转码跟不上，或投递供不上（缓冲被抽干）。
 *
 * ## 决定性判据（本脚本核心）
 *
 *   10s 窗口内 `buffered.end(last) - currentTime` 的**最小值** + `waiting`/`stalled`
 *   计数：
 *     - 缓冲始终领先、无 waiting ⇒ **供给充足**，丢帧只可能来自 (P)。
 *     - 缓冲被抽干 / waiting 频发 ⇒ (D) 或 (T)。
 *   再叠加「有效内容播放速率」`ΔcurrentTime / Δwallclock`：
 *     - ≈ 设定倍速 ⇒ 播放没掉队（时钟跟得上），丢帧是呈现层的 ⇒ (P)。
 *     - 明显 < 设定倍速 ⇒ 解码/投递拖住了时钟 ⇒ (D)/(T)。
 *
 * ## 夹具（详见 BUG-209 交接）
 *
 *   - 472：源 HEVC 1280×720 **60fps** 11.8Mbps（Chromium 无 HEVC 硬解）⇒ 走**兼容流**
 *          `/stream`。代理 `proxies/472.mp4` 已是 H.264 1280×720 **30fps** 1.47Mbps
 *          ⇒ `x-orig-stream: proxy`（本地静态投递，**排除 T**）。
 *   - 607：H.264 Main 480×852 **30fps** ⇒ 可解码 ⇒ 走 `/raw`。
 *   - 598：H.264 High 720×1280 **30fps** ⇒ 可解码 ⇒ 走 `/raw`。
 *
 * 每个夹具跑 **1x / 2x / 4x**；另对 472 做**原始 /raw 对照**（预期 0 帧可解 →
 * 触发自动切流），用于确认「走的是哪条路径」这一变量的影响。
 *
 * ## 采集项（每个 条目 × 倍速）
 *
 *   1. 实际呈现帧率：`video.requestVideoFrameCallback` 计数 ÷ 时长（最硬指标）
 *      + `getVideoPlaybackQuality()` 的 `totalVideoFrames`/`droppedVideoFrames` 前后差。
 *   2. 显示器刷新率：`requestAnimationFrame` 2s 计数估算（≈Hz）。
 *   3. 供给：缓冲最小值、`waiting`/`stalled`/`suspend` 计数、`readyState` 序列。
 *   4. 实际 URL / 路径：`video.currentSrc` + CDP `Network` 域取 `x-orig-stream`
 *      （`live` 实时转码 / `proxy` 代理缓存）。
 *   5. 「解码吃力」提示是否在场（DOM 文案 `解码吃力`）。
 *   6. `videoWidth`/`videoHeight`/`readyState`/`networkState`。
 *
 * ## 用法
 *
 *   先起开发态服务（daemon + orig-tg 19787 + vite dev 5180），再：
 *     node verify/verify_playback_rate_profile.cjs
 *   环境变量：APP_PORT / TG_URL / ORIG_VERIFY_OUT / PROBE_ITEMS（逗号分隔）。
 *
 * 产物：`tauri-shell/verify_shots/rate_profile/`（截图 + JSON + Markdown 表）。
 * 退出码：0 = 画像跑完；1 = 脚本自身/页面异常；2 = 环境不可达。
 *
 * 只读：仅打开播放器并播放，不写后端（localStorage 的兼容流记忆属客户端）。
 */

const fs = require('node:fs')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', 'verify_shots', 'rate_profile'),
)
/** 兼容流夹具（HEVC → /stream）与 /raw 夹具（可解码 → /raw） */
const COMPAT_ITEM = Number(process.env.PROBE_ITEM || 472)
const RAW_ITEMS = (process.env.PROBE_RAW_ITEMS || '607,598')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const RATES = [1, 2, 4]
/** 每个倍速的采样窗口（秒） */
const WINDOW_SEC = 10
/** 改速后的解码器预热静默期（对齐 decodeHealth.ts 的 WARMUP_MS） */
const WARMUP_MS = 1600
/** 打开条目后等待「出帧」的上限（兼容流首次冷启动可能较久；代理命中则很快） */
const FRAME_WAIT_MS = 90000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// CDP 侧：Network 域收集 x-orig-stream 响应头
// ---------------------------------------------------------------------------

/**
 * 订阅 CDP Network 域，记录 /raw 与 /stream 请求的响应头。
 * @param {object} page CDP Page
 * @returns {Array<{url:string,status:number,mime:string,stream:string|null}>} 可变数组
 */
function collectNetwork(page) {
  const seen = []
  page.conn.on('Network.responseReceived', (p) => {
    const r = (p && p.response) || {}
    const url = String(r.url || '')
    if (!url.includes('/raw') && !url.includes('/stream')) return
    const h = r.headers || {}
    const stream = h['x-orig-stream'] || h['X-Orig-Stream'] || null
    seen.push({ url, status: r.status, mime: r.mimeType || '', stream })
  })
  return seen
}

// ---------------------------------------------------------------------------
// 页面内探针
// ---------------------------------------------------------------------------

/** 通过 store 打开一个视频条目（src 用 /raw，MediaViewer 内部会自动补 compatSrc）。 */
async function openItem(page, item, kind) {
  const src = `${TG}/api/media/items/${item}/${kind}`
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
    item,
  )
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="media-viewer"] video'),
    { timeout: 15000 },
  )
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      v.play().catch(() => {})
    }
  })
}

/** 当前 video 元素的快照（路径/尺寸/帧数/横幅/提示）。 */
async function videoSnapshot(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    const src = String(v.currentSrc || v.src || '')
    return {
      path: src.includes('/stream') ? 'stream' : src.includes('/raw') ? 'raw' : 'other',
      src,
      vw: v.videoWidth,
      vh: v.videoHeight,
      frames: q ? q.totalVideoFrames : null,
      dropped: q ? q.droppedVideoFrames : null,
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      playbackRate: v.playbackRate,
      halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      strained: document.body.innerText.includes('解码吃力'),
    }
  })
}

/**
 * 472 的 /raw 对照：清空兼容流记忆后重新打开，记录「原始流 0 帧 → 自动切兼容流」的时间线。
 * @returns {Promise<object>} 对照轨迹
 */
async function rawContrastTrace(page, item) {
  await page.evaluate(() => localStorage.removeItem('orighub.compatSrcs'))
  await openItem(page, item, 'raw')
  const trace = []
  const t0 = Date.now()
  let switchedAt = null
  let framesAt = null
  for (let i = 0; i < 80; i++) {
    const s = await videoSnapshot(page)
    const t = Number(((Date.now() - t0) / 1000).toFixed(2))
    if (s) {
      trace.push({
        t,
        path: s.path,
        vw: s.vw,
        frames: s.frames,
        readyState: s.readyState,
        halted: s.halted,
      })
      if (switchedAt === null && s.path === 'stream') switchedAt = t
      if (framesAt === null && s.vw > 0 && (s.frames || 0) > 0) framesAt = t
    }
    // 已经切流并稳定出帧 → 再采 1s 收尾即可
    if (switchedAt !== null && framesAt !== null && t - framesAt > 1) break
    await delay(250)
  }
  const first = trace[0] || {}
  return {
    item,
    firstPath: first.path || null,
    rawStartedWithZeroFrames: first.path === 'raw' && first.vw === 0,
    switchedAtSec: switchedAt,
    firstFrameAtSec: framesAt,
    // 原始 /raw 阶段有没有上过任何一帧
    rawEverPresentedFrame: trace.some((x) => x.path === 'raw' && x.vw > 0 && (x.frames || 0) > 0),
    trace,
  }
}

/**
 * 显示器刷新率估算：2s 内 requestAnimationFrame 回调次数 ÷ 秒。
 * @returns {Promise<number>} 估算 Hz（保留 1 位小数）
 */
async function measureRefreshHz(page) {
  const hz = await page.evaluate(async () => {
    let count = 0
    const t0 = performance.now()
    await new Promise((resolve) => {
      const tick = () => {
        count += 1
        if (performance.now() - t0 >= 2000) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return count / ((performance.now() - t0) / 1000)
  })
  return Number(Number(hz).toFixed(1))
}

/** 倍速 UI 是否可用（播放速度按钮存在）。 */
async function hasRateUI(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).some((b) => {
      const a = b.getAttribute('aria-label') || ''
      return a === '播放速度' || a === 'Playback speed'
    })
  })
}

/**
 * 通过播放器 UI 设置倍速（点「播放速度」→ 点菜单项）。
 * @returns {Promise<{ok:boolean, actual:number|null, reason?:string}>}
 */
async function setRateViaUI(page, rate) {
  const opened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const a = b.getAttribute('aria-label') || ''
      return a === '播放速度' || a === 'Playback speed'
    })
    if (!btn) return false
    btn.click()
    return true
  })
  if (!opened) return { ok: false, actual: null, reason: 'speed button not found' }
  await delay(250)
  const picked = await page.evaluate((r) => {
    const menu = document.querySelector('[role="menu"]')
    if (!menu) return { ok: false, reason: 'speed menu did not open' }
    const items = Array.from(menu.querySelectorAll('button'))
    const target = items.find((b) => (b.textContent || '').trim().startsWith(`${r}x`))
    if (!target) {
      return { ok: false, reason: 'rate item not found', seen: items.map((b) => (b.textContent || '').trim()) }
    }
    target.click()
    return { ok: true }
  }, rate)
  await delay(200)
  const actual = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    return v ? v.playbackRate : null
  })
  return { ok: picked.ok && actual === rate, actual, reason: picked.reason, seen: picked.seen }
}

/** 直接设置 video.playbackRate（UI 不可用时的回退）。 */
async function setRateDirect(page, rate) {
  const actual = await page.evaluate((r) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    v.playbackRate = r
    return v.playbackRate
  }, rate)
  return { ok: actual === rate, actual, reason: 'direct' }
}

/**
 * 一个 10s 采样窗口：呈现帧率 / 丢帧 / 缓冲最小值 / 事件计数 / readyState 序列 / 路径 / 提示。
 *
 * 整个窗口在页面内一次性跑完（Promise 解析后返回），避免多次往返丢样本。
 * @returns {Promise<object>} 窗口统计
 */
async function measureWindow(page, seconds) {
  return page.evaluate(async (secs) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return { error: 'no video element' }
    const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    const t0 = performance.now()
    const cur0 = v.currentTime

    const ev = { waiting: 0, stalled: 0, suspend: 0, playing: 0, ratechange: 0, error: 0 }
    const binds = []
    for (const name of Object.keys(ev)) {
      const f = () => {
        ev[name] += 1
      }
      v.addEventListener(name, f)
      binds.push([name, f])
    }

    // requestVideoFrameCallback：真正被「呈现」的帧（最硬指标）
    const rvfcSupported = typeof v.requestVideoFrameCallback === 'function'
    let rvfcCount = 0
    let rvfcHandle = null
    if (rvfcSupported) {
      const onFrame = () => {
        rvfcCount += 1
        rvfcHandle = v.requestVideoFrameCallback(onFrame)
      }
      rvfcHandle = v.requestVideoFrameCallback(onFrame)
    }

    // 100ms 采样：缓冲领先量最小值 + readyState 序列
    const readyStates = []
    let aheadMin = Infinity
    let aheadSeen = false
    const sampler = setInterval(() => {
      const b = v.buffered
      if (b && b.length) {
        const ahead = b.end(b.length - 1) - v.currentTime
        aheadSeen = true
        if (ahead < aheadMin) aheadMin = ahead
      }
      readyStates.push(v.readyState)
    }, 100)

    await new Promise((r) => setTimeout(r, secs * 1000))

    clearInterval(sampler)
    for (const [name, f] of binds) v.removeEventListener(name, f)
    if (rvfcHandle != null) {
      try {
        v.cancelVideoFrameCallback(rvfcHandle)
      } catch (_e) {
        /* ignore */
      }
    }

    const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    const wall = (performance.now() - t0) / 1000
    const cur1 = v.currentTime
    const counts = readyStates.reduce((a, s) => {
      a[s] = (a[s] || 0) + 1
      return a
    }, {})
    const src = String(v.currentSrc || v.src || '')
    return {
      wallSecs: Number(wall.toFixed(2)),
      contentPlayed: Number((cur1 - cur0).toFixed(2)),
      effRate: Number(((cur1 - cur0) / wall).toFixed(2)),
      rvfcSupported,
      rvfcCount,
      rvfcFps: Number((rvfcCount / wall).toFixed(1)),
      // totalVideoFrames 含「被丢弃」的帧（W3C：已创建/解码的总帧数），
      // 故 total = 真正呈现 + dropped。呈现帧率最硬的指标是上面的 rVFC。
      presentedDelta: q0 && q1 ? q1.totalVideoFrames - q0.totalVideoFrames : null,
      droppedDelta: q0 && q1 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
      totalFps:
        q0 && q1 ? Number(((q1.totalVideoFrames - q0.totalVideoFrames) / wall).toFixed(1)) : null,
      qualityPresentedFps:
        q0 && q1
          ? Number(
              (
                (q1.totalVideoFrames -
                  q0.totalVideoFrames -
                  (q1.droppedVideoFrames - q0.droppedVideoFrames)) /
                wall
              ).toFixed(1),
            )
          : null,
      totalFrames: q1 ? q1.totalVideoFrames : null,
      droppedTotal: q1 ? q1.droppedVideoFrames : null,
      aheadMin: aheadSeen && isFinite(aheadMin) ? Number(aheadMin.toFixed(2)) : null,
      aheadSeen,
      events: ev,
      readyStateMin: readyStates.length ? Math.min(...readyStates) : null,
      readyStateMax: readyStates.length ? Math.max(...readyStates) : null,
      readyStateCounts: counts,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      readyState: v.readyState,
      networkState: v.networkState,
      playbackRate: v.playbackRate,
      path: src.includes('/stream') ? 'stream' : src.includes('/raw') ? 'raw' : 'other',
      currentSrc: src,
      halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      strained: document.body.innerText.includes('解码吃力'),
    }
  }, seconds)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[rate] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(f).size
  } catch (_e) {
    /* ignore */
  }
  console.log(`[rate] shot ${name} -> ${f} (${size} bytes)`)
}

/**
 * 跑一个夹具的全部倍速档，返回逐档结果。
 * @param {object} page CDP Page
 * @param {number} item 条目 id
 * @param {object} opts `{ expectPath: 'stream'|'raw', label: string }`
 * @returns {Promise<object>} 夹具结果
 */
async function runFixture(page, item, opts) {
  const label = opts.label || `${item}_${opts.expectPath}`
  console.log(`\n[rate] ===== fixture ${item} (${label}) =====`)
  await openItem(page, item, 'raw')

  // 等出帧（兼容流首次冷启动可能久；代理命中则很快）
  const framed = await page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: FRAME_WAIT_MS },
    )
    .then(() => true)
    .catch(() => false)

  const snap = await videoSnapshot(page)
  console.log(`[rate] ${label} opened: ${JSON.stringify(snap)}`)
  const pathOk = snap && snap.path === opts.expectPath
  check(`${label}: opened on /${opts.expectPath}`, pathOk, `path=${snap && snap.path} framed=${framed}`)
  await shot(page, `${label}_opened.png`)

  const refreshHz = await measureRefreshHz(page)
  console.log(`[rate] ${label} refresh ≈ ${refreshHz} Hz`)

  const uiAvailable = await hasRateUI(page)
  console.log(`[rate] ${label} rate UI available = ${uiAvailable}`)

  const phases = []
  for (const rate of RATES) {
    // 设速：优先走真实 UI，UI 不可用则直接写 video.playbackRate
    let setRes
    if (uiAvailable) {
      setRes = await setRateViaUI(page, rate)
      if (!setRes.ok) {
        console.log(`[rate] ${label} UI set ${rate}x failed (${setRes.reason}) -> direct fallback`)
        setRes = await setRateDirect(page, rate)
      }
    } else {
      setRes = await setRateDirect(page, rate)
    }
    const method = uiAvailable && setRes.reason !== 'direct' ? 'ui' : 'direct'
    // 预热静默期：让解码器稳定、让 decodeHealth 越过 warmup
    await delay(WARMUP_MS)
    const m = await measureWindow(page, WINDOW_SEC)
    const phase = {
      item,
      label,
      rate,
      rateMethod: method,
      rateActual: setRes.actual,
      refreshHz,
      ...m,
    }
    phases.push(phase)
    const dropPct =
      m.presentedDelta != null && m.droppedDelta != null && m.presentedDelta > 0
        ? Number(((100 * m.droppedDelta) / m.presentedDelta).toFixed(1))
        : null
    console.log(
      `[rate] ${label} ${rate}x (${method}) | presented(rVFC) ${m.rvfcFps}fps` +
        ` total ${m.totalFps}fps | dropped +${m.droppedDelta} (${dropPct}% of decoded) | aheadMin ${m.aheadMin}s` +
        ` | waiting ${m.events.waiting} stalled ${m.events.stalled} suspend ${m.events.suspend}` +
        ` | readyState ${m.readyStateMin}-${m.readyStateMax} | effRate ${m.effRate}x` +
        ` | path ${m.path} | strained ${m.strained}`,
    )
    await shot(page, `${label}_${rate}x.png`)
  }

  await page.evaluate(() => window.__origStore.getState().closeViewer())
  await delay(400)
  return { item, label, expectPath: opts.expectPath, framed, snap, refreshHz, uiAvailable, phases }
}

/**
 * 归因：用「缓冲最小值 + waiting」判 (P) vs (D)/(T)，再用「有效播放速率」细分。
 * @returns {string} 判定标签
 */
function attribute(phase) {
  const supplyStarved =
    (phase.aheadMin !== null && phase.aheadMin < 0.5) ||
    (phase.events && (phase.events.waiting > 0 || phase.events.stalled > 0))
  const needFps = phase.sourceFps != null ? phase.sourceFps * phase.rate : null
  if (!supplyStarved) {
    // 供给充足：丢帧只可能来自呈现预算
    if (needFps != null && phase.refreshHz && needFps > phase.refreshHz * 1.02) return 'P'
    return phase.droppedDelta > 0 ? 'P?' : 'ok'
  }
  // 供给被抽干：解码或投递不足。用有效播放速率区分时钟是否掉队
  if (phase.effRate != null && phase.rate > 0 && phase.effRate < phase.rate * 0.85) return 'D/T'
  return 'D/T?'
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let browser
  try {
    browser = await cdp.launch()
  } catch (e) {
    console.error(`[rate] ENV: browser launch failed: ${e && e.message ? e.message : e}`)
    process.exit(2)
  }

  try {
    const page = await browser.newPage()
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    } catch (e) {
      console.error(`[rate] ENV: dev server unreachable at ${APP_URL}: ${e && e.message ? e.message : e}`)
      process.exit(2)
    }
    const netSeen = collectNetwork(page)
    try {
      await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    } catch (_e) {
      console.log('[rate] WARN: Network domain unavailable; x-orig-stream will be null')
    }
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })
    console.log('[rate] app ready at', APP_URL)

    const results = { compatItem: COMPAT_ITEM, rawItems: RAW_ITEMS, fixtures: [] }

    // ---- A：472 原始 /raw 对照（预期 0 帧 → 自动切兼容流） ----
    console.log('\n[rate] ===== contrast: 472 raw vs compat =====')
    const contrast = await rawContrastTrace(page, COMPAT_ITEM)
    console.log(
      `[rate] 472 contrast: firstPath=${contrast.firstPath} rawZeroFrames=${contrast.rawStartedWithZeroFrames}` +
        ` switchedAt=${contrast.switchedAtSec}s firstFrame=${contrast.firstFrameAtSec}s rawEverFrame=${contrast.rawEverPresentedFrame}`,
    )
    await shot(page, '472_raw_contrast.png')
    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(500)
    results.contrast = contrast
    // 记忆已建立 → 重开直接走兼容流
    check('472: raw path presents 0 frames (needs compat switch)', contrast.rawStartedWithZeroFrames, JSON.stringify({ firstPath: contrast.firstPath }))

    // ---- B：472 兼容流（记忆直开） 1x/2x/4x ----
    const compat = await runFixture(page, COMPAT_ITEM, { expectPath: 'stream', label: '472_compat' })
    results.fixtures.push(compat)

    // ---- C：可解码 /raw 夹具 1x/2x/4x ----
    for (const item of RAW_ITEMS) {
      const fx = await runFixture(page, item, { expectPath: 'raw', label: `${item}_raw` })
      results.fixtures.push(fx)
    }

    // ---- 汇总 x-orig-stream ----
    // 只汇总「x-orig-stream 的取值分布」，避免逐条 Range 请求把日志刷爆。
    const streamReqs = netSeen.filter((r) => r.url.includes('/stream'))
    const streamByKind = streamReqs.reduce((a, r) => {
      const k = r.stream || '(none)'
      a[k] = (a[k] || 0) + 1
      return a
    }, {})
    results.streamHeadSummary = {
      total: streamReqs.length,
      byXOrigStream: streamByKind,
      sampleStatus: streamReqs.length ? streamReqs[0].status : null,
    }
    console.log(
      `[rate] /stream responses: total=${streamReqs.length} byXOrigStream=${JSON.stringify(streamByKind)}`,
    )

    // ---- 归因（源帧率：472 代理=30fps；607/598=30fps） ----
    const sourceFps = Number(process.env.PROBE_SRC_FPS || 30)
    for (const fx of results.fixtures) {
      for (const p of fx.phases) {
        p.sourceFps = sourceFps
        p.needFps = sourceFps * p.rate
        p.attribute = attribute(p)
      }
    }

    const pageErrors = page.pageErrors().slice(0, 20)
    const consoleErrors = page.consoleErrors().slice(0, 20)
    results.pageErrors = pageErrors
    results.consoleErrors = consoleErrors
    console.log('[rate] PAGE_ERRORS:', JSON.stringify(pageErrors))
    console.log('[rate] CONSOLE_ERRORS:', JSON.stringify(consoleErrors))
    check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors))

    // ---- 写产物 ----
    fs.writeFileSync(path.join(OUT, 'rate_profile.json'), JSON.stringify(results, null, 2))

    // Markdown 表
    const lines = []
    lines.push('| 条目 | 倍速 | 呈现fps(rVFC) | 总帧fps(totalVideoFrames) | 丢帧Δ | 丢帧% | 刷新率 | 缓冲最小 | waiting | 路径 | 解码吃力 |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
    for (const fx of results.fixtures) {
      for (const p of fx.phases) {
        const dropPct =
          p.presentedDelta != null && p.droppedDelta != null && p.presentedDelta > 0
            ? ((100 * p.droppedDelta) / p.presentedDelta).toFixed(1) + '%'
            : '-'
        lines.push(
          `| ${p.item} | ${p.rate}x | ${p.rvfcFps} | ${p.totalFps} | +${p.droppedDelta} | ${dropPct} | ${p.refreshHz}Hz | ${p.aheadMin}s | ${p.events.waiting} | ${p.path} | ${p.strained} |`,
        )
      }
    }
    lines.push('')
    lines.push('归因（P=呈现预算 / D=解码 / T=转码投递）：')
    for (const fx of results.fixtures) {
      for (const p of fx.phases) {
        lines.push(
          `- ${p.item} @${p.rate}x → **${p.attribute}**（需求 ${p.needFps}fps vs 刷新 ${p.refreshHz}Hz；` +
            `缓冲最小 ${p.aheadMin}s；waiting ${p.events.waiting}；有效播放 ${p.effRate}x）`,
        )
      }
    }
    const md = lines.join('\n')
    fs.writeFileSync(path.join(OUT, 'rate_profile.md'), md + '\n')
    console.log('\n[rate] === MARKDOWN ===')
    console.log(md)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[rate] === SUMMARY ===')
    console.log(`[rate] checks total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[rate] FAILED:', failed.map((c) => c.name).join(' | '))
    console.log(`[rate] artifacts in ${OUT}`)
  } catch (e) {
    console.error('[rate] ERROR', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main()
