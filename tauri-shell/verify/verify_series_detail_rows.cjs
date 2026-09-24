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
 *   4. 剧集介绍整页只出现一次且常驻 Hero：正文 innerText 里出现次数 === 1，
 *      且该元素在文档顺序上早于「第 N 季」标题（compareDocumentPosition）；
 *   5. 按季分组：「第 1 季」标题存在且早于第一个 `episode-slot`；
 *   6. 集级挂图仍可达：`episode-images` 缩略图 > 0，点 `episode-image-open` 出
 *      `episode-image-viewer`，再关掉；
 *   7. 窄视口无横向溢出：主滚动容器 scrollWidth === clientWidth，且行内封面仍 ≥150px 宽。
 *      720px 是任务书点名的宽度，但 `src-tauri/tauri.conf.json` 的 `minWidth` = 900 ——
 *      桌面壳最小窗口就是 900px，720 在真实产品里**不可达**。故 720 只实测打印（溢出则记为
 *      WARNING 并附原因），硬断言落在支持范围内的最窄窗口 **900px**（另附 820px 佐证）。
 *
 * 每条断言都打印实测值，且对改版前的代码必然失败（旧版：chip 条/聚焦区/desc tab 非 0、
 * 封面 80×44、介绍不在 Hero、无「第 N 季」分组）。
 *
 * Usage:  node verify/verify_series_detail_rows.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT PROBE(1=只 dump testid)
 * Exit:   0 = 全部通过；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')

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
  await waitTestid(page, 'nav-media', 15000)
  await clickTestid(page, 'nav-media')
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

/** Hero 常驻介绍：与「编辑/添加介绍」按钮同属一个 flex 行的 <p> */
const READ_HERO_DESC = () => {
  const btn = document.querySelector('[data-testid="series-desc-edit"]')
  if (!btn || !btn.parentElement) return null
  const p = btn.parentElement.querySelector('p')
  if (!p) return null
  const text = (p.textContent || '').trim()
  if (!text) return null
  return { text, head: text.slice(0, 40) }
}

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

    // ── 5) 按季分组：「第 1 季」早于第一个分集行 ───────────────────────────
    const season = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('h4'))
      const head = hs.find((h) => /^第\s*\d+\s*季$/.test((h.textContent || '').trim()))
      const firstSlot = document.querySelector('[data-testid="episode-slot"]')
      if (!head || !firstSlot) return null
      const following = !!(head.compareDocumentPosition(firstSlot) & Node.DOCUMENT_POSITION_FOLLOWING)
      return {
        heading: (head.textContent || '').trim(),
        headings: hs.map((h) => (h.textContent || '').trim()).filter((t) => /第\s*\d+\s*季/.test(t)),
        headingBeforeFirstRow: following,
      }
    })
    console.log('[rows] season grouping:', JSON.stringify(season))
    if (!season) {
      fails.push('no "第 N 季" season heading rendered')
    } else {
      if (!/第\s*1\s*季/.test(season.heading)) {
        fails.push(`first season heading is not 第 1 季: ${JSON.stringify(season.heading)}`)
      }
      if (!season.headingBeforeFirstRow) {
        fails.push('season heading does not precede the first episode row')
      }
    }

    await scrollListTop(page)
    await shot(page, 'rows-wide.png', null)

    // ── 7) 窄视口 720px：无横向溢出 + 行内封面仍 ≥150px ────────────────────
    /** 在某个视口宽度下量一次：滚动容器溢出 + 首个封面尺寸 + Hero 海报尺寸 */
    const narrowProbe = async (w) => {
      await setViewport(page, w, 900)
      const box = await page.evaluate(FIND_LIST_CONTAINER)
      const rest = await page.evaluate(() => {
        const cov = document.querySelector('[data-testid="episode-cover"]')
        const r = cov ? cov.getBoundingClientRect() : null
        // Hero 海报（w-80 + aspect-video）：窄窗口下 flex 拉伸会把 aspect-ratio 打掉
        const hd = Array.from(document.querySelectorAll('div')).find((d) =>
          /aspect-video w-80/.test(String(d.className)),
        )
        const hr = hd ? hd.getBoundingClientRect() : null
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
        }
      })
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
      if (n720.rest.posterH > 200) {
        warns.push(
          `at 720px the hero poster is stretched to ${n720.rest.posterW}x${n720.rest.posterH} ` +
            '(aspect-video defeated by flex align-stretch once the right column grows taller) — below minWidth 900.',
        )
      }
    }
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
      // 支持范围内的最窄窗口上，Hero 海报必须保持 320×180（不被拉伸）
      if (w === 900 && !(n.rest.posterW >= 300 && n.rest.posterH >= 170 && n.rest.posterH <= 190)) {
        fails.push(`hero poster not 320x180 at 900px: ${n.rest.posterW}x${n.rest.posterH}`)
      }
      if (w === 820 && n.rest.posterH > 200) {
        warns.push(
          `at 820px (still below minWidth 900) the hero poster is stretched to ${n.rest.posterW}x${n.rest.posterH}`,
        )
      }
    }
    await setViewport(page, 1280, 900)

    // ══ 6) 集级挂图（series 80）══════════════════════════════════════════════
    await openSeriesById(page, SERIES_IMAGES)
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
    const galleryFit = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="series-gallery"] img')).map(
        (im) => getComputedStyle(im).objectFit,
      ),
    )
    console.log('[rows] series gallery img object-fit:', JSON.stringify(galleryFit))
    if (galleryFit.length && !galleryFit.includes('contain')) {
      fails.push(`series gallery photo not object-contain: ${JSON.stringify(galleryFit)}`)
    }
    await shot(page, 'rows-images.png', 'episode-images')

    // 点缩略图 → 灯箱 → 关闭
    await clickTestid(page, 'episode-image-open')
    const viewerUp = await waitTestidSoft(page, 'episode-image-viewer', 6000)
    const viewer = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="episode-image-viewer"]')
      if (!el) return null
      const im = el.querySelector('img')
      const r = im ? im.getBoundingClientRect() : null
      return {
        srcHead: im ? String(im.getAttribute('src') || '').slice(0, 24) : null,
        w: r ? Math.round(r.width) : -1,
        h: r ? Math.round(r.height) : -1,
      }
    })
    console.log('[rows] episode-image-viewer opened:', viewerUp, JSON.stringify(viewer))
    if (!viewerUp) fails.push('clicking episode-image-open did not open episode-image-viewer')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="episode-image-viewer"]')
      if (el) el.click()
    })
    const viewerDown = await page.waitForFunction(
      () => !document.querySelector('[data-testid="episode-image-viewer"]'),
      { timeout: 6000 },
    ).then(() => true).catch(() => false)
    console.log('[rows] episode-image-viewer closed:', viewerDown)
    if (!viewerDown) fails.push('episode-image-viewer did not close on backdrop click')

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
      const pos = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="series-desc-edit"]')
        const p = btn && btn.parentElement ? btn.parentElement.querySelector('p') : null
        const head = Array.from(document.querySelectorAll('h4')).find((h) =>
          /第\s*\d+\s*季/.test((h.textContent || '').trim()),
        )
        if (!p || !head) return null
        return {
          descBeforeSeason: !!(p.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING),
          inSeasonSection: !!p.closest('section'),
        }
      })
      console.log('[rows] series 80 desc position:', JSON.stringify(pos))
      if (!pos || !pos.descBeforeSeason) {
        fails.push(`series description is not inside the hero (before 第 N 季): ${JSON.stringify(pos)}`)
      }
      if (pos && pos.inSeasonSection) {
        fails.push('series description sits inside a season <section>, not the hero')
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
        const btn = document.querySelector('[data-testid="series-desc-edit"]')
        const p = btn && btn.parentElement ? btn.parentElement.querySelector('p') : null
        const head = Array.from(document.querySelectorAll('h4')).find((h) =>
          /第\s*\d+\s*季/.test((h.textContent || '').trim()),
        )
        if (!p || !head) return null
        return {
          descBeforeSeason: !!(p.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING),
          heroLines: (p.textContent || '').split('\n').length,
        }
      })
      console.log('[rows] series 101 desc position:', JSON.stringify(pos101))
      if (!pos101 || !pos101.descBeforeSeason) {
        fails.push(`series 101 description is not inside the hero: ${JSON.stringify(pos101)}`)
      }
      if (n101 !== 1) {
        warns.push(
          `series 101: description text appears ${n101}x in page innerText — its single episode's ` +
            'description is byte-identical to the series description (same TG caption), and the row ' +
            'renders 本集介绍 by design. Two fields, two places: not the same block rendered twice.',
        )
      }
      if (pos101 && !(pos101.heroLines > 1)) {
        warns.push('series 101 hero description rendered on a single line (multi-line resident block expected)')
      }
    }
    await scrollListTop(page)
    await shot(page, 'rows-desc.png', null)

    // ══ 8) 截图文件真实落盘 ══════════════════════════════════════════════════
    for (const name of [
      'rows-wide.png',
      'rows-images.png',
      'rows-narrow.png',
      'rows-narrow-hero.png',
      'rows-desc.png',
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
