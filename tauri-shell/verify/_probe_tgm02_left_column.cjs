'use strict'
/**
 * BUG-330 TGM-02 探针（2026-10-20 第三次复报后重写）：左栏消费序 + 元素授权台账。
 *
 * 第三次复报（用户原话）：「524 频道→3 监控→12 命中 什么逻辑谁说要这个了?」
 * 「③ 这3个数字出现的意义是什么?」「来源——加监控在主列频道页/管理列表完成
 * 这些说明我记得规则有强烈限制不允许」「①频道(… 显示不全」。
 * ⇒ 判据从「验证我方设计的机制存在」翻转为「**无授权元素必须不存在**」。
 *
 * 判据（真实渲染 + 与 API 真值对比）：
 *   P1a 监听链状态条（tg-chain-bar）不存在（无授权元素，BUG-330 台账）；
 *   P1b ①②③ 漏斗编号不存在（无授权）；
 *   P1c 常驻说明/溯源文案不存在：aside 全文不得含「来自」「搜 N 个监控频道」
 *       「来源——」「每条规则就是一条监控」「只检查这些频道的实时更新」（BUG-148）；
 *   P2 消费序：DOM 上筛选节在监控节、监控节在频道节前；
 *   P3 频道节默认折叠（aria-expanded=false 且组行不渲染）；点真控件后展开；
 *   P4 节头**无污染**（BUG-340，2026-10-20 夜用户报障「(524) 3 个监控中 正在后台
 *      扫描订阅列表… 数字,监控数,扫描,这些全是错误内容」+「数据异常时显示(-)…
 *      从来没有需要显示(-)的要求」）：频道节头无原始计数/无「N 个监控中」/无
 *      「正在后台扫描」状态文本/无脉冲点；全左栏无 `—` 占位；节头零截断；
 *   P5 左栏无「取消监控」按钮（§2.7 单一写面）；
 *   P6 三节同属一个 overflow-y-auto 容器；监控列表 computed max-height 为 none；
 *   P7 三个节头 h3 不含 emoji；
 *   P8 主列频道实体行有「取消监控」按钮；
 *   P9 行内 +N 徽标合计 === API newCount/newHits 合计（无样本 SKIP）。
 *
 * 反向证伪（--expect-legacy）：反置 P2/P3（旧版面序/旧默认展开）、
 * P1a/P1c（期望状态条与溯源文案**存在**——第二次复报前的形态）与
 * P4（期望节头污染存在——BUG-340 前的形态）⇒ 必须 FAIL exit 1。
 *
 * 用法：node tauri-shell/verify/_probe_tgm02_left_column.cjs [--expect-legacy]
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。产物 verify_shots/tgm02-left-column/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tgm02-left-column')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

/** 等左栏真的渲染出来（等行出现，不是等容器——BUG-324 探针竞态纪律）。
 *  BUG-340 后节头不再渲染任何计数/状态文本 ⇒ 只等监控行出现即视为就绪
 *  （计数曾用「未就绪渲染 `—`」表达，现已整个撤除：没有就不渲染）。 */
async function openTgPanel(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0,
    { timeout: 30000 },
  )
}

const LEFT_SNAP = () => {
  const sections = ['tg-section-filter', 'tg-section-monitor', 'tg-section-channels'].map(
    (id) => document.getElementById(id),
  )
  const orderOk =
    sections[0] && sections[1] && sections[2]
      ? Boolean(
          sections[0].compareDocumentPosition(sections[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
        ) &&
        Boolean(
          sections[1].compareDocumentPosition(sections[2]) & Node.DOCUMENT_POSITION_FOLLOWING,
        )
      : false
  // DOM 里有两个 <aside>：全局导航侧栏 + TG 面板自己的左栏（含 tg-filter-row）。
  // 必须选**含 tg-filter-row 的那个**——2026-10-20 之前这里用
  // querySelector('aside')（命中全局导航），P1c/P4b/P5 三条护栏实际上在对
  // 全局侧栏断言：那些元素从来不在全局侧栏里 ⇒ 恒绿、从来没有牙。
  const aside = Array.from(document.querySelectorAll('aside')).find((a) =>
    a.querySelector('[data-testid="tg-filter-row"]'),
  )
  const asideText = aside ? aside.textContent.replace(/\s+/g, ' ') : ''
  const h3s = Array.from(document.querySelectorAll('section h3')).map((h) => h.textContent.trim())
  const unmonitorInAside = aside
    ? Array.from(aside.querySelectorAll('button')).filter(
        (b) => (b.getAttribute('aria-label') || '').includes('取消监控'),
      ).length
    : -1
  const monList = document.querySelector('[data-testid="tg-monitor-list"]')
  // BUG-340：频道节头污染检测（用户点名的四样：数字/监控数/扫描/脉冲点）。
  // 节头 = section 的第一个 div（flex 行）；动作按钮（重新扫描订阅）是授权
  // 元素，其文案含「扫描」但不含「正在后台扫描」状态短语，不误伤。
  const chSec = document.getElementById('tg-section-channels')
  const chHeader = chSec ? chSec.querySelector('div') : null
  const chHeaderText = chHeader ? chHeader.textContent.replace(/\s+/g, ' ').trim() : ''
  const chPollution = {
    rawCount: /\(\d+\)/.test(chHeaderText),
    monitoredCount: /\d+\s*个监控中/.test(chHeaderText),
    scanStatus: chHeaderText.includes('正在后台扫描'),
    pulseDot: chHeader ? !!chHeader.querySelector('.animate-pulse') : false,
  }
  // BUG-340：`—` 兜底整个撤除（「数据没有获取时就应该不显示」）
  const dashInAside = asideText.includes('—')
  // 节头截断（复报「①频道(… 显示不全」判据）：标题一律不得溢出。
  // ★ 前提断言：被压到 clientWidth=0 的标题 scrollWidth 也是 0（overflow:hidden），
  //   只比 scrollWidth 会假绿——所以每个 h3 必须同时「有宽度」才允许判过。
  const truncated = Array.from(document.querySelectorAll('section h3'))
    .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.clientWidth < 24)
    .map((el) => ({ text: el.textContent.trim().slice(0, 30), sw: el.scrollWidth, cw: el.clientWidth }))
  // 三节是否同属一个 overflow-y-auto 滚动容器
  const scrollParent = (() => {
    let el = document.getElementById('tg-section-filter')
    while (el) {
      const cs = getComputedStyle(el)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el
      el = el.parentElement
    }
    return null
  })()
  return {
    chainBarCount: document.querySelectorAll('[data-testid="tg-chain-bar"]').length,
    funnelNums: h3s.filter((s) => /^[①②③]/.test(s)).length,
    bannedCopy: ['来自', '搜 ', '个监控频道', '来源', '每条规则就是一条监控', '只检查这些频道的实时更新']
      .filter((k) => asideText.includes(k)),
    orderOk,
    chExpanded: document.querySelector('[data-testid="channel-collapse-toggle"]')
      ? document.querySelector('[data-testid="channel-collapse-toggle"]').getAttribute('aria-expanded')
      : null,
    chPollution,
    dashInAside,
    truncated,
    h3s,
    emojiInH3: h3s.some((s) => /\p{Extended_Pictographic}/u.test(s)),
    unmonitorInAside,
    scrollParentHasAll: !!scrollParent
      ? ['tg-section-filter', 'tg-section-monitor', 'tg-section-channels'].every((id) =>
          scrollParent.contains(document.getElementById(id)),
        )
      : false,
    monMaxHeight: monList ? getComputedStyle(monList).maxHeight : null,
    rowBadges: Array.from(
      document.querySelectorAll('[data-testid="tg-monitor-new-badge"], [data-testid="tg-filter-new-badge"]'),
    ).reduce((s, el) => s + (Number(el.getAttribute('data-count')) || 0), 0),
    badgeCount: document.querySelectorAll(
      '[data-testid="tg-monitor-new-badge"], [data-testid="tg-filter-new-badge"]',
    ).length,
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    // vite 文件变更后首次整页加载可 >30s（与改动无关的已知现象）：超时放宽。
    await page.goto(APP, { timeout: 90000 })
    await openTgPanel(page)
    await sleep(600)

    // API 真值（徽标合计判据用；BUG-340 后节头不再渲染计数，无需 dialogs 全量）
    const [monitored, filtersPage] = await Promise.all([
      getJson(`${TG}/api/tg/monitor/channels`),
      getJson(`${TG}/api/tg/monitor/filters`),
    ])
    const filters = (Array.isArray(filtersPage) ? filtersPage : filtersPage.items || []).map((f) => ({
      ...f,
      hits: Number(f.hits) || 0,
      newHits: Number(f.newHits) || 0,
    }))
    const newTotal =
      monitored.reduce((s, m) => s + (m.newCount || 0), 0) +
      filters.reduce((s, f) => s + (f.newHits || 0), 0)

    const snap = await page.evaluate(LEFT_SNAP)
    const problems = []
    const results = []
    const push = (name, ok, detail) => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) problems.push(name)
    }

    // P1 无授权元素必须不存在（legacy 反置 = 期望它们存在）
    const wantAbsent = EXPECT_LEGACY ? false : true
    push('P1a 监听链状态条不存在（无授权）', (snap.chainBarCount === 0) === wantAbsent, `count=${snap.chainBarCount}`)
    push('P1b ①②③ 漏斗编号不存在（无授权）', (snap.funnelNums === 0) === wantAbsent, `count=${snap.funnelNums}`)
    push('P1c 常驻说明/溯源文案不存在（BUG-148）', (snap.bannedCopy.length === 0) === wantAbsent, `命中=${JSON.stringify(snap.bannedCopy)}`)

    // P2 消费序（旧版面序 = 监控在筛选前 ⇒ legacy 反置时必须 FAIL）
    const wantOrder = EXPECT_LEGACY ? false : true
    push('P2 消费序（筛选→监控→频道）', snap.orderOk === wantOrder, `orderOk=${snap.orderOk}`)

    // P3 频道节默认折叠
    const wantExpanded = EXPECT_LEGACY ? 'true' : 'false'
    push('P3 频道节默认折叠', snap.chExpanded === wantExpanded, `aria-expanded=${snap.chExpanded}`)

    // P4 节头无污染（BUG-340；legacy 反置 = 期望污染存在——报障前的形态）
    const wantClean = EXPECT_LEGACY ? false : true
    const anyPollution = Object.values(snap.chPollution).some(Boolean)
    push(
      'P4a 频道节头无原始计数/「N 个监控中」/「正在后台扫描」/脉冲点',
      (!anyPollution) === wantClean,
      JSON.stringify(snap.chPollution),
    )
    push(
      'P4b 左栏无 `—` 占位（数据未就绪 = 不渲染）',
      (!snap.dashInAside) === wantClean,
      `dashInAside=${snap.dashInAside}`,
    )
    push('P4c 节头零截断（scrollWidth≤clientWidth）', snap.truncated.length === 0, JSON.stringify(snap.truncated))

    // P5 左栏无取消监控按钮
    push('P5 左栏只读投影（无取消按钮）', snap.unmonitorInAside === 0, `aside 内取消按钮=${snap.unmonitorInAside}`)

    // P6 单一滚动容器 + 无 max-height 限高
    push('P6 三节同一滚动容器', snap.scrollParentHasAll, `scrollParentHasAll=${snap.scrollParentHasAll}`)
    push('P6b 监控列表无限高', snap.monMaxHeight === 'none' || snap.monMaxHeight === '0px', `computed maxHeight=${snap.monMaxHeight}`)

    // P7 节头无 emoji
    push('P7 节头无 emoji', snap.emojiInH3 === false, `h3=${JSON.stringify(snap.h3s)}`)

    // P8 主列频道实体行有取消监控入口（限定在频道头内——全局 find 会被
    // 「左栏回归加回按钮」蒙混，P5 已钉左栏没有，这里钉主列必须有）
    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tg-monitor-row"]')
      if (row) row.click()
    })
    await sleep(500)
    const unmonitorBtn = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="tg-channel-header"]')
      const btns = header ? Array.from(header.querySelectorAll('button')) : []
      const b = btns.find((x) => (x.getAttribute('aria-label') || '').includes('取消监控'))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() }
    })
    // h === 28：BUG-344 的 xs token（h-7）。原 >=28 是给「声明 h-7 实际渲染
    // 32px」的坏形态放水的判据（cn 裸 join，h-7 override 被 h-8 按源序赢掉）。
    push('P8 主列频道实体行有「取消监控」', !!unmonitorBtn && unmonitorBtn.h === 28, JSON.stringify(unmonitorBtn))

    // P9 行内 +N 徽标合计 === API 真值（无样本 SKIP，不冒充 PASS）
    if (newTotal > 0) {
      push('P9 行内 +N 徽标合计=API', snap.rowBadges === newTotal, `渲染=${snap.rowBadges} API=${newTotal}`)
    } else {
      results.push(`SKIP P9 无新命中样本（API newTotal=0，徽标数=${snap.badgeCount}）`)
    }

    // 折叠控件交互：点频道节控件应真的展开
    await page.evaluate(() => {
      const t = document.querySelector('[data-testid="channel-collapse-toggle"]')
      if (t) t.click()
    })
    await sleep(300)
    const afterToggle = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="channel-collapse-toggle"]')
      return {
        expanded: t ? t.getAttribute('aria-expanded') : null,
        listExists: !!document.getElementById('tg-channel-list'),
      }
    })
    push('P3b 点控件真的展开', afterToggle.expanded === 'true' && afterToggle.listExists, JSON.stringify(afterToggle))

    await page.screenshot(path.join(OUT, 'left-column.png'))
    fs.writeFileSync(path.join(OUT, 'result.txt'), results.join('\n') + '\n', 'utf8')
    console.log(results.join('\n'))
    if (problems.length > 0) {
      console.log(`\nFAIL: ${problems.join(', ')}（--expect-legacy=${EXPECT_LEGACY}）`)
      process.exitCode = 1
    } else {
      console.log(`\n ALL PASS（--expect-legacy=${EXPECT_LEGACY}）`.trim())
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
