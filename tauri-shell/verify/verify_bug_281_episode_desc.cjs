#!/usr/bin/env node
'use strict'

/**
 * BUG-281 **媒体库侧（shell）**验收：分集介绍「按来源贴标签」取代「逐字相同即隐藏」。
 *
 * ## 被验对象（产品裁定，2026-10-12 用户定）
 *
 * TG 相册组只带**一条**组级 caption。旧门控 `shouldRenderEpisodeDescription`
 * 「与剧集介绍逐字相同 ⇒ 隐藏」把唯一的内容入口也藏了：实测全库 44 条有介绍的
 * 分集里 36 条逐字等于剧集介绍（series 315 EP6 即 232 字全等）⇒ 用户在几乎
 * 每一集读到空态「本集暂无介绍」（报障原话「大部分集是没有内容的」）。
 * 新规则：**非空即渲染**；逐字相等 ⇒ 贴「剧集介绍」标签，不同 ⇒ 「本集介绍」；
 * 连文本都没有才走空态 `media.descEmptyEp`。
 *
 * ## 判据（全部打印实测值；禁 always-green）
 *
 *   0 数据前置（只读）：DB 交叉复核 series 315 EP6 的介绍与剧集介绍**逐字全等**、
 *     series 215 EP5 的介绍**互不相同**；API 详情同旨。靶子不存在即报数据不足。
 *   1 剧集级分集（series 315 EP6，caption 归属集）：`episode-focus-desc`
 *     **可见**、非空、文本 === 该集介绍；区块标签 === 「剧集介绍」；空态文案不出现。
 *     —— **旧代码下 1.1~1.5 必 FAIL**（旧门控把逐字相同的介绍渲成空态）。
 *   2 本集级分集（series 215 EP5，介绍与剧集不同）：`episode-focus-desc` 可见、
 *     文本 === 该集自己的介绍且 ≠ 剧集介绍；标签 === 「本集介绍」。
 *     （旧代码下本组照旧 PASS —— 证明新断言咬的是「剧集级被藏」这一半。）
 *   3 剧集头介绍不回退：`series-description` 可见且文本 === 剧集介绍（两个剧集都比）。
 *   4 空态仍保留（咬合）：介绍为空的分集（series 315 EP1）仍显示空态、无
 *     `episode-focus-desc`；该剧所有非空介绍分集都渲到非空正文。
 *
 * ## 反向证伪（牙齿）手动流程
 *
 *   # 1) 临时把 episodePresentation.ts 的 shouldRenderEpisodeDescription 改回旧门控：
 *   #      return (ep.description ?? '').trim().length > 0 &&
 *   #             (ep.description ?? '').trim() !== (series.description ?? '').trim()
 *   ORIG_VERIFY_SHOTS=verify/evidence/BUG-281/falsification-old-gate \
 *     node verify/verify_bug_281_episode_desc.cjs   # 判据 1 必 FAIL，退出码 2
 *   # 2) 恢复新门控后重跑 ⇒ 全 PASS。
 *
 * ## 只读铁律
 *
 * - DB 一律 `node:sqlite` **只读**打开生产库；零写入、零夹具。
 * - UI 只导航 / 点选 / 截图；不点任何编辑 / 保存 / 删除。
 *
 * ## 用法
 *
 *   node verify/verify_bug_281_episode_desc.cjs
 *   APP_PORT=5180 DAEMON_PORT=19786 ORIG_VERIFY_SHOTS=<dir> node ...
 *
 * Exit: 0 = 全部 PASS；2 = 有 FAIL；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, 'evidence', 'BUG-281'),
)
/** 剧集级靶子：series 315《温柔的妈妈被我弄哭了》，EP6（item 1406）是 caption 归属集。 */
const SERIES_A = Number(process.env.BUG281_SERIES_A || 315)
/** 本集级靶子：series 215，EP5（item 612）的介绍与本剧不同。 */
const SERIES_B = Number(process.env.BUG281_SERIES_B || 215)
/** 剧集墙懒加载：滚多少屏找靶子卡（库内 72 部，靶子靠近列表头部）。 */
const WALL_SCROLL_STEPS = Number(process.env.BUG281_WALL_SCROLL_STEPS || 40)

const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const LABEL_SERIES = ZH['media.episode.sectionDescSeries'] // 「剧集介绍」
const LABEL_EPISODE = ZH['media.episode.sectionDesc'] // 「本集介绍」
const EMPTY_TEXT = ZH['media.descEmptyEp'] // 「本集暂无介绍」

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
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try { size = fs.statSync(file).size } catch (_e) { /* ignore */ }
  console.log(`[bug281] shot ${name} (${size} bytes)`)
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

/**
 * 只读交叉复核（生产库）：两个靶子分集的介绍与剧集介绍的字面关系。
 * 库不可用返回 null（判据降级为「仅 API 模型」，并明确打印降级原因）。
 */
function dbCrossCheck(seriesA, epA, seriesB, epB) {
  const appData = process.env.APPDATA
  const dbPath = appData ? path.join(appData, 'com.origadmin.orighub', 'tg', 'store.db') : ''
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { available: false, reason: `store.db not found (${dbPath || 'APPDATA unset'})` }
  }
  let DatabaseSync
  try { ({ DatabaseSync } = require('node:sqlite')) } catch (e) {
    return { available: false, reason: 'node:sqlite unavailable: ' + e.message }
  }
  let db
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch (e) {
    return { available: false, reason: 'open readOnly failed: ' + e.message }
  }
  try {
    const read = (sid, itemId) => {
      const s = db.prepare('SELECT COALESCE(description, \'\') AS d FROM media_series WHERE id = ?').get(sid)
      const i = db.prepare('SELECT COALESCE(description, \'\') AS d FROM media_item WHERE id = ?').get(itemId)
      return { seriesDesc: s ? s.d : null, itemDesc: i ? i.d : null }
    }
    const a = read(seriesA, epA.itemId)
    const b = read(seriesB, epB.itemId)
    return {
      available: true,
      a: {
        seriesLen: a.seriesDesc.length,
        itemLen: a.itemDesc.length,
        byteEqual: a.seriesDesc === a.itemDesc,
        trimmedEqual: a.seriesDesc.trim() === a.itemDesc.trim(),
      },
      b: {
        seriesLen: b.seriesDesc.length,
        itemLen: b.itemDesc.length,
        byteEqual: b.seriesDesc === b.itemDesc,
        trimmedEqual: b.seriesDesc.trim() === b.itemDesc.trim(),
      },
    }
  } catch (e) {
    return { available: false, reason: String((e && e.message) || e) }
  } finally {
    try { db.close() } catch (_e) { /* best effort */ }
  }
}

/** 右栏「本集介绍」区块读数（含可见性判定；旧代码无 label testid 时回退取兄弟 span）。 */
async function readDescBlock(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false
      const r = el.getBoundingClientRect()
      const cs = window.getComputedStyle(el)
      return (
        el.getClientRects().length > 0 &&
        r.width > 0 &&
        r.height > 0 &&
        cs.visibility !== 'hidden' &&
        cs.display !== 'none'
      )
    }
    const p = document.querySelector('[data-testid="episode-focus-desc"]')
    const labelEl = document.querySelector('[data-testid="episode-focus-desc-label"]')
    let label = null
    if (labelEl) label = String(labelEl.textContent || '').trim()
    else if (p && p.previousElementSibling) label = String(p.previousElementSibling.textContent || '').trim()
    const parent = p ? p.parentElement : labelEl ? labelEl.parentElement : null
    let emptyText = null
    if (parent) {
      const eps = [...parent.querySelectorAll('p')].filter((x) => x !== p)
      if (eps.length > 0) emptyText = String(eps[0].textContent || '').trim()
    }
    return {
      hasDesc: Boolean(p),
      descVisible: vis(p),
      descText: p ? String(p.textContent || '') : null,
      label,
      emptyText,
      hasLabelTestid: Boolean(labelEl),
    }
  })
}

/** 剧集头介绍读数（回归面：顶部介绍必须原样）。 */
async function readHeroDesc(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="series-description"]')
    const vis = (e) => {
      if (!e) return false
      const r = e.getBoundingClientRect()
      const cs = window.getComputedStyle(e)
      return e.getClientRects().length > 0 && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    return {
      present: Boolean(el),
      visible: vis(el),
      text: el ? String(el.textContent || '') : null,
    }
  })
}

/** 侧栏 → 媒体库 → 剧集墙（一律 data-testid）。 */
async function gotoWall(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-child-lib-series 入口不存在')
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

async function openSeries(page, seriesId) {
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
  await delay(600)
}

async function selectEpisode(page, episodeId) {
  await page.waitForFunction(
    (eid) => Boolean(document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)),
    { timeout: 20000, intervalMs: 300, args: [episodeId] },
  )
  await page.evaluate((eid) => {
    const row = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)
    if (row) row.click()
  }, episodeId)
  // 右栏头（episode-focus-title）在旧/新代码下都渲染 —— 以它为准切集完成，
  // 避免等待只存在于新代码的节点（那会让反向证伪变成超时崩溃而不是判定 FAIL）。
  await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), {
    timeout: 15000,
    intervalMs: 200,
  })
  await delay(500)
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug281] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)
  console.log(`[bug281] targets: seriesA=${SERIES_A} seriesB=${SERIES_B}`)

  const TG = await resolveTg()
  if (!TG) { console.error('[bug281] daemon /api/config 未给出 tg_port —— 环境未就绪'); process.exit(1) }
  const app = await httpJson('GET', APP_URL)
  if (app.status !== 200) { console.error(`[bug281] app 不可达 HTTP ${app.status}`); process.exit(1) }
  console.log(`[bug281] tg=${TG}`)

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    // 禁用 HTTP 缓存：否则旧结果的 404/旧渲染被缓存，判据静默失效。
    await page.conn.send('Network.setCacheDisabled', { cacheDisabled: true }, { sessionId: page.sessionId })

    // 先导航到 app（页面内 XHR 需要 5180 源才能过 orig-tg 的 origin 回显 CORS；
    // about:blank 的 origin=null 会被拒 —— 那不是环境故障，是探针自身顺序错误）。
    await gotoWall(page)

    // ── 0. 数据前置：靶子发现（API 详情，页面内 XHR） ─────────────────
    console.log('\n[bug281] === 判据 0：数据前置（靶子必须存在，否则无可证伪） ===')
    const detailA = await xhrJson(page, `${TG}/api/media/series/${SERIES_A}`)
    const detailB = await xhrJson(page, `${TG}/api/media/series/${SERIES_B}`)
    const epsA = (detailA && detailA.episodes) || []
    const epsB = (detailB && detailB.episodes) || []
    const seriesDescA = String((detailA && detailA.description) || '')
    const seriesDescB = String((detailB && detailB.description) || '')
    console.log(`[bug281] series ${SERIES_A} title=${JSON.stringify(detailA && detailA.title)} descLen=${seriesDescA.length} episodes=${epsA.length}`)
    console.log(`[bug281] series ${SERIES_B} title=${JSON.stringify(detailB && detailB.title)} descLen=${seriesDescB.length} episodes=${epsB.length}`)

    // 剧集级靶子：非空介绍且 trim 后逐字等于剧集介绍（caption 归属集，如 EP6）
    const epA = epsA.find(
      (e) => String(e.description || '').trim().length > 0 &&
        String(e.description || '').trim() === seriesDescA.trim(),
    ) || null
    // 本集级靶子：非空介绍且与剧集介绍不同（如 EP5）
    const epB = epsB.find(
      (e) => String(e.description || '').trim().length > 0 &&
        String(e.description || '').trim() !== seriesDescB.trim(),
    ) || null
    // 空态靶子：介绍为空的某一集（如 EP1）
    const epEmpty = epsA.find((e) => String(e.description || '').trim().length === 0) || null

    check('0.1', '剧集级靶子存在：series A 有「介绍非空且逐字等于剧集介绍」的分集',
      Boolean(epA),
      `series ${SERIES_A} 至少 1 集 description trim 后 === 剧集介绍（实测应为 EP6/item 1406）`,
      epA ? `epId=${epA.id} episodeNo=${epA.episodeNo} itemId=${epA.itemId} descLen=${String(epA.description || '').length}` : 'none')
    check('0.2', '本集级靶子存在：series B 有「介绍非空且与剧集介绍不同」的分集',
      Boolean(epB),
      `series ${SERIES_B} 至少 1 集 description trim 后 !== 剧集介绍（实测应为 EP5/item 612）`,
      epB ? `epId=${epB.id} episodeNo=${epB.episodeNo} itemId=${epB.itemId} descLen=${String(epB.description || '').length}` : 'none')
    check('0.3', '空态靶子存在：series A 有介绍为空的的分集（咬合面）',
      Boolean(epEmpty),
      `series ${SERIES_A} 至少 1 集 description 为空（实测应为 EP1）`,
      epEmpty ? `epId=${epEmpty.id} episodeNo=${epEmpty.episodeNo}` : 'none')
    if (!epA || !epB || !epEmpty) {
      console.error('[bug281] 靶子不足：无法证明任何判据（数据不足即退出，绝不输出「符合预期」）')
      process.exit(1)
    }

    // 只读 DB 交叉复核：靶子的字面关系不是从 UI 反推的，而是库里直接量的
    const dbFacts = dbCrossCheck(SERIES_A, epA, SERIES_B, epB)
    if (dbFacts.available) {
      console.log(`[bug281] DB(ro) A: seriesDescLen=${dbFacts.a.seriesLen} itemDescLen=${dbFacts.a.itemLen} byteEqual=${dbFacts.a.byteEqual} trimmedEqual=${dbFacts.a.trimmedEqual}`)
      console.log(`[bug281] DB(ro) B: seriesDescLen=${dbFacts.b.seriesLen} itemDescLen=${dbFacts.b.itemLen} byteEqual=${dbFacts.b.byteEqual} trimmedEqual=${dbFacts.b.trimmedEqual}`)
      check('0.4', 'DB(只读) 交叉复核：series A 靶子介绍与剧集介绍逐字全等（组级 caption 属实）',
        dbFacts.a.trimmedEqual === true && dbFacts.a.itemLen > 0,
        'trimmedEqual=true 且 itemDescLen>0',
        `trimmedEqual=${dbFacts.a.trimmedEqual} itemDescLen=${dbFacts.a.itemLen} seriesDescLen=${dbFacts.a.seriesLen}`)
      check('0.5', 'DB(只读) 交叉复核：series B 靶子介绍与剧集介绍不同（本集自有文案属实）',
        dbFacts.b.trimmedEqual === false && dbFacts.b.itemLen > 0,
        'trimmedEqual=false 且 itemDescLen>0',
        `trimmedEqual=${dbFacts.b.trimmedEqual} itemDescLen=${dbFacts.b.itemLen} seriesDescLen=${dbFacts.b.seriesLen}`)
    } else {
      console.log(`[bug281] DB(ro) 不可用，降级为仅 API 模型：${dbFacts.reason}`)
    }

    // ── 导航到 series A 详情（已在剧集墙上，直接开卡） ────────────────
    await openSeries(page, SERIES_A)

    // ── 判据 3（先在 A 页做）：剧集头介绍不回退 ───────────────────────
    console.log('\n[bug281] === 判据 3：剧集头介绍不回退（series A） ===')
    const heroA = await readHeroDesc(page)
    check('3.1', `series ${SERIES_A} 剧集头介绍可见且文本 === 剧集介绍（与 DB/API 一致）`,
      heroA.present && heroA.visible && heroA.text === seriesDescA,
      `series-description 可见，text === series ${SERIES_A} description（len=${seriesDescA.length}）`,
      `present=${heroA.present} visible=${heroA.visible} textLen=${heroA.text ? heroA.text.length : -1} identical=${heroA.text === seriesDescA}`)

    // ── 判据 1：剧集级分集（A 的 caption 归属集） ─────────────────────
    console.log(`\n[bug281] === 判据 1：剧集级分集（series ${SERIES_A} EP${epA.episodeNo}，旧代码必红） ===`)
    await selectEpisode(page, epA.id)
    const blockA = await readDescBlock(page)
    await shot(page, `01-series${SERIES_A}-ep${epA.episodeNo}-serieslevel-desc.png`)

    check('1.1', `series ${SERIES_A} EP${epA.episodeNo}：episode-focus-desc 在 DOM 中`,
      blockA.hasDesc === true,
      'querySelector([data-testid="episode-focus-desc"]) 非空',
      `hasDesc=${blockA.hasDesc} label=${JSON.stringify(blockA.label)} emptyText=${JSON.stringify(blockA.emptyText)}`)
    check('1.2', `series ${SERIES_A} EP${epA.episodeNo}：episode-focus-desc 可见（非 display:none / 零尺寸）`,
      blockA.hasDesc === true && blockA.descVisible === true,
      'hasDesc=true 且 descVisible=true（getClientRects + computed style 判定）',
      `hasDesc=${blockA.hasDesc} descVisible=${blockA.descVisible}`)
    check('1.3', `series ${SERIES_A} EP${epA.episodeNo}：正文非空且 === 该集介绍（trim 后逐字相等）`,
      blockA.descText != null && blockA.descText.trim() === String(epA.description || '').trim(),
      `text.trim() === API 下发的该集 description（len=${String(epA.description || '').length}）`,
      `textLen=${blockA.descText == null ? -1 : blockA.descText.length} identical=${blockA.descText != null && blockA.descText.trim() === String(epA.description || '').trim()}`)
    check('1.4', `series ${SERIES_A} EP${epA.episodeNo}：区块标签 === 「${LABEL_SERIES}」（剧集级来源）`,
      blockA.label === LABEL_SERIES,
      `label === "${LABEL_SERIES}"（zh: media.episode.sectionDescSeries）`,
      `label=${JSON.stringify(blockA.label)} hasLabelTestid=${blockA.hasLabelTestid}`)
    check('1.5', `series ${SERIES_A} EP${epA.episodeNo}：不出现空态文案「${EMPTY_TEXT}」`,
      blockA.emptyText !== EMPTY_TEXT,
      `空态 <p> 文本 !== "${EMPTY_TEXT}"`,
      `emptyText=${JSON.stringify(blockA.emptyText)}`)

    // ── 判据 4（A 页）：空态仍保留 + 非空分集全渲染 ───────────────────
    console.log(`\n[bug281] === 判据 4：空态咬合 + 非空分集不漏（series ${SERIES_A}） ===`)
    await selectEpisode(page, epEmpty.id)
    const blockEmpty = await readDescBlock(page)
    await shot(page, `02-series${SERIES_A}-ep${epEmpty.episodeNo}-empty-state.png`)
    check('4.1', `series ${SERIES_A} EP${epEmpty.episodeNo}（介绍为空）：仍走空态，无 episode-focus-desc`,
      blockEmpty.hasDesc === false && blockEmpty.emptyText === EMPTY_TEXT,
      `hasDesc=false 且空态文案 === "${EMPTY_TEXT}"`,
      `hasDesc=${blockEmpty.hasDesc} emptyText=${JSON.stringify(blockEmpty.emptyText)}`)

    const nonEmptyEps = epsA.filter((e) => String(e.description || '').trim().length > 0)
    console.log(`[bug281] series ${SERIES_A} 非空介绍分集数=${nonEmptyEps.length}（引擎回填前实测 1；回填后应为 8）`)
    let allNonEmptyRendered = true
    const renderedLens = []
    for (const e of nonEmptyEps) {
      await selectEpisode(page, e.id)
      const b = await readDescBlock(page)
      renderedLens.push({ epId: e.id, episodeNo: e.episodeNo, hasDesc: b.hasDesc, visible: b.descVisible, textLen: b.descText == null ? -1 : b.descText.length })
      if (!(b.hasDesc && b.descVisible && b.descText != null && b.descText.trim().length > 0)) allNonEmptyRendered = false
    }
    check('4.2', `series ${SERIES_A} 全部 ${nonEmptyEps.length} 个非空介绍分集都渲染出可见非空正文`,
      allNonEmptyRendered,
      '每个非空分集：hasDesc=true 且 visible 且 trim 后非空',
      JSON.stringify(renderedLens))

    // ── 导航到 series B 详情（重新走一遍墙，避免依赖视图返回栈） ───────
    await gotoWall(page)
    await openSeries(page, SERIES_B)

    // ── 判据 2：本集级分集（B 的自有介绍集） ─────────────────────────
    console.log(`\n[bug281] === 判据 2：本集级分集（series ${SERIES_B} EP${epB.episodeNo}） ===`)
    await selectEpisode(page, epB.id)
    const blockB = await readDescBlock(page)
    await shot(page, `03-series${SERIES_B}-ep${epB.episodeNo}-episodelevel-desc.png`)

    check('2.1', `series ${SERIES_B} EP${epB.episodeNo}：episode-focus-desc 在 DOM 中且可见`,
      blockB.hasDesc === true && blockB.descVisible === true,
      'hasDesc=true 且 descVisible=true',
      `hasDesc=${blockB.hasDesc} descVisible=${blockB.descVisible}`)
    check('2.2', `series ${SERIES_B} EP${epB.episodeNo}：正文 === 该集自己的介绍且 ≠ 剧集介绍`,
      blockB.descText != null &&
        blockB.descText.trim() === String(epB.description || '').trim() &&
        blockB.descText.trim() !== seriesDescB.trim(),
      `text.trim() === 该集 description（len=${String(epB.description || '').length}）且 !== 剧集介绍（len=${seriesDescB.length}）`,
      `textLen=${blockB.descText == null ? -1 : blockB.descText.length} equalsEpisode=${blockB.descText != null && blockB.descText.trim() === String(epB.description || '').trim()} differsFromSeries=${blockB.descText != null && blockB.descText.trim() !== seriesDescB.trim()}`)
    check('2.3', `series ${SERIES_B} EP${epB.episodeNo}：区块标签 === 「${LABEL_EPISODE}」（本集级来源）`,
      blockB.label === LABEL_EPISODE,
      `label === "${LABEL_EPISODE}"（zh: media.episode.sectionDesc）`,
      `label=${JSON.stringify(blockB.label)} hasLabelTestid=${blockB.hasLabelTestid}`)

    // ── 判据 3（B 页）：剧集头介绍不回退 ──────────────────────────────
    const heroB = await readHeroDesc(page)
    await shot(page, `04-series${SERIES_B}-hero-unchanged.png`)
    check('3.2', `series ${SERIES_B} 剧集头介绍可见且文本 === 剧集介绍`,
      heroB.present && heroB.visible && heroB.text === seriesDescB,
      `series-description 可见，text === series ${SERIES_B} description（len=${seriesDescB.length}）`,
      `present=${heroB.present} visible=${heroB.visible} textLen=${heroB.text ? heroB.text.length : -1} identical=${heroB.text === seriesDescB}`)

    const pageErrs = page.pageErrors().slice(0, 5)
    const consoleErrs = page.consoleErrors().slice(0, 8)
    console.log(`[bug281] pageErrors=${JSON.stringify(pageErrs)}`)
    console.log(`[bug281] consoleErrors(${consoleErrs.length})=${JSON.stringify(consoleErrs)}`)

    // ── 汇总 ─────────────────────────────────────────────────────────
    const failed = checks.filter((c) => !c.ok)
    console.log('\n[bug281] === SUMMARY ===')
    console.log(`[bug281] shots: ${SHOTS}`)
    console.log(`[bug281] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[bug281] FAILED:', failed.map((c) => `${c.id}:${c.label}`).join(' | '))
    process.exitCode = failed.length ? 2 : 0
  } finally {
    if (browser) await browser.close()
  }
}

main().catch((e) => {
  console.error('[bug281] ERROR', (e && e.stack) || e)
  process.exit(1)
})
