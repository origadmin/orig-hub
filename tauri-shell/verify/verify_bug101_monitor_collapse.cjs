'use strict'
/**
 * BUG-101 真实 UI 验收：监控列表折叠控件是**独立可辨识的控件**，且**与标题解耦**。
 *
 * 缺陷原文（docs/bugs/BUG-101.md ①）：折叠指示器是纯文本字符 `▾`/`▸`（text-[10px]），
 * 读起来像装饰而不是控件；且箭头与标题**共用同一个 `<button>`** → 点标题就折叠。
 *
 * 本探针断言（全部在**真实渲染**的 Edge 上测量，不做代码推断）：
 *  A. 折叠控件是独立 `<button>`，热区 **≥ 24×24**（doc §验收要点 第 1 条）。
 *  B. 图标是 **lucide-react** 的 chevron 组件（`<svg>` + lucide 的 `M6 9l6 6 6-6` 路径），
 *     而非纯文本字符 —— 纯文本字符在 DOM 里表现为元素**文本内容**含 `▾`/`▸`。
 *  C. 标题是**独立元素**（不在 button 内），点击标题**不触发折叠**（解耦，doc 第 2 条）。
 *  D. 控件可访问性到位：aria-expanded 随状态翻转、aria-label 存在。
 *  E. 点击控件确实折叠/展开监控列表（控件是**活的**，不是摆设）。
 *
 * 用法：`node verify/verify_bug101_monitor_collapse.cjs`
 * 证据：`verify/evidence/BUG-101/`
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-101')
fs.mkdirSync(OUT, { recursive: true })

const SHELL = 'http://127.0.0.1:5180/'
const TOGGLE = '[data-testid="monitor-collapse-toggle"]'

/** lucide `ChevronDown` / `ChevronRight` 的真实 path `d`（24x24 viewBox, v1.47.0）。 */
const LUCIDE_PATHS = ['m6 9 6 6 6-6', 'm9 18 6-6-6-6']

/** 读取折叠控件 + 标题的测量结果。 */
async function measure(page) {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    if (!btn) return { found: false }
    const rect = btn.getBoundingClientRect()

    // 标题 = 与控件同一标题行里的 <h3>（不假设它在 button 内）
    const row = btn.closest('div')
    const title = row ? row.querySelector('h3') : null

    const svg = btn.querySelector('svg')
    const pathEl = svg ? svg.querySelector('path') : null

    // 监控列表容器：用稳定的 data-testid 定位（不用 nextElementSibling ——
    // 折叠后该兄弟节点会变成下一个分区，导致「折叠未生效」的假阴性）
    const list = document.querySelector('[data-testid="tg-monitor-list"]')

    return {
      found: true,
      tag: btn.tagName,
      // 热区（CSS px）
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      // 视觉图标尺寸
      iconW: svg ? Math.round(svg.getBoundingClientRect().width * 100) / 100 : null,
      iconH: svg ? Math.round(svg.getBoundingClientRect().height * 100) / 100 : null,
      // 图标来源判据
      hasSvg: Boolean(svg),
      pathD: pathEl ? pathEl.getAttribute('d') : null,
      strokeWidth: svg ? svg.getAttribute('stroke-width') : null,
      // 纯文本字符判据：控件自身的可见文本必须为空
      ownText: (btn.innerText || '').trim(),
      // 可访问性
      ariaExpanded: btn.getAttribute('aria-expanded'),
      ariaLabel: btn.getAttribute('aria-label'),
      ariaControls: btn.getAttribute('aria-controls'),
      // 标题解耦判据
      titleFound: Boolean(title),
      titleInsideBtn: title ? btn.contains(title) : null,
      titleClosestButton: title && title.closest('button') ? title.closest('button').outerHTML.slice(0, 120) : null,
      titleText: title ? (title.innerText || '').trim() : null,
      // 监控列表可见性（E 的判据）
      listPresent: Boolean(list),
      listRows: list ? list.querySelectorAll('button').length : 0,
    }
  }, TOGGLE)
}

/** 点击标题（而非控件），返回 aria-expanded 是否被翻转。 */
async function clickTitle(page) {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    const row = btn && btn.closest('div')
    const title = row ? row.querySelector('h3') : null
    if (!title) return { clicked: false }
    const before = btn.getAttribute('aria-expanded')
    title.click()
    return { clicked: true, before }
  }, TOGGLE)
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  const problems = []

  try {
    await page.goto(SHELL, { settleMs: 2500 })

    if (!(await page.evaluate(() => {
      const b = document.querySelector('[data-testid="nav-tg"]')
      if (!b) return false
      b.click()
      return true
    }))) throw new Error('nav-tg not found')

    // 等监控列表出现（TG 服务可能尚未就绪）
    let before = null
    for (let i = 0; i < 12; i++) {
      await delay(1200)
      before = await measure(page)
      if (before.found) break
    }
    if (!before || !before.found) throw new Error(`折叠控件未渲染（${TOGGLE}）`)

    console.log('--- 初始（展开态）---')
    console.log(JSON.stringify(before, null, 2))
    await page.screenshot(path.join(OUT, '1_expanded.png'))

    // ---- A. 热区 ≥ 24×24 ----
    if (before.w < 24 || before.h < 24) {
      problems.push(`热区 ${before.w}×${before.h} < 24×24（doc 验收要点 1）`)
    }

    // ---- B. lucide chevron 图标，而非纯文本字符 ----
    if (!before.hasSvg) {
      problems.push('折叠指示器不是 SVG 图标（仍是纯文本字符？）')
    } else if (!LUCIDE_PATHS.includes(before.pathD)) {
      problems.push(`图标 path 非 lucide chevron：d="${before.pathD}"`)
    }
    if (before.ownText.length > 0) {
      problems.push(`控件内仍残留纯文本指示字符："${before.ownText}"`)
    }

    // ---- D. 可访问性 ----
    if (before.ariaExpanded !== 'true') {
      problems.push(`初始 aria-expanded=${before.ariaExpanded}（期望 "true"）`)
    }
    if (!before.ariaLabel) {
      problems.push('折叠控件缺 aria-label')
    }
    if (before.ariaControls !== 'tg-monitor-list') {
      problems.push(`折叠控件 aria-controls=${before.ariaControls}（期望 "tg-monitor-list"）`)
    }

    // ---- C. 点标题不折叠（解耦）----
    if (!before.titleFound) problems.push('找不到监控列表标题 <h3>')
    if (before.titleInsideBtn) {
      problems.push('标题仍位于折叠按钮内部（未解耦）')
    }
    if (before.titleClosestButton) {
      problems.push(`标题仍是某个 <button> 的后代：${before.titleClosestButton.slice(0, 80)}`)
    }

    await clickTitle(page)
    await delay(600)
    const afterTitleClick = await measure(page)
    console.log('--- 点标题后 ---')
    console.log(JSON.stringify({ ariaExpanded: afterTitleClick.ariaExpanded, listPresent: afterTitleClick.listPresent }))
    await page.screenshot(path.join(OUT, '2_after_title_click.png'))

    if (afterTitleClick.ariaExpanded !== before.ariaExpanded) {
      problems.push(`点标题触发了折叠（aria-expanded ${before.ariaExpanded} → ${afterTitleClick.ariaExpanded}）`)
    }
    if (!afterTitleClick.listPresent) {
      problems.push('点标题后监控列表消失（说明标题仍是折叠入口）')
    }

    // ---- E. 点控件确实折叠 / 展开（控件是活的）----
    await page.evaluate((sel) => { document.querySelector(sel).click() }, TOGGLE)
    await delay(700)
    const collapsed = await measure(page)
    console.log('--- 点控件后（应为折叠态）---')
    console.log(JSON.stringify({ ariaExpanded: collapsed.ariaExpanded, listPresent: collapsed.listPresent, iconPath: collapsed.pathD }))
    await page.screenshot(path.join(OUT, '3_collapsed.png'))

    if (collapsed.ariaExpanded !== 'false') {
      problems.push(`点控件后 aria-expanded=${collapsed.ariaExpanded}（期望 "false"）`)
    }
    if (collapsed.listPresent) {
      problems.push('点控件后监控列表仍可见（折叠未生效）')
    }
    if (LUCIDE_PATHS.includes(collapsed.pathD) && collapsed.pathD === before.pathD) {
      problems.push('折叠态图标未变化（chevron 未翻转）')
    }
    // 折叠态热区同样要达标
    if (collapsed.w < 24 || collapsed.h < 24) {
      problems.push(`折叠态热区 ${collapsed.w}×${collapsed.h} < 24×24`)
    }

    // 复原（展开态）并留档
    await page.evaluate((sel) => { document.querySelector(sel).click() }, TOGGLE)
    await delay(700)
    const restored = await measure(page)
    await page.screenshot(path.join(OUT, '4_restored_expanded.png'))
    if (restored.ariaExpanded !== 'true') problems.push('再次点控件未恢复展开态')

    const consoleErrors = page.consoleErrors().filter((e) => !/favicon\.ico/.test(e))
    const pageErrors = page.pageErrors()
    if (pageErrors.length) problems.push(`页面异常：${pageErrors.slice(0, 2).join(' | ')}`)
    if (consoleErrors.length) problems.push(`控制台错误：${consoleErrors.slice(0, 2).join(' | ')}`)

    const report = {
      bug: 'BUG-101',
      viewport: '1440x900',
      browser: 'Edge (headful, real compositing)',
      shell: SHELL,
      assertions: {
        hotZone: `${before.w}x${before.h} (>=24x24 required)`,
        icon: { isSvg: before.hasSvg, pathD: before.pathD, strokeWidth: before.strokeWidth, ownText: before.ownText },
        titleDecoupled: { found: before.titleFound, insideButton: before.titleInsideBtn, insideAnyButton: Boolean(before.titleClosestButton), titleText: before.titleText },
        titleClickChangedState: afterTitleClick.ariaExpanded !== before.ariaExpanded,
        toggleCollapses: collapsed.ariaExpanded === 'false' && !collapsed.listPresent,
        restoredExpanded: restored.ariaExpanded === 'true',
        aria: { expanded: before.ariaExpanded, label: before.ariaLabel },
      },
      consoleErrors,
      pageErrors,
      problems,
      verdict: problems.length ? 'FAIL' : 'PASS',
    }
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2))

    console.log('\n=== VERDICT ===')
    console.log(`热区            : ${before.w}x${before.h}`)
    console.log(`图标            : svg=${before.hasSvg} d="${before.pathD}" 残留文本="${before.ownText}"`)
    console.log(`标题解耦        : 在按钮内=${before.titleInsideBtn} 属任意按钮=${Boolean(before.titleClosestButton)}`)
    console.log(`点标题改变状态  : ${afterTitleClick.ariaExpanded !== before.ariaExpanded} (期望 false)`)
    console.log(`点控件折叠生效  : ${collapsed.ariaExpanded === 'false'}`)
    console.log(`console errors  : ${consoleErrors.length}  page errors: ${pageErrors.length}`)
    console.log(problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS: 折叠控件独立可辨识且与标题解耦')
  } finally {
    await browser.close()
  }

  if (problems.length) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
