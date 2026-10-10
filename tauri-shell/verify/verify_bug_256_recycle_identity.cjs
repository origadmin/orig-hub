'use strict'

/*
 * BUG-256 验收：临时文件回收页签的信息架构 —— 收敛上半部分 + 明细行可辨识。
 *
 * ## 判据（docs/bugs/BUG-256.md「修复后必须满足」，全部 DOM 断言，本脚本亲眼量）
 *
 * 控件（正控，非判据）：弹窗真的开了、页签真的切了（流水线的 scope 行消失、
 * 回收清单真的有行）。控件失败一律 FATAL exit 1 —— 绝不把 0 当成功报数。
 *
 * 判据 1：「临时文件回收」页签下 `data-testid="cache-ingest-summary"` 在 DOM 中不存在。
 *   咬合：切页签**前**（流水线页签）该构件必须**在** —— 证明 testid 对、且是「跨页签常驻」
 *   这一件事被修掉了，而不是构件从来就没渲染过。
 * 判据 2：每行（textContent + 全部 [title] 悬浮属性）不出现任何匹配 /^[a-z]+--\d+_\d+/i
 *   的字符串（`doc--1004493170102_6896` 一类内部标识）。
 * 判据 3：每行至少给出「频道 + 消息号 + 类型」三项非空可辨识信息（空标题行也必须可辨识）。
 * 判据 4：四档按钮（全部/孤儿/陈旧/失败）、按频道选定 chips、勾选回收、确认条
 *   全部仍在**且可用** —— 勾选会更新计数、确认条会弹出且能取消（BUG-149 铁律：
 *   重构不是删能力的授权）。chips 按预览数据的频道分组数门控（单组时不渲染是设计）。
 *
 * ## 反向证伪（判据 5，在源码上做，不在本脚本内）
 *
 *   临时把 CacheBytesPanel.tsx 的 `isRawFileName(x.title)` 守卫短路成「恒不清洗」
 *   （vite dev 热更即时生效），重跑本脚本 ⇒ 判据 2 必须 FAIL（exit 非 0），然后装回。
 *   期望：正向 run exit 0；反向 run exit 非 0 且 FAIL 点恰为判据 2。
 *
 * ## 端点
 *
 * tg 端口由 `_lib_endpoints.cjs` 运行时解析（daemon /api/config 的 tg_port），
 * 绝不写死 —— 此前两次假红都是端口写死造成。预览接口只读（预览不产生任何删除）。
 *
 * 跑法：
 *   node verify/verify_bug_256_recycle_identity.cjs
 */

const path = require('node:path')
const http = require('node:http')
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const WAIT_MS = 30000
/** 与 BUG-256 文档取证口径一致：1920×1080。 */
const VIEW_W = 1920
const VIEW_H = 1080
/** 与媒体库/前端守卫逐字同源的判定正则（lib/tgmedia.ts isRawFileName）。 */
const RAW_RE = /^[a-z]+--\d+_\d+/i
/** 截图落点：verify/evidence/BUG-256/（随证据目录惯例不入库，路径登记进 BUG 文档）。 */
const SHOT_DIR = path.join(__dirname, 'evidence', 'BUG-256')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0

function check(ok, label, detail) {
  if (ok) {
    passed += 1
    console.log(`[verify] PASS - ${label}${detail ? ' :: ' + detail : ''}`)
  } else {
    failed += 1
    console.log(`[verify] FAIL - ${label}${detail ? ' :: ' + detail : ''}`)
  }
}

function fatal(msg) {
  console.error(`\n[verify] FATAL: ${msg}`)
  process.exit(1)
}

/** Node 侧 GET（不走系统代理），用于只读预览对数。 */
function httpGet(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
  })
}

/** 固定视口（CDP 库默认 1440x900）。 */
async function setViewport(page, w, h) {
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
}

/** 打开「入库流水线」弹窗（与 _probe_cache_dialog_geom.cjs 同一入口）。 */
async function openDialog(page, appUrl) {  await page.goto(appUrl, { waitForRoot: true, settleMs: 2500 })
  await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
  const nav = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-tg"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!nav) fatal('nav-tg not found (TG view entry missing)')
  await delay(1200)
  const opened = await page.evaluate(() => {
    const s = window.__origStore && window.__origStore.getState()
    if (!s || typeof s.setTgCacheManagerOpen !== 'function') return false
    s.setTgCacheManagerOpen(true)
    return true
  })
  if (!opened) fatal('window.__origStore.setTgCacheManagerOpen unavailable (dev build required)')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-manager"]'), {
    timeout: WAIT_MS,
  })
}

/**
 * 等行内读数稳定（连续两次采样一致且至少 1.5s）：行内「频道 + 消息号 + 类型」
 * 由 /api/media/items/:id 异步补齐（响应带 base64 封面，不小），先到先渲染。
 * @param {object} page CDP page
 * @param {number} maxMs 上限（默认 8s；超时按现状取证 —— 判据自会给出结论）
 */
async function waitForRowStable(page, maxMs = 8000) {
  const readAll = () =>
    page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="cache-bytes-row"]')
      let text = ''
      for (const r of rows) text += String(r.textContent || '') + '|'
      return { n: rows.length, text }
    })
  let prev = await readAll()
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await delay(750)
    const cur = await readAll()
    if (cur.n === prev.n && cur.text === prev.text && Date.now() - t0 >= 1500) return
    prev = cur
  }
}

async function main() {
  const ep = await endpoints.resolve()
  const appUrl = `${ep.app}/`
  console.log(`[verify] app=${appUrl} tg=${ep.tg}`)

  // ── 0. 只读预览对数：没有 inside 行就无法验证「行可辨识」，FATAL 而不是报 0。
  const prev = await httpGet(`${ep.tg}/api/cache/clear/preview?olderThanDays=30`)
  if (prev.status !== 200) fatal(`preview endpoint ${ep.tg} returned HTTP ${prev.status}`)
  const preview = JSON.parse(prev.body)
  const insideCount = (preview.items || []).filter((x) => x.inside).length
  const chatGroups = new Set((preview.items || []).filter((x) => x.inside).map((x) => x.chatId)).size
  console.log(
    `[verify] preview: total=${preview.total.count} inside=${insideCount} ` +
      `chats=${chatGroups} orphan=${preview.orphan.count} failed=${preview.failed.count}`,
  )
  if (insideCount === 0) {
    fatal('preview has 0 inside rows — 行可辨识判据没有靶子，拒绝在空清单上报成功')
  }

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await setViewport(page, VIEW_W, VIEW_H)
    await openDialog(page, appUrl)

    // ── 正控 A：流水线页签就绪，且统计条在该页签**在**（判据 1 的咬合半边） ──
    await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-scope-all"]'), {
      timeout: WAIT_MS,
    })
    const pipeSummary = await page.evaluate(
      () => !!document.querySelector('[data-testid="cache-ingest-summary"]'),
    )
    check(
      pipeSummary,
      'control: [cache-ingest-summary] IS present in the PIPELINE tab (testid is right; the fix is tab-scoping, not deletion)',
    )

    // ── 切到「临时文件回收」页签 ──
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="cache-tab-bytes"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!clicked) fatal('cache-tab-bytes button not found')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="cache-bytes-row"]').length > 0,
      { timeout: WAIT_MS },
    )
    // 行内元数据（/api/media/items/:id，响应带 base64 封面、体积不小）是**异步补齐**的：
    // 行先以降级形态渲染，等读数稳定再取证，否则会把「还没补齐」误判成「取不到」。
    await waitForRowStable(page)

    // ── 正控 B：页签真的切了 ──
    const tabProbe = await page.evaluate(() => ({
      scopeRowGone: !document.querySelector('[data-testid="cache-scope-all"]'),
      rows: document.querySelectorAll('[data-testid="cache-bytes-row"]').length,
    }))
    if (!tabProbe.scopeRowGone) {
      fatal('POSITIVE CONTROL FAILED: pipeline scope row still present — tab did not switch')
    }
    if (tabProbe.rows === 0) {
      fatal('POSITIVE CONTROL FAILED: 0 [cache-bytes-row] rows after switching (cannot verify)')
    }
    check(
      true,
      'control: tab switched (pipeline scope row gone) and the reclamation list renders',
      `rows=${tabProbe.rows} (preview inside=${insideCount})`,
    )
    if (tabProbe.rows !== insideCount) {
      console.log(
        `[verify] note: row count drifted vs preview snapshot (UI=${tabProbe.rows}, preview=${insideCount}) — data is live, non-blocking`,
      )
    }

    // ── 判据 1：回收页签下统计条不存在 ──
    const summaryInBytes = await page.evaluate(
      () => !!document.querySelector('[data-testid="cache-ingest-summary"]'),
    )
    check(
      !summaryInBytes,
      '判据1: [cache-ingest-summary] is ABSENT in the reclamation tab',
      `present=${summaryInBytes}`,
    )

    // ── 判据 2/3：逐行取证（textContent + 全部 [title] 属性 + 三项标识） ──
    const rows = await page.evaluate(() => {
      const out = []
      for (const r of document.querySelectorAll('[data-testid="cache-bytes-row"]')) {
        const pick = (tid) => {
          const el = r.querySelector(`[data-testid="${tid}"]`)
          return el ? String(el.textContent || '').trim() : null
        }
        const titles = [...r.querySelectorAll('[title]')].map((el) =>
          String(el.getAttribute('title') || ''),
        )
        out.push({
          text: String(r.textContent || ''),
          titles,
          chat: pick('cache-bytes-row-chat'),
          msg: pick('cache-bytes-row-msg'),
          kind: pick('cache-bytes-row-kind'),
        })
      }
      return out
    })
    console.log('[verify] row samples:', JSON.stringify(rows.slice(0, 4)))

    const rawHits = rows.filter(
      (r) => RAW_RE.test(r.text) || r.titles.some((t) => RAW_RE.test(t)),
    )
    check(
      rawHits.length === 0,
      '判据2: no row text / title-attr matches ^[a-z]+--\\d+_\\d+ (raw file-name ids are gone)',
      rawHits.length === 0
        ? `scanned=${rows.length}`
        : `hits=${rawHits.length} sample=${JSON.stringify(rawHits[0] && rawHits[0].text.slice(0, 120))}`,
    )

    const unidentifiable = rows.filter(
      (r) => !r.chat || !r.msg || !r.kind || !r.chat.trim() || !r.msg.trim() || !r.kind.trim(),
    )
    check(
      unidentifiable.length === 0,
      '判据3: every row carries non-empty channel + message-number + kind',
      unidentifiable.length === 0
        ? `rows=${rows.length}`
        : `bad=${unidentifiable.length} sample=${JSON.stringify(unidentifiable[0])}`,
    )

    await page.screenshot(path.join(SHOT_DIR, 'bug256-reclamation-tab.png'))
    console.log(`[verify] screenshot: ${path.join(SHOT_DIR, 'bug256-reclamation-tab.png')}`)

    // ── 判据 4：能力全部仍在且可用 ──
    const presence = await page.evaluate(() => {
      const q = (tid) => document.querySelector(`[data-testid="${tid}"]`)
      const btn = (tid) => {
        const el = q(tid)
        return el ? { present: true, disabled: Boolean(el.disabled) } : { present: false }
      }
      return {
        clearAll: btn('cache-bytes-clear-all'),
        clearOrphan: btn('cache-bytes-clear-orphan'),
        clearStale: btn('cache-bytes-clear-stale'),
        clearFailed: btn('cache-bytes-clear-failed'),
        selectAll: btn('cache-bytes-select-all'),
        selectedCount: !!q('cache-bytes-selected-count'),
        chipsRoot: !!q('cache-bytes-chats'),
        chipButtons: document.querySelectorAll('[data-testid^="cache-bytes-chat-"]').length,
      }
    })
    check(
      presence.clearAll.present &&
        presence.clearOrphan.present &&
        presence.clearStale.present &&
        presence.clearFailed.present,
      '判据4a: four-tier buttons (all/orphan/stale/failed) all present',
      JSON.stringify(presence),
    )
    check(presence.selectAll.present, '判据4b: select-all control present')
    check(presence.selectedCount, '判据4b: selected-count readout present')
    if (chatGroups > 1) {
      check(
        presence.chipsRoot && presence.chipButtons >= chatGroups,
        '判据4c: per-channel chips present (preview has >1 chat group)',
        `chips=${presence.chipButtons} groups=${chatGroups}`,
      )
    } else {
      console.log('[verify] note: single chat group in preview — chips legitimately absent')
    }

    // 可用性 ①：点四档里第一个可用的档 → 确认条弹出（含 是/否）→ 取消。
    const tier = await page.evaluate(() => {
      for (const tid of [
        'cache-bytes-clear-orphan',
        'cache-bytes-clear-failed',
        'cache-bytes-clear-stale',
        'cache-bytes-clear-all',
      ]) {
        const el = document.querySelector(`[data-testid="${tid}"]`)
        if (el && !el.disabled) {
          el.click()
          return tid
        }
      }
      return null
    })
    if (!tier) {
      check(false, '判据4d: at least one tier button is clickable', 'all four disabled')
    } else {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-bytes-confirm"]'), {
        timeout: 8000,
      })
      const confirmOk = await page.evaluate(
        () =>
          !!document.querySelector('[data-testid="cache-bytes-confirm-yes"]') &&
          !!document.querySelector('[data-testid="cache-bytes-confirm-no"]'),
      )
      check(confirmOk, '判据4d: tier button opens the confirm bar (yes+no)', `tier=${tier}`)
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="cache-bytes-confirm-no"]')
        if (el) el.click()
      })
      await delay(300)
      const confirmGone = await page.evaluate(
        () => !document.querySelector('[data-testid="cache-bytes-confirm"]'),
      )
      check(confirmGone, '判据4d: confirm bar is cancellable (nothing deleted)')
    }

    // 可用性 ②：勾选一行 → 已选计数变化 → 「回收所选」→ 确认条弹出 → 取消。
    const before = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cache-bytes-selected-count"]')
      return el ? String(el.textContent || '').trim() : ''
    })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="cache-bytes-check-"]')
      if (el) el.click()
    })
    await delay(300)
    const after = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cache-bytes-selected-count"]')
      return el ? String(el.textContent || '').trim() : ''
    })
    check(
      after !== before && /\d/.test(after),
      '判据4e: ticking a row updates the selected-count readout',
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    )
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cache-bytes-clear-selected"]')
      if (el && !el.disabled) el.click()
    })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-bytes-confirm"]'), {
      timeout: 8000,
    })
    const idsConfirm = await page.evaluate(
      () =>
        !!document.querySelector('[data-testid="cache-bytes-confirm-yes"]') &&
        !!document.querySelector('[data-testid="cache-bytes-confirm-no"]'),
    )
    check(idsConfirm, '判据4f: 「回收所选」opens the same confirm bar (selection path alive)')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cache-bytes-confirm-no"]')
      if (el) el.click()
    })
    await delay(300)

    // 全选往返：勾满 → 清空（选择工具条本身可用）。
    const allCounts = await page.evaluate(async () => {
      const readCount = () => {
        const el = document.querySelector('[data-testid="cache-bytes-selected-count"]')
        return el ? String(el.textContent || '').trim() : ''
      }
      const rowsN = document.querySelectorAll('[data-testid="cache-bytes-row"]').length
      const btn = document.querySelector('[data-testid="cache-bytes-select-all"]')
      if (!btn || btn.disabled) return { rowsN, full: '', empty: '', disabled: true }
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      const full = readCount()
      btn.click()
      await new Promise((r) => setTimeout(r, 250))
      const empty = readCount()
      return { rowsN, full, empty, disabled: false }
    })
    check(
      !allCounts.disabled && allCounts.full !== allCounts.empty,
      '判据4g: select-all round-trip works (check-all then uncheck-all)',
      JSON.stringify(allCounts),
    )

    await page.screenshot(path.join(SHOT_DIR, 'bug256-capabilities.png'))
    console.log(`[verify] screenshot: ${path.join(SHOT_DIR, 'bug256-capabilities.png')}`)

    const pageErrors = page.pageErrors()
    check(pageErrors.length === 0, 'no uncaught page errors', JSON.stringify(pageErrors.slice(0, 2)))
  } finally {
    await browser.close()
  }

  console.log(`[verify] total=${passed + failed} passed=${passed} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 2)
}

main().catch((err) => {
  console.error(`[verify] ERROR ${err && err.message ? err.message : err}`)
  process.exit(1)
})
