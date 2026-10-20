'use strict'
/**
 * BUG-330 TGM-04 探针：筛选节（③ · 内容定义面）。
 *
 * 用户 2026-10-20 二次复报原话：
 *   「按照『消费序』，筛选改为标题右上角按钮，弹出添加设计，当前下方一行的方式
 *     严重破坏了整体设计。显示的标题也有严重问题，同一文字显示 2 串，且排版突兀。
 *     还有筛选需要考虑多个显示超出规则后的折叠和展示。」
 *
 * 判据（真实渲染 + 真实鼠标事件）：
 *   F1 右上角「+ 新建」真按钮（热区 ≥24px、aria-haspopup）→ 弹窗出现；
 *     节内**不再有**常驻输入行（旧形态：tg-filter-input 不在弹窗外）。
 *   F2 弹窗建「显示名 ≠ 关键词」的规则 ⇒ 左栏两行都显（标题 + "关键词" 副行）。
 *   F3 弹窗只填关键词（label 缺省 = keyword）⇒ 左栏**只渲染一行**
 *     （「同一文字显示 2 串」的修复判据）。
 *   F4 主列命中工作台副条同样去重：label≡keyword 时副条只有匹配说明。
 *   F5 节内检索框：不匹配词 ⇒ 「没有匹配的规则」；清空恢复。
 *   F6 超 K 折叠（K=8）：API 直建 9 条 ⇒ DOM 只渲染 K 条 + 「+N 条规则」
 *     控件（aria-expanded=false）⇒ 点击展开全部 + 「收起」。
 *   F7 行内溯源「搜 N 个监控频道」N === API monitored 真值。
 *   F8 +N 新命中徽标：0 不渲染（有值的行徽标数 === API newHits）。
 *
 * 反向证伪（--expect-legacy）：反置 F1b（期望节外有常驻输入行——旧形态）与
 * F3（期望 label≡keyword 渲染 2 串——旧「同一文字显示 2 串」）⇒ 必须 FAIL exit 1。
 *
 * 清理：本脚本建的规则全部 DELETE（finally）。
 *
 * 用法：node tauri-shell/verify/_probe_tgm04_filter_section.cjs
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。产物 verify_shots/tgm04-filter-section/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tgm04-filter-section')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const FOLD_K = 8
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const created = []

async function tgApi(method, url, body) {
  const res = await fetch(`${TG}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function realClick(page, selector) {
  const pt = await page.evaluate((sel) => {
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
  if (!pt) throw new Error(`realClick: 找不到或不可见 ${selector}`)
  if (!pt.hitOk) throw new Error(`realClick: ${selector} 的点击点被其它元素占据`)
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

async function fillDialog(page, { keyword, label }) {
  await page.evaluate(
    ({ keyword, label }) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      const kw = document.querySelector('[data-testid="tg-filter-input"]')
      setter.call(kw, keyword)
      kw.dispatchEvent(new Event('input', { bubbles: true }))
      if (label !== null) {
        const lb = document.querySelector('[data-testid="tg-filter-label-input"]')
        setter.call(lb, label)
        lb.dispatchEvent(new Event('input', { bubbles: true }))
      }
    },
    { keyword, label },
  )
}

/** 登记 UI 建的规则 id（finally 清理用）：必须在“规则已出现”之后调用。 */
async function registerCreatedRule(keyword) {
  const list = await tgApi('GET', '/api/tg/monitor/filters')
  const found = (list.items || []).find((f) => f.keyword === keyword)
  if (found) created.push(found.id)
}

const FILTER_ROWS_SNAP = () =>
  Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]')).map((r) => {
    const ps = Array.from(r.querySelectorAll('p')).map((p) => p.textContent.trim())
    return { lines: ps, hasBadge: !!r.querySelector('[data-testid="tg-filter-new-badge"]') }
  })

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
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 600 })
    await page.goto(APP)
    await openTgPanel(page)
    await sleep(400)

    const results = []
    const problems = []
    const push = (name, ok, detail) => {
      results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) problems.push(name)
    }

    // ── F1：右上角新建按钮 + 弹窗；节内无常驻输入行 ──
    const f1 = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="tg-filter-new"]')
      const r = btn ? btn.getBoundingClientRect() : null
      const cs = btn ? getComputedStyle(btn) : null
      return {
        exists: !!btn,
        w: r ? Math.round(r.width) : 0,
        h: r ? Math.round(r.height) : 0,
        text: btn ? btn.textContent.trim() : '',
        hasPopup: btn ? btn.getAttribute('aria-haspopup') : null,
        borderW: cs ? cs.borderTopWidth : null,
        bg: cs ? cs.backgroundColor : null,
      }
    })
    // BUG-344（用户 2026-10-20 夜：「按钮过大」「筛选右边还有文字…按钮长宽高都
    // 需要规范化」）：token = h-7（28px）**图标钮**，无文字标签。可见性由
    // **边框 + 底色**承担（secondary variant）——这是 BUG-327「存在≠可用」
    // （初版 28px 裸图标被当成空白）与 BUG-344「过大 + 有字」的共同解：
    // 不再用尺寸 + 文字标签证明按钮存在。
    // 2026-10-20 收紧为**精确 28×28**：原 24–32 宽松区间放过了「声明 h-7 实际
    // 渲染 32px」的形态（cn 裸 join，调用方 h-7 被 sizeClasses 的 h-8 按样式表
    // 源序赢掉）⇒ 现改一等 size token（icon-sm）。reverse 变异（装回 h-9 带字
    // 形态 = 36px+文字，或装回 h-7 override 被 h-8 赢 = 32px）必须 FAIL。
    push(
      'F1a 「+ 新建」图标钮 token：28×28 无文字标签且有边框底色（BUG-344）',
      f1.exists &&
        f1.w === 28 &&
        f1.h === 28 &&
        f1.text.length === 0 &&
        f1.hasPopup === 'dialog' &&
        f1.borderW === '1px' &&
        f1.bg !== 'rgba(0, 0, 0, 0)' &&
        f1.bg !== 'transparent',
      JSON.stringify(f1),
    )
    await realClick(page, '[data-testid="tg-filter-new"]')
    const dlg = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="tg-filter-dialog"]')
      const inputInDialog = d
        ? !!d.querySelector('[data-testid="tg-filter-input"]')
        : false
      const inputOutside = Array.from(
        document.querySelectorAll('[data-testid="tg-filter-input"]'),
      ).filter((el) => !el.closest('[data-testid="tg-filter-dialog"]')).length
      return { dialog: !!d, inputInDialog, inputOutside }
    })
    if (EXPECT_LEGACY) {
      // 旧形态：规则列表下方常驻一行 Input + 添加按钮（用户「严重破坏整体设计」）
      push(
        'F1b [legacy 反置] 节外存在常驻输入行',
        dlg.inputOutside === 1,
        JSON.stringify(dlg),
      )
    } else {
      push(
        'F1b 弹窗出现且输入框迁入弹窗（节外无常驻输入行）',
        dlg.dialog && dlg.inputInDialog && dlg.inputOutside === 0,
        JSON.stringify(dlg),
      )
    }

    // ── F2：显示名 ≠ 关键词 ⇒ 两行都显 ──
    const kwA = `__verify_f2_${Date.now()}`
    await fillDialog(page, { keyword: kwA, label: '验证F2显示名' })
    await realClick(page, '[data-testid="tg-filter-dialog"] [data-testid="tg-filter-add"]')
    await page.waitForFunction(
      (kw) =>
        Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]')).some((r) =>
          (r.textContent || '').includes(kw),
        ),
      { timeout: 15000, args: [kwA] },
    )
    await registerCreatedRule(kwA)
    const rowsAfterA = await page.evaluate(FILTER_ROWS_SNAP)
    const rowA = rowsAfterA.find((r) => r.lines.some((l) => l.includes(kwA)))
    push(
      'F2 显示名≠关键词 ⇒ 标题行 + 关键词副行两行都显',
      !!rowA && rowA.lines.length >= 2 && rowA.lines[0] === '验证F2显示名',
      JSON.stringify(rowA),
    )

    // ── F3：label 缺省 = keyword ⇒ 只渲染一行（去重判据） ──
    const kwB = `__verify_f3_${Date.now()}`
    await realClick(page, '[data-testid="tg-filter-new"]')
    await fillDialog(page, { keyword: kwB, label: '' })
    await realClick(page, '[data-testid="tg-filter-dialog"] [data-testid="tg-filter-add"]')
    await page.waitForFunction(
      (kw) =>
        Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]')).some((r) =>
          (r.textContent || '').includes(kw),
        ),
      { timeout: 15000, args: [kwB] },
    )
    await registerCreatedRule(kwB)
    const rowsAfterB = await page.evaluate(FILTER_ROWS_SNAP)
    const rowB = rowsAfterB.find((r) => r.lines.some((l) => l.includes(kwB)))
    // 去重判据：行内文本串里 kwB 只出现一次（标题），不再有第二串相同文字
    const occurrences = rowB ? rowB.lines.filter((l) => l.includes(kwB)).length : 0
    if (EXPECT_LEGACY) {
      // 旧行为：标题 + 副行"关键词"两串相同文字（用户「同一文字显示 2 串」）
      push(
        'F3 [legacy 反置] label≡keyword 渲染 2 串',
        occurrences === 2,
        JSON.stringify(rowB),
      )
    } else {
      push(
        'F3 label≡keyword ⇒ 同一文字只渲染一串（不再 2 串）',
        !!rowB && occurrences === 1,
        JSON.stringify(rowB),
      )
    }

    // ── F4：主列副条去重 ──
    await realClick(page, '[data-testid="tg-filter-new"]') // 关弹窗（避免遮挡）
    await page.evaluate((kw) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]'))
      const target = rows.find((r) => (r.textContent || '').includes(kw))
      if (target) target.querySelector('button').click()
    }, kwB)
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
      { timeout: 10000 },
    )
    const f4 = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="tg-filter-panel"]')
      // 副条 = header 下方那条说明行（class 含 shrink-0 border-b）；
      // 不能按文本含「匹配」全量收集 —— 空态「没有匹配的内容」也会命中。
      const sub = panel ? panel.querySelector('div.shrink-0.border-b') : null
      return { sub: sub ? sub.textContent.trim() : null }
    })
    push(
      'F4 主列副条 label≡keyword 时只有匹配说明（无第二串关键词）',
      !!f4.sub && !f4.sub.includes(kwB),
      JSON.stringify(f4),
    )
    await realClick(page, '[data-testid="tg-filter-back"]')

    // ── F5：检索框 ──
    await page.evaluate(() => {
      const s = document.querySelector('[data-testid="tg-filter-search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(s, '__绝对不存在的词__')
      s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(300)
    const f5a = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="tg-filter-row"]').length,
      noMatch: (document.body.textContent || '').includes('没有匹配的规则'),
    }))
    push('F5a 检索无匹配 ⇒ 「没有匹配的规则」', f5a.rows === 0 && f5a.noMatch, JSON.stringify(f5a))
    await page.evaluate(() => {
      const s = document.querySelector('[data-testid="tg-filter-search"]')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(s, '')
      s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(300)
    const f5b = await page.evaluate(
      () => document.querySelectorAll('[data-testid="tg-filter-row"]').length,
    )
    push('F5b 清空检索 ⇒ 规则恢复', f5b > 0, `rows=${f5b}`)

    // ── F6：超 K 折叠 ──
    const bulk = []
    for (let i = 0; i < FOLD_K + 1; i++) {
      const kw = `__verify_fold_${Date.now()}_${i}`
      const r = await tgApi('POST', '/api/tg/monitor/filters', { keyword: kw })
      if (r && r.id) {
        created.push(r.id)
        bulk.push(kw)
      }
    }
    // 等前端重新拉到（轮询 5s：面板只在挂载/添加时刷新 ⇒ 触发一次导航重入）
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    await page.goto(APP)
    await openTgPanel(page)
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="tg-filter-row"]').length >= n,
      { timeout: 20000, args: [FOLD_K] },
    )
    await sleep(300)
    const f6a = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="tg-filter-row"]').length
      const toggle = document.querySelector('[data-testid="tg-filter-fold-toggle"]')
      return {
        rows,
        toggle: !!toggle,
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        text: toggle ? toggle.textContent.trim() : null,
      }
    })
    push(
      `F6a 超 K 默认只渲染 K 条 + 折叠控件 aria-expanded=false`,
      f6a.rows === FOLD_K && f6a.toggle && f6a.expanded === 'false' && f6a.text.includes('+'),
      JSON.stringify(f6a),
    )
    await realClick(page, '[data-testid="tg-filter-fold-toggle"]')
    await sleep(300)
    const f6b = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="tg-filter-row"]').length,
      toggle: document.querySelector('[data-testid="tg-filter-fold-toggle"]')
        ? document.querySelector('[data-testid="tg-filter-fold-toggle"]').textContent.trim()
        : null,
    }))
    push(
      'F6b 点折叠控件 ⇒ 展开全部 + 「收起」',
      f6b.rows > FOLD_K && f6b.toggle === '收起',
      JSON.stringify(f6b),
    )

    // ── F7：无授权溯源文案已撤（第三次复报）──
    const f7 = await page.evaluate(() => {
      const aside = document.querySelector('aside')
      const txt = aside ? aside.textContent.replace(/\s+/g, ' ') : ''
      return ['搜 ', '个监控频道', '来自', '来源'].filter((k) => txt.includes(k))
    })
    push('F7 左栏无「搜 N 个监控频道/来自/来源」溯源文案（BUG-148）', f7.length === 0, JSON.stringify(f7))

    // ── F8：+N 徽标 0 不渲染 ──
    const f8 = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]'))
      return rows.map((r) => !!r.querySelector('[data-testid="tg-filter-new-badge"]'))
    })
    push('F8 新建规则 newHits=0 ⇒ 徽标不渲染', f8.every((v) => v === false), JSON.stringify(f8))

    await page.screenshot(path.join(OUT, 'filter-section.png'))
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
