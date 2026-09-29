#!/usr/bin/env node
'use strict'

/**
 * BUG-208 真实 UI 验收：视频轨「解不出来」→ 自动切兼容流（服务端实时转码 H.264）。
 *
 * ## 背景（接棒 BUG-207）
 *
 * BUG-207 把「0 帧解码」的无限风暴换成了诚实停载；但停载不解决「能看」。
 * 本修复（用户拍板）：VideoPlayer 判定 `unsupported` 时**先切兼容流**
 * （`/api/media/items/:id/stream`，orig-tg 用 ffmpeg 按需实时转 H.264 fMP4，
 * 代理完成后同地址秒开），退无可退才停载。
 *
 * ## 判据（全部通过才算修复）
 *
 * 1. 打开 HEVC 条目 472：兼容流横幅（`player-compat-banner`）在 20s 内出现。
 * 2. 切换后 90s 内视频真正出帧：videoWidth > 0 且 totalVideoFrames 持续增长
 *    （转码即播，fMP4 无需等整片转完）。
 * 3. 切换后 10s 窗口内 `/stream` 请求 ≤ 3（单飞生效，新端点无 BUG-033 式风暴）。
 * 4. 切换后 `/raw` 请求停止增长（旧源已弃）。
 * 5. 刷新记忆：localStorage 记住了解不动的源，重开同一条目直接从 `/stream` 起步。
 * 6. 回归：可解码条目 598 正常出帧，绝不切兼容流。
 * 7. 全程无页面错误。
 *
 * 用法：先起开发态服务（`python scripts/dev_services.py` + vite dev 5180），
 * 再 `node verify/verify_compat_stream.cjs`（`PROBE_ITEM`/`PROBE_ITEM_OK` 可换条目）。
 * 证据目录：`ORIG_VERIFY_OUT`（默认系统临时目录 `orighub-verify-compat-stream`）。
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
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-compat-stream'),
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

async function reqCounts(page) {
  return page.evaluate(() => {
    const all = Array.from(performance.getEntriesByType('resource') || [])
    const mid = (document.querySelector('[data-testid="media-viewer"]') || {}).getAttribute
      ? document.querySelector('[data-testid="media-viewer"]').getAttribute('data-message-id')
      : null
    return {
      raw: all.filter((r) => String(r.name).includes(`/api/media/items/${mid}/raw`)).length,
      stream: all.filter((r) => String(r.name).includes(`/api/media/items/${mid}/stream`)).length,
    }
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
    // 干净起点：清掉历史记忆，确保 A 阶段走完整的「先原始流 → 切兼容流」路径
    await page.evaluate(() => localStorage.removeItem('orighub.compatSrcs'))

    // ---- A：HEVC 条目 → 自动切兼容流并出帧 ----
    await openItem(page, HEVC_ITEM)
    const banner = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="player-compat-banner"]'), { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    console.log('[verify] compat banner present =', banner)
    check('A: compat banner appears for HEVC item (auto-switch)', banner, `item=${HEVC_ITEM}`)
    if (!banner) {
      await shot(page, 'A-no-banner.png')
    }

    // 切换点：/raw 停止增长 + /stream 无风暴
    await page.evaluate(() => { window.__switchAt = performance.now() })
    const c1 = await reqCounts(page)
    await delay(10000)
    const c2 = await reqCounts(page)
    console.log('[verify] request counts: before', JSON.stringify(c1), 'after 10s', JSON.stringify(c2))
    check('A: /stream requests stay bounded (single-flight, no storm)', c2.stream <= 3, `stream reqs=${c2.stream}`)
    check('A: /raw requests stop growing after switch', c2.raw <= c1.raw + 1, `raw ${c1.raw} -> ${c2.raw}`)

    // 出帧：fMP4 直播态下 videoWidth>0 且 totalVideoFrames 持续增长
    const framed = await page
      .waitForFunction(() => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return v && v.videoWidth > 0 && v.getVideoPlaybackQuality && v.getVideoPlaybackQuality().totalVideoFrames > 0
      }, { timeout: 90000 })
      .then(() => true)
      .catch(() => false)
    const s1 = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      return { vw: v.videoWidth, vh: v.videoHeight, frames: q ? q.totalVideoFrames : 0, t: v.currentTime }
    })
    await delay(4000)
    const s2 = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      return { frames: q ? q.totalVideoFrames : 0, t: v.currentTime }
    })
    console.log('[verify] frames: first sample', JSON.stringify(s1), 'after 4s', JSON.stringify(s2))
    await shot(page, 'A-compat-stream-playing.png')
    check('A: compat stream decodes frames (videoWidth > 0)', framed && s1 && s1.vw > 0,
      `framed=${framed} ${s1 && s1.vw}x${s1 && s1.vh}`)
    check('A: frames keep growing (actually playing)', s2 && s1 && s2.frames > s1.frames,
      `frames ${s1 && s1.frames} -> ${s2 && s2.frames}`)

    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(500)

    // ---- B：记忆直开——重开同一条目应直接从 /stream 起步 ----
    await openItem(page, HEVC_ITEM)
    await delay(2000)
    const mem = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const bannerNow = !!document.querySelector('[data-testid="player-compat-banner"]')
      return { src: v ? v.src : null, bannerNow }
    })
    console.log('[verify] memory reopen:', JSON.stringify(mem))
    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(300)
    check('B: remembered item opens directly on /stream', mem.src && mem.src.includes('/stream'), `src=${mem.src}`)
    check('B: compat banner shows immediately on remembered item', mem.bannerNow, `banner=${mem.bannerNow}`)

    // ---- C：可解码条目回归 → 正常播放，绝不切兼容流 ----
    await openItem(page, OK_ITEM)
    await delay(6000)
    const okState = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (!v) return null
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
      return {
        vw: v.videoWidth, vh: v.videoHeight,
        frames: q ? q.totalVideoFrames : -1,
        src: v.src,
        banner: !!document.querySelector('[data-testid="player-compat-banner"]'),
        halt: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
      }
    })
    console.log('[verify] C decodable item state:', JSON.stringify(okState))
    await shot(page, 'C-decodable-no-compat.png')
    check('C: decodable item presents frames on raw source (no compat switch)',
      okState && okState.frames > 0 && okState.vw > 0 && String(okState.src).includes('/raw'),
      `frames=${okState && okState.frames} ${okState && okState.vw}x${okState && okState.vh} src=${okState && okState.src}`)
    check('C: no compat banner and no halt for decodable item',
      okState && !okState.banner && !okState.halt,
      `banner=${okState && okState.banner} halt=${okState && okState.halt}`)

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
