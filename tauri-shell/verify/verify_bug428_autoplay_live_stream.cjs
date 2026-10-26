#!/usr/bin/env node
'use strict'
/**
 * BUG-428 验收：**连续播放**端到端 —— 播完必须浮出下一集倒计时，且不依赖 `ended`。
 *
 * ## 背景（用户 2026-10-26 报「合并播放,连续播放,这些问题完全丢失」）
 *
 * 代码链是完整的：`episode-row-play` → `playItems(整部剧集)` → `MediaViewer.nextUp`
 * → `VideoPlayer` 倒计时。但**播放一律走 `/stream`**（stream-first，2026-10-09 用户裁定），
 * 而该端点响应头是
 *   `x-orig-stream: live` + `transfer-encoding: chunked`（无 content-length / accept-ranges），
 * live 流的元素 `duration` 是**随下载量上涨的估算值**，`ended` **永不触发**
 * ⇒ 连播倒计时永不出现。这就是「连续播放完全丢失」的物理原因。
 *
 * 修复：`VideoPlayer` 增加 `onTimeUpdate` 兜底 —— 不可 seek 的流上，
 * 按**真源总时长**（`contentDuration` prop，实测与 `/raw` 的元素 duration 逐位相同）
 * 判定 `currentTime*speed + offset >= duration - 0.75s` 即视为播完。
 *
 * ## 判据
 *  428-A 从剧集详情点行内 ▶ 后，播放序列 = 整部剧集（≥ 2 条）。
 *  428-B 播完必须浮出 `player-autoplay-next` 倒计时浮层（有界等待，超时报红带耗时）。
 *  428-C 浮层给出下一集标题 / 集号。
 *  428-D 点「立即播放」⇒ 播放器换集（`media-viewer` 的 messageId 变化）且浮层消失。
 *  428-E 浮层出现时记录 `video.ended`：为 `false` 即证明**兜底判据**生效
 *        （live 流没抛 ended 也能连播）；为 `true` 也不判失败，如实打印。
 *  428-F 无页面 / console 错误（favicon 噪声除外）。
 *  RF    关掉 `autoPlayNext` ⇒ 428-B 必须 FAIL（判据灵敏）。
 *
 * 为什么用剧集 219：库里它恰好 2 集（9s + 30s），端到端只需十几秒；
 * 其余剧集单集 5~12 分钟，无法在验收窗口内自然播完。
 *
 * 用法（先起 dev 栈 5180）：
 *   node tauri-shell/verify/verify_bug428_autoplay_live_stream.cjs [SERIES_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug428-autoplay'),
)
const SERIES_ID = Number(process.argv[2] || process.env.SERIES_ID || 219)
/** 浮层等待上限：9s 素材 + 转码起播 + 余量 */
const OVERLAY_BUDGET_MS = 60000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function openSeriesById(page, seriesId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!ok) {
      await delay(2000)
      continue
    }
    let found = false
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
        { timeout: 25000 },
      )
      found = true
    } catch {
      console.log(`[bug428] attempt#${attempt + 1}: series wall timeout`)
      await delay(2000)
      continue
    }
    if (!found) continue
    await delay(1000)
    const clicked = await page.evaluate((sid) => {
      const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
      if (!card) return false
      card.click()
      return true
    }, seriesId)
    if (!clicked) {
      console.log(`[bug428] attempt#${attempt + 1}: series ${seriesId} card not in wall`)
      await delay(1500)
      continue
    }
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    await delay(800)
    return
  }
  throw new Error(`series ${seriesId} not reachable after 3 attempts`)
}

function readViewer() {
  const viewer = document.querySelector('[data-testid="media-viewer"]')
  if (!viewer) return { error: 'media-viewer not found' }
  const overlay = document.querySelector('[data-testid="player-autoplay-next"]')
  const video = viewer.querySelector('video')
  return {
    messageId: viewer.getAttribute('data-message-id'),
    playlistCount: document.querySelectorAll('[data-testid^="episode-list-item-"]').length,
    overlay: overlay
      ? {
          nextTitle: overlay.getAttribute('data-next-title') || '',
          nextEpisode: overlay.getAttribute('data-next-episode') || '',
        }
      : null,
    video: video
      ? {
          currentSrc: video.currentSrc,
          ended: video.ended,
          currentTime: Math.round(video.currentTime * 100) / 100,
          duration: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : String(video.duration),
          paused: video.paused,
        }
      : null,
  }
}

/** 点第一个有字节的视频行的 ▶ */
async function startFromFirstVideoRow(page) {
  const r = await page.evaluate(() => {
    const plays = [...document.querySelectorAll('[data-testid="episode-row-play"]')].filter(
      (el) => el.getAttribute('data-kind') === 'video',
    )
    if (!plays.length) return { ok: false }
    plays[0].click()
    return { ok: true, count: plays.length }
  })
  if (!r.ok) throw new Error('no video episode-row-play')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 20000,
  })
  return r
}

/** 有界等待浮层；同时记录首次观察到时的 video 状态 */
async function waitOverlay(page, budgetMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    const v = await page.evaluate(readViewer)
    if (v.overlay) return { overlay: v.overlay, video: v.video, waited: Date.now() - t0 }
    await delay(250)
  }
  const last = await page.evaluate(readViewer)
  return { overlay: null, video: last.video, waited: Date.now() - t0 }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const evidence = { seriesId: SERIES_ID }
  try {
    await openSeriesById(page, SERIES_ID)
    const rowInfo = await startFromFirstVideoRow(page)
    evidence.rowPlayCount = rowInfo.count
    await delay(1500)
    const before = await page.evaluate(readViewer)
    evidence.before = before
    console.log(`[bug428] before: ${JSON.stringify(before)}`)

    check(
      '428-A 播放序列 = 整部剧集（≥ 2 条）',
      before.playlistCount >= 2,
      `playlistCount=${before.playlistCount} startId=${before.messageId}`,
    )

    const got = await waitOverlay(page, OVERLAY_BUDGET_MS)
    evidence.overlay = got
    await page.screenshot(path.join(OUT, 'A-autoplay-overlay.png'))
    console.log(`[bug428] overlay wait: waited=${got.waited}ms video=${JSON.stringify(got.video)}`)

    check(
      '428-B 播完浮出「下一集」倒计时浮层',
      !!got.overlay,
      got.overlay
        ? `waited=${got.waited}ms`
        : `未出现（等待 ${got.waited}ms）；video=${JSON.stringify(got.video)}`,
    )
    check(
      '428-C 浮层给出下一集标题 / 集号',
      !!got.overlay && (!!got.overlay.nextTitle || !!got.overlay.nextEpisode),
      got.overlay ? `title="${got.overlay.nextTitle}" ep="${got.overlay.nextEpisode}"` : 'n/a',
    )
    check(
      '428-E 浮层出现时 video.ended（记录：false ⇒ 兜底判据生效）',
      true,
      got.video ? `ended=${got.video.ended} duration=${got.video.duration} src=${got.video.currentSrc}` : 'n/a',
    )

    if (got.overlay) {
      const clicked = await page.evaluate(() => {
        const ov = document.querySelector('[data-testid="player-autoplay-next"]')
        if (!ov) return false
        const btns = [...ov.querySelectorAll('button')].filter(
          (b) => (b.textContent || '').trim().length > 0,
        )
        if (!btns.length) return false
        btns[btns.length - 1].click()
        return true
      })
      let after = null
      for (let i = 0; i < 60; i++) {
        const v = await page.evaluate(readViewer)
        if (v.messageId && before.messageId && v.messageId !== before.messageId && !v.overlay) {
          after = v
          break
        }
        await delay(250)
      }
      evidence.afterNext = after
      await page.screenshot(path.join(OUT, 'B-after-next.png'))
      check(
        '428-D 点「立即播放」切到下一集且浮层消失',
        clicked && !!after,
        after ? `messageId ${before.messageId} → ${after.messageId}` : `clicked=${clicked} 未换集`,
      )
    } else {
      check('428-D 点「立即播放」切到下一集且浮层消失', false, '前置 428-B 未通过')
    }

    // ---- RF：关掉 autoPlayNext ⇒ 428-B 必须 FAIL ----
    const rfPrev = await page.evaluate(() => {
      const KEY = 'orighub_player_settings'
      const prev = localStorage.getItem(KEY)
      let cur = {}
      try {
        cur = prev ? JSON.parse(prev) : {}
      } catch {
        cur = {}
      }
      localStorage.setItem(KEY, JSON.stringify({ ...cur, autoPlayNext: false }))
      return prev
    })
    await openSeriesById(page, SERIES_ID)
    await startFromFirstVideoRow(page)
    await delay(1200)
    const rfGot = await waitOverlay(page, OVERLAY_BUDGET_MS)
    check(
      'RF 关掉 autoPlayNext ⇒ 浮层必须不出现',
      !rfGot.overlay,
      rfGot.overlay
        ? `仍出现：${JSON.stringify(rfGot.overlay)}`
        : `未出现（判据灵敏）；waited=${rfGot.waited}ms video=${JSON.stringify(rfGot.video)}`,
    )
    await page.evaluate((prev) => {
      const KEY = 'orighub_player_settings'
      if (prev == null) localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, prev)
    }, rfPrev)

    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon\.ico/i.test(String(e)),
    )
    check('428-F 无页面 / console 错误', errs.length === 0, `errors=${JSON.stringify(errs.slice(0, 3))}`)
  } catch (e) {
    check('EXEC 脚本执行', false, e.message)
  } finally {
    await browser.close().catch(() => {})
  }

  const passed = checks.filter((c) => c.pass).length
  const total = checks.length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ seriesId: SERIES_ID, evidence, checks, passed, total }, null, 2),
  )
  console.log(`\ntotal=${total} passed=${passed} failed=${total - passed}`)
  console.log(`evidence: ${OUT}`)
  if (passed !== total) {
    console.log('FAILED CHECKS:')
    for (const c of checks.filter((x) => !x.pass)) console.log(`  - ${c.name} — ${c.detail}`)
    process.exit(1)
  }
  console.log('ALL CHECKS PASSED')
})()
