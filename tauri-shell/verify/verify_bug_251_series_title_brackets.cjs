#!/usr/bin/env node
'use strict'

/**
 * BUG-251 真实 UI 验收：剧名「已自带书名号」时渲染层不得再套第二层（杜绝 `《《…》》`）。
 *
 * ## 缺陷回顾
 *
 * 剧集标题是自由文本，用户/来源可能**本就带书名号**。实测库里约 45.7%（16/35）的
 * 剧集标题含 `《`（如 `《小镇上的熟母露出俱乐部》`、`#ai短剧 #Ai成人短剧 《苏老师的裸贷人生》`、
 * `😀😀…#《存在感零》`）。渲染层若无脑套 `《{title}》`，近半数剧集显示成 `《《…》》`。
 * 修复：新增唯一入口 `src/lib/displayTitle.ts#seriesLabel`（已含 `《` 原样返回，否则包一层），
 * 所有原本会包裹剧名的位置一律改用它（硬编码处 + i18n 传参处）。
 *
 * ## 本脚本断言什么（真实 DOM + 真实后端；夹具自造自删，绝不动用户数据）
 *
 *   前置(P)：`GET /api/media/series` 中 `title` 含 `《` 的条数 **> 0**，并打印条数与前 3 个样本。
 *           —— 防止「库里没有合适样本 ⇒ 断言恒绿」。
 *   A1：选中「自带书名号」+「不自带」两条剧集 → 打开批量删除确认清单 → **逐行打印**，
 *       断言**没有任何一行包含 `《《`**（核心判据）。
 *   A2：自带书名号那条的**剧名标签**以 `《` 开头、以 `》` 结尾，且 `《` 计数 === 1（`》` 同理）；
 *       并断言标签 === 原始标题（幂等，未多包一层）。
 *   A3：不自带那条的标签 === `《原始标题》`（恰好一层）。
 *   A4：真实库里「以 `《` 开头」的剧集（最多 3 条）一并选入，其标签 === 原始标题且不含 `《《`。
 *   B1：合并对话框（选 ≥2 → `series-merge-wall`）正文含 `seriesMergeConfirmBody` 的**目标剧名**，
 *       断言弹窗正文不含 `《《`。
 *   B2：剧集卡选择框 `aria-label`（`seriesSelectionToggle`）不含 `《《`，且等于 `选择{书名单层标题}`。
 *   B3：批量打标对话框正文（`series-bulk-tag` → `BulkTagDialog scope="series"`）不含 `《《`。
 *       全程只到弹窗，点取消 —— **绝不真删/真合并/真打标**。
 *   C ：纯函数层（独立于 UI）用 `node --experimental-strip-types` 直接 import
 *       `src/lib/displayTitle.ts`，跑规则表 4 例。flag 不可用时如实标注跳过。
 *
 * ## 环境
 *
 *   vite dev + 后端。未就绪时用 `scripts/dev_services.py` 拉起（**不裸跑** orig-tg/daemon）。
 *   orig-tg 端口从 daemon `/api/config` 的 `tg_port` 取真源，不硬编码。
 *
 * 用法：`node verify/verify_bug_251_series_title_brackets.cjs`
 * Env : APP_PORT(5180) / DAEMON_PORT(19786) / ORIG_VERIFY_SHOTS
 * Exit: 0 = 全部通过；2 = 有判据失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, '..', 'verify_shots', 'bug251'),
)

/** 选中真实库里「以 《 开头」剧集的上限（给 A4 全库牙齿，又不至于噪声太多）。 */
const MAX_REAL_LEADING = 3

/**
 * C 段用的 ESM loader：把 `displayTitle.ts` 的 `../i18n` 依赖 stub 成读全局语言的
 * `getLanguage()`。Node 解析不了无扩展名的目录 import（`../i18n`），且 i18n 会拉起
 * JSON/store 链 —— 只 stub「语言来源」这一个依赖，被测函数本体仍是
 * `src/lib/displayTitle.ts` 原文。
 */
const LOADER_SRC = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../i18n') {
    const src = "export function getLanguage(){ return globalThis.__BUG251_LANG__ || 'zh-CN' }"
    return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail, id = '') {
  checks.push({ name, pass: Boolean(pass), detail, id })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(pass)
}

// ─────────────────────────── HTTP（仅回环） ───────────────────────────

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

async function resolveTgBase() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  if (cfg.status !== 200 || !cfg.json || !cfg.json.tg_port) return null
  return { base: `http://127.0.0.1:${cfg.json.tg_port}`, tgRunning: cfg.json.tg_running === true }
}

function startDevServices() {
  const repo = path.resolve(__dirname, '..', '..')
  const script = path.join(repo, 'scripts', 'dev_services.py')
  console.log(`[bug251] dev services not ready — starting ${script}`)
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

// ─────────────────────────── 夹具（只造自己的） ───────────────────────────

async function createItem(title, ts, tg) {
  const fakePath = path.join(os.tmpdir(), `orighub-bug251-${ts}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, status: r.status }
}

async function createSeries(title, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status }
}

async function addEpisode(seriesId, itemId, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo: 1,
  })
  return r.status
}

/**
 * 造两条**自己拥有的**剧集：
 *  - BR：标题**自带书名号**（模拟库里 45.7% 的真实形态；修复前必现 `《《》》`）
 *  - PL：标题**不带**书名号（应恰好被包一层）
 * 各 1 集。收尾按记录 id 精确删除，绝不碰用户数据。
 */
async function makeFixtures(tg) {
  const ts = Date.now()
  const specs = [
    { key: 'BR', title: `《ZZ-BUG251-BR-${ts}》` },
    { key: 'PL', title: `ZZ-BUG251-PL-${ts}` },
  ]
  const out = []
  for (const s of specs) {
    const item = await createItem(s.title, ts, tg)
    if (item.id == null) throw new Error(`fixture item ${s.key} not created (status=${item.status})`)
    const ser = await createSeries(s.title, tg)
    if (ser.id == null) throw new Error(`fixture series ${s.key} not created (status=${ser.status})`)
    const epStatus = await addEpisode(ser.id, item.id, tg)
    if (epStatus !== 200) throw new Error(`fixture episode ${s.key} not added (status=${epStatus})`)
    out.push({ key: s.key, title: s.title, seriesId: ser.id, itemId: item.id })
  }
  return out
}

// ─────────────────────────── DOM 判据 ───────────────────────────

/** 点选给定剧集卡（真实点击）。 */
async function selectSeries(page, ids) {
  for (const id of ids) {
    const ok = await page.evaluate((sid) => {
      const root = document.querySelector(
        `[data-testid="series-card-root"][data-series-id="${sid}"]`,
      )
      const btn = root && root.querySelector('[data-testid="series-card-select"]')
      if (!btn) return false
      btn.click()
      return true
    }, id)
    if (!ok) throw new Error(`series-card-select for ${id} not found`)
    await delay(180)
  }
}

/** 取行文案里的**剧名标签**：`{label} · {N} 集` → `label`。 */
function labelOfRow(text) {
  const idx = text.lastIndexOf(' · ')
  return idx >= 0 ? text.slice(0, idx).trim() : text.trim()
}

function countChar(s, ch) {
  let n = 0
  for (const c of s) if (c === ch) n += 1
  return n
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    /* 产物缺失不影响判据 */
  }
  console.log(`[bug251] shot ${name} -> ${file} (${size} bytes)`)
}

// ─────────────────────────── C 段：纯函数 ───────────────────────────

function runPureFunctionChecks() {
  const target = path.join(__dirname, '..', 'src', 'lib', 'displayTitle.ts')
  if (!fs.existsSync(target)) {
    return { ran: false, why: `模块不存在：${target}` }
  }
  // displayTitle.ts 现在 `import '../i18n'`（读 language）。用 loader 只 stub 语言来源。
  const loaderPath = path.join(os.tmpdir(), `bug251-strip-loader-${process.pid}.mjs`)
  fs.writeFileSync(loaderPath, LOADER_SRC)
  const loaderUrl = pathToFileURL(loaderPath).href
  const targetUrl = pathToFileURL(target).href
  const code = `
const m = await import(${JSON.stringify(targetUrl)});
const cases = [
  ['zh-CN', '《小镇上的熟母露出俱乐部》', '《小镇上的熟母露出俱乐部》'],
  ['zh-CN', '#ai短剧 #Ai成人短剧 《苏老师的裸贷人生》', '#ai短剧 #Ai成人短剧 《苏老师的裸贷人生》'],
  ['zh-CN', 'zz-BUG251-A', '《zz-BUG251-A》'],
  ['zh-CN', '', ''],
  ['en-US', '《小镇上的熟母露出俱乐部》', '《小镇上的熟母露出俱乐部》'],
  ['en-US', '#ai短剧 《苏老师的裸贷人生》', '#ai短剧 《苏老师的裸贷人生》'],
  ['en-US', 'zz-BUG251-A', '“zz-BUG251-A”'],
  ['en-US', '', ''],
];
const out = cases.map(([lang, input, expected]) => {
  globalThis.__BUG251_LANG__ = lang;
  const got = m.seriesLabel(input);
  return { lang, input, expected, got, ok: got === expected };
});
process.stdout.write('__RESULT__' + JSON.stringify(out));
`
  try {
    const raw = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--experimental-loader',
        loaderUrl,
        '--input-type=module',
        '-e',
        code,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const marker = raw.indexOf('__RESULT__')
    if (marker < 0) return { ran: false, why: `未取到结果标记；stdout=${JSON.stringify(raw.slice(0, 400))}` }
    return { ran: true, rows: JSON.parse(raw.slice(marker + '__RESULT__'.length)) }
  } catch (e) {
    const stderr = String((e && e.stderr) || '')
    // 允许在不支持 strip-types / loader 的 node 上如实跳过（不硬造替代）。
    if (/strip-types|--experimental-loader|ERR_UNKNOWN|not supported|Unexpected token|bad option/i.test(stderr + String((e && e.message) || ''))) {
      return { ran: false, why: `node 不支持 --experimental-strip-types / loader：${stderr.trim().slice(0, 240)}` }
    }
    return { ran: false, why: `执行失败：${String((e && e.message) || e).slice(0, 300)}` }
  } finally {
    try {
      fs.unlinkSync(loaderPath)
    } catch (_e) {
      /* ignore */
    }
  }
}

// ─────────────────────────── D 段：语言感知（en 语义） ───────────────────────────

/** 打开 设置 → 常规 页签，点语言按钮（按可见文案：'English' / '简体中文'）。 */
async function pickLanguage(page, label) {
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-settings"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-settings 入口不存在')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="settings-tab-general"]'), {
    timeout: 10000,
  })
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-tab-general"]')
    if (el) el.click()
  })
  await delay(400)
  const clicked = await page.evaluate((lbl) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === lbl)
    if (!btn) return false
    btn.click()
    return true
  }, label)
  if (!clicked) throw new Error(`语言按钮「${label}」未找到`)
}

async function htmlLang(page) {
  return page.evaluate(() => document.documentElement.getAttribute('lang'))
}

async function gotoSeriesWall(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-media"]')
    if (el) el.click()
  })
  await delay(1200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-rail-series-all"]')
    if (el) el.click()
  })
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug251] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)

  let envInfo = await resolveTgBase()
  if (!envInfo || !envInfo.tgRunning) {
    startDevServices()
    envInfo = await waitForEnv()
  }
  if (!envInfo || !envInfo.base || !envInfo.tgRunning) {
    console.error(`[bug251] 环境未就绪：${JSON.stringify(envInfo)}`)
    process.exit(1)
  }
  const TG = envInfo.base
  console.log(`[bug251] orig-tg = ${TG}（取自 daemon tg_port 真源）`)

  // ── 前置 P：真实库里含书名号的剧集必须非空 ──
  const lib = await httpJson('GET', `${TG}/api/media/series`)
  const allSeries = lib.json && Array.isArray(lib.json.items) ? lib.json.items : []
  const withBracket = allSeries.filter((s) => typeof s.title === 'string' && s.title.includes('《'))
  const leadingBracket = allSeries.filter(
    (s) => typeof s.title === 'string' && s.title.trim().startsWith('《'),
  )
  const samples = withBracket.slice(0, 3).map((s) => s.title)
  console.log(`[bug251] 全库剧集=${allSeries.length} 含《=${withBracket.length} 以《开头=${leadingBracket.length}`)
  console.log(`[bug251] 含《 前 3 样本: ${JSON.stringify(samples)}`)
  check(
    'P: 真实库中 title 含 《 的剧集条数 > 0（前置非空证明）',
    withBracket.length > 0,
    `count=${withBracket.length}/${allSeries.length} samples=${JSON.stringify(samples)}`,
    'P',
  )

  const realPick = leadingBracket.slice(0, MAX_REAL_LEADING).map((s) => ({
    id: s.id,
    title: s.title,
  }))

  let created = { series: [], items: [] }
  let browser = null
  let pageRef = null
  try {
    const fixture = await makeFixtures(TG)
    created = { series: fixture.map((f) => f.seriesId), items: fixture.map((f) => f.itemId) }
    const BR = fixture.find((f) => f.key === 'BR')
    const PL = fixture.find((f) => f.key === 'PL')
    console.log(`[bug251] fixtures: BR=${JSON.stringify(BR)} PL=${JSON.stringify(PL)}`)

    browser = await cdp.launch()
    const page = await browser.newPage()
    pageRef = page
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })

    // ── 导航（data-testid）：媒体库 → 剧集墙 ──
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-media 入口不存在')
    await delay(1500)
    const railOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-rail-series-all"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!railOk) throw new Error('media-rail-series-all 入口不存在')

    const wantIds = [BR.seriesId, PL.seriesId, ...realPick.map((r) => r.id)]
    await page.waitForFunction(
      (ids) =>
        ids.every((id) =>
          !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`),
        ),
      { timeout: 25000, args: [wantIds] },
    )

    await selectSeries(page, wantIds)
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-selection-bar"]'),
      { timeout: 10000 },
    )
    await delay(300)
    await shot(page, '01-wall-bracket-titles.png')

    // ── A1/A2/A3/A4：批量删除确认清单 ──
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-remove"]')
      if (b) b.click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-confirm-delete-list"]'),
      { timeout: 10000 },
    )
    const rows = await page.evaluate(() => {
      const els = document.querySelectorAll('[data-testid="series-confirm-delete-item"]')
      return [...els].map((e) => ({
        text: String(e.textContent || '').trim(),
        seriesId: e.getAttribute('data-series-id'),
      }))
    })
    await shot(page, '02-confirm-list.png')
    console.log('[bug251] 确认清单逐行实际文本：')
    for (const r of rows) console.log(`           ${JSON.stringify(r.text)}`)

    // A1：没有任何一行包含 《《
    const doubleRows = rows.filter((r) => r.text.includes('《《'))
    check(
      'A1: 确认清单没有任何一行包含 《《（核心判据）',
      rows.length > 0 && doubleRows.length === 0,
      `rows=${rows.length} 含《《的行=${doubleRows.length}` + (doubleRows.length ? ` -> ${JSON.stringify(doubleRows.map((r) => r.text))}` : ''),
      'A1',
    )

    // A2：BR（自带书名号）标签：以 《 开头、以 》 结尾、计数各 1，且 === 原始标题
    const brRow = rows.find((r) => labelOfRow(r.text).includes(`ZZ-BUG251-BR-`))
    let a2ok = false
    let a2detail = 'BR 行未找到'
    if (brRow) {
      const label = labelOfRow(brRow.text)
      const open = countChar(label, '《')
      const close = countChar(label, '》')
      a2ok =
        label.startsWith('《') &&
        label.endsWith('》') &&
        open === 1 &&
        close === 1 &&
        label === BR.title
      a2detail =
        `label=${JSON.stringify(label)} raw=${JSON.stringify(BR.title)} ` +
        `startsWith《=${label.startsWith('《')} endsWith》=${label.endsWith('》')} 计数《=${open} 计数》=${close}`
    }
    check('A2: 自带书名号剧名标签恰一层（=== 原始标题，计数各 1）', a2ok, a2detail, 'A2')

    // A3：PL（不自带）标签 === 《原始标题》，恰一层
    const plRow = rows.find((r) => labelOfRow(r.text).includes(`ZZ-BUG251-PL-`))
    let a3ok = false
    let a3detail = 'PL 行未找到'
    if (plRow) {
      const label = labelOfRow(plRow.text)
      const expected = `《${PL.title}》`
      a3ok = label === expected && label.startsWith('《') && label.endsWith('》')
      a3detail = `label=${JSON.stringify(label)} expected=${JSON.stringify(expected)}`
    }
    check('A3: 不自带书名号剧名标签恰被包一层', a3ok, a3detail, 'A3')

    // A4：真实库以 《 开头的剧集 —— 标签 === 原始标题且无 《《
    let a4ok = true
    const a4bad = []
    for (const r of realPick) {
      const row = rows.find((x) => labelOfRow(x.text) === r.title || labelOfRow(x.text).includes(r.title))
      const label = row ? labelOfRow(row.text) : null
      const good = label === r.title && !String(label).includes('《《')
      if (!good) {
        a4ok = false
        a4bad.push({ title: r.title, label })
      }
    }
    check(
      `A4: 真实库自带书名号剧集（${realPick.length} 条）标签 === 原始标题且无 《《`,
      realPick.length > 0 && a4ok,
      realPick.length === 0
        ? '真实库无以 《 开头的剧集可选'
        : `checked=${realPick.length} bad=${JSON.stringify(a4bad)}`,
      'A4',
    )

    // 取消删除确认（绝不点确认）
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-confirm-no"]')
      if (b) b.click()
    })
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="series-confirm-delete-list"]'), {
        timeout: 8000,
      })
      .catch(() => undefined)
    await delay(200)

    // ── B1：合并对话框正文不得出现 《《 ──
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-wall"]')
      if (b) b.click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-merge-multi-dialog"]'),
      { timeout: 10000 },
    )
    // 进到第二步（确认），正文才有被包裹的目标剧名。
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-multi-next"]')
      if (b) b.click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-merge-confirm-warn"]'),
      { timeout: 10000 },
    )
    const merge = await page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="series-merge-multi-dialog"]')
      const warn = document.querySelector('[data-testid="series-merge-confirm-warn"]')
      return {
        dialogText: dlg ? String(dlg.textContent || '') : '',
        warnText: warn ? String(warn.textContent || '').trim() : null,
      }
    })
    await shot(page, '03-merge-dialog.png')
    console.log(`[bug251] 合并确认正文: ${JSON.stringify(merge.warnText)}`)
    check(
      'B1: 合并对话框正文不含 《《',
      Boolean(merge.warnText) && !merge.dialogText.includes('《《'),
      `warn=${JSON.stringify(merge.warnText)} hasDouble=${merge.dialogText.includes('《《')}`,
      'B1',
    )
    // 取消合并（绝不点确认）
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-merge-multi-cancel"]')
      if (b) b.click()
    })
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="series-merge-multi-dialog"]'), {
        timeout: 8000,
      })
      .catch(() => undefined)
    await delay(200)

    // ── B2：选择框 aria-label（seriesSelectionToggle）不得出现 《《 ──
    const aria = await page.evaluate(
      (brId, plId) => {
        const read = (sid) => {
          const root = document.querySelector(
            `[data-testid="series-card-root"][data-series-id="${sid}"]`,
          )
          const btn = root && root.querySelector('[data-testid="series-card-select"]')
          return btn ? btn.getAttribute('aria-label') : null
        }
        return { br: read(brId), pl: read(plId) }
      },
      BR.seriesId,
      PL.seriesId,
    )
    console.log(`[bug251] aria-label: br=${JSON.stringify(aria.br)} pl=${JSON.stringify(aria.pl)}`)
    const ariaOk =
      Boolean(aria.br) &&
      Boolean(aria.pl) &&
      !aria.br.includes('《《') &&
      !aria.pl.includes('《《') &&
      aria.br === `选择${BR.title}` &&
      aria.pl === `选择《${PL.title}》`
    check(
      'B2: 选择框 aria-label 不含 《《 且恰一层书名号',
      ariaOk,
      `br=${JSON.stringify(aria.br)} pl=${JSON.stringify(aria.pl)}`,
      'B2',
    )

    // ── B3：批量打标对话框正文不得出现 《《 ──
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-tag"]')
      if (b) b.click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tag-picker-input"]'),
      { timeout: 10000 },
    )
    const tagText = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="tag-picker-input"]')
      const panel = input && input.closest('[class*="max-w-md"]')
      return panel ? String(panel.textContent || '') : null
    })
    console.log(`[bug251] 批量打标对话框正文片段: ${JSON.stringify((tagText || '').slice(0, 80))}`)
    check(
      'B3: 批量打标对话框正文不含 《《',
      Boolean(tagText) && !tagText.includes('《《'),
      `hasDouble=${tagText ? tagText.includes('《《') : 'no-panel'}`,
      'B3',
    )
    // 关闭打标对话框（点「取消」，绝不「应用」）
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="tag-picker-input"]')
      const panel = input && input.closest('[class*="max-w-md"]')
      const btn = panel && [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
      if (btn) btn.click()
    })
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="tag-picker-input"]'), { timeout: 8000 })
      .catch(() => undefined)

    // ── C：纯函数（独立于 UI，zh/en 两语言规则表） ──
    const pure = runPureFunctionChecks()
    if (pure.ran) {
      for (const r of pure.rows)
        console.log(
          `[bug251] C ${r.ok ? 'PASS' : 'FAIL'} [${r.lang}] seriesLabel(${JSON.stringify(r.input)}) = ${JSON.stringify(r.got)} (期望 ${JSON.stringify(r.expected)})`,
        )
      check(
        'C: 纯函数 seriesLabel 规则表 8/8（zh 4 + en 4）',
        pure.rows.every((r) => r.ok),
        `cases=${pure.rows.length} failed=${pure.rows.filter((r) => !r.ok).length}`,
        'C',
      )
    } else {
      check('C: 纯函数 seriesLabel 规则表 8/8（未能执行，如实标注）', false, `SKIP: ${pure.why}`, 'C')
    }

    // ── D：语言感知（BUG-251 en 语义修正） —— 标记形态随 UI 语言 ──
    console.log('[bug251] --- D 段：语言感知（en 不得出现中文书名号）---')
    try {
      // D1（zh 回归）：zh 下 aria-label === 选择《<标题>》，恰一层
      const zhAria = await page.evaluate(
        (brId, plId) => {
          const read = (sid) => {
            const root = document.querySelector(
              `[data-testid="series-card-root"][data-series-id="${sid}"]`,
            )
            const btn = root && root.querySelector('[data-testid="series-card-select"]')
            return btn ? btn.getAttribute('aria-label') : null
          }
          return { br: read(brId), pl: read(plId) }
        },
        BR.seriesId,
        PL.seriesId,
      )
      const zhLang = await htmlLang(page)
      console.log(`[bug251] D1 zh aria-label: br=${JSON.stringify(zhAria.br)} pl=${JSON.stringify(zhAria.pl)} lang=${zhLang}`)
      check(
        'D1: zh 下 aria-label === 选择《<标题>》（恰一层）',
        zhLang === 'zh-CN' &&
          zhAria.br === `选择${BR.title}` &&
          zhAria.pl === `选择《${PL.title}》`,
        `lang=${zhLang} br=${JSON.stringify(zhAria.br)} pl=${JSON.stringify(zhAria.pl)}`,
        'D1',
      )

      // D2：UI 路径切到 English → 未自带标记的标题必须用弯引号，不得含 《
      await pickLanguage(page, 'English')
      await page
        .waitForFunction(() => document.documentElement.getAttribute('lang') === 'en-US', { timeout: 8000 })
        .catch(() => undefined)
      await delay(500)
      await gotoSeriesWall(page)
      await page.waitForFunction(
        (ids) =>
          ids.every((id) =>
            !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`),
          ),
        { timeout: 20000, args: [[BR.seriesId, PL.seriesId]] },
      )
      const enAria = await page.evaluate(
        (brId, plId) => {
          const read = (sid) => {
            const root = document.querySelector(
              `[data-testid="series-card-root"][data-series-id="${sid}"]`,
            )
            const btn = root && root.querySelector('[data-testid="series-card-select"]')
            return btn ? btn.getAttribute('aria-label') : null
          }
          return { br: read(brId), pl: read(plId) }
        },
        BR.seriesId,
        PL.seriesId,
      )
      const enLang = await htmlLang(page)
      await shot(page, '04-en-aria-label.png')
      // PL（无标记）→ Select “PL”（弯引号，不得含 《）；BR（自带 《）→ 原样（含 《 是标题自身内容）
      const expPl = `Select “${PL.title}”`
      const expBr = `Select ${BR.title}`
      console.log(`[bug251] D2 en aria-label: br=${JSON.stringify(enAria.br)} pl=${JSON.stringify(enAria.pl)} lang=${enLang}`)
      check(
        'D2: en 下 aria-label 形如 Select “<标题>”（未自带标记者不得含 《）',
        enLang === 'en-US' && enAria.pl === expPl && !enAria.pl.includes('《') && enAria.br === expBr,
        `lang=${enLang} br=${JSON.stringify(enAria.br)} (exp ${JSON.stringify(expBr)}) pl=${JSON.stringify(enAria.pl)} (exp ${JSON.stringify(expPl)})`,
        'D2',
      )

      // D3：en 下删除确认清单同样无 《《
      await selectSeries(page, [BR.seriesId, PL.seriesId, ...realPick.map((r) => r.id)])
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="series-selection-bar"]'),
        { timeout: 10000 },
      )
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-bulk-remove"]')
        if (b) b.click()
      })
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="series-confirm-delete-list"]'),
        { timeout: 10000 },
      )
      const enRows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="series-confirm-delete-item"]')].map((e) =>
          String(e.textContent || '').trim(),
        ),
      )
      console.log('[bug251] D3 en 确认清单逐行：')
      for (const t of enRows) console.log(`           ${JSON.stringify(t)}`)
      check(
        'D3: en 下确认清单没有任何一行包含 《《',
        enRows.length > 0 && enRows.every((t) => !t.includes('《《')),
        `rows=${enRows.length} bad=${JSON.stringify(enRows.filter((t) => t.includes('《《')))}`,
        'D3',
      )
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="media-confirm-no"]')
        if (b) b.click()
      })
      await page
        .waitForFunction(() => !document.querySelector('[data-testid="series-confirm-delete-list"]'), {
          timeout: 8000,
        })
        .catch(() => undefined)
      await delay(200)
    } finally {
      // D4（还原）：无论上面成功与否，都把界面语言切回简体中文（不得留在英文）
      try {
        await pickLanguage(page, '简体中文')
        await page
          .waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN', { timeout: 8000 })
          .catch(() => undefined)
      } catch (_e) {
        /* 通道已断则放弃，外层 finally 还有一次尽力还原 */
      }
      const restoredLang = await htmlLang(page).catch(() => null)
      check('D4: 结束前界面语言已还原为 zh-CN（<html lang>）', restoredLang === 'zh-CN', `lang=${restoredLang}`, 'D4')
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug251] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[bug251] === SUMMARY ===')
    console.log(`[bug251] shots: ${SHOTS}`)
    console.log(`[bug251] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[bug251] FAILED:', failed.map((c) => `${c.id}:${c.name}`).join(' | '))
    if (failed.length) process.exitCode = 2
  } finally {
    // 尽力还原界面语言（不得把用户界面留在英文）—— 第二重兜底
    if (pageRef) {
      try {
        const lang = await pageRef
          .evaluate(() => document.documentElement.getAttribute('lang'))
          .catch(() => null)
        if (lang && lang !== 'zh-CN') {
          await pickLanguage(pageRef, '简体中文')
          const back = await pageRef
            .evaluate(() => document.documentElement.getAttribute('lang'))
            .catch(() => null)
          console.log(`[bug251] language restore(best-effort): ${lang} -> ${back}`)
        }
      } catch (_e) {
        /* 通道已断则放弃 */
      }
    }
    if (browser) await browser.close()
    for (const id of created.series) {
      await httpJson('DELETE', `${TG}/api/media/series/${id}`).catch(() => undefined)
    }
    for (const id of created.items) {
      await httpJson('DELETE', `${TG}/api/media/items/${id}`).catch(() => undefined)
    }
    const left = await httpJson('GET', `${TG}/api/media/series`)
    const still = (left.json && left.json.items ? left.json.items : []).filter((s) =>
      created.series.includes(s.id),
    )
    console.log(
      `[bug251] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`,
    )
  }
}

main().catch((e) => {
  console.error('[bug251] ERROR', (e && e.message) || e)
  process.exit(1)
})
