#!/usr/bin/env node
'use strict'

/**
 * BUG-305 验收（活栈 · CDP）：媒体库「在 TG 中查看」= **应用内跳转**
 * （切到 TG 插件面板 → 选中来源频道 → 定位来源消息并高亮），而非只开 t.me 外链。
 *
 * ## 判据（对应 docs/bugs/BUG-305.md「可证伪判据」1-7，每条都可反向证伪）
 *
 *   1. 应用内跳转可达且定位正确：点入口 → 切到 TG 面板（DOM 事实），
 *      `data-channel-id === chatId`，消息流存在 `data-message-key="s-<chat>-<msg>"`
 *      且被高亮（`data-tg-highlight="true"`）且已滚进可视区。
 *   2. 不离开应用：点击不产生框架导航 / 新标签，URL 不变、页面可见；
 *      t.me 外链降为**次要出口**（独立 <a target="_blank">，BUG-285 回归保持）。
 *   3. 条目级与剧集级都可跳：MediaCard 入口（`item-view-tg`）+
 *      SeriesDetail 来源块（`episode-source-jump-tg`）与列表行
 *      （`episode-row-view-tg`）—— 两类都定位到同一频道同一消息。
 *   4. 本地 / 无坐标不渲染入口：本地条目卡片、本地剧集来源块与列表行 0 入口。
 *   5. 错误坐标必 FAIL：伪 messageId / 伪 chatId 注入 ⇒ 无高亮、无静默成功，
 *      焦点被一次性消费、失败有如实反馈（global-toast）。
 *   6. 不回退反向跳转：`pendingMediaFocus` 字段与 setter 仍在（运行时 + 源码）。
 *   7. 真实 UI 可核：全部断言基于 data-* 属性与几何事实；脚本自身零类名推断
 *      （末条自证检查读本文件，出现读取元素类名的代码即 FAIL）。
 *
 * ## 目标选取（运行时从 API 派生，不写死任何 id）
 *
 *   ① 监控频道列表（`/api/tg/monitor/channels`）非空 —— 空则 Loud FAIL；
 *   ② 媒体库条目里选一条 **TG 来源 + ref 可解析 + 频道已监控 + 有字节 +
 *      属于某剧集** 的条目（剧集级判据需要它）；
 *   ③ 该消息必须真的在监控消息流里（翻页可达）—— 否则 Loud FAIL
 *      （目标不可定位却跑判据 = 假绿）；
 *   ④ 负样本：一条本地来源 + 有字节的条目，及其所在剧集（本地分集）。
 *
 * ## 反向证伪（脚本内一轮，字节级还原）
 *
 *   摘掉 MediaLibraryPanel `viewInTg` 里的 `setPendingTgFocus(coords)`：
 *   入口仍在、仍切面板（证明红的不是「按钮没了」），但焦点从未设过
 *   ⇒ 判据 1/7 必须 RED；sha256 复原后复跑必须复绿。
 *
 * ## 环境
 *
 *   活栈：vite :5180 / orig-daemon :19786 / orig-tg（端口经 `_lib_endpoints.cjs`
 *   从 daemon `/api/config` 的 `tg_port` 运行时解析，不写死）。dev stack 不许动。
 *
 * 用法：`node tauri-shell/verify/verify_bug305_tg_jump.cjs`（仓库根）
 * Env : ORIG_VERIFY_OUT（截图 / result.json 输出目录，默认 verify/evidence/BUG-305）
 * Exit: 0 = 全部通过；2 = 有判据失败（含证伪红态未按预期失败 / 还原后不复绿）。
 */

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-305')
const SHELL = path.resolve(__dirname, '..')
const USE_STORE_TS = path.join(SHELL, 'src', 'store', 'useStore.ts')
const SERIES_DETAIL_TSX = path.join(SHELL, 'src', 'components', 'media', 'SeriesDetail.tsx')
const MEDIA_LIBRARY_PANEL_TSX = path.join(SHELL, 'src', 'components', 'MediaLibraryPanel.tsx')
const LOCALE_ZH = path.join(SHELL, 'src', 'i18n', 'locales', 'zh-CN.json')
const LOCALE_EN = path.join(SHELL, 'src', 'i18n', 'locales', 'en-US.json')
const SELF = __filename

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Loud failure：没有可验证目标时绝不跑判据（跳过伪装成通过 = 假绿）。 */
function fatal(msg) {
  console.error(`\n[bug305] FATAL: ${msg}`)
  process.exit(2)
}

// ─────────────────────────── HTTP（仅回环，读真值 / 派生目标） ───────────────────────────

async function apiGet(base, p, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(base + p, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${p} -> HTTP ${res.status} ${text.slice(0, 120)}`)
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

/** 翻页遍历媒体库条目（offset 分页；同一批 id 重复出现即止，防呆）。 */
async function listAllItems(tg) {
  const out = []
  const seen = new Set()
  for (let offset = 0; offset < 4000; offset += 500) {
    const r = await apiGet(tg, `/api/media/items?limit=500&offset=${offset}`)
    const batch = (r && r.items) || []
    let fresh = 0
    for (const it of batch) {
      if (!seen.has(it.id)) {
        seen.add(it.id)
        out.push(it)
        fresh += 1
      }
    }
    if (batch.length < 500 || fresh === 0) break
  }
  return out
}

/** 目标消息是否真的在监控消息流里（有界翻页；找不到 = 目标不可定位）。 */
async function monitorMessageReachable(tg, chatId, messageId, maxPages = 12) {
  let before
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ channelId: String(chatId), limit: '30' })
    if (before !== undefined) q.set('beforeId', String(before))
    const r = await apiGet(tg, `/api/tg/monitor/messages?${q}`)
    const items = (r && r.items) || []
    if (items.some((m) => m.messageId === messageId)) return { found: true, pages: page + 1 }
    if (!r || !r.hasMore || items.length === 0) break
    before = Math.min(...items.map((m) => m.messageId))
  }
  return { found: false, pages: maxPages }
}

/** 从标题派生一个「API 上能唯一搜到该条目」的短子串（搜索框判据的对象）。 */
async function deriveSearchTerm(tg, item) {
  const title = String(item.title || '')
  for (let len = 2; len <= 6; len += 1) {
    if (title.length < len) break
    const term = title.slice(0, len)
    const q = new URLSearchParams({ q: term, hasBytes: 'true', limit: '50' })
    const r = await apiGet(tg, `/api/media/items?${q}`)
    const items = (r && r.items) || []
    if (items.length >= 1 && items.some((x) => x.id === item.id)) return { term, total: r.total }
  }
  return null
}

/** 解析 `<chat>:<msg>`（与前端 parseTgRef 同口径；不符返回 null，不兜底成 0）。 */
function parseRef(ref) {
  if (typeof ref !== 'string') return null
  const i = ref.indexOf(':')
  if (i <= 0 || i === ref.length - 1) return null
  const chatId = Number(ref.slice(0, i))
  const messageId = Number(ref.slice(i + 1))
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null
  return { chatId, messageId }
}

// ─────────────────────────── 页面内工具（DOM 事实，零类名推断） ───────────────────────────

const INSTALL_HELPERS = (tgOrigin) => {
  window.__b305 = {
    tg: tgOrigin,
    q(sel) {
      return document.querySelector(sel)
    },
    present(sel) {
      return document.querySelectorAll(sel).length
    },
    attr(sel, name) {
      const el = document.querySelector(sel)
      return el ? el.getAttribute(name) : null
    },
    text(sel) {
      const el = document.querySelector(sel)
      return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null
    },
    click(sel) {
      const el = document.querySelector(sel)
      if (!el) return false
      el.click()
      return true
    },
    /** React 受控输入：原生 setter + input 事件（否则 onChange 不触发）。 */
    setInput(sel, value) {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    /** 入口元素事实：标签 / href / target / 可见文案。 */
    entryInfo(sel) {
      const el = document.querySelector(sel)
      if (!el) return null
      return {
        tag: el.tagName,
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
      }
    },
    /** 元素是否与视口相交（几何事实，不读样式类）。 */
    inViewport(sel) {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.height <= 0 || r.width <= 0) return false
      const vh = window.innerHeight || document.documentElement.clientHeight
      const vw = window.innerWidth || document.documentElement.clientWidth
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
    },
    /** 当前所有高亮消息（key + 是否在视口）。 */
    highlights() {
      return Array.from(document.querySelectorAll('[data-tg-highlight="true"]')).map((el) => {
        const r = el.getBoundingClientRect()
        const vh = window.innerHeight || document.documentElement.clientHeight
        return {
          key: el.getAttribute('data-message-key'),
          inViewport: r.height > 0 && r.bottom > 0 && r.top < vh,
        }
      })
    },
    /**
     * TG 面板根（全局侧栏也是 <aside> 且排在前面 ⇒ 一切面板内查询都必须
     * 先收敛到面板根，否则查到的会是侧栏，判据变成假阴性/假阳性）。
     */
    panel() {
      return document.querySelector('[data-testid="tg-panel-root"]')
    },
    /** 面板左栏（监控列表 + 分组入口）内按文本点按钮。 */
    asideButtonByText(text) {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      const aside = panel && panel.querySelector('aside')
      if (!aside) return false
      const b = Array.from(aside.querySelectorAll('button')).find((x) =>
        (x.innerText || '').trim().includes(text),
      )
      if (!b) return false
      b.click()
      return true
    },
    /** 组内频道行 = 面板第二列（section）里的按钮；左栏监控行天然不在内。 */
    groupChannelTexts() {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return []
      const col = panel.querySelector('section')
      if (!col) return []
      return Array.from(col.querySelectorAll('button'))
        .map((b) => (b.innerText || '').trim())
        .filter((t) => t && t.length <= 80)
    },
    clickChannelByText(text) {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return false
      const col = panel.querySelector('section')
      if (!col) return false
      const b = Array.from(col.querySelectorAll('button')).find(
        (x) => (x.innerText || '').trim() === text,
      )
      if (!b) return false
      b.click()
      return true
    },
    /** store 事实（dev 钩子 window.__origStore）。 */
    store() {
      const s = window.__origStore
      if (!s || typeof s.getState !== 'function') return { ok: false }
      const st = s.getState()
      return {
        ok: true,
        pendingTgFocus:
          st.pendingTgFocus === undefined ? '<missing-field>' : st.pendingTgFocus,
        hasMediaFocusField: Object.prototype.hasOwnProperty.call(st, 'pendingMediaFocus'),
        hasMediaFocusSetter: typeof st.setPendingMediaFocus === 'function',
        hasTgFocusSetter: typeof st.setPendingTgFocus === 'function',
      }
    },
    /** 判据 5 的伪坐标注入口（与产品入口同一条 store 通道）。 */
    setFocus(chatId, messageId) {
      const s = window.__origStore
      if (!s || typeof s.getState !== 'function') return false
      s.getState().setPendingTgFocus({ chatId, messageId })
      return true
    },
    toast() {
      const el = document.querySelector('[data-testid="global-toast"]')
      return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null
    },
    url() {
      return location.href
    },
    visibility() {
      return document.visibilityState
    },
    lang() {
      return document.documentElement.lang || ''
    },
  }
}

/** 轮询直到 fn 返回真值；返回该值（超时返回 null）。 */
async function waitForValue(page, fn, opts = {}) {
  const timeout = opts.timeout || 30000
  const intervalMs = opts.intervalMs || 250
  const args = opts.args || []
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, ...args)
    if (last) return last
    await delay(intervalMs)
  }
  return null
}

/** 强制界面语言：写持久化设置 → 整页重载（与 BUG-263 / BUG-285 同机制）。 */
async function forceLanguage(page, appUrl, lang) {
  await page.goto(appUrl, { settleMs: 1200 })
  await page.evaluate((l) => {
    let cur = {}
    try {
      cur = JSON.parse(localStorage.getItem('orig-hub:settings') || '{}')
    } catch (_e) {
      cur = {}
    }
    cur.language = l
    localStorage.setItem('orig-hub:settings', JSON.stringify(cur))
  }, lang)
  await page.goto(appUrl, { settleMs: 1800 })
  await page.evaluate(INSTALL_HELPERS)
}

/** 打开文件域条目视图（父行 cat-all ⇒ items 视图，搜索框只在 items 视图渲染）。 */
async function openItemsView(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-files"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-search-input"]'), {
    timeout: 25000,
  })
  await delay(700)
}

/** 打开剧集墙并进入指定剧集详情（等来源块出现）。 */
async function openSeriesDetail(page, seriesId) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    (sid) => !!document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`),
    { timeout: 25000, args: [seriesId] },
  )
  await delay(400)
  await page.evaluate((sid) => {
    const el = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (el) el.click()
  }, seriesId)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-source-info"]'), {
    timeout: 25000,
  })
  await delay(600)
}

/**
 * 预切换：把 TG 面板切到一个**非目标**频道（频道断言才有牙 ——
 * 目标频道本就是默认选中，不预切换则「频道对了」是空转断言）。
 * 订阅列表加载不出来 ⇒ Loud FAIL（牙失效不许静默降级）。
 */
async function preswitchOtherChannel(page, ctx) {
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
    timeout: 25000,
  })
  await delay(900)
  const opened = await page.evaluate((label) => window.__b305.asideButtonByText(label), ctx.navAllLabel)
  if (!opened) throw new Error(`cannot open subscription group list (${ctx.navAllLabel})`)
  await page.waitForFunction(() => window.__b305.groupChannelTexts().length > 0, { timeout: 30000 })
  let otherId = null
  for (let attempt = 0; attempt < 4 && !otherId; attempt += 1) {
    const texts = await page.evaluate(() => window.__b305.groupChannelTexts())
    const pick = texts.find((t) => !t.includes(ctx.targetChannelTitle))
    if (!pick) break
    await page.evaluate((t) => window.__b305.clickChannelByText(t), pick)
    otherId = await waitForValue(
      page,
      (tgt) => {
        const el = document.querySelector('[data-testid="tg-channel-header"]')
        if (!el) return null
        const id = el.getAttribute('data-channel-id')
        return id && id !== String(tgt) ? id : null
      },
      { timeout: 20000, args: [ctx.targetChatId] },
    )
  }
  if (!otherId) {
    throw new Error(
      'pre-switch to a non-target channel failed — channel assertion would be vacuous',
    )
  }
  await delay(600)
  return otherId
}

/** 点入口 → 等定位高亮；同时记录「是否离开应用」的事实。 */
async function clickEntryAndAwaitLocate(page, ctx, entrySel, opts = {}) {
  const locateTimeout = opts.locateTimeout || 90000
  const urlBefore = await page.evaluate(() => window.__b305.url())
  const navEvents = []
  const offFrame = page.conn.on('Page.frameNavigated', () => navEvents.push('frame-navigated'))
  const offTarget = page.conn.on('Target.targetCreated', () => navEvents.push('target-created'))
  let clicked = false
  try {
    clicked = await page.evaluate((s) => window.__b305.click(s), entrySel)
  } finally {
    offFrame()
    offTarget()
  }
  const key = await waitForValue(
    page,
    (k) => {
      const els = Array.from(document.querySelectorAll('[data-tg-highlight="true"]'))
      return els.some((x) => x.getAttribute('data-message-key') === k) ? k : null
    },
    { timeout: locateTimeout, intervalMs: 300, args: [ctx.expectedKey] },
  )
  const after = await page.evaluate(
    (k) => ({
      url: window.__b305.url(),
      visibility: window.__b305.visibility(),
      panelRoot: window.__b305.present('[data-testid="tg-panel-root"]'),
      channelId: window.__b305.attr('[data-testid="tg-channel-header"]', 'data-channel-id'),
      keyCount: window.__b305.present(`[data-message-key="${k}"]`),
      highlightedKey: window.__b305.attr(`[data-message-key="${k}"]`, 'data-tg-highlight'),
      inViewport: window.__b305.inViewport(`[data-message-key="${k}"]`),
      highlights: window.__b305.highlights(),
      focus: window.__b305.store().pendingTgFocus,
    }),
    ctx.expectedKey,
  )
  return { clicked, key, urlBefore, navEvents, after }
}

/** 判据 1/2/7 的共用断言（条目级 / 剧集级同一套 DOM 事实）。 */
function assertLocate(label, res, ctx) {
  check(
    `判据1 ${label}：应用切到 TG 面板（tg-panel-root，非 t.me 网页）`,
    res.after.panelRoot === 1,
    `panelRoot=${res.after.panelRoot}`,
  )
  check(
    `判据1 ${label}：当前频道 = 来源频道（tg-channel-header data-channel-id）`,
    res.after.channelId === String(ctx.targetChatId),
    `header=${res.after.channelId} expected=${ctx.targetChatId}`,
  )
  check(
    `判据1 ${label}：来源消息存在于消息流（data-message-key）`,
    res.after.keyCount >= 1,
    `keyCount=${res.after.keyCount} key=${ctx.expectedKey}`,
  )
  check(
    `判据1 ${label}：来源消息被高亮（data-tg-highlight）`,
    res.after.highlightedKey === 'true' &&
      res.after.highlights.some((h) => h.key === ctx.expectedKey),
    `highlightedKey=${res.after.highlightedKey} highlights=${JSON.stringify(res.after.highlights)}`,
  )
  check(
    `判据1 ${label}：来源消息已滚进可视区`,
    res.after.inViewport === true,
    `inViewport=${res.after.inViewport}`,
  )
  check(
    `判据2 ${label}：未发生框架导航 / 新标签（不离开 OrigHub）`,
    res.navEvents.length === 0,
    `navEvents=${JSON.stringify(res.navEvents)}`,
  )
  check(
    `判据2 ${label}：URL 未变且页面保持可见`,
    res.after.url === res.urlBefore && res.after.visibility === 'visible',
    `url ${res.urlBefore} -> ${res.after.url} visibility=${res.after.visibility}`,
  )
  check(
    `判据7 ${label}：频道事实为 data-channel-id 属性逐字相等（非类名推断）`,
    res.after.channelId === String(ctx.targetChatId),
    `header=${res.after.channelId}`,
  )
  check(
    `判据7 ${label}：消息事实为 data-message-key / data-tg-highlight 属性值`,
    res.after.highlightedKey === 'true',
    `key=${ctx.expectedKey} highlight=${res.after.highlightedKey}`,
  )
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug305] app=${ep.app} tg=${ep.tg} out=${OUT}`)

  const zh = JSON.parse(fs.readFileSync(LOCALE_ZH, 'utf8'))
  const en = JSON.parse(fs.readFileSync(LOCALE_EN, 'utf8'))
  const L = {
    viewInTgZh: zh['media.viewInTg'],
    viewInTgEn: en['media.viewInTg'],
    epViewInTgZh: zh['media.episode.viewInTg'],
    epViewInTgEn: en['media.episode.viewInTg'],
    locateFailedZh: zh['tg.locateFailed'],
    locateNoChannelZh: zh['tg.locateNoChannel'],
    navAllZh: zh['tg.navAll'],
  }

  // ── ⓪ 目标派生（全部运行时，不写死）──
  const monitored = await apiGet(ep.tg, '/api/tg/monitor/channels')
  if (!Array.isArray(monitored) || monitored.length === 0) {
    fatal(
      'monitored channel list is empty — nothing to locate. ' +
        'A skip here would be a false green; add a monitored channel first.',
    )
  }
  const monSet = new Set(monitored.map((c) => c.channelId))
  check(
    '⓪ 监控频道列表非空（活栈确有可定位目标）',
    monSet.size > 0,
    `channels=${monitored.map((c) => `${c.channelId}:${c.title}`).join(' | ')}`,
  )

  const items = await listAllItems(ep.tg)
  const tgCandidates = items
    .filter((i) => i.source === 'tg' && i.bytesPresence === 'present')
    .map((i) => ({ item: i, at: parseRef(i.ref) }))
    .filter((x) => x.at && monSet.has(x.at.chatId))
  if (tgCandidates.length === 0) {
    fatal(
      `no tg-sourced library item from a monitored channel (scanned ${items.length} items). ` +
        'Refusing to run criteria without a real target.',
    )
  }
  // 优先「属于剧集」的候选（剧集级判据需要它）；再按可达性挑第一个真能定位的。
  const withSeries = tgCandidates.filter((x) => typeof x.item.seriesId === 'number')
  const others = tgCandidates.filter((x) => typeof x.item.seriesId !== 'number')
  const ordered = [...withSeries, ...others]
  let picked = null
  let reach = null
  for (const cand of ordered.slice(0, 12)) {
    const r = await monitorMessageReachable(ep.tg, cand.at.chatId, cand.at.messageId, 6)
    if (r.found && typeof cand.item.seriesId === 'number') {
      picked = cand
      reach = r
      break
    }
  }
  if (!picked) {
    fatal(
      'no reachable tg item from a monitored channel that belongs to a series ' +
        `(candidates=${tgCandidates.length}). A target that cannot be located would make ` +
        'criterion 1 vacuous — refusing to report a skip as a pass.',
    )
  }
  check(
    '⓪ 目标消息确实存在于监控消息流（翻页可达，定位判据有对象）',
    reach.found === true,
    `item=${picked.item.id} ref=${picked.item.ref} pages=${reach.pages}`,
  )

  const seriesId = picked.item.seriesId
  let seriesTitle = picked.item.seriesTitle || ''
  if (typeof seriesId === 'number') {
    const sd = await apiGet(ep.tg, `/api/media/series/${seriesId}`)
    seriesTitle = sd.title || seriesTitle
    const tgEp = ((sd.episodes || []).find(
      (e) => e.source === 'tg' && e.ref === picked.item.ref,
    ) || null)
    check(
      '⓪ 目标条目所属剧集含同坐标分集（剧集级判据有对象）',
      tgEp !== null,
      `series=${seriesId} title=${seriesTitle} episodes=${(sd.episodes || []).length}`,
    )
    if (!tgEp) fatal(`series ${seriesId} has no episode matching ref ${picked.item.ref}`)
  } else {
    fatal('picked target item has no series — series-level criterion would be vacuous')
  }

  const itemTerm = await deriveSearchTerm(ep.tg, picked.item)
  if (!itemTerm) {
    fatal(`cannot derive a search term that uniquely finds item ${picked.item.id} in the API`)
  }
  check(
    '⓪ 搜索词可从标题派生且在 API 上命中目标（搜索框判据的对象）',
    true,
    `term=${JSON.stringify(itemTerm.term)} total=${itemTerm.total} item=${picked.item.id}`,
  )

  // 负样本：本地条目 + 本地剧集
  const localItem = items.find((i) => i.source === 'local' && i.bytesPresence === 'present') || null
  if (!localItem) fatal('no local-source library item with bytes — criterion 4 negative would be vacuous')
  const localTerm = await deriveSearchTerm(ep.tg, localItem)
  if (!localTerm) fatal(`cannot derive a search term for local item ${localItem.id}`)
  const localSeriesList = await apiGet(ep.tg, '/api/media/series?limit=500')
  let localSeries = null
  for (const s of (localSeriesList.items || [])) {
    const sd = await apiGet(ep.tg, `/api/media/series/${s.id}`)
    const eps = sd.episodes || []
    if (eps.length > 0 && eps.every((e) => e.source === 'local') && sd.hasBytes !== false) {
      localSeries = { id: s.id, title: sd.title, episode: eps[0] }
      break
    }
  }
  if (!localSeries) fatal('no local-episode series with bytes — series-level criterion 4 negative would be vacuous')
  check(
    '⓪ 负样本齐备：本地条目 + 本地剧集（判据4 的反向有对象）',
    true,
    `localItem=${localItem.id}(${localItem.title}) localSeries=${localSeries.id}(${localSeries.title})`,
  )

  const dialogs = await apiGet(ep.tg, '/api/tg/dialogs?limit=200&offset=0')
  const dialogCount = (dialogs.items || []).length
  check(
    '⓪ 订阅（dialogs）列表可加载（频道切换牙的前提）',
    dialogCount > 0,
    `dialogs page0=${dialogCount} hasMore=${dialogs.hasMore}`,
  )
  if (dialogCount === 0) fatal('dialogs list is empty — pre-switch teeth would be vacuous')

  const ctx = {
    targetChatId: picked.at.chatId,
    targetMessageId: picked.at.messageId,
    expectedKey: `s-${picked.at.chatId}-${picked.at.messageId}`,
    itemId: picked.item.id,
    itemTitle: picked.item.title,
    seriesId,
    seriesTitle,
    itemTerm: itemTerm.term,
    localItemId: localItem.id,
    localItemTerm: localTerm.term,
    localSeriesId: localSeries.id,
    navAllLabel: L.navAllZh,
  }
  console.log(
    `[bug305] target: item=${ctx.itemId} series=${ctx.seriesId} ref=${picked.item.ref} key=${ctx.expectedKey}`,
  )

  // i18n 键（两个 locale 都要有，新文案不许硬编码）
  const i18nKeys = ['media.viewInTg', 'media.episode.viewInTg', 'tg.locateFailed', 'tg.locateNoChannel']
  const missingKeys = i18nKeys.filter((k) => !zh[k] || !en[k])
  check(
    'i18n 四个新键在两个 locale 均存在且非空',
    missingKeys.length === 0,
    missingKeys.length ? `missing=${missingKeys.join(',')}` : i18nKeys.join(','),
  )
  check(
    'i18n 入口文案两语言不同（zh=在 TG 中查看 / en=View in TG，非同一份硬编码）',
    L.viewInTgZh === '在 TG 中查看' && L.viewInTgEn === 'View in TG',
    `zh=${L.viewInTgZh} en=${L.viewInTgEn}`,
  )

  // ── 浏览器会话（zh-CN 主会话）──
  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await forceLanguage(page, ep.app, 'zh-CN')
    const langNow = await page.evaluate(() => window.__b305.lang())
    check('⓪b zh-CN 已生效（<html lang>）', String(langNow).toLowerCase().startsWith('zh'), `lang=${langNow}`)

    // ── 判据 4（条目级）：有坐标 ⇒ 渲染；本地 ⇒ 不渲染 ──
    await openItemsView(page)
    await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
      { timeout: 25000, args: [ctx.itemId] },
    )
    await delay(500)
    const tgCardEntry = await page.evaluate(
      (id) => ({
        cards: window.__b305.present('[data-testid="media-card"]'),
        entry: window.__b305.entryInfo(
          `[data-testid="media-card"][data-item-id="${id}"] [data-testid="item-view-tg"]`,
        ),
      }),
      ctx.itemId,
    )
    await page.screenshot(path.join(OUT, '1_media_library_entry.png'))
    check(
      '判据4 TG 来源条目卡片渲染「在 TG 中查看」入口（有坐标就给入口）',
      tgCardEntry.entry !== null && tgCardEntry.entry.tag === 'BUTTON',
      `cards=${tgCardEntry.cards} entry=${JSON.stringify(tgCardEntry.entry)}`,
    )
    check(
      '判据4 入口文案走 i18n（zh-CN = 在 TG 中查看）',
      tgCardEntry.entry !== null && tgCardEntry.entry.text === L.viewInTgZh,
      `text=${tgCardEntry.entry && tgCardEntry.entry.text}`,
    )
    check(
      '判据2 应用内入口是 button（无 href / target，本身不离开应用）',
      tgCardEntry.entry !== null &&
        tgCardEntry.entry.tag === 'BUTTON' &&
        !tgCardEntry.entry.href &&
        !tgCardEntry.entry.target,
      `entry=${JSON.stringify(tgCardEntry.entry)}`,
    )

    await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.localItemTerm)
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
      { timeout: 25000, args: [ctx.localItemId] },
    )
    await delay(500)
    const localCard = await page.evaluate(
      (id) => ({
        cards: window.__b305.present('[data-testid="media-card"]'),
        entries: window.__b305.present(
          `[data-testid="media-card"][data-item-id="${id}"] [data-testid="item-view-tg"]`,
        ),
        anyEntry: window.__b305.present('[data-testid="item-view-tg"]'),
      }),
      ctx.localItemId,
    )
    await page.screenshot(path.join(OUT, '1b_local_card_no_entry.png'))
    check(
      '判据4 本地来源条目卡片不渲染入口（点了也没有坐标可跳）',
      localCard.cards >= 1 && localCard.entries === 0,
      `cards=${localCard.cards} cardEntries=${localCard.entries} anyEntry=${localCard.anyEntry}`,
    )

    // ── 判据 1/2/7（条目级跳转）──
    await page.evaluate(() => window.__b305.click('[data-testid="nav-tg"]'))
    const otherChannelId = await preswitchOtherChannel(page, ctx)
    check(
      '判据1（牙）跳转前频道已被预切到非目标频道（频道断言非空转）',
      otherChannelId !== String(ctx.targetChatId),
      `preswitched=${otherChannelId} target=${ctx.targetChatId}`,
    )
    await openItemsView(page)
    await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
      { timeout: 25000, args: [ctx.itemId] },
    )
    await delay(400)
    const itemRes = await clickEntryAndAwaitLocate(
      page,
      ctx,
      `[data-testid="media-card"][data-item-id="${ctx.itemId}"] [data-testid="item-view-tg"]`,
    )
    await page.screenshot(path.join(OUT, '2_item_jump_located.png'))
    check(
      '判据1 条目级：入口可点且定位到目标消息',
      itemRes.clicked === true && itemRes.key === ctx.expectedKey,
      `clicked=${itemRes.clicked} key=${itemRes.key} expected=${ctx.expectedKey}`,
    )
    assertLocate('条目级', itemRes, ctx)
    check(
      '判据1 条目级：定位后焦点被一次性消费（pendingTgFocus 回 null）',
      itemRes.after.focus === null,
      `focus=${JSON.stringify(itemRes.after.focus)}`,
    )

    // ── 判据 3 + 判据 4（剧集级）──
    await page.evaluate(() => window.__b305.click('[data-testid="nav-files"]'))
    await openSeriesDetail(page, ctx.localSeriesId)
    const localSeriesDom = await page.evaluate(() => ({
      jump: window.__b305.present('[data-testid="episode-source-jump-tg"]'),
      link: window.__b305.present('[data-testid="episode-source-view-tg"]'),
      row: window.__b305.present('[data-testid="episode-row-view-tg"]'),
    }))
    check(
      '判据4 本地剧集来源块不渲染应用内入口（episode-source-jump-tg = 0）',
      localSeriesDom.jump === 0,
      `jump=${localSeriesDom.jump} link=${localSeriesDom.link} row=${localSeriesDom.row}`,
    )
    check(
      '判据4 本地剧集来源块也不渲染 t.me 外链（无坐标 ⇒ 两个出口都没有）',
      localSeriesDom.link === 0,
      `link=${localSeriesDom.link}`,
    )
    check(
      '判据4 本地剧集列表行不渲染入口（episode-row-view-tg = 0）',
      localSeriesDom.row === 0,
      `row=${localSeriesDom.row}`,
    )

    await page.evaluate(() => window.__b305.click('[data-testid="nav-files"]'))
    await openSeriesDetail(page, ctx.seriesId)
    const tgSeriesDom = await page.evaluate(() => ({
      jump: window.__b305.entryInfo('[data-testid="episode-source-jump-tg"]'),
      link: window.__b305.entryInfo('[data-testid="episode-source-view-tg"]'),
      row: window.__b305.entryInfo('[data-testid="episode-row-view-tg"]'),
    }))
    await page.screenshot(path.join(OUT, '4_series_source_entries.png'))
    check(
      '判据3 剧集来源块有应用内主入口（episode-source-jump-tg，button）',
      tgSeriesDom.jump !== null && tgSeriesDom.jump.tag === 'BUTTON',
      `jump=${JSON.stringify(tgSeriesDom.jump)}`,
    )
    check(
      '判据3 剧集列表行也有入口（episode-row-view-tg）',
      tgSeriesDom.row !== null,
      `row=${JSON.stringify(tgSeriesDom.row)}`,
    )
    check(
      '判据2 BUG-285 回归：t.me 外链保留为次要出口（独立 <a target="_blank">）',
      tgSeriesDom.link !== null &&
        tgSeriesDom.link.tag === 'A' &&
        tgSeriesDom.link.target === '_blank' &&
        String(tgSeriesDom.link.href).includes(`t.me/c/${ctx.targetChatId}/${ctx.targetMessageId}`),
      `link=${JSON.stringify(tgSeriesDom.link)}`,
    )

    await page.evaluate(() => window.__b305.click('[data-testid="nav-tg"]'))
    await preswitchOtherChannel(page, ctx)
    await page.evaluate(() => window.__b305.click('[data-testid="nav-files"]'))
    await openSeriesDetail(page, ctx.seriesId)
    const seriesRes = await clickEntryAndAwaitLocate(
      page,
      ctx,
      '[data-testid="episode-source-jump-tg"]',
    )
    await page.screenshot(path.join(OUT, '3_series_jump_located.png'))
    check(
      '判据3 剧集级：入口可点且定位到同一频道同一消息',
      seriesRes.clicked === true && seriesRes.key === ctx.expectedKey,
      `clicked=${seriesRes.clicked} key=${seriesRes.key} expected=${ctx.expectedKey}`,
    )
    assertLocate('剧集级', seriesRes, ctx)
    check(
      '判据3 剧集级：定位后焦点被一次性消费（pendingTgFocus 回 null）',
      seriesRes.after.focus === null,
      `focus=${JSON.stringify(seriesRes.after.focus)}`,
    )

    // ── 判据 5：伪坐标必 FAIL（无静默成功）──
    // 先切到非目标频道清掉上一轮高亮（切频道即清高亮是产品契约）。
    await preswitchOtherChannel(page, ctx)
    const cleared = await page.evaluate(() => window.__b305.highlights())
    check(
      '判据5（前置）切频道后旧高亮被清除（伪坐标判据的干净起点）',
      cleared.length === 0,
      `highlights=${JSON.stringify(cleared)}`,
    )

    // 5a 伪 messageId（真频道 + 不存在的消息号）
    await page.evaluate((c, m) => window.__b305.setFocus(c, m), ctx.targetChatId, 999999999)
    const bogusFocusCleared = await waitForValue(
      page,
      () => {
        const s = window.__b305.store()
        return s.ok && s.pendingTgFocus === null ? true : null
      },
      { timeout: 10000 },
    )
    check(
      '判据5 伪 messageId：焦点被一次性消费（未挂起重复触发）',
      bogusFocusCleared === true,
      `focus=${JSON.stringify(await page.evaluate(() => window.__b305.store().pendingTgFocus))}`,
    )
    let bogusToast = null
    const bogusDeadline = Date.now() + 150000
    let bogusHighlights = []
    while (Date.now() < bogusDeadline) {
      bogusHighlights = await page.evaluate(() => window.__b305.highlights())
      if (bogusHighlights.length > 0) break
      const t = await page.evaluate(() => window.__b305.toast())
      if (t && t.includes(L.locateFailedZh)) {
        bogusToast = t
        break
      }
      await delay(400)
    }
    await page.screenshot(path.join(OUT, '5_bogus_coords_no_locate.png'))
    check(
      '判据5 伪 messageId：全程无任何高亮（未静默「定位成功」）',
      bogusHighlights.length === 0,
      `highlights=${JSON.stringify(bogusHighlights)}`,
    )
    check(
      '判据5 伪 messageId：消息流中不存在该 key',
      (await page.evaluate((k) => window.__b305.present(`[data-message-key="${k}"]`), `s-${ctx.targetChatId}-999999999`)) === 0,
      `key=s-${ctx.targetChatId}-999999999`,
    )
    check(
      '判据5 伪 messageId：定位失败有如实反馈（global-toast 明说未定位到）',
      typeof bogusToast === 'string' && bogusToast.includes(L.locateFailedZh),
      `toast=${JSON.stringify(bogusToast)}`,
    )

    // 5b 伪 chatId（不存在的频道）
    await delay(5000) // 等上一条 toast 自动消失，避免串味
    const beforeBogusChat = await page.evaluate(() =>
      window.__b305.attr('[data-testid="tg-channel-header"]', 'data-channel-id'),
    )
    await page.evaluate((c, m) => window.__b305.setFocus(c, m), 999999999, ctx.targetMessageId)
    let chatToast = null
    const chatDeadline = Date.now() + 30000
    let chatFocus = null
    let chatHighlights = []
    while (Date.now() < chatDeadline) {
      const st = await page.evaluate(() => window.__b305.store())
      chatFocus = st.pendingTgFocus
      chatHighlights = await page.evaluate(() => window.__b305.highlights())
      const t = await page.evaluate(() => window.__b305.toast())
      if (t && t.includes(L.locateNoChannelZh)) {
        chatToast = t
        break
      }
      await delay(400)
    }
    const afterBogusChat = await page.evaluate(() =>
      window.__b305.attr('[data-testid="tg-channel-header"]', 'data-channel-id'),
    )
    check(
      '判据5 伪 chatId：焦点被消费且未挂起',
      chatFocus === null,
      `focus=${JSON.stringify(chatFocus)}`,
    )
    check(
      '判据5 伪 chatId：无任何高亮',
      chatHighlights.length === 0,
      `highlights=${JSON.stringify(chatHighlights)}`,
    )
    check(
      '判据5 伪 chatId：频道未被切到伪值（header 保持原频道）',
      afterBogusChat !== '999999999' && afterBogusChat === beforeBogusChat,
      `before=${beforeBogusChat} after=${afterBogusChat}`,
    )
    check(
      '判据5 伪 chatId：失败有如实反馈（订阅列表里没有该频道）',
      typeof chatToast === 'string' && chatToast.includes(L.locateNoChannelZh),
      `toast=${JSON.stringify(chatToast)}`,
    )

    // ── 判据 6：不回退反向跳转 ──
    const storeNow = await page.evaluate(() => window.__b305.store())
    check(
      '判据6 运行时：pendingMediaFocus 字段与 setter 仍在（未被改名/删除）',
      storeNow.ok === true &&
        storeNow.hasMediaFocusField === true &&
        storeNow.hasMediaFocusSetter === true &&
        storeNow.hasTgFocusSetter === true,
      `store=${JSON.stringify(storeNow)}`,
    )
    const storeSrc = fs.readFileSync(USE_STORE_TS, 'utf8')
    check(
      '判据6 源码：useStore.ts 仍定义 pendingMediaFocus 与 setPendingMediaFocus',
      storeSrc.includes('pendingMediaFocus:') && storeSrc.includes('setPendingMediaFocus:'),
      `pendingMediaFocus hits=${(storeSrc.match(/pendingMediaFocus/g) || []).length}`,
    )
    const sdSrc = fs.readFileSync(SERIES_DETAIL_TSX, 'utf8')
    check(
      '判据6 BUG-285 母档锚点仍在（SeriesDetail 主版本行 t.me 链接构造未被改掉）',
      sdSrc.includes('const curTgUrl = cur ? sourceMessageUrl(cur.source, cur.ref) : null'),
      'anchor=curTgUrl',
    )

    // ── 判据 7：脚本自身零类名推断（自证）──
    // 判据 7 的自证牙：本文件不得出现「读元素类名」的代码（正则以拼接构造，
    // 否则这行自身就会命中自己）。DOM 事实只认 data-* 属性与几何量。
    const selfSrc = fs.readFileSync(SELF, 'utf8')
    const classInference = new RegExp('class' + 'Name|class' + 'List')
    check(
      '判据7 脚本自身不含类名推断（全文无读取元素类名的代码）',
      !classInference.test(selfSrc),
      'self-scan of this file',
    )

    const pageErrs = page.pageErrors().slice(0, 5)
    check('无未捕获页面错误（zh-CN 会话）', pageErrs.length === 0, pageErrs.join(' | '))

    // ── i18n 牙：en-US 会话入口文案 ──
    const enBrowser = await cdp.launch({ args: ['--lang=en-US'] })
    try {
      const enPage = await enBrowser.newPage()
      await forceLanguage(enPage, ep.app, 'en-US')
      await enPage.evaluate(INSTALL_HELPERS)
      const enLang = await enPage.evaluate(() => window.__b305.lang())
      check('⓪c en-US 已生效（<html lang>）', String(enLang).toLowerCase().startsWith('en'), `lang=${enLang}`)
      await openItemsView(enPage)
      await enPage.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
      await enPage.waitForFunction(
        (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
        { timeout: 25000, args: [ctx.itemId] },
      )
      await delay(500)
      const enEntry = await enPage.evaluate(
        (id) =>
          window.__b305.entryInfo(
            `[data-testid="media-card"][data-item-id="${id}"] [data-testid="item-view-tg"]`,
          ),
        ctx.itemId,
      )
      await enPage.screenshot(path.join(OUT, '6_en_us_entry.png'))
      check(
        'i18n en-US 会话入口文案 === "View in TG"（非中文硬编码）',
        enEntry !== null && enEntry.text === L.viewInTgEn,
        `entry=${JSON.stringify(enEntry)}`,
      )
      const enErrs = enPage.pageErrors().slice(0, 5)
      check('无未捕获页面错误（en-US 会话）', enErrs.length === 0, enErrs.join(' | '))
    } finally {
      await enBrowser.close()
    }

    // ── 反向证伪：摘掉焦点设置 ⇒ 判据 1/7 必须 RED ⇒ 字节级还原 ⇒ 复绿 ──
    const TAMPER_FROM = '      setPendingTgFocus(coords)\n'
    const TAMPER_TO = ''
    const beforeBytes = fs.readFileSync(MEDIA_LIBRARY_PANEL_TSX)
    const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')
    const beforeText = beforeBytes.toString('utf8')
    console.log(`[bug305] --- 证伪：摘掉 viewInTg 的焦点设置（${TAMPER_FROM.trim()}）---`)
    check(
      '④P 证伪锚点存在（MediaLibraryPanel.tsx 含目标行）',
      beforeText.includes(TAMPER_FROM),
      TAMPER_FROM.trim(),
    )
    if (beforeText.includes(TAMPER_FROM)) {
      let restored = false
      try {
        fs.writeFileSync(MEDIA_LIBRARY_PANEL_TSX, beforeText.replace(TAMPER_FROM, TAMPER_TO))
        await delay(1000) // 等 vite watch 失效模块缓存
        await page.goto(ep.app, { settleMs: 1800 })
        await page.evaluate(INSTALL_HELPERS)
        await openItemsView(page)
        await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
        await page.waitForFunction(
          (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
          { timeout: 25000, args: [ctx.itemId] },
        )
        await delay(400)
        const redEntry = await page.evaluate(
          (id) =>
            window.__b305.entryInfo(
              `[data-testid="media-card"][data-item-id="${id}"] [data-testid="item-view-tg"]`,
            ),
          ctx.itemId,
        )
        check(
          '④a 红态：入口仍在且可点（证明红的不是「按钮没了」）',
          redEntry !== null && redEntry.tag === 'BUTTON',
          `entry=${JSON.stringify(redEntry)}`,
        )
        const redRes = await clickEntryAndAwaitLocate(
          page,
          ctx,
          `[data-testid="media-card"][data-item-id="${ctx.itemId}"] [data-testid="item-view-tg"]`,
          { locateTimeout: 30000 },
        )
        await page.screenshot(path.join(OUT, '7_red_state_no_locate.png'))
        check(
          '④b 红态：点击后无高亮、无定位（判据1 按预期失败）',
          redRes.key === null && redRes.after.highlights.length === 0,
          `key=${redRes.key} highlights=${JSON.stringify(redRes.after.highlights)}`,
        )
        check(
          '④c 红态：目标消息未被高亮（判据7 的 DOM 事实按预期失败）',
          redRes.after.highlightedKey !== 'true',
          `highlightedKey=${redRes.after.highlightedKey}`,
        )
        check(
          '④d 红态：面板仍被打开（隔离证伪面 —— 只摘了焦点，没摘导航）',
          redRes.after.panelRoot === 1,
          `panelRoot=${redRes.after.panelRoot}`,
        )
      } finally {
        // 字节级还原（禁 git checkout —— 会冲掉并行 agent 的未提交改动）
        fs.writeFileSync(MEDIA_LIBRARY_PANEL_TSX, beforeBytes)
        restored = true
      }
      const afterBytes = fs.readFileSync(MEDIA_LIBRARY_PANEL_TSX)
      const shaAfter = crypto.createHash('sha256').update(afterBytes).digest('hex')
      check(
        '④e 字节级还原：sha256 与改前一致',
        restored && shaAfter === shaBefore,
        `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`,
      )

      await delay(1000)
      await page.goto(ep.app, { settleMs: 1800 })
      await page.evaluate(INSTALL_HELPERS)
      await openItemsView(page)
      await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
      await page.waitForFunction(
        (id) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${id}"]`),
        { timeout: 25000, args: [ctx.itemId] },
      )
      await delay(400)
      const greenRes = await clickEntryAndAwaitLocate(
        page,
        ctx,
        `[data-testid="media-card"][data-item-id="${ctx.itemId}"] [data-testid="item-view-tg"]`,
      )
      await page.screenshot(path.join(OUT, '8_restore_green.png'))
      check(
        '④f 还原后复跑：条目级跳转重新定位到目标消息并高亮',
        greenRes.key === ctx.expectedKey &&
          greenRes.after.channelId === String(ctx.targetChatId) &&
          greenRes.after.highlightedKey === 'true',
        `key=${greenRes.key} channel=${greenRes.after.channelId} highlight=${greenRes.after.highlightedKey}`,
      )
    }
  } finally {
    if (browser) await browser.close()
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify(
      {
        bug: 'BUG-305',
        passed,
        total: checks.length,
        all_passed: passed === checks.length,
        target: {
          itemId: ctx.itemId,
          seriesId: ctx.seriesId,
          chatId: ctx.targetChatId,
          messageId: ctx.targetMessageId,
          expectedKey: ctx.expectedKey,
          monitorPagesToTarget: reach.pages,
        },
        checks,
      },
      null,
      2,
    ),
  )
  console.log(`\nRESULT ${passed}/${checks.length}  shots=${OUT}`)
  process.exit(passed === checks.length ? 0 : 2)
}

main().catch((e) => {
  console.error('FATAL', (e && e.stack) || e)
  process.exit(2)
})
