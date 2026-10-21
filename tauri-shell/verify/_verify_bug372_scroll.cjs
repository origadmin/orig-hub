#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 BUG-372 滚动修复验证：「他为什么不滚」。
 *
 * 判据（全部必须 PASS，缺一即 FAIL）：
 *   V1 engine 行在滚动容器**内部**（修复前在 shrink-0 块里，容器外）；
 *   V2 真实 wheel 事件压在 **engine 行**上 → 整表 scrollTop 必须变化；
 *   V3 继续滚 → 渲染行窗口必须跟随（首行文案变化）；
 *   V4 容器 scrollHeight > clientH（确实有得滚）；
 *   V5 900x600 最矮窗口同样成立（视口宽高显式断言，防假绿）。
 */

const path = require('node:path')
const fs = require('node:fs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(page, label, expectW, expectH) {
  // 先复位到顶：V1 要量「engine 行在不在滚动器里」，滚动后窗口化会把第 0 行
  // 渲染掉 ⇒ 查询不到 ⇒ 假红。复位只影响测量时机，被测滚轮仍是 CDP 真事件。
  await page.evaluate(() => {
    const vl = document.querySelector('[data-testid="dl-group-list"]')
    if (vl) vl.scrollTo(0, 0)
  })
  await delay(400)
  const st = await page.evaluate(() => {
    const vl = document.querySelector('[data-testid="dl-group-list"]')
    const eng = [...document.querySelectorAll('[data-testid="download-item"]')]
    const inside = eng.length > 0 && vl ? eng.every((e) => vl.contains(e)) : null
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hasVlist: !!vl,
      engineRows: eng.length,
      engineInsideScroller: inside,
      scrollH: vl ? vl.scrollHeight : 0,
      clientH: vl ? vl.clientHeight : 0,
      scrollTop: vl ? vl.scrollTop : -1,
      rendered: vl ? vl.querySelectorAll('[data-vl-row]').length : 0,
      total: vl ? Number(vl.getAttribute('data-total') || '0') : 0,
      firstRow: vl ? (vl.textContent || '').slice(0, 40) : null,
      ingestRows: vl ? vl.querySelectorAll('[data-testid="ingest-group-row"]').length : 0,
    }
  })
  console.log(`=== ${label} (viewport ${st.viewport.w}x${st.viewport.h}) ===`)
  console.log(JSON.stringify(st))

  const vpOk = st.viewport.w === expectW && st.viewport.h === expectH
  const v1 = st.engineInsideScroller === true
  const v4 = st.scrollH > st.clientH + 1
  console.log(`V1 engine 行在滚动器内: ${v1}`)
  console.log(`V4 有得滚(scrollH ${st.scrollH} > clientH ${st.clientH}): ${v4}`)
  console.log(`视口前提断言(${expectW}x${expectH}): ${vpOk}`)

  let v2 = null
  let v3 = null
  if (!v1 || !v4) {
    if (!v4) console.log('V2/V3 SKIP：内容不满一屏（无从滚起，非缺陷）')
    if (!v1) console.log('V2/V3 SKIP：engine 行不在滚动器内')
  } else {
    // 先复位到顶（上一视口轮的滚动位置会带着跑；engine 行滚出视口后滚轮坐标
    // 会落在屏幕外 ⇒ 假红）。复位用程序式 scrollTo，被测的滚轮仍是 CDP 真事件。
    await page.evaluate(() => {
      const vl = document.querySelector('[data-testid="dl-group-list"]')
      if (vl) vl.scrollTo(0, 0)
    })
    await delay(400)
    const box = await page.evaluate(() => {
      const eng = document.querySelector('[data-testid="download-item"]')
      const r = eng.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
    // 真实滚轮：CDP Input.dispatchMouseEvent（JS 合成 WheelEvent 不可信、
    // 不触发浏览器默认滚动动作，必须走 CDP 输入通道）。连滚 3 次确保越过
    // overscan 缓冲区，窗口必须换人。
    for (let k = 0; k < 3; k += 1) {
      await page.conn.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: box.x, y: box.y },
        { sessionId: page.sessionId },
      )
      await page.conn.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 600 },
        { sessionId: page.sessionId },
      )
      await delay(250)
    }
    await delay(500)
    const after = await page.evaluate(() => {
      const vl = document.querySelector('[data-testid="dl-group-list"]')
      return {
        scrollTop: vl.scrollTop,
        firstRow: (vl.textContent || '').slice(0, 40),
        rendered: vl.querySelectorAll('[data-vl-row]').length,
      }
    })
    v2 = after.scrollTop > st.scrollTop
    v3 = after.firstRow !== st.firstRow || after.rendered !== st.rendered
    console.log(`V2 wheel 压 engine 行后 scrollTop ${st.scrollTop} -> ${after.scrollTop}: ${v2}`)
    console.log(`V3 窗口跟随(首行/渲染行变化): ${v3} (firstRow: ${st.firstRow?.slice(0, 20)} -> ${after.firstRow?.slice(0, 20)})`)
  }
  const pass = vpOk && v1 && v4 !== false && (v2 === null || v2 === true) && (v3 === null || v3 === true)
  console.log(`>>> ${label}: ${pass ? 'PASS' : 'FAIL'}`)
  return pass
}

async function main() {
  const browser = await cdp.launch()
  let allPass = true
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="dl-group-list"]') !== null,
      { timeout: 30000 },
    )
    await delay(2500)

    allPass = (await run(page, 'default-viewport', await page.evaluate(() => window.innerWidth), await page.evaluate(() => window.innerHeight))) && allPass

    await page.setViewport({ width: 900, height: 600 })
    await delay(1000)
    allPass = (await run(page, 'min-window-900x600', 900, 600)) && allPass

    const shots = path.join(__dirname, '..', 'verify_shots')
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot(path.join(shots, 'dl_scroll_fixed_900x600.png'))
    console.log('shot: verify_shots/dl_scroll_fixed_900x600.png')
    console.log(allPass ? 'ALL PASS' : 'HAS FAIL')
  } finally {
    await browser.close()
  }
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
