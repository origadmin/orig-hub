'use strict'
/**
 * BUG-320 / BUG-315 活栈验收（Sheet 形态，DLU-T01 2026-10-16 用户裁定
 * 「随 mock 测试那条，改用底部弹出」）：入库行「明细」入口必须**看得见、是
 * 控件**，点开从底部弹 Sheet；Sheet 内条目带「下载」控制（缺字节的条目），
 * 条目级停止的缺席要直说。
 *
 * 与旧行内展开版的差异映射（验牙连续性）：
 *   面板 ingest-group-panel → ingest-detail-sheet（fixed 底部层，不占列表流）
 *   条目 ingest-group-entry → ingest-sheet-entry
 *   下载 ingest-group-entry-download → ingest-sheet-entry-download
 *   A4 去 aria-controls（Sheet 不指向行内面板，无指向关系可断）
 *   A6b 去「收起」文案（Sheet 化后按钮恒「明细 N」，展开态由 aria 表达）
 *   A7 关 Sheet（点 ✕）而非再点入口
 *
 * 判据（每条都要「有值 + 具体值」，不允许「不等于旧值」式假绿）：
 *   A1 入口存在且是 <button>（旧实现是 <span>，不可聚焦、无 aria）；
 *   A2 入口可见：rect 非 0 且**不透明**（opacity/colour 不是透明），字号 ≥ 11px；
 *   A3 入口带文案「明细 N」（不是裸三角符号；Sheet 化后恒此文案）；
 *   A4 入口带 aria-expanded 且初始为 false；
 *   A5 入口可聚焦（focus() 后 document.activeElement 就是它）；
 *   A6 点入口 ⇒ 底部 Sheet 出现（ingest-detail-sheet）且 aria-expanded=true；
 *   A7 点 Sheet ✕ ⇒ 关闭（Sheet 消失、aria 回 false、文案回「明细 N」）；
 *   B1 Sheet 内条目行渲染出来（ingest-sheet-entry ≥ 1）；
 *   B2 缺字节条目（data-bytes=0）条条都有「下载」按钮；
 *   B3 有字节条目（data-bytes=1）没有「下载」按钮（已有字节不重复搬运）；
 *   B4 Sheet 内直说了「条目级停止不存在」（不解释 = 又一个黑洞）。
 *
 * 验牙（反向证伪，任一行必须转红）：
 *   入口改回 `<span>{open ? '▾' : '▸'}</span>` ⇒ A1/A3/A5 红；
 *   去掉 aria-expanded ⇒ A4 红；
 *   条目下载按钮去掉 data-testid ⇒ B2 红（noBytesWithBtn 0 ≠ noBytes）；
 *   停止说明段落去掉 data-testid ⇒ B4 红（note=null）。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug320-expand-toggle')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

/** 注入读取 helper（与主验收脚本同款：导航后必须重新注入）。 */
async function inject(page) {
  await page.evaluate(() => {
    window.__q = (sel) => document.querySelector(sel)
    window.__all = (sel) => Array.from(document.querySelectorAll(sel))
    window.__text = (sel) => {
      const el = document.querySelector(sel)
      return el ? (el.textContent || '').trim() : null
    }
    window.__click = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      el.click()
      return true
    }
  })
}

async function main() {
  const fs = require('node:fs')
  fs.mkdirSync(OUT, { recursive: true })

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0,
    { timeout: 15000 },
  )
  await inject(page)

  // ── A1..A5：入口本身 ────────────────────────────────────────────────
  const t = await page.evaluate(() => {
    const el = window.__q('[data-testid="ingest-group-toggle"]')
    if (!el) return { exists: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      exists: true,
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      ariaExpanded: el.getAttribute('aria-expanded'),
      type: el.getAttribute('type'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      fontSize: parseFloat(cs.fontSize),
      color: cs.color,
      opacity: cs.opacity,
      visibility: cs.visibility,
      hasChevronSvg: !!el.querySelector('svg'),
    }
  })

  check(
    `A1 入口存在且是 <button>（实到 <${t.tag || 'none'}>, type=${t.type}）`,
    t.exists && t.tag === 'BUTTON',
    JSON.stringify(t),
  )
  check(
    `A2 入口可见：${t.w}x${t.h}px、字号 ${t.fontSize}px、opacity ${t.opacity}、色 ${t.color}`,
    t.exists && t.w > 0 && t.h > 0 && t.fontSize >= 11 && t.opacity === '1' && t.visibility === 'visible',
    JSON.stringify(t),
  )
  check(
    `A3 入口带文案而不是裸三角（text="${t.text}"）`,
    /明细\s+\d+/.test(t.text || ''),
    JSON.stringify(t),
  )
  check(
    `A4 入口带 aria-expanded 且初始为 false（实到 ${t.ariaExpanded}）`,
    t.ariaExpanded === 'false',
    JSON.stringify(t),
  )
  const focused = await page.evaluate(() => {
    const el = window.__q('[data-testid="ingest-group-toggle"]')
    if (!el || !el.focus) return false
    el.focus()
    return document.activeElement === el
  })
  check(`A5 入口可聚焦（focus() 后 activeElement === 入口：${focused}）`, focused === true)

  await page.screenshot(path.join(OUT, '01-collapsed-toggle.png'))

  // ── A6：点开 ⇒ 底部 Sheet ──────────────────────────────────────────
  await page.evaluate(() => window.__click('[data-testid="ingest-group-toggle"]'))
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  await inject(page)
  const opened = await page.evaluate(() => {
    const el = window.__q('[data-testid="ingest-group-toggle"]')
    const sheet = window.__q('[data-testid="ingest-detail-sheet"]')
    const cs = sheet ? getComputedStyle(sheet) : null
    return {
      aria: el ? el.getAttribute('aria-expanded') : null,
      text: el ? (el.textContent || '').trim() : null,
      sheetPosition: cs ? cs.position : null,
      sheetBottomAnchored: (() => {
        // 底部弹出 = fixed + 内容贴底（flex items-end）：量面板下沿与视口底距
        if (!sheet) return false
        const panel = sheet.querySelector('[data-testid="ingest-detail-sheet"] > div')
        const r = sheet.getBoundingClientRect()
        return cs.position === 'fixed' && Math.round(r.bottom) >= window.innerHeight - 1
      })(),
      hasGrip: !!sheet && sheet.textContent.includes('⠿'),
    }
  })
  check(
    `A6 点入口弹出底部 Sheet：aria-expanded=${opened.aria}、position=${opened.sheetPosition}、贴底=${opened.sheetBottomAnchored}、抓手=${opened.hasGrip}`,
    opened.aria === 'true' && opened.sheetBottomAnchored === true && opened.hasGrip === true,
    JSON.stringify(opened),
  )

  // ── B1..B4：Sheet 内容 ─────────────────────────────────────────────
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0,
    { timeout: 8000 },
  )
  const entries = await page.evaluate(() => {
    const rows = window.__all('[data-testid="ingest-sheet-entry"]')
    return {
      total: rows.length,
      noBytes: rows.filter((r) => r.getAttribute('data-bytes') === '0').length,
      // BT 式选择（2026-10-19 用户裁定）：缺字节条目带复选框而非下载按钮
      noBytesWithCheckbox: rows.filter(
        (r) =>
          r.getAttribute('data-bytes') === '0' &&
          r.querySelector('[data-testid="ingest-sheet-entry-checkbox"]'),
      ).length,
      hasBytesWithCheckbox: rows.filter(
        (r) =>
          r.getAttribute('data-bytes') === '1' &&
          r.querySelector('[data-testid="ingest-sheet-entry-checkbox"]'),
      ).length,
      // 逐条下载按钮必须不存在（旧模型整体移除）
      legacyDownloadBtn: rows.filter((r) =>
        r.querySelector('[data-testid="ingest-sheet-entry-download"]'),
      ).length,
      selectAll: !!window.__q('[data-testid="ingest-sheet-select-all-box"]'),
      bulkBar: !!window.__q('[data-testid="ingest-sheet-bulk-bar"]'),
      bulkBtn: !!window.__q('[data-testid="ingest-sheet-download-selected"]'),
      note: (() => {
        const n = window.__q('[data-testid="ingest-group-entry-note"]')
        return n ? (n.textContent || '').trim() : null
      })(),
    }
  })
  check(
    `B1 Sheet 内条目行渲染（${entries.total} 条）`,
    entries.total > 0,
    JSON.stringify(entries),
  )
  check(
    `B2 缺字节条目条条有复选框（缺字节 ${entries.noBytes}，带复选框 ${entries.noBytesWithCheckbox}）`,
    entries.noBytes > 0 && entries.noBytesWithCheckbox === entries.noBytes,
    JSON.stringify(entries),
  )
  check(
    `B3 有字节条目不给复选框（有字节却带复选框的行 ${entries.hasBytesWithCheckbox}，应为 0）`,
    entries.hasBytesWithCheckbox === 0,
    JSON.stringify(entries),
  )
  check(
    `B3b 逐条「下载」按钮已整体移除（残留 ${entries.legacyDownloadBtn}，应为 0）`,
    entries.legacyDownloadBtn === 0,
    JSON.stringify(entries),
  )
  check(
    `B5 选择式控件齐备：全选=${entries.selectAll}、批量条=${entries.bulkBar}、批量按钮=${entries.bulkBtn}`,
    entries.selectAll && entries.bulkBar && entries.bulkBtn,
    JSON.stringify(entries),
  )
  check(
    `B4 Sheet 内直说条目级停止不存在（note="${entries.note}"）`,
    /条目级停止不存在/.test(entries.note || ''),
    JSON.stringify(entries),
  )

  await page.screenshot(path.join(OUT, '02-sheet-entries.png'))

  // ── A7：关 Sheet ───────────────────────────────────────────────────
  await page.evaluate(() => window.__click('[data-testid="ingest-detail-sheet-close"]'))
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  await inject(page)
  const closed = await page.evaluate(() => {
    const el = window.__q('[data-testid="ingest-group-toggle"]')
    return {
      aria: el ? el.getAttribute('aria-expanded') : null,
      text: el ? (el.textContent || '').trim() : null,
    }
  })
  check(
    `A7 点 Sheet ✕ 关闭：Sheet 消失、aria=${closed.aria}、文案="${closed.text}"`,
    closed.aria === 'false' && /明细\s+\d+/.test(closed.text || ''),
    JSON.stringify(closed),
  )

  await browser.close()
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-320 Sheet 入口与条目控制：${pass} pass / ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
