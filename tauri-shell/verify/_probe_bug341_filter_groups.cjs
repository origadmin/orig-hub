'use strict'
/**
 * BUG-341 探针：筛选命中按**相册组**呈现 + 整组入库（用户 2026-10-20 夜诉求③：
 * 「筛选内容显示完全错误，显示『必须』是组数据（相册），仍显示单条错误数据、
 *   内容丢失；入库逻辑针对组数据」）。
 *
 * 判据（真实运行栈 + 真实活库相册夹具 + 真实鼠标事件 + 真实 wire 请求）：
 *   A1（后端·活库）建规则后 `GET .../filters/{id}/messages` 的**单元**口径：
 *      3 个相册 + 1 条单条；夹具相册（ch=-1004493170102,
 *      group=14315949991671397，10 名成员，组级 caption 只挂 1 条）必须
 *      **整组 10 条**全部入列——旧实现每组只回匹配到的那 1 条（内容丢失根因）。
 *   U1（前端）面板渲染 3 个 `tg-filter-group` + 1 个 `tg-filter-hit`。
 *   U2 相册行显「相册 · 10 项」且默认勾选（BUG-327：缺字节 = 要下载的）。
 *   U3 展开相册 ⇒ `tg-filter-members` 内正好 10 个 `tg-filter-member`
 *      （含 9 条**不匹配关键词**的成员——「内容丢失」的修复判据）。
 *   U4 面板内无 `—` 占位（BUG-340 回归护栏）。
 *   U5（入库 wire）点「入库」⇒ 每个**单元**一次 POST /api/tg/cache/tasks：
 *      夹具相册那次带 groupId=14315949991671397 且 messageIds 为整组 10 个
 *      （4728..4737）；单条那次不带 groupId、只 1 个 id。
 *
 * 为什么入库请求只捕获不转发：验收不搬真实用户内容的字节（相册首项是 59MB
 * 视频）。捕获的是前端**真实发出的 wire 请求**（BUG-341 修的就是这个 payload
 * 的形状）；服务端对 groupId 的接受与组键去重由引擎测试覆盖
 * （`enqueue_fixture_task(..., Some(CACHE_FIXTURE_GROUP))` 一族）。
 *
 * 验牙（--expect-legacy）：反置 A1/U2/U3/U5a 为**旧二进制可观测**形态（相册只回/
 * 只显 1 名成员、入库只带 1 个 id）⇒ 对重部署前的旧 orig-tg 必须 PASS、对新
 * orig-tg 必须 FAIL。两个方向都证，断言才有牙（禁恒绿）。
 * 注意（2026-10-20 修正）：面板必须在 U1/U2 **之前**打开，且行定位必须用
 * rowMarker——同频道（麻豆短剧）有两个相册命中同一关键词，按标题/频道名都会
 * 指错行；旧稿把开面板放在 U3 里，U1/U2 因此恒数 0 行（假阴性，非旧实现形态）。
 *
 * 清理：finally 里 DELETE 本探针建的规则。
 *
 * 用法：node tauri-shell/verify/_probe_bug341_filter_groups.cjs [--expect-legacy]
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。产物 verify_shots/bug341-filter-groups/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug341-filter-groups')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

/** 活库真实夹具（%APPDATA%/com.origadmin.orighub/tg/store.db 实证 2026-10-20）。
 *  受监控 3 频道里该关键词的全景：3 相册 + 1 单条——
 *    麻豆短剧: 组14315949991671397(10 员, 夹具) + 组14339616038980793(2 员)
 *    黄果短剧: 组14315172264914709(3 员) + 单条 1758
 *  （一个有意思的地方/镇长回忆录 的命中不在受监控集，不计入。） */
const FIXTURE = {
  channelId: -1004493170102,
  /** BUG-345：group_id > JS 2^53，字面量 number 会被舍成 …396（同款精度坑），
   *  故此处存**字符串真值**，比较一律走 normGroupId()。 */
  groupId: '14315949991671397',
  memberIds: [4728, 4729, 4730, 4731, 4732, 4733, 4734, 4735, 4736, 4737],
  /** 组级 caption（只挂 4728 一条）的首行关键词 */
  keyword: '入职第一天',
  /** 相册行标题（caption 首行） */
  title: '入职第一天',
  /** 夹具相册行的**唯一**文本标记：另一麻豆短剧相册的 caption 是
   *  「📱【入职第一天被内射】新剧首更…」、黄果相册是「🌟⚡️《…》EP1-2」，
   *  均不含「第1-2集」——同频道两个相册都含关键词，按标题/频道名都会指错行。 */
  rowMarker: '第1-2集',
}
/** 该关键词在 3 个受监控频道里的单元全景（活库实证）：3 相册 + 1 单条。 */
const EXPECT_UNITS = { groups: 3, singles: 1, total: 4 }

/** BUG-345：groupId 跨 JSON 界的形状归一化——新后端下发 string（真值），
 *  旧后端下发 number（>2^53 已被 JSON.parse 舍坏）。比较前一律过这个函数，
 *  否则「string 真值 vs number 坏值」永远配不上，断言会给出假阴性。 */
const normGroupId = (v) => (v == null ? null : String(v))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const createdFilterIds = []

async function tgApi(method, url, body) {
  const res = await fetch(`${TG}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

/** 真实鼠标点击：坐标由页面内实算（元素必须真的可点、不被遮挡）。
 *  `locatorFn` 会被字符串化后**在页面里**执行，参数经 `...args` 透传。 */
async function clickAt(page, locatorFn, ...args) {
  const pt = await page.evaluate(locatorFn, ...args)
  if (!pt) throw new Error('clickAt: 找不到或不可见目标元素')
  if (!pt.hitOk) throw new Error(`clickAt: 点击点被其它元素占据 (${pt.x},${pt.y})`)
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

/** 页面内实算「左栏含 keyword 的规则行的行首按钮」中心点。 */
const filterRowButtonPoint = (kw) => {
  const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]'))
  const row = rows.find((r) => (r.textContent || '').includes(kw))
  const btn = row ? row.querySelector('button') : null
  if (!btn) return null
  btn.scrollIntoView({ block: 'nearest' })
  const r = btn.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  const hit = document.elementFromPoint(x, y)
  return { x, y, hitOk: !!hit && (btn === hit || btn.contains(hit)) }
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
  const results = []
  const problems = []
  const push = (name, ok, detail) => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) problems.push(name)
  }

  // ── A1：后端·活库——建规则，单元口径必须整组入列 ──
  const created = await tgApi('POST', '/api/tg/monitor/filters', {
    keyword: FIXTURE.keyword,
    label: `__verify_bug341_${Date.now()}`,
  })
  const filterId = created && created.id
  if (!filterId) throw new Error(`建规则失败：${JSON.stringify(created)}`)
  createdFilterIds.push(filterId)

  const apiHits = await tgApi('GET', `/api/tg/monitor/filters/${filterId}/messages?limit=50`)
  const items = apiHits.items || []
  const groupUnits = new Set()
  const singleUnits = new Set()
  const fixtureMembers = []
  for (const h of items) {
    if (h.groupId != null) {
      groupUnits.add(`${h.channelId}:${normGroupId(h.groupId)}`)
    } else {
      singleUnits.add(`${h.channelId}:${h.messageId}`)
    }
    // 夹具相册的成员判定按**消息号归属**（channel+messageId），不按 groupId 比配：
    // 旧后端 number 形态的 groupId 已被 JS 舍坏，按值比对会得出假阴性。
    if (h.channelId === FIXTURE.channelId && FIXTURE.memberIds.includes(h.messageId)) {
      fixtureMembers.push(h.messageId)
    }
  }
  if (EXPECT_LEGACY) {
    push(
      'A1 [legacy 反置] 相册只回 1 名成员（旧实现可观测形态）',
      fixtureMembers.length === 1,
      `fixtureMembers=${JSON.stringify(fixtureMembers)}`,
    )
  } else {
    push(
      'A1 活库 API：3 相册单元 + 1 单条单元；夹具相册整组 10 条全入列',
      groupUnits.size === EXPECT_UNITS.groups &&
        singleUnits.size === EXPECT_UNITS.singles &&
        fixtureMembers.length === FIXTURE.memberIds.length &&
        FIXTURE.memberIds.every((m) => fixtureMembers.includes(m)),
      `groupUnits=${groupUnits.size} singles=${singleUnits.size} fixtureMembers=${fixtureMembers.length}`,
    )
  }

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    // vite 文件变更后首次整页加载可 >30s（与改动无关的已知现象）：导航超时放宽。
    await page.goto(APP, { timeout: 90000 })
    await openTgPanel(page)
    await sleep(400)

    // 打开筛选面板（点左栏含 keyword 的规则行行首按钮）——U1/U2/U3 全部依赖面板
    // 已展开（旧稿把这一步放在 U3 里，导致 U1/U2 在面板未开时数行 ⇒ 恒 0 行假阴性）。
    // 旧实现这里只回 1 名成员：新前端+旧后端也必须能观测到差异（验牙的 legacy 方向）。
    await clickAt(page, filterRowButtonPoint, FIXTURE.keyword)
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
      { timeout: 15000 },
    )
    // 等内容行真的渲染出来再断言（面板挂载与数据到达之间有时序差）。
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="tg-filter-group"]').length +
          document.querySelectorAll('[data-testid="tg-filter-hit"]').length >
        0,
      { timeout: 15000 },
    )

    // ── U1：组是行单位 ──
    const counts = await page.evaluate(() => ({
      groups: document.querySelectorAll('[data-testid="tg-filter-group"]').length,
      hits: document.querySelectorAll('[data-testid="tg-filter-hit"]').length,
    }))
    if (!EXPECT_LEGACY) {
      push(
        'U1 面板：3 个相册行 + 1 个单条行（组是行单位）',
        counts.groups === EXPECT_UNITS.groups && counts.hits === EXPECT_UNITS.singles,
        JSON.stringify(counts),
      )
    }

    // ── U2：相册行的成员数徽标 + 默认勾选 ──
    // 行定位用 rowMarker（夹具相册 caption 独有串）：同频道另一相册也含关键词，
    // 按标题找会指错行（活库实证：麻豆短剧有 2 个相册命中同一关键词）。
    const albumRow = await page.evaluate((fx) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-group"]'))
      const row = rows.find((r) => (r.textContent || '').includes(fx.rowMarker))
      if (!row) return null
      const cb = row.querySelector('input[type="checkbox"]')
      return {
        checked: cb ? cb.checked : null,
        badge10: (row.textContent || '').includes(`相册 · ${fx.memberIds.length} 项`),
        badge1: (row.textContent || '').includes('相册 · 1 项'),
      }
    }, FIXTURE)
    if (EXPECT_LEGACY) {
      push(
        'U2 [legacy 反置] 相册行只显 1 名成员（旧实现可观测形态）',
        !!albumRow && albumRow.badge1 && !albumRow.badge10,
        JSON.stringify(albumRow),
      )
    } else {
      push(
        'U2 相册行显「相册 · 10 项」且默认勾选',
        !!albumRow && albumRow.badge10 && albumRow.checked === true,
        JSON.stringify(albumRow),
      )
    }

    // ── U3：展开 ⇒ 整组成员可见（面板已开；行定位同 U2 用 rowMarker） ──
    await page.evaluate((marker) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-group"]'))
      const row = rows.find((r) => (r.textContent || '').includes(marker))
      const btn = row ? row.querySelector('button[aria-expanded]') : null
      if (btn) btn.click()
    }, FIXTURE.rowMarker)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-filter-member"]').length > 0,
      { timeout: 8000 },
    )
    await sleep(250)
    const members = await page.evaluate((kw) => {
      const box = document.querySelector('[data-testid="tg-filter-members"]')
      const rows = box ? Array.from(box.querySelectorAll('[data-testid="tg-filter-member"]')) : []
      return {
        total: rows.length,
        // 不匹配关键词的成员（标题行不含关键词）也必须出现在展开列表里——
        // 「内容丢失」的修复判据（旧实现这些成员根本不在结果里）。
        nonMatching: rows.filter((r) => {
          const p = r.querySelector('p')
          return p ? !(p.textContent || '').includes(kw) : false
        }).length,
      }
    }, FIXTURE.keyword)
    if (EXPECT_LEGACY) {
      push(
        'U3 [legacy 反置] 展开只有 1 名成员（旧实现可观测形态）',
        members.total === 1,
        JSON.stringify(members),
      )
    } else {
      push(
        'U3 展开相册 ⇒ 10 名成员全部可见（含 9 名不匹配关键词的）',
        members.total === FIXTURE.memberIds.length && members.nonMatching >= 9,
        JSON.stringify(members),
      )
    }
    await page.screenshot(path.join(OUT, EXPECT_LEGACY ? 'album-legacy.png' : 'album-expanded.png'))

    // ── U4：无 `—` 占位（BUG-340 回归护栏）──
    const dash = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tg-filter-panel"]')
      return { hasDash: panel ? (panel.textContent || '').includes('—') : false }
    })
    push('U4 面板无 `—` 占位（BUG-340 护栏）', !dash.hasDash, JSON.stringify(dash))

    // ── U5：入库 wire——每单元一次请求，相册那次带整组 ids + groupId ──
    if (!EXPECT_LEGACY) {
      await page.evaluate(() => {
        window.__ingestCalls = []
        const orig = window.fetch.bind(window)
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input && input.url ? input.url : ''
          const method = (init && init.method) || (input && input.method) || 'GET'
          if (url.includes('/api/tg/cache/tasks') && method === 'POST') {
            const body = JSON.parse(init && init.body ? init.body : '{}')
            window.__ingestCalls.push(body)
            // 合成成功响应：只验前端发出的真实 payload，不搬真实字节（见文件头）。
            return new Response(
              JSON.stringify({
                id: 999001,
                status: 'queued',
                total: (body.messageIds || []).length,
                done: 0,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          }
          return orig(input, init)
        }
      })
      await clickAt(page, () => {
        const btn = document.querySelector('[data-testid="tg-filter-ingest"]')
        if (!btn) return null
        btn.scrollIntoView({ block: 'nearest' })
        const r = btn.getBoundingClientRect()
        const x = Math.round(r.left + r.width / 2)
        const y = Math.round(r.top + r.height / 2)
        const hit = document.elementFromPoint(x, y)
        return { x, y, hitOk: !!hit && (btn === hit || btn.contains(hit)) }
      })
      await sleep(600)
      const calls = await page.evaluate(() => window.__ingestCalls || [])
      // BUG-345：wire 上的 groupId 是 string 真值；normGroupId 归一化后比配。
      const fixtureCall = calls.find(
        (c) => c.chatId === FIXTURE.channelId && normGroupId(c.groupId) === FIXTURE.groupId,
      )
      const singleCall = calls.find((c) => c.groupId == null)
      const idsOk =
        !!fixtureCall &&
        Array.isArray(fixtureCall.messageIds) &&
        fixtureCall.messageIds.length === FIXTURE.memberIds.length &&
        FIXTURE.memberIds.every((m) => fixtureCall.messageIds.includes(m))
      push(
        'U5a 入库 wire：相册单元一次请求带整组 10 个 messageIds + groupId',
        idsOk,
        JSON.stringify(
          calls.map((c) => ({ chat: c.chatId, g: c.groupId ?? null, n: (c.messageIds || []).length })),
        ),
      )
      push(
        'U5b 入库 wire：单条单元一次请求、不带 groupId；总请求数 = 单元数',
        !!singleCall &&
          (singleCall.messageIds || []).length === 1 &&
          calls.length === EXPECT_UNITS.total,
        `calls=${calls.length}`,
      )
      await page.screenshot(path.join(OUT, 'after-ingest.png'))
    }

    fs.writeFileSync(path.join(OUT, 'result.txt'), results.join('\n') + '\n', 'utf8')
    console.log(results.join('\n'))
    if (problems.length > 0) {
      console.log(`\nFAIL: ${problems.join(', ')}`)
      process.exitCode = 1
    } else {
      console.log('\nALL PASS')
    }
  } finally {
    await browser.close()
    for (const id of createdFilterIds) {
      try {
        await tgApi('DELETE', `/api/tg/monitor/filters/${id}`)
      } catch {
        /* 清理尽力而为 */
      }
    }
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
