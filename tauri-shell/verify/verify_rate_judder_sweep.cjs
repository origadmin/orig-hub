#!/usr/bin/env node
'use strict'

/**
 * BUG-218 取证仪器：倍速档位**抽帧均匀性**单跑扫描（rate judder sweep）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 本文件是 #33 的重写版（原 software-engineer-12 的 BUG-217/218 版本已对
 * 2026-10-09 stream-first 翻转失效：其 bare 臂直放 472 的 /raw = HEVC 0 帧）。
 * 重写后是其超集：多源、多倍速、app+bare 两臂、单跑、x-orig-stream 路径标注。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## 为什么需要它
 *
 * 呈现帧率随倍速上升会撞上显示器刷新率上限，「丢帧」本身是物理必然（BUG-209/212）。
 * 但用户感知的**卡**不只取决于丢了多少帧，还取决于**剩下的帧排得匀不匀**——同样呈现
 * ~50fps，「每 2 个 vsync 稳定出一帧」看着顺，「一串 1-vsync 间隔里突然插一个
 * 4-vsync 长间隔」看着就是一顿一顿。本仪器量化后者：**抽帧间隔的分布均匀性**。
 *
 * ## 采集设计（单跑：1 个 Edge / 1 页 / 一次跑完）
 *
 *   - 8 个倍速档 × N 个源（默认 472 / 673）——每个 (源, 倍速) **全新打开**一次：
 *     先把倍速写进 `orighub_player_settings`，再 openViewer，让播放器以该倍速挂载
 *     （= 真实用户路径「选好倍速再播」；也避开「1x 起播失败→halted 卡死」的陷阱）。
 *   - 2 个**裸 `<video>` 对照**（无 React 控件层）：源基础代理流 + 浏览器原生
 *     `playbackRate`（2x / 4x）。用来分离「App 播放器/服务端 FRC」与「媒体管道本身」。
 *
 * ## 每个采样的指标
 *
 *   1. `间隔直方图`：`video.requestVideoFrameCallback` 记录**相邻两帧真正上屏**的时间
 *      差，按 vsync 周期整数倍分箱（1×/2×/3×/…）。
 *   2. `jitterShare`：**未落在众数分箱**的呈现间隔占比（只在 ≤100ms 的呈现间隔上算，
 *      排除供数长间隙）——越大越顿。干净稳定 ≈ 0；2:1 交替 ≈ 0.5。
 *   3. `cv`：间隔变异系数（stddev/mean）。
 *   4. `理论 frames-per-vsync` = 需求帧率 / 刷新率；理论丢帧占比 = `max(0, 1 − 刷新率/需求)`。
 *   5. 供数证据：`waiting`/`stalled`、缓冲领先最小值、`x-orig-stream`（proxy/live/…）、
 *      `readyState`、`videoWidth`。**未出帧**的采样记为 `unplayable`（如 503 冷流）。
 *
 * 判读：`jitterShare` 高但 `waiting=0` 且路径=proxy ⇒ 抽帧不均来自**呈现层**；
 * `waiting>0` / 路径=live ⇒ 该采样被**供数**污染，需打折看。
 *
 * ## 用法
 *
 *   先起服务（daemon + orig-tg 19787 + vite dev 5180），再：
 *     node verify/verify_rate_judder_sweep.cjs
 *   环境变量：APP_PORT / TG_URL / ORIG_VERIFY_OUT / JUDDER_ITEMS / JUDDER_WINDOW_SEC /
 *             JUDDER_FRAME_WAIT_MS / JUDDER_SRC_FPS。
 *
 * 产物：`tauri-shell/verify_shots/rate_judder/`（judder_sweep.json + .md + 截图）。
 * 退出码：0 = 扫描完成；1 = 脚本/页面异常；2 = 环境不可达。
 *
 * 只读仪器：不写后端、不改产品代码（播放会触发服务端转码缓存，属既有行为）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', 'verify_shots', 'rate_judder'),
)
const ITEMS = (process.env.JUDDER_ITEMS || '472,673')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
/** 8 个倍速档（与 VideoPlayer.tsx 的 RATES 对齐） */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
/** 裸 video 对照的倍速档（用户报的痛点档） */
const BARE_RATES = [2, 4]
/** 每个采样窗口（秒） */
const WINDOW_SEC = Number(process.env.JUDDER_WINDOW_SEC || 6)
/** 改速/起播后的预热静默期 */
const WARMUP_MS = 1600
/** 等待「出帧」的上限（冷 live 起转可能久；未出帧则记 unplayable） */
const FRAME_WAIT_MS = Number(process.env.JUDDER_FRAME_WAIT_MS || 40000)
/** 源帧率（472 代理与 673 均为 30fps） */
const SRC_FPS = Number(process.env.JUDDER_SRC_FPS || 30)
/**
 * 导航/挂载超时。默认 30s 在空闲机器上够用，但当本机已被若干并发 ffmpeg（FRC 变体
 * 转码在断开后继续跑，见 routes.rs:4637）占满 CPU 时，dev server 首屏加载会超过 30s，
 * 于是整轮扫描在**第一个 navigate** 就报 "Page.navigate timed out" 直接夭折。
 * 放宽到可配（JUDDER_NAV_TIMEOUT_MS），让扫描在负载下也能起来；不影响测量语义。
 */
const NAV_TIMEOUT_MS = Number(process.env.JUDDER_NAV_TIMEOUT_MS || 45000)
/** 呈现间隔上限：超过此值视为供数间隙（stall gap），不计入 jitterShare */
const PRESENT_GAP_MS = 100

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 统计本机 ffmpeg 进程数（Windows）。
 *
 * 为什么要它：App 的 FRC 变体转码在**客户端断开后仍继续**（routes.rs 注释：
 * "Canonical FRC variants keep transcoding to a seekable speed-specific proxy"），
 * 于是访问过若干冷缓存倍速后，会有 N 个 ffmpeg 并发跑满 CPU → 后续采样全部供数受限。
 * `JUDDER_DRAIN=1` 时在开测前等它们跑完，让第二遍测量落在**已就绪的代理**上（干净）。
 */
function ffmpegCount() {
  try {
    const out = execFileSync('tasklist', [], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return out.split(/\r?\n/).filter((l) => /ffmpeg\.exe/i.test(l)).length
  } catch (_e) {
    return -1
  }
}

function collectNetwork(page) {
  const seen = []
  page.conn.on('Network.responseReceived', (p) => {
    const r = (p && p.response) || {}
    const url = String(r.url || '')
    if (!url.includes('/stream') && !url.includes('/raw')) return
    const h = r.headers || {}
    seen.push({ url, status: r.status, stream: h['x-orig-stream'] || h['X-Orig-Stream'] || null })
  })
  return seen
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

/** 把倍速写进播放器偏好（下次挂载即生效），并打开条目（stream-first）。 */
async function openAtRate(page, item, rate) {
  await page.evaluate(
    (tg, it, r) => {
      try {
        const raw = localStorage.getItem('orighub_player_settings')
        const s = raw ? JSON.parse(raw) : {}
        s.playbackRate = r
        localStorage.setItem('orighub_player_settings', JSON.stringify(s))
      } catch (_e) {
        /* ignore */
      }
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${it}`,
            chatId: 0,
            messageId: it,
            kind: 'video',
            caption: '',
            description: null,
            src: `${tg}/api/media/items/${it}/raw`,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    },
    TG,
    item,
    rate,
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
  const framed = await page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: FRAME_WAIT_MS, intervalMs: 250 },
    )
    .then(() => true)
    .catch(() => false)
  return framed
}

async function closeViewer(page) {
  await page.evaluate(() => window.__origStore.getState().closeViewer()).catch(() => {})
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="media-viewer"]'), {
      timeout: 8000,
      intervalMs: 200,
    })
    .catch(() => {})
  await delay(300)
}

/**
 * 一个采样窗口：rVFC 相邻间隔 + waiting/stalled + 缓冲最小 + 路径 + 元素状态。
 * @param {'app'|'bare'} target
 */
async function measureJudder(page, seconds, target) {
  return page.evaluate(
    async (secs, which) => {
      const v =
        which === 'bare'
          ? document.getElementById('__bare_video')
          : document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return { error: 'no video element', frames: 0, presentedFps: 0 }
      const t0 = performance.now()
      const intervals = []
      let last = null
      let waiting = 0
      let stalled = 0
      const onWait = () => {
        waiting += 1
      }
      const onStall = () => {
        stalled += 1
      }
      v.addEventListener('waiting', onWait)
      v.addEventListener('stalled', onStall)
      let aheadMin = Infinity
      let aheadSeen = false
      const sampler = setInterval(() => {
        const b = v.buffered
        if (b && b.length) {
          aheadSeen = true
          const a = b.end(b.length - 1) - v.currentTime
          if (a < aheadMin) aheadMin = a
        }
      }, 100)
      const rvfc = typeof v.requestVideoFrameCallback === 'function'
      let handle = null
      let frames = 0
      if (rvfc) {
        const onFrame = (now) => {
          frames += 1
          if (last != null) intervals.push(now - last)
          last = now
          handle = v.requestVideoFrameCallback(onFrame)
        }
        handle = v.requestVideoFrameCallback(onFrame)
      }
      await new Promise((r) => setTimeout(r, secs * 1000))
      clearInterval(sampler)
      v.removeEventListener('waiting', onWait)
      v.removeEventListener('stalled', onStall)
      if (handle != null) {
        try {
          v.cancelVideoFrameCallback(handle)
        } catch (_e) {
          /* ignore */
        }
      }
      const wall = (performance.now() - t0) / 1000
      const src = String(v.currentSrc || v.src || '')
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null
      return {
        wallSecs: Number(wall.toFixed(2)),
        rvfc,
        frames,
        presentedFps: Number((frames / wall).toFixed(1)),
        intervalsMs: intervals.map((x) => Number(x.toFixed(2))),
        waiting,
        stalled,
        aheadMin: aheadSeen && isFinite(aheadMin) ? Number(aheadMin.toFixed(2)) : null,
        playbackRate: v.playbackRate,
        videoWidth: v.videoWidth,
        readyState: v.readyState,
        totalFrames: q ? q.totalVideoFrames : null,
        droppedFrames: q ? q.droppedVideoFrames : null,
        path: src.includes('/stream') ? 'stream' : src.includes('/raw') ? 'raw' : 'other',
        currentSrc: src,
        halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      }
    },
    seconds,
    target,
  )
}

/**
 * judder 统计：直方图（按 vsync 整数倍）+ jitterShare + cv + 理论值。
 * @param {number[]} intervalsMs
 * @param {number} refreshHz
 * @param {number} demandFps 源fps × 倍速
 */
function judderStats(intervalsMs, refreshHz, demandFps) {
  const vsync = 1000 / refreshHz
  const present = intervalsMs.filter((x) => x > vsync * 0.5 && x <= PRESENT_GAP_MS)
  const gaps = intervalsMs.filter((x) => x > PRESENT_GAP_MS)
  const hist = {}
  for (const x of present) {
    const k = Math.max(1, Math.round(x / vsync))
    hist[k] = (hist[k] || 0) + 1
  }
  const total = present.length
  let modalK = null
  let modalCount = 0
  for (const [k, c] of Object.entries(hist)) {
    if (c > modalCount) {
      modalCount = c
      modalK = Number(k)
    }
  }
  const jitterShare = total > 0 ? Number((1 - modalCount / total).toFixed(3)) : null
  const mean = total > 0 ? present.reduce((a, b) => a + b, 0) / total : 0
  const variance = total > 0 ? present.reduce((a, b) => a + (b - mean) ** 2, 0) / total : 0
  const cv = mean > 0 ? Number((Math.sqrt(variance) / mean).toFixed(3)) : null
  return {
    presentIntervals: total,
    stallGaps: gaps.length,
    histByVsyncMultiple: hist,
    modalVsyncMultiple: modalK,
    jitterShare,
    cv,
    meanIntervalMs: Number(mean.toFixed(2)),
    vsyncMs: Number(vsync.toFixed(2)),
    framesPerVsync: Number((demandFps / refreshHz).toFixed(2)),
    theoryDropShare: Number(Math.max(0, 1 - refreshHz / demandFps).toFixed(3)),
  }
}

async function shot(page, name) {
  await page.screenshot(path.join(OUT, name), { fullPage: true }).catch(() => {})
}

const results = { refreshHz: null, srcFps: SRC_FPS, rates: RATES, samples: [], bare: [] }

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 可选：开测前等在途转码跑完（避免并发 ffmpeg 把后续采样全部拖成供数受限）
  if (process.env.JUDDER_DRAIN === '1') {
    const deadline = Date.now() + Number(process.env.JUDDER_DRAIN_MAX_MS || 1500000)
    let n = ffmpegCount()
    console.log(`[judder] drain-wait start: ffmpeg=${n}`)
    if (n < 0) {
      // 数不到（tasklist 不可用 / 被沙箱拦截）：无法排空，如实告警后继续，绝不静默假装已排空。
      console.log('[judder] drain-wait: cannot enumerate ffmpeg (tasklist unavailable); proceeding without drain')
    }
    while (n > 0 && Date.now() < deadline) {
      await delay(10000)
      const prev = n
      n = ffmpegCount()
      if (n !== prev) console.log(`[judder] drain-wait: ffmpeg=${n}`)
    }
    console.log(`[judder] drain-wait done: ffmpeg=${n}`)
  }

  let browser
  try {
    browser = await cdp.launch()
  } catch (e) {
    console.error(`[judder] ENV: browser launch failed: ${e && e.message ? e.message : e}`)
    process.exit(2)
  }
  try {
    const page = await browser.newPage()
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500, timeout: NAV_TIMEOUT_MS })
    } catch (e) {
      console.error(`[judder] ENV: dev server unreachable: ${e && e.message ? e.message : e}`)
      process.exit(2)
    }
    const netSeen = collectNetwork(page)
    try {
      await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    } catch (_e) {
      console.log('[judder] WARN: Network domain unavailable')
    }
    await page.waitForFunction(() => !!window.__origStore, { timeout: NAV_TIMEOUT_MS })
    await page.evaluate(() => localStorage.removeItem('orighub.compatSrcs'))

    results.refreshHz = await measureRefreshHz(page)
    console.log(`[judder] refresh ≈ ${results.refreshHz} Hz`)
    console.log(
      `[judder] plan: ${ITEMS.length} items x ${RATES.length} rates + ${BARE_RATES.length} bare = ${ITEMS.length * RATES.length + BARE_RATES.length} samples`,
    )

    // ---- App 路径：每 (源, 倍速) 全新打开 ----
    for (const item of ITEMS) {
      console.log(`\n[judder] ===== app item ${item} =====`)
      for (const rate of RATES) {
       try {
        await closeViewer(page)
        const framed = await openAtRate(page, item, rate)
        const demand = SRC_FPS * rate
        if (!framed) {
          const snap = await page.evaluate(() => {
            const v = document.querySelector('[data-testid="media-viewer"] video')
            return v
              ? {
                  videoWidth: v.videoWidth,
                  readyState: v.readyState,
                  currentSrc: String(v.currentSrc || ''),
                  halted: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
                }
              : null
          })
          results.samples.push({
            kind: 'app',
            item,
            rate,
            demandFps: demand,
            unplayable: true,
            path: snap && snap.currentSrc.includes('/stream') ? 'stream' : 'other',
            readyState: snap ? snap.readyState : null,
            videoWidth: snap ? snap.videoWidth : null,
            halted: snap ? snap.halted : null,
            presentedFps: 0,
            frames: 0,
            waiting: null,
            stallGaps: null,
            aheadMin: null,
            jitterShare: null,
            cv: null,
          })
          console.log(`[judder] app ${item} ${rate}x -> UNPLAYABLE (no frame in ${FRAME_WAIT_MS}ms) ${JSON.stringify(snap)}`)
          await shot(page, `app_${item}_${String(rate).replace('.', '_')}x_unplayable.png`)
          continue
        }
        await delay(WARMUP_MS)
        const m = await measureJudder(page, WINDOW_SEC, 'app')
        const st = judderStats(m.intervalsMs || [], results.refreshHz, demand)
        // 供数受限标记：waiting/stall gap/缓冲不足/未稳态 ⇒ 该采样的 judder 被供数污染，需打折看
        const supplyLimited =
          m.waiting > 0 || st.stallGaps > 0 || (m.aheadMin != null && m.aheadMin < 1) || m.readyState < 4
        const sample = {
          kind: 'app',
          item,
          rate,
          demandFps: demand,
          unplayable: false,
          supplyLimited,
          ...m,
          ...st,
        }
        delete sample.intervalsMs
        results.samples.push(sample)
        console.log(
          `[judder] app ${item} ${rate}x | presented ${m.presentedFps}fps | jitterShare ${st.jitterShare} cv ${st.cv} modal ${st.modalVsyncMultiple}×vsync | hist ${JSON.stringify(st.histByVsyncMultiple)} | gaps ${st.stallGaps} waiting ${m.waiting} | aheadMin ${m.aheadMin} | path ${m.path} rs ${m.readyState} | demand ${demand} vs ${results.refreshHz}Hz (theoryDrop ${st.theoryDropShare})${supplyLimited ? ' [SUPPLY-LIMITED]' : ''}`,
        )
        await shot(page, `app_${item}_${String(rate).replace('.', '_')}x.png`)
       } catch (e) {
        console.error(`[judder] app ${item} ${rate}x ERROR: ${e && e.message ? e.message : e}`)
        results.samples.push({
          kind: 'app',
          item,
          rate,
          error: String((e && e.message) || e),
          unplayable: true,
        })
       }
      }
    }
    await closeViewer(page)

    // ---- 裸 video 对照：基础代理流 + 原生 playbackRate ----
    console.log('\n[judder] ===== bare video controls (base /stream + native rate) =====')
    await page.evaluate(
      (tg, item) => {
        const old = document.getElementById('__bare_video')
        if (old) old.remove()
        const v = document.createElement('video')
        v.id = '__bare_video'
        v.muted = true
        v.playsInline = true
        v.preload = 'auto'
        v.src = `${tg}/api/media/items/${item}/stream`
        v.style.cssText =
          'position:fixed;left:0;top:0;width:640px;height:360px;z-index:2147483000;background:#000'
        document.body.appendChild(v)
      },
      TG,
      ITEMS[0],
    )
    const bareFramed = await page
      .waitForFunction(
        () => {
          const v = document.getElementById('__bare_video')
          return !!v && v.videoWidth > 0 && v.readyState >= 2
        },
        { timeout: FRAME_WAIT_MS, intervalMs: 250 },
      )
      .then(() => true)
      .catch(() => false)
    await page.evaluate(() => {
      const v = document.getElementById('__bare_video')
      if (v) v.play().catch(() => {})
    })
    for (const rate of BARE_RATES) {
     try {
      if (!bareFramed) {
        results.bare.push({ kind: 'bare', item: ITEMS[0], rate, unplayable: true, frames: 0, presentedFps: 0 })
        continue
      }
      await page.evaluate((r) => {
        const v = document.getElementById('__bare_video')
        if (v) v.playbackRate = r
      }, rate)
      await delay(WARMUP_MS)
      const m = await measureJudder(page, WINDOW_SEC, 'bare')
      const demand = SRC_FPS * rate
      const st = judderStats(m.intervalsMs || [], results.refreshHz, demand)
      const supplyLimited =
        m.waiting > 0 || st.stallGaps > 0 || (m.aheadMin != null && m.aheadMin < 1) || m.readyState < 4
      const sample = {
        kind: 'bare',
        item: ITEMS[0],
        rate,
        demandFps: demand,
        unplayable: false,
        supplyLimited,
        ...m,
        ...st,
      }
      delete sample.intervalsMs
      results.bare.push(sample)
      console.log(
        `[judder] bare ${ITEMS[0]} ${rate}x (native) | presented ${m.presentedFps}fps | jitterShare ${st.jitterShare} cv ${st.cv} modal ${st.modalVsyncMultiple}×vsync | hist ${JSON.stringify(st.histByVsyncMultiple)} | waiting ${m.waiting}`,
      )
      await shot(page, `bare_${rate}x.png`)
     } catch (e) {
      console.error(`[judder] bare ${rate}x ERROR: ${e && e.message ? e.message : e}`)
      results.bare.push({ kind: 'bare', item: ITEMS[0], rate, error: String((e && e.message) || e), unplayable: true })
     }
    }

    // ---- 汇总 ----
    results.streamHeadSummary = netSeen
      .filter((r) => r.url.includes('/stream'))
      .reduce((a, r) => {
        const k = r.stream || '(none)'
        a[k] = (a[k] || 0) + 1
        return a
      }, {})
    results.pageErrors = page.pageErrors().slice(0, 20)
    results.consoleErrors = page.consoleErrors().slice(0, 20)
    console.log('[judder] /stream x-orig-stream:', JSON.stringify(results.streamHeadSummary))
    console.log('[judder] PAGE_ERRORS:', JSON.stringify(results.pageErrors))

    fs.writeFileSync(path.join(OUT, 'judder_sweep.json'), JSON.stringify(results, null, 2))

    const lines = []
    lines.push(`刷新率 ≈ ${results.refreshHz}Hz；源帧率 ${SRC_FPS}fps；窗口 ${WINDOW_SEC}s。`)
    lines.push('')
    lines.push(
      '| 类型 | 条目 | 倍速 | 呈现fps | jitterShare | cv | 众数×vsync | 直方图(×vsync:帧数) | 理论fps/vsync | 理论丢帧 | 供数(waiting/gaps/aheadMin) | 路径 |',
    )
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const s of [...results.samples, ...results.bare]) {
      if (s.unplayable) {
        lines.push(
          `| ${s.kind} | ${s.item} | ${s.rate}x | **unplayable** | - | - | - | - | - | - | rs=${s.readyState} vw=${s.videoWidth} | ${s.path} |`,
        )
        continue
      }
      const hist = Object.entries(s.histByVsyncMultiple || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([k, c]) => `${k}×:${c}`)
        .join(' ')
      const warn = s.supplyLimited ? ' ⚠供数受限' : ''
      lines.push(
        `| ${s.kind} | ${s.item} | ${s.rate}x${warn} | ${s.presentedFps} | ${s.jitterShare} | ${s.cv} | ${s.modalVsyncMultiple} | ${hist} | ${s.framesPerVsync} | ${s.theoryDropShare} | ${s.waiting}/${s.stallGaps}/${s.aheadMin} | ${s.path} |`,
      )
    }
    const md = lines.join('\n')
    fs.writeFileSync(path.join(OUT, 'judder_sweep.md'), md + '\n')
    console.log('\n[judder] === MARKDOWN ===')
    console.log(md)
    console.log(`\n[judder] artifacts in ${OUT}`)
  } catch (e) {
    console.error('[judder] ERROR', e && e.stack ? e.stack : e)
    // 任何异常也落一份 partial JSON：单采样失败不得丢掉已采到的全部数据
    try {
      fs.writeFileSync(path.join(OUT, 'judder_sweep.partial.json'), JSON.stringify(results, null, 2))
      console.error(
        `[judder] partial JSON: ${results.samples.length + results.bare.length} samples (app ${results.samples.length}, bare ${results.bare.length})`,
      )
    } catch (_e) {
      /* ignore */
    }
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main()
