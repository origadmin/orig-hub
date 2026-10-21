#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 BUG-374 验证：下载域两个详情 Sheet 的**外壳一致性**（用户第四次提出
 * 「标题不在第一行」，并问「为什么有的有蓝色顶框,有的没有」）。
 *
 * 判据（**只覆盖用户报的两件事**，不擅自扩大）：
 *   A1 顶框一致：两个 Sheet **都没有**顶部强调线（用户直言其丑陋 ⇒ 统一取向
 *      「都没有」，不是给另一边加上；也不碰其他样式）；
 *   A2 标题第一行：表头第一个元素就是标题，且 panel 内没有任何文字元素整体排在
 *      标题**上方**占了一行（抓手单独占一行 / 内嵌在标题前 两种旧形态都要能判红）。
 *
 * 反向证伪（判据的牙齿）：在运行态注入**两种旧形态**（①顶框 ②抓手单独占一行
 * ③抓手内嵌在标题前 + 假拖拽提示），同一批断言必须**全部转红**；随后还原并自证
 * `sha256(outerHTML)` before == after。
 *
 * 定位方式：按**标题文本**找 `.rounded-t-2xl` 面板，不依赖任何为测试新增的 testid
 * —— 产品侧零改动即可验证（不为了好测而改产品）。
 */

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面内测量函数。**不得引用 Node 侧任何标识符**（`page.evaluate(fn)` 会丢作用域）。 */
const MEASURE_FN = `function measure(needle) {
  const panels = [...document.querySelectorAll('.rounded-t-2xl')]
  let panel = null
  for (const p of panels) {
    const t = p.querySelector('p.truncate')
    if (t && (t.textContent || '').indexOf(needle) >= 0) { panel = p; break }
  }
  if (!panel) return { found: false }
  const titleP = panel.querySelector('p.truncate')
  const header = titleP.parentElement
  const titleRect = titleP.getBoundingClientRect()
  const kids = [...header.children]
  // 「顶框」= panel 里排在标题上方的**纯装饰横条**（高 ≤8px、无文字、通栏）
  let accentBars = 0
  for (const k of panel.children) {
    if (k === header) continue
    const r = k.getBoundingClientRect()
    const hasText = (k.textContent || '').trim().length > 0
    if (!hasText && r.height > 0 && r.height <= 8 && r.width >= panel.clientWidth - 2) accentBars += 1
  }
  let leftMin = null
  for (const k of kids) {
    const r = k.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (leftMin === null || r.left < leftMin) leftMin = r.left
  }
  /*
   * 「标题在第一行」的真语义：没有任何文字元素整体排在标题**上方**占了一行。
   * 不能用「title.top 是 header 里最小」—— header 是 items-center，更高的关闭按钮
   * top 天然更小但与标题是同一行，那样判会把正常形态误判成「标题被挤下去」。
   */
  let pushedByHeader = null
  for (const k of kids) {
    if (k === titleP) continue
    const r = k.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    if (r.bottom <= titleRect.top + 1) { pushedByHeader = k.tagName; break }
  }
  let pushedByPanel = null
  const walk = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT)
  let n = walk.nextNode()
  while (n) {
    const r = n.getBoundingClientRect()
    const hasText = (n.textContent || '').trim().length > 0
    if (hasText && r.width > 0 && r.height > 0 && r.bottom <= titleRect.top + 1) {
      pushedByPanel = n.tagName + ':' + (n.textContent || '').trim().slice(0, 12)
      break
    }
    n = walk.nextNode()
  }
  return {
    found: true,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    titleText: (titleP.textContent || '').slice(0, 40),
    accentBars,
    titleIsFirstInHeader: header.firstElementChild === titleP,
    titleLeftIsMin: Math.abs(titleRect.left - leftMin) < 1,
    pushedByHeader,
    pushedByPanel,
    hasGripChar: (panel.textContent || '').indexOf('\\u2840') >= 0,
    hasDragTitle: !!panel.querySelector('[title="\\u62d6\\u62fd"]'),
  }
}`

/** 反向证伪：注入三种旧形态（顶框 / 抓手独占一行 / 抓手内嵌标题前 + 假拖拽提示）。 */
const INJECT_LEGACY_FN = `function injectLegacy(needle) {
  const panels = [...document.querySelectorAll('.rounded-t-2xl')]
  let panel = null
  for (const p of panels) {
    const t = p.querySelector('p.truncate')
    if (t && (t.textContent || '').indexOf(needle) >= 0) { panel = p; break }
  }
  if (!panel) return false
  const titleP = panel.querySelector('p.truncate')
  const header = titleP.parentElement
  // ① 顶框（旧引擎侧的网卡渐变强调线）
  const bar = document.createElement('div')
  bar.style.height = '4px'
  bar.style.width = '100%'
  bar.style.background = 'linear-gradient(90deg, #3b82f6, #8b5cf6)'
  bar.setAttribute('data-bug374-legacy', '1')
  panel.insertBefore(bar, panel.firstChild)
  // ② 抓手**单独占一行**（旧入库侧）⇒ 整体在标题上方
  const row = document.createElement('div')
  row.className = 'flex items-center gap-2 px-4 pt-3'
  row.setAttribute('data-bug374-legacy', '1')
  const g1 = document.createElement('span')
  g1.textContent = '\\u2840'
  row.appendChild(g1)
  panel.insertBefore(row, header)
  // ③ 抓手**内嵌在标题前** + 说了做不到的 title="拖拽"（旧引擎侧）
  const g2 = document.createElement('span')
  g2.textContent = '\\u2840'
  g2.setAttribute('title', '\\u62d6\\u62fd')
  g2.setAttribute('data-bug374-legacy', '1')
  header.insertBefore(g2, header.firstChild)
  return true
}`

async function measure(page, needle) {
  return page.evaluate(
    new Function('needle', `${MEASURE_FN}; return measure(needle)`),
    needle,
  )
}

async function injectLegacy(page, needle) {
  return page.evaluate(
    new Function('needle', `${INJECT_LEGACY_FN}; return injectLegacy(needle)`),
    needle,
  )
}

/** 判据：只覆盖用户报的两件事（顶框一致 / 标题第一行）。 */
function judge(m) {
  if (!m.found) return { ok: false, fails: ['sheet-not-found'] }
  const fails = []
  if (m.accentBars !== 0) fails.push(`A1-accent-bars-${m.accentBars}`)
  if (!m.titleIsFirstInHeader) fails.push('A2-title-not-first-in-header')
  if (m.pushedByHeader) fails.push(`A2-title-pushed-by-header:${m.pushedByHeader}`)
  if (m.pushedByPanel) fails.push(`A2-title-pushed-by-panel:${m.pushedByPanel}`)
  if (!m.titleLeftIsMin) fails.push('A2-title-not-leftmost')
  if (m.hasGripChar) fails.push('A2-grip-char-present')
  if (m.hasDragTitle) fails.push('A2-fake-drag-title')
  return { ok: fails.length === 0, fails }
}

async function main() {
  const browser = await cdp.launch()
  let pass = true
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await delay(2500)

    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    console.log(`视口: ${vp.w}x${vp.h}（判据前提，显式断言）`)
    if (vp.w !== 1440) {
      console.log(`FAIL: 视口宽 ${vp.w} !== 1440 —— 判据按 1440 定，环境没变则结论不可信`)
      process.exit(1)
    }

    // ---------- Phase 1：引擎下载详情 Sheet ----------
    console.log('\n=== Phase 1: DownloadDetailSheet（引擎下载详情） ===')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="download-item"]').length > 0,
      { timeout: 30000 },
    )
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="download-item"]')]
      const hit = rows.find((r) => (r.textContent || '').includes('bug322ui'))
      if (hit) hit.click()
    })
    await delay(1500)

    let m1 = await measure(page, 'bug322ui')
    console.log(JSON.stringify(m1, null, 1))
    let j1 = judge(m1)
    console.log(`引擎 Sheet: ${j1.ok ? '合规' : '不合规'}${j1.ok ? '' : '  fails=' + j1.fails.join(',')}`)
    if (!j1.ok) pass = false

    // 反向证伪
    const before = await page.evaluate(() => document.documentElement.outerHTML)
    const shaBefore = crypto.createHash('sha256').update(before).digest('hex')
    const injected = await injectLegacy(page, 'bug322ui')
    await delay(300)
    const mLegacy = await measure(page, 'bug322ui')
    const jLegacy = judge(mLegacy)
    console.log(`反向证伪（注入三种旧形态）: ${jLegacy.ok ? '仍然合规(假绿!)' : '已转红'}  fails=${jLegacy.fails.join(',')}`)
    if (!injected) { console.log('FAIL: 注入失败'); pass = false }
    if (jLegacy.ok) { console.log('FAIL: 判据没有牙齿'); pass = false }

    // 还原 + 自证
    await page.evaluate(() => {
      for (const n of document.querySelectorAll('[data-bug374-legacy]')) n.remove()
    })
    await delay(300)
    const after = await page.evaluate(() => document.documentElement.outerHTML)
    const shaAfter = crypto.createHash('sha256').update(after).digest('hex')
    const restored = shaBefore === shaAfter
    console.log(`还原自证 sha256 before==after: ${restored}`)
    if (!restored) { console.log('FAIL: 未还原到原状'); pass = false }
    const m1b = await measure(page, 'bug322ui')
    const j1b = judge(m1b)
    console.log(`还原后引擎 Sheet: ${j1b.ok ? '合规' : '不合规'}${j1b.ok ? '' : '  fails=' + j1b.fails.join(',')}`)
    if (!j1b.ok) pass = false

    await page.screenshot(path.join(__dirname, '..', 'verify_shots', 'dl_detail_sheet_spec.png'))
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await delay(600)

    // ---------- Phase 2：入库明细 Sheet ----------
    console.log('\n=== Phase 2: IngestDetailSheet（入库明细） ===')
    let opened2 = false
    for (let i = 0; i < 40 && !opened2; i += 1) {
      const found = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="ingest-group-row"]')]
        const hit = rows.find((r) => (r.textContent || '').includes('母子同欢'))
        if (!hit) return false
        const h = hit.querySelector('[data-testid="ingest-group-header"]')
        if (h) h.click()
        return true
      })
      if (found) { opened2 = true; break }
      await page.conn.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 450, y: 400, deltaX: 0, deltaY: 800 },
        { sessionId: page.sessionId },
      )
      await delay(700)
    }
    if (!opened2) {
      // orig-tg down（BUG-373 重启风暴）⇒ ingest 组为空。**如实报红，不吞失败**。
      console.log('FAIL: 40 次滚动内没找到「母子同欢」组行 —— orig-tg 不可用（BUG-373 风暴期）')
      console.log('      入库 Sheet 未验证，不是通过。待 orig-tg 恢复后重跑本脚本。')
      pass = false
    } else {
      await delay(1800)
      const m2 = await measure(page, '母子同欢')
      console.log(JSON.stringify(m2, null, 1))
      const j2 = judge(m2)
      console.log(`入库 Sheet: ${j2.ok ? '合规' : '不合规'}${j2.ok ? '' : '  fails=' + j2.fails.join(',')}`)
      if (!j2.ok) pass = false
      await page.screenshot(path.join(__dirname, '..', 'verify_shots', 'ingest_detail_sheet_spec.png'))
    }

    console.log('\n' + (pass ? 'ALL PASS' : 'HAS FAIL'))
  } finally {
    await browser.close()
  }
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
