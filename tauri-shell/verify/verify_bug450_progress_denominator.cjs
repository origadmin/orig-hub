#!/usr/bin/env node
'use strict'

/**
 * BUG-450 acceptance: the progress bar and the time text must share ONE denominator.
 *
 * 症状：`1:14 / 10:30` 时条面已填满 ~97%。
 * 根因：可见条拿的是「分段轴」（跳过片头/片尾的 `segOffset`/`segDuration`，默认 0/null），
 *      于是 `displayDur()` 回退到**元素** `duration`；而 live 转码流上元素 `duration`
 *      只是「已经转码到哪」。时间文本走的是内容轴（真源时长），所以两个控件两个分母。
 *
 * 判据（确定性，不依赖转码快慢）：
 *   把 `video.duration` 强行改成 10s（模拟「元素只知道转了 10 秒」），真源时长传 50s。
 *   - 修复前：条面 = currentTime/10 ⇒ 播到 5s 就是 50%，与文本 5/50=10% 差 40 个点。
 *   - 修复后：条面 = currentTime/50 ⇒ 与文本一致（|Δ| ≤ 3 个点）。
 *
 * 反向证伪：把 `displayDur()` 的 ref 优先改回 prop/元素优先 ⇒ 本条必 FAIL。
 *
 * Usage: node verify/verify_bug450_progress_denominator.cjs
 * Env: APP_PORT(5180) TG_URL(127.0.0.1:19787) PROBE_ITEM(630) CONTENT_DURATION(50)
 */

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 630)
/** 真源总时长（秒）：必须与 `GET /api/media/items/<id>` 的 duration 一致，否则文本也会错。 */
const CONTENT_DURATION = Number(process.env.CONTENT_DURATION || 50)
/** 强塞给元素的假 duration：模拟「转码只覆盖了一小段」。 */
const FAKE_ELEMENT_DURATION = 10
const TOLERANCE_PCT = 3

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name} :: ${detail}`)
}

/** 让控件层保持可见。
 *  ★ 必须打在 `[role="application"]` 上：`onMouseMove={pokeControls}` 挂在播放器容器，
 *    React 合成事件按「目标 → 根」冒泡计算路径；打在它的**父节点**上，容器不在路径里，
 *    处理器不会触发（本轮踩过：整轮 S4 都被 SKIP）。 */
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
  // 时间文本：唯一含 " / " 的 span
  let text = null
  for (const s of root.querySelectorAll('span')) {
    const tx = (s.textContent || '').trim()
    if (tx.includes('/') && tx.includes(':')) {
      text = tx
      break
    }
  }
  // 播放段：slider 内带内联 width 且是 `bg-accent` 的那个 div。
  // ★ 不能取「第一个带 width 的 div」—— 那是**已缓冲**段（track 里，DOM 在前），
  //   它的进度本来就在播放点前面，会把判据带偏。
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
  // 兜底/交叉校验：`write()` 同时直写 aria-valuenow/valuemax（同一 `dur`），
  // 控件隐藏时仍可读 —— 但**不作为主判据**，主判据必须是可见条宽。
  const ariaNow = slider ? Number(slider.getAttribute('aria-valuenow')) : NaN
  const ariaMax = slider ? Number(slider.getAttribute('aria-valuemax')) : NaN
  return {
    currentTime: v.currentTime,
    elementDuration: Number.isFinite(v.duration) ? v.duration : null,
    paused: v.paused,
    readyState: v.readyState,
    text,
    barPct,
    barVisible,
    bufferedPct,
    ariaNow,
    ariaMax,
  }
}

/** "1:14 / 10:30" -> {cur:74, total:630} */
function parseText(text) {
  if (!text) return null
  const m = text.match(/(\d+):(\d{2})\s*\/\s*(\d+):(\d{2})/)
  if (!m) return null
  return {
    cur: Number(m[1]) * 60 + Number(m[2]),
    total: Number(m[3]) * 60 + Number(m[4]),
  }
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
      '--mute-audio',
    ],
  })
  const page = await browser.newPage()
  let failed = false
  try {
    await page.goto(APP_URL)
    await page.waitForFunction(() => Boolean(window.__origStore), {
      timeout: 30000,
      intervalMs: 250,
    })

    // 打开播放器：src 直连转码流；duration 传真源总时长（BUG-253 的入口）
    await page.evaluate(
      (tg, id, dur) => {
        window.__origStore.getState().openViewer({
          items: [
            {
              key: `media-${id}`,
              chatId: 0,
              messageId: id,
              kind: 'video',
              caption: 'BUG-450 verify',
              description: null,
              src: `${tg}/api/media/items/${id}/stream`,
              poster: null,
              episodeNo: null,
              seriesId: null,
              duration: dur,
            },
          ],
          index: 0,
          title: 'BUG-450 verify',
        })
      },
      TG,
      ITEM,
      CONTENT_DURATION,
    )

    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="media-viewer"] video'),
      { timeout: 30000, intervalMs: 200 },
    )

    // 起播 + 强塞假元素时长（模拟「转码只覆盖 10s」）
    await page.evaluate((fake) => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      v.muted = true
      v.play().catch(() => {})
      Object.defineProperty(v, 'duration', { configurable: true, get: () => fake })
    }, FAKE_ELEMENT_DURATION)

    // 等到真的播起来（currentTime > 2），最多 25s；期间持续 poke 控件让它保持可见。
    // 控件会在几秒后自动隐藏（`chromeMounted` 卸载可见条），所以**一旦读到可见条宽就
    // 立刻留档**（barSnap）—— 不能等到循环末尾再读，那时可能已经只剩 sr-only 条。
    const deadline = Date.now() + 25000
    let snap = null
    let barSnap = null
    while (Date.now() < deadline) {
      await poke(page)
      snap = await page.evaluate(SNAPSHOT)
      if (snap && snap.currentTime > 2 && snap.barVisible && !barSnap) barSnap = snap
      if (snap && snap.currentTime > 2 && snap.barVisible) break
      await delay(300)
    }
    // 再等两拍 timeupdate，确保条面已经按新分母写过
    await poke(page)
    await delay(1200)
    snap = await page.evaluate(SNAPSHOT)
    // 末尾如果可见条还在，用最新的；否则退回留档的那一帧
    if (snap && snap.barVisible) barSnap = snap

    console.log('[verify] snapshot =', JSON.stringify(snap))
    if (barSnap) console.log('[verify] barSnapshot =', JSON.stringify(barSnap))
    if (!snap) {
      check('S0 播放器与条面存在', false, '找不到 video / slider')
      failed = true
      throw new Error('no snapshot')
    }
    if (!snap.barVisible) {
      console.log('[verify] NOTE 可见条未挂载（控件自动隐藏），以 aria-valuemax 作分母判据')
    }

    check(
      'S0 元素 duration 已被改成假值（前提成立）',
      snap.elementDuration === FAKE_ELEMENT_DURATION,
      `elementDuration=${snap.elementDuration} 期望=${FAKE_ELEMENT_DURATION}`,
    )

    const t = parseText(snap.text)
    check('S1 时间文本可解析', Boolean(t), `text=${snap.text}`)
    if (!t) throw new Error('text unparsable')

    check(
      'S2 文本总时长 = 真源时长（不是元素假值）',
      Math.abs(t.total - CONTENT_DURATION) <= 1,
      `total=${t.total} 期望≈${CONTENT_DURATION}`,
    )

    /**
     * 主判据：**分母**。
     * `write()` 里 `dur` 只算一次，同时喂给「条面宽度」和 `aria-valuemax` —— 所以
     * `aria-valuemax` 就是条面用的那个分母，控件隐藏时依然可读（不受节流影响：
     * valuemax 只在变化时写）。若仍走「元素 duration」，这里会是 10，不是 50。
     */
    check(
      'S3 进度条分母 = 真源时长（不是元素 duration）',
      Math.abs(snap.ariaMax - CONTENT_DURATION) <= 1,
      `aria-valuemax=${snap.ariaMax} 期望≈${CONTENT_DURATION}（若退化会是 ${FAKE_ELEMENT_DURATION}）`,
    )

    if (barSnap) {
      // 期望值用**该帧自己的播放点**算（条宽按 BAR_WRITE_MS 节流，最多落后半拍）；
      // 不用 aria-valuenow —— 它按 ARIA_WRITE_MS 节流，比条宽更旧。
      const expectedPct = (barSnap.currentTime / CONTENT_DURATION) * 100
      const delta = Math.abs(barSnap.barPct - expectedPct)
      check(
        'S4 可见条宽 = 播放点/真源时长（像素级一致）',
        delta <= TOLERANCE_PCT,
        `bar=${barSnap.barPct.toFixed(1)}% @${barSnap.currentTime.toFixed(1)}s 期望=${expectedPct.toFixed(1)}% Δ=${delta.toFixed(1)}pt` +
          `（buffered=${barSnap.bufferedPct}% 只作参考，不是判据）`,
      )
    } else {
      console.log('[verify] SKIP S4 可见条像素校验（整轮控件都未挂载，本轮不适用）')
    }
  } catch (err) {
    failed = true
    console.error('[verify] ERROR', err && err.message ? err.message : err)
  } finally {
    try {
      await page.screenshot({ path: 'verify_shots/bug450-progress.png' })
    } catch {
      /* 截图失败不影响判据 */
    }
    await browser.close()
  }

  const bad = checks.filter((c) => !c.pass)
  if (bad.length || failed) {
    console.log(`\ncheck-bug450: FAIL - ${bad.length} 项不达标`)
    process.exit(1)
  }
  console.log('\ncheck-bug450: OK - 条面与时间文本同一分母')
}

main()
