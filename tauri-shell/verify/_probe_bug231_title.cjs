'use strict'
const cdp = require('./lib/cdp.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load' })
  await delay(2000)
  // 契约验证：title=undefined 且 item.caption 有值 ⇒ viewer-title 显示 caption 内容，而非任何频道名
  await page.evaluate(() => {
    window.__origStore.getState().openViewer({
      title: undefined,
      index: 0,
      items: [{ key: 'media-673', chatId: 0, messageId: 673, kind: 'video',
        caption: '😀😀😀 #《存在感零》 EP6', description: null, src: 'http://127.0.0.1:19787/api/media/items/673/raw',
        poster: null, episodeNo: null, seriesId: null }],
      title: undefined,
    })
  })
  await delay(1800)
  const st = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="viewer-title"]')
    return { viewerTitle: t ? t.textContent.trim().slice(0, 60) : '(no el)' }
  })
  console.log('contract:', JSON.stringify(st))
  // 反证：旧代码传频道名 ⇒ 标题就是频道名（证明渲染层只是透传，修复点在调用方）
  await page.evaluate(() => {
    window.__origStore.getState().openViewer({
      title: '西瓜短剧(AI短剧)', index: 0,
      items: [{ key: 'media-673b', chatId: 0, messageId: 673, kind: 'video',
        caption: '😀😀😀 #《存在感零》 EP6', description: null, src: 'http://127.0.0.1:19787/api/media/items/673/raw',
        poster: null, episodeNo: null, seriesId: null }],
    })
  })
  await delay(1200)
  const st2 = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="viewer-title"]')
    return { viewerTitle: t ? t.textContent.trim().slice(0, 60) : '(no el)' }
  })
  console.log('before-fix behavior:', JSON.stringify(st2))
  await browser.close()
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
