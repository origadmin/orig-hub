'use strict'

/**
 * BUG-138 验收：`media:list` 条目列表读缓存。
 *
 * 缺陷：`fetchCache.cacheKey` 未覆盖条目列表，`MediaLibraryPanel.loadItems` 每次
 * 进出 items 视图都发真请求（无在途合并、无结果缓存），而同面板的 stats / tags /
 * 剧集列表都有读缓存 —— 同一面板两套数据策略，且条目列表是最高频消费的那一个。
 *
 * ## 判据（每条都必须能 FAIL，附反向证伪）
 *
 *   A. **缓存命中**：同一查询条件下二次进入 items 视图，请求数**不增**。
 *      反向证伪：把 `cached(...)` 去掉，本判据的第二次进入会多发 1 次 ⇒ FAIL。
 *   B. **在途合并**：首次进入（含 StrictMode effect 双调用）只发 **1** 次。
 *      反向证伪：无 `cached()` 时双调用 = 2 次请求 ⇒ FAIL。
 *   C. **失效后重取**（反向证伪的核心）：用产品代码里**真正那个**
 *      `invalidateCache(cacheKey.mediaListPrefix())` 作废后，再进 items 视图
 *      必须**重新发一次请求**。前缀写错 / 与实际键不匹配 ⇒ 不重发 ⇒ FAIL。
 *   D. **键的正确性**（真实模块，非复刻）：
 *      D1 页面里 `peek(mediaList(mediaListParams(面板当前查询)))` 必须命中
 *          ⇒ 同时证明「动态 import 拿到的是同一个模块实例」且「键公式与面板用的完全一致」。
 *      D2 等价查询（缺省 limit vs 显式 limit=60、空串 kind vs 缺省）同键；
 *          任一筛选维度不同则不同键。
 *      D3 `mediaListPrefix()` 只清 media:list 一族，**不动** seriesList / tagList /
 *          libraryStats / tgDiag（过度失效会让 BUG-239 的缓存白做）。
 *
 * ## 为什么全程只读
 *
 * 后端是**用户真实库**（`127.0.0.1:19787`，480 条 / 76 标签，见 verify/lib/sandbox.cjs
 * 对生产写入的防线）。判据 C 需要「变更 → 失效 → 重取」，但**不需要真的写库**：
 * 直接调用产品代码里那个失效函数即可 —— 它若写错前缀，C 就会 FAIL。
 * 故本脚本零写入、零建剧集、零改标签，绝不碰用户数据。
 *
 * 前置：orig-daemon 19786 / orig-tg 19787 / vite dev 5180（AGENTS.md §4.1 的规范源）。
 * 用法：node tauri-shell/verify/verify_bug138_media_list_cache.cjs
 * 产物：verify_shots/bug-138/result.json（**证据产物不入库**，AGENTS.md §6）。
 */

const path = require('node:path')
const fs = require('node:fs')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180'
const OUT_DIR =
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'bug-138')
const TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** 面板当前（默认）查询在 `MediaLibraryPanel.loadItems` 里的真实形状。 */
const PANEL_QUERY = {
  kind: '',
  q: undefined,
  tagId: undefined,
  unassigned: false,
  sort: 'recent',
  limit: 120,
  offset: 0,
}

/** 在页面里装一个 fetch 计数器（只数条目列表请求）。 */
const INSTALL_COUNTER = () => {
  window.__bug138 = { list: 0, urls: [] }
  const orig = window.fetch.bind(window)
  window.fetch = function patched(input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url
      if (typeof url === 'string' && /\/api\/media\/items(\?|$)/.test(url)) {
        window.__bug138.list += 1
        if (window.__bug138.urls.length < 40) window.__bug138.urls.push(url)
      }
    } catch {
      /* 计数失败不得影响被测应用 */
    }
    return orig(input, init)
  }
  return true
}

const READ_COUNTER = () => ({ list: window.__bug138.list, urls: window.__bug138.urls.slice() })

/** 点一个 `data-testid` 锚点。 */
const CLICK = sel => {
  const el = document.querySelector(sel)
  if (!el) return false
  el.click()
  return true
}

const CARDS = () => document.querySelectorAll('[data-testid="media-card"]').length

/**
 * 动态 import **应用自己那份** fetchCache / api-media 模块。
 *
 * 必须走 `performance.getEntriesByType('resource')` 查出的**完整 URL（含 vite 的
 * `?t=<HMR 时间戳>`）**：直接 `import('/src/lib/fetchCache.ts')`（无 query）会拿到
 * **另一个模块实例** —— ES module registry 按完整 URL 缓存，两条 URL 是两个实例，
 * 于是本脚本改的是一份没被应用使用的缓存，断言会假失败（实测 D1/C 就是这么假的）。
 * 取应用真实 URL ⇒ 改的就是应用正在用的那份。
 */
const RESOLVE_MODULES = async () => {
  const names = performance.getEntriesByType('resource').map(e => e.name)
  const pick = re => names.find(n => re.test(n))
  const fcUrl = pick(/\/src\/lib\/fetchCache\.ts/)
  const mediaUrl = pick(/\/src\/api\/media\.ts/)
  if (!fcUrl || !mediaUrl) throw new Error(`cannot locate app modules: ${JSON.stringify(names)}`)
  const fc = await import(fcUrl)
  const media = await import(mediaUrl)
  return { fc, media }
}

/** 进入 items 视图（点左栏「全部」分类按钮 = `setView('items')`）。 */
async function enterItems(page) {
  const ok = await page.evaluate(CLICK, '[data-testid="media-cat-all"]')
  if (!ok) throw new Error('media-cat-all not found (media panel not rendered?)')
  await page.waitForFunction(CARDS, { timeout: TIMEOUT_MS, intervalMs: 150 })
  // loadItems 有 250ms 防抖；再留一点余量让请求落地
  await sleep(600)
}

/** 离开 items 视图（回剧集墙）。 */
async function leaveItems(page) {
  const ok = await page.evaluate(CLICK, '[data-testid="media-rail-series-all"]')
  if (!ok) throw new Error('media-rail-series-all not found')
  await sleep(500)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  let exitCode = 0
  try {
    const page = await browser.newPage()

    // 装计数器必须在**进入媒体库之前** —— 首屏就会打 stats/tags，但条目列表请求
    // 只在进入 items 视图时发，故此处安装仍能拿到干净的起点。
    await page.goto(APP_URL, { timeout: TIMEOUT_MS, waitForRoot: true, settleMs: 1500 })
    await page.evaluate(INSTALL_COUNTER)

    // ---- 进入媒体库面板 ----
    const opened = await page.evaluate(CLICK, '[data-testid="nav-media"]')
    if (!opened) throw new Error('nav-media not found')
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="media-panel-title"]')),
      { timeout: TIMEOUT_MS, intervalMs: 200 },
    )
    await sleep(800) // 等 stats/tags 探活落定（这些不是被测请求）

    const baseline = await page.evaluate(READ_COUNTER)
    check(
      'baseline: no item-list request before entering items view',
      baseline.list === 0,
      `list=${baseline.list}`,
    )

    // ================= A + B：首次进入 = 1 次 =================
    await enterItems(page)
    const first = await page.evaluate(READ_COUNTER)
    check(
      'B  first entry issues exactly ONE /api/media/items request',
      first.list === 1,
      `list=${first.list} urls=${JSON.stringify(first.urls)}`,
    )
    const cardsFirst = await page.evaluate(CARDS)
    check('B  items view really rendered cards (not an empty/error state)', cardsFirst > 0, `cards=${cardsFirst}`)

    // ================= A：切走再回，必须命中缓存（零新请求） =================
    await leaveItems(page)
    await enterItems(page)
    const second = await page.evaluate(READ_COUNTER)
    check(
      'A  cache hit: re-entering items view issues NO new request',
      second.list === first.list,
      `before=${first.list} after=${second.list} (delta must be 0)`,
    )
    const cardsSecond = await page.evaluate(CARDS)
    check(
      'A  re-entered items view still shows the list (cache hit, not a blank view)',
      cardsSecond > 0,
      `cards=${cardsSecond}`,
    )

    // ================= B2：在途合并（直接打真实模块，不靠 UI 巧合） =================
    // UI 上「首次进入只发 1 次」**证明不了**在途合并：`loadItems` 有 250ms 防抖，
    // StrictMode 的 effect 双调用被 `clearTimeout` 吃掉了（实测去掉缓存后仍是 1 次）。
    // 故这里直接对**应用那份** fetchCache 发两次并发 `cached()`，数 loader 跑了几次。
    const b2 = await page.evaluate(async () => {
      const pick = re =>
        performance.getEntriesByType('resource').map(e => e.name).find(n => re.test(n))
      const fc = await import(pick(/\/src\/lib\/fetchCache\.ts/))
      const media = await import(pick(/\/src\/api\/media\.ts/))
      const key = fc.cacheKey.mediaList(media.mediaListParams({ sort: 'size', q: '__bug138_inflight__' }))
      fc.invalidateCache(key)
      let loads = 0
      const loader = async () => {
        loads += 1
        await new Promise(r => setTimeout(r, 250))
        return { items: [], total: 0 }
      }
      const [a, b] = await Promise.all([fc.cached(key, loader), fc.cached(key, loader)])
      const afterConcurrent = loads
      // 再打一次已解析的键 ⇒ 必须零次 loader（结果缓存）
      await fc.cached(key, loader)
      return { afterConcurrent, afterRepeat: loads, sameRef: a === b }
    })
    check(
      'B2 in-flight merge: two concurrent cached() calls run the loader ONCE',
      b2.afterConcurrent === 1 && b2.sameRef,
      `loaderRuns=${b2.afterConcurrent} samePromiseResult=${b2.sameRef}`,
    )
    check(
      'B2 result cache: a later cached() on the resolved key runs the loader ZERO more times',
      b2.afterRepeat === 1,
      `loaderRuns=${b2.afterRepeat}`,
    )

    // ================= D1：真实模块的键必须与面板用的完全一致 =================
    // `peek(...)` 命中 ⇒ ① 动态 import 拿到的是**同一个模块实例**，② 键公式一致。
    const d1 = await page.evaluate(async () => {
      const pick = re =>
        performance.getEntriesByType('resource').map(e => e.name).find(n => re.test(n))
      const fc = await import(pick(/\/src\/lib\/fetchCache\.ts/))
      const media = await import(pick(/\/src\/api\/media\.ts/))
      const key = fc.cacheKey.mediaList(
        media.mediaListParams({
          kind: '',
          q: undefined,
          tagId: undefined,
          unassigned: false,
          sort: 'recent',
          limit: 120,
          offset: 0,
        }),
      )
      const hit = fc.peek(key)
      return {
        key,
        hit: hit !== undefined,
        itemCount: hit && hit.items ? hit.items.length : -1,
        total: hit ? hit.total : -1,
      }
    })
    check(
      'D1 real module: peek(mediaList(mediaListParams(panel query))) hits the panel cache',
      d1.hit,
      `key=${d1.key} cachedItems=${d1.itemCount} total=${d1.total}`,
    )

    // ================= D2：键的等价 / 区分语义 =================
    const d2 = await page.evaluate(async () => {
      const pick = re =>
        performance.getEntriesByType('resource').map(e => e.name).find(n => re.test(n))
      const fc = await import(pick(/\/src\/lib\/fetchCache\.ts/))
      const media = await import(pick(/\/src\/api\/media\.ts/))
      const K = q => fc.cacheKey.mediaList(media.mediaListParams(q))
      return {
        // 等价：缺省 limit（后端默认 60）与显式 60 是同一次请求 ⇒ 必须同键
        defaultedVsExplicit: K({ sort: 'recent' }) === K({ sort: 'recent', limit: 60 }),
        emptyKindVsAbsent: K({ kind: '', sort: 'recent' }) === K({ sort: 'recent' }),
        // 区分：任一筛选维度不同 ⇒ 不同键
        differsBySort: K({ sort: 'recent' }) !== K({ sort: 'title' }),
        differsByTag: K({ tagId: 1 }) !== K({ tagId: 2 }),
        differsByTagVsNone: K({ tagId: 1 }) !== K({}),
        differsByKind: K({ kind: 'video' }) !== K({ kind: 'photo' }),
        differsBySearch: K({ q: 'a' }) !== K({ q: 'b' }),
        differsByUnassigned: K({ unassigned: true }) !== K({}),
        differsBySeries: K({ seriesId: 7 }) !== K({}),
        differsByOffset: K({ offset: 0 }) !== K({ offset: 120 }),
      }
    })
    check('D2 equivalent queries share one key (defaulted limit / empty kind)', d2.defaultedVsExplicit && d2.emptyKindVsAbsent, JSON.stringify(d2))
    check(
      'D2 every filter dimension yields a distinct key',
      d2.differsBySort && d2.differsByTag && d2.differsByTagVsNone && d2.differsByKind &&
        d2.differsBySearch && d2.differsByUnassigned && d2.differsBySeries && d2.differsByOffset,
      JSON.stringify(d2),
    )

    // ================= D3：前缀只清 media:list 一族 =================
    const d3 = await page.evaluate(async () => {
      const pick = re =>
        performance.getEntriesByType('resource').map(e => e.name).find(n => re.test(n))
      const fc = await import(pick(/\/src\/lib\/fetchCache\.ts/))
      const media = await import(pick(/\/src\/api\/media\.ts/))
      // 预置：media:list 两份 + 四个旁系 key
      fc.cached(fc.cacheKey.mediaList(media.mediaListParams({ sort: 'recent' })), async () => ({ items: [1], total: 1 }))
      fc.cached(fc.cacheKey.mediaList(media.mediaListParams({ sort: 'title' })), async () => ({ items: [2], total: 2 }))
      fc.cached(fc.cacheKey.seriesList(null), async () => ['s'])
      fc.cached(fc.cacheKey.seriesDetail(1), async () => 'd')
      fc.cached(fc.cacheKey.tagList(), async () => ['t'])
      fc.cached(fc.cacheKey.libraryStats(), async () => ({ items: 1 }))
      fc.cached(fc.cacheKey.tgDiag(), async () => ({ available: true }))
      await new Promise(r => setTimeout(r, 0))

      fc.invalidateCache(fc.cacheKey.mediaListPrefix())

      return {
        recentGone: fc.peek(fc.cacheKey.mediaList(media.mediaListParams({ sort: 'recent' }))) === undefined,
        titleGone: fc.peek(fc.cacheKey.mediaList(media.mediaListParams({ sort: 'title' }))) === undefined,
        seriesListKept: fc.peek(fc.cacheKey.seriesList(null)) !== undefined,
        seriesDetailKept: fc.peek(fc.cacheKey.seriesDetail(1)) !== undefined,
        tagListKept: fc.peek(fc.cacheKey.tagList()) !== undefined,
        statsKept: fc.peek(fc.cacheKey.libraryStats()) !== undefined,
        tgDiagKept: fc.peek(fc.cacheKey.tgDiag()) !== undefined,
      }
    })
    check(
      'D3 mediaListPrefix() evicts ALL media:list keys (both filter combos)',
      d3.recentGone && d3.titleGone,
      JSON.stringify(d3),
    )
    check(
      'D3 mediaListPrefix() does NOT touch seriesList / seriesDetail / tagList / libraryStats / tgDiag',
      d3.seriesListKept && d3.seriesDetailKept && d3.tagListKept && d3.statsKept && d3.tgDiagKept,
      JSON.stringify(d3),
    )

    // ============ C（核心反向证伪）：用产品代码里真正那个失效函数作废后，必须重取 ============
    // D3 步骤**已经**作废了 media:list。先切走再切回，让 D3 的失效**单独**可观测：
    // 若 `mediaListPrefix()` 写错前缀（够不到面板真正用的那个键），这一步 delta 会是 0。
    // 注意必须先 `leaveItems`：items→items 时 `setView('items')` 是空操作，
    // effect 不重跑 ⇒ `loadItems` 压根不会被调用（那会让本判据假通过）。
    await leaveItems(page)
    await enterItems(page) // 缓存已被 D3 清空 ⇒ 这次应发出新请求
    const afterD3 = await page.evaluate(READ_COUNTER)
    check(
      'C  setup: after D3 eviction, re-entry re-fetches (proves eviction reached the live read path)',
      afterD3.list === second.list + 1,
      `before=${second.list} after=${afterD3.list} (delta must be 1)`,
    )

    await leaveItems(page) // 此刻不刷新 ⇒ 缓存里那份仍在
    const beforeC = await page.evaluate(READ_COUNTER)

    // 显式调用**产品代码用的同一个函数**（不是本脚本自造的失效逻辑）
    const invalidated = await page.evaluate(async () => {
      const pick = re =>
        performance.getEntriesByType('resource').map(e => e.name).find(n => re.test(n))
      const fc = await import(pick(/\/src\/lib\/fetchCache\.ts/))
      const media = await import(pick(/\/src\/api\/media\.ts/))
      fc.invalidateCache(fc.cacheKey.mediaListPrefix())
      return (
        fc.peek(
          fc.cacheKey.mediaList(
            media.mediaListParams({ kind: '', sort: 'recent', limit: 120, offset: 0 }),
          ),
        ) === undefined
      )
    })
    check('C  invalidateCache(cacheKey.mediaListPrefix()) actually dropped the panel key', invalidated === true)

    await enterItems(page)
    const afterC = await page.evaluate(READ_COUNTER)
    check(
      'C  invalidation -> re-entry DOES re-request (stale list is impossible)',
      afterC.list === beforeC.list + 1,
      `before=${beforeC.list} after=${afterC.list} (delta must be 1; 0 would mean a stale list survives a write)`,
    )

    const cardsC = await page.evaluate(CARDS)
    check('C  list still renders after invalidation', cardsC > 0, `cards=${cardsC}`)

    // ================= 顺带：面板无控制台错误 =================
    const errs = page.consoleErrors().filter(e => !/favicon|DevTools|React DevTools/i.test(e))
    check('no console errors in the media panel', errs.length === 0, errs.slice(0, 3).join(' | '))

    const shot = path.join(OUT_DIR, 'items-view-after-invalidation.png')
    await page.screenshot(shot)
    console.log(`\nscreenshot: ${shot}`)
  } catch (e) {
    check('verification script completed without throwing', false, String(e && e.stack ? e.stack : e))
  } finally {
    const failed = results.filter(r => !r.ok)
    const payload = {
      bug: 'BUG-138',
      app: APP_URL,
      at: new Date().toISOString(),
      total: results.length,
      failed: failed.length,
      checks: results,
    }
    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(payload, null, 2))
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
    console.log(`evidence: ${path.join(OUT_DIR, 'result.json')}`)
    exitCode = failed.length === 0 ? 0 : 1
    await browser.close()
  }
  process.exit(exitCode)
}

main()