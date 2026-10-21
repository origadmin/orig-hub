'use strict'
/**
 * TG 域版式/逻辑诊断（BUG-359 / BUG-360 现场取证）。
 *
 * 用户 2026-10-21 复报：
 *   ①「样式混乱：NanaZip_7.0.1843.0_Binaries.zip 在第一行，TG弹窗标题在第二行」
 *   ②「TG筛选下载逻辑混乱：详情内容无法选择，但是有黑框，不清楚用途；展示的内容也是混乱的」
 *
 * 本脚本只做**取证**（不改产品）：真实渲染 + 几何量测 + testid 普查 + 截图，
 * 把「样式混乱/逻辑混乱」变成可复算的数字（谁压谁、谁盖谁、哪些元素不可交互）。
 *
 * 用法：node tauri-shell/verify/_diag_tg_layout.cjs
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tg-layout')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function realClick(page, selector) {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, hitOk: !!hit && (el === hit || el.contains(hit)) }
  }, selector)
  if (!pt) throw new Error(`realClick: 找不到或不可见 ${selector}`)
  if (!pt.hitOk) throw new Error(`realClick: ${selector} 的点击点被其它元素占据`)
  const conn = page.conn || page._conn
  const sessionId = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send(
      'Input.dispatchMouseEvent',
      { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 },
      { sessionId },
    )
  }
  await sleep(120)
}

/** 元素几何 + 文本摘要（含 data-testid）。 */
async function geom(page) {
  return page.evaluate(() => {
    const out = []
    const all = document.querySelectorAll('*')
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!txt) continue
      out.push({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid') || null,
        cls: (el.getAttribute('class') || '').slice(0, 90),
        txt: txt.slice(0, 60),
        rect: {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
        },
        z: cs.zIndex === 'auto' ? null : cs.zIndex,
        pos: cs.position,
        overflowY: cs.overflowY,
        pointerEvents: cs.pointerEvents,
        fontSize: cs.fontSize,
      })
    }
    return out
  })
}

/** 两个矩形的交集面积。 */
function inter(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2500)

    // 1) 文件域（NanaZip 所在处）
    await realClick(page, '[data-testid="nav-files"]')
    await sleep(1200)
    await page.screenshot(path.join(OUT, '01-files.png'))
    const filesGeom = await geom(page)

    // 2) TG 域
    await realClick(page, '[data-testid="nav-tg"]')
    await sleep(2500)
    await page.screenshot(path.join(OUT, '02-tg.png'))
    const tgGeom = await geom(page)

    // 3) 展开频道节，把列表面进来
    try {
      await realClick(page, '[data-testid="channel-collapse-toggle"]')
      await sleep(1500)
    } catch (e) {
      console.log(`(info) 频道节展开失败：${e.message}`)
    }
    await page.screenshot(path.join(OUT, '03-tg-channels.png'))
    const tgGeom2 = await geom(page)

    // 4) 打开筛选/监控（TG 侧筛选下载入口）—— 只点已存在的入口
    const filterEntry = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('[data-testid], button, [role="tab"]'))
        .filter((el) => /筛选|监控|filter|monitor/i.test(el.textContent || ''))
      return cands.slice(0, 6).map((el) => ({
        testid: el.getAttribute('data-testid') || null,
        tag: el.tagName.toLowerCase(),
        txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      }))
    })
    console.log('筛选入口候选：', JSON.stringify(filterEntry, null, 1))

    // ---- 报告 ----
    console.log('\n===== 取证：NanaZip / TG 弹窗标题 几何 =====')
    const find = (list, re) =>
      list.filter((g) => re.test(g.txt) || (g.testid && re.test(g.testid)))
    for (const g of find(filesGeom, /NanaZip/i)) {
      console.log(`[files] ${g.testid || g.tag} "${g.txt}" rect=${JSON.stringify(g.rect)}`)
    }
    for (const g of find(tgGeom, /TG|Telegram/i).slice(0, 8)) {
      console.log(`[tg] ${g.testid || g.tag} "${g.txt}" rect=${JSON.stringify(g.rect)} pos=${g.pos} z=${g.z}`)
    }

    // 跨视图重叠检测：同一个屏幕内，两列内容的纵向顺序（用户报「第一行/第二行」）
    console.log('\n===== 取证：TG 视图内文本节点（前 25 个，按 y 排序） =====')
    tgGeom2
      .sort((a, b) => a.rect.y - b.rect.y)
      .slice(0, 25)
      .forEach((g) =>
        console.log(
          `y=${g.rect.y} x=${g.rect.x} ${g.w}x${g.h} ${g.testid ? `[${g.testid}] ` : ''}"${g.txt}"`,
        ),
      )

    // 不可交互的可见块（用户报「详情内容无法选择，但是有黑框」）
    console.log('\n===== 取证：不可交互/异常块（pointer-events 或命中测试失败） =====')
    const blocked = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('div,section,article,li,button')) {
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const cx = Math.round(r.x + r.width / 2)
        const cy = Math.round(r.y + r.height / 2)
        const hit = document.elementFromPoint(cx, cy)
        const covered = !!hit && hit !== el && !el.contains(hit)
        const looksClickable = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
        if (covered || cs.pointerEvents === 'none') {
          out.push({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid') || null,
            cls: (el.getAttribute('class') || '').slice(0, 80),
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            coveredBy: hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-testid') ? '[' + hit.getAttribute('data-testid') + ']' : ''}` : null,
            pointerEvents: cs.pointerEvents,
            looksClickable,
          })
        }
      }
      return out.slice(0, 40)
    })
    blocked.forEach((b) =>
      console.log(
        `${b.testid ? `[${b.testid}] ` : ''}${b.tag} "${b.txt}" rect=${JSON.stringify(b.rect)}` +
          ` 被=${b.coveredBy} pe=${b.pointerEvents} 可点=${b.looksClickable}`,
      ),
    )

    console.log(`\n产物：${OUT}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
