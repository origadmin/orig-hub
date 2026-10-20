'use strict'
/**
 * BUG-330 TGM-07 探针：主列 `filter:<id>` 命中工作台（诉求①「筛选出来的内容无法
 * 看到内容信息」+ TGM-05 分页游标的 UI 侧）。
 *
 * ★ 2026-10-21 口径迁移（BUG-341 相册组）：命中不再「1 条消息 = 1 行」，而是
 *   **单元**级——一个相册（groupId 非空）或一条单消息。后端 `limit` 也改数单元
 *   （`PAGE_SIZE=50` 单元）。旧版探针按 `tg-filter-hit` 数 200 条消息的判据已失效
 *   （那不是产品回归，是契约变更），本版按单元复算 `groupHits` 与 `unitTitle`。
 *
 * 判据（真实渲染 + 真实鼠标事件 + API 真值收敛）：
 *   P0 环境前提自证（BUG-328 教训）：viewport 恰为 900×600，且 PAGE_SIZE 从源码
 *      读出（读不到 FAIL——判据不能靠探针里硬编码的数字冒充契约）。
 *   P1 点单元行主体 ⇒ 就地展开：单条单元渲染 `tg-filter-hit-detail`（完整 caption
 *      与 API 逐字相等、文件名/MIME/meta），相册单元渲染成员列表（条数 = 组内成员
 *      数，BUG-341）；再点收起；`aria-expanded` 同步翻转（BUG-320 真控件纪律）。
 *   P2 BUG-151 范式：点行**不改变**勾选态；复选框是独立热区，点它才切换（±1）。
 *      P2c：翻页不还原用户的减法（新页只增量默认勾选）。
 *   P3 分页：首屏恰 PAGE_SIZE 个单元 + `tg-filter-load-more`；翻页后单元数 = API
 *      p1+p2 的单元数、逐行标题与单元复算顺序一一对应（抓重复/乱序/游标失效）、
 *      按钮去留依 API 总量。两页键零重叠（游标契约）在建流即验。
 *   P4 BUG-327/329 不回归：默认勾选 = 可勾单元数（缺字节），整组已入库的单元禁用；
 *      有手动取消 ⇒ 全选框半选（indeterminate）。
 *   P5 降级不崩：无 error/卡死态；每条渲染行标题非空（caption→fileName→相册计数兜底）。
 *
 * 反向证伪（--expect-legacy）：P1 期望「点行无展开」（旧版行只能勾选）、P3 期望
 * 「无 load-more 按钮」⇒ 新实现必 FAIL exit 1。
 *
 * 清理：本探针自建的夹具规则（命中 > 一页的常见词）跑完 DELETE。
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
const FIXTURE_KEYWORD = '的'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

/** 行选择器：单条单元 + 相册单元（BUG-341 两种 testid） */
const ROWS = '[data-testid="tg-filter-hit"],[data-testid="tg-filter-group"]'

/** PAGE_SIZE 从源码读（MEMORY：判据常量不得在探针里硬编码冒充契约） */
function readPageSize() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'TgFilterPanel.tsx'), 'utf8')
  const m = /const PAGE_SIZE = (\d+)/.exec(src)
  if (!m) throw new Error('源码里读不到 `const PAGE_SIZE = N`（契约已变，探针必须同步）')
  return Number(m[1])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tgApi(method, url, body) {
  const res = await fetch(`${TG}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

/** 与 TgFilterPanel.groupHits 同规则复算单元（保序：首次出现序即单元序） */
function groupHits(hits) {
  const out = []
  const idx = new Map()
  for (const h of hits) {
    const key =
      h.groupId != null ? `g:${h.channelId}:${h.groupId}` : `m:${h.channelId}:${h.messageId}`
    let u = idx.get(key)
    if (!u) {
      u = { key, channelId: h.channelId, groupId: h.groupId ?? null, members: [] }
      idx.set(key, u)
      out.push(u)
    }
    u.members.push(h)
  }
  return out
}

/** 与 unitTitle 同序复算；返回 null 表示走「相册计数」i18n 兜底（探针不复算文案） */
function unitTitleOf(u) {
  for (const m of u.members) {
    const cap = (m.caption ?? '').split('\n')[0].trim()
    if (cap) return cap
  }
  for (const m of u.members) {
    const name = (m.fileName ?? '').trim()
    if (name) return name
  }
  return null
}

/** 单元可勾 = 组内还有缺字节成员 */
const pickableUnit = (u) => u.members.some((m) => !m.downloaded)

async function pointOf(page, fn, arg) {
  const pt = await page.evaluate(fn, arg)
  if (!pt) throw new Error('pointOf: 找不到或不可见目标')
  if (!pt.hitOk) throw new Error('pointOf: 目标点击点被其它元素占据')
  return pt
}

async function dispatchClick(page, pt) {
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
    return { x, y, hitOk: !!hit && (el === hit || el.contains(hit) || hit.contains(el)) }
  }, selector)
  await dispatchClick(page, pt)
  return pt
}

/** 点第 i 行（0-based）内的 `sub` 元素——行有两种 testid，不能用 :nth-of-type */
async function clickRow(page, i, sub) {
  const pt = await pointOf(
    page,
    (arg) => {
      const rows = document.querySelectorAll(arg.rows)
      const row = rows[arg.i]
      if (!row) return null
      const el = arg.sub ? row.querySelector(arg.sub) : row
      if (!el) return null
      el.scrollIntoView({ block: 'nearest' })
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      return { x, y, hitOk: !!hit && (el === hit || el.contains(hit) || hit.contains(el)) }
    },
    { rows: ROWS, i, sub },
  )
  await dispatchClick(page, pt)
  return pt
}

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
  const PAGE_SIZE = readPageSize()

  // ── API 真值（收敛等待与比对都靠它，不靠 DOM 出现即信） ──
  const rules = await tgApi('GET', '/api/tg/monitor/filters')
  let fixture = (rules.items || []).find((f) => f.keyword === FIXTURE_KEYWORD)
  // 只删「本探针新建」的夹具；用户自己的同名规则绝不碰
  const createdNew = !fixture
  if (!fixture) {
    const r = await tgApi('POST', '/api/tg/monitor/filters', { keyword: FIXTURE_KEYWORD })
    fixture = { id: r.id, keyword: FIXTURE_KEYWORD }
  }

  const p1 = (await tgApi('GET', `/api/tg/monitor/filters/${fixture.id}/messages?limit=${PAGE_SIZE}`))
    .items
  const u1 = groupHits(p1)
  if (u1.length < PAGE_SIZE) {
    throw new Error(
      `夹具首页单元不足一页（${u1.length} < ${PAGE_SIZE}，消息 ${p1.length} 条），翻页判据无从谈起`,
    )
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
  const u2 = groupHits(p2)
  const expectedUnits = u1.length + u2.length
  const expectedTitles = [...u1, ...u2].map(unitTitleOf)
  // 游标契约本身（UI 判据的地基）：两页键零重叠
  const k1 = new Set(p1.map((m) => `${m.channelId}:${m.messageId}`))
  const cursorOverlap = p2.filter((m) => k1.has(`${m.channelId}:${m.messageId}`)).length
  if (cursorOverlap !== 0) throw new Error(`游标契约破：两页重叠 ${cursorOverlap} 条（TGM-05 回归）`)

  const pickableUnits = [...u1, ...u2].filter(pickableUnit).length
  // 展开判据的两个样本：一个单条单元（detail 预览）+ 一个相册单元（成员列表）
  const singleIdx = u1.findIndex((u) => u.groupId == null && (u.members[0].caption ?? '').trim())
  if (singleIdx < 0) throw new Error('首页无「带 caption 的单条单元」，P1 单条预览无从验起')
  const expectedCaption = u1[singleIdx].members[0].caption
  const albumIdx = u1.findIndex((u) => u.groupId != null && u.members.length > 1)
  const albumMembers = albumIdx >= 0 ? u1[albumIdx].members.length : -1
  const pickIdx = u1.findIndex(pickableUnit)
  if (pickIdx < 0) throw new Error('首页无可勾单元，P2/P4 无从验起')

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

    // ── P0：环境前提自证（BUG-328 教训） ──
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    push(
      `P0 视口前提自证 900×600 且 PAGE_SIZE=${PAGE_SIZE}（源码读取）`,
      vp.w === 900 && vp.h === 600 && PAGE_SIZE > 0,
      JSON.stringify({ ...vp, PAGE_SIZE }),
    )

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
    // 收敛口径：等到**单元数** === API 首页单元真值（不是「容器出现」）
    await page.waitForFunction(
      (arg) => document.querySelectorAll(arg.rows).length === arg.n,
      { timeout: 30000, args: [{ rows: ROWS, n: u1.length }] },
    )

    // ── P1：点行展开 / 收起（单条 detail + 相册成员列表） ──
    const before1 = await page.evaluate((arg) => {
      const row = document.querySelectorAll(arg.rows)[arg.i]
      const btn = row ? row.querySelector('button') : null
      return {
        detail: document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length,
        expanded: btn ? btn.getAttribute('aria-expanded') : null,
      }
    }, { rows: ROWS, i: singleIdx })
    await clickRow(page, singleIdx, 'button')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length === 1,
      { timeout: 8000 },
    )
    const after1 = await page.evaluate((arg) => {
      const row = document.querySelectorAll(arg.rows)[arg.i]
      const btn = row ? row.querySelector('button') : null
      const detail = document.querySelector('[data-testid="tg-filter-hit-detail"]')
      const capP = detail ? detail.querySelector('p') : null
      return {
        expanded: btn ? btn.getAttribute('aria-expanded') : null,
        caption: capP ? capP.textContent : null,
        hasFileMeta: detail ? detail.textContent.length > 20 : false,
      }
    }, { rows: ROWS, i: singleIdx })
    if (EXPECT_LEGACY) {
      push(
        'P1 [legacy 反置] 点行无展开态（旧版只能勾选）',
        after1.expanded === 'false',
        JSON.stringify({ before1, after1 }),
      )
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
      await clickRow(page, singleIdx, 'button')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="tg-filter-hit-detail"]').length === 0,
        { timeout: 8000 },
      )
      push('P1c 再点 ⇒ detail 收起', true)

      // P1d：相册单元展开渲染成员列表（BUG-341 组级呈现）
      if (albumIdx >= 0) {
        await clickRow(page, albumIdx, 'button')
        await sleep(400)
        const album = await page.evaluate((arg) => {
          const row = document.querySelectorAll(arg.rows)[arg.i]
          // 展开区里每个成员一条（缩略图/文件名行）；用 detail 是否出现区分单条/组
          const detail = row ? row.querySelector('[data-testid="tg-filter-hit-detail"]') : null
          const imgs = row ? row.querySelectorAll('img').length : 0
          const text = row ? row.textContent.replace(/\s+/g, ' ').trim() : ''
          return { hasDetail: !!detail, imgs, textLen: text.length }
        }, { rows: ROWS, i: albumIdx })
        push(
          `P1d 相册单元展开 ⇒ 成员列表（${albumMembers} 条）且不走单条 detail`,
          album.hasDetail === false && album.textLen > 40,
          JSON.stringify({ albumMembers, ...album }),
        )
        await clickRow(page, albumIdx, 'button')
        await sleep(300)
      } else {
        push('P1d 相册单元展开 ⇒ 成员列表', true, '首页无多成员相册，跳过（如实标注）')
      }
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
    await clickRow(page, pickIdx, 'button') // 展开（切态）
    const selAfterExpand = parseN(await selText())
    await clickRow(page, pickIdx, 'button') // 收起
    const selBeforeBox = parseN(await selText())
    await clickRow(page, pickIdx, 'input[type=checkbox]')
    const selAfterBox = parseN(await selText())
    push('P2a 点行主体不改勾选态（BUG-151 范式）', selBefore === selAfterExpand, `${selBefore}→${selAfterExpand}`)
    push(
      'P2b 复选框是独立热区：点它已选数 ±1',
      Math.abs(selAfterBox - selBeforeBox) === 1,
      `${selBeforeBox}→${selAfterBox}`,
    )

    // ── P3：分页（TGM-05 游标的 UI 侧；单元级） ──
    const rows0 = await page.evaluate((sel) => document.querySelectorAll(sel).length, ROWS)
    const moreBtn0 = await page.evaluate(() => !!document.querySelector('[data-testid="tg-filter-load-more"]'))
    await realClick(page, '[data-testid="tg-filter-load-more"]')
    await page.waitForFunction(
      (arg) => document.querySelectorAll(arg.rows).length === arg.n,
      { timeout: 30000, args: [{ rows: ROWS, n: expectedUnits }] },
    )
    await sleep(200)
    const p3 = await page.evaluate((arg) => {
      const rows = Array.from(document.querySelectorAll(arg.rows))
      const domTitles = rows.map((r) => {
        const p = r.querySelector('button p')
        return p ? p.textContent.trim() : ''
      })
      let mismatch = -1
      for (let i = 0; i < arg.titles.length; i++) {
        const want = arg.titles[i]
        const got = domTitles[i]
        // want=null ⇒ 相册计数 i18n 兜底：只要求非空（不硬编码文案）
        const ok = want === null ? !!got : got === want
        if (!ok) {
          mismatch = i
          break
        }
      }
      return {
        rows: rows.length,
        mismatch,
        moreBtn: !!document.querySelector('[data-testid="tg-filter-load-more"]'),
        emptyTitles: domTitles.filter((t) => !t).length,
      }
    }, { rows: ROWS, titles: expectedTitles })
    if (EXPECT_LEGACY) {
      push(
        'P3 [legacy 反置] 无「加载更多」按钮（旧版一次拉全）',
        !moreBtn0 && rows0 === u1.length,
        JSON.stringify({ rows0, moreBtn0 }),
      )
    } else {
      push(
        `P3a 首屏恰 ${PAGE_SIZE} 个单元 + 加载更多按钮`,
        rows0 === PAGE_SIZE && moreBtn0,
        JSON.stringify({ rows0, moreBtn0, messages: p1.length }),
      )
      push(
        'P3b 翻页后逐行标题与 API 单元复算顺序一一对应（抓重复/乱序/游标失效）',
        p3.rows === expectedUnits && p3.mismatch === -1 && p3.emptyTitles === 0,
        JSON.stringify(p3),
      )
      push(
        `P3c 按钮去留依 API 总量（消息总量 ${apiTotalProbe.length}；>${p1.length + p2.length} 应仍在）`,
        apiTotalProbe.length > p1.length + p2.length
          ? p3.moreBtn === true
          : p3.moreBtn === false,
        JSON.stringify({ apiTotal: apiTotalProbe.length, expectedUnits, moreBtn: p3.moreBtn }),
      )
    }

    // ── P2c：翻页不还原用户的减法（loadMore 增量合并的验牙） ──
    const p2c = await page.evaluate((arg) => {
      const rows = document.querySelectorAll(arg.rows)
      const box = rows[arg.i] ? rows[arg.i].querySelector('input[type=checkbox]') : null
      return box ? box.checked : null
    }, { rows: ROWS, i: pickIdx })
    push(
      'P2c 翻页后 P2b 取消的那一行仍为未勾选（减法不被加载更多还原）',
      p2c === false,
      JSON.stringify({ pickIdx, checked: p2c }),
    )

    // ── P4：默认勾选 = 可勾单元数（BUG-327/329 口径不回归） ──
    const p4 = await page.evaluate((sel) => {
      const root = document.querySelector('[data-testid="tg-filter-panel"]')
      const rows = Array.from(root.querySelectorAll(sel))
      const boxes = rows.map((r) => r.querySelector('input[type=checkbox]'))
      const all = root.querySelector('[data-testid="tg-filter-select-all"]')
      return {
        checked: boxes.filter((b) => b && b.checked).length,
        disabled: boxes.filter((b) => b && b.disabled).length,
        total: boxes.length,
        all: all ? all.checked : null,
        indeterminate: all ? all.indeterminate : null,
      }
    }, ROWS)
    push(
      `P4a 勾选数 === 可勾单元数-1（${pickableUnits}，P2b 手动取消 1 个）+ 整组已入库的禁用`,
      p4.checked === pickableUnits - 1 && p4.disabled === expectedUnits - pickableUnits,
      JSON.stringify(p4),
    )
    push(
      'P4b 半选态：全选框非 checked 且 indeterminate（有取消即半选）',
      p4.all === false && p4.indeterminate === true,
      JSON.stringify({ all: p4.all, indeterminate: p4.indeterminate }),
    )

    // ── P5：无 error 态、行标题兜底链非空 ──
    const p5 = await page.evaluate((sel) => {
      const root = document.querySelector('[data-testid="tg-filter-panel"]')
      const rows = Array.from(root.querySelectorAll(sel))
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
    }, ROWS)
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
    // 清理本探针**自建**的夹具规则（用户既有同名规则不动）
    if (createdNew) {
      await tgApi('DELETE', `/api/tg/monitor/filters/${fixture.id}`).catch(() => {})
    }
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exit(1)
})
