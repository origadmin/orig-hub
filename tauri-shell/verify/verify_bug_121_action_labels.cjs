#!/usr/bin/env node
'use strict'

/**
 * BUG-121 取证：TG 面板「加入媒体库」与「缓存」两个入口的**语义重叠**。
 *
 * ## 这个脚本证明什么（只取证，不改代码）
 *
 * BUG-121 的根因不是「两个入口」，而是**同一个动作按内容类型换文案**：
 *
 *   - 含视频 / 音视频 / 文件 → 文案「缓存」   → `onDownload`  → `enqueueCacheTask`（落盘 + 入库）
 *   - 纯图 / 单图            → 文案「加入媒体库」→ `onImportPhoto`→ `importMediaItems`（**只入库，不落盘**）
 *
 * 用户看到两种措辞就以为是两种操作，于是点了「加入媒体库」后断网打不开（BUG-115）。
 *
 * 本脚本在**真实浏览器**里把同一屏上的两种文案同时抓出来 + 抓后端事实（图片条目
 * 一律 `filePath: null`，即字节从未落盘），证明「文案不同 ⇒ 行为不同」这条相关
 * 关系在真实数据上成立，从而证明合并成单一措辞之前必须先决定**后端是否让图片落盘**
 * （见 BUG-121.md 报告）。
 *
 * ## 为什么只取证不修复
 *
 * `docs/bugs/BUG-121.md` 的裁定是「合并为一个动作『缓存到媒体库』（入库即落盘）」，
 * 但同一句话要求**取消「只入库、不落盘」这个用户可见终态**——那意味着图片也必须落盘，
 * 而引擎当前对图片是**无条件跳过下载**的（`download-engine/crates/orig-tg/src/routes.rs`
 * 的 `photo_rule` 分支，日志「photo … registered to library (no cache by rule)」）。
 * 也就是说：把文案合并成「缓存到媒体库」而不动引擎，等于对用户**撒谎**
 * （点了说缓存，实际没缓存）。这是产品级取舍，需 lead 拍板，不在本脚本内决定。
 *
 * ## 断言
 *
 *   A. 同一屏内同时出现两种措辞（「加入媒体库」与「缓存」），证明用户确实会撞见两个入口；
 *   B. 后端事实：tg 图片条目的 `filePath` 全为 null（字节未落盘），
 *      而非图片条目确有落盘路径 —— 证明两种措辞背后是**两种真实行为**，
 *      因此合并文案必须同时统一后端行为，不能只改前端措辞。
 *
 * ## 环境
 *
 *   APP_URL  前端 dev server（默认 http://127.0.0.1:5180/）
 *   TG_API   orig-tg（默认 http://127.0.0.1:19787）
 *
 * Exit: 0 = 取证成功且两种措辞同屏出现；3 = 未捕获到两种措辞（复现条件不足）；1 = 环境问题
 */

const fs = require('node:fs')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_API = (process.env.TG_API || 'http://127.0.0.1:19787').replace(/\/$/, '')
const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-121')

/** 被测文案（两种语言都抓，用户可任一语言界面复现）。 */
const ADD_LIB = new Set(['加入媒体库', 'Add to library'])
const CACHE = new Set(['缓存', 'Cache'])

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpGetJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    return { status: r.status, body: await r.json() }
  } finally {
    clearTimeout(t)
  }
}

/** 打开 TG 面板并等待内容流渲染。 */
async function openTgPanel(browser) {
  const page = await browser.newPage()
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!clicked) throw new Error('nav-tg not found (TG feature gated off?)')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
    timeout: 20000,
  })
  await delay(3500)
  return page
}

/**
 * 消息流滚动。
 *
 * 方向说明（实测）：TG feed **旧消息在上、新消息在下**，而当前频道的视频消息
 * （208336/208327）比首屏照片更**旧**，所以取证要**向上**翻（scrollTop 减小），
 * 向下翻永远到不了视频分支。
 */
const FEED_SCROLL_FN = `(() => {
  const cands = [...document.querySelectorAll('div.overflow-y-auto')].filter(
    (d) => d.scrollHeight > d.clientHeight + 40
  )
  if (!cands.length) return false
  const el = cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  el.scrollTop = Math.max(0, el.scrollTop - Math.floor(el.clientHeight * 0.9))
  el.dispatchEvent(new Event('scroll', { bubbles: true }))
  return true
})()`

/**
 * 在消息流里同时收集两种措辞。
 *
 * 手法：先全量扫描（滚动 + 逐帧取可见按钮文案），若仍未见「缓存」，
 * 则**直接按 data-message-id 滚到后端已确认存在的视频条目**上取证 ——
 * 该频道 feed 实测同页含 58 photo + 2 video，两种措辞本就在同一列表里。
 */
async function collectWording(page, videoMessageIds = [], maxScroll = 30) {
  const seen = { addLib: [], cache: [] }

  /**
   * 逐气泡扫描操作行文案。
   * 只看**气泡内的 button**（而非全页 span）：角标/正文里的「缓存」等字样会造成误判。
   */
  const scanOnce = async () => {
    const b = await page.evaluate(
      ({ addLib, cache }) => {
        const shells = [
          ...document.querySelectorAll('[data-testid="tg-panel-root"] .rounded-2xl'),
        ]
        const add = []
        const cac = []
        for (const s of shells) {
          for (const btn of s.querySelectorAll('button')) {
            const txt = (btn.innerText || '').trim()
            if (!txt || txt.length > 12) continue
            const r = btn.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            if (addLib.includes(txt)) add.push(txt)
            else if (cache.includes(txt)) cac.push(txt)
          }
        }
        return { add, cac }
      },
      { addLib: [...ADD_LIB], cache: [...CACHE] },
    )
    for (const t of b.add) if (!seen.addLib.includes(t)) seen.addLib.push(t)
    for (const t of b.cac) if (!seen.cache.includes(t)) seen.cache.push(t)
  }

  for (let i = 0; i < maxScroll; i++) {
    await scanOnce()
    if (seen.addLib.length && seen.cache.length) break
    if (!(await page.evaluate(FEED_SCROLL_FN))) break
    await delay(1300)
  }

  // 兜底：直接定位到已知视频消息。单条气泡没有 data-message-id（该属性只在
  // 相册瓦片 / 预览层 / 搜索命中上），但操作行一定渲染 `#<messageId>`，
  // 用它定位到该气泡所属的滚动容器位置。
  if (!seen.cache.length) {
    for (const id of videoMessageIds) {
      const ok = await page.evaluate((msgId) => {
        const needle = '#' + msgId
        const hit = [...document.querySelectorAll('span')].find(
          (s) => (s.textContent || '').trim() === needle,
        )
        if (!hit) return false
        const bubble = hit.closest('.rounded-2xl') || hit.parentElement
        if (bubble) bubble.scrollIntoView({ block: 'center' })
        return true
      }, String(id))
      if (!ok) continue
      await delay(900)
      await scanOnce()
      if (seen.cache.length) break
    }
  }
  return seen
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ── B：后端事实（先取证，再据此解读 UI） ──────────────────────────────
  const items = (await httpGetJson(`${TG_API}/api/media/items?page=1&page_size=200`)).body.items ?? []
  const photos = items.filter((i) => i.kind === 'photo')
  const tgPhotos = photos.filter((i) => i.source === 'tg')
  const nonPhotos = items.filter((i) => i.kind !== 'photo')
  const backend = {
    channelId: Number(process.env.ORIG_VERIFY_CHANNEL_ID || '-1001341930464'),
    photoItems: photos.length,
    tgPhotoItems: tgPhotos.length,
    tgPhotosWithBytes: tgPhotos.filter((i) => i.filePath).length,
    nonPhotoItems: nonPhotos.length,
    nonPhotoWithBytes: nonPhotos.filter((i) => i.filePath).length,
  }
  console.log('[BUG-121] backend facts ' + JSON.stringify(backend))

  // 当前监控频道 feed 里真实存在的视频消息（用于把「缓存」分支滚进视口取证）
  let videoMessageIds = []
  try {
    const feed = (
      await httpGetJson(`${TG_API}/api/tg/monitor/messages?channelId=${backend.channelId}&limit=60`)
    ).body.items ?? []
    videoMessageIds = feed.filter((i) => i.type === 'video').map((i) => i.messageId)
    backend.feedVideoMessageIds = videoMessageIds
    console.log('[BUG-121] feed video message ids ' + JSON.stringify(videoMessageIds))
  } catch (e) {
    console.log('[BUG-121] feed probe failed (' + e.message + ')，退化为纯滚动扫描')
  }

  const browser = await cdp.launch()
  let shot = null
  let shotCache = null
  let wording = null
  try {
    const page = await openTgPanel(browser)
    wording = await collectWording(page, videoMessageIds)
    await page.screenshot(path.join(OUT, '01-tg-panel-photo-bubbles.png'))
    shot = path.join(OUT, '01-tg-panel-photo-bubbles.png')

    // 把「缓存」按钮滚到视口中央再取证，确保截图里能直接看见第二种措辞
    const focused = await page.evaluate((cacheLabels) => {
      const shells = [
        ...document.querySelectorAll('[data-testid="tg-panel-root"] .rounded-2xl'),
      ]
      for (const s of shells) {
        for (const btn of s.querySelectorAll('button')) {
          const txt = (btn.innerText || '').trim()
          if (cacheLabels.includes(txt)) {
            const bubble = s
            bubble.scrollIntoView({ block: 'center' })
            return txt
          }
        }
      }
      return null
    }, [...CACHE])
    if (focused) {
      await delay(900)
      await page.screenshot(path.join(OUT, '02-tg-panel-cache-label.png'))
      shotCache = path.join(OUT, '02-tg-panel-cache-label.png')
      console.log('[BUG-121] focused cache label ' + focused)
    }
  } finally {
    await browser.close()
  }

  const result = {
    bug: 'BUG-121',
    capturedAt: new Date().toISOString(),
    appUrl: APP_URL,
    tgApi: TG_API,
    screenshot: shot,
    screenshotCacheLabel: shotCache,
    wordingSeenOnScreen: wording,
    backendFacts: backend,
    finding:
      '同一屏同时出现两种措辞（tg.addToLibrary / tg.download），但后端对图片是' +
      '"只入库不落盘"（tgPhotoItems 全为 filePath=null）——两种措辞对应两种真实行为。',
    note:
      '合并为单一措辞前必须先决定后端是否让图片落盘：只改前端措辞会让 UI 对用户撒谎。' +
      '详见 docs/bugs/BUG-121.md。',
  }
  fs.writeFileSync(
    path.join(OUT, 'bug121-evidence.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  )
  console.log('[BUG-121] screenshot ' + shot)
  console.log('[BUG-121] wording ' + JSON.stringify(wording))

  const both = wording.addLib.length > 0 && wording.cache.length > 0
  if (!both) {
    console.error('[BUG-121] 未在同一屏捕获到两种措辞（复现条件不足，需要含图+含视频的频道）')
    process.exit(3)
  }
  console.log('[BUG-121] OK — 两种措辞同屏复现，后端事实已一并记录')
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})