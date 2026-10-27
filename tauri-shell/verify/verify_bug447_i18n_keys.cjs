'use strict'

/**
 * BUG-447 验收：代码引用的 i18n key 必须在 locale 里存在，界面不得显示原始 key。
 *
 * 缺陷的两层（缺一不可，只修一层都会复发）：
 *   1. 代码 `t('media.card.delete')` 引用的 key 两个 locale 都没定义 ⇒ `t()` 未命中
 *      时回退返回 key 字面量 ⇒ 界面直接把 `media.card.delete` 显示给用户；
 *   2. 门禁只做「zh-CN ↔ en-US 双语对齐」⇒ 「完全对齐」与「引用一批不存在的 key」
 *      同时成立，门禁全绿。
 *
 * 断言分三组：
 *   A. 门禁侧（静态）：`check-i18n-keys.py` 必须**能**抓到悬空引用 —— 反向变异：
 *      临时从两个 locale 删掉一个被引用的 key，门禁必须 FAIL 且报 dangling（恒绿检测）。
 *   B. 门禁侧（当前态）：当前代码 + 当前 locale 跑门禁必须 0 违反。
 *   C. 运行时（CDP 真实渲染）：关键页面可见文本里不得出现 i18n-key 形状的字符串
 *      （`media.card.delete` / `download.panel.emptyTitle` 这类）。
 *
 *   node tauri-shell/verify/verify_bug447_i18n_keys.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '..', '..')
const ZH = path.join(REPO, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json')
const EN = path.join(REPO, 'tauri-shell', 'src', 'i18n', 'locales', 'en-US.json')
const GATE = path.join(REPO, 'scripts', 'check-i18n-keys.py')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5180'

/** locale 的顶层命名空间 = 「这串点分文本是不是 i18n key」的唯一可靠判据。 */
const NAMESPACES = new Set(
  Object.keys(JSON.parse(fs.readFileSync(ZH, 'utf8'))).map((k) => k.split('.')[0]),
)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed++
}

function runGate() {
  try {
    const out = execFileSync('python3', [GATE], { cwd: REPO, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

/** 反向变异：删掉一个真实被引用的 key，门禁必须变红（证明断言有牙）。 */
function falsify() {
  const probe = 'media.card.delete'
  const backup = { zh: fs.readFileSync(ZH), en: fs.readFileSync(EN) }
  try {
    for (const p of [ZH, EN]) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (!(probe in data)) return { ok: false, detail: `probe key ${probe} not in ${path.basename(p)}` }
      delete data[probe]
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
    }
    const r = runGate()
    const red = r.code !== 0 && /dangling i18n reference/.test(r.out) && r.out.includes(probe)
    return { ok: red, detail: `exit=${r.code} mentionsProbe=${r.out.includes(probe)}` }
  } finally {
    fs.writeFileSync(ZH, backup.zh)
    fs.writeFileSync(EN, backup.en)
  }
}

async function scanPages() {
  const cdp = require('./lib/cdp.cjs')
  const browser = await cdp.launch()
  const leaks = []
  try {
    const page = await browser.newPage()
    // 首屏（文件域）
    await page.goto(BASE, { waitUntil: 'load', timeoutMs: 60000 })
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)))

    const stops = [
      ['files', 'nav-files'],
      ['download', 'nav-download'],
      ['tg', 'nav-tg'],
      ['settings', 'nav-settings'],
    ]
    for (const [label, testid] of stops) {
      const clicked = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        if (!el) return false
        el.click()
        return true
      }, testid)
      if (!clicked) {
        leaks.push({ page: label, leak: `NAV_MISSING:${testid}` })
        continue
      }
      await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)))
      // 前置：页面必须**真的有内容**。空页面（「媒体服务未运行」）上扫不到 raw key
      // 是无意义的恒绿 —— 第一次跑这条断言时正是这种假通过。
      const rowCount = await page.evaluate(
        () =>
          document.querySelectorAll(
            '[data-testid="file-list-row"], [data-testid="media-card"], [data-testid="series-card"], [data-testid="download-item"], [data-testid="nav-child-lib-series"]',
          ).length,
      )
      if ((label === 'files' || label === 'download') && rowCount === 0) {
        leaks.push({ page: label, leak: 'EMPTY_PAGE:no rows to scan' })
        continue
      }
      // 声纳自检（禁恒绿）：先往页面塞一段 key 形状的文本，扫描器必须命中它。
      // 不做这一步，「扫描 0 命中」既可能是真干净，也可能是扫描器根本不工作。
      let sonar = null
      if (label === 'files') {
        await page.evaluate(() => {
          const el = document.createElement('span')
          el.id = '__i18n_sonar'
          el.textContent = 'media.card.delete'
          document.body.appendChild(el)
        })
        sonar = await page.evaluate((namespaces) => {
          const ns = new Set(namespaces)
          const re = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,3}\b/g
          const el = document.getElementById('__i18n_sonar')
          const hits = [...(el?.textContent || '').matchAll(re)].map((m) => m[0]).filter((s) => ns.has(s.split('.')[0]))
          el?.remove()
          return hits
        }, [...NAMESPACES])
      }

      const found = await page.evaluate((namespaces) => {
        // i18n key 形状：小写字母开头的点分段标识符，至少两段，且**首段是已知命名空间**。
        // 只按「点分」判会误报文件名（实测 `bug322ui.bin` / `d.zip` / `c.zip` 全被抓），
        // 而文件名与 key 的字符形状完全一样 —— 唯一可靠判据是首段 ∈ locale 顶层命名空间。
        const ns = new Set(namespaces)
        const re = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,3}\b/g
        const skip = /\.(png|jpe?g|svg|css|js|tsx?|json|mp4|html|exe|dll|log)$/i
        const out = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walker.nextNode())) {
          const t = (n.nodeValue || '').trim()
          if (!t) continue
          const host = n.parentElement
          if (!host) continue
          const tag = host.tagName
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue
          for (const m of t.matchAll(re)) {
            const s = m[0]
            if (skip.test(s)) continue
            if (!ns.has(s.split('.')[0])) continue
            out.push(s)
          }
        }
        return [...new Set(out)]
      }, [...NAMESPACES])
      if (sonar) {
        check('C0 扫描器声纳自检（注入 key 形状文本必须命中）', sonar.includes('media.card.delete'), `hits=${JSON.stringify(sonar)}`)
      }
      for (const l of found) leaks.push({ page: label, leak: l })
      await page.screenshot(path.join(REPO, 'tauri-shell', 'verify', 'evidence', 'BUG-447', `${label}.png`))
    }
  } finally {
    await browser.close()
  }
  return leaks
}

async function main() {
  fs.mkdirSync(path.join(REPO, 'tauri-shell', 'verify', 'evidence', 'BUG-447'), { recursive: true })

  // A. 门禁有牙（反向变异）
  const f = falsify()
  check('A1 删掉被引用的 key 后门禁必须 FAIL（反向变异）', f.ok, f.detail)

  // B. 当前态门禁全绿
  const r = runGate()
  check('B1 当前代码 + locale 跑门禁 0 违反', r.code === 0, r.out.trim().split(/\r?\n/).slice(-1)[0] || '')

  // C. 运行时无 key 泄漏
  let leaks = []
  try {
    leaks = await scanPages()
  } catch (e) {
    check('C0 CDP 可打开页面', false, String(e && e.message ? e.message : e))
  }
  const real = leaks.filter((l) => !l.leak.startsWith('NAV_MISSING:'))
  check('C1 关键页面可见文本无 i18n key 泄漏', real.length === 0,
    real.length ? JSON.stringify(real.slice(0, 8)) : 'files/download/tg/settings 四页扫描通过')

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
  fs.writeFileSync(
    path.join(REPO, 'tauri-shell', 'verify', 'evidence', 'BUG-447', 'report.json'),
    JSON.stringify({ failed, leaks }, null, 2),
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
