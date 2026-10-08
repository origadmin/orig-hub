#!/usr/bin/env node
'use strict'

/**
 * BUG-183 真实 UI 验收：剧集内页补回「剧集介绍展示位」。
 *
 * ## 缺陷回顾（用户反馈：剧集内页看不到「剧集介绍」）
 *
 * 活的剧集内页 `SeriesDetail.tsx` **全文不读 `detail.description`** —— 剧集介绍字段在
 * 活实现里从未被渲染；全仓唯一的剧集介绍展示位（`series-description` / `series-desc-toggle`
 * / `series-desc-edit`）在 `SeriesHero.tsx`，而该组件**零 importer**（不可达）。
 * 重构迁移清单漏列了「剧集介绍」，却留下「能力零删减」的注释 —— 故按清单核对永远核不出来。
 *
 * ## 本次修复（commit 见档内「入库提交」）
 *
 * 在 `SeriesDetail.tsx` 左栏「标签之后、动作之前」补回剧集介绍块：非空恒渲染
 * `series-description`（数据源 `detail.description`），超行时给 `series-desc-toggle`
 * 展开/收起，并恒给 `series-desc-edit` 进 `SeriesEditPanel`；空态给可编辑空位（绝不
 * 用首集介绍 `cur.description` 兜底）。
 *
 * ## 判据（对**真实渲染的 DOM**，逐条打印实测值）
 *
 *   A 非空剧集：`[data-testid="series-description"]` 存在（恰好 1），其 `textContent`
 *     **等于**接口返回的剧集 `description`（去首尾空白比对），且**不等于**该剧集首集的
 *     `description`（防「分集介绍冒充剧集介绍」）。
 *   B 折叠：初始 `getComputedStyle(p).maxHeight` = `64px`；介绍超行时 `series-desc-toggle`
 *     出现，点击后 `maxHeight` 解除（不再是 64px）。
 *   C 位置（**文档序**，非坐标）：介绍块晚于标题、早于总览操作（`series-edit`）——
 *     即设计 V7「在标签之后、动作之前」。
 *   D 空态剧集：`series-description` **不存在**，`series-desc-edit` 存在，且页面文本
 *     **不含**该剧集首集的 `description`（首集介绍为空时该条为「空值自证」，仍断言）。
 *   E 编辑入口：点 `series-desc-edit` → `SeriesEditPanel`（`series-edit-panel`）出现。
 *   F 全程收集 `pageerror` / console error，报告是否有页面错误。
 *
 * ## 反向证伪（验收的验收，必须做且必须自动还原 + 自证）
 *
 *   脚本**自动**把介绍块条件改成 `false &&`（等价「撤掉展示位」），重跑断言 A —— 断言 A
 *   **必须 FAIL**。还原后：改动前 `sha256` 与还原后 `sha256` **相等**，且
 *   `git diff --name-only` **不含**该文件。任一步失败 → 立即 `git checkout --` 恢复并报告。
 *   **绝不改断言去迎合代码。**
 *
 * Usage:  node verify/verify_series_description_slot.cjs            # 正常跑判据
 *         PROBE=1 node verify/verify_series_description_slot.cjs    # 只 dump 页面 testid
 * Env:    APP_PORT(默认5180) TG_URL(默认 http://127.0.0.1:19787)
 *         PROBE_NONEMPTY(非空夹具剧集 id) PROBE_EMPTY(空态夹具剧集 id) ORIG_VERIFY_OUT
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
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-series-desc-slot'),
)

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TARGET_REL = 'tauri-shell/src/components/media/SeriesDetail.tsx'
const TARGET_FILE = path.join(REPO_ROOT, TARGET_REL)

/**
 * 反向证伪注入锚点 = 介绍块「非空分支」的条件表达式。
 * 改成 `false && …` 后非空分支不再渲染 ⇒ `series-description` 消失 ⇒ 断言 A 必然 FAIL。
 * 该串在修复后文件里**唯一**（另一处 `detail.description` 在测量 effect 的依赖数组里）。
 */
const ANCHOR_OK = '{detail.description ? ('
const ANCHOR_DEFECT = '{false && detail.description ? ('

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

/**
 * 动态挑夹具（不写死 id）：
 *   - 非空：取 `description` **最长**的剧集（既非空、又必超折叠阈值）；
 *   - 空态：取 `description` 为空/空白、且**至少 1 集**的剧集（须能进详情页）。
 * 同时回传「非空剧集首集的 description」供「防冒充」比对。
 */
async function discoverFixtures() {
  const { json } = await httpGetJson(`${TG}/api/media/series`)
  const items = (json && (json.items || json)) || []
  if (!Array.isArray(items) || items.length === 0) return null

  const overrideNonEmpty = Number(process.env.PROBE_NONEMPTY || 0)
  const overrideEmpty = Number(process.env.PROBE_EMPTY || 0)

  let nonEmpty = null
  if (overrideNonEmpty) {
    const s = items.find((x) => x.id === overrideNonEmpty)
    if (s) nonEmpty = { id: s.id, desc: (s.description || '').trim() }
  } else {
    for (const s of items) {
      const d = (s.description || '').trim()
      if (d && (!nonEmpty || d.length > nonEmpty.desc.length)) nonEmpty = { id: s.id, desc: d }
    }
  }

  let empty = null
  if (overrideEmpty) {
    empty = { id: overrideEmpty, firstEpDesc: '', epCount: -1 }
  } else {
    for (const s of items) {
      if ((s.description || '').trim()) continue
      const det = await httpGetJson(`${TG}/api/media/series/${s.id}`)
      const eps = (det.json && det.json.episodes) || []
      if (eps.length >= 1) {
        empty = { id: s.id, firstEpDesc: (eps[0].description || '').trim(), epCount: eps.length }
        break
      }
    }
  }
  if (!empty) return null

  // 非空剧集首集 description（防冒充比对）
  if (nonEmpty && !nonEmpty.firstEpDesc) {
    const det = await httpGetJson(`${TG}/api/media/series/${nonEmpty.id}`)
    const eps = (det.json && det.json.episodes) || []
    nonEmpty.firstEpDesc = eps.length ? (eps[0].description || '').trim() : ''
    nonEmpty.epCount = eps.length
  }
  return { nonEmpty, empty }
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
 * 冷导航打开「媒体库 → 指定剧集详情」。每次强制 `goto` 冷启动（Vite HMR 后的旧 DOM
 * 不可信），并自证落到了目标剧集（`series-cover` 渲染）。
 */
async function openSeriesDetail(page, seriesId) {
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
  if (!clicked) throw new Error(`series-card data-series-id=${seriesId} not found in library`)
  const up = await waitTestidSoft(page, 'series-cover', 15000)
  if (!up) throw new Error(`series ${seriesId}: series-cover never rendered`)
  await delay(700)
}

/**
 * 页面内：一次性采集断言所需事实（唯一真源）。
 * 位置按 **DOM 文档序**（左栏 `aside` 内 `querySelectorAll('*')` 的 index）判定。
 */
const GATHER = () => {
  const $ = (s, r) => (r || document).querySelector(s)
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s))

  const cover = $('[data-testid="series-cover"]')
  const aside = cover ? cover.closest('aside') : null
  const sd = $('[data-testid="series-description"]')
  const sdInAside = aside ? $('[data-testid="series-description"]', aside) : null
  const sdEdit = $('[data-testid="series-desc-edit"]')
  const sdToggle = $('[data-testid="series-desc-toggle"]')
  const panel = $('[data-testid="series-edit-panel"]')

  let order = null
  if (aside) {
    const all = $$('*', aside)
    const idx = (el) => (el ? all.indexOf(el) : -1)
    order = {
      title: idx($('[data-testid="series-title"]', aside)),
      desc: idx(sdInAside),
      edit: idx($('[data-testid="series-edit"]', aside)),
    }
  }

  let maxHeight = null
  if (sd) {
    const cs = getComputedStyle(sd)
    maxHeight = cs.maxHeight
  }

  return {
    sdCountDoc: $$('[data-testid="series-description"]').length,
    sdCountAside: aside ? $$('[data-testid="series-description"]', aside).length : 0,
    sdText: sd ? (sd.textContent || '').trim() : null,
    sdEditCount: sdEdit ? $$('[data-testid="series-desc-edit"]').length : 0,
    hasSdEdit: !!sdEdit,
    hasSdToggle: !!sdToggle,
    maxHeight,
    hasPanel: !!panel,
    order,
    asideText: aside ? aside.innerText || '' : '',
    docText: document.body ? document.body.innerText || '' : '',
  }
}

const gather = (page) => page.evaluate(GATHER)

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
 * 注入缺陷态（撤掉介绍块）→ 重跑断言 A → 还原 → 自证未污染工作区。
 * @returns {Promise<object>}
 */
async function reverseFalsify(page, seriesId) {
  const orig = fs.readFileSync(TARGET_FILE, 'utf8')
  const origHash = sha256(orig)
  const result = { defectFailsCheckA: false, restored: false, shaMatch: false, gitClean: false, forcedRestore: false }
  if (!orig.includes(ANCHOR_OK)) {
    result.error = `anchor not found: ${ANCHOR_OK}`
    return result
  }
  try {
    const injected = orig.replace(ANCHOR_OK, ANCHOR_DEFECT)
    if (injected === orig) {
      result.error = 'injection produced no textual change'
      return result
    }
    fs.writeFileSync(TARGET_FILE, injected, 'utf8')
    await delay(1500) // 等 Vite 重新 transform
    await openSeriesDetail(page, seriesId)
    const g = await gather(page)
    result.injectedSdCount = g.sdCountDoc
    result.defectFailsCheckA = g.sdCountDoc === 0
    result.defectDetail = `series-description count=${g.sdCountDoc} (expect 0 in defect state)`
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

  // 环境自检 + 夹具发现（在启动浏览器之前，快速失败）
  const fx = await discoverFixtures()
  if (!fx || !fx.nonEmpty || !fx.empty) {
    console.error('[verify] ENV FAIL: could not discover fixtures from', TG)
    process.exitCode = 1
    return
  }
  info('fixture nonEmpty', JSON.stringify({ id: fx.nonEmpty.id, descLen: fx.nonEmpty.desc.length, firstEpDescLen: fx.nonEmpty.firstEpDesc.length }))
  info('fixture empty', JSON.stringify(fx.empty))

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

    // ═══════════ 非空剧集 ═══════════
    await openSeriesDetail(page, fx.nonEmpty.id)
    await shot(page, 'A-nonempty-series.png')
    const g = await gather(page)
    info('gathered(nonempty)', JSON.stringify(g))

    check('0: live series detail rendered (series-cover)', g.order != null, `order=${JSON.stringify(g.order)}`)

    // A 非空：展示位存在 + 文本 = 剧集介绍 + ≠ 首集介绍（防冒充）
    check('183-A: series-description exists exactly once', g.sdCountDoc === 1, `count=${g.sdCountDoc}`)
    check('183-A: series-description is inside left pane (aside)', g.sdCountAside === 1, `countAside=${g.sdCountAside}`)
    check(
      '183-A: series-description text == API series description',
      g.sdText != null && g.sdText === fx.nonEmpty.desc,
      `len(page)=${g.sdText ? g.sdText.length : -1} len(api)=${fx.nonEmpty.desc.length} equal=${g.sdText === fx.nonEmpty.desc}`,
    )
    check(
      '183-A: series-description text != first episode description (no impersonation)',
      fx.nonEmpty.firstEpDesc.length > 0 && g.sdText !== fx.nonEmpty.firstEpDesc,
      `firstEpDescLen=${fx.nonEmpty.firstEpDesc.length} equalToFirstEp=${g.sdText === fx.nonEmpty.firstEpDesc}`,
    )

    // B 折叠：初始 64px；超行给 toggle；点击后解除
    check('183-B: description clamped to 64px initially', g.maxHeight === '64px', `maxHeight=${g.maxHeight}`)
    check('183-B: series-desc-toggle present (long description overflows)', g.hasSdToggle === true, `hasToggle=${g.hasSdToggle}`)
    let maxHeightAfter = null
    if (g.hasSdToggle) {
      await clickTestid(page, 'series-desc-toggle')
      await delay(500)
      maxHeightAfter = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="series-description"]')
        return el ? getComputedStyle(el).maxHeight : null
      })
    }
    check('183-B: clicking toggle removes clamp (maxHeight != 64px)', maxHeightAfter != null && maxHeightAfter !== '64px', `maxHeightAfter=${maxHeightAfter}`)
    await shot(page, 'B-expanded.png')

    // C 位置（文档序）：标题 < 介绍 < 总览操作
    const o = g.order
    check('183-C: description AFTER title', o && o.title >= 0 && o.desc > o.title, `idx(title=${o && o.title} desc=${o && o.desc} edit=${o && o.edit})`)
    check('183-C: description BEFORE overview actions (series-edit)', o && o.edit >= 0 && o.desc < o.edit, `idx(title=${o && o.title} desc=${o && o.desc} edit=${o && o.edit})`)

    // E 编辑入口 → 面板
    check('183-E: series-desc-edit present (non-empty)', g.hasSdEdit === true, `hasEdit=${g.hasSdEdit}`)
    if (g.hasSdEdit) {
      await clickTestid(page, 'series-desc-edit')
      const panelUp = await waitTestidSoft(page, 'series-edit-panel', 8000)
      check('183-E: clicking series-desc-edit opens SeriesEditPanel', panelUp === true, `panelUp=${panelUp}`)
      await shot(page, 'E-edit-panel.png')
      // 关掉面板（Esc 或点遮罩）以免影响后续
      await page.evaluate(() => {
        const p = document.querySelector('[data-testid="series-edit-panel"]')
        if (p && p.parentElement) p.parentElement.click()
      })
      await delay(400)
    }

    // ═══════════ 空态剧集 ═══════════
    await openSeriesDetail(page, fx.empty.id)
    await shot(page, 'D-empty-series.png')
    const ge = await gather(page)
    info('gathered(empty)', JSON.stringify(ge))

    check('183-D: series-description ABSENT for empty description', ge.sdCountDoc === 0, `count=${ge.sdCountDoc}`)
    check('183-D: series-desc-edit present (editable slot)', ge.hasSdEdit === true, `hasEdit=${ge.hasSdEdit}`)
    const emptyEpDesc = fx.empty.firstEpDesc || ''
    const noImpersonation = emptyEpDesc.length === 0 || !ge.docText.includes(emptyEpDesc)
    check(
      '183-D: page text does NOT contain first episode description (no impersonation)',
      noImpersonation,
      `firstEpDescLen=${emptyEpDesc.length} (len=0 => vacuous but asserted) present=${emptyEpDesc.length > 0 && ge.docText.includes(emptyEpDesc)}`,
    )

    // ───────────── 页面错误 ─────────────
    const pageErrs = page.pageErrors().slice(0, 10)
    const consoleErrs = page.consoleErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(pageErrs))
    console.log('[verify] CONSOLE_ERRORS:', JSON.stringify(consoleErrs))
    check('F: no uncaught page errors', pageErrs.length === 0, JSON.stringify(pageErrs))

    // ───────────── 反向证伪（必须 FAIL + 自动还原 + 自证） ─────────────
    console.log('\n[verify] ===== REVERSE FALSIFICATION =====')
    const rf = await reverseFalsify(page, fx.nonEmpty.id)
    info('injected defect result', `sdCount=${rf.injectedSdCount} failsCheckA=${rf.defectFailsCheckA}`)
    check('RF: removing the description block makes check A FAIL', rf.defectFailsCheckA === true, `detail=${rf.defectDetail || '-'} err=${rf.error || '-'}`)
    check('RF: file restored byte-identical (sha256 match)', rf.restored === true && rf.shaMatch === true, `restored=${rf.restored} shaMatch=${rf.shaMatch}`)
    check('RF: target file NOT in `git diff --name-only`', rf.gitClean === true, `gitClean=${rf.gitClean} forcedRestore=${rf.forcedRestore}`)

    // 还原后再跑一次主断言，证明还原后的真实代码仍绿
    await openSeriesDetail(page, fx.nonEmpty.id)
    const gFinal = await gather(page)
    check('RF: after restore, check A passes again on real code', gFinal.sdCountDoc === 1 && gFinal.sdText === fx.nonEmpty.desc, `count=${gFinal.sdCountDoc} equal=${gFinal.sdText === fx.nonEmpty.desc}`)

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
