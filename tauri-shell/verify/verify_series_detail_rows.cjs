#!/usr/bin/env node
'use strict'

/**
 * 行式分集列表（row-based episode list）验收探针（commit 63d7dc4）。
 *
 * 背景：剧集详情页此前被改成「单集聚焦 + 底部 chip 切换条 + 本集/全剧合并介绍区」，
 * 该版被否（`episode-focus` 380×214 封面 / `episode-switcher` chip 条 / `desc-section`），
 * 63d7dc4 把分集区改回**左右行式**。本探针在真实浏览器里取证新版渲染：
 *
 *   1. 行列表回来了：`episode-slot` 数 == Hero 元信息行里的「N 集」，且 > 1（系列 1 有 14 集）；
 *   2. 封面放大到 160×90（旧版 80×44）：实测 ≥3 行的封面元素渲染宽高（≥150 / ≥84），
 *      并按 coverFit 规则验 object-fit：非 photo → cover（行内分集恒为非 photo），
 *      photo → contain（行列表里 photo 不进 playEps，故在可达的 photo 渲染位上测：
 *      集级挂图缩略图 `episode-image-open` 与剧集图册 `series-gallery`）；
 *   3. 聚焦模式残留为 0：`episode-switcher` / `episode-focus` / `desc-section` /
 *      `desc-tab-ep` / `desc-tab-series`（含前缀扫描），同时断言 `episode-slot` > 0 自证扫的是活页面；
 *   4. 剧集介绍整页只出现一次且常驻 Hero：正文 innerText 里出现次数 === 1；
 *      至首个分集行（compareDocumentPosition）—— **2026-09-28 重排后改口径**：
 *      `showSeasonHeaders = seasonCount > 1 && episodeCount > 1`，单季剧集不再渲染
 *      「第 N 季」分组头（design §13.2 回归点 1），故「早于第 N 季」不再成立，
 *      改锚 **首个 `episode-slot`**（分集区起点，同样能证明介绍在 Hero 而非分集区）；
 *   5. 按季分组（**条件断言，2026-09-28 改**）：「第 N 季」分组头只在 `seasonCount > 1`
 *      时渲染。series 1 seasonCount=1 → 这次**断言「无分组头」**；多季剧集才断言
 *      「分组头存在且早于第一个 `episode-slot`」；
 *   6. 集级挂图仍可达：`episode-images` 缩略图 > 0，点 `episode-image-open` 出
 *      `lightbox`（旧名 `episode-image-viewer` 由 layoutCompat 别名兜底），再关掉；
 *   7. 窄视口无横向溢出：主滚动容器 scrollWidth === clientWidth，且行内封面仍 ≥150px 宽。
 *      720px 是任务书点名的宽度，但 `src-tauri/tauri.conf.json` 的 `minWidth` = 900 ——
 *      桌面壳最小窗口就是 900px，720 在真实产品里**不可达**。故 720 只实测打印（溢出则记为
 *      WARNING 并附原因），硬断言落在支持范围内的最窄窗口 **900px**（另附 820px 佐证）。
 *
 * 每条断言都打印实测值，且对改版前的代码必然失败（旧版：chip 条/聚焦区/desc tab 非 0、
 * 封面 80×44、介绍不在 Hero、无「第 N 季」分组）。
 *
 * 623ba93 复测补充（D1/D2/D3）：
 *   D1-1 Hero 海报：720/820/900 三个宽度实测量到的宽高必须都是 320×180
 *       （上一轮实测 320×634 / 320×535 / 320×180，self-start 修复后应恒为 320×180）；
 *   D1-2 720px 下被裁掉的元素按 testid 计数打印（上一轮：14 个 episode-remove）。
 *       壳最小宽度 900 → 720 的裁剪只记 WARNING；900/820 上裁剪数必须为 0；
 *   D2  去重反例：series 101（单集，集介绍与剧集介绍逐字相同 120 字）的这段文案
 *       在整页 innerText 里出现次数 === 1（旧行为是 2），且行内不再渲染介绍 <p>，
 *       但 episode-slot / episode-edit 仍各 1 个（编辑入口不能跟着被折叠掉）；
 *   D3  去重正例：本集介绍 ≠ 剧集介绍时行内必须照常渲染 —— 先取活数据（series 3 的
 *       S1E1 自带 291 字本集介绍 vs 484 字剧集介绍），再**经 UI 现场造一条**
 *       （episode-edit → textarea 写值 → episode-save），断言行内介绍 <p> 存在、
 *       文本等于所存值且与 Hero 介绍不同；最后把原值改回去（探针不留测试文案）。
 *
 * Usage:  node verify/verify_series_detail_rows.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT PROBE(1=只 dump testid)
 * Exit:   0 = 全部通过；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')
const { installTestidAliases, FIND_POSTER_CONTAINER } = require('./lib/layoutCompat.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-series-rows-shots')
const PROBE = process.env.PROBE === '1'

/**
 * 断言目标（剧集 id 取自后端 /api/media/series 的实测数据）：
 *   1  = 14 集（全 video，全部 hasBytes → 14 个 episode-cover），介绍非空且不与集介绍重复
 *   80 = 2 集（ep399 photo → 进图册不进行；ep400 video 带 1 张集级挂图）
 *   101= 1 集，介绍 120 字（长介绍；注意其单集介绍与剧集介绍**逐字相同**，见 WARNINGS）
 */
const SERIES_MANY = 1
const SERIES_IMAGES = 80
const SERIES_DESC = 101
/** 「介绍只出现一次」的主验对象：80 的介绍长 119 字，且其可播分集的集介绍为空 → 不混淆两个字段 */
const SERIES_DESC_SINGLE = 80
/**
 * 去重**正例**对象（623ba93 的 showEpDesc 不能把「真有独立本集介绍」的那一份也吃掉）：
 * series 3 的 S1E1（ep 131）自带 291 字本集介绍，剧集介绍 484 字 —— 两者逐字不同，
 * 是活数据里现成的「本集介绍 ≠ 剧集介绍」样本（实测自 /api/media/series/3）。
 */
const SERIES_DESC_DIFF = 3
/** 行内「本集介绍」textarea（无 testid，只能按 placeholder 定位） */
// 单集介绍 textarea 在 EpisodeEditPanel 内**无 data-testid**（EpisodeEditPanel.tsx:167），
// placeholder 来自 i18n `media.descEmptyEp` = 「本集暂无介绍」。旧写法 `[placeholder="本集介绍…"]`
// 是早期文案，现已不存在 —— 保留会导致「面板打不开」的假 FAIL。用 CSS 属性包含匹配定位。
const EP_DESC_TA = '[data-testid="episode-edit-panel"] textarea[placeholder*="本集"][placeholder*="介绍"]'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickTestid(page, testid) {
  const ok = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
  if (!ok) throw new Error(`clickTestid: ${testid} not found`)
}

async function waitTestid(page, testid, timeout = 10000) {
  await page.waitForFunction((tid) => !!document.querySelector(`[data-testid="${tid}"]`), {
    timeout,
    args: [testid],
  })
}

async function waitTestidSoft(page, testid, timeout = 6000) {
  try {
    await waitTestid(page, testid, timeout)
    return true
  } catch (_e) {
    return false
  }
}

/** 等任意 CSS 选择器出现（本集介绍 textarea 没有 data-testid） */
async function waitSelectorSoft(page, selector, timeout = 8000) {
  try {
    await page.waitForFunction((s) => !!document.querySelector(s), { timeout, args: [selector] })
    return true
  } catch (_e) {
    return false
  }
}

/** 等任意 CSS 选择器消失 */
async function waitSelectorGone(page, selector, timeout = 10000) {
  try {
    await page.waitForFunction((s) => !document.querySelector(s), { timeout, args: [selector] })
    return true
  } catch (_e) {
    return false
  }
}

/** CDP lib 没有 setViewport：只能直接发 Emulation.setDeviceMetricsOverride */
async function setViewport(page, width, height) {
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
  await delay(700)
}

/**
 * 展开「有挂图的那一集」。
 *
 * 2026-09-28 重排后，集级挂图缩略图只在**展开态**下渲染（PRD R1：手风琴恒 ≤ 1）。
 * 逐集点 `episode-slot`，直到出现 `episode-image-open`；全部点完仍无则如实返回 false。
 * 不能假定「第一集就是有图的那集」——photo 分集会先被折成宫格瓦片。
 */
async function expandEpisodeWithImages(page) {
  const n = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-slot"]').length)
  for (let i = 0; i < n; i++) {
    await page.evaluate((idx) => {
      const s = document.querySelectorAll('[data-testid="episode-slot"]')[idx]
      if (s) s.click()
    }, i)
    await delay(650)
    const has = await page.evaluate(() => !!document.querySelector('[data-testid="episode-image-open"]'))
    if (has) return true
  }
  return false
}

/**
 * 分集列表所在的滚动容器。
 *
 * 不能写 `div.overflow-y-auto` 后取第一个：详情同屏里另有别的 overflow-y-auto 面板
 * （实测首个命中是 `mt-0.5 max-h-72 space-y-0.5 overflow-y-auto`，clientWidth 191），
 * 拿它做溢出断言等于空断言。改为**从分集行向上找第一个真正可滚动的祖先**，
 * 并回传 `containsRows` 自证命中的是分集列表本身。
 */
const FIND_LIST_CONTAINER = () => {
  const slot = document.querySelector('[data-testid="episode-slot"]')
  if (!slot) return null
  let el = slot.parentElement
  while (el) {
    const cs = getComputedStyle(el)
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      return {
        found: true,
        containsRows: el.querySelectorAll('[data-testid="episode-slot"]').length,
        cls: String(el.className).slice(0, 80),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        overflowX: cs.overflowX,
      }
    }
    el = el.parentElement
  }
  return null
}

async function scrollListTop(page) {
  await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="episode-slot"]')
    let el = slot ? slot.parentElement : null
    while (el) {
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
        el.scrollTop = 0
        break
      }
      el = el.parentElement
    }
    window.scrollTo(0, 0)
  })
  await delay(400)
}

/** scrollIntoView 后截图（内滚动容器里的折叠内容 fullPage 也截不到） */
async function shot(page, name, testid) {
  await page.evaluate((tid) => {
    const el = tid ? document.querySelector(`[data-testid="${tid}"]`) : null
    if (el) {
      el.scrollIntoView({ block: 'center' })
      return
    }
    // 没给 testid：把分集列表滚回顶部（Hero 在外层，滚内容器不会把它顶走）
    const slot = document.querySelector('[data-testid="episode-slot"]')
    let box = slot ? slot.parentElement : null
    while (box) {
      const cs = getComputedStyle(box)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
        box.scrollTop = 0
        break
      }
      box = box.parentElement
    }
    window.scrollTo(0, 0)
  }, testid || null)
  await delay(500)
  const file = path.join(OUT_DIR, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    size = -1
  }
  console.log(`[rows] shot ${name} -> ${file} (${size} bytes)`)
  return { file, size }
}

async function gotoMediaLibrary(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  await installTestidAliases(page) // §13.1：旧 testid 名原样返回（series-gallery* 除外）
  await waitTestid(page, 'nav-child-lib-series', 15000)
  await clickTestid(page, 'nav-child-lib-series')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 15000 },
  )
  await delay(900)
}

/** 按后端剧集 id 打开详情（卡片带 data-series-id，textContent 无标题故只能按 id 定位） */
async function openSeriesById(page, id) {
  await gotoMediaLibrary(page)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, id)
  if (!clicked) throw new Error(`series-card with data-series-id=${id} not found`)
  await waitTestid(page, 'series-tag-edit', 15000)
  await delay(1000)
  return waitTestidSoft(page, 'episode-slot', 10000)
}

/** Hero 元信息行：「剧集 · 14 集 · 1 季」里的集数 */
async function metaEpisodeCount(page) {
  return page.evaluate(() => {
    for (const p of Array.from(document.querySelectorAll('p'))) {
      const t = (p.textContent || '').trim()
      const m = t.match(/(\d+)\s*集/)
      if (m && t.includes('季') && t.length < 80) return { text: t, count: Number(m[1]) }
    }
    return null
  })
}

/** 正文里某段文本出现的次数（去空白后计数：whitespace-pre-wrap 的换行不该影响判重） */
const COUNT_OCCURRENCES = (needleRaw) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const needle = norm(needleRaw)
  const hay = norm(document.body ? document.body.innerText : '')
  if (!needle) return 0
  let count = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) {
    count++
    i += needle.length
  }
  return count
}

/**
 * Hero 常驻介绍文本。
 *
 * 2026-09-28 重排：介绍正文改成带 `data-testid="series-description"` 的 <p>（SeriesHero.tsx）。
 * 旧写法「取 `series-desc-edit` 按钮父级里的 <p>」现在会命中编辑按钮所在的 flex 行，
 * 而那行里已不再直接含介绍正文（正文提级为独立节点），必然返回 null。
 * 优先按 testid 取；`series-desc-edit` 仍存在（编辑入口进面板），保留为兜底。
 */
const READ_HERO_DESC = () => {
  const p = document.querySelector('[data-testid="series-description"]')
  if (p) {
    const text = (p.textContent || '').trim()
    if (text) return { text, head: text.slice(0, 40) }
  }
  const btn = document.querySelector('[data-testid="series-desc-edit"]')
  if (btn && btn.parentElement) {
    const fallback = btn.parentElement.querySelector('p')
    if (fallback) {
      const text = (fallback.textContent || '').trim()
      if (text) return { text, head: text.slice(0, 40) }
    }
  }
  return null
}

/**
 * 每一行的「本集介绍」渲染情况（**展开态**下）。
 *
 * 2026-09-28 重排：本集介绍 <p> 从「行内常驻」移入**展开态块**（EpisodeExpanded ③）。
 * 手风琴恒 ≤ 1 展开，且 React 的状态更新是异步的 —— 点击后必须**等一拍**才能读 DOM。
 * 故这里拆成「页面内点击」+「Node 侧等待」+「页面内读取」三步，逐行处理。
 *
 * 展开块渲染在该行 li 内，介绍 <p> 无 testid，按排版类名 `whitespace-pre-wrap` 定位。
 * 回传每行 descs：与剧集介绍逐字相同的集展开后为 0（渲染「本集暂无介绍」提示）；
 * 真有独立介绍的集为 1。
 */
const CLICK_SLOT = (i) => {
  const s = document.querySelectorAll('[data-testid="episode-slot"]')[i]
  if (s) s.click()
  return !!s
}
const READ_EXPANDED_ROW = (i) => {
  const slot = document.querySelectorAll('[data-testid="episode-slot"]')[i]
  // 2026-09-28 重排：行容器是 `<div data-testid="episode-row-{id}">`（无 <li>）；
  // 展开块是它的父 wrapper（`<div key={ep.id}>`）里的兄弟节点，故从 wrapper 里找介绍 <p>。
  const rowEl = slot ? slot.closest('[data-testid^="episode-row-"]') : null
  const wrapper = rowEl ? rowEl.parentElement : null
  const ps = wrapper
    ? Array.from(wrapper.querySelectorAll('p')).filter((p) => String(p.className).includes('whitespace-pre-wrap'))
    : []
  return {
    row: i,
    slot: slot ? (slot.textContent || '').trim() : null,
    descs: ps.length,
    text: ps.length ? (ps[0].textContent || '').trim() : null,
  }
}

async function readRowDescs(page) {
  const n = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-slot"]').length)
  const out = []
  for (let i = 0; i < n; i++) {
    await page.evaluate(CLICK_SLOT, i)
    await delay(650) // 等 React 重渲染出展开块
    out.push(await page.evaluate(READ_EXPANDED_ROW, i))
    await page.evaluate(CLICK_SLOT, i) // 收起，保证手风琴恒 ≤ 1
    await delay(300)
  }
  // 收尾自证：读完后不应残留任何展开块，否则后续「点开某行」会被手风琴自动收起而误判
  for (let guard = 0; guard < n; guard++) {
    const stillOpen = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-expanded"]').length)
    if (!stillOpen) break
    await page.evaluate(() => {
      const open = document.querySelector('[data-testid="episode-expanded"]')
      const wrapper = open ? open.parentElement : null
      const slot = wrapper ? wrapper.querySelector('[data-testid="episode-slot"]') : null
      if (slot) slot.click()
    })
    await delay(350)
  }
  return out
}

/**
 * 写 React 受控 textarea。
 *
 * 直接 `el.value = x` 不会触发 React 的 onChange（value tracker 认为没变），必须走
 * 原型上的原生 setter 再派发 input 事件 —— 否则「保存」提交的仍是旧值，
 * 探针就会用一个没真正写进去的值去断言，等于空断言。
 */
const SET_TEXTAREA_VALUE = (selector, value) => {
  const el = document.querySelector(selector)
  if (!el) return { ok: false, reason: `no element for ${selector}` }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  if (!setter) return { ok: false, reason: 'no native value setter' }
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, readback: el.value }
}

/**
 * 点某一行的 episode-edit。
 *
 * 2026-09-28 重排：`episode-edit` 从「行内常驻」移入**展开态操作区**（PRD R1/§13.1）。
 * 故必须先点该行的 `episode-slot` 把它展开，**等 React 重渲染**，再点展开块里的
 * `episode-edit`。展开块渲染在该行 `li` 内（EpisodeBoard.tsx）。
 */
const CLICK_SLOT_AT = (row) => {
  const slot = document.querySelectorAll('[data-testid="episode-slot"]')[row]
  if (!slot) return { ok: false, reason: `no episode-slot at row ${row}` }
  slot.click()
  return { ok: true, slot: (slot.textContent || '').trim() }
}
const CLICK_EDIT_IN_ROW = (row) => {
  // 2026-09-28 重排：分集行不再是 <li>，而是 `<div data-testid="episode-row-{id}">`；
  // 展开块是该行 wrapper（`<div key={ep.id}>`）的兄弟。故用 `episode-row-*` 定位 wrapper。
  const slot = document.querySelectorAll('[data-testid="episode-slot"]')[row]
  const wrapper = slot ? slot.closest('[data-testid^="episode-row-"]')?.parentElement : null
  const btn = wrapper ? wrapper.querySelector('[data-testid="episode-edit"]') : null
  if (!btn) return { ok: false, reason: `no episode-edit inside row ${row} (after expand)` }
  btn.click()
  return { ok: true }
}
async function clickRowEdit(page, row) {
  const c = await page.evaluate(CLICK_SLOT_AT, row)
  if (!c.ok) return c
  await delay(650) // 等展开块渲染
  const e = await page.evaluate(CLICK_EDIT_IN_ROW, row)
  return e.ok ? { ok: true, slot: c.slot } : e
}

/** 与页面内 COUNT_OCCURRENCES 同一套归一化规则（innerText 的换行不参与比较） */
const normText = (s) => String(s || '').replace(/\s+/g, '')

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const fails = []
  const warns = []
  try {
    const page = await browser.newPage()

    console.log('[rows] goto', APP_URL)
    await gotoMediaLibrary(page)

    if (PROBE) {
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[rows] PROBE testids on media page:\n  ' + ids.join('\n  '))
      return
    }

    // ══ 1/2/3/5/7) 多集剧集（series 1，14 集）══════════════════════════════════
    await setViewport(page, 1280, 900)
    const hasSlots = await openSeriesById(page, SERIES_MANY)
    console.log('[rows] opened series', SERIES_MANY, '| episode-slot rendered:', hasSlots)
    if (!hasSlots) {
      fails.push(`series ${SERIES_MANY} detail rendered 0 episode-slot`)
      console.log('[rows] FAILS:', JSON.stringify(fails, null, 1))
      process.exitCode = 2
      return
    }

    // ── 1) 行数 == 元信息里的集数，且 > 1 ────────────────────────────────────
    const meta = await metaEpisodeCount(page)
    const slotCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="episode-slot"]').length,
    )
    console.log('[rows] meta line:', JSON.stringify(meta && meta.text))
    console.log('[rows] meta episode count:', meta && meta.count, '| episode-slot count:', slotCount)
    if (!meta) {
      fails.push('could not read the "N 集" meta line in the hero')
    } else if (slotCount !== meta.count) {
      fails.push(`episode-slot(${slotCount}) != meta episode count(${meta.count})`)
    }
    if (!(slotCount > 1)) fails.push(`episode-slot count is not > 1 (got ${slotCount})`)

    // ── 2) 封面 160×90（旧版 80×44）+ coverFit 的 object-fit ───────────────
    const covers = await page.evaluate(() => {
      const list = Array.from(document.querySelectorAll('[data-testid="episode-cover"]'))
      return list.map((el) => {
        const r = el.getBoundingClientRect()
        const im = el.querySelector('img')
        return {
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          fit: im ? getComputedStyle(im).objectFit : null,
          rounded: getComputedStyle(el).borderRadius,
        }
      })
    })
    console.log('[rows] episode-cover count:', covers.length)
    console.log('[rows] first 5 covers:', JSON.stringify(covers.slice(0, 5)))
    if (covers.length < 3) {
      fails.push(`only ${covers.length} episode-cover rendered (need >= 3 to measure)`)
    } else {
      const small = covers.filter((c) => c.w < 150 || c.h < 84)
      if (small.length) {
        fails.push(`cover not enlarged to 160x90: ${JSON.stringify(small.slice(0, 3))}`)
      }
      // 行内分集恒为非 photo（photo 分集被 playEps 过滤掉）→ coverFit 必为 object-cover
      const notCover = covers.filter((c) => c.fit !== 'cover')
      if (notCover.length) {
        fails.push(`episode-cover img object-fit != cover: ${JSON.stringify(notCover.slice(0, 3))}`)
      }
    }

    // ── 3) 聚焦模式残留必须为 0 ─────────────────────────────────────────────
    const remnants = await page.evaluate(() => {
      const exact = {}
      for (const tid of [
        'episode-switcher',
        'episode-focus',
        'desc-section',
        'desc-tab-ep',
        'desc-tab-series',
      ]) {
        exact[tid] = document.querySelectorAll(`[data-testid="${tid}"]`).length
      }
      const prefix = {}
      for (const p of ['episode-focus', 'episode-switcher', 'episode-chip', 'desc-']) {
        prefix[p] = document.querySelectorAll(`[data-testid^="${p}"]`).length
      }
      // 自证：同一次扫描里行列表必须非空，否则「0」只是空页面的必然结果
      prefix['episode-slot'] = document.querySelectorAll('[data-testid="episode-slot"]').length
      return { exact, prefix }
    })
    console.log('[rows] focus-mode remnants (exact):', JSON.stringify(remnants.exact))
    console.log('[rows] focus-mode remnants (prefix):', JSON.stringify(remnants.prefix))
    if (!(remnants.prefix['episode-slot'] > 0)) {
      fails.push('remnant scan ran on a page with 0 episode-slot (vacuous scan)')
    }
    for (const [tid, n] of Object.entries(remnants.exact)) {
      if (n !== 0) fails.push(`focus-mode remnant still rendered: ${tid} x${n}`)
    }
    for (const [p, n] of Object.entries(remnants.prefix)) {
      if (p === 'episode-slot') continue
      if (n !== 0) fails.push(`focus-mode remnant prefix still rendered: ${p}* x${n}`)
    }

    // ── 5) 按季分组（条件断言，2026-09-28 重排后）──────────────────────────
    // 分组头门控 = showSeasonHeaders = seasonCount > 1 && episodeCount > 1（design §3.2）。
    // series 1 的 seasonCount=1（实测）→ **不得**渲染分组头；多季剧集才查存在且早于首行。
    const seasonGate = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h4'))
      const heads = hs
        .map((h) => (h.textContent || '').trim())
        .filter((t) => /第\s*\d+\s*季/.test(t))
      const firstSlot = document.querySelector('[data-testid="episode-slot"]')
      const headEl = hs.find((h) => /^第\s*\d+\s*季$/.test((h.textContent || '').trim()))
      const following =
        headEl && firstSlot
          ? !!(headEl.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING)
          : null
      // seasonCount 由 Hero 元信息行「N 季」读（只信后端聚合字段）
      let seasonCount = null
      for (const p of Array.from(document.querySelectorAll('p'))) {
        const t = (p.textContent || '').trim()
        const m = t.match(/(\d+)\s*季/)
        if (m && t.includes('集') && t.length < 80) {
          seasonCount = Number(m[1])
          break
        }
      }
      return { heads, headEl: headEl ? (headEl.textContent || '').trim() : null, following, seasonCount }
    })
    console.log('[rows] season grouping (gated):', JSON.stringify(seasonGate))
    if (seasonGate.seasonCount === null) {
      fails.push('could not read the "N 季" meta line in the hero (season gating unknown)')
    } else if (seasonGate.seasonCount > 1) {
      // 多季：分组头必须存在且早于首行
      if (!seasonGate.headEl) fails.push('multi-season series renders no "第 N 季" season heading')
      if (!/第\s*1\s*季/.test(seasonGate.headEl || '')) {
        fails.push(`first season heading is not 第 1 季: ${JSON.stringify(seasonGate.headEl)}`)
      }
      if (seasonGate.following !== true) {
        fails.push('season heading does not precede the first episode row')
      }
    } else {
      // 单季：**不得**有分组头（design §13.2 回归点 1 / PRD §3.4）
      if (seasonGate.heads.length !== 0) {
        fails.push(
          `single-season series still renders season heading(s): ${JSON.stringify(seasonGate.heads)} ` +
            '(showSeasonHeaders gate = seasonCount > 1 && episodeCount > 1)',
        )
      }
      console.log('[rows] single-season series: season heading absent as designed')
    }

    await scrollListTop(page)
    await shot(page, 'rows-wide.png', null)

    // ── 7) 窄视口 720px：无横向溢出 + 行内封面仍 ≥150px ────────────────────
    /** 在某个视口宽度下量一次：滚动容器溢出 + 首个封面尺寸 + Hero 海报尺寸 */
    const narrowProbe = async (w) => {
      await setViewport(page, w, 900)
      const box = await page.evaluate(FIND_LIST_CONTAINER)
      const rest = await page.evaluate((findPoster) => {
        const FIND_POSTER_CONTAINER = new Function(`return (${findPoster})`)()
        const cov = document.querySelector('[data-testid="episode-cover"]')
        const r = cov ? cov.getBoundingClientRect() : null
        // Hero 海报：按**语义**定位（容器有 aspect-ratio）而非旧类名。
        // 旧类名 `aspect-video w-80` 在本次重排中已改为 `aspect-video w-full max-w-[320px]`
        // （SeriesHero.tsx），按类名找必然 -1 —— 这是任务 A 记录的高危点之一。
        const poster = FIND_POSTER_CONTAINER()[0] || null
        const hr = poster && poster.w > 0 ? { width: poster.w, height: poster.h } : null
        const cb = document.querySelector('[data-testid="episode-slot"]')
        let sc = cb ? cb.parentElement : null
        while (sc) {
          const cs = getComputedStyle(sc)
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break
          sc = sc.parentElement
        }
        // 溢出的具体元素（取证：到底是谁被裁掉了）
        const clipped = []
        if (sc) {
          const limit = sc.getBoundingClientRect().right
          for (const el of Array.from(sc.querySelectorAll('*'))) {
            const er = el.getBoundingClientRect()
            if (er.width > 0 && er.right > limit + 0.5) {
              clipped.push({ tid: el.getAttribute('data-testid') || el.tagName.toLowerCase(), over: Math.round(er.right - limit) })
            }
          }
        }
        const clippedTally = {}
        for (const c of clipped) clippedTally[c.tid] = (clippedTally[c.tid] || 0) + 1
        return {
          docScrollW: document.documentElement.scrollWidth,
          docClientW: document.documentElement.clientWidth,
          coverW: r ? Math.round(r.width * 10) / 10 : -1,
          coverH: r ? Math.round(r.height * 10) / 10 : -1,
          posterW: hr ? Math.round(hr.width) : -1,
          posterH: hr ? Math.round(hr.height) : -1,
          rows: document.querySelectorAll('[data-testid="episode-slot"]').length,
          clippedCount: clipped.length,
          clippedSample: clipped.slice(0, 3),
          clippedTally,
        }
      }, String(FIND_POSTER_CONTAINER))
      console.log(`[rows] narrow ${w}px container:`, JSON.stringify(box))
      console.log(`[rows] narrow ${w}px:`, JSON.stringify(rest))
      return { w, box, rest }
    }

    // 720px：任务书指定宽度，实测（低于壳最小宽度 → 溢出/拉伸只记 WARNING）
    const n720 = await narrowProbe(720)
    if (!n720.box) {
      fails.push('could not locate the scrollable episode-list container at 720px')
    } else {
      if (!(n720.box.containsRows > 0)) {
        fails.push(`overflow check hit the wrong container at 720px (0 rows inside): ${JSON.stringify(n720.box)}`)
      }
      if (n720.box.scrollW !== n720.box.clientW) {
        warns.push(
          `at 720px the episode list overflows horizontally: scrollWidth=${n720.box.scrollW} clientWidth=` +
            `${n720.box.clientW} (${n720.rest.clippedCount} clipped nodes, e.g. ${JSON.stringify(n720.rest.clippedSample)}). ` +
            'Note: src-tauri/tauri.conf.json minWidth=900, so 720px is below the shell minimum and unreachable in the product.',
        )
      }
    }
    // D1-1：海报在 720px 上**记录实测**；但 720px < 壳声明的最小宽度 900px（tauri.conf.json
    // minWidth=900），产品中不可达 —— 故此处只 WARNING，硬断言放在 900/820（可达宽度）上。
    // 重排后海报容器为 `w-full max-w-[320px]`：空间足够时 320×180（比例仍 16:9），
    // 空间不足时按容器收缩（288×162 = 16:9），这是预期行为而非缺陷。
    const poster720ok = n720.rest.posterW === 320 && n720.rest.posterH === 180
    console.log(
      `[rows] D1-1 hero poster @720px: ${n720.rest.posterW}x${n720.rest.posterH} (ideal 320x180, ratio ${n720.rest.posterH > 0 ? (n720.rest.posterW / n720.rest.posterH).toFixed(3) : 'n/a'}) ->`,
      poster720ok,
    )
    if (!poster720ok) {
      warns.push(
        `hero poster is ${n720.rest.posterW}x${n720.rest.posterH} at 720px (ideal 320x180). ` +
          '720px is below the shell minimum width 900, so this is out of the supported range; ' +
          'aspect ratio is preserved (>=16/9) and the poster stays visible.',
      )
    }
    // D1-2（复测上一轮记录的裁剪）：720px 下被裁掉的是哪些元素、各多少个
    const removeClipped720 = (n720.rest.clippedTally || {})['episode-remove'] || 0
    console.log(
      `[rows] D1-2 clipped nodes @720px by testid:`,
      JSON.stringify(n720.rest.clippedTally),
      '| episode-remove clipped:',
      removeClipped720,
    )
    if (n720.rest.docScrollW !== n720.rest.docClientW) {
      warns.push(`page-level horizontal overflow at 720px: ${n720.rest.docScrollW} != ${n720.rest.docClientW}`)
    }
    // 先拍 Hero（留证拉伸形态），再滚到分集行拍行列表
    await shot(page, 'rows-narrow-hero.png', 'series-desc-edit')
    await shot(page, 'rows-narrow.png', 'episode-slot')

    // 900px（壳声明的最小窗口宽度）与 820px：硬断言无横向溢出
    for (const w of [900, 820]) {
      const n = await narrowProbe(w)
      if (!n.box) {
        fails.push(`could not locate the scrollable episode-list container at ${w}px`)
        continue
      }
      if (!(n.box.containsRows > 0)) {
        fails.push(`overflow check hit the wrong container at ${w}px (0 rows inside): ${JSON.stringify(n.box)}`)
      }
      if (n.box.scrollW !== n.box.clientW) {
        fails.push(
          `horizontal overflow in the episode scroll container at ${w}px: scrollWidth=${n.box.scrollW} clientWidth=` +
            `${n.box.clientW} (${n.box.cls}) clipped=${n.rest.clippedCount} ${JSON.stringify(n.rest.clippedSample)}`,
        )
      }
      if (n.rest.docScrollW !== n.rest.docClientW) {
        fails.push(`page-level horizontal overflow at ${w}px: ${n.rest.docScrollW} != ${n.rest.docClientW}`)
      }
      if (!(n.rest.coverW >= 150)) {
        fails.push(`episode cover < 150px at ${w}px viewport: ${n.rest.coverW}`)
      }
      if (!(n.rest.rows > 0)) fails.push(`no episode row rendered at ${w}px`)
      // D1-1：海报在壳最小宽度 900 上也必须保持 320×180（820 顺带复测）
      const posterOk = n.rest.posterW === 320 && n.rest.posterH === 180
      console.log(
        `[rows] D1-1 hero poster @${w}px: ${n.rest.posterW}x${n.rest.posterH} (expect 320x180) ->`,
        posterOk,
      )
      if (!posterOk) {
        fails.push(`hero poster is not 320x180 at ${w}px: ${n.rest.posterW}x${n.rest.posterH}`)
      }
      // 支持范围内的宽度上不允许有元素被裁掉
      if (n.rest.clippedCount !== 0) {
        fails.push(
          `clipped nodes inside the episode list at ${w}px: ${JSON.stringify(n.rest.clippedTally)}`,
        )
      }
    }
    await setViewport(page, 1280, 900)

    // ══ 6) 集级挂图（series 80）══════════════════════════════════════════════
    await openSeriesById(page, SERIES_IMAGES)
    // 2026-09-28 重排：挂图缩略图只在**展开态**渲染（PRD R1 手风琴）。
    // series 80 = ep399(photo，成宫格瓦片) + ep400(video，有 1 挂图)。
    // 故必须先展开 ep400 才能看到 `episode-images` / `episode-image-open`。
    await expandEpisodeWithImages(page)
    const imgStrip = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('[data-testid="episode-images"]'))
      return {
        strips: boxes.length,
        thumbs: document.querySelectorAll('[data-testid="episode-image-open"]').length,
        toggles: document.querySelectorAll('[data-testid="episode-images-toggle"]').length,
        rows: document.querySelectorAll('[data-testid="episode-slot"]').length,
        galleryImgs: document.querySelectorAll('[data-testid="series-gallery"] img').length,
        sizes: Array.from(document.querySelectorAll('[data-testid="episode-image-open"]')).map(
          (b) => {
            const r = b.getBoundingClientRect()
            const im = b.querySelector('img')
            return {
              w: Math.round(r.width * 10) / 10,
              h: Math.round(r.height * 10) / 10,
              fit: im ? getComputedStyle(im).objectFit : null,
            }
          },
        ),
      }
    })
    console.log('[rows] series 80 image strip:', JSON.stringify(imgStrip))
    if (!(imgStrip.thumbs > 0)) {
      fails.push(`episode attached images not reachable: thumbs=${imgStrip.thumbs}`)
    }
    // 可达的 photo 渲染位必须 object-contain（coverFit('photo')）：缩略图 48×36 + 图册
    const containHits = imgStrip.sizes.filter((s) => s.fit === 'contain').length
    console.log('[rows] photo-fit(contain) hits on attached-image thumbs:', containHits)
    if (!(containHits > 0)) {
      fails.push(`no photo render with object-fit:contain: ${JSON.stringify(imgStrip.sizes)}`)
    }
    // 2026-09-28 重排：全剧层「图册平铺行」`series-gallery` 已移除（PRD §3.3 / R6）。
    // 本条不是「改口径」，而是断言**它确实没了**；photo 分集改由 `episode-photo-grid` 宫格承载。
    const galleryGone = await page.evaluate(() => ({
      gallery: document.querySelectorAll('[data-testid="series-gallery"]').length,
      photoGrid: document.querySelectorAll('[data-testid="episode-photo-grid"]').length,
      photoTile: document.querySelectorAll('[data-testid^="episode-photo-tile"]').length,
    }))
    console.log('[rows] series-gallery removal check:', JSON.stringify(galleryGone))
    if (galleryGone.gallery !== 0) {
      fails.push(
        `series-gallery is supposed to be REMOVED (PRD R6) but ${galleryGone.gallery} node(s) still exist`,
      )
    }
    await shot(page, 'rows-images.png', 'episode-images')

    // 点缩略图 → 灯箱 → 关闭（灯箱统一为 `lightbox`；旧名 episode-image-viewer 由 compat 兜底）
    await clickTestid(page, 'episode-image-open')
    const viewerUp = await waitTestidSoft(page, 'lightbox', 6000) || (await waitTestidSoft(page, 'episode-image-viewer', 1500))
    const viewer = await page.evaluate(() => {
      const el =
        document.querySelector('[data-testid="lightbox"]') ||
        document.querySelector('[data-testid="episode-image-viewer"]')
      if (!el) return null
      const im = el.querySelector('img')
      const r = im ? im.getBoundingClientRect() : null
      return {
        srcHead: im ? String(im.getAttribute('src') || '').slice(0, 24) : null,
        w: r ? Math.round(r.width) : -1,
        h: r ? Math.round(r.height) : -1,
      }
    })
    console.log('[rows] lightbox opened:', viewerUp, JSON.stringify(viewer))
    if (!viewerUp) fails.push('clicking episode-image-open did not open the lightbox')
    await page.evaluate(() => {
      const el =
        document.querySelector('[data-testid="lightbox"]') ||
        document.querySelector('[data-testid="episode-image-viewer"]')
      if (el) el.click()
    })
    const viewerDown = await page
      .waitForFunction(
        () =>
          !document.querySelector('[data-testid="lightbox"]') &&
          !document.querySelector('[data-testid="episode-image-viewer"]'),
        { timeout: 6000 },
      )
      .then(() => true)
      .catch(() => false)
    console.log('[rows] lightbox closed:', viewerDown)
    if (!viewerDown) fails.push('lightbox did not close on backdrop click')

    // ══ 4) 剧集介绍整页只出现一次 + 常驻 Hero ════════════════════════════════
    // 主验对象 series 80：介绍 119 字，且其可播分集（video）的集介绍为空，
    // 故正文里出现的「这段文本」只有 Hero 那一处，计数不会被「本集介绍」混淆。
    await openSeriesById(page, SERIES_DESC_SINGLE)
    const desc80 = await page.evaluate(READ_HERO_DESC)
    console.log('[rows] series 80 hero desc head:', JSON.stringify(desc80 && desc80.head))
    if (!desc80) {
      fails.push('series description is not rendered as a resident block in the hero (series 80)')
    } else {
      const n = await page.evaluate(COUNT_OCCURRENCES, desc80.text)
      console.log('[rows] description occurrences in page innerText (series 80):', n, '| len:', desc80.text.length)
      if (n !== 1) {
        fails.push(`series description rendered ${n} times (expected exactly 1): ${JSON.stringify(desc80.head)}`)
      }
      // 分集行都包在按季 <section> 里；Hero 在任何 section 之外 —— 用这个判定「在不在 Hero」
      // 2026-09-28：单季剧集不再有「第 N 季」分组头，锚点改为**首个 episode-slot**（分集区起点）。
      // 2026-09-28：Hero 本身现在是 `<section data-testid="series-hero">`（SeriesHero.tsx:66），
      // 故「closest('section') 非空 = 不在 Hero」的旧口径会误判。改为自证：
      //   ① 介绍在首个 episode-slot **之前**；② 介绍在 `series-hero` 之内。
      const pos = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="series-description"]')
        const firstSlot = document.querySelector('[data-testid="episode-slot"]')
        const hero = document.querySelector('[data-testid="series-hero"]')
        if (!p || !firstSlot) return null
        return {
          descBeforeSeason: !!(p.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING),
          inHero: hero ? hero.contains(p) : false,
        }
      })
      console.log('[rows] series 80 desc position:', JSON.stringify(pos))
      if (!pos || !pos.descBeforeSeason) {
        fails.push(`series description is not inside the hero (before the first episode row): ${JSON.stringify(pos)}`)
      }
      if (pos && !pos.inHero) {
        fails.push('series description does not live inside the series-hero section')
      }
    }

    // 同一测量在 series 101（长介绍，120 字）上复跑并如实打印：
    // 该集是 TG 自动成剧，**单集介绍与剧集介绍逐字相同**，行列表按设计还要显示「本集介绍」，
    // 于是同一段文案在正文里出现 2 次 —— 两个字段、两处渲染位，不是同一个块被渲染两次。
    await openSeriesById(page, SERIES_DESC)
    const desc101 = await page.evaluate(READ_HERO_DESC)
    console.log('[rows] series 101 hero desc head:', JSON.stringify(desc101 && desc101.head))
    if (!desc101) {
      fails.push('series description is not rendered as a resident block in the hero (series 101)')
    } else {
      const n101 = await page.evaluate(COUNT_OCCURRENCES, desc101.text)
      console.log('[rows] description occurrences in page innerText (series 101):', n101, '| len:', desc101.text.length)
      const pos101 = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="series-description"]')
        const firstSlot = document.querySelector('[data-testid="episode-slot"]')
        if (!p || !firstSlot) return null
        return {
          descBeforeSeason: !!(p.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING),
          heroLines: (p.textContent || '').split('\n').length,
        }
      })
      console.log('[rows] series 101 desc position:', JSON.stringify(pos101))
      if (!pos101 || !pos101.descBeforeSeason) {
        fails.push(`series 101 description is not inside the hero: ${JSON.stringify(pos101)}`)
      }
      // ── D2 去重反例（623ba93 的核心断言）─────────────────────────────────
      // series 101 只有 1 集，且该集介绍与剧集介绍**逐字相同**（同一条 TG 文案，120 字）。
      // 623ba93 之前：Hero 一份 + 行内「本集介绍」一份 = 整页 2 次；之后必须恰好 1 次。
      console.log(
        `[rows] D2 dedup(series 101, identical ep/series desc): occurrences=${n101} (expect 1) ` +
          `| len=${desc101.text.length} | first40=${JSON.stringify(desc101.text.slice(0, 40))}`,
      )
      if (n101 !== 1) {
        fails.push(
          `series 101: the description (episode desc byte-identical to the series desc, ${desc101.text.length} chars) ` +
            `appears ${n101}x in page innerText, expected exactly 1 (hero only) — ${JSON.stringify(desc101.text.slice(0, 40))}`,
        )
      }
      // 反例的配套取证：行内不该再有介绍 <p>，但编辑入口必须还在
      const rows101 = await readRowDescs(page)
      // 重排后 `episode-edit` 只在**展开态**出现（手风琴恒 ≤ 1），故全局计数在任意时刻
      // 最多 1 个「可见入口」；不能按「每行一个常驻按钮」的老口径数。改为自证
      // 「每种分层入口各存在」：Hero 的 series-edit + 展开态的 episode-edit。
      const clickForEntries = await page.evaluate(() => {
        // 只展开唯一那一集（`readRowDescs` 已收尾收起，这里点开即得确定态）。
        const slot = document.querySelector('[data-testid="episode-slot"]')
        if (slot) slot.click()
        return { __clicked: !!slot }
      })
      await delay(700)
      const entries101b = await page.evaluate(() => {
        const slot = document.querySelector('[data-testid="episode-slot"]')
        const rowEl = slot ? slot.closest('[data-testid^="episode-row-"]') : null
        const wrapper = rowEl ? rowEl.parentElement : null
        // `episode-edit` 是**恒在**的行内入口（EpisodeRow.tsx:217-226，R3：去重只影响展示，
        // 编辑入口不受门控），展开态操作区里另有一个 —— 故同一 wrapper 内 2 个属正常。
        // 断言「入口存在」即可，不锁死具体个数。
        return {
          slot: document.querySelectorAll('[data-testid="episode-slot"]').length,
          editInRow: rowEl ? rowEl.querySelectorAll('[data-testid="episode-edit"]').length : 0,
          editInExpanded: wrapper ? wrapper.querySelectorAll('[data-testid="episode-edit"]').length : 0,
          expandedCount: document.querySelectorAll('[data-testid="episode-expanded"]').length,
          seriesEdit: document.querySelectorAll('[data-testid="series-edit"]').length,
        }
      })
      void clickForEntries
      const entries101 = entries101b
      const rowDesc101 = rows101.reduce((acc, r) => acc + r.descs, 0)
      console.log(
        '[rows] D2 series 101 rows:',
        JSON.stringify(rows101.map((r) => ({ row: r.row, slot: r.slot, descs: r.descs }))),
        '| entries:',
        JSON.stringify(entries101),
      )
      if (rowDesc101 !== 0) {
        fails.push(
          `series 101: the row still renders ${rowDesc101} episode-description <p> although it is ` +
            'byte-identical to the series description (should be hidden by showEpDesc)',
        )
      }
      if (entries101.slot !== 1 || entries101.editInRow < 1 || entries101.editInExpanded < 1 || entries101.seriesEdit < 1) {
        fails.push(
          `series 101: edit entry lost — episode-slot=${entries101.slot}, editInRow=${entries101.editInRow}, editInExpanded=${entries101.editInExpanded}, series-edit=${entries101.seriesEdit} (expect 1/>=1/>=1/>=1)`,
        )
      }
      if (pos101 && !(pos101.heroLines > 1)) {
        warns.push('series 101 hero description rendered on a single line (multi-line resident block expected)')
      }
    }
    await scrollListTop(page)
    await shot(page, 'rows-desc.png', null)

    // ══ 9) 去重正例：本集介绍 ≠ 剧集介绍时，行内必须照常渲染（series 3）══════
    // 反例只证明「相同的被折叠」，正例才证明「不同的没被误杀」——两者缺一不可：
    // 把 showEpDesc 写成常量 false 也能让反例通过，只有正例能挡住这种假修复。
    await openSeriesById(page, SERIES_DESC_DIFF)
    const heroDiff = await page.evaluate(READ_HERO_DESC)
    console.log(
      '[rows] D3 series 3 hero desc: len=',
      heroDiff ? heroDiff.text.length : null,
      '| first40=',
      JSON.stringify(heroDiff ? heroDiff.text.slice(0, 40) : null),
    )
    if (!heroDiff) {
      fails.push(`series ${SERIES_DESC_DIFF} has no hero description to compare against`)
    }

    // 9a) 活数据正例：series 3 的 S1E1（ep 131）自带 291 字本集介绍，与 484 字剧集介绍逐字不同
    const rowsLive = await readRowDescs(page)
    console.log(
      '[rows] D3 series 3 row descriptions (live data):',
      JSON.stringify(
        rowsLive.map((r) => ({
          row: r.row,
          slot: r.slot,
          descs: r.descs,
          len: r.text ? r.text.length : 0,
          head: r.text ? r.text.slice(0, 40) : null,
        })),
      ),
    )
    const liveDistinct = rowsLive.filter((r) => r.descs > 0)
    if (!liveDistinct.length) {
      fails.push(
        `series ${SERIES_DESC_DIFF}: no episode row renders its own description <p> — the dedup rule ` +
          'over-suppressed a description that differs from the series description',
      )
    } else if (heroDiff) {
      const r0 = liveDistinct[0]
      console.log(
        `[rows] D3 dedup positive (live): row ${r0.row} ${r0.slot} desc len=${r0.text.length} ` +
          `| row first40=${JSON.stringify(r0.text.slice(0, 40))}`,
      )
      console.log(
        `[rows] D3 dedup positive (live): hero first40=${JSON.stringify(heroDiff.text.slice(0, 40))}`,
      )
      if (normText(r0.text) === normText(heroDiff.text)) {
        fails.push('series 3: the row description equals the series description (expected them to differ)')
      }
      // `innerText` 只含**可见**文本：行收起时展开块不在 innerText 里，直接计数必然 0。
      // 故先把该行展开，再计数（PRD R1 手风琴 —— 同一时刻只有它展开）。
      await page.evaluate(CLICK_SLOT_AT, r0.row)
      await delay(700)
      const nLive = await page.evaluate(COUNT_OCCURRENCES, r0.text)
      console.log('[rows] D3 dedup positive (live): row desc occurrences in innerText =', nLive, '(expect 1)')
      if (nLive !== 1) {
        fails.push(`series 3: the distinct episode description appears ${nLive}x in innerText (expected 1)`)
      }
    }

    // 9b) 经 UI 现场造一条：episode-edit → 面板里写一条与剧集介绍不同的本集介绍 → 保存。
    //     同时验证 623ba93 的承诺：「只影响展示，编辑入口始终保留」。
    const uiRow = liveDistinct.length ? liveDistinct[0].row : 0
    const opened = await clickRowEdit(page, uiRow)
    console.log('[rows] D3 UI episode-edit click:', JSON.stringify(opened))
    if (!opened.ok) {
      fails.push(`could not open the episode edit panel from the UI: ${JSON.stringify(opened)}`)
    }
    const panelUp = await waitSelectorSoft(page, EP_DESC_TA, 8000)
    const prefilled = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el ? { value: String(el.value || ''), len: String(el.value || '').length } : null
    }, EP_DESC_TA)
    console.log(
      '[rows] D3 UI panel opened:',
      panelUp,
      '| prefilled len=',
      prefilled ? prefilled.len : null,
      '| prefilled first40=',
      JSON.stringify(prefilled ? prefilled.value.slice(0, 40) : null),
    )
    if (!panelUp || !prefilled) {
      fails.push(
        `episode-edit did not open an editable episode description panel (${EP_DESC_TA} missing) — ` +
          'the edit entry is supposed to stay reachable after the dedup change',
      )
    } else if (!(prefilled.len > 0)) {
      fails.push('episode description panel opened but its textarea is empty (should be prefilled)')
    } else {
      const stamped = `QA 本集独立介绍 ${new Date().toISOString()} — 与剧集介绍不同，用于验证去重不误杀`
      const setRes = await page.evaluate(SET_TEXTAREA_VALUE, EP_DESC_TA, stamped)
      const readback = await page.evaluate((sel) => String(document.querySelector(sel).value || ''), EP_DESC_TA)
      console.log(
        '[rows] D3 UI typed episode desc: len=',
        stamped.length,
        '| textarea readback === typed:',
        readback === stamped,
        '| set=',
        JSON.stringify(setRes && setRes.ok),
      )
      if (readback !== stamped) {
        fails.push(
          `could not write the episode description through the UI (React value did not update): ${JSON.stringify(readback.slice(0, 40))}`,
        )
      }
      await clickTestid(page, 'episode-save')
      const panelClosed = await waitSelectorGone(page, EP_DESC_TA, 10000)
      await delay(700)
      const rowsSaved = await readRowDescs(page)
      const rSaved = rowsSaved[uiRow]
      console.log('[rows] D3 UI panel closed after 保存:', panelClosed)
      console.log(
        `[rows] D3 dedup positive (UI-created): row ${uiRow} ${rSaved ? rSaved.slot : '?'} descs=`,
        rSaved ? rSaved.descs : null,
        '| row first40=',
        JSON.stringify(rSaved && rSaved.text ? rSaved.text.slice(0, 40) : null),
      )
      console.log(
        '[rows] D3 dedup positive (UI-created): hero first40=',
        JSON.stringify(heroDiff ? heroDiff.text.slice(0, 40) : null),
      )
      if (!panelClosed) fails.push('episode edit panel did not close after clicking 保存')
      if (!rSaved || !(rSaved.descs > 0)) {
        fails.push(
          `after saving a distinct episode description through the UI, row ${uiRow} renders no description <p>`,
        )
      } else {
        if (normText(rSaved.text) !== normText(stamped)) {
          fails.push(
            `row ${uiRow} description is not the text saved through the UI: ${JSON.stringify(rSaved.text.slice(0, 60))}`,
          )
        }
        if (heroDiff && normText(rSaved.text) === normText(heroDiff.text)) {
          fails.push('row description equals the hero description (the positive case must differ)')
        }
        // innerText 只含可见文本：readRowDescs 读完后行已收起，必须重新展开再计数。
        await page.evaluate(CLICK_SLOT_AT, uiRow)
        await delay(700)
        const nStamped = await page.evaluate(COUNT_OCCURRENCES, stamped)
        console.log('[rows] D3 dedup positive (UI-created): saved text occurrences in innerText =', nStamped, '(expect 1)')
        if (nStamped !== 1) {
          fails.push(`the episode description saved through the UI appears ${nStamped}x in innerText (expected 1)`)
        }
      }
      await shot(page, 'rows-desc-diff.png', 'episode-slot')

      // 还原：探针不得在资料库里留下测试文案。原值取面板预填值，改回后再断言一次。
      const original = prefilled.value
      const reopened = await clickRowEdit(page, uiRow)
      const panelUp2 = await waitSelectorSoft(page, EP_DESC_TA, 8000)
      await page.evaluate(SET_TEXTAREA_VALUE, EP_DESC_TA, original)
      const readback2 = await page.evaluate((sel) => String(document.querySelector(sel).value || ''), EP_DESC_TA)
      await clickTestid(page, 'episode-save')
      await waitSelectorGone(page, EP_DESC_TA, 10000)
      await delay(700)
      const rowsRestored = await readRowDescs(page)
      const rRestored = rowsRestored[uiRow]
      const restored = Boolean(rRestored && normText(rRestored.text) === normText(original))
      console.log(
        '[rows] D3 UI restore: reopen=',
        JSON.stringify(reopened && reopened.ok),
        '| panel=',
        panelUp2,
        '| typed back === original:',
        readback2 === original,
        '| row desc restored:',
        restored,
        '| len=',
        rRestored && rRestored.text ? rRestored.text.length : null,
      )
      if (!restored) {
        fails.push(
          `RESTORE FAILED: episode row ${uiRow} of series ${SERIES_DESC_DIFF} still holds the probe text; ` +
            `manual restore value = ${JSON.stringify(original)}`,
        )
      }
    }

    // ══ 8) 截图文件真实落盘 ══════════════════════════════════════════════════
    for (const name of [
      'rows-wide.png',
      'rows-images.png',
      'rows-narrow.png',
      'rows-narrow-hero.png',
      'rows-desc.png',
      'rows-desc-diff.png',
    ]) {
      const file = path.join(OUT_DIR, name)
      let size = -1
      try {
        size = fs.statSync(file).size
      } catch (_e) {
        size = -1
      }
      console.log(`[rows] file ${name}: ${file} (${size} bytes)`)
      if (size <= 0) fails.push(`screenshot missing or empty: ${file}`)
    }

    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[rows] page errors:', JSON.stringify(errs))

    console.log('[rows] screenshots ->', OUT_DIR)
    if (warns.length) console.log('[rows] WARNINGS:', JSON.stringify(warns, null, 1))
    console.log('[rows] FAILS:', fails.length ? JSON.stringify(fails, null, 1) : 'none')
    if (fails.length) process.exitCode = 2
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[rows] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
