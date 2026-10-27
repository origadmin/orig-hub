'use strict'
/**
 * BUG-436 取证：用户报「未命名视频」到底出现在**哪一层**。
 *
 * 不看代码猜，直接渲染媒体库网格，把每张卡片的显名抓下来数「未命名」；
 * 再打开一个空标题条目，读播放器返回行的 `viewer-title`。
 *
 * 输出：每层的未命名计数 + 样例。
 */
const cdp = require('./lib/cdp.cjs')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://127.0.0.1:5180/', { waitUntil: 'load', timeout: 90000 })
  await delay(2500)

  // 进「文件管理 → 全部内容」
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-files"]')
    if (b) b.click()
  })
  await delay(1200)

  // 等网格
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(
      () => document.querySelectorAll('[data-testid="media-card"]').length,
    )
    if (n > 0) break
    await delay(500)
  }

  const grid = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="media-card"]'))
    const names = cards.map((c) => {
      const t = c.querySelector('[data-testid="media-card-title"]')
      return (t ? t.textContent : c.textContent || '').trim()
    })
    const untitled = names.filter((n) => n.includes('未命名'))
    return { total: cards.length, untitledCount: untitled.length, sample: untitled.slice(0, 8) }
  })
  console.log('grid:', JSON.stringify(grid))

  // 找一个空标题条目的 id
  const blankId = await page.evaluate(async () => {
    const r = await fetch('http://127.0.0.1:19787/api/media/items?limit=2000')
    const d = await r.json()
    const hit = (d.items || []).find((i) => !(i.title || '').trim() && i.seriesTitle)
    return hit ? { id: hit.id, ref: hit.ref, seriesTitle: hit.seriesTitle } : null
  })
  console.log('blank item:', JSON.stringify(blankId))

  if (blankId) {
    await page.evaluate(async (id) => {
      const r = await fetch('http://127.0.0.1:19787/api/media/items/' + id)
      const it = await r.json()
      window.__origStore.getState().openViewer({
        index: 0,
        items: [
          {
            key: 'media-' + it.id,
            chatId: 0,
            messageId: it.id,
            kind: it.kind,
            caption: it.title,
            description: it.description ?? null,
            src: 'http://127.0.0.1:19787/api/media/items/' + it.id + '/raw',
            streamSrc:
              it.kind === 'video'
                ? 'http://127.0.0.1:19787/api/media/items/' + it.id + '/stream'
                : undefined,
            poster: it.poster ?? null,
            seriesId: it.kind === 'video' ? (it.seriesId ?? null) : null,
            duration: it.duration,
            hasBytes: true,
            ref: it.ref ?? null,
            source: it.source ?? null,
          },
        ],
      })
    }, blankId.id)
    await delay(1500)
    const viewer = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="viewer-title"]')
      return t ? t.textContent.trim() : '(no el)'
    })
    console.log('viewer-title (现状，caption 直接取裸 title):', JSON.stringify(viewer))
  }

  await browser.close()
}
main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
