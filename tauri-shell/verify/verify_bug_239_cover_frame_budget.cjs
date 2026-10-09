#!/usr/bin/env node
'use strict'

/**
 * BUG-239 真实 UI 验收：封面抽帧（`/api/media/items/{id}/raw`）**不随条目数线性增长**。
 *
 * ## 缺陷回顾（用户复报的问题 1）
 *
 * 「`api/media/items/{id}/raw` 仍然在请求，这个不是不用了吗？」—— 播放器本身并不读 raw
 * （`<video>.src` 走 `/stream`）；raw 来自**封面抽帧**：`lib/poster.ts` 对每条「无封面视频」
 * 发一次解码级请求。修复前，卡片**挂载即抽帧**（与是否在视口无关），于是一个「全部内容」
 * 网格上百张卡里几十条无封面视频**同时**排进解码队列，请求数随条目数线性放大，并与播放
 * 争解码/IO（实测播放中 `currentTime` 只推进 0.72×，即用户体感的卡顿）。
 *
 * ## 为什么用**自造夹具**
 *
 * 抽帧成功会**回写后端 `poster`**（一次生成永久复用）——那是正确行为，但会让「现成的
 * 无封面条目」被逐次消耗，判据随之退化（第 N 次跑就没有候选了）。故本脚本每次**自造**
 * `N_FIX` 条「有字节、无封面」的临时视频条目（把库里最小的一段真实字节复制到临时路径后
 * 登记），跑完**精确删除**（夹具自造自删，绝不碰用户既有条目）——保证判据每次都有牙。
 *
 * ## 判据（真实 DOM + 真实后端；分母全部**活取**）
 *
 *   P  : 夹具建成且**全部挂载**；可见候选 ≥ 1 且 **可见候选 < 挂载候选**（存在落差）。
 *   A1 : 首屏期间被请求过 raw 的条目 id **全部落在「可见候选」集合内**（核心判据 ——
 *        若抽帧按挂载条目走，必然出现**屏外**条目被请求，A1 立刻 FAIL）。
 *   A2 : 首屏去重 raw 条目数 **严格小于** 挂载候选数（不随挂载条目线性增长）。
 *   D1 : 无字节候选条目**从未**被请求 raw（BUG-250 边界不回退）。
 *   B1 : 滚动一屏后，**新增**被请求的 raw 条目 id 全在「曾可见」集合内（只随新进入视口增长）。
 *   C1 : 打开播放器后的 5s 窗口内，raw 请求增量 **= 0**（播放让路门）。
 *   E  : 抽帧预算读数 `stats.pending ≤ 10`（队列有上限、可观测）。
 *
 * ## 反向（验牙）—— `BUG239_TEETH=1`
 *
 * 在页面首帧注入一个「永远报 intersecting」的 `IntersectionObserver` 替身，等价于
 * **把可见性门控关掉**（正是修复前「挂载即抽帧」的行为）。复跑后 A1 必须 **FAIL**
 * （会出现屏外条目被请求）。该替身**只注入到浏览器页面**，不改任何源码 —— 因此不存在
 * 「还原字节」的步骤（`git status` 里 `tauri-shell/src` 保持原样即是证明）。
 *
 * ## 环境
 *
 *   vite dev + orig-tg。未就绪时用 `scripts/dev_services.py` 拉起（**不裸跑** orig-tg/daemon）。
 *   orig-tg 端口从 daemon `/api/config` 的 `tg_port` 取真源，不硬编码。
 *
 * 用法：`node tauri-shell/verify/verify_bug_239_cover_frame_budget.cjs`
 *      `BUG239_TEETH=1 node tauri-shell/verify/verify_bug_239_cover_frame_budget.cjs`  （验牙）
 * Env : APP_PORT(5180) / DAEMON_PORT(19786) / ORIG_VERIFY_SHOTS
 * Exit: 0 = 全部通过；2 = 有判据失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const TEETH = process.env.BUG239_TEETH === '1'

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, '..', 'verify_shots', 'bug239'),
)

/**
 * 夹具数量：**明显多于一屏可见卡片**，才能保证「挂载 ≫ 可见」的落差**必然存在**
 * （视口高 900（`lib/cdp.cjs` 的 `Emulation.setDeviceMetricsOverride`）时一屏约容 ~52 张卡，
 * 取 80 以保证至少有一屏装不下的夹具落在屏外 —— 否则本判据会在「一屏刚好放下」时抖成恒真）。
 */
const N_FIX = 80
/** 观测时长（ms）：抽帧是解码级开销，给足时间让队列排空。 */
const WINDOW_MS = 9000
/** 滚动步长（px）：约一屏高。 */
const SCROLL_STEP = 600
/** 可见性几何余量：与 `lib/poster.ts` 的 `COVER_VIEWPORT_MARGIN` 对齐（200px）。 */
const MARGIN = 200
/** A1 判定用的**额外**宽容（px）：抵消我的几何与 IO 之间的边界差，只放宽「允许集合」。 */
const SLACK = 60

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail, id = '') {
  checks.push({ name, pass: Boolean(pass), detail, id })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(pass)
}

// ─────────────────────────── HTTP（仅回环） ───────────────────────────

async function httpJson(method, url, body, timeoutMs = 10000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
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

async function resolveTgBase() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  if (cfg.status !== 200 || !cfg.json || !cfg.json.tg_port) return null
  return { base: `http://127.0.0.1:${cfg.json.tg_port}`, tgRunning: cfg.json.tg_running === true }
}

function startDevServices() {
  const repo = path.resolve(__dirname, '..', '..')
  const script = path.join(repo, 'scripts', 'dev_services.py')
  console.log(`[bug239] dev services not ready — starting ${script}`)
  execFileSync('python', [script], { cwd: repo, stdio: 'inherit', timeout: 120000 })
}

async function waitForEnv(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const tg = await resolveTgBase()
    const app = await httpJson('GET', APP_URL)
    if (tg && tg.tgRunning && app.status === 200) return tg
    last = { tg, appStatus: app.status }
    await delay(1000)
  }
  return last
}

// ─────────────────────────── 夹具（自造自删） ───────────────────────────

/**
 * 找一段**最小的、有字节的**视频文件作为夹具字节来源（抽帧要真解码，越小越快）。
 * 路径在运行时从后端条目取真源，绝不硬编码机器路径。
 */
async function pickFixtureSource(TG, items) {
  const vids = items.filter(
    (it) =>
      it.kind === 'video' &&
      it.bytesPresence === 'present' &&
      it.absolutePath &&
      (it.size || 0) > 0,
  )
  vids.sort((a, b) => (a.size || 0) - (b.size || 0))
  return vids[0] && vids[0].absolutePath ? vids[0].absolutePath : null
}

/** 夹具标题前缀：`sweep` 只删自己造的这一族，绝不碰用户既有条目。 */
const FIX_PREFIX = 'ZZ-BUG239-FIX-'
/** 一次批量登记的条数（后端对每条会探测磁盘字节，分块更稳、避免长请求超时丢响应留下孤儿）。 */
const FIX_CHUNK = 20

async function listAllItems(TG, limit = 500) {
  const r = await httpJson('GET', `${TG}/api/media/items?sort=recent&limit=${limit}&offset=0`, undefined, 20000)
  return r.json && Array.isArray(r.json.items) ? r.json.items : []
}

/** 扫除自己造的夹具（含历史崩溃残留的孤儿）。只按标题前缀匹配，绝不动用户条目。 */
async function sweepFixtures(TG) {
  const items = await listAllItems(TG)
  const victims = items.filter((it) => String(it.title || '').startsWith('ZZ-BUG239'))
  await deleteItems(TG, victims.map((v) => v.id))
  return victims.length
}

/**
 * 造 `N_FIX` 条「无封面、有字节」的视频夹具：把来源文件复制到各自**独立**临时路径后登记
 * （后端按 path 去重，必须路径互异才能得到互异条目）。返回夹具 id 与临时目录，供收尾精确清理。
 */
async function makeFixtures(TG, srcPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug239fix-'))
  const specs = []
  for (let i = 0; i < N_FIX; i += 1) {
    const p = path.join(dir, `clip${i}.mp4`)
    fs.copyFileSync(srcPath, p)
    specs.push({ path: p, source: 'local', kind: 'video', title: `${FIX_PREFIX}${i}` })
  }
  const ids = []
  let lastStatus = 200
  for (let i = 0; i < specs.length; i += FIX_CHUNK) {
    const r = await httpJson('POST', `${TG}/api/media/items`, { items: specs.slice(i, i + FIX_CHUNK) }, 60000)
    lastStatus = r.status
    if (r.json && Array.isArray(r.json.ids)) ids.push(...r.json.ids)
  }
  return { dir, ids, status: lastStatus }
}

async function deleteItems(TG, ids) {
  for (const id of ids) {
    await httpJson('DELETE', `${TG}/api/media/items/${id}`).catch(() => undefined)
  }
}

// ─────────────────────────── 把候选信息压成给页面的紧凑表 ───────────────────────────

function candidatesFromItems(items) {
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    hasPoster: Boolean(it.poster),
    present: it.bytesPresence === 'present' || (it.bytesPresence == null && Boolean(it.filePath)),
  }))
}

// ─────────────────────────── 页面内几何：挂载 / 可见 ───────────────────────────

/**
 * 读网格卡片的**挂载 / 可见**几何。
 *
 * 可见判定对齐 `lib/poster.ts` 的 IO：卡片矩形与「滚动容器矩形 ± margin」相交即算可见
 * （IntersectionObserver 会被祖先滚动容器裁剪，故用**容器**矩形而非 window 更接近真值）。
 * 卡片带 `data-item-id`（BUG-239 加的可测性钩子），与后端候选表**按 id 对齐**，不依赖渲染顺序。
 *
 * `visible` 用 MARGIN（报告用），`allowed` 用 MARGIN+SLACK（A1 的允许集合，抵消边界差）。
 */
async function readGrid(page, cand, margin, slack) {
  return page.evaluate(
    (cands, M, S) => {
      const grid = document.querySelector('[data-testid="media-grid"]')
      if (!grid) return { ok: false, reason: 'media-grid 缺失' }
      let scroller = grid.parentElement
      while (scroller && scroller !== document.body) {
        const ov = getComputedStyle(scroller).overflowY
        if (ov === 'auto' || ov === 'scroll') break
        scroller = scroller.parentElement
      }
      const box = (scroller || document.documentElement).getBoundingClientRect()
      const hit = (r, m) =>
        r.bottom >= box.top - m && r.top <= box.bottom + m && r.right >= box.left - m && r.left <= box.right + m
      const cards = [...grid.querySelectorAll('[data-testid="media-card"]')]
      const candById = new Map(cands.map((c) => [c.id, c]))
      const mounted = cards.length
      const mountedCands = []
      const visibleCands = []
      const allowedCands = []
      const missingMounted = []
      for (const c of cards) {
        const id = Number(c.getAttribute('data-item-id'))
        const cc = candById.get(id)
        if (!cc) continue
        if (!cc.present) {
          missingMounted.push(id)
          continue
        }
        if (cc.kind !== 'video' || cc.hasPoster) continue
        mountedCands.push(id)
        const r = c.getBoundingClientRect()
        if (hit(r, M)) visibleCands.push(id)
        if (hit(r, M + S)) allowedCands.push(id)
      }
      const stats = window.__origPoster ? window.__origPoster.stats() : null
      return {
        ok: true,
        mounted,
        mountedCands,
        visibleCands,
        allowedCands,
        missingMounted,
        stats,
        scrollerClass: scroller ? String(scroller.className).slice(0, 48) : null,
        scrollerTop: Math.round(box.top),
        scrollerBottom: Math.round(box.bottom),
        innerH: window.innerHeight,
      }
    },
    cand,
    margin,
    slack,
  )
}

// ─────────────────────────── CDP 抓包 ───────────────────────────

function rawIdOf(url) {
  const m = /\/api\/media\/items\/(\d+)\/raw(?:\?|$)/.exec(url)
  return m ? Number(m[1]) : null
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug239] app=${APP_URL} daemon=${DAEMON} teeth=${TEETH} fix=${N_FIX} shots=${SHOTS}`)

  let envInfo = await resolveTgBase()
  if (!envInfo || !envInfo.tgRunning) {
    startDevServices()
    envInfo = await waitForEnv()
  }
  if (!envInfo || !envInfo.base || !envInfo.tgRunning) {
    console.error(`[bug239] 环境未就绪：${JSON.stringify(envInfo)}`)
    process.exit(1)
  }
  const TG = envInfo.base
  const isTg = (u) => String(u).startsWith(TG)
  console.log(`[bug239] orig-tg = ${TG}（取自 daemon tg_port 真源）`)

  // ── 夹具来源（运行时取真源，不硬编码机器路径）──
  const pre = await httpJson('GET', `${TG}/api/media/items?sort=recent&limit=120&offset=0`)
  const preItems = pre.json && Array.isArray(pre.json.items) ? pre.json.items : []
  const srcPath = await pickFixtureSource(TG, preItems)
  if (!srcPath) {
    console.error('[bug239] 库里没有「有字节的视频」可作夹具来源，无法构造判据')
    process.exit(1)
  }
  console.log(`[bug239] 夹具字节来源（库内最小有字节视频）=${srcPath}`)

  // 预清扫：清掉历史崩溃/超时残留的孤儿夹具（只按标题前缀匹配）
  const swept0 = await sweepFixtures(TG)
  if (swept0) console.log(`[bug239] 预清扫历史夹具残留=${swept0}`)

  let fixture = { dir: null, ids: [] }
  let browser = null
  try {
    fixture = await makeFixtures(TG, srcPath)
    console.log(`[bug239] 夹具建成：status=${fixture.status} count=${fixture.ids.length} dir=${fixture.dir}`)

    // 重新取条目表（含夹具）
    const listRes = await httpJson('GET', `${TG}/api/media/items?sort=recent&limit=120&offset=0`)
    const items = listRes.json && Array.isArray(listRes.json.items) ? listRes.json.items : []
    const cand = candidatesFromItems(items)
    const fixSet = new Set(fixture.ids)
    const mountedTotal = cand.filter((c) => c.kind === 'video' && !c.hasPoster && c.present).length
    const missingIds = new Set(cand.filter((c) => !c.present).map((c) => c.id))
    console.log(
      `[bug239] 条目=${items.length} 抽帧候选(video/无封面/有字节)=${mountedTotal} 无字节=${missingIds.size}`,
    )
    check(
      'P0: 夹具建成且数量正确（自造自删，判据每次有牙）',
      fixture.ids.length === N_FIX,
      `created=${fixture.ids.length}/${N_FIX} status=${fixture.status}`,
      'P0',
    )

    browser = await cdp.launch({
      headless: false,
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    const page = await browser.newPage()

    // 验牙：首帧注入「永远 intersecting」的 IO 替身 —— 等价关掉可见性门控。
    if (TEETH) {
      const stub = `(() => {
  class ForceIO {
    constructor(cb) { this.cb = cb; this._els = new Set() }
    observe(el) {
      this._els.add(el)
      const run = () => { try { this.cb([{ isIntersecting: true, intersectionRatio: 1, target: el }], this) } catch (e) {} }
      queueMicrotask(run); setTimeout(run, 0)
    }
    unobserve(el) { this._els.delete(el) }
    disconnect() { this._els.clear() }
    takeRecords() { return [] }
  }
  window.IntersectionObserver = ForceIO
})();`
      await page.conn.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: stub },
        { sessionId: page.sessionId },
      )
      console.log('[bug239] TEETH: 已注入强制 intersecting 的 IntersectionObserver 替身（关掉可见性门控）')
    }

    await page.goto(APP_URL, { waitUntil: 'load', settleMs: 2000 })

    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    const rawEvents = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = p.request.url
      if (url.startsWith('data:') || url.startsWith('blob:')) return
      if (!isTg(url)) return
      const id = rawIdOf(url)
      if (id != null) rawEvents.push({ id, url })
    })

    // ── 进入媒体库 → 全部内容 ──
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-media 入口不存在')
    await delay(1800)
    const catOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-cat-all"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!catOk) throw new Error('media-cat-all 入口不存在')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="media-card"]').length >= 60,
      { timeout: 25000 },
    )

    // ── A：首屏窗口 ──
    const beforeA = rawEvents.length
    await delay(WINDOW_MS)
    const gridA = await readGrid(page, cand, MARGIN, SLACK)
    const rawA = rawEvents.slice(beforeA)
    const distinctA = [...new Set(rawA.map((e) => e.id))].sort((a, b) => a - b)
    const allowedA = new Set(gridA.allowedCands)
    const offScreenA = distinctA.filter((id) => !allowedA.has(id))
    const missingHitA = distinctA.filter((id) => missingIds.has(id))
    const fixMounted = gridA.mountedCands.filter((id) => fixSet.has(id)).length
    console.log(
      `[bug239] A 首屏: 挂载=${gridA.mounted} 挂载候选=${gridA.mountedCands.length}(夹具${fixMounted}) 可见候选=${gridA.visibleCands.length} 允许=${gridA.allowedCands.length} raw请求=${rawA.length} 去重=${distinctA.length}`,
    )
    console.log(`[bug239] A 可见候选 id=${JSON.stringify(gridA.visibleCands)}`)
    console.log(`[bug239] A 屏外被请求 id=${JSON.stringify(offScreenA)}`)
    console.log(`[bug239] A budget stats=${JSON.stringify(gridA.stats)}`)
    await page.screenshot(path.join(SHOTS, '01-items-grid.png'), { fullPage: true })

    const gapA = gridA.mountedCands.length - gridA.visibleCands.length
    check(
      'P1: 夹具全部挂载且「可见候选 ≪ 挂载候选」（落差 ≥ 5 张）',
      fixMounted === N_FIX && gridA.visibleCands.length >= 1 && gapA >= 5,
      `夹具挂载=${fixMounted}/${N_FIX} 可见=${gridA.visibleCands.length} 挂载=${gridA.mountedCands.length} 落差=${gapA}`,
      'P1',
    )
    check(
      'A1: 首屏被请求的 raw 条目全部在「可见候选」内（无屏外抽帧）',
      offScreenA.length === 0,
      `去重raw=${distinctA.length} 屏外=${JSON.stringify(offScreenA)} 可见=${gridA.visibleCands.length}`,
      'A1',
    )
    check(
      'A2: 首屏去重 raw 条目数 < 挂载候选数（不随挂载条目线性增长）',
      distinctA.length < gridA.mountedCands.length,
      `去重raw=${distinctA.length} < 挂载候选=${gridA.mountedCands.length}`,
      'A2',
    )
    check(
      'D1: 无字节候选从未被请求 raw（BUG-250 边界不回退）',
      missingHitA.length === 0,
      `无字节被请求=${JSON.stringify(missingHitA)} 无字节挂载=${gridA.missingMounted.length}`,
      'D1',
    )
    check(
      'E: 抽帧预算待办数有上限（stats.pending ≤ 10，可观测）',
      Boolean(gridA.stats) && gridA.stats.pending <= 10,
      `stats=${JSON.stringify(gridA.stats)}`,
      'E',
    )

    const everVisible = new Set(gridA.allowedCands)

    // ── 滚动一屏 ──
    await page.evaluate((step) => {
      const grid = document.querySelector('[data-testid="media-grid"]')
      let s = grid && grid.parentElement
      while (s && s !== document.body) {
        const ov = getComputedStyle(s).overflowY
        if (ov === 'auto' || ov === 'scroll') break
        s = s.parentElement
      }
      if (s) s.scrollTop = s.scrollTop + step
    }, SCROLL_STEP)
    const beforeB = rawEvents.length
    await delay(WINDOW_MS)
    const gridB = await readGrid(page, cand, MARGIN, SLACK)
    for (const id of gridB.allowedCands) everVisible.add(id)
    const rawB = rawEvents.slice(beforeB)
    const distinctB = [...new Set(rawB.map((e) => e.id))].sort((a, b) => a - b)
    const newlyRequested = distinctB.filter((id) => !allowedA.has(id))
    const offScreenB = newlyRequested.filter((id) => !everVisible.has(id))
    console.log(
      `[bug239] B 滚动: 可见候选=${gridB.visibleCands.length} raw请求=${rawB.length} 新增去重=${newlyRequested.length} 从未可见=${JSON.stringify(offScreenB)}`,
    )
    await page.screenshot(path.join(SHOTS, '02-after-scroll.png'), { fullPage: true })
    check(
      'B1: 滚动后新增被请求的 raw 条目全在「曾可见」集合内（只随新进入视口增长）',
      offScreenB.length === 0,
      `新增被请求=${newlyRequested.length} 越界(从未可见)=${JSON.stringify(offScreenB)} 曾可见=${everVisible.size}`,
      'B1',
    )

    // ── C：打开播放器后的 5s 窗口 raw 必须为 0 ──
    const firstFix = fixture.ids[0]
    const opened = await page.evaluate((fixId) => {
      const grid = document.querySelector('[data-testid="media-grid"]')
      const cards = [...(grid ? grid.querySelectorAll('[data-testid="media-card"]') : [])]
      const pick = (el) => {
        const btn = el && el.querySelector('button')
        if (!btn) return false
        btn.click()
        return true
      }
      const el = cards.find((c) => Number(c.getAttribute('data-item-id')) === fixId)
      if (pick(el)) return true
      for (const c of cards) if (pick(c)) return true
      return false
    }, firstFix)
    await page
      .waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), { timeout: 10000 })
      .catch(() => undefined)
    await delay(800)
    const beforeC = rawEvents.length
    await delay(5000)
    const rawC = rawEvents.slice(beforeC)
    const viewerOpen = await page.evaluate(() => !!document.querySelector('[data-testid="media-viewer"]'))
    console.log(
      `[bug239] C 播放窗口: clicked=${opened} viewer=${viewerOpen} raw增量=${rawC.length} ids=${JSON.stringify([...new Set(rawC.map((e) => e.id))])}`,
    )
    await page.screenshot(path.join(SHOTS, '03-player-open.png'), { fullPage: true })
    check(
      'C1: 播放器打开期间 raw 请求增量为 0（播放让路门生效）',
      viewerOpen && rawC.length === 0,
      `viewer=${viewerOpen} raw增量=${rawC.length}`,
      'C1',
    )

    const pageErrs = page.pageErrors().slice(0, 5)
    if (pageErrs.length) console.log(`[bug239] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[bug239] === SUMMARY ===')
    console.log(`[bug239] teeth=${TEETH} total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    console.log(`[bug239] shots: ${SHOTS}`)
    if (failed.length) console.log('[bug239] FAILED:', failed.map((c) => `${c.id}:${c.name}`).join(' | '))
    if (failed.length) process.exitCode = 2
  } finally {
    if (browser) await browser.close()
    // 夹具自造自删：按标题前缀扫除（含超时丢响应产生的孤儿），绝不碰用户既有条目
    const swept = await sweepFixtures(TG)
    const remain = (await listAllItems(TG)).filter((it) =>
      String(it.title || '').startsWith('ZZ-BUG239'),
    ).length
    console.log(`[bug239] cleanup: swept=${swept} created=${fixture.ids.length} remain=${remain}`)
    if (fixture.dir) {
      try {
        fs.rmSync(fixture.dir, { recursive: true, force: true })
      } catch (_e) {
        /* best effort */
      }
    }
  }
}

main().catch((e) => {
  console.error('[bug239] ERROR', (e && e.stack) || e)
  process.exit(1)
})
