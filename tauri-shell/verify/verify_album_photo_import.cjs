#!/usr/bin/env node
'use strict'

/**
 * BUG-188 真实 UI 验收：纯图相册「加入媒体库」必须走**一次批量编目**，不进字节传输队列。
 *
 * ## 缺陷回顾（BUG-188）
 *
 * 相册操作行原先唯一的出口是 `downloadAlbum` → `enqueueCacheTask`，也就是**字节传输
 * 队列**。但纯图组**没有任何需要落盘的字节**（TG 图片由 raw 端点现场代理，`entryState.ts:96`
 * 对 `tg`+`photo` 恒返回 `cached`）。于是「加入媒体库」这个**零字节**的编目动作被排到
 * 视频字节传输之后；而队列态是操作行三个渲染分支里的**第一支**（`progress ? ... : !allDone ? ... : done`），
 * 它**同时遮住**「加入媒体库」按钮与完成态 —— 用户看到永久「排队中」，无法判断功能是否坏了。
 *
 * ## 修复（commit b43c84c，仅前端）
 *
 *   - `importAlbum(items)`：**一次原子** `importMediaItems(...)` POST 覆盖整组 refs
 *     （source=`tg`, kind=`photo`），成功后同步 `photoLibRefs`（与单图 `importPhoto` 同源）；
 *   - `onAlbumImport`（useEvent 稳定回调）；
 *   - 按钮分岔：`cacheTargets === 0 ? onImportAlbum(items) : onDownload(items)`。
 *
 * ## 本脚本断言什么（打真实渲染 + 真实网络，不读分支）
 *
 *   A. **BUG-188 核心**：未入库纯图组点「加入媒体库」后 ——
 *      ① 只发生 **1 次** `POST /api/media/items`，且 body 的 items 覆盖**整组** refs；
 *      ② **0 次** `POST /api/tg/cache/tasks`（不进字节传输队列）；
 *      ③ 该组**就地立即**渲染完成态（`album-done` + `album-open`），**无需重载**；
 *      ④ 全程**不出现** `album-queued` / `album-progress`（不闪「排队中」）。
 *   B. **不回归 BUG-184/185**：同目录 `verify_album_action_row.cjs` 仍全绿（单独跑，见 README/报告）。
 *   C. **含视频组仍走 worker**（行为断言，不读分支）：含 video 的组点其按钮 →
 *      发生 `POST /api/tg/cache/tasks`，且**不**发生 `/api/media/items`；操作行转排队/进度态。
 *   D. **反向证伪**：把按钮改回无条件 `onDownload(items)` → 断言 A **必须转红**。跑完自动还原 +
 *      `sha256` 自证逐字节一致。
 *
 * ## 网络观测
 *
 *   经 CDP `Network.enable` 记录 `Network.requestWillBeSent`，按 URL 归并到
 *   `/api/media/items`（编目）与 `/api/tg/cache/tasks`（字节传输队列）两类 —— 这是**行为**
 *   证据，不是读代码。
 *
 * ## ⚠️ 写入冻结
 *
 *   本脚本会写（点按钮会 POST 到后端）。**默认拒绝**对真实实例 `127.0.0.1:19787` 运行；
 *   须在**隔离实例**（自建端口 + 自建临时 `ORIG_TG_DB`）上跑，或用 `ORIG_VERIFY_ALLOW_PROD_WRITES=1`
 *   显式放行（冻结解除后才可）。
 *
 * ## Usage / Env
 *
 *   APP_URL   (default http://127.0.0.1:5180/)      前端 dev server（指向隔离 orig-tg）
 *   TG_API    (default http://127.0.0.1:19787)      orig-tg 基址
 *   ORIG_VERIFY_OUT                                 证据/截图输出目录
 *   ORIG_VERIFY_REVERT                              '1' → 注入修复前形态（按钮走 onDownload）
 *   ORIG_VERIFY_ALLOW_PROD_WRITES                   放行对 19787 的写入（默认拒绝）
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题；3 = 拒绝对生产实例写入。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = (process.env.TG_API || process.env.ORIG_TG_API || 'http://127.0.0.1:19787').replace(/\/$/, '')
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-album-photo-import')
const REVERT = process.env.ORIG_VERIFY_REVERT === '1'
const ALLOW_PROD_WRITES = process.env.ORIG_VERIFY_ALLOW_PROD_WRITES === '1'

/** 被测源文件与其唯一改动点（按钮分岔）。 */
const TG_PANEL_SRC = path.resolve(__dirname, '..', 'src', 'components', 'TgPanel.tsx')
const BTN_FIXED = 'onClick={() => (cacheTargets === 0 ? onImportAlbum(items) : onDownload(items))}'
const BTN_PREFIX = 'onClick={() => onDownload(items)}'

const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))
const ADD_LABELS = new Set([ZH['tg.addToLibrary'], EN['tg.addToLibrary']].filter(Boolean))

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── 断言记录 ──────────────────────────────

const results = []
function check(name, ok, detail = '', id = '') {
  results.push({ name, ok: Boolean(ok), detail, id })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}
function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(`[album-photo-import] ${results.length - failed}/${results.length} assertions passed`)
}

function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(`Refusing to write artifacts inside the repo (${resolved}). Set ORIG_VERIFY_OUT.`)
  }
}

// ────────────────────────────── HTTP 小工具 ──────────────────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
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

async function monitoredChannels() {
  const r = await httpJson('GET', `${TG_API}/api/tg/monitor/channels`)
  return Array.isArray(r.json) ? r.json : []
}
async function itemIdByRef(ref) {
  const r = await httpJson('GET', `${TG_API}/api/media/items/by-ref?source=tg&ref=${encodeURIComponent(ref)}`)
  return r.json && typeof r.json.id === 'number' ? r.json.id : null
}
async function groupInLibrary(chatId, msgIds) {
  const ids = []
  for (const m of msgIds) ids.push(await itemIdByRef(`${chatId}:${m}`))
  return { all: ids.every((x) => x !== null), ids }
}
async function activeTaskGroupIds() {
  const r = await httpJson('GET', `${TG_API}/api/tg/cache/tasks`)
  const ids = new Set()
  const add = (t) => {
    if (t && t.groupId !== undefined && t.groupId !== null) ids.add(String(t.groupId))
  }
  if (r.json) {
    add(r.json.task)
    for (const q of r.json.queued || []) add(q)
  }
  return ids
}
async function cancelTask(id) {
  return httpJson('DELETE', `${TG_API}/api/tg/cache/tasks/${encodeURIComponent(String(id))}`)
}
/** 当前唯一任务的 id（running 或最老 queued）。 */
async function currentTaskId() {
  const r = await httpJson('GET', `${TG_API}/api/tg/cache/tasks`)
  if (!r.json) return null
  if (r.json.task && r.json.task.id != null) return r.json.task.id
  const q = (r.json.queued || [])[0]
  return q && q.id != null ? q.id : null
}

// ────────────────────────────── DOM 扫描 ──────────────────────────────

const SCAN_FN = () => {
  const out = []
  document.querySelectorAll('[data-testid="album-grid"]').forEach((g) => {
    const card = g.parentElement
    if (!card) return
    let msgId = null
    let opRow = null
    for (const s of card.querySelectorAll('span')) {
      const t = (s.textContent || '').trim()
      if (t.startsWith('#') && s.parentElement) {
        msgId = t
        opRow = s.parentElement
        break
      }
    }
    let vids = 0
    let photos = 0
    const msgIds = []
    g.querySelectorAll('button').forEach((b) => {
      const mid = b.getAttribute('data-message-id')
      if (mid) msgIds.push(Number(mid))
      const isVideo = [...b.querySelectorAll('span')].some((s) => {
        const t = (s.textContent || '').trim()
        return t === '▶' || t === '⬇'
      })
      if (isVideo) vids++
      else photos++
    })
    const doneEl = card.querySelector('[data-testid="album-done"]')
    const openEl = card.querySelector('[data-testid="album-open"]')
    out.push({
      msgId,
      tiles: g.querySelectorAll('button').length,
      vids,
      photos,
      msgIds,
      opText: opRow ? opRow.innerText.replace(/\s+/g, ' ').trim() : null,
      opButtons: opRow ? [...opRow.querySelectorAll('button')].map((b) => b.innerText.trim()) : [],
      hasDone: !!doneEl,
      hasOpen: !!openEl,
      hasQueued: !!card.querySelector('[data-testid="album-queued"]'),
      hasProgress: !!card.querySelector('[data-testid="album-progress"]'),
      doneText: doneEl ? doneEl.innerText.trim() : null,
      openText: openEl ? openEl.innerText.trim() : null,
    })
  })
  return out
}

const SCROLL_TOP_FN = () => {
  const el = [...document.querySelectorAll('div.overflow-y-auto')].find(
    (d) => d.querySelector('[data-testid="album-grid"]') || d.querySelector('[data-testid="tg-photo-preview"]'),
  )
  if (!el) return false
  el.scrollTop = 0
  el.dispatchEvent(new Event('scroll', { bubbles: true }))
  return true
}

function hasActiveProgress(a) {
  if (!a) return false
  return a.hasQueued || a.hasProgress || (a.opButtons || []).includes('取消') || /排队中|缓存中/.test(a.opText || '')
}

async function openTgPanel(browser) {
  const page = await browser.newPage()
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!clicked) throw new Error('nav-tg entry not found (TG feature gated off?)')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), { timeout: 20000 })
  await delay(3500)
  return page
}

async function collectAlbums(page, maxScroll = 24, stopWhen = () => false) {
  const seen = new Map()
  const collect = async () => {
    const arr = await page.evaluate(SCAN_FN)
    for (const a of arr) if (a.msgId) seen.set(a.msgId, a)
  }
  await collect()
  for (let i = 0; i < maxScroll; i++) {
    if (stopWhen(seen)) break
    const ok = await page.evaluate(SCROLL_TOP_FN)
    if (!ok) break
    await delay(1400)
    await collect()
  }
  return seen
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[album-photo-import] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[album-photo-import] shot ${name} FAILED: ${e.message}`)
  }
}

/** 点击某相册操作行里文本匹配 `label` 的按钮。 */
async function clickAlbumButton(page, msgId, label) {
  return page.evaluate(
    (mid, lbl) => {
      for (const g of document.querySelectorAll('[data-testid="album-grid"]')) {
        const card = g.parentElement
        if (!card || !card.innerText.includes(mid)) continue
        for (const b of card.querySelectorAll('button')) {
          if (b.innerText.trim() === lbl) {
            b.click()
            return true
          }
        }
        return 'card-found-but-no-matching-button:' + [...card.querySelectorAll('button')].map((b) => b.innerText.trim()).join('|')
      }
      return 'card-not-found'
    },
    msgId,
    label,
  )
}

/** 读取某相册的实时操作行快照。 */
async function albumSnapshot(page, msgId) {
  return page.evaluate((mid) => {
    for (const g of document.querySelectorAll('[data-testid="album-grid"]')) {
      const card = g.parentElement
      if (!card || !card.innerText.includes(mid)) continue
      const doneEl = card.querySelector('[data-testid="album-done"]')
      const openEl = card.querySelector('[data-testid="album-open"]')
      let opText = null
      for (const s of card.querySelectorAll('span')) {
        const t = (s.textContent || '').trim()
        if (t.startsWith('#') && s.parentElement) {
          opText = s.parentElement.innerText.replace(/\s+/g, ' ').trim()
          break
        }
      }
      return {
        found: true,
        opText,
        hasDone: !!doneEl,
        hasOpen: !!openEl,
        hasQueued: !!card.querySelector('[data-testid="album-queued"]'),
        hasProgress: !!card.querySelector('[data-testid="album-progress"]'),
        doneText: doneEl ? doneEl.innerText.trim() : null,
        openText: openEl ? openEl.innerText.trim() : null,
      }
    }
    return { found: false }
  }, msgId)
}

// ────────────────────────────── 网络观测 ──────────────────────────────

/**
 * 开启 Network 域并记录请求（method/url/postData）。
 * @returns {Promise<{log:Array, clear:Function, dispose:Function}>}
 */
async function enableNetwork(page) {
  const log = []
  const off = page.conn.on('Network.requestWillBeSent', (p) => {
    const req = p.request || {}
    log.push({ method: req.method, url: req.url, postData: req.postData || null })
  })
  await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
  return {
    log,
    clear: () => {
      log.length = 0
    },
    dispose: off,
  }
}
const isMediaItemsPost = (r) => r.method === 'POST' && /\/api\/media\/items(\?|$)/.test(r.url)
const isCacheTaskPost = (r) => r.method === 'POST' && /\/api\/tg\/cache\/tasks(\?|$)/.test(r.url)

// ────────────────────────────── 反向证伪 ──────────────────────────────

function sha256(t) {
  return crypto.createHash('sha256').update(t).digest('hex')
}
function injectPreFixForm() {
  const original = fs.readFileSync(TG_PANEL_SRC, 'utf8')
  if (!original.includes(BTN_FIXED)) throw new Error(`revert: anchor not found: ${BTN_FIXED}`)
  const patched = original.replace(BTN_FIXED, BTN_PREFIX)
  if (patched === original) throw new Error('revert: replacement produced no change')
  fs.writeFileSync(TG_PANEL_SRC, patched)
  return original
}
function restoreSource(original) {
  if (typeof original !== 'string') return
  fs.writeFileSync(TG_PANEL_SRC, original)
}
async function waitForServedMarker(expectPresent, expectAbsent, timeoutMs = 25000) {
  const url = `${APP_URL.replace(/\/$/, '')}/src/components/TgPanel.tsx`
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const body = await httpGetText(url, 4000)
    if (body != null) {
      last = body
      const hp = expectPresent ? body.includes(expectPresent) : true
      const ha = expectAbsent ? body.includes(expectAbsent) : false
      if (hp && !ha) return { ok: true, hasPresent: hp, hasAbsent: ha }
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

  console.log(`[album-photo-import] app=${APP_URL} tg-api=${TG_API} out=${OUT_DIR}`)
  console.log(`[album-photo-import] revert: ${REVERT ? 'ON (inject pre-fix button, expect FAIL)' : 'off'}`)

  // ── 写入冻结防线：默认拒绝对真实实例 19787 写入 ──────────────────────
  let host = ''
  let port = ''
  try {
    const u = new URL(TG_API)
    host = u.hostname
    port = u.port
  } catch (_e) {
    /* ignore */
  }
  const isRealInstance = (host === '127.0.0.1' || host === 'localhost') && port === '19787'
  if (isRealInstance && !ALLOW_PROD_WRITES) {
    console.error(
      '[album-photo-import] REFUSED: this script WRITES and TG_API points at the real instance ' +
        `${TG_API}. Writes are frozen. Run on an isolated instance, or set ` +
        'ORIG_VERIFY_ALLOW_PROD_WRITES=1 once unfrozen.',
    )
    process.exit(3)
  }

  // ── 环境自检 ───────────────────────────────────────────────────────
  const diag = await httpJson('GET', `${TG_API}/api/tg/diag`)
  console.log(
    `[album-photo-import] diag: status=${diag.status} available=${diag.json && diag.json.available} ` +
      `mode=${diag.json && diag.json.mode} session=${diag.json && diag.json.session_phase}`,
  )
  if (!diag.json || diag.json.available !== true) {
    console.error('[album-photo-import] orig-tg not available. Aborting (env).')
    process.exit(1)
  }
  if ((await httpGetText(APP_URL, 6000)) == null) {
    console.error(`[album-photo-import] dev server ${APP_URL} not reachable. Aborting (env).`)
    process.exit(1)
  }

  // ── 反向证伪注入 ────────────────────────────────────────────────────
  let originalSource = null
  let hashBefore = null
  if (REVERT) {
    originalSource = injectPreFixForm()
    hashBefore = sha256(originalSource)
    const served = await waitForServedMarker('onClick: () => onDownload(items)', 'onImportAlbum')
    console.log(
      `[album-photo-import] revert: injected "${BTN_PREFIX}" | vite served reverted module: ${served.ok}` +
        (served.ok ? '' : ` (hasPresent=${served.hasPresent} hasAbsent=${served.hasAbsent})`),
    )
    if (!served.ok) {
      restoreSource(originalSource)
      originalSource = null
      throw new Error('revert: Vite did not serve the reverted module in time (source restored)')
    }
  }
  const cleanupRestore = () => {
    if (REVERT && originalSource != null) restoreSource(originalSource)
  }
  process.on('exit', cleanupRestore)
  process.on('SIGINT', () => {
    cleanupRestore()
    process.exit(130)
  })

  const browser = await cdp.launch()
  const createdTaskIds = []
  try {
    const page = await openTgPanel(browser)
    const net = await enableNetwork(page)

    const chans = await monitoredChannels()
    const chatId = chans.length ? Number(chans[0].channelId) : null
    console.log(`[album-photo-import] monitored channels: ${JSON.stringify(chans.map((c) => ({ id: c.channelId, title: c.title })))}`)
    if (chatId == null) throw new Error('no monitored channel — cannot map refs')

    const unbound = await page.evaluate(() => !!document.querySelector('[data-testid="tg-unbound-guide"]'))
    const broken = await page.evaluate(() => !!document.querySelector('[data-testid="tg-panel-broken"]'))
    if (unbound || broken) {
      console.error(`[album-photo-import] TG panel unusable (unbound=${unbound} broken=${broken}). Aborting (env).`)
      process.exit(1)
    }

    const seen = await collectAlbums(page, 24, (s) => {
      const arr = [...s.values()]
      return (
        arr.some((a) => a.vids === 0 && a.photos >= 2 && !a.hasDone && !hasActiveProgress(a)) &&
        arr.some((a) => a.vids >= 1 && !a.hasDone && !hasActiveProgress(a))
      )
    })
    const all = [...seen.values()]
    console.log(`[album-photo-import] album bubbles collected: ${all.length}`)
    await shot(page, '01-tg-panel.png')

    // ── 选样本：未入库纯图组（断言 A）、含视频组（断言 C） ──────────────────
    const pureCandidates = all.filter((a) => a.vids === 0 && a.photos >= 2 && !a.hasDone && !hasActiveProgress(a))
    let pure = null
    for (const a of pureCandidates) {
      const lib = await groupInLibrary(chatId, a.msgIds)
      if (!lib.all) {
        pure = { ...a, libIds: lib.ids }
        break
      }
    }
    const videoCand = all.find((a) => a.vids >= 1 && !a.hasDone && !hasActiveProgress(a))

    check(
      'A/环境: 存在「未入库纯图相册」样本（组内 video=0 且 photo≥2）',
      !!pure,
      pure ? `msgId=${pure.msgId} photos=${pure.photos} msgIds=${JSON.stringify(pure.msgIds)}` : `none among ${pureCandidates.length} candidates`,
      'A0',
    )
    if (!pure) {
      dumpResults()
      process.exitCode = 2
      return
    }
    console.log(`[album-photo-import] PURE ${pure.msgId}: opText="${pure.opText}" buttons=${JSON.stringify(pure.opButtons)} msgIds=${JSON.stringify(pure.msgIds)}`)

    // ── 断言 A：点「加入媒体库」→ 一次批量编目、不进队列、就地完成 ──────────
    net.clear()
    const before = await albumSnapshot(page, pure.msgId)
    const clicked = await clickAlbumButton(page, pure.msgId, ZH['tg.addToLibrary'])
    console.log(`[album-photo-import] clicked 加入媒体库 on ${pure.msgId}: ${clicked}`)
    // 观察约 6s 内的即时转态（含是否闪排队态）
    let sawQueued = false
    let sawProgress = false
    let immediateDone = false
    let doneSnap = null
    for (let i = 0; i < 30; i++) {
      await delay(200)
      const snap = await albumSnapshot(page, pure.msgId)
      if (snap.hasQueued) sawQueued = true
      if (snap.hasProgress) sawProgress = true
      if (snap.hasDone && snap.hasOpen) {
        immediateDone = true
        doneSnap = snap
        break
      }
    }
    await shot(page, '02-pure-after-click.png')

    const mediaPosts = net.log.filter(isMediaItemsPost)
    const taskPosts = net.log.filter(isCacheTaskPost)
    console.log(
      `[album-photo-import] NET after click: media/items POST=${mediaPosts.length} cache/tasks POST=${taskPosts.length}`,
    )
    for (const r of mediaPosts) console.log(`[album-photo-import]   POST ${r.url} body=${r.postData}`)
    for (const r of taskPosts) console.log(`[album-photo-import]   POST ${r.url} body=${r.postData}`)

    // ① 一次原子 POST
    check(
      'A/BUG-188: 点「加入媒体库」只发生 1 次 POST /api/media/items',
      mediaPosts.length === 1,
      `media/items POST count=${mediaPosts.length}`,
      'A1',
    )
    // ② body 覆盖整组 refs
    let bodyCount = -1
    if (mediaPosts.length === 1) {
      try {
        const parsed = JSON.parse(mediaPosts[0].postData || '{}')
        bodyCount = Array.isArray(parsed.items) ? parsed.items.length : -1
      } catch (_e) {
        bodyCount = -1
      }
    }
    check(
      'A/BUG-188: 该 POST 的 body.items 覆盖整组 refs（一次覆盖全部，非循环单条）',
      bodyCount === pure.msgIds.length && bodyCount >= 2,
      `body.items=${bodyCount} groupSize=${pure.msgIds.length}`,
      'A2',
    )
    // ③ 不进字节传输队列
    check(
      'A/BUG-188: 点「加入媒体库」不发生 POST /api/tg/cache/tasks（不进字节传输队列）',
      taskPosts.length === 0,
      `cache/tasks POST count=${taskPosts.length}`,
      'A3',
    )
    // ④ 就地立即完成
    check(
      'A/BUG-188: 该纯图组就地立即渲染完成态（album-done + album-open，无需重载）',
      immediateDone,
      doneSnap ? `opText="${doneSnap.opText}" doneText=${JSON.stringify(doneSnap.doneText)} openText=${JSON.stringify(doneSnap.openText)}` : `not reached within 6s (before="${before.opText}")`,
      'A4',
    )
    // ⑤ 不闪排队态
    check(
      'A/BUG-188: 全程不出现「排队中/缓存中」（无 album-queued / album-progress）',
      !sawQueued && !sawProgress,
      `sawQueued=${sawQueued} sawProgress=${sawProgress}`,
      'A5',
    )
    // 后端佐证：refs 真入库
    const afterLib = await groupInLibrary(chatId, pure.msgIds)
    check(
      'A/BUG-188: 后端佐证 —— 该组 refs 全部已在库（by-ref 命中）',
      afterLib.all,
      `ids=${JSON.stringify(afterLib.ids)}`,
      'A6',
    )

    // ── 断言 C：含视频组仍走 worker（行为断言） ───────────────────────────
    if (videoCand) {
      console.log(`[album-photo-import] VIDEO ${videoCand.msgId}: opText="${videoCand.opText}" buttons=${JSON.stringify(videoCand.opButtons)} vids=${videoCand.vids}`)
      const btnLabel = videoCand.opButtons.find((t) => t && !ADD_LABELS.has(t))
      net.clear()
      const clicked2 = btnLabel ? await clickAlbumButton(page, videoCand.msgId, btnLabel) : 'no-button'
      console.log(`[album-photo-import] clicked video-group button "${btnLabel}" on ${videoCand.msgId}: ${clicked2}`)
      let videoQueued = false
      for (let i = 0; i < 25; i++) {
        await delay(200)
        const snap = await albumSnapshot(page, videoCand.msgId)
        if (snap.hasQueued || snap.hasProgress) {
          videoQueued = true
          break
        }
      }
      await shot(page, '03-video-after-click.png')
      const mediaPosts2 = net.log.filter(isMediaItemsPost)
      const taskPosts2 = net.log.filter(isCacheTaskPost)
      console.log(
        `[album-photo-import] NET after video click: media/items POST=${mediaPosts2.length} cache/tasks POST=${taskPosts2.length}`,
      )
      check(
        'C/BUG-188: 含视频组仍走字节传输队列（发生 POST /api/tg/cache/tasks）',
        taskPosts2.length >= 1,
        `cache/tasks POST count=${taskPosts2.length}`,
        'C1',
      )
      check(
        'C/BUG-188: 含视频组不误走批量编目（无 POST /api/media/items）',
        mediaPosts2.length === 0,
        `media/items POST count=${mediaPosts2.length}`,
        'C2',
      )
      check(
        'C/BUG-188: 含视频组点击后操作行转排队/进度态（album-queued / album-progress）',
        videoQueued,
        `videoQueued=${videoQueued}`,
        'C3',
      )
      // 清理：取消本次点击产生的任务（隔离实例上也无害，保持幂等）
      const tid = await currentTaskId()
      if (tid != null) {
        createdTaskIds.push(tid)
        const c = await cancelTask(tid)
        console.log(`[album-photo-import] cleanup: cancelled cache task id=${tid} -> status=${c.status}`)
      }
    } else {
      check('C/环境: 存在「含视频相册」样本（video≥1）', false, `none among ${all.length} bubbles`, 'C0')
    }

    // ── 页面健康 ───────────────────────────────────────────────────────
    const pageErrs = page.pageErrors().slice(0, 5)
    const consoleErrs = page.consoleErrors().filter((e) => !/favicon\.ico/.test(e)).slice(0, 5)
    if (pageErrs.length) console.log('[album-photo-import] page errors:', JSON.stringify(pageErrs))
    check('页面无未捕获异常（非白屏）', pageErrs.length === 0, pageErrs.length ? JSON.stringify(pageErrs) : 'none')
    check('页面无 console.error（favicon 除外）', consoleErrs.length === 0, consoleErrs.length ? JSON.stringify(consoleErrs) : 'none')

    // ── 反向证伪还原（dump 前，让「还原」本身也进断言） ────────────────────
    if (REVERT && originalSource != null) {
      restoreSource(originalSource)
      const hashAfter = sha256(fs.readFileSync(TG_PANEL_SRC, 'utf8'))
      const identical = hashAfter === hashBefore
      console.log(`[album-photo-import] revert restore: sha256 before=${hashBefore} after=${hashAfter} byte-identical=${identical}`)
      check('反向证伪还原: TgPanel.tsx 逐字节还原（sha256 前后一致）', identical, `sha256 ${hashBefore} -> ${hashAfter}`)
      originalSource = null
    }

    console.log('[album-photo-import] screenshots ->', OUT_DIR)
    dumpResults()

    const failed = results.filter((r) => !r.ok).length
    if (REVERT) {
      const core = results.find((r) => r.id === 'A1')
      const coreFailed = core && !core.ok
      if (coreFailed) {
        console.log('[album-photo-import] FALSIFICATION CONFIRMED: 注回修复前按钮后核心断言（A1）转红')
      } else {
        console.log('[album-photo-import] FALSIFICATION FAILED: 注回修复前按钮后 A1 仍绿 —— 探针假绿，需修断言')
        process.exitCode = 4
      }
    }
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    if (REVERT && originalSource != null) {
      restoreSource(originalSource)
      console.log('[album-photo-import] revert: source file restored (finally)')
    }
  }
}

main().catch((e) => {
  console.error('[album-photo-import] ERROR', (e && e.message) || e)
  process.exit(1)
})
