'use strict'

/**
 * BUG-364 诊断：定位循环 stalls 现场（R3 hit=null / 120s 只翻 6 页）。
 * 密集采样（500ms）：toast / 高亮 / 面板频道 / 正在定位 / 翻页计数 /
 * DOM 消息键总数 / 目标键是否存在 / feedLoading 态（经 locating 与 DOM 推断）。
 * 不写判据，只打印事实。
 */

const fs = require('fs')
const http = require('http')
const path = require('path')
const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')

function apiGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 20000 }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(b) })
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

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
    clickMonitoredByTitle(title) {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return false
      const aside = panel.querySelector('aside')
      if (!aside) return false
      const b = [...aside.querySelectorAll('button')].find((x) =>
        (x.innerText || '').includes(title),
      )
      if (!b) return false
      b.click()
      return true
    },
    storeOk() {
      const s = window.__origStore
      return !!s && typeof s.getState === 'function' && typeof s.getState().setPendingTgFocus === 'function'
    },
    setFocus(chatId, messageId) {
      const s = window.__origStore
      if (!s || typeof s.getState !== 'function') return false
      s.getState().setPendingTgFocus({ chatId, messageId })
      return true
    },
    sample() {
      const hl = document.querySelector('[data-tg-highlight="true"]')
      const st = window.__b364fetch
      const keys = document.querySelectorAll('[data-message-key]')
      let targetInDom = false
      for (const el of keys) {
        if (el.getAttribute('data-message-key') === window.__b364.targetKey) {
          targetInDom = true
          break
        }
      }
      return {
        t: Date.now(),
        toasts: [...document.querySelectorAll('[data-testid="global-toast"]')]
          .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean),
        highlight: hl ? hl.getAttribute('data-message-key') : null,
        channelId: (document.querySelector('[data-testid="tg-channel-header"]') || {}).dataset
          ? document.querySelector('[data-testid="tg-channel-header"]').getAttribute('data-channel-id')
          : null,
        locating: !!document.querySelector('[data-testid="tg-locating"]'),
        historyOlder: !!document.querySelector('[data-testid="tg-history-older"]'),
        pageLoads: st ? st.pages : -1,
        firstLoads: st ? st.firsts : -1,
        domKeys: keys.length,
        targetInDom,
        feedLoadingText: (document.body.innerText || '').includes('加载媒体中'),
      }
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
    calls: [],
    delayMs: 0,
    delayUntil: 0,
    reset() {
      this.pages = 0
      this.firsts = 0
      this.calls = []
      this.delayMs = 0
      this.delayUntil = 0
    },
    armDelay(ms, windowMs) {
      this.delayMs = ms
      this.delayUntil = Date.now() + windowMs
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
      const hasBefore = url.includes('beforeId=')
      if (hasBefore) st.pages += 1
      else st.firsts += 1
      st.calls.push({ hasBefore, t: Date.now() })
      if (st.delayUntil && Date.now() < st.delayUntil) {
        await new Promise((r) => setTimeout(r, st.delayMs))
      }
    }
    return orig.apply(this, args)
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[diag] app=${ep.app} tg=${ep.tg}`)
  const mon = await apiGet(19787, '/api/tg/monitor/channels')
  const targetCh = (mon.json || []).find((c) => Number(c.channelId) === CHAT)
  console.log('[diag] target channel:', JSON.stringify(targetCh))
  if (!targetCh) {
    console.log('[diag] target channel not monitored; abort')
    return
  }
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    const consoleLines = []
    await page.evaluate(INSTALL_HELPERS)
    await page.evaluate(INSTALL_FETCH_PROBE)
    await page.evaluate((k) => {
      window.__b364.targetKey = k
    }, KEY)
    // vite 首载可 >30s（与改动无关的已知现象）⇒ 带重试导航
    let loaded = false
    for (let i = 1; i <= 3 && !loaded; i += 1) {
      try {
        await page.goto(ep.app + '/', { settleMs: 1500, timeout: 90000 })
        await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-files"]'), {
          timeout: 45000,
        })
        loaded = true
      } catch (e) {
        console.log(`[diag] goto attempt ${i} failed: ${String((e && e.message) || e).slice(0, 160)}`)
        await delay(1500)
      }
    }
    if (!loaded) throw new Error('app 加载失败（3 次重试）')
    await page.waitForFunction(() => !!window.__origStore, { timeout: 30000 })
    await page.evaluate(INSTALL_HELPERS)
    await page.evaluate(INSTALL_FETCH_PROBE)
    await page.evaluate((k) => {
      window.__b364.targetKey = k
    }, KEY)

    // 直接进 TG 面板（热路径，先看循环本身通不通）
    await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="nav-tg"]')
      if (nav) nav.click()
    })
    // 监控列表是 TgPanel 本地状态（异步拉取）⇒ 等左栏频道按钮出现
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="tg-panel-root"]')
        const aside = panel && panel.querySelector('aside')
        return !!aside && aside.querySelectorAll('button').length > 0
      },
      { timeout: 60000 },
    )
    const titles = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      const aside = panel.querySelector('aside')
      return [...aside.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
    })
    console.log('[diag] aside buttons (full text):', JSON.stringify(titles))
    const clicked = await page.evaluate(
      (t) => window.__b364.clickMonitoredByTitle(t),
      targetCh.title || '',
    )
    console.log('[diag] clicked target channel:', clicked, targetCh.title)
    await page.waitForFunction(() => document.querySelectorAll('[data-message-key]').length > 0, {
      timeout: 60000,
    })
    await delay(1500)

    // 经 store 钩子注入定位焦点（与 BUG-305 判据5 同机制）
    const armed = await page.evaluate(() => window.__b364fetch && window.__b364fetch.reset())
    const focused = await page.evaluate((c, m) => window.__b364.setFocus(c, m), CHAT, MSG)
    console.log('[diag] focus injected:', focused)

    const t0 = Date.now()
    const samples = []
    while (Date.now() - t0 < 90000) {
      const s = await page.evaluate(() => window.__b364.sample())
      samples.push(s)
      const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s ch=${s.channelId} locating=${s.locating} pages=${s.pageLoads} firsts=${s.firstLoads} domKeys=${s.domKeys} targetInDom=${s.targetInDom} hl=${s.highlight} toasts=${JSON.stringify(s.toasts)} loading=${s.feedLoadingText}`
      console.log(line)
      if (s.highlight) break
      if (s.toasts.length) break
      await delay(500)
    }
    await page.screenshot(path.join(OUT, 'diag_stall.png'))
    const appLogs = await page.evaluate(() => (window.__b364logs || []).slice(-120))
    const cdpErrs = await page.consoleErrors()
    fs.writeFileSync(
      path.join(OUT, 'diag_stall.json'),
      JSON.stringify({ samples, appLogs, cdpErrs: cdpErrs.slice(0, 40) }, null, 1),
    )
    console.log('[diag] app console (last 40):')
    for (const l of appLogs.slice(-40)) console.log('  ' + l)
    if (cdpErrs.length) {
      console.log('[diag] cdp console errors:')
      for (const l of cdpErrs.slice(0, 10)) console.log('  ' + l)
    }
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[diag] FATAL', e)
  process.exit(2)
})
