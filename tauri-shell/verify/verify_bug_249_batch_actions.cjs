#!/usr/bin/env node
'use strict'

/**
 * BUG-249 真实 UI 验收：入库流水线的批量动作条（重试 / 取消 / 删除）。
 *
 * ## 缺陷回顾
 *
 * 入库流水线（`CacheManagerDialog`）此前只有「批量删除」一种批量能力
 * （`cache-confirm-batch`）。大量 failed 记录只能逐条点重试、排队任务无法批量取消。
 * 后端 `546d17c` 已补两条批量端点：
 *   - `POST /api/cache/tasks/retry?ids=…`  —— 仅 failed/cancelled/interrupted 可复位；
 *   - `POST /api/cache/tasks/cancel?ids=…` —— 仅 queued/running 可取消；
 *   两者契约相同：请求里夹带**任意一条**不合法状态 ⇒ **整请求 422**（body 含
 *   `error` 与 `invalid`），合法的那几条**不部分执行**；成功回 `{"ok":true,"ids":[…]}`。
 *
 * 因此前端**不能**把「已选 N 条」原样发给端点（必然 422），必须先只发**可操作的子集**，
 * 并把落差如实摆出来。这正是本脚本 A 段要验收的核心。
 *
 * ## ⚠️ 硬约束：绝不改变用户任务状态
 *
 * 真实的 retry / cancel / delete **一个都不发**（会污染真实的入库队列）。本脚本只：
 *   - **读** DOM（动作条、计数、按钮 disabled/title）；
 *   - C 段用**空 ids / 越界 id** 探针证明 422 契约（这两类请求后端都不会动任何记录）。
 * 动作条上的三个按钮**只读状态、不点击**。
 *
 * ## 断言
 *
 *   A  **实时派生**（不是「恒等于选中数」）：
 *      A1 选中全部可重试行 → 计数「可重试 x」=== 选中数 n，且「可取消」=== 0；
 *      A2 再叠加 1 条**非可重试行**（优先活跃行，无活跃时回退 done 行）→ 选中数变成
 *         n+1，而「可重试」仍是 n（retry ≠ n+1）⇒ 证明计数是**从选中集实时派生**的，
 *         不是复制选中数；
 *      A3 落差可见：重试按钮 title（「另外 {miss} 条本次不受影响」）非空且含正确 miss。
 *   B  三个入口 `cache-batch-retry`/`cache-batch-cancel`/`cache-batch-delete` 都存在；
 *      且「选中集里没有活跃任务」时 `cache-batch-cancel` **disabled === true**。
 *   C  422 契约（不改变任何状态）：空 ids → 422；越界 id → 非 422 且 `ids` 为空。
 *   D  截图：动作条 + 计数、取消按钮状态。
 *
 * 若当前列表**没有任何终态（failed/interrupted）记录**，A 段无法构成（样本不足）——
 * 脚本**如实判 FAIL 并说明**，不跳过、不伪造样本。
 *
 * ## 环境
 *
 *   vite dev + 后端。未就绪时用 `scripts/dev_services.py` 拉起（**不裸跑** orig-tg：
 *   daemon 是唯一启动者）。orig-tg 端口从 daemon `/api/config` 取真源（BUG-358 起
 *   plugins[] id="tg".port，旧键 tg_port 兜底 —— BUG-423）。
 *
 * 用法： node verify/verify_bug_249_batch_actions.cjs
 * Env:  APP_PORT(5180) / DAEMON_PORT(19786) / ORIG_VERIFY_SHOTS
 * Exit: 0 全通过；2 A/B/C 有判据失败；1 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`

/** 与 `CacheManagerDialog.tsx` 的状态门**同源**（前端判定 / 后端门必须一致）。 */
const RETRYABLE_STATUS = ['failed', 'cancelled', 'interrupted']
const ACTIVE_STATUS = ['queued', 'running']

/** 越界 id：远超真实自增范围，后端视作「读不到」——不动手、不报错。 */
const OUT_OF_RANGE_ID = 999999999

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, '..', 'verify_shots', 'bug249'),
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail, id = '') {
  checks.push({ name, pass: Boolean(pass), detail, id })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(pass)
}

// ─────────────────────────── HTTP（仅回环） ───────────────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
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

/** 从 daemon 真源取 orig-tg 端口（不硬编码）。 */
async function resolveTgBase() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  if (cfg.status !== 200 || !cfg.json) return null
  // BUG-423：BUG-358 起真源是 plugins[] 里 id="tg"（旧键 tg_port/tg_running 兜底）
  const plug = Array.isArray(cfg.json.plugins) ? cfg.json.plugins.find((x) => x && x.id === 'tg') : null
  const port =
    plug && Number(plug.port) > 0 ? Number(plug.port) : Number(cfg.json.tg_port) > 0 ? Number(cfg.json.tg_port) : null
  if (!port) return null
  const tgRunning = plug ? plug.running === true : cfg.json.tg_running === true
  return { base: `http://127.0.0.1:${port}`, tgRunning }
}

function startDevServices() {
  const repo = path.resolve(__dirname, '..', '..')
  const script = path.join(repo, 'scripts', 'dev_services.py')
  console.log(`[bug249] dev services not ready — starting ${script}`)
  execFileSync('python', [script], { cwd: repo, stdio: 'inherit', timeout: 120000 })
}

async function waitForEnv(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const tg = await resolveTgBase()
    const app = await httpJson('GET', APP_URL)
    if (tg && tg.tgRunning && app.status === 200) return tg
    last = { tg, appStatus: app.status }
    await delay(1000)
  }
  return last
}

// ─────────────────────────── DOM 判据 ───────────────────────────

/** 点选所有指定状态的行（真实点击 checkbox，不是改 state）。返回点了几条。 */
async function selectRowsByStatus(page, statuses) {
  return page.evaluate((sts) => {
    const set = new Set(sts)
    let n = 0
    for (const r of document.querySelectorAll('[data-testid="cache-task-row"]')) {
      if (!set.has(r.getAttribute('data-status'))) continue
      const cb = r.querySelector('[data-testid="cache-select-row"]')
      if (cb) {
        cb.click()
        n++
      }
    }
    return n
  }, statuses)
}

/**
 * 叠加点选**一条非可重试行**，用来制造「选中数 > 可重试数」的对照（证明计数实时派生）。
 *
 * 优先级：**活跃行**（queued 优先 —— 最稳定，且能额外验证 cancel 变为可用）→
 * 任一「既不可重试也不活跃」的可选行（如 `done`）。之所以允许回退：某些环境
 * （例如刚重启过 orig-tg，in-flight 的 queued 全被置为 interrupted）列表里可能
 * 一条活跃任务都没有，但**派生性质**（可重试数 ≠ 选中数）用 `done` 行同样可证。
 * 返回 `{status, active}`；找不到可叠加行时返回 null（A2 如实判 FAIL）。
 */
async function selectOneExtra(page) {
  return page.evaluate((activeSts, retrySts) => {
    const rows = [...document.querySelectorAll('[data-testid="cache-task-row"]')]
    const sel = (r) => r.querySelector('[data-testid="cache-select-row"]')
    const isRetry = (r) => retrySts.includes(r.getAttribute('data-status'))
    const isActive = (r) => activeSts.includes(r.getAttribute('data-status'))
    const pick =
      rows.find((r) => r.getAttribute('data-status') === 'queued' && sel(r)) ||
      rows.find((r) => isActive(r) && sel(r)) ||
      rows.find((r) => !isRetry(r) && !isActive(r) && sel(r))
    if (!pick) return null
    const st = pick.getAttribute('data-status')
    sel(pick).click()
    return { status: st, active: activeSts.includes(st) }
  }, ACTIVE_STATUS, RETRYABLE_STATUS)
}

/** 读动作条快照（计数 / 三个按钮的 text·disabled·title）。 */
async function readBar(page) {
  return page.evaluate(() => {
    const read = (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return null
      return {
        text: String(el.textContent || '').trim(),
        disabled: el.disabled === true,
        title: el.getAttribute('title') || '',
      }
    }
    const counts = document.querySelector('[data-testid="cache-batch-counts"]')
    return {
      hasBar: !!document.querySelector('[data-testid="cache-batch-bar"]'),
      countsText: counts ? String(counts.textContent || '').trim() : null,
      retry: read('cache-batch-retry'),
      cancel: read('cache-batch-cancel'),
      del: read('cache-batch-delete'),
    }
  })
}

/** 从计数文本按出现顺序取数（zh/en 结构一致：选中 / 可重试 / 可取消）。 */
function parseCounts(text) {
  const m = String(text || '').match(/\d+/g)
  if (!m || m.length < 3) return null
  return { n: Number(m[0]), retry: Number(m[1]), cancel: Number(m[2]) }
}

/** 从按钮文本里取括号/圆弧内的数字（zh「批量重试（8）」/ en「Retry selected (8)」）。 */
function parseButtonCount(text) {
  const m = String(text || '').match(/(\d+)/)
  return m ? Number(m[1]) : null
}

/** 行状态分布（用于样本判定与报告）。 */
async function readStatusCounts(page) {
  return page.evaluate(() => {
    const out = {}
    for (const r of document.querySelectorAll('[data-testid="cache-task-row"]')) {
      const s = r.getAttribute('data-status') || '?'
      out[s] = (out[s] || 0) + 1
    }
    return out
  })
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    /* 产物缺失不影响判据 */
  }
  console.log(`[bug249] shot ${name} -> ${file} (${size} bytes)`)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug249] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)

  let envInfo = await resolveTgBase()
  if (!envInfo || !envInfo.tgRunning) {
    startDevServices()
    envInfo = await waitForEnv()
  }
  if (!envInfo || !envInfo.base || !envInfo.tgRunning) {
    console.error(`[bug249] 环境未就绪：${JSON.stringify(envInfo)}`)
    process.exit(1)
  }
  const TG = envInfo.base
  console.log(`[bug249] orig-tg = ${TG}（取自 daemon tg_port 真源）`)

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })

    // ── 导航（一律 data-testid）：TG 面板 → 「入库流水线」入口 ──
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-tg 入口不存在')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
      { timeout: 25000 },
    )
    const entryOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-cache-manager-entry"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!entryOk) throw new Error('tg-cache-manager-entry 入口不存在')

    // 流水线页签（默认即为 tasks）+ 至少一行记录
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="cache-manager"]'),
      { timeout: 15000 },
    )
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="cache-task-row"]'),
      { timeout: 20000 },
    )
    await delay(500)

    const statusCounts = await readStatusCounts(page)
    const retryableRows = RETRYABLE_STATUS.reduce((a, s) => a + (statusCounts[s] || 0), 0)
    const activeRows = ACTIVE_STATUS.reduce((a, s) => a + (statusCounts[s] || 0), 0)
    console.log(
      `[bug249] 列表状态分布 = ${JSON.stringify(statusCounts)}（可重试=${retryableRows} 活跃=${activeRows}）`,
    )

    // ── 选中全部可重试行 ──
    const selectedRetryable = await selectRowsByStatus(page, RETRYABLE_STATUS)
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="cache-batch-bar"]'),
      { timeout: 10000 },
    ).catch(() => undefined)
    await delay(300)

    const bar1 = await readBar(page)
    const c1 = parseCounts(bar1.countsText)
    console.log(`[bug249] stage1 countsText=${JSON.stringify(bar1.countsText)} parsed=${JSON.stringify(c1)}`)

    // ── B 段：三入口存在 + 「无活跃任务」时 cancel 禁用 ──
    const threeExist = Boolean(bar1.retry && bar1.cancel && bar1.del)
    check(
      'B1: 动作条三个入口都存在（retry / cancel / delete）',
      bar1.hasBar && threeExist,
      `hasBar=${bar1.hasBar} retry=${!!bar1.retry} cancel=${!!bar1.cancel} delete=${!!bar1.del}`,
      'B1',
    )
    check(
      'B2: 选中集无活跃任务时 cache-batch-cancel 为 disabled',
      Boolean(bar1.cancel) && bar1.cancel.disabled === true,
      `cancel.disabled=${bar1.cancel ? bar1.cancel.disabled : 'null'} cancel.text=${JSON.stringify(bar1.cancel && bar1.cancel.text)}`,
      'B2',
    )
    await shot(page, '02-batch-cancel-disabled.png')

    // ── A 段：实时派生 ──
    let a1ok = false
    if (retryableRows === 0) {
      check(
        'A1: 选中全部可重试行后「可重试」计数 === 选中数',
        false,
        '样本不足：当前列表没有任何终态（failed/interrupted）记录，无法构成判据（如实判 FAIL）',
        'A1',
      )
    } else {
      a1ok =
        selectedRetryable === retryableRows &&
        c1 !== null &&
        c1.n === retryableRows &&
        c1.retry === retryableRows &&
        c1.cancel === 0 &&
        Boolean(bar1.retry) &&
        bar1.retry.disabled === false &&
        parseButtonCount(bar1.retry.text) === retryableRows
      check(
        'A1: 选中全部可重试行后「可重试」计数 === 选中数（且可取消=0）',
        a1ok,
        `selected=${selectedRetryable}/${retryableRows} counts=${JSON.stringify(c1)} ` +
          `retryLabel=${JSON.stringify(bar1.retry && bar1.retry.text)} retryDisabled=${bar1.retry && bar1.retry.disabled}`,
        'A1',
      )
    }
    await shot(page, '01-batch-bar-counts.png')

    // 叠加 1 条**非可重试行** → 选中数 +1，可重试不变（retry ≠ n 即证明「实时派生」）
    let a2ok = false
    let a3ok = false
    if (!a1ok) {
      check(
        'A2: 叠加 1 条非可重试行后选中数 +1 而「可重试」不变（证明实时派生）',
        false,
        'A1 未通过，跳过',
        'A2',
      )
      check('A3: 落差以 title 明示「另外 N 条本次不受影响」', false, 'A1 未通过，跳过', 'A3')
    } else {
      const extra = await selectOneExtra(page)
      if (!extra) {
        check(
          'A2: 叠加 1 条非可重试行后选中数 +1 而「可重试」不变（证明实时派生）',
          false,
          '样本不足：列表里没有可叠加的非可重试行（既无活跃也无 done），无法构成「retry ≠ n」的对照（如实判 FAIL）',
          'A2',
        )
        check('A3: 落差以 title 明示「另外 N 条本次不受影响」', false, 'A2 未构成', 'A3')
      } else {
        await delay(300)
        const bar2 = await readBar(page)
        const c2 = parseCounts(bar2.countsText)
        const expectN = retryableRows + 1
        console.log(
          `[bug249] stage2 extra=${JSON.stringify(extra)} countsText=${JSON.stringify(bar2.countsText)} parsed=${JSON.stringify(c2)}`,
        )
        a2ok =
          c2 !== null &&
          c2.n === expectN &&
          c2.retry === retryableRows &&
          c2.retry !== c2.n &&
          Boolean(bar2.retry) &&
          parseButtonCount(bar2.retry.text) === retryableRows
        check(
          'A2: 叠加 1 条非可重试行后选中数 +1 而「可重试」不变（证明实时派生，retry ≠ n）',
          a2ok,
          `extra=${JSON.stringify(extra)} activeSample=${extra.active} counts=${JSON.stringify(c2)} ` +
            `expectN=${expectN} expectRetry=${retryableRows} retryLabel=${JSON.stringify(bar2.retry && bar2.retry.text)}`,
          'A2',
        )
        const miss = c2 ? c2.n - c2.retry : null
        a3ok =
          Boolean(bar2.retry) &&
          bar2.retry.title.length > 0 &&
          miss !== null &&
          miss > 0 &&
          bar2.retry.title.includes(String(miss))
        check(
          'A3: 落差以 title 明示「另外 N 条本次不受影响」（不静默跳过）',
          a3ok,
          `miss=${miss} retry.title=${JSON.stringify(bar2.retry && bar2.retry.title)}`,
          'A3',
        )
        if (extra.active) {
          check(
            'A4: 选中集含活跃任务时 cache-batch-cancel 变为可用',
            Boolean(bar2.cancel) && bar2.cancel.disabled === false,
            `cancel.disabled=${bar2.cancel ? bar2.cancel.disabled : 'null'}`,
            'A4',
          )
        } else {
          console.log(
            `[bug249] INFO A4: 当前列表无活跃任务（本次叠加的是 ${extra.status}），cancel 可用性路径未在本轮实测；` +
              'B2 已覆盖「无活跃 ⇒ cancel 禁用」一侧。',
          )
        }
        await shot(page, '03-batch-bar-with-extra.png')
      }
    }

    // ── C 段：422 契约（不改变任何状态）──
    // 探针在页面内发（走前端真实 CORS 通道）；空 ids 与越界 id 后端都不会动记录。
    const before = await httpJson('GET', `${TG}/api/tg/cache/tasks/all`)
    const probes = await page.evaluate(async (base) => {
      const call = async (url) => {
        try {
          const res = await fetch(url, { method: 'POST' })
          const text = await res.text()
          return { status: res.status, body: text.slice(0, 300) }
        } catch (e) {
          return { status: 0, body: String((e && e.message) || e) }
        }
      }
      const retryNoIds = await call(`${base}/api/cache/tasks/retry`)
      const cancelNoIds = await call(`${base}/api/cache/tasks/cancel`)
      const retryOutOfRange = await call(`${base}/api/cache/tasks/retry?ids=999999999`)
      return { retryNoIds, cancelNoIds, retryOutOfRange }
    }, TG)
    console.log(`[bug249] C 探针 = ${JSON.stringify(probes)}`)

    check(
      'C1: POST retry 空 ids → 422（绝不静默 no-op）',
      probes.retryNoIds.status === 422,
      `status=${probes.retryNoIds.status} body=${JSON.stringify(probes.retryNoIds.body)}`,
      'C1',
    )
    check(
      'C2: POST cancel 空 ids → 422',
      probes.cancelNoIds.status === 422,
      `status=${probes.cancelNoIds.status} body=${JSON.stringify(probes.cancelNoIds.body)}`,
      'C2',
    )
    let outOk = probes.retryOutOfRange.status !== 422
    let outJson = null
    try {
      outJson = JSON.parse(probes.retryOutOfRange.body)
    } catch (_e) {
      outJson = null
    }
    const outIdsEmpty = outJson && Array.isArray(outJson.ids) && outJson.ids.length === 0
    check(
      'C3: POST retry 越界 id → 非 422，且生效 ids 为空（不动任何记录）',
      outOk && outIdsEmpty,
      `status=${probes.retryOutOfRange.status} body=${JSON.stringify(probes.retryOutOfRange.body)}`,
      'C3',
    )

    const after = await httpJson('GET', `${TG}/api/tg/cache/tasks/all`)
    const beforeCounts = before.json ? before.json.counts : null
    const afterCounts = after.json ? after.json.counts : null
    console.log(
      `[bug249] 探针前后 counts（观测，不计入判据）= before=${JSON.stringify(beforeCounts)} after=${JSON.stringify(afterCounts)}`,
    )

    // 收尾：退出选中（不改任何后端状态；纯 UI）
    await page.evaluate(() => {
      const all = document.querySelector('[data-testid="cache-select-all"]')
      if (all) all.click()
      for (const r of document.querySelectorAll('[data-testid="cache-task-row"]')) {
        const cb = r.querySelector('[data-testid="cache-select-row"]')
        if (cb && cb.checked) cb.click()
      }
    })

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug249] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)
    check('D1: 页面无未捕获异常', pageErrs.length === 0, JSON.stringify(pageErrs), 'D1')

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[bug249] === SUMMARY ===')
    console.log(`[bug249] shots: ${SHOTS}`)
    console.log(
      `[bug249] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`,
    )
    if (failed.length) console.log('[bug249] FAILED:', failed.map((c) => `${c.id}:${c.name}`).join(' | '))
    if (failed.length) process.exitCode = 2
  } finally {
    if (browser) await browser.close()
    console.log('[bug249] 未发送任何真实 retry / cancel / delete（硬约束：不改变用户任务状态）')
  }
}

main().catch((e) => {
  console.error('[bug249] ERROR', (e && e.message) || e)
  process.exit(1)
})
