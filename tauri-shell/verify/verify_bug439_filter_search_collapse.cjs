/**
 * BUG-439 验收：筛选节的「规则检索框」默认**收起**，必要性成员只有节头那枚图标钮
 * （`tg-filter-search-toggle`，贴在新建 `+` 的左边）；展开/收起由用户点它控制。
 *
 * 为什么必须能在这台机器上验出来而不只是「看代码改了」：这里唯一的风险是**假改**——
 * 把 Input 藏了却没给入口，或者收起了却让检索词继续生效（隐形过滤）。三条判据各打一处：
 *
 *   P1 折叠态：没有 `tg-filter-search`，但有可见的 `tg-filter-search-toggle`；
 *   P2 展开态：点钮 ⇒ Input 出现、聚焦，且**真的过滤**（命中行数下降）；
 *   P3 收起即清词：再点钮 ⇒ Input 消失 且 行数回到全量（看不见的过滤不许留）。
 *
 * 验牙（`BUG439_TEETH=1`）：注入一个伪造的常驻 Input（`data-testid="tg-filter-search"`
 * 直接塞进 DOM，模拟「改之前」的形态）⇒ P1 必须 FAIL。恒绿的脚本等于没有脚本。
 *
 * 用法： node tauri-shell/verify/verify_bug439_filter_search_collapse.cjs
 */
const path = require('path')
const cdp = require('./lib/cdp.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE = process.env.ORIG_HUB_WEB || 'http://127.0.0.1:5180'
const TEETH = process.env.BUG439_TEETH === '1'
const OUT =
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', '..', 'verify_shots')

const results = []
const note = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`)
}
const info = (msg) => console.log(`note  ${msg}`)

/** 可见性must immer relative to DOM presence + box model（`offsetParent` / rect > 0）。 */
async function presence(page, testid) {
  return page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (!el) return { present: false, visible: false, focused: false }
    const r = el.getBoundingClientRect()
    return {
      present: true,
      visible: r.width > 0 && r.height > 0 && el.offsetParent !== null,
      focused: document.activeElement === el,
      value: typeof el.value === 'string' ? el.value : null,
    }
  }, testid)
}

const rowCount = (page) =>
  page.evaluate(() => document.querySelectorAll('[data-testid="tg-filter-row"]').length)

const clickTid = (page, tid) =>
  page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, tid)

/** 命中行里第一条规则的**关键词原文**（用来构造一个必定能命中的检索词）。
 *  取 chip 的**第一个元素子节点**而不是整行文本：整行还挂着命中计数（「… 43 条」），
 *  拿它当词会匹配不到任何规则 —— 那种「过滤生效」是假信号（把什么都过滤没了）。 */
function firstRuleText(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="tg-filter-row"]')
    if (!row) return null
    const chip = row.querySelector('[data-testid="tg-filter-chip"]')
    const src = chip || row
    const first = Array.from(src.children).map((c) => (c.textContent || '').trim()).find(Boolean)
    const word = (first || src.textContent || '').trim()
    if (!word) return null
    return Array.from(word).slice(0, 4).join('')
  })
}

async function main() {
  const browser = await cdp.launch({ headless: true })
  const page = await browser.newPage()

  await page.goto(BASE, { waitUntil: 'load', timeoutMs: 60_000 })
  await sleep(3500)
  // 壳首屏不一定落在 TG 页 ⇒ 走顶部导航（testid 是验收的唯一锚，禁文本正则）。
  await clickTid(page, 'nav-tg')
  await sleep(3000)

  const rules = await rowCount(page)
  note('前置数据：筛选节存在规则行', rules > 0, `tg-filter-row = ${rules}`)
  if (rules === 0) {
    // 没有规则 ⇒ P2 的「真的过滤」无从验起；如实跳过，绝不把它记成 PASS。
    info('无筛选规则 ⇒ P2 过滤效果不可验，仅验形态；不计数')
  }

  if (TEETH) {
    await page.evaluate(() => {
      const fake = document.createElement('input')
      fake.setAttribute('data-testid', 'tg-filter-search')
      // 伪装成「改之前」的常驻输入框必须在列表容器**之前**，位置代码会因为 DOM 顺序排
      // 到那里；这里只求 P1 的 `present === false` 被推翻。
      const body = document.getElementById('tg-filter-list-body')
      ;(body || document.body).prepend(fake)
    })
    info('TEETH：已注入常驻 tg-filter-search（模拟修复前形态）')
  }

  await page.screenshot(path.join(OUT, 'bug439-collapsed.png'))

  // ── P1 折叠态：输入框不存在，入口钮可见 ──
  const fieldCollapsed = await presence(page, 'tg-filter-search')
  const toggle = await presence(page, 'tg-filter-search-toggle')
  note(
    'P1 折叠态无常驻检索输入框',
    fieldCollapsed.present === false,
    `tg-filter-search present=${fieldCollapsed.present}`,
  )
  note(
    'P1 折叠态检索入口钮可见',
    toggle.present && toggle.visible,
    JSON.stringify(toggle),
  )

  // ── P2 展开态 ──
  await clickTid(page, 'tg-filter-search-toggle')
  await sleep(600)
  const fieldOpen = await presence(page, 'tg-filter-search')
  await page.screenshot(path.join(OUT, 'bug439-expanded.png'))
  note(
    'P2 点入口钮展开检索输入框',
    fieldOpen.present && fieldOpen.visible && fieldOpen.focused,
    JSON.stringify(fieldOpen),
  )

  let filtered = null
  if (fieldOpen.present && rules > 0) {
    const word = await firstRuleText(page)
    if (word) {
      await page.evaluate((w) => {
        const el = document.querySelector('[data-testid="tg-filter-search"]')
        // React 受控输入：直接赋 value 不会触发 onChange ⇒ 走原生 setter + input 事件。
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set
        setter.call(el, w)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }, word)
      await sleep(600)
      filtered = await rowCount(page)
      await page.screenshot(path.join(OUT, 'bug439-filtered.png'))
      note(
        'P2 检索词真的过滤了规则列表',
        filtered < rules,
        `规则行 ${rules} → ${filtered}（词 = 「${word}」）`,
      )
    }
  }

  // ── P3 收起即清词 ──
  await clickTid(page, 'tg-filter-search-toggle')
  await sleep(600)
  const fieldClosed = await presence(page, 'tg-filter-search')
  const afterClose = await rowCount(page)
  await page.screenshot(path.join(OUT, 'bug439-closed.png'))
  note(
    'P3 再点收起：输入框消失',
    fieldClosed.present === false,
    `present=${fieldClosed.present}`,
  )
  note(
    'P3 收起清空检索词（不留隐形过滤）',
    afterClose === rules && (filtered === null || filtered < rules),
    `行数回到 ${afterClose}（全量 ${rules}，过滤时 ${filtered}）`,
  )

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(
    `\nRESULT ${failed === 0 ? 'OK' : 'FAILED'} — ${results.length} checks, ${failed} failed`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`ERROR ${e && e.message ? e.message : String(e)}`)
  process.exit(2)
})
