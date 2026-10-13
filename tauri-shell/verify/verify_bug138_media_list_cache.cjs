'use strict'

/**
 * BUG-138 验收：`media:list` 条目列表读缓存。
 *
 * 缺陷：`fetchCache.cacheKey` 未覆盖条目列表，`MediaLibraryPanel.loadItems` 每次
 * 进出 items 视图都发真请求（无在途合并、无结果缓存），而同面板的 stats / tags /
 * 剧集列表都有读缓存 —— 同一面板两套数据策略，且条目列表是最高频消费的那一个。
 *
 * 修复：`loadItems` 走 `cached(cacheKey.mediaList(mediaListParams(query)), ...)`，
 * 写操作（编辑 / 删除 / 改标签 / 重缓存 / 封面回写 / `refreshAll`）失效 `media:list:*`。
 *
 * ## 判据（每条都必须能 FAIL，附反向证伪）
 *
 *   A. **缓存命中**：同一查询条件下二次进入 items 视图，请求数**不增**。
 *      反向证伪：把 `cached(...)` 去掉，本判据的第二次进入会多发 1 次 ⇒ FAIL。
 *   B. **首次进入只发 1 次**（含 StrictMode effect 双调用）。
 *   B2. **在途合并**：对应用那份 fetchCache 并发两次 `cached()`，loader 只跑 1 次。
 *   C. **失效后重取**（反向证伪的核心）：用产品代码里**真正那个**
 *      `invalidateCache(cacheKey.mediaListPrefix())` 作废后，再进 items 视图
 *      必须**重新发一次请求**。前缀写错 / 与实际键不匹配 ⇒ 不重发 ⇒ FAIL。
 *   D1. **键的正确性**（真实模块，非复刻）：页面里
 *      `peek(mediaList(mediaListParams(面板当前查询)))` 必须命中
 *          ⇒ 同时证明「动态 import 拿到的是同一个模块实例」且「键公式与面板用的完全一致」。
 *   D2. 等价查询（缺省 limit vs 显式 limit=60、空串 kind vs 缺省）同键；
 *       任一筛选维度不同则不同键。
 *   D3. `mediaListPrefix()` 只清 media:list 一族，**不动** seriesList / tagList /
 *       libraryStats / tgDiag（过度失效会让 BUG-239 的缓存白做）。
 *   E. **编辑后重开显示新值**（本轮新增，直击「改完又看到旧值」）：
 *      通过 UI 改夹具标题 → 保存 → E1 列表必须重取；离开再进入 → E2 卡片显示**新**标题。
 *      反向证伪：去掉 `refreshAll` 里的 `invalidateCache()` ⇒ E1/E2 FAIL。
 *
 * ## 为什么 A / D1 需要「干净窗口 + 有限重试」
 *
 * 这两条判据读的是「条目列表缓存此刻是否仍在」。而 `MediaLibraryPanel.onPosterReady`
 * （卡片封面抽帧回写后）会调用 `invalidateCache(cacheKey.mediaListPrefix())` ——
 * **任何一张卡片补封面都会把整族 media:list 作废**。这是产品的既定行为（注释里写了
 * 它会收敛：封面入库后不再产生写操作），在共享活栈上别人正在导入数据时，封面补写随时
 * 可能落进测量窗口，于是 A/D1 会**间歇性红**（实测：同一份代码连跑两次，一次
 * 16/17、一次 17/17，唯一差异就是这个）。
 *
 * 故本脚本：① 先用 raw/PATCH 计数等封面补写风暴**静止**；② 在窗口内同时测 A 与 D1；
 * ③ 若窗口内出现 raw/PATCH（被污染）或结果不成立，**整轮重来**，最多 3 次。
 * 污染与重试次数都写进 result.json —— 不把「重试到绿」藏起来。
 *
 * ## 为什么 E 之外全程只读
 *
 * 后端是**用户真实库**。A/B2/C/D 都不需要写库：直接调用产品代码里那个失效函数即可
 * —— 它若写错前缀，C 就会 FAIL。E 需要一次真实编辑，故**自造自删**一条夹具条目
 * （`ZZ-BUG138-<ts>`，ASCII 标题），`finally` 里删除并自证无残留，绝不碰用户数据。
 *
 * 前置：orig-daemon / orig-tg / vite dev 活栈（端口经 `_lib_endpoints.cjs` 从 daemon
 * `/api/config` 运行时解析，**不写死**）。
 * 用法：node tauri-shell/verify/verify_bug138_media_list_cache.cjs
 * 产物：verify_shots/bug-138/result.json（**证据产物不入库**，AGENTS.md §6）。
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const OUT_DIR =
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'bug-138')
const TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
/** 封面补写静止判据：连续这么久没有新的 raw/PATCH 即认为风暴已过。 */
const QUIET_MS = Number(process.env.ORIG_BUG138_QUIET_MS || 2000)
const QUIET_CAP_MS = Number(process.env.ORIG_BUG138_QUIET_CAP_MS || 25000)
/** A/D1 干净窗口的最大重试轮数。 */
const CYCLE_ATTEMPTS = 3

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

/**
 * 在页面里装 fetch 计数器 + 模块解析 helper。
 *
 * 三类请求分开数：
 *   list  —— `GET /api/media/items?...`，本脚本的被测对象；
 *   raw   —— `GET /api/media/items/<id>/raw`，卡片补封面抽帧；
 *   patch —— `PATCH /api/media/items/<id>`，封面回写（`onPosterReady`）。
 * 后两者是「缓存被产品自己作废」的信号，用来识别被污染的测量窗口（见文件头）。
 *
 * `__bug138Resolve` 必须**装进页面**而不是留在 node 侧：`page.evaluate` 会把回调
 * 序列化成字符串在页面里跑，node 作用域里的函数在那里不存在（ReferenceError）。
 */
const INSTALL_COUNTER = () => {
  /**
   * 动态 import **应用自己那份** fetchCache / api-media 模块。
   *
   * 必须走 `performance.getEntriesByType('resource')` 查出的**完整 URL（含 vite 的
   * `?t=<HMR 时间戳>`）**：直接 `import('/src/lib/fetchCache.ts')`（无 query）会拿到
   * **另一个模块实例** —— ES module registry 按完整 URL 缓存，两条 URL 是两个实例，
   * 于是本脚本改的是一份没被应用使用的缓存，断言会假失败（实测 D1/C 就是这么假的）。
   * 取应用真实 URL ⇒ 改的就是应用正在用的那份。
   */
  window.__bug138Resolve = async () => {
    const names = performance.getEntriesByType('resource').map(e => e.name)
    const pick = re => names.find(n => re.test(n))
    const fcUrl = pick(/\/src\/lib\/fetchCache\.ts/)
    const mediaUrl = pick(/\/src\/api\/media\.ts/)
    if (!fcUrl || !mediaUrl) throw new Error(`cannot locate app modules: ${JSON.stringify(names)}`)
    return { fc: await import(fcUrl), media: await import(mediaUrl) }
  }
  window.__bug138 = { list: 0, raw: 0, patch: 0, urls: [] }
  const orig = window.fetch.bind(window)
  window.fetch = function patched(input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url
      const m = String((init && init.method) || 'GET').toUpperCase()
      if (typeof url === 'string') {
        if (m === 'GET' && /\/api\/media\/items(\?|$)/.test(url)) {
          window.__bug138.list += 1
          if (window.__bug138.urls.length < 40) window.__bug138.urls.push(url)
        } else if (/\/api\/media\/items\/\d+\/raw/.test(url)) {
          window.__bug138.raw += 1
        } else if (m === 'PATCH' && /\/api\/media\/items\/\d+(\?|$)/.test(url)) {
          window.__bug138.patch += 1
        }
      }
    } catch {
      /* 计数失败不得影响被测应用 */
    }
    return orig(input, init)
  }
  return true
}

const READ_COUNTER = () => ({ ...window.__bug138, urls: window.__bug138.urls.slice() })

/** 点一个 `data-testid` 锚点。 */
const CLICK = sel => {
  const el = document.querySelector(sel)
  if (!el) return false
  el.click()
  return true
}

const CARDS = () => document.querySelectorAll('[data-testid="media-card"]').length

/** 卡片可见文本（用于断言「显示的是新标题还是旧标题」）。 */
const CARD_TEXT = id => {
  const el = document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`)
  return el ? String(el.innerText || '') : null
}

/** `peek()` 面板当前查询对应的键 —— 命中即证明「模块实例一致」且「键公式一致」。 */
const PEEK_PANEL_KEY = async () => {
  const { fc, media } = await window.__bug138Resolve()
  const key = fc.cacheKey.mediaList(media.mediaListParams({
    kind: '',
    q: undefined,
    tagId: undefined,
    unassigned: false,
    sort: 'recent',
    limit: 120,
    offset: 0,
  }))
  const hit = fc.peek(key)
  return {
    key,
    hit: hit !== undefined,
    itemCount: hit && hit.items ? hit.items.length : -1,
    total: hit ? hit.total : -1,
  }
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

/**
 * 等封面补写风暴静止。
 *
 * `raw`（抽帧）与 `patch`（回写）计数只要还在涨，说明还有卡片在补封面，而每补一张
 * 就会作废整族 media:list —— 此时测「缓存是否仍命中」是在测别的东西。
 */
async function waitForPosterQuiet(page) {
  const t0 = Date.now()
  let lastSig = null
  let stableSince = Date.now()
  while (Date.now() - t0 < QUIET_CAP_MS) {
    const c = await page.evaluate(READ_COUNTER)
    const sig = `${c.raw}/${c.patch}`
    if (sig !== lastSig) {
      lastSig = sig
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= QUIET_MS) {
      return { quiet: true, waitedMs: Date.now() - t0, raw: c.raw, patch: c.patch }
    }
    await sleep(300)
  }
  const c = await page.evaluate(READ_COUNTER)
  return { quiet: false, waitedMs: Date.now() - t0, raw: c.raw, patch: c.patch }
}

// ───────────────── HTTP（仅回环，造/删夹具，绝不碰用户数据） ─────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

/** 造一条**有真实字节**的本地视频条目（与 BUG-263 同一夹具手法）。 */
async function createFixtureItem(title, tg) {
  const filePath = path.join(os.tmpdir(), `orighub-bug138-${Date.now()}-${title}.mp4`)
  fs.writeFileSync(filePath, Buffer.alloc(2048, 7))
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: filePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, filePath, status: r.status }
}

/**
 * 通过 UI 编辑夹具标题并保存。
 *
 * React 受控输入：直接赋 `.value` 不会触发 onChange，必须走原型上的 setter
 * 再派发原生 `input` 事件，否则 `save()` 里拿到的仍是旧 `title`，PATCH 不发、判据假红。
 */
async function editFixtureTitleViaUi(page, itemId, newTitle) {
  const opened = await page.evaluate(id => {
    const card = document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`)
    const btn = card && card.querySelector('[data-testid="item-edit"]')
    if (!btn) return false
    btn.click()
    return true
  }, itemId)
  if (!opened) throw new Error(`item-edit button not found for fixture ${itemId}`)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="item-edit-dialog"]'), {
    timeout: 15000,
  })
  await sleep(400)

  const typed = await page.evaluate(v => {
    const el = document.querySelector('[data-testid="item-edit-title"]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, newTitle)
  if (!typed) throw new Error('item-edit-title not found')

  await sleep(200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="item-edit-save"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !document.querySelector('[data-testid="item-edit-dialog"]'), {
    timeout: 15000,
  })
  // 保存 → `refreshAll()` → `loadItems()`，给它落地的时间
  await sleep(900)
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug138] app=${ep.app} tg=${ep.tg} out=${OUT_DIR}`)

  // 夹具标题用 -A / -B 而不是「旧标题 + 后缀」：后者让旧标题成为新标题的子串，
  // 「不含旧标题」的断言会永远为真（判据失效）。
  const ts = Date.now()
  const FIXTURE_A = `ZZ-BUG138-${ts}-A`
  const FIXTURE_B = `ZZ-BUG138-${ts}-B`
  let fixture = { id: null, filePath: null }

  const browser = await cdp.launch()
  let exitCode = 0
  try {
    // 夹具必须在应用读到列表**之前**建好：直接走 HTTP 建数据不会失效前端缓存，
    // 若等列表进缓存后再建，卡片就看不见了（而失效重取会污染 A 的测量窗口）。
    fixture = await createFixtureItem(FIXTURE_A, ep.tg)
    if (!fixture.id) {
      check('fixture: created a throwaway item to edit', false, `${JSON.stringify(fixture)}`)
      throw new Error('fixture creation failed')
    }
    console.log(`[bug138] fixture: ${FIXTURE_A} id=${fixture.id}`)

    const page = await browser.newPage()

    // 装计数器必须在**进入媒体库之前** —— 首屏就会打 stats/tags，但条目列表请求
    // 只在进入 items 视图时发，故此处安装仍能拿到干净的起点。
    await page.goto(ep.app, { timeout: TIMEOUT_MS, waitForRoot: true, settleMs: 1500 })
    await page.evaluate(INSTALL_COUNTER)

    // ---- 进入媒体库面板 ----
    const opened = await page.evaluate(CLICK, '[data-testid="nav-child-lib-series"]')
    if (!opened) throw new Error('nav-child-lib-series not found')
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
    const quiet1 = await waitForPosterQuiet(page)
    await enterItems(page)
    const first = await page.evaluate(READ_COUNTER)
    check(
      'B  first entry issues exactly ONE /api/media/items request',
      first.list === 1,
      `list=${first.list} urls=${JSON.stringify(first.urls)}`,
    )
    const cardsFirst = await page.evaluate(CARDS)
    check('B  items view really rendered cards (not an empty/error state)', cardsFirst > 0, `cards=${cardsFirst}`)

    // ============ A + D1：切走再回必须命中缓存，且真实模块能 peek 到 ============
    // 两者必须在**同一个干净窗口**里读：中间只要补一张封面，缓存就被产品自己作废了。
    let cycle = null
    const cycleLog = []
    for (let attempt = 1; attempt <= CYCLE_ATTEMPTS; attempt++) {
      // 进窗口**之前**也 peek 一次：缓存若在窗口外已被作废（典型：夹具这张新卡片
      // 刚补完封面走 `onPosterReady` 失效），窗口内再干净也必然重取 —— 记下来，
      // 免得把「窗口前被作废」误读成「缓存没生效」。
      const peekAtStart = await page.evaluate(PEEK_PANEL_KEY)
      const quiet = await waitForPosterQuiet(page)
      await leaveItems(page)
      const before = await page.evaluate(READ_COUNTER)
      await enterItems(page)
      const after = await page.evaluate(READ_COUNTER)
      const peek = await page.evaluate(PEEK_PANEL_KEY)
      const listDelta = after.list - before.list
      const contaminated = after.raw !== before.raw || after.patch !== before.patch
      cycleLog.push({
        attempt,
        peekHitAtCycleStart: peekAtStart.hit,
        posterQuiet: quiet.quiet,
        listDelta,
        rawDelta: after.raw - before.raw,
        patchDelta: after.patch - before.patch,
        peekHit: peek.hit,
      })
      if (!contaminated && listDelta === 0 && peek.hit) {
        cycle = { before, after, peek, attempt, quiet }
        break
      }
    }
    console.log(`[bug138] cache-hit cycle: ${JSON.stringify(cycleLog)}`)

    check(
      'A  cache hit: re-entering items view issues NO new request',
      !!cycle,
      cycle
        ? `before=${cycle.before.list} after=${cycle.after.list} (delta must be 0) attempt=${cycle.attempt}/${CYCLE_ATTEMPTS} contamination=${JSON.stringify(cycleLog)}`
        : `no clean window in ${CYCLE_ATTEMPTS} attempts: ${JSON.stringify(cycleLog)}`,
    )
    const cardsSecond = await page.evaluate(CARDS)
    check(
      'A  re-entered items view still shows the list (cache hit, not a blank view)',
      cardsSecond > 0,
      `cards=${cardsSecond}`,
    )
    const d1 = cycle ? cycle.peek : { key: '(no clean window)', hit: false, itemCount: -1, total: -1 }
    check(
      'D1 real module: peek(mediaList(mediaListParams(panel query))) hits the panel cache',
      d1.hit,
      `key=${d1.key} cachedItems=${d1.itemCount} total=${d1.total} cycleLog=${JSON.stringify(cycleLog)}`,
    )
    // 旁证：键与真实请求 URL 同源（不依赖缓存是否仍驻留，故不受补封面影响）
    const keyMatchesRequest = await page.evaluate(async () => {
      const { fc, media } = await window.__bug138Resolve()
      const params = media.mediaListParams({
        kind: '',
        q: undefined,
        tagId: undefined,
        unassigned: false,
        sort: 'recent',
        limit: 120,
        offset: 0,
      })
      const req = performance
        .getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => /\/api\/media\/items\?/.test(n))
      return { params, key: fc.cacheKey.mediaList(params), requests: req }
    })
    check(
      'D1b cache key is generated from the SAME serializer as the request URL (side evidence)',
      keyMatchesRequest.requests.some(u => u.endsWith(`?${keyMatchesRequest.params}`)),
      `params=${keyMatchesRequest.params} requests=${JSON.stringify(keyMatchesRequest.requests.slice(0, 3))}`,
    )

    // ================= B2：在途合并（直接打真实模块，不靠 UI 巧合） =================
    // UI 上「首次进入只发 1 次」**证明不了**在途合并：`loadItems` 有 250ms 防抖，
    // StrictMode 的 effect 双调用被 `clearTimeout` 吃掉了（实测去掉缓存后仍是 1 次）。
    // 故这里直接对**应用那份** fetchCache 发两次并发 `cached()`，数 loader 跑了几次。
    const b2 = await page.evaluate(async () => {
      const { fc, media } = await window.__bug138Resolve()
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

    // ================= D2：键的等价 / 区分语义 =================
    const d2 = await page.evaluate(async () => {
      const { fc, media } = await window.__bug138Resolve()
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
      const { fc, media } = await window.__bug138Resolve()
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
    // 基线取「紧邻这一次进入之前」的计数，不复用前面某一步留下的值：
    // 缓存被去掉（证伪态）时根本找不到干净窗口，`cycle` 会是 null，
    // 依赖它会让脚本在这里抛异常，后面的 C/E 判据就全跑不到了（红态读数会缺一半）。
    await leaveItems(page)
    const beforeD3 = await page.evaluate(READ_COUNTER)
    await enterItems(page) // 缓存已被 D3 清空 ⇒ 这次应发出新请求
    const afterD3 = await page.evaluate(READ_COUNTER)
    check(
      'C  setup: after D3 eviction, re-entry re-fetches (proves eviction reached the live read path)',
      afterD3.list === beforeD3.list + 1,
      `before=${beforeD3.list} after=${afterD3.list} (delta must be 1)`,
    )

    await leaveItems(page) // 此刻不刷新 ⇒ 缓存里那份仍在
    const beforeC = await page.evaluate(READ_COUNTER)

    // 显式调用**产品代码用的同一个函数**（不是本脚本自造的失效逻辑）
    const invalidated = await page.evaluate(async () => {
      const { fc, media } = await window.__bug138Resolve()
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

    // ================= E：编辑后重开必须显示新值 =================
    // 这是用户真正的痛点：「改完标题又变回去了」。C 只证明「失效函数写对了」，
    // E 证明**真实编辑路径**（`ItemEditDialog.save` → `onSaved` → `refreshAll`）会走到它。
    await page.waitForFunction(
      id => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
      { timeout: TIMEOUT_MS, args: [fixture.id] },
    )
    const textBeforeEdit = await page.evaluate(CARD_TEXT, fixture.id)
    check(
      'E  setup: fixture card is visible with its ORIGINAL title before the edit',
      !!textBeforeEdit && textBeforeEdit.includes(FIXTURE_A) && !textBeforeEdit.includes(FIXTURE_B),
      `cardText=${JSON.stringify(String(textBeforeEdit || '').slice(0, 80))}`,
    )

    const beforeEdit = await page.evaluate(READ_COUNTER)
    await editFixtureTitleViaUi(page, fixture.id, FIXTURE_B)

    // E1：保存必须触发一次新的列表请求（`refreshAll` → `invalidateCache()` → `loadItems()`）
    const afterEdit = await page.evaluate(READ_COUNTER)
    check(
      'E1 saving an edit DOES re-request the list (invalidation fires on the real edit path)',
      afterEdit.list > beforeEdit.list,
      `before=${beforeEdit.list} after=${afterEdit.list} (delta must be >= 1; 0 = edit never invalidates)`,
    )

    // E2：离开再进入，卡片必须显示**新**标题（缓存里是改后那份，不是改前那份）
    await leaveItems(page)
    await enterItems(page)
    const textAfterEdit = await page.evaluate(CARD_TEXT, fixture.id)
    check(
      'E2 re-opening the list shows the NEW title, not the stale one',
      !!textAfterEdit && textAfterEdit.includes(FIXTURE_B) && !textAfterEdit.includes(FIXTURE_A),
      `cardText=${JSON.stringify(String(textAfterEdit || '').slice(0, 80))} expectIncludes=${FIXTURE_B} expectExcludes=${FIXTURE_A}`,
    )

    // ================= 顺带：面板无控制台错误 =================
    const errs = page.consoleErrors().filter(e => !/favicon|DevTools|React DevTools/i.test(e))
    check('no console errors in the media panel', errs.length === 0, errs.slice(0, 3).join(' | '))

    const shot = path.join(OUT_DIR, 'items-view-after-edit.png')
    await page.screenshot(shot)
    console.log(`\nscreenshot: ${shot}`)
  } catch (e) {
    check('verification script completed without throwing', false, String(e && e.stack ? e.stack : e))
  } finally {
    // 夹具自造自删 —— 无论如何都不能把测试条目留在用户库里
    if (fixture.id) {
      const del = await httpJson('DELETE', `${ep.tg}/api/media/items/${fixture.id}`)
      const gone = await httpJson('GET', `${ep.tg}/api/media/items/${fixture.id}`)
      const left = await httpJson('GET', `${ep.tg}/api/media/items?q=${encodeURIComponent(`ZZ-BUG138-${ts}`)}&limit=20`)
      const leftCount = left.json && Array.isArray(left.json.items) ? left.json.items.length : -1
      check(
        'fixture cleaned up (no throwaway item left in the user library)',
        gone.status === 404 && leftCount === 0,
        `deleteStatus=${del.status} getAfterDelete=${gone.status} leftoverBySearch=${leftCount}`,
      )
      try {
        if (fixture.filePath) fs.unlinkSync(fixture.filePath)
      } catch (_e) {
        /* 临时文件删不掉无碍 */
      }
    }
    const failed = results.filter(r => !r.ok)
    const payload = {
      bug: 'BUG-138',
      app: ep.app,
      tg: ep.tg,
      endpointsResolvedAtRuntime: true,
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
