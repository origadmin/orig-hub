#!/usr/bin/env node
'use strict'

/**
 * BUG-186 **独立** UI 验收：媒体库剧集墙多选合并（真实渲染 + 真实后端）。
 *
 * 与实现者脚本 `verify_series_multi_select_merge.cjs` **各自独立**：本脚本刻意
 * 走**不同的判据**，专门覆盖实现者脚本**没测**的边界：
 *
 *   B1. 选中 3 条 → 动作条出现、计数正确（按 DOM 读，不按实现者脚本的断言）。
 *   B2. **故意把第 3 条选为「保留」**（不选第 1 条）→ 确认后**保留的必须是第 3 条**（按 id 核）。
 *   B3. 合并后：另 2 条从列表消失；它们的**分集确实挂到了保留的那条**（按 item id 逐条核）。
 *   B4. 整个合并**只发一个** `POST /api/media/series/:id/merge`（CDP 网络计数）。
 *   B5. 边界：选中 2 条再取消 1 条 → 动作条消失；离开剧集墙再回来 → 选择被清空。
 *   B6. **不回归**：剧集**内页**的旧「合并」入口（`data-testid="series-merge"`）仍在且可用。
 *   B7. 无 `pageErrors`；无 `console.error`（favicon 除外 —— 夹具假路径的 `/raw` 404 单列并说明）。
 *
 * ## 夹具（只造自己的，用完即删）
 *
 *   造 3 条剧集（`ZZ-UIWALL-<ts>-A/B/C`），每条挂 1 个分集。收尾按记录到的 id 精确删除，
 *   最后断言 `GET /api/media/series` 的 id 集合 == 开工前记录的集合（证明没误伤真实数据）。
 *
 * ## 环境（用**真实在跑**的服务，严禁隔离实例 —— 隔离会丢真实 TG 数据）
 *
 *     # 服务已在跑：vite 127.0.0.1:5180 / orig-tg 127.0.0.1:19787
 *     node verify/verify_series_merge_ui_wall.cjs
 *
 * ## Usage / Env
 *
 *   APP_URL   (default http://127.0.0.1:5180/)   前端 dev server
 *   TG_API    (default http://127.0.0.1:19787)   orig-tg：/api/media/*
 *   ORIG_VERIFY_OUT                               截图输出目录（默认系统临时目录）
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = (process.env.TG_API || process.env.ORIG_TG_API || 'http://127.0.0.1:19787').replace(
  /\/$/,
  '',
)
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-series-uiwall')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── 断言记录 ──────────────────────────────

const results = []

/**
 * 记录并打印一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 实测细节
 * @returns {boolean} ok
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`[series-uiwall] ${results.length - failed}/${results.length} assertions passed`)
}

/** 拒绝把产物写进仓库（AGENTS.md §6）。 */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). Set ORIG_VERIFY_OUT to a temp directory.`,
    )
  }
}

// ────────────────────────────── HTTP（仅回环） ──────────────────────────────

/** 回环请求 → { status, json, text }（失败返回 status:0）。 */
async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

/** GET 纯文本（探测 dev server 可达）。 */
function httpGetText(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const http = require('node:http')
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => finish(res.statusCode === 200 ? body : null))
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
  })
}

// ────────────────────────────── 后端真源 ──────────────────────────────

async function listSeries() {
  const r = await httpJson('GET', `${TG_API}/api/media/series`)
  return r.json && Array.isArray(r.json.items) ? r.json.items : []
}

async function seriesIdSet() {
  return (await listSeries()).map((s) => s.id).sort((a, b) => a - b)
}

async function getSeries(id) {
  const r = await httpJson('GET', `${TG_API}/api/media/series/${id}`)
  return r.status === 200 && r.json ? r.json : null
}

async function createItem(title) {
  const fakePath = path.join(
    os.tmpdir(),
    `orighub-uiwall-${Date.now()}-${title.replace(/[^\w.-]/g, '_')}.mp4`,
  )
  const r = await httpJson('POST', `${TG_API}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, status: r.status }
}

async function createSeries(title) {
  const r = await httpJson('POST', `${TG_API}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status }
}

async function addEpisode(seriesId, itemId) {
  return httpJson('POST', `${TG_API}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo: 1,
  })
}

async function deleteSeries(id) {
  return httpJson('DELETE', `${TG_API}/api/media/series/${id}`)
}

async function deleteItem(id) {
  return httpJson('DELETE', `${TG_API}/api/media/items/${id}`)
}

// ────────────────────────────── DOM 扫描（真实渲染） ──────────────────────────────

/** 动作条 / 计数 / 合并按钮。 */
const SCAN_BAR_FN = () => {
  const bar = document.querySelector('[data-testid="series-selection-bar"]')
  const count = document.querySelector('[data-testid="series-selection-count"]')
  const mergeBtn = document.querySelector('[data-testid="series-merge-wall"]')
  return {
    hasBar: !!bar,
    countText: count ? count.textContent.trim() : null,
    hasMerge: !!mergeBtn,
  }
}

/** 剧集墙当前渲染的 series id + 选中态。 */
const READ_WALL_FN = () => {
  const out = []
  document.querySelectorAll('[data-testid="series-card-root"]').forEach((r) => {
    out.push({
      id: Number(r.getAttribute('data-series-id')),
      selected: r.getAttribute('data-selected') === 'true',
    })
  })
  return out
}

/** 读取合并对话框的「保留目标」候选。 */
const READ_KEEP_OPTIONS_FN = () => {
  const opts = []
  document.querySelectorAll('[data-testid="series-merge-keep-option"]').forEach((o) => {
    const input = o.querySelector('input[type="radio"]')
    opts.push({
      seriesId: Number(o.getAttribute('data-series-id')),
      checked: input ? input.checked : false,
    })
  })
  return opts
}

/** 读取确认步的删除清单 + 警示文案。 */
const READ_DELETE_FN = () => {
  const lis = [...document.querySelectorAll('[data-testid="series-merge-delete-list"] li')].map((li) =>
    li.textContent.trim(),
  )
  const warn = document.querySelector('[data-testid="series-merge-confirm-warn"]')
  return { list: lis, warnText: warn ? warn.textContent.trim() : null }
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[series-uiwall] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[series-uiwall] shot ${name} FAILED: ${e.message}`)
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assertOutDirSafe(OUT_DIR)

  console.log(`[series-uiwall] app=${APP_URL} tg-api=${TG_API} out=${OUT_DIR}`)

  // ── 环境自检 ───────────────────────────────────────────────────────
  const probe = await httpJson('GET', `${TG_API}/api/media/series`)
  if (probe.status !== 200) {
    console.error(`[series-uiwall] orig-tg media API not reachable (status=${probe.status}). Aborting (env).`)
    process.exit(1)
  }
  const appProbe = await httpGetText(APP_URL, 6000)
  if (appProbe == null) {
    console.error(`[series-uiwall] dev server ${APP_URL} not reachable. Aborting (env).`)
    process.exit(1)
  }

  // ── 开工前基线 ─────────────────────────────────────────────────────
  const baselineSeries = await seriesIdSet()
  console.log(`[series-uiwall] baseline series (${baselineSeries.length}): ${JSON.stringify(baselineSeries)}`)

  const ts = Date.now()
  const created = { series: [], items: [] }
  const fx = []

  const browser = await cdp.launch()
  try {
    // ── 造 3 条夹具（A / B / C），每条挂 1 个分集 ─────────────────────
    for (const key of ['A', 'B', 'C']) {
      const title = `ZZ-UIWALL-${ts}-${key}`
      const item = await createItem(title)
      if (item.id == null) throw new Error(`fixture item ${key} not created (status=${item.status})`)
      created.items.push(item.id)
      const s = await createSeries(title)
      if (s.id == null) throw new Error(`fixture series ${key} not created (status=${s.status})`)
      created.series.push(s.id)
      const ep = await addEpisode(s.id, item.id)
      if (ep.status !== 200) throw new Error(`fixture episode ${key} not added (status=${ep.status})`)
      fx.push({ key, seriesId: s.id, itemId: item.id, title })
    }
    console.log(
      `[series-uiwall] fixtures: ${JSON.stringify(fx.map((f) => ({ k: f.key, seriesId: f.seriesId, itemId: f.itemId })))}`,
    )
    const fixtureItemIds = new Set(fx.map((f) => f.itemId))

    const page = await browser.newPage()
    // 网络监听：统计 /merge 的 POST 次数（B4）。
    const mergeReqs = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = (p && p.request && p.request.url) || ''
      const method = (p && p.request && p.request.method) || ''
      if (method === 'POST' && /\/api\/media\/series\/\d+\/merge(\?|$)/.test(url)) {
        mergeReqs.push({ url, method })
      }
    })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })

    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-media entry not found')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
      { timeout: 20000 },
    )
    await delay(1000)

    // 进入剧集墙（确保 view === 'series'）。
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-rail-series-all"]')
      if (b) b.click()
    })
    await delay(800)

    const wallIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="series-card-root"]')].map((r) =>
        Number(r.getAttribute('data-series-id')),
      ),
    )
    const allOnWall = fx.every((f) => wallIds.includes(f.seriesId))
    check(
      'B1a: 3 条夹具剧集都渲染在剧集墙上',
      allOnWall,
      `fixture=${JSON.stringify(fx.map((f) => f.seriesId))} onWall=${allOnWall}`,
    )
    await shot(page, '01-series-wall.png')

    /** 点击某条剧集的选择框。 */
    const clickSelect = async (sid) => {
      await page.evaluate((id) => {
        const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`)
        const btn = root && root.querySelector('[data-testid="series-card-select"]')
        if (btn) btn.click()
      }, sid)
      await delay(220)
    }

    const A = fx[0].seriesId
    const B = fx[1].seriesId
    const C = fx[2].seriesId

    // ── B5 上半：选中 2 条 → 动作条出现；取消 1 条（剩 1）→ 动作条消失 ──
    await clickSelect(A)
    await clickSelect(B)
    await delay(300)
    const bar2 = await page.evaluate(SCAN_BAR_FN)
    check(
      'B5a: 选中 2 条 → 动作条出现',
      bar2.hasBar && bar2.hasMerge,
      `hasBar=${bar2.hasBar} countText=${JSON.stringify(bar2.countText)}`,
    )
    await clickSelect(B) // 取消 B，剩 1 条
    await delay(300)
    const bar1 = await page.evaluate(SCAN_BAR_FN)
    check(
      'B5b: 取消 1 条（剩 1 条）→ 动作条消失',
      !bar1.hasBar,
      `hasBar=${bar1.hasBar} countText=${JSON.stringify(bar1.countText)}`,
    )

    // ── B5 下半：离开剧集墙再回来 → 选择被清空 ─────────────────────────
    // 选中 2 条（先造成非空选择），切到内容视图，再切回剧集墙。
    await clickSelect(A)
    await clickSelect(B)
    await delay(300)
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-cat-all"]')
      if (b) b.click()
    })
    await delay(700)
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-rail-series-all"]')
      if (b) b.click()
    })
    await delay(900)
    const wallAfterReturn = await page.evaluate(READ_WALL_FN)
    const anySelectedAfterReturn = wallAfterReturn.some((w) => w.selected)
    const barAfterReturn = await page.evaluate(SCAN_BAR_FN)
    check(
      'B5c: 离开剧集墙再回来 → 选择被清空（无选中卡片、无动作条）',
      !anySelectedAfterReturn && !barAfterReturn.hasBar,
      `anySelected=${anySelectedAfterReturn} hasBar=${barAfterReturn.hasBar}`,
    )

    // ── B1：选中 3 条 → 动作条出现、计数正确 ───────────────────────────
    await clickSelect(A)
    await clickSelect(B)
    await clickSelect(C)
    await delay(400)
    const bar3 = await page.evaluate(SCAN_BAR_FN)
    const wall3 = await page.evaluate(READ_WALL_FN)
    const sel3 = wall3.filter((w) => w.selected).map((w) => w.id).sort((x, y) => x - y)
    check(
      'B1b: 选中 3 条 → 动作条出现、计数显示 3',
      bar3.hasBar && bar3.hasMerge && /3/.test(bar3.countText || ''),
      `hasBar=${bar3.hasBar} countText=${JSON.stringify(bar3.countText)} selected=${JSON.stringify(sel3)}`,
    )
    await shot(page, '02-selected-three.png')

    // ── B2：打开对话框，**显式把第 3 条（C）选为「保留」**（不选第 1 条 A）──
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-wall"]')
      if (b) b.click()
    })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-merge-multi-dialog"]'), {
      timeout: 10000,
    })
    await delay(300)
    await shot(page, '03-dialog-step1.png')

    const optsBefore = await page.evaluate(READ_KEEP_OPTIONS_FN)
    check(
      'B2a: 对话框列出全部 3 条「保留目标」候选',
      optsBefore.length === 3,
      `options=${JSON.stringify(optsBefore.map((o) => o.seriesId))}`,
    )

    await page.evaluate((sid) => {
      const o = document.querySelector(`[data-testid="series-merge-keep-option"][data-series-id="${sid}"]`)
      const input = o && o.querySelector('input[type="radio"]')
      if (input) input.click()
      else if (o) o.click()
    }, C)
    await delay(350)
    const optsAfter = await page.evaluate(READ_KEEP_OPTIONS_FN)
    const picked = optsAfter.find((o) => o.checked)
    check(
      'B2b: 用户显式选中的保留目标是**第 3 条（C）**，不是第 1 条（A）',
      Boolean(picked && picked.seriesId === C) && picked.seriesId !== A,
      `picked=${picked ? picked.seriesId : null} expectedC=${C} firstA=${A}`,
    )

    // ── 下一步 → 确认步：删除清单列出 A、B（不含保留目标 C）──────────────
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-multi-next"]')
      if (b) b.click()
    })
    await delay(350)
    await shot(page, '04-dialog-step2.png')
    const del = await page.evaluate(READ_DELETE_FN)
    const sources = fx.filter((f) => f.seriesId !== C)
    const namesShown = sources.every((s) => del.list.some((n) => n.includes(s.title)))
    const keptNotListed = !del.list.some((n) => n.includes(fx[2].title))
    check(
      'B2c: 确认步删除清单列出被删源（A、B），不含保留目标 C',
      namesShown && keptNotListed,
      `namesShown=${namesShown} keptNotListed=${keptNotListed} list=${JSON.stringify(del.list)}`,
    )
    check(
      'B2d: 确认步出现「源剧集将被删除 / 不可撤销」警示',
      Boolean(del.warnText && /删除|无法撤销|undone|deleted/i.test(del.warnText)),
      `warnText=${JSON.stringify(del.warnText)}`,
    )

    // ── 确认合并 ───────────────────────────────────────────────────────
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-multi-confirm"]')
      if (b) b.click()
    })
    let merged = false
    for (let i = 0; i < 30; i++) {
      await delay(500)
      const list = await listSeries()
      if (!list.some((s) => s.id === A) && !list.some((s) => s.id === B)) {
        merged = true
        break
      }
    }
    await delay(600)
    await shot(page, '05-after-merge.png')

    const listAfter = await listSeries()
    const keptC = listAfter.find((s) => s.id === C)
    const goneA = !listAfter.some((s) => s.id === A)
    const goneB = !listAfter.some((s) => s.id === B)
    const keptDetail = keptC ? await getSeries(C) : null
    const keptItemIds = keptDetail ? keptDetail.episodes.map((e) => e.itemId) : []
    const ownership = sources.map((s) => ({ src: s.key, itemId: s.itemId, onKept: keptItemIds.includes(s.itemId) }))

    console.log(
      `[series-uiwall] after merge: merged=${merged} keptC=${!!keptC} goneA=${goneA} goneB=${goneB} keptEpisodes=${keptC ? keptC.episodeCount : null}`,
    )
    check(
      'B3a: 合并后**保留的是第 3 条（C）**（按 id 核，不按位置/顺序）',
      Boolean(keptC) && goneA && goneB,
      `keptC=${Boolean(keptC)} goneA=${goneA} goneB=${goneB} (expected kept=C=${C})`,
    )
    check(
      'B3b: 另 2 条源剧集（A、B）从列表消失',
      goneA && goneB,
      `goneA=${goneA} goneB=${goneB}`,
    )
    check(
      'B3c: 保留剧集 C 的分集数 = 3（各自 1 集并入）',
      Boolean(keptC) && keptC.episodeCount === 3,
      `episodeCount=${keptC ? keptC.episodeCount : null}`,
    )
    check(
      'B3d: A、B 的分集**确实挂到了保留的 C 上**（按 item id 逐条核）',
      ownership.every((o) => o.onKept),
      `ownership=${JSON.stringify(ownership)} keptItemIds=${JSON.stringify(keptItemIds)}`,
    )
    check(
      'B4: 整个合并**只发一个** POST /merge 请求',
      mergeReqs.length === 1,
      `mergeRequests=${mergeReqs.length} ${JSON.stringify(mergeReqs)}`,
    )

    // ── B6：剧集内页旧「合并」入口仍在且可用（不回归）────────────────────
    await page.evaluate((sid) => {
      const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
      const open = root && root.querySelector('[data-testid="series-card"]')
      if (open) open.click()
    }, C)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-merge"]'), {
      timeout: 15000,
    })
    const inPageMergeExists = await page.evaluate(
      () => !!document.querySelector('[data-testid="series-merge"]'),
    )
    await shot(page, '06-series-detail.png')
    // 点开它 → 旧对话框（含 <select> 下拉）应出现。
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge"]')
      if (b) b.click()
    })
    await delay(700)
    const legacyDialog = await page.evaluate(() => {
      const sels = [...document.querySelectorAll('select')]
      const sel = sels.find((s) => s.querySelectorAll('option').length >= 1)
      const text = document.body.innerText
      return {
        hasSelect: !!sel,
        optionCount: sel ? sel.querySelectorAll('option').length : 0,
        mentionsMerge: /合并/.test(text),
      }
    })
    await shot(page, '07-legacy-merge-dialog.png')
    check(
      'B6: 剧集内页旧「合并」入口 [series-merge] 仍存在且可打开旧对话框（含下拉选源）',
      inPageMergeExists && legacyDialog.hasSelect,
      `btnExists=${inPageMergeExists} legacyDialogHasSelect=${legacyDialog.hasSelect} options=${legacyDialog.optionCount}`,
    )
    // 关闭旧对话框（点遮罩）。
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll('select')].find((s) => s.querySelectorAll('option').length >= 1)
      const overlay = sel ? sel.closest('div.fixed') : null
      if (overlay) overlay.click()
    })
    await delay(300)

    // ── B7：页面健康 ───────────────────────────────────────────────────
    const pageErrs = page.pageErrors().slice(0, 5)
    check('B7a: 页面无未捕获异常（非白屏）', pageErrs.length === 0, pageErrs.length ? JSON.stringify(pageErrs) : 'none')

    const allConsoleErrs = page.consoleErrors()
    const nonFavicon = allConsoleErrs.filter((e) => !/favicon\.ico/.test(e))
    // 夹具假路径导致的 /raw 404：单列为「夹具产物」，不算产品错误，但如实打印。
    const fixtureRaw404 = nonFavicon.filter((e) => {
      const m = /\/api\/media\/items\/(\d+)\/raw/.exec(e)
      return m && fixtureItemIds.has(Number(m[1]))
    })
    const otherErrs = nonFavicon.filter((e) => !fixtureRaw404.includes(e))
    console.log(
      `[series-uiwall] console.errors total=${allConsoleErrs.length} nonFavicon=${nonFavicon.length} fixtureRaw404=${fixtureRaw404.length} other=${otherErrs.length}`,
    )
    if (fixtureRaw404.length) {
      console.log(
        `[series-uiwall] NOTE: ${fixtureRaw404.length} 个 404 来自夹具假路径（items ${JSON.stringify([...fixtureItemIds])} 的 /raw），非产品错误`,
      )
    }
    if (otherErrs.length) console.log('[series-uiwall] other console errors:', JSON.stringify(otherErrs))
    check(
      'B7b: 无 console.error（favicon 与夹具假路径 /raw 404 除外）',
      otherErrs.length === 0,
      otherErrs.length ? JSON.stringify(otherErrs) : `none (fixtureRaw404=${fixtureRaw404.length} excluded)`,
    )
  } finally {
    await browser.close()
    // ── 收尾清理：只删自己造的夹具（按记录到的 id）──────────────────────
    for (const id of created.series) await deleteSeries(id).catch(() => undefined)
    for (const id of created.items) await deleteItem(id).catch(() => undefined)
    await delay(150)
    const after = await seriesIdSet()
    const sameSet =
      after.length === baselineSeries.length && after.every((v, i) => v === baselineSeries[i])
    console.log(
      `[series-uiwall] cleanup: removed series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)}`,
    )
    console.log(`[series-uiwall] series ids after=${JSON.stringify(after)}`)
    check(
      '收尾：剧集 id 集合与开工前逐字一致（未误伤真实数据）',
      sameSet,
      sameSet
        ? `identical (${after.length} ids)`
        : `DIFF\n  before=${JSON.stringify(baselineSeries)}\n  after =${JSON.stringify(after)}`,
    )
  }

  console.log('[series-uiwall] screenshots ->', OUT_DIR)
  dumpResults()
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) process.exitCode = 2
}

main().catch((e) => {
  console.error('[series-uiwall] ERROR', (e && e.message) || e)
  process.exit(1)
})
