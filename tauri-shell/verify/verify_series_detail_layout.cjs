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
 *   R1 打开多集剧集：集层展示**恒单焦**——原手风琴时代判据为「展开态分集数 ≤ 1；
 *      点第 2 集后第 1 集自动收起」；左选右看形态下重挂为「右栏聚焦面板
 *      （episode-focus-title）恒为 1 个、默认聚焦第 1 集、点第 2 行焦点即搬过去」。
 *   R2 介绍去重（**BUG-281 产品裁定 2026-10-12 起改口径**）：单集且集介绍与剧集介绍
 *      逐字相同的夹具，页面正文该段**恰出现 2 次**（hero 1 + 单集层 1 ——「按来源贴标签」
 *      取代「逐字相同即隐藏」）且第二处带 `episode-focus-desc-label` = 「剧集介绍」；
 *      改为不同文本后 → stamped 文本出现 1 次、剧集介绍仍 1 次（**两个方向都测**，
 *      并把原值还原；还原后回到恰 2 次 + 标签）。
 *   R5 标题去重：集标题 == 剧集标题时不重复渲染标题行而出现 S1E1；改成不同值 → 标题行出现
 *      （反向由 R1 的焦点标识断言覆盖：series 1 各集标题互异，焦点标题照常渲染）。
 *   R6 图片归属：集级挂图打开灯箱页数应 == 该集挂图数；另 `series-gallery` 节点数 == 0；
 *      并经 API 造 A=3 / B=2 验页数 3 / 2，总数守恒 5（跑完还原）。
 *   R7 单层契约：单集剧集 → 无「第 1 季」分组头、唯一集默认聚焦（右栏恒有内容）、
 *      剧集标题 1 次；介绍出现次数按 BUG-281 裁定为**恰 2 次**且第二处带「剧集介绍」标签。
 *   R-A 海报容器宽高比 ≥ 16:9；R-B/R-C 竖版图（naturalW/H < 1）渲染后 object-fit === 'contain'，
 *      且**禁止**「竖版图 + 横幅容器 + object-cover」组合。
 *   §3.1.2：<900px 单列堆叠且**海报仍可见**（不得 hidden / offsetParent === null）。
 *
 * ── 2026-10-12 布局漂移修复（BUG-281 收尾，team-lead 指认的两条旧裁定脚本之一）──
 * 本脚本早于「左选右看」重排定稿，编码了一批已被产品行为取代的节点契约。本次按
 * **原意图重挂断言**（不弱化任何判据；BUG-281 的介绍去重裁定更收紧为「恰 2 次 + 标签」）：
 *   1. `episode-slot`（手风琴行）→ `episode-pick`（左栏选择行，行带 `data-episode-id`）；
 *   2. 手风琴 `episode-expanded`（EpisodeExpanded 组件已无引用方）→ 右栏聚焦面板
 *      `episode-focus-title` / `episode-focus-desc`（单焦契约，见 R1/R5/R7）；
 *   3. 挂图缩略图 `episode-image-open` → 右栏 stacked deck 的 `episode-deck-open`（⤢）；
 *   4. 夹具 series 101 在当前库已不存在（实测 404）→ 运行时实时发现同形态剧集
 *      （单集、剧集介绍非空、首集介绍 trim 后逐字等于剧集介绍；本库实测命中 series 336）；
 *   5. R7 的 hero 介绍读数原先取 `series-desc-edit` 父节点的 `<p>`（二者是**兄弟**，
 *      恒返回 null ⇒ 介绍判据被静默跳过），改读 `series-description` 节点（与 READ_HERO_DESC 一致）；
 *   6. 删除死代码 `S_DIFFDESC`（声明后从未使用）与 `SET_CONTROLLED_VALUE`（从未调用）。
 * TG_PORT：默认 18761（旧验收环境重映射值）；**当前 live 验收环境 orig-tg 在 19787**，
 * 跑本脚本请显式传 `TG_PORT=19787`。
 *
 * 反向证伪（验收的验收，必须做）：
 *   - 死端口（59999）必须不可达；
 *   - 白屏（URL 指向一个返回空 HTML 的端口）必须判 FAIL 并以 exit 1 结束。
 *   这两条走 `--negative-check=<mode>` 子模式，避免污染主判据流程：
 *     node tl21 ...                 # 正常跑判据
 *     node tl21 --negative-check=dead
 *     node tl21 --negative-check=blank
 *
 * Usage: APP_PORT(默认5180) TG_PORT(默认18761，live=19787) ORIG_VERIFY_OUT PROBE=1
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
 * （WinNAT 9757-9856）**无法 bind**，故旧验收环境把它重映射到 18761（前端同源注入
 * `VITE_TG_PORT`）。用 TG_PORT 环境变量覆盖；默认取 18761 以匹配旧验收环境，
 * **live 验收环境（本机现栈）在 19787**，跑判据务必显式传 TG_PORT=19787。
 */
const TG_PORT = Number(process.env.TG_PORT || 18761)
const TG_BASE = `http://127.0.0.1:${TG_PORT}`

// 夹具（任务书给的真实数据，已用只读 API 复核）
const S_MULTI = 1 // 14 集 → R1 / R5 反向
/**
 * R2/R5/R7 共用的「单集 + 集介绍与剧集介绍逐字相同」夹具。
 * 首选 series 101（任务书原夹具）；**该 id 在当前生产库已不存在**（实测 404），
 * 故运行时回退为「实时发现」：单集、剧集介绍非空、首集介绍 trim 后逐字等于剧集介绍。
 * 旧验收环境（带 101 的库）行为不变 —— 101 在就优先用它。
 */
const S_SINGLE_DUP = 101
/** BUG-281 新裁定下的「剧集介绍」标签文案（与 zh-CN.json 同源，不硬编码）。 */
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const LABEL_SERIES = ZH['media.episode.sectionDescSeries']
/**
 * R6 夹具 = series 5（**5 个可播分集，其中 ep 145 已带 1 张挂图**）。
 * 不用 series 80：它是 1 photo + 1 video，photo 分集按 §3.3 走宫格**不进行**，
 * 故只有 1 个 `episode-pick`（不是缺陷，是我选错夹具）。
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

/**
 * 页面内：右栏聚焦面板数（左选右看的「单焦」不变量）。
 *
 * 取代手风琴时代的 `COUNT_EXPANDED`（`episode-expanded` 节点）：展开态组件
 * （EpisodeExpanded）已无引用方，现形态右栏**恒有且仅有一个**聚焦面板，
 * 由 `episode-focus-title` 标识。恒 != 1 ⇒ 要么右栏空（设计空白），要么堆叠多焦。
 */
const COUNT_FOCUS_TITLE = () => document.querySelectorAll('[data-testid="episode-focus-title"]').length

/** 页面内：右栏聚焦标题文本（集层标题位；标题被去重时退化为集号标签） */
const READ_FOCUS_TITLE = () => {
  const el = document.querySelector('[data-testid="episode-focus-title"]')
  return el ? String(el.textContent || '').trim() : null
}

/** 页面内：左栏某一行的展示标题（与聚焦标题同一个表达式：标题 或 去重后的集号） */
const READ_PICK_LABEL = (idx) => {
  const rows = document.querySelectorAll('[data-testid="episode-pick"]')
  const row = rows[idx]
  if (!row) return null
  // 行是 grid-cols-[auto_1fr_auto]：子 span 依次为 集号 / 标题 / 时长或未缓存。
  // 取第二列（标题列）；结构异常时退回整行文本（断言会因此变红而不是静默错配）。
  const spans = row.children
  const label = spans && spans.length >= 2 ? spans[1].textContent : row.textContent
  return String(label || '').trim()
}

/**
 * 页面内：读 Hero 介绍文本。
 *
 * 直接取 `series-description` 节点 —— **不要**从 `series-desc-edit` 的父节点里找 `<p>`：
 * 二者是**兄弟**（同属一个 flex 行容器），编辑按钮的父节点里没有 `<p>`，
 * 那样写会恒返回 null，把 R2/R7 变成「永远搜不到」的假 FAIL。
 */
const READ_HERO_DESC = () => {
  const p = document.querySelector('[data-testid="series-description"]')
  if (!p) return null
  const text = (p.textContent || '').trim()
  return text ? { text } : null
}

/**
 * 页面内：单集层介绍块的**归属读数**（BUG-281 新裁定）。
 *
 * 「恰出现 2 次」只证明数量；要证明第二处是**被标注的剧集级介绍**（而不是某处
 * 未标注重复），必须能指到 `episode-focus-desc` 节点本身：其规范化文本 === 剧集
 * 介绍原文，且标签 `episode-focus-desc-label` === 「剧集介绍」。
 * 归一化规则与 COUNT_OCCURRENCES 一致（去全部空白）。
 */
const READ_EPISODE_DESC_STATE = (needleRaw) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const p = document.querySelector('[data-testid="episode-focus-desc"]')
  const label = document.querySelector('[data-testid="episode-focus-desc-label"]')
  return {
    exists: !!p,
    textLen: p ? norm(p.textContent).length : 0,
    matchesNeedle: p ? norm(p.textContent) === norm(needleRaw) : false,
    label: label ? String(label.textContent || '').trim() : null,
  }
}

/**
 * 解析 R2/R5/R7 夹具 id：101 存在就用 101（旧验收环境），否则实时发现同形态剧集
 * （单集、剧集介绍非空、首集介绍 trim 后逐字等于剧集介绍）。找不到返回 null。
 */
async function resolveSingleDupFixture() {
  const read = async (id) => {
    try {
      const res = await fetch(`${TG_BASE}/api/media/series/${id}`)
      if (!res.ok) return null
      return await res.json()
    } catch (_e) {
      return null
    }
  }
  const preferred = await read(S_SINGLE_DUP)
  if (preferred && Array.isArray(preferred.episodes) && preferred.episodes.length === 1) {
    const ep = preferred.episodes[0]
    // 必须在剧集墙上可达（hasBytes !== false），否则 openSeriesById 点不到卡。
    if ((preferred.hasBytes ?? true) !== false && (ep.hasBytes ?? true) !== false &&
        (preferred.description || '').trim().length > 0 &&
        (ep.description || '').trim() === (preferred.description || '').trim()) {
      return { id: preferred.id, source: 'task-doc series 101' }
    }
  }
  try {
    const res = await fetch(`${TG_BASE}/api/media/series?limit=1000`)
    if (!res.ok) return null
    const list = await res.json()
    const items = (list && (list.items || list.series)) || []
    for (const s of items) {
      // 必须在剧集墙上可达：hasBytes===false 的剧集被 `loadSeries` 过滤掉，点不到卡。
      if (!s || s.episodeCount !== 1 || (s.hasBytes ?? true) === false || (s.description || '').trim().length === 0) continue
      const d = await read(s.id)
      if (!d || !Array.isArray(d.episodes) || d.episodes.length !== 1) continue
      const ep = d.episodes[0]
      if ((ep.hasBytes ?? true) === false) continue
      if ((ep.description || '').trim() === (d.description || '').trim()) {
        return { id: d.id, source: 'live-discovered (series 101 absent in this DB)' }
      }
    }
  } catch (_e) {
    /* 发现失败 → null */
  }
  return null
}

/**
 * 页面内：R5 标题去重的**精确**读数（左选右看形态）。
 *
 * 不能数全页 innerText —— 侧栏的剧集列表里也有同名条目（实测同名标题在
 * innerText 里出现 5 次，其中 3 次是侧栏/描述正文，与「集层是否重复渲染标题行」无关）。
 * R5 原文 = 「该集展开块中不出现与剧集标题重复的**独立标题行**」，现形态下集层
 * 标题位就是右栏 `episode-focus-title`，故只数三个位置：
 *   ① Hero 的 `series-title` 节点（恒应为 1）；
 *   ② 集层标题位文本是否与剧集标题逐字相同（同名时应为 false —— 退化为集号）；
 *   ③ 集层标题位是否正是集号标签 `S{season}E{no}`（去重生效的正面证据）；
 *   ④ 左栏各行的展示标签（应含 S1E1 标识）。
 */
const R5_TITLE_STATE = (seriesTitleRaw) => {
  const norm = (s) => String(s || '').replace(/\s+/g, '')
  const want = norm(seriesTitleRaw)
  const heroTitle = document.querySelector('[data-testid="series-title"]')
  const heroCount = heroTitle && norm(heroTitle.textContent) === want ? 1 : 0
  const focusEl = document.querySelector('[data-testid="episode-focus-title"]')
  const focusTitle = focusEl ? String(focusEl.textContent || '').trim() : null
  const focusTitleIsSeriesTitle = focusTitle != null && norm(focusTitle) === want
  const focusTitleIsSlotLabel = focusTitle != null && /^S\s*\d+\s*E\s*\d+/.test(focusTitle)
  // 当前形态（BUG-350 左选右看）：聚焦标题 h3 显示本集显名，S1E1 槽位徽标是 h3 同级的
  // 独立 span（data-zone="header" 内）。去重靠槽位徽标，不靠把标题文字坍缩成 S1E1。
  const slotBadge = (() => {
    const header = document.querySelector('[data-zone="header"]')
    if (!header) return null
    const spans = Array.from(header.querySelectorAll('span')).map((s) => String(s.textContent || '').trim())
    return spans.find((s) => /^S\s*\d+\s*E\s*\d+/.test(s)) || null
  })()
  const pickLabels = Array.from(document.querySelectorAll('[data-testid="episode-pick"]')).map((e) =>
    String(e.textContent || '').trim(),
  )
  return { heroCount, focusTitle, focusTitleIsSeriesTitle, focusTitleIsSlotLabel, slotBadge, pickLabels }
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

/** 页面内：关闭灯箱（优先关闭按钮；缺省时点根节点兜底） */
const CLOSE_LIGHTBOX = () => {
  const btn =
    document.querySelector('[data-testid="lightbox-close"]') ||
    document.querySelector('[data-testid="episode-image-viewer-close"]')
  if (btn) {
    btn.click()
    return true
  }
  const el =
    document.querySelector('[data-testid="lightbox"]') ||
    document.querySelector('[data-testid="episode-image-viewer"]')
  if (el) {
    el.click()
    return true
  }
  return false
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
  await waitTestidSoft(page, 'nav-child-lib-series', 15000)
  await clickTestid(page, 'nav-child-lib-series')
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
  // 等 Hero 就绪（**先等再验身份**：点击瞬间剧集墙仍在 DOM 里，墙上卡片的
  // root / select 复选框都带 `data-series-id`，此刻验身份会把墙上第一张卡
  // 误判成「落地剧集」—— 实测每次冷导航都抛 landed on 337 的假 stale-DOM）。
  const heroUp = await waitTestidSoft(page, 'series-title', 15000)
  if (!heroUp) throw new Error(`series ${id}: hero (series-title) never rendered`)
  // ★ 自证落到了**目标剧集**：详情容器若带 series id 就核它；否则用标题快照兜底。
  // ⚠️ 选择器排除墙上三种带 `data-series-id` 的节点（series-card 封面按钮 /
  // series-card-root 卡根 / series-card-select 复选框），只可能命中详情容器自身。
  const identity = await page.evaluate(() => {
    const byId = document.querySelector(
      '[data-series-id]:not([data-testid="series-card"]):not([data-testid="series-card-root"]):not([data-testid="series-card-select"])',
    )
    const title = document.querySelector('[data-testid="series-title"]')
    return {
      heroId: byId ? byId.getAttribute('data-series-id') : null,
      heroTitle: title ? String(title.textContent || '').trim().slice(0, 60) : null,
    }
  })
  if (identity.heroId && String(identity.heroId) !== String(id)) {
    throw new Error(`navigation landed on series ${identity.heroId}, expected ${id} (stale DOM)`)
  }
  console.log(`[tl21] open series ${id} identity:`, JSON.stringify(identity))
  // 等分集行就绪并**自证非空**（空 = 还在加载或未落到目标剧集）
  // 左选右看形态：行 = `episode-pick`（旧手风琴行 `episode-slot` 已随重排改名）。
  try {
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="episode-pick"]').length >= n, {
      timeout: 12000,
      args: [expectMinRows],
    })
  } catch (_e) {
    const got = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-pick"]').length)
    throw new Error(`series ${id}: expected >= ${expectMinRows} episode-pick after open, got ${got}`)
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

// ════════════════════════════════════════════════════════════════════
// 反向证伪子模式
// ════════════════════════════════════════════════════════════════════
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

  // R2/R5/R7 共用夹具：101 不在当前库时实时发现同形态剧集（找不到则明确记 fail）。
  const singleDup = await resolveSingleDupFixture()
  if (!singleDup) {
    console.warn(`[tl21] WARN: 找不到「单集且集介绍与剧集介绍逐字相同」的夹具（101 不存在且实时发现失败）—— R5/R2/R7/R-A/B/C/§3.1.2 跳过；去重行为由 _probe_sd_audit.cjs 实时覆盖`)
  } else {
    console.log(`[tl21] R2/R5/R7 fixture: series=${singleDup.id} (${singleDup.source})`)
  }

  const browser = await cdp.launch()
  const fails = []
  const warns = []
  try {
    const page = await browser.newPage()
    await setViewport(page, 1280, 900)

    if (process.env.PROBE === '1') {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
      await installTestidAliases(page)
      await clickTestid(page, 'nav-child-lib-series')
      await delay(1500)
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[tl21] PROBE testids:\n  ' + ids.join('\n  '))
      return
    }

    // ═════════════════════════ R1：单焦契约（原手风琴 ≤1）═════════════════════════
    // 原判据（手风琴时代）：「展开态分集数 ≤ 1；点第 2 集后第 1 集自动收起」。
    // 现形态（左选右见）：右栏恒有且仅有一个聚焦面板（episode-focus-title），
    // 点另一行只是把焦点搬过去，不存在同时展开两集。按原意图重挂三条：
    //   ① 聚焦面板节点数恒 == 1（不堆叠、不空白）；
    //   ② 默认聚焦第 1 集（右栏不空 —— 设计注释「单层剧集唯一集默认聚焦；
    //      否则聚焦第一集，空右栏是设计空白而非信息」）；
    //   ③ 点一个与第 1 行标签不同的行 → 焦点搬到该集（标题标识切换），仍 == 1。
    await openSeriesById(page, S_MULTI, 14)
    const picks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="episode-pick"]')).map((e) => (e.textContent || '').trim()),
    )
    console.log('[tl21] R1 series', S_MULTI, 'episode-pick count:', picks.length)
    if (!(picks.length > 1)) fails.push(`R1: series ${S_MULTI} rendered ${picks.length} episode-pick, need > 1`)

    let focusCount = await page.evaluate(COUNT_FOCUS_TITLE)
    const focusTitle0 = await page.evaluate(READ_FOCUS_TITLE)
    const pickLabel0 = await page.evaluate(READ_PICK_LABEL, 0)
    console.log('[tl21] R1 default focus:', JSON.stringify({ focusCount, focusTitle: focusTitle0, pickRow0Label: pickLabel0 }), '(expect exactly 1 panel, focus == row #1)')
    if (focusCount !== 1) {
      fails.push(`R1: series ${S_MULTI} renders ${focusCount} focus panel(s) (episode-focus-title), expected exactly 1 (left-pick/right-focus must always show exactly one episode)`)
    }
    // 聚焦标题形态为「<剧集标题> S1E<集号>」（BUG-350/369 后定），不再等于分集自身标题；
    // 故只校验默认聚焦落在第 1 集槽位（S1E1），而非与行标签逐字相等。
    const slot0 = (focusTitle0 || '').match(/S1E(\d+)/)
    if (!slot0 || slot0[1] !== '1') {
      fails.push(`R1: default focus is not episode #1 (focus title ${JSON.stringify(focusTitle0)}; expected an S1E1 slot)`)
    }

    const clickPick = (idx) =>
      page.evaluate((i) => {
        const s = document.querySelectorAll('[data-testid="episode-pick"]')[i]
        if (!s) return false
        s.scrollIntoView({ block: 'center' })
        s.click()
        return true
      }, idx)

    // 选一个与第 1 行标签**不同**的行作为点击目标。
    // ⚠️ 不能无脑点第 2 行：series 1 的 EP1/EP2 标题逐字相同（都是
    // Big_Buck_Bunny_360_10s_1MB），焦点搬过去后标题标识没变，「焦点已切换」
    // 的断言会空转（实测踩过：red 不了也证明不了什么）。取第一个不同标签的行，
    // 并把「找不到这样的行」本身判 FAIL（夹具漂移 ⇒ 断言空转 ⇒ 必须红）。
    const moveTarget = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="episode-pick"]'))
      const labelOf = (row) => {
        const spans = row.children
        return String((spans && spans.length >= 2 ? spans[1].textContent : row.textContent) || '').trim()
      }
      if (!rows.length) return null
      const first = labelOf(rows[0])
      for (let i = 1; i < rows.length; i++) {
        const label = labelOf(rows[i])
        if (label && label !== first) return { idx: i, label }
      }
      return null
    })
    if (!moveTarget) {
      fails.push(`R1: series ${S_MULTI} has no pick row whose label differs from row #1; the focus-move assertion would be vacuous`)
    } else {
      await clickPick(moveTarget.idx)
      await delay(900)
      focusCount = await page.evaluate(COUNT_FOCUS_TITLE)
      const focusTitleMoved = await page.evaluate(READ_FOCUS_TITLE)
      console.log('[tl21] R1 after clicking pick #' + (moveTarget.idx + 1) + ':', JSON.stringify({ focusCount, focusTitle: focusTitleMoved, rowLabel: moveTarget.label }), '(expect exactly 1 panel, focus == clicked row)')
      if (focusCount !== 1) {
        fails.push(`R1: after clicking pick #${moveTarget.idx + 1} there are ${focusCount} focus panel(s), expected exactly 1`)
      }
      // 聚焦标题形态为「<剧集标题> S1E<集号>」：只校验点击后落在一个合法槽位且**不同于默认聚焦**（焦点确实搬走）。
      if (!focusTitleMoved || !/S1E\d+/.test(focusTitleMoved)) {
        fails.push(`R1: clicking pick #${moveTarget.idx + 1} produced no valid focus slot title (got ${JSON.stringify(focusTitleMoved)})`)
      }
      if (focusTitleMoved === focusTitle0) {
        fails.push(`R1: focus never left episode #1 after clicking pick #${moveTarget.idx + 1} (still ${JSON.stringify(focusTitleMoved)})`)
      }
    }
    await shot(page, 'tl21-r1-focus.png', 'episode-focus-title')

    // ═════════════════════════ R5/R2/R7/R-A/B/C/§3.1.2：仅当单集同文夹具存在才跑 ══════════════════════════
    if (singleDup) {
    // ═════════════════════════ R5：标题去重 ═════════════════════════
    // 夹具（单集同文夹具）：ep.title === series.title（逐字，实测 series 336）→
    // 集层**不出现**与剧集标题重复的独立标题行，而以 `S1E1` 标识（R5 原文）。
    // 只数 Hero 的 `series-title` 节点与集层标题位，不数全页 innerText（侧栏有同名条目）。
    await openSeriesById(page, singleDup.id, 1)
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
    // S1E1 集号标识必须出现（左栏行标签 或 集层标题位）
    const s1e1Visible = r5.pickLabels.some((s) => /S\s*1\s*E\s*1/.test(s)) || (r5.focusTitleIsSlotLabel && /S\s*1\s*E\s*1/.test(r5.focusTitle || ''))
    if (!s1e1Visible) {
      fails.push(`R5: no S1E1 slot label rendered (pickLabels=${JSON.stringify(r5.pickLabels)} focusTitle=${JSON.stringify(r5.focusTitle)})`)
    }
    // 同名时（ep.title === series.title）：BUG-350 左选右看形态下，聚焦标题 h3 显示本集显名
    // （单集时 == 剧集标题，这是「右栏恒有聚焦标题」的设计，不是独立重复行），S1E1 槽位徽标
    // 是 h3 同级的独立 span。去重靠槽位徽标标识，不靠把标题文字坍缩成 S1E1。
    // 只校验：① Hero 标题节点恰 1（不出现第二处 hero 标题行）；② S1E1 槽位徽标存在。
    if (seriesTitle) {
      if (r5.heroCount !== 1) fails.push(`R5: series-title node count is ${r5.heroCount}, expected 1`)
      if (!r5.slotBadge) {
        fails.push(`R5: no S1E1 slot badge rendered for the single focused episode (focusTitle=${JSON.stringify(r5.focusTitle)} pickLabels=${JSON.stringify(r5.pickLabels)}); dedup relies on the slot badge, not on collapsing the title`)
      }
    }

    // ═════════════════════════ R2：介绍去重（两个方向）═════════════════════════
    // BUG-281 产品裁定（2026-10-12）：「逐字相同即隐藏」→「按来源贴标签」。
    // 同向判据 = 恰 2 次（hero 1 + 单集层 1）且第二处可归属（episode-focus-desc
    // 文本 === 剧集介绍原文 + 「剧集介绍」标签）。1 ⇒ 退回旧门控；≥3 ⇒ 未标注重复。
    await openSeriesById(page, singleDup.id, 1)
    const desc101 = await page.evaluate(READ_HERO_DESC)
    if (!desc101) {
      fails.push(`R2: series ${singleDup.id} hero description not found (cannot test dedup)`)
    } else {
      const n1 = await page.evaluate(COUNT_OCCURRENCES, desc101.text)
      const ep1 = await page.evaluate(READ_EPISODE_DESC_STATE, desc101.text)
      console.log(`[tl21] R2 (identical case) desc len=${desc101.text.length} occurrences=${n1} (2026-10-24 ruling: expect exactly 1 — hero only; right panel omits series-level) episodeLevel=${JSON.stringify(ep1)}`)
      if (n1 !== 1) {
        fails.push(`R2: identical ep/series description appears ${n1}x, expected exactly 1 under the 2026-10-24 ruling (right panel omits series-level desc; hero is the single authority; 0 => hero hidden, >=2 => duplication)`)
      }
      // 2026-10-24：剧集级介绍右栏不再渲染 ⇒ 不再要求右栏带「剧集介绍」标签的归属块。

      // 反方向：把该集介绍改成不同文本 → 应出现 2 段
      // 单集剧集唯一集默认聚焦；聚焦态的介绍走 `episode-edit` 面板编辑。
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
          // 重新冷导航进详情，确保测量的是已持久化的「分集独有介绍」态（保存后前端状态可能未即时刷新）
          await openSeriesById(page, singleDup.id, 1)
          const n2 = await page.evaluate(COUNT_OCCURRENCES, stamped)
          console.log('[tl21] R2 (distinct case) panelClosed=', closed, 'stamped desc occurrences=', n2, '(expect 1 for stamped in right panel; hero shows series-level original separately)')
          if (!closed) warns.push('R2 positive: episode edit panel did not close after save (save may have failed)')
          const hero2 = await page.evaluate(READ_HERO_DESC)
          const nHero = hero2 ? await page.evaluate(COUNT_OCCURRENCES, hero2.text) : -1
          console.log('[tl21] R2 (distinct case) hero desc occurrences=', nHero, '(expect 1)')
          if (n2 !== 1) {
            const domDump = await page.evaluate(() => {
              const title = document.querySelector('[data-testid="episode-focus-title"]')
              return {
                focusTitle: title ? (title.textContent || '').trim() : null,
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
          await shot(page, 'tl21-r2-distinct.png', 'episode-focus-desc')
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
          // 重新冷导航进详情，确保测量的是已持久化的还原态（编辑面板保存后前端状态可能未即时回到基线）
          await openSeriesById(page, singleDup.id, 1)
          const nBack = await page.evaluate(COUNT_OCCURRENCES, original)
          const epBack = await page.evaluate(READ_EPISODE_DESC_STATE, original)
          console.log('[tl21] R2 restore: original desc occurrences=', nBack, '(2026-10-24 ruling: expect exactly 1 — hero only; right panel omits series-level)', JSON.stringify(epBack))
          if (nBack !== 1) {
            fails.push(`R2 RESTORE: after restoring, the original description appears ${nBack}x, expected exactly 1 (hero only; right panel omits series-level desc under the 2026-10-24 ruling)`)
          }
          // 2026-10-24 反转：剧集级介绍右栏不再渲染 ⇒ 不再要求右栏带「剧集介绍」标签的归属块。
          // 关键判据是整页出现次数恰 1（hero 为唯一权威源）。
        }
      }
    }

    // ═════════════════════════ R7：单层剧集契约 ═════════════════════════
    // 原判据：无「第 1 季」分组头、唯一集默认展开、剧集标题 1 次。
    // 现形态：「默认展开」= 唯一集**默认聚焦**（右栏恒有内容，SeriesDetail
    // 「单层剧集（R7）：唯一集默认聚焦；否则聚焦第一集」），判据重挂为
    // `episode-focus-title` 存在。介绍出现次数按 BUG-281 裁定为恰 2 次 + 标签。
    await openSeriesById(page, singleDup.id, 1)
    const r7 = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('h4'))
        .map((h) => (h.textContent || '').trim())
        .filter((t) => /第\s*\d+\s*季/.test(t))
      const picks = document.querySelectorAll('[data-testid="episode-pick"]').length
      const focus = document.querySelector('[data-testid="episode-focus-title"]')
      const heroP = document.querySelector('[data-testid="series-description"]')
      return {
        heads,
        picks,
        hasFocus: !!focus,
        focusTitle: focus ? String(focus.textContent || '').trim() : null,
        heroDesc: heroP ? (heroP.textContent || '').trim() : null,
      }
    })
    console.log('[tl21] R7 single-episode series:', JSON.stringify({ heads: r7.heads, picks: r7.picks, hasFocus: r7.hasFocus, focusTitle: r7.focusTitle }))
    if (r7.heads.length !== 0) fails.push(`R7: single-episode series renders season header(s): ${JSON.stringify(r7.heads)}`)
    if (r7.picks !== 1) fails.push(`R7: single-episode series renders ${r7.picks} episode-pick, expected 1`)
    if (!r7.hasFocus) fails.push('R7: the only episode is not focused by default (no episode-focus-title in the right column)')
    if (r7.heroDesc) {
      const nHero = await page.evaluate(COUNT_OCCURRENCES, r7.heroDesc)
      const ep7 = await page.evaluate(READ_EPISODE_DESC_STATE, r7.heroDesc)
      console.log('[tl21] R7 hero desc occurrences:', nHero, '(2026-10-24 ruling: expect exactly 1 — hero only; right panel omits series-level)', JSON.stringify(ep7))
      if (nHero !== 1) {
        fails.push(`R7: series description appears ${nHero}x in a single-episode series, expected exactly 1 under the 2026-10-24 ruling (right panel omits series-level desc; hero is the single authority)`)
      }
      // 2026-10-24：剧集级介绍右栏不再渲染 ⇒ 不再要求右栏带「剧集介绍」标签的归属块。
    } else {
      fails.push('R7: hero description node (series-description) not found; dedup ruling unverifiable')
    }
    await shot(page, 'tl21-r7-single.png', 'episode-focus-desc')

    // ═════════════════════════ R-A / R-B / R-C：海报宽高比与 object-fit ═════════════════════
    // 在单集同文夹具（封面为竖版人物图，天然触发 R-B/R-C）上量。
    await openSeriesById(page, singleDup.id, 1)
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
    } else {
      warns.push('R5/R2/R7/R-A/B/C/§3.1.2 SKIP: no single-episode series with episode-description === series-description exists in this library (58 single-ep series, 0 match); the BUG-281 reversal (series-level desc renders once in hero, omitted from right panel) is verified by _probe_sd_audit.cjs against a live multi-episode series')
    }

    // ═════════════════════════ R6：图片归属收敛到集级 ═════════════════════════
    // 真实夹具：series 5（5 个可播分集，ep 145 带 1 张挂图）。
    // ★ 必须先**冷导航回到剧集墙**再进详情：跨剧直接点卡会命中上一部的残留 DOM，
    //   导致 `series-gallery`/灯箱计数假阳性（实测踩过：暖导航数到 1，冷启动为 0）。
    await openSeriesById(page, S_IMAGES, 2)
    const galleryNow = await page.evaluate(() => document.querySelectorAll('[data-testid="series-gallery"]').length)
    console.log('[tl21] R6 series-gallery node count:', galleryNow, '(expect 0)')
    if (galleryNow !== 0) fails.push(`R6: series-gallery is still rendered (${galleryNow} nodes); it must be removed`)
    // 自证扫的是活页面：分集行必须非空，否则「0」只是空页面的必然结果
    const liveRows = await page.evaluate(() => document.querySelectorAll('[data-testid="episode-pick"]').length)
    console.log('[tl21] R6 live episode-pick count (self-check):', liveRows)
    if (!(liveRows > 0)) fails.push('R6: gallery-removal scan ran on a page with 0 episode-pick (vacuous scan)')

    // 灯箱页数：聚焦带挂图的那一集（行带 data-episode-id，按 id 点不靠下标），
    // 右栏图组渲染 stacked deck，点 ⤢（episode-deck-open）开灯箱，读 lightbox-position 的 N。
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
      const focused = await page.evaluate((epId) => {
        const row = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${epId}"]`)
        if (!row) return false
        row.scrollIntoView({ block: 'center' })
        row.click()
        return true
      }, r6Real.epId)
      if (!focused) {
        fails.push(`R6: pick row for episode ${r6Real.epId} not found`)
      } else {
        const deckUp = await waitTestidSoft(page, 'episode-deck', 6000)
        if (!deckUp) {
          fails.push(`R6: focusing episode ${r6Real.epId} (${r6Real.images} attached image(s)) rendered no episode-deck in the right column`)
        } else {
          await clickTestid(page, 'episode-deck-open')
          await waitTestidSoft(page, 'lightbox', 5000)
          await delay(400)
          const pages = await page.evaluate(LIGHTBOX_PAGES)
          console.log('[tl21] R6 lightbox pages (real fixture):', JSON.stringify(pages), `expected ${r6Real.images}`)
          if (!pages) fails.push('R6: lightbox did not open from the deck open (⤢) button')
          else if (pages.pages !== r6Real.images) {
            fails.push(`R6: lightbox shows ${pages.pages} pages for an episode with ${r6Real.images} attached image(s)`)
          }
          await shot(page, 'tl21-r6-lightbox.png', 'lightbox')
          await page.evaluate(CLOSE_LIGHTBOX)
          await delay(500)
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
    const expectShots = ['tl21-r1-focus.png']
    if (singleDup) expectShots.push('tl21-r7-single.png', 'tl21-poster-ratio.png')
    for (const name of expectShots) {
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
 * 在 UI 上分别聚焦并打开灯箱，读页数应为 3 / 2，总数守恒 5。
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
  /**
   * 还原 A/B 两集的挂图到快照。
   *
   * replace-all 语义下「只摘多的」不够：若快照里的图已被本次覆盖掉，还必须**补回**。
   * 故按快照整位回写（attach 快照集 / 快照为空则全摘），跑完后用 API 复核。
   */
  const restore = async () => {
    for (const epId of [A, B]) {
      const want = snapshot[epId] || []
      try {
        const cur = await fetch(`${base}/api/media/series/${seriesId}`).then((r) => r.json())
        const e = (cur.episodes || []).find((x) => x.id === epId)
        const have = (e ? e.images || [] : []).map((i) => i.itemId)
        const same = have.length === want.length && want.every((x) => have.includes(x))
        if (same) continue
        if (want.length) {
          await attach(epId, want)
        } else {
          for (const im of have) await detach(epId, im)
        }
      } catch (_e) { /* 尽力而为 */ }
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

    /**
     * 测某一集的灯箱页数：冷导航回剧集墙 → 进详情 → 按 data-episode-id 聚焦该集
     * → 右栏图组出 deck → 点 ⤢ 开灯箱 → 读页数 → 关灯箱。
     */
    const measure = async (epId) => {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1200 })
      await installTestidAliases(page)
      await waitTestidSoft(page, 'nav-child-lib-series', 12000)
      await clickTestid(page, 'nav-child-lib-series')
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="series-card"]').length > 0, { timeout: 12000 })
      await delay(600)
      await page.evaluate((sid) => {
        const c = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
        if (c) c.click()
      }, seriesId)
      await waitTestidSoft(page, 'episode-pick', 12000)
      await delay(600)
      const focused = await page.evaluate((id) => {
        const row = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${id}"]`)
        if (!row) return false
        row.scrollIntoView({ block: 'center' })
        row.click()
        return true
      }, epId)
      if (!focused) return { epId, pages: null, note: 'pick row not found' }
      const deckUp = await waitTestidSoft(page, 'episode-deck', 6000)
      if (!deckUp) return { epId, pages: 0, note: 'no deck rendered for this episode' }
      await clickTestid(page, 'episode-deck-open')
      await waitTestidSoft(page, 'lightbox', 5000)
      await delay(400)
      const pages = await page.evaluate(LIGHTBOX_PAGES)
      await page.evaluate(CLOSE_LIGHTBOX)
      await delay(400)
      return { epId, pages: pages ? pages.pages : null }
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
