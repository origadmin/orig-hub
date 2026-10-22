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
 *   3. 条目级与剧集级都可跳：cat-all 文件行入口（`file-list-view-tg-*`，BUG-385）+
 *      SeriesDetail 来源块（`episode-source-jump-tg`）—— 两类都定位到同一频道同一消息。
 *      （BUG-364：原列表行第三入口 `episode-row-view-tg` 撤销 —— 与来源块跳转同坐标、
 *      同文案、10px 违反可读性门槛；应用内跳转收敛为「每颗来源一颗」。）
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
 *   入口面沿革（2026-10-22 探针腐烂修正，判据编号不变、断言面改基到现行契约）：
 *   - BUG-305 落地时（2026-10-14）：条目卡片 `item-view-tg` 是入口面之一；
 *   - BUG-307 设计锁（同日用户拍板）：「视频 = 通用类，TG 跳转 = 剧集链路专有」
 *     ⇒ items 网格 MediaCard **不烤** onViewInTg，卡片级判据反转为「必须没有」；
 *   - BUG-385（2026-10-22）：入口面 = cat-all 文件行 `file-list-view-tg-*` +
 *     剧集链路（SeriesDetail 来源块 `episode-source-jump-tg`）。
 *   条目级跳转/证伪/复绿全部改走 cat-all 文件行；`item-view-tg` 仅作 BUG-307
 *   锁的反向断言（网格恒无入口）。
 *   ② 媒体库条目里选一条 **TG 来源 + ref 可解析 + 频道已监控 + 有字节 +
 *      属于某剧集** 的条目（剧集级判据需要它）；BUG-364 起若库态没有同时满足
 *      「剧集 + 监控流可达 + 标题可派生搜索词」三条件的条目（2026-10-21 实测
 *      即此：缓存窗口内的剧集条目全是 BUG-362 兜底标题不可搜，可搜的都在窗口
 *      外），先自造夹具（TG 源登记 + 无 caption video 锚点 + 『〖B』唯一可搜
 *      标题，BUG-304 导入自动归档建剧，再经引擎缓存任务给锚点补**真字节**
 *      —— 否则 UI 搜索与 deriveSearchTerm 的 hasBytes 门都看不见它），
 *      判据全跑完后自删（C1 断言条目/剧集/缓存任务记录/落盘字节残留 = 0）；
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
/**
 * FATAL = 判据空转，不许当通过。改为 throw（带标记）而非 process.exit ——
 * BUG-364 起探针有库内夹具，硬退会漏删夹具；throw 让 main 的收尾清理
 * （cleanupFixture）与 .catch 都能跑到，行为对调用方不变（仍是非零退出）。
 */
function fatal(msg) {
  const e = new Error(`[bug305] FATAL: ${msg}`)
  e.bug305Fatal = true
  throw e
}

/** POST/DELETE 等写操作（夹具生命周期用）；回环、带超时。status 0 = 网络层失败。 */
async function httpJsonOnce(method, url, body, timeoutMs = 20000) {
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
      /* 非 JSON 响应保留 text 供判读 */
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 写操作 + 网络层重试（停摆窗口数秒；幂等 ⇒ 重试安全）。 */
async function httpJson(method, url, body, timeoutMs = 20000) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await httpJsonOnce(method, url, body, timeoutMs)
    if (r.status !== 0 || attempt === 4) return r
    await delay(2000)
  }
}

// ─────────────────────────── HTTP（仅回环，读真值 / 派生目标） ───────────────────────────

/**
 * 网络层重试（本机 orig-tg 已知间歇停摆：TCP 接受层面偶发数秒不响应，
 * curl 与 Node 交替命中——2026-10-21 实测多次，进程始终健康）。
 * 只对**网络错误**重试（fetch 抛错 / status 0），HTTP 状态码错误不重试
 * （404/422 等是产品的确定性回答，重试会掩盖语义）。全部用法均幂等：
 * GET 无害；POST 按 (source,ref) upsert；DELETE 幂等 ⇒ 重试安全。
 */
async function withNetRetry(fn, attempts = 4, gapMs = 2000) {
  let lastErr = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      // 带 httpStatus 的错是产品的确定性回答（404/422…）—— 原样抛出，不重试
      if (e && e.httpStatus) throw e
      if (i < attempts) await delay(gapMs)
    }
  }
  throw lastErr
}

async function apiGet(base, p, timeoutMs = 20000) {
  return withNetRetry(async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(base + p, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        const e = new Error(`${p} -> HTTP ${res.status} ${text.slice(0, 120)}`)
        e.httpStatus = res.status
        throw e
      }
      return text ? JSON.parse(text) : null
    } finally {
      clearTimeout(timer)
    }
  })
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

/**
 * 给夹具补**真字节**（BUG-364 复跑的决定性一步）。
 *
 * 为什么必须补：UI 媒体库搜索与 `deriveSearchTerm` 都带 `hasBytes=true`
 * （MediaLibraryPanel.tsx 实证；后端口径 = `file_path IS NOT NULL`，见
 * media.rs `ItemQuery::has_bytes` 的说明）—— 无字节条目进不了成品列表，
 * 夹具没有字节 ⇒ 搜索框判据与卡片判据同时失去对象（等卡片等到超时）。
 *
 * 走**真实产品路径**而非任何后门：`POST /api/tg/cache/tasks` 入队 →
 * worker T0 登记按 (tg, ref) 复用夹具条目（`register_media_item_t0` 的
 * `item_id_by_ref` 分支，标题非空不覆盖）→ 下载完成由
 * `backfill_item_bytes_with_blob` 回填 `file_path`。轮询以条目
 * `bytesPresence === 'present'` 为准（BUG-132 三态探测 = 唯一真相）。
 *
 * 返回 `{ taskId, ownRecord, absolutePath }`：
 *   taskId      = 入队响应给出的任务 id（`alreadyIngested` 时为 null）；
 *   ownRecord   = 该任务行是否由本次探针**新建**（入队前 by-item 查无记录，
 *                 且响应是恰好覆盖锚点一条的单消息任务）—— requeue 复用的
 *                 旧行 / 相册组行不删，那是既有产品状态，探针无权抹掉；
 *   absolutePath = 回填后的字节绝对路径（C1 残留断言用）。
 */
async function cacheAnchorForBytes(ep, anchor, itemId, timeoutMs = 240000) {
  const ref = `${anchor.chatId}:${anchor.messageId}`
  // 入队前先查：已有任务记录 ⇒ 即便响应是同一行也不是我们建的（requeue 复用）
  const pre = await apiGet(ep.tg, `/api/tg/cache/tasks/by-item?refs=${encodeURIComponent(ref)}`)
  const preExists = !!(pre && pre.tasks && pre.tasks[ref])
  const enc = await httpJson('POST', `${ep.tg}/api/tg/cache/tasks`, {
    chatId: anchor.chatId,
    messageIds: [anchor.messageId],
  })
  if (enc.json && enc.json.alreadyIngested === true) {
    // 并发写者已缓存过这条消息：字节已在盘，没有新任务行要清
    const back = await apiGet(ep.tg, `/api/media/items/${itemId}`)
    fixtureCache = { taskId: null, ownRecord: false, absolutePath: (back && back.absolutePath) || null, ref }
    return fixtureCache
  }
  const taskId = enc.json && typeof enc.json.id === 'number' ? enc.json.id : null
  if (enc.status >= 300 || !taskId) {
    fatal(
      `cache enqueue for fixture anchor ${ref} failed: ` +
        `${enc.status}/${String(enc.text).slice(0, 160)}`,
    )
  }
  const sole =
    Array.isArray(enc.json.messageIds) &&
    enc.json.messageIds.length === 1 &&
    enc.json.messageIds[0] === anchor.messageId &&
    String(enc.json.itemKey) === `m:${anchor.chatId}:${anchor.messageId}`
  // 先落账再轮询：轮询途中 fatal（任务失败 / 超时）时，.catch 的
  // cleanupFixture 也能凭这条记录删掉任务行与字节——不靠调用方记得传参。
  fixtureCache = { taskId, ownRecord: !preExists && sole, absolutePath: null, ref }
  const deadline = Date.now() + timeoutMs
  let lastItem = null
  let lastTask = null
  while (Date.now() < deadline) {
    lastItem = await apiGet(ep.tg, `/api/media/items/${itemId}`)
    if (lastItem && lastItem.bytesPresence === 'present') {
      fixtureCache.absolutePath = lastItem.absolutePath || null
      return fixtureCache
    }
    const byItem = await apiGet(
      ep.tg,
      `/api/tg/cache/tasks/by-item?refs=${encodeURIComponent(ref)}`,
    )
    lastTask = (byItem && byItem.tasks && byItem.tasks[ref]) || null
    if (lastTask && ['failed', 'cancelled', 'interrupted'].includes(lastTask.status)) {
      fatal(
        `cache task ${taskId} for ${ref} ended "${lastTask.status}" ` +
          `(${lastTask.error || 'no error field'}) — fixture cannot get bytes`,
      )
    }
    await delay(2000)
  }
  fatal(
    `fixture bytes never became present within ${timeoutMs}ms ` +
      `(task=${taskId} status=${lastTask && lastTask.status} ` +
      `bytesPresence=${lastItem && lastItem.bytesPresence})`,
  )
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
    /**
     * 组内频道行 = 面板**第二列**（`tg-panel-root > div > section`，直接子级）
     * 里的按钮。
     *
     * 为什么不能写 `panel.querySelector('section')`：左栏 aside 内部就有三个
     * `<section>`（筛选/监控/订阅），document 顺序全在第二列之前 —— 旧写法取到
     * 的是「文字筛选」节（2026-10-22 实证：预切频道 4  attempts 全失败，
     * 点到的是筛选节按钮，频道头永不更新）。`>:scope > div > section` 只命中
     * 第二列（aside 是同级 <aside>，其内 section 是孙级）。
     */
    groupChannelTexts() {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return []
      const col = panel.querySelector(':scope > div > section')
      if (!col) return []
      return Array.from(col.querySelectorAll('button'))
        .map((b) => (b.innerText || '').trim())
        .filter((t) => t && t.length <= 80)
    },
    clickChannelByText(text) {
      const panel = document.querySelector('[data-testid="tg-panel-root"]')
      if (!panel) return false
      const col = panel.querySelector(':scope > div > section')
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
  await waitForAppMount(page)
  await page.evaluate(INSTALL_HELPERS)
}

/**
 * 等应用**真正挂载**（`nav-files` 出现 = shell 已渲染）。
 *
 * 为什么不能只靠 goto 内部的 `#root` 子节点等待：加载态/半挂载同样往 #root
 * 里渲染节点，会把「壳有了」误判成「应用好了」。2026-10-22 实证：并发提交
 * （大批 shell 改动）后探针首跑，vite 冷转换把真实挂载甩到 openItemsView 的
 * 25s 窗口外 ⇒ FATAL；同一序列 warm 后 3-7s 全过。挂载等待不属于任何判据，
 * 只是保证判据有页面可跑；超时报错带 readyState / body 片段 / 页面错误，
 * 不把「冷加载」和「产品真挂了」混成同一个无信息超时。
 */
async function waitForAppMount(page, timeoutMs = 90000) {
  try {
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-files"]'), {
      timeout: timeoutMs,
      intervalMs: 300,
    })
  } catch (_e) {
    const st = await page.evaluate(() => ({
      ready: document.readyState,
      root: (document.querySelector('#root') || { childElementCount: -1 }).childElementCount,
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    }))
    throw new Error(
      `app did not mount within ${timeoutMs}ms (ready=${st.ready} rootChildren=${st.root} ` +
        `body="${st.body}") pageErrors=${JSON.stringify(page.pageErrors().slice(0, 3))}`,
    )
  }
}

/**
 * 打开文件域条目视图的**卡片网格**。
 *
 * BUG-299（2026-10-15 用户裁定）起 cat-all 渲染的是 FileListView **行**，
 * media-card 网格只在**分类 tab** 渲染 —— 旧探针只点 nav-files 落 cat-all，
 * 永远等不到 media-card（2026-10-22 实证 FATAL：探针腐烂，非产品回归）。
 * 故显式进分类 tab：`cat='video'`（夹具锚点是 video）/ `'image'`（负样本
 * 本地条目是 photo ⇒ image 档）。
 */
async function openItemsView(page, cat = 'video') {
  await waitForAppMount(page)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-files"]')
    if (el) el.click()
  })
  // 分类子项只在文件树展开态渲染；折叠态先开展（ Chevron 恒在）。
  await page.evaluate(() => {
    if (!document.querySelector('[data-testid="nav-child-cat-video"]') &&
        !document.querySelector('[data-testid="nav-child-image"]')) {
      const chevron = document.querySelector('[data-testid="files-chevron"]')
      if (chevron) chevron.click()
    }
  })
  const testid = cat === 'video' ? 'nav-child-cat-video' : `nav-child-${cat}`
  await page.waitForFunction((t) => !!document.querySelector(`[data-testid="${t}"]`), {
    timeout: 15000,
    args: [testid],
  })
  await page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (el) el.click()
  }, testid)
  try {
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-search-input"]'), {
      timeout: 25000,
    })
  } catch (_e) {
    const st = await page.evaluate(() => ({
      navFiles: !!document.querySelector('[data-testid="nav-files"]'),
      body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    }))
    throw new Error(
      `media-search-input did not appear within 25s after clicking ${testid} ` +
        `(navFiles=${st.navFiles} body="${st.body}") ` +
        `pageErrors=${JSON.stringify(page.pageErrors().slice(0, 3))}`,
    )
  }
  await delay(700)
}

/**
 * 打开 cat-all **文件行**视图（BUG-385 起「在 TG 中查看」的行级入口面；
 * BUG-307 锁后 items 网格不承载 TG 跳转 ⇒ 条目级判据的现行落点）。
 * 搜索框在 items 视图恒渲染，cat-all 行集 = `items`（含 q 过滤）⇒ 可搜。
 */
async function openCatAllRows(page) {
  await waitForAppMount(page)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-files"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="file-list-row"]'), {
    timeout: 25000,
  })
  await delay(700)
}

/**
 * 在 cat-all 行列表里**滚动找到**指定条目行（有界，触底即停）。
 *
 * 为什么必须滚：cat-all 行集 = 搜索过滤后的媒体条目 ∪ **全部**下载成品行
 * （成品行当前不参与 q 过滤，BUG-386 已登记；按日期混排）⇒ 目标行可能落在
 * 虚拟窗口（视口 ± overscan）之外，纯 waitForFunction 会假超时（2026-10-22 实证：
 * total=39，254 在第 ~20 位、scrollTop=603 处）。
 */
async function scrollToFileRow(page, itemId, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const found = await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="file-list-row"][data-item-id="${id}"]`)
      if (row) {
        row.scrollIntoView({ block: 'center' })
        return true
      }
      const scroller = document.querySelector('[data-testid="file-list-scroll"]')
      if (!scroller) return false
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      if (atBottom) {
        // 触底后最后一批行可能刚渲染：再给一拍，仍没有才算真没有
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(!!document.querySelector(`[data-testid="file-list-row"][data-item-id="${id}"]`))
          }, 400)
        })
      }
      scroller.scrollTop += 600
      return false
    }, itemId)
    if (found) return true
    await delay(150)
  }
  return false
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
  // 「频道 · 来源」节**默认折叠**（channelOpen=false）⇒ 组行（全部订阅…）
  // 不渲染。先幂等展开（aria-expanded=false 才点），否则 asideButtonByText
  // 找不到「全部订阅」而 Loud FAIL（2026-10-22 实证的探针腐烂点）。
  await page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="channel-collapse-toggle"]')
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click()
  })
  await delay(400)
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

/**
 * BUG-364 supersede 复跑夹具（模块级：main 与 .catch 的清理都要用）。
 *
 * 为什么需要夹具：2026-10-21 实测库态里**没有**同时满足选靶三条件的条目——
 * 监控缓存窗口内的剧集条目全是 BUG-362 兜底标题（展示层 fill-empty、不入库
 * 不可搜），可搜的又都在缓存窗口外。夹具 = TG 源登记 + 无 caption 的 video
 * 消息锚点 + 唯一可搜标题 + **引擎缓存补真字节**（UI 搜索与 deriveSearchTerm
 * 都过 hasBytes 门，无字节夹具不可见）；BUG-304「导入即成剧」自动给它建剧集。
 *
 * 清理策略（精确制导，不用基线差分）：只删「装着夹具条目」的剧集 + 夹具
 * 条目本身 + 探针自己入队的缓存任务记录 + 落盘字节 —— 并发写者的在飞夹具
 * 可能同窗口新建，基线差分会误删别人的东西；requeue 复用的旧任务行是既有
 * 产品状态，同样不删（ownRecord 标记区分）。
 */
let fixture = null
let epRef = null
let fixtureCache = null

async function cleanupFixture(ep) {
  if (!fixture) return ['fixture was never created']
  const problems = []
  // ① 落盘字节：只删字节、记录保留（422 = 已无可清；404 = 条目已没了）。
  //    不做的话 C1 的「残留=0」只覆盖了库内行，磁盘上还留着探针下载的视频。
  const cb = await httpJson('DELETE', `${ep.tg}/api/cache/items/${fixture.itemId}`)
  if (cb.status >= 300 && cb.status !== 422 && cb.status !== 404) {
    problems.push(`cache item clear -> ${cb.status}`)
  }
  // ② 缓存任务记录：仅删探针自己新建的那行（ownRecord）。删除端点任何状态
  //    可删（内部先置 cancelled 再删行），不会把 worker 留在悬空 id 上。
  if (fixtureCache && fixtureCache.ownRecord && typeof fixtureCache.taskId === 'number') {
    const dt = await httpJson('DELETE', `${ep.tg}/api/cache/tasks/${fixtureCache.taskId}`)
    if (dt.status >= 300 && dt.status !== 404) problems.push(`cache task delete -> ${dt.status}`)
    try {
      const byItem = await apiGet(
        ep.tg,
        `/api/tg/cache/tasks/by-item?refs=${encodeURIComponent(fixture.ref)}`,
      )
      if (byItem && byItem.tasks && byItem.tasks[fixture.ref]) {
        problems.push('cache task record still present after delete')
      }
    } catch (_e) {
      /* 查询失败不篡夺删除结果的事实，交由上面状态码判据 */
    }
  }
  const seriesList = await apiGet(ep.tg, '/api/media/series?limit=500')
  for (const s of seriesList.items || []) {
    const sd = await apiGet(ep.tg, `/api/media/series/${s.id}`)
    if ((sd.episodes || []).some((e) => e.itemId === fixture.itemId)) {
      const d = await httpJson('DELETE', `${ep.tg}/api/media/series/${s.id}`)
      if (d.status >= 300) problems.push(`series ${s.id} delete -> ${d.status}`)
    }
  }
  const di = await httpJson('DELETE', `${ep.tg}/api/media/items/${fixture.itemId}`)
  if (di.status >= 300 && di.status !== 404) problems.push(`item delete -> ${di.status}`)
  try {
    await apiGet(ep.tg, `/api/media/items/${fixture.itemId}`)
    problems.push('fixture item still readable after delete')
  } catch (_e) {
    /* 404 = 删净 */
  }
  // ③ 磁盘真值：清字节/删条目都会在引用归零时 unlink——直接 stat 落点，
  //    不靠「API 说 200」推断字节没了（取不到 ≠ 没有，真值只有一个）。
  if (fixtureCache && fixtureCache.absolutePath) {
    if (fs.existsSync(fixtureCache.absolutePath)) {
      problems.push(`fixture bytes still on disk: ${fixtureCache.absolutePath}`)
    }
  }
  return problems
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  epRef = ep
  console.log(`[bug305] app=${ep.app} tg=${ep.tg} out=${OUT}`)

  const zh = JSON.parse(fs.readFileSync(LOCALE_ZH, 'utf8'))
  const en = JSON.parse(fs.readFileSync(LOCALE_EN, 'utf8'))
  const L = {
    viewInTgZh: zh['media.viewInTg'],
    viewInTgEn: en['media.viewInTg'],
    epViewInTgZh: zh['media.episode.openInBrowser'],
    epViewInTgEn: en['media.episode.openInBrowser'],
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

  // ── 夹具：库态无「剧集+可达+可搜」三元目标时自造自删（BUG-364 复跑）──
  // 锚点选**各监控频道第一页的无 caption video 消息**：第一页 = 深度 1 必然
  // 可达；无 caption 是因为服务端「以流水 caption 为准」（import_media_items），
  // 有 caption 会覆盖夹具标题 ⇒ 不可搜。非相册消息（无 groupId）优先：单条
  // 缓存语义最干净，不牵动组内其它消息。标题用『〖B』开头：全库唯一，搜索
  // 一词命中且只命中它（2026-10-21 实测 total=1）。
  const itemsBefore = await listAllItems(ep.tg)
  const refsBefore = new Set(itemsBefore.map((i) => i.ref))
  const anchors = []
  for (const c of monitored) {
    const r = await apiGet(ep.tg, `/api/tg/monitor/messages?channelId=${c.channelId}&limit=30`)
    for (const m of r.items || []) {
      if (m.type !== 'video') continue
      if (m.caption && m.caption.trim()) continue
      const ref = `${c.channelId}:${m.messageId}`
      if (refsBefore.has(ref)) continue
      anchors.push({
        ref,
        chatId: c.channelId,
        messageId: m.messageId,
        grouped: !!m.groupId,
        size: typeof m.size === 'number' ? m.size : Number.MAX_SAFE_INTEGER,
      })
    }
  }
  if (anchors.length === 0) {
    fatal('fixture: no caption-less video message on any monitored channel first page')
  }
  // 非相册优先（单条缓存语义最干净）；同级按体积小优先——夹具要真下载字节，
  // 撞上超大视频会把轮询窗口拖爆（那是选靶失误，不是产品回归）。
  anchors.sort((x, y) => Number(x.grouped) - Number(y.grouped) || x.size - y.size)
  const fixtureTitle = '〖BUG305〗夹具靶点'
  let created = null
  for (const a of anchors.slice(0, 5)) {
    // 竞态再确认：listing 与建条目之间，并发写者可能已占同一 ref ——
    // POST 是 (source,ref) upsert，会**覆盖**别人的标题，必须先查再建。
    const pre2 = await apiGet(
      ep.tg,
      `/api/media/items/by-ref?source=tg&ref=${encodeURIComponent(a.ref)}`,
    )
    if (pre2 && typeof pre2.id === 'number') continue
    const res = await httpJson('POST', `${ep.tg}/api/media/items`, {
      items: [{ source: 'tg', ref: a.ref, kind: 'video', title: fixtureTitle }],
    })
    const id = res.json && Array.isArray(res.json.ids) ? res.json.ids[0] : null
    if (!id) fatal(`fixture item create failed: ${res.status}/${res.text.slice(0, 120)}`)
    let back = null
    try {
      back = await apiGet(ep.tg, `/api/media/items/${id}`)
    } catch (e) {
      // 别把半成品留在库里（读回失败也要删）
      await httpJson('DELETE', `${ep.tg}/api/media/items/${id}`)
      throw e
    }
    if (String((back && back.title) || '') !== fixtureTitle) {
      // 消息其实有 caption，标题被服务端覆盖 —— 删掉换下一个锚点
      await httpJson('DELETE', `${ep.tg}/api/media/items/${id}`)
      continue
    }
    // 先落账再补字节：此后任何一步 fatal（无剧集 / 缓存失败 / 轮询超时），
    // .catch 的 cleanupFixture 都知道要删什么——夹具生命周期对 FATAL 路径
    // 同样封闭，不会「建到一半躺库里」。
    fixture = { itemId: id, ref: a.ref, chatId: a.chatId, messageId: a.messageId, title: fixtureTitle }
    if (typeof back.seriesId !== 'number') {
      fatal(
        `fixture item ${id} has no series (BUG-304 auto-filing missing) — ` +
          'series-level criteria would be vacuous',
      )
    }
    // 补真字节（UI 搜索与 deriveSearchTerm 的 hasBytes 门都要求它）；
    // 内部自行维护 fixtureCache（含 FATAL 路径可清的任务行落账）。
    await cacheAnchorForBytes(ep, a, id)
    created = { itemId: id, ...a }
    break
  }
  if (!created) fatal('fixture: every anchor produced a caption-overridden title')
  fixture = { ...created, title: fixtureTitle }

  const items = await listAllItems(ep.tg)
  const fixtureItem = items.find((i) => i.id === fixture.itemId) || null
  if (!fixtureItem) {
    fatal(`fixture item ${fixture.itemId} vanished from the listing right after creation`)
  }
  if (fixtureItem.bytesPresence !== 'present') {
    // 缓存轮询说 present 这里却说没有 ⇒ 探测口径不一致，必须当场红灯，
    // 绝不能带着「其实不可搜」的夹具往下跑（搜索框判据会变成假绿）。
    fatal(
      `fixture item ${fixture.itemId} has no bytes in listing ` +
        `(bytesPresence=${fixtureItem.bytesPresence}) — cacheAnchorForBytes lied`,
    )
  }
  // 夹具已补真字节 ⇒ 它本身就过 hasBytes 门，会出现在自然候选里；置顶前
  // 先去重，避免同一 id 两颗候选（选靶结果仍对，但 candidates=N 读数会虚）。
  // 其余候选仍按「有字节」过滤：无字节条目在 UI 成品列表里不可见，
  // 拿它当判据对象 = 等一张永远不会出现的卡片。
  const tgCandidates = items
    .filter((i) => i.source === 'tg' && i.bytesPresence === 'present' && i.id !== fixture.itemId)
    .map((i) => ({ item: i, at: parseRef(i.ref) }))
    .filter((x) => x.at && monSet.has(x.at.chatId))
  tgCandidates.unshift({ item: fixtureItem, at: parseRef(fixtureItem.ref) })
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
  let itemTerm = null
  // 可达窗口 12 页（= helper 默认值）：监控缓存随新消息增长，旧消息自然变深——
  // 2026-10-21 实测全部剧集候选已沉到 6 页外（目标 4837 深度=7），
  // 调用方原先写死 6 页会把这个探针永远 FATAL 在选靶上（库态增长的非产品回归）。
  // 12 页仍远小于产品定位循环的 LOCATE_MAX_PAGES=20，选靶余量不变紧。
  // 选靶三条件缺一不可（缺任一即该类判据空转，按本探针反假绿设计 FATAL）：
  //   ① 属于剧集（剧集级判据的对象）；
  //   ② 监控流可达（定位判据的对象）；
  //   ③ 标题可派生搜索词（搜索框判据的对象）——BUG-362 起兜底标题
  //      （`未命名视频 #1574`）是展示层 fill-empty、不入库不可搜，而候选按
  //      newest-first 排，头条目经常正是它；不把③纳入选靶就会 FATAL 在
  //      deriveSearchTerm 上（2026-10-21 实测即此）。
  for (const cand of ordered) {
    if (typeof cand.item.seriesId !== 'number') continue
    const r = await monitorMessageReachable(ep.tg, cand.at.chatId, cand.at.messageId, 12)
    if (!r.found) continue
    const term = await deriveSearchTerm(ep.tg, cand.item)
    if (!term) continue
    picked = cand
    reach = r
    itemTerm = term
    break
  }
  if (!picked) {
    fatal(
      'no reachable tg item from a monitored channel that belongs to a series ' +
        `and has a searchable title (candidates=${tgCandidates.length}). ` +
        'A target that cannot be located would make criterion 1 vacuous — ' +
        'refusing to report a skip as a pass.',
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

  // itemTerm 已在选靶循环里派生（选靶条件③）——target 不可搜根本进不来。
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
    // cat-all 行级门控用**全标题**：短前缀在「全部文件」全类目下命中数超分页
    // （PAGE=60，虚拟列表只渲染视口行）⇒ 目标行被挤出已加载页，等到超时。
    // 全标题唯一命中 ⇒ 行必在第一页（2026-10-22 实证修法）。
    localItemFullTitle: String(localItem.title || ''),
    localSeriesId: localSeries.id,
    navAllLabel: L.navAllZh,
  }
  console.log(
    `[bug305] target: item=${ctx.itemId} series=${ctx.seriesId} ref=${picked.item.ref} key=${ctx.expectedKey}`,
  )

  // i18n 键（两个 locale 都要有，新文案不许硬编码）
  const i18nKeys = ['media.viewInTg', 'media.episode.openInBrowser', 'tg.locateFailed', 'tg.locateNoChannel']
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
    // 入口面以 **BUG-307 设计锁**（2026-10-14 用户拍板）为准：「视频 = 通用类，
    // TG 跳转 = 剧集链路专有 ⇒ items 网格 MediaCard 不烤 onViewInTg」。
    // 旧判据「卡片有入口」随该锁失效（探针腐烂，2026-10-22 修）；现行入口面 =
    // cat-all 文件行（BUG-385）+ 剧集链路（SeriesDetail 来源块）。
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
    await page.screenshot(path.join(OUT, '1_media_grid_no_entry_bug307.png'))
    check(
      '判据4a（BUG-307 锁）items 网格卡片不烤入 TG 入口（视频=通用类，反向证伪旧判据）',
      tgCardEntry.cards >= 1 && tgCardEntry.entry === null,
      `cards=${tgCardEntry.cards} entry=${JSON.stringify(tgCardEntry.entry)}`,
    )

    // 现行入口面：cat-all 文件行（BUG-385）——有坐标才渲染
    await openCatAllRows(page)
    await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
    const tgRowFound = await scrollToFileRow(page, ctx.itemId)
    await delay(500)
    const tgRowEntry = await page.evaluate(
      (id) => ({
        rows: window.__b305.present('[data-testid="file-list-row"]'),
        entry: window.__b305.entryInfo(
          `[data-testid="file-list-row"][data-item-id="${id}"] [data-testid^="file-list-view-tg-"]`,
        ),
      }),
      ctx.itemId,
    )
    await page.screenshot(path.join(OUT, '1_media_library_row_entry.png'))
    check(
      '判据4b（BUG-385 现行面）TG 来源文件行渲染「在 TG 中查看」入口（有坐标就给入口）',
      tgRowFound && tgRowEntry.rows >= 1 && tgRowEntry.entry !== null && tgRowEntry.entry.tag === 'BUTTON',
      `rowFound=${tgRowFound} rows=${tgRowEntry.rows} entry=${JSON.stringify(tgRowEntry.entry)}`,
    )
    check(
      '判据4b 入口文案走 i18n（zh-CN = 在 TG 中查看）',
      tgRowEntry.entry !== null && tgRowEntry.entry.text === L.viewInTgZh,
      `text=${tgRowEntry.entry && tgRowEntry.entry.text}`,
    )
    check(
      '判据2 应用内入口是 button（无 href / target，本身不离开应用）',
      tgRowEntry.entry !== null &&
        tgRowEntry.entry.tag === 'BUTTON' &&
        !tgRowEntry.entry.href &&
        !tgRowEntry.entry.target,
      `entry=${JSON.stringify(tgRowEntry.entry)}`,
    )

    // 负样本是本地 **photo** ⇒ 切 image 档再搜（video 档里永远看不到它）
    await openItemsView(page, 'image')
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
      '判据4 本地来源条目卡片不渲染入口（BUG-307 锁下网格恒无入口，反向佐证）',
      localCard.cards >= 1 && localCard.entries === 0,
      `cards=${localCard.cards} cardEntries=${localCard.entries} anyEntry=${localCard.anyEntry}`,
    )

    // 坐标门控的真判据面（BUG-385）：本地来源的 cat-all **行**同样不渲染入口
    await openCatAllRows(page)
    await page.evaluate(
      (t) => window.__b305.setInput('[data-testid="media-search-input"]', t),
      ctx.localItemFullTitle,
    )
    const localRowFound = await scrollToFileRow(page, ctx.localItemId)
    await delay(500)
    const localRow = await page.evaluate(
      (id) => ({
        rows: window.__b305.present('[data-testid="file-list-row"]'),
        entries: window.__b305.present(
          `[data-testid="file-list-row"][data-item-id="${id}"] [data-testid^="file-list-view-tg-"]`,
        ),
        anyEntry: window.__b305.present('[data-testid^="file-list-view-tg-"]'),
      }),
      ctx.localItemId,
    )
    check(
      '判据4c（BUG-385 门控）本地来源文件行不渲染入口（无坐标可跳）',
      localRowFound && localRow.rows >= 1 && localRow.entries === 0,
      `rowFound=${localRowFound} rows=${localRow.rows} rowEntries=${localRow.entries} anyEntry=${localRow.anyEntry}`,
    )

    // ── 判据 1/2/7（条目级跳转）──
    await page.evaluate(() => window.__b305.click('[data-testid="nav-tg"]'))
    const otherChannelId = await preswitchOtherChannel(page, ctx)
    check(
      '判据1（牙）跳转前频道已被预切到非目标频道（频道断言非空转）',
      otherChannelId !== String(ctx.targetChatId),
      `preswitched=${otherChannelId} target=${ctx.targetChatId}`,
    )
    // 条目级跳转的现行入口 = cat-all 文件行（BUG-385；items 网格按 BUG-307 锁不承载）
    await openCatAllRows(page)
    await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
    const jumpRowFound = await scrollToFileRow(page, ctx.itemId)
    await delay(400)
    const itemRes = await clickEntryAndAwaitLocate(
      page,
      ctx,
      `[data-testid="file-list-row"][data-item-id="${ctx.itemId}"] [data-testid^="file-list-view-tg-"]`,
    )
    await page.screenshot(path.join(OUT, '2_item_jump_located.png'))
    check(
      '判据1 条目级：入口可点且定位到目标消息',
      jumpRowFound && itemRes.clicked === true && itemRes.key === ctx.expectedKey,
      `rowFound=${jumpRowFound} clicked=${itemRes.clicked} key=${itemRes.key} expected=${ctx.expectedKey}`,
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
      // BUG-364：行级入口已撤销（supersede 判据3 原「列表行也有入口」）——
      // 应用内跳转收敛为来源块一颗；本地剧集同样为 0。
      '判据3 BUG-364：剧集列表行不再渲染行级入口（episode-row-view-tg = 0，已撤销）',
      tgSeriesDom.row === null,
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
      await openCatAllRows(enPage)
      await enPage.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
      const enRowFound = await scrollToFileRow(enPage, ctx.itemId)
      await delay(500)
      const enEntry = await enPage.evaluate(
        (id) =>
          window.__b305.entryInfo(
            `[data-testid="file-list-row"][data-item-id="${id}"] [data-testid^="file-list-view-tg-"]`,
          ),
        ctx.itemId,
      )
      await enPage.screenshot(path.join(OUT, '6_en_us_entry.png'))
      check(
        'i18n en-US 会话入口文案 === "View in TG"（非中文硬编码）',
        enRowFound && enEntry !== null && enEntry.text === L.viewInTgEn,
        `rowFound=${enRowFound} entry=${JSON.stringify(enEntry)}`,
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
        await waitForAppMount(page)
        await page.evaluate(INSTALL_HELPERS)
        await openCatAllRows(page)
        await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
        const redRowFound = await scrollToFileRow(page, ctx.itemId)
        await delay(400)
        const redEntry = await page.evaluate(
          (id) =>
            window.__b305.entryInfo(
              `[data-testid="file-list-row"][data-item-id="${id}"] [data-testid^="file-list-view-tg-"]`,
            ),
          ctx.itemId,
        )
        check(
          '④a 红态：入口仍在且可点（证明红的不是「按钮没了」）',
          redRowFound && redEntry !== null && redEntry.tag === 'BUTTON',
          `rowFound=${redRowFound} entry=${JSON.stringify(redEntry)}`,
        )
        const redRes = await clickEntryAndAwaitLocate(
          page,
          ctx,
          `[data-testid="file-list-row"][data-item-id="${ctx.itemId}"] [data-testid^="file-list-view-tg-"]`,
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
      await waitForAppMount(page)
      await page.evaluate(INSTALL_HELPERS)
      await openCatAllRows(page)
      await page.evaluate((t) => window.__b305.setInput('[data-testid="media-search-input"]', t), ctx.itemTerm)
      const greenRowFound = await scrollToFileRow(page, ctx.itemId)
      await delay(400)
      const greenRes = await clickEntryAndAwaitLocate(
        page,
        ctx,
        `[data-testid="file-list-row"][data-item-id="${ctx.itemId}"] [data-testid^="file-list-view-tg-"]`,
      )
      await page.screenshot(path.join(OUT, '8_restore_green.png'))
      check(
        '④f 还原后复跑：条目级跳转重新定位到目标消息并高亮',
        greenRowFound &&
          greenRes.key === ctx.expectedKey &&
          greenRes.after.channelId === String(ctx.targetChatId) &&
          greenRes.after.highlightedKey === 'true',
        `rowFound=${greenRowFound} key=${greenRes.key} channel=${greenRes.after.channelId} highlight=${greenRes.after.highlightedKey}`,
      )
    }
  } finally {
    if (browser) await browser.close()
  }

  // ── 夹具清理（C1：残留 = 0）——全部判据跑完才删，falsification 复跑也用得到 ──
  const cleanupProblems = await cleanupFixture(ep)
  check(
    'C1 夹具残留 = 0（条目 + 装着它的剧集 + 探针入队的缓存任务记录 + 落盘字节，复查 404 / 不存在）',
    cleanupProblems.length === 0,
    cleanupProblems.join(' | ') ||
      `item=${fixture ? fixture.itemId : '-'} ref=${fixture ? fixture.ref : '-'} ` +
        `task=${fixtureCache && fixtureCache.taskId !== null ? fixtureCache.taskId : '-'} deleted`,
  )

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
          fixture: fixture ? { itemId: fixture.itemId, ref: fixture.ref } : null,
          fixtureCache: fixtureCache
            ? {
                taskId: fixtureCache.taskId,
                ownRecord: fixtureCache.ownRecord,
                bytesPath: fixtureCache.absolutePath,
              }
            : null,
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

main().catch(async (e) => {
  console.error('FATAL', (e && e.stack) || e)
  // fatal() 改 throw 后，夹具清理在这条路上也要跑（否则 FATAL 即泄漏）
  if (fixture && epRef) {
    try {
      const problems = await cleanupFixture(epRef)
      if (problems.length) console.error('[bug305] fixture cleanup problems:', problems.join(' | '))
      else console.error(`[bug305] fixture cleaned on fatal path: item=${fixture.itemId}`)
    } catch (_e) {
      console.error('[bug305] fixture cleanup failed:', String((_e && _e.message) || _e))
    }
  }
  process.exit(2)
})
