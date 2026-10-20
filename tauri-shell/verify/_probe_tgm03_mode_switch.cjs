'use strict'
/**
 * BUG-330 TGM-03 探针：主列单一 `tgMode` 五分支互斥切换（删四态 + 删优先级链）。
 *
 * 用户原始投诉③（2026-10-20）：「进入筛选后下面的分组无法进去」——
 * 老代码 `activeFilter ? … : …` 优先级链短路其余全部状态，点分组/监控行主列不变。
 *
 * 判据（真实渲染 + 真实鼠标事件）：
 *   M1 点筛选行 → 命中工作台 `tg-filter-panel` 出现；关闭 → 回到进入前那一屏
 *      （进入前是频道内容流 ⇒ `tg-channel-header` 回来，不是回全部）。
 *   M2 **投诉③复验**：先在筛选模式 → 点左栏分组行 → 主列**真的**切成分组管理列表
 *      （`tg-group-search-scope` 可见 + 监控 Switch 在）—— 老代码这一步点不动。
 *   M3 分组列表点频道名 → 内容页 + 「← 返回」出现 → 点返回回到**该分组**列表。
 *   M4 点监控行 → 内容页（互斥切换）。
 *   M5 全局搜索：上下文栏提交 → 结果视图（`tg-hit-row`）→ 清除 → 回到进入搜索前
 *      的频道内容流（模式闭环，不是永远停在搜索台）。
 *   M6 搜索在场时点左栏分组行 → 主列切走且搜索词被清（离场闭环：否则进场 effect
 *      会立刻把用户拽回搜索模式，永远出不去）。
 *
 * 反向证伪（--expect-legacy）：反置 M2 为「筛选模式点分组行主列不变」（老行为）
 * ⇒ 必须 FAIL 且 exit 1。
 *
 * 用法：node tauri-shell/verify/_probe_tgm03_mode_switch.cjs [--expect-legacy]
 * 前置：dev 5180 + daemon 19786。产物 verify_shots/tgm03-mode-switch/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tgm03-mode-switch')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 真实鼠标点击（memory 纪律：`el.click()` 不过命中测试，测不出遮挡/越界）。
 *  先 scrollIntoView 再取矩形 —— 左栏是单一滚动容器（TGM-02），① 频道节在底部，
 *  700px 视口下分组行本就在折叠线以下，不滚动就直接点会落到别的行上（实测教训）。 */
async function realClick(page, selector) {
  /*
   * ★ 有界等待「目标真的可点」（2026-10-21 实测假红）：`openTgPanel` 等到规则行
   * 出现之后，filters 还可能再刷新一轮（后台轮询/点开即归零的乐观更新），DOM 在
   * 等待与点击之间短暂空掉 ⇒ 直接 evaluate 拿到 null，报「找不到」——那不是产品
   * 问题，是探针没等稳。这里改成轮询到可点（上限 15s），超时仍如实报错。
   */
  let pt = null
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    pt = await page.evaluate((sel) => {
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
    if (pt && pt.hitOk) break
    await sleep(200)
  }
  if (!pt) throw new Error(`realClick: 找不到或不可见 ${selector}（等待 15s 后仍不可点）`)
  if (!pt.hitOk) throw new Error(`realClick: ${selector} 的点击点被其它元素占据（命中测试失败）`)
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

/** 当前主列处于哪一屏（按 DOM 事实判，不读内部 state） */
const MAIN_SNAP = () => {
  const panel = document.querySelector('[data-testid="tg-filter-panel"]')
  const header = document.querySelector('[data-testid="tg-channel-header"]')
  const groupScope = document.querySelector('[data-testid="tg-group-search-scope"]')
  const hitRows = document.querySelectorAll('[data-testid="tg-hit-row"]').length
  const back = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent || '').includes('返回列表'),
  )
  // 分组标题只从主列那一屏读（左栏也有 section/h3，先查会串到左栏节头）
  const groupTitle = groupScope
    ? ((groupScope.closest('section') || {}).querySelector
        ? groupScope.closest('section').querySelector('h3')
        : null)
    : null
  return {
    filterPanel: !!panel,
    channelHeader: !!header,
    channelId: header ? header.getAttribute('data-channel-id') : null,
    groupList: !!groupScope,
    groupTitle: groupTitle ? groupTitle.textContent.trim() : null,
    searchResults: hitRows,
    backBtn: !!back,
  }
}

async function openTgPanel(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  // 等首落点（数据驱动：第一个监控频道的内容流）而不是等容器
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="tg-channel-header"]'),
    { timeout: 30000 },
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1100, height: 700 })
    await page.goto(APP)
    await openTgPanel(page)
    await sleep(400)

    const results = []
    const problems = []
    const push = (name, ok, detail) => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) problems.push(name)
    }

    const s0 = await page.evaluate(MAIN_SNAP)

    // ---- M1：筛选模式进出闭环 ----
    await realClick(page, '[data-testid="tg-filter-row"]')
    const s1 = await page.evaluate(MAIN_SNAP)
    push('M1a 点筛选行 → 命中工作台', s1.filterPanel, JSON.stringify(s1))
    await realClick(page, '[data-testid="tg-filter-back"]')
    await sleep(400)
    const s1b = await page.evaluate(MAIN_SNAP)
    push(
      'M1b 关闭筛选 → 回进入前的频道内容流',
      s1b.channelHeader && s1b.channelId === s0.channelId,
      JSON.stringify(s1b),
    )

    // ---- M2：投诉③复验（筛选在场 → 点分组行 → 主列必须真的切走） ----
    await realClick(page, '[data-testid="tg-filter-row"]')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
      { timeout: 10000 },
    )
    // 展开频道节（默认折叠）并点第一个分组行
    await realClick(page, '[data-testid="channel-collapse-toggle"]')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-group-row"]').length > 0,
      { timeout: 10000 },
    )
    /*
     * ★ 有界等待「订阅列表真的落地」（MEMORY 教训：只等容器出现会读到 0 条）。
     * 「全部订阅 / 未分组」两个分组行是**恒定渲染**的（不依赖 channels），所以
     * 上面那条 waitForFunction 会立刻满足——但 channels 还在翻页拉取（525 条 /
     * 3 页），此时点进分组列表会看到「全部订阅 (0)」、组内 0 个频道，M3a 假红。
     * 判据 = 左栏「全部订阅」行尾计数 === API dialogs total（同一真值口径）。
     */
    const dialogsTotal = await (await fetch(`${TG}/api/tg/dialogs?limit=1`)).json().then((r) => r.total)
    await page.waitForFunction(
      (total) => {
        const sec = document.getElementById('tg-section-channels')
        if (!sec) return false
        const rows = Array.from(sec.querySelectorAll('[data-testid="tg-group-row"]'))
        const all = rows[0]
        if (!all) return false
        const m = /(\d+)/.exec(all.textContent || '')
        return !!m && Number(m[1]) === total
      },
      { timeout: 40000, args: [dialogsTotal] },
    )
    await realClick(page, '[data-testid="tg-group-row"]')
    await sleep(400)
    const s2 = await page.evaluate(MAIN_SNAP)
    if (EXPECT_LEGACY) {
      // 老行为：筛选模式点分组行，主列不动（仍是筛选工作台）
      push('M2 [legacy 反置] 筛选模式点分组行主列不变', s2.filterPanel && !s2.groupList, JSON.stringify(s2))
    } else {
      push(
        'M2 筛选模式点分组行 → 主列切到分组管理列表（投诉③）',
        s2.groupList && !s2.filterPanel,
        JSON.stringify(s2),
      )
    }

    // ---- M3：分组列表 → 频道内容 → 返回该分组 ----
    await realClick(page, '[data-testid="tg-group-row"]')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-group-search-scope"]'),
      { timeout: 10000 },
    )
    const firstChan = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tg-group-search-scope"]')
      const list = row ? row.closest('section') : null
      const btn = list
        ? Array.from(list.querySelectorAll('button')).find((b) => b.querySelector('p'))
        : null
      if (!btn) return null
      btn.click()
      return true
    })
    await sleep(400)
    const s3 = await page.evaluate(MAIN_SNAP)
    push('M3a 分组列表点频道 → 内容页 + 返回按钮', s3.channelHeader && s3.backBtn, JSON.stringify(s3))
    const s2title = s2.groupTitle
    const backClicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        (x.textContent || '').includes('返回列表'),
      )
      if (!b) return false
      b.click()
      return true
    })
    await sleep(400)
    const s3b = await page.evaluate(MAIN_SNAP)
    push(
      'M3b 点返回 → 回该分组列表',
      backClicked && firstChan && s3b.groupList && s3b.groupTitle === s2title,
      JSON.stringify(s3b),
    )

    // ---- M4：点监控行 → 内容页 ----
    await realClick(page, '[data-testid="tg-monitor-row"]')
    await sleep(400)
    const s4 = await page.evaluate(MAIN_SNAP)
    push('M4 点监控行 → 内容页', s4.channelHeader && !s4.groupList && !s4.filterPanel, JSON.stringify(s4))

    // ---- M5：全局搜索进/出闭环 ----
    await realClick(page, '[data-testid="tg-global-search-input"]')
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="tg-global-search-input"]')
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(input, '剧')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="tg-hit-row"]').length > 0 ||
        !!document.querySelector('[data-testid="tg-global-search-searching"]'),
      { timeout: 20000 },
    )
    await sleep(500)
    const s5 = await page.evaluate(MAIN_SNAP)
    const inSearch = s5.searchResults > 0 || (await page.evaluate(() =>
      !!document.querySelector('[data-testid="tg-global-search-searching"]'),
    ))
    push('M5a 上下文栏提交 → 搜索结果视图', inSearch, JSON.stringify(s5))
    await realClick(page, '[data-testid="tg-global-search-clear"]')
    await sleep(500)
    const s5b = await page.evaluate(MAIN_SNAP)
    push(
      'M5b 清除搜索 → 回进入前的频道内容流',
      s5b.channelHeader && s5b.channelId === s4.channelId,
      JSON.stringify(s5b),
    )

    // ---- M6：搜索在场时点左栏分组行 → 切走 + 搜索词被清 ----
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="tg-global-search-input"]')
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(input, '剧')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="tg-hit-row"]').length > 0,
      { timeout: 20000 },
    )
    await realClick(page, '[data-testid="tg-group-row"]')
    await sleep(500)
    const s6 = await page.evaluate(MAIN_SNAP)
    const committedCleared = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="tg-global-search-input"]')
      return input ? input.value === '' : true
    })
    push(
      'M6 搜索中点分组行 → 切走且搜索词清（离场闭环）',
      s6.groupList && committedCleared,
      JSON.stringify({ ...s6, committedCleared }),
    )

    await page.screenshot(path.join(OUT, 'mode-switch.png'))
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
