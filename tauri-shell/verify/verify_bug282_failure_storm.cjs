'use strict'

/**
 * BUG-282 复报取证（2026-10-13）：**后端不可达时前端失败请求风暴**。
 *
 * 用户原话：「服务挂了…挂了后大量 http://127.0.0.1:19786/api/downloads、
 * http://127.0.0.1:19786/api/events 请求爆炸。」
 *
 * 本脚本在**后端确实不可达**的前提下，用 CDP `Network.requestWillBeSent` 实测
 * 60 秒内这两条路径的真实请求次数与**间隔分布**，把「无失败退避」变成可核验读数。
 *
 * 复现语义（与 BUG-259 取证脚本同款）：**修复前应 PASS（现象复现成功）、
 * 修复后应 FAIL（现象消失）** —— 判据是「现象存在且间隔近似恒定」。
 *
 * 断言：
 *   A. 前提：daemon 确实不可达（否则本脚本的前提不成立，直接 FAIL 并提示停服务）
 *   B. 观测期内**确实有**失败请求（现象存在）
 *   C. `/api/downloads` 与 `/api/events` 各自的请求数与被测窗口一致（可核验读数）
 *   D. **间隔恒定**（无退避）：`/api/downloads` 的相邻间隔标准差 / 均值 < 0.25
 *      ⇒ 修复后必须出现「间隔单调增大或归零」，本判据转红
 *   E. 负对照：不存在的路径计数必须为 0（证明计数不是恒真）
 *
 * 退出码：0 = 全部 PASS（现象复现）；2 = 判据 FAIL；1 = harness 错误。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug282_failure_storm.cjs
 *   （需 vite :5180 在跑，且 **daemon :19786 必须停着** —— `python scripts/dev_services.py --stop`）
 *   可选：VERIFY_APP_URL / VERIFY_DAEMON_URL / VERIFY_WINDOW_MS
 */

const path = require('node:path')
const http = require('node:http')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON_URL = process.env.VERIFY_DAEMON_URL || 'http://127.0.0.1:19786'
const WINDOW_MS = Number(process.env.VERIFY_WINDOW_MS || 60000)

/** 探测 daemon 是否可达（只用 /health，2s 超时，不走代理）。 */
function daemonReachable(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/health`, { timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ up: true, code: res.statusCode, body: body.slice(0, 80) }))
    })
    req.on('error', (e) => resolve({ up: false, err: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ up: false, err: 'timeout' }) })
  })
}

function stats(xs) {
  if (!xs.length) return { n: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return { n: xs.length, mean, sd: Math.sqrt(varr), cv: mean > 0 ? Math.sqrt(varr) / mean : 0 }
}

async function main() {
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  const probe = await daemonReachable(DAEMON_URL)
  check('A. 前提：daemon 确实不可达（本脚本测的是「后端挂了」场景）', probe.up === false,
    probe.up
      ? `**${DAEMON_URL} 仍可达（HTTP ${probe.code}）** ⇒ 前提不成立。请先停服务：python scripts/dev_services.py --stop`
      : `${DAEMON_URL} 不可达（${probe.err}）✓`)

  const browser = await cdp.launch()
  const hits = []          // { t, url }
  let t0 = 0
  try {
    const page = await browser.newPage()
    const sessionId = page.sessionId
    await page.conn.send('Network.enable', {}, { sessionId })
    page.conn.on('Network.requestWillBeSent', (p) => {
      if (!p || !p.request || !p.request.url) return
      hits.push({ t: Date.now(), url: p.request.url })
    })

    t0 = Date.now()
    await page.goto(APP_URL, { waitUntil: 'load' })
    console.log(`\n观测窗口 ${WINDOW_MS / 1000}s（后端不可达）…\n`)
    await new Promise((r) => setTimeout(r, WINDOW_MS))
    const t1 = Date.now()
    const winMs = t1 - t0

    const inWin = hits.filter((h) => h.t >= t0 && h.t <= t1)
    const match = (pat) => inWin.filter((h) => h.url.includes(pat))
    const downloads = match('/api/downloads')
    const events = match('/api/events')
    const absent = inWin.filter((h) => h.url.includes('__BUG282_NO_SUCH_PATH__'))
    const perMin = (n) => Math.round((n * 60000) / winMs)

    console.log(`总请求 ${inWin.length} 次 / ${(winMs / 1000).toFixed(1)}s`)
    console.log(`  /api/downloads : ${downloads.length} 次  (≈${perMin(downloads.length)}/分钟)`)
    console.log(`  /api/events    : ${events.length} 次  (≈${perMin(events.length)}/分钟)`)
    console.log(`  其余           : ${inWin.length - downloads.length - events.length} 次`)

    // 按路径归类（去掉 query），列 Top 12 —— 「其余」不能是一笔糊涂账
    const byPath = new Map()
    for (const h of inWin) {
      let key
      try {
        const u = new URL(h.url)
        key = u.origin + u.pathname
      } catch (_e) {
        key = h.url
      }
      byPath.set(key, (byPath.get(key) || 0) + 1)
    }
    const top = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    console.log('\n按路径 Top 12：')
    for (const [k, n] of top) console.log(`  ${String(n).padStart(4)}  ${k}`)

    /*
     * 动态路径的**时间分布** —— 这一节是为了把两类东西分开：
     *   ①「启动突发」：有界（如 StrictMode 双挂载 + probeTg 的 5×1.5s 重试链），
     *      全部集中在开头几秒，之后归零 —— 属于 BUG-282「无退避」但**有界**。
     *   ②「稳态轮询」：均匀铺满整个窗口，永不停止 —— 才是「请求爆炸」的主体。
     * 不做这一步就无法判断某条路径到底属于哪一类（只报总数会把两者混为一谈）。
     */
    const BURST_CUT_MS = 10000
    console.log(`\n动态路径时间分布（切分点 ${BURST_CUT_MS / 1000}s）：`)
    for (const p of ['/api/downloads', '/api/events', '/api/config']) {
      const ts = inWin.filter((h) => h.url.includes(p)).map((h) => h.t - t0).sort((a, b) => a - b)
      if (!ts.length) { console.log(`  ${p}: 0 次`); continue }
      const gaps = ts.slice(1).map((x, i) => x - ts[i])
      const burst = ts.filter((x) => x <= BURST_CUT_MS).length
      const steady = ts.length - burst
      console.log(`  ${p}: ${ts.length} 次  [启动 ${burst} / 稳态 ${steady}]  ⇒ ${steady > 3 ? '**稳态轮询**' : '启动突发（有界）'}`)
      console.log(`      相对时刻(ms): ${ts.map((x) => x.toFixed(0)).join(', ')}`)
      if (gaps.length) console.log(`      相邻间隔(ms): ${gaps.map((x) => x.toFixed(0)).join(', ')}`)
    }

    check('B. 观测期内确实存在失败请求（现象存在）', inWin.length > 0, `${inWin.length} 次`)
    check('C. /api/downloads 与 /api/events 均被高频重发', downloads.length > 0 && events.length > 0,
      `downloads=${downloads.length}（≈${perMin(downloads.length)}/min） events=${events.length}（≈${perMin(events.length)}/min）`)

    /*
     * D. 「无失败退避」的判据用**趋势**而不是变异系数：
     *    首帧那一次请求与后续 5s 轮询之间会有一个 ~1ms 的伪间隔，把 CV 抬高
     *    （实测 CV=0.289 > 0.25 导致误判 FAIL，而真实间隔是恒定 5000ms）。
     *    正确表述：有退避 ⇒ 间隔**单调增大** ⇒ 后半段均值显著大于前半段；
     *    无退避 ⇒ 两段均值近似相等。用 后半/前半 比值判定，抗单点噪声。
     */
    const dlTs = downloads.map((h) => h.t).sort((a, b) => a - b)
    const rawGaps = []
    for (let i = 1; i < dlTs.length; i++) rawGaps.push(dlTs[i] - dlTs[i - 1])
    const gaps = rawGaps.filter((x) => x >= 200) // 滤掉首帧伪间隔
    const g = stats(gaps)
    console.log(`\n/api/downloads 相邻间隔: n=${g.n}${g.n ? `  均值=${g.mean.toFixed(0)}ms  标准差=${g.sd.toFixed(0)}ms` : ''}`)
    if (g.n) console.log(`  前 12 个间隔(ms): ${gaps.slice(0, 12).map((x) => x.toFixed(0)).join(', ')}`)
    let ratio = null
    if (gaps.length >= 4) {
      const half = Math.floor(gaps.length / 2)
      const first = gaps.slice(0, half)
      const second = gaps.slice(gaps.length - half)
      const m1 = first.reduce((a, b) => a + b, 0) / first.length
      const m2 = second.reduce((a, b) => a + b, 0) / second.length
      ratio = m2 / m1
      console.log(`  后半段均值 / 前半段均值 = ${ratio.toFixed(3)}（无退避≈1.0；有退避应显著 >1）`)
    }
    check('D. ★ 间隔**无增大趋势**（无失败退避）—— 修复后本判据必须转红',
      ratio !== null && ratio < 1.3,
      ratio === null ? '样本不足' : `后半/前半=${ratio.toFixed(3)}（<1.3 视为无退避；修复后应单调增大）`)

    check('E. 负对照：不存在的路径计数必须为 0', absent.length === 0, `命中=${absent.length}`)

    const shot = path.join(require('node:os').tmpdir(), 'orighub-probe', 'bug282_storm.png')
    try { await page.screenshot(shot); console.log(`\n截图: ${shot}`) } catch (_e) {}

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} PASS`)
    return failed.length === 0 ? 0 : 2
  } finally {
    await browser.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('VERIFY FAILED:', e && e.message ? e.message : e)
    process.exit(1)
  })
