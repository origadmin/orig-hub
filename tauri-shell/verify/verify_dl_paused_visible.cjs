'use strict'
/**
 * 验收：「已暂停」档必须装下**所有停止项**（BUG-377）。
 *
 * 用户 2026-10-22 原话：「全部下载 -> 已暂停没有看到暂停内容（失败、取消、错误），
 * **所有停止项都应该在里面**」。
 *
 * 旧实现：引擎侧 `status === 'paused'`、入库侧 `groupInBucket('paused') === false`
 * ⇒ `failed` / `cancelled` / `interrupted` **任何档位都看不见**（不在「下载中」，
 * 不在「已完成」，「已暂停」又不收）。真实库态实测有 22 个 stopped 入库对象
 * （14 interrupted + 11 failed，聚合后 22 组），修复前这一档是空的。
 *
 * ## 判据（每条都带被测前提）
 *
 *   P1 前提：真源 API 里确实存在 stopped 项（引擎 stopped + 入库 stopped 组 > 0）。
 *      没有可测样本 ⇒ **Loud FAIL**，不是「空列表也算过」。
 *   P2 侧栏「已暂停」徽标数 = 真源重算出的 stopped 数（**独立复算**，不复用产品
 *      的分组代码：徽标与列表若各写一份条件，就会分裂成「徽标 0、列表 22」）。
 *   P3 点进「已暂停」档后列表**非空**（用户诉求的直接反面）。
 *   P4 该档里不出现「下载中」「已完成」字样的行（档位不串）。
 *   P5 入库停止行确实带重试入口（`ingest-group-action-retry`）—— 「能看见」必须
 *      连带「能处理」，否则只是把尸体摆出来。
 *
 * 用法：node tauri-shell/verify/verify_dl_paused_visible.cjs
 * 前置：dev 栈在跑（`scripts/dev/dev-stack.cmd` → 1 起栈），5180 可访问。
 * 产物：verify_shots/dl-paused/{report.json,*.png}
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'dl-paused')
const VIEWPORT = { width: 900, height: 600 }

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}
function fatal(msg) {
  console.error(`\n[dl-paused] FATAL: ${msg}`)
  process.exit(2)
}

const ENGINE_STOPPED = ['paused', 'error', 'cancelled', 'interrupted']
const CACHE_ACTIVE = ['queued', 'running']

async function apiGet(base, p) {
  const res = await fetch(base + p, { headers: { accept: 'application/json' } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status} ${text.slice(0, 120)}`)
  return text ? JSON.parse(text) : null
}

/**
 * 独立复算「停止项」数量（**故意不复用产品代码**）。
 *
 * 入库侧按 `groupKey` 聚合（与产品同一聚合键），`latest` 规则照 BUG-318 契约：
 * 组内有活跃任务 ⇒ 代表项是活跃项（该组不算停止）；否则取 `updated_at` 最新那条。
 */
function computeExpected(engine, activity) {
  const engineStopped = (engine || []).filter((d) => ENGINE_STOPPED.includes(d.status)).length
  const byKey = new Map()
  for (const t of (activity && activity.tasks) || []) {
    // 只数入库（cache）任务：activity 响应混有 kind='download' 的引擎任务
    // （其 status 用 completed 等另一套词），混进来会恒定算出一组假停止项
    // （实测 bug322ui.bin：completed ≠ done ⇒ +1，徽标 30 vs 复算 31 假红）。
    if (t.kind !== 'cache') continue
    const key = t.groupKey || String(t.id)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(t)
  }
  let ingestStopped = 0
  for (const [, rows] of byKey) {
    const active = rows.filter((r) => CACHE_ACTIVE.includes(r.status))
    if (active.length > 0) continue
    const latest = rows.reduce((a, b) => ((b.updated_at || 0) > (a.updated_at || 0) ? b : a), rows[0])
    if (!['done'].includes(latest.status)) ingestStopped += 1
  }
  return { engineStopped, ingestStopped, total: engineStopped + ingestStopped, groups: byKey.size }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  const engine = await apiGet(ep.daemon, '/api/downloads')
  // scope=all：UI 的 useIngestGroups 走 fetchActivity('all')（含已结束记录）。
  // 裸取 /api/activity 是默认 scope=active（只见在传+停滞）——曾据此算出
  // 「徽标 30 ≠ 复算 22」的假红（BUG-377 验收记录）。
  const activity = await apiGet(ep.daemon, '/api/activity?scope=all')
  const exp = computeExpected(engine, activity)
  console.log(
    `[dl-paused] app=${ep.app} daemon=${ep.daemon} engineStopped=${exp.engineStopped} ` +
      `ingestStopped=${exp.ingestStopped} total=${exp.total} groups=${exp.groups}`,
  )
  check(
    'P1 前提：真源里存在停止项（引擎 stopped 或入库 stopped 组 > 0）',
    exp.total > 0,
    `total=${exp.total} (engine=${exp.engineStopped} ingest=${exp.ingestStopped})`,
  )
  if (exp.total === 0) fatal('no stopped item in the real data — criteria would be vacuous')

  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await page.setViewport(VIEWPORT)
    await page.goto(ep.app + '/', { waitUntil: 'domcontentloaded', waitForRoot: true, settleMs: 1500, timeout: 90000, attempts: 3 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-download"]'), { timeout: 60000 })

    // 进下载域 + 展开档位子树（`dlOpen` 关着时子项不渲染）
    await page.evaluate(() => document.querySelector('[data-testid="nav-download"]').click())
    await page.waitForFunction(() => !!document.querySelector('[data-testid="dl-group-list"]'), { timeout: 30000 })
    const needExpand = await page.evaluate(() => !document.querySelector('[data-testid="nav-child-dl-paused"]'))
    if (needExpand) {
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="download-chevron"]')
        if (c) c.click()
      })
      await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-dl-paused"]'), { timeout: 15000 })
    }

    // P2 徽标 = 独立复算值。**期望值在等待窗口内对新鲜快照重算**：本机反复跑
    // 回溯验收时任务集在分钟级漂移（取消回溯的最后一个任务中途落库），拿探针
    // 启动时那一份固定期望值比对，会把实时漂移误报成「徽标 ≠ 真源」。
    const readBadge = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="nav-child-dl-paused"]')
        if (!el) return null
        const spans = el.querySelectorAll('span')
        const raw = spans.length ? (spans[spans.length - 1].textContent || '').trim() : ''
        return { text: raw, num: /^\d+$/.test(raw) ? Number(raw) : null }
      })
    const deadline = Date.now() + 30000
    let seen = await readBadge()
    let fresh = exp
    let matched = null
    while (Date.now() < deadline) {
      const engineNow = await apiGet(ep.daemon, '/api/downloads')
      const activityNow = await apiGet(ep.daemon, '/api/activity?scope=all')
      fresh = computeExpected(engineNow, activityNow)
      if (seen && seen.num === fresh.total) {
        matched = { badge: seen.num, expected: fresh.total }
        break
      }
      await new Promise((r) => setTimeout(r, 500))
      seen = await readBadge()
    }
    check(
      'P2 侧栏「已暂停」徽标数 = 真源独立复算的停止项数',
      matched !== null,
      matched
        ? `badge=${matched.badge} expected=${matched.expected}（窗口内收敛）`
        : `badge=${seen && seen.text} expected=${fresh.total}（30s 未收敛，如实报差）`,
    )

    // P3 点进该档：列表非空
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-dl-paused"]').click())
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="dl-group-list"]') || !!document.querySelector('[data-testid="dl-empty"]'),
      { timeout: 20000 },
    )
    await new Promise((r) => setTimeout(r, 1200))
    const shot = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="dl-group-list"]')
      const rows = list
        ? Array.from(list.querySelectorAll('[data-testid="download-item"], [data-testid="ingest-group-row"]'))
        : []
      return {
        empty: !!document.querySelector('[data-testid="dl-empty"]'),
        rows: rows.length,
        rowTexts: rows.map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90)),
        retryBtns: Array.from(document.querySelectorAll('[data-testid="ingest-group-action-retry"]')).length,
        listText: list ? (list.innerText || '').replace(/\s+/g, ' ').slice(0, 300) : '',
      }
    })
    await page.screenshot(path.join(OUT, '01-paused-bucket.png'))
    check('P3 「已暂停」档列表非空', !shot.empty && shot.rows > 0, `rows=${shot.rows} empty=${shot.empty} text="${shot.listText}"`)

    // P4 档位不串：不出现「下载中」「已完成」字样的行
    const bad = shot.rowTexts.filter((t) => /下载中|已完成/.test(t))
    check('P4 该档不混入「下载中」「已完成」的行', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean')

    // P5 能看见必须能处理：停止的入库行带重试
    check(
      'P5 入库停止行带「重试」入口（可见 ≠ 可用）',
      shot.retryBtns > 0,
      `retry buttons in DOM = ${shot.retryBtns}（窗口化列表只渲染可见行，>0 即可）`,
    )

    fs.writeFileSync(
      path.join(OUT, 'report.json'),
      JSON.stringify({ expected: exp, badge: seen, ui: shot, checks: results }, null, 2),
    )
  } finally {
    const failed = results.filter((r) => !r.ok)
    await browser.close()
    console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length}`)
    process.exit(failed.length === 0 ? 0 : 1)
  }
}

main().catch((e) => {
  console.error('FATAL', (e && e.stack) || e)
  process.exit(2)
})
