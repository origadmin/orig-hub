#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 下载域「2 个订死数据破坏滚动样式」取证探针（只出数字不改判据）。
 *
 * 用户原话：「bug322ui.bin NanaZip_7.0.1843.0_Binaries.zip 影响破坏滚动样式了!」
 *
 * 两条死行来源：BUG-319/322 验收脚本写进真实引擎任务库的测试残留
 * （mock://bug322ui.bin 32MB completed / NanaZip github completed，删不掉只能重试）。
 *
 * 本脚本量化：
 *   D1 两条死行的实际高度与占位；
 *   D2 下载域面板内每个可滚动祖先的 scrollHeight/clientHeight（谁滚得动）；
 *   D3 engine 行块（shrink-0）与入库 VirtualList 的高度分配；
 *   D4 页面级（main）滚动是否被面板 h-full 吃掉；
 *   D5 两个视口（默认 / 最矮受支持窗口 900x600）各测一遍，断言视口真的变了。
 */

const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(page, label) {
  return page.evaluate((lbl) => {
    const rows = [...document.querySelectorAll('[data-testid="download-item"]')]
    const rowInfo = rows.map((r) => {
      const rect = r.getBoundingClientRect()
      return {
        fid: (r.getAttribute('data-fid') || '').slice(0, 8),
        status: r.getAttribute('data-status'),
        y: Math.round(rect.y),
        h: Math.round(rect.height),
        w: Math.round(rect.width),
        name: (r.querySelector('p.truncate') ? r.querySelector('p.truncate').textContent : '').slice(0, 40),
      }
    })
    // 每条可滚动祖先（从行往上走到 body 前；无 engine 行时以入库列表为锚）
    const scrollers = []
    const anchor = rows.length
      ? rows[0].parentElement
      : document.querySelector('[data-testid="dl-group-list"]')
    let el = anchor
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el)
      if (/(auto|scroll)/.test(cs.overflowY)) {
        const rect = el.getBoundingClientRect()
        scrollers.push({
          tag: el.tagName,
          testid: el.getAttribute('data-testid'),
          cls: (el.className || '').toString().slice(0, 90),
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
          canScroll: el.scrollHeight > el.clientHeight + 1,
          y: Math.round(rect.y),
          h: Math.round(rect.height),
        })
      }
      el = el.parentElement
    }
    // engine 行块（DownloadList 容器 space-y-2.5 的父 div shrink-0）
    let engineBlock = null
    const dl = document.querySelector('[data-testid="dl-group-list"]')
    if (dl) {
      let p = dl.parentElement
      while (p && p !== document.body) {
        if (p.querySelector('[data-testid="download-item"]')) { engineBlock = p; break }
        p = p.parentElement
      }
    }
    const engineInfo = engineBlock
      ? (() => {
          const cs = getComputedStyle(engineBlock)
          const rect = engineBlock.getBoundingClientRect()
          return {
            cls: (engineBlock.className || '').toString().slice(0, 60),
            shrink: cs.flexShrink,
            overflowY: cs.overflowY,
            h: Math.round(rect.height),
            scrollH: engineBlock.scrollHeight,
          }
        })()
      : null
    const vlist = dl
      ? {
          testid: dl.getAttribute('data-testid'),
          scrollH: dl.scrollHeight,
          clientH: dl.clientHeight,
          canScroll: dl.scrollHeight > dl.clientHeight + 1,
          h: Math.round(dl.getBoundingClientRect().height),
        }
      : null
    const main = document.querySelector('main')
    const pageScroll = main
      ? { scrollH: main.scrollHeight, clientH: main.clientHeight, canScroll: main.scrollHeight > main.clientHeight + 1 }
      : null
    return {
      label: lbl,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rowCount: rows.length,
      rowInfo,
      scrollers,
      engineInfo,
      vlist,
      pageScroll,
      ingestRowCount: document.querySelectorAll('[data-testid="ingest-group-row"]').length,
    }
  }, label)
}

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="download-item"]').length > 0 ||
        document.querySelector('[data-testid="dl-group-list"]') !== null,
      { timeout: 30000 },
    )
    await delay(2000)

    const a = await measure(page, 'default-viewport')
    console.log('=== D1-D4 @ default viewport', JSON.stringify(a.viewport), '===')
    console.log(JSON.stringify(a, null, 1))

    await page.setViewport({ width: 900, height: 600 })
    await delay(800)
    const b = await measure(page, 'min-window-900x600')
    console.log('=== D1-D4 @ 900x600 (viewport assert:', b.viewport.w === 900 && b.viewport.h === 600, ') ===')
    console.log(JSON.stringify(b, null, 1))

    const shots = path.join(__dirname, '..', 'verify_shots')
    require('node:fs').mkdirSync(shots, { recursive: true })
    await page.screenshot(path.join(shots, 'dl_scroll_900x600.png'))
    console.log('shot: verify_shots/dl_scroll_900x600.png')
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
