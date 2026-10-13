#!/usr/bin/env node
'use strict'

/**
 * BUG-171 现状核验：**真实渲染**判定「同一段简介出现两次 + Hero 海报比例被 flex
 * stretch 顶掉」在当前「左右主从」形态下是否仍然成立。
 *
 * ## BUG-171 回顾（`docs/bugs/BUG-171.md`，正文描述的是**旧布局**）
 *
 *   - 根因 1：Hero 常驻整段**剧集简介**，分集行里又整段渲染一次**本集介绍**，
 *     单集剧集（TG 抓取时把整段剧集简介逐字复制进每一集）⇒ 同一段话逐字出现两遍。
 *   - 根因 2：Hero 海报容器是 flex 行子项，`align-items: stretch` 压过 `aspect-video`，
 *     720px 下 320×634、820px 下 320×535，只有 ≥900px 才是 320×180。
 *
 * ## 当前实现（`SeriesDetail.tsx`，左右主从形态）
 *
 *   - 左栏总览新增**剧集介绍展示位** `[data-testid="series-description"]`（BUG-183 补回）。
 *   - 右栏本集介绍由 `shouldRenderEpisodeDescription(ep, series)`（`episodePresentation.ts`）
 *     门控。**BUG-281 产品裁定（2026-10-12，用户定）改变了这道门控的语义**：
 *     旧规「与剧集简介逐字相同 ⇒ 隐藏」（本脚本判据 1 的原口径：整页恰 1 次）；
 *     新规「trim 后非空即渲染，按来源贴标签」—— 逐字相同的那部分不再消失，而是由
 *     `episodeDescriptionIsSeriesLevel` 判为**剧集级**，在单集层带
 *     `[data-testid="episode-focus-desc-label"]` = 「剧集介绍」标签渲染。
 *     依据：TG 相册组只带一条组级 caption，旧门控把 36/44 条有介绍的分集藏成
 *     空态（BUG-281 报障「大部分集是没有内容的」）；重复从「被隐藏」改为「被标注」。
 *   - 左栏海报 `[data-testid="series-cover"]` 带 `aspect-video w-full self-start`。
 *   - 旧 `SeriesHero.tsx` 已是零 importer 孤儿（其海报问题不可达）。
 *
 * ## 判据（对**真实渲染的 DOM**，逐条打印实测值）
 *
 *   1 简介双现+标注（BUG-281 新裁定）：取一部**单集**且 `ep.description.trim() ===
 *     series.description.trim()` 的剧集，把剧集简介原文在**整页可见文本**
 *     （`document.body.innerText`）里统计出现次数 —— 必须 **恰为 2 次**
 *     （左栏剧集介绍位 1 + 右栏单集层 1）。`1` ⇒ 退回旧门控（隐藏）；
 *     `>= 3` ⇒ 多出一处未标注的重复（失去对「第三处」的牙齿）。
 *     且第二处必须**可归属**：`episode-focus-desc` 存在、规范化文本 === 剧集简介
 *     原文、其标签 `episode-focus-desc-label` === 「剧集介绍」。
 *     `0` ⇒ 展示位缺失（如实记录，不判 BUG-171 未修）。
 *   2 海报比例：720 / 820 / 1280px 三视口下读 `[data-testid="series-cover"]` 的
 *     `getBoundingClientRect()`，宽高比须 ≈ 16:9（±3%）。**读 rect，不读 className。**
 *   3 编辑能力未受损：`episode-edit` 存在，点击后出现 `episode-title-input`。
 *   4 反向证伪：把 `shouldRenderEpisodeDescription` **换回旧门控**（逐字相同即隐藏）
 *     → 判据 1 **必须 FAIL**（次数跌到 1、`episode-focus-desc` 消失）；
 *     还原后 sha256 相等、且 BUG-281 新门控与 `episodeDescriptionIsSeriesLevel`
 *     均在位。**绝不改断言去迎合代码。**
 *   5 收集 `pageerror` / console error。
 *
 * Usage:  node verify/verify_bug171_status.cjs            # 正常跑判据
 *         PROBE=1 node verify/verify_bug171_status.cjs    # 只 dump 页面事实
 * Env:    APP_PORT(默认5180) TG_URL(默认 http://127.0.0.1:19787)
 *         PROBE_SERIES(默认自动挑单集夹具) ORIG_VERIFY_OUT
 * Exit:   0 = 全通过；1 = 环境失败；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const PROBE = process.env.PROBE === '1'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug171'),
)

/** BUG-281 新裁定下的「剧集介绍」标签文案（与 zh-CN.json 同源，不硬编码）。 */
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const LABEL_SERIES = ZH['media.episode.sectionDescSeries']

/** BUG-171 的两个缺陷面都在「窄视口」最明显：三视口逐一实测。 */
const VIEWPORTS = [
  { w: 720, h: 900, label: '720px' },
  { w: 820, h: 900, label: '820px' },
  { w: 1280, h: 900, label: '1280px' },
]

/** 16:9 = 1.7778；容差 ±3%。 */
const RATIO_16_9 = 16 / 9
const RATIO_TOL = 0.03

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TARGET_REL = 'tauri-shell/src/lib/episodePresentation.ts'
const TARGET_FILE = path.join(REPO_ROOT, TARGET_REL)
/**
 * 反向证伪锚点（BUG-281 新裁定门控的**当前源码正文**）：trim 后非空即渲染。
 * 注入 = 把它换回旧门控（逐字相同即隐藏）—— 正是 BUG-281 取代的那个行为。
 */
const NEW_GATE_BODY = "  return (ep.description ?? '').trim().length > 0"
const OLD_GATE_BODY =
  "  const epDesc = (ep.description ?? '').trim()\n" +
  "  return epDesc.length > 0 && epDesc !== (_series.description ?? '').trim()"
/** 新裁定的另一半：来源判定函数必须在位（只换门控不换判定 = 半截修复）。 */
const RULING_MARK = 'episodeDescriptionIsSeriesLevel'
/** 关注并发编辑：核验期间若该文件被他人改写，结果不稳定，需标记。 */
const WATCH_REL = 'tauri-shell/src/components/media/SeriesDetail.tsx'
const WATCH_FILE = path.join(REPO_ROOT, WATCH_REL)

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

function httpGetJson(url, timeoutMs = 5000) {
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

// ───────────────────────────── 夹具自动发现 ─────────────────────────────

/**
 * 找一部**单集**剧集，且其唯一分集的介绍与剧集简介**逐字相同**（BUG-171 夹具特征：
 * TG 抓取把整段剧集简介复制进每一集）。这是判据 1 与反向证伪的必要前提。
 * @returns {Promise<{seriesId:number, episodeId:number, seriesDesc:string, title:string}|null>}
 */
async function findFixture() {
  const forced = Number(process.env.PROBE_SERIES || 0)
  const { json: list } = await httpGetJson(`${TG}/api/media/series`)
  const items = (list && (list.items || list)) || []
  if (!Array.isArray(items) || items.length === 0) return null
  const candidates = items.filter(
    (s) => s && s.episodeCount === 1 && (s.description || '').trim().length > 0,
  )
  const ordered = forced ? candidates.filter((s) => s.id === forced).concat(candidates.filter((s) => s.id !== forced)) : candidates
  for (const s of ordered) {
    const { json: d } = await httpGetJson(`${TG}/api/media/series/${s.id}`)
    if (!d || !Array.isArray(d.episodes) || d.episodes.length !== 1) continue
    const ep = d.episodes[0]
    const seriesDesc = (d.description || '').trim()
    const epDesc = (ep.description || '').trim()
    if (seriesDesc.length === 0) continue
    if (epDesc === seriesDesc) {
      return { seriesId: d.id, episodeId: ep.id, seriesDesc, title: d.title || '', epDescLen: epDesc.length }
    }
  }
  return null
}

// ───────────────────────────── 页面辅助 ─────────────────────────────

async function clickTestid(page, tid) {
  const ok = await page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
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

/** 冷导航打开「媒体库 → series 详情」，自证落到了目标剧集（左栏标题 + 右栏聚焦集）。 */
async function openSeriesDetail(page, seriesId) {
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
  await waitTestidSoft(page, 'series-title', 15000)
  await waitTestidSoft(page, 'episode-focus-title', 15000)
  await delay(600)
}

/**
 * 页面内：采集判据所需全部事实（一次求值，避免多次求值期间 DOM 漂移）。
 * 简介出现次数按**规范化空白后**的子串计数（渲染换行口径与 API 原文可能不同）。
 */
const GATHER = (seriesDesc) => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const countOccurrences = (hay, needle) => {
    if (!needle) return 0
    let n = 0
    let i = 0
    for (;;) {
      const j = hay.indexOf(needle, i)
      if (j < 0) break
      n += 1
      i = j + needle.length
    }
    return n
  }
  const needle = norm(seriesDesc)
  const innerText = norm(document.body ? document.body.innerText : '')
  const textContent = norm(document.body ? document.body.textContent : '')
  const innerCount = countOccurrences(innerText, needle)
  const domCount = countOccurrences(textContent, needle)

  const slot = document.querySelector('[data-testid="series-description"]')
  const focusDesc = document.querySelector('[data-testid="episode-focus-desc"]')
  // BUG-281：单集层介绍的区块标签（剧集级 = 「剧集介绍」，本集级 = 「本集介绍」）。
  // 旧代码无此 testid —— 取不到即证明跑在旧裁定代码上，判据 1 应 FAIL 而非静默。
  const focusLabel = document.querySelector('[data-testid="episode-focus-desc-label"]')
  const cover = document.querySelector('[data-testid="series-cover"]')
  const aside = cover ? cover.closest('aside') : null

  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      ratio: r.height > 0 ? Math.round((r.width / r.height) * 10000) / 10000 : null,
    }
  }

  return {
    viewport: { innerW: window.innerWidth, clientW: document.documentElement.clientWidth },
    descLen: needle.length,
    innerCount,
    domCount,
    innerTextLen: innerText.length,
    slot: {
      exists: !!slot,
      textLen: slot ? norm(slot.textContent || '').length : 0,
      clamped: slot ? slot.scrollHeight > slot.clientHeight + 2 : false,
      scrollH: slot ? slot.scrollHeight : null,
      clientH: slot ? slot.clientHeight : null,
    },
    focusDescExists: !!focusDesc,
    focusDescTextLen: focusDesc ? norm(focusDesc.textContent || '').length : 0,
    /** 单集层那段是否就是剧集简介原文（规范化后相等）—— 「第二处」的归属证明。 */
    focusDescMatchesNeedle: focusDesc ? norm(focusDesc.textContent || '') === needle : false,
    focusLabel: focusLabel ? String(focusLabel.textContent || '').trim() : null,
    cover: rectOf(cover),
    asideW: aside ? Math.round(aside.getBoundingClientRect().width * 100) / 100 : null,
    hasEdit: !!document.querySelector('[data-testid="episode-edit"]'),
    hasTitleInput: !!document.querySelector('[data-testid="episode-title-input"]'),
  }
}

const gather = (page, seriesDesc) => page.evaluate(GATHER, seriesDesc)

// ───────────────────────────── 反向证伪 ─────────────────────────────

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const fileHash = (p) => {
  try {
    return sha256(fs.readFileSync(p, 'utf8'))
  } catch (_e) {
    return null
  }
}

/**
 * 注入旧门控（逐字相同即隐藏）→ 重跑判据 1 → 还原 → 自证未污染工作区。
 *
 * BUG-281 语义：旧门控下剧集级介绍被藏成空态 ⇒ 次数跌到 1、`episode-focus-desc`
 * 消失 ⇒ 判据 1 FAIL。还原**只走字节写回**：工作树带着 BUG-281 的未提交改动，
 * `git checkout --` 会把裁定一起冲掉（旧版脚本的兜底路径已删除）。
 * @returns {Promise<object>}
 */
async function reverseFalsify(page, fixture) {
  const orig = fs.readFileSync(TARGET_FILE, 'utf8')
  const origHash = sha256(orig)
  const result = { restored: false, shaMatch: false, rulingIntact: false }
  if (!orig.includes(NEW_GATE_BODY)) {
    result.error = `BUG-281 gate anchor not found in ${TARGET_REL}: ${JSON.stringify(NEW_GATE_BODY)}`
    return result
  }
  try {
    const injected = orig.replace(NEW_GATE_BODY, OLD_GATE_BODY)
    if (injected === orig) {
      result.error = 'injection produced no textual change'
      return result
    }
    fs.writeFileSync(TARGET_FILE, injected, 'utf8')
    await delay(1800) // 等 Vite 重新 transform
    await openSeriesDetail(page, fixture.seriesId)
    const g = await gather(page, fixture.seriesDesc)
    result.injectedInnerCount = g.innerCount
    result.injectedDomCount = g.domCount
    result.injectedFocusDescExists = g.focusDescExists
    result.injectedLabel = g.focusLabel
    await shot(page, 'F-injected-old-gate.png') // 红态：旧门控把剧集级介绍藏成空态
  } catch (e) {
    result.error = e && e.message ? e.message : String(e)
  } finally {
    // ★ 无论如何先还原（字节写回；绝不用 git checkout）
    try {
      fs.writeFileSync(TARGET_FILE, orig, 'utf8')
      await delay(1500)
    } catch (_e) {
      result.forcedRestore = true
    }
    let now = null
    try {
      now = fs.readFileSync(TARGET_FILE, 'utf8')
    } catch (_e) {}
    result.restored = now === orig
    result.shaMatch = now != null && sha256(now) === origHash
    // 还原必须回到**新裁定**态：新门控 + 来源判定函数都在位
    result.rulingIntact =
      now != null && now.includes(NEW_GATE_BODY) && now.includes(RULING_MARK)
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

  // ───────────── 环境自检 + 夹具发现 ─────────────
  const fixture = await findFixture()
  if (!fixture) {
    console.error(
      `[verify] ENV FAIL: 未能在 ${TG} 找到「单集且 ep.description === series.description」的夹具剧集`,
    )
    process.exitCode = 1
    return
  }
  info(
    'fixture',
    `series=${fixture.seriesId} ep=${fixture.episodeId} descLen=${fixture.seriesDesc.length} title=${JSON.stringify(fixture.title.slice(0, 40))}`,
  )
  const watchHashStart = fileHash(WATCH_FILE)

  const browser = await cdp.launch()
  let page
  try {
    page = await browser.newPage()
    await setViewport(page, 1440, 900)

    if (PROBE) {
      await openSeriesDetail(page, fixture.seriesId)
      for (const vp of VIEWPORTS) {
        await setViewport(page, vp.w, vp.h)
        const g = await gather(page, fixture.seriesDesc)
        console.log(`[verify] PROBE ${vp.label} :: ${JSON.stringify(g)}`)
      }
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[verify] PROBE testids:\n  ' + ids.join('\n  '))
      return
    }

    // ───────────── 打开真实页面（默认 1440） ─────────────
    await openSeriesDetail(page, fixture.seriesId)
    const g0 = await gather(page, fixture.seriesDesc)
    info('gathered@1440', JSON.stringify(g0))
    await shot(page, '05-bug171-updated.png') // BUG-281 新裁定下的双现+标注态

    // 自证扫的是活页面
    check('0: series description slot rendered (live DOM)', g0.slot.exists, `slotExists=${g0.slot.exists} textLen=${g0.slot.textLen}`)

    // ───────────── 判据 1：简介双现 + 单集层带「剧集介绍」标签（BUG-281 新裁定） ─────────────
    const baseCount = g0.innerCount
    const domCount = g0.domCount
    info('desc occurrences', `innerText=${baseCount} textContent=${domCount} (needleLen=${g0.descLen})`)
    check(
      `171-1 (BUG-281 ruling): series description appears EXACTLY TWICE — hero once + episode level once`,
      baseCount === 2 && domCount === 2,
      `innerCount=2 且 textContentCount=2（1 ⇒ 退回旧门控「隐藏」；>=3 ⇒ 多出一处未标注重复）`,
      `innerCount=${baseCount} textContentCount=${domCount}`,
    )
    check(
      `171-1 (BUG-281 ruling): the episode-level occurrence is attributed — episode-focus-desc matches the series description AND carries the "${LABEL_SERIES}" label`,
      g0.focusDescExists === true &&
        g0.focusDescMatchesNeedle === true &&
        g0.focusLabel === LABEL_SERIES,
      `episode-focus-desc 存在、规范化文本 === 剧集简介原文（len=${g0.descLen}）、label === "${LABEL_SERIES}"`,
      `focusDescExists=${g0.focusDescExists} focusDescTextLen=${g0.focusDescTextLen} matchesNeedle=${g0.focusDescMatchesNeedle} label=${JSON.stringify(g0.focusLabel)}`,
    )

    // ───────────── 判据 2：海报比例（三视口） ─────────────
    const coverByVp = {}
    for (const vp of VIEWPORTS) {
      await setViewport(page, vp.w, vp.h)
      const g = await gather(page, fixture.seriesDesc)
      const c = g.cover
      const ratioOk = !!c && c.ratio != null && Math.abs(c.ratio - RATIO_16_9) <= RATIO_16_9 * RATIO_TOL
      coverByVp[vp.label] = { ...c, ratioOk, innerW: g.viewport.innerW, asideW: g.asideW }
      check(
        `171-2(${vp.label}): series-cover aspect ≈ 16:9`,
        ratioOk,
        c ? `w=${c.w} h=${c.h} ratio=${c.ratio} (16:9=${RATIO_16_9.toFixed(4)}) innerW=${g.viewport.innerW} asideW=${g.asideW}` : 'no series-cover',
      )
      await shot(page, `B-cover-${vp.w}.png`)
    }
    info('cover rects', JSON.stringify(coverByVp))

    // ───────────── 判据 3：编辑能力未受损 ─────────────
    await setViewport(page, 1280, 900)
    await openSeriesDetail(page, fixture.seriesId)
    const beforeEdit = await gather(page, fixture.seriesDesc)
    check('171-3: episode-edit present', beforeEdit.hasEdit, `hasEdit=${beforeEdit.hasEdit}`)
    let titleInputUp = false
    if (beforeEdit.hasEdit) {
      await clickTestid(page, 'episode-edit')
      titleInputUp = await waitTestidSoft(page, 'episode-title-input', 8000)
      await shot(page, 'C-edit-panel.png')
    }
    check('171-3: clicking episode-edit opens panel (episode-title-input)', titleInputUp, `titleInput=${titleInputUp}`)

    // ───────────── 判据 5：页面错误 ─────────────
    const pageErrs = page.pageErrors().slice(0, 10)
    const consoleErrs = page.consoleErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(pageErrs))
    console.log('[verify] CONSOLE_ERRORS:', JSON.stringify(consoleErrs))
    check('171-5: no uncaught page errors', pageErrs.length === 0, JSON.stringify(pageErrs))

    // ───────────── 判据 4：反向证伪 ─────────────
    console.log('\n[verify] ===== REVERSE FALSIFICATION =====')
    const rf = await reverseFalsify(page, fixture)
    info(
      'injected (old gate restored) counts',
      `innerCount=${rf.injectedInnerCount} domCount=${rf.injectedDomCount} focusDescExists=${rf.injectedFocusDescExists} label=${JSON.stringify(rf.injectedLabel)} err=${rf.error || '-'}`,
    )
    check(
      'RF: restoring the OLD gate (hide verbatim-equal) drops the count to 1 and hides episode-focus-desc (assertion 1 FAILS)',
      rf.injectedInnerCount === 1 &&
        rf.injectedInnerCount < baseCount &&
        rf.injectedFocusDescExists === false,
      `injectedInnerCount=1（< base ${baseCount}）且注入态 episode-focus-desc 消失（被藏成空态）`,
      `injectedInnerCount=${rf.injectedInnerCount} base=${baseCount} focusDescExists=${rf.injectedFocusDescExists} err=${rf.error || '-'}`,
    )
    check(
      'RF: target file restored byte-identical (sha256 match)',
      rf.restored === true && rf.shaMatch === true,
      `restored=${rf.restored} shaMatch=${rf.shaMatch}`,
      `restored=${rf.restored} shaMatch=${rf.shaMatch} forcedRestore=${rf.forcedRestore === true}`,
    )
    check(
      'RF: BUG-281 ruling intact after restore (new gate body + episodeDescriptionIsSeriesLevel present)',
      rf.rulingIntact === true,
      `还原后仍含新门控正文与 ${RULING_MARK}（不是回到旧裁定）`,
      `rulingIntact=${rf.rulingIntact}`,
    )

    // 还原后再跑一次主判据，证明还原后的真实代码仍是「双现 + 剧集介绍标签」
    await openSeriesDetail(page, fixture.seriesId)
    const gFinal = await gather(page, fixture.seriesDesc)
    await shot(page, 'Z-final.png')
    check(
      `RF: after restore, count is back to EXACTLY 2 with the "${LABEL_SERIES}" label on real code`,
      gFinal.innerCount === 2 &&
        gFinal.focusDescMatchesNeedle === true &&
        gFinal.focusLabel === LABEL_SERIES,
      `innerCount=2 且第二处可归属（episode-focus-desc === 剧集简介原文、label === "${LABEL_SERIES}"）`,
      `innerCount=${gFinal.innerCount} matchesNeedle=${gFinal.focusDescMatchesNeedle} label=${JSON.stringify(gFinal.focusLabel)}`,
    )

    // ───────────── 并发编辑护栏 ─────────────
    const watchHashEnd = fileHash(WATCH_FILE)
    check(
      'CONSISTENCY: watched file (SeriesDetail.tsx) unchanged during run',
      watchHashStart != null && watchHashStart === watchHashEnd,
      `start=${watchHashStart ? watchHashStart.slice(0, 12) : '-'} end=${watchHashEnd ? watchHashEnd.slice(0, 12) : '-'}`,
    )

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
    // 末态截图已在「还原后复跑」处显式拍摄（Z-final.png = 新裁定真实代码态）；
    // 这里不再补拍 —— 异常路径下页面可能停留在注入态，补拍会覆盖权威证据。
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
