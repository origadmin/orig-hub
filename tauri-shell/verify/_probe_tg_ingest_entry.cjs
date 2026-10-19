/**
 * 真实渲染探针：TG 上下文栏「入库流水线」入口（2026-10-17 续裁形态 = **只留入口按钮**）。
 *
 * 断言（正向）：
 *  A1 入口按钮 `tg-cache-manager-entry` 在场，文案含「入库流水线」
 *  A2 按钮上挂 `tg-ingest-status`，在传/待处理/已缓存 三计数 == 独立复算的 API 口径
 *  A3 点入口 → **弹出** `cache-manager-overlay`，且**未跳转**（标题仍 Telegram）
 *  A4 关面板 → overlay 消失
 *  A5 ★ **入口上没有条目级跳转**：`tg-ingest-go-download` / `tg-ingest-go-library`
 *     在入口内**都不存在**（续裁：这两者都属于具体条目，只留在条目行上）
 *  A6 ★ 最窄受支持窗口（900px）下入口与中槽搜索框**零重叠**（网格例外生效）
 *
 * 反向证伪：PROBE_NEGATE=1 时把期望值换成错值 —— 探针必须 FAIL。
 */
const path = require('path')
const fs = require('fs')
const http = require('http')
const { launch } = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const BASE = process.env.PROBE_BASE || 'http://localhost:5180'
const API = process.env.PROBE_API || 'http://127.0.0.1:19786'
const NEGATE = process.env.PROBE_NEGATE === '1'
const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tg-ingest-entry')
fs.mkdirSync(OUT, { recursive: true })

const results = []
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

/** 独立复算入库概览（与前端同口径：按 groupKey 合组，代表=最新活跃否则最新）。 */
function expectedOverview(data) {
  const tasks = (data?.tasks || []).filter((t) => t.kind === 'cache')
  const buckets = new Map()
  for (const t of tasks) {
    const key = String(t.groupKey || '').trim() || `tg:${t.control?.native_id}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(t)
  }
  const isActive = (s) => s === 'queued' || s === 'running'
  const isStalled = (s) => s === 'failed' || s === 'interrupted'
  const ov = { total: buckets.size, active: 0, stalled: 0, done: 0, cancelled: 0 }
  for (const list of buckets.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        (b.updated_at || 0) - (a.updated_at || 0) ||
        Number(b.control?.native_id || 0) - Number(a.control?.native_id || 0),
    )
    const act = sorted.filter((t) => isActive(t.status))
    const rep = act.length > 0 ? act[0] : sorted[0]
    if (isActive(rep.status)) ov.active += 1
    else if (isStalled(rep.status)) ov.stalled += 1
    else if (rep.status === 'done') ov.done += 1
    else ov.cancelled += 1
  }
  return ov
}

const CLICK = (sel) => {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing ' + sel)
  el.click()
  return true
}
const TEXTOF = (sel) => {
  const el = document.querySelector(sel)
  return el ? (el.textContent || '').trim() : null
}
const HAS = (sel) => Boolean(document.querySelector(sel))

async function main() {
  const api = await fetchJson(`${API}/api/activity?scope=all`)
  const exp = expectedOverview(api)
  console.log('API 复算概览:', JSON.stringify(exp))

  const browser = await launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(BASE, { timeout: 60000, settleMs: 1500 })
    await page.waitForFunction((s) => Boolean(document.querySelector(s)), {
      timeout: 20000,
      args: ['[data-testid="nav-tg"]'],
    })
    await page.evaluate(CLICK, '[data-testid="nav-tg"]')
    await page.waitForFunction((s) => Boolean(document.querySelector(s)), {
      timeout: 20000,
      args: ['[data-testid="tg-cache-manager-entry"]'],
    })
    /*
     * 等计数**收敛到 API 口径**，而不是「文本里有数字」。
     *
     * 旧写法 `/\\d/.test(text)` 对「在传 0待处理 0已缓存 0」也为真 —— 首帧还没拿到
     * ingest 数据时三计数就是 0，于是 A2 间歇性假红（实测 3 次里 2 次）。改成有界
     * 收敛等待：要么等到与 API 复算一致（真通过），要么 10s 后照样往下走、由 A2
     * 如实报出差异（真失败）。**不吞掉失败**，只是不再把竞态当结论。
     */
    await page.waitForFunction(
      (s, exp) => {
        const el = document.querySelector(s)
        if (!el) return false
        const txt = el.textContent || ''
        const n = (label) => {
          const m = new RegExp(label + '\\s*(\\d+)').exec(txt)
          return m ? Number(m[1]) : NaN
        }
        return n('在传') === exp.active && n('待处理') === exp.stalled && n('已缓存') === exp.done
      },
      { timeout: 10000, args: ['[data-testid="tg-ingest-status"]', exp] },
    ).catch(() => {})
    await page.screenshot(path.join(OUT, '01_entry_tg_view.png'))

    // ---- A1 ----
    const entryText = await page.evaluate(TEXTOF, '[data-testid="tg-cache-manager-entry"]')
    check('A1 entry button', (entryText || '').includes('入库流水线'), `text=${JSON.stringify(entryText)}`)

    // ---- A2 计数 ----
    const statusText = await page.evaluate(TEXTOF, '[data-testid="tg-ingest-status"]')
    const num = (label) => {
      const m = new RegExp(label + '\\s*(\\d+)').exec(statusText || '')
      return m ? Number(m[1]) : NaN
    }
    const got = { active: num('在传'), stalled: num('待处理'), done: num('已缓存') }
    console.log('DOM 计数:', JSON.stringify(got))
    check(
      'A2 counts match API',
      got.active === exp.active && got.stalled === exp.stalled && got.done === exp.done,
      `dom=${JSON.stringify(got)} api=${JSON.stringify({ active: exp.active, stalled: exp.stalled, done: exp.done })}`,
    )

    // ---- A5 入口上没有条目级跳转（本轮续裁的核心）----
    const hasGoDl = await page.evaluate(HAS, '[data-testid="tg-ingest-go-download"]')
    const hasGoLib = await page.evaluate(HAS, '[data-testid="tg-ingest-go-library"]')
    const wantAbsent = !NEGATE
    check(
      'A5 no item-level jumps on entry',
      hasGoDl === !wantAbsent && hasGoLib === !wantAbsent,
      `go-download present=${hasGoDl} go-library present=${hasGoLib} (期望都不存在)`,
    )

    // ---- A3 点入口 = 弹窗（不是跳转）----
    await page.evaluate(CLICK, '[data-testid="tg-cache-manager-entry"]')
    let dialogUp = true
    try {
      await page.waitForFunction((s) => Boolean(document.querySelector(s)), {
        timeout: 6000,
        args: ['[data-testid="cache-manager-overlay"]'],
      })
    } catch (_e) {
      dialogUp = false
    }
    const titleAfterOpen = await page.evaluate(TEXTOF, '[data-testid="page-title"]')
    await page.screenshot(path.join(OUT, '02_dialog_opened.png'))
    check('A3 opens dialog', dialogUp, `cache-manager-overlay present=${dialogUp}`)
    check(
      'A3b no navigation',
      titleAfterOpen === (NEGATE ? '全部下载' : 'Telegram'),
      `page-title=${JSON.stringify(titleAfterOpen)}`,
    )

    // ---- A4 关面板 ----
    await page.evaluate(CLICK, '[data-testid="cache-close"]')
    let closed = false
    try {
      await page.waitForFunction((s) => !document.querySelector(s), {
        timeout: 6000,
        args: ['[data-testid="cache-manager-overlay"]'],
      })
      closed = true
    } catch (_e) {
      closed = false
    }
    check('A4 dialog closes', closed, `overlay gone=${closed}`)

    // ---- A6 最窄窗口零重叠 ----
    await page.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 900, height: 800, deviceScaleFactor: 1, mobile: false },
      { sessionId: page.sessionId },
    )
    await new Promise((r) => setTimeout(r, 900))
    const narrow = await page.evaluate(() => {
      const e = document.querySelector('[data-testid="tg-cache-manager-entry"]')
      const s = document.querySelector('[data-testid="tg-global-search"]')
      const bar = document.querySelector('[data-testid="context-bar"]')
      const R = (el) => (el ? el.getBoundingClientRect() : null)
      const eb = R(e)
      const sb = R(s)
      return {
        entryW: eb ? Math.round(eb.width) : null,
        overlap: eb && sb ? Math.max(0, Math.round(sb.right - eb.left)) : null,
        barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null,
        clipped: eb ? eb.right > window.innerWidth : null,
      }
    })
    console.log('900px 测量:', JSON.stringify(narrow))
    await page.screenshot(path.join(OUT, '03_narrow_900.png'))
    check(
      'A6 no overlap at 900px',
      narrow.overlap === (NEGATE ? 1 : 0) && narrow.barOverflow === 0 && narrow.clipped === false,
      JSON.stringify(narrow),
    )
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${NEGATE ? '[NEGATE] ' : ''}TOTAL ${results.length}  FAIL ${failed.length}`)
  console.log('shots ->', OUT)
  if (NEGATE) {
    if (failed.length === 0) {
      console.log('NEGATE-MODE VIOLATION: 喂错值却全绿 —— 断言无效')
      process.exit(2)
    }
    console.log('NEGATE OK: 喂错值已 FAIL（断言有效）')
    process.exit(0)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('PROBE ERROR:', e && e.stack ? e.stack : e)
  process.exit(3)
})
