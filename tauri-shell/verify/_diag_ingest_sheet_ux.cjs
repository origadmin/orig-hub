'use strict'
/**
 * 诊断：入库明细底部 Sheet 的**可读性与可操作性**实测（用户 2026-10-20 报
 * 「选中的=要下载的 / 实际全部非选中 / 全选和选中偏离 / 按钮完全无法找到 /
 * 字体小得看不清」）。
 *
 * 只测不修：把「看不见的按钮」「12px 复选框」「10px 说明」「默认零选中」
 * 这些主观描述变成可复核的数字，再决定改什么。
 *
 * 用法：node tauri-shell/verify/_diag_ingest_sheet_ux.cjs
 * 产物：verify_shots/diag-ingest-sheet-ux/（截图 + report.json）
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'diag-ingest-sheet-ux')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

async function main() {
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
  // 打开第一个入库组的明细
  await page.evaluate(() => {
    document.querySelector('[data-testid="ingest-group-header"]').click()
  })
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  // 等清单懒加载回来（等行数 > 0，不是等容器出现）
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0,
    { timeout: 15000 },
  )

  await page.screenshot(path.join(OUT, '01-sheet-default.png'))

  const report = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        bottom: Math.round(r.bottom),
        right: Math.round(r.right),
        inViewport:
          r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1,
      }
    }
    const fs2 = (el) => (el ? parseFloat(getComputedStyle(el).fontSize) : null)
    /** 命中测试：中心点上真正接事件的是谁（遮挡/越界的实证）。 */
    const hitAt = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1)
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
      const hit = document.elementFromPoint(cx, cy)
      return {
        hitTag: hit ? hit.tagName : null,
        hitSelf: !!hit && (el === hit || el.contains(hit)),
        hitTestId: hit ? hit.getAttribute('data-testid') : null,
      }
    }

    const sheet = document.querySelector('[data-testid="ingest-detail-sheet"]')
    const panel = sheet ? sheet.firstElementChild && sheet.querySelector(':scope > div.relative') : null
    const bulkBar = document.querySelector('[data-testid="ingest-sheet-bulk-bar"]')
    const bulkBtn = document.querySelector('[data-testid="ingest-sheet-download-selected"]')
    const note = document.querySelector('[data-testid="ingest-group-entry-note"]')
    const selectAllLabel = document.querySelector('[data-testid="ingest-sheet-select-all"]')
    const selectAllBox = document.querySelector('[data-testid="ingest-sheet-select-all-box"]')
    const entries = Array.from(document.querySelectorAll('[data-testid="ingest-sheet-entry"]'))
    const boxes = Array.from(
      document.querySelectorAll('[data-testid="ingest-sheet-entry-checkbox"]'),
    )
    const scrollBody = sheet
      ? Array.from(sheet.querySelectorAll('div')).find((d) => {
          const cs = getComputedStyle(d)
          return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
        })
      : null

    /** position:fixed 是否被 transform/filter 祖先劫持（会让贴底面板跑到视口外）。 */
    const fixedBreakers = []
    for (let el = sheet && sheet.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el)
      if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || cs.contain.includes('paint')) {
        fixedBreakers.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          transform: cs.transform,
          filter: cs.filter,
        })
      }
    }

    return {
      viewport: { vw, vh },
      sheet: rect(sheet),
      panel: rect(panel),
      bulkBar: { rect: rect(bulkBar), hit: hitAt(bulkBtn) },
      bulkBtn: {
        rect: rect(bulkBtn),
        fontSize: fs2(bulkBtn),
        text: bulkBtn ? bulkBtn.textContent.trim() : null,
        disabled: bulkBtn ? bulkBtn.disabled : null,
      },
      note: { fontSize: fs2(note), text: note ? note.textContent.trim() : null },
      selectAll: {
        labelRect: rect(selectAllLabel),
        labelFontSize: fs2(selectAllLabel),
        boxRect: rect(selectAllBox),
        checked: selectAllBox ? selectAllBox.checked : null,
        indeterminate: selectAllBox ? selectAllBox.indeterminate : null,
      },
      counts: {
        entries: entries.length,
        checkboxes: boxes.length,
        checkedRows: boxes.filter((b) => b.checked).length,
        dataSelected: entries.filter((e) => e.dataset.selected === '1').length,
      },
      entryFontSize: entries.length ? fs2(entries[0]) : null,
      checkboxSize: boxes.length
        ? { w: rect(boxes[0]).w, h: rect(boxes[0]).h }
        : null,
      /** 每个条目行的字号分布（10/11/12 混排是「看不清」的直接证据）。 */
      fontSizeHistogram: (() => {
        const hist = {}
        for (const el of document.querySelectorAll('[data-testid="ingest-detail-sheet"] *')) {
          if (!el.textContent || !el.textContent.trim()) continue
          if (el.children.length > 0) continue
          const s = parseFloat(getComputedStyle(el).fontSize)
          hist[s] = (hist[s] || 0) + 1
        }
        return hist
      })(),
      scroll: scrollBody
        ? {
            clientHeight: scrollBody.clientHeight,
            scrollHeight: scrollBody.scrollHeight,
            scrollable: scrollBody.scrollHeight > scrollBody.clientHeight,
          }
        : null,
      fixedBreakers,
      pageErrors: [],
    }
  })

  // ── 交互：点「全选」，看全选框与行是否同步 ─────────────────────────
  const afterAll = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="ingest-sheet-select-all-box"]')
    if (!box) return { clicked: false }
    box.click()
    return { clicked: true }
  })
  await new Promise((r) => setTimeout(r, 400))
  const allState = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="ingest-sheet-select-all-box"]')
    const boxes = Array.from(
      document.querySelectorAll('[data-testid="ingest-sheet-entry-checkbox"]'),
    )
    const entries = Array.from(document.querySelectorAll('[data-testid="ingest-sheet-entry"]'))
    const btn = document.querySelector('[data-testid="ingest-sheet-download-selected"]')
    const r = btn ? btn.getBoundingClientRect() : null
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
    return {
      selectAllChecked: box ? box.checked : null,
      selectAllIndeterminate: box ? box.indeterminate : null,
      checkedRows: boxes.filter((b) => b.checked).length,
      rows: boxes.length,
      dataSelected: entries.filter((e) => e.dataset.selected === '1').length,
      btnText: btn ? btn.textContent.trim() : null,
      btnDisabled: btn ? btn.disabled : null,
      btnRect: r
        ? { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) }
        : null,
      btnHitSelf: !!(hit && btn && (btn === hit || btn.contains(hit))),
      btnInViewport: r ? r.top >= 0 && r.bottom <= window.innerHeight : null,
    }
  })
  await page.screenshot(path.join(OUT, '02-sheet-all-selected.png'))

  // ── 窄窗（最矮受支持窗口）下的同一组量 ────────────────────────────
  await page.setViewport && (await page.setViewport({ width: 1280, height: 640 }))
  await new Promise((r) => setTimeout(r, 500))
  const narrow = await page.evaluate(() => {
    const vh = window.innerHeight
    const btn = document.querySelector('[data-testid="ingest-sheet-download-selected"]')
    const bar = document.querySelector('[data-testid="ingest-sheet-bulk-bar"]')
    const r = btn ? btn.getBoundingClientRect() : null
    const br = bar ? bar.getBoundingClientRect() : null
    return {
      vh,
      btnRect: r ? { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null,
      barRect: br ? { y: Math.round(br.y), bottom: Math.round(br.bottom) } : null,
      btnInViewport: r ? r.top >= 0 && r.bottom <= vh : null,
    }
  })
  await page.screenshot(path.join(OUT, '03-sheet-narrow-1280x640.png'))

  const out = { report, afterAll, allState, narrow }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(JSON.stringify(out, null, 2))

  await browser.close()
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
