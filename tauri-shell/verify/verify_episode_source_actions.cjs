#!/usr/bin/env node
'use strict'

/**
 * BUG-182 真实 UI 点击验收：多源区「摘除备用源」必须打**摘源**端点，而不是**摘挂图**。
 *
 * ## 缺陷回顾（docs/bugs/BUG-182.md）
 *
 * 剧集内页（活实现 `SeriesDetail.tsx` 右栏「多源区」）每个备用源行上有一个「摘除」按钮
 * （`data-testid="episode-source-detach"`）。修复前它的 `onClick` 误调 `detachImage`
 * （摘**挂图**），而备用源是 **video**、挂图是 **photo**，同一 `item_id` 不可能两者兼属
 * （且 `media_episode_source.item_id` 全表 UNIQUE）⇒ 点「摘除」**必然打空**
 * （`detachEpisodeImage(videoItemId)` 在 `media_episode_image` 里找不到该行，幂等删除
 * `removed:0`，两表行数都不变），用户看到的是「点了没反应」。
 *
 * **诚实边界（2026-09-29 实测）**：初稿曾推断「也可能误摘挂图」，实测**不成立** ——
 * video 的 itemId 不可能出现在 `media_episode_image` 里。因此本场景下**判别性断言是
 * 「备用源行消失」**（断言 ①）；「挂图行数不变」（断言 ②）是防**另一类错实现**的护栏，
 * 本场景修复前后两版都会通过它 —— 故断言 ② 单独不足以判定本缺陷，必须与 ① 并看。
 *
 * 修复（当前工作区已改、尚未提交）：
 *   - `SeriesDetail.tsx` import 补 `detachEpisodeSource`；
 *   - 新增 `detachSource = (epId,itemId) => applyChange(() => detachEpisodeSource(epId,itemId))`；
 *   - 多源区摘除按钮 `onClick={() => detachSource(cur.id, s.itemId)}`（**本档唯一改动点**）；
 *   - 灯箱内的「摘图」**仍调 `detachImage`**（这一处必须逐字不变）。
 *
 * ## 本脚本断言什么（打真实点击，不打内部函数）
 *
 *   造一条「1 主 + 1 备用源 + 2 挂图」的分集，在真实浏览器里点击
 *   `[data-testid="episode-source-detach"]` 后：
 *     ① 核心断言：`media_episode_source` 该行**消失**（备用源真被摘除）；
 *     ② 反证：`media_episode_image` 行数**不变**（没有误摘挂图）——
 *        原缺陷的表现正是「该变的没变、不该动的动了」；
 *     ③ 不误伤：灯箱内的「摘图」（`lightbox-detach`，走 `detachImage`）行为逐字不变，
 *        点它挂图**应当**消失。
 *
 * 每条断言都打印**实测值**：点击前后 `media_episode_source` / `media_episode_image` 的
 * 行数（**直读 SQLite 表**，见下）+ 后端读模型 + 每个 HTTP 状态码。
 *
 * ## 行数真值来源（两层，互相印证）
 *
 *   1. **直读 SQLite 表**（首选，最接近「表里那行没了」的字面事实）：用 Node 内置
 *      `node:sqlite`（Node ≥ 22.5）只读打开 `ORIG_TG_DB` 指向的库，
 *      `SELECT COUNT(*) FROM media_episode_source / media_episode_image WHERE episode_id = ?`。
 *   2. **后端读模型**（兜底 + 交叉印证）：`GET /api/media/series/:id` 的
 *      `episodes[].sources / images`（后端由这两张表 join 得出）。
 *
 *   `ORIG_TG_DB` 未设时仅打印告警并用读模型断言；给了就两层都断言（推荐）。
 *
 * ## 反向证伪（硬要求：断言不许假绿）
 *
 *   `ORIG_VERIFY_REVERT=1`：脚本会**临时**把 `SeriesDetail.tsx` 的
 *   `detachSource(cur.id, s.itemId)` 改回 `detachImage(cur.id, s.itemId)`
 *   （= 修复前形态），等 Vite 重新编译，再跑同一套断言 —— **核心断言必须转红（exit 2）**。
 *   跑完**无论成败都在 `finally` 里还原文件**（另挂进程级清理钩子兜底）。
 *
 * ## 环境（隔离实例，严禁污染用户真实库）
 *
 *   `lib/sandbox.cjs` 拒绝对生产实例（回环 + 9877）写入。本脚本默认指向隔离端口 18761：
 *
 *     # 1) 先 copy 一份在产库再用（不要直接改在产库）
 *     #    %APPDATA%\com.origadmin.orighub\tg\store.db
 *     # 2) 起 orig-tg（离线，媒体库端点照常）
 *     ORIG_TG_OFFLINE=1 ORIG_TG_PORT=18761 ORIG_TG_DB=<copy 的库> \
 *     ORIG_TG_SESSION=<临时文件> ORIG_TG_DOWNLOAD_DIR=<临时目录> \
 *       download-engine/target/release/orig-tg.exe &
 *     # 3) 前端 dev（vite 默认 5180）；daemon 端口指到不可达值，
 *     #    防止前端从 daemon `/api/config` 拿到真 tg_port 而改打生产库
 *     cd tauri-shell && VITE_TG_PORT=18761 VITE_DAEMON_PORT=1 npm run dev
 *     # 4) 跑验收
 *     ORIG_TG_DB=<copy 的库> node verify/verify_episode_source_actions.cjs
 *
 * ## Usage / Env
 *
 *   node verify/verify_episode_source_actions.cjs
 *   ORIG_VERIFY_REVERT=1 node verify/verify_episode_source_actions.cjs   # 反向证伪（期望 exit 2）
 *   APP_PORT=5180 ORIG_MEDIA_API=http://127.0.0.1:18761 \
 *     ORIG_TG_DB=<db> ORIG_VERIFY_OUT=<临时目录> node verify/...
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题（浏览器找不到 / dev server 不可达）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')
const sandbox = require('./lib/sandbox.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const MEDIA_API = process.env.ORIG_MEDIA_API || process.env.MEDIA_API || 'http://127.0.0.1:18761'
const TG_DB = process.env.ORIG_TG_DB || ''
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-episode-source-actions')

/** 自证伪开关：把「修复前形态」注回源文件，期望本脚本转红。 */
const REVERT_TO_PRE_FIX = process.env.ORIG_VERIFY_REVERT === '1'

/** 被测源文件（活实现）与其唯一改动点。 */
const SERIES_DETAIL_SRC = path.resolve(
  __dirname,
  '..',
  'src',
  'components',
  'media',
  'SeriesDetail.tsx',
)
const FIXED_CALL = 'detachSource(cur.id, s.itemId)'
const PREFIX_CALL = 'detachImage(cur.id, s.itemId)'

// BUG-161 污染防线：本脚本会写后端；默认拒绝写生产实例（9877）。
sandbox.guardWrites('verify_episode_source_actions.cjs', MEDIA_API)

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
  console.log(`[bug182] ${results.length - failed}/${results.length} assertions passed`)
}

/** 拒绝把产物写进仓库（AGENTS.md §6）。 */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory.',
    )
  }
}

// ────────────────────────────── 表行数（直读 SQLite） ──────────────────────────────

/**
 * 只读打开库并统计某集在两张关联表里的行（含具体 item_id，便于定位）。
 *
 * @param {number} episodeId 集 id
 * @returns {null | {sources:number, images:number, sourceItems:number[], imageItems:number[], error?:string}}
 */
function sqliteCounts(episodeId) {
  if (!TG_DB || !fs.existsSync(TG_DB)) return null
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch (e) {
    return { sources: -1, images: -1, sourceItems: [], imageItems: [], error: `node:sqlite unavailable: ${e.message}` }
  }
  let db
  try {
    db = new DatabaseSync(TG_DB, { readOnly: true })
  } catch (e) {
    return { sources: -1, images: -1, sourceItems: [], imageItems: [], error: `open failed: ${e.message}` }
  }
  try {
    const src = db
      .prepare('SELECT COUNT(*) AS c FROM media_episode_source WHERE episode_id = ?')
      .get(episodeId).c
    const img = db
      .prepare('SELECT COUNT(*) AS c FROM media_episode_image WHERE episode_id = ?')
      .get(episodeId).c
    const sourceItems = db
      .prepare('SELECT item_id FROM media_episode_source WHERE episode_id = ? ORDER BY item_id')
      .all(episodeId)
      .map((r) => Number(r.item_id))
    const imageItems = db
      .prepare('SELECT item_id FROM media_episode_image WHERE episode_id = ? ORDER BY item_id')
      .all(episodeId)
      .map((r) => Number(r.item_id))
    return { sources: Number(src), images: Number(img), sourceItems, imageItems }
  } catch (e) {
    return { sources: -1, images: -1, sourceItems: [], imageItems: [], error: `query failed: ${e.message}` }
  } finally {
    try {
      db.close()
    } catch (_e) {
      /* best effort */
    }
  }
}

// ────────────────────────────── 后端读模型 ──────────────────────────────

/**
 * `GET /api/media/series/:id` → 该集在**读模型**里的 sources / images 计数。
 *
 * @param {number} seriesId 剧集 id
 * @param {number} episodeId 集 id
 * @returns {Promise<null | {status:number, sources:number, images:number, sourceItems:number[], imageItems:number[]}>}
 */
async function apiEpisodeView(seriesId, episodeId) {
  const r = await sandbox.httpJson('GET', `${MEDIA_API}/api/media/series/${seriesId}`)
  if (r.status !== 200 || !r.json) return { status: r.status, sources: -1, images: -1, sourceItems: [], imageItems: [] }
  const ep = (r.json.episodes || []).find((e) => e.id === episodeId)
  if (!ep) return { status: r.status, sources: -1, images: -1, sourceItems: [], imageItems: [] }
  return {
    status: r.status,
    sources: (ep.sources || []).length,
    images: (ep.images || []).length,
    sourceItems: (ep.sources || []).map((s) => Number(s.itemId)),
    imageItems: (ep.images || []).map((i) => Number(i.itemId)),
  }
}

// ────────────────────────────── 反向证伪：临时改写源文件 ──────────────────────────────

/**
 * 把「修复前形态」注回源文件（`detachSource(...)` → `detachImage(...)`）。
 *
 * @returns {string} 原始文件内容（用于还原）
 * @throws {Error} 找不到锚点字符串时（不静默改写别的东西）
 */
function injectPreFixForm() {
  const original = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
  if (!original.includes(FIXED_CALL)) {
    throw new Error(
      `revert: anchor "${FIXED_CALL}" not found in ${SERIES_DETAIL_SRC} — cannot inject the pre-fix form`,
    )
  }
  const patched = original.replace(FIXED_CALL, PREFIX_CALL)
  if (patched === original) {
    throw new Error('revert: replacement produced no change (unexpected)')
  }
  fs.writeFileSync(SERIES_DETAIL_SRC, patched)
  return original
}

/** 还原源文件（幂等）。 */
function restoreSource(original) {
  if (typeof original !== 'string') return
  fs.writeFileSync(SERIES_DETAIL_SRC, original)
}

/** 文件内容 sha256（用于证明反向证伪跑完后源文件逐字节还原）。 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** 轮询 Vite 转译产物，确认「修复前形态」已被服务端编译出来。 */
async function waitForServedMarker(expectPresent, expectAbsent, timeoutMs = 25000) {
  const url = `${APP_URL}src/components/media/SeriesDetail.tsx`
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const body = await httpGetText(url, 4000)
    if (body != null) {
      last = body
      if (body.includes(expectPresent) && !body.includes(expectAbsent)) {
        return { ok: true, url, bytes: body.length }
      }
    }
    await delay(400)
  }
  return { ok: false, url, bytes: last.length, hasPresent: last.includes(expectPresent), hasAbsent: last.includes(expectAbsent) }
}

/** 简单 GET 文本（仅回环，不走代理）。 */
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

async function waitTestid(page, testid, timeout = 15000) {
  await page.waitForFunction((tid) => !!document.querySelector(`[data-testid="${tid}"]`), {
    timeout,
    args: [testid],
  })
}

async function countTestid(page, testid) {
  return page.evaluate((tid) => document.querySelectorAll(`[data-testid="${tid}"]`).length, testid)
}

async function waitCountEq(page, testid, want, timeout = 9000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const n = await countTestid(page, testid)
    if (n === want) return true
    await delay(250)
  }
  return false
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[bug182] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[bug182] shot ${name} FAILED: ${e.message}`)
  }
}

/** 打开媒体库 → 剧集墙。 */
async function gotoMediaLibrary(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  await waitTestid(page, 'nav-child-lib-series', 20000)
  await clickTestid(page, 'nav-child-lib-series')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 20000 },
  )
  await delay(800)
}

/** 按后端剧集 id 打开详情。 */
async function openSeriesById(page, id) {
  await gotoMediaLibrary(page)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, id)
  if (!clicked) throw new Error(`series-card with data-series-id=${id} not found on the series wall`)
  await waitTestid(page, 'episode-source-detach', 20000)
  await delay(600)
}

// ────────────────────────────── 造数 ──────────────────────────────

/** 建一个本地条目（kind 显式给出），返回 itemId。 */
async function createItem(kind, title, filePath) {
  const r = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/items`, {
    items: [{ path: filePath, title, kind }],
  })
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.ids) || r.json.ids.length !== 1) {
    throw new Error(`createItem(${kind}) failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
  return Number(r.json.ids[0])
}

/**
 * 造「1 主 + 1 备用源 + 2 挂图」的分集，并登记清理。
 *
 * @returns {Promise<object>} 造出的 id 集合与关键 HTTP 状态
 */
async function buildFixture() {
  const mediaDir = path.join(OUT_DIR, 'testmedia')
  fs.mkdirSync(mediaDir, { recursive: true })
  const mk = (name) => {
    const p = path.join(mediaDir, name)
    fs.writeFileSync(p, Buffer.alloc(16))
    return p
  }

  const { id: seriesId, title: seriesTitle } = await sandbox.createTempSeries(
    MEDIA_API,
    'VerifyProbe_Bug182_',
  )

  const mainItem = await createItem('video', 'QA-BUG182 主视频', mk('main.mp4'))
  const altItem = await createItem('video', 'QA-BUG182 备用源', mk('alt.mp4'))
  const imgItem1 = await createItem('photo', 'QA-BUG182 挂图1', mk('img1.jpg'))
  const imgItem2 = await createItem('photo', 'QA-BUG182 挂图2', mk('img2.jpg'))

  // 条目也要登记清理（剧集删除只级联分集/关联，不删条目）。
  for (const iid of [mainItem, altItem, imgItem1, imgItem2]) {
    sandbox.trackCleanup(async () => {
      await sandbox.httpJson('DELETE', `${MEDIA_API}/api/media/items/${iid}`)
    })
  }

  const epRes = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/series/${seriesId}/episodes`, {
    itemId: mainItem,
  })
  if (epRes.status !== 200 || !epRes.json || typeof epRes.json.id !== 'number') {
    throw new Error(`add episode failed: status=${epRes.status} body=${JSON.stringify(epRes.json)}`)
  }
  const episodeId = Number(epRes.json.id)

  const srcRes = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/episodes/${episodeId}/sources`, {
    itemId: altItem,
  })
  const imgRes = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/episodes/${episodeId}/images`, {
    itemIds: [imgItem1, imgItem2],
  })

  console.log(
    `[bug182] fixture: series=${seriesId} "${seriesTitle}" episode=${episodeId} main=${mainItem} ` +
      `alt(source)=${altItem} images=[${imgItem1},${imgItem2}]`,
  )
  console.log(
    `[bug182] fixture HTTP: addEpisode=${epRes.status} attachSource=${srcRes.status} ` +
      `(body=${JSON.stringify(srcRes.json)}) attachImages=${imgRes.status} (body=${JSON.stringify(imgRes.json)})`,
  )
  if (srcRes.status !== 200) {
    throw new Error(`attach source failed: status=${srcRes.status} body=${JSON.stringify(srcRes.json)}`)
  }
  if (imgRes.status !== 200 || !imgRes.json || Number(imgRes.json.attached) !== 2) {
    throw new Error(`attach images failed: status=${imgRes.status} body=${JSON.stringify(imgRes.json)}`)
  }

  return { seriesId, episodeId, mainItem, altItem, imgItem1, imgItem2 }
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assertOutDirSafe(OUT_DIR)

  console.log(`[bug182] app=${APP_URL} media-api=${MEDIA_API} db=${TG_DB || '(unset)'}`)
  console.log(`[bug182] revert mode: ${REVERT_TO_PRE_FIX ? 'ON (inject pre-fix form, expect FAIL)' : 'off'}`)

  // 反向证伪：临时把源文件改成修复前形态（跑完在 finally 还原）。
  let originalSource = null
  let sourceHashBefore = null
  if (REVERT_TO_PRE_FIX) {
    originalSource = injectPreFixForm()
    sourceHashBefore = sha256(originalSource)
    sandbox.trackCleanup(async () => restoreSource(originalSource))
    const served = await waitForServedMarker(PREFIX_CALL, FIXED_CALL)
    console.log(
      `[bug182] revert: injected "${PREFIX_CALL}" | vite served reverted module: ${served.ok}` +
        (served.ok ? '' : ` (hasPrefix=${served.hasPresent} hasFixed=${served.hasAbsent})`),
    )
    if (!served.ok) {
      throw new Error('revert: Vite did not serve the reverted module in time; aborting (file will be restored)')
    }
  }

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()

    // ── 造数 ─────────────────────────────────────────────────────────────
    const fx = await buildFixture()
    const { seriesId, episodeId, altItem, imgItem1, imgItem2 } = fx

    // ── 打开详情 ─────────────────────────────────────────────────────────
    await openSeriesById(page, seriesId)
    const detachBtns = await countTestid(page, 'episode-source-detach')
    console.log(`[bug182] detail opened; episode-source-detach count (before click) = ${detachBtns}`)
    check(
      'sanity: 多源区「摘除」按钮已渲染（1 个备用源 → 1 个按钮）',
      detachBtns === 1,
      `count=${detachBtns}`,
    )
    await shot(page, '01-detail-before.png')

    // ── 点击前基线 ───────────────────────────────────────────────────────
    const beforeDb = sqliteCounts(episodeId)
    const beforeApi = await apiEpisodeView(seriesId, episodeId)
    console.log('[bug182] BEFORE click  DB :', JSON.stringify(beforeDb))
    console.log('[bug182] BEFORE click  API:', JSON.stringify(beforeApi))
    check(
      'baseline: media_episode_source = 1（备用源已挂）',
      !!beforeDb && beforeDb.sources === 1,
      beforeDb ? `DB sources=${beforeDb.sources} items=${JSON.stringify(beforeDb.sourceItems)}` : 'DB unreadable',
    )
    check(
      'baseline: media_episode_image = 2（两张挂图已挂）',
      !!beforeDb && beforeDb.images === 2,
      beforeDb ? `DB images=${beforeDb.images} items=${JSON.stringify(beforeDb.imageItems)}` : 'DB unreadable',
    )
    check(
      'baseline: 读模型与表一致（sources=1, images=2）',
      beforeApi.sources === 1 && beforeApi.images === 2,
      `API status=${beforeApi.status} sources=${beforeApi.sources} images=${beforeApi.images}`,
    )

    // ── 真实点击「摘除」 ─────────────────────────────────────────────────
    await clickTestid(page, 'episode-source-detach')
    console.log('[bug182] clicked [data-testid="episode-source-detach"]')
    const domGone = await waitCountEq(page, 'episode-source-detach', 0, 9000)
    console.log(`[bug182] episode-source-detach disappeared from DOM: ${domGone}`)
    await delay(500)
    await shot(page, '02-detail-after-detach.png')

    // ── 点击后实测 ───────────────────────────────────────────────────────
    const afterDb = sqliteCounts(episodeId)
    const afterApi = await apiEpisodeView(seriesId, episodeId)
    console.log('[bug182] AFTER  click  DB :', JSON.stringify(afterDb))
    console.log('[bug182] AFTER  click  API:', JSON.stringify(afterApi))

    // ① 核心断言：备用源行消失
    const sourceGoneDb = !!afterDb && afterDb.sources === 0
    const sourceGoneApi = afterApi.sources === 0
    const altGoneDb = !!afterDb && !afterDb.sourceItems.includes(altItem)
    check(
      'CORE: 点击后 media_episode_source 行消失（备用源真被摘除）',
      sourceGoneDb && sourceGoneApi && altGoneDb,
      `DB sources ${beforeDb ? beforeDb.sources : '?'}->${afterDb ? afterDb.sources : '?'} ` +
        `(altItem ${altItem} present=${afterDb ? afterDb.sourceItems.includes(altItem) : '?'}) | ` +
        `API sources ${beforeApi.sources}->${afterApi.sources} | ` +
        `HTTP attach=${beforeApi.status} after=${afterApi.status}`,
    )

    // ② 反证：挂图行数不变（没有误摘挂图）
    const imagesUnchangedDb = !!afterDb && !!beforeDb && afterDb.images === beforeDb.images
    const imagesUnchangedApi = afterApi.images === beforeApi.images
    check(
      'CORE: media_episode_image 行数不变（未误摘挂图）',
      imagesUnchangedDb && imagesUnchangedApi,
      `DB images ${beforeDb ? beforeDb.images : '?'}->${afterDb ? afterDb.images : '?'} ` +
        `(expect equal) | API images ${beforeApi.images}->${afterApi.images}`,
    )

    // ── ③ 不误伤：灯箱内「摘图」行为逐字不变 ─────────────────────────────
    // 此刻挂图仍有 2 张（上一步反证已确认没被误删）→ 用它验证灯箱摘图仍生效。
    const deckOpen = await countTestid(page, 'episode-deck-open')
    console.log(`[bug182] episode-deck-open count = ${deckOpen}`)
    check('灯箱入口可达（episode-deck-open 存在）', deckOpen >= 1, `count=${deckOpen}`)

    let lightboxUp = false
    let lightboxClosed = false
    if (deckOpen >= 1) {
      await clickTestid(page, 'episode-deck-open')
      lightboxUp = await countTestid(page, 'lightbox').then((n) => n > 0).catch(() => false)
      console.log(`[bug182] lightbox opened: ${lightboxUp}`)
      await shot(page, '03-lightbox.png')
      const detachInLightbox = await countTestid(page, 'lightbox-detach')
      console.log(`[bug182] lightbox-detach count = ${detachInLightbox}`)
      check('灯箱内「摘图」按钮存在（lightbox-detach）', detachInLightbox >= 1, `count=${detachInLightbox}`)

      const beforeLbDb = sqliteCounts(episodeId)
      const beforeLbApi = await apiEpisodeView(seriesId, episodeId)
      if (detachInLightbox >= 1) {
        await clickTestid(page, 'lightbox-detach')
        lightboxClosed = await waitCountEq(page, 'lightbox', 0, 6000)
        await delay(500)
        const afterLbDb = sqliteCounts(episodeId)
        const afterLbApi = await apiEpisodeView(seriesId, episodeId)
        console.log('[bug182] LIGHTBOX before DB :', JSON.stringify(beforeLbDb))
        console.log('[bug182] LIGHTBOX after  DB :', JSON.stringify(afterLbDb))
        console.log('[bug182] LIGHTBOX before API:', JSON.stringify(beforeLbApi))
        console.log('[bug182] LIGHTBOX after  API:', JSON.stringify(afterLbApi))
        const imgDecreasedDb =
          !!beforeLbDb && !!afterLbDb && afterLbDb.images === beforeLbDb.images - 1
        const imgDecreasedApi = afterLbApi.images === beforeLbApi.images - 1
        check(
          '不误伤: 灯箱内「摘图」仍生效（media_episode_image 减少 1）',
          imgDecreasedDb && imgDecreasedApi,
          `DB images ${beforeLbDb ? beforeLbDb.images : '?'}->${afterLbDb ? afterLbDb.images : '?'} ` +
            `| API images ${beforeLbApi.images}->${afterLbApi.images}`,
        )
        check(
          '不误伤: 灯箱摘图不触碰备用源（media_episode_source 仍为 0）',
          !!afterLbDb && afterLbDb.sources === 0,
          `DB sources=${afterLbDb ? afterLbDb.sources : '?'}`,
        )
      }
    } else {
      check('灯箱入口可达（episode-deck-open 存在）', false, 'no episode-deck-open to click')
    }

    // ── 页面健康 ─────────────────────────────────────────────────────────
    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[bug182] page errors:', JSON.stringify(errs))
    check('页面无未捕获异常', errs.length === 0, errs.length ? JSON.stringify(errs) : 'none')

    // ── 反向证伪还原（在 dump 之前做，好让「还原」本身也进断言清单）───────
    if (REVERT_TO_PRE_FIX && originalSource != null) {
      restoreSource(originalSource)
      const nowText = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
      const hashAfter = sha256(nowText)
      const byteIdentical = hashAfter === sourceHashBefore
      console.log(
        `[bug182] revert restore: sha256 before=${sourceHashBefore} after=${hashAfter} byte-identical=${byteIdentical}`,
      )
      check(
        '反向证伪还原: SeriesDetail.tsx 逐字节还原（sha256 前后一致）',
        byteIdentical,
        `sha256 ${sourceHashBefore} -> ${hashAfter}`,
      )
      originalSource = null // 已还原；finally 不再重复
    }

    console.log('[bug182] screenshots ->', OUT_DIR)
    dumpResults()
    const failed = results.filter((r) => !r.ok).length
    if (REVERT_TO_PRE_FIX) {
      // 反向证伪：期望「核心断言」转红。
      const core = results.find((r) => r.name.startsWith('CORE: 点击后 media_episode_source'))
      if (failed > 0) {
        console.log(
          `[bug182] FALSIFICATION CONFIRMED: 注回修复前形态后有 ${failed} 条断言转红` +
            (core ? `（含核心断言：${core.ok ? 'NO' : 'YES'}）` : ''),
        )
      } else {
        console.log('[bug182] FALSIFICATION FAILED: 注回修复前形态后断言仍全绿 —— 本探针是假绿，需修断言')
      }
    }
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    // 反向证伪的还原：无论成败都还原（另有进程级钩子兜底）。
    if (REVERT_TO_PRE_FIX && originalSource != null) {
      restoreSource(originalSource)
      console.log('[bug182] revert: source file restored')
    }
    await sandbox.finalize()
  }
}

main().catch((e) => {
  console.error('[bug182] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
