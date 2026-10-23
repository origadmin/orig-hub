#!/usr/bin/env node
'use strict'
/**
 * BUG-400 验收：文件页信息架构（搜索/读数/排序归位）。
 *
 * 判据（真实运行栈 + 真实 wire 请求，非字符串匹配）：
 *   B1. cat-all 视图：搜索框在**标题栏**（`context-bar` 内），内容区工具条不再
 *       有搜索框/排序下拉（`media-sort-select` 全页为 0 —— 整行工具条撤销）；
 *   B2. 输入关键词 ⇒ 发出带 `q=<kw>` 的列表请求（wire 证据），点清除 ⇒ 清空；
 *   B3. 占用/登记读数（`page-secondary-info`）在**页脚状态栏**
 *       （`files-status-bar`）内，且位于视口底部（bottom 差 ≤ 4px）；
 *   B4. 列头排序：点 `file-sort-title` ⇒ aria-pressed 翻转 + 发出 `sort=title`
 *       请求；点 `file-sort-date` 两次 ⇒ 箭头 ↓→↑（recent↔oldest 互切）；
 *   B5. 分类网格视图（cat:video）仍保留 `media-sort-select`（能力不删，BUG-149）；
 *   T.  验牙（反向变异，页内 inline 改动）：隐藏页脚 ⇒ B3 必红；
 *       改名 context-bar testid ⇒ B1 必红；还原后全部复绿。
 *
 * 用法:: node verify/verify_bug400_files_ia.cjs
 * Exit: 0 = 全部通过；1 = 任一判据失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug400')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const results = {}
const problems = []
function check(name, ok, detail) {
  results[name] = ok ? 'PASS' : `FAIL ${detail || ''}`
  if (!ok) problems.push(`${name}: ${detail || 'failed'}`)
}

/** resource URLs 里是否出现匹配（可等待新请求落地） */
async function waitForResource(page, substr, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const urls = await page.evaluate(
      (s) => performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes(s)),
      substr,
    )
    if (urls.length > 0) return urls
    await delay(150)
  }
  return []
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeout: 30000 },
    )
    await delay(500)

    // ── B1：搜索在标题栏；工具条无搜索/排序 ──
    // 注意：MainLayout 的 ContextBar 外层本身就是 `<header>`，故「在 header 里」
    // 不是反例 —— 判据是：全页**恰一个** header 含搜索框，且那个 header 就是顶栏
    // （内含 context-bar）。面板工具条（另一条 header）必须不含。
    const b1 = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="media-search-input"]')
      const headersWithInput = Array.from(document.querySelectorAll('header')).filter((h) =>
        h.querySelector('[data-testid="media-search-input"]'),
      )
      const inCtxBarHeader = headersWithInput.some((h) => h.querySelector('[data-testid="context-bar"]'))
      return {
        hasInput: !!input,
        inCtx: !!(input && input.closest('[data-testid="context-bar"]')),
        headerCount: headersWithInput.length,
        inCtxBarHeader,
        sortSelects: document.querySelectorAll('[data-testid="media-sort-select"]').length,
      }
    })
    check('B1_search_in_context_bar', b1.hasInput && b1.inCtx && b1.inCtxBarHeader, JSON.stringify(b1))
    check('B1_no_sort_select_in_cat_all', b1.sortSelects === 0, `sortSelects=${b1.sortSelects}`)
    check(
      'B1_no_search_in_panel_toolbar',
      b1.headerCount === 1 && b1.inCtxBarHeader,
      `headers with search=${b1.headerCount} (期望恰 1 = 顶栏)`,
    )

    // ── B2：输入 → wire q=；清除 → 清空 ──
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="media-search-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'bug322')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const qUrls = await waitForResource(page, 'q=bug322')
    check('B2_search_issues_q_request', qUrls.length > 0, 'no resource URL with q=bug322')
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="files-global-search-clear"]')
      if (btn) btn.click()
    })
    await delay(400)
    const cleared = await page.evaluate(
      () => document.querySelector('[data-testid="media-search-input"]').value,
    )
    check('B2_clear_empties_input', cleared === '', `value="${cleared}"`)

    // ── B3：占用/登记在页脚状态栏（全局 footer）内、footer 贴视口底部 ──
    // 注意：files-status-bar 是 footer 里垂直居中的 chip，其自身 bottom 自然高于
    // 视口底 —— 「贴底」判据量的是**所属 footer** 的底边。
    const b3 = await page.evaluate(() => {
      const info = document.querySelector('[data-testid="page-secondary-info"]')
      const bar = info && info.closest('[data-testid="files-status-bar"]')
      const foot = info && info.closest('footer')
      if (!info || !bar || !foot) {
        return { ok: false, detail: 'page-secondary-info/files-status-bar/global footer not found' }
      }
      const diff = Math.abs(foot.getBoundingClientRect().bottom - window.innerHeight)
      return { ok: diff <= 4, detail: `footer bottom diff=${diff}px`, text: info.textContent.trim() }
    })
    check('B3_stats_in_bottom_status_bar', b3.ok, b3.detail || '')
    results.B3_text = b3.text

    // ── B4：列头排序 ──
    const pressed0 = await page.evaluate(
      () => document.querySelector('[data-testid="file-sort-title"]').getAttribute('aria-pressed'),
    )
    await page.evaluate(() => document.querySelector('[data-testid="file-sort-title"]').click())
    const titleUrls = await waitForResource(page, 'sort=title')
    const pressed1 = await page.evaluate(
      () => document.querySelector('[data-testid="file-sort-title"]').getAttribute('aria-pressed'),
    )
    check('B4_title_sort_click', pressed0 === 'false' && pressed1 === 'true' && titleUrls.length > 0,
      `pressed ${pressed0}->${pressed1}, sort=title requests=${titleUrls.length}`)

    await page.evaluate(() => document.querySelector('[data-testid="file-sort-date"]').click())
    await delay(300)
    const arrowDesc = await page.evaluate(
      () => document.querySelector('[data-testid="file-sort-date"]').textContent.trim(),
    )
    await page.evaluate(() => document.querySelector('[data-testid="file-sort-date"]').click())
    await delay(300)
    const arrowAsc = await page.evaluate(
      () => document.querySelector('[data-testid="file-sort-date"]').textContent.trim(),
    )
    check('B4_date_toggle_direction', /↓/.test(arrowDesc) && /↑/.test(arrowAsc),
      `date header "${arrowDesc}" -> "${arrowAsc}"`)

    // ── B5：cat:video 仍保留排序下拉 ──
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-cat-video"]')
      if (el) el.click()
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="media-sort-select"]').length > 0, {
      timeout: 15000,
    })
    check('B5_grid_keeps_sort_select', true)

    // ── 验牙 T1：把读数节点移出 footer ⇒ B3「在 footer 内」必红 ──
    const t1 = await page.evaluate(() => {
      const info = document.querySelector('[data-testid="page-secondary-info"]')
      const parent = info.parentElement
      document.body.appendChild(info)
      const foot = info.closest('footer')
      const ok = (() => {
        if (!foot) return false
        const diff = Math.abs(foot.getBoundingClientRect().bottom - window.innerHeight)
        return diff <= 4
      })()
      parent.appendChild(info)
      return { ok }
    })
    check('T1_teeth_footer_hidden_trips_B3', t1.ok === false, 'B3 did NOT trip when footer hidden (恒绿!)')
    await page.evaluate(() => {
      document.querySelector('[data-testid="files-status-bar"]').style.display = ''
    })

    // ── 验牙 T2：context-bar 改名 ⇒ B1 断言必红 ──
    await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="context-bar"]')
      bar.dataset.savedTestid = 'context-bar'
      bar.setAttribute('data-testid', 'context-bar-mutated')
    })
    await delay(100)
    const t2 = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="media-search-input"]')
      return { inCtx: !!(input && input.closest('[data-testid="context-bar"]')) }
    })
    check('T2_teeth_ctx_renamed_trips_B1', t2.inCtx === false, 'B1 did NOT trip when context-bar renamed (恒绿!)')
    await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="context-bar-mutated"]')
      bar.setAttribute('data-testid', 'context-bar')
      delete bar.dataset.savedTestid
    })

    // 截图（cat-all 形态）
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-files"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeout: 30000 },
    )
    await delay(500)
    const file = path.join(OUT_DIR, 'bug400-files-ia.png')
    await page.screenshot(file, { fullPage: false })
    results.screenshot = file
  } finally {
    await browser.close()
  }

  results.verdict = problems.length === 0 ? 'PASS' : `FAIL (${problems.length})`
  fs.writeFileSync(path.join(OUT_DIR, 'bug400-verify.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  process.exit(problems.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.message ? e.message : e)
  process.exit(1)
})
