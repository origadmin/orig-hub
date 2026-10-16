'use strict'

/**
 * BUG-316 段②补 —— /api/activity 轮询**按视图在场门控**（2026-10-16 用户裁定）。
 *
 * 用户报：「api/activity?scope=all 作为下载状态或者列表来讲,频率超高,且不论在
 * 什么位置一直请求,所谓『不在其位不谋其政』,这严重破坏了模块和功能的分割逻辑.
 * 而且导致了很大的性能问题,卡顿严重.」
 *
 * 实证路径（全部真实栈，无 mock）：
 *   1. 打开应用（首屏 settle）；
 *   2. 页面侧包 `window.fetch` 计数 `/api/activity` 请求；
 *   3. 切到 nav-files（媒体库，**非下载域**），停留 10s ⇒ 计数器增量必须 == 0
 *      （修复前基线：3s 间隔 × 10s ≈ 3 次，每次读 SQLite）；
 *   4. 切回 nav-download ⇒ 4s 内计数器增量 ≥ 1（切回立即补拉）且入库组列表
 *      正常渲染（data-total > 0）；
 *   5. 切走期间数据不清空（切回后 data-total 与切走前一致）。
 *
 * 反向证伪（「验收的验收」）由调用方执行：把 `useIngestGroups` 的 enabled 门控
 * 去掉（`enabled` 恒 true），第 3 步断言必 FAIL（10s 内 ≥ 2 次 activity 请求）。
 *
 * 用法：node tauri-shell/verify/verify_bug316_activity_gate.cjs
 *   （需 vite :5180 + orig-daemon :19786 + orig-tg 在跑；产物落 verify_shots/）
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(ROOT, 'verify_shots', 'bug316-activity-gate')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const T = {
  navFiles: 'nav-files',
  navDownload: 'nav-download',
  groupList: 'dl-group-list',
}

/** 非下载域停留时长（修复前 3s 间隔下应有 ~3 次请求；修复后必须 0）。 */
const OFFVIEW_MS = 10000
/** 回下载域后等待（轮询间隔 3s + 余量）。 */
const BACKVIEW_MS = 4500

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 包 window.fetch 计数 /api/activity（面板走 window.fetch，页面侧拦截即可）。 */
const installFetchCounter = (page) =>
  page.evaluate(() => {
    window.__actHits = []
    const orig = window.fetch
    window.fetch = function (...args) {
      try {
        const u = typeof args[0] === 'string' ? args[0] : args[0]?.url
        if (typeof u === 'string' && u.includes('/api/activity')) {
          window.__actHits.push(u)
        }
      } catch {
        /* 计数失败不影响请求本身 */
      }
      return orig.apply(this, args)
    }
    return true
  })

const actHits = (page) => page.evaluate(() => window.__actHits || [])

const clickNav = (page, testid) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`[data-testid="${sel}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)

const groupTotal = (page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(`[data-testid="${sel}"]`)
    return el ? Number(el.getAttribute('data-total') || '0') : -1
  }, T.groupList)

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()

  await page.goto(APP_URL, { waitUntil: 'load', timeout: 30000, settleMs: 1200 })
  // 首屏默认视图可能就是下载域：先确保落在下载域、让首轮拉取完成，
  // 再注入计数器 —— 否则首帧请求会污染增量口径。
  await clickNav(page, T.navDownload)
  await new Promise((r) => setTimeout(r, 1500))
  await installFetchCounter(page)

  // 基线：切走前的组数（数据不清空判据）
  const totalBefore = await groupTotal(page)
  const hitsBaseline = (await actHits(page)).length

  // ── ③ 非下载域停留 10s：activity 请求必须为 0 ──
  check('切到媒体库前计数器已注入', hitsBaseline >= 0)
  await clickNav(page, T.navFiles)
  await new Promise((r) => setTimeout(r, OFFVIEW_MS))
  const hitsOffView = (await actHits(page)).length - hitsBaseline
  check(
    `非下载域 ${OFFVIEW_MS}ms 内 /api/activity 请求数 == 0`,
    hitsOffView === 0,
    `实测 ${hitsOffView} 次（修复前基线 ≈ ${Math.floor(OFFVIEW_MS / 3000)} 次）`,
  )
  const pageErrorsOff = page.pageErrors()
  check('非下载域期间无页面异常', pageErrorsOff.length === 0, pageErrorsOff.join(' | ').slice(0, 200))

  // ── ④ 回下载域：立即补拉 + 列表正常 ──
  await clickNav(page, T.navDownload)
  await new Promise((r) => setTimeout(r, BACKVIEW_MS))
  const hitsBack = (await actHits(page)).length - hitsBaseline - hitsOffView
  check(
    '回下载域后立即补拉（≥1 次 activity 请求）',
    hitsBack >= 1,
    `实测 ${hitsBack} 次`,
  )
  const totalAfter = await groupTotal(page)
  check(
    '入库组列表正常渲染（data-total > 0）',
    totalAfter > 0,
    `data-total=${totalAfter}`,
  )

  // ── ⑤ 切走期间数据不清空（快照保留） ──
  check(
    '切走期间入库组数据不清空（data-total 不变）',
    totalBefore === totalAfter && totalBefore > 0,
    `切走前=${totalBefore} 切回后=${totalAfter}`,
  )
  const pageErrors = page.pageErrors()
  check('全程无页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))

  await page.screenshot(path.join(OUT, 'back_on_download.png'))
  await browser.close()

  console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
