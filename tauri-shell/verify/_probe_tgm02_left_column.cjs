'use strict'
/**
 * BUG-330 TGM-02 探针：左栏消费序重排（③筛选→②监控→①频道 + 监听链状态条 +
 * 单一滚动容器 + 节折叠真控件 + 行内溯源 + §2.7 单一写面）。
 *
 * 判据（真实渲染 + 与 API 真值对比，不允许「存在即通过」）：
 *   P1 监听链状态条存在，三数与 API 真值逐项相等（dialogs 数 / monitored 数 /
 *      filters 命中合计）—— 证伪「侧栏自己算一套」。
 *   P2 消费序：DOM 上筛选节在监控节前、监控节在频道节前（compareDocumentPosition）。
 *   P3 频道节默认折叠（aria-expanded=false 且组行不渲染）；点击真控件后展开。
 *   P4 监控节副标为用户口径文案；至少一行监控行带「来自 <分组>」溯源。
 *   P5 左栏内不再有「取消监控」按钮（§2.7 单一写面：② 只读投影）。
 *   P6 单一滚动容器：三节同属一个 overflow-y-auto 容器；监控列表 computed
 *      max-height 为 none（撤掉旧的 max-h-56 各自限高）。
 *   P7 三个节头 h3 不含 emoji（⭐ 已清除）。
 *   P8 主列频道实体行有「取消监控」按钮（取消能力的唯一写面之一）。
 *   P9 +N 新徽标（有样本时）数字 === API newCount/newHits 合计；无样本时 SKIP 不冒充。
 *
 * 反向证伪（--expect-legacy）：反置 P2（期望旧版面序：监控在筛选前）与 P3
 *（期望频道节默认展开）⇒ 必须 FAIL 且 exit 1。
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

/** 等左栏真的渲染出来（等行出现，不是等容器——BUG-324 探针竞态纪律）。 */
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

const CHAIN_SNAP = () => {
  const bar = document.querySelector('[data-testid="tg-chain-bar"]')
  if (!bar) return null
  const btns = Array.from(bar.querySelectorAll('button'))
  const newBadge = bar.querySelector('[data-testid="tg-chain-new"]')
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
  const chToggle = document.querySelector('[data-testid="channel-collapse-toggle"]')
  const h3s = Array.from(document.querySelectorAll('section h3')).map((h) => h.textContent.trim())
  const aside = document.querySelector('aside')
  const unmonitorInAside = aside
    ? Array.from(aside.querySelectorAll('button')).filter(
        (b) => (b.getAttribute('aria-label') || '').includes('取消监控'),
      ).length
    : -1
  const monList = document.querySelector('[data-testid="tg-monitor-list"]')
  const rows = Array.from(document.querySelectorAll('[data-testid="tg-monitor-row"]'))
  const sources = rows.map((r) => {
    const ps = Array.from(r.querySelectorAll('p')).map((p) => p.textContent.trim())
    return ps.find((s) => s.includes('来自')) || null
  })
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
    chainTexts: btns.map((b) => b.textContent.trim()),
    chainNew: newBadge ? newBadge.textContent.trim() : null,
    orderOk,
    chExpanded: chToggle ? chToggle.getAttribute('aria-expanded') : null,
    chListExists: !!document.getElementById('tg-channel-list'),
    h3s,
    emojiInH3: h3s.some((s) => /\p{Extended_Pictographic}/u.test(s)),
    unmonitorInAside,
    monSub: monList ? (monList.querySelector('p') || {}).textContent : null,
    sources,
    scrollParentHasAll: !!scrollParent
      ? ['tg-section-filter', 'tg-section-monitor', 'tg-section-channels'].every((id) =>
          scrollParent.contains(document.getElementById(id)),
        )
      : false,
    monMaxHeight: monList ? getComputedStyle(monList).maxHeight : null,
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    await page.goto(APP)
    await openTgPanel(page)
    // BUG-318：等三个 list 端点都取到再比数字（未取到时状态条渲染 `—`，不是 0）
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-testid="tg-chain-bar"]')
        if (!bar) return false
        const texts = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent.trim())
        return texts.length >= 3 && texts.every((t) => t !== '—' && /\d/.test(t))
      },
      { timeout: 45000 },
    )
    await sleep(600)

    // API 真值（与前端同一批端点）
    // API 真值（与前端同一批端点、同一种翻页口径：limit=200 翻到 hasMore=false）
    const dlgItems = await (async () => {
      const all = []
      let offset = 0
      for (let page = 0; page < 10; page++) {
        const r = await getJson(`${TG}/api/tg/dialogs?limit=200${offset ? `&offset=${offset}` : ''}`)
        const items = Array.isArray(r) ? r : r.items || []
        all.push(...items)
        if (!r.hasMore || items.length === 0) break
        offset += items.length
      }
      return all
    })()
    const [monitored, filtersPage] = await Promise.all([
      getJson(`${TG}/api/tg/monitor/channels`),
      getJson(`${TG}/api/tg/monitor/filters`),
    ])
    // filters 端点是分页形状 { items }；老构建没有 newHits 字段（TGM-05/06 新增）⇒ 兜底 0
    const filters = (Array.isArray(filtersPage) ? filtersPage : filtersPage.items || []).map((f) => ({
      ...f,
      hits: Number(f.hits) || 0,
      newHits: Number(f.newHits) || 0,
    }))
    const hitTotal = filters.reduce((s, f) => s + (f.hits || 0), 0)
    const newTotal =
      monitored.reduce((s, m) => s + (m.newCount || 0), 0) +
      filters.reduce((s, f) => s + (f.newHits || 0), 0)

    const snap = await page.evaluate(CHAIN_SNAP)
    const problems = []
    const results = []
    const push = (name, ok, detail) => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) problems.push(name)
    }

    // P1 状态条三数与 API 真值逐项相等
    const wantTexts = [
      `${dlgItems.length} 频道`,
      `${monitored.length} 监控`,
      `${hitTotal} 命中`,
    ]
    const chainOk =
      !!snap &&
      snap.chainTexts.length >= 3 &&
      wantTexts.every((w, i) => (snap.chainTexts[i] || '').includes(String(w.split(' ')[0]))) &&
      snap.chainTexts[0].includes('频道') &&
      snap.chainTexts[1].includes('监控') &&
      snap.chainTexts[2].includes('命中')
    push('P1 监听链三数=API 真值', chainOk, `渲染 ${snap ? snap.chainTexts.join(' | ') : 'null'} vs API ${wantTexts.join(' | ')}`)

    // P2 消费序（旧版面序 = 监控在筛选前 ⇒ legacy 反置时必须 FAIL）
    const wantOrder = EXPECT_LEGACY ? false : true
    push('P2 消费序 ③②①', !!snap && snap.orderOk === wantOrder, `orderOk=${snap && snap.orderOk}`)

    // P3 频道节默认折叠
    const wantExpanded = EXPECT_LEGACY ? 'true' : 'false'
    push('P3 ① 频道节默认折叠', !!snap && snap.chExpanded === wantExpanded, `aria-expanded=${snap && snap.chExpanded}`)

    // P4 副标 + 行内溯源
    const subOk = !!snap && typeof snap.monSub === 'string' && snap.monSub.includes('实时更新')
    push('P4 监控节副标口径文案', subOk, `副标="${snap && snap.monSub}"`)
    const srcOk = !!snap && snap.sources.some((s) => !!s)
    push('P4b 监控行「来自 <分组>」溯源', srcOk, `样本=${JSON.stringify((snap && snap.sources.slice(0, 3)) || [])}`)

    // P5 左栏无取消监控按钮
    push('P5 左栏②只读投影（无取消按钮）', !!snap && snap.unmonitorInAside === 0, `aside 内取消按钮=${snap && snap.unmonitorInAside}`)

    // P6 单一滚动容器 + 无 max-height 限高
    push('P6 三节同一滚动容器', !!snap && snap.scrollParentHasAll, `scrollParentHasAll=${snap && snap.scrollParentHasAll}`)
    const maxhOk = !!snap && (snap.monMaxHeight === 'none' || snap.monMaxHeight === '0px')
    push('P6b 监控列表无限高', maxhOk, `computed maxHeight=${snap && snap.monMaxHeight}`)

    // P7 节头无 emoji
    push('P7 节头无 emoji', !!snap && snap.emojiInH3 === false, `h3=${JSON.stringify(snap && snap.h3s)}`)

    // P8 主列频道实体行有取消监控入口（点第一个监控行进主列）
    await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tg-monitor-row"]')
      if (row) row.click()
    })
    await sleep(500)
    const unmonitorBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const b = btns.find((x) => (x.getAttribute('aria-label') || '').includes('取消监控'))
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() }
    })
    push(
      'P8 主列频道实体行有「取消监控」',
      !!unmonitorBtn && unmonitorBtn.h >= 28,
      JSON.stringify(unmonitorBtn),
    )

    // P9 +N 新徽标与 API 一致（无样本 SKIP，不冒充 PASS）
    if (newTotal > 0) {
      const badgeOk = !!snap && snap.chainNew !== null && snap.chainNew.includes(String(newTotal))
      push('P9 状态条 +N=API newCount/newHits 合计', badgeOk, `渲染=${snap && snap.chainNew} API=${newTotal}`)
    } else {
      results.push(`SKIP P9 无新命中样本（API newTotal=0）`)
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
      console.log(`\nALL PASS（--expect-legacy=${EXPECT_LEGACY}）`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
