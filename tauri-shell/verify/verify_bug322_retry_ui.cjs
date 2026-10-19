'use strict'
/**
 * BUG-322 活栈 UI 验收：停住的下载行上，「重试」必须是**看得见、点得动、真的重跑**。
 *
 * 本脚本补 API 验收（`scripts/verify_bug322_engine_retry.py`）证不到的那一半：
 * 接口对不等于用户能用 —— 按钮藏在 hover 后面、文案含糊成「继续」，接口再对
 * 用户也够不着（BUG-320 同型教训）。
 *
 * 判据（每条都要「有值 + 具体值」，不许「不等于旧值」式假绿）：
 *   A1 终态行渲染出来（data-status=interrupted|error|cancelled 之一）；
 *   A2 「重试」按钮存在且是 <button>（不是装饰元素）；
 *   A3 按钮**未 hover 也可见**：容器 opacity=1、rect 非 0、字号 ≥ 11px；
 *   A4 按钮文案是「重试」（不是裸图标）；
 *   A5 按钮直说了「从 0 重新下载」（不把无真续传冒充成「继续」）；
 *   A6 状态徽标是「已中断/已取消/错误」，**不是**「空闲」（statusMeta 覆盖）；
 *   A7 点它 ⇒ 该行真变成「下载中」（UI 与接口双证）；
 *   A8 反向：在途行的按钮仍然 hover 才显示（不因为改了终态就一改全改）。
 *
 * 验牙：把按钮容器的常驻 `opacity-100` 改回 `opacity-0 group-hover:opacity-100`，
 * A3 必须转红（有尺寸但不可见 = 恒绿陷阱）。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug322-retry')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON || 'http://127.0.0.1:19786'
const NAME = 'bug322ui.bin'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(DAEMON + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应按文本用 */
  }
  return { status: res.status, json, text }
}

async function waitForStack() {
  // 监督者自举后栈要几秒才起，不先等就把 ECONNREFUSED 当成验收失败。
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(DAEMON + '/health')
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function makeCancelledRow() {
  // 32 MiB @ 256 KiB/s：慢到足够在它跑完之前取消。
  const created = await api(
    'POST',
    '/api/downloads',
    { url: `mock://${NAME}?size=33554432&rate=256k`, filename: NAME },
  )
  const id = created.json && created.json.id
  if (!id) {
    console.error('    enqueue failed:', created.status, created.text)
    return null
  }
  // 跑起来一点再取消，确保它真的是「在途中被叫停」而不是没开始。
  await new Promise((r) => setTimeout(r, 1200))
  await api('POST', `/api/downloads/${id}?action=cancel`)
  await new Promise((r) => setTimeout(r, 2000)) // 等后台收尾落终态并让出句柄
  return id
}

async function rowFromApi(id) {
  const res = await api('GET', '/api/downloads')
  const list = Array.isArray(res.json) ? res.json : []
  return list.find((r) => r.id === id) || null
}

async function cleanup(id) {
  if (id) await api('DELETE', `/api/downloads/${id}`)
  const files = await api('GET', '/api/files')
  const list = (files.json && files.json.files) || []
  for (const f of list) {
    if ((f.name || '').includes('bug322')) {
      await api('DELETE', '/api/files?path=' + encodeURIComponent(f.path))
    }
  }
}

async function main() {
  const fs = require('node:fs')
  fs.mkdirSync(OUT, { recursive: true })

  if (!(await waitForStack())) {
    console.log('HAS FAIL: 0/0（daemon 没起来，活栈验收无从谈起）')
    return 1
  }
  const id = await makeCancelledRow()
  if (!id) {
    console.log('HAS FAIL: 0/0（造不出终态行，无从验收）')
    return 1
  }
  console.log(`    造出终态行 id=${id}`)

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelector('[data-testid="download-item"]') !== null,
    { timeout: 20000 },
  )
  await page.evaluate(() => {
    window.__q = (sel) => document.querySelector(sel)
    window.__all = (sel) => Array.from(document.querySelectorAll(sel))
  })

  // ── A1：终态行渲染出来了 ──
  const stalled = await page.evaluate(
    (tid) => {
      const el = document.querySelector(`[data-status][data-fid="${tid}"]`) ||
        window.__all('[data-testid="download-item"]').find((n) =>
          (n.textContent || '').includes('bug322ui'),
        )
      if (!el) return { exists: false }
      return {
        exists: true,
        status: el.getAttribute('data-status'),
        text: (el.textContent || '').trim().slice(0, 200),
      }
    },
    id,
  )
  check(
    `A1 终态行渲染出来（data-status=${stalled.status}）`,
    stalled.exists && ['interrupted', 'error', 'cancelled'].includes(stalled.status),
    JSON.stringify(stalled),
  )

  // ── A2..A5：按钮本身 ──
  const btn = await page.evaluate(() => {
    const el = window.__q('[data-testid="download-retry"]')
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const parent = el.parentElement
    const pcs = parent ? getComputedStyle(parent) : null
    return {
      exists: true,
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      title: el.getAttribute('title'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      fontSize: parseFloat(cs.fontSize),
      opacity: cs.opacity,
      visibility: cs.visibility,
      // 容器才是 hover 显隐的那一层：按钮自身 opacity 恒 1，看容器才验得出来。
      parentOpacity: pcs ? pcs.opacity : null,
    }
  })

  check(
    `A2 「重试」存在且是 <button>（实到 <${btn.tag || 'none'}>）`,
    btn.exists && btn.tag === 'BUTTON',
    JSON.stringify(btn),
  )
  check(
    `A3 未 hover 也可见：${btn.w}x${btn.h}px、字号 ${btn.fontSize}px、按钮 opacity ${btn.opacity}、容器 opacity ${btn.parentOpacity}`,
    btn.exists &&
      btn.w > 0 &&
      btn.h > 0 &&
      btn.fontSize >= 11 &&
      btn.opacity === '1' &&
      btn.visibility === 'visible' &&
      btn.parentOpacity === '1',
    JSON.stringify(btn),
  )
  check(`A4 文案是「重试」（实到「${btn.text}」）`, btn.text === '重试', JSON.stringify(btn))
  check(
    `A5 直说「从 0 重新下载」（title=「${btn.title}」）`,
    (btn.title || '').includes('从 0 重新下载'),
    JSON.stringify(btn),
  )

  // ── A6：状态徽标不是「空闲」──
  const badge = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-fid="${tid}"]`)
    if (!el) return null
    const t = (el.textContent || '')
    return {
      hasIdle: t.includes('空闲'),
      hasStalledWord: ['已中断', '已取消', '错误'].some((w) => t.includes(w)),
      text: t.slice(0, 120),
    }
  }, id)
  check(
    `A6 徽标是终态词不含「空闲」（hasIdle=${badge && badge.hasIdle} hasStalledWord=${badge && badge.hasStalledWord}）`,
    badge && badge.hasStalledWord && !badge.hasIdle,
    JSON.stringify(badge),
  )

  await page.screenshot(path.join(OUT, '01-stalled-row-retry-visible.png'))

  // ── A7：点它，行真的开始跑 ──
  await page.evaluate(() => {
    const el = window.__q('[data-testid="download-retry"]')
    if (el) el.click()
  })
  // 采序列而不是只看一个时点：只看终值会在「先 downloading 后被人改写」的情况下
  // 拿到最后一个值却说不清是谁改的。
  const seq = []
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    const r = await rowFromApi(id)
    seq.push(r ? r.status : 'none')
  }

  const afterUi = await page.evaluate(
    (tid) => {
      const el = document.querySelector(`[data-fid="${tid}"]`)
      return el ? el.getAttribute('data-status') : null
    },
    id,
  )
  const afterApi = await rowFromApi(id)
  check(
    `A7 点「重试」后真的开始跑：序列=${seq.join('>')} UI=${afterUi}`,
    seq[0] === 'downloading' && afterUi === 'downloading',
    JSON.stringify({ seq, afterUi, api: afterApi && afterApi.status }),
  )
  await page.screenshot(path.join(OUT, '02-after-retry-downloading.png'))

  // ── A8：在途行的按钮仍 hover 才显示（改动没有一改全改）──
  const live = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-fid="${tid}"]`)
    if (!el) return null
    // 在途行没有「重试」按钮（actions 里不含它），故取「暂停」按钮的容器 ——
    // hover 显隐挂在这一层容器上。
    const any = el.querySelector('[data-testid="download-retry"]') ||
      Array.from(el.querySelectorAll('button')).find((b) => (b.textContent || '').includes('暂停'))
    return any && any.parentElement ? getComputedStyle(any.parentElement).opacity : null
  }, id)
  check(
    `A8 在途行动作容器回到 hover 显隐（opacity=${live}）`,
    live === '0',
    JSON.stringify({ live }),
  )

  await cleanup(id)
  const leftover = await rowFromApi(id)
  check(`A9 清理后记录消失（left=${leftover ? leftover.status : 'none'}）`, !leftover)

  await browser.close()

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}: ${pass}/${pass + fail}`)
  return fail === 0 ? 0 : 1
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error('FATAL', e)
    process.exit(1)
  })
