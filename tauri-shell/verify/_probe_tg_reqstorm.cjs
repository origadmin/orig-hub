'use strict'

/**
 * TG 频道「请求爆炸」只读取证探针（用户报告 2026-10-09）：
 *   「TG 插件 → 每日沙雕墙，进入后请求了 1000 多个。」
 *
 * 只读：不改产品代码，仅驱动真实 UI（点 nav-tg → 点监控频道行）并抓取 CDP
 * Network domain 的全量请求。输出：
 *   - /api 请求总数、按端点分组计数
 *   - 瞬时峰值 req/s、逐秒时间分布（判断「一次爆发」还是「周期轮询」）
 *   - 重复 URL 计数（同一 URL 在窗口内被请求多少次）
 *   - initiator 归属（脚本栈 url:line，用于定位前端触发点）
 *
 * 用法：node _probe_tg_reqstorm.cjs [channelTitleSubstring] [windowMs]
 */

const cdp = require('./lib/cdp.cjs')

const APP = 'http://127.0.0.1:5180/'
const TG = 'http://127.0.0.1:19787'
const TITLE = process.argv[2] || '每日沙雕墙'
const WINDOW_MS = Number(process.argv[3] || 30000)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 只统计打到 orig-tg（媒体库 API + TG API 同进程）的请求。 */
function isTgApi(url) {
  return url.startsWith(TG) || /127\.0\.0\.1:19787\//.test(url)
}

function pathKey(url) {
  try {
    const u = new URL(url)
    return u.pathname + (u.search || '')
  } catch (_e) {
    return url
  }
}

function summarize(records, label, windowMs) {
  const api = records.filter((r) => isTgApi(r.url))
  const byPath = {}
  for (const r of api) {
    const k = pathKey(r.url)
    byPath[k] = (byPath[k] || 0) + 1
  }
  // 按「端点族」聚合：把 :id 段归并，便于看 N+1 模式
  const byFamily = {}
  for (const r of api) {
    let k = pathKey(r.url).split('?')[0]
    k = k
      .replace(/\/api\/tg\/thumb\/[^/]+\/[^/]+/, '/api/tg/thumb/{chat}/{msg}')
      .replace(/\/api\/tg\/file\/[^/]+\/[^/]+/, '/api/tg/file/{chat}/{msg}')
      .replace(/\/api\/tg\/local\/[^/]+\/[^/]+/, '/api/tg/local/{chat}/{msg}')
      .replace(/\/api\/media\/items\/[^/]+\/raw/, '/api/media/items/{id}/raw')
      .replace(/\/api\/tg\/messages\/[^/]+/, '/api/tg/messages/{chat}')
      .replace(/\/api\/tg\/downloaded\/[^/]+/, '/api/tg/downloaded/{chat}')
    byFamily[k] = (byFamily[k] || 0) + 1
  }
  // 逐秒桶
  const buckets = new Map()
  const t0 = api.length ? api[0].ts : 0
  for (const r of api) {
    const sec = Math.floor(r.ts - t0)
    buckets.set(sec, (buckets.get(sec) || 0) + 1)
  }
  const secs = [...buckets.keys()].sort((a, b) => a - b)
  const peak = secs.length ? Math.max(...secs.map((s) => buckets.get(s))) : 0
  // 重复 URL
  const urlCount = {}
  for (const r of api) urlCount[r.url] = (urlCount[r.url] || 0) + 1
  const dupes = Object.entries(urlCount)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])

  console.log(`\n=== ${label} ===`)
  console.log(`window=${(windowMs / 1000).toFixed(0)}s  /api 请求总数=${api.length}  peak/s=${peak}`)
  const byMethod = {}
  for (const r of api) byMethod[r.method] = (byMethod[r.method] || 0) + 1
  console.log('--- 按 HTTP 方法（OPTIONS=预检） ---')
  console.log('  ' + JSON.stringify(byMethod))
  console.log('--- 按端点族 ---')
  for (const [k, n] of Object.entries(byFamily).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}x  ${k}`)
  }
  console.log('--- 逐秒分布 (sec:count) ---')
  console.log('  ' + secs.map((s) => `${s}:${buckets.get(s)}`).join('  '))
  console.log(`--- 重复 URL（>1 次）共 ${dupes.length} 个，Top 12 ---`)
  for (const [u, n] of dupes.slice(0, 12)) console.log(`  ${String(n).padStart(4)}x  ${pathKey(u)}`)
  // initiator 归属
  const byInit = {}
  for (const r of api) {
    const frame = r.stack && r.stack[0]
    const src = frame ? `${frame.url}:${frame.lineNumber}:${frame.columnNumber} ${frame.functionName || ''}` : `(${r.initType || 'no-stack'})`
    const key = `${r.initType || '?'} :: ${src}`
    byInit[key] = (byInit[key] || 0) + 1
  }
  console.log('--- initiator 归属（脚本栈 url:line:col） ---')
  for (const [k, n] of Object.entries(byInit).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`  ${String(n).padStart(5)}x  ${k}`)
  }
  return { total: api.length, peak, secs, byFamily, dupes: dupes.length }
}

async function main() {
  const browser = await cdp.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage()
  await page.goto(APP, { settleMs: 2000 })

  // 先开 Network，抓「进入频道」前的基线（面板自身的挂载请求）
  await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
  const records = []
  let navMark = 0
  page.conn.on('Network.requestWillBeSent', (p) => {
    const init = p.initiator || {}
    let stack = []
    if (init.stack && Array.isArray(init.stack.callFrames)) {
      stack = init.stack.callFrames.map((f) => ({
        url: String(f.url || ''),
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
        functionName: f.functionName || '',
      }))
    }
    records.push({
      ts: p.wallTime || p.timestamp,
      url: p.request.url,
      method: p.request.method,
      type: p.type || '',
      initType: init.type || '',
      stack,
    })
  })

  // 进入 TG 面板（面板挂载会自动选中第一个监控频道 → 即触发 feed 加载）
  navMark = records.length
  const navOk = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-tg"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!navOk) throw new Error('nav-tg not found')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
    timeout: 20000,
    intervalMs: 250,
  })
  await delay(3500)
  const panelBaseCount = records.length
  const mountSum = summarize(records.slice(navMark), '面板挂载 + 自动选中首个监控频道（0→3.5s）', 3500)
  console.log(`[baseline] 面板挂载后（含自动进入频道）请求数=${records.filter((r) => isTgApi(r.url)).length}`)

  // 进入目标频道：点监控行里标题匹配的按钮（若已自动选中则为幂等重选）
  const clicked = await page.evaluate((title) => {
    const btns = [...document.querySelectorAll('[data-testid="tg-panel-root"] aside button')]
    const hit = btns.find((b) => (b.textContent || '').includes(title))
    if (!hit) return false
    hit.click()
    return true
  }, TITLE)
  if (!clicked) throw new Error(`monitored row「${TITLE}」not found`)
  console.log(`[enter] clicked monitored row「${TITLE}」，开始 ${WINDOW_MS / 1000}s 采样`)

  const mark = records.length
  await delay(WINDOW_MS)

  // 采样后 DOM 统计（关联请求数与渲染瓦片数）
  const dom = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="tg-panel-root"]')
    const imgs = root ? [...root.querySelectorAll('img')] : []
    const thumbs = imgs.map((i) => i.getAttribute('src') || '').filter((s) => s.includes('/api/tg/thumb/'))
    const tiles = root ? root.querySelectorAll('[data-testid^="tg-album-tile-"]').length : 0
    const photos = root ? root.querySelectorAll('[data-testid="tg-photo-preview"]').length : 0
    return { imgCount: imgs.length, thumbImgs: thumbs.length, albumTiles: tiles, photoPreviews: photos }
  })
  console.log('[dom]', JSON.stringify(dom))

  const win = records.slice(mark)
  const sum = summarize(win, `进入「${TITLE}」后 ${WINDOW_MS / 1000}s`, WINDOW_MS)
  console.log('\n[VERDICT] /api 总数=' + sum.total + ' peak/s=' + sum.peak + ' 重复URL数=' + sum.dupes)

  await browser.close()
}

main().catch((e) => {
  console.error('PROBE FAILED:', e && e.message)
  process.exit(1)
})
