#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 BUG-368/372 修复验证（用户第三次提出「图片无法选择」+「标题不在第一行」）。
 *
 * 判据：
 *   T1 Sheet 表头第一个元素就是标题（其前无徽标；全 Sheet 不得再有「TG 入库」徽标）；
 *   T2 照片条目（label=图片）**有**复选框（BUG-368：历史落盘图未入库也可选）；
 *   T3 照片条目默认选中（未入库 = 要下载的，与用户 2026-10-20 口径一致）；
 *   T4 视频条目复选框形状不变（回归）。
 */

const path = require('node:path')
const fs = require('node:fs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

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
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0,
      { timeout: 30000 },
    )
    await delay(2000)

    // 有界查找「母子同欢」组行（窗口化列表里可能还没渲染到）
    let opened = false
    for (let i = 0; i < 12 && !opened; i += 1) {
      const found = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="ingest-group-row"]')]
        const hit = rows.find((r) => (r.textContent || '').includes('母子同欢'))
        if (!hit) return false
        const h = hit.querySelector('[data-testid="ingest-group-header"]')
        if (h) h.click()
        return true
      })
      if (found) {
        opened = true
        break
      }
      // 没找到 ⇒ 滚下列表再找（CDP 真实滚轮）
      await page.conn.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 450, y: 400, deltaX: 0, deltaY: 800 },
        { sessionId: page.sessionId },
      )
      await delay(700)
    }
    if (!opened) {
      console.log('FAIL：窗口化列表里没找到「母子同欢」组行（12 次滚动内）')
      process.exit(1)
    }
    await page.waitForFunction(
      () => document.querySelector('[data-testid="ingest-detail-sheet"]') !== null,
      { timeout: 15000 },
    )
    await delay(1500)

    const r = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="ingest-detail-sheet"]')
      const titleP = sheet.querySelector('p.truncate')
      const headerDiv = titleP ? titleP.parentElement : null
      const entries = [...sheet.querySelectorAll('[data-testid="ingest-sheet-entry"]')]
      const kindOf = (li) => {
        const label = li.querySelector('span.w-14')
        return label ? (label.textContent || '').trim() : ''
      }
      const photos = entries.filter((li) => kindOf(li) === '图片')
      const videos = entries.filter((li) => kindOf(li) !== '图片')
      return {
        titleText: titleP ? (titleP.textContent || '').slice(0, 40) : null,
        titleIsFirstInHeader: headerDiv ? headerDiv.firstElementChild === titleP : false,
        hasTgBadge: (sheet.textContent || '').includes('TG 入库'),
        total: entries.length,
        photos: photos.length,
        photosWithCheckbox: photos.filter((li) => !!li.querySelector('[data-testid="ingest-sheet-entry-checkbox"]')).length,
        photosSelected: photos.filter((li) => li.getAttribute('data-selected') === '1').length,
        videos: videos.length,
        videosWithCheckbox: videos.filter((li) => !!li.querySelector('[data-testid="ingest-sheet-entry-checkbox"]')).length,
      }
    })
    console.log(JSON.stringify(r, null, 1))

    const t1 = r.titleIsFirstInHeader && !r.hasTgBadge && !!r.titleText
    const t2 = r.photos > 0 && r.photosWithCheckbox === r.photos
    const t3 = r.photos > 0 && r.photosSelected === r.photos
    const t4 = r.videosWithCheckbox === r.videos
    console.log(`T1 标题是表头第一个元素且无 TG 入库徽标: ${t1}`)
    console.log(`T2 照片条目全有复选框 (${r.photosWithCheckbox}/${r.photos}): ${t2}`)
    console.log(`T3 照片条目默认全选 (${r.photosSelected}/${r.photos}): ${t3}`)
    console.log(`T4 视频条目复选框形状不变 (${r.videosWithCheckbox}/${r.videos}): ${t4}`)
    pass = t1 && t2 && t3 && t4

    const shots = path.join(__dirname, '..', 'verify_shots')
    fs.mkdirSync(shots, { recursive: true })
    await page.screenshot(path.join(shots, 'dl_ingest_sheet_fixed.png'))
    console.log('shot: verify_shots/dl_ingest_sheet_fixed.png')
    console.log(pass ? 'ALL PASS' : 'HAS FAIL')
  } finally {
    await browser.close()
  }
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
