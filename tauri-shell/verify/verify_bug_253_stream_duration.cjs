#!/usr/bin/env node
'use strict'

/**
 * BUG-253 acceptance: 播放器总时长必须取自**真源** `item.duration`
 * （GET /api/media/items/<id>），而非 live 转码流的瞬时 <video>.duration。
 *
 * 现象：用户实测 0:32 / 0:01 —— 当前时间 > 总时长，或总数远小于真值（真值 242s，
 * 而元素 duration 随转码推进抖动增长：12s 内 85 次、瞬时仅 1~14s）。
 *
 * 修复契约（见 VideoPlayer.tsx / MediaViewer.tsx）：
 *   总数 = 上游下发的 `item.duration`（= 242s），挂载即初始化 `contentDurationRef`，
 *   元素 `durationchange` / `loadedmetadata` 与换档探针都**不得覆盖**已由真源确立的总数。
 *
 * 验收标准（每条带明确值）：
 *  C1  挂载即显示总数 ≈ 真源 duration（±2s），采样期间恒定，不随 live 元素 duration 漂移。
 *  C2  每个采样点 currentTime ≤ total。
 *  C3  <video>.duration（被 shim 固定为 7s，模拟冷缓存 live 流）与总数明显不同 ——
 *      证明总数不是来自元素（反之若总数是 7s，说明真源没生效，即为 BUG-253 本身）。
 *  C4  切到 2x：总数不重置，仍 ≈ 真源 duration（±2s）。
 *  C5  （teeth / 反向）构造「无真源」场景（ViewerItem 不传 duration，元素仍被 shim 成 7s）：
 *      总数应回落到元素 duration（≈7s），≠ 真源 —— 证明本脚本的断言确实能咬住回归。
 *      若 C5 显示总数仍 ≈ 真源，则说明测试本身失去判别力 → 脚本以非 0 退出。
 *
 * 用法：node verify/verify_bug_253_stream_duration.cjs
 * 环境变量：APP_PORT(5180) / PROBE_ITEM(自动挑选) / SHOT_DIR
 * 说明：tg 端口从运行中的 app store 读取（== daemon 真实 tg_port，实测 19788），
 *       不写死，避免端口漂移导致脚本误判。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const OUT = path.resolve(
  process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'verify_shots', 'bug-253-stream-duration'),
)
const TOLERANCE_S = 2
const SAMPLE_MS = 1200
const SAMPLE_COUNT = 8
/** 模拟冷缓存 live 流的瞬时元素 duration（秒）——明显小于真源，用来证明总数不取它。 */
const SHIM_DURATION = 7

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简断言收集器（与 verify_bug_226_stream_anchor.cjs 同构）。 */
const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

/** node 侧 GET JSON（loopback，不 consult 代理）。 */
function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`non-JSON from ${url}: ${body.slice(0, 100)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout ${url}`))
    })
  })
}

/** "m:ss" / "h:mm:ss" -> 秒；无法解析返回 NaN。 */
function parseTime(s) {
  if (!s) return NaN
  s = String(s).trim()
  if (!/^\d+:\d{1,2}(:\d{2})?$/.test(s)) return NaN
  const p = s.split(':').map(Number)
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  return p[0] * 60 + p[1]
}

/** 读取播放器时间文案标签 "current / total"。 */
async function readLabel(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="media-viewer"]')
    if (!root) return null
    const spans = Array.from(root.querySelectorAll('span'))
    const re = /^\s*(\d+:\d{1,2}(?::\d{2})?)\s*\/\s*(\d+:\d{1,2}(?::\d{2})?)\s*$/
    for (const s of spans) {
      const m = re.exec(s.textContent || '')
      if (m) return { current: m[1], total: m[2] }
    }
    return null
  })
}

/** 读取元素自身的 duration（被 shim 覆写为 SHIM_DURATION 时即返回该值）。 */
async function readElementDuration(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return NaN
    const d = v.duration
    return Number.isFinite(d) ? d : NaN
  })
}

/** 用 store 直接打开一个构造好的 ViewerItem（与 verify_bug_226 同法）。 */
async function openItem(page, item) {
  await page.evaluate((it) => {
    window.__origStore.getState().openViewer({
      items: [it],
      index: 0,
      title: 'BUG-253 verify',
    })
  }, item)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 20000,
    intervalMs: 200,
  })
}

/** 点击倍速菜单并选 rate（2 表示 2x）。 */
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
  await delay(300)
}

/** 采样 n 次（current/total/elementDuration）。 */
async function sampleTotals(page, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const label = await readLabel(page)
    const elDur = await readElementDuration(page)
    if (label) {
      out.push({
        current: parseTime(label.current),
        total: parseTime(label.total),
        elementDuration: elDur,
      })
    }
    await delay(SAMPLE_MS)
  }
  return out
}

async function pickItem(tgPort) {
  const TG = `http://127.0.0.1:${tgPort}`
  const forced = Number(process.env.PROBE_ITEM || 0)
  if (forced > 0) {
    const item = await getJson(`${TG}/api/media/items/${forced}`)
    if (!item || typeof item.id !== 'number') throw new Error(`PROBE_ITEM=${forced} not found`)
    if (typeof item.duration !== 'number' || item.duration <= 0) {
      throw new Error(`PROBE_ITEM=${forced} has no usable duration field`)
    }
    return { id: item.id, duration: item.duration }
  }
  // 自动挑选：按 duration 降序，挑首个有字节、时长 >= 60s 的视频。
  const list = await getJson(`${TG}/api/media/items?limit=200&sort=duration`)
  const items = (list && list.items) || []
  const cand = items.find(
    (it) =>
      it.kind === 'video' &&
      typeof it.duration === 'number' &&
      it.duration >= 60 &&
      it.bytesPresence === 'present',
  )
  if (cand) return { id: cand.id, duration: cand.duration }
  // 退化：任何有 duration 的视频都行（总数断言不依赖字节，但播放更依赖）。
  const fallback = items.find((it) => it.kind === 'video' && typeof it.duration === 'number' && it.duration >= 30)
  if (fallback) return { id: fallback.id, duration: fallback.duration }
  throw new Error('no usable video item with duration found in media library')
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({
    // DOM/结构断言为主；video 实际解码不影响总数标签（总数取自 prop），headless 即可。
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 30000, intervalMs: 250 })

    // 读取 daemon 真实 tg 端口（== media API 端口），并强制 1x 起始。
    const tgPort = await page.evaluate(() => {
      const s = window.__origStore.getState()
      return Number(s && s.tgService && s.tgService.port)
    })
    if (!tgPort || tgPort <= 0) throw new Error('could not read tgService.port from store')
    const TG = `http://127.0.0.1:${tgPort}`
    console.log(`[verify] tg/media port = ${tgPort}`)

    await page.evaluate(() => {
      localStorage.removeItem('orighub.compatSrcs')
      localStorage.setItem(
        'orighub_player_settings',
        JSON.stringify({ volume: 1, isMuted: true, playbackRate: 1, autoPlayNext: false }),
      )
    })
    await delay(800)

    const { id, duration: D } = await pickItem(tgPort)
    console.log(`[verify] picked item id=${id} sourceDuration=${D}s`)

    // page-side shim：让 <video>.duration 永远返回 SHIM_DURATION（模拟冷缓存 live 流）。
    // 不改动源码 —— 用于证明总数不是来自元素。
    await page.evaluate((shim) => {
      try {
        Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
          configurable: true,
          get() {
            return shim
          },
        })
      } catch (_e) {
        /* 已覆写则忽略 */
      }
    }, SHIM_DURATION)

    // ---- C1 / C2 / C3：真源生效，总数来自 item.duration ----
    await openItem(page, {
      key: `bug253-${id}`,
      chatId: 0,
      messageId: id,
      kind: 'video',
      caption: 'BUG-253 verify',
      description: null,
      src: `${TG}/api/media/items/${id}/raw`,
      poster: null,
      episodeNo: null,
      seriesId: null,
      duration: D,
    })
    await delay(1000)

    const samples = await sampleTotals(page, SAMPLE_COUNT)
    console.log('[verify] samples:', JSON.stringify(samples.map((s) => ({ c: s.current, t: s.total, e: s.elementDuration }))))

    const totals = samples.map((s) => s.total).filter((t) => Number.isFinite(t))
    const currents = samples.map((s) => s.current).filter((c) => Number.isFinite(c))
    const minTotal = totals.length ? Math.min(...totals) : NaN
    const maxTotal = totals.length ? Math.max(...totals) : NaN
    const allTotalOk = totals.length > 0 && totals.every((t) => Math.abs(t - D) <= TOLERANCE_S)
    const allCurrentLeTotal = samples.every((s) => Number.isFinite(s.current) && Number.isFinite(s.total) && s.current <= s.total + 0.001)
    const elementDur = samples.length ? samples[0].elementDuration : NaN
    const elementDiffers = Number.isFinite(elementDur) && Math.abs(elementDur - D) > 5

    check(
      `C1 总数 ≈ 真源 ${D}s（±${TOLERANCE_S}s），采样 ${totals.length}/${SAMPLE_COUNT} 次`,
      allTotalOk,
      `min=${fmt(minTotal)} max=${fmt(maxTotal)} 期望=${D}`,
    )
    check('C2 每个采样点 currentTime ≤ total', allCurrentLeTotal, JSON.stringify(samples.map((s) => [s.current, s.total])))
    check(
      `C3 元素 <video>.duration(${fmt(elementDur)}s) 与总数(${D}s) 明显不同（证明总数非来自元素）`,
      elementDiffers,
      `element=${fmt(elementDur)} total=${D}`,
    )

    // ---- C4：切 2x，总数不重置 ----
    await clickRate(page, 2)
    await delay(2500)
    const after2x = await sampleTotals(page, 4)
    const totals2x = after2x.map((s) => s.total).filter((t) => Number.isFinite(t))
    const min2x = totals2x.length ? Math.min(...totals2x) : NaN
    const max2x = totals2x.length ? Math.max(...totals2x) : NaN
    const twoXOk = totals2x.length > 0 && totals2x.every((t) => Math.abs(t - D) <= TOLERANCE_S)
    check(
      `C4 切 2x 后总数仍 ≈ ${D}s（±${TOLERANCE_S}s，不重置）`,
      twoXOk,
      `min=${fmt(min2x)} max=${fmt(max2x)} 期望=${D}`,
    )

    await page.screenshot(path.join(OUT, 'bug253-fixed.png'))

    // ---- C5：teeth（反向）—— 无真源时总数回落到元素 duration（≈SHIM_DURATION） ----
    await openItem(page, {
      key: `bug253-teeth-${id}`,
      chatId: 0,
      messageId: id,
      kind: 'video',
      caption: 'BUG-253 teeth (no source duration)',
      description: null,
      src: `${TG}/api/media/items/${id}/raw`,
      poster: null,
      episodeNo: null,
      seriesId: null,
      // 注意：故意不传 duration —— 模拟修复前「拿不到真源」的回归场景
    })
    await delay(1500)
    const teeth = await sampleTotals(page, 5)
    const teethTotals = teeth.map((s) => s.total).filter((t) => Number.isFinite(t))
    const teethMin = teethTotals.length ? Math.min(...teethTotals) : NaN
    const teethMax = teethTotals.length ? Math.max(...teethTotals) : NaN
    // 回归场景：总数应 ≈ 元素 shim 值（≠ 真源）。断言「总数明显偏离真源」成立 → 说明测试有牙齿。
    const teethShowsRegression = teethTotals.length > 0 && teethTotals.every((t) => Math.abs(t - D) > TOLERANCE_S)
    check(
      `C5 (teeth) 无真源时总数回落到元素 duration（≠ ${D}s，证明断言能咬住回归）`,
      teethShowsRegression,
      `min=${fmt(teethMin)} max=${fmt(teethMax)} 期望明显≠${D}（元素 shim=${SHIM_DURATION}s）`,
    )
    // 若 C5 没咬住（总数仍 ≈ 真源），说明 shim/构造失败，测试失去判别力 → 脚本应失败。
    if (!teethShowsRegression) {
      check('C5b 测试判别力自检', false, `teeth 未呈现回归，断言可能失效（total≈${fmt(teethMin)}~${fmt(teethMax)} vs ${D}）`)
    }

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
      JSON.stringify({ passed: checks.length - failed.length, total: checks.length, checks }, null, 2),
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

/** 秒 -> 可读字符串，或 'NaN'。 */
function fmt(s) {
  return Number.isFinite(s) ? String(Math.round(s * 100) / 100) : 'NaN'
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})
