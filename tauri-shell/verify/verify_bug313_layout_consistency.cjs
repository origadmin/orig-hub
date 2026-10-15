'use strict'

/**
 * BUG-313 —— 设置页排版一致性回归（SectionCard 单一真源的可证伪验收）。
 *
 * 用户裁定（2026-10-15）：「页面中大量组件排版问题……我说了大量问题，不仅仅是账号区」，
 * 选定「全面收敛：规范单一真源 + 全仓对齐 + 门禁」。本脚本是这句话的守卫：
 *
 * 源码锚（读不到即 FAIL，不靠页面倒推）：
 *   ① SectionCard 契约含 p-5（20px 内边距）且默认节奏 space-y-5；
 *   ② SettingsPanel / AccountsPanel 中**不再有**手写区块卡 class（单一真源）；
 *   ③ AccountsPanel 无页级 h3、无 mx-auto max-w-2xl（去寄生）；
 *   ④ SettingsPanel 恰 7 个页级 h3（每页签一个，network 的 proxy 标题已降级）；
 *   ⑤ i18n accounts.disabledHint 双语齐全（停用态解释，不允许空壳卡）。
 *
 * 运行时锚（getComputedStyle 实量，不数 testid）：
 *   ⑥ 每个区块卡（圆角 12px + 1px 边 + 不透明底）四边 padding 均为 20px；
 *   ⑦ 区块卡不得嵌套区块卡（卡中卡）；
 *   ⑧ 每页签可见区域恰 1 个 h3（页级标题唯一）；
 *   ⑨ 页签顶层块间距 = 24px（space-y-6 节奏，逐缝实量）；
 *   ⑩ telegram 页：账号卡与「停用说明」互斥且必居其一（门控关闭不留空壳）。
 *
 * 反证（证明⑥⑦⑧不是恒真的假绿；每项注入后必须 FAIL，再还原并自证）：
 *   F1 注入第二个 h3 → ⑧ 必须 FAIL；
 *   F2 把一张区块卡塞进另一张区块卡 → ⑦ 必须 FAIL；
 *   F3 把某张卡 padding 改成 16px → ⑥ 必须 FAIL；
 *   还原后 body 的 djb2 哈希与注入前逐位相同（BUG-259 自证纪律；
 *   哈希前剥离空 style 属性，防 React 清回 style="" 造成的假差）。
 *
 * 用法：node tauri-shell/verify/verify_bug313_layout_consistency.cjs
 *   （需 vite :5180；产物落 verify_shots/bug313-layout/）
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  sectionCard: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'ui', 'section-card.tsx'), 'utf8'),
  settings: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'SettingsPanel.tsx'), 'utf8'),
  accounts: fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'components', 'AccountsPanel.tsx'), 'utf8'),
  zh: JSON.parse(fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')),
}
const OUT = process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug313-layout')
const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

/** 区块卡契约（SectionCard 的 class 串；运行时按计算样式识别同一族） */
const CARD_CLASS = 'rounded-xl border border-border-subtle bg-surface p-5'
const RHYTHM_TOP = 24 // 页签容器 space-y-6
const RHYTHM_CARD = 20 // 区块卡内 space-y-5

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 源码锚 ── */
const handWrittenCard = /rounded-xl border border-border-subtle bg-surface p-5/
const srcChecks = () => {
  check('源码①：SectionCard 契约含 p-5（20px 内边距）', SRC.sectionCard.includes(CARD_CLASS))
  check('源码①：SectionCard 默认节奏 space-y-5', /md: 'space-y-5'/.test(SRC.sectionCard))
  check('源码②：SettingsPanel 无手写区块卡（单一真源）', !handWrittenCard.test(SRC.settings))
  check('源码②：AccountsPanel 无手写区块卡（单一真源）', !handWrittenCard.test(SRC.accounts))
  check('源码③：AccountsPanel 无页级 h3（标题已降级为区块级）', !/<h3\b/.test(SRC.accounts))
  check('源码③：AccountsPanel 无 mx-auto max-w-2xl（去页面级容器）', !/mx-auto max-w-2xl/.test(SRC.accounts))
  const h3 = (SRC.settings.match(/<h3\b/g) || []).length
  check('源码④：SettingsPanel 恰 7 个页级 h3（每页签一个）', h3 === 7, `count=${h3}`)
  check('源码④：SettingsPanel 从 ./ui/section-card 引入', /from '\.\/ui\/section-card'/.test(SRC.settings))
  check('源码⑤：i18n accounts.disabledHint 双语齐全',
    typeof SRC.zh['accounts.disabledHint'] === 'string' && SRC.zh['accounts.disabledHint'].length > 0
    && typeof SRC.en['accounts.disabledHint'] === 'string' && SRC.en['accounts.disabledHint'].length > 0)
}

/* 页面侧探针（常量随注入脚本进页面，防 page.evaluate 丢 Node 作用域）。
 * 区块卡身份按 class 词元识别、padding 按计算样式实量：本项目覆写了圆角刻度
 * （src/styles.css 的 --radius-md 为 12px，与 rounded-xl 默认值相同），
 * 单靠计算样式（12px+1px 边）区分不出区块卡与 Stepper/分类行等子元素。 */
const PAGE_JS = `
window.__b313 = {
  sel: ${JSON.stringify({ cardClass: CARD_CLASS })},
  /** 审计范围：设置页滚动容器（页签容器的父节点）——只数当前页签的真实内容，
   *  避免同屏挂载的其他页面（TgPanel/DownloadList 的 h3）污染计数。
   *  必须限定 div：左侧导航按钮同样带 data-sec（SettingsPanel.tsx:588）。 */
  scope(secAttr) {
    const tab = document.querySelector('div[data-sec="' + secAttr + '"]')
    return tab ? tab.parentElement : null
  },
  cards() {
    return [...document.querySelectorAll('div')].filter((el) => this.isCard(el))
  },
  isCard(el) {
    const need = ['rounded-xl', 'border-border-subtle', 'bg-surface', 'p-5']
    return need.every((c) => el.classList.contains(c))
  },
  audit(root) {
    const cards = this.cards().filter((c) => root.contains(c))
    const bad = []
    for (const c of cards) {
      const cs = getComputedStyle(c)
      if (cs.paddingTop !== '20px' || cs.paddingRight !== '20px'
          || cs.paddingBottom !== '20px' || cs.paddingLeft !== '20px') {
        bad.push({ pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join('/'), text: (c.innerText || '').slice(0, 24) })
      }
    }
    // 卡中卡：任一族内卡片是另一族内卡片的后代
    let nested = 0
    for (const a of cards) {
      for (const b of cards) {
        if (a !== b && a.contains(b)) nested += 1
      }
    }
    // 页级 h3（仅当前页签内容区内的可见标题）
    const h3s = [...root.querySelectorAll('h3')].filter((h) => h.offsetParent !== null)
    return {
      cardCount: cards.length,
      badPadding: bad,
      nested,
      h3Count: h3s.length,
      h3Texts: h3s.map((h) => (h.innerText || '').trim()),
    }
  },
  /** 页签顶层块节奏：相邻直接子块上边距 - 前块底边 */
  rhythm(secAttr) {
    const root = document.querySelector('div[data-sec="' + secAttr + '"]')
    if (!root) return null
    const kids = [...root.children].filter((k) => k.getBoundingClientRect().height > 0)
    const gaps = []
    for (let i = 1; i < kids.length; i += 1) {
      const prev = kids[i - 1].getBoundingClientRect()
      const cur = kids[i].getBoundingClientRect()
      gaps.push(Math.round(cur.top - prev.bottom))
    }
    return gaps
  },
  tgAccounts() {
    const hint = document.querySelector('[data-testid="tg-accounts-disabled-hint"]')
    const card = document.querySelector('[data-testid="tg-account-card"]')
    const diag = document.querySelector('[data-testid="tg-accounts-banner"]')
    return {
      hint: hint !== null && hint.offsetParent !== null,
      card: card !== null,
      diag: diag !== null,
    }
  },
  hash() {
    // 剥离空 style 属性后再哈希（React 清回 style="" 会造成假差）
    for (const el of document.querySelectorAll('[style=""]')) el.removeAttribute('style')
    const s = document.body.innerHTML
    let h = 5381
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    return h.toString(16)
  },
}
`

const TABS = [
  { id: 'downloads', sec: 'downloads' },
  { id: 'network', sec: 'network-nics' },
  { id: 'telegram', sec: 'telegram' },
  { id: 'general', sec: 'general' },
  { id: 'engine', sec: 'engine' },
  { id: 'share', sec: 'share' },
  { id: 'about', sec: 'about' },
]

async function main() {
  srcChecks()

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="nav-settings"]'),
      { timeout: 30000 },
    )
    await page.evaluate(() => document.querySelector('[data-testid="nav-settings"]').click())
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="settings-tab-downloads"]'),
      { timeout: 15000 },
    )
    await page.evaluate(PAGE_JS)

    for (const tab of TABS) {
      await page.evaluate((id) => {
        document.querySelector(`[data-testid="settings-tab-${id}"]`).click()
      }, tab.id)
      await page.waitForFunction(
        (sec) => !!document.querySelector(`[data-sec="${sec}"]`),
        { timeout: 10000, args: [tab.sec] },
      )
      await new Promise((r) => setTimeout(r, 350)) // 过渡动画时长裕量
      const a = await page.evaluate((sec) => {
        const root = window.__b313.scope(sec)
        if (!root) return { missing: true, gaps: null }
        const au = window.__b313.audit(root)
        return { ...au, gaps: window.__b313.rhythm(sec) }
      }, tab.sec)
      if (a.missing) {
        check(`[${tab.id}] 页签容器存在`, false, `[data-sec="${tab.sec}"] not found`)
        continue
      }
      check(`⑥ [${tab.id}] 区块卡四边 padding=20px（同族一致）`,
        a.cardCount > 0 && a.badPadding.length === 0,
        `cards=${a.cardCount} bad=${JSON.stringify(a.badPadding)}`)
      check(`⑦ [${tab.id}] 区块卡不嵌套区块卡`, a.nested === 0, `nested=${a.nested}`)
      check(`⑧ [${tab.id}] 恰 1 个页级 h3`, a.h3Count === 1, `count=${a.h3Count} texts=${JSON.stringify(a.h3Texts)}`)
      const gaps = a.gaps || []
      check(`⑨ [${tab.id}] 顶层块间距=24px（space-y-6）`,
        gaps.length > 0 && gaps.every((g) => g === 24), `gaps=${JSON.stringify(gaps)}`)
      if (tab.id === 'telegram') {
        const tg = await page.evaluate(() => window.__b313.tgAccounts())
        check('⑩ telegram：账号卡与停用说明互斥且必居其一（门控关闭不留空壳）',
          tg.card !== tg.hint, `card=${tg.card} hint=${tg.hint}`)
      }
      if (tab.id === 'network') {
        const g2 = await page.evaluate(() => window.__b313.rhythm('network-proxy'))
        check('⑨ [network-proxy] 顶层块间距=24px（proxy 区块同节奏）',
          (g2 || []).length > 0 && g2.every((g) => g === 24), `gaps=${JSON.stringify(g2)}`)
        const h3p = await page.evaluate(() =>
          [...document.querySelectorAll('[data-sec="network-proxy"] h3')].filter((h) => h.offsetParent !== null).length)
        check('⑧ [network-proxy] proxy 标题已降级（块内无页级 h3）', h3p === 0, `h3=${h3p}`)
      }
      await page.screenshot(path.join(OUT, `tab_${tab.id}.png`))
    }

    /* ── 反证：注入必须 FAIL，还原必须自证 ── */
    await page.evaluate(() => document.querySelector('[data-testid="settings-tab-telegram"]').click())
    await new Promise((r) => setTimeout(r, 350))
    const before = await page.evaluate(() => window.__b313.hash())

    // F1：第二个 h3 → ⑧ 必须红
    const f1 = await page.evaluate(() => {
      const root = window.__b313.scope('telegram')
      const h = document.createElement('h3')
      h.textContent = 'FAKE-SECOND-HEADING'
      document.querySelector('div[data-sec="telegram"]').appendChild(h)
      return window.__b313.audit(root).h3Count
    })
    check('反证 F1：注入第二个 h3 后计数变 2（⑧ 非恒真）', f1 === 2, `h3Count=${f1}`)

    // F2：卡中卡 → ⑦ 必须红
    const f2 = await page.evaluate(() => {
      const root = window.__b313.scope('telegram')
      const cards = window.__b313.cards().filter((c) => root.contains(c))
      if (cards.length < 2) return -1
      const clone = cards[0].cloneNode(true)
      cards[1].appendChild(clone)
      return window.__b313.audit(root).nested
    })
    check('反证 F2：注入嵌套卡后 nested>0（⑦ 非恒真）', f2 > 0, `nested=${f2}`)

    // F3：padding 改 16px → ⑥ 必须红
    const f3 = await page.evaluate(() => {
      const root = window.__b313.scope('telegram')
      const cards = window.__b313.cards().filter((c) => root.contains(c))
      if (cards.length === 0) return -1
      cards[0].style.padding = '16px'
      return window.__b313.audit(root).badPadding.length
    })
    check('反证 F3：注入 16px padding 后 badPadding>0（⑥ 非恒真）', f3 > 0, `bad=${f3}`)

    // 还原 + 自证（剥空 style 后哈希须与注入前一致）
    const after = await page.evaluate(() => {
      document.querySelectorAll('div[data-sec="telegram"] h3').forEach((h) => {
        if ((h.innerText || '').includes('FAKE-SECOND-HEADING')) h.remove()
      })
      // F2 注入的克隆卡与 F3 的内联样式一并精确还原。
      const cards = window.__b313.cards()
      for (const c of cards) {
        for (const kid of [...c.children]) {
          if (kid.tagName === 'DIV' && window.__b313.isCard(kid)) kid.remove()
        }
        c.style.padding = ''
        c.style.border = ''
        c.style.borderRadius = ''
        c.style.backgroundColor = ''
      }
      return window.__b313.hash()
    })
    check('自证：还原后 body 哈希与注入前一致（BUG-259 纪律）', after === before, `before=${before} after=${after}`)
    await page.screenshot(path.join(OUT, 'tab_telegram_restored.png'))
  } finally {
    await browser.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} — artifacts: ${OUT}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
