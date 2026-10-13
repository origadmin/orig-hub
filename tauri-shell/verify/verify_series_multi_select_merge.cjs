#!/usr/bin/env node
'use strict'

/**
 * BUG-186 真实 UI 验收：媒体库**剧集墙**多选剧集 → 合并（新增可达路径）。
 *
 * ## 缺陷回顾
 *
 * 合并是**剧集（series）级的对等操作**，入口却只挂在剧集**内页**
 * （`SeriesDetail.tsx` 的 `series-merge`），必须先进入一条才能操作它的同级实体；
 * 而且方向由「你先打开了谁」隐含决定（`SeriesDialog.tsx:231` 的 `target` 硬编码为当前剧集）。
 * 剧集墙**完全没有多选**，无法「选中 A + 选中 B → 合并」。
 *
 * ## 本脚本断言什么（打**真实渲染的 DOM** + 真实后端，不打内部函数）
 *
 *   A. **能力**：剧集墙上选中 **3 条**剧集 → 出现动作条 `[data-testid="series-selection-bar"]`
 *      与计数 `[data-testid="series-selection-count"]`。
 *   B. **方向显式**：打开合并对话框，**显式选第 2 条**为「保留目标」（故意不选第一条），
 *      删除清单里列出将被删的**源剧集名字**，且**不含**保留目标。
 *   C. **结果**：合并后**保留的就是第 2 条**（不是第一条）、另外 2 条从列表消失、
 *      保留那条的分集数 = 3（各自 1 集并入）。
 *   D. **原子性**：整个合并**只发一个** `POST /api/media/series/:id/merge` 请求
 *      （前端**禁止**循环调单源端点）。
 *
 * 反向证伪（断言不许假绿）：
 *   - `ORIG_VERIFY_REVERT=nomulti`：把剧集墙的「动作条可见」判据注回缺失态（动作条永不出现）
 *     → 断言 A（动作条出现）**必须转红**，exit 2。
 *     注：BUG-214 起动作条可见判据是 `seriesBulkReady`（选中 ≥1），合并能力判据
 *     `seriesMultiReady`（选中 ≥2）只是按钮的 enabled 条件 —— 注入点随之上移到
 *     可见判据，否则「动作条永不出现」这层证伪会失效（注入后动作条照旧在）。
 *   - `ORIG_VERIFY_REVERT=ordertarget`：把合并目标改成「第一个被点的」（顺序决定）
 *     → 断言 C（保留的是第 2 条）**必须转红**，exit 2。
 *   注入后等 Vite 重新编译再跑同一套断言；跑完**无论成败都在 finally 还原**并用 `sha256` 自证。
 *
 * ## 夹具（**只造自己的**，用完即删）
 *
 *   用 API 造 3 条可辨识剧集（名字带唯一后缀 `ZZ-Fixture-<A|B|C>-<ts>`），每条挂 1 个分集。
 *   收尾按记录下来的 id 精确删除 —— **绝不**碰用户的真实剧集。
 *
 * ## 环境（用**真实在跑**的服务，严禁隔离实例）
 *
 *     # 服务已在跑：vite 127.0.0.1:5180 / orig-tg 127.0.0.1:19787
 *     node verify/verify_series_multi_select_merge.cjs
 *     ORIG_VERIFY_REVERT=nomulti node verify/verify_series_multi_select_merge.cjs       # 期望 exit 2
 *     ORIG_VERIFY_REVERT=ordertarget node verify/verify_series_multi_select_merge.cjs   # 期望 exit 2
 *
 * ## Usage / Env
 *
 *   APP_URL          (default http://127.0.0.1:5180/)   前端 dev server
 *   TG_API           (default http://127.0.0.1:19787)   orig-tg：/api/media/*
 *   ORIG_VERIFY_OUT                                     证据/截图输出目录（默认系统临时目录）
 *   ORIG_VERIFY_REVERT                                   '' | nomulti | ordertarget
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = (process.env.TG_API || process.env.ORIG_TG_API || 'http://127.0.0.1:19787').replace(
  /\/$/,
  '',
)
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-series-multi-merge')

/** 反向证伪开关。 */
const REVERT = (process.env.ORIG_VERIFY_REVERT || '').trim().toLowerCase()
const REVERT_NOMULTI = REVERT === 'nomulti'
const REVERT_ORDERTARGET = REVERT === 'ordertarget'
const REVERT_ON = REVERT_NOMULTI || REVERT_ORDERTARGET

/** 被测源文件（活实现）。 */
const PANEL_SRC = path.resolve(__dirname, '..', 'src', 'components', 'MediaLibraryPanel.tsx')
const DIALOG_SRC = path.resolve(
  __dirname,
  '..',
  'src',
  'components',
  'media',
  'SeriesDialog.tsx',
)
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))

// ── 反向证伪锚点（源文件里**唯一**的字符串） ──────────────────────────────
/**
 * 动作条**可见**判据（MediaLibraryPanel.tsx）。
 *
 * BUG-214 前可见判据与「可合并」是同一条（`seriesMultiReady`，≥2）；BUG-214 把
 * 可见性放宽到 ≥1（`seriesBulkReady`），故注入点随之改到可见判据上，否则注入后
 * 动作条仍会出现、A2 仍是绿的（证伪失效）。合并按钮的 disabled 已由 A2 之外的
 * 判据覆盖（`series-merge-wall` 存在 + `disabled` 状态）。
 */
const NOMULTI_OLD = 'const seriesBulkReady = selectedSeriesList.length > 0'
const NOMULTI_NEW = 'const seriesBulkReady = false'
/** 合并目标解析（SeriesDialog.tsx）：显式选择 vs 顺序决定。 */
const ORDER_OLD = 'const target = series.find((s) => s.id === targetId) ?? null'
const ORDER_NEW = 'const target = series[0] ?? null'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── 断言记录 ──────────────────────────────

const results = []

/**
 * 记录并打印一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 实测细节
 * @param {string} id 稳定标识（反向证伪用它精确定位「核心断言」）
 * @returns {boolean} ok
 */
function check(name, ok, detail = '', id = '') {
  results.push({ name, ok: Boolean(ok), detail, id })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`[series-multi-merge] ${results.length - failed}/${results.length} assertions passed`)
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

// ────────────────────────────── HTTP 小工具（仅回环） ──────────────────────────────

/** 回环请求 → JSON（失败返回 {status:0}）。 */
async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
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

/** GET 纯文本（探测 Vite 转译产物）。 */
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

/** 列出全部剧集。 */
async function listSeries() {
  const r = await httpJson('GET', `${TG_API}/api/media/series`)
  return r.json && Array.isArray(r.json.items) ? r.json.items : []
}

/** 取剧集详情（不存在返回 null）。 */
async function getSeries(id) {
  const r = await httpJson('GET', `${TG_API}/api/media/series/${id}`)
  return r.status === 200 && r.json ? r.json : null
}

/** 造一个本地条目（唯一假路径 → 唯一 ref，绝不与真实数据碰撞）。 */
async function createItem(title, ts) {
  const fakePath = path.join(os.tmpdir(), `orighub-fixture-${ts}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
  const r = await httpJson('POST', `${TG_API}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, fakePath, status: r.status, body: r.json }
}

/** 造一条剧集。 */
async function createSeries(title) {
  const r = await httpJson('POST', `${TG_API}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status, body: r.json }
}

/** 给剧集挂 1 个分集。 */
async function addEpisode(seriesId, itemId) {
  const r = await httpJson('POST', `${TG_API}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo: 1,
  })
  return { status: r.status, body: r.json }
}

/** 删剧集（幂等：不存在也当成功）。 */
async function deleteSeries(id) {
  return httpJson('DELETE', `${TG_API}/api/media/series/${id}`)
}

/** 删条目（幂等：不存在也当成功）。 */
async function deleteItem(id) {
  return httpJson('DELETE', `${TG_API}/api/media/items/${id}`)
}

// ────────────────────────────── DOM 扫描（真实渲染） ──────────────────────────────

/** 剧集墙上是否存在动作条 / 计数 / 清空按钮 / 合并按钮。 */
const SCAN_BAR_FN = () => {
  const bar = document.querySelector('[data-testid="series-selection-bar"]')
  const count = document.querySelector('[data-testid="series-selection-count"]')
  const mergeBtn = document.querySelector('[data-testid="series-merge-wall"]')
  const clearBtn = document.querySelector('[data-testid="series-selection-clear"]')
  return {
    hasBar: !!bar,
    countText: count ? count.textContent.trim() : null,
    hasMerge: !!mergeBtn,
    mergeText: mergeBtn ? mergeBtn.textContent.trim() : null,
    hasClear: !!clearBtn,
  }
}

/** 读取剧集墙当前展示的 series id 集合 + 每条选中态。 */
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

/** 读取合并对话框「保留目标」选项。 */
const READ_KEEP_OPTIONS_FN = () => {
  const opts = []
  document.querySelectorAll('[data-testid="series-merge-keep-option"]').forEach((o) => {
    const input = o.querySelector('input[type="radio"]')
    opts.push({
      seriesId: Number(o.getAttribute('data-series-id')),
      checked: input ? input.checked : false,
      title: o.textContent.trim(),
    })
  })
  return opts
}

/** 读取「将删除」清单里的名字。 */
const READ_DELETE_LIST_FN = () => {
  const lis = [...document.querySelectorAll('[data-testid="series-merge-delete-list"] li')].map((li) =>
    li.textContent.trim(),
  )
  // 第一步的 willDelete 列表（无 data-testid）——取 destructive 区块里的 li。
  const step1 = [...document.querySelectorAll('ul.list-disc li')].map((li) => li.textContent.trim())
  const warn = document.querySelector('[data-testid="series-merge-confirm-warn"]')
  return { step2: lis, step1, warnText: warn ? warn.textContent.trim() : null }
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[series-multi-merge] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[series-multi-merge] shot ${name} FAILED: ${e.message}`)
  }
}

// ────────────────────────────── 反向证伪 ──────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * 把「修复前形态」注回源文件。
 * @returns {{file:string, original:string}[]} 原始内容（用于还原）
 */
function injectPreFixForm() {
  const backups = []
  if (REVERT_NOMULTI) {
    const original = fs.readFileSync(PANEL_SRC, 'utf8')
    if (!original.includes(NOMULTI_OLD)) {
      throw new Error(`revert nomulti: anchor not found: ${NOMULTI_OLD}`)
    }
    const patched = original.replace(NOMULTI_OLD, NOMULTI_NEW)
    if (patched === original) throw new Error('revert nomulti: no change produced')
    fs.writeFileSync(PANEL_SRC, patched)
    backups.push({ file: PANEL_SRC, original })
  }
  if (REVERT_ORDERTARGET) {
    const original = fs.readFileSync(DIALOG_SRC, 'utf8')
    if (!original.includes(ORDER_OLD)) {
      throw new Error(`revert ordertarget: anchor not found: ${ORDER_OLD}`)
    }
    const patched = original.replace(ORDER_OLD, ORDER_NEW)
    if (patched === original) throw new Error('revert ordertarget: no change produced')
    fs.writeFileSync(DIALOG_SRC, patched)
    backups.push({ file: DIALOG_SRC, original })
  }
  return backups
}

/** 还原源文件（幂等）。 */
function restoreSources(backups) {
  if (!Array.isArray(backups)) return
  for (const b of backups) fs.writeFileSync(b.file, b.original)
}

/** 轮询 Vite 转译产物，确认「修复前形态」已被服务端编译出来。 */
async function waitForServedMarker(modulePath, expectPresent, expectAbsent, timeoutMs = 25000) {
  const url = `${APP_URL.replace(/\/$/, '')}${modulePath}`
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const body = await httpGetText(url, 4000)
    if (body != null) {
      last = body
      const hasPresent = expectPresent ? body.includes(expectPresent) : true
      const hasAbsent = expectAbsent ? body.includes(expectAbsent) : false
      if (hasPresent && !hasAbsent) return { ok: true, hasPresent, hasAbsent }
    }
    await delay(400)
  }
  return {
    ok: false,
    hasPresent: expectPresent ? last.includes(expectPresent) : true,
    hasAbsent: expectAbsent ? last.includes(expectAbsent) : false,
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assertOutDirSafe(OUT_DIR)

  console.log(`[series-multi-merge] app=${APP_URL} tg-api=${TG_API} out=${OUT_DIR}`)
  console.log(`[series-multi-merge] revert mode: ${REVERT_ON ? REVERT : 'off'}`)

  // ── 环境自检 ───────────────────────────────────────────────────────
  const seriesProbe = await httpJson('GET', `${TG_API}/api/media/series`)
  if (seriesProbe.status !== 200) {
    console.error(`[series-multi-merge] orig-tg media API not reachable (status=${seriesProbe.status}). Aborting (env).`)
    process.exit(1)
  }
  const appProbe = await httpGetText(APP_URL, 6000)
  if (appProbe == null) {
    console.error(`[series-multi-merge] dev server ${APP_URL} not reachable. Aborting (env).`)
    process.exit(1)
  }

  // ── 反向证伪：注回修复前形态（跑完在 finally 还原） ────────────────────
  let backups = null
  const hashesBefore = {}
  if (REVERT_ON) {
    backups = injectPreFixForm()
    for (const b of backups) hashesBefore[b.file] = sha256(b.original)
    const ok =
      REVERT_NOMULTI
        ? await waitForServedMarker(
            '/src/components/MediaLibraryPanel.tsx',
            NOMULTI_NEW,
            'seriesBulkReady = selectedSeriesList.length',
          )
        : await waitForServedMarker(
            '/src/components/media/SeriesDialog.tsx',
            'series[0] ?? null',
            'series.find((s) => s.id === targetId)',
          )
    console.log(
      `[series-multi-merge] revert: injected (${REVERT}) | vite served reverted module: ${ok.ok}` +
        (ok.ok ? '' : ` (hasPresent=${ok.hasPresent} hasAbsent=${ok.hasAbsent})`),
    )
    if (!ok.ok) {
      restoreSources(backups)
      backups = null
      throw new Error('revert: Vite did not serve the reverted module in time (source restored)')
    }
  }

  // 进程级兜底：异常退出也要还原。
  const cleanupRestore = () => {
    if (REVERT_ON && backups != null) restoreSources(backups)
  }
  process.on('exit', cleanupRestore)
  process.on('SIGINT', () => {
    cleanupRestore()
    process.exit(130)
  })

  // ── 夹具（只造自己的；用完即删） ──────────────────────────────────────
  const ts = Date.now()
  const fixture = [] // { key, seriesId, itemId, title }
  const created = { series: [], items: [] }

  const browser = await cdp.launch()
  try {
    // 造 3 条剧集（A / B / C），每条挂 1 个分集。
    for (const key of ['A', 'B', 'C']) {
      const title = `ZZ-Fixture-${key}-${ts}`
      const item = await createItem(title, ts)
      if (item.id == null) throw new Error(`fixture item ${key} not created (status=${item.status})`)
      created.items.push(item.id)
      const s = await createSeries(title)
      if (s.id == null) throw new Error(`fixture series ${key} not created (status=${s.status})`)
      created.series.push(s.id)
      const ep = await addEpisode(s.id, item.id)
      if (ep.status !== 200) throw new Error(`fixture episode ${key} not added (status=${ep.status})`)
      fixture.push({ key, seriesId: s.id, itemId: item.id, title })
    }
    console.log(
      `[series-multi-merge] fixtures: ${JSON.stringify(fixture.map((f) => ({ k: f.key, seriesId: f.seriesId, title: f.title })))}`,
    )

    // ── 打开媒体库剧集墙 ─────────────────────────────────────────────
    const page = await browser.newPage()
    // 网络监听：统计 /merge 的 POST 次数（原子性断言）。
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
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-child-lib-series entry not found')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
      { timeout: 20000 },
    )
    await delay(1000)

    // 确认 3 条夹具都在墙上。
    const wallIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="series-card-root"]')].map((r) =>
        Number(r.getAttribute('data-series-id')),
      ),
    )
    const allOnWall = fixture.every((f) => wallIds.includes(f.seriesId))
    check(
      'A1: 3 条夹具剧集都渲染在剧集墙上',
      allOnWall,
      `fixture=${JSON.stringify(fixture.map((f) => f.seriesId))} onWall=${allOnWall}`,
      'A1',
    )
    await shot(page, '01-series-wall.png')

    // ── 选中 3 条（点击顺序 A → B → C）────────────────────────────────
    const idsInClickOrder = fixture.map((f) => f.seriesId) // [A, B, C]
    for (const id of idsInClickOrder) {
      await page.evaluate((sid) => {
        const root = document.querySelector(
          `[data-testid="series-card-root"][data-series-id="${sid}"]`,
        )
        const btn = root && root.querySelector('[data-testid="series-card-select"]')
        if (btn) btn.click()
      }, id)
      await delay(250)
    }
    await delay(400)

    const wall = await page.evaluate(READ_WALL_FN)
    const selectedCount = wall.filter((w) => w.selected).length
    console.log(`[series-multi-merge] wall selection: ${JSON.stringify(wall.filter((w) => w.selected))}`)

    const bar = await page.evaluate(SCAN_BAR_FN)
    console.log(`[series-multi-merge] bar scan: ${JSON.stringify(bar)}`)

    // ★ 核心断言（nomulti 反向证伪对象）：选中 ≥2 → 动作条出现。
    check(
      'A2: 剧集墙选中 ≥2 条后出现动作条 [series-selection-bar]',
      bar.hasBar && bar.hasMerge,
      `hasBar=${bar.hasBar} hasMerge=${bar.hasMerge} selectedCount=${selectedCount}`,
      'A2',
    )
    check(
      'A3: 动作条计数文案显示「已选 3 条」',
      Boolean(bar.countText && /3/.test(bar.countText)),
      `countText=${JSON.stringify(bar.countText)}`,
      'A3',
    )
    // i18n：文案取自 locale（zh-CN / en-US 任一），不是硬编码。
    const countTemplates = [
      (ZH['media.seriesSelectionCount'] || '').replace('{n}', '3'),
      (EN['media.seriesSelectionCount'] || '').replace('{n}', '3'),
    ].filter(Boolean)
    const mergeLabels = [ZH['media.seriesMergeOpen'], EN['media.seriesMergeOpen']].filter(Boolean)
    check(
      'A4: 动作条文案走 i18n（计数模板 + 「合并剧集」按钮）',
      countTemplates.includes(bar.countText) && mergeLabels.includes(bar.mergeText),
      `countText=${JSON.stringify(bar.countText)} in ${JSON.stringify(countTemplates)} | mergeText=${JSON.stringify(bar.mergeText)} in ${JSON.stringify(mergeLabels)}`,
      'A4',
    )

    if (!bar.hasBar) {
      // 动作条缺失（nomulti 注入态）：核心断言已红，无法继续走对话框。
      console.log('[series-multi-merge] selection bar missing — skipping dialog flow (expected under nomulti revert)')
    } else {
      // ── 打开合并对话框 ─────────────────────────────────────────────
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-merge-wall"]')
        if (b) b.click()
      })
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="series-merge-multi-dialog"]'),
        { timeout: 10000 },
      )
      await delay(400)
      await shot(page, '02-merge-dialog-step1.png')

      const opts = await page.evaluate(READ_KEEP_OPTIONS_FN)
      console.log(`[series-multi-merge] keep options: ${JSON.stringify(opts)}`)
      check(
        'B1: 对话框列出全部 3 条「保留目标」候选',
        opts.length === 3,
        `options=${opts.length}`,
        'B1',
      )

      // ── 显式选**第 2 条**（B）为保留目标（故意不选第一条 A）──────────
      const keepTarget = fixture[1] // B
      await page.evaluate((sid) => {
        const o = document.querySelector(
          `[data-testid="series-merge-keep-option"][data-series-id="${sid}"]`,
        )
        const input = o && o.querySelector('input[type="radio"]')
        if (input) input.click()
        else if (o) o.click()
      }, keepTarget.seriesId)
      await delay(400)

      const optsAfter = await page.evaluate(READ_KEEP_OPTIONS_FN)
      const picked = optsAfter.find((o) => o.checked)
      console.log(`[series-multi-merge] picked keep target: ${JSON.stringify(picked)}`)
      check(
        'B2: 用户显式选中的保留目标是第 2 条（B），不是第 1 条（A）',
        Boolean(picked && picked.seriesId === keepTarget.seriesId),
        `picked=${picked ? picked.seriesId : null} expected=${keepTarget.seriesId}`,
        'B2',
      )

      // ── 下一步 → 确认步：删除清单列出被删的源名字（不含保留目标）────────
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-merge-multi-next"]')
        if (b) b.click()
      })
      await delay(400)
      await shot(page, '03-merge-dialog-step2.png')

      const del = await page.evaluate(READ_DELETE_LIST_FN)
      console.log(`[series-multi-merge] delete list: ${JSON.stringify(del)}`)
      const sources = fixture.filter((f) => f.seriesId !== keepTarget.seriesId)
      const namesShown = sources.every((s) => del.step2.some((n) => n.includes(s.title)))
      const keptNotListed = !del.step2.some((n) => n.includes(keepTarget.title))
      check(
        'B3: 确认步删除清单列出被删源剧集的名字（含 A、C，不含保留目标 B）',
        namesShown && keptNotListed,
        `namesShown=${namesShown} keptNotListed=${keptNotListed} list=${JSON.stringify(del.step2)}`,
        'B3',
      )
      check(
        'B4: 确认步出现「源剧集将被删除 / 不可撤销」类警示文案',
        Boolean(del.warnText && /删除|无法撤销|deleted|cannot be undone|undone/i.test(del.warnText)),
        `warnText=${JSON.stringify(del.warnText)}`,
        'B4',
      )

      // ── 确认合并 ───────────────────────────────────────────────────
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-merge-multi-confirm"]')
        if (b) b.click()
      })

      // 等合并完成：列表里 A、C 消失。
      let merged = false
      for (let i = 0; i < 30; i++) {
        await delay(500)
        const list = await listSeries()
        const hasA = list.some((s) => s.id === fixture[0].seriesId)
        const hasC = list.some((s) => s.id === fixture[2].seriesId)
        if (!hasA && !hasC) {
          merged = true
          break
        }
      }
      await delay(600)
      await shot(page, '04-after-merge.png')

      const listAfter = await listSeries()
      const kept = listAfter.find((s) => s.id === keepTarget.seriesId)
      const goneA = !listAfter.some((s) => s.id === fixture[0].seriesId)
      const goneC = !listAfter.some((s) => s.id === fixture[2].seriesId)
      const keptDetail = kept ? await getSeries(keepTarget.seriesId) : null
      const epCount = kept ? kept.episodeCount : null

      console.log(
        `[series-multi-merge] after merge: merged=${merged} keptB=${!!kept} goneA=${goneA} goneC=${goneC} keptEpisodes=${epCount}`,
      )

      // ★ 核心断言（ordertarget 反向证伪对象）：保留的是第 2 条（B）。
      check(
        'C1: 合并后**保留的是第 2 条（B）**，而不是第一条（A）',
        Boolean(kept) && goneA,
        `keptB=${Boolean(kept)} goneA=${goneA} (expected kept=B=${keepTarget.seriesId})`,
        'C1',
      )
      check(
        'C2: 另外 2 条源剧集（A、C）从列表中消失',
        goneA && goneC,
        `goneA=${goneA} goneC=${goneC}`,
        'C2',
      )
      check(
        'C3: 保留剧集的分集数 = 3（3 条各自 1 集并入）',
        epCount === 3,
        `episodeCount=${epCount} detailEps=${keptDetail ? keptDetail.episodes.length : 'n/a'}`,
        'C3',
      )
      check(
        'C4: 原子性 —— 整个合并只发一个 POST /merge 请求',
        mergeReqs.length === 1,
        `mergeRequests=${mergeReqs.length} ${JSON.stringify(mergeReqs)}`,
        'C4',
      )
    }

    // ── 页面健康 ─────────────────────────────────────────────────────
    const pageErrs = page.pageErrors().slice(0, 5)
    // 夹具 item id 白名单：本次运行自造的本地假路径条目（API 造不出真实 TG 上传）。
    const fixtureItemIds = new Set(created.items)
    const allConsoleErrs = page.consoleErrors()
    const nonFavicon = allConsoleErrs.filter((e) => !/favicon\.ico/.test(e))
    // 夹具假路径导致的 /raw 404：单列为「夹具产物」，不算产品错误，但如实打印。
    // **只认本次自造的那几个 item id** —— 绝不写成「忽略所有 /raw 404」。
    const fixtureRaw404 = nonFavicon.filter((e) => {
      const m = /\/api\/media\/items\/(\d+)\/raw/.exec(e)
      return m && fixtureItemIds.has(Number(m[1]))
    })
    const otherErrs = nonFavicon.filter((e) => !fixtureRaw404.includes(e))
    if (pageErrs.length) console.log('[series-multi-merge] page errors:', JSON.stringify(pageErrs))
    console.log(
      `[series-multi-merge] console.errors total=${allConsoleErrs.length} nonFavicon=${nonFavicon.length} fixtureRaw404=${fixtureRaw404.length} other=${otherErrs.length}`,
    )
    if (fixtureRaw404.length) {
      console.log(
        `[series-multi-merge] NOTE: ${fixtureRaw404.length} 个 404 来自夹具假路径（items ${JSON.stringify([...fixtureItemIds])} 的 /raw），非产品错误`,
      )
    }
    if (otherErrs.length) console.log('[series-multi-merge] other console errors:', JSON.stringify(otherErrs))
    check('页面无未捕获异常（非白屏）', pageErrs.length === 0, pageErrs.length ? JSON.stringify(pageErrs) : 'none')
    check(
      '页面无 console.error（favicon 与夹具假路径 /raw 404 除外）',
      otherErrs.length === 0,
      otherErrs.length
        ? JSON.stringify(otherErrs.slice(0, 5))
        : `none (fixtureRaw404=${fixtureRaw404.length} excluded)`,
    )

    // ── 反向证伪还原（dump 之前，好让「还原」本身也进断言清单）─────────────
    if (REVERT_ON && backups != null) {
      restoreSources(backups)
      let allIdentical = true
      const hashDetails = []
      for (const b of backups) {
        const nowText = fs.readFileSync(b.file, 'utf8')
        const hashAfter = sha256(nowText)
        const identical = hashAfter === hashesBefore[b.file]
        if (!identical) allIdentical = false
        hashDetails.push(`${path.basename(b.file)} ${hashesBefore[b.file]} -> ${hashAfter}`)
      }
      console.log(`[series-multi-merge] revert restore: ${hashDetails.join(' | ')}`)
      check(
        '反向证伪还原: 源文件逐字节还原（sha256 前后一致）',
        allIdentical,
        hashDetails.join(' | '),
      )
      backups = null
    }

    console.log('[series-multi-merge] screenshots ->', OUT_DIR)
    dumpResults()

    const failed = results.filter((r) => !r.ok).length
    if (REVERT_ON) {
      const coreId = REVERT_NOMULTI ? 'A2' : 'C1'
      const core = results.find((r) => r.id === coreId)
      const coreFailed = core && !core.ok
      if (coreFailed) {
        console.log(
          `[series-multi-merge] FALSIFICATION CONFIRMED: 注回修复前形态后核心断言转红（${core.name}）`,
        )
      } else {
        console.log(
          `[series-multi-merge] FALSIFICATION FAILED: 注回修复前形态后核心断言（${coreId}）仍绿 —— 本探针是假绿，需修断言`,
        )
        process.exitCode = 4
      }
    }
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    if (REVERT_ON && backups != null) {
      restoreSources(backups)
      console.log('[series-multi-merge] revert: source file restored (finally)')
    }
    // ── 收尾清理：只删自己造的夹具（按记录下来的 id）──────────────────────
    // 源剧集可能已被合并删除 → DELETE 幂等；条目同理。
    for (const id of created.series) {
      await deleteSeries(id).catch(() => undefined)
    }
    for (const id of created.items) {
      await deleteItem(id).catch(() => undefined)
    }
    // 二次确认：夹具剧集确实不在了。
    const leftover = await listSeries().catch(() => [])
    const stillThere = leftover.filter((s) => created.series.includes(s.id))
    console.log(
      `[series-multi-merge] cleanup: removed series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(stillThere.map((s) => s.id))}`,
    )
  }
}

main().catch((e) => {
  console.error('[series-multi-merge] ERROR', (e && e.message) || e)
  process.exit(1)
})
