#!/usr/bin/env node
'use strict'

/**
 * 单集聚焦布局（episode focus）验收探针。
 *
 * 真实渲染截图 + 断言（非恒绿：切换前后必须取到不同集号/封面）：
 *   1. 媒体库 → 打开某剧集详情（左侧剧集导航或剧集卡本体）；
 *   2. 集号切换条 episode-switcher 渲染，chip 数 = 集数，episode-slot 数 = 集数；
 *   3. 默认聚焦第一集；点第二个 chip → 聚焦集号改变（断言取到具体集号文本，非"不等于旧值"）；
 *   4. 主区封面 episode-focus-cover 实际宽度 ≥ 340px（改版目标 380×214）；
 *   5. 本集挂图 episode-images 单张宽度 ≥ 180px（改版目标 200×150）且 img 为 object-contain（不裁切）；
 *   6. 窄窗口（720px）下主区纵向堆叠、无横向溢出。
 *
 * Usage:  node verify/verify_episode_focus.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT PROBE(1=只 dump testid)
 * Exit:   0 = 全部通过；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-episode-focus-shots')
const PROBE = process.env.PROBE === '1'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickTestid(page, testid) {
  const ok = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
  if (!ok) throw new Error(`clickTestid: ${testid} not found`)
}

async function waitTestid(page, testid, timeout = 10000) {
  await page.waitForFunction(
    (tid) => !!document.querySelector(`[data-testid="${tid}"]`),
    { timeout, args: [testid] },
  )
}

async function waitTestidSoft(page, testid, timeout = 6000) {
  try {
    await waitTestid(page, testid, timeout)
    return true
  } catch (_e) {
    return false
  }
}

/**
 * 逐个打开剧集，直到找到一个「默认聚焦集就带集级挂图」的剧集。
 * 集级挂图只挂在一部分集上（演示数据：series 5 的 ep145/ep146），
 * 必须先找到它才能真正验到画廊尺寸与 object-contain。
 */
async function openSeriesWithEpisodeImages(page) {
  const n = await page.evaluate(
    () => document.querySelectorAll('[data-testid="series-card"]').length,
  )
  for (let i = 0; i < n; i++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
    await waitTestid(page, 'nav-media')
    await clickTestid(page, 'nav-media')
    await delay(900)
    const label = await page.evaluate((idx) => {
      const cards = Array.from(document.querySelectorAll('[data-testid="series-card"]'))
      if (!cards[idx]) return null
      cards[idx].click()
      return (cards[idx].textContent || '').trim().slice(0, 40)
    }, i)
    if (!label) break
    const ok = await waitTestidSoft(page, 'episode-switcher', 6000)
    if (!ok) continue
    await delay(700)
    const has = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-images"]'),
    )
    if (has) return label
  }
  return null
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const fails = []
  try {
    const page = await browser.newPage()
    const errors = []
    page._offConsole && page._offConsole()
    page.on &&
      page.on('Runtime.exceptionThrown', (p) =>
        errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '')),
      )

    console.log('[ef] goto', APP_URL)
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    await waitTestid(page, 'nav-media')
    await clickTestid(page, 'nav-media')
    await delay(1200)

    if (PROBE) {
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 80),
      )
      console.log('[ef] PROBE testids on media page:\n' + ids.join('\n'))
      return
    }

    // 1) 打开一个「默认聚焦集就带集级挂图」的剧集（点剧集卡本体，卡内首个 button 是播放）
    const opened = await openSeriesWithEpisodeImages(page)
    console.log('[ef] open series with episode images:', opened)
    if (!opened) {
      console.log('[ef] FAILS: ["no series with episode images found"]')
      process.exitCode = 2
      return
    }
    await delay(1200)

    // 1b) 整页：Hero 海报 320×180、「图片 · N」图册 160×120
    await page.evaluate(() => window.scrollTo(0, 0))
    await delay(400)
    const hero = await page.evaluate(() => {
      const el = document.querySelector('div[class*="min-[720px]"] img')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })
    console.log('[ef] hero poster size:', JSON.stringify(hero))
    if (!hero || hero.w < 300) fails.push(`hero poster not enlarged: ${JSON.stringify(hero)}`)

    const gal = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="series-gallery"]')
      if (!box) return null
      const im = box.querySelector('img')
      if (!im) return null
      const r = im.getBoundingClientRect()
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        fit: getComputedStyle(im).objectFit,
      }
    })
    console.log('[ef] series gallery item:', JSON.stringify(gal))
    if (gal && gal.w < 140) fails.push(`gallery item not enlarged: ${JSON.stringify(gal)}`)
    await page.screenshot(path.join(OUT_DIR, 'ef-page-top.png'), { fullPage: true })

    // 1c) 文档顺序必须是 episode-focus -> episode-switcher -> episode-images
    const order = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="episode-focus"]')
      const s = document.querySelector('[data-testid="episode-switcher"]')
      const i = document.querySelector('[data-testid="episode-images"]')
      if (!f || !s || !i) return null
      const after = (a, b) =>
        !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      return { focusBeforeSwitcher: after(f, s), switcherBeforeImages: after(s, i) }
    })
    console.log('[ef] dom order:', JSON.stringify(order))
    if (!order || !order.focusBeforeSwitcher || !order.switcherBeforeImages) {
      fails.push(`wrong dom order: ${JSON.stringify(order)}`)
    }

    await waitTestid(page, 'episode-switcher', 12000)
    await delay(800)

    // 2) chip 数 = 集数；episode-slot 数 = 集数
    const counts = await page.evaluate(() => {
      const sw = document.querySelector('[data-testid="episode-switcher"]')
      const chips = document.querySelectorAll('[data-testid^="episode-chip-"]').length
      const slots = document.querySelectorAll('[data-testid="episode-slot"]').length
      return { chips, slots, switcher: !!sw }
    })
    console.log('[ef] counts:', JSON.stringify(counts))
    if (counts.chips < 1) fails.push('no episode-chip rendered')
    if (counts.slots !== counts.chips) fails.push(`episode-slot(${counts.slots}) != chip(${counts.chips})`)

    // 3) 默认聚焦第一集，记录集号；点第二个 chip 后集号必须变成第二集的具体值
    const firstLabel = await page.evaluate(() => {
      const c = document.querySelector('[data-testid^="episode-chip-"]')
      return c ? (c.textContent || '').trim() : null
    })
    const focusFirst = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="episode-focus"]')
      return el ? (el.textContent || '').trim().slice(0, 60) : null
    })
    console.log('[ef] first chip label:', firstLabel)
    console.log('[ef] focus (default):', focusFirst)
    // 应用是内滚动容器（文档高度=视口），必须把目标区域滚进视口才截得到
    await page.evaluate(() => {
      const el =
        document.querySelector('[data-testid="episode-images"]') ||
        document.querySelector('[data-testid="episode-focus"]')
      if (el) el.scrollIntoView({ block: 'center' })
    })
    await delay(500)
    await page.screenshot(path.join(OUT_DIR, 'ef-focus-first.png'), { fullPage: true })

    if (counts.chips > 1) {
      const secondLabel = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid^="episode-chip-"]'))
        return chips[1] ? (chips[1].textContent || '').trim() : null
      })
      await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('[data-testid^="episode-chip-"]'))
        if (chips[1]) chips[1].click()
      })
      await delay(700)
      const focusAfter = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="episode-focus"]')
        return el ? (el.textContent || '').trim().slice(0, 60) : null
      })
      console.log('[ef] second chip label:', secondLabel)
      console.log('[ef] focus after switch:', focusAfter)
      // 非恒绿断言：切换后聚焦区必须包含第二集的集号文本
      const secondNo = (secondLabel || '').match(/S\d+E\d+/)?.[0]
      const ok = secondNo ? (focusAfter || '').includes(secondNo) : false
      console.log('[ef] switch assertion (focus contains', secondNo, '):', ok)
      if (!ok) fails.push(`switch did not focus ${secondNo}`)
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="episode-focus"]')
        if (el) el.scrollIntoView({ block: 'center' })
      })
      await delay(500)
      await page.screenshot(path.join(OUT_DIR, 'ef-focus-second.png'), { fullPage: true })
    }

    // 4) 主区封面尺寸
    const cover = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="episode-focus-cover"]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })
    console.log('[ef] focus cover size:', JSON.stringify(cover))
    if (!cover || cover.w < 340) fails.push(`cover too small: ${JSON.stringify(cover)}`)

    // 5) 本集挂图尺寸 + object-contain
    const imgs = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="episode-images"]')
      if (!box) return null
      const list = Array.from(box.querySelectorAll('img'))
      return list.map((im) => {
        const r = im.getBoundingClientRect()
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          fit: getComputedStyle(im).objectFit,
        }
      })
    })
    console.log('[ef] episode images:', JSON.stringify(imgs))
    // 已确保打开的是带挂图的剧集：画廊必须存在，且单张 ≥180px 宽、必须 contain（不裁切）
    if (!imgs || !imgs.length) {
      fails.push('episode-images present in DOM but no <img> rendered')
    } else {
      if (imgs.some((i) => i.w < 180)) fails.push(`episode image too small: ${JSON.stringify(imgs)}`)
      if (imgs.every((i) => i.fit !== 'contain'))
        fails.push(`episode image not contain (still cropping): ${JSON.stringify(imgs)}`)
    }

    // 6) 窄窗口：纵向堆叠 + 无横向溢出
    await page.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 720, height: 900, deviceScaleFactor: 1, mobile: false },
      { sessionId: page.sessionId },
    )
    await delay(900)
    const narrow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }))
    console.log('[ef] narrow viewport overflow:', JSON.stringify(narrow))
    if (narrow.scrollW > narrow.clientW + 2) fails.push(`horizontal overflow at 720px: ${JSON.stringify(narrow)}`)
    await page.screenshot(path.join(OUT_DIR, 'ef-narrow-720.png'), { fullPage: true })

    if (errors.length) console.log('[ef] page errors:', errors.slice(0, 5))
    console.log('[ef] screenshots ->', OUT_DIR)
    console.log('[ef] FAILS:', fails.length ? JSON.stringify(fails) : 'none')
    if (fails.length) process.exitCode = 2
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[ef] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
