'use strict'
/**
 * BUG-320 复报复核（2026-10-20 用户第三次明确「明细按钮删除」）：入库行**没有
 * 明细入口按钮**，明细 Sheet 的唯一入口是折叠头整块点击。Sheet 内条目带
 * BT 式选择控制（缺字节的条目），条目级停止的缺席要直说。
 *
 * 三次诉求与两次未满足（本轮才满足，判据因此锁「不存在」而不是「换形态」）：
 *   2026-10-16「明细 N 按钮位置和样式有问题」→ 只改成底部弹出，按钮还在；
 *   2026-10-19「下载明细不要按钮，只要选择」→ 只删了条目级逐条「下载」按钮，
 *     「明细 N」入口按钮还在；
 *   2026-10-20「明细按钮删除没有修复，明确过 3 次了」→ 删除 `ingest-group-toggle`。
 *
 * 判据（每条都要「有值 + 具体值」，不允许「不等于旧值」式假绿）：
 *   A0 **入口按钮不存在**：`ingest-group-toggle` 0 个；且全页面任何带「明细」
 *      文案的可交互控件（button/a/onclick）0 个 —— 防换个形态长回来；
 *   A1 折叠头（ingest-group-header）是 Sheet 入口：存在、cursor:pointer、
 *      title 指向明细（不是死标题）；
 *   A2 点折叠头 ⇒ 底部 Sheet 出现（ingest-detail-sheet，fixed 贴底 + 抓手）；
 *   A3 点 Sheet ✕ ⇒ 关闭（Sheet 消失）；
 *   B1 Sheet 内条目行渲染出来（ingest-sheet-entry ≥ 1）；
 *   B2 缺字节条目（data-bytes=0）条条都有复选框；
 *   B3 有字节条目（data-bytes=1）没有复选框（已有字节不重复搬运）；
 *   B4 Sheet 内的说明文案随状态给出：整批入库中直说「条目级停止不存在」+ 指路
 *      列表行取消；空闲时直说 BT 式选择语义（只有选中的才会下载）。两种都不许省略。
 *
 * 验牙（反向证伪，任一行必须转红）：
 *   把入口按钮加回来（任何形态：button/span▸/文字链带「明细」）⇒ A0 红；
 *   折叠头 onClick 去掉 ⇒ A2 红（点不开 Sheet）；
 *   条目复选框去掉 data-testid ⇒ B2 红（noBytesWithCheckbox 0 ≠ noBytes）；
 *   说明段落去掉 data-testid ⇒ B4 红（note=null）；只留一种状态文案 ⇒ 另一种状态红。
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

  // ── A0/A1：入口按钮不得存在；折叠头整块即入口 ────────────────────────
  const t = await page.evaluate(() => {
    // A0：明细入口按钮（任何形态）0 个。three-strikes 判据：用户三次要求删除，
    // 只换形态（span▸/文字链/新 testid）都算没满足 —— 按**文案**扫，不按 testid 扫。
    const interactiveWithMingxi = Array.from(
      document.querySelectorAll('button, a, [role="button"], [onclick]'),
    ).filter((el) => /明细/.test(el.textContent || ''))
    const header = document.querySelector('[data-testid="ingest-group-header"]')
    const hs = header ? getComputedStyle(header) : null
    const hr = header ? header.getBoundingClientRect() : null
    return {
      toggleCount: document.querySelectorAll('[data-testid="ingest-group-toggle"]').length,
      interactiveWithMingxi: interactiveWithMingxi.length,
      headerExists: !!header,
      headerCursor: hs ? hs.cursor : null,
      headerTitle: header ? header.getAttribute('title') || '' : '',
      headerW: hr ? Math.round(hr.width) : 0,
      headerH: hr ? Math.round(hr.height) : 0,
    }
  })

  check(
    `A0 明细入口按钮不存在（toggle=${t.toggleCount}、带「明细」文案的可交互控件=${t.interactiveWithMingxi}，均应为 0）`,
    t.toggleCount === 0 && t.interactiveWithMingxi === 0,
    JSON.stringify(t),
  )
  check(
    `A1 折叠头是 Sheet 入口：存在、cursor=${t.headerCursor}、title="${t.headerTitle}"、${t.headerW}x${t.headerH}px`,
    t.headerExists && t.headerCursor === 'pointer' && /明细/.test(t.headerTitle) && t.headerW > 0 && t.headerH > 0,
    JSON.stringify(t),
  )

  await page.screenshot(path.join(OUT, '01-collapsed-row.png'))

  // ── A2：点折叠头 ⇒ 底部 Sheet ──────────────────────────────────────
  await page.evaluate(() => window.__click('[data-testid="ingest-group-header"]'))
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  await inject(page)
  const opened = await page.evaluate(() => {
    const sheet = window.__q('[data-testid="ingest-detail-sheet"]')
    const cs = sheet ? getComputedStyle(sheet) : null
    return {
      sheetPosition: cs ? cs.position : null,
      sheetBottomAnchored: (() => {
        // 底部弹出 = fixed + 内容贴底（flex items-end）：量面板下沿与视口底距
        if (!sheet) return false
        const r = sheet.getBoundingClientRect()
        return cs.position === 'fixed' && Math.round(r.bottom) >= window.innerHeight - 1
      })(),
      hasGrip: !!sheet && sheet.textContent.includes('⠿'),
    }
  })
  check(
    `A2 点折叠头弹出底部 Sheet：position=${opened.sheetPosition}、贴底=${opened.sheetBottomAnchored}、抓手=${opened.hasGrip}`,
    opened.sheetBottomAnchored === true && opened.hasGrip === true,
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
      // 全选框的禁用态：整批入库中（isActive）或没有缺字节条目时为 disabled。
      // 与 note 文案配对即可还原「当前是哪个状态」（见 B4）。
      selectAllDisabled: (() => {
        const el = window.__q('[data-testid="ingest-sheet-select-all-box"]')
        return !!el && el.disabled === true
      })(),
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
  // B4：说明文案必须**随状态**给出，两种合法形态都不许省略（不解释 = 黑洞）：
  //   - 整批入库中（有缺字节条目但全选被禁用）⇒ 直说「条目级停止不存在」+ 指路取消；
  //   - 空闲 ⇒ 直说 BT 式选择语义（只有选中的才会下载）。
  // 判据用「有缺字节条目 ∧ 全选禁用」还原 isActive —— 空闲时全选可用，
  // 全部已入库时没有可选条目，那也不算 active（note 走 BT 文案）。
  const sheetActive = entries.noBytes > 0 && entries.selectAllDisabled
  check(
    `B4 说明文案随状态给出（active=${sheetActive}，note="${entries.note}"）`,
    sheetActive
      ? /条目级停止不存在/.test(entries.note || '')
      : /只有选中的才会下载/.test(entries.note || ''),
    JSON.stringify(entries),
  )

  await page.screenshot(path.join(OUT, '02-sheet-entries.png'))

  // ── A3：关 Sheet ───────────────────────────────────────────────────
  await page.evaluate(() => window.__click('[data-testid="ingest-detail-sheet-close"]'))
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  await inject(page)
  const closed = await page.evaluate(() => ({
    sheetGone: !document.querySelector('[data-testid="ingest-detail-sheet"]'),
    // 关掉后入口按钮依然不得出现（Sheet 生命周期不会把按钮长回来）
    toggleCount: document.querySelectorAll('[data-testid="ingest-group-toggle"]').length,
    headerStill: !!document.querySelector('[data-testid="ingest-group-header"]'),
  }))
  check(
    `A3 点 Sheet ✕ 关闭：Sheet 消失=${closed.sheetGone}、按钮仍为 0=${closed.toggleCount === 0}、折叠头仍在=${closed.headerStill}`,
    closed.sheetGone && closed.toggleCount === 0 && closed.headerStill,
    JSON.stringify(closed),
  )

  await browser.close()
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-320 复报（明细按钮已删除 / 折叠头为唯一入口 / 条目选择控制）：${pass} pass / ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
