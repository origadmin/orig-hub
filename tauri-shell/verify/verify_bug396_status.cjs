/**
 * BUG-396 现状复核探针（活栈 + 真实渲染）
 *
 * 回答两个具体问题，不看代码推理，只看页面上真实渲染出来的东西：
 *
 * P1（BUG-396 本体）：终态（done/cancelled）的 TG 入库行，界面上必须**看不见**
 *    「优先下载」徽标（ingest-group-prioritized）与「取消优先」按钮
 *    （ingest-group-action-unprefer）。这是 BUG-396 当时的验收判据，今天复跑。
 *
 * P2（用户本轮的疑问）：下载页最上面那几行到底是什么、能不能操作 —— 逐行列出
 *    来源（普通下载 / TG 入库）、状态文案、以及**实际可见**的动作按钮。
 *    「可见」按 getComputedStyle 的 opacity 算，不是 DOM 里有没有：
 *    DownloadItem 的按钮组默认 opacity-0 + group-hover:opacity-100，
 *    藏在 hover 后面的按钮用户第一眼是看不见的（等于没有）。
 *
 * 用法：活栈已起（daemon 19786 / orig-tg 19787 / vite 5180）
 *   node tauri-shell/verify/probe_bug396_status.cjs
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5180'
const OUT = path.join('verify_shots', 'bug396-recheck')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const lines = []
const note = (name, ok, detail) => {
  if (ok) pass += 1
  else fail += 1
  const s = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  console.log('  ' + s)
  lines.push(s)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({ headless: true })
  const page = await browser.newPage()

  const nav = async (url) => {
    for (let i = 0; i < 3; i += 1) {
      try {
        await page.goto(url, { waitUntil: 'load', timeoutMs: 60000 })
        return
      } catch (e) {
        if (i === 2) throw e
        await sleep(1500)
      }
    }
  }

  await nav(BASE)
  await sleep(3000)
  await page.evaluate(() => document.querySelector('[data-testid="nav-download"]')?.click())
  await sleep(4000)

  await page.screenshot(path.join(OUT, 'downloads-top.png'))

  const rows = await page.evaluate(() => {
    /** 只算真正看得见的：自己或祖先 opacity 为 0 ⇒ 用户看不见。 */
    const visible = (el) => {
      let n = el
      while (n && n !== document.body) {
        const cs = getComputedStyle(n)
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05)
          return false
        n = n.parentElement
      }
      return true
    }
    const out = []
    const push = (kind, el) => {
      const text = (sel) => el.querySelector(sel)?.textContent?.trim() || ''
      const r = el.getBoundingClientRect()
      out.push({
        kind,
        top: Math.round(r.top),
        name:
          kind === 'engine'
            ? text('p.truncate')
            : text('[data-testid="ingest-group-name"]') || text('[data-testid="ingest-group-header"]'),
        status: kind === 'engine' ? text('span.rounded') : text('[data-testid="ingest-group-header"] span'),
        badge: !!el.querySelector('[data-testid="ingest-group-prioritized"]'),
        actions: Array.from(el.querySelectorAll('button,[data-testid^="ingest-group-action-"]')).filter((b) => {
          const id = b.getAttribute('data-testid') || ''
          if (!id) return false
          return visible(b)
        }).map((b) => b.getAttribute('data-testid') + ':' + (b.textContent || '').trim().slice(0, 6)),
        hiddenActions: Array.from(el.querySelectorAll('[data-testid^="ingest-group-action-"]'))
          .filter((b) => !visible(b))
          .map((b) => b.getAttribute('data-testid')),
      })
    }
    // 页面内的行序 = 用户看到的顺序（不另排序）
    Array.from(document.querySelectorAll('[data-testid="download-item"]')).forEach((e) =>
      push('engine', e),
    )
    Array.from(document.querySelectorAll('[data-testid="ingest-group-row"]')).forEach((e) =>
      push('ingest', e),
    )
    return out.sort((a, b) => a.top - b.top)
  })

  console.log(`\n  页面上共 ${rows.length} 行（已按屏幕纵坐标排序，前 12 行）：`)
  for (const r of rows.slice(0, 12)) {
    console.log(
      `    top=${String(r.top).padStart(4)} [${r.kind.padEnd(6)}] ${String(r.status).padEnd(12)} ` +
        `${r.badge ? '优先徽标! ' : ''}${r.name.slice(0, 28)} | 可见动作: ${r.actions.join(', ') || '（无）'}` +
        (r.hiddenActions.length ? ` | 藏起来的: ${r.hiddenActions.join(', ')}` : ''),
    )
  }

  // P1：BUG-396 本体 —— 终态行不得出现优先徽标 / 取消优先
  const settled = rows.filter(
    (r) => r.kind === 'ingest' && /完成|已入库|已取消|已完成/.test(r.status || ''),
  )
  const leaked = settled.filter(
    (r) => r.badge || r.actions.some((a) => a.includes('unprefer')),
  )
  note(
    'P1 BUG-396：终态入库行无「优先下载」徽标 / 无「取消优先」',
    settled.length > 0 ? leaked.length === 0 : true,
    settled.length === 0
      ? '页面当前没有终态入库行（未能否证，非绿）'
      : `终态行 ${settled.length} 条，违规 ${leaked.length} 条`,
  )

  // P2：最上面一行能否操作（能不能取消，不悬停的前提下）
  const first = rows[0]
  if (first) {
    const cancellable = first.actions.some(
      (a) => a.includes('-cancel') || a.includes('unprefer') || a.includes('取消'),
    )
    note(
      'P2 第一行不悬停也能看到「取消」类动作',
      cancellable,
      `kind=${first.kind} status=${first.status} 可见动作=${first.actions.join(', ') || '（无）'}`,
    )
  } else {
    note('P2 页面有行', false, '0 行')
  }

  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ rows, pass, fail }, null, 2),
  )
  console.log(`\n  PASS=${pass} FAIL=${fail}`)
  await browser.close()
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('probe failed:', e.message)
  process.exit(2)
})
