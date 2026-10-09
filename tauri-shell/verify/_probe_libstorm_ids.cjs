'use strict'
/**
 * Decisive read-only probe: unique item-id count among the rendered media cards.
 *
 * `MediaCard` root has NO id-bearing DOM attribute (MediaCard.tsx:242-244), so we
 * read the React fiber's `memoizedProps.item` off each `[data-testid="media-card"]`
 * node (dev build => `__reactFiber$*` key is present). Also reports the default
 * (series-wall) view card count / unique id count for contrast.
 */
const cdp = require('./lib/cdp.cjs')
const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function click(page, id) {
  return page.evaluate((x) => { const b = document.querySelector(`[data-testid="${x}"]`); if (!b) return false; b.click(); return true }, id)
}

/** Read the media cards' item ids via the React fiber. */
async function readCardIds(page) {
  return page.evaluate(() => {
    const KEY = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    const nodes = [...document.querySelectorAll('[data-testid="media-card"]')]
    const cards = nodes.map((el, i) => {
      const k = KEY(el)
      let fiber = k ? el[k] : null
      let id = null
      let title = null
      let depth = 0
      while (fiber && depth < 12) {
        const p = fiber.memoizedProps
        if (p && p.item && typeof p.item.id === 'number') { id = p.item.id; title = p.item.title ?? null; break }
        fiber = fiber.return
        depth++
      }
      // nearest section container (to detect cross-block duplication)
      const sec = el.closest('[data-testid="media-grid"]') ? 'media-grid' : (el.parentElement ? el.parentElement.getAttribute('data-testid') || el.parentElement.className.slice(0, 24) : '?')
      return { i, id, title: (title || '').trim(), sec }
    })
    const ids = cards.map((c) => c.id).filter((x) => x != null)
    const counts = {}
    for (const x of ids) counts[x] = (counts[x] || 0) + 1
    const dups = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => [Number(k), n])
    return {
      cards: cards.length,
      withId: ids.length,
      uniqueIds: new Set(ids).size,
      dupIdCount: dups.length,
      dupSamples: dups.slice(0, 5),
      dupPositions: cards.filter((c) => c.id != null && counts[c.id] > 1).map((c) => ({ i: c.i, id: c.id, sec: c.sec, title: c.title.slice(0, 18) })).slice(0, 12),
      sections: [...new Set(cards.map((c) => c.sec))],
      sampleIds: ids.slice(0, 8),
      emptyTitleCards: cards.filter((c) => c.title === '').length,
    }
  })
}

async function readSeries(page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-testid="series-card"]')].map((e) => e.getAttribute('data-series-id'))
    return { cards: ids.length, uniqueIds: new Set(ids).size, sample: ids.slice(0, 6) }
  })
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto(APP, { waitUntil: 'load' })
  await delay(3000)
  await click(page, 'nav-media')
  await delay(7000)

  const series = await readSeries(page)
  console.log('DEFAULT VIEW (series wall):', JSON.stringify(series))

  const ok = await click(page, 'media-cat-all')
  await delay(8000)
  const items = await readCardIds(page)
  console.log('ITEMS GRID (clicked=' + ok + '):', JSON.stringify(items, null, 2))

  await browser.close()
}
main().catch((e) => { console.error('FAIL', e && e.stack ? e.stack : e); process.exit(1) })
