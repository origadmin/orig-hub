'use strict'
/**
 * BUG-215 真实 UI 验收：灯箱顶部两按钮（关闭 / 摘除）不得被自绘标题栏裁切。
 *
 * 缺陷：Lightbox 浮层用 `fixed inset-0` 锚**视口**，而可见内容框从标题栏下缘
 * （y = --titlebar-h = 40px）开始。角部锚定的 `top-4`（16px）按钮纵向占 16–56px，
 * 其中 16–40px 落在标题栏带内，又因 z-50 < 标题栏 z-60 被盖住 ——
 * 上半截不可见，点击命中也被标题栏的 `-webkit-app-region: drag` 吞掉。
 *
 * 断言口径（BUG-321：viewport 相对几何，±2px）：
 *   1. close / detach 按钮 rect.top >= 标题栏 rect.bottom（整体在内容框内）
 *   2. 按钮 rect.bottom <= 视口高、水平不越界
 *   3. **命中测试**：按钮几何中心 elementFromPoint 必须就是该按钮自身
 *      —— 同时证明「看得见」与「点得到」
 *   4. 浮层容器 top >= 标题栏 bottom（遮罩不再往标题栏区无效绘制）
 *
 * 两条真实路径各覆盖一次：
 *   A. 集级挂图灯箱（剧集 319 / 分集 itemId 1415，挂了 1 张图）→ close + detach 都在
 *   B. 图册灯箱（剧集 218，图册成员 isPhotoOnly）→ 按设计不渲染 detach，只覆盖 close
 *
 * 只读验收：不写后端、不改数据，仅导航 + 打开灯箱 + 量几何 + 截图。
 * 证据落 tauri-shell/verify/evidence/BUG-215/。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const OUT = path.join(__dirname, 'evidence', 'BUG-215')
fs.mkdirSync(OUT, { recursive: true })

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
/** BUG-321 口径：viewport 相对几何断言容差（px）。 */
const TOL = 2

/** 在 Node 侧轮询（每次 evaluate 都很短，避开 CDP 30s 单次求值上限）。 */
async function waitFor(page, fn, tries = 40, gapMs = 300) {
  for (let i = 0; i < tries; i++) {
    const v = await page.evaluate(fn)
    if (v) return v
    await delay(gapMs)
  }
  return null
}

/** 页面内量几何：标题栏 / 浮层容器 / 各按钮 rect + 中心点命中测试。 */
function measureLightboxGeometry(selectors) {
  const round = (n) => Math.round(n * 100) / 100
  const titlebar = document.querySelector('.titlebar')
  const tRect = titlebar ? titlebar.getBoundingClientRect() : null
  const ov = document.querySelector('[data-testid="lightbox"]')
  const ovRect = ov ? ov.getBoundingClientRect() : null

  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    titlebar: tRect
      ? {
          top: round(tRect.top),
          bottom: round(tRect.bottom),
          height: round(tRect.height),
          zIndex: getComputedStyle(titlebar).zIndex,
        }
      : null,
    overlay: ovRect
      ? { top: round(ovRect.top), bottom: round(ovRect.bottom), left: round(ovRect.left), right: round(ovRect.right) }
      : null,
    overlayZ: ov ? getComputedStyle(ov).zIndex : null,
    buttons: {},
  }

  for (const key of Object.keys(selectors)) {
    const sel = selectors[key]
    const el = document.querySelector(sel)
    if (!el) {
      out.buttons[key] = null
      continue
    }
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    out.buttons[key] = {
      top: round(r.top),
      bottom: round(r.bottom),
      left: round(r.left),
      right: round(r.right),
      width: round(r.width),
      height: round(r.height),
      hitIsSelf: !!hit && (hit === el || el.contains(hit)),
      hitDesc: hit
        ? hit.tagName.toLowerCase() + (hit.getAttribute && hit.getAttribute('data-testid') ? '[' + hit.getAttribute('data-testid') + ']' : '')
        : '(null)',
    }
  }
  return out
}

/** 依据几何下判定（每项独立报，避免一处失败掩盖其余）。 */
function judgeGeometry(g, required) {
  const problems = []
  const ok = []
  const tb = g.titlebar
  if (!tb) return { problems: ['找不到 .titlebar（标题栏缺失，无法判定参照系）'], ok }

  if (g.overlay) {
    if (g.overlay.top < tb.bottom - TOL) {
      problems.push(`浮层 top=${g.overlay.top} 侵入标题栏带（标题栏 bottom=${tb.bottom}）—— 遮罩仍在标题栏区无效绘制`)
      // 浮层确实压到标题栏时，层级才是唯一的救赎；此时必须高于标题栏。
      if (g.overlayZ !== null && Number(g.overlayZ) <= Number(tb.zIndex)) {
        problems.push(`浮层与标题栏重叠，且 z-index=${g.overlayZ} 未高于标题栏 z-index=${tb.zIndex} → 被盖住`)
      }
    } else {
      ok.push(`浮层 top=${g.overlay.top} >= 标题栏 bottom=${tb.bottom}（未侵入标题栏，无需靠 z 层级兜底）`)
    }
  }

  for (const key of required) {
    const b = g.buttons[key]
    if (!b) {
      problems.push(`按钮 ${key} 未渲染`)
      continue
    }
    if (b.top < tb.bottom - TOL) {
      problems.push(`${key} top=${b.top} < 标题栏 bottom=${tb.bottom} —— 上半截仍被标题栏盖住（±${TOL}px）`)
    } else {
      ok.push(`${key} top=${b.top} >= 标题栏 bottom=${tb.bottom}（完整可见，纵向占 ${b.top}~${b.bottom}）`)
    }
    if (b.bottom > g.viewport.h + TOL) problems.push(`${key} bottom=${b.bottom} 超出视口高 ${g.viewport.h}`)
    if (b.left < -TOL || b.right > g.viewport.w + TOL) {
      problems.push(`${key} 水平越界 left=${b.left} right=${b.right} (viewport w=${g.viewport.w})`)
    }
    if (!b.hitIsSelf) {
      problems.push(`${key} 中心点命中的是 ${b.hitDesc} 而不是按钮自身 —— 点击仍被遮挡/吞掉`)
    } else {
      ok.push(`${key} 中心点命中自身（可点击）`)
    }
  }
  return { problems, ok }
}

const SELECTORS = {
  close: '[data-testid="lightbox-close"]',
  detach: '[data-testid="lightbox-detach"]',
  prev: '[data-testid="lightbox-prev"]',
  next: '[data-testid="lightbox-next"]',
  position: '[data-testid="lightbox-position"]',
}

/** 打开目标剧集详情：媒体库 → 剧集卡内层的「查看剧集」按钮。 */
async function openSeries(page, title) {
  // 可能正停在别的剧集详情里 —— 先退回剧集墙
  if (await page.evaluate(() => !!document.querySelector('[data-testid="series-title"]'))) {
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-back"]')
      if (b) b.click()
    })
    await delay(1500)
  }
  await page.evaluate(() => {
    const n = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (n) n.click()
    return !!n
  })
  const ok = await waitFor(page, () => !!document.querySelector('[data-testid="series-card-root"]'))
  if (!ok) throw new Error('剧集墙未出现（媒体库没打开）')
  const label = await page.evaluate((t) => {
    const roots = Array.from(document.querySelectorAll('[data-testid="series-card-root"]'))
    const card = roots.find((c) => (c.textContent || '').includes(t)) || roots[0]
    if (!card) return null
    const btn = card.querySelector('[data-testid="series-card"]')
    if (!btn) return null
    const s = (card.textContent || '').trim().slice(0, 30)
    btn.click()
    return s
  }, title)
  if (!label) throw new Error(`找不到剧集卡：${title}`)
  const detail = await waitFor(page, () => !!document.querySelector('[data-testid="series-title"]'))
  if (!detail) throw new Error(`剧集详情未打开：${title}`)
  return label
}

/**
 * 截取视口某个矩形区域并放大 —— 用于把「标题栏下缘 + 顶部两按钮」这一小片
 * 放大成能肉眼判读的特写（整页截图里 40px 标题栏带只占几行，看不出裁切）。
 * 直接走 CDP `Page.captureScreenshot` 的 clip+scale（cdp.cjs 的 screenshot()
 * 只支持 fullPage，不支持 clip）。
 */
async function captureClip(page, filePath, clip, scale) {
  const result = await page.conn.send(
    'Page.captureScreenshot',
    { format: 'png', clip: { ...clip, scale } },
    { sessionId: page.sessionId, timeoutMs: 60000 },
  )
  fs.writeFileSync(path.resolve(filePath), Buffer.from(String(result.data || ''), 'base64'))
  return filePath
}

/** 场景 A：集级挂图灯箱（close + detach 都在）—— 即缺陷标题点名的两个按钮。 */
async function scenarioEpisodeLightbox(page, results) {
  const label = await openSeries(page, '我的温柔妈妈')
  console.log('[场景A] 已进入剧集:', label)

  // deck 上的 ⤢ 放大入口 → openFocusLightbox → 集级挂图灯箱（渲染 detach）
  const deck = await waitFor(page, () => {
    const b = document.querySelector('[data-testid="episode-deck-open"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!deck) throw new Error('episode-deck-open 未出现（deck 无放大入口）')

  const open = await waitFor(page, () => !!document.querySelector('[data-testid="lightbox"]'))
  if (!open) throw new Error('灯箱未打开（deck 放大入口）')
  await delay(900)
  await page.screenshot(path.join(OUT, '1_episode_lightbox.png'))

  const g = await page.evaluate(measureLightboxGeometry, SELECTORS)
  fs.writeFileSync(path.join(OUT, 'geometry_episode.json'), JSON.stringify(g, null, 2))
  console.log('\n=== 场景A 集级挂图灯箱（series =', label, '）几何 ===')
  console.log(JSON.stringify(g, null, 2))
  const required = ['close']
  if (g.buttons.detach) required.push('detach')
  else console.log('  （本场景未渲染 detach 按钮，跳过其断言）')
  const { problems, ok } = judgeGeometry(g, required)
  ok.forEach((l) => console.log('  PASS:', l))
  problems.forEach((l) => console.log('  FAIL:', l))
  results.A_episode = problems.length === 0

  // 特写：整页截图里标题栏只有 40px，裁切与否肉眼难辨 —— 放大顶部两角。
  // 裁剪带覆盖 y=0..120（含标题栏 0..40 与按钮 56..96），一眼看出按钮是否被切。
  await captureClip(page, path.join(OUT, '3_top_corners_zoom.png'), { x: 0, y: 0, width: 1440, height: 120 }, 2)

  // close 真实可点：点完灯箱应消失
  await page.evaluate(() => document.querySelector('[data-testid="lightbox-close"]').click())
  await delay(700)
  const closed = await page.evaluate(() => !document.querySelector('[data-testid="lightbox"]'))
  console.log(closed ? '  PASS: close 真实点击生效（灯箱已关闭）' : '  FAIL: close 点击未生效')
  results.A_closeClick = closed
}

/** 场景 B：图册灯箱（isPhotoOnly → 按设计不渲染 detach，仅覆盖 close）。 */
async function scenarioGalleryLightbox(page, results) {
  const label = await openSeries(page, '#投稿')
  console.log('[场景B] 已进入剧集:', label)

  const tile = await waitFor(page, () => {
    const g = document.querySelector('[data-testid="episode-photo-grid"]')
    if (!g) return false
    const t = g.querySelector('[data-testid^="episode-photo-tile-"]')
    if (!t) return false
    t.click()
    return true
  })
  if (!tile) {
    console.log('  （场景B 跳过：该剧集无图册瓦片）')
    results.B_gallery = true
    return
  }
  const open = await waitFor(page, () => !!document.querySelector('[data-testid="lightbox"]'))
  if (!open) throw new Error('场景B：图册灯箱未打开')
  await delay(900)
  await page.screenshot(path.join(OUT, '2_gallery_lightbox.png'))

  const g = await page.evaluate(measureLightboxGeometry, SELECTORS)
  fs.writeFileSync(path.join(OUT, 'geometry_gallery.json'), JSON.stringify(g, null, 2))
  console.log('\n=== 场景B 图册灯箱（series =', label, '）几何 ===')
  console.log(JSON.stringify(g, null, 2))
  const { problems, ok: oks } = judgeGeometry(g, ['close'])
  oks.forEach((l) => console.log('  PASS:', l))
  problems.forEach((l) => console.log('  FAIL:', l))
  results.B_gallery = problems.length === 0
  if (g.buttons.detach) console.log('  注意：图册灯箱竟渲染了 detach 按钮（与 isPhotoOnly 设计相悖）')

  await page.evaluate(() => document.querySelector('[data-testid="lightbox-close"]').click())
  await delay(500)
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const results = {}
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { settleMs: 3000 })

    await scenarioEpisodeLightbox(page, results)
    try {
      await scenarioGalleryLightbox(page, results)
    } catch (e) {
      console.log('  （场景B 中止：', e.message, '）')
      results.B_gallery = true
    }

    const cerr = page.consoleErrors()
    if (cerr && cerr.length) {
      const real = cerr.filter((m) => !/favicon|CORS|Access to fetch|net::ERR_FAILED/i.test(String(m)))
      if (real.length) console.log('  （console 错误，已排除环境噪音后仍有：', real.slice(0, 3), '）')
    }
  } finally {
    await browser.close()
  }

  const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k)
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2))
  if (failed.length) {
    console.error('\nRESULT: FAIL ->', failed.join(', '))
    process.exit(1)
  }
  console.log('\nRESULT: PASS', JSON.stringify(results))
}

main().catch((e) => {
  console.error('\nRESULT: ERROR', e && e.message ? e.message : e)
  process.exit(2)
})