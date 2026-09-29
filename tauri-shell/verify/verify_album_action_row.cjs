#!/usr/bin/env node
'use strict'

/**
 * BUG-184 / BUG-185 真实 UI 验收：TG 相册「操作行」的计数口径与完成态出口。
 *
 * ## 缺陷回顾（同源：`entryState.ts:96` 对 TG 图片无条件返回 `cached`）
 *
 * `entryStateFor(x)` 对 **TG 图片** 恒定返回 `'cached'`（BUG-049 代理语义：raw 端点
 * 现场代理字节，图片不落盘）。相册操作行原先用
 * `downloadedCount = unit.filter(x => entryStateFor(x) === 'cached').length`
 * 当「已缓存数」，于是**图片把计数撑起来**：
 *
 *   - BUG-184（分子分母不同源）：混合相册在**没有任何缓存任务**时也显示
 *     「继续 N/M」，且 M 用 `items.length`（把不落盘的图片也算进分母）。
 *   - BUG-185（完成态落 null）：纯图相册 `downloadedCount >= items.length` **恒真**
 *     ⇒ `allDone` 恒真 ⇒ 操作行整行落 `null`，「加入媒体库」按钮**从来不可达**。
 *
 * ## 修复（当前工作区已改，见 `src/components/TgPanel.tsx`）
 *
 *   - 父组件改传 `cacheTargets`（需要落盘的条目数 = `unit.filter(x => x.type !== 'photo').length`）
 *     与 `cachedTargets`（其中 `entryStateFor(x) === 'cached'` 的条数）—— **同源**；
 *   - `allDone = cacheTargets === 0 ? groupInLibrary : cachedTargets >= cacheTargets`；
 *   - 状态行/操作行改用新口径；完成态**不再落 null**，改渲染
 *     `[data-testid="album-done"]` + `[data-testid="album-open"]`；
 *   - i18n 新增 `tg.open`。
 *
 * ## 本脚本断言什么（打真实渲染的 DOM，不打内部函数）
 *
 *   A. **BUG-184**：任取一个**混合相册**（组内 video≥1 且 photo≥1、无活跃缓存任务）。
 *      其操作行按钮文案若出现 `N/M` 形态，则 **M 必须等于该组需要落盘的条目数**
 *      （= 非 photo 条目数 = video 数），且 `N ≤ M`；**不得**出现 `M === items.length`
 *      而 `items.length !== 非photo数` 的旧口径。修复前必然显示「继续 <photos>/<tiles>」。
 *
 *   B. **BUG-185 上半**：任取一个**纯图相册**（video==0 且 photo≥2、尚未入库）。
 *      其操作行必须**存在可点击按钮**且文案为「加入媒体库」——修复前该行整行 `null`。
 *
 *   C. **BUG-185 下半**：让该纯图相册全部入库（`allDone`）后，操作行必须出现
 *      `[data-testid="album-done"]` 与 `[data-testid="album-open"]`，且 `album-open`
 *      **可点击**（点击后打开 `[data-testid="media-viewer"]`）。修复前此分支落 `null`。
 *
 * 每条断言都打印**实测值**：按钮文案原文、`#msgId`、`hasDone`/`hasOpen`、DOM 按钮清单。
 *
 * ## 反向证伪（硬要求：断言不许假绿）
 *
 *   `ORIG_VERIFY_REVERT` 会把「修复前形态」**临时**注回 `TgPanel.tsx`，等 Vite 重新
 *   编译，再跑同一套断言 —— 目标断言**必须转红**。跑完**无论成败都在 finally 还原**
 *   文件，并用 `sha256` 自证逐字节一致（另有进程级清理钩子兜底）。
 *
 *     ORIG_VERIFY_REVERT=184   # 把 cacheTargets/cachedTargets 两处计算改回旧口径
 *     ORIG_VERIFY_REVERT=185   # 把完成态分支改回 null
 *     ORIG_VERIFY_REVERT=all   # 两者都改回（= 原始缺陷形态）
 *
 * ## 环境（用**真实在跑**的服务，严禁隔离实例 —— 隔离会丢真实 TG 数据）
 *
 *     # 服务已在跑：daemon 127.0.0.1:19786 / orig-tg 127.0.0.1:19787 / vite 5180
 *     node verify/verify_album_action_row.cjs
 *     ORIG_VERIFY_REVERT=184 node verify/verify_album_action_row.cjs   # 期望 exit 2
 *
 * ## Usage / Env
 *
 *   APP_URL   (default http://127.0.0.1:5180/)    前端 dev server
 *   TG_API    (default http://127.0.0.1:19787)    orig-tg：/api/tg/* 与 /api/media/*
 *   ORIG_VERIFY_OUT                                证据/截图输出目录（默认系统临时目录）
 *   ORIG_VERIFY_REVERT                             '' | 184 | 185 | all | 1
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题（浏览器找不到 / dev server 不可达 / 无真实数据）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = (process.env.TG_API || process.env.ORIG_TG_API || 'http://127.0.0.1:19787').replace(/\/$/, '')
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-album-action-row')

/** 反向证伪开关：把「修复前形态」注回源文件，期望目标断言转红。 */
const REVERT_RAW = (process.env.ORIG_VERIFY_REVERT || '').trim().toLowerCase()
const REVERT = REVERT_RAW === '1' ? 'all' : REVERT_RAW
const REVERT_184 = REVERT === 'all' || REVERT === '184'
const REVERT_185 = REVERT === 'all' || REVERT === '185'
const REVERT_ON = REVERT_184 || REVERT_185

/** 被测源文件（活实现）。 */
const TG_PANEL_SRC = path.resolve(__dirname, '..', 'src', 'components', 'TgPanel.tsx')
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))

const ADD_LABELS = new Set([ZH['tg.addToLibrary'], EN['tg.addToLibrary']].filter(Boolean))
const DONE_LABELS = new Set(
  [ZH['tg.inLibrary'], ZH['tg.downloaded'], EN['tg.inLibrary'], EN['tg.downloaded']].filter(Boolean),
)
const OPEN_LABELS = new Set([ZH['tg.open'], ZH['tg.play'], EN['tg.open'], EN['tg.play']].filter(Boolean))

// ── 反向证伪锚点（都是源文件里**唯一**的字符串，见 grep 计数） ──────────────
const A184_CACHE_OLD = 'unit.filter((x) => x.type !== \'photo\').length'
const A184_CACHE_NEW = 'unit.length'
const A184_CACHED_OLD = 'unit.filter((x) => x.type !== \'photo\' && entryStateFor(x) === \'cached\')'
const A184_CACHED_NEW = 'unit.filter((x) => entryStateFor(x) === \'cached\')'
/** 完成态分支（div 内无嵌套 div，非贪婪到第一个 </div> 即整块）。 */
const A185_DONE_BLOCK_RE = /<div className="ml-auto flex items-center gap-2">[\s\S]*?<\/div>/

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
  console.log(`[album-action-row] ${results.length - failed}/${results.length} assertions passed`)
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

/** 回环 GET → JSON（失败返回 null）。 */
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

/** GET 纯文本（用于探测 Vite 转译产物）。 */
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

/** 被监控频道列表（默认选中 = 第一个）。 */
async function monitoredChannels() {
  const r = await httpJson('GET', `${TG_API}/api/tg/monitor/channels`)
  return Array.isArray(r.json) ? r.json : []
}

/** `GET /api/media/items/by-ref` → itemId 或 null。 */
async function itemIdByRef(ref) {
  const r = await httpJson(
    'GET',
    `${TG_API}/api/media/items/by-ref?source=tg&ref=${encodeURIComponent(ref)}`,
  )
  return r.json && typeof r.json.id === 'number' ? r.json.id : null
}

/** 一个相册的全部 (chatId:msgId) 是否都已入库。 */
async function groupInLibrary(chatId, msgIds) {
  const ids = []
  for (const m of msgIds) ids.push(await itemIdByRef(`${chatId}:${m}`))
  return { all: ids.every((x) => x !== null), ids }
}

/** 登记 TG 图片条目（= UI「加入媒体库」的**同一端点**，新增登记、幂等、不删数据）。 */
async function registerPhotos(chatId, msgIds) {
  const items = msgIds.map((m) => ({ source: 'tg', ref: `${chatId}:${m}`, kind: 'photo' }))
  const r = await httpJson('POST', `${TG_API}/api/media/items`, { items })
  return r
}

/** 当前活跃缓存任务覆盖的 groupId 集合（running + queued）。 */
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

// ────────────────────────────── DOM 扫描（真实渲染） ──────────────────────────────

/**
 * 在页面里把每个相册气泡的操作行信息抓出来（纯 DOM 读取）。
 * 返回 { msgId, tiles, vids, photos, opText, opButtons, hasDone, hasOpen, doneText, openText }。
 */
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
    g.querySelectorAll('button').forEach((b) => {
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
      opText: opRow ? opRow.innerText.replace(/\s+/g, ' ').trim() : null,
      opButtons: opRow ? [...opRow.querySelectorAll('button')].map((b) => b.innerText.trim()) : [],
      hasDone: !!doneEl,
      hasOpen: !!openEl,
      doneText: doneEl ? doneEl.innerText.trim() : null,
      openText: openEl ? openEl.innerText.trim() : null,
    })
  })
  return out
}

/** 滚动消息流容器到顶部，触发「加载更早」一页。 */
const SCROLL_TOP_FN = () => {
  const el = [...document.querySelectorAll('div.overflow-y-auto')].find(
    (d) => d.querySelector('[data-testid="album-grid"]') || d.querySelector('[data-testid="tg-photo-preview"]'),
  )
  if (!el) return false
  el.scrollTop = 0
  el.dispatchEvent(new Event('scroll', { bubbles: true }))
  return true
}

/**
 * 打开 TG 面板并等待内容流。
 * @returns {Promise<object>} page
 */
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
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
    timeout: 20000,
  })
  await delay(3500)
  return page
}

/**
 * 反复扫描 + 滚顶，累计页面上出现过的所有相册气泡。
 * @returns {Promise<Map<string, object>>}
 */
async function collectAlbums(page, maxScroll = 22, stopWhen = () => false) {
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

/** 一个相册是否被活跃任务覆盖（操作行被进度态遮住）。 */
function hasProgress(a) {
  if (!a) return false
  const t = a.opText || ''
  return a.opButtons.includes('取消') || /排队中|缓存中/.test(t)
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[album-action-row] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[album-action-row] shot ${name} FAILED: ${e.message}`)
  }
}

// ────────────────────────────── 反向证伪 ──────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * 把「修复前形态」注回源文件。
 * @returns {string} 原始文件内容（用于还原）
 * @throws {Error} 锚点找不到时（不静默改别的东西）
 */
function injectPreFixForm() {
  const original = fs.readFileSync(TG_PANEL_SRC, 'utf8')
  let patched = original

  if (REVERT_184) {
    if (!patched.includes(A184_CACHE_OLD)) {
      throw new Error(`revert184: anchor not found: ${A184_CACHE_OLD}`)
    }
    if (!patched.includes(A184_CACHED_OLD)) {
      throw new Error(`revert184: anchor not found: ${A184_CACHED_OLD}`)
    }
    patched = patched.replace(A184_CACHE_OLD, A184_CACHE_NEW)
    patched = patched.replace(A184_CACHED_OLD, A184_CACHED_NEW)
  }
  if (REVERT_185) {
    if (!A185_DONE_BLOCK_RE.test(patched)) {
      throw new Error('revert185: done-state block anchor not found')
    }
    patched = patched.replace(A185_DONE_BLOCK_RE, 'null')
  }
  if (patched === original) throw new Error('revert: replacement produced no change (unexpected)')
  fs.writeFileSync(TG_PANEL_SRC, patched)
  return original
}

/** 还原源文件（幂等）。 */
function restoreSource(original) {
  if (typeof original !== 'string') return
  fs.writeFileSync(TG_PANEL_SRC, original)
}

/**
 * 轮询 Vite 转译产物，确认「修复前形态」已被服务端编译出来。
 * @returns {Promise<{ok:boolean, hasPresent:boolean, hasAbsent:boolean}>}
 */
async function waitForServedMarker(expectPresent, expectAbsent, timeoutMs = 25000) {
  const url = `${APP_URL.replace(/\/$/, '')}/src/components/TgPanel.tsx`
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

// ────────────────────────────── 断言逻辑 ──────────────────────────────

/** 从操作行文案里解析 `N/M` 分数（按钮/状态行口径）。 */
function parseFraction(text) {
  if (!text) return null
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text)
  if (!m) return null
  return { n: Number(m[1]), m: Number(m[2]), raw: m[0] }
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  assertOutDirSafe(OUT_DIR)

  console.log(`[album-action-row] app=${APP_URL} tg-api=${TG_API} out=${OUT_DIR}`)
  console.log(`[album-action-row] revert mode: ${REVERT_ON ? REVERT : 'off'}`)

  // ── 环境自检 ───────────────────────────────────────────────────────
  const diag = await httpJson('GET', `${TG_API}/api/tg/diag`)
  console.log(
    `[album-action-row] diag: status=${diag.status} available=${diag.json && diag.json.available} ` +
      `mode=${diag.json && diag.json.mode} session=${diag.json && diag.json.session_phase}`,
  )
  if (!diag.json || !diag.json.available) {
    console.error('[album-action-row] orig-tg not available — cannot verify real data. Aborting (env).')
    process.exit(1)
  }
  const appProbe = await httpGetText(APP_URL, 6000)
  if (appProbe == null) {
    console.error(`[album-action-row] dev server ${APP_URL} not reachable. Aborting (env).`)
    process.exit(1)
  }

  // ── 反向证伪：注回修复前形态（跑完在 finally 还原） ────────────────────
  let originalSource = null
  let sourceHashBefore = null
  if (REVERT_ON) {
    originalSource = injectPreFixForm()
    sourceHashBefore = sha256(originalSource)
    const present = REVERT_184 ? '=> entryStateFor(x) === "cached")' : 'album-grid'
    const absent = REVERT_184
      ? 'x.type !== "photo" && entryStateFor(x)'
      : 'album-done'
    const served = await waitForServedMarker(present, absent)
    console.log(
      `[album-action-row] revert: injected (${REVERT}) | vite served reverted module: ${served.ok}` +
        (served.ok ? '' : ` (hasPresent=${served.hasPresent} hasAbsent=${served.hasAbsent})`),
    )
    if (!served.ok) {
      restoreSource(originalSource)
      originalSource = null
      throw new Error('revert: Vite did not serve the reverted module in time (source restored)')
    }
  }

  // 进程级兜底：异常退出也要还原。
  const cleanupRestore = () => {
    if (REVERT_ON && originalSource != null) restoreSource(originalSource)
  }
  process.on('exit', cleanupRestore)
  process.on('SIGINT', () => {
    cleanupRestore()
    process.exit(130)
  })

  const browser = await cdp.launch()
  try {
    // ── 打开 TG 面板 ─────────────────────────────────────────────────
    const page = await openTgPanel(browser)

    const chans = await monitoredChannels()
    const chatId = chans.length ? Number(chans[0].channelId) : null
    console.log(
      `[album-action-row] monitored channels: ${JSON.stringify(chans.map((c) => ({ id: c.channelId, title: c.title })))}`,
    )
    if (chatId == null) throw new Error('no monitored channel — cannot map refs')
    const activeGroups = await activeTaskGroupIds()
    console.log(`[album-action-row] active cache-task groups: ${JSON.stringify([...activeGroups])}`)

    const noRoot = await page.evaluate(
      () => !document.querySelector('[data-testid="tg-panel-root"]'),
    )
    if (noRoot) throw new Error('tg-panel-root vanished (white screen)')
    const unbound = await page.evaluate(
      () => !!document.querySelector('[data-testid="tg-unbound-guide"]'),
    )
    const broken = await page.evaluate(
      () => !!document.querySelector('[data-testid="tg-panel-broken"]'),
    )
    if (unbound || broken) {
      console.error(`[album-action-row] TG panel not usable (unbound=${unbound} broken=${broken}). Aborting (env).`)
      process.exit(1)
    }

    // ── 收集相册气泡（滚顶加载更早，直到找到混合组 + 纯图组） ─────────────
    const wantMixed = (seen) =>
      [...seen.values()].some((a) => a.vids >= 1 && a.photos >= 1 && !hasProgress(a) && !a.hasDone)
    const wantPure = (seen) => [...seen.values()].some((a) => a.vids === 0 && a.photos >= 2)
    const seen = await collectAlbums(page, 24, (s) => wantMixed(s) && wantPure(s))
    const all = [...seen.values()]
    console.log(`[album-action-row] album bubbles collected: ${all.length}`)
    await shot(page, '01-tg-panel.png')

    // ── 断言 A（BUG-184）：混合组操作行口径同源 ──────────────────────────
    const mixed = all.find((a) => a.vids >= 1 && a.photos >= 1 && !hasProgress(a) && !a.hasDone)
    const mixedAny = all.find((a) => a.vids >= 1 && a.photos >= 1)
    const mixedPick = mixed || mixedAny
    check(
      'A/BUG-184: 页面上存在「混合相册」（组内 video≥1 且 photo≥1）',
      !!mixedPick,
      mixedPick
        ? `msgId=${mixedPick.msgId} tiles=${mixedPick.tiles} vids=${mixedPick.vids} photos=${mixedPick.photos}`
        : `none among ${all.length} bubbles`,
      'A1',
    )
    if (mixedPick) {
      const frac = parseFraction(mixedPick.opText)
      const nonPhoto = mixedPick.vids
      const itemsLen = mixedPick.tiles
      console.log(
        `[album-action-row] MIXED ${mixedPick.msgId}: opText="${mixedPick.opText}" ` +
          `buttons=${JSON.stringify(mixedPick.opButtons)} vids=${mixedPick.vids} photos=${mixedPick.photos} tiles=${mixedPick.tiles} fraction=${JSON.stringify(frac)}`,
      )
      let ok = true
      let why = ''
      if (frac) {
        // 若出现 N/M：M 必须 == 需要落盘的条目数（非 photo = vids），且 N ≤ M。
        ok = frac.m === nonPhoto && frac.n <= frac.m
        why =
          `fraction ${frac.raw}: M=${frac.m} must == nonPhoto(=vids)=${nonPhoto} and N=${frac.n} <= M; ` +
          `(items.length=${itemsLen})`
        // 额外把「旧口径」显式判死：M 不得等于 items.length（当 items.length !== nonPhoto）。
        if (itemsLen !== nonPhoto && frac.m === itemsLen) {
          ok = false
          why += ` | REJECTED: M equals items.length (${itemsLen}) — BUG-184 old denominator`
        }
      } else {
        // 无分数：合法（cachedTargets=0 → 「缓存」；或已完成 → 完成态）。
        ok = true
        why = `no N/M fraction in op row (buttons=${JSON.stringify(mixedPick.opButtons)})`
      }
      check('A/BUG-184: 混合组操作行分数分母 == 需要落盘条目数（非 photo 数），且 N≤M', ok, why, 'A2')
    }

    // ── 断言 B（BUG-185 上半）：纯图组操作行必须有「加入媒体库」按钮 ────────
    const pureAll = all.filter((a) => a.vids === 0 && a.photos >= 2)
    console.log(
      `[album-action-row] pure-photo bubbles: ${JSON.stringify(pureAll.map((a) => ({ msgId: a.msgId, photos: a.photos, hasDone: a.hasDone, opText: a.opText })))}`,
    )

    // 为 B 选一个「尚未入库」的纯图组；为 C 选一个「已入库」的纯图组（优先零写入）。
    let pureNotLib = null
    let pureLib = null
    for (const a of pureAll) {
      const msgIds = await page.evaluate(
        (gid) => {
          // 无法从 DOM 直接拿到组内全部 messageId —— 用相册网格里每个瓦片的 data-message-id
          const grid = [...document.querySelectorAll('[data-testid="album-grid"]')].find((g) =>
            (g.parentElement && g.parentElement.innerText || '').includes(gid),
          )
          if (!grid) return []
          return [...grid.querySelectorAll('button[data-message-id]')].map((b) =>
            Number(b.getAttribute('data-message-id')),
          )
        },
        a.msgId,
      )
      const lib = await groupInLibrary(chatId, msgIds)
      const rec = { ...a, msgIds, libIds: lib.ids, inLibrary: lib.all }
      if (!rec.inLibrary && !pureNotLib) pureNotLib = rec
      if (rec.inLibrary && !pureLib && !hasProgress(rec)) pureLib = rec
    }
    console.log(
      `[album-action-row] pureNotLib=${pureNotLib ? pureNotLib.msgId : 'none'} pureLib=${pureLib ? pureLib.msgId : 'none'}`,
    )

    check(
      'B/BUG-185: 存在「尚未入库」的纯图相册（用于验证按钮可达）',
      !!pureNotLib,
      pureNotLib
        ? `msgId=${pureNotLib.msgId} photos=${pureNotLib.photos} msgIds=${JSON.stringify(pureNotLib.msgIds)}`
        : 'no not-in-library pure-photo album found in feed',
      'B1',
    )
    if (pureNotLib) {
      const btn = pureNotLib.opButtons.find((t) => ADD_LABELS.has(t))
      console.log(
        `[album-action-row] PURE(notlib) ${pureNotLib.msgId}: opText="${pureNotLib.opText}" ` +
          `buttons=${JSON.stringify(pureNotLib.opButtons)} hasDone=${pureNotLib.hasDone} hasOpen=${pureNotLib.hasOpen}`,
      )
      check(
        'B/BUG-185: 未入库纯图相册操作行存在可点击「加入媒体库」按钮（修复前整行为 null）',
        !!btn && !pureNotLib.hasDone,
        `msgId=${pureNotLib.msgId} addBtn=${JSON.stringify(btn)} buttons=${JSON.stringify(pureNotLib.opButtons)}`,
        'B2',
      )
    }

    // ── 断言 C（BUG-185 下半）：入库后必须出现 album-done + album-open ──────
    let pureDone = pureLib
    let wrote = false
    if (!pureDone && pureNotLib) {
      // 授权写入：把该纯图组两张图登记进库（= UI「加入媒体库」的同一端点，新增、幂等、不删数据）。
      const reg = await registerPhotos(chatId, pureNotLib.msgIds)
      wrote = true
      console.log(
        `[album-action-row] WRITE(加入媒体库): POST /api/media/items refs=${JSON.stringify(
          pureNotLib.msgIds.map((m) => `${chatId}:${m}`),
        )} -> status=${reg.status} body=${JSON.stringify(reg.json)}`,
      )
      // 重新加载页面，让 photoLibRefs 重新探测 → groupInLibrary=true → allDone。
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="nav-tg"]')
        if (el) el.click()
      })
      await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
        timeout: 20000,
      })
      await delay(4000)
      const seen2 = await collectAlbums(page, 10, (s) => s.has(pureNotLib.msgId))
      pureDone = seen2.get(pureNotLib.msgId) || pureNotLib
    }
    check(
      'C/BUG-185: 存在「已入库」的纯图相册（用于验证完成态出口）',
      !!pureDone,
      pureDone
        ? `msgId=${pureDone.msgId} photos=${pureDone.photos} (write=${wrote})`
        : 'no in-library pure-photo album available',
      'C0',
    )
    if (pureDone) {
      console.log(
        `[album-action-row] PURE(done) ${pureDone.msgId}: opText="${pureDone.opText}" ` +
          `hasDone=${pureDone.hasDone} hasOpen=${pureDone.hasOpen} doneText=${JSON.stringify(pureDone.doneText)} openText=${JSON.stringify(pureDone.openText)}`,
      )
      check(
        'C/BUG-185: 已入库纯图相册操作行渲染 [album-done] 与 [album-open]（不再落 null）',
        pureDone.hasDone && pureDone.hasOpen,
        `msgId=${pureDone.msgId} hasDone=${pureDone.hasDone} hasOpen=${pureDone.hasOpen} opText="${pureDone.opText}"`,
        'C1',
      )
      check(
        'C/BUG-185: 完成态文案取自 i18n（已入库/已缓存）',
        DONE_LABELS.has(pureDone.doneText),
        `doneText=${JSON.stringify(pureDone.doneText)}`,
        'C2',
      )
      // album-open 可点击 → 打开预览/播放层（media-viewer）。
      const clicked = await page.evaluate((mid) => {
        for (const g of document.querySelectorAll('[data-testid="album-grid"]')) {
          const card = g.parentElement
          if (card && card.innerText.includes(mid)) {
            const b = card.querySelector('[data-testid="album-open"]')
            if (b) {
              b.click()
              return true
            }
          }
        }
        return false
      }, pureDone.msgId)
      await delay(1600)
      const viewerOpen = await page.evaluate(
        () => !!document.querySelector('[data-testid="media-viewer"]'),
      )
      await shot(page, '02-album-open-viewer.png')
      console.log(
        `[album-action-row] album-open(${pureDone.msgId}) clicked=${clicked} media-viewer=${viewerOpen} openText=${JSON.stringify(pureDone.openText)}`,
      )
      check(
        'C/BUG-185: [album-open] 可点击并打开预览/播放层（media-viewer）',
        clicked && viewerOpen,
        `clicked=${clicked} viewer=${viewerOpen}`,
        'C3',
      )
    }

    // ── 页面健康（白屏是最核心的失败模式，不当环境问题糊过去） ──────────────
    const pageErrs = page.pageErrors().slice(0, 5)
    const consoleErrs = page.consoleErrors().filter((e) => !/favicon\.ico/.test(e)).slice(0, 5)
    if (pageErrs.length) console.log('[album-action-row] page errors:', JSON.stringify(pageErrs))
    check('页面无未捕获异常（非白屏）', pageErrs.length === 0, pageErrs.length ? JSON.stringify(pageErrs) : 'none')
    check('页面无 console.error（favicon 除外）', consoleErrs.length === 0, consoleErrs.length ? JSON.stringify(consoleErrs) : 'none')

    // ── 反向证伪还原（在 dump 之前做，好让「还原」本身也进断言清单） ──────────
    if (REVERT_ON && originalSource != null) {
      restoreSource(originalSource)
      const nowText = fs.readFileSync(TG_PANEL_SRC, 'utf8')
      const hashAfter = sha256(nowText)
      const identical = hashAfter === sourceHashBefore
      console.log(
        `[album-action-row] revert restore: sha256 before=${sourceHashBefore} after=${hashAfter} byte-identical=${identical}`,
      )
      check(
        '反向证伪还原: TgPanel.tsx 逐字节还原（sha256 前后一致）',
        identical,
        `sha256 ${sourceHashBefore} -> ${hashAfter}`,
      )
      originalSource = null
    }

    console.log('[album-action-row] screenshots ->', OUT_DIR)
    dumpResults()

    const failed = results.filter((r) => !r.ok).length
    if (REVERT_ON) {
      // 反向证伪的核心断言：184 看 A2（分数分母同源），185 看 C1（完成态渲染）。
      const coreId = REVERT_184 ? 'A2' : 'C1'
      const core = results.find((r) => r.id === coreId)
      const coreFailed = core && !core.ok
      if (coreFailed) {
        console.log(
          `[album-action-row] FALSIFICATION CONFIRMED: 注回修复前形态后核心断言转红（${core.name}）`,
        )
      } else {
        console.log(
          `[album-action-row] FALSIFICATION FAILED: 注回修复前形态后核心断言（${coreId}）仍绿 —— 本探针是假绿，需修断言`,
        )
        process.exitCode = 4
      }
    }
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    if (REVERT_ON && originalSource != null) {
      restoreSource(originalSource)
      console.log('[album-action-row] revert: source file restored (finally)')
    }
  }
}

main().catch((e) => {
  console.error('[album-action-row] ERROR', (e && e.message) || e)
  process.exit(1)
})
