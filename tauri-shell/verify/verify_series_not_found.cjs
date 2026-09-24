#!/usr/bin/env node
'use strict'

/**
 * 真实渲染验收：删除/合并剧集后，前端对「series not found」(404) 的处理。
 * 零依赖：仅用 Node 内置 `WebSocket` + `./lib/cdp.cjs`。
 *
 *  缺陷背景（BUG-159）：剧集被删/合并后，客户端若仍持有死 id 并再次导航到它，
 *  `openSeries(deadId)` 拿 404，旧代码只 `setError("series not found")` 后返回，
 *  于是裸报错 + 卡在 seriesDetail 视图。修复后应是：清死缓存、回退剧集墙、给出
 *  语义化提示「该系列已被删除或合并」，全程不出现裸 "series not found"。
 *
 *  确定性触发路径（经代码走查确认）：剧集墙仍含陈旧死卡时，用户点击该卡
 *  （SeriesCard.onOpen → openSeries(deadId) → 404）才会命中守卫回落逻辑；
 *  详情视图内「返回」走的是 onBack→loadSeries()，不会调用 openSeries(deadId)，
 *  因此本脚本刻意「不进详情、在墙层面删剧集、再点死卡」来真触发守卫。
 *
 *  反向证伪（本项目硬要求，两类失败严格分开）：
 *   1. 死端口 → UNREACHABLE(exit 2)：证脚本不是恒绿。
 *   2. `ORIG_VERIFY_REVERT=1`：守卫跑完后向 DOM 注入「该缺陷原本会裸抛的
 *      series not found」节点，跑同一套断言 → 必须 exit 1（断言翻转，证到缺陷
 *      真出现时本脚本会红）。
 *
 * Usage:
 *   node verify/verify_series_not_found.cjs
 *   APP_URL=http://127.0.0.1:59999 node verify/verify_series_not_found.cjs   # 证伪 1
 *   ORIG_VERIFY_REVERT=1 node verify/verify_series_not_found.cjs            # 证伪 2（期望 exit 1）
 *   ORIG_VERIFY_OUT=<临时目录> node verify/verify_series_not_found.cjs
 *
 * 前置：dev server (默认 5180) + 后端 9877 都已起（见 verify/README.md）。
 * Exit codes: 0 = 全部通过, 1 = 断言失败, 2 = 环境/通道问题。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const MEDIA_API = process.env.ORIG_MEDIA_API || 'http://127.0.0.1:9877'

// BUG-161 污染防线：本脚本会写后端（建/删剧集）；默认拒绝写生产实例（9877），
// 需显式 ORIG_VERIFY_ALLOW_PROD_WRITES=1 或改用隔离实例（见 verify/README.md §4）。
require('./lib/sandbox.cjs').guardWrites('verify_series_not_found.cjs', MEDIA_API)
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-series-not-found')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
const STEP_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_STEP_TIMEOUT || 20000)

/** 自证伪开关：守卫跑完后向 DOM 注入「该缺陷会裸抛的 series not found」，期望本脚本转红。 */
const REVERT_TO_PRE_FIX = process.env.ORIG_VERIFY_REVERT === '1'

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -- ${item.detail || 'n/a'}`}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`[verify:series-nf] ${results.length - failed}/${results.length} assertions passed`)
  return failed === 0 ? 0 : 1
}

function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

function parseHostPort(urlStr) {
  const u = new URL(urlStr)
  return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }
}

/** GET/POST/DELETE 的 JSON 封装（仅回环，server-to-server 不受浏览器 CORS 约束）。 */
function httpJson(method, url, body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = http.request(
      url,
      { method, timeout: timeoutMs, headers },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(raw)
          } catch (_e) {
            /* ignore */
          }
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null })
    })
    if (data) req.write(data)
    req.end()
  })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 按 data-testid 点击（项目约定：导航一律 testid）。返回是否点到了。
 * 比文本匹配更稳：外层容器/侧栏会把 nav 文案包成祖先 div，裸 `.click()` 点到
 * 祖先不会触发内部 button 的 onClick（事件不向下冒泡）。
 */
async function clickTestId(page, testid) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
}

/**
 * 在剧集墙里按标题点开某张 SeriesCard。
 * 注意：SeriesCard 的 `data-testid="series-card"` 挂在**封面内层 button** 上，其
 * textContent 只有「查看/集」角标；标题 <p> 与按钮同属外层 root div。因此先定位
 * 含标题的 root（按钮的 parentElement），再点内层 button（onClick=onOpen→openSeries）。
 */
async function clickSeriesCardByText(page, text) {
  return page.evaluate((t) => {
    const norm = (s) => (s || '').trim().toLowerCase()
    const target = norm(t)
    const roots = Array.from(document.querySelectorAll('[data-testid="series-card"]'))
      .map((btn) => btn.parentElement)
      .filter(Boolean)
    const root = roots.find((r) => norm(r.textContent).includes(target))
    if (!root) return false
    const btn = root.querySelector('[data-testid="series-card"]')
    if (!btn) return false
    btn.click()
    return true
  }, text)
}

/** 页面可见文本是否包含子串。 */
async function bodyContains(page, sub) {
  const text = await page.evaluate(() => document.body.innerText)
  return text.includes(sub)
}

async function main() {
  // ---------- 门禁 1：死端口预检（证非恒绿） ----------
  const app = parseHostPort(APP_URL)
  if (!(await tcpProbe(app.host, app.port))) {
    console.error(`[verify:series-nf] dev server unreachable: ${APP_URL}`)
    console.error('[verify:series-nf] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  }
  const api = parseHostPort(MEDIA_API + '/')
  if (!(await tcpProbe(api.host, api.port))) {
    console.error(`[verify:series-nf] media api unreachable: ${MEDIA_API}`)
    console.error('[verify:series-nf] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  }

  // ---------- 准备：经后端建一个剧集（拿真实 id） ----------
  const title = `VerifySeriesNF_${Date.now()}`
  const created = await httpJson('POST', `${MEDIA_API}/api/media/series`, { title })
  if (!created.json || typeof created.json.id !== 'number') {
    console.error(`[verify:series-nf] 创建剧集失败: ${JSON.stringify(created)}`)
    process.exit(2)
  }
  const seriesId = created.json.id
  console.log(`[verify:series-nf] created series id=${seriesId} title="${title}"`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    // 默认视图是「下载」，先进媒体库（MediaLibraryPanel 落地视图=剧集墙）。
    await page.goto(APP_URL, { timeout: NAV_TIMEOUT_MS })
    const navOk = await clickTestId(page, 'nav-media')
    check('进入媒体库面板', navOk, navOk ? '' : '未找到 nav-media 导航项')
    if (!navOk) return dumpResults()

    // 剧集墙已挂载（rail 标签「剧集」出现）。
    const wallMounted = await page
      .waitForFunction(() => /剧集/.test(document.body.innerText), { timeout: STEP_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    check('剧集墙已挂载', wallMounted)

    // 让墙重新拉取，把刚建的剧集显示出来：刷新 + 再进媒体库（mount 即 loadSeries）。
    await page.goto(APP_URL, { timeout: NAV_TIMEOUT_MS })
    await clickTestId(page, 'nav-media')
    const cardShown = await page
      .waitForFunction((t) => document.body.innerText.includes(t), {
        timeout: STEP_TIMEOUT_MS,
        args: [title],
      })
      .then(() => true)
      .catch(() => false)
    check('剧集墙渲染出新建剧集卡片', cardShown, cardShown ? '' : `未渲染「${title}」`)
    if (!cardShown) return dumpResults()

    // 在墙仍含陈旧死卡时，从后端删除该剧集（模拟外部删除/合并）。
    const delStatus = await httpJson('DELETE', `${MEDIA_API}/api/media/series/${seriesId}`)
    check('后端删除剧集成功', delStatus.status === 200, `status=${delStatus.status}`)

    // 点击死卡 → openSeries(deadId) → 404 → 守卫回落（清死缓存 + 退回墙 + 语义提示）。
    const clicked = await clickSeriesCardByText(page, title)
    check('点击陈旧死卡触发导航', clicked, clicked ? '' : `未找到含「${title}」的卡片`)
    if (!clicked) return dumpResults()

    // 守卫的 setError 会弹 toast（4s 自动消失），需在窗口内尽早断言。
    await delay(400)
    const friendly =
      (await bodyContains(page, '已返回剧集列表')) || (await bodyContains(page, '已被删除或合并'))
    check('给出语义化提示（该系列已被删除或合并）', friendly)

    // 守卫跑了 loadSeries() 重新拉墙（已同时作废列表缓存）→ 死卡应从剧集墙移除。
    // 只数「剧集墙里的 series-card」，不扫整页（侧栏「最近」等独立列表不在本缺陷范围）。
    const cardGone = await page
      .waitForFunction(
        (t) => {
          const norm = (s) => (s || '').trim().toLowerCase()
          const tg = norm(t)
          const roots = Array.from(document.querySelectorAll('[data-testid="series-card"]'))
            .map((b) => b.parentElement)
            .filter(Boolean)
          return roots.filter((r) => norm(r.textContent).includes(tg)).length === 0
        },
        { timeout: STEP_TIMEOUT_MS, args: [title] },
      )
      .then(() => true)
      .catch(() => false)
    check('回退后剧集墙不再列出死卡', cardGone, cardGone ? '' : `墙仍含「${title}」`)

    // 门禁 2：注入「该缺陷原本会裸抛的 series not found」，验证断言会翻转。
    if (REVERT_TO_PRE_FIX) {
      await page.evaluate(() => {
        const d = document.createElement('div')
        d.id = 'revert-injected-series-nf'
        d.textContent = 'series not found'
        document.body.appendChild(d)
      })
    }

    const rawLeak = await bodyContains(page, 'series not found')
    check('全程不裸抛 series not found', !rawLeak, rawLeak ? '页面出现裸 "series not found"' : '')

    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
  } finally {
    await browser.close()
    // 清理：若中途异常导致未删干净，再删一次（幂等，忽略失败）。
    try {
      await httpJson('DELETE', `${MEDIA_API}/api/media/series/${seriesId}`)
    } catch (_e) {
      /* ignore */
    }
  }

  const code = dumpResults()
  console.log(`[verify:series-nf] RESULT: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code})`)

  // 产物落仓外临时目录（AGENTS.md §6 污染防线），绝不在仓库内留文件。
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(OUT_DIR, 'result.json'),
      JSON.stringify(
        {
          name: 'verify:series-nf',
          exitCode: code,
          seriesId,
          title,
          passed: results.filter((r) => r.ok).length,
          total: results.length,
          results,
          reverted: REVERT_TO_PRE_FIX,
          at: new Date().toISOString(),
          method: 'cdp headless (edge/chrome) real render',
        },
        null,
        2,
      ),
    )
  } catch (_e) {
    /* 证据落盘失败不影响验收结论 */
  }

  process.exit(code)
}

main().catch((err) => {
  console.error(`[verify:series-nf] FATAL: ${err && err.message ? err.message : err}`)
  process.exit(2)
})
