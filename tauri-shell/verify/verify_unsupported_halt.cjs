#!/usr/bin/env node
'use strict'

/**
 * BUG-207 真实 UI 验收：视频轨「解不出来」→ 立即停载，终止请求风暴。
 *
 * ## 缺陷回顾（用户 2026-09-30 反馈「还是播放器流畅问题…解码吃力…不可能播放器可以,浏览器不行吧?」）
 *
 * 实测定位两层根因：
 * 1. 投递层已不是瓶颈：BUG-199 环回不限速生效（实测 32MiB 0.19s ≈ 174 MB/s），
 *    可解码条目（598，720p AVC 1.9Mbps）30s 仪表化播放 **0 丢帧**、缓冲领先均值 14s。
 * 2. 解码层：库内重量级条目（472=1.78GB/12Mbps、357=308MiB/10.4Mbps）均为
 *    **HEVC（hvc1）**，本机 Chromium（WebView2/Edge）无硬件 HEVC → **0 帧解码**
 *    （videoWidth=0、totalVideoFrames=0），但音频能解、时长正常。`preload="auto"` 的
 *    `<video>` 永远等不到可播数据 → Chromium「缓冲 → abort → 重取」风暴：
 *    实测 20s 内 **97–137 个请求**（GB 级无效 IO），整个页面被拖卡。
 *    本地播放器（VLC 等）自带软件 HEVC 解码所以「播放器可以，浏览器不行」。
 *
 * ## 修复要点
 *
 * VideoPlayer 在 `useDecodeHealth` 判定 `unsupported`（且条目应有视频轨）时**立即停载**：
 * pause + removeAttribute('src') + load()，把无限风暴换成一次诚实的整屏失败提示
 * （`tg.decodeUnsupported`，文案同步改为「已停止加载 + 用系统播放器打开」）。
 * 音频条目（`hasVideoTrack=false`）无视频轨属正常，绝不触发。
 *
 * ## 判据（全部通过才算修复）
 *
 * 1. 打开 HEVC 条目 472：`player-unsupported-halt` 遮罩在 15s 内出现。
 * 2. 停载点之后 6s 窗口内，`/api/media/items/472/raw` 的新请求为 **0**（风暴终止；
 *    修复前同时长持续 97–137 个）。
 * 3. 回归：可解码条目 598 正常出帧（totalVideoFrames > 0），绝不触发停载遮罩。
 * 4. 全程无页面错误。
 *
 * 用法：先起开发态服务（`python scripts/dev_services.py` + vite dev 5180），
 * 再 `node verify/verify_unsupported_halt.cjs`（`PROBE_ITEM`/`PROBE_ITEM_OK` 可换条目）。
 * 证据目录：`ORIG_VERIFY_OUT`（默认系统临时目录 `orighub-verify-unsupported-halt`）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const HEVC_ITEM = Number(process.env.PROBE_ITEM || 472)
const OK_ITEM = Number(process.env.PROBE_ITEM_OK || 598)
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-unsupported-halt'),
)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try { size = fs.statSync(f).size } catch (_e) {}
  console.log(`[verify] shot ${name} -> ${f} (${size} bytes)`)
}

async function openItem(page, item) {
  await page.evaluate((tg, it) => {
    window.__origStore.getState().openViewer({
      items: [{ key: it, chatId: -100, messageId: it, kind: 'video', caption: '', description: '', src: `${tg}/api/media/items/${it}/raw`, poster: null, episodeNo: null, seriesId: null }],
      index: 0,
      title: '',
    })
  }, TG, item)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), { timeout: 10000 })
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) { v.muted = true; v.volume = 0; v.play().catch(() => {}) }
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    console.log('[verify] navigated to', APP_URL)
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })

    // ---- A：HEVC 条目 → 停载遮罩出现，风暴终止 ----
    await page.evaluate(() => { window.__t0 = performance.now() })
    await openItem(page, HEVC_ITEM)
    const halted = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="player-unsupported-halt"]'), { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    const haltAt = await page.evaluate(() => performance.now())
    await page.evaluate((h) => {
      window.__haltAt = h
      const viewer = document.querySelector('[data-testid="media-viewer"]')
      window.__mid = viewer ? viewer.getAttribute('data-message-id') : null
    }, haltAt)
    console.log(`[verify] halt overlay present=${halted} at +${Math.round(haltAt - (await page.evaluate(() => window.__t0)))}ms`)
    await shot(page, 'A-hevc-halt-overlay.png')
    check('A: unsupported halt overlay appears for HEVC item', halted, `item=${HEVC_ITEM}`)

    // 停载前的请求总量（media 元素的 Range 重取会进 resource timing）
    const preHalt = await page.evaluate(() => {
      const all = Array.from(performance.getEntriesByType('resource') || [])
      return all.filter((r) => String(r.name).includes(`/api/media/items/${window.__mid}/raw`)).length
    })
    console.log('[verify] media requests before halt:', preHalt)
    // 注意：停载在 NO_FRAME_MS(3s)+采样后即触发，这里只有约 3-4s 窗口，风暴积累不出
    // 97-137/20s 的完整形态——该基线由 BUG-207 的探针证据（probe report）记录。
    // 门禁只断言「停载前确有媒体请求在途」。
    check('A: media element was actively fetching before halt', preHalt >= 1, `pre-halt raw requests=${preHalt}`)

    // 停载后 6s 窗口：新请求必须为 0（风暴终止）
    await delay(6000)
    const postHalt = await page.evaluate(() => {
      const all = Array.from(performance.getEntriesByType('resource') || [])
      return all.filter((r) => String(r.name).includes(`/api/media/items/${window.__mid}/raw`) && r.startTime > window.__haltAt).length
    })
    check('A: zero new media requests in 6s after halt (storm terminated)', postHalt === 0, `post-halt requests=${postHalt}`)

    // 关闭播放器，避免 B 阶段混入 A 的计数
    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(500)

    // ---- B：可解码条目回归 → 必须出帧，绝不触发停载 ----
    await openItem(page, OK_ITEM)
    await delay(6000)
    const okState = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      return {
        vw: v.videoWidth, vh: v.videoHeight,
        frames: q ? q.totalVideoFrames : -1,
        haltOverlay: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      }
    })
    console.log('[verify] B decodable item state:', JSON.stringify(okState))
    await shot(page, 'B-decodable-plays.png')
    check('B: decodable item presents frames (no false halt)', okState && okState.frames > 0 && okState.vw > 0,
      `frames=${okState && okState.frames} ${okState && okState.vw}x${okState && okState.vh}`)
    check('B: no halt overlay for decodable item', okState && !okState.haltOverlay, `haltOverlay=${okState && okState.haltOverlay}`)

    const errs = page.pageErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(errs))
    check('no page errors', errs.length === 0, JSON.stringify(errs))

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
