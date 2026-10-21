'use strict'
/**
 * 请求风暴诊断（只读）：把「请求爆炸导致卡顿」变成可复算的数字。
 *
 * 方法：CDP `Network` 域记录每一次请求，按阶段分桶统计：
 *   A 首页静置 20s（文件管理域）
 *   B 点 nav-tg 后静置 30s（TG 面板，未选频道）
 *   C 点第一个监控频道后静置 30s（消息流 + 缩略图）
 * 每阶段输出：请求总数、每秒速率、按路径归一化后的分桶计数、并发在飞峰值、
 * 阶段结束时仍在飞的请求、以及「同 URL 重复次数 Top」。
 *
 * 只读：不点保存、不建规则、不下载。产物 verify_shots/request-storm/
 * 用法：node tauri-shell/verify/_diag_request_storm.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'request-storm')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 路径归一化：数字 id / 长 hash 折叠，便于聚合同类请求 */
function normPath(u) {
  try {
    const url = new URL(u)
    if (url.origin === 'data:' || u.startsWith('data:')) return 'data:'
    let p = url.pathname.replace(/\/-?\d{6,}/g, '/:id').replace(/\/\d{4,}/g, '/:n')
    if (url.search) {
      const keys = [...url.searchParams.keys()].sort().join(',')
      p += `?${keys}`
    }
    return p
  } catch {
    return u.slice(0, 60)
  }
}

async function realClick(page, selector) {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, hitOk: !!hit && (el === hit || el.contains(hit)) }
  }, selector)
  if (!pt) throw new Error(`realClick: 找不到或不可见 ${selector}`)
  if (!pt.hitOk) throw new Error(`realClick: ${selector} 的点击点被其它元素占据`)
  const conn = page.conn || page._conn
  const sessionId = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 }, { sessionId })
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const conn = page.conn || page._conn
  const sid = page.sessionId

  // ---- 采集器 ----
  let current = null
  const phases = []
  const inflight = new Map() // requestId -> {url, start}
  let peak = 0

  const unsubs = []
  const durByBucket = new Map() // key -> number[]（毫秒）
  const rec = new Map() // requestId -> {key, t0}
  unsubs.push(conn.on('Network.requestWillBeSent', (p) => {
    if (p.sessionId && p.sessionId !== sid) return
    const url = p.request && p.request.url
    if (!url) return
    inflight.set(p.requestId, { url, start: Date.now(), type: p.type })
    if (current) {
      current.total += 1
      const key = `${p.request.method} ${normPath(url)}`
      current.buckets.set(key, (current.buckets.get(key) || 0) + 1)
      current.urlCount.set(url, (current.urlCount.get(url) || 0) + 1)
      if (p.type === 'Image') current.images += 1
      if (p.type === 'Fetch' || p.type === 'XHR') current.xhr += 1
      rec.set(p.requestId, { key, t0: Date.now() })
    }
    if (inflight.size > peak) peak = inflight.size
    if (current && inflight.size > current.peak) current.peak = inflight.size
    // 同源并发（浏览器对同一 origin 的 HTTP/1.1 连接数有上限，同源并发最能解释「卡」）
    try {
      const origin = new URL(url).origin
      let sameOrigin = 0
      for (const v of inflight.values()) {
        try { if (new URL(v.url).origin === origin) sameOrigin += 1 } catch { /* ignore */ }
      }
      if (!current) return
      if (!current.peakByOrigin) current.peakByOrigin = new Map()
      const prev = current.peakByOrigin.get(origin) || 0
      if (sameOrigin > prev) current.peakByOrigin.set(origin, sameOrigin)
    } catch { /* ignore */ }
  }))
  const finish = (p) => {
    if (p.sessionId && p.sessionId !== sid) return
    inflight.delete(p.requestId)
    const r = rec.get(p.requestId)
    if (!r) return
    rec.delete(p.requestId)
    const d = Date.now() - r.t0
    if (!durByBucket.has(r.key)) durByBucket.set(r.key, [])
    durByBucket.get(r.key).push(d)
  }
  unsubs.push(conn.on('Network.loadingFinished', finish))
  unsubs.push(conn.on('Network.loadingFailed', finish))

  await conn.send('Network.enable', {}, { sessionId: sid })

  const startPhase = (name, ms) => {
    current = { name, ms, total: 0, images: 0, xhr: 0, peak: 0, buckets: new Map(), urlCount: new Map(), t0: Date.now() }
    phases.push(current)
    return current
  }

  try {
    await page.goto(APP, { timeout: 60000 })

    // ---- A 首页静置 ----
    startPhase('A 首页静置', 20000)
    await sleep(20000)

    // ---- B 进 TG 面板静置 ----
    await realClick(page, '[data-testid="nav-tg"]')
    startPhase('B TG 面板静置（未选频道）', 30000)
    await sleep(30000)

    // ---- C 选第一个监控频道 ----
    let entered = ''
    try {
      await realClick(page, '[data-testid="tg-monitor-row"]')
      entered = '已进入首个监控频道'
    } catch (err) {
      entered = `未进入：${err.message}`
    }
    startPhase('C 监控频道消息流', 30000)
    await sleep(30000)
    await page.screenshot(path.join(OUT, 'phase-c.png'))

    // ---- 汇总 ----
    const lines = []
    const all = { buckets: new Map(), urlCount: new Map() }
    for (const ph of phases) {
      const sec = ph.ms / 1000
      const inflightAtEnd = [...inflight.values()].filter((v) => v.start >= ph.t0).length
      lines.push(`## ${ph.name}（${sec}s）`)
      lines.push(`总请求=${ph.total} 速率=${(ph.total / sec).toFixed(2)}/s 其中 Image=${ph.images} XHR/Fetch=${ph.xhr} 并发峰值=${ph.peak} 阶段末仍在飞=${inflightAtEnd}`)
      if (ph.peakByOrigin) {
        const byO = [...ph.peakByOrigin.entries()].map(([o, v]) => `${o.replace('http://127.0.0.1:', ':')}=${v}`).join(' ')
        lines.push(`同源并发峰值: ${byO}`)
      }
      const top = [...ph.buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      for (const [k, v] of top) lines.push(`  ${String(v).padStart(5)}x  ${k}`)
      lines.push('')
      for (const [k, v] of ph.buckets) all.buckets.set(k, (all.buckets.get(k) || 0) + v)
      for (const [k, v] of ph.urlCount) all.urlCount.set(k, (all.urlCount.get(k) || 0) + v)
    }
    const totalReq = phases.reduce((s, p) => s + p.total, 0)
    const totalSec = phases.reduce((s, p) => s + p.ms, 0) / 1000
    lines.push('## 合计')
    lines.push(`总请求=${totalReq} 平均速率=${(totalReq / totalSec).toFixed(2)}/s 全程并发峰值=${peak} 阶段说明：${entered}`)
    lines.push('')
    lines.push('## 同 URL 重复次数 Top 10（重复 = 可能缺缓存/缺去重）')
    const dup = [...all.urlCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    for (const [u, v] of dup) lines.push(`  ${String(v).padStart(5)}x  ${u.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}`)
    lines.push('')
    lines.push('## 全阶段路径分桶 Top 20')
    for (const [k, v] of [...all.buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      lines.push(`  ${String(v).padStart(5)}x  ${k}`)
    }

    lines.push('')
    lines.push('## 每类请求耗时（ms，requestWillBeSent → 完成；含排队时间）')
    const q = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b)
      return s[Math.min(s.length - 1, Math.floor(s.length * p))]
    }
    const durRows = [...durByBucket.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 14)
    lines.push('  次数  中位   p95   最大   路径')
    for (const [k, arr] of durRows) {
      lines.push(`  ${String(arr.length).padStart(4)}  ${String(q(arr, 0.5)).padStart(5)}  ${String(q(arr, 0.95)).padStart(5)}  ${String(Math.max(...arr)).padStart(5)}  ${k}`)
    }

    const out = lines.join('\n')
    fs.writeFileSync(path.join(OUT, 'result.txt'), `${out}\n`, 'utf8')
    console.log(out)
  } finally {
    for (const u of unsubs) { try { u() } catch { /* ignore */ } }
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error(`STORM DIAG CRASH: ${err && err.stack || err}`)
  process.exit(1)
})
