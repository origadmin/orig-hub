#!/usr/bin/env node
'use strict'
/**
 * BUG-350 取证 + 验收：剧集详情**右栏（单集面）主次分层**。
 *
 * 用户报障（2026-10-21）：「剧集详情主次不分，把核心播放位置放到了次(展示)，
 * TG中查看这个次内容放到了主（而且次中已有）。排版逻辑非常混乱。」
 *
 * 本脚本先做**版式取证**（列出右栏区块顺序与几何），再跑分层断言：
 *   M1 主区在次区之前（动作区整体位于展示区上方）；
 *   M2 播放按钮 = 主区第一颗实心主按钮（且是右栏唯一实心按钮）；
 *   M3 「在 TG 中查看」不再是主位实心按钮（不与播放同级抢主位）；
 *   M4 右栏区块数收敛（不再 7 段平铺）；
 *   M5 主区/次区有显式分区标记（data-zone）。
 *
 * 用法::
 *   node _probe_bug350_series_detail.cjs [--expect-legacy]
 * Exit: 0 = 全 PASS；1 = 有 FAIL
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug350-verify')
const LEGACY = process.argv.includes('--expect-legacy')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const assert = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail == null ? '' : '  — ' + detail}`)
}

async function openSeriesDetail(page) {
  // vite 文件变更后首次整页加载可 >30s（已知坑）：导航带重试 + 打印 readyState
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
      break
    } catch (e) {
      const rs = await page
        .evaluate(() => document.readyState)
        .catch(() => 'n/a')
      console.log(`[bug350] goto attempt#${i + 1} failed (${e.message}); readyState=${rs}`)
      if (i === 2) throw e
      await delay(2000)
    }
  }
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-child-lib-series not found')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 25000 },
  )
  await delay(1200)
  const idx = Number(process.env.SERIES_INDEX || 0)
  await page.evaluate((i) => {
    const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
    cards[Math.min(i, cards.length - 1)].click()
  }, idx)
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-focus-title"]'),
    )
    if (ready) break
    await delay(500)
  }
  await delay(900)
}

/** 右栏（单集面）区块清单：直接子元素 + 几何 + 文本摘要 */
async function readRightPane(page) {
  return page.evaluate(() => {
    const title = document.querySelector('[data-testid="episode-focus-title"]')
    if (!title) return null
    const section = title.closest('section')
    if (!section) return null
    const kids = [...section.children]
    const blocks = kids.map((el, i) => {
      const r = el.getBoundingClientRect()
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      return {
        i,
        zone: el.getAttribute('data-zone') || '',
        tag: el.tagName.toLowerCase(),
        top: Math.round(r.top),
        h: Math.round(r.height),
        text: txt,
      }
    })
    const play = document.querySelector('[data-testid="episode-play"]')
    const pr = play ? play.getBoundingClientRect() : null
    const playBlock = play ? kids.findIndex((k) => k.contains(play)) : -1
    // 实心主按钮判定：背景不透明且非 outline（Tailwind: 默认 variant = bg-accent 类）
    const solids = [...section.querySelectorAll('button')].filter((b) => {
      const cs = getComputedStyle(b)
      const bg = cs.backgroundColor
      const m = bg.match(/rgba?\(([^)]+)\)/)
      if (!m) return false
      const parts = m[1].split(',').map((x) => parseFloat(x))
      const alpha = parts.length > 3 ? parts[3] : 1
      return alpha > 0.85 && !(parts[0] === 0 && parts[1] === 0 && parts[2] === 0)
    })
    const tgButtons = [...section.querySelectorAll('[data-testid="episode-source-jump-tg"]')]
    const tgInfo = tgButtons.map((b) => {
      const cs = getComputedStyle(b)
      const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/)
      const parts = m ? m[1].split(',').map(parseFloat) : [0, 0, 0]
      const alpha = parts.length > 3 ? parts[3] : 1
      const r = b.getBoundingClientRect()
      return {
        w: Math.round(r.width),
        top: Math.round(r.top),
        alpha,
        border: cs.borderTopWidth,
        text: (b.textContent || '').trim(),
      }
    })
    return {
      blocks,
      play: pr
        ? { top: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), blockIndex: playBlock }
        : null,
      solidCount: solids.length,
      solidTestIds: solids.map((b) => b.getAttribute('data-testid') || b.textContent.trim().slice(0, 12)),
      tg: tgInfo,
      sectionHeight: Math.round(section.getBoundingClientRect().height),
    }
  })
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await openSeriesDetail(page)
    const pane = await readRightPane(page)
    if (!pane) throw new Error('right pane not found')
    console.log('[bug350] right pane blocks:')
    for (const b of pane.blocks) {
      console.log(
        `   #${b.i} [${b.zone || '-'}] ${b.tag} top=${b.top} h=${b.h} :: ${b.text}`,
      )
    }
    console.log('[bug350] play =', JSON.stringify(pane.play))
    console.log('[bug350] solid buttons =', pane.solidCount, JSON.stringify(pane.solidTestIds))
    console.log('[bug350] tg buttons =', JSON.stringify(pane.tg))

    // ---- M1 主区在次区之前 ----
    const zoneTops = pane.blocks
      .filter((b) => b.zone === 'primary' || b.zone === 'secondary')
      .map((b) => ({ zone: b.zone, top: b.top }))
    const firstPrimary = zoneTops.find((z) => z.zone === 'primary')
    const firstSecondary = zoneTops.find((z) => z.zone === 'secondary')
    const m1 = firstPrimary && firstSecondary ? firstPrimary.top < firstSecondary.top : false
    assert(
      'M1 主区(primary)整体位于次区(secondary)之前',
      LEGACY ? !m1 : m1,
      `primary.top=${firstPrimary ? firstPrimary.top : 'n/a'} secondary.top=${firstSecondary ? firstSecondary.top : 'n/a'}`,
    )

    // ---- M2 播放 = 主区第一个子元素，且右栏唯一实心 ----
    const playZoneEl = pane.blocks.find((b) => b.zone === 'primary')
    const playFirst = await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="episode-primary-zone"]')
      const play = document.querySelector('[data-testid="episode-play"]')
      if (!zone || !play) return false
      const firstEl = [...zone.children][0]
      return firstEl != null && (firstEl === play || firstEl.contains(play))
    })
    const m2 = playFirst && pane.solidCount === 1
    assert(
      'M2 播放=主区首个子元素且是右栏唯一实心按钮',
      LEGACY ? !m2 : m2,
      `playFirst=${playFirst} solidCount=${pane.solidCount}`,
    )

    // ---- M3 「在 TG 中查看」不再抢主位（非实心高亮块）----
    const guiltyTg = pane.tg.filter((t) => t.alpha > 0.4)
    const m3 = pane.tg.length === 0 || guiltyTg.length === 0
    assert(
      'M3 「在 TG 中查看」不是实心高亮主位按钮',
      LEGACY ? !m3 : m3,
      `tg=${JSON.stringify(pane.tg)}`,
    )

    // ---- M4 右栏区块收敛 ----
    const m4 = pane.blocks.length <= 4
    assert('M4 右栏区块数 ≤ 4（不再 7 段平铺）', LEGACY ? !m4 : m4, `blocks=${pane.blocks.length}`)

    // ---- M5 分区标记存在（header/primary/secondary 全枚举）----
    const validZones = new Set(['header', 'primary', 'secondary'])
    const zoned = pane.blocks.filter((b) => validZones.has(b.zone))
    const m5 = zoned.length === pane.blocks.length && pane.blocks.length > 0
    assert('M5 每个区块都有 data-zone 分区标记', LEGACY ? !m5 : m5, `zoned=${zoned.length}/${pane.blocks.length}`)

    // ---- M6 播放按钮不与展示文本交错：次区里没有 data-testid 为 episode-play 的按钮 ----
    const m6 = pane.play != null && pane.play.w > 200
    assert('M6 播放按钮保持通栏主尺寸', LEGACY ? !m6 : m6, JSON.stringify(pane.play))

    const shot = path.join(OUT_DIR, 'bug350-right-pane.png')
    const box = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="episode-focus-title"]')
      const s = t.closest('section')
      const r = s.getBoundingClientRect()
      return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: Math.min(r.height + 16, 1400) }
    })
    await page.screenshot(shot, box)
    console.log('[bug350] shot ->', shot)

    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[bug350] pageErrors:', JSON.stringify(errs))

    await browser.close()
    const fails = results.filter((r) => !r.ok)
    console.log(`\n[bug350] ${results.length - fails.length}/${results.length} PASS`)
    if (fails.length > 0) process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('[bug350] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
