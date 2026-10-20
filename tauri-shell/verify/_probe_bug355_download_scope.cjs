'use strict'
/**
 * BUG-355 验收探针：下载域「普通下载不受影响」谎报 + 默认下载目录 "/"
 * ----------------------------------------------------------------------------
 * 复现并验证错误范围横幅的真实语义：
 *   旧逻辑把 `Download` 源 `available` 写死 true，且前端写死「（普通下载不受影响）」，
 *   于是「服务全挂 / 下载根非法」时界面仍谎称下载正常 —— 用户实测全 outage 下所有任务
 *   失败，但横幅写死下载不受影响（逻辑不自恰）。
 *
 * 复现手段：用 CDP `Page.addScriptToEvaluateOnNewDocument` 注入常驻脚本，把
 * `/api/activity` 的请求改写成我们控制的 `sources` 形态（其余请求放行），跑的是真实
 * app 代码、真实 React 渲染。两种形态：
 *   - cache-down：仅 cache 源不可用、download 源可用 ⇒ 横幅应只报 TG，且不得含
 *     「普通下载不受影响」这一写死的谎。
 *   - both-down：两源均不可用 ⇒ 横幅应如实报「TG 入库与普通下载均不可用」。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')

const BASE = process.env.VITE_URL || 'http://127.0.0.1:5180/'
const SHOT_DIR = path.resolve(__dirname, '..', 'verify_shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const results = []
function check(name, cond, detail) {
  const ok = !!cond
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`)
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function navigateWithRetry(page, url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { timeoutMs: 90000, waitForRoot: false, settleMs: 0 })
      return
    } catch (e) {
      if (i === tries - 1) throw e
      await delay(3000)
    }
  }
}

// 拦截 /api/activity，返回指定 sources 形态；mode: 'cache-down' | 'both-down'
function activityInterceptorSource(mode) {
  return `(${function (mode) {
    const orig = window.fetch ? window.fetch.bind(window) : null
    window.__origFetch = orig
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/api/activity') !== -1) {
        const sources =
          mode === 'both-down'
            ? [
                { kind: 'download', available: false, error: '下载根目录无效或不可写（检查设置中的下载目录）', count: 0 },
                { kind: 'cache', available: false, error: 'request orig-tg: connection refused', count: 0 },
              ]
            : [
                { kind: 'download', available: true, error: null, count: 0 },
                { kind: 'cache', available: false, error: 'request orig-tg: connection refused', count: 0 },
              ]
        const body = JSON.stringify({ tasks: [], sources, generated_at: Math.floor(Date.now() / 1000) })
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }
      return orig ? orig(input, init) : Promise.reject(new Error('no-fetch'))
    }
  }})(${JSON.stringify(mode)})`
}

async function runScenario(browser, mode) {
  const page = await browser.newPage()
  await page.conn.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: activityInterceptorSource(mode) },
    { sessionId: page.sessionId },
  )
  await navigateWithRetry(page, BASE)
  const sStart = Date.now()
  while (Date.now() - sStart < 25000) {
    if (await page.evaluate(() => !!window.__origStore)) break
    await delay(300)
  }
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  const bStart = Date.now()
  let text = ''
  while (Date.now() - bStart < 20000) {
    text = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dl-tg-unavailable"]')
      return el ? el.textContent || '' : ''
    })
    if (text) break
    await delay(300)
  }
  await page.screenshot(path.join(SHOT_DIR, `bug355-${mode}.png`))
  return text
}

async function main() {
  const browser = await cdp.launch()
  try {
    const a = await runScenario(browser, 'cache-down')
    check('A: 出现入库不可用横幅', a.length > 0, a)
    check('A: 横幅说明 TG 入库无法读取', a.includes('TG 入库任务暂时无法读取'), a)
    check('A: 不再写死「普通下载不受影响」', !a.includes('普通下载不受影响'), a)

    const b = await runScenario(browser, 'both-down')
    check('B: 横幅如实报「TG 入库与普通下载均不可用」', b.includes('TG 入库与普通下载均不可用'), b)

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} (${results.length} checks) ===`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
