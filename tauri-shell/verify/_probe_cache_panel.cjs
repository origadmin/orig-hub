'use strict'

/**
 * 入库流水线面板（CacheManagerDialog）真实渲染取证。
 *
 * 回答两个问题（不猜、只读 DOM）：
 *   1. 「下载中」（queued/running）的行在 DOM 里排第几？是否真在置顶？
 *   2. 全表多少行、有哪些状态？「已中断」的行排在什么位置？
 *
 * 只读：不改任何数据。
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch({ headless: false })
  let keep = null
  try {
    const page = await browser.newPage()
    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    const bring = () =>
      page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
    await bring()
    keep = setInterval(bring, 2000)

    // 面板只在 TG 视图挂载时才渲染 ⇒ 先切到 TG 视图
    const navTg = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="nav-tg"]')
      if (!b) return false
      b.click()
      return true
    })
    console.log('[nav] 切到 TG 视图 =', navTg)
    await delay(2500)

    // 打开入库流水线面板
    const opened = await page.evaluate(() => {
      try {
        window.__origStore.getState().setTgCacheManagerOpen(true)
        return true
      } catch (e) {
        return String(e)
      }
    })
    console.log('[open]', opened)
    await delay(3000)

    const dump = await page.evaluate(() => {
      const all = [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
      const hasCacheText = [...document.querySelectorAll('*')].some(
        (e) => e.children.length === 0 && (e.textContent || '').includes('入库流水线'),
      )
      const store = window.__origStore ? Object.keys(window.__origStore.getState()).filter((k) => /cache/i.test(k)) : []
      const storeVals = {}
      if (window.__origStore) {
        const s = window.__origStore.getState()
        for (const k of store) storeVals[k] = typeof s[k] === 'function' ? 'fn' : s[k]
      }
      return { testids: [...new Set(all)], hasCacheText, store, storeVals }
    })
    console.log('[diag] testids =', JSON.stringify(dump.testids))
    console.log('[diag] 页面含「入库流水线」文案 =', dump.hasCacheText)
    console.log('[diag] store 中 cache 相关键 =', JSON.stringify(dump.store))
    console.log('[diag] 其值 =', JSON.stringify(dump.storeVals))

    // ── 行顺序 ────────────────────────────────────────────────────────────
    const rowsDump = await page.evaluate(() => {
      const list = [...document.querySelectorAll('div.overflow-y-auto')].find((el) =>
        el.className.includes('flex-1'),
      )
      const rows = []
      if (list) {
        for (const child of list.children) {
          const txt = (child.textContent || '').replace(/\s+/g, ' ').trim()
          rows.push(txt.slice(0, 110))
        }
      }
      return { found: !!list, n: rows.length, rows }
    })
    console.log(`\n[list] found=${rowsDump.found} rows=${rowsDump.n}`)
    console.log('=== 前 20 行（DOM 顺序）===')
    rowsDump.rows.slice(0, 20).forEach((t, i) => console.log(`  ${String(i).padStart(3)} | ${t}`))

    const counts = {}
    for (const t of rowsDump.rows) {
      for (const k of ['下载中', '缓存中', '已入库', '入库中', '失败', '已中断', '中断', '已取消', '排队', '等待']) {
        if (t.includes(k)) counts[k] = (counts[k] || 0) + 1
      }
    }
    console.log('\n[状态词出现次数]', JSON.stringify(counts))
    console.log('[第一个活跃行下标]', rowsDump.rows.findIndex((t) => /下载中|缓存中|排队|等待/.test(t)))
    const intIdx = rowsDump.rows.map((t, i) => (/中断/.test(t) ? i : -1)).filter((i) => i >= 0)
    console.log('[「中断」行下标]', intIdx.slice(0, 20), '共', intIdx.length)

  } finally {
    if (keep) clearInterval(keep)
    await browser.close()
  }
}

main().catch((e) => {
  console.error('PROBE_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
