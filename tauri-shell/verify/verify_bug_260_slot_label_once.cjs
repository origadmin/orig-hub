#!/usr/bin/env node
'use strict'

/**
 * BUG-260 **媒体库侧（shell）**验收：分集选择行中列**不得回退槽位标签**。
 *
 * ## 被验对象（产品裁定，活体取证后重写根因）
 *
 * BUG-260 文档原根因假设「BUG-246/BUG-200 把无标题分集的 ep.title 回填成槽位标签」
 * —— 该前提被活体证伪：BUG-200 的裁定恰是「集可以没有标题、空标题可显式清空」，
 * 实测 series 315 的 8 集里 7 集 `media_item.title` 就是空串。真正的重复机制是
 * **中列回退**：`SeriesDetail.tsx` 分集行是三列栅格，左列渲槽位标签
 * （`episodeSlotLabel`），中列旧代码 `shouldRenderEpisodeTitle(ep, detail)
 * ? ep.title : episodeSlotLabel(ep)` 在标题为空时把槽位标签再渲一遍 ⇒ 行文本
 * `S1E3S1E3未缓存`（实测）。照片集左列是 `🖼`，中列渲 BUG-049 兜底标题
 * （如 `TG 图片 #8609`），不再重复槽位标签。
 *
 * 修复（最小差异）：
 *   1. `shouldRenderEpisodeTitle` 增第三条判据 `epTitle !== episodeSlotLabel(ep)`；
 *   2. 新增纯函数 `episodeRowTitle(ep, series)`：门控为真返回标题，为假返回 null
 *      （**不回退槽位标签**）；
 *   3. `SeriesDetail.tsx` 分集行中列改渲 `episodeRowTitle(ep, detail)`；
 *   4. 右栏聚焦面板 `episode-focus-title` 的回退**保持原样**（面板内无左列，
 *      不构成重复；TL-21 布局回归 R5 依赖该回退）。
 *
 * ## 判据（全部打印实测值；禁 always-green；靶子运行时发现，不硬编码 series id）
 *
 *   0 数据前置（只读 API）：运行时发现「≥1 集标题为空串」的剧集（同时最好带
 *     ≥1 集真标题，反向防过度修正）与「含 photo 分集」的剧集；找不到即 FAIL。
 *   1 空标题剧集（核心）：每行按 API 的 season/episodeNo（含 episodeNoEnd 区间）
 *     算槽位标签，行文本中该标签**恰好出现 1 次**（0 ⇒ 展位丢失，≥2 ⇒ 本缺陷）；
 *     空标题行的中列必须**为空**（修复的直接读数）；有真标题（非空、≠剧集标题、
 *     ≠槽位标签）的行必须包含该标题原文（防过度修正成「一律不渲」）。
 *   2 照片剧集（防回归）：photo 行文本中 `🖼` 恰好 1 次；photo 行不出现槽位标签
 *     （左列是图标，中列不得回显）；有真标题的 photo 行包含标题原文。
 *   3 行数 sanity：pick 行数 === API 分集数（防空跑 / 防漏行）。
 *   4 反向证伪（牙齿）：把 `episodeRowTitle` 临时改成旧行为（中列回退槽位标签）
 *     ⇒ 判据 1 必须 FAIL（空标题行内出现 2 次）；**字节级还原**（禁 git checkout
 *     —— 会冲掉未提交改动），sha256 前后一致，且还原后 `shouldRenderEpisodeTitle`
 *     仍含第三条判据、`episodeRowTitle` 仍无回退；复跑回绿。
 *
 * ## 只读铁律
 *
 * - API 只 GET；UI 只导航 / 截图；不点任何编辑 / 保存 / 删除；零数据写入。
 * - 唯一写盘是反向证伪对 `src/lib/episodePresentation.ts` 的**临时注入 + 字节级还原**。
 *
 * ## 用法
 *
 *   node verify/verify_bug_260_slot_label_once.cjs
 *   APP_PORT=5180 DAEMON_PORT=19786 ORIG_VERIFY_SHOTS=<dir> node ...
 *
 * Exit: 0 = 全部 PASS；2 = 有 FAIL；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, 'evidence', 'BUG-260'),
)
/** 被验源文件（反向证伪的临时注入 / 字节级还原对象）。 */
const SRC_FILE = path.resolve(__dirname, '..', 'src', 'lib', 'episodePresentation.ts')
/** 剧集墙懒加载：滚多少屏找靶子卡（库内 ~70 部）。 */
const WALL_SCROLL_STEPS = Number(process.env.BUG260_WALL_SCROLL_STEPS || 40)
/** HMR settle：源码注入/还原后等 Vite 热更新落地再测量。 */
const HMR_SETTLE_MS = Number(process.env.BUG260_HMR_SETTLE_MS || 2500)

const checks = []
function check(id, label, ok, expected, actual) {
  checks.push({ id, label, ok: Boolean(ok), expected, actual })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}`)
  console.log(`        expected: ${expected}`)
  console.log(`        actual  : ${actual}`)
  return Boolean(ok)
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (_e) { json = null }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

async function resolveTg() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  if (cfg.status !== 200 || !cfg.json || !cfg.json.tg_port) return null
  return `http://127.0.0.1:${cfg.json.tg_port}`
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  // 行特写：先把分集选择器滚进视口，再整页截图
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="episode-pick"]') ||
      document.querySelector('[data-testid="episode-picker"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' })
    else window.scrollTo(0, 0)
  })
  await delay(400)
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try { size = fs.statSync(file).size } catch (_e) { /* ignore */ }
  console.log(`[bug260] shot ${name} (${size} bytes)`)
  return { file, size }
}

/** 用页面内 XHR 拉 JSON（真实数据通道，绕开任何 page-side 改动）。 */
async function xhrJson(page, url) {
  return page.evaluate(
    (u) =>
      new Promise((resolve, reject) => {
        const x = new XMLHttpRequest()
        x.open('GET', u, true)
        x.onload = () => {
          try { resolve(JSON.parse(x.responseText)) } catch (e) { reject(new Error('json parse failed: ' + e.message)) }
        }
        x.onerror = () => reject(new Error('xhr failed: ' + u))
        x.send()
      }),
    url,
  )
}

/** 侧栏 → 媒体库 → 剧集墙（一律 data-testid）。 */
async function gotoWall(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-media"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-media 入口不存在')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-panel-title"]'), {
    timeout: 25000,
    intervalMs: 300,
  })
  const railOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-rail-series-all"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!railOk) throw new Error('media-rail-series-all 入口不存在')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card-root"]').length > 0,
    { timeout: 25000, intervalMs: 300 },
  )
}

/** 剧集墙懒加载：滚到靶子卡出现为止。 */
async function scrollToCard(page, seriesId) {
  for (let i = 0; i < WALL_SCROLL_STEPS; i += 1) {
    const found = await page.evaluate(
      (sid) => Boolean(document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)),
      seriesId,
    )
    if (found) return true
    const moved = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="series-wall-scroll"]')
      const before = c ? c.scrollTop : window.scrollY
      if (c) c.scrollBy(0, Math.max(600, Math.floor(c.clientHeight * 0.9)))
      else window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.9)))
      const after = c ? c.scrollTop : window.scrollY
      return after > before
    })
    if (!moved) break
    await delay(300)
  }
  return false
}

/** 冷导航打开指定剧集详情（每次都回墙，避免跨剧残留 DOM）。 */
async function openSeriesFresh(page, seriesId) {
  await gotoWall(page)
  const found = await scrollToCard(page, seriesId)
  if (!found) throw new Error(`series-card data-series-id=${seriesId} 未在剧集墙出现（已滚 ${WALL_SCROLL_STEPS} 屏）`)
  await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (card) card.click()
  }, seriesId)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-picker"]'), {
    timeout: 25000,
    intervalMs: 300,
  })
  // 等分集行就绪并自证非空（空 = 还在加载或未落到目标剧集）
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="episode-pick"]').length > 0,
    { timeout: 20000, intervalMs: 300 },
  )
  await delay(600)
}

/** 页面内：分集选择行读数（行文本 + 左/中/右列，按 data-episode-id 归集）。 */
const READ_PICK_ROWS = () =>
  Array.from(document.querySelectorAll('[data-testid="episode-pick"]')).map((el) => {
    const kids = el.children
    const cols = []
    for (let i = 0; i < kids.length; i++) cols.push(String(kids[i].textContent || ''))
    return {
      epId: el.getAttribute('data-episode-id'),
      // 列间插分隔符再拼：textContent 直接拼接时，左列槽位标签会紧贴右列时长首数字
      // （空标题行 = "S1E1" + "4:26"），计数用的 `(?!\d)` 守卫（防 S1E1 数进 S1E10）
      // 会把这种紧贴误判成「标签是更长编号的前缀」而漏计 —— 实测踩过：绿态 0、红态 1。
      text: cols.join('\u0001'),
      left: cols.length >= 1 ? cols[0] : null,
      middle: cols.length >= 2 ? cols[1] : null,
      right: cols.length >= 3 ? cols[2] : null,
    }
  })

// ── node 侧判定工具（与 src 同规则但**独立实现**：验收不 import 被测代码） ──

/** 归一化：去变体选择符（emoji '🖼' 可能带 U+FE0F，两边都去才可比可数）。 */
const norm = (s) => String(s == null ? '' : s).replace(/\uFE0F/g, '')
const titleTrim = (ep) => String(ep.title == null ? '' : ep.title).trim()
const seriesTitleTrim = (detail) => String(detail.title == null ? '' : detail.title).trim()
const isPhotoEp = (ep) => ep.kind === 'photo'
/** 与 episodeSlotLabel 同规则：合集区间（episodeNoEnd > episodeNo）追 `-{end}`。 */
const slotLabelOf = (ep) =>
  `S${ep.season}E${ep.episodeNo}` +
  (ep.episodeNoEnd != null && ep.episodeNoEnd > ep.episodeNo ? `-${ep.episodeNoEnd}` : '')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * 行文本中槽位标签出现次数。
 * `(?!\d)` 守卫不可省：否则 `S1E1` 会数进 `S1E10` 里（实测库内有 10 集剧）。
 */
const countLabel = (text, label) => {
  if (!label) return 0
  const re = new RegExp(escapeRe(norm(label)) + '(?!\\d)', 'g')
  const m = norm(text).match(re)
  return m ? m.length : 0
}
const countGlyph = (text, glyph) => norm(text).split(norm(glyph)).length - 1
/** 与 shouldRenderEpisodeTitle（BUG-260 后）同规则的三条判据。 */
const titleGate = (ep, detail) => {
  const t = titleTrim(ep)
  return (
    t.length > 0 &&
    t !== seriesTitleTrim(detail) &&
    t !== slotLabelOf(ep)
  )
}
/**
 * 该行文本中槽位标签的**期望**次数（按裁定从 API 数据推，不读 DOM 中列——
 * 否则旧行为下「中列=标签」会把期望抬成 2，断言空转）。
 *   photo 行：左列是 🖼，槽位标签无展位 ⇒ 期望 0（中列不得回显）；
 *   其它行：左列 1 次 + 标题自带该串的次数（真标题可能含 `S1E3 重制版`）。
 */
const expectedLabelCount = (ep, detail) => {
  if (isPhotoEp(ep)) return 0
  return 1 + (titleGate(ep, detail) ? countLabel(titleTrim(ep), slotLabelOf(ep)) : 0)
}

/** 把 API 详情与行读数对齐，输出逐行判定表。 */
function evaluateRows(detail, rows) {
  const byId = new Map((detail.episodes || []).map((e) => [String(e.id), e]))
  return rows.map((r) => {
    const ep = byId.get(String(r.epId)) || null
    const label = ep ? slotLabelOf(ep) : null
    const actual = ep ? countLabel(r.text, label) : -1
    const expected = ep ? expectedLabelCount(ep, detail) : -1
    return {
      epId: r.epId,
      slot: label,
      kind: ep ? ep.kind : null,
      title: ep ? titleTrim(ep) : null,
      gate: ep ? titleGate(ep, detail) : null,
      actual,
      expected,
      ok: actual === expected,
      middle: r.middle,
      left: r.left,
      glyphCount: countGlyph(r.text, '🖼'),
      rowText: r.text,
    }
  })
}

const fmtRow = (r) =>
  `${r.slot}${r.kind === 'photo' ? '(photo)' : ''} title=${JSON.stringify(r.title)} ` +
  `labelCount=${r.actual}(exp ${r.expected}) middle=${JSON.stringify(r.middle)} glyph=${r.glyphCount}`

/**
 * 运行时发现靶子（不硬编码 series id）：
 *   targetEmpty = 空标题集数最多、且带真标题集的剧（核心咬合面）；
 *   targetPhoto = photo 分集最多的剧（防回归面）。
 */
async function discoverFixtures(page, TG) {
  const list = await xhrJson(page, `${TG}/api/media/series?limit=1000`)
  const items = (list && (list.items || list.series)) || []
  console.log(`[bug260] series list: ${items.length} 部（逐部取详情找形态，只读）`)
  const seen = []
  for (const s of items) {
    if (!s || s.id == null) continue
    const d = await xhrJson(page, `${TG}/api/media/series/${s.id}`)
    if (!d || !Array.isArray(d.episodes) || d.episodes.length === 0) continue
    seen.push({
      id: d.id,
      title: d.title,
      episodeCount: d.episodes.length,
      emptyCount: d.episodes.filter((e) => titleTrim(e).length === 0).length,
      realCount: d.episodes.filter((e) => titleGate(e, d)).length,
      photoCount: d.episodes.filter(isPhotoEp).length,
      detail: d,
    })
  }
  const withEmpty = seen.filter((x) => x.emptyCount > 0)
  withEmpty.sort((a, b) => b.emptyCount - a.emptyCount || b.realCount - a.realCount || a.id - b.id)
  const targetEmpty = withEmpty.find((x) => x.realCount > 0) || withEmpty[0] || null
  const withPhoto = seen.filter((x) => x.photoCount > 0)
  withPhoto.sort((a, b) => b.photoCount - a.photoCount || a.id - b.id)
  const targetPhoto = withPhoto[0] || null
  console.log(`[bug260] 候选（空标题）: ${JSON.stringify(withEmpty.slice(0, 5).map((x) => ({ id: x.id, empty: x.emptyCount, real: x.realCount, eps: x.episodeCount })))}`)
  console.log(`[bug260] 候选（photo）: ${JSON.stringify(withPhoto.slice(0, 5).map((x) => ({ id: x.id, photo: x.photoCount, eps: x.episodeCount })))}`)
  return { targetEmpty, targetPhoto, scanned: seen.length }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug260] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)
  console.log(`[bug260] src=${SRC_FILE}`)

  const TG = await resolveTg()
  if (!TG) { console.error('[bug260] daemon /api/config 未给出 tg_port —— 环境未就绪'); process.exit(1) }
  const app = await httpJson('GET', APP_URL)
  if (app.status !== 200) { console.error(`[bug260] app 不可达 HTTP ${app.status}`); process.exit(1) }
  console.log(`[bug260] tg=${TG}`)

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    // 禁用 HTTP 缓存：否则旧渲染被缓存，判据静默失效。
    await page.conn.send('Network.setCacheDisabled', { cacheDisabled: true }, { sessionId: page.sessionId })

    // 先导航到 app（页面内 XHR 需要 5180 源才能过 orig-tg 的 origin 回显 CORS）。
    await gotoWall(page)

    // ── 0. 数据前置：靶子运行时发现 ──────────────────────────────────
    console.log('\n[bug260] === 判据 0：数据前置（运行时发现靶子，不硬编码 series id） ===')
    const { targetEmpty, targetPhoto, scanned } = await discoverFixtures(page, TG)
    check('0.1', '发现「≥1 集标题为空串」的剧集（核心咬合面）',
      Boolean(targetEmpty),
      '全库扫描后至少 1 部剧含空标题分集',
      targetEmpty
        ? `series ${targetEmpty.id}（${JSON.stringify(targetEmpty.title)}）episodes=${targetEmpty.episodeCount} emptyTitle=${targetEmpty.emptyCount} realTitle=${targetEmpty.realCount}`
        : `scanned=${scanned}，无空标题分集`)
    check('0.2', '发现「含 photo 分集」的剧集（照片防回归面）',
      Boolean(targetPhoto),
      '全库扫描后至少 1 部剧含 kind=photo 分集',
      targetPhoto
        ? `series ${targetPhoto.id}（${JSON.stringify(targetPhoto.title)}）episodes=${targetPhoto.episodeCount} photo=${targetPhoto.photoCount}`
        : `scanned=${scanned}，无 photo 分集`)
    if (!targetEmpty || !targetPhoto) {
      console.error('[bug260] 靶子不足：无法证明任何判据（数据不足即退出，绝不输出「符合预期」）')
      process.exit(1)
    }
    // 核心靶子最好同时带真标题（判据 1 的反向防过度修正）；不带则明确记 FAIL
    check('0.3', '核心靶子同时含「真标题」分集（反向防过度修正面）',
      targetEmpty.realCount > 0,
      '靶子剧集至少有 1 集标题非空、≠ 剧集标题、≠ 槽位标签',
      `realTitle=${targetEmpty.realCount}`)
    if (targetEmpty.realCount === 0) {
      console.error('[bug260] 核心靶子没有真标题分集：判据 1 的反向面无从验证（数据不足即退出）')
      process.exit(1)
    }

    // ── 判据 1：空标题剧集（核心；旧代码必红） ───────────────────────
    console.log(`\n[bug260] === 判据 1：空标题剧集 series ${targetEmpty.id}（旧代码必红） ===`)
    await openSeriesFresh(page, targetEmpty.id)
    const detail = targetEmpty.detail
    const rows = await page.evaluate(READ_PICK_ROWS)
    const table = evaluateRows(detail, rows)
    for (const r of table) console.log(`[bug260]   row ${fmtRow(r)}`)
    await shot(page, '01-empty-title-rows-once.png')

    check('1.1', `series ${targetEmpty.id}：pick 行数 === API 分集数（sanity，防空跑）`,
      rows.length === detail.episodes.length,
      `rows === ${detail.episodes.length}`,
      `rows=${rows.length} apiEpisodes=${detail.episodes.length}`)

    const bad = table.filter((r) => !r.ok)
    check('1.2', `series ${targetEmpty.id}：每行槽位标签恰好出现期望次数（0 ⇒ 展位丢失，≥2 ⇒ 本缺陷）`,
      bad.length === 0,
      '所有行 labelCount === expected（非 photo 行 = 1 + 标题自带次数；photo 行 = 0）',
      bad.length ? `offenders: ${JSON.stringify(bad.map((r) => ({ slot: r.slot, actual: r.actual, expected: r.expected, middle: r.middle })))}` : `all ${table.length} rows ok`)

    const emptyRows = table.filter((r) => r.title === '')
    const emptyMiddleDirty = emptyRows.filter((r) => String(r.middle || '').trim().length > 0)
    check('1.3', `series ${targetEmpty.id}：${emptyRows.length} 个空标题行的中列为空（修复直接读数）`,
      emptyRows.length > 0 && emptyMiddleDirty.length === 0,
      '空标题行 middle === ""（episodeRowTitle 返回 null，不回退槽位标签）',
      emptyMiddleDirty.length
        ? `dirty: ${JSON.stringify(emptyMiddleDirty.map((r) => ({ slot: r.slot, middle: r.middle })))}`
        : `all ${emptyRows.length} empty-title rows have empty middle`)

    const realRows = table.filter((r) => r.gate === true)
    const realMissing = realRows.filter((r) => !r.rowText.includes(String((detail.episodes.find((e) => String(e.id) === String(r.epId)) || {}).title ?? '')))
    check('1.4', `series ${targetEmpty.id}：${realRows.length} 个真标题行的行文本包含标题原文（防过度修正）`,
      realRows.length > 0 && realMissing.length === 0,
      '每个真标题分集：rowText.includes(ep.title)',
      realMissing.length
        ? `missing: ${JSON.stringify(realMissing.map((r) => ({ slot: r.slot, title: r.title })))}`
        : `all ${realRows.length} real-title rows carry their title`)

    // ── 判据 2：照片剧集（防回归） ───────────────────────────────────
    console.log(`\n[bug260] === 判据 2：照片剧集 series ${targetPhoto.id}（🖼 恰好 1 次） ===`)
    await openSeriesFresh(page, targetPhoto.id)
    const photoDetail = targetPhoto.detail
    const photoRowsDom = await page.evaluate(READ_PICK_ROWS)
    const photoTable = evaluateRows(photoDetail, photoRowsDom)
    for (const r of photoTable) console.log(`[bug260]   row ${fmtRow(r)}`)
    await shot(page, '02-photo-rows.png')

    check('2.1', `series ${targetPhoto.id}：pick 行数 === API 分集数（sanity）`,
      photoRowsDom.length === photoDetail.episodes.length,
      `rows === ${photoDetail.episodes.length}`,
      `rows=${photoRowsDom.length} apiEpisodes=${photoDetail.episodes.length}`)

    const photoKindRows = photoTable.filter((r) => r.kind === 'photo')
    const glyphBad = photoKindRows.filter((r) => r.glyphCount !== 1)
    check('2.2', `series ${targetPhoto.id}：${photoKindRows.length} 个 photo 行的 🖼 恰好 1 次（防「🖼 🖼」回归）`,
      photoKindRows.length > 0 && glyphBad.length === 0,
      '每个 photo 行文本中 🖼（去变体选择符后）计数 === 1',
      glyphBad.length
        ? `offenders: ${JSON.stringify(glyphBad.map((r) => ({ slot: r.slot, glyph: r.glyphCount, text: r.rowText })))}`
        : `all ${photoKindRows.length} photo rows have exactly one 🖼`)

    const photoLabelBad = photoKindRows.filter((r) => r.actual !== 0)
    check('2.3', `series ${targetPhoto.id}：photo 行不出现槽位标签（左列是图标，中列不得回显）`,
      photoLabelBad.length === 0,
      'photo 行 labelCount === 0',
      photoLabelBad.length
        ? `offenders: ${JSON.stringify(photoLabelBad.map((r) => ({ slot: r.slot, actual: r.actual, middle: r.middle })))}`
        : `all ${photoKindRows.length} photo rows carry no slot label`)

    const photoReal = photoTable.filter((r) => r.gate === true)
    const photoRealMissing = photoReal.filter((r) => !r.rowText.includes(String((photoDetail.episodes.find((e) => String(e.id) === String(r.epId)) || {}).title ?? '')))
    check('2.4', `series ${targetPhoto.id}：${photoReal.length} 个真标题 photo 行包含标题原文（BUG-049 兜底标题仍在）`,
      photoReal.length > 0 && photoRealMissing.length === 0,
      '每个真标题 photo 分集：rowText.includes(ep.title)',
      photoRealMissing.length
        ? `missing: ${JSON.stringify(photoRealMissing.map((r) => ({ slot: r.slot, title: r.title })))}`
        : `all ${photoReal.length} rows carry their title`)

    const pageErrs = page.pageErrors().slice(0, 5)
    const consoleErrs = page.consoleErrors().slice(0, 8)
    console.log(`[bug260] pageErrors=${JSON.stringify(pageErrs)}`)
    console.log(`[bug260] consoleErrors(${consoleErrs.length})=${JSON.stringify(consoleErrs)}`)

    // ── 判据 4：反向证伪（牙齿） ─────────────────────────────────────
    console.log('\n[bug260] === 判据 4：反向证伪（episodeRowTitle 临时改回旧行为 ⇒ 判据 1 必须红） ===')
    const srcBefore = fs.readFileSync(SRC_FILE, 'utf8')
    const shaBefore = crypto.createHash('sha256').update(srcBefore).digest('hex')
    console.log(`[bug260] src sha256(before)=${shaBefore}`)
    const NEW_LINE = '  return shouldRenderEpisodeTitle(ep, series) ? ep.title ?? null : null'
    const OLD_LINE =
      '  // [BUG-260 咬合验证·临时] 旧行为：中列回退槽位标签（验完必须还原）\n' +
      '  return shouldRenderEpisodeTitle(ep, series) ? ep.title ?? episodeSlotLabel(ep) : episodeSlotLabel(ep)'
    const occurrences = srcBefore.split(NEW_LINE).length - 1
    check('4.1', '注入点唯一：episodeRowTitle 的新正文在源文件中恰好 1 处',
      occurrences === 1,
      'NEW_LINE 出现次数 === 1（多处 ⇒ 注入目标不明确，拒绝证伪）',
      `occurrences=${occurrences}`)

    if (occurrences === 1) {
      let redTable = null
      let redErr = null
      try {
        fs.writeFileSync(SRC_FILE, srcBefore.replace(NEW_LINE, OLD_LINE), 'utf8')
        console.log('[bug260] 已注入旧行为（中列回退槽位标签），等 HMR settle …')
        await delay(HMR_SETTLE_MS)
        await openSeriesFresh(page, targetEmpty.id)
        const redRows = await page.evaluate(READ_PICK_ROWS)
        redTable = evaluateRows(detail, redRows)
        for (const r of redTable) console.log(`[bug260]   red row ${fmtRow(r)}`)
        await shot(page, '03-falsification-old-fallback-red.png')
      } catch (e) {
        redErr = e
      } finally {
        // 字节级还原（禁 git checkout —— 会冲掉未提交改动）
        fs.writeFileSync(SRC_FILE, srcBefore, 'utf8')
        console.log('[bug260] 已字节级还原源文件')
      }
      const srcAfter = fs.readFileSync(SRC_FILE, 'utf8')
      const shaAfter = crypto.createHash('sha256').update(srcAfter).digest('hex')
      check('4.2', '字节级还原：sha256 前后一致',
        shaAfter === shaBefore,
        `sha256(after) === sha256(before) = ${shaBefore}`,
        `shaAfter=${shaAfter} match=${shaAfter === shaBefore}`)

      const fnTitle = /export function shouldRenderEpisodeTitle[\s\S]*?\n}/.exec(srcAfter)
      const fnRow = /export function episodeRowTitle[\s\S]*?\n}/.exec(srcAfter)
      check('4.3', '还原后 shouldRenderEpisodeTitle 仍含第三条判据（epTitle !== episodeSlotLabel(ep)）',
        Boolean(fnTitle) && fnTitle[0].includes('episodeSlotLabel(ep)'),
        '函数体出现 episodeSlotLabel(ep) 比较',
        fnTitle ? `bodyHasSlotLabelCompare=${fnTitle[0].includes('episodeSlotLabel(ep)')}` : 'function not found')
      check('4.4', '还原后 episodeRowTitle 无回退（函数体不含 episodeSlotLabel，且返回 null）',
        Boolean(fnRow) && !fnRow[0].includes('episodeSlotLabel') && fnRow[0].includes('null'),
        '函数体不含 episodeSlotLabel 且含 null 分支',
        fnRow ? `bodyHasSlotLabel=${fnRow[0].includes('episodeSlotLabel')} bodyHasNull=${fnRow[0].includes('null')}` : 'function not found')

      if (redErr) {
        check('4.5', '旧行为下判据 1 必须 FAIL（注入态测量本身失败 ⇒ 证伪无效）',
          false,
          '注入态能正常打开剧集并读行',
          `exception: ${redErr.message}`)
      } else if (redTable) {
        const redBad = redTable.filter((r) => !r.ok)
        const redEmptyDoubled = redTable.filter((r) => r.title === '' && r.actual === 2)
        check('4.5', '旧行为下判据 1 必须 FAIL：空标题行内槽位标签出现 2 次',
          redBad.length > 0 && redEmptyDoubled.length > 0,
          `注入态 offenders > 0 且空标题行 labelCount === 2（左列 + 中列各 1 次）`,
          `offenders=${redBad.length} emptyDoubled=${redEmptyDoubled.length}/${redTable.filter((r) => r.title === '').length} ` +
            `sample=${JSON.stringify(redBad.slice(0, 3).map((r) => ({ slot: r.slot, actual: r.actual, expected: r.expected, middle: r.middle })))}`)
      }

      // 还原后复跑回绿（HMR settle 后冷导航重测）
      await delay(HMR_SETTLE_MS)
      await openSeriesFresh(page, targetEmpty.id)
      const greenRows = await page.evaluate(READ_PICK_ROWS)
      const greenTable = evaluateRows(detail, greenRows)
      const greenBad = greenTable.filter((r) => !r.ok)
      check('4.6', '还原后判据 1 复绿（所有行回到期望次数）',
        greenBad.length === 0 && greenRows.length === detail.episodes.length,
        'offenders === 0 且行数 === API 分集数',
        greenBad.length
          ? `offenders: ${JSON.stringify(greenBad.map((r) => ({ slot: r.slot, actual: r.actual, expected: r.expected })))}`
          : `all ${greenTable.length} rows ok`)
      await shot(page, '04-falsification-restored-green.png')
    }

    // ── 汇总 ─────────────────────────────────────────────────────────
    const failed = checks.filter((c) => !c.ok)
    console.log('\n[bug260] === SUMMARY ===')
    console.log(`[bug260] shots: ${SHOTS}`)
    console.log(`[bug260] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[bug260] FAILED:', failed.map((c) => `${c.id}:${c.label}`).join(' | '))
    process.exitCode = failed.length ? 2 : 0
  } finally {
    if (browser) await browser.close()
  }
}

main().catch((e) => {
  console.error('[bug260] ERROR', (e && e.stack) || e)
  process.exit(1)
})
