#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for BUG-123: a media card must signal its KIND *before*
 * the click, so an image can never be mistaken for a video.
 *
 * 缺陷现场：用户点开一张图片，进到的却是视频播放器。根因不是分流缺失
 * （`MediaViewer.modeOf` 早已按 `kind` 分流），而是**点击之前没有类型信号**：
 * 网格里图片与视频都只有一张缩略图，且悬浮层统一挂着一个播放三角 ▶ ——
 * 图片卡片 hover 也显示 ▶，用户自然以为点下去是播放。
 *
 * 修复（`src/components/media/MediaCard.tsx`）两处互补信号：
 *   1. 悬浮操作图标按类型分流 —— photo → `ZoomIn`（看图语义），video → `Play`
 *   2. 常驻类型徽标 `[data-testid="item-kind"]` —— 不 hover 也能分辨
 *
 * BUG-128 追加（本脚本第二轮）：
 *   徽标文案此前是**硬编码中文**，英文界面里混排「视频」「图片」。本脚本现在
 *   还会**真的把 locale 切到 en-US**（走设置 UI，不是直接改 localStorage），
 *   断言徽标变为 `Photo` / `Video` 且不含 CJK 字符，最后切回 zh-CN 复核渲染值
 *   一字未变。只跑 zh-CN 是测不出 BUG-128 的 —— 中文环境下硬编码与 i18n 取值
 *   的渲染结果完全一样。
 *
 * 为什么必须在真实浏览器里断言：
 *   断言对象是**渲染后的 svg class**（lucide-react 生成的语义化 class 名）
 *   与徽标文本。用 jsdom / 单测重写一份 `KIND_ACTION_ICON` 再断言，无论线上
 *   组件写成什么样都会通过 —— 那是测「我以为的代码」，不是测「跑起来的页面」。
 *
 * 非循环的判据（关键）：
 *   卡片 DOM 不带 `kind` 属性，若用**被测的徽标**去分类卡片，再用徽标断言，
 *   就是自证循环。所以本脚本用**后端 kind 过滤**作为地面真值：
 *   点左栏 `media-cat-photo` 后，网格里的卡片由后端 `?kind=photo` 返回 ——
 *   这个真值与 `MediaCard.tsx` 无关。随后再交叉核对条数（photo 30 / video 85）。
 *
 * 反向证伪（本项目硬要求，三重）：
 *   1. 死端口跑同一脚本 → 必须 UNREACHABLE（exit 2），证明脚本不是恒绿。
 *   2. **活体篡改**：把「修复前那个统一播放三角」注回一张图片卡片的悬浮层，
 *      用**与正式断言完全同一段检测代码**重新检测 —— 必须报出违规。
 *      这条防的是「检测器本身是瞎的」（例如选择器写错、恒返回 0），
 *      没有它，一个永远返回「没找到播放三角」的检测器也能全绿。
 *   3. **自证伪模式**（`ORIG_VERIFY_REVERT=1`）：把修复前形态注回真实 DOM
 *      （图标改回播放三角 + 移除类型徽标），跑同一套断言 → 必须 exit 1。
 *      这条才证到「缺陷真出现时这套断言会红」；死端口那轮只证到可达性守卫。
 *   4. **BUG-128 自证伪**（`ORIG_VERIFY_REVERT_I18N=1`）：en-US 那一轮把徽标文案
 *      改回硬编码中文（徽标仍在，只是文案错了）→ en-US 两条断言必须 exit 1，
 *      而 zh-CN 断言保持全绿。这条专证「硬编码中文」这一具体形态可被检出 ——
 *      第 3 条只删徽标，压不到它。
 *
 * Usage:
 *   node verify/verify_card_kind_signal.cjs                    # http://127.0.0.1:5180
 *   APP_URL=http://127.0.0.1:59999 node verify/verify_card_kind_signal.cjs   # 反向证伪 1
 *   ORIG_VERIFY_REVERT=1 node verify/verify_card_kind_signal.cjs             # 反向证伪 3（期望 exit 1）
 *   ORIG_VERIFY_REVERT_I18N=1 node verify/verify_card_kind_signal.cjs        # 反向证伪 4（期望 exit 1）
 *   ORIG_VERIFY_OUT=<临时目录> node verify/verify_card_kind_signal.cjs        # 产物目录
 *
 * Exit codes: 0 = 全部断言通过, 1 = 断言失败（页面问题）,
 *             2 = 环境/通道问题（dev server 不可达、浏览器起不来、导航失败）。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

/** 被测页面地址（override 用 APP_URL）。 */
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'

/** 媒体库数据源（orig-tg 9877）——用作与 DOM 交叉核对的地面真值。 */
const MEDIA_API =
  process.env.ORIG_MEDIA_API || 'http://127.0.0.1:9877/api/media/items?limit=200'

/** 产物目录：**必须在仓库外**（AGENTS.md §6 污染防线）。 */
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-card-kind')

/** 导航预算。 */
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)

/** 列表加载预算（点击分类后要等 250ms 防抖 + 后端往返）。 */
const GRID_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_GRID_TIMEOUT || 20000)

/** 环境噪音，不算应用缺陷。 */
const BENIGN_CONSOLE = [/favicon/i, /DevTools/i, /Download the React DevTools/i]

/**
 * 自证伪模式（`ORIG_VERIFY_REVERT=1`）。
 *
 * 把**修复前的形态**注回真实 DOM —— 图片卡片的悬浮图标改回播放三角、
 * 类型徽标整个移除 —— 然后跑**同一套断言**。此时脚本必须以 exit 1 失败。
 *
 * 这是「断言是不是假绿」的正面证据：死端口那轮只证到了可达性守卫，
 * 证不到断言本身有判别力；这一轮才证到「缺陷真的出现时，这套断言会红」。
 * 不设这个开关，脚本就只能证明自己会绿，不能证明自己会红。
 */
const REVERT_TO_PRE_FIX = process.env.ORIG_VERIFY_REVERT === '1'

/**
 * 自证伪模式（`ORIG_VERIFY_REVERT_I18N=1`，BUG-128 专用）。
 *
 * `ORIG_VERIFY_REVERT` 是把类型徽标**整个删掉** —— 它证明的是「徽标缺失会被抓到」，
 * 证不到「徽标在、但文案是硬编码中文」也会被抓到。这两件事不一样：前者只压到
 * 「等值断言非空转」，后者才压到 BUG-128 的具体形态。
 *
 * 打开后，在 en-US 那一轮把徽标文案改回**硬编码中文**（`图片` / `视频`），
 * 期望 en-US 的两条断言变红 → exit 1；同时 zh-CN 的断言应保持全绿，
 * 从而证明失败被精确归因到 en-US 场景，而不是断言整体失灵。
 */
const REVERT_I18N_TO_PRE_FIX = process.env.ORIG_VERIFY_REVERT_I18N === '1'

/**
 * BUG-128 修复前的硬编码徽标文案（自证伪用）。
 *
 * 只在这里出现一次 —— 注入页面时作为参数传进去，注入函数本身不含中文字面量。
 */
const PRE_FIX_KIND_LABEL = { video: '视频', photo: '图片', audio: '音频', file: '文档' }

/** 断言结果收集器（模块级：失败路径也要能 dump 已跑过的项）。 */
const results = []

/**
 * 记录一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败/观测细节
 * @returns {boolean} ok
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

/** 打印已记录的全部断言。 */
function dumpResults() {
  if (results.length === 0) {
    console.log('--- assertions --- (none recorded)')
    return
  }
  console.log('--- assertions ---')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -- ${item.detail || 'n/a'}`}`)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:card-kind] ${results.length - failed}/${results.length} assertions passed`)
}

/** 拒绝把产物写进仓库。 */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory (AGENTS.md §6).',
    )
  }
}

/**
 * 快速 TCP 预检：不可达时 2s 内失败，而不是耗完整个导航预算。
 * @param {string} host 主机
 * @param {number} port 端口
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否有监听
 */
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let done = false
    const finish = ok => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

/**
 * 取一个 JSON 文档（仅本机回环，不读代理环境变量）。
 * @param {string} url 目标
 * @param {number} timeoutMs 超时
 * @returns {Promise<object|null>} 解析结果或 null
 */
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => {
        body += c
      })
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null)
        try {
          finish(JSON.parse(body))
        } catch (_err) {
          finish(null)
        }
      })
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
  })
}

/**
 * 页面内采集：把网格里每张卡片的「悬浮层图标 / 类型徽标」读出来。
 *
 * 刻意定义在模块级且不闭包任何 Node 变量 —— `page.evaluate` 会把它
 * `toString()` 后注入页面执行。
 *
 * @returns {object} 采集结果
 */
function collectGridInPage() {
  /** 悬浮操作层容器（MediaCard.tsx 的 `bg-black/45`）。用 class 子串选择器，
   *  免去 Tailwind 斜杠转义，也不依赖层级猜测。 */
  const layerSelector = '[class*="bg-black/45"]'
  const cards = Array.from(document.querySelectorAll('[data-testid="media-card"]'))
  const items = cards.map(card => {
    const layer = card.querySelector(layerSelector)
    const actionSvg = layer ? layer.querySelector('svg') : null
    const badge = card.querySelector('[data-testid="item-kind"]')
    const badgeClass = badge ? badge.getAttribute('class') || '' : ''
    const titleEl = card.querySelector('p[title]')
    return {
      hasHoverLayer: Boolean(layer),
      /** 悬浮操作图标的 svg class —— lucide 会写语义化类名（lucide-play / lucide-zoom-in ...） */
      actionIcon: actionSvg ? actionSvg.getAttribute('class') || '' : null,
      badge: badge ? (badge.textContent || '').trim() : null,
      /** 徽标必须常驻：不得带 `opacity-0`，且不得吞掉封面点击 */
      badgeAlwaysVisible: Boolean(badge) && !/\bopacity-0\b/.test(badgeClass),
      badgePointerEventsNone: /pointer-events-none/.test(badgeClass),
      noBytes: Boolean(card.querySelector('[data-testid="item-nobytes"]')),
      title: titleEl ? titleEl.textContent : null,
    }
  })
  return {
    gridPresent: Boolean(document.querySelector('[data-testid="media-grid"]')),
    total: items.length,
    cards: items,
  }
}

/**
 * 点击一个 data-testid 元素。
 * @param {object} page CDP page
 * @param {string} testid 目标 testid
 * @returns {Promise<boolean>} 是否点到
 */
async function clickTestId(page, testid) {
  return Boolean(
    await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return false
      el.click()
      return true
    }, testid),
  )
}

/** 等某个 data-testid 出现。 */
async function waitForTestId(page, testid, timeoutMs = GRID_TIMEOUT_MS) {
  await page.waitForFunction(
    id => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    { timeout: timeoutMs, intervalMs: 200, args: [testid] },
  )
}

/**
 * 等网格卡片数达到期望值（期望值来自后端 kind 计数，与组件实现无关）。
 *
 * 为什么不能只等「网格里有卡片」：切换分类时 React **不清空**旧列表 ——
 * 新请求回来之前，网格里躺着的还是上一个分类的卡片。只等「有卡片」会立刻
 * 返回，于是拿**图片分类的 30 张卡**去断言「视频卡片仍是播放三角」，
 * 报出 4 条与修复无关的假 FAIL（实测踩过）。等条数才真正等到数据换血。
 *
 * @param {object} page CDP page
 * @param {number} expected 期望卡片数（<=0 时跳过等待）
 * @param {number} timeoutMs 超时
 * @returns {Promise<void>}
 */
async function waitForGridCount(page, expected, timeoutMs = GRID_TIMEOUT_MS) {
  if (expected <= 0) return
  await page.waitForFunction(
    n =>
      Boolean(document.querySelector('[data-testid="media-grid"]')) &&
      document.querySelectorAll('[data-testid="media-card"]').length === n,
    { timeout: timeoutMs, intervalMs: 250, args: [expected] },
  )
}

/** 媒体库一页的条数上限（MediaLibraryPanel 的 `PAGE`）。 */
const PAGE_LIMIT = 120

/** 悬浮层图标是否为播放三角。 */
const isPlayIcon = cls => /lucide-play\b/.test(cls || '')
/** 悬浮层图标是否为看图语义（ZoomIn）。 */
const isZoomInIcon = cls => /lucide-zoom-in\b/.test(cls || '')

/**
 * 文案里是否含 CJK 统一表意文字（BUG-128）。
 *
 * 徽标一旦出现任何一个 CJK 字符，就说明它没走 i18n —— 硬编码中文的**直接指纹**。
 * 断言「等于 Photo」已经能抓到本缺陷，这条是更强的独立判据：将来文案被改成
 * 「图片（Photo）」这类中英混排时，等值断言会漏，CJK 扫描不会。
 */
const hasCJK = s => /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(s || ''))

/**
 * 点击一个文案（trim 后）恰好等于 text 的按钮。
 *
 * 语言切换按钮没有 `data-testid`，但它的文案来自 `SUPPORTED_LANGUAGES[].label`
 * —— 语言**自称**（`简体中文` / `English`），不随当前 locale 变，因此按文案定位
 * 在两个语言下都稳定。
 *
 * @param {object} page CDP page
 * @param {string} text 目标按钮文案
 * @returns {Promise<boolean>} 是否点到
 */
async function clickButtonByText(page, text) {
  return Boolean(
    await page.evaluate(txt => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const hit = buttons.find(b => (b.textContent || '').trim() === txt)
      if (!hit) return false
      hit.click()
      return true
    }, text),
  )
}

/**
 * 走真实 UI 把界面语言切到目标 locale（BUG-128 验收）。
 *
 * 路径：侧栏「设置」→ 设置左栏「通用」→ 语言卡片里点目标语言按钮。
 *
 * 为什么不用「直接写 localStorage + 刷新」：那绕开了用户真实路径。万一语言按钮
 * 本身接错了线（点了没反应），改 localStorage 的脚本仍然会绿 —— 那是假绿。
 * 走 UI 才同时验到「入口可达」与「切换真的生效」。
 *
 * @param {object} page CDP page
 * @param {string} label 目标语言按钮文案（`English` / `简体中文`）
 * @param {string} expectLang 期望的 `<html lang>` 值
 * @returns {Promise<boolean>} 是否完成切换（按钮点到 + `<html lang>` 已生效）
 */
async function switchLocaleViaUI(page, label, expectLang) {
  if (!(await clickTestId(page, 'nav-settings'))) return false
  try {
    await waitForTestId(page, 'settings-tab-general', 15000)
  } catch (_err) {
    return false
  }
  await clickTestId(page, 'settings-tab-general')
  try {
    await page.waitForFunction(
      txt =>
        Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').trim() === txt),
      { timeout: 15000, intervalMs: 200, args: [label] },
    )
  } catch (_err) {
    return false
  }
  if (!(await clickButtonByText(page, label))) return false
  // `setLanguage()` 会同步写 `<html lang>`（i18n/index.ts）。它变了就说明
  // `setLanguage` 真的跑了 —— 也就是 store 里 `settings.language` 真的变了，
  // 而那正是 `useTranslation()` 订阅、驱动卡片重渲染的那个值。
  try {
    await page.waitForFunction(
      lang => document.documentElement.getAttribute('lang') === lang,
      { timeout: 10000, intervalMs: 100, args: [expectLang] },
    )
  } catch (_err) {
    return false
  }
  return true
}

/**
 * 自证伪辅助：把「修复前形态」注回**当前网格**（图标改回播放三角 + 移除类型徽标）。
 *
 * 每次重新进入网格后都必须重注 —— SPA 切视图会重建 DOM，注入随之丢失。
 * 只注一次的话，后续断言会跑在「已经修好的 DOM」上，自证伪通道就断了。
 *
 * @param {object} page CDP page
 * @returns {Promise<number>} 被改写的卡片数
 */
async function injectPreFixIntoGrid(page) {
  return Number(
    await page.evaluate(() => {
      const layerSelector = '[class*="bg-black/45"]'
      let n = 0
      for (const card of document.querySelectorAll('[data-testid="media-card"]')) {
        const layer = card.querySelector(layerSelector)
        const svg = layer ? layer.querySelector('svg') : null
        if (svg) {
          svg.setAttribute('class', 'lucide lucide-play h-4 w-4')
          n++
        }
        const badge = card.querySelector('[data-testid="item-kind"]')
        if (badge) badge.remove()
      }
      return n
    }),
  )
}

/**
 * 自证伪（BUG-128）：把当前网格的徽标文案改回**硬编码中文**，模拟修复前形态。
 *
 * 与 `injectPreFixIntoGrid` 的区别：那个删徽标，这个**保留**徽标只换文案 ——
 * 专门用来压 BUG-128 的那两条断言（等值 + CJK 扫描）是否真的有判别力。
 *
 * @param {object} page CDP page
 * @param {Record<string, string>} labels kind → 硬编码中文文案
 * @returns {Promise<number>} 被改写的卡片数
 */
async function injectPreFixLabelsIntoGrid(page, labels) {
  return Number(
    await page.evaluate(map => {
      const layerSelector = '[class*="bg-black/45"]'
      let n = 0
      for (const card of document.querySelectorAll('[data-testid="media-card"]')) {
        const badge = card.querySelector('[data-testid="item-kind"]')
        if (!badge) continue
        const layer = card.querySelector(layerSelector)
        const svg = layer ? layer.querySelector('svg') : null
        const cls = svg ? svg.getAttribute('class') || '' : ''
        // 用悬浮图标反推 kind —— 它语言无关，可以当作地面真值
        const kind = /lucide-zoom-in\b/.test(cls) ? 'photo' : /lucide-play\b/.test(cls) ? 'video' : null
        if (!kind || !map[kind]) continue
        badge.textContent = map[kind]
        n++
      }
      return n
    }, labels),
  )
}

/**
 * 读取左栏某个分类按钮的**文案**（第一个 span）。
 *
 * 按钮结构是 `<span>文案</span><span>计数</span>`，直接取 `textContent` 会把计数
 * 粘进来（`Photos30`），所以只读第一个子元素。
 *
 * @param {object} page CDP page
 * @param {string} key 分类 key（photo / video / ...）
 * @returns {Promise<string|null>} 文案
 */
async function readCategoryLabel(page, key) {
  const value = await page.evaluate(k => {
    const el = document.querySelector(`[data-testid="media-cat-${k}"]`)
    return el && el.firstElementChild ? (el.firstElementChild.textContent || '').trim() : null
  }, key)
  return value === undefined ? null : value
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[verify:card-kind] target: ${APP_URL}`)
  console.log(`[verify:card-kind] media api: ${MEDIA_API}`)
  console.log(`[verify:card-kind] artifacts: ${OUT_DIR}`)

  // ---- 环境预检：dev server 必须可达（否则 exit 2，不是断言失败）----
  const target = new URL(APP_URL)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (!(await tcpProbe(target.hostname, targetPort))) {
    console.error(
      `[verify:card-kind] dev server unreachable: nothing is listening on ${target.host}`,
    )
    console.error('[verify:card-kind] start it with `npm run dev` (vite: 127.0.0.1:5180)')
    dumpResults()
    console.error('[verify:card-kind] RESULT: UNREACHABLE (exit 2)')
    return 2
  }

  // ---- 地面真值：后端各 kind 的条数（与 MediaCard.tsx 无关）----
  const api = await httpGetJson(MEDIA_API)
  const apiItems = api && Array.isArray(api.items) ? api.items : null
  if (!apiItems) {
    console.error(
      `[verify:card-kind] media api unreachable or malformed: ${MEDIA_API}`,
    )
    console.error('[verify:card-kind] orig-tg (9877) must be running for a meaningful run')
    dumpResults()
    console.error('[verify:card-kind] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const apiByKind = apiItems.reduce((acc, it) => {
    acc[it.kind] = (acc[it.kind] || 0) + 1
    return acc
  }, {})
  console.log(
    `[verify:card-kind] backend truth: total=${apiItems.length} kinds=${JSON.stringify(apiByKind)}`,
  )

  const browser = await cdp.launch()
  console.log(`[verify:card-kind] browser: ${browser.executable} (devtools port ${browser.port})`)

  try {
    const page = await browser.newPage()
    try {
      // 不等待 #root：白屏要报成断言失败（exit 1），不能被误判成环境问题（exit 2）。
      await page.goto(APP_URL, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
        settleMs: 1500,
        waitForRoot: false,
      })
    } catch (err) {
      console.error(`[verify:card-kind] navigation failed: ${err && err.message ? err.message : err}`)
      dumpResults()
      console.error('[verify:card-kind] RESULT: UNREACHABLE (exit 2)')
      return 2
    }

    console.log('')
    console.log('--- 前置：进入媒体库内容列表 ---')

    // 侧栏「媒体库」入口 —— 自己探索出来的锚点，不猜。
    try {
      await waitForTestId(page, 'nav-media', 15000)
    } catch (_err) {
      check('sidebar [data-testid="nav-media"] 存在', false, '侧栏未渲染出媒体库入口（页面白屏？）')
      const html = await page.content()
      fs.writeFileSync(path.join(OUT_DIR, 'dom-no-nav-media.html'), html, 'utf8')
      dumpResults()
      console.log('[verify:card-kind] RESULT: FAIL (app did not render sidebar)')
      return 1
    }
    check('sidebar [data-testid="nav-media"] 存在', true)

    const entered = await clickTestId(page, 'nav-media')
    check('点击 nav-media 进入媒体库', entered)

    // 左栏分类按钮出现（其计数来自后端 stats，0 计数不渲染）
    let catAll = false
    try {
      await waitForTestId(page, 'media-cat-all', 15000)
      catAll = true
    } catch (_err) {
      catAll = false
    }
    check('媒体库左栏分类按钮渲染（media-cat-all）', catAll)

    const hasPhotoCat = Boolean(
      await page.evaluate(() => Boolean(document.querySelector('[data-testid="media-cat-photo"]'))),
    )
    const hasVideoCat = Boolean(
      await page.evaluate(() => Boolean(document.querySelector('[data-testid="media-cat-video"]'))),
    )
    check('左栏存在「图片」分类（media-cat-photo）', hasPhotoCat, `backend photo=${apiByKind.photo ?? 0}`)
    check('左栏存在「视频」分类（media-cat-video）', hasVideoCat, `backend video=${apiByKind.video ?? 0}`)

    // ================= 正向：图片分类 =================
    console.log('')
    console.log('--- 正向断言 A：图片分类（后端 ?kind=photo 为地面真值）---')

    const photoExpected = Math.min(apiByKind.photo ?? 0, PAGE_LIMIT)
    await clickTestId(page, 'media-cat-photo')
    let photoSynced = true
    try {
      await waitForGridCount(page, photoExpected)
    } catch (err) {
      photoSynced = false
      check(
        '图片分类网格刷新到后端条数',
        false,
        `等待 ${photoExpected} 张卡片超时（旧分类数据未换血）: ${err && err.message ? err.message : err}`,
      )
    }
    if (photoSynced) check('图片分类网格刷新到后端条数', true, `expected=${photoExpected}`)

    // 自证伪：把修复前的形态注回真实 DOM，后续断言必须以 FAIL 收场
    if (REVERT_TO_PRE_FIX) {
      const reverted = await injectPreFixIntoGrid(page)
      console.log(
        `[verify:card-kind] FALSIFY: 已把 ${reverted} 张图片卡片的悬浮图标改回播放三角、并移除类型徽标（模拟修复前）`,
      )
    }

    {
      const photoGrid = await page.evaluate(collectGridInPage)
      const photoCards = photoGrid.cards
      const photoTotal = photoGrid.total
      const playInPhoto = photoCards.filter(c => isPlayIcon(c.actionIcon))
      const zoomInPhoto = photoCards.filter(c => isZoomInIcon(c.actionIcon))
      const noLayer = photoCards.filter(c => !c.hasHoverLayer)
      const badgeNotPhoto = photoCards.filter(c => c.badge !== '图片')
      const badgeNotPersistent = photoCards.filter(c => !c.badgeAlwaysVisible)
      const badgeNotClickThrough = photoCards.filter(c => !c.badgePointerEventsNone)

      console.log(
        `[verify:card-kind] photo 卡片=${photoTotal} 悬浮层图标样本=` +
          JSON.stringify(photoCards.slice(0, 4).map(c => c.actionIcon)),
      )
      console.log(
        `[verify:card-kind] photo 徽标样本=` +
          JSON.stringify(photoCards.slice(0, 4).map(c => c.badge)),
      )

      check('图片分类卡片数 > 0（避免后续断言空转）', photoTotal > 0, `cards=${photoTotal}`)

      // ★ 核心断言：图片卡片的悬浮层**绝不是**播放三角
      check(
        '★ 图片卡片悬浮层不含播放三角（lucide-play）',
        photoTotal > 0 && playInPhoto.length === 0,
        `photo=${photoTotal} 含播放三角=${playInPhoto.length}` +
          (playInPhoto.length > 0 ? ` 首个=${JSON.stringify(playInPhoto[0].actionIcon)}` : ''),
      )
      // 正向对照：确实是看图语义，而不是「什么都没渲染」（后者会让上一条假绿）
      check(
        '图片卡片悬浮层是看图语义（lucide-zoom-in）',
        photoTotal > 0 && zoomInPhoto.length === photoTotal,
        `zoom-in=${zoomInPhoto.length}/${photoTotal}`,
      )
      check(
        '图片卡片均存在悬浮操作层（上一条非空转）',
        photoTotal > 0 && noLayer.length === 0,
        `无悬浮层=${noLayer.length}`,
      )
      check(
        '图片卡片常驻徽标文本为「图片」',
        photoTotal > 0 && badgeNotPhoto.length === 0,
        `不符=${badgeNotPhoto.length}` +
          (badgeNotPhoto.length > 0 ? ` 样本=${JSON.stringify(badgeNotPhoto.slice(0, 3).map(c => c.badge))}` : ''),
      )
      check(
        '图片徽标常驻可见（class 不含 opacity-0，无需 hover）',
        photoTotal > 0 && badgeNotPersistent.length === 0,
        `不常驻=${badgeNotPersistent.length}`,
      )
      check(
        '图片徽标 pointer-events-none（不吞掉封面点击）',
        photoTotal > 0 && badgeNotClickThrough.length === 0,
        `非穿透=${badgeNotClickThrough.length}`,
      )
      // 交叉核对：DOM 条数 == 后端 photo 条数
      check(
        '图片分类卡片数 == 后端 photo 条数',
        photoTotal === (apiByKind.photo ?? 0),
        `dom=${photoTotal} backend=${apiByKind.photo ?? 0}`,
      )
    }

    // ================= 正向：视频分类（正向对照） =================
    console.log('')
    console.log('--- 正向断言 B：视频分类（证明播放三角只被"移走"而非"全删"）---')

    const videoExpected = Math.min(apiByKind.video ?? 0, PAGE_LIMIT)
    await clickTestId(page, 'media-cat-video')
    let videoSynced = true
    try {
      await waitForGridCount(page, videoExpected)
    } catch (err) {
      videoSynced = false
      check(
        '视频分类网格刷新到后端条数',
        false,
        `等待 ${videoExpected} 张卡片超时（旧分类数据未换血）: ${err && err.message ? err.message : err}`,
      )
    }
    if (videoSynced) check('视频分类网格刷新到后端条数', true, `expected=${videoExpected}`)

    {
      const videoGrid = await page.evaluate(collectGridInPage)
      const videoCards = videoGrid.cards
      const videoTotal = videoGrid.total
      const playInVideo = videoCards.filter(c => isPlayIcon(c.actionIcon))
      const zoomInVideo = videoCards.filter(c => isZoomInIcon(c.actionIcon))
      const badgeNotVideo = videoCards.filter(c => c.badge !== '视频')

      console.log(
        `[verify:card-kind] video 卡片=${videoTotal} 悬浮层图标样本=` +
          JSON.stringify(videoCards.slice(0, 4).map(c => c.actionIcon)),
      )

      check('视频分类卡片数 > 0', videoTotal > 0, `cards=${videoTotal}`)
      // 视频仍然保留播放三角 —— 没有这条，「把图标全删掉」也能过核心断言
      check(
        '视频卡片悬浮层仍是播放三角（lucide-play）',
        videoTotal > 0 && playInVideo.length === videoTotal,
        `play=${playInVideo.length}/${videoTotal}`,
      )
      check(
        '视频卡片不含看图语义图标（lucide-zoom-in）',
        zoomInVideo.length === 0,
        `zoom-in=${zoomInVideo.length}`,
      )
      check(
        '视频卡片常驻徽标文本为「视频」',
        videoTotal > 0 && badgeNotVideo.length === 0,
        `不符=${badgeNotVideo.length}` +
          (badgeNotVideo.length > 0 ? ` 样本=${JSON.stringify(badgeNotVideo.slice(0, 3).map(c => c.badge))}` : ''),
      )
      check(
        '视频分类卡片数 == 后端 video 条数',
        videoTotal === (apiByKind.video ?? 0),
        `dom=${videoTotal} backend=${apiByKind.video ?? 0}`,
      )
    }

    // ================= 反向证伪 1：活体篡改检测器 =================
    console.log('')
    console.log('--- 反向证伪 1：把"修复前的统一播放三角"注回图片卡片，检测器必须报出 ---')

    // 回到图片分类，在真实 DOM 上做篡改—检测—还原
    await clickTestId(page, 'media-cat-photo')
    try {
      await waitForGridCount(page, photoExpected)
    } catch (_err) {
      // 由下面的断言如实报告：网格若仍是视频分类，篡改的就不是图片卡片
    }

    const tamper = await page.evaluate(() => {
      const layerSelector = '[class*="bg-black/45"]'
      const readPlayCount = () => {
        const cards = Array.from(document.querySelectorAll('[data-testid="media-card"]'))
        let n = 0
        for (const card of cards) {
          const layer = card.querySelector(layerSelector)
          const svg = layer ? layer.querySelector('svg') : null
          if (svg && /lucide-play\b/.test(svg.getAttribute('class') || '')) n++
        }
        return n
      }
      const before = readPlayCount()
      const cards = Array.from(document.querySelectorAll('[data-testid="media-card"]'))
      for (const card of cards) {
        const layer = card.querySelector(layerSelector)
        if (!layer) continue
        const svg = layer.querySelector('svg')
        if (!svg) continue
        if (/lucide-play\b/.test(svg.getAttribute('class') || '')) continue
        // 注入修复前的形态：图片卡片也挂播放三角
        const clone = svg.cloneNode(true)
        clone.setAttribute('class', 'lucide lucide-play h-4 w-4')
        svg.replaceWith(clone)
        const after = readPlayCount()
        clone.replaceWith(svg)
        return { before, after, restored: readPlayCount(), injected: true }
      }
      return { before, after: before, restored: before, injected: false }
    })

    console.log(
      `[verify:card-kind] tamper: injected=${tamper.injected} before=${tamper.before} after=${tamper.after} restored=${tamper.restored}`,
    )
    check(
      '★ 检测器非空转：注入播放三角后能被检出，且注入已还原',
      tamper.injected && tamper.after === tamper.before + 1 && tamper.restored === tamper.before,
      `before=${tamper.before} after=${tamper.after} restored=${tamper.restored}`,
    )

    // ================= en-US：徽标文案必须随 locale 变化（BUG-128） =================
    console.log('')
    console.log('--- en-US 断言（BUG-128）：徽标走 i18n，英文界面不得混排中文 ---')

    /*
     * 为什么必须单独跑一轮 en-US：
     *   BUG-128 是**单语可见**缺陷 —— zh-CN 的期望值恰好就是中文，硬编码中文与
     *   i18n 取值在中文环境下渲染结果**完全一样**。所以上面那轮 zh-CN 断言对
     *   本缺陷毫无判别力，必须把 locale 真的切过去才测得出。
     *
     * 防假绿（关键）：只断言「徽标变成英文」不够 —— 得先证明 locale 真生效，
     *   否则断言建立在一个没被验证的前提上。所以额外核对**另一个已知会变的文案**
     *   （左栏分类按钮 `media.photos`：zh-CN「图片」→ en-US「Photos」）与
     *   `<html lang>`：三者同时变，才认 locale 生效。分类名与徽标是两套 i18n 键，
     *   分类名变了本身就证明 `t()` 取的是 en-US 词典。
     */

    // 基线：切换前同一个分类按钮的文案（zh-CN），作为「切换后必须变」的对照组
    const catLabelBefore = await readCategoryLabel(page, 'photo')
    const langBefore = await page.evaluate(() => document.documentElement.getAttribute('lang'))
    check(
      '切换前 <html lang> 为 zh-CN（证明后面的切换是真变化，而非本来如此）',
      langBefore === 'zh-CN',
      `lang=${langBefore}`,
    )
    check(
      '切换前分类按钮文案为「图片」（对照组基线）',
      catLabelBefore === '图片',
      `label=${catLabelBefore}`,
    )

    const switched = await switchLocaleViaUI(page, 'English', 'en-US')
    check('走真实 UI（设置 → 通用 → English）完成切换', switched)

    const langAfter = await page.evaluate(() => document.documentElement.getAttribute('lang'))
    check('切换后 <html lang> 变为 en-US', langAfter === 'en-US', `lang=${langAfter}`)

    // 回媒体库，重新进入图片分类（SPA 切视图会重建卡片 DOM）
    await clickTestId(page, 'nav-media')
    try {
      await waitForTestId(page, 'media-cat-all', 15000)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }

    const catLabelAfter = await readCategoryLabel(page, 'photo')
    // ★ 这条是「locale 真的生效」的证据，不是重复断言：它证明的是**前提**成立，
    //   后面的徽标断言才有意义。
    check(
      '★ locale 确已生效：同一分类按钮文案变为「Photos」（非仅徽标变化）',
      catLabelAfter === 'Photos',
      `label=${catLabelAfter}`,
    )

    await clickTestId(page, 'media-cat-photo')
    let enPhotoSynced = true
    try {
      await waitForGridCount(page, photoExpected)
    } catch (err) {
      enPhotoSynced = false
      check('en-US 图片分类网格刷新到后端条数', false, `${err && err.message ? err.message : err}`)
    }
    if (enPhotoSynced) check('en-US 图片分类网格刷新到后端条数', true, `expected=${photoExpected}`)
    // 自证伪通道在新一轮里也要续上：切视图后 DOM 重建，注入会丢
    if (REVERT_TO_PRE_FIX) await injectPreFixIntoGrid(page)
    if (REVERT_I18N_TO_PRE_FIX) {
      const n = await injectPreFixLabelsIntoGrid(page, PRE_FIX_KIND_LABEL)
      console.log(
        `[verify:card-kind] FALSIFY(i18n): 已把 ${n} 张图片卡片的徽标改回硬编码中文（模拟 BUG-128 修复前）`,
      )
    }

    {
      const grid = await page.evaluate(collectGridInPage)
      const cards = grid.cards
      const total = grid.total
      const notEnglish = cards.filter(c => c.badge !== 'Photo')
      const withCJK = cards.filter(c => hasCJK(c.badge))
      console.log(
        `[verify:card-kind] en-US photo 徽标样本=${JSON.stringify(cards.slice(0, 4).map(c => c.badge))}`,
      )
      check('en-US 图片分类卡片数 > 0', total > 0, `cards=${total}`)
      check(
        '★ en-US 图片卡片徽标文本为「Photo」',
        total > 0 && notEnglish.length === 0,
        `不符=${notEnglish.length}` +
          (notEnglish.length > 0 ? ` 样本=${JSON.stringify(notEnglish.slice(0, 3).map(c => c.badge))}` : ''),
      )
      check(
        '★ en-US 图片卡片徽标不含 CJK 字符（硬编码中文在这里现形）',
        total > 0 && withCJK.length === 0,
        `含 CJK=${withCJK.length}` +
          (withCJK.length > 0 ? ` 样本=${JSON.stringify(withCJK.slice(0, 3).map(c => c.badge))}` : ''),
      )
    }

    // 视频分支同样核一遍 —— 只验 photo 会漏掉「只修了一个分支」
    await clickTestId(page, 'media-cat-video')
    let enVideoSynced = true
    try {
      await waitForGridCount(page, videoExpected)
    } catch (err) {
      enVideoSynced = false
      check('en-US 视频分类网格刷新到后端条数', false, `${err && err.message ? err.message : err}`)
    }
    if (enVideoSynced) check('en-US 视频分类网格刷新到后端条数', true, `expected=${videoExpected}`)
    if (REVERT_TO_PRE_FIX) await injectPreFixIntoGrid(page)

    {
      const grid = await page.evaluate(collectGridInPage)
      const cards = grid.cards
      const total = grid.total
      const notEnglish = cards.filter(c => c.badge !== 'Video')
      const withCJK = cards.filter(c => hasCJK(c.badge))
      console.log(
        `[verify:card-kind] en-US video 徽标样本=${JSON.stringify(cards.slice(0, 4).map(c => c.badge))}`,
      )
      check('en-US 视频分类卡片数 > 0', total > 0, `cards=${total}`)
      check(
        '★ en-US 视频卡片徽标文本为「Video」',
        total > 0 && notEnglish.length === 0,
        `不符=${notEnglish.length}` +
          (notEnglish.length > 0 ? ` 样本=${JSON.stringify(notEnglish.slice(0, 3).map(c => c.badge))}` : ''),
      )
      check(
        '★ en-US 视频卡片徽标不含 CJK 字符',
        total > 0 && withCJK.length === 0,
        `含 CJK=${withCJK.length}` +
          (withCJK.length > 0 ? ` 样本=${JSON.stringify(withCJK.slice(0, 3).map(c => c.badge))}` : ''),
      )
    }

    // ---- 还原 zh-CN：证明切换双向可用，且 BUG-123 的 zh-CN 渲染值一字未变 ----
    const restored = await switchLocaleViaUI(page, '简体中文', 'zh-CN')
    check('走真实 UI 切回 zh-CN', restored)
    await clickTestId(page, 'nav-media')
    try {
      await waitForTestId(page, 'media-cat-all', 15000)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    await clickTestId(page, 'media-cat-photo')
    try {
      await waitForGridCount(page, photoExpected)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    {
      const grid = await page.evaluate(collectGridInPage)
      const notZh = grid.cards.filter(c => c.badge !== '图片')
      check(
        '★ 切回 zh-CN 后徽标仍为「图片」（BUG-123 的渲染值未被 i18n 改造动过）',
        grid.total > 0 && notZh.length === 0,
        `不符=${notZh.length}/${grid.total}`,
      )
    }

    // ================= 补充：audio / file 无数据，只能做源码级核对 =================
    console.log('')
    console.log('--- 补充（源码级，非渲染）：audio / file 分支无数据可验 ---')

    const srcPath = path.join(__dirname, '..', 'src', 'components', 'media', 'MediaCard.tsx')
    const src = fs.readFileSync(srcPath, 'utf8')
    const mapping = {
      'video: Play': /video:\s*Play\b/.test(src),
      'photo: ZoomIn': /photo:\s*ZoomIn\b/.test(src),
      'audio: Music': /audio:\s*Music\b/.test(src),
      'file: FileText': /file:\s*FileText\b/.test(src),
      'FALLBACK = Maximize2': /FALLBACK_ACTION_ICON:\s*LucideIcon\s*=\s*Maximize2\b/.test(src),
    }
    console.log(`[verify:card-kind] 源码映射: ${JSON.stringify(mapping)}`)
    check(
      'KIND_ACTION_ICON 四类 + 未知兜底映射齐全（源码级）',
      Object.values(mapping).every(Boolean),
      JSON.stringify(mapping),
    )
    check(
      'photo 分支不是 Play（源码级防回归）',
      /photo:\s*ZoomIn\b/.test(src) && !/photo:\s*Play\b/.test(src),
      'photo 必须映射到看图语义',
    )

    // ---- BUG-128 源码 / 资源级核对：徽标文案必须走 i18n 键，两个词典都得有 ----
    const i18nMapping = {
      'video → media.kindVideo': /video:\s*'media\.kindVideo'/.test(src),
      'photo → media.kindPhoto': /photo:\s*'media\.kindPhoto'/.test(src),
      'audio → media.kindAudio': /audio:\s*'media\.kindAudio'/.test(src),
      'file → media.kindFile': /file:\s*'media\.kindFile'/.test(src),
    }
    console.log(`[verify:card-kind] 徽标 i18n 键映射: ${JSON.stringify(i18nMapping)}`)
    check(
      '类型徽标映射到 i18n 键而非中文字面量（源码级，BUG-128）',
      Object.values(i18nMapping).every(Boolean),
      JSON.stringify(i18nMapping),
    )
    // 硬编码中文的指纹：KIND_LABEL 那张表里若再出现 `video: '视频'` 就说明回退了
    check(
      'KIND_LABEL 不再把中文字面量当文案（源码级，BUG-128）',
      !/video:\s*'视频'|photo:\s*'图片'|audio:\s*'音频'|file:\s*'文档'/.test(src),
      '检测到中文字面量直接作为徽标文案',
    )

    const locales = {}
    for (const lang of ['zh-CN', 'en-US']) {
      const p = path.join(__dirname, '..', 'src', 'i18n', 'locales', `${lang}.json`)
      locales[lang] = JSON.parse(fs.readFileSync(p, 'utf8'))
    }
    const want = {
      'media.kindVideo': { 'zh-CN': '视频', 'en-US': 'Video' },
      'media.kindPhoto': { 'zh-CN': '图片', 'en-US': 'Photo' },
      'media.kindAudio': { 'zh-CN': '音频', 'en-US': 'Audio' },
      'media.kindFile': { 'zh-CN': '文档', 'en-US': 'Document' },
    }
    const missing = []
    for (const [key, byLang] of Object.entries(want)) {
      for (const lang of ['zh-CN', 'en-US']) {
        if (locales[lang][key] !== byLang[lang]) {
          missing.push(`${lang}:${key}=${JSON.stringify(locales[lang][key])}≠${JSON.stringify(byLang[lang])}`)
        }
      }
    }
    check(
      '两个 locale 词典都有 4 个 media.kind* 键且取值正确（BUG-128）',
      missing.length === 0,
      missing.join(' | '),
    )
    // 单语可见缺陷的通用防线：英文词典里任何 media.kind* 值都不得含 CJK
    const enCJK = Object.keys(want).filter(k => hasCJK(locales['en-US'][k]))
    check(
      'en-US 词典的 media.kind* 取值不含 CJK（BUG-128 的资源级判据）',
      enCJK.length === 0,
      enCJK.length > 0 ? `含 CJK 的键=${JSON.stringify(enCJK)}` : '',
    )
    console.log(
      `[verify:card-kind] NOTE: 媒体库当前无 audio/file 数据（audio=${apiByKind.audio ?? 0} file=${apiByKind.file ?? 0}），` +
        '这两条分支的**渲染结果**本轮无法在真实页面验证，仅源码级核对。',
    )

    // ================= 运行时健康 =================
    console.log('')
    console.log('--- 运行时健康 ---')
    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
    const realConsole = page
      .consoleErrors()
      .filter(m => !BENIGN_CONSOLE.some(re => re.test(m)))
    check('无 console error（忽略 favicon 等环境噪音）', realConsole.length === 0, JSON.stringify(realConsole.slice(0, 3)))

    // ================= 产物 =================
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const html = await page.content()
    const domPath = path.join(OUT_DIR, `card-kind-${stamp}.html`)
    fs.writeFileSync(domPath, html, 'utf8')
    const resultPath = path.join(OUT_DIR, `card-kind-${stamp}.json`)
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ appUrl: APP_URL, backendKinds: apiByKind, tamper, results }, null, 2),
      'utf8',
    )
    console.log(`[verify:card-kind] DOM 快照: ${domPath} (${Buffer.byteLength(html, 'utf8')} bytes)`)
    console.log(`[verify:card-kind] 结果: ${resultPath}`)

    console.log('')
    const failed = results.filter(r => !r.ok)
    const passed = results.length - failed.length
    console.log(`[verify:card-kind] ${passed}/${results.length} assertions passed`)
    if (failed.length > 0) {
      console.log('')
      console.log('--- FAILURES ---')
      for (const item of failed) console.log(`  - ${item.name}: ${item.detail || 'n/a'}`)
      console.log(`[verify:card-kind] RESULT: FAIL (${failed.length} failed)`)
      return 1
    }
    console.log('[verify:card-kind] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:card-kind] ERROR: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    console.error('[verify:card-kind] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  })
