'use strict'
/**
 * BUG-330 TGM-07 探针：主列 `filter:<id>` 命中工作台重做（诉求①「筛选出来的内容
 * 无法看到内容信息」+ TGM-05 分页游标的 UI 侧）。
 *
 * 判据（真实渲染 + 真实鼠标事件 + API 真值收敛）：
 *   P0 环境前提自证（BUG-328 教训）：viewport 恰为 900×600——「先改环境再测量」
 *      的判据必须断言前提本身，否则结论恒真。
 *   P1 点命中行主体 ⇒ 就地展开 `tg-filter-hit-detail`：完整 caption（与 API 逐字
 *      相等，不再被行内 truncate 截断）+ 文件名/MIME/meta；再点收起；
 *      `aria-expanded` 同步翻转（BUG-320 真控件纪律）。
 *   P2 BUG-151 范式：点行**不改变**勾选态（已选数不变）；复选框是独立热区，
 *      点它才切换（±1）。P2c：翻页不还原用户的减法（新页只增量默认勾选）。
 *   P3 分页：首屏恰 200 行 + `tg-filter-load-more`；点击后 400 行、逐行标题与
 *      API p1+p2 顺序一一对应（抓重复/乱序/游标失效三类回归）、按钮依 API 总量
 *      决定去留；两页键零重叠（游标契约）在建流即验。
 *   P4 BUG-327/329 不回归：默认全选 = 缺字节条目数（DOM 勾选数 === API downloaded
 *      真值）；有手动取消 ⇒ 全选框半选（indeterminate）。
 *   P5 降级不崩：无 error 态；每条渲染行标题非空（caption→fileName→#id 兜底链）。
 *
 * 反向证伪（--expect-legacy）：P1 期望「点行无 detail」（旧版行只能勾选）、
 * P3 期望「无 load-more 按钮」⇒ 新实现必 FAIL exit 1。
 *
 * 清理：本探针用的「的」规则（命中 500+ 的分页夹具）跑完 DELETE。
 *
 * 用法：node tauri-shell/verify/_probe_tgm07_filter_hits.cjs [--expect-legacy]
 * 前置：dev 5180 + daemon 19786（orig-tg 19787，须含 TGM-05 serde rename 修复）。
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tgm07-filter-hits')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const PAGE_SIZE = 200
const FIXTURE_KEYWORD = '的'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tgApi(method, url, body) {
  const res = await fetch(`${TG}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

/** 标题兜底链（与 TgFilterPanel.hitTitle 同序复算，供 DOM↔API 逐行比对） */
function hitTitle(h) {
  const cap = (h.caption ?? '').split('\n')[0].trim()
  if (cap) return cap
  const name = (h.fileName ?? '').trim()
  if (name) return name
  return `#${h.messageId}`
}

async function pointOf(page, fn, ...args) {
  const pt = await page.evaluate(fn, ...args)
  if (!pt) throw new Error('pointOf: 找不到或不可见目标')
  if (!pt.hitOk) throw new Error('pointOf: 目标点击点被其它元素占据')
  return pt
}

async function realClick(page, selector) {
  const pt = await pointOf(page, (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, hitOk: !!hit && (el === hit || el.contains(hit)) }
  }, selector)
  const conn = page.conn || page._conn
  const sessionId = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send(
      'Input.dispatchMouseEvent',
      { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 },
      { sessionId },
    )
  }
  await sleep(320)
  return pt
}

/** 第 n 行（1-based）命中行内的选择器（行是 hits 容器里唯一的 div 子元素序列） */
const hitRow = (n, sub) =>
  `[data-testid="tg-filter-hit"]:nth-of-type(${n})${sub || ''}`

async function openTgPanel(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0,
    { timeout: 30000 },
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  // ── API 真值（收敛等待与比对都靠它，不靠 DOM 出现即信） ──
  const rules = await tgApi('GET', '/api/tg/monitor/filters')
  let fixture = (rules.items || []).find((f) => f.keyword === FIXTURE_KEYWORD)
  const created = []
  if (!fixture) {
    const r = await tgApi('POST', '/api/tg/monitor/filters', { keyword: FIXTURE_KEYWORD })
    fixture = { id: r.id, keyword: FIXTURE_KEYWORD }
  }
  created.push(fixture.id)
  const p1 = (await tgApi('GET', `/api/tg/monitor/filters/${fixture.id}/messages?limit=${PAGE_SIZE}`)).items
  if (p1.length < PAGE_SIZE) {
    throw new Error(`夹具命中不足一页（${p1.length} < ${PAGE_SIZE}），翻页判据无从谈起`)
  }
  const last = p1[p1.length - 1]
  const p2 = (
    await tgApi(
      'GET',
      `/api/tg/monitor/filters/${fixture.id}/messages?limit=${PAGE_SIZE}` +
        `&beforeDate=${last.date}&beforeChannelId=${last.channelId}&beforeMessageId=${last.messageId}`,
    )
  ).items
  const apiTotalProbe = (
    await tgApi('GET', `/api/tg/monitor/filters/${fixture.id}/messages?limit=500`)
  ).items
  const expectedRows = p1.length + p2.length
  const expectedTitles = [...p1, ...p2].map(hitTitle)
  // 游标契约本身（UI 判据的地基）：两页键零重叠、拼接单调不增
  const k1 = new Set(p1.map((m) => `${m.channelId}:${m.messageId}`))
  const cursorOverlap = p2.filter((m) => k1.has(`${m.channelId}:${m.messageId}`)).length
  if (cursorOverlap !== 0) throw new Error(`游标契约破：两页重叠 ${cursorOverlap} 条（TGM-05 回归）`)
  const pickableCount = [...p1, ...p2].filter((h) => !h.downloaded).length
  const expandIdx = p1.findIndex((h) => (h.caption ?? '').trim().length > 0)
  if (expandIdx < 0) throw new Error('首页 200 行无一带 caption，P1 无从验起')
  const expectedCaption = p1[expandIdx].caption

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    await page.goto(APP)

    const results = []
    const problems = []
    const push = (name, ok, detail) => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) problems.push(name)
    }

    // ── P0：环境前提自证（视口必须真的是 900×600） ──
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    push('P0 视口前提自证 900×600', vp.w === 900 && vp.h === 600, JSON.stringify(vp))

    await openTgPanel(page)
    await sleep(400)

    // 用节内检索框把夹具规则孤立出来（唯一行 ⇒ 选择器唯一）
    await page.evaluate((kw) => {
      const s = document.querySelector('[data-testid="tg-filter-search"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(s, kw)
      s.dispatchEvent(new Event('input', { bubbles: true }))
    }, FIXTURE_KEYWORD)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-filter-row"]').length === 1,
      { timeout: 10000 },
    )
    await realClick(page, '[data-testid="tg-filter-row"] button')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
      { timeout: 15000 },
    )
    // 收敛口径：等到行数 === API 首页真值（不是「容器出现」）
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="tg-filter-hit"]').length === n,
      { timeout: 30000, args: [p1.length] },
    )

    // ── P1：点行展开 / 收起（完整 caption + aria-expanded） ──
    const n = expandIdx + 1
    const before1 = await page.evaluate((nn) => {
      const row = document.querySelectorAll('[data-testid="tg-filter-hit"]')[nn - 1]
      const btn = row.querySelector('button')
      return {
        detail: document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length,
        expanded: btn.getAttribute('aria-expanded'),
      }
    }, n)
    await realClick(page, hitRow(n, ' button'))
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length === 1,
      { timeout: 8000 },
    )
    const after1 = await page.evaluate((nn) => {
      const row = document.querySelectorAll('[data-testid="tg-filter-hit"]')[nn - 1]
      const btn = row.querySelector('button')
      const detail = document.querySelector('[data-testid="tg-filter-hit-detail"]')
      const capP = detail ? detail.querySelector('p') : null
      return {
        expanded: btn.getAttribute('aria-expanded'),
        caption: capP ? capP.textContent : null,
        hasFileMeta: detail ? detail.textContent.length > 20 : false,
      }
    }, n)
    if (EXPECT_LEGACY) {
      push('P1 [legacy 反置] 点行无展开态（旧版只能勾选）', after1.expanded === 'false', JSON.stringify({ before1, after1 }))
    } else {
      push(
        'P1a 点行 ⇒ detail 出现 + aria-expanded 翻 true',
        before1.detail === 0 && before1.expanded === 'false' && after1.expanded === 'true',
        JSON.stringify({ before1, after1 }),
      )
      push(
        'P1b detail 渲染完整 caption（与 API 逐字相等，不被行内截断）',
        after1.caption === expectedCaption.trim() && after1.hasFileMeta,
        JSON.stringify({ dom: (after1.caption || '').slice(0, 40), api: expectedCaption.slice(0, 40) }),
      )
      await realClick(page, hitRow(n, ' button'))
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length === 0,
        { timeout: 8000 },
      )
      push('P1c 再点 ⇒ detail 收起', true)
    }

    // ── P2：点行不改勾选态；复选框独立热区 ──
    const selText = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="tg-filter-selected-count"]')
        return el ? el.textContent : ''
      })
    const parseN = (s) => {
      const m = /(\d+)/.exec(s || '')
      return m ? Number(m[1]) : -1
    }
    const selBefore = parseN(await selText())
    await realClick(page, hitRow(n, ' button')) // 展开（切态）
    const selAfterExpand = parseN(await selText())
    await realClick(page, hitRow(n, ' button')) // 收起
    // 找一行缺字节的（可勾）做复选框测试
    const pickIdx = p1.findIndex((h) => !h.downloaded)
    const np = pickIdx + 1
    const selBeforeBox = parseN(await selText())
    await realClick(page, hitRow(np, ' input[type=checkbox]'))
    const selAfterBox = parseN(await selText())
    push('P2a 点行主体不改勾选态（BUG-151 范式）', selBefore === selAfterExpand, `${selBefore}→${selAfterExpand}`)
    push('P2b 复选框是独立热区：点它已选数 ±1', Math.abs(selAfterBox - selBeforeBox) === 1, `${selBeforeBox}→${selAfterBox}`)

    // ── P3：分页（TGM-05 游标的 UI 侧） ──
    const rows0 = await page.evaluate(() => document.querySelectorAll('[data-testid="tg-filter-hit"]').length)
    const moreBtn0 = await page.evaluate(() => !!document.querySelector('[data-testid="tg-filter-load-more"]'))
    await realClick(page, '[data-testid="tg-filter-load-more"]')
    await page.waitForFunction(
      (k) => document.querySelectorAll('[data-testid="tg-filter-hit"]').length === k,
      { timeout: 30000, args: [expectedRows] },
    )
    await sleep(200)
    const p3 = await page.evaluate((titles) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-hit"]'))
      const domTitles = rows.map((r) => {
        const p = r.querySelector('button p')
        return p ? p.textContent.trim() : ''
      })
      let mismatch = -1
      for (let i = 0; i < titles.length; i++) {
        if (domTitles[i] !== titles[i]) {
          mismatch = i
          break
        }
      }
      return {
        rows: rows.length,
        mismatch,
        moreBtn: !!document.querySelector('[data-testid="tg-filter-load-more"]'),
        // 同文案行是数据属性（同一视频多频道转载），不作判据、只留档
        dupText: rows.length - new Set(rows.map((r) => r.textContent.trim())).size,
      }
    }, expectedTitles)
    if (EXPECT_LEGACY) {
      push('P3 [legacy 反置] 无「加载更多」按钮（旧版一次拉全）', !moreBtn0 && rows0 === p1.length, JSON.stringify({ rows0, moreBtn0 }))
    } else {
      push(
        `P3a 首屏恰 ${PAGE_SIZE} 行 + 加载更多按钮`,
        rows0 === PAGE_SIZE && moreBtn0,
        JSON.stringify({ rows0, moreBtn0 }),
      )
      push(
        'P3b 翻页后逐行标题与 API p1+p2 一一对应（抓重复/乱序/游标失效三类回归）',
        p3.rows === expectedRows && p3.mismatch === -1,
        JSON.stringify(p3),
      )
      push(
        `P3c 按钮去留依 API 总量（总量 ${apiTotalProbe.length}；>${expectedRows} 应仍在）`,
        apiTotalProbe.length > expectedRows ? p3.moreBtn === true : p3.moreBtn === false,
        JSON.stringify({ apiTotal: apiTotalProbe.length, expectedRows, moreBtn: p3.moreBtn }),
      )
    }

    // ── P2c：翻页不还原用户的减法（loadMore 增量合并的验牙） ──
    const p2c = await page.evaluate((nn) => {
      const rows = document.querySelectorAll('[data-testid="tg-filter-hit"]')
      const box = rows[nn - 1] ? rows[nn - 1].querySelector('input[type=checkbox]') : null
      return box ? box.checked : null
    }, np)
    push('P2c 翻页后 P2b 取消的那一行仍为未勾选（减法不被加载更多还原）', p2c === false, JSON.stringify({ np, checked: p2c }))

    // ── P4：默认全选 = 缺字节条目数（BUG-327/329 口径不回归） ──
    const p4 = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="tg-filter-panel"]')
      const rows = Array.from(root.querySelectorAll('[data-testid="tg-filter-hit"]'))
      const boxes = rows.map((r) => r.querySelector('input[type=checkbox]'))
      return {
        checked: boxes.filter((b) => b.checked).length,
        disabled: boxes.filter((b) => b.disabled).length,
        all: root.querySelector('[data-testid="tg-filter-select-all"]').checked,
        indeterminate: root.querySelector('[data-testid="tg-filter-select-all"]').indeterminate,
      }
    })
    push(
      `P4a 勾选数 === API 缺字节数-1（${pickableCount}，P2b 手动取消 1 条）`,
      p4.checked === pickableCount - 1 && p4.disabled === expectedRows - pickableCount,
      JSON.stringify(p4),
    )
    push('P4b 半选态：全选框非 checked 且 indeterminate（有取消即半选）', p4.all === false && p4.indeterminate === true, JSON.stringify(p4))

    // ── P5：无 error 态、行标题兜底链非空 ──
    const p5 = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="tg-filter-panel"]')
      const rows = Array.from(root.querySelectorAll('[data-testid="tg-filter-hit"]'))
      const emptyTitles = rows.filter((r) => {
        const p = r.querySelector('button p')
        return !p || !p.textContent.trim()
      }).length
      const header = root.querySelector('h3')
      return {
        err: (root.textContent || '').includes('筛选中…') ? 'loading-stuck' : null,
        emptyTitles,
        header: header ? header.textContent.trim() : null,
      }
    })
    push('P5 无 error/卡死态；行标题兜底链非空', !p5.err && p5.emptyTitles === 0, JSON.stringify(p5))

    await page.screenshot(path.join(OUT, 'filter-hits.png'))
    fs.writeFileSync(path.join(OUT, 'result.txt'), results.join('\n') + '\n', 'utf8')
    console.log(results.join('\n'))
    if (problems.length > 0) {
      console.log(`\nFAIL: ${problems.join(', ')}`)
      process.exitCode = 1
    } else {
      console.log('\nALL PASS')
    }
  } finally {
    for (const id of created) {
      try {
        await tgApi('DELETE', `/api/tg/monitor/filters/${id}`)
      } catch {
        /* 清理尽力而为 */
      }
    }
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
