#!/usr/bin/env node
'use strict'

/**
 * BUG-210 / BUG-211 真实 UI 验收：剧集内页「播放本集」升级为唯一实心主按钮 +
 * 来源区按条件门控 + 移除按钮文案改写（commit 384db56）。
 *
 * ## 缺陷回顾（用户反馈：剧集内页主任务被降格）
 *
 * `SeriesDetail.tsx`（右栏 = 当前单集显示与编辑）此前把 `episode-play` 埋在右栏**最底部**
 * 「操作」区，与三个描边按钮同尺寸并排 —— 播放是高频主任务，却被降格为并列操作。
 * 同时「来源」区在**无备用源**时仍占位渲染（一个空壳信息板），移除按钮的可见文案
 * 用的是 `media.remove`（「移出资料库」），与它真实语义（只摘关联、内容留在库）不符。
 *
 * ## 本次修复的两条断言
 *
 * **BUG-210**：`episode-play` 上移到**本集图组 Deck 之后、本集介绍之前**，渲染为
 *   **独占一行整行宽**的实心主按钮（`h-9 w-full gap-1.5 text-[13px]`，默认 variant =
 *   实心 accent）；来源区整块用 `(cur.sources ?? []).length > 0` 门控（无备用源时该块
 *   在 DOM 中**完全不存在**，非 hidden）。
 * **BUG-211**：结构性操作里的移除按钮（`data-testid="episode-remove"`）可见文案由
 *   `media.remove`（「移出资料库」）改为 `media.episode.removeFromSeries`
 *   （「从剧集中移除（内容保留在资料库）」）。
 *
 * ## 判据（对**真实渲染的 DOM**，逐条打印实测值）
 *
 *   A 唯一性：`[data-testid="episode-play"]` 全文档**恰好 1 个**（移动而非复制）。
 *   B 位置（**文档序**，非坐标）：`episode-play` 晚于 `episode-focus-title`，
 *     且早于 `episode-focus-desc`（本集介绍）与 `episode-remove`（结构性操作）。
 *     用 `querySelectorAll('*')` 在右栏内的 index 比较，不用 bounding box 猜。
 *   C 视觉主按钮：读 `getComputedStyle` —— 宽度 ≈ 父容器内容宽度（`w-full` 生效，
 *     容差 ±2px），高度 ≥ 32px（`h-9` = 36px）。**不读 className**（Tailwind v4 层序
 *     会静默吃掉追加类，className 存在 ≠ 样式生效）。
 *   D 来源区门控：选一部**无备用源**的剧集，断言右栏内来源区**不存在**
 *     （`episode-source-switch`/`episode-source-detach` 计数 0，且区块标题「来源」
 *     文本零命中）；再**临时**经后端 API 给同一集挂一个备用源，断言来源区**出现**，
 *     证明门控是「按条件」而非「被删了」；随后**摘除并自证还原**。
 *   211 移除按钮 `textContent` 必须含「从剧集中移除」，且**不得**等于「移出资料库」。
 *   E 全程收集 `pageerror` / console error，报告是否有页面错误。
 *
 * ## 反向证伪（验收的验收，必须做且必须自动还原 + 自证）
 *
 *   脚本**自动**把播放按钮改回缺陷态（替换 `className`），重跑同一断言 —— 断言 C
 *   （宽度/高度）**必须 FAIL**。还原后：改动前 `sha256` 与还原后 `sha256` **相等**，
 *   且 `git diff --name-only` **不含**该文件。任一步失败 → 立即 `git checkout --`
 *   恢复原状并报告。**绝不改断言去迎合代码。**
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
 *   - 本集介绍非空且 ≠ 剧集介绍 ⇒ `episode-focus-desc` 会渲染（位置断言需要它）；
 *   - `sources` 为空 ⇒ 天然是「无备用源」夹具（D 的负例）；
 *   - `hasBytes=true` ⇒ 播放按钮可用（非 disabled，视觉断言有效）。
 */
const SERIES_ID = Number(process.env.PROBE_SERIES || 3)
const EPISODE_ID = Number(process.env.PROBE_EPISODE || 131)
/** 挂作备用源的现成视频条目（series 3 内另一集的 item，验证后立即摘除） */
const SOURCE_ITEM_ID = Number(process.env.PROBE_SOURCE_ITEM || 19)

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TARGET_REL = 'tauri-shell/src/components/media/SeriesDetail.tsx'
const TARGET_FILE = path.join(REPO_ROOT, TARGET_REL)

/** 缺陷态注入锚点 = 修复后的整行宽主按钮 className */
const PLAY_CLASS_OK = 'className="h-9 w-full gap-1.5 text-[13px]"'
/**
 * 反向证伪注入（**必须可靠地翻转断言 C**）：
 * 把 `w-full` 换成 `w-1/2`（唯一宽度类，不会与 sizeClasses 里的类争层序），
 * 宽度应变为父内容宽的一半 ⇒ 断言 C 必然 FAIL。
 * 注：不采用任务书示例里的 `h-7 ...`（去掉 w-full 后 flex 列的 stretch 仍会撑满宽度，
 * 而 h-7 会被 Button 的 size 默认类 `h-9` 按 Tailwind 层序静默吃掉）——那会注入
 * 一个**不可证伪**的假缺陷。此处用真正改变渲染结果的注入。
 */
const PLAY_CLASS_DEFECT = 'className="h-9 w-1/2 gap-1.5 text-[13px]"'
/** 任务书示例注入（信息性：验证 Tailwind 层序是否吃掉追加类，不参与硬断言） */
const PLAY_CLASS_DEFECT_TASK = 'className="h-7 px-2.5 text-[11px]"'

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
  await waitTestidSoft(page, 'nav-media', 15000)
  await clickTestid(page, 'nav-media')
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
 * 全部按 **DOM 文档序**（`querySelectorAll('*')` 的 index）而非坐标判定位置。
 */
const GATHER = () => {
  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))

  const title = $('[data-testid="episode-focus-title"]')
  const pane = title ? title.closest('section') : null

  const playDoc = $$('[data-testid="episode-play"]')
  const playPane = pane ? $$('[data-testid="episode-play"]', pane) : []
  const play = playPane[0] || null
  const desc = pane ? $('[data-testid="episode-focus-desc"]', pane) : null
  const remove = pane ? $('[data-testid="episode-remove"]', pane) : null

  let order = null
  if (pane) {
    const all = $$('*', pane)
    const idx = (el) => (el ? all.indexOf(el) : -1)
    order = { title: idx(title), play: idx(play), desc: idx(desc), remove: idx(remove) }
  }

  let visual = null
  if (play) {
    const cs = getComputedStyle(play)
    const parent = play.parentElement
    const pcs = getComputedStyle(parent)
    const pr = parent.getBoundingClientRect()
    const padL = parseFloat(pcs.paddingLeft) || 0
    const padR = parseFloat(pcs.paddingRight) || 0
    const bL = parseFloat(pcs.borderLeftWidth) || 0
    const bR = parseFloat(pcs.borderRightWidth) || 0
    const contentW = pr.width - padL - padR - bL - bR
    const r = play.getBoundingClientRect()
    visual = {
      btnW: Math.round(r.width * 100) / 100,
      btnH: Math.round(r.height * 100) / 100,
      parentContentW: Math.round(contentW * 100) / 100,
      parentTag: parent.tagName,
      parentTestid: parent.getAttribute('data-testid'),
      bg: cs.backgroundColor,
      display: cs.display,
      disabled: !!play.disabled,
      text: (play.textContent || '').trim(),
    }
  }

  const paneText = pane ? pane.innerText || '' : ''
  return {
    playCountDoc: playDoc.length,
    playCountPane: playPane.length,
    order,
    visual,
    hasTitle: !!title,
    hasDesc: !!desc,
    hasRemove: !!remove,
    sourceSwitchCount: pane ? $$('[data-testid="episode-source-switch"]', pane).length : 0,
    sourceDetachCount: pane ? $$('[data-testid="episode-source-detach"]', pane).length : 0,
    sourcesTitleHits: (paneText.match(/来源/g) || []).length,
    removeText: remove ? (remove.textContent || '').trim() : null,
    removeTitle: remove ? remove.getAttribute('title') : null,
    focusTitleText: title ? (title.textContent || '').trim() : null,
  }
}

const gather = (page) => page.evaluate(GATHER)

/** 断言 C（视觉主按钮）的纯函数判定 */
function evalVisual(g) {
  const v = g.visual
  if (!v) return { pass: false, widthOk: false, heightOk: false, detail: 'no episode-play' }
  const widthOk = Math.abs(v.btnW - v.parentContentW) <= 2
  const heightOk = v.btnH >= 32
  return {
    pass: widthOk && heightOk,
    widthOk,
    heightOk,
    detail: `btnW=${v.btnW} parentContentW=${v.parentContentW} (Δ=${Math.round(Math.abs(v.btnW - v.parentContentW) * 100) / 100}) btnH=${v.btnH} bg=${v.bg} disabled=${v.disabled}`,
  }
}

/** 断言 B（文档序）的纯函数判定 */
function evalOrder(g) {
  const o = g.order
  if (!o) return { pass: false, detail: 'no right pane / title' }
  const afterTitle = o.title >= 0 && o.play > o.title
  const beforeDesc = o.desc < 0 ? null : o.play < o.desc
  const beforeRemove = o.remove < 0 ? null : o.play < o.remove
  const pass = afterTitle && beforeDesc !== false && beforeRemove !== false
  return {
    pass,
    afterTitle,
    beforeDesc,
    beforeRemove,
    detail: `idx(title=${o.title} play=${o.play} desc=${o.desc} remove=${o.remove})`,
  }
}

// ───────────────────────────── 反向证伪 ─────────────────────────────

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

function gitDiffNames() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'diff', '--name-only'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (_e) {
    return []
  }
}

/**
 * 注入缺陷态 → 重跑断言 C → 还原 → 自证未污染工作区。
 * @returns {Promise<object>} { injectedVisual, defectFailsCheckC, restored, shaMatch, gitClean, forcedRestore }
 */
async function reverseFalsify(page, fromStr, toStr, label) {
  const orig = fs.readFileSync(TARGET_FILE, 'utf8')
  const origHash = sha256(orig)
  const result = { label, defectFailsCheckC: false, restored: false, shaMatch: false, gitClean: false, forcedRestore: false }
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
    result.injectedVisual = g.visual
    const vis = evalVisual(g)
    result.defectFailsCheckC = !vis.pass
    result.defectDetail = vis.detail
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
    result.gitClean = !gitDiffNames().includes(TARGET_REL)
    if (!result.restored) {
      // 二次兜底：git 强制还原
      try {
        execFileSync('git', ['-C', REPO_ROOT, 'checkout', '--', TARGET_REL], { stdio: 'ignore' })
        result.forcedRestore = true
        result.restored = fs.readFileSync(TARGET_FILE, 'utf8') === orig
        result.gitClean = !gitDiffNames().includes(TARGET_REL)
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
      await clickTestid(page, 'nav-media')
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

    // ───────────── BUG-210-A 唯一性 ─────────────
    check('210-A: exactly one [episode-play] in document', g.playCountDoc === 1, `count=${g.playCountDoc}`)
    check('210-A: exactly one [episode-play] in right pane', g.playCountPane === 1, `count=${g.playCountPane}`)

    // ───────────── BUG-210-B 文档序位置 ─────────────
    const ord = evalOrder(g)
    check('210-B: play AFTER title', ord.afterTitle, ord.detail)
    check('210-B: play BEFORE episode description (episode-focus-desc)', ord.beforeDesc === true, `beforeDesc=${ord.beforeDesc} ${ord.detail}`)
    check('210-B: play BEFORE structural actions (episode-remove)', ord.beforeRemove === true, `beforeRemove=${ord.beforeRemove} ${ord.detail}`)

    // ───────────── BUG-210-C 视觉主按钮 ─────────────
    const vis = evalVisual(g)
    check('210-C: play width ≈ parent content width (w-full, ±2px)', vis.widthOk, vis.detail)
    check('210-C: play height ≥ 32px (h-9=36px)', vis.heightOk, vis.detail)

    // ───────────── BUG-211 移除按钮文案 ─────────────
    const rm = g.removeText || ''
    check('211: episode-remove text contains 「从剧集中移除」', rm.includes('从剧集中移除'), `text=${JSON.stringify(rm)}`)
    check('211: episode-remove text is NOT 「移出资料库」', rm !== '移出资料库', `text=${JSON.stringify(rm)}`)

    // ───────────── BUG-210-D 来源区门控（负例：无备用源） ─────────────
    check('210-D(neg): sources block ABSENT for episode with 0 sources', g.sourceSwitchCount === 0 && g.sourceDetachCount === 0 && g.sourcesTitleHits === 0,
      `switch=${g.sourceSwitchCount} detach=${g.sourceDetachCount} 来源hits=${g.sourcesTitleHits}`)

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
        check('210-D(pos): sources block PRESENT once a backup source exists', gp.sourceSwitchCount >= 1 && gp.sourcesTitleHits >= 1,
          `switch=${gp.sourceSwitchCount} detach=${gp.sourceDetachCount} 来源hits=${gp.sourcesTitleHits}`)
      } finally {
        const det = await httpJson('DELETE', `${TG}/api/media/episodes/${EPISODE_ID}/sources/${SOURCE_ITEM_ID}`)
        info('detach source', `DELETE -> status=${det.status} body=${JSON.stringify(det.json)}`)
      }
      // 还原自证：来源区重新消失
      await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
      const gr = await gather(page)
      const restoredSources = await readEpisodeSources(SERIES_ID, EPISODE_ID)
      check('210-D: source fixture restored (block absent again)', gr.sourceSwitchCount === 0 && gr.sourcesTitleHits === 0,
        `switch=${gr.sourceSwitchCount} 来源hits=${gr.sourcesTitleHits} sources=${JSON.stringify(restoredSources)}`)
    } else {
      check('210-D(pos): sources block PRESENT when a backup source exists', false,
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
    const rf = await reverseFalsify(page, PLAY_CLASS_OK, PLAY_CLASS_DEFECT, 'w-1/2 defect')
    info('injected defect visual', JSON.stringify(rf.injectedVisual))
    check('RF: injected defect (w-1/2) makes check C FAIL', rf.defectFailsCheckC === true, `detail=${rf.defectDetail} err=${rf.error || '-'}`)
    check('RF: file restored byte-identical (sha256 match)', rf.restored === true && rf.shaMatch === true, `restored=${rf.restored} shaMatch=${rf.shaMatch}`)
    check('RF: target file NOT in `git diff --name-only`', rf.gitClean === true, `gitClean=${rf.gitClean} forcedRestore=${rf.forcedRestore}`)

    // 信息性：任务书示例注入是否被 Tailwind 层序吃掉（不参与硬断言）
    const rfTask = await reverseFalsify(page, PLAY_CLASS_OK, PLAY_CLASS_DEFECT_TASK, 'task-suggested h-7 defect (informational)')
    info('task-suggested injection result', `visual=${JSON.stringify(rfTask.injectedVisual)} failsCheckC=${rfTask.defectFailsCheckC} restored=${rfTask.restored}`)

    // 还原后再跑一次主断言，证明还原后的真实代码仍绿（防「还原成缺陷态」）
    await openSeriesFocus(page, SERIES_ID, EPISODE_ID)
    const gFinal = await gather(page)
    const visFinal = evalVisual(gFinal)
    check('RF: after restore, check C passes again on real code', visFinal.pass, visFinal.detail)

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
