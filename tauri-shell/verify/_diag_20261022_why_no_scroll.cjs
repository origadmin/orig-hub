#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 「下载域为什么不滚」实测（BUG-372）。
 *
 * 用户原话：「严重的逻辑错误,我说的是滚动问题,他为什么不滚???」
 *
 * 三件事必须分清：
 *   S1 面板里到底有没有可滚容器（engine 块 shrink-0 钉死 + ingest 不可达时 =
 *      整个面板没有任何 overflow 容器 ⇒ 鼠标滚轮压哪儿都不滚）；
 *   S2 有容器时，原生滚动是否真的发生（scrollTop 是否变）；
 *   S3 窗口化是否跟随（滚动后渲染行是否换）。
 */

const path = require('node:path')
const fs = require('node:fs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    // 等到下载域任一内容形态（列表/空态/横幅）出现
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="dl-group-list"]') ||
        document.querySelector('[data-testid="dl-empty"]') ||
        document.querySelector('[data-testid="download-item"]'),
      { timeout: 30000 },
    )
    await delay(2500)

    const snap = () =>
      page.evaluate(() => {
        const vl = document.querySelector('[data-testid="dl-group-list"]')
        const eng = [...document.querySelectorAll('[data-testid="download-item"]')]
        const engBlock = eng.length ? eng[0].closest('.shrink-0') : null
        // 面板内所有 overflow 容器
        const overs = []
        const root = document.querySelector('[data-testid="dl-group-list"]')?.closest('.flex.h-full') || document.body
        root.querySelectorAll('*').forEach((el) => {
          const cs = getComputedStyle(el)
          if (/(auto|scroll)/.test(cs.overflowY)) {
            overs.push({
              testid: el.getAttribute('data-testid'),
              cls: (el.className || '').toString().slice(0, 60),
              scrollH: el.scrollHeight,
              clientH: el.clientHeight,
            })
          }
        })
        return {
          hasVlist: !!vl,
          vlist: vl
            ? {
                scrollH: vl.scrollHeight,
                clientH: vl.clientHeight,
                scrollTop: vl.scrollTop,
                renderedRows: vl.querySelectorAll('[data-testid="ingest-group-row"]').length,
                firstRowText: (vl.textContent || '').slice(0, 50),
              }
            : null,
          engineRows: eng.length,
          engineBlockCls: engBlock ? (engBlock.className || '').toString() : null,
          overs,
          banner: (document.querySelector('[data-testid="dl-tg-unavailable"]') || {}).textContent?.slice(0, 120) || null,
          empty: !!document.querySelector('[data-testid="dl-empty"]'),
        }
      })

    const before = await snap()
    console.log('=== BEFORE wheel ===')
    console.log(JSON.stringify(before, null, 1))

    if (before.hasVlist && before.vlist.scrollH > before.vlist.clientH + 1) {
      // 真实滚轮：CDP mouseWheel 事件（合成 el.scrollTop= 不算）
      const box = await page.evaluate(() => {
        const vl = document.querySelector('[data-testid="dl-group-list"]')
        const r = vl.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      await page.evaluate(
        ([x, y]) => {
          const vl = document.querySelector('[data-testid="dl-group-list"]')
          vl.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 600, clientX: x, clientY: y, bubbles: true, cancelable: true }),
          )
        },
        [box.x, box.y],
      )
      await delay(600)
      const after = await snap()
      console.log('=== AFTER wheel (deltaY=600 at list center) ===')
      console.log(JSON.stringify(after.vlist, null, 1))
      console.log('S2 原生滚动发生:', after.vlist.scrollTop > before.vlist.scrollTop)
      console.log('S3 窗口化跟随(渲染行变化或首行文案变化):',
        after.vlist.renderedRows !== before.vlist.renderedRows ||
        after.vlist.firstRowText !== before.vlist.firstRowText)
    } else {
      console.log('!! 没有可滚的入库列表（hasVlist=' + before.hasVlist + '）⇒ 鼠标滚轮压在面板任何位置都不会滚')
    }

    const shots = path.join(__dirname, '..', 'verify_shots')
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot(path.join(shots, 'dl_scroll_now.png'))
    console.log('shot: verify_shots/dl_scroll_now.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
