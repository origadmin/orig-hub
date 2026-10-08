#!/usr/bin/env node
'use strict'

/**
 * BUG-209 取证（第二轮 · 真实显示器 / 真实 GPU 合成）：倍速丢帧归因的**判别性**重测。
 *
 * ## 为什么要重测
 *
 * 第一轮（`verify_playback_rate_profile.cjs`）跑在 **headless Edge + `--disable-gpu`**
 * （软件合成）下，测得「倍速越高丢帧越多」，据此判为 (P) 呈现预算不足。该结论有两个
 * 在软件合成环境里无法回答的疑点：
 *
 *   1. headless 下 rAF 刷新率被钉在 ~60Hz（软件合成的假上限），而据称本机真实显示器
 *      是 165Hz（2560×1440）。若刷新率真是 165Hz，则 30fps 源 2x=60fps、4x=120fps
 *      **都低于刷新率**，按「刷新率上限」理论**根本不该丢帧**。
 *   2. headless 实测 2x 呈现只有 ~40.8fps，**明显低于它自己测到的 60.3Hz 上限** ——
 *      说明除刷新率外还有一个**随倍速增长**的瓶颈。
 *
 * 因此必须在**真实显示器 + 真实 GPU 合成（headful）**下重测，才能把
 *   (P) 呈现预算（需求帧率 > 实际刷新率）
 *   (D) 解码/渲染吞吐（每帧工作量随倍速线性增长，与分辨率关系不大）
 *   (T) 投递/转码（缓冲被抽干 / waiting 频发）
 * 三者分开。
 *
 * ## 决定性判据（本脚本核心）
 *
 *   1. **呈现帧率 vs 刷新率**：呈现帧率**低于**刷新率 ⇒ 瓶颈**不是**刷新率上限 ——
 *      不是 (P)，而是吞吐 (D)（或供给 T）。
 *   2. **呈现间隔的规则性**：记录相邻 `requestVideoFrameCallback` 的
 *      wall-clock / mediaTime / presentedFrames 间隔序列，算**标准差**与**最大间隔**。
 *      - 均匀的低帧率（如 60Hz 上放 30fps，每帧隔 33ms）→ 帧率低但**不卡**（P 类）。
 *      - 忽大忽小的间隔（抖动/突发）→ 解码/渲染跟不上，**卡**（D 类）。
 *   3. **每帧解码耗时** `VideoFrameCallbackMetadata.processingDuration`（Chromium 直接
 *      给出的「单帧提交→可合成」耗时，ms）。若逼近/超过该倍速下的帧间隔预算 ⇒ (D) 直接证据。
 *   4. **供给**：`buffered.end(last) - currentTime` 最小值 + `waiting`/`stalled` 计数。
 *      缓冲始终领先、无 waiting ⇒ 供给充足，排除 (T)。
 *   5. **有效播放速率** `ΔcurrentTime / Δwall`：≈ 设定倍速 ⇒ 时钟跟得上；明显 < 设定 ⇒
 *      解码/投递拖住了时钟 ⇒ (D)/(T)。
 *
 * ## 夹具（见 BUG-209 交接）
 *
 *   - 472：源 HEVC 1280×720 **60fps** ⇒ 无 HEVC 解码时走**兼容流** `/stream`（代理 H.264
 *          30fps）；headful + 真实 GPU 下若 OS/硬件能解 HEVC，则**停在 `/raw` 60fps**
 *          （与 headless 的关键差异，如实记录）。
 *   - 598：H.264 High 720×1280 **30fps** ⇒ `/raw`。
 *   - 607：H.264 Main 480×852 **30fps** ⇒ `/raw`。
 *
 * ## 采集项（每个 夹具 × 倍速∈{1,2,4}，10s 窗口）
 *
 *   呈现帧率（rVFC）· 间隔标准差/最大间隔 · 丢帧 · 每帧 processingDuration ·
 *   缓冲最小值/waiting/stalled · currentSrc 路径 · 「解码吃力」提示在场 ·
 *   窗口内 playbackRate/paused 采样（确认倍速确实生效）。
 *
 * 另采：窗口落屏（screen/DPR/outer/inner）、真实刷新率（rAF 2s）、
 * GPU 合成（CDP `SystemInfo.getInfo` featureStatus + chrome://gpu 兜底）。
 *
 * ## 稳健性（第一版踩过的坑）
 *
 *   - 每个 (夹具 × 倍速) **重新打开一次播放器**：避免跨倍速的倍速残留 / 元素状态污染。
 *   - 截图先写**系统临时目录**（不在 Vite 监听树内），跑完再拷进 `verify_shots/rate_real/`，
 *     排除「写文件触发 Vite HMR 整页重载 → 播放器消失」这一验收通道干扰。
 *   - 每一步都对「video 元素是否还在」做守卫；若消失则记 `viewerVanished` 并重开一次。
 *   - 记录 `Runtime.exceptionThrown` 的**时间线**，便于把「播放器消失」定位到具体异常。
 *
 * ## 用法
 *
 *   node verify/verify_rate_real_display.cjs
 *   环境变量：APP_PORT / APP_URL / OUT / PROBE_ITEMS / WINDOW_SEC / DEBUG_PORT。
 *
 * 产物：`tauri-shell/verify_shots/rate_real/`（截图 + JSON + Markdown 表）。
 * 退出码：0 = 画像跑完；1 = 脚本自身/页面异常；2 = 环境不可达。
 *
 * **只读**：仅打开播放器并播放，不写后端（localStorage 的兼容流记忆属客户端）。
 * **headful**：不加 `--headless`、不加 `--disable-gpu`，用真实窗口/真实 GPU 合成。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://localhost:${APP_PORT}/`
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9222)
const OUT = path.resolve(process.env.OUT || path.join(__dirname, '..', 'verify_shots', 'rate_real'))
/** 截图先落临时目录（不在 Vite 监听树内），跑完再拷进 OUT。 */
const SHOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-rate-real-shots-'))
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEMS = (process.env.PROBE_ITEMS || '472,598,607')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const RATES = [1, 2, 4]
const WINDOW_SEC = Number(process.env.WINDOW_SEC || 10)
/** 改速后的解码器预热静默期（对齐 decodeHealth.ts 的 WARMUP_MS=1500）。 */
const WARMUP_MS = 1800
const FRAME_WAIT_MS = 90000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 每个夹具在**实际路径**下的源帧率假设（用于算需求帧率）。
 * @param {number} item 条目 id
 * @param {string} pathKind 'raw' | 'stream' | 'other'
 * @returns {number} 源帧率
 */
function assumedSourceFps(item, pathKind) {
  if (item === 472) return pathKind === 'stream' ? 30 : 60
  return 30
}

// ---------------------------------------------------------------------------
// headful 浏览器进程管理
// ---------------------------------------------------------------------------

async function waitForDevtools(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(body) : null)
          } catch (_e) {
            resolve(null)
          }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
    })
    if (info && info.webSocketDebuggerUrl) return info
    await delay(200)
  }
  throw new Error(`DevTools endpoint on 127.0.0.1:${port} not ready within ${timeoutMs}ms`)
}

/**
 * 起一个 **headful**（有窗口、不 `--disable-gpu`）Edge，打开应用首页。
 *
 * 注（BUG-213）：`lib/cdp.cjs` 的 `launch()` 缺陷已修复，后续可直接
 * `cdp.launch({ headless: false })` 得到 headful 浏览器。本函数保留以维持本脚本
 * 独立可用（实现与行为均不变），不必再自建 headful 起法。
 *
 * @returns {Promise<{proc:import('child_process').ChildProcess, executable:string, userDataDir:string, version:object}>}
 */
async function launchHeadful() {
  const executable = cdp.findBrowser()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-headful-'))
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1000,700',
    '--window-position=40,40',
    APP_URL,
  ]
  const proc = spawn(executable, args, { stdio: 'ignore', windowsHide: false })
  proc.on('error', (err) => console.error(`[real] failed to spawn browser: ${err.message}`))
  const version = await waitForDevtools(DEBUG_PORT, 30000)
  return { proc, executable, userDataDir, version }
}

async function killTree(proc, userDataDir) {
  let exited = false
  if (proc) {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' })
        } else {
          proc.kill('SIGKILL')
        }
      } catch (_e) {
        /* already gone */
      }
    }
    exited = await new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true)
      const timer = setTimeout(() => resolve(false), 4000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
  try {
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch (_e) {
    /* best effort */
  }
  return exited
}

// ---------------------------------------------------------------------------
// 页面内探针
// ---------------------------------------------------------------------------

async function displayInfo(page) {
  return page.evaluate(() => ({
    screenW: window.screen.width,
    screenH: window.screen.height,
    availW: window.screen.availWidth,
    availH: window.screen.availHeight,
    availLeft: window.screen.availLeft,
    availTop: window.screen.availTop,
    dpr: window.devicePixelRatio,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    colorDepth: window.screen.colorDepth,
    screenX: window.screenX,
    screenY: window.screenY,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    hardwareConcurrency: navigator.hardwareConcurrency,
  }))
}

/** 把窗口提到前台（后台/被遮挡时 Chromium 会把 rAF 节流，导致刷新率测不准）。 */
async function bringToFront(page) {
  try {
    await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId })
    await delay(400)
  } catch (_e) {
    /* ignore */
  }
}

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

/** 通过 store 打开一个视频条目（src 用 /raw，MediaViewer 内部按需补 compatSrc）。 */
async function openItem(page, item) {
  const src = `${TG}/api/media/items/${item}/raw`
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
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 15000,
  })
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      v.play().catch(() => {})
    }
  })
}

async function closeViewer(page) {
  try {
    await page.evaluate(() => {
      const s = window.__origStore
      if (s && s.getState) s.getState().closeViewer()
    })
  } catch (_e) {
    /* ignore */
  }
  await delay(400)
}

async function waitFramed(page, timeoutMs = FRAME_WAIT_MS) {
  return page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false)
}

async function videoSnapshot(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) {
      return {
        exists: false,
        rootChildren: document.querySelector('#root')?.children.length ?? -1,
      }
    }
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    const src = String(v.currentSrc || v.src || '')
    return {
      exists: true,
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
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      rootChildren: document.querySelector('#root')?.children.length ?? -1,
      compatBanner: !!document.querySelector('[data-testid="player-compat-banner"]'),
      halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      strained: document.body.innerText.includes('解码吃力'),
    }
  })
}

async function hasRateUI(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some((b) => {
      const a = b.getAttribute('aria-label') || ''
      return a === '播放速度' || a === 'Playback speed'
    }),
  )
}

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
      return {
        ok: false,
        reason: 'rate item not found',
        seen: items.map((b) => (b.textContent || '').trim()),
      }
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

async function setRateDirect(page, rate) {
  const actual = await page.evaluate((r) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    v.playbackRate = r
    return v.playbackRate
  }, rate)
  return { ok: actual === rate, actual, reason: 'direct' }
}

/** 设倍速：优先真实 UI，失败回退直接写 video.playbackRate，最后再断言一次。 */
async function setRate(page, rate) {
  let res = await setRateViaUI(page, rate)
  let method = 'ui'
  if (!res.ok) {
    res = await setRateDirect(page, rate)
    method = 'direct'
  }
  // 无论走哪条路，最后都断言一次实际值
  const actual = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    return v ? v.playbackRate : null
  })
  if (actual !== rate) {
    const forced = await setRateDirect(page, rate)
    if (forced.actual === rate) method = 'forced-direct'
    res = forced
  }
  return { ok: actual === rate || res.actual === rate, actual: res.actual, method, reason: res.reason }
}

/**
 * 一个 10s 采样窗口。整个窗口在页面内一次性跑完。
 * 返回每帧 `series`（wall/mediaTime/presentedFrames/processingDuration）+ 100ms 采样
 * （缓冲领先、readyState、playbackRate、paused、video 是否还在）。
 */
async function measureWindow(page, seconds) {
  return page.evaluate(async (secs) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return { error: 'no video element at window start' }
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

    // 同窗口再数一次 rAF（合成器帧）：用来区分「只有视频呈现跟不上」还是「整页都卡」
    let rafCount = 0
    let rafActive = true
    const rafTick = () => {
      if (!rafActive) return
      rafCount += 1
      requestAnimationFrame(rafTick)
    }
    requestAnimationFrame(rafTick)

    const rvfcSupported = typeof v.requestVideoFrameCallback === 'function'
    const series = []
    let rvfcHandle = null
    if (rvfcSupported) {
      const onFrame = (_now, meta) => {
        series.push({
          t: performance.now(),
          mt: meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : null,
          pf: meta && typeof meta.presentedFrames === 'number' ? meta.presentedFrames : null,
          pd:
            meta && typeof meta.processingDuration === 'number' ? meta.processingDuration : null,
        })
        rvfcHandle = v.requestVideoFrameCallback(onFrame)
      }
      rvfcHandle = v.requestVideoFrameCallback(onFrame)
    }

    const readyStates = []
    const rateSamples = []
    let pausedSamples = 0
    let samples = 0
    let videoAliveSamples = 0
    let aheadMin = Infinity
    let aheadSeen = false
    const sampler = setInterval(() => {
      samples += 1
      const el = document.querySelector('[data-testid="media-viewer"] video')
      if (el) {
        videoAliveSamples += 1
        readyStates.push(el.readyState)
        rateSamples.push(el.playbackRate)
        if (el.paused) pausedSamples += 1
        const b = el.buffered
        if (b && b.length) {
          const ahead = b.end(b.length - 1) - el.currentTime
          aheadSeen = true
          if (ahead < aheadMin) aheadMin = ahead
        }
      }
    }, 100)

    await new Promise((r) => setTimeout(r, secs * 1000))

    rafActive = false
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
      rvfcCount: series.length,
      rvfcFps: Number((series.length / wall).toFixed(1)),
      rafCount,
      rafFps: Number((rafCount / wall).toFixed(1)),
      series,
      totalDelta: q0 && q1 ? q1.totalVideoFrames - q0.totalVideoFrames : null,
      droppedDelta: q0 && q1 ? q1.droppedVideoFrames - q0.droppedVideoFrames : null,
      totalFps:
        q0 && q1 ? Number(((q1.totalVideoFrames - q0.totalVideoFrames) / wall).toFixed(1)) : null,
      presentedFpsQuality:
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
      rateSamplesMin: rateSamples.length ? Math.min(...rateSamples) : null,
      rateSamplesMax: rateSamples.length ? Math.max(...rateSamples) : null,
      pausedSamples,
      samples,
      videoAliveSamples,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      readyState: v.readyState,
      networkState: v.networkState,
      playbackRate: v.playbackRate,
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      path: src.includes('/stream') ? 'stream' : src.includes('/raw') ? 'raw' : 'other',
      currentSrc: src,
      compatBanner: !!document.querySelector('[data-testid="player-compat-banner"]'),
      halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      strained: document.body.innerText.includes('解码吃力'),
    }
  }, seconds)
}

// ---------------------------------------------------------------------------
// 间隔 / 抖动统计（Node 侧）
// ---------------------------------------------------------------------------

function stats(nums) {
  if (!nums.length) return null
  const n = nums.length
  const mean = nums.reduce((a, b) => a + b, 0) / n
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1)
  const sorted = nums.slice().sort((a, b) => a - b)
  const pick = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))]
  return {
    count: n,
    mean: Number(mean.toFixed(3)),
    stdDev: Number(Math.sqrt(variance).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    p50: Number(pick(50).toFixed(3)),
    p95: Number(pick(95).toFixed(3)),
    max: Number(sorted[n - 1].toFixed(3)),
  }
}

function intervalStats(series) {
  const wall = []
  const mt = []
  const pf = []
  const pd = []
  for (let i = 1; i < series.length; i++) {
    wall.push(series[i].t - series[i - 1].t)
    if (series[i].mt != null && series[i - 1].mt != null) {
      mt.push((series[i].mt - series[i - 1].mt) * 1000)
    }
    if (series[i].pf != null && series[i - 1].pf != null) {
      pf.push(series[i].pf - series[i - 1].pf)
    }
  }
  for (const s of series) if (s.pd != null) pd.push(s.pd * 1000)
  const pfStats = stats(pf)
  return {
    wallIntervalMs: stats(wall),
    mediaIntervalMs: stats(mt),
    presentedFramesStep: pfStats ? { ...pfStats, stepsGt1: pf.filter((x) => x > 1).length } : null,
    processingDurationMs: stats(pd),
  }
}

// ---------------------------------------------------------------------------
// GPU 合成状态
// ---------------------------------------------------------------------------

async function readGpu(conn) {
  let sysInfo = null
  try {
    const r = await conn.send('SystemInfo.getInfo', {}, { timeoutMs: 8000 })
    if (r && r.gpu) {
      sysInfo = {
        devices: (r.gpu.devices || []).map((d) => ({
          vendor: d.vendorString || d.vendorId,
          device: d.deviceString || d.deviceId,
          driverVendor: d.driverVendor,
          driverVersion: d.driverVersion,
        })),
        featureStatus: r.gpu.featureStatus || {},
        auxAttributes: r.gpu.auxAttributes || {},
      }
    }
  } catch (e) {
    sysInfo = { error: String((e && e.message) || e) }
  }

  let chromeGpuText = null
  try {
    const { targetId } = await conn.send('Target.createTarget', { url: 'chrome://gpu' })
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true })
    await conn.send('Runtime.enable', {}, { sessionId })
    for (let i = 0; i < 40; i++) {
      const t = await conn.send(
        'Runtime.evaluate',
        { expression: 'document.body ? document.body.innerText : ""', returnByValue: true },
        { sessionId },
      )
      const txt = t && t.result && t.result.value
      if (txt && String(txt).length > 200) {
        chromeGpuText = String(txt)
        break
      }
      await delay(300)
    }
    await conn.send('Target.closeTarget', { targetId }).catch(() => {})
  } catch (e) {
    chromeGpuText = `unavailable: ${String((e && e.message) || e)}`
  }
  return { sysInfo, chromeGpuText }
}

function gpuKeyLines(text) {
  if (!text || typeof text !== 'string') return []
  const keys = [
    'Canvas',
    'Rasterization',
    'Video Decode',
    'Video Encode',
    'WebGL',
    'Compositing',
    'Multiple Raster Threads',
    'Vulkan',
    'Direct3D',
    'GPU0',
    'Driver',
  ]
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && keys.some((k) => l.includes(k)))
    .slice(0, 40)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[real] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(SHOT_TMP, name)
  try {
    await page.screenshot(f)
    return f
  } catch (e) {
    console.log(`[real] shot ${name} FAILED: ${(e && e.message) || e}`)
    return null
  }
}

/**
 * 跑一个 (夹具 × 倍速)：重开播放器 → 设速 → 预热 → 10s 窗口。
 * @returns {Promise<object>} 该档结果
 */
async function runPhase(page, item, rate) {
  await closeViewer(page)
  await openItem(page, item)
  const framed = await waitFramed(page)
  const opened = await videoSnapshot(page)
  if (!framed || !opened || !opened.exists) {
    return {
      item,
      rate,
      error: `viewer did not open/frame (framed=${framed}, exists=${opened && opened.exists})`,
    }
  }

  const setRes = await setRate(page, rate)
  await delay(WARMUP_MS)

  const pre = await videoSnapshot(page)
  let reopened = false
  if (!pre || !pre.exists) {
    // 播放器在预热期消失 → 重开一次（记录事实，不掩盖）
    reopened = true
    await closeViewer(page)
    await openItem(page, item)
    await waitFramed(page)
    await setRate(page, rate)
    await delay(WARMUP_MS)
  }

  const m = await measureWindow(page, WINDOW_SEC)
  if (m.error) {
    return { item, rate, error: m.error, rateMethod: setRes.method, rateActual: setRes.actual, reopened, opened }
  }

  const iv = intervalStats(m.series || [])
  const sourceFps = assumedSourceFps(item, m.path)
  const needFps = sourceFps * rate
  const dropPct =
    m.totalDelta != null && m.droppedDelta != null && m.totalDelta > 0
      ? Number(((100 * m.droppedDelta) / m.totalDelta).toFixed(1))
      : null

  const w = iv.wallIntervalMs
  const pd = iv.processingDurationMs
  console.log(
    `[real] ${item} ${rate}x (${setRes.method}, actual=${setRes.actual}, reopened=${reopened}) |` +
      ` presented(rVFC) ${m.rvfcFps}fps | raf ${m.rafFps}fps | quality-presented ${m.presentedFpsQuality}fps total ${m.totalFps}fps |` +
      ` dropped +${m.droppedDelta} (${dropPct}%) | interval mean ${w ? w.mean : '-'}ms sd ${w ? w.stdDev : '-'}ms max ${w ? w.max : '-'}ms |` +
      ` procDur mean ${pd ? pd.mean : '-'}ms max ${pd ? pd.max : '-'}ms |` +
      ` aheadMin ${m.aheadMin}s | waiting ${m.events.waiting} stalled ${m.events.stalled} |` +
      ` readyState ${m.readyStateMin}-${m.readyStateMax} | rateSample ${m.rateSamplesMin}-${m.rateSamplesMax} paused#${m.pausedSamples}/${m.samples} |` +
      ` effRate ${m.effRate}x | path ${m.path} | strained ${m.strained}`,
  )
  await shot(page, `${item}_${rate}x.png`)

  return {
    item,
    rate,
    rateMethod: setRes.method,
    rateActual: setRes.actual,
    reopened,
    sourceFps,
    needFps,
    dropPct,
    opened,
    interval: iv,
    // series 太长，不写进 JSON（统计已抽干）
    ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'series')),
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`[real] headful probe starting; app=${APP_URL} debugPort=${DEBUG_PORT}`)
  console.log(`[real] screenshots staged in ${SHOT_TMP} (outside Vite tree), copied to ${OUT} at end`)

  let launched
  try {
    launched = await launchHeadful()
  } catch (e) {
    console.error(`[real] ENV: headful browser launch failed: ${(e && e.message) || e}`)
    process.exit(2)
  }
  console.log(`[real] headful Edge: ${launched.executable} pid=${launched.proc.pid}`)

  let conn
  const results = {
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    debugPort: DEBUG_PORT,
    browser: launched.executable,
    fixtures: [],
    pageErrorEvents: [],
    checks,
  }

  try {
    conn = new cdp.CdpConnection(launched.version.webSocketDebuggerUrl)
    await conn.connect()
    // 重载/卡顿的页面会让 Runtime.evaluate 很慢：放宽命令超时，避免 30s 就丢掉一档样本
    conn.timeoutMs = 150000

    const { targetInfos } = await conn.send('Target.getTargets')
    const pageTarget = (targetInfos || []).find((t) => t.type === 'page')
    if (!pageTarget) throw new Error('no page target found after launch')
    const { sessionId } = await conn.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    })
    const page = new cdp.Page(conn, sessionId)
    await page._enable()
    // 真实显示器测量：清掉 cdp 默认注入的 1440×900/DPR1 设备仿真
    try {
      await conn.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId })
    } catch (_e) {
      /* ignore */
    }

    // 记录异常时间线（用于把「播放器消失」定位到具体异常）
    const t0 = Date.now()
    conn.on('Runtime.exceptionThrown', (p) => {
      const d = (p && p.exceptionDetails) || {}
      const text = (d.exception && d.exception.description) || d.text || 'unknown'
      results.pageErrorEvents.push({ atSec: Number(((Date.now() - t0) / 1000).toFixed(2)), text: String(text) })
    })

    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
    await bringToFront(page)
    console.log('[real] app ready at', APP_URL)

    const disp = await displayInfo(page)
    results.display = disp
    console.log(`[real] display: ${JSON.stringify(disp)}`)

    const gpu = await readGpu(conn)
    results.gpu = { sysInfo: gpu.sysInfo, keyLines: gpuKeyLines(gpu.chromeGpuText) }
    if (gpu.sysInfo && gpu.sysInfo.featureStatus) {
      const fsx = gpu.sysInfo.featureStatus
      console.log(
        `[real] GPU featureStatus: gpu_compositing=${fsx.gpu_compositing} video_decode=${fsx.video_decode} rasterization=${fsx.rasterization} canvas=${fsx.canvas} webgl=${fsx.webgl} webgl2=${fsx.webgl2}`,
      )
      console.log(`[real] GPU devices: ${JSON.stringify(gpu.sysInfo.devices)}`)
    } else {
      console.log(`[real] GPU sysInfo: ${JSON.stringify(gpu.sysInfo)}`)
    }
    console.log(`[real] chrome://gpu keyLines: ${JSON.stringify(results.gpu.keyLines)}`)

    for (const item of ITEMS) {
      console.log(`\n[real] ===== fixture ${item} =====`)
      await bringToFront(page)
      const refreshHz = await measureRefreshHz(page)
      console.log(`[real] ${item} refresh ≈ ${refreshHz} Hz (rAF, headful)`)
      const uiAvailable = await hasRateUI(page)
      console.log(`[real] ${item} rate UI available = ${uiAvailable}`)
      const phases = []
      for (const rate of RATES) {
        try {
          const p = await runPhase(page, item, rate)
          p.refreshHz = refreshHz
          phases.push(p)
        } catch (e) {
          console.error(`[real] ${item} ${rate}x ERROR: ${(e && e.stack) || e}`)
          phases.push({ item, rate, error: String((e && e.message) || e) })
        }
      }
      results.fixtures.push({ item, refreshHz, uiAvailable, phases })
    }

    await closeViewer(page)

    const pageErrors = page.pageErrors().slice(0, 20)
    const consoleErrors = page.consoleErrors().slice(0, 20)
    results.pageErrors = pageErrors
    results.consoleErrors = consoleErrors
    console.log('[real] PAGE_ERRORS:', JSON.stringify(pageErrors))
    console.log('[real] PAGE_ERROR_EVENTS:', JSON.stringify(results.pageErrorEvents))
    console.log('[real] CONSOLE_ERRORS:', JSON.stringify(consoleErrors))

    fs.writeFileSync(path.join(OUT, 'rate_real.json'), JSON.stringify(results, null, 2))

    const lines = []
    lines.push(
      '| 夹具 | 倍速 | 呈现fps(rVFC) | 整页raf fps | 刷新率 | 丢帧% | 间隔标准差ms | 最大间隔ms | 单帧处理ms(均值) | 缓冲最小s | waiting | 路径 | 解码吃力 |',
    )
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const fx of results.fixtures) {
      for (const p of fx.phases) {
        if (p.error) {
          lines.push(`| ${p.item} | ${p.rate}x | ERROR: ${p.error} | | | | | | | | | | |`)
          continue
        }
        const w = p.interval && p.interval.wallIntervalMs
        const pd = p.interval && p.interval.processingDurationMs
        lines.push(
          `| ${p.item} | ${p.rate}x | ${p.rvfcFps} | ${p.rafFps} | ${p.refreshHz}Hz | ${p.dropPct}% | ${w ? w.stdDev : '-'} | ${w ? w.max : '-'} | ${pd ? pd.mean : '-'} | ${p.aheadMin} | ${p.events.waiting} | ${p.path} | ${p.strained} |`,
        )
      }
    }
    const md = lines.join('\n')
    fs.writeFileSync(path.join(OUT, 'rate_real.md'), md + '\n')
    console.log('\n[real] === MARKDOWN ===')
    console.log(md)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[real] === SUMMARY ===')
    console.log(
      `[real] checks total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`,
    )
    if (failed.length) console.log('[real] FAILED:', failed.map((c) => c.name).join(' | '))
    console.log(`[real] artifacts in ${OUT}`)
  } catch (e) {
    console.error('[real] ERROR', (e && e.stack) || e)
    process.exitCode = 1
  } finally {
    try {
      if (conn) conn.closeSocket()
    } catch (_e) {
      /* ignore */
    }
    const exited = await killTree(launched.proc, launched.userDataDir)
    console.log(`[real] headful Edge pid=${launched.proc.pid} killed=${exited}`)
    results.browserClosed = exited

    // 把临时截图拷进 OUT（此时测量已结束，写文件不会再影响结果）
    try {
      fs.mkdirSync(OUT, { recursive: true })
      for (const f of fs.readdirSync(SHOT_TMP)) {
        fs.copyFileSync(path.join(SHOT_TMP, f), path.join(OUT, f))
      }
      fs.rmSync(SHOT_TMP, { recursive: true, force: true })
      console.log(`[real] screenshots copied to ${OUT}`)
    } catch (e) {
      console.log(`[real] screenshot copy failed: ${(e && e.message) || e}`)
    }
  }
}

main()
