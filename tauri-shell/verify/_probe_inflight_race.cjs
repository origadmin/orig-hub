#!/usr/bin/env node
'use strict'

/**
 * 探针（临时，提交前删）：确定性证实 fetchCache 的「在途竞态」。
 *
 * 假设：`invalidateCache(prefix)` 只清 resolved、不清 inflight；在途 loader 解析后
 * 无条件 `resolved.set(key, v)` ⇒ 失效后旧数据仍会落进缓存（甚至覆盖新数据）。
 *
 * 步骤（全部打应用自己那份模块，与 bug138 同一手法）：
 *   1. 对某 key 发起一个**人工 stall** 的 cached()（loader 不 resolve）；
 *   2. invalidateCache(mediaListPrefix())（写操作落地）；
 *   3. resolve loader（在途请求返回 —— 带回的是写前数据）；
 *   4. peek(key) —— 修复态必须是 undefined；若拿到值 ⇒ 竞态属实。
 *   附带 5：失效后第二次 cached() 是否复用仍在途的旧 promise（不重发）。
 */

const path = require('node:path')
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const RESOLVE = () => {
  window.__probeResolve = async () => {
    const names = performance.getEntriesByType('resource').map(e => e.name)
    const pick = re => names.find(n => re.test(n))
    const fcUrl = pick(/\/src\/lib\/fetchCache\.ts/)
    const mediaUrl = pick(/\/src\/api\/media\.ts/)
    if (!fcUrl || !mediaUrl) throw new Error(`cannot locate app modules: ${JSON.stringify(names)}`)
    return { fc: await import(fcUrl), media: await import(mediaUrl) }
  }
  return true
}

async function main() {
  const ep = await endpoints.resolve()
  console.log(`[probe] app=${ep.app}`)
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(ep.app, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => /\/src\/lib\/fetchCache\.ts/.test(e.name)), { timeout: 30000 })
    await page.evaluate(RESOLVE)

    const out = await page.evaluate(async () => {
      const { fc, media } = await window.__probeResolve()
      const key = fc.cacheKey.mediaList(media.mediaListParams({ sort: 'recent', limit: 60, offset: 0, q: '__probe_inflight__' }))
      let release = null
      const stalled = new Promise(r => { release = r })
      let loaderRuns = 0
      const loader = async () => { loaderRuns += 1; await stalled; return { items: ['STALE-PRE-WRITE'], total: 1 } }
      const p1 = fc.cached(key, loader) // 在途（stall）
      const inflightReuse = fc.cached(key, loader) // 在途合并：同一个 promise，不重发
      fc.invalidateCache(fc.cacheKey.mediaListPrefix()) // 写操作落地（前缀失效）
      release() // 在途请求返回（写前数据）
      await p1
      await new Promise(r => setTimeout(r, 50))
      const afterLateResolve = fc.peek(key)
      // 失效后再读一次：修复态应重新发起 loader（拿到新数据），
      // 竞态态则直接拿到写前旧数据且 loader 不重跑。
      const p2 = fc.cached(key, loader)
      const v2 = await p2
      return {
        loaderRuns,
        inflightReuseSamePromise: p1 === inflightReuse,
        staleSurvivesInvalidation: afterLateResolve !== undefined,
        staleValue: afterLateResolve,
        secondReadValue: v2,
        secondReadLoaderRuns: loaderRuns,
      }
    })
    console.log('[probe] result:', JSON.stringify(out, null, 2))
    const race = out.staleSurvivesInvalidation === true
    console.log(race ? '[probe] RACE CONFIRMED: pre-write data lands in cache after prefix invalidation' : '[probe] no race: late in-flight resolution did not repopulate')
    process.exitCode = race ? 3 : 0
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('[probe] ERROR', e && e.message ? e.message : e); process.exit(1) })
