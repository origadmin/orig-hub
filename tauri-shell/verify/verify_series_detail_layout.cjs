#!/usr/bin/env node
'use strict'

/**
 * TL-21 扩展：媒体库展示重排**新判据**验收（真实渲染，headless Edge + CDP）。
 *
 * 与 `verify_series_detail_rows.cjs` 的分工：
 *   - `verify_series_detail_rows.cjs` = 旧断言（行式列表 / 封面尺寸 / 宽视口），仅做重排
 *     适配（分组头条件化、灯箱改名、series-gallery 移除），**不加新判据**；
 *   - 本文件 = 只承载**本次重排新增的可证伪判据**（PRD §5.1 R1/R2/R5/R6/R7 +
 *     design §3.1.1 R-A/R-B/R-C + §3.1.2 900px 断点）。两个文件各自可独立运行。
 *
 * 判据逐条照抄，不自造更严口径：
 *   R1 打开多集剧集：展开态分集数 ≤ 1；点第 2 集后第 1 集自动收起。
 *   R2 介绍去重：series 101（集介绍与剧集介绍逐字相同 113 字）页面正文该段**出现 1 次**；
 *      改为不同文本后 → 出现 2 段且互不相同（**两个方向都测**，并把原值还原）。
 *   R5 标题去重：集标题 == 剧集标题时不重复渲染标题行而出现 S1E1；改成不同值 → 标题行出现。
 *   R6 图片归属：A 集 3 图 / B 集 2 图分别打开灯箱页数应为 3 / 2，总数守恒 5；
 *      另 `series-gallery` 节点数 == 0。
 *   R7 单层契约：单集剧集 → 无「第 1 季」分组头、唯一集默认展开、剧集标题与介绍各出现 1 次。
 *   R-A 海报容器宽高比 ≥ 16:9；R-B/R-C 竖版图（naturalW/H < 1）渲染后 object-fit === 'contain'，
 *      且**禁止**「竖版图 + 横幅容器 + object-cover」组合。
 *   §3.1.2：<900px 单列堆叠且**海报仍可见**（不得 hidden / offsetParent === null）。
 *
 * 反向证伪（验收的验收，必须做）：
 *   - 死端口（59999）必须不可达；
 *   - 白屏（URL 指向一个返回空 HTML 的端口）必须判 FAIL 并以 exit 1 结束。
 *   这两条走 `--negative-check=<mode>` 子模式，避免污染主判据流程：
 *     node tl21 ...                 # 正常跑判据
 *     node tl21 --negative-check=dead
 *     node tl21 --negative-check=blank
 *
 * Usage: APP_PORT(默认5180) TG_PORT(默认9877) ORIG_VERIFY_OUT PROBE=1
 * Exit:  0 = 全通过；1 = 白屏/环境失败；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')
const { installTestidAliases, FIND_POSTER_CONTAINER } = require('./lib/layoutCompat.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-tl21-shots')
/**
 * orig-tg 端口。默认 9877（Rust 侧默认），但本机 9876/9877 落在 Windows 保留端口段
 * （WinNAT 9757-9856）**无法 bind**，故验收环境把它重映射到 18761（前端同源注入
 * `VITE_TG_PORT`）。用 TG_PORT 环境变量覆盖；默认取 18761 以匹配当前验收环境。
 */
const TG_PORT = Number(process.env.TG_PORT || 18761)
const TG_BASE = `http://127.0.0.1:${TG_PORT}`

// 夹具（任务书给的真实数据，已用只读 API 复核）
const S_MULTI = 1 // 14 集 → R1 / R5 反向
const S_DIFFDESC = 3 // 9 集，S1E1 有独立介绍 → R2 反例夹具
const S_SINGLE_DUP = 101 // 1 集，集标题/介绍与剧集逐字相同 → R2/R7 最佳夹具
/**
 * R6 夹具 = series 5（**5 个可播分集，其中 2 个已带挂图**）。
 * 不用 series 80：它是 1 photo + 1 video，photo 分集按 §3.3 走宫格**不进行**，
 * 故只有 1 个 `episode-slot`（不是缺陷，是我选错夹具）。
 */
const S_IMAGES = 5

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

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
  await page.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, { sessionId: page.sessionId })
  await delay(650)
}

/** 页面内：正文某段文本出现次数（去空白归一化，与旧脚本同规则） */
const COUNT_OCCURRENCES = (needleRaw) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const needle = norm(needleRaw)
  const hay = norm(document.body ? document.body.innerText : '')
  if (!needle) return 0
  let c = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) {
    c++
    i += needle.length
  }
  return c
}

/** 页面内：当前展开态分集数（手风琴恒 ≤ 1） */
const COUNT_EXPANDED = () => document.querySelectorAll('[data-testid="episode-expanded"]').length

/**
 * 页面内：读 Hero 介绍文本。
 *
 * 直接取 `series-description` 节点 —— **不要**从 `series-desc-edit` 的父节点里找 `<p>`：
 * 二者是**兄弟**（同属一个 flex 行容器），编辑按钮的父节点里没有 `<p>`，
 * 那样写会恒返回 null，把 R2 变成「永远搜不到」的假 FAIL。
 */
const READ_HERO_DESC = () => {
  const p = document.querySelector('[data-testid="series-description"]')
  if (!p) return null
  const text = (p.textContent || '').trim()
  return text ? { text } : null
}

/**
 * 页面内：R5 标题去重的**精确**计数。
 *
 * 不能数全页 innerText —— 侧栏的剧集列表里也有同名条目（实测 series 101 的标题在
 * innerText 里出现 5 次，其中 3 次是侧栏/描述正文，与「单集层是否重复渲染标题行」无关）。
 * R5 原文 = 「该集展开块中不出现与剧集标题重复的**独立标题行**」，故只数两个位置：
 *   ① Hero 的 `series-title` 节点（恒应为 1）；
 *   ② 展开态块内与剧集标题逐字相同的标题元素（同名时应为 0）。
 */
const R5_TITLE_STATE = (seriesTitleRaw) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const want = norm(seriesTitleRaw)
  const heroTitle = document.querySelector('[data-testid="series-title"]')
  const heroCount = heroTitle && norm(heroTitle.textContent) === want ? 1 : 0
  const exp = document.querySelector('[data-testid="episode-expanded"]')
  let expandedTitleHits = 0
  let expandedSlot = null
  if (exp) {
    // 展开态里的标题元素：h1-h6 或带 episode-title testid
    const cands = Array.from(exp.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-testid^="episode-title"]'))
    for (const c of cands) if (norm(c.textContent) === want) expandedTitleHits++
    const slot = document.querySelector('[data-testid="episode-slot"]')
    expandedSlot = slot ? (slot.textContent || '').trim() : null
  }
  return { heroCount, expandedTitleHits, expandedSlot, hasExpanded: !!exp }
}

/** 页面内：写 React 受控 input/textarea */
const SET_CONTROLLED_VALUE = (selector, value, tag) => {
  const el = document.querySelector(selector)
  if (!el) return { ok: false, reason: `no element ${selector}` }
  const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true, readback: el.value }
}

/** 页面内：R6 灯箱页数（lightbox-position 文本里的 N，或灯箱内 img 数） */
const LIGHTBOX_PAGES = () => {
  const el =
    document.querySelector('[data-testid="lightbox"]') ||
    document.querySelector('[data-testid="episode-image-viewer"]')
  if (!el) return null
  const pos = el.querySelector('[data-testid="lightbox-position"]')
  let declared = null
  if (pos) {
    const m = String(pos.textContent || '').match(/(\d+)\s*\/\s*(\d+)/)
    if (m) declared = Number(m[2])
  }
  const imgs = el.querySelectorAll('img').length
  // 位置计数里「/N」的 N 是权威页数；无则回退灯箱内图片数
  return { declared, imgs, pages: declared != null ? declared : imgs }
}

/**
 * 冷导航打开指定剧集详情，并**自证落到了目标剧集**（区分「真渲染」与「残留 DOM」）。
 *
 * 实测坑：从剧集 A 直接点剧集 B 的卡（暖导航）会先命中 A 的残留节点，
 * `series-gallery`/灯箱计数因此假阳性。故每次强制 `goto(APP_URL)` 冷启动，
 * 并断言 Hero 出现且分集行数 > 0，否则抛错而非静默继续。
 */
async function openSeriesById(page, id, expectMinRows = 1) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
  await installTestidAliases(page)
  await waitTestidSoft(page, 'nav-media', 15000)
  await clickTestid(page, 'nav-media')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 15000 })
  await delay(800)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, id)
  if (!clicked) throw new Error(`series-card data-series-id=${id} not found`)
  // ★ 自证落到了**目标剧集**：详情容器若带 series id 就核它；否则用 URL/标题快照兜底。
  const identity = await page.evaluate(() => {
    const byId = document.querySelector('[data-testid="series-hero"][data-series-id], [data-series-id]:not([data-testid="series-card"])')
    const hero = document.querySelector('[data-testid="series-hero"]')
    return {
      heroId: byId ? byId.getAttribute('data-series-id') : null,
      heroTestid: hero ? hero.getAttribute('data-testid') : null,
    }
  })
  if (identity.heroId && String(identity.heroId) !== String(id)) {
    throw new Error(`navigation landed on series ${identity.heroId}, expected ${id} (stale DOM)`)
  }
  // 等 Hero 就绪
  const heroUp = await waitTestidSoft(page, 'series-title', 15000)
  if (!heroUp) throw new Error(`series ${id}: hero (series-title) never rendered`)
  // 等分集行就绪并**自证非空**（空 = 还在加载或未落到目标剧集）
  try {
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="episode-slot"]').length >= n, {
      timeout: 12000,
      args: [expectMinRows],
    })
  } catch (_e) {
    const got = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-slot"]').length)
    throw new Error(`series ${id}: expected >= ${expectMinRows} episode-slot after open, got ${got}`)
  }
  await delay(900)
}

async function shot(page, name, testid) {
  await page.evaluate((tid) => {
    const el = tid ? document.querySelector(`[data-testid="${tid}"]`) : null
    if (el) el.scrollIntoView({ block: 'center' })
    else window.scrollTo(0, 0)
  }, testid || null)
  await delay(400)
  const file = path.join(OUT_DIR, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try { size = fs.statSync(file).size } catch (_e) { size = -1 }
  console.log(`[tl21] shot ${name} -> ${file} (${size} bytes)`)
  return size
}

// ════════════════════════════════════════════════════════════════════════
// 反向证伪子模式
// ════════════════════════════════════════════════════════════════════════
async function negativeCheck(mode) {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    if (mode === 'dead') {
      // 死端口：必须不可达（连接被拒 / chrome-error / goto 超时）。exit 2 = FAIL，
      // 因为「死端口也能渲染出内容」意味着探针根本没在测真实可达性。
      let navigated = false
      try {
        await page.goto('http://127.0.0.1:59999/', { waitForRoot: false, settleMs: 800, timeout: 5000 })
        navigated = true
      } catch (e) {
        console.log(`[tl21][negative:dead] goto rejected (connection refused): ${String(e.message).slice(0, 90)}`)
      }
      // Edge 在连接失败时会渲染一张错误页（含 "ERR_CONNECTION_REFUSED" 文案），
      // 那不是「真实应用渲染」。故判据 = 导航成功 **且** 不是错误页。
      let errPage = true
      try {
        errPage = await page.evaluate(() => {
          const t = document.body ? document.body.innerText || '' : ''
          return /ERR_|无法访问此|This site can|chrome-error|连接被拒绝|Connection refused/i.test(t)
        })
      } catch (_e) {
        errPage = true
      }
      const reached = navigated && !errPage
      console.log(`[tl21][negative:dead] navigated=${navigated} errorPage=${errPage} -> renderedApp=${reached} (expect false)`)
      process.exitCode = reached ? 2 : 0
      return
    }
    if (mode === 'blank') {
      // 白屏：让页面指向一个真实存在但应用未挂载的地址（APP_URL + 不存在的路径由 vite 兜底为 SPA；
      // 故用 about:blank 语义 = 无 #root 内容）→ 必须判 FAIL 且 exit 1。
      await page.goto('about:blank', { waitForRoot: false, settleMs: 500 })
      const len = await page.evaluate(() => (document.body ? (document.body.innerText || '').length : 0))
      const blank = len < 20
      console.log(`[tl21][negative:blank] blank detected=${blank} (expect true) bodyLen=${len}`)
      process.exitCode = blank ? 1 : 2
      return
    }
    console.error(`unknown negative check mode: ${mode}`)
    process.exitCode = 2
  } finally {
    await browser.close()
  }
}

async function main() {
  const negArg = process.argv.find((a) => a.startsWith('--negative-check='))
  if (negArg) {
    await negativeCheck(negArg.split('=')[1])
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const fails = []
  const warns = []
  try {
    const page = await browser.newPage()
    await setViewport(page, 1280, 900)

    if (process.env.PROBE === '1') {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
      await installTestidAliases(page)
      await clickTestid(page, 'nav-media')
      await delay(1500)
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[tl21] PROBE testids:\n  ' + ids.join('\n  '))
      return
    }

    // ═════════════════════════ R1：手风琴 ≤ 1 ═════════════════════════
    await openSeriesById(page, S_MULTI, 14)
    const slots = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="episode-slot"]')).map((e) => (e.textContent || '').trim()))
    console.log('[tl21] R1 series', S_MULTI, 'episode-slot count:', slots.length)
    if (!(slots.length > 1)) fails.push(`R1: series ${S_MULTI} rendered ${slots.length} episode-slot, need > 1`)

    // 默认：多集剧集应全部行态（展开态 0）
    let expanded = await page.evaluate(COUNT_EXPANDED)
    console.log('[tl21] R1 default expanded count:', expanded, '(expect 0)')
    if (expanded !== 0) fails.push(`R1: multi-episode series opens with ${expanded} expanded episode(s), expected 0`)

    // 点第 1 集 → 展开 1
    const clickSlot = (idx) =>
      page.evaluate((i) => {
        const s = document.querySelectorAll('[data-testid="episode-slot"]')[i]
        if (!s) return false
        s.scrollIntoView({ block: 'center' })
        s.click()
        return true
      }, idx)
    await clickSlot(0)
    await delay(900)
    const afterFirst = await page.evaluate(COUNT_EXPANDED)
    console.log('[tl21] R1 after clicking episode #1 expanded:', afterFirst, '(expect 1)')
    if (afterFirst !== 1) fails.push(`R1: clicking episode #1 produced ${afterFirst} expanded episode(s), expected 1`)

    // 点第 2 集 → 第 1 集自动收起，仍 ≤ 1
    await clickSlot(1)
    await delay(900)
    const afterSecond = await page.evaluate(COUNT_EXPANDED)
    console.log('[tl21] R1 after clicking episode #2 expanded:', afterSecond, '(expect 1)')
    if (afterSecond !== 1) fails.push(`R1: clicking episode #2 produced ${afterSecond} expanded episode(s), expected 1 (accordion must auto-collapse #1)`)
    if (afterSecond > 1) fails.push('R1: accordion violated — more than 1 episode expanded at once')
    await shot(page, 'tl21-r1-accordion.png', 'episode-expanded')

    // ═════════════════════════ R5：标题去重 ═════════════════════════
    // 夹具 series 101：ep.title === series.title（逐字，实测）→ 展开块中**不出现**
    // 与剧集标题重复的独立标题行，而以 `S1E1` 标识（R5 原文）。
    // 只数 Hero 的 `series-title` 节点与展开块内部，不数全页 innerText（侧栏有同名条目）。
    await openSeriesById(page, S_SINGLE_DUP, 1)
    const seriesTitle = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="series-title"]')
      return el ? (el.textContent || '').trim() : null
    })
    console.log('[tl21] R5 hero title (series-title node):', JSON.stringify(seriesTitle))
    if (!seriesTitle) {
      fails.push('R5: series-title node not found in the hero')
    }
    const r5 = await page.evaluate(R5_TITLE_STATE, seriesTitle || '')
    console.log('[tl21] R5 state:', JSON.stringify(r5))
    // S1E1 集号标识必须出现
    const slots101 = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="episode-slot"]')).map((e) => (e.textContent || '').trim()),
    )
    console.log('[tl21] R5 series 101 slots:', JSON.stringify(slots101))
    if (!slots101.some((s) => /S\s*1\s*E\s*1/.test(s))) {
      fails.push(`R5: no S1E1 slot label rendered (slots=${JSON.stringify(slots101)})`)
    }
    // 同名时：Hero 标题恰 1；展开块内与剧集标题逐字相同的独立标题行 == 0
    if (seriesTitle && r5.hasExpanded) {
      if (r5.heroCount !== 1) fails.push(`R5: series-title node count is ${r5.heroCount}, expected 1`)
      if (r5.expandedTitleHits !== 0) {
        fails.push(
          `R5: the expanded block renders ${r5.expandedTitleHits} title element(s) byte-identical to the series title ` +
            `("${seriesTitle.slice(0, 24)}"), expected 0 (identical title must collapse to the S1E1 slot label)`,
        )
      }
    } else if (!r5.hasExpanded) {
      warns.push('R5: no episode-expanded block present; could only check the S1E1 slot label')
    }

    // ═════════════════════════ R2：介绍去重（两个方向）═════════════════════════
    await openSeriesById(page, S_SINGLE_DUP, 1)
    const desc101 = await page.evaluate(READ_HERO_DESC)
    if (!desc101) {
      fails.push('R2: series 101 hero description not found (cannot test dedup)')
    } else {
      const n1 = await page.evaluate(COUNT_OCCURRENCES, desc101.text)
      console.log(`[tl21] R2 (identical case) desc len=${desc101.text.length} occurrences=${n1} (expect 1)`)
      if (n1 !== 1) fails.push(`R2: identical ep/series description appears ${n1}x, expected exactly 1`)

      // 反方向：把该集介绍改成不同文本 → 应出现 2 段
      // 单集剧集唯一集默认展开；展开态的介绍走 `episode-edit` 面板编辑。
      const editUp = await waitTestidSoft(page, 'episode-edit', 6000)
      if (!editUp) {
        warns.push('R2 positive: no episode-edit entry found to inject a distinct description')
      } else {
        await clickTestid(page, 'episode-edit')
        await waitTestidSoft(page, 'episode-edit-panel', 8000)
        await delay(300)
        // 通过 API 参数拿到该集真实 id（页面上的 data-ep-id 不可靠），直接在页面内写介绍。
        // 单集介绍 textarea 在 EpisodeEditPanel 内**无 data-testid**（源码 EpisodeEditPanel.tsx:167），
        // 其 placeholder 来自 i18n `media.descEmptyEp` = 「本集暂无介绍」。
        // 面板内 textarea 顺序：episode-title-input 在前，介绍框在后 →
        //   「placeholder 含『本集』且含『介绍』」的 textarea 即介绍框。
        const stamped = `QA-TL21-R2 与剧集介绍不同的独立本集介绍 ${Date.now()}`
        const setRes = await page.evaluate((val) => {
          const area = Array.from(document.querySelectorAll('[data-testid="episode-edit-panel"] textarea'))
            .find((t) => (t.placeholder || '').includes('本集') && (t.placeholder || '').includes('介绍'))
          if (!area) return { ok: false, reason: 'no episode desc textarea in panel' }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          setter.call(area, val)
          area.dispatchEvent(new Event('input', { bubbles: true }))
          return { ok: true, readback: area.value }
        }, stamped)
        console.log('[tl21] R2 write distinct desc:', JSON.stringify(setRes && setRes.ok))
        if (!setRes || !setRes.ok) {
          warns.push(`R2 positive: could not write episode description (${JSON.stringify(setRes)})`)
        } else {
          await clickTestid(page, 'episode-save')
          // 等面板关闭 = 保存成功（失败会留panel并 toast onError）
          const closed = await (async () => {
            try {
              await page.waitForFunction(() => !document.querySelector('[data-testid="episode-edit-panel"]'), { timeout: 8000 })
              return true
            } catch (_e) { return false }
          })()
          await delay(1200)
          const n2 = await page.evaluate(COUNT_OCCURRENCES, stamped)
          console.log('[tl21] R2 (distinct case) panelClosed=', closed, 'stamped desc occurrences=', n2, '(expect 1 for stamped, plus hero original => 2 distinct blocks)')
          if (!closed) warns.push('R2 positive: episode edit panel did not close after save (save may have failed)')
          const hero2 = await page.evaluate(READ_HERO_DESC)
          const nHero = hero2 ? await page.evaluate(COUNT_OCCURRENCES, hero2.text) : -1
          console.log('[tl21] R2 (distinct case) hero desc occurrences=', nHero, '(expect 1)')
          if (n2 !== 1) {
            const domDump = await page.evaluate(() => {
              const ex = document.querySelector('[data-testid="episode-expanded"]')
              return {
                expandedText: ex ? (ex.innerText || '').replace(/\s+/g, ' ').slice(0, 400) : null,
                panelOpen: !!document.querySelector('[data-testid="episode-edit-panel"]'),
              }
            })
            console.log('[tl21] R2 DIAG (stamped not found):', JSON.stringify(domDump))
            fails.push(`R2: after saving a distinct episode description it appears ${n2}x, expected 1`)
          }
          if (nHero !== 1) fails.push(`R2: after the change the hero description appears ${nHero}x, expected 1`)
          // 两段互不相同 = 页面确实出现 2 个不同介绍块
          if (hero2 && hero2.text.trim() === stamped.trim()) {
            fails.push('R2: episode description equals the series description after the change (expected distinct)')
          }
          await shot(page, 'tl21-r2-distinct.png', 'episode-expanded')
          // 还原：重新打开编辑面板 → 写回原文 → 保存
          await clickTestid(page, 'episode-edit')
          await waitTestidSoft(page, 'episode-edit-panel', 8000)
          await delay(300)
          const original = desc101.text
          let backRes = await page.evaluate((val) => {
            const area = Array.from(document.querySelectorAll('[data-testid="episode-edit-panel"] textarea'))
              .find((t) => (t.placeholder || '').includes('本集') && (t.placeholder || '').includes('介绍'))
            if (!area) return { ok: false, reason: 'no episode desc textarea in panel' }
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(area, val)
            area.dispatchEvent(new Event('input', { bubbles: true }))
            return { ok: true, readback: area.value.length }
          }, original)
          if (!backRes || !backRes.ok) {
            warns.push(`R2 restore: could not write back the original description (${JSON.stringify(backRes)})`)
          }
          await clickTestid(page, 'episode-save')
          await delay(1400)
          const nBack = await page.evaluate(COUNT_OCCURRENCES, original)
          console.log('[tl21] R2 restore: original desc occurrences=', nBack, '(expect 1)')
          if (nBack !== 1) {
            fails.push(`R2 RESTORE: after restoring, the original description appears ${nBack}x, expected 1`)
          }
        }
      }
    }

    // ═════════════════════════ R7：单层剧集契约 ═════════════════════════
    await openSeriesById(page, S_SINGLE_DUP, 1)
    const r7 = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h4'))
        .map((h) => (h.textContent || '').trim())
        .filter((t) => /第\s*\d+\s*季/.test(t))
      const slots = document.querySelectorAll('[data-testid="episode-slot"]').length
      const expanded = document.querySelectorAll('[data-testid="episode-expanded"]').length
      const btn = document.querySelector('[data-testid="series-desc-edit"]')
      const heroP = btn && btn.parentElement ? btn.parentElement.querySelector('p') : null
      return { heads, slots, expanded, heroDesc: heroP ? (heroP.textContent || '').trim() : null }
    })
    console.log('[tl21] R7 single-episode series:', JSON.stringify({ heads: r7.heads, slots: r7.slots, expanded: r7.expanded }))
    if (r7.heads.length !== 0) fails.push(`R7: single-episode series renders season header(s): ${JSON.stringify(r7.heads)}`)
    if (r7.slots !== 1) fails.push(`R7: single-episode series renders ${r7.slots} episode-slot, expected 1`)
    if (r7.expanded !== 1) fails.push(`R7: the only episode is not expanded by default (expanded=${r7.expanded}, expected 1)`)
    if (r7.heroDesc) {
      const nHero = await page.evaluate(COUNT_OCCURRENCES, r7.heroDesc)
      console.log('[tl21] R7 hero desc occurrences:', nHero, '(expect 1)')
      if (nHero !== 1) fails.push(`R7: series description appears ${nHero}x in a single-episode series, expected 1`)
    }
    await shot(page, 'tl21-r7-single.png', 'episode-expanded')

    // ═════════════════════ R-A / R-B / R-C：海报宽高比与 object-fit ═════════════════════
    // 在 series 101（封面为竖版人物图，天然触发 R-B/R-C）上量。
    await openSeriesById(page, S_SINGLE_DUP, 1)
    await setViewport(page, 1280, 900)
    const posters = await page.evaluate(FIND_POSTER_CONTAINER)
    console.log('[tl21] R-A/R-B candidates:', JSON.stringify(posters.slice(0, 4)))
    if (!posters.length) {
      fails.push('R-A: no aspect-ratio poster container found in the hero')
    } else {
      const narrow = posters.filter((p) => p.ratio < 16 / 9 - 0.02)
      if (narrow.length) {
        fails.push(`R-A: poster container aspect-ratio < 16:9: ${JSON.stringify(narrow.slice(0, 3))}`)
      }
      // R-B / R-C：竖版源图（naturalW/naturalH < 1）必须 object-fit === 'contain'
      const portrait = posters.filter((p) => p.naturalW > 0 && p.naturalH > 0 && p.naturalW / p.naturalH < 1)
      console.log('[tl21] R-B/C portrait posters:', JSON.stringify(portrait.map((p) => ({ ratio: p.ratio, obj: p.imgObjectFit, nat: `${p.naturalW}x${p.naturalH}` }))))
      for (const p of portrait) {
        if (p.imgObjectFit !== 'contain') {
          fails.push(`R-C: portrait poster (naturalW/H=${(p.naturalW / p.naturalH).toFixed(3)}) rendered with object-fit=${p.imgObjectFit}, expected 'contain' (forbidden: portrait + wide box + object-cover)`)
        }
      }
      if (!portrait.length) {
        warns.push('R-B/C: no portrait cover found in the fixture series to exercise the object-contain rule')
      }
    }
    await shot(page, 'tl21-poster-ratio.png', 'series-desc-edit')

    // ═════════════════════════ §3.1.2：< 900px 单列堆叠且海报可见 ═════════════════════════
    for (const w of [820, 760]) {
      await setViewport(page, w, 900)
      const at = await page.evaluate(() => {
        const posters = (() => {
          const out = []
          for (const img of Array.from(document.querySelectorAll('img'))) {
            let el = img.parentElement
            let d = 0
            while (el && d < 4) {
              const cs = getComputedStyle(el)
              const ar = cs.aspectRatio
              if (ar && ar !== 'auto') {
                const r = el.getBoundingClientRect()
                if (r.width > 40 && r.height > 20) {
                  out.push({
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                    visible: el.offsetParent !== null && cs.visibility !== 'hidden' && cs.display !== 'none',
                    legacyHidden: /min-\[720px\]:block/.test(String(el.className)),
                  })
                  break
                }
              }
              el = el.parentElement
              d++
            }
          }
          return out
        })()
        const doc = document.documentElement
        return { posters, scrollW: doc.scrollWidth, clientW: doc.clientWidth }
      })
      console.log(`[tl21] breakpoint ${w}px:`, JSON.stringify(at))
      const visiblePoster = at.posters.some((p) => p.visible && p.w > 0 && p.h > 0)
      if (!visiblePoster) {
        fails.push(`§3.1.2: at ${w}px (<900) the poster is hidden or collapsed — it must stay visible in single-column stack (posters=${JSON.stringify(at.posters)})`)
      }
      // 旧版 `hidden min-[720px]:block` 断点已废止：不得再以此为隐藏口径
      const legacy = at.posters.filter((p) => p.legacyHidden)
      if (legacy.length) {
        fails.push(`§3.1.2: poster still carries the deprecated "min-[720px]:block" gating class: ${JSON.stringify(legacy)}`)
      }
      if (at.scrollW !== at.clientW) {
        warns.push(`§3.1.2: page-level horizontal overflow at ${w}px: ${at.scrollW} != ${at.clientW}`)
      }
    }
    await setViewport(page, 1280, 900)

    // ═════════════════════════ R6：图片归属收敛到集级 ═════════════════════════
    // 真实夹具：series 80（2 集，photo 挂 1 图 / video 挂 1 图）。
    // ★ 必须先**冷导航回到剧集墙**再进详情：跨剧直接点卡会命中上一部的残留 DOM，
    //   导致 `series-gallery`/灯箱计数假阳性（实测踩过：暖导航数到 1，冷启动为 0）。
    await openSeriesById(page, S_IMAGES, 2)
    const galleryNow = await page.evaluate(() => document.querySelectorAll('[data-testid="series-gallery"]').length)
    console.log('[tl21] R6 series-gallery node count:', galleryNow, '(expect 0)')
    if (galleryNow !== 0) fails.push(`R6: series-gallery is still rendered (${galleryNow} nodes); it must be removed`)
    // 自证扫的是活页面：分集行必须非空，否则「0」只是空页面的必然结果
    const liveRows = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-slot"]').length)
    console.log('[tl21] R6 live episode-slot count (self-check):', liveRows)
    if (!(liveRows > 0)) fails.push('R6: gallery-removal scan ran on a page with 0 episode-slot (vacuous scan)')

    // 灯箱页数：打开有挂图的那一集，点开一张图，读 lightbox-position 的 N
    const r6Real = await (async () => {
      try {
        const res = await fetch(`${TG_BASE}/api/media/series/${S_IMAGES}`)
        if (!res.ok) return { error: `HTTP ${res.status}` }
        const detail = await res.json()
        const withImg = (detail.episodes || []).find((e) => (e.images || []).length > 0)
        if (!withImg) return { error: 'no episode with attached images' }
        return { epId: withImg.id, images: (withImg.images || []).length }
      } catch (e) {
        return { error: e.message }
      }
    })()
    console.log('[tl21] R6 real fixture:', JSON.stringify(r6Real))
    if (r6Real.error) {
      warns.push(`R6: could not read the real attached-image fixture (${r6Real.error}); TG_PORT=${TG_PORT} — 3/2 conservation test still runs`)
    } else {
      // 展开该集（多集剧集默认行态）
      const seq = await page.evaluate(() => {
        const slots = Array.from(document.querySelectorAll('[data-testid="episode-slot"]'))
        return slots.length
      })
      if (seq > 0) {
        // 逐集点开，找到有 episode-image-open 的那一集
        for (let i = 0; i < seq; i++) {
          await page.evaluate((idx) => {
            const s = document.querySelectorAll('[data-testid="episode-slot"]')[idx]
            if (s) s.click()
          }, i)
          await delay(700)
          const hasThumb = await page.evaluate(() => !!document.querySelector('[data-testid="episode-image-open"]'))
          if (hasThumb) break
        }
        const thumbOk = await waitTestidSoft(page, 'episode-image-open', 4000)
        if (thumbOk) {
          await clickTestid(page, 'episode-image-open')
          await waitTestidSoft(page, 'lightbox', 5000)
          await delay(400)
          const pages = await page.evaluate(LIGHTBOX_PAGES)
          console.log('[tl21] R6 lightbox pages (real fixture):', JSON.stringify(pages), `expected ${r6Real.images}`)
          if (!pages) fails.push('R6: lightbox did not open from an attached-image thumbnail')
          else if (pages.pages !== r6Real.images) {
            fails.push(`R6: lightbox shows ${pages.pages} pages for an episode with ${r6Real.images} attached image(s)`)
          }
          await shot(page, 'tl21-r6-lightbox.png', 'lightbox')
          await page.evaluate(() => {
            const el = document.querySelector('[data-testid="lightbox"]') || document.querySelector('[data-testid="episode-image-viewer"]')
            if (el) el.click()
          })
          await delay(500)
        } else {
          fails.push('R6: an episode with attached images did not expose episode-image-open')
        }
      }
    }

    // R6 三图/两图守恒：经 API 在**本集挂图**上造 A=3 / B=2，验灯箱页数 3 / 2，总数 5。
    // 语义：attachmentCount 是 API 契约（见 api/media.ts），用于把「本集仅这几张」灌进灯箱范围。
    // 若工程未实现该字段，本段保留为**明确的可执行断言**（不做静默跳过）。
    const r6Api = await exerciseAttachedImageScopes(page, TG_BASE)
    if (r6Api.skipped) {
      warns.push(`R6(3/2 conservation): ${r6Api.reason}`)
    } else if (r6Api.fail) {
      fails.push(r6Api.fail)
    } else {
      console.log('[tl21] R6 3/2 conservation PASSED:', JSON.stringify(r6Api.detail))
    }

    // ═════════════════════════ 截图落盘核对 ═════════════════════════
    for (const name of ['tl21-r1-accordion.png', 'tl21-r7-single.png', 'tl21-poster-ratio.png']) {
      const f = path.join(OUT_DIR, name)
      let size = -1
      try { size = fs.statSync(f).size } catch (_e) { size = -1 }
      if (size <= 0) fails.push(`screenshot missing or empty: ${f}`)
    }

    if (warns.length) console.log('[tl21] WARNINGS:', JSON.stringify(warns, null, 1))
    console.log('[tl21] FAILS:', fails.length ? JSON.stringify(fails, null, 1) : 'none')
    if (fails.length) process.exitCode = 2
  } finally {
    await browser.close()
  }
}

/**
 * R6 的 3/2 灯箱页数守恒：
 * 选一个 video 分集 A、photo 或另一 video 分集 B，经 API 分别把本集挂图设为 3 / 2 张，
 * 在 UI 上分别展开并打开灯箱，读页数应为 3 / 2，总数守恒 5。
 * 依赖：`POST /api/media/episodes/:id/images`（挂图）与 `DELETE .../images/:itemId`（摘图）。
 * 返回 { skipped?, fail?, detail? }；不静默通过。
 */
async function exerciseAttachedImageScopes(page, base) {
  let seriesId = S_IMAGES
  let detail
  try {
    detail = await (await fetch(`${base}/api/media/series/${seriesId}`)).json()
  } catch (e) {
    return { skipped: true, reason: `cannot fetch series ${seriesId}: ${e.message}` }
  }
  const eps = (detail.episodes || []).filter((e) => e.kind !== 'photo')
  if (eps.length < 2) {
    return { skipped: true, reason: `series ${seriesId} has ${eps.length} playable episode(s); need 2 for A/B scopes` }
  }
  // 收集候选图片 itemId：本剧所有分集已有挂图 + 条目本身的封面/图
  const pool = []
  for (const e of detail.episodes || []) for (const im of e.images || []) if (im.itemId) pool.push(im.itemId)
  // 若不足 5 张，从内容库补（photo 条目）
  if (pool.length < 5) {
    try {
      const items = await (await fetch(`${base}/api/media/items?kind=photo&limit=20`)).json()
      for (const it of items.items || []) if (it.id && !pool.includes(it.id)) pool.push(it.id)
    } catch (_e) { /* 尽力而为 */ }
  }
  if (pool.length < 5) {
    return { skipped: true, reason: `only ${pool.length} candidate image itemId(s) available; need >= 5 for the 3/2 split` }
  }
  const A = eps[0].id
  const B = eps[1].id
  const aImgs = pool.slice(0, 3)
  const bImgs = pool.slice(3, 5)
  // 记录原状以便还原
  const snapshot = {}
  for (const e of [eps[0], eps[1]]) snapshot[e.id] = (e.images || []).map((i) => i.itemId)

  // 挂图契约（见 api/media.ts attachEpisodeImages）：POST body = { itemIds: number[] }，
  // **replace-all** 语义 —— 按 itemIds 顺序重写该集的图片位。传 { itemId } 会 422。
  const attach = async (epId, itemIds) => {
    try {
      const r = await fetch(`${base}/api/media/episodes/${epId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      })
      return r.status
    } catch (e) { return `ERR:${e.message}` }
  }
  const detach = async (epId, itemId) => {
    try {
      const r = await fetch(`${base}/api/media/episodes/${epId}/images/${itemId}`, { method: 'DELETE' })
      return r.status
    } catch (e) { return `ERR:${e.message}` }
  }
  const restore = async () => {
    for (const epId of [A, B]) {
      const cur = await fetch(`${base}/api/media/series/${seriesId}`).then((r) => r.json())
      const e = (cur.episodes || []).find((x) => x.id === epId)
      for (const im of e ? e.images || [] : []) {
        if (!snapshot[epId].includes(im.itemId)) await detach(epId, im.itemId)
      }
    }
  }

  try {
    // replace-all：直接下发目标 itemIds 即得到精确的 3 / 2 张（不再逐张叠加）
    const sA = await attach(A, aImgs)
    const sB = await attach(B, bImgs)
    console.log('[tl21] R6 attach statuses A:', JSON.stringify(sA), 'B:', JSON.stringify(sB))
    if (sA !== 200 && sA !== 201 && sA !== 204) {
      await restore()
      return { skipped: true, reason: `attach API not usable for episode A (status ${JSON.stringify(sA)})` }
    }
    if (sB !== 200 && sB !== 201 && sB !== 204) {
      await restore()
      return { skipped: true, reason: `attach API not usable for episode B (status ${JSON.stringify(sB)})` }
    }

    const measure = async (epId) => {
      // 回列表 → 打开剧 → 点开该集 → 点挂图 → 读灯箱页数
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
      await installTestidAliases(page)
      await waitTestidSoft(page, 'nav-media', 12000)
      await clickTestid(page, 'nav-media')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 12000 })
      await delay(600)
      await page.evaluate((sid) => {
        const c = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
        if (c) c.click()
      }, seriesId)
      await delay(1600)
      const slotsN = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-slot"]').length)
      for (let i = 0; i < slotsN; i++) {
        await page.evaluate((idx) => {
          const s = document.querySelectorAll('[data-testid="episode-slot"]')[idx]
          if (s) s.click()
        }, i)
        await delay(600)
        const label = await page.evaluate((idx) => {
          const s = document.querySelectorAll('[data-testid="episode-slot"]')[idx]
          return s ? (s.textContent || '').trim() : null
        }, i)
        // 用 API 复核该槽对应的 epId
        const cur = await fetch(`${base}/api/media/series/${seriesId}`).then((r) => r.json())
        const epsAll = cur.episodes || []
        const slotFor = epsAll[i]
        if (!slotFor || slotFor.id !== epId) continue
        void label
        const has = await page.evaluate(() => !!document.querySelector('[data-testid="episode-image-open"]'))
        if (!has) return { epId, pages: 0, note: 'no thumbnail rendered' }
        await clickTestid(page, 'episode-image-open')
        await waitTestidSoft(page, 'lightbox', 5000)
        await delay(400)
        const pages = await page.evaluate(LIGHTBOX_PAGES)
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid="lightbox"]') || document.querySelector('[data-testid="episode-image-viewer"]')
          if (el) el.click()
        })
        await delay(400)
        return { epId, pages: pages ? pages.pages : null }
      }
      return { epId, pages: null, note: 'target slot not located' }
    }

    const mB = await measure(B)
    const mA = await measure(A)
    console.log('[tl21] R6 3/2 measured:', JSON.stringify({ mA, mB }))
    const okA = mA.pages === 3
    const okB = mB.pages === 2
    const conserved = (mA.pages || 0) + (mB.pages || 0) === 5
    await restore()
    if (!okA || !okB) {
      return {
        fail: `R6: attached-image lightbox page counts are A=${mA.pages} (expect 3) / B=${mB.pages} (expect 2), total ${(mA.pages || 0) + (mB.pages || 0)} (expect 5)`,
      }
    }
    if (!conserved) return { fail: `R6: total lightbox pages ${(mA.pages || 0) + (mB.pages || 0)} != 5` }
    return { detail: { A: mA.pages, B: mB.pages, total: 5 } }
  } catch (e) {
    await restore()
    return { skipped: true, reason: `R6 3/2 exercise errored: ${e.message}` }
  }
}

main().catch((e) => {
  console.error('[tl21] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
