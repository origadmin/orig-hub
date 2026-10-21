'use strict'

/**
 * BUG-364 验收探针：剧集「在 TG 中查看」定位竞赛 + 入口去重 + 播放按钮 kind 分支
 * ============================================================================
 *
 * 修了什么（对照 docs/bugs/BUG-364.md）：
 *   ① TgPanel 定位循环误报：冷面板下 20 页预算被空转 tick 烧光（loadOlder 早退
 *      不翻页却照扣预算），首屏 4–19s 未到即弹 `tg.locateFailed`（toast 与
 *      「加载媒体中…」同屏，而消息实证在库约第 10 页）。修法四态分离：命中 /
 *      面板失败即 surfaced / 未就绪只等待（可见「正在定位」）/ 就绪后仅真实
 *      翻页扣预算。
 *   ② 入口重复：来源块应用内跳转与 t.me 外链文案同为「在 TG 中查看」+ 行级
 *      10px 第三颗。修法：行级入口撤销（BUG-305 判据3 由本登记 supersede），
 *      外链改「在浏览器打开」（BUG-285 ①d 文案值 supersede，testid/href 不变）。
 *   ③ 播放按钮不按 kind 分支：照片集显示「播放」+Play 图标（错承诺，
 *      media.episode.viewImage 键定义了没用上）。修法：photo ⇒ 「查看大图」
 *      + 图册灯箱；video ⇒ 原行为不变。
 *
 * 判据（全部可反向证伪；D=入口/分支，R=冷面板竞赛，N=真找不到，A=验牙）：
 *   D1 视频集来源块应用内跳转存在（button，文案「在 TG 中查看」）
 *   D2 t.me 外链存在（<a target=_blank>，文案「在浏览器打开」，href=期望深链，同行）
 *   D3 行级入口 episode-row-view-tg === 0（已撤销）
 *   D4 每颗来源恰好一颗应用内入口（jump 数 === 1 + 备用源行数）
 *   D5 视频分集播放按钮文案 === 「播放」
 *   D6 照片分支静态契约：SeriesDetail 播放按钮按 isPhotoEpisode(cur) 分支
 *      （文案 media.episode.viewImage + ImageIcon + openPhotoLightbox），两语言
 *      键非空。**为何不是 E2E**：照片条目不能成为分集（BUG-044 硬门，POST
 *      episodes 对 photo 条目 422 —— 见 F2 实测），照片分集在现行数据模型下
 *      构造不出来 ⇒ 静态判据 + 内存变异自证（变异副本必判红）
 *   D8 视频分集点播放 ⇒ 视频播放器打开（原路径不回退）
 *   R0 冷事实：点击前面板所在频道 ≠ 目标频道（否则测的是热路径）
 *   R1 「正在定位」可见反馈出现过（tg-locating）
 *   R2 全程无 locateFailed toast —— **反误报核心断言**
 *   R3 定位成功且高亮键 === 期望键（s-<chat>-<msg>）
 *   R4 真实翻页发生（beforeId 调用 ≥ 2）且预算有界（≤ LOCATE_MAX_PAGES=20）
 *   R5 面板切到了目标频道
 *   N1 伪 messageId ⇒ 最终如实弹 locateFailed（不静默）
 *   N2 全程无高亮（不假装成功）
 *   N3 翻页预算有界（beforeId 调用 ≤ 20，循环必然终止）
 *   N4 失败有反馈或足够快（locatingSeen 或 <5s，无声长等后误报 = 旧 bug 签名）
 *   A1 证伪锚点存在（TgPanel.tsx 含就绪门 + started 计数文本）
 *   A2 旧实现（摘就绪门 + 恢复空转扣预算）+ 首屏延迟 8s ⇒ 必现误报 toast 且无高亮
 *   A3 字节级还原（sha256 一致）
 *   A4 还原后同序列复跑必绿（无 toast + 高亮命中）
 *
 * 夹具：仅照片条目自造自删（POST /api/media/items，结尾 DELETE 并断言残留=0；
 * 分类管线若晚到给它建自动剧，按基线差分一并删净）。视频分集点播（D8）与
 * F2 硬门尝试直接复用**目标剧集自身**（T1 已验有字节）—— 分类管线当前关闭，
 * 自造视频条目不会自动建剧，而手工建剧会撞 media_episode.item_id 唯一索引。
 * 定位目标取自真实库（只读），深度经监控 API 有界核对（limit=30、最多 12 页，
 * 不触发深翻回补）。
 *
 * 采样器注意（首轮假红的教训）：高亮元素有两种根 —— MessageBubble 根自带
 * `data-message-key`，**AlbumBubble 根没有**（只有组内瓦片带）。相册命中时
 * 直接读根的 message-key 会恒得 null，把成功读成失败（R3/A4 首轮假红）。
 * `sample()` 因此相册感知：根无 key 时进组内比对 `expectedKey`（各组前重设）。
 *
 * Exit: 0 = 全部通过；2 = 有判据失败（含证伪红态未按预期失败 / 还原后不复绿）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'bug364')
const SHELL = path.resolve(__dirname, '..')
const TG_PANEL_TSX = path.join(SHELL, 'src', 'components', 'TgPanel.tsx')
const LOCALE_ZH = path.join(SHELL, 'src', 'i18n', 'locales', 'zh-CN.json')
const LOCALE_EN = path.join(SHELL, 'src', 'i18n', 'locales', 'en-US.json')

const ZH = JSON.parse(fs.readFileSync(LOCALE_ZH, 'utf8'))
const EN = JSON.parse(fs.readFileSync(LOCALE_EN, 'utf8'))

const LOCATE_FAILED_ZH = ZH['tg.locateFailed']
const LOCATING_ZH = ZH['tg.locating']
const VIEW_IN_TG_ZH = ZH['media.viewInTg']
const OPEN_IN_BROWSER_ZH = ZH['media.episode.openInBrowser']
const PLAY_ZH = ZH['media.episode.play']
const VIEW_IMAGE_ZH = ZH['media.episode.viewImage']

/** 1x1 红 PNG（照片夹具的真实字节；内容有效，灯箱里能渲染） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const FIXTURE_TITLE = 'BUG-364 夹具照片剧'

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Loud failure：抛错由外层 catch 收口 —— finally 里的夹具清理因此一定执行
 *  （process.exit 会跳过 finally，夹具将泄漏进共享库）。 */
function fatal(msg) {
  throw new Error(`FATAL: ${msg}`)
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────── HTTP（仅回环，读真值 / 造夹具） ───────────────────────────

async function httpJson(method, url, body, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

const apiGet = (base, p) => httpJson('GET', base + p)

/** 目标消息在监控消息流里的深度（页；limit=30）。找不到返回 null；超过 maxPages 返回 'deep'。 */
async function monitorDepth(tg, chatId, messageId, maxPages = 12) {
  let before
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({ channelId: String(chatId), limit: '30' })
    if (before !== undefined) q.set('beforeId', String(before))
    const r = await apiGet(tg, `/api/tg/monitor/messages?${q}`)
    const items = (r.json && r.json.items) || []
    if (items.some((m) => m.messageId === messageId)) return page + 1
    if (!r.json || !r.json.hasMore || items.length === 0) return null
    before = Math.min(...items.map((m) => m.messageId))
  }
  return 'deep'
}

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

const INSTALL_HELPERS = () => {
  window.__b364 = {
    /** 期望锚点（sample 在相册根无 message-key 时进组内比对它；每组前重设）。 */
    expectedKey: null,
    present(sel) {
      return document.querySelectorAll(sel).length
    },
    click(sel) {
      const el = document.querySelector(sel)
      if (!el) return false
      el.click()
      return true
    },
    text(sel) {
      const el = document.querySelector(sel)
      return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null
    },
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
    /** 来源块快照：入口元素事实 + 行数结构（主版本行 + 备用源 li）。 */
    sourceBlock() {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const block = document.querySelector('[data-testid="episode-source-info"]')
      if (!block) return null
      const kids = [...block.children]
      const primaryRow = kids[1] || null
      const jumps = [...block.querySelectorAll('[data-testid="episode-source-jump-tg"]')]
      const links = [...block.querySelectorAll('[data-testid="episode-source-view-tg"]')]
      const backupLis = block.querySelectorAll('ul > li').length
      const l = links[0] || null
      const j = jumps[0] || null
      return {
        jumpCount: jumps.length,
        linkCount: links.length,
        rowLevelCount: document.querySelectorAll('[data-testid="episode-row-view-tg"]').length,
        backupLis,
        jump: j ? { tag: j.tagName, text: norm(j.innerText) } : null,
        link: l
          ? {
              tag: l.tagName,
              href: l.getAttribute('href'),
              target: l.getAttribute('target'),
              text: norm(l.textContent),
              inPrimaryRow: !!(primaryRow && primaryRow.contains(l)),
            }
          : null,
      }
    },
    /** store dev 钩子事实（判据 N 组的伪坐标注入口）。 */
    storeOk() {
      const s = window.__origStore
      return !!s && typeof s.getState === 'function' && typeof s.getState().setPendingTgFocus === 'function'
    },
    setFocus(chatId, messageId) {
      const s = window.__origStore
      if (!s || typeof s.getState !== 'function') return false
      s.getState().setPendingTgFocus({ chatId, messageId })
      return true
    },
    /** 面板当前频道（冷/热事实的来源）。 */
    panelChannelId() {
      const hdr = document.querySelector('[data-testid="tg-channel-header"]')
      return hdr ? hdr.getAttribute('data-channel-id') : null
    },
    /** 在 TG 面板左栏（监控列表）里按标题文本点一个频道。 */
    clickMonitoredByTitle(title) {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return false
      const aside = panel.querySelector('aside')
      if (!aside) return false
      const b = [...aside.querySelectorAll('button')].find((x) =>
        (x.innerText || '').includes(title),
      )
      if (!b) return false
      b.click()
      return true
    },
    /** 全局 toast 全集（可能多条栈叠）。 */
    toasts() {
      return [...document.querySelectorAll('[data-testid="global-toast"]')]
        .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    },
    /** 定位采样：toast / 高亮 / 频道 / 「正在定位」/ 翻页计数。 */
    sample() {
      // 高亮元素两种根：MessageBubble 根自带 data-message-key；AlbumBubble 根
      // **没有**（只有组内瓦片带）—— 相册命中时要进组内找期望锚点，否则会把
      // 成功的高亮读成 null（B364 首轮 R3/A4 假红就是这个 sampler 缺陷）。
      const hl = document.querySelector('[data-tg-highlight="true"]')
      let hlKey = null
      if (hl) {
        hlKey = hl.getAttribute('data-message-key')
        if (!hlKey) {
          const want = window.__b364.expectedKey
          const inside = want ? hl.querySelector(`[data-message-key="${want}"]`) : null
          hlKey = inside ? want : 'album-other'
        }
      }
      const st = window.__b364fetch
      return {
        toasts: this.toasts(),
        highlight: hlKey,
        highlighted: !!hl,
        channelId: this.panelChannelId(),
        locating: !!document.querySelector('[data-testid="tg-locating"]'),
        pageLoads: st ? st.pages : -1,
        firstLoads: st ? st.firsts : -1,
      }
    },
  }
}

/**
 * 翻页计数器（window.fetch 包装）：只数 `/api/tg/monitor/messages`。
 * `beforeId` 调用 = 真实翻页（预算判据 R4/N3 的尺子）；无 beforeId = 首屏/轮询。
 * `armDelay(ms, windowMs)`：windowMs 内发起的监控调用一律延迟 ms —— A 组证伪用，
 * 把冷面板首屏**确定性**地压到 8s（旧实现 6s 烧光预算 ⇒ 必误报）。
 */
const INSTALL_FETCH_PROBE = () => {
  if (window.__b364fetch) {
    window.__b364fetch.reset()
    return
  }
  const orig = window.fetch
  const st = {
    pages: 0,
    firsts: 0,
    calls: [],
    delayMs: 0,
    delayUntil: 0,
    reset() {
      this.pages = 0
      this.firsts = 0
      this.calls = []
      this.delayMs = 0
      this.delayUntil = 0
    },
    armDelay(ms, windowMs) {
      this.delayMs = ms
      this.delayUntil = Date.now() + windowMs
    },
  }
  window.__b364fetch = st
  window.fetch = async function (...args) {
    let url = ''
    try {
      url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0])
    } catch (_e) {
      url = ''
    }
    if (url.includes('/api/tg/monitor/messages')) {
      const hasBefore = url.includes('beforeId=')
      if (hasBefore) st.pages += 1
      else st.firsts += 1
      st.calls.push({ hasBefore, t: Date.now() })
      if (st.delayUntil && Date.now() < st.delayUntil) {
        await new Promise((r) => setTimeout(r, st.delayMs))
      }
    }
    return orig.apply(this, args)
  }
}

/** 轮询定位结果；返回 { hit, samples, stopReason, elapsedMs }。 */
async function pollLocate(page, opts) {
  const { timeoutMs = 120000, stopOnToast = true, expectedKey = null } = opts
  const deadline = Date.now() + timeoutMs
  const samples = []
  const toastsSeen = new Set()
  let locatingSeen = false
  let highlightedSeen = false
  let maxPages = 0
  let firstsSeen = 0
  let hit = null
  let stopReason = 'timeout'
  const t0 = Date.now()
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.__b364.sample())
    samples.push({ t: Date.now() - t0, ...s })
    for (const t of s.toasts) toastsSeen.add(t)
    if (s.locating) locatingSeen = true
    if (s.highlighted) highlightedSeen = true
    maxPages = Math.max(maxPages, s.pageLoads)
    firstsSeen = Math.max(firstsSeen, s.firstLoads)
    if (s.highlight) {
      hit = s.highlight
      stopReason = 'hit'
      break
    }
    if (stopOnToast && s.toasts.some((t) => t.includes(LOCATE_FAILED_ZH))) {
      stopReason = 'locateFailed-toast'
      break
    }
    await delay(250)
  }
  return {
    hit,
    highlightedSeen,
    stopReason,
    elapsedMs: Date.now() - t0,
    toastsSeen: [...toastsSeen],
    locatingSeen,
    maxPages,
    firstsSeen,
    samples,
  }
}

/** 整页加载（vite 冷变更后首次加载可 >30s ⇒ 重试 + 打印 readyState，勿误判产品故障）。
 *  注意：整页加载会换 document ⇒ 页面内钩子（__b364 / __b364fetch）必须重装。 */
async function gotoApp(page, appUrl, attempts = 3) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await page.goto(appUrl, { settleMs: 1500, timeout: 60000 })
      await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-files"]'), {
        timeout: 45000,
      })
      const rs = await page.evaluate(() => document.readyState)
      if (rs === 'complete') {
        await page.evaluate(INSTALL_HELPERS)
        await page.evaluate(INSTALL_FETCH_PROBE)
        return true
      }
    } catch (e) {
      console.log(`[bug364] goto attempt ${i}/${attempts} failed: ${String((e && e.message) || e).slice(0, 160)}`)
    }
    await delay(1500)
  }
  return false
}

async function forceLanguage(page, appUrl, lang) {
  await gotoApp(page, appUrl)
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
  await gotoApp(page, appUrl)
  const langNow = await page.evaluate(() => document.documentElement.lang)
  return String(langNow).toLowerCase().startsWith('zh')
}

/** 打开剧集内页：文件域 → 剧集墙 → 点卡片（id 直击，不依赖标题）。 */
async function openSeriesDetail(page, seriesId) {
  await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="nav-files"]')
    if (nav) nav.click()
  })
  await delay(1200)
  await page.evaluate(() => {
    const child = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (child) child.click()
  })
  await delay(1000)
  await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="media-rail-series-all"]')
    if (rail) rail.click()
  })
  await delay(1200)
  try {
    await page.waitForFunction(
      (sid) => !!document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`),
      { timeout: 40000, args: [seriesId] },
    )
  } catch (_e) {
    return false
  }
  await page.evaluate((sid) => {
    const el = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (el) el.click()
  }, seriesId)
  try {
    await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-source-info"]'), {
      timeout: 30000,
    })
  } catch (_e) {
    return false
  }
  await delay(600)
  return true
}

async function focusEpisode(page, episodeId) {
  await page.evaluate((eid) => {
    const el = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)
    if (el) el.click()
  }, episodeId)
  await delay(800)
}

/** 冷面板前置：TG 面板 → 点一个**非目标**受监控频道 → 等它的消息流落地。 */
async function preloadColdChannel(page, channelTitle, channelId) {
  await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="nav-tg"]')
    if (nav) nav.click()
  })
  await delay(1500)
  console.log(`[bug364] preload: nav clicked, waiting panel（${channelTitle}）`)
  // 环境门（诚实区分抖动与失败）：等监控行**或**「TG 不可用」面板。
  // 今晚 TG 链路多次瞬时 down（BUG-351 重启风暴），不可用窗口里监控列表
  // 按 BUG-023 设计**不拉取**（依赖不可用时不发必 503 的请求）—— 那是环境
  // 事实，不是产品判据失败，必须显式报出来而不是盲等超时。
  const envDeadline = Date.now() + 120000
  let envState = 'timeout'
  while (Date.now() < envDeadline) {
    const st = await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
      const broken = document.querySelector('[data-testid="tg-panel-broken"]')
      const brokenText = broken ? (broken.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
      return {
        rowVisible: rows.some((r) => (r.innerText || '').includes(t)),
        broken: !!broken,
        brokenText,
      }
    }, channelTitle)
    if (st.rowVisible) {
      envState = 'rows'
      break
    }
    if (st.broken) {
      fatal(
        `环境不可用：TG 面板处于「不可用」态（${st.brokenText}）—— BUG-023 设计下监控列表不拉取。` +
          '这是 TG 链路抖动（今晚已知），非产品判据失败；等链路恢复后重跑本探针。',
      )
    }
    await delay(1000)
  }
  if (envState !== 'rows') {
    fatal(`冷面板前置失败：120s 内监控行未出现且面板未报不可用（state=${envState}）`)
  }
  console.log('[bug364] preload: monitor row visible, clicking')
  const clicked = await page.evaluate((t) => window.__b364.clickMonitoredByTitle(t), channelTitle)
  if (!clicked) fatal(`冷面板前置失败：监控列表里点不到频道「${channelTitle}」`)
  await page.waitForFunction(() => document.querySelectorAll('[data-message-key]').length > 0, {
    timeout: 60000,
  })
  console.log('[bug364] preload: feed landed, pinning channel')
  // 防「点了但没切过去」：monitoredRows 就位时有 auto-select 首频道的竞态，
  // 面板可能停在别的频道 —— 冷事实必须钉死，否则 R0 测的是热路径。
  let pinned = true
  try {
    await page.waitForFunction(
      (cid) => {
        const hdr = document.querySelector('[data-testid="tg-channel-header"]')
        return hdr && Number(hdr.getAttribute('data-channel-id')) === cid
      },
      // 注意：cdp 库的 waitForFunction 只认 options.args（第三个位置参数会被忽略）
      { timeout: 30000, args: [channelId] },
    )
  } catch (_e) {
    pinned = false
  }
  if (!pinned) {
    // 失败现场转储：header 实况 / store 的 tgMode / 当前激活行 / 筛选态 / 截图
    const dbg = await page.evaluate(() => {
      const hdr = document.querySelector('[data-testid="tg-channel-header"]')
      const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
      const st = window.__origStore && window.__origStore.getState ? window.__origStore.getState() : {}
      const activeRow = rows.find((r) => r.className.includes('bg-accent'))
      return {
        headerChannel: hdr ? hdr.getAttribute('data-channel-id') : null,
        headerText: hdr ? (hdr.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
        storeTgMode: (st.nav && st.nav.tgMode) ?? null,
        activeRowText: activeRow ? (activeRow.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) : null,
        rowTexts: rows.map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24)),
        filterView: !!document.querySelector('[data-testid="tg-filter-list"]'),
        messageKeys: document.querySelectorAll('[data-message-key]').length,
      }
    })
    await page.screenshot(path.join(OUT, '09_preload_pin_failed.png'))
    fatal(`冷面板钉死失败：点击后面板未停在冷频道。现场=${JSON.stringify(dbg)}`)
  }
  await delay(600)
}

// ─────────────────────────── 主流程 ───────────────────────────

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`[bug364] out=${OUT}`)

  const ep = await endpoints.resolve()
  console.log(`[bug364] app=${ep.app} tg=${ep.tg} daemon=${ep.daemon}`)
  check('E1 三端点可达（app/tg/daemon 均 resolve 成功）', true, `app=${ep.app} tg=${ep.tg}`)

  // ── P0 目标派生（HTTP，只读 + 自造夹具）──
  const monitored = await apiGet(ep.tg, '/api/tg/monitor/channels')
  const monitoredChannelsRaw = monitored.json || []
  // 冷面板频道必须**有消息**（否则预载后等不到消息流，前置等待会超时误判）
  const monitoredChannels = []
  for (const c of monitoredChannelsRaw) {
    const probe = await apiGet(
      ep.tg,
      `/api/tg/monitor/messages?channelId=${c.channelId}&limit=1`,
    )
    const n = (probe.json && probe.json.items || []).length
    monitoredChannels.push({ id: c.channelId, title: c.title || String(c.channelId), hasMessages: n > 0 })
  }
  check('E2 受监控频道列表非空', monitoredChannels.length > 0, `n=${monitoredChannels.length}`)
  if (monitoredChannels.length < 2) fatal('受监控频道不足 2 个，无法构造冷面板前置')

  const seriesList = await apiGet(ep.tg, '/api/media/series')
  const allSeries = (seriesList.json && seriesList.json.items) || []
  check('E3 剧集列表非空', allSeries.length > 0, `n=${allSeries.length}`)

  // 定位目标：TG 源分集，监控流深度 2–12 页（要真翻页、又必须在 20 页预算内），有字节
  let target = null
  for (const s of allSeries) {
    if (target) break
    let detail
    try {
      detail = await apiGet(ep.tg, `/api/media/series/${s.id}`)
    } catch (_e) {
      continue
    }
    const eps = (detail.json && detail.json.episodes) || []
    for (const e of eps) {
      if (e.source !== 'tg' || !e.ref || !e.hasBytes) continue
      const at = parseRef(e.ref)
      if (!at) continue
      const depth = await monitorDepth(ep.tg, at.chatId, at.messageId, 12)
      if (typeof depth === 'number' && depth >= 2 && depth <= 12) {
        target = {
          seriesId: s.id,
          seriesTitle: s.title || `#${s.id}`,
          episodeId: e.id,
          chatId: at.chatId,
          messageId: at.messageId,
          depth,
          expectedKey: `s-${at.chatId}-${at.messageId}`,
          expectedUrl: `https://t.me/c/${at.chatId}/${at.messageId}`,
        }
        break
      }
    }
  }
  if (!target) fatal('找不到深度 2–12 页的 TG 源分集（定位竞赛无可验证目标）')
  check(
    'T1 定位目标已派生（TG 源 + 深度 2–12 页 + 有字节）',
    true,
    `series=${target.seriesId} ep=${target.episodeId} ref=${target.chatId}:${target.messageId} depth=${target.depth} key=${target.expectedKey}`,
  )

  const cold = monitoredChannels.find((c) => c.id !== target.chatId && c.hasMessages)
  check(
    'T2 冷面板频道已选（≠ 目标频道且有消息）',
    !!cold,
    cold ? `cold=${cold.title}(${cold.id}) target=${target.chatId}` : 'none',
  )
  if (!cold) fatal('找不到可作冷面板前置的受监控频道（≠ 目标且有消息）')

  // 照片夹具（自造自删；任何一步失败都要在 finally 里删净）
  // 视频分集点播复用**目标剧集自身**（T1 已验有字节）—— 不再自造视频条目：
  // 分类管线（classify_enabled）当前关闭 ⇒ 本地视频条目导入后不再自动建剧；
  // 而手工建剧/编集会撞 media_episode.item_id 唯一索引（一个条目只能属于一部剧，
  // 实测 500 留证）。夹具只需照片条目（F2 硬门尝试用）。
  let browser = null
  let photoItemId = null
  let tmpDir = null
  let newSeriesIds = []
  let seriesIdsBefore = new Set()
  const pageErrors = []
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-bug364-'))
  const pngPath = path.join(tmpDir, 'fixture-photo.png')
  fs.writeFileSync(pngPath, PNG_1X1)

  // 导入前的剧集基线：分类管线可能给照片条目也建自动剧 ⇒ 清理按「新增全集」删
  seriesIdsBefore = new Set(
    (((await apiGet(ep.tg, '/api/media/series')).json || {}).items || []).map((s) => s.id),
  )

  const photoItemRes = await httpJson('POST', `${ep.tg}/api/media/items`, {
    items: [{ path: pngPath, source: 'local', kind: 'photo', title: 'BUG-364 夹具照片' }],
  })
  photoItemId = photoItemRes.json && Array.isArray(photoItemRes.json.ids) ? photoItemRes.json.ids[0] : null
  if (!photoItemId) {
    fatal(`夹具条目创建失败 photo=${photoItemRes.status}/${photoItemRes.text.slice(0, 120)}`)
  }
  // BUG-044 硬门实测：照片条目不能成为分集（422）—— 这正是照片标签分支
  // 无法 E2E 的原因（数据模型里构造不出 photo 分集），留证。
  // 对目标剧集发起（422 的 kind 门先于槽位冲突门，S1E2 被占也不影响判据）。
  const photoEpAttempt = await httpJson('POST', `${ep.tg}/api/media/series/${target.seriesId}/episodes`, {
    itemId: photoItemId,
    season: 1,
    episodeNo: 2,
  })
  check(
    'F2 BUG-044 硬门依旧：照片条目成为分集被 422 拒绝（照片分支不可 E2E 的原因）',
    photoEpAttempt.status === 422,
    `status=${photoEpAttempt.status} body=${photoEpAttempt.text.slice(0, 80)}`,
  )

  // ── 浏览器 ──
  const pageErrors = []
  {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.evaluate(INSTALL_HELPERS)

    const zhOk = await forceLanguage(page, ep.app, 'zh-CN')
    check('P1 界面语言 = zh-CN', zhOk)

    // ── D 组：入口去重 + kind 分支 ──
    const openedTarget = await openSeriesDetail(page, target.seriesId)
    if (!openedTarget) fatal(`打不开目标剧集内页 series=${target.seriesId}`)
    await focusEpisode(page, target.episodeId)
    const blk = await page.evaluate(() => window.__b364.sourceBlock())
    if (!blk) fatal('来源块不可读（episode-source-info missing）')
    await page.screenshot(path.join(OUT, '01_video_source_entries.png'))

    check(
      'D1 视频集来源块应用内跳转存在（button，文案 = media.viewInTg）',
      !!blk.jump && blk.jump.tag === 'BUTTON' && blk.jump.text === VIEW_IN_TG_ZH,
      `jump=${JSON.stringify(blk.jump)} expect="${VIEW_IN_TG_ZH}"`,
    )
    check(
      'D2 t.me 外链存在（<a target=_blank>，文案 = media.episode.openInBrowser，href=期望深链，同行）',
      !!blk.link &&
        blk.link.tag === 'A' &&
        blk.link.target === '_blank' &&
        blk.link.text === OPEN_IN_BROWSER_ZH &&
        blk.link.href === target.expectedUrl &&
        blk.link.inPrimaryRow === true,
      `link=${JSON.stringify(blk.link)} expectText="${OPEN_IN_BROWSER_ZH}" expectHref=${target.expectedUrl}`,
    )
    check(
      'D3 行级入口已撤销（episode-row-view-tg = 0，BUG-364 supersede BUG-305 判据3）',
      blk.rowLevelCount === 0,
      `rowLevelCount=${blk.rowLevelCount}`,
    )
    check(
      'D4 每颗来源恰好一颗应用内入口（jump 数 === 1 + 备用源行数）',
      blk.jumpCount === 1 + blk.backupLis,
      `jumpCount=${blk.jumpCount} backupLis=${blk.backupLis}`,
    )
    const playLabelVideo = await page.evaluate(() => window.__b364.text('[data-testid="episode-play"]'))
    check(
      'D5 视频分集播放按钮文案 = media.episode.play（「播放」）',
      playLabelVideo === PLAY_ZH,
      `label="${playLabelVideo}" expect="${PLAY_ZH}"`,
    )

    // ── D6：照片分支静态契约（E2E 不可达：BUG-044 硬门拒照片分集，见 F2）──
    const sdSrc = fs.readFileSync(
      path.join(SHELL, 'src', 'components', 'media', 'SeriesDetail.tsx'),
      'utf8',
    )
    const btnAt = sdSrc.indexOf('data-testid="episode-play"')
    const btnSrc = btnAt >= 0 ? sdSrc.slice(Math.max(0, btnAt - 900), btnAt + 1400) : ''
    const branch = {
      label: btnSrc.includes("isPhotoEpisode(cur) ? t('media.episode.viewImage') : t('media.episode.play')"),
      icon: btnSrc.includes('isPhotoEpisode(cur) ? (') && btnSrc.includes('<ImageIcon'),
      click:
        btnSrc.includes('isPhotoEpisode(cur)') &&
        btnSrc.includes('openPhotoLightbox(') &&
        btnSrc.includes('playEpisode(cur)'),
    }
    check(
      'D6 照片分支静态契约（文案/图标/点击三处按 isPhotoEpisode(cur) 分支）',
      branch.label && branch.icon && branch.click,
      JSON.stringify(branch),
    )
    check(
      'D6b viewImage 键两语言非空（不是回退 key 名）',
      !!ZH['media.episode.viewImage'] && !!EN['media.episode.viewImage'],
      `zh="${ZH['media.episode.viewImage']}" en="${EN['media.episode.viewImage']}"`,
    )
    // 静态判据的自证：内存变异（摘掉文案分支）必判红 —— 禁恒绿
    const mutant = sdSrc.replace(
      "{isPhotoEpisode(cur) ? t('media.episode.viewImage') : t('media.episode.play')}",
      "{t('media.episode.play')}",
    )
    const mutantBtn = mutant.slice(Math.max(0, btnAt - 900), btnAt + 1400)
    const mutantLabelBranch = mutantBtn.includes(
      "isPhotoEpisode(cur) ? t('media.episode.viewImage') : t('media.episode.play')",
    )
    check(
      'D6c 静态判据有牙：内存变异副本（摘文案分支）必判红',
      mutant !== sdSrc && !mutantLabelBranch,
      `mutated=${mutant !== sdSrc} mutantLabelBranch=${mutantLabelBranch}`,
    )

    // 视频分集点播：复用目标剧集自身（T1 已验有字节）⇒ 视频播放器
    const openedFx = await openSeriesDetail(page, target.seriesId)
    if (!openedFx) fatal(`打不开目标剧集内页 series=${target.seriesId}`)
    await focusEpisode(page, target.episodeId)
    const playLabelFxVideo = await page.evaluate(() =>
      window.__b364.text('[data-testid="episode-play"]'),
    )
    check(
      'D8a 视频分集文案仍为「播放」',
      playLabelFxVideo === PLAY_ZH,
      `label="${playLabelFxVideo}"`,
    )
    await page.evaluate(() => window.__b364.click('[data-testid="episode-play"]'))
    let viewerOpened = true
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), {
        timeout: 10000,
      })
    } catch (_e) {
      viewerOpened = false
    }
    check('D8b 视频分集点播放 ⇒ 视频播放器打开（原路径不回退）', viewerOpened, `viewer=${viewerOpened}`)
    await page.screenshot(path.join(OUT, '04_video_viewer.png'))
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    )
    // 播放器是 fixed 全屏遮罩：不等到它**真消失**就点导航，点击会被遮罩
    // 吞掉（冷前置随之 60s 超时 —— 首轮之后两轮 FATAL 的根因）。
    try {
      await page.waitForFunction(() => !document.querySelector('[data-testid="media-viewer"]'), {
        timeout: 8000,
      })
    } catch (_e) {
      fatal('播放器关不掉（Escape 后 media-viewer 仍在）—— 后续导航点击会被遮罩吞掉')
    }
    await delay(500)

    // ── R 组：冷面板定位竞赛（自然时序）──
    await preloadColdChannel(page, cold.title, cold.id)
    // 冷事实在**前置后立刻**取：再往下就切去剧集详情（TG 面板不在场，
    // header 不在 DOM 里，取到的是 null 而非事实）。测的是「点跳转前，
    // 面板停在哪个频道」—— 那才是竞赛的起点。
    const channelCold = await page.evaluate(() => window.__b364.panelChannelId())
    check(
      'R0 冷事实：点击跳转前面板频道 ≠ 目标频道（测的是冷面板路径）',
      channelCold !== null && Number(channelCold) !== target.chatId,
      `before=${channelCold} target=${target.chatId}`,
    )
    const reopened = await openSeriesDetail(page, target.seriesId)
    if (!reopened) fatal('竞赛前打不开目标剧集内页')
    await focusEpisode(page, target.episodeId)

    const storeOk = await page.evaluate(() => window.__b364.storeOk())
    check('E4 store dev 钩子可用（__origStore.setPendingTgFocus）', storeOk)
    if (!storeOk) fatal('store dev 钩子不可用 —— N 组（伪坐标注入）无法运行')

    await page.evaluate(() => window.__b364fetch && window.__b364fetch.reset())
    await page.evaluate((k) => {
      window.__b364.expectedKey = k
    }, target.expectedKey)

    const jumped = await page.evaluate(() =>
      window.__b364.click('[data-testid="episode-source-jump-tg"]'),
    )
    if (!jumped) fatal('点不中应用内跳转入口（episode-source-jump-tg）')

    const rRes = await pollLocate(page, {
      timeoutMs: 120000,
      stopOnToast: true,
      expectedKey: target.expectedKey,
    })
    await page.screenshot(path.join(OUT, '05_locate_hit.png'))

    check(
      'R1 「正在定位」可见反馈出现过（tg-locating）',
      rRes.locatingSeen,
      `locatingSeen=${rRes.locatingSeen}`,
    )
    check(
      'R2 全程无 locateFailed toast（反误报核心断言）',
      !rRes.toastsSeen.some((t) => t.includes(LOCATE_FAILED_ZH)),
      `toasts=${JSON.stringify(rRes.toastsSeen)}`,
    )
    check(
      'R3 定位成功且高亮键 = 期望键',
      rRes.hit === target.expectedKey,
      `hit=${rRes.hit} expect=${target.expectedKey} stop=${rRes.stopReason} elapsed=${(rRes.elapsedMs / 1000).toFixed(1)}s`,
    )
    check(
      'R4 真实翻页发生（beforeId 调用 ≥ 2）且预算有界（≤ 20 页）',
      rRes.maxPages >= 2 && rRes.maxPages <= 20,
      `pageLoads=${rRes.maxPages} firstLoads=${rRes.firstsSeen}`,
    )
    const channelAfter = await page.evaluate(() => window.__b364.panelChannelId())
    check(
      'R5 面板切到了目标频道',
      channelAfter !== null && Number(channelAfter) === target.chatId,
      `after=${channelAfter} target=${target.chatId}`,
    )

    // ── N 组：真找不到（伪 messageId，与产品入口同一条 store 通道）──
    await page.evaluate(() => window.__b364fetch && window.__b364fetch.reset())
    const injected = await page.evaluate((c, m) => window.__b364.setFocus(c, m), target.chatId, 999999999)
    if (!injected) fatal('伪坐标注入失败（setPendingTgFocus）')
    const nRes = await pollLocate(page, {
      timeoutMs: 120000,
      stopOnToast: true,
      expectedKey: null,
    })
    await page.screenshot(path.join(OUT, '06_not_found_toast.png'))
    check(
      'N1 伪 messageId ⇒ 最终如实弹 locateFailed（不静默）',
      nRes.stopReason === 'locateFailed-toast' &&
        nRes.toastsSeen.some((t) => t.includes(LOCATE_FAILED_ZH)),
      `stop=${nRes.stopReason} toasts=${JSON.stringify(nRes.toastsSeen)} elapsed=${(nRes.elapsedMs / 1000).toFixed(1)}s`,
    )
    check(
      'N2 全程无高亮（不假装定位成功）',
      !nRes.highlightedSeen,
      `highlightedSeen=${nRes.highlightedSeen} hit=${nRes.hit}`,
    )
    check(
      'N3 翻页预算有界（beforeId 调用 ≤ 20，循环必然终止）',
      nRes.maxPages <= 20,
      `pageLoads=${nRes.maxPages}`,
    )
    check(
      'N4 失败有反馈或足够快（locatingSeen 或 <5s —— 不许无声长等后误报）',
      nRes.locatingSeen || nRes.elapsedMs < 5000,
      `locatingSeen=${nRes.locatingSeen} elapsed=${(nRes.elapsedMs / 1000).toFixed(1)}s`,
    )

    // ── A 组：A/B 反向证伪（验牙）──
    const original = fs.readFileSync(TG_PANEL_TSX)
    const shaBefore = crypto.createHash('sha256').update(original).digest('hex')

    const TAMPER_FROM = [
      '        // ② 面板内容流加载失败 ⇒ 定位无从谈起：如实 surfaced 失败原因，',
      '        //    绝不把「面板没加载出来」写成「消息找不到」（误报的直接来源）。',
      '        if (feedErrorRef.current) {',
      '          setLocateReq(null)',
      '          setError(feedErrorRef.current)',
      '          return',
      '        }',
      '        // ③ 面板已离开目标频道（用户切到别的频道 / 回列表）⇒ 焦点失效，',
      '        //    静默取消——不拿旧频道的结论报新频道的案，也不误报「找不到」。',
      '        const src = feedSourceRef.current',
      '        if (!src || src.chatId !== chatId) {',
      '          setLocateReq(null)',
      '          return',
      '        }',
      '        // ③b 目标频道首屏未就绪 ⇒ 只等待。冷面板首屏 4–19s，旧实现在这里',
      '        //      空转烧光预算；现在预算一分不花，界面持续显示「正在定位」。',
      '        if (!feedReadyRef.current) return',
      '        // ④ 就绪后翻页：仅当 loadOlder 真发起了一次翻页才扣预算',
      '        //      （空转/在途/无更多都不扣 —— 预算只对真实翻页生效）。',
      '        if (hasMoreRef.current && pages < LOCATE_MAX_PAGES) {',
      '          const started = await loadOlderRef.current()',
      '          if (started) {',
      '            pages += 1',
      '          }',
      '          return',
      '        }',
    ].join('\n')
    const TAMPER_TO = [
      '        if (hasMoreRef.current && pages < LOCATE_MAX_PAGES) {',
      '          pages += 1',
      '          await loadOlderRef.current()',
      '          return',
      '        }',
    ].join('\n')

    const normalized = original.toString('utf8').replace(/\r\n/g, '\n')
    const occurrences = normalized.split(TAMPER_FROM).length - 1
    check('A1 证伪锚点存在（TgPanel.tsx 含就绪门 + started 计数，唯一一处）', occurrences === 1, `occurrences=${occurrences}`)
    if (occurrences !== 1) fatal('证伪锚点不唯一/不存在 —— 无法做字节级 A/B')

    const eol = original.toString('utf8').includes('\r\n') ? '\r\n' : '\n'
    const tampered = normalized.replace(TAMPER_FROM, TAMPER_TO)
    fs.writeFileSync(TG_PANEL_TSX, tampered.replace(/\n/g, eol))
    await delay(2500) // 等 vite 监视器落定再整页加载

    /** 冷面板 + 首屏延迟 8s 的一次完整跳转序列（A 组两轮共用）。 */
    async function runColdJumpWithDelay() {
      await gotoApp(page, ep.app)
      await page.evaluate(INSTALL_HELPERS)
      await page.evaluate(INSTALL_FETCH_PROBE)
      await page.evaluate((k) => {
        window.__b364.expectedKey = k
      }, target.expectedKey)
      await preloadColdChannel(page, cold.title, cold.id)
      const ok = await openSeriesDetail(page, target.seriesId)
      if (!ok) fatal('A 组序列：打不开目标剧集内页')
      await focusEpisode(page, target.episodeId)
      await page.evaluate(() => {
        window.__b364fetch && window.__b364fetch.reset()
        window.__b364fetch && window.__b364fetch.armDelay(8000, 7000)
      })
      const clicked = await page.evaluate(() =>
        window.__b364.click('[data-testid="episode-source-jump-tg"]'),
      )
      if (!clicked) fatal('A 组序列：点不中跳转入口')
      return pollLocate(page, { timeoutMs: 60000, stopOnToast: true, expectedKey: target.expectedKey })
    }

    // A2：旧实现必红（首屏 8s 才到，6s 预算烧光 ⇒ 误报 toast、无高亮）
    const oldRes = await runColdJumpWithDelay()
    await page.screenshot(path.join(OUT, '07_teeth_old_fail.png'))
    const oldRed =
      oldRes.stopReason === 'locateFailed-toast' &&
      oldRes.toastsSeen.some((t) => t.includes(LOCATE_FAILED_ZH)) &&
      oldRes.hit === null
    check(
      'A2 旧实现（摘就绪门+空转扣预算）在延迟首屏下必现误报 toast 且无高亮（判据有牙）',
      oldRed,
      `stop=${oldRes.stopReason} hit=${oldRes.hit} elapsed=${(oldRes.elapsedMs / 1000).toFixed(1)}s toasts=${JSON.stringify(oldRes.toastsSeen)}`,
    )

    // A3：字节级还原
    fs.writeFileSync(TG_PANEL_TSX, original)
    const restored = fs.readFileSync(TG_PANEL_TSX)
    const shaAfter = crypto.createHash('sha256').update(restored).digest('hex')
    check('A3 字节级还原（sha256 与修复版一致）', shaAfter === shaBefore, `sha=${shaAfter.slice(0, 12)}`)
    await delay(2500)

    // A4：还原后同序列必绿
    const newRes = await runColdJumpWithDelay()
    await page.screenshot(path.join(OUT, '08_teeth_new_pass.png'))
    check(
      'A4 还原后同序列必绿（无 toast + 高亮命中）',
      newRes.hit === target.expectedKey &&
        !newRes.toastsSeen.some((t) => t.includes(LOCATE_FAILED_ZH)),
      `hit=${newRes.hit} stop=${newRes.stopReason} elapsed=${(newRes.elapsedMs / 1000).toFixed(1)}s toasts=${JSON.stringify(newRes.toastsSeen)}`,
    )

    const errs = await page.pageErrors()
    for (const e of errs) pageErrors.push(String((e && e.message) || e))
  }
  } finally {
    // ── 夹具清理（提前失败的路径也要走；残留=0 断言）──
    if (photoItemId || newSeriesIds.length) {
      // 删「导入后新增的全部剧集」（分类管线可能给照片条目建自动剧）—— 基线差分
      // 在清理时**重新算**（分类管线可能晚到），不依赖轮询快照。
      const listNow = await apiGet(ep.tg, '/api/media/series')
      const idsNow = ((listNow.json || {}).items || []).map((s) => s.id)
      const toDelete = idsNow.filter((id) => !seriesIdsBefore.has(id))
      const delSeriesResults = []
      for (const sid of toDelete) {
        delSeriesResults.push(await httpJson('DELETE', `${ep.tg}/api/media/series/${sid}`))
      }
      const delPhoto = photoItemId
        ? await httpJson('DELETE', `${ep.tg}/api/media/items/${photoItemId}`)
        : { status: 204 }
      try {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch (_e) {
        /* 临时目录清不掉不影响判据 */
      }
      const chkPhoto = photoItemId
        ? await apiGet(ep.tg, `/api/media/items/${photoItemId}`)
        : { status: 404 }
      // 新增剧集必须全部消失（复查列表里不再有其中任何一个）
      const listAfter = await apiGet(ep.tg, '/api/media/series')
      const idsAfter = new Set(((listAfter.json || {}).items || []).map((s) => s.id))
      const leaked = toDelete.filter((id) => idsAfter.has(id))
      const allDelOk = delSeriesResults.every((r) => r.status >= 200 && r.status < 300)
      check(
        'C1 夹具残留 = 0（新增剧集全删 + 照片条目删净，复查 404/不在列表）',
        allDelOk &&
          leaked.length === 0 &&
          delPhoto.status >= 200 &&
          delPhoto.status < 300 &&
          chkPhoto.status === 404,
        `newSeries=${JSON.stringify(toDelete)} del=${JSON.stringify(delSeriesResults.map((r) => r.status))} leaked=${JSON.stringify(leaked)} chk=${chkPhoto.status}`,
      )
    }
    if (browser) {
      try {
        await browser.close()
      } catch (_e) {
        /* 浏览器关闭失败不掩盖判据结果 */
      }
    }
  }

  // ── 汇总 ──
  const failed = checks.filter((c) => !c.ok)
  const result = {
    bug: 'BUG-364',
    at: new Date().toISOString(),
    endpoints: { app: ep.app, tg: ep.tg, daemon: ep.daemon },
    target,
    coldChannel: cold,
    fixture: { photoItemId },
    checks,
    pageErrors,
    pass: failed.length === 0,
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`\n[bug364] ${checks.length - failed.length}/${checks.length} PASS${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`)
  if (pageErrors.length) console.log(`[bug364] page errors (${pageErrors.length}): ${pageErrors.slice(0, 3).join(' || ')}`)
  process.exit(failed.length === 0 ? 0 : 2)
})().catch((e) => {
  console.error(`[bug364] FATAL-EXIT: ${(e && e.message) || e}`)
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify(
        {
          bug: 'BUG-364',
          at: new Date().toISOString(),
          pass: false,
          fatal: String((e && e.message) || e),
          checks,
        },
        null,
        2,
      ),
    )
  } catch (_e) {
    /* 证据落盘失败不掩盖原始错误 */
  }
  process.exit(2)
})
