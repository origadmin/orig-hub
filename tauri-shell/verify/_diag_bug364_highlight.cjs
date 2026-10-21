'use strict'

/** BUG-364 诊断②：循环命中后高亮到底进没进 DOM（属性 + 计算样式事实）。 */

const fs = require('fs')
const path = require('path')
const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')

const OUT = path.join(__dirname, '..', '..', 'verify_shots', 'bug364')
const CHAT = -1003969766003
const MSG = 4837
const KEY = `s-${CHAT}-${MSG}`
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const INSTALL_HELPERS = () => {
  window.__b364logs = []
  for (const lvl of ['log', 'warn', 'error']) {
    const orig = console[lvl].bind(console)
    console[lvl] = (...args) => {
      try {
        window.__b364logs.push(`${lvl}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`)
        if (window.__b364logs.length > 300) window.__b364logs.shift()
      } catch (_e) {
        /* 序列化失败不掩盖原日志 */
      }
      orig(...args)
    }
  }
  window.__b364 = {
    panelChannelId() {
      const hdr = document.querySelector('[data-testid="tg-channel-header"]')
      return hdr ? hdr.getAttribute('data-channel-id') : null
    },
    storeOk() {
      const s = window.__origStore
      return !!s && typeof s.getState === 'function' && typeof s.getState().setPendingTgFocus === 'function'
    },
    setFocus(chatId, messageId) {
      window.__origStore.getState().setPendingTgFocus({ chatId, messageId })
      return true
    },
    sample() {
      const st = window.__b364fetch
      const key = window.__b364.targetKey
      return {
        locating: !!document.querySelector('[data-testid="tg-locating"]'),
        pages: st ? st.pages : -1,
        keys: document.querySelectorAll('[data-message-key]').length,
        hlAny: document.querySelectorAll('[data-tg-highlight="true"]').length,
        tgt: !!document.querySelector(`[data-message-key="${key}"]`),
      }
    },
    /** 高亮 DOM 事实全量转储。 */
    dumpHighlight() {
      const key = window.__b364.targetKey
      const out = { hlElements: [], targetTile: null, targetAlbumRoot: null }
      for (const el of document.querySelectorAll('[data-tg-highlight]')) {
        out.hlElements.push({
          attr: el.getAttribute('data-tg-highlight'),
          hasMsgKey: el.getAttribute('data-message-key'),
          cls: (el.className || '').slice(0, 80),
          borderColor: getComputedStyle(el).borderColor,
          boxShadow: getComputedStyle(el).boxShadow,
        })
      }
      const tile = document.querySelector(`[data-message-key="${key}"]`)
      if (tile) {
        // 瓦片往上找带 data-tg-highlight 的祖先（相册根）
        let p = tile.closest('[data-tg-highlight]')
        out.targetTile = {
          tag: tile.tagName,
          cls: (tile.className || '').slice(0, 60),
          borderColor: getComputedStyle(tile).borderColor,
        }
        out.targetAlbumRoot = p
          ? {
              attr: p.getAttribute('data-tg-highlight'),
              cls: (p.className || '').slice(0, 80),
              borderColor: getComputedStyle(p).borderColor,
              boxShadow: getComputedStyle(p).boxShadow,
            }
          : null
      }
      out.scrollTop = (document.querySelector('[data-testid="tg-panel-root"] .overflow-y-auto') || {}).scrollTop
      return out
    },
  }
}

const INSTALL_FETCH_PROBE = () => {
  if (window.__b364fetch) {
    window.__b364fetch.reset()
    return
  }
  const orig = window.fetch
  const st = {
    pages: 0,
    firsts: 0,
    reset() {
      this.pages = 0
      this.firsts = 0
    },
  }
  window.__b364fetch = st
  window.fetch = async function (...args) {
    let url = ''
    try {
      url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0])
    } catch (_e) {
      url = ''
    }
    if (url.includes('/api/tg/monitor/messages')) {
      if (url.includes('beforeId=')) st.pages += 1
      else st.firsts += 1
    }
    return orig.apply(this, args)
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.evaluate(INSTALL_HELPERS)
    await page.evaluate(INSTALL_FETCH_PROBE)
    await page.evaluate((k) => {
      window.__b364.targetKey = k
    }, KEY)
    let loaded = false
    for (let i = 1; i <= 3 && !loaded; i += 1) {
      try {
        await page.goto(ep.app + '/', { settleMs: 1500, timeout: 90000 })
        await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-files"]'), { timeout: 45000 })
        loaded = true
      } catch (e) {
        console.log(`[diag2] goto ${i} failed: ${String((e && e.message) || e).slice(0, 120)}`)
        await delay(1500)
      }
    }
    if (!loaded) throw new Error('app load failed')
    await page.evaluate(INSTALL_HELPERS)
    await page.evaluate(INSTALL_FETCH_PROBE)
    await page.evaluate((k) => {
      window.__b364.targetKey = k
    }, KEY)

    await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="nav-tg"]')
      if (nav) nav.click()
    })
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
        return rows.length > 0
      },
      { timeout: 60000 },
    )
    // 直接经 store 钩子注入定位焦点（面板此时在 auto-select 的首频道 = 冷路径）
    await page.evaluate(() => window.__b364fetch.reset())
    const ok = await page.evaluate(() => window.__b364.setFocus(-1003969766003, 4837))
    console.log('[diag2] focus injected:', ok)

    const t0 = Date.now()
    let last = null
    while (Date.now() - t0 < 60000) {
      const s = await page.evaluate(() => window.__b364.sample())
      last = s
      if (!s.locating && s.pages > 0) break
      await delay(500)
    }
    console.log('[diag2] settled sample:', JSON.stringify(last))
    await delay(1000)
    const dump = await page.evaluate(() => window.__b364.dumpHighlight())
    console.log('[diag2] highlight dump:', JSON.stringify(dump, null, 1))
    const appLogs = await page.evaluate(() => (window.__b364logs || []).slice(-60))
    console.log('[diag2] app logs (last 20):')
    for (const l of appLogs.slice(-20)) console.log('  ' + l)
    await page.screenshot(path.join(OUT, 'diag2_highlight.png'))
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[diag2] FATAL', e)
  process.exit(2)
})
