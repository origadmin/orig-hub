#!/usr/bin/env node
'use strict'

/**
 * BUG-369 真实 UI 验收：剧集详情页的**播放入口归左栏**。
 *
 * ## 为什么这个脚本被整篇改写（第五次复报的结构性根因）
 *
 * 本脚本原为 BUG-210/211 而写，判据是：
 *   - `210-A`：全文档 `[data-testid="episode-play"]` **恰好 1 个**；
 *   - `210-B`：它必须**晚于**标题、**早于**本集介绍；
 *   - `210-C`：它的宽度 **≈ 父容器内容宽**（`w-full`，±2px）、高度 ≥ 32px。
 *
 * 这三条把「右栏一颗横贯整行、贴左边缘的实心绿条」钉成了**正确形态**。于是：
 *   - 用户 2026-10-22 裁定「现在右边播放是错误,左边缺少播放也是错误」；
 *   - BUG-369 只补了左栏、留下右栏那颗，本脚本全绿 ⇒ 交付时看起来「已修」；
 *   - 用户第五次复报「播放按钮位置不对」。
 *
 * 教训：**判据与诉求方向相反时，实现改多少次都不会对。** 所以本次先翻转判据
 * （把旧形态断言改成「必须不存在」），再让实现去满足它。
 *
 * ## 目标形态
 *
 *   - 右栏（`episode-focus-title` 所在的 `<section>`）职责 = 「这一集是什么」，
 *     只放展示 + 管理动作，**不含任何播放入口**。
 *   - 播放归左栏：剧集级 `series-play-all`（播放全部）+ **每条分集行尾**
 *     `episode-row-play`（从本集开始播放 / 照片集=查看大图）。
 *   - 分集行本身是 `<button data-testid="episode-pick">`，HTML 不允许嵌套 button
 *     ⇒ 行内入口是 `span[role=button]` + `stopPropagation`。
 *
 * ## 判据（对**真实渲染的 DOM**，逐条打印实测值）
 *
 *   376-A 旧形态必须消失：`[data-testid="episode-play"]` 在**全文档**与**右栏**内
 *         计数均为 0。
 *   376-D 换形态也不能长回来：右栏内**任何**可点击元素（`button` / `[role=button]`
 *         / `a`）的可见文案或 `title`/`aria-label` 都**不得**含「播放」/「play」。
 *         按**语义**扫而非按 testid 扫 —— 只盯 testid 的话，改个名字就能复活。
 *   376-B 左栏有入口：`[data-testid="episode-row-play"]` 计数 ≥ 1，且**当前聚焦
 *         的那一集**（`data-episode-id` = 夹具集）必须有。
 *   376-C 它在行内、且不是满宽条：`closest('[data-testid="episode-pick"]')` 非空；
 *         宽度 / 行宽 ≤ 0.35（图标尺寸，不是横贯整行的条）；命中区 ≥ 24×24。
 *   211   移除按钮文案（BUG-211 原样保留）。
 *   210-D 来源区**两层门控**（按 BUG-265 的契约，不是 BUG-210 的旧形态）：信息段
 *         （`episode-source-info` + 标题「来源」）恒渲染；控件段（切换 / 摘除）无备用
 *         源时不进 DOM。临时挂一个 ⇒ 控件出现；摘除 ⇒ 控件再次消失、信息段仍在。
 *         ★ 旧写法用 `pane.innerText.match(/来源/g)` 数命中，会把溯源区字段标签
 *         「来源原文：x」也算进去 ⇒ 假红；已改为「整段文字恰好等于『来源』」。
 *   E     全程收集 `pageerror` / console error。
 *
 * ## 反向证伪（验收的验收，必须做且必须自动还原 + 自证）
 *
 *   注入：把行内入口的 `data-testid="episode-row-play"` 改成 `"episode-play"`
 *   （= 旧形态复活）⇒ 376-A **必须 FAIL**。
 *   还原后：文件 `sha256` 与注入前**相等**，且 `git diff -- <该文件>` 的**文本**
 *   与注入前逐字相同。
 *     ★ 这里不比对「文件是否出现在 `git diff --name-only` 里」—— 修复未提交时
 *     该文件**本来就在** diff 中，那样写会在本地改完就永远红（旧脚本的洞）。
 *
 * Usage:  node verify/verify_play_primary.cjs            # 正常跑判据
 *         PROBE=1 node verify/verify_play_primary.cjs    # 只 dump 页面 testid
 * Env:    APP_PORT(默认5180) TG_URL(默认 http://127.0.0.1:19787)
 *         PROBE_SERIES(默认3) PROBE_EPISODE(默认131) ORIG_VERIFY_OUT
 * Exit:   0 = 全通过；1 = 环境失败；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const PROBE = process.env.PROBE === '1'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-play-primary'),
)

/**
 * 验收夹具（series 3 / ep 131 = S1E1）—— 经只读 API 实测：
 *   - 本集介绍非空且 ≠ 剧集介绍 ⇒ `episode-focus-desc` 会渲染；
 *   - `sources` 为空 ⇒ 天然是「无备用源」夹具（210-D 的负例）；
 *   - `hasBytes=true` ⇒ 行内播放入口会渲染（不是 disabled / 不是不渲染）。
 */
const SERIES_ID = Number(process.env.PROBE_SERIES || 3)
const EPISODE_ID = Number(process.env.PROBE_EPISODE || 131)
/** 挂作备用源的现成视频条目（验证后立即摘除） */
const SOURCE_ITEM_ID = Number(process.env.PROBE_SOURCE_ITEM || 19)

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TARGET_REL = 'tauri-shell/src/components/media/SeriesDetail.tsx'
const TARGET_FILE = path.join(REPO_ROOT, TARGET_REL)

/**
 * 反向证伪锚点：行内播放入口的 testid。
 * 全仓唯一（左栏每条分集行共用同一个 testid，但源码里只出现**一次**）。
 */
const ROW_PLAY_ANCHOR = 'data-testid="episode-row-play"'
/** 缺陷态 = 把名字换回旧形态；376-A 必须因此 FAIL */
const LEGACY_PLAY_ANCHOR = 'data-testid="episode-play"'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
function info(name, detail) {
  console.log(`[verify] INFO - ${name}${detail ? ' :: ' + detail : ''}`)
}

// ───────────────────────────── HTTP（仅环回，忽略代理） ─────────────────────────────

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) })
        } catch (_e) {
          resolve({ status: res.statusCode, json: null })
        }
      })
    })
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null })
    })
  })
}

function httpJson(method, url, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const data = payload ? JSON.stringify(payload) : null
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(body)
          } catch (_e) {}
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null })
    })
    if (data) req.write(data)
    req.end()
  })
}

/** 读某集当前的 sources 数组（只读详情接口） */
async function readEpisodeSources(seriesId, episodeId) {
  const { json } = await httpGetJson(`${TG}/api/media/series/${seriesId}`)
  if (!json || !Array.isArray(json.episodes)) return null
  const ep = json.episodes.find((e) => e.id === episodeId)
  if (!ep) return null
  return ep.sources ?? []
}

// ───────────────────────────── 页面辅助 ─────────────────────────────

async function clickTestid(page, tid) {
  const ok = await page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, tid)
  if (!ok) throw new Error(`clickTestid: ${tid} not found`)
}

async function waitTestidSoft(page, tid, timeout = 8000) {
  try {
    await page.waitForFunction((t) => !!document.querySelector(`[data-testid="${t}"]`), { timeout, args: [tid] })
    return true
  } catch (_e) {
    return false
  }
}

async function setViewport(page, width, height) {
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
  await delay(650)
}

/**
 * 冷导航打开「媒体库 → series 3 详情 → 聚焦 ep 131」。
 * 每次强制 `goto` 冷启动（Vite HMR 后的旧 DOM 不可信），并自证落到了目标剧集/集。
 */
async function openSeriesFocus(page, seriesId, episodeId) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
  await waitTestidSoft(page, 'nav-child-lib-series', 15000)
  await clickTestid(page, 'nav-child-lib-series')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, {
    timeout: 20000,
  })
  await delay(700)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, seriesId)
  if (!clicked) throw new Error(`series-card data-series-id=${seriesId} not found`)
  const titleUp = await waitTestidSoft(page, 'episode-focus-title', 15000)
  if (!titleUp) throw new Error(`series ${seriesId}: episode-focus-title never rendered`)
  await delay(500)
  const picked = await page.evaluate((eid) => {
    const b = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)
    if (!b) return false
    b.scrollIntoView({ block: 'center' })
    b.click()
    return true
  }, episodeId)
  if (!picked) throw new Error(`episode-pick data-episode-id=${episodeId} not found`)
  await delay(900)
}

/**
 * 页面内：一次性采集全部断言所需事实（唯一真源，避免多次求值期间 DOM 漂移）。
 * `focusEpisodeId` 必须由调用方传入 —— `page.evaluate` 序列化函数会丢掉 Node 侧作用域。
 */
const GATHER = (focusEpisodeId) => {
  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 }
  }

  const title = $('[data-testid="episode-focus-title"]')
  const pane = title ? title.closest('section') : null

  // ── 旧形态（右栏满宽主按钮）：必须为 0 ──
  const legacyDoc = $$('[data-testid="episode-play"]')
  const legacyPane = pane ? $$('[data-testid="episode-play"]', pane) : []

  // ── 新形态：左栏分集行尾的播放入口 ──
  const rowPlayEls = $$('[data-testid="episode-row-play"]')
  const curEl =
    rowPlayEls.find((el) => Number(el.getAttribute('data-episode-id')) === Number(focusEpisodeId)) || null

  let rowPlay = null
  if (curEl) {
    const r = rectOf(curEl)
    const host = curEl.closest('[data-testid="episode-pick"]')
    const hostW = host ? rectOf(host).w : -1
    const cs = getComputedStyle(curEl)
    rowPlay = {
      w: r.w,
      h: r.h,
      inPickRow: !!host,
      pickRowW: hostW,
      widthRatioToRow: hostW > 0 ? Math.round((r.w / hostW) * 1000) / 1000 : -1,
      kind: curEl.getAttribute('data-kind'),
      title: curEl.getAttribute('title'),
      text: (curEl.textContent || '').trim(),
      cursor: cs.cursor,
      display: cs.display,
    }
  }

  // ── 376-D：右栏内任何「播放语义」的可点击元素（按文案/title 扫，不只 testid） ──
  const paneContentW = pane
    ? (() => {
        const pcs = getComputedStyle(pane)
        const pr = pane.getBoundingClientRect()
        const n = (v) => parseFloat(v) || 0
        return (
          Math.round(
            (pr.width - n(pcs.paddingLeft) - n(pcs.paddingRight) - n(pcs.borderLeftWidth) - n(pcs.borderRightWidth)) *
              100,
          ) / 100
        )
      })()
    : -1
  const playish = (pane ? $$('button, [role="button"], a', pane) : [])
    .map((el) => {
      const txt = [
        el.textContent || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
      ]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!/播放|play/i.test(txt)) return null
      const r = rectOf(el)
      return {
        testid: el.getAttribute('data-testid'),
        text: txt.slice(0, 60),
        w: r.w,
        h: r.h,
        fullWidth: paneContentW > 0 && r.w >= paneContentW * 0.8,
      }
    })
    .filter(Boolean)

  // ── 照片集「查看大图」（夹具是视频集，通常不渲染 ⇒ 出现时只断言「不是满宽条」） ──
  const viewImageEl = pane ? $('[data-testid="episode-view-image"]', pane) : null
  const viewImage = viewImageEl
    ? { ...rectOf(viewImageEl), fullWidth: paneContentW > 0 && rectOf(viewImageEl).w >= paneContentW * 0.8 }
    : null

  const remove = pane ? $('[data-testid="episode-remove"]', pane) : null
  // 来源区**标题**的计数必须按「整段文字恰好等于『来源』」来数。
  // ★ 旧写法用 `pane.innerText.match(/来源/g)`，会把溯源区的字段标签
  //   `media.item.sourceTitle`（「来源原文：xxx」）也算成命中 ⇒ 无备用源时
  //   区块明明不存在，判据却报 1 处命中（实测假红）。字段标签 ≠ 区块标题。
  const sourcesTitleExact = pane
    ? $$('*', pane).filter((el) => (el.textContent || '').trim() === '来源').length
    : 0

  return {
    hasTitle: !!title,
    focusTitleText: title ? (title.textContent || '').trim() : null,
    paneContentW,
    legacyDoc: legacyDoc.length,
    legacyPane: legacyPane.length,
    rowPlayCount: rowPlayEls.length,
    rowPlay,
    playish,
    viewImage,
    removeText: remove ? (remove.textContent || '').trim() : null,
    sourceSwitchCount: pane ? $$('[data-testid="episode-source-switch"]', pane).length : 0,
    sourceDetachCount: pane ? $$('[data-testid="episode-source-detach"]', pane).length : 0,
    sourceInfoCount: pane ? $$('[data-testid="episode-source-info"]', pane).length : 0,
    sourcesTitleExact,
  }
}

const gather = (page) => page.evaluate(GATHER, EPISODE_ID)

/** 376-A + 376-D 的纯函数判定：右栏不得有任何播放入口（旧形态 / 换名字的形态） */
function evalNoPanePlay(g) {
  const pass = g.legacyDoc === 0 && g.legacyPane === 0 && g.playish.length === 0
  return {
    pass,
    legacyOk: g.legacyDoc === 0 && g.legacyPane === 0,
    semanticOk: g.playish.length === 0,
    detail: `legacyDoc=${g.legacyDoc} legacyPane=${g.legacyPane} playish=${JSON.stringify(g.playish)}`,
  }
}

/** 376-C 的纯函数判定：行内入口在行内、是图标而非满宽条、命中区够大 */
function evalRowPlay(g) {
  const r = g.rowPlay
  if (!r) return { pass: false, insideRow: false, notFullWidth: false, hitOk: false, detail: 'no [episode-row-play] on the focused episode row' }
  const insideRow = r.inPickRow === true
  const notFullWidth = r.widthRatioToRow > 0 && r.widthRatioToRow <= 0.35
  const hitOk = r.w >= 24 && r.h >= 24
  return {
    pass: insideRow && notFullWidth && hitOk,
    insideRow,
    notFullWidth,
    hitOk,
    detail: `inPickRow=${r.inPickRow} w=${r.w} h=${r.h} pickRowW=${r.pickRowW} ratio=${r.widthRatioToRow} kind=${r.kind} title=${JSON.stringify(r.title)}`,
  }
}

// ───────────────────────────── 反向证伪 ─────────────────────────────

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** 目标文件当前在工作区的 diff 文本（用于「还原后与注入前逐字相同」的自证） */
function gitDiffOf(rel) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'diff', '--', rel], { encoding: 'utf8' })
  } catch (_e) {
    return ''
  }
}

/**
 * 注入缺陷态 → 重跑 376-A/D → 还原 → 自证工作区未被污染。
 * @returns {Promise<object>} { defectFailsCheckA, restored, shaMatch, diffMatch, forcedRestore }
 */
async function reverseFalsify(page, fromStr, toStr, label) {
  const orig = fs.readFileSync(TARGET_FILE, 'utf8')
  const origHash = sha256(orig)
  const origDiff = gitDiffOf(TARGET_REL)
  const result = { label, defectFailsCheckA: false, restored: false, shaMatch: false, diffMatch: false, forcedRestore: false }
  if (!orig.includes(fromStr)) {
    result.error = `anchor not found: ${fromStr}`
    return result
  }
  try {
    const injected = orig.replace(fromStr, toStr)
    if (injected === orig) {
      result.error = 'injection produced no textual change'
      return result
    }
    fs.writeFileSync(TARGET_FILE, injected, 'utf8')
    await delay(1500) // 等 Vite 重新 transform
    await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
    const g = await gather(page)
    result.injected = { legacyDoc: g.legacyDoc, legacyPane: g.legacyPane, playish: g.playish }
    const ev = evalNoPanePlay(g)
    result.defectFailsCheckA = !ev.pass
    result.defectDetail = ev.detail
  } catch (e) {
    result.error = e && e.message ? e.message : String(e)
  } finally {
    // ★ 无论如何先还原
    try {
      fs.writeFileSync(TARGET_FILE, orig, 'utf8')
      await delay(1500)
    } catch (_e) {
      result.forcedRestore = true
    }
    const now = fs.readFileSync(TARGET_FILE, 'utf8')
    result.restored = now === orig
    result.shaMatch = sha256(now) === origHash
    result.diffMatch = gitDiffOf(TARGET_REL) === origDiff
    if (!result.restored) {
      // 二次兜底：git 强制还原
      try {
        execFileSync('git', ['-C', REPO_ROOT, 'checkout', '--', TARGET_REL], { stdio: 'ignore' })
        result.forcedRestore = true
        result.restored = fs.readFileSync(TARGET_FILE, 'utf8') === orig
        result.diffMatch = gitDiffOf(TARGET_REL) === origDiff
      } catch (_e) {
        result.forcedRestore = true
      }
    }
  }
  return result
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function shot(page, name) {
  const f = path.join(OUT, name)
  try {
    await page.screenshot(f, { fullPage: true })
    let size = -1
    try {
      size = fs.statSync(f).size
    } catch (_e) {}
    console.log(`[verify] shot ${name} -> ${f} (${size} bytes)`)
  } catch (e) {
    console.log(`[verify] shot ${name} FAILED: ${e && e.message}`)
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  let page
  try {
    page = await browser.newPage()
    await setViewport(page, 1440, 900)

    if (PROBE) {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
      await clickTestid(page, 'nav-child-lib-series')
      await delay(1500)
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[verify] PROBE testids:\n  ' + ids.join('\n  '))
      return
    }

    // 环境自检：后端可达 + 夹具与「无备用源」前提成立
    const preSources = await readEpisodeSources(SERIES_ID, EPISODE_ID)
    info('fixture pre-state', `series=${SERIES_ID} ep=${EPISODE_ID} sources=${JSON.stringify(preSources)}`)
    if (preSources == null) {
      console.error(`[verify] ENV FAIL: cannot read series ${SERIES_ID} / ep ${EPISODE_ID} from ${TG}`)
      process.exitCode = 1
      return
    }

    // ───────────── 打开真实页面 ─────────────
    await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
    await shot(page, 'A-series-detail.png')
    const g = await gather(page)
    info('gathered', JSON.stringify(g))

    // 自证扫的是活页面
    check('0: right pane + focus title rendered (live DOM)', g.hasTitle, `focusTitle=${JSON.stringify(g.focusTitleText)}`)

    // ───────────── BUG-369-A 旧形态必须消失 ─────────────
    const np = evalNoPanePlay(g)
    check('376-A: legacy [episode-play] count in document === 0', g.legacyDoc === 0, `count=${g.legacyDoc}`)
    check('376-A: legacy [episode-play] count in right pane === 0', g.legacyPane === 0, `count=${g.legacyPane}`)

    // ───────────── BUG-369-D 换形态也不能长回来（按语义扫） ─────────────
    check(
      '376-D: right pane has NO clickable element with play semantics (text/title)',
      np.semanticOk,
      `playish=${JSON.stringify(g.playish)} paneContentW=${g.paneContentW}`,
    )

    // ───────────── BUG-369-B 左栏有入口 ─────────────
    check('376-B: [episode-row-play] count in left column ≥ 1', g.rowPlayCount >= 1, `count=${g.rowPlayCount}`)
    check('376-B: focused episode row HAS [episode-row-play]', !!g.rowPlay, `episodeId=${EPISODE_ID} rowPlay=${JSON.stringify(g.rowPlay)}`)

    // ───────────── BUG-369-C 它在行内、且不是满宽条 ─────────────
    const rp = evalRowPlay(g)
    check('376-C: row play is INSIDE the [episode-pick] row', rp.insideRow, rp.detail)
    check('376-C: row play is an icon, NOT a full-width bar (width/row ≤ 0.35)', rp.notFullWidth, rp.detail)
    check('376-C: row play hit area ≥ 24×24', rp.hitOk, rp.detail)

    // ───────────── 照片集「查看大图」不得回到满宽条（渲染时才有意义） ─────────────
    check(
      '376-C(photo): episode-view-image, when rendered, is NOT full-width',
      g.viewImage === null || g.viewImage.fullWidth === false,
      `viewImage=${JSON.stringify(g.viewImage)}`,
    )

    // ───────────── BUG-211 移除按钮文案 ─────────────
    const rm = g.removeText || ''
    check('211: episode-remove text contains 「从剧集中移除」', rm.includes('从剧集中移除'), `text=${JSON.stringify(rm)}`)
    check('211: episode-remove text is NOT 「移出资料库」', rm !== '移出资料库', `text=${JSON.stringify(rm)}`)

    // ───────────── 来源区两层门控（BUG-210 → BUG-265 收窄） ─────────────
    // ★ 旧断言写的是「无备用源 ⇒ 整块不存在（标题零命中）」，那是 BUG-210 的形态；
    //   BUG-265 已明确定为**两层门控**（源码 `episode-source-info` 上方注释）：
    //     信息段（区块标题 + 当前播放来源行）**恒渲染** ——「正在从哪播」是信息；
    //     控件段（备用源列表 + 切换 / 摘除）无备用源时**不进 DOM**。
    //   ⇒ 判据按 BUG-265 的契约写，而不是按 BUG-210 的旧形态。
    check(
      '210-D(neg): info section ALWAYS present (BUG-265), controls ABSENT with 0 sources',
      g.sourceInfoCount === 1 && g.sourcesTitleExact >= 1 && g.sourceSwitchCount === 0 && g.sourceDetachCount === 0,
      `info=${g.sourceInfoCount} 来源标题=${g.sourcesTitleExact} switch=${g.sourceSwitchCount} detach=${g.sourceDetachCount}`,
    )

    // ───────────── BUG-210-D 来源区门控（正例：临时挂备用源 → 出现 → 摘除还原） ─────────────
    let positiveCovered = false
    const attach = await httpJson('POST', `${TG}/api/media/episodes/${EPISODE_ID}/sources`, { itemId: SOURCE_ITEM_ID })
    info('attach source', `POST /episodes/${EPISODE_ID}/sources itemId=${SOURCE_ITEM_ID} -> status=${attach.status} body=${JSON.stringify(attach.json)}`)
    if (attach.status === 200 && attach.json && attach.json.ok) {
      positiveCovered = true
      try {
        const afterAttach = await readEpisodeSources(SERIES_ID, EPISODE_ID)
        info('sources after attach', JSON.stringify(afterAttach))
        await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
        await shot(page, 'D-sources-present.png')
        const gp = await gather(page)
        check('210-D(pos): control section PRESENT once a backup source exists', gp.sourceSwitchCount >= 1 && gp.sourceDetachCount >= 1,
          `switch=${gp.sourceSwitchCount} detach=${gp.sourceDetachCount} info=${gp.sourceInfoCount}`)
      } finally {
        const det = await httpJson('DELETE', `${TG}/api/media/episodes/${EPISODE_ID}/sources/${SOURCE_ITEM_ID}`)
        info('detach source', `DELETE -> status=${det.status} body=${JSON.stringify(det.json)}`)
      }
      // 还原自证：控件段重新消失（信息段按 BUG-265 恒在）
      await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
      const gr = await gather(page)
      const restoredSources = await readEpisodeSources(SERIES_ID, EPISODE_ID)
      check('210-D: source fixture restored (controls absent again)', gr.sourceSwitchCount === 0 && gr.sourceDetachCount === 0 && gr.sourceInfoCount === 1,
        `switch=${gr.sourceSwitchCount} detach=${gr.sourceDetachCount} info=${gr.sourceInfoCount} sources=${JSON.stringify(restoredSources)}`)
    } else {
      check('210-D(pos): control section PRESENT when a backup source exists', false,
        `SKIP/UNCOVERED — could not attach a source via API (status=${attach.status}); positive branch NOT covered`)
    }
    info('positive branch covered', String(positiveCovered))

    // ───────────── 页面错误 ─────────────
    const pageErrs = page.pageErrors().slice(0, 10)
    const consoleErrs = page.consoleErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(pageErrs))
    console.log('[verify] CONSOLE_ERRORS:', JSON.stringify(consoleErrs))
    check('E: no uncaught page errors', pageErrs.length === 0, JSON.stringify(pageErrs))

    // ───────────── 反向证伪（必须 FAIL + 自动还原 + 自证） ─────────────
    console.log('\n[verify] ===== REVERSE FALSIFICATION =====')
    const rf = await reverseFalsify(page, ROW_PLAY_ANCHOR, LEGACY_PLAY_ANCHOR, 'legacy episode-play resurrected')
    info('injected defect facts', JSON.stringify(rf.injected))
    check('RF: resurrecting [episode-play] makes 376-A/D FAIL', rf.defectFailsCheckA === true, `detail=${rf.defectDetail} err=${rf.error || '-'}`)
    check('RF: file restored byte-identical (sha256 match)', rf.restored === true && rf.shaMatch === true, `restored=${rf.restored} shaMatch=${rf.shaMatch}`)
    check('RF: `git diff -- <target>` identical to pre-injection', rf.diffMatch === true, `diffMatch=${rf.diffMatch} forcedRestore=${rf.forcedRestore}`)

    // 还原后再跑一次主断言，证明还原后的真实代码仍绿（防「还原成缺陷态」）
    await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
    const gFinal = await gather(page)
    const npFinal = evalNoPanePlay(gFinal)
    check('RF: after restore, 376-A/D pass again on real code', npFinal.pass, npFinal.detail)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    if (page) {
      try {
        await shot(page, 'Z-final.png')
      } catch (_e) {}
    }
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
