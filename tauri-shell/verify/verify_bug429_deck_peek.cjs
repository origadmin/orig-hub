#!/usr/bin/env node
'use strict'
/**
 * BUG-429 真实 UI 验收：本集图组（Deck 平铺）露边可点 + 编辑态缩略图尺寸。
 *
 * ## 用户诉求（2026-10-26 原话）
 *   「本集图组 平铺需要再展开一点,后面的图片不容易点击.
 *     编辑中的图片展示也需要稍微放大点,这是图片不是ICON.」
 *
 * ## 修复前实测（剧集 217 / 分集 573，9 帧竖版）
 *   - 单卡宽 170px，后卡只露 **26px**（15%）；父容器可用宽 **830px**，富余很大；
 *   - 槽位写死 `min(n,6)` ⇒ 9 帧里后 3 帧**完全叠在同一槽位**（相邻间距出现 3 个 0），
 *     根本点不到；
 *   - 编辑面板缩略图 `h-14 w-20` = **80×56**，接近图标尺寸。
 *
 * ## 修复
 *   - `Deck`：上限取 `min(maxW, 父容器可用宽)`（ResizeObserver，窄窗口不溢出）；
 *     槽位数按宽度预算自适应，且每张后卡露边不低于 `MIN_PEEK_PX = 44`；
 *   - `SeriesDetail`：`maxW 420→580`、`peek 26→56`、`maxSlots 6→10`；
 *   - `EpisodeEditPanel`：缩略图 `80×56 → 112×80`。
 *
 * ## 判据
 *  429-A 每张后卡的露边 ≥ 44px（`MIN_PEEK_PX`）。
 *  429-B 帧数装得下时，每帧独占一个槽位（相邻间距不得出现 0）；装不下时记 N/A。
 *  429-C 平铺总宽 ≤ 父容器可用宽（不得横向溢出）。
 *  429-D 在最靠后一张卡的露边处做命中测试，命中的必须是它自己（不是被前卡盖住）。
 *  429-E 编辑面板缩略图 ≥ 96×64（明显大于修复前的 80×56）。
 *  429-F 无页面 / console 错误（favicon 噪声除外）。
 *  RF1 把可用宽压到 180px ⇒ 429-A/B 必须 FAIL；还原后复绿（判据灵敏）。
 *  RF2 把一张缩略图压回 80×56 ⇒ 429-E 必须 FAIL；还原后复绿。
 *
 * 用法（先起 dev 栈 5180）：
 *   node tauri-shell/verify/verify_bug429_deck_peek.cjs [SERIES_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug429-deck'),
)
/** 默认剧集 217：库里恰好 1 集、带 9 帧（露边/槽位压缩问题最明显） */
const SERIES_ID = Number(process.argv[2] || process.env.SERIES_ID || 217)
const MIN_PEEK = 44
const THUMB_MIN_W = 96
const THUMB_MIN_H = 64
const NAV_TIMEOUT = 90000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function openSeries(page, sid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
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
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
        { timeout: 25000 },
      )
    } catch {
      console.log(`[bug429] attempt#${attempt + 1}: series wall timeout`)
      await delay(2000)
      continue
    }
    await delay(1000)
    const clicked = await page.evaluate((id) => {
      const card = document.querySelector(`[data-testid="series-card"][data-series-id="${id}"]`)
      if (!card) return false
      card.click()
      return true
    }, sid)
    if (!clicked) {
      console.log(`[bug429] attempt#${attempt + 1}: series ${sid} not in wall`)
      await delay(1500)
      continue
    }
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    const inDetail = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-focus-title"]'),
    )
    if (!inDetail) {
      console.log(`[bug429] attempt#${attempt + 1}: detail pane not opened`)
      await delay(1500)
      continue
    }
    await delay(900)
    return
  }
  throw new Error(`series ${sid} detail not reachable`)
}

/** 切到帧数最多的那一集（Deck 只在有帧且非编辑态时渲染） */
async function focusRichestEpisode(page) {
  const rows = await page.evaluate(
    () => document.querySelectorAll('[data-testid="episode-pick"]').length,
  )
  let best = { row: -1, frames: 0 }
  for (let i = 0; i < rows; i++) {
    await page.evaluate((k) => {
      const el = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      if (el[k]) el[k].click()
    }, i)
    await delay(600)
    const n = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="episode-deck-count"]')
      if (!c) return 0
      const m = (c.textContent || '').match(/\/\s*(\d+)/)
      return m ? Number(m[1]) : 0
    })
    if (n > best.frames) best = { row: i, frames: n }
  }
  if (best.row >= 0) {
    await page.evaluate((k) => {
      const el = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      if (el[k]) el[k].click()
    }, best.row)
    await delay(800)
  }
  return best
}

/** 量平铺：每张卡 x / 露边 / 总宽 / 父容器宽 / 后卡露边处命中测试 */
function readDeck() {
  const deck = document.querySelector('[data-testid="episode-deck"]')
  if (!deck) return { exists: false }
  const dr = deck.getBoundingClientRect()
  const box = deck.parentElement
  const boxW = box ? Math.round(box.getBoundingClientRect().width) : null
  const cards = [...deck.children].filter(
    (el) => el.tagName === 'DIV' && getComputedStyle(el).position === 'absolute',
  )
  const rects = cards.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x * 100) / 100, w: Math.round(r.width * 100) / 100 }
  })
  const byX = [...rects].sort((a, b) => a.x - b.x)
  // 露边 = 相邻卡的左边界间距（最后一张按「总宽 − 它的 x」算）
  const steps = []
  for (let i = 1; i < byX.length; i++) steps.push(Math.round((byX[i].x - byX[i - 1].x) * 100) / 100)
  const lastExposure = byX.length
    ? Math.round((dr.right - byX[byX.length - 1].x) * 100) / 100
    : 0
  const distinctX = new Set(byX.map((r) => r.x)).size
  // 命中测试：最靠后（x 最小）那张的露边中点
  let hit = null
  if (byX.length) {
    const back = byX[0]
    const px = Math.round(back.x + Math.min(4, Math.max(1, (steps[0] ?? 8) / 2)))
    const py = Math.round(dr.y + dr.height / 2)
    const el = document.elementFromPoint(px, py)
    hit = {
      x: px,
      y: py,
      tag: el ? el.tagName : null,
      insideDeck: el ? deck.contains(el) : false,
      // 命中的元素是否属于「x 最小那张卡」
      onBackCard: el ? cards[byX[0] ? rects.findIndex((r) => r.x === byX[0].x) : 0] === el.closest('div') : false,
      hitCardX: el && el.closest('div') ? Math.round(el.closest('div').getBoundingClientRect().x) : null,
      backCardX: back.x,
    }
  }
  return {
    exists: true,
    count: deck.getAttribute('data-deck-count'),
    totalW: Math.round(dr.width),
    boxW,
    cardCount: rects.length,
    cardW: rects.length ? rects[0].w : null,
    steps,
    lastExposure,
    minExposure: steps.length ? Math.min(...steps) : lastExposure,
    distinctX,
    hit,
  }
}

function readThumbs() {
  const wrap = document.querySelector('[data-testid="episode-edit-images"]')
  if (!wrap) return { exists: false }
  const imgs = [...wrap.querySelectorAll('img')]
  const first = imgs[0] ? imgs[0].getBoundingClientRect() : null
  return {
    exists: true,
    count: imgs.length,
    w: first ? Math.round(first.width) : 0,
    h: first ? Math.round(first.height) : 0,
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const evidence = { seriesId: SERIES_ID }
  try {
    await openSeries(page, SERIES_ID)
    evidence.focus = await focusRichestEpisode(page)
    const deck = await page.evaluate(readDeck)
    evidence.deck = deck
    console.log('[bug429] deck: ' + JSON.stringify(deck))
    await page.screenshot(path.join(OUT, 'A-deck.png'))

    if (!deck.exists) throw new Error('episode-deck not rendered (该集没有帧)')

    // 429-A：露边下限
    check(
      `429-A 每张后卡露边 ≥ ${MIN_PEEK}px`,
      deck.minExposure >= MIN_PEEK,
      `minExposure=${deck.minExposure}px steps=${JSON.stringify(deck.steps)}`,
    )
    // 429-B：帧数装得下时每帧独占槽位
    const maxByStep = deck.boxW ? Math.floor((Math.min(580, deck.boxW) - deck.cardW) / MIN_PEEK) + 1 : 0
    const roomForAll = deck.cardCount <= Math.min(10, maxByStep)
    check(
      '429-B 每帧独占一个槽位（相邻间距无 0）',
      roomForAll ? deck.distinctX === deck.cardCount : true,
      roomForAll
        ? `distinctX=${deck.distinctX} cardCount=${deck.cardCount}`
        : `N/A（宽度只够 ${Math.min(10, maxByStep)} 槽，帧数 ${deck.cardCount}）`,
    )
    // 429-C：不溢出
    check(
      '429-C 平铺总宽 ≤ 父容器可用宽',
      deck.boxW == null ? true : deck.totalW <= deck.boxW + 1,
      `totalW=${deck.totalW} boxW=${deck.boxW}`,
    )
    // 429-D：后卡露边可点
    check(
      '429-D 后卡露边命中它自己（不是被前卡盖住）',
      !!deck.hit && deck.hit.insideDeck && deck.hit.hitCardX === deck.hit.backCardX,
      `hit=${JSON.stringify(deck.hit)}`,
    )

    // ---- RF1：把可用宽压到 180px ⇒ 429-A/B 必须 FAIL ----
    // 放在进编辑态**之前**：编辑态不渲染 Deck（BUG-203/204），那时就没法做这组证伪了。
    const rf1 = await page.evaluate(() => {
      const deck = document.querySelector('[data-testid="episode-deck"]')
      if (!deck) return { ok: false }
      const box = deck.parentElement
      if (!box) return { ok: false }
      box.setAttribute('data-rf1-saved', box.style.width || '')
      box.style.width = '180px'
      return { ok: true }
    })
    if (rf1.ok) {
      await delay(1200) // 等 ResizeObserver 回灌
      const rfDeck = await page.evaluate(readDeck)
      check(
        'RF1 可用宽压到 180px ⇒ 429-A/B 必须 FAIL',
        !!rfDeck && rfDeck.exists && (rfDeck.minExposure < MIN_PEEK || rfDeck.distinctX < rfDeck.cardCount),
        rfDeck && rfDeck.exists
          ? `minExposure=${rfDeck.minExposure}px distinctX=${rfDeck.distinctX}/${rfDeck.cardCount}`
          : 'deck 消失',
      )
      // 还原
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('[data-rf1-saved]')) {
          el.style.width = el.getAttribute('data-rf1-saved') || ''
          el.removeAttribute('data-rf1-saved')
        }
      })
      await delay(1200)
      const back = await page.evaluate(readDeck)
      check(
        'RF1b 还原可用宽 ⇒ 429-A/B 复绿',
        !!back && back.exists && back.minExposure >= MIN_PEEK,
        back && back.exists ? `minExposure=${back.minExposure}px distinctX=${back.distinctX}/${back.cardCount}` : 'deck 消失',
      )
    } else {
      check('RF1 可用宽压到 180px ⇒ 429-A/B 必须 FAIL', false, '无法定位 deck 容器')
    }

    // 编辑态缩略图
    const opened = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="episode-edit"]')
      if (!b) return false
      b.click()
      return true
    })
    let thumbs = { exists: false }
    if (opened) {
      await delay(900)
      thumbs = await page.evaluate(readThumbs)
      await page.screenshot(path.join(OUT, 'B-edit.png'))
    }
    evidence.thumbs = thumbs
    console.log('[bug429] thumbs: ' + JSON.stringify(thumbs))
    check(
      `429-E 编辑态缩略图 ≥ ${THUMB_MIN_W}×${THUMB_MIN_H}（修复前 80×56）`,
      thumbs.exists && thumbs.w >= THUMB_MIN_W && thumbs.h >= THUMB_MIN_H,
      thumbs.exists ? `${thumbs.w}×${thumbs.h} ×${thumbs.count}` : 'episode-edit-images 不存在',
    )

    // ---- RF2：把一张缩略图压回 80×56 ⇒ 429-E 必须 FAIL ----
    // 此刻已在编辑态，直接改样式即可。
    if (thumbs.exists) {
      const rf2 = await page.evaluate(() => {
        const img = document.querySelector('[data-testid="episode-edit-images"] img')
        if (!img) return { ok: false }
        img.setAttribute('data-rf2-saved', img.getAttribute('style') || '')
        img.style.width = '80px'
        img.style.height = '56px'
        return { ok: true }
      })
      if (rf2.ok) {
        const small = await page.evaluate(readThumbs)
        check(
          'RF2 缩略图压回 80×56 ⇒ 429-E 必须 FAIL',
          small.exists && (small.w < THUMB_MIN_W || small.h < THUMB_MIN_H),
          small.exists ? `${small.w}×${small.h}` : 'n/a',
        )
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('[data-rf2-saved]')) {
            el.setAttribute('style', el.getAttribute('data-rf2-saved') || '')
            el.removeAttribute('data-rf2-saved')
          }
        })
        const back2 = await page.evaluate(readThumbs)
        check(
          'RF2b 还原缩略图 ⇒ 429-E 复绿',
          back2.exists && back2.w >= THUMB_MIN_W && back2.h >= THUMB_MIN_H,
          back2.exists ? `${back2.w}×${back2.h}` : 'n/a',
        )
      } else {
        check('RF2 缩略图压回 80×56 ⇒ 429-E 必须 FAIL', false, '找不到缩略图')
      }
    }

    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon\.ico/i.test(String(e)),
    )
    check('429-F 无页面 / console 错误', errs.length === 0, `errors=${JSON.stringify(errs.slice(0, 3))}`)
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
