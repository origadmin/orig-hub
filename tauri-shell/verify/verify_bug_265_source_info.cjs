#!/usr/bin/env node
'use strict'

/**
 * BUG-265 真实 UI 验收：剧集内页「来源」块 = 「信息段（恒渲染）+ 控件段（备用源门控）」。
 *
 * ## 缺陷回顾（docs/bugs/BUG-265.md）
 *
 * BUG-210 把「来源」块里的**两类东西**塞进了同一个门控
 * `(cur.sources ?? []).length > 0`：
 *   - 信息段：当前播放来源（「正在从哪播」）—— 这是**信息**，不因没有备选项而失去意义；
 *   - 控件段：备用源列表 + 切换 / 摘除 —— 这是**控件**，「无选择即无控件」只对它成立。
 * 生产库 `media_episode_source` 0 行 ⇒ 每一集 `sources.length == 0` ⇒ 该块 45/45 部剧
 * 0 渲染（且永不进 DOM），「正在从哪播」退化为标题行里一段 `12:34 · TG · #394` 小灰字。
 * 用户连续两次报告「来源没有了」。
 *
 * ## 修复（选项 A，用户已拍板）
 *
 * `SeriesDetail.tsx` 来源块拆两层：
 *   - 信息段 `<div data-testid="episode-source-info">`：区块标题 + 主版本行，**恒渲染**；
 *     来源词走 `sourceLabelKey`，无来源回退 i18n `source.local`（本地/Local），
 *     **不得**退化成只剩 `#<itemId>`；
 *   - 控件段：保留 BUG-210 原门控，无备用源时 `<ul>` 不进 DOM；
 *     既有 `episode-source-switch` / `episode-source-detach` 两个 testid 逐字不动。
 * 标题行 meta 的小灰字（:648-652）**保持原样**（非本档判据对象）。
 *
 * ## 本脚本断言什么（全部打真实 UI，可见性用 getComputedStyle，不读 className）
 *
 *   A. **真实数据（生产库）**：任取一个「首集无备用源」的真实剧集（生产库备用源 0 行，
 *      全部剧集都满足）：
 *      A1 判据1：信息段在 DOM 中且**可见**，文案含区块标题 + 来源词；
 *      A2 判据2：`episode-source-switch` / `episode-source-detach` 命中 0。
 *
 *   B. **0 备用源夹具**（临时剧集 + 自动清理，绝不打真实剧集 id）：
 *      B1 判据1：同 A1（受控环境复核）；
 *      B2 判据2：同 A2。
 *
 *   C. **1 备用源夹具**（临时挂一个再验，验完删；注入走产品 API，不直改库）：
 *      C1 判据6：两个既有 testid 在 DOM 中存在（各 1 个）；
 *      C2 判据4：点「切为主版本」→ 读模型主条目变为备用源条目（切换真实生效）；
 *      C2b 判据4 的 UI 侧前提：切换后**页面重渲染**出「主条目 = 备用源行」
 *                （服务端先生效、UI 后渲染，不等这步就点摘除会点到旧行 =
 *                 闭包里旧 itemId 的 no-op，实测假红过）；
 *      C3 判据4：点「摘除」→ `media_episode_source` 行消失、控件从 DOM 消失，
 *                信息段**仍然可见**（BUG-210 合理部分未被回退）。
 *
 *   D. **反向证伪（判据3）**：把信息段临时纳入旧门控
 *      （`{(cur.sources ?? []).length > 0 ? (<div data-testid="episode-source-info">…`），
 *      等 Vite 重新编译后重开同一夹具详情 —— 信息段**必须从 DOM 消失**
 *      （即判据 1 的断言转红）。随后**自动还原**源文件，并以
 *      `sha256(改前) === sha256(还原后)` 自证逐字节一致；再复核信息段恢复可见。
 *
 * ## 行数真值来源（两层，互相印证）
 *
 *   1. 直读 SQLite（只读）：`node:sqlite` 打开 `ORIG_TG_DB`（默认探测
 *      `%APPDATA%\com.origadmin.orighub\tg\store.db`），数 `media_episode_source` 行；
 *   2. 后端读模型：`GET /api/media/series/:id` 的 `episodes[].sources / itemId`。
 *
 * ## 判据 4 的注入方法（如实说明）
 *
 *   通过**产品自身 API** 在临时夹具剧集上挂备用源：
 *   `POST /api/media/episodes/:id/sources`（与 BUG-182 验收同一通道）。
 *   只写 `VerifyProbe_<ms>` 前缀的临时剧集与新建条目，**绝不触碰真实剧集 id**，
 *   全部实体在 `sandbox.trackCleanup` 登记删除（含异常路径），脚本结束即清空。
 *   禁止任何 sqlite 直写。
 *
 * ## 环境（用真实在跑的 dev 栈；端口一律经 `_lib_endpoints.cjs` 运行时解析，不写死）
 *
 *     # daemon 127.0.0.1:19786 / vite 5180 / orig-tg 端口随 daemon /api/config 漂移
 *     node verify/verify_bug_265_source_info.cjs
 *
 * ## Usage / Env
 *
 *   ORIG_VERIFY_OUT   证据/截图输出目录（默认 verify/evidence/BUG-265/）
 *   ORIG_TG_DB        SQLite 库路径（默认探测 %APPDATA% 下的 store.db；找不到则降级为仅读模型）
 *   APP_URL / TG_URL  覆盖端点（默认仍走 _lib_endpoints 运行时解析）
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题（dev 栈不可达 / 无真实数据）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')
const sandbox = require('./lib/sandbox.cjs')

/** 证据输出目录（本档按任务要求落在仓库 evidence/BUG-265/ 下）。 */
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-265')

/** 被测源文件（活实现）—— 反向证伪的注入 / 还原对象。 */
const SERIES_DETAIL_SRC = path.resolve(__dirname, '..', 'src', 'components', 'media', 'SeriesDetail.tsx')

// ── 反向证伪锚点（都是源文件里唯一的字符串；与修复态逐字节对应） ──────────────
// BUG-422：锚点随源码漂移两次 —— ①className 的 border-t/…/pt-2.5 已被样式调整移除；
// ②块尾「单集结构性操作」注释被 BUG-350 改写。锚点只认**当前**活实现，
// 每次改动 SeriesDetail.tsx 信息段周边结构都必须回来同步，否则注入会拒改。
const ANCHOR_OPEN = [
  '              <div',
  '                className="flex flex-col gap-1.5"',
  '                data-testid="episode-source-info"',
  '              >',
].join('\n')
const ANCHOR_OPEN_INJECTED = '              {(cur.sources ?? []).length > 0 ? (\n' + ANCHOR_OPEN
// 块尾：内层 ul 门控收尾 + 信息段 </div> + 紧随的 BUG-350 注释首行（唯一定位）。
const ANCHOR_CLOSE = [
  '                ) : null}',
  '              </div>',
  '',
  '              {/* BUG-350：上移/下移/移除与「操作」组（挂图/前往条目/重缓存）已并入',
].join('\n')
const ANCHOR_CLOSE_INJECTED = [
  '                ) : null}',
  '              </div>',
  '              ) : null}',
  '',
  '              {/* BUG-350：上移/下移/移除与「操作」组（挂图/前往条目/重缓存）已并入',
].join('\n')

// ── 文案候选集（浏览器语言未知：zh / en 两套都收） ──────────────────────────
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))
const BLOCK_TITLES = new Set(
  [ZH['media.episode.sourcesTitle'], EN['media.episode.sourcesTitle']].filter(Boolean),
)
const SOURCE_WORDS = new Set()
for (const key of ['source.tg', 'source.local', 'source.oss', 'source.s3', 'source.netdisk']) {
  for (const v of [ZH[key], EN[key]]) if (v) SOURCE_WORDS.add(v)
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

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
  console.log(`[bug265] ${results.length - failed}/${results.length} assertions passed`)
  return failed
}

// ────────────────────────────── 可见性（getComputedStyle，不读 className） ──────────────────────────────

/**
 * 在页面里取 testid 元素的可见性与文案（getComputedStyle 口径）。
 * @param {object} page cdp page
 * @param {string} testid
 * @returns {Promise<object|null>} null = 元素不在 DOM
 */
async function inspectTestid(page, testid) {
  return page.evaluate(
    (tid) => {
      const el = document.querySelector(`[data-testid="${tid}"]`)
      if (!el) return null
      const cs = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return {
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        rects: el.getClientRects().length,
        width: rect.width,
        height: rect.height,
        text: (el.innerText || '').trim(),
      }
    },
    testid,
  )
}

/** 元素存在且 getComputedStyle 判可见。 */
function isVisible(info) {
  return (
    !!info &&
    info.display !== 'none' &&
    info.visibility !== 'hidden' &&
    info.visibility !== 'collapse' &&
    Number(info.opacity) > 0 &&
    info.rects > 0 &&
    info.height > 0
  )
}

/**
 * 判据 1 的核心断言：信息段可见 + 文案含区块标题与来源词（不是只剩 #<itemId>）。
 * @returns {Promise<boolean>}
 */
async function assertInfoVisible(page, label) {
  const info = await inspectTestid(page, 'episode-source-info')
  console.log(`[bug265] ${label} episode-source-info:`, JSON.stringify(info))
  const visible = isVisible(info)
  check(`${label}: 信息段在 DOM 中且可见（getComputedStyle）`, visible, JSON.stringify(info))
  if (!visible) return false
  const hasTitle = [...BLOCK_TITLES].some((w) => info.text.includes(w))
  const hasSourceWord = [...SOURCE_WORDS].some((w) => info.text.includes(w))
  const onlyItemId = /^#\d+$/.test(info.text)
  check(
    `${label}: 文案含区块标题（来源/Sources）`,
    hasTitle,
    `text="${info.text.slice(0, 80)}" titles=${JSON.stringify([...BLOCK_TITLES])}`,
  )
  check(
    `${label}: 文案含来源词（TG/本地/…），非只剩 #itemId`,
    hasSourceWord && !onlyItemId,
    `text="${info.text.slice(0, 80)}" words=${JSON.stringify([...SOURCE_WORDS])} onlyItemId=${onlyItemId}`,
  )
  return true
}

// ────────────────────────────── 页面工具 ──────────────────────────────

async function clickTestid(page, testid, index = 0) {
  const ok = await page.evaluate(
    (tid, idx) => {
      const el = document.querySelectorAll(`[data-testid="${tid}"]`)[idx]
      if (!el) return false
      el.click()
      return true
    },
    testid,
    index,
  )
  if (!ok) throw new Error(`clickTestid: ${testid}[${index}] not found`)
}

async function countTestid(page, testid) {
  return page.evaluate((tid) => document.querySelectorAll(`[data-testid="${tid}"]`).length, testid)
}

async function waitCountEq(page, testid, want, timeout = 9000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const n = await countTestid(page, testid)
    if (n === want) return true
    if (Date.now() > deadline) return false
    await delay(250)
  }
}

/**
 * 等右栏「备用源行」（含 episode-source-detach 的那个 li）渲染出期望文本。
 * BUG-422：切换动作**服务端先生效、UI 后重渲染**——API 轮询看到 primary 已换，
 * 页面可能还停在切换前。此刻点「摘除」点到的是旧行，其 onClick 闭包里的
 * s.itemId 还是切换前的备用源（切换后它已是主版本）⇒ 摘除 no-op，
 * api/db 恒 1、判据 4 假红。点摘除前必须等这步。
 * @returns {Promise<boolean>}
 */
async function waitBackupRowText(page, want, timeout = 10000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const txt = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="episode-source-detach"]')
      const li = btn && btn.closest('li')
      return li ? (li.innerText || '') : ''
    })
    if (txt.includes(want)) return true
    if (Date.now() > deadline) return false
    await delay(250)
  }
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[bug265] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[bug265] shot ${name} FAILED: ${e.message}`)
  }
}

/** 打开媒体库 → 剧集墙。 */
async function gotoMediaLibrary(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const ok = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  if (!ok) throw new Error('nav-child-lib-series not found (app did not boot?)')
  await clickTestid(page, 'nav-child-lib-series')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 20000 },
  )
  await delay(800)
}

/**
 * 按后端剧集 id 打开详情。
 * 详情就绪锚 = `episode-focus-title`（右栏渲染即算就绪，与信息段无关 ——
 * 反向证伪态下信息段本来就该缺席，不能拿它当就绪条件）。
 * `expectInfo`：等 `episode-source-info` 出现（修复态）；证伪轮必须传 false。
 */
async function openSeriesById(page, id, { expectControls = false, expectInfo = true } = {}) {
  await gotoMediaLibrary(page)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, id)
  if (!clicked) throw new Error(`series-card with data-series-id=${id} not found on the series wall`)
  const detailUp = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false)
  if (!detailUp) throw new Error('series detail never rendered (episode-focus-title missing)')
  if (expectInfo) {
    const ok = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="episode-source-info"]'), {
        timeout: 20000,
      })
      .then(() => true)
      .catch(() => false)
    if (!ok) throw new Error('episode-source-info never rendered after opening series detail')
  }
  if (expectControls) {
    await waitCountEq(page, 'episode-source-detach', 1, 12000)
  }
  await delay(600)
}

// ────────────────────────────── 数据真值 ──────────────────────────────

/**
 * 读模型：GET /api/media/series/:id。
 * @returns {Promise<{status:number, series:object|null}>}
 */
async function apiSeries(seriesId) {
  const r = await sandbox.httpJson('GET', `${MEDIA_API}/api/media/series/${seriesId}`)
  return { status: r.status, series: r.json }
}

/** 某集在读模型里的 sources 计数与主条目 id。 */
function episodeView(series, episodeId) {
  const ep = (series.episodes || []).find((e) => e.id === episodeId)
  if (!ep) return null
  return {
    itemId: Number(ep.itemId),
    source: ep.source || '',
    sources: (ep.sources || []).map((s) => Number(s.itemId)),
  }
}

/** DB 路径：显式 env 优先，否则探测 %APPDATA% 下的生产库（只读打开）。 */
function resolveDbPath() {
  if (process.env.ORIG_TG_DB) return process.env.ORIG_TG_DB
  const appData = process.env.APPDATA
  if (!appData) return ''
  const p = path.join(appData, 'com.origadmin.orighub', 'tg', 'store.db')
  return fs.existsSync(p) ? p : ''
}

/**
 * 只读数某集的 `media_episode_source` 行。库不可用时返回 null（降级为仅读模型断言）。
 */
function dbSourceCount(episodeId) {
  const dbPath = DB_PATH
  if (!dbPath || !fs.existsSync(dbPath)) return null
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch (_e) {
    return null
  }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (_e) {
    return null
  }
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM media_episode_source WHERE episode_id = ?')
      .get(episodeId)
    return Number(row.c)
  } catch (_e) {
    return null
  } finally {
    try {
      db.close()
    } catch (_e) {
      /* best effort */
    }
  }
}

// ────────────────────────────── 夹具（临时实体，自动清理） ──────────────────────────────

/** 建一个本地条目，返回 itemId。 */
async function createItem(kind, title, filePath) {
  const r = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/items`, {
    items: [{ path: filePath, title, kind }],
  })
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.ids) || r.json.ids.length !== 1) {
    throw new Error(`createItem(${kind}) failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
  const id = Number(r.json.ids[0])
  // BUG-422：导入即被 BUG-304 自动归档进单集剧集；不先撤销归属，后面往自己的
  // 剧集挂载会撞 media_episode.item_id 唯一约束（HTTP 500）。
  await sandbox.detachAutoSeries(MEDIA_API, id)
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${MEDIA_API}/api/media/items/${id}`)
  })
  return id
}

/**
 * 造一个临时剧集 + 1 个分集（mainItem）；withSource=true 时再挂一个备用源（altItem）。
 * 所有实体经 createTempSeries / trackCleanup 登记删除 ——「建了不删」不可表达。
 */
async function buildFixture(withSource) {
  const mediaDir = path.join(OUT_DIR, 'testmedia')
  fs.mkdirSync(mediaDir, { recursive: true })
  const mk = (name) => {
    const p = path.join(mediaDir, name)
    fs.writeFileSync(p, Buffer.alloc(16))
    return p
  }

  const { id: seriesId, title: seriesTitle } = await sandbox.createTempSeries(
    MEDIA_API,
    'VerifyProbe_',
  )
  const mainTitle = 'QA-BUG265 主视频'
  const mainItem = await createItem('video', mainTitle, mk(withSource ? 'main2.mp4' : 'main.mp4'))

  const epRes = await sandbox.httpJson(
    'POST',
    `${MEDIA_API}/api/media/series/${seriesId}/episodes`,
    { itemId: mainItem },
  )
  if (epRes.status !== 200 || !epRes.json || typeof epRes.json.id !== 'number') {
    throw new Error(`add episode failed: status=${epRes.status} body=${JSON.stringify(epRes.json)}`)
  }
  const episodeId = Number(epRes.json.id)

  let altItem = 0
  if (withSource) {
    altItem = await createItem('video', 'QA-BUG265 备用源', mk('alt.mp4'))
    const srcRes = await sandbox.httpJson(
      'POST',
      `${MEDIA_API}/api/media/episodes/${episodeId}/sources`,
      { itemId: altItem },
    )
    if (srcRes.status !== 200) {
      throw new Error(`attach source failed: status=${srcRes.status} body=${JSON.stringify(srcRes.json)}`)
    }
  }

  console.log(
    `[bug265] fixture: series=${seriesId} "${seriesTitle}" episode=${episodeId} ` +
      `main=${mainItem}${withSource ? ` alt(source)=${altItem}` : ' (no backup source)'}`,
  )
  return { seriesId, episodeId, mainItem, altItem, seriesTitle, mainTitle }
}

// ────────────────────────────── 反向证伪：注入 + 还原 ──────────────────────────────

/**
 * 把「修复前形态」注回源文件（信息段也纳入旧门控）。
 * @returns {string} 原始文件内容（用于还原）
 */
function injectPreFixForm() {
  const original = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
  for (const [label, anchor] of [
    ['open', ANCHOR_OPEN],
    ['close', ANCHOR_CLOSE],
  ]) {
    const hits = original.split(anchor).length - 1
    if (hits !== 1) {
      throw new Error(
        `revert: anchor ${label} found ${hits} times (expected 1) in ${SERIES_DETAIL_SRC} — refusing to patch blindly`,
      )
    }
  }
  const patched = original
    .replace(ANCHOR_OPEN, ANCHOR_OPEN_INJECTED)
    .replace(ANCHOR_CLOSE, ANCHOR_CLOSE_INJECTED)
  if (patched === original) throw new Error('revert: replacement produced no change (unexpected)')
  fs.writeFileSync(SERIES_DETAIL_SRC, patched)
  return original
}

/** 还原源文件（幂等）。 */
function restoreSource(original) {
  if (typeof original !== 'string') return
  fs.writeFileSync(SERIES_DETAIL_SRC, original)
}

/**
 * 打开夹具详情并轮询「信息段是否已从 DOM 消失」（证伪态）。
 * 每轮整页重开（goto → 剧集墙 → 点卡片），确保拿到 Vite 最新编译产物。
 * @returns {Promise<boolean>} true = 信息段已消失（证伪生效）
 */
async function waitInfoGone(page, seriesId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    try {
      await openSeriesById(page, seriesId, { expectInfo: false })
      const n = await countTestid(page, 'episode-source-info')
      const detailAlive = await countTestid(page, 'episode-focus-title')
      console.log(`[bug265] falsify attempt#${attempt}: episode-source-info count=${n} (detail rendered=${detailAlive > 0})`)
      if (n === 0 && detailAlive > 0) return true
    } catch (e) {
      console.log(`[bug265] falsify attempt#${attempt}: ${e.message}`)
    }
    await delay(1200)
  }
  return false
}

// ────────────────────────────── 主流程 ──────────────────────────────

let APP_URL = ''
let MEDIA_API = ''
let DB_PATH = ''

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // 端口一律运行时解析（_lib_endpoints.cjs），绝不写死。
  const ep = await endpoints.resolve()
  APP_URL = ep.app.endsWith('/') ? ep.app : `${ep.app}/`
  MEDIA_API = ep.tg
  DB_PATH = resolveDbPath()

  console.log(`[bug265] app=${APP_URL} media-api=${MEDIA_API} db=${DB_PATH || '(unresolved, read-model only)'}`)
  console.log(`[bug265] evidence -> ${OUT_DIR}`)

  // 写通道只指向 dev orig-tg（sandbox 只拦生产 9877）；写面 = VerifyProbe_ 夹具，全部登记清理。
  sandbox.guardWrites('verify_bug_265_source_info.cjs', MEDIA_API)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()

    // ══ A. 真实数据（生产库）：无备用源 ⇒ 信息段可见 + 控件缺席 ══════════════
    const list = await sandbox.httpJson('GET', `${MEDIA_API}/api/media/series`)
    if (list.status !== 200 || !list.json || !Array.isArray(list.json.items) || list.json.items.length === 0) {
      throw new Error(`series list unavailable: status=${list.status}`)
    }
    // 找一个「首集无备用源」的真实剧集（生产库备用源 0 行 ⇒ 第一个即满足；找不到才扫全表）。
    // BUG-422：候选必须**墙可见**（hasBytes !== false）——BUG-304 起无字节剧集整卡
    // 不上墙，选中了也点不开卡（实测 543 就是这样：API 列表第一条，墙上没有）。
    let realSeries = null
    for (const s of list.json.items) {
      if (s.hasBytes === false) continue
      const { status, series } = await apiSeries(s.id)
      if (status !== 200 || !series || !(series.episodes || []).length) continue
      const v = episodeView(series, series.episodes[0].id)
      if (v && v.sources.length === 0) {
        realSeries = { id: s.id, title: s.title, episodeId: series.episodes[0].id, view: v }
        break
      }
    }
    if (!realSeries) throw new Error('no real series with a 0-source first episode found (unexpected per BUG-265 archive)')

    console.log(`[bug265] real series: id=${realSeries.id} "${realSeries.title}" episode=${realSeries.episodeId}`)
    await openSeriesById(page, realSeries.id)
    await delay(500)
    await shot(page, '01-real-series-detail.png')
    await assertInfoVisible(page, 'A/real')
    check(
      'A/real: 无备用源时 episode-source-switch 命中 0（判据2）',
      (await countTestid(page, 'episode-source-switch')) === 0,
      `count=${await countTestid(page, 'episode-source-switch')}`,
    )
    check(
      'A/real: 无备用源时 episode-source-detach 命中 0（判据2）',
      (await countTestid(page, 'episode-source-detach')) === 0,
      `count=${await countTestid(page, 'episode-source-detach')}`,
    )

    // ══ B. 0 备用源夹具：受控复核判据 1 / 2 ══════════════════════════════════
    const fx1 = await buildFixture(false)
    const b0Db = dbSourceCount(fx1.episodeId)
    const { series: b0Model } = await apiSeries(fx1.seriesId)
    const b0View = episodeView(b0Model, fx1.episodeId)
    check(
      'B/fixture: 基线 sources=0（读模型 + DB 双源印证）',
      b0View && b0View.sources.length === 0 && (b0Db === null || b0Db === 0),
      `api=${b0View ? b0View.sources.length : 'n/a'} db=${b0Db === null ? 'skipped' : b0Db}`,
    )
    await openSeriesById(page, fx1.seriesId)
    await delay(500)
    await shot(page, '02-fixture-no-source.png')
    await assertInfoVisible(page, 'B/fixture')
    check(
      'B/fixture: 无备用源时 episode-source-switch 命中 0（判据2）',
      (await countTestid(page, 'episode-source-switch')) === 0,
      `count=${await countTestid(page, 'episode-source-switch')}`,
    )
    check(
      'B/fixture: 无备用源时 episode-source-detach 命中 0（判据2）',
      (await countTestid(page, 'episode-source-detach')) === 0,
      `count=${await countTestid(page, 'episode-source-detach')}`,
    )

    // ══ C. 1 备用源夹具：判据 4（切换 / 摘除可用）+ 判据 6（testid 存在） ═════
    const fx2 = await buildFixture(true)
    await openSeriesById(page, fx2.seriesId, { expectControls: true })
    await delay(500)
    await shot(page, '03-fixture-with-source.png')

    const c0Db = dbSourceCount(fx2.episodeId)
    const { series: c0Model } = await apiSeries(fx2.seriesId)
    const c0View = episodeView(c0Model, fx2.episodeId)
    check(
      'C/fixture: 基线 sources=1, primary=main（读模型）',
      c0View && c0View.sources.length === 1 && c0View.sources.includes(fx2.altItem) && c0View.itemId === fx2.mainItem,
      `api=${JSON.stringify(c0View)} db=${c0Db === null ? 'skipped' : c0Db}`,
    )
    await assertInfoVisible(page, 'C/fixture')
    const swCount = await countTestid(page, 'episode-source-switch')
    const dtCount = await countTestid(page, 'episode-source-detach')
    check(
      'C/fixture: 有备用源时 episode-source-switch 存在（判据6）',
      swCount === 1,
      `count=${swCount}`,
    )
    check(
      'C/fixture: 有备用源时 episode-source-detach 存在（判据6）',
      dtCount === 1,
      `count=${dtCount}`,
    )

    // ── 切换：点「切为主版本」→ 主条目变为备用源条目 ──
    await clickTestid(page, 'episode-source-switch')
    console.log('[bug265] clicked [data-testid="episode-source-switch"]')
    let switched = false
    let c1View = null
    {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const { series } = await apiSeries(fx2.seriesId)
        c1View = episodeView(series, fx2.episodeId)
        if (c1View && c1View.itemId === fx2.altItem && c1View.sources.includes(fx2.mainItem)) {
          switched = true
          break
        }
        await delay(400)
      }
    }
    await shot(page, '04-after-switch.png')
    check(
      'C/fixture: 切换生效 —— primary=alt、main 降级为备用源（判据4）',
      switched,
      `view=${JSON.stringify(c1View)} expect primary=${fx2.altItem} sources=[${fx2.mainItem}]`,
    )
    await assertInfoVisible(page, 'C/fixture-after-switch')

    // ── 摘除：点「摘除」→ 备用源行消失、控件缺席、信息段仍在 ──
    // BUG-422：先等 UI 重渲染出「主条目 = 备用源行」再点摘除。
    // 不等就点会点到切换前的旧行（闭包里 s.itemId 还是旧备用源，而它切换后
    // 已是主版本 ⇒ 摘除 no-op，api/db 恒 1，判据 4 假红——实测踩过）。
    const rowReady = await waitBackupRowText(page, fx2.mainTitle)
    check(
      'C/fixture: 切换后 UI 重渲染 —— 备用源行显示主条目（判据4 的 UI 侧前提）',
      rowReady,
      `backup row should contain "${fx2.mainTitle}" after switch`,
    )
    await clickTestid(page, 'episode-source-detach')
    console.log('[bug265] clicked [data-testid="episode-source-detach"]')
    const dtGone = await waitCountEq(page, 'episode-source-detach', 0, 9000)
    await delay(500)
    await shot(page, '05-after-detach.png')
    const c2Db = dbSourceCount(fx2.episodeId)
    const { series: c2Model } = await apiSeries(fx2.seriesId)
    const c2View = episodeView(c2Model, fx2.episodeId)
    check(
      'C/fixture: 摘除生效 —— media_episode_source 0 行（判据4）',
      c2View && c2View.sources.length === 0 && (c2Db === null || c2Db === 0),
      `api=${c2View ? c2View.sources.length : 'n/a'} db=${c2Db === null ? 'skipped' : c2Db}`,
    )
    check(
      'C/fixture: 摘除后 episode-source-detach 从 DOM 消失（判据4）',
      dtGone && (await countTestid(page, 'episode-source-detach')) === 0,
      `count=${await countTestid(page, 'episode-source-detach')}`,
    )
    await assertInfoVisible(page, 'C/fixture-after-detach')

    // ══ D. 反向证伪（判据3）：信息段纳入旧门控 ⇒ 判据 1 必须转红 ═════════════
    const fixedText = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
    const hashBefore = sha256(fixedText)
    let originalSource = null
    let falsified = false
    try {
      originalSource = injectPreFixForm()
      sandbox.trackCleanup(async () => restoreSource(originalSource))
      console.log(
        `[bug265] falsify: injected pre-fix form (sha256 before=${hashBefore}); polling served UI...`,
      )
      falsified = await waitInfoGone(page, fx1.seriesId)
      await shot(page, '06-falsified-info-hidden.png')
      check(
        'D/falsify: 旧门控注入后信息段从 DOM 消失（判据1 断言转红 = 证伪成立）',
        falsified,
        'episode-source-info count must be 0 under the injected (pre-fix) gating',
      )
    } finally {
      // 自动还原（无论成败）；sha256 自证逐字节一致。
      if (originalSource != null) {
        restoreSource(originalSource)
        const restoredText = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
        const hashAfter = sha256(restoredText)
        const byteIdentical = hashAfter === hashBefore
        console.log(
          `[bug265] falsify restore: sha256 before=${hashBefore} after=${hashAfter} byte-identical=${byteIdentical}`,
        )
        check(
          'D/falsify: SeriesDetail.tsx 逐字节还原（sha256 前后一致）',
          byteIdentical,
          `sha256 ${hashBefore} -> ${hashAfter}`,
        )
        originalSource = null
      }
    }
    // 还原后复核：信息段恢复可见（Vite 热更回到修复态）。
    if (falsified) {
      let recovered = false
      {
        const deadline = Date.now() + 45000
        while (Date.now() < deadline) {
          try {
            await openSeriesById(page, fx1.seriesId)
            const info = await inspectTestid(page, 'episode-source-info')
            if (isVisible(info)) {
              recovered = true
              break
            }
          } catch (_e) {
            /* retry */
          }
          await delay(1200)
        }
      }
      await shot(page, '07-restored-info-visible.png')
      check('D/falsify: 还原后信息段恢复可见（回归复核）', recovered)
    }

    // ── 页面健康 ─────────────────────────────────────────────────────────
    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[bug265] page errors:', JSON.stringify(errs))
    check('页面无未捕获异常', errs.length === 0, errs.length ? JSON.stringify(errs) : 'none')

    console.log('[bug265] screenshots ->', OUT_DIR)
    const failed = dumpResults()
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    await sandbox.finalize()
  }
}

main().catch((e) => {
  console.error('[bug265] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
