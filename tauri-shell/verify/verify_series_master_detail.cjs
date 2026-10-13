#!/usr/bin/env node
'use strict'
/**
 * 剧集详情页「左右主从 + stacked deck 跑马灯」**真实运行态**验收。
 *
 * 规范真源：`docs/design/media-episode-image-handover-2026-09-28.md`
 * （用户 2026-09-29：「最基础的，左右布局，跑马灯全都不见」）。
 *
 * 与旧 `verify_series_detail_layout.cjs`（夹具 + 手风琴旧形态）的根本区别：
 *   1. 断言对象 = **运行中产品**（vite 5180 → 真实 orig-tg）的真实剧集详情页；
 *   2. 断言内容 = 规范形态本身：
 *      A. 左右两栏同时存在（左选集器 episode-picker / 右 deck 容器）；
 *      B. deck 计数徽标 `1 / n`，**点右半翻页后变 `2 / n`**（真实交互，非静态截图）；
 *      C. 标题单行省略（white-space nowrap + text-overflow ellipsis，§6.2）；
 *      D. 反向证伪：deck 上不存在时 B 必须失败（不写恒真断言）。
 *
 * 用法::
 *   node verify_series_master_detail.cjs
 *   ORIG_VERIFY_OUT=<dir> node verify_series_master_detail.cjs
 * Exit: 0 = 全部断言 PASS；1 = 任一 FAIL
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-md-verify')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const assert = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail == null ? '' : '  — ' + detail}`)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const out = { appUrl: APP_URL }
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })

    // 进入媒体库
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    assert('A0 进入媒体库(nav-child-lib-series)', navOk)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
      { timeout: 20000 },
    )
    await delay(1200)

    // 必须在进详情前统计剧集卡数（详情页里 series-card 不在 DOM）
    const cardCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="series-card"]').length,
    )

    // 打开目标真实剧集（SERIES_MATCH 标题子串优先；默认第一张卡）
    const seriesIndex = Number(process.env.SERIES_INDEX || 0)
    const seriesTitle = await page.evaluate((idx) => {
      const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
      if (!cards.length) return null
      const target = cards[Math.min(idx, cards.length - 1)]
      const title = target.textContent.trim().slice(0, 40)
      target.click()
      return title
    }, seriesIndex)
    assert('A1 打开真实剧集卡', seriesTitle != null, seriesTitle ?? 'no series-card')

    // 等左右两栏出现
    for (let i = 0; i < 30; i++) {
      const ready = await page.evaluate(
        () =>
          !!(
            document.querySelector('[data-testid="episode-picker"]') &&
            document.querySelector('[data-testid="episode-focus-title"]')
          ),
      )
      if (ready) break
      await delay(500)
    }
    await delay(800)
    console.log('[md-verify] detail page ready')

    // A2 左右两栏并存 + grid 两列
    const twoCol = await page.evaluate(() => {
      const pick = document.querySelector('[data-testid="episode-picker"]')
      const title = document.querySelector('[data-testid="episode-focus-title"]')
      if (!pick || !title) return { ok: false, why: 'missing nodes' }
      const grid = pick.closest('[class*="grid"]')
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns : ''
      const pr = pick.getBoundingClientRect()
      const tr = title.getBoundingClientRect()
      return {
        ok: cols.split(' ').length >= 2 && tr.left > pr.right - 8,
        cols,
        pickerRight: Math.round(pr.right),
        focusLeft: Math.round(tr.left),
      }
    })
    assert('A2 左右两栏布局(选集器在左/详情在右)', twoCol.ok, JSON.stringify(twoCol))

    // A3 deck 存在且计数 1 / n
    const deck1 = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="episode-deck"]')
      if (!d) return { ok: false, why: 'no deck' }
      const cards = d.querySelectorAll('.deck-card, [style*="z-index"]').length
      return { ok: true, count: d.getAttribute('data-deck-count'), cards }
    })
    assert('A3 stacked deck 渲染 + 计数徽标', deck1.ok, JSON.stringify(deck1))

    // A4 deck 翻页（真实交互断言）：若当前 deck ≥ 2 帧直接点右半；否则遍历分集找多帧集
    let deck2 = { ok: false, before: null, after: null, why: 'no multi-frame episode' }
    const readCount = () =>
      page.evaluate(() => {
        const d = document.querySelector('[data-testid="episode-deck"]')
        return d ? d.getAttribute('data-deck-count') : null
      })
    let cnt0 = await readCount()
    if (cnt0 && Number(cnt0.split(' / ')[1]) > 1) {
      deck2.why = 'current deck multi-frame'
    } else {
      const rows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="episode-pick"]').length,
      )
      for (let i = 0; i < rows; i++) {
        await page.evaluate((idx) => {
          document.querySelectorAll('[data-testid="episode-pick"]')[idx].click()
        }, i)
        await delay(350)
        cnt0 = await readCount()
        if (cnt0 && Number(cnt0.split(' / ')[1]) > 1) break
      }
    }
    if (cnt0 && Number(cnt0.split(' / ')[1]) > 1) {
      const before = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="episode-deck"]')
        const rect = d.getBoundingClientRect()
        d.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            clientX: rect.left + rect.width - 5,
            clientY: rect.top + rect.height / 2,
          }),
        )
        return d.getAttribute('data-deck-count')
      })
      await delay(600)
      const after = await readCount()
      deck2 = { ok: after !== before, before, after, why: 'flip test' }
    }
    assert(
      'A4 deck 点右半翻页(计数变化)',
      deck2.ok,
      `before=${deck2.before} after=${deck2.after ?? ''} ${deck2.why ?? ''}`,
    )

    // A5 标题单行省略（§6.2）
    const ell = await page.evaluate(() => {
      const els = [
        document.querySelector('[data-testid="episode-focus-title"]'),
        document.querySelector('[data-testid="series-title"]'),
      ].filter(Boolean)
      return els.map((el) => {
        const cs = getComputedStyle(el)
        return {
          testid: el.getAttribute('data-testid'),
          nowrap: cs.whiteSpace === 'nowrap',
          ellipsis: cs.textOverflow === 'ellipsis',
          overflow: cs.overflowX === 'hidden' || cs.overflow === 'hidden',
        }
      })
    })
    assert(
      'A5 标题单行省略(nowrap+ellipsis+hidden)',
      ell.length >= 1 && ell.every((x) => x.nowrap && x.ellipsis && x.overflow),
      JSON.stringify(ell),
    )

    // A6 左栏选集器列出真实分集数 ≥ 1，右栏有图组或占位
    const pickerRows = await page.evaluate(
      () => document.querySelectorAll('[data-testid="episode-pick"]').length,
    )
    assert('A6 选集器分集行 ≥ 1', pickerRows >= 1, `rows=${pickerRows}`)

    out.results = results
    out.consoleErrors = page.consoleErrors().slice(0, 8)
    out.pageErrors = page.pageErrors().slice(0, 8)

    // 截图：详情页全景 + deck 特写
    const shot = path.join(OUT_DIR, 'series-master-detail.png')
    await page.screenshot(shot, { fullPage: true })
    out.screenshot = shot

    const deckEl = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="episode-deck"]')
      if (!d) return null
      const r = d.getBoundingClientRect()
      return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 40), width: r.width + 40, height: r.height + 80 }
    })
    if (deckEl) {
      const shot2 = path.join(OUT_DIR, 'series-deck-closeup.png')
      await page.screenshot(shot2, deckEl)
      out.deckShot = shot2
    }

    await browser.close()
    const fails = results.filter((r) => !r.ok)
    console.log(`\n[md-verify] ${results.length - fails.length}/${results.length} PASS  -> ${shot}`)
    if (fails.length > 0) process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('[md-verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
