#!/usr/bin/env node
'use strict'

/**
 * BUG-256 geometry probe — MEASURE (not estimate) the vertical budget of the
 * 「临时文件回收」(cache reclamation) tab inside the cache-manager dialog.
 *
 * WHY THIS EXISTS
 * ---------------
 * BUG-256 claims "9 widgets stacked above the item list, ~393px ≈ 47% of the
 * 80vh dialog". That 47% was derived by reading Tailwind class names — it was
 * explicitly labelled an ESTIMATE and never measured with getComputedStyle /
 * getBoundingClientRect. The product owner's complaint ("上半部分无用内容占据
 * 弹窗一半") is entirely about the PROPORTION, so the number must be real pixels.
 *
 * WHAT IT MEASURES (all via getComputedStyle + getBoundingClientRect in page)
 *   1. dialog container: rect + computed max-height + resolved 80vh; viewport h
 *   2. every widget rendered ABOVE the first item row, in visual order:
 *      class list + measured height; the SUM; and the SUM + the gap offset from
 *      the dialog content top, each as a % of the dialog's inner content height
 *   3. whether the ingest-stats strip (`cache-ingest-summary`) renders in BOTH
 *      tabs — measured in the pipeline tab AND in the reclamation tab
 *   4. item list: visible row count, how many titles match the repo's
 *      `isRawFileName` regex (/^[a-z]+--\d+_\d+/i), and a few raw strings
 *   5. the empty/whitespace budget: inner content height vs (widgets + list)
 *
 * FALSIFICATION (mandatory — a harness that reports numbers even when the dialog
 * never opened is worthless):
 *   - POSITIVE control: the dialog must exist AND, after switching, the
 *     reclamation list root must exist (>=1 `cache-bytes-row`) AND the pipeline
 *     tab's scope row must be GONE. If not -> FATAL, exit 1 (never report zeros
 *     as success).
 *   - NEGATIVE control: run with PROBE_BREAK=1 to deliberately corrupt the row
 *     selector; the positive control must then fail and the script must exit
 *     non-zero instead of printing a plausible-looking measurement.
 *
 * Endpoints are resolved at runtime (tg port DRIFTS) via `_lib_endpoints.cjs`;
 * never hard-coded. This probe drives the real UI over CDP headful.
 *
 * Usage:
 *   node _probe_cache_dialog_geom.cjs
 *   PROBE_BREAK=1 node _probe_cache_dialog_geom.cjs   # negative control
 * Output: human log + a single `RESULT_JSON: {...}` line for machine parsing.
 */

const path = require('node:path')
const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const WAIT_MS = 30000
/** Match the doc's 1080p assumption so the measured ratio is directly comparable. */
const VIEW_W = 1920
const VIEW_H = 1080
/** NEGATIVE control: corrupt the row selector so the positive control must fail. */
const BREAK = process.env.PROBE_BREAK === '1'
const ROW_SEL = BREAK ? '[data-testid="cache-bytes-row-BROKEN"]' : '[data-testid="cache-bytes-row"]'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function fatal(msg) {
  console.error(`\n[probe] FATAL: ${msg}`)
  process.exit(1)
}

/** Switch the page to a fixed viewport (the CDP lib pins 1440x900 by default). */
async function setViewport(page, w, h) {
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
}

/** Open the cache-manager dialog (mirrors verify_bug_221: nav-tg + store hook). */
async function openDialog(page) {
  const nav = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-tg"]')
    if (!b) return false
    b.click()
    return true
  })
  if (!nav) fatal('nav-tg not found (TG view entry missing)')
  await delay(1500)
  const opened = await page.evaluate(() => {
    const s = window.__origStore && window.__origStore.getState()
    if (!s || typeof s.setTgCacheManagerOpen !== 'function') return false
    s.setTgCacheManagerOpen(true)
    return true
  })
  if (!opened) fatal('window.__origStore.setTgCacheManagerOpen unavailable (dev build required)')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-manager"]'), {
    timeout: WAIT_MS,
  })
}

/** Presence + height of the ingest-stats strip in the CURRENT tab. */
function readIngestSummary(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="cache-ingest-summary"]')
    if (!el) return { present: false, height: 0, text: null }
    const r = el.getBoundingClientRect()
    return {
      present: true,
      height: Math.round(r.height * 100) / 100,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim(),
    }
  })
}

/** Whether the pipeline tab's own chrome is on screen (proves which tab is active). */
function readTabProbe(page) {
  return page.evaluate(() => ({
    scopeRow: !!document.querySelector('[data-testid="cache-scope-all"]'),
    selectBar: !!document.querySelector('[data-testid="cache-select-bar"]'),
    bytesList: !!document.querySelector('[data-testid="cache-bytes-row"]'),
    bytesSelectAll: !!document.querySelector('[data-testid="cache-bytes-select-all"]'),
    activeTab: (() => {
      const t = document.querySelector('[data-testid="cache-tab-bytes"]')
      if (!t) return null
      return getComputedStyle(t).fontWeight // active tab is font-medium (600)
    })(),
  }))
}

/** Full geometry of the dialog + widgets above the list, in the reclamation tab. */
function measureGeometry(page, rowSel) {
  return page.evaluate((sel) => {
    const dialog = document.querySelector('[data-testid="cache-manager"]')
    if (!dialog) return { error: 'cache-manager not found' }

    const cs = getComputedStyle(dialog)
    const dRect = dialog.getBoundingClientRect()
    const padTop = parseFloat(cs.paddingTop) || 0
    const padBottom = parseFloat(cs.paddingBottom) || 0
    const borderTop = parseFloat(cs.borderTopWidth) || 0
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0
    // Inner content height = client box minus vertical padding (the area widgets+list live in).
    const innerContentH = dialog.clientHeight - padTop - padBottom
    const contentTop = dRect.top + borderTop + padTop

    const rows = dialog.querySelectorAll(sel)
    if (rows.length === 0) return { error: 'no rows for selector ' + sel, rowSel: sel }

    const firstRow = rows[0]
    // List root = nearest scroll-container ancestor of the first row.
    let listRoot = firstRow.parentElement
    while (listRoot && listRoot !== dialog) {
      const ov = getComputedStyle(listRoot).overflowY
      if (ov === 'auto' || ov === 'scroll') break
      listRoot = listRoot.parentElement
    }

    const labelOf = (el) => {
      if (el.getAttribute && el.getAttribute('data-testid')) return el.getAttribute('data-testid')
      const inner = el.querySelector && el.querySelector('[data-testid]')
      if (inner) return '~' + inner.getAttribute('data-testid')
      return 'class:' + String(el.className || '').slice(0, 60)
    }

    // Collect every preceding sibling of the list root at each ancestor level,
    // walking up to the dialog. These are exactly the blocks rendered above the list.
    const widgets = []
    let node = listRoot
    while (node && node !== dialog) {
      const level = []
      let sib = node.previousElementSibling
      while (sib) {
        level.push(sib)
        sib = sib.previousElementSibling
      }
      for (const s of level) widgets.push(s)
      node = node.parentElement
    }

    const items = widgets
      .map((el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return {
          label: labelOf(el),
          className: String(el.className || ''),
          height: Math.round(r.height * 100) / 100,
          top: Math.round(r.top * 100) / 100,
          bottom: Math.round(r.bottom * 100) / 100,
          marginTop: parseFloat(s.marginTop) || 0,
          visible: r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
        }
      })
      .filter((x) => x.visible)
      .sort((a, b) => a.top - b.top)

    const sumWidgetHeights = items.reduce((a, x) => a + x.height, 0)
    const listRootTop = listRoot.getBoundingClientRect().top
    // Everything the user must scroll past before the first row: widgets + the gaps between them.
    const aboveListOffset = listRootTop - contentTop

    // Item rows: count + raw-id detection (mirrors isRawFileName in lib/tgmedia.ts).
    const RAW = /^[a-z]+--\d+_\d+/i
    const rowInfo = []
    for (const r of rows) {
      const span = r.querySelector('span')
      const title = span ? String(span.textContent || '').trim() : ''
      rowInfo.push({ title, raw: RAW.test(title) })
    }
    const rawCount = rowInfo.filter((x) => x.raw).length

    return {
      rowSel: sel,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dialog: {
        rect: {
          top: Math.round(dRect.top * 100) / 100,
          height: Math.round(dRect.height * 100) / 100,
        },
        clientHeight: dialog.clientHeight,
        computedMaxHeight: cs.maxHeight,
        paddingTop: padTop,
        paddingBottom: padBottom,
        innerContentH: Math.round(innerContentH * 100) / 100,
      },
      widgetCount: items.length,
      widgets: items,
      sumWidgetHeights: Math.round(sumWidgetHeights * 100) / 100,
      aboveListOffset: Math.round(aboveListOffset * 100) / 100,
      pctWidgetSum: Math.round((sumWidgetHeights / innerContentH) * 10000) / 100,
      pctAboveListOffset: Math.round((aboveListOffset / innerContentH) * 10000) / 100,
      listRootHeight: Math.round(listRoot.getBoundingClientRect().height * 100) / 100,
      rowCount: rowInfo.length,
      rawIdCount: rawCount,
      rawIdRatio: rowInfo.length ? Math.round((rawCount / rowInfo.length) * 10000) / 100 : 0,
      sampleTitles: rowInfo.slice(0, 12).map((x) => x.title),
      whitespaceBudget: Math.round((innerContentH - sumWidgetHeights - listRoot.getBoundingClientRect().height) * 100) / 100,
    }
  }, rowSel)
}

async function main() {
  const ep = await endpoints.resolve()
  console.log(`[probe] app=${ep.app} daemon=${ep.daemon} tg=${ep.tg} (tg_port=${ep.tgPort})`)
  if (BREAK) console.log('[probe] NEGATIVE CONTROL MODE (PROBE_BREAK=1): row selector corrupted on purpose')

  const browser = await cdp.launch({ headless: false })
  let exitCode = 0
  try {
    const page = await browser.newPage()
    await setViewport(page, VIEW_W, VIEW_H)
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
    console.log('[probe] app ready at', APP_URL)

    await openDialog(page)

    // ── POSITIVE CONTROL 1: dialog actually opened ──
    const dialogOpen = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="cache-manager"]')
      if (!d) return null
      const r = d.getBoundingClientRect()
      return { height: r.height, width: r.width }
    })
    if (!dialogOpen) fatal('dialog [data-testid="cache-manager"] never rendered (cannot measure zeros)')
    console.log('[probe] dialog opened:', JSON.stringify(dialogOpen))

    // ── Tab: PIPELINE (tasks) — measure ingest strip here ──
    await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-scope-all"]'), {
      timeout: WAIT_MS,
    })
    const ingestTasks = await readIngestSummary(page)
    const tabTasks = await readTabProbe(page)
    console.log('[probe] PIPELINE tab ingest-summary:', JSON.stringify(ingestTasks))
    console.log('[probe] PIPELINE tab chrome:', JSON.stringify(tabTasks))

    // ── Switch to the reclamation (bytes) tab ──
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="cache-tab-bytes"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!clicked) fatal('cache-tab-bytes button not found')

    // ── POSITIVE CONTROL 2: the reclamation list root exists (real rows rendered) ──
    let rowsSeen = false
    try {
      await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, {
        timeout: WAIT_MS,
        args: [ROW_SEL],
      })
      rowsSeen = true
    } catch (_e) {
      rowsSeen = false
    }
    const tabBytes = await readTabProbe(page)
    if (!rowsSeen) {
      fatal(
        `POSITIVE CONTROL FAILED: no "${ROW_SEL}" rows after switching to the reclamation tab ` +
          `(tabProbe=${JSON.stringify(tabBytes)}). Refusing to report zeros as a measurement.`,
      )
    }
    // The pipeline tab's scope row must be gone — proves the tab really switched.
    if (tabBytes.scopeRow) {
      fatal('POSITIVE CONTROL FAILED: pipeline scope row still present after switching tabs (did not switch)')
    }
    console.log('[probe] reclamation tab chrome:', JSON.stringify(tabBytes))

    const ingestBytes = await readIngestSummary(page)
    console.log('[probe] RECLAMATION tab ingest-summary:', JSON.stringify(ingestBytes))

    // ── Geometry measurement ──
    const geom = await measureGeometry(page, ROW_SEL)
    if (geom.error) fatal('measurement failed: ' + geom.error)

    console.log('\n[probe] === DIALOG ===')
    console.log(`[probe] viewport ${geom.viewport.w}x${geom.viewport.h}`)
    console.log(
      `[probe] dialog rect.height=${geom.dialog.rect.height} clientHeight=${geom.dialog.clientHeight} ` +
        `computed max-height=${geom.dialog.computedMaxHeight} innerContentH=${geom.dialog.innerContentH}`,
    )
    console.log(`\n[probe] === WIDGETS ABOVE LIST (${geom.widgetCount}) ===`)
    geom.widgets.forEach((w, i) =>
      console.log(`[probe]   ${i + 1}. ${w.height}px  ${w.label}`),
    )
    console.log(
      `[probe] sum(widget heights)=${geom.sumWidgetHeights}px (${geom.pctWidgetSum}% of innerContent)`,
    )
    console.log(
      `[probe] widgets+gaps offset above list=${geom.aboveListOffset}px (${geom.pctAboveListOffset}% of innerContent)`,
    )
    console.log(
      `[probe] listRoot height=${geom.listRootHeight}px  whitespace/gaps budget=${geom.whitespaceBudget}px`,
    )
    console.log(
      `[probe] rows=${geom.rowCount} rawIdRows=${geom.rawIdCount} (${geom.rawIdRatio}%)`,
    )
    console.log('[probe] sample titles:', JSON.stringify(geom.sampleTitles))

    const result = {
      viewport: geom.viewport,
      dialog: geom.dialog,
      widgetCount: geom.widgetCount,
      widgets: geom.widgets,
      sumWidgetHeights: geom.sumWidgetHeights,
      aboveListOffset: geom.aboveListOffset,
      pctWidgetSum: geom.pctWidgetSum,
      pctAboveListOffset: geom.pctAboveListOffset,
      listRootHeight: geom.listRootHeight,
      whitespaceBudget: geom.whitespaceBudget,
      rowCount: geom.rowCount,
      rawIdCount: geom.rawIdCount,
      rawIdRatio: geom.rawIdRatio,
      sampleTitles: geom.sampleTitles,
      ingestSummaryInPipelineTab: ingestTasks,
      ingestSummaryInReclamationTab: ingestBytes,
      breakMode: BREAK,
    }
    console.log('\nRESULT_JSON: ' + JSON.stringify(result))
    console.log('[probe] OK')
  } catch (e) {
    console.error('[probe] ERROR', e && e.message ? e.message : e)
    exitCode = 1
  } finally {
    await browser.close()
  }
  process.exit(exitCode)
}

main().catch((e) => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
