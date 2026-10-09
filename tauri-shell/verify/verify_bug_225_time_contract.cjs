#!/usr/bin/env node
'use strict'

/**
 * BUG-225 acceptance: the *content-time* contract on FRC streams.
 *
 * On a cold (live, fMP4 `empty_moov`) FRC stream the element's `loadedmetadata`
 * carries `duration = NaN`. The pre-fix player snapshotted that into
 * `durationRef = 0` and then:
 *   - clamped the position restore with `Math.min(durationRef, target)` -> the
 *     position snapped back to 0:00 (measured: content 30s -> 0.00);
 *   - never re-synced on `durationchange`, so +/-10s skips computed
 *     `Math.min(0, ...)` -> every skip snapped to 0.00 (measured: two forward-10s
 *     clicks left `currentTime` at 0.00);
 *   - displayed the compressed media duration ("0:13") instead of the source
 *     duration ("0:49").
 *
 * This script asserts the fixed contract end to end on the real APP + msedge +
 * orig-tg (BUG-122: only msedge can be trusted with decode judgements).
 *
 * Criteria (each "has value + exact value"):
 *  C1  Cold-cache rate switch keeps the source-content position (|Δ| <= 2s).
 *  C2  Forward-10s x2 on the FRC stream advances content time by 20s (+/-4s),
 *      and never resets it to 0.
 *  C3  Backward-10s decreases content time by 10s (+/-3s).
 *  C4  The time text total equals the SOURCE duration (0:49/0:50), not the
 *      compressed media duration.
 *  C5  Warm (proxy on disk) switch keeps the position (BUG-223 C5 semantics).
 *
 * Falsification: reverting the fix (clamp restore with the stale ref, drop the
 * durationchange sync) makes C1 fail via the restore clamp only when the
 * server has no `t` anchor support; C2/C4 fail regardless -- C2 is the sharpest
 * tooth (the old skip clamps to 0 on any live stream).
 *
 * Usage: node verify/verify_bug_225_time_contract.cjs
 * Env: APP_PORT (5180), TG_URL, PROBE_ITEM (630), SHOT_DIR.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 630)
const OUT = path.resolve(
  process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'verify_shots', 'bug-225-time-contract'),
)
/** Position tolerance in source-content seconds. */
const POSITION_TOLERANCE_S = 2.0

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

const PROXY_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'com.origadmin.orighub', 'tg', 'proxies')
function clearSpeedProxies(id) {
  const removed = []
  for (const name of [`${id}-speed-200.mp4`, `${id}-speed-400.mp4`, `${id}-speed-200.mp4.part`, `${id}-speed-400.mp4.part`]) {
    const file = path.join(PROXY_DIR, name)
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file)
        removed.push(name)
      }
    } catch (err) {
      console.log(`[verify] WARN could not remove ${name}: ${err.message}`)
    }
  }
  return removed
}

/** Consume a URL to the end (used to pre-build a canonical proxy). */
function fetchFull(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout ${url}`))
    })
  })
}

async function openItem(page, id) {
  // The app calibrates its TG base from `GET /api/config` (`tgService.port`).
  // compatSrc is built from that base, so wait until the store agrees with the
  // TG base this script uses -- otherwise the FRC URL lands on a dead port.
  await page.waitForFunction(
    (port) => {
      const s = window.__origStore && window.__origStore.getState()
      return Boolean(s && s.tgService && s.tgService.port === port)
    },
    { timeout: 20000, intervalMs: 250, args: [Number(new URL(TG).port)] },
  )
  await page.evaluate(
    (tg, itemId) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${itemId}`,
            chatId: 0,
            messageId: itemId,
            kind: 'video',
            caption: 'BUG-225 verify',
            description: null,
            src: `${tg}/api/media/items/${itemId}/raw`,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: 'BUG-225 verify',
      })
    },
    TG,
    id,
  )
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 20000,
    intervalMs: 200,
  })
}

const SNAPSHOT = () => {
  const v = document.querySelector('[data-testid="media-viewer"] video')
  if (!v) return null
  let text = null
  for (const s of document.querySelectorAll('[data-testid="media-viewer"] span')) {
    if ((s.textContent || '').includes(' / ')) {
      text = s.textContent.trim()
      break
    }
  }
  const offset = Number(v.getAttribute('data-content-offset') || '0')
  const speed = Number(v.getAttribute('data-content-speed') || '1')
  return {
    src: v.currentSrc || v.src || '',
    currentTime: v.currentTime,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    paused: v.paused,
    readyState: v.readyState,
    playbackRate: v.playbackRate,
    offset,
    speed,
    /** Source-content seconds per the fixed contract. */
    contentTime: offset + v.currentTime * speed,
    text,
  }
}

async function snapshot(page) {
  return page.evaluate(SNAPSHOT)
}

async function waitForSrc(page, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await snapshot(page)
    if (last && predicate(last) && last.readyState >= 1) return last
    await delay(400)
  }
  throw new Error(`waitForSrc(${label}) timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

async function clickRate(page, rate) {
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-haspopup="menu"][aria-expanded]')
    if (!btn) throw new Error('speed menu button not found')
    btn.click()
  })
  await delay(250)
  const ok = await page.evaluate((r) => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const target = items.find((el) => (el.textContent || '').trim().startsWith(`${r}x`))
    if (!target) return false
    target.click()
    return true
  }, rate)
  if (!ok) throw new Error(`rate ${rate}x menu entry not found`)
}

/** Click the forward/backward 10s buttons (no state pokes).
 *  Locale-agnostic: both buttons carry "10" in their aria-label and render in
 *  the fixed order rewind -> forward (VideoPlayer JSX order). */
async function clickSkip(page, dir) {
  return page.evaluate((d) => {
    const btns = Array.from(document.querySelectorAll('[data-testid="media-viewer"] button'))
    const skipBtns = btns.filter((b) => (b.getAttribute('aria-label') || '').includes('10'))
    if (skipBtns.length < 2) return false
    const target = d > 0 ? skipBtns[1] : skipBtns[0]
    target.click()
    return true
  }, dir)
}

async function play(page) {
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      void v.play().catch(() => {})
    }
  })
}

async function pauseAt(page, contentSec) {
  await page.evaluate((sec) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.pause()
      v.currentTime = sec // 1x raw timeline == content seconds
    }
  }, contentSec)
  await delay(800)
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) v.pause()
  })
  await delay(300)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
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
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 30000, intervalMs: 250 })
    await page.evaluate(() => {
      localStorage.removeItem('orighub.compatSrcs')
      localStorage.setItem(
        'orighub_player_settings',
        JSON.stringify({ volume: 1, isMuted: true, playbackRate: 1, autoPlayNext: false }),
      )
    })
    await delay(1200)

    const removed = clearSpeedProxies(ITEM)
    console.log(`[verify] cleared stale speed proxies: ${JSON.stringify(removed)}`)

    // ---- C1: cold-cache 2x switch keeps the content position ----------------
    await openItem(page, ITEM)
    await waitForSrc(page, (s) => s.src.includes(`/items/${ITEM}/raw`), 30000, '1x raw')
    await pauseAt(page, 30)
    const before = await snapshot(page)
    console.log(`[verify] before switch ${JSON.stringify(before)}`)
    await clickRate(page, 2)
    const after = await waitForSrc(page, (s) => s.src.includes('speed=2'), 60000, '2x FRC')
    await delay(800)
    const restored = await snapshot(page)
    console.log(`[verify] after switch ${JSON.stringify(restored)}`)
    const drift = Math.abs(restored.contentTime - before.contentTime)
    check(
      'C1 (1) 冷缓存切 2x 保留源内容位置（±2s；修前钳回 0:00）',
      restored.speed === 2 && drift <= POSITION_TOLERANCE_S,
      `before=${before.contentTime.toFixed(2)}s after=${restored.contentTime.toFixed(2)}s drift=${drift.toFixed(2)}s offset=${restored.offset}`,
    )

    // ---- C2: forward-10s x2 advances content time by ~20s -------------------
    await clickSkip(page, +1)
    await delay(1200)
    await clickSkip(page, +1)
    await delay(1200)
    const fwd = await snapshot(page)
    const gain = fwd.contentTime - restored.contentTime
    check(
      'C2 (2) live 流上「快进 10s」×2 内容时间前进 20s±4s（修前两次都钳回 0）',
      gain >= 16 && gain <= 24 && fwd.contentTime > restored.contentTime,
      `from=${restored.contentTime.toFixed(2)} to=${fwd.contentTime.toFixed(2)} gain=${gain.toFixed(2)}s`,
    )

    // ---- C3: backward-10s decreases content time by ~10s --------------------
    await clickSkip(page, -1)
    await delay(1200)
    const back = await snapshot(page)
    const drop = fwd.contentTime - back.contentTime
    check(
      'C3 (3) 「快退 10s」内容时间后退 10s±3s',
      drop >= 7 && drop <= 13,
      `from=${fwd.contentTime.toFixed(2)} to=${back.contentTime.toFixed(2)} drop=${drop.toFixed(2)}s`,
    )

    // ---- C4: the total shown is the SOURCE duration --------------------------
    const total = (back.text || '').split('/')[1] || ''
    check(
      'C4 (2) 时间文案总时长 = 源内容时长（0:49/0:50，修前显示压缩后的 0:13）',
      /^0:(49|50)/.test(total.trim()),
      `text="${back.text}" total="${total.trim()}"`,
    )

    // ---- C5: warm (proxy on disk) switch keeps the position -----------------
    console.log('[verify] pre-building canonical 2x proxy...')
    await fetchFull(`${TG}/api/media/items/${ITEM}/stream?speed=2`)
    await clickRate(page, 1)
    await waitForSrc(page, (s) => s.src.includes(`/items/${ITEM}/raw`), 60000, 'back to 1x')
    await delay(400)
    await play(page)
    await pauseAt(page, 35)
    const warmBefore = await snapshot(page)
    await clickRate(page, 2)
    await waitForSrc(page, (s) => s.src.includes('speed=2'), 60000, '2x warm')
    await delay(800)
    const warmAfter = await snapshot(page)
    const warmDrift = Math.abs(warmAfter.contentTime - warmBefore.contentTime)
    check(
      'C5 (4) 代理就绪时换档位置 drift ≤ 2s（BUG-223 C5 语义回归）',
      warmAfter.speed === 2 && warmDrift <= POSITION_TOLERANCE_S,
      `before=${warmBefore.contentTime.toFixed(2)} after=${warmAfter.contentTime.toFixed(2)} drift=${warmDrift.toFixed(2)}s`,
    )

    await page.screenshot(path.join(OUT, 'after-c5.png'))

    const errs = page.pageErrors().slice(0, 8)
    check('全程无页面错误', errs.length === 0, JSON.stringify(errs))
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.pass)
  const summaryText = [
    '',
    '[verify] === SUMMARY ===',
    ...checks.map((c) => `  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`),
    `[verify] ${checks.length - failed.length}/${checks.length} passed`,
  ].join('\n')
  console.log(summaryText)
  console.error(summaryText)

  try {
    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify({ item: ITEM, passed: checks.length - failed.length, total: checks.length, checks }, null, 2),
    )
  } catch (err) {
    console.error(`[verify] could not write report: ${err.message}`)
  }

  if (failed.length) {
    console.error(`[verify] FAILED ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join(' | ')}`)
    process.exit(1)
  }
  console.log('[verify] ALL CHECKS PASSED')
  console.error('[verify] ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})
