#!/usr/bin/env node
'use strict'

/**
 * BUG-450 真实场景复测：**不注入任何假值**。
 *
 * 与 verify_bug450_progress_denominator.cjs 的区别：那一版靠
 * `Object.defineProperty(v,'duration',...)` 伪造「元素只转码了 10 秒」来稳定复现；
 * 这一版用**真实条目**（duration=630，即截图里的 10:30）真播，观察
 * live 转码流上「元素 duration（已转码到哪）」与「条面分母」的关系。
 *
 * 判据：
 *   S1 条面分母（aria-valuemax）== 真源总时长（630），**不是**元素 duration。
 *      ★ 分母与文本同源 ⇒ 两者必须一致；这是用户截图症状（文本 10:30 对、条面 97% 错）
 *        的唯一可判定形式。
 *   S2 可见条宽 == currentTime / 真源总时长（像素级，容差 3pt）。
 *   S3 反向检查：条面分母 == 元素 duration 时 ⇒ 说明分母退化了（复现旧缺陷）。
 *
 * 用法：node verify/verify_bug450_real_stream.cjs
 * Env: APP_PORT(5180) TG_URL(127.0.0.1:19787) PROBE_ITEM(630)
 */

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 630)
const TOLERANCE_PCT = 3

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name} :: ${detail}`)
}

async function poke(page) {
  await page.evaluate(() => {
    const host =
      document.querySelector('[data-testid="media-viewer"] [role="application"]') ||
      document.querySelector('[data-testid="media-viewer"] video')
    if (host) host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  })
}

const SNAPSHOT = () => {
  const root = document.querySelector('[data-testid="media-viewer"]')
  if (!root) return null
  const v = root.querySelector('video')
  if (!v) return null
  let text = null
  for (const s of root.querySelectorAll('span')) {
    const tx = (s.textContent || '').trim()
    if (tx.includes('/') && tx.includes(':')) {
      text = tx
      break
    }
  }
  const slider = root.querySelector('[role="slider"]')
  let barPct = null
  let barVisible = false
  let bufferedPct = null
  if (slider) {
    for (const d of slider.querySelectorAll('div')) {
      const w = d.style && d.style.width
      if (!w || !w.endsWith('%')) continue
      const cls = d.className || ''
      if (cls.includes('bg-accent')) {
        barPct = parseFloat(w)
        barVisible = true
      } else if (cls.includes('bg-white/45')) {
        bufferedPct = parseFloat(w)
      }
    }
  }
  return {
    currentTime: v.currentTime,
    elementDuration: Number.isFinite(v.duration) ? v.duration : null,
    readyState: v.readyState,
    paused: v.paused,
    text,
    barPct,
    barVisible,
    bufferedPct,
    ariaNow: slider ? Number(slider.getAttribute('aria-valuenow')) : NaN,
    ariaMax: slider ? Number(slider.getAttribute('aria-valuemax')) : NaN,
  }
}

function parseText(text) {
  if (!text) return null
  const m = text.match(/(\d+):(\d{2})\s*\/\s*(\d+):(\d{2})/)
  if (!m) return null
  return { cur: Number(m[1]) * 60 + Number(m[2]), total: Number(m[3]) * 60 + Number(m[4]) }
}

async function main() {
  // 真源总时长：从 daemon 拿，绝不手写
  const res = await fetch(`${TG}/api/media/items/${ITEM}`)
  const item = await res.json()
  const TRUTH = Number(item.duration)
  console.log(`[verify] item ${ITEM} 真源 duration = ${TRUTH}s (${Math.floor(TRUTH / 60)}:${String(TRUTH % 60).padStart(2, '0')})`)

  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  })
  const page = await browser.newPage()
  let failed = false
  try {
    await page.goto(APP_URL)
    await page.waitForFunction(() => Boolean(window.__origStore), { timeout: 30000, intervalMs: 250 })

    await page.evaluate(
      (tg, id, dur) => {
        window.__origStore.getState().openViewer({
          items: [
            {
              key: `media-${id}`,
              chatId: 0,
              messageId: id,
              kind: 'video',
              caption: 'BUG-450 real stream verify',
              description: null,
              src: `${tg}/api/media/items/${id}/stream`,
              poster: null,
              episodeNo: null,
              seriesId: null,
              duration: dur,
            },
          ],
          index: 0,
          title: 'BUG-450 real stream verify',
        })
      },
      TG,
      ITEM,
      TRUTH,
    )

    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
      timeout: 30000,
      intervalMs: 200,
    })
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      v.muted = true
      v.play().catch(() => {})
    })

    // 等真的播起来并读到可见条
    const deadline = Date.now() + 40000
    let snap = null
    let barSnap = null
    while (Date.now() < deadline) {
      await poke(page)
      snap = await page.evaluate(SNAPSHOT)
      if (snap && snap.currentTime > 2 && snap.barVisible && !barSnap) barSnap = snap
      if (snap && snap.currentTime > 2 && snap.barVisible) break
      await delay(300)
    }
    await poke(page)
    await delay(1200)
    const last = await page.evaluate(SNAPSHOT)
    if (last && last.barVisible) barSnap = last
    if (!snap) snap = last

    console.log('[verify] snapshot =', JSON.stringify(snap))
    if (barSnap) console.log('[verify] barSnapshot =', JSON.stringify(barSnap))

    if (!snap) {
      check('S0 播放器与条面存在', false, '找不到 video / slider')
      failed = true
      throw new Error('no snapshot')
    }

    const t = parseText(snap.text)
    check('S1 时间文本可解析', Boolean(t), `text=${snap.text}`)
    if (!t) throw new Error('text unparsable')

    check(
      'S2 文本总时长 = 真源时长',
      Math.abs(t.total - TRUTH) <= 1,
      `total=${t.total} 期望≈${TRUTH}`,
    )

    // ★ 核心判据：条面分母必须 == 真源总时长。
    //   退化时它会等于元素 duration（live 流上只是「已转码到哪」）。
    check(
      'S3 条面分母 = 真源总时长（不是元素 duration）',
      Math.abs(snap.ariaMax - TRUTH) <= 1,
      `aria-valuemax=${snap.ariaMax} 期望≈${TRUTH}；元素 duration=${snap.elementDuration}`,
    )

    check(
      'S4 条面分母未退化为元素 duration',
      snap.ariaMax !== snap.elementDuration,
      `ariaMax=${snap.ariaMax} elementDuration=${snap.elementDuration}` +
        `（相等 ⇒ 分母走的是「已转码到哪」，即旧缺陷）`,
    )

    if (barSnap) {
      const expectedPct = (barSnap.currentTime / TRUTH) * 100
      const delta = Math.abs(barSnap.barPct - expectedPct)
      check(
        'S5 可见条宽 = 播放点/真源时长（像素级一致）',
        delta <= TOLERANCE_PCT,
        `bar=${barSnap.barPct.toFixed(1)}% @${barSnap.currentTime.toFixed(1)}s 期望=${expectedPct.toFixed(1)}% Δ=${delta.toFixed(1)}pt` +
          `（buffered=${barSnap.bufferedPct}% 仅参考）`,
      )
    } else {
      console.log('[verify] SKIP S5 可见条像素校验（控件整轮未挂载，本轮不适用）')
    }
  } catch (err) {
    failed = true
    console.error('[verify] ERROR', err && err.message ? err.message : err)
  } finally {
    try {
      await page.screenshot({ path: 'verify_shots/bug450-real-stream.png' })
    } catch {
      /* ignore */
    }
    await browser.close()
  }

  const bad = checks.filter((c) => !c.pass)
  if (bad.length || failed) {
    console.log(`\ncheck-bug450-real: FAIL - ${bad.length} 项不达标`)
    process.exit(1)
  }
  console.log('\ncheck-bug450-real: OK - 真实 live 流上条面与文本同一分母')
}

main()
