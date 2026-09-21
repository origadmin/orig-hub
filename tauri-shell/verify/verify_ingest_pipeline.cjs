#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for the ingest pipeline panel (concept fix: cache
 * panel == "subscribed content -> media library", not "a TG cache asset box").
 *
 * This script proves the panel ACTUALLY renders in a real browser with REAL
 * data: it drives a local Edge/Chrome over CDP (zero third-party deps, see
 * ./lib/cdp.cjs) and asserts on the post-JavaScript DOM. It deliberately does
 * not accept "the file compiles" or "the i18n key exists" as evidence.
 *
 * What it proves:
 *   1. the pipeline tab exists and is the default tab;
 *   2. the top summary bar renders the three ingest segments (ingested /
 *      ingesting / failed) and their numbers agree with the backend counts;
 *   3. rows in status `done` carry the "view in library" action, and clicking
 *      it really opens the viewer (by-ref hit) or says "not in library yet";
 *   4. reverse proof: the removed actions (select all / delete selected) and
 *      the removed "failed-cancelled" bucket are NOT on the page;
 *   5. the byte reclaim UI did not disappear -- it moved into the second tab;
 *   6. reverse proof (de-dup): the "ingest pipeline" entry button exists exactly
 *      ONCE and only in the top toolbar. It used to be duplicated in the channel
 *      detail header; that copy was dropped. Counting is what makes this a real
 *      guard -- asserting "the entry exists" would pass with 0, 1 or 2 copies,
 *      so a regression that re-adds the duplicate would look like a success.
 *
 * Usage:
 *   node verify/verify_ingest_pipeline.cjs                 # 5180 + orig-tg 9877
 *   APP_URL=http://127.0.0.1:5173/ node verify/verify_ingest_pipeline.cjs
 *   TG_API=http://127.0.0.1:9877 node verify/verify_ingest_pipeline.cjs
 *   ORIG_VERIFY_OUT=<dir> node verify/verify_ingest_pipeline.cjs
 *
 * Exit codes: 0 = all passed, 1 = at least one assertion failed,
 *             2 = environment problem (no browser / server unreachable).
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

/** Application url under test (override with APP_URL). */
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'

/** orig-tg base (override with TG_API); the media API lives on the same port. */
const TG_API = process.env.TG_API || 'http://127.0.0.1:9877'

/** Artifact dir; must stay OUTSIDE the repo tree (AGENTS.md §6). */
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-ingest')

/** Navigation / DOM wait budget. */
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
const WAIT_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_WAIT_TIMEOUT || 20000)

/** Console/page errors that are environment noise, not app defects. */
const BENIGN = [
  /favicon/i,
  /DevTools/i,
  /Download the React DevTools/i,
  /blocked by CORS|CORS policy|Access-Control-Allow-Origin/i,
]

/**
 * @type {Array<{name: string, ok: boolean, detail: string}>}
 */
const results = []

/**
 * Run one assertion and print PASS/FAIL immediately.
 * @param {string} name assertion name
 * @param {Function} fn predicate (sync or async)
 * @param {string} detail extra context printed on failure
 * @returns {Promise<boolean>}
 */
async function check(name, fn, detail = '') {
  let ok = false
  let message = ''
  try {
    ok = Boolean(await fn())
    if (!ok && !detail) message = 'predicate returned falsy'
  } catch (err) {
    ok = false
    message = err && err.message ? err.message : String(err)
  }
  results.push({ name, ok, detail: message || detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${message || detail}`}`)
  return ok
}

/** Refuse to write artifacts inside the repository. */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory (AGENTS.md §6).',
    )
  }
}

/**
 * TCP pre-flight so an unreachable server fails in ~2s instead of burning the
 * whole navigation budget.
 * @param {string} host hostname
 * @param {number} port port
 * @param {number} timeoutMs timeout
 * @returns {Promise<boolean>}
 */
function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = new net.Socket()
    let done = false
    const finish = ok => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

/**
 * GET JSON over plain http (no deps).
 * @param {string} url absolute url
 * @param {number} timeoutMs timeout
 * @returns {Promise<object>}
 */
function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new Error(`${url} returned non-JSON: ${body.slice(0, 200)}`))
        }
      })
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${url} timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
  })
}

/**
 * Backend ingest truth: the same counts the panel must be rendering.
 * @returns {Promise<{total: number, ingested: number, ingesting: number, failed: number}>}
 */
async function backendCounts() {
  const d = await getJson(`${TG_API}/api/tg/cache/tasks/all`)
  const c = d.counts || {}
  const n = k => Number(c[k] || 0)
  return {
    total: (d.tasks || []).length,
    ingested: n('done'),
    ingesting: n('queued') + n('running'),
    failed: n('failed') + n('interrupted'),
    cancelled: n('cancelled'),
  }
}

/**
 * Click an element by `data-testid` (the CDP lib has no click helper).
 * @param {object} page page handle
 * @param {string} testid target
 * @returns {Promise<boolean>} true when the element existed
 */
async function clickTestId(page, testid) {
  return page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
}

async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const appUrl = new URL(APP_URL)
  const tgUrl = new URL(TG_API)

  console.log(`[verify:ingest] app:   ${APP_URL}`)
  console.log(`[verify:ingest] tg:    ${TG_API}`)
  console.log(`[verify:ingest] out:   ${OUT_DIR}`)

  if (!(await tcpProbe(appUrl.hostname, Number(appUrl.port || 80)))) {
    console.error(`[verify:ingest] dev server unreachable at ${appUrl.host}`)
    return 2
  }
  if (!(await tcpProbe(tgUrl.hostname, Number(tgUrl.port || 80)))) {
    console.error(`[verify:ingest] orig-tg unreachable at ${tgUrl.host}`)
    return 2
  }

  // Backend truth first: without rows the DOM assertions below would pass on
  // an empty panel, which proves nothing.
  const backend = await backendCounts()
  console.log(
    `[verify:ingest] backend counts: ingested=${backend.ingested} ` +
      `ingesting=${backend.ingesting} failed=${backend.failed} ` +
      `cancelled=${backend.cancelled} (${backend.total} rows)`,
  )
  if (backend.total === 0) {
    console.error('[verify:ingest] no cache tasks on the backend -- seed one first')
    return 2
  }

  const browser = await cdp.launch()
  let page
  try {
    page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="context-bar"]')),
      { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
    )

    await check('app.shell.rendered', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="context-bar"]'))),
    )

    // ---- open the TG view, then the pipeline dialog ----
    await check('tg.nav.clickable', () => clickTestId(page, 'nav-tg'))
    const tgReady = await page
      .waitForFunction(() => Boolean(document.querySelector('[data-testid="tg-toolbar"]')), {
        timeout: WAIT_TIMEOUT_MS,
        intervalMs: 200,
      })
      .then(() => true)
      .catch(() => false)
    if (!tgReady) {
      console.error('[verify:ingest] TG toolbar never appeared (is tg_running true?)')
      return 1
    }
    await check('tg.view.opened', () => true)

    // ---- de-dup guard: the entry must exist exactly once, in the toolbar ----
    // Taken before the dialog opens so the count reflects the panel itself.
    //
    // The duplicate copy used to live in the channel detail header, so the count
    // is worthless unless that header is actually mounted: it appears only after
    // a channel is auto-selected (monitored rows arrive over the wire). Waiting
    // for it is what keeps this assertion from being vacuous -- measuring right
    // after `tg-toolbar` shows up catches the pre-selection frame, where the
    // duplicate is not in the DOM yet and a 2-copy regression still reads as 1.
    const detailReady = await page
      .waitForFunction(
        () => Boolean(document.querySelector('header input[type="search"]')),
        { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
      )
      .then(() => true)
      .catch(() => false)
    const entrySnap = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter(
        b => (b.textContent || '').trim() === '入库流水线',
      )
      return {
        total: buttons.length,
        tagged: buttons.filter(
          b => b.getAttribute('data-testid') === 'tg-cache-manager-entry',
        ).length,
        inToolbar: buttons.filter(b => b.closest('[data-testid="tg-toolbar"]')).length,
        inChannelHeader: buttons.filter(b => b.closest('header')).length,
        channelDetailRendered: Boolean(document.querySelector('header input[type="search"]')),
      }
    })
    // `total === 1` catches both directions: 0 = the toolbar copy was wrongly
    // deleted, 2 = the channel-header duplicate came back. `detailReady` is part
    // of the predicate on purpose: without the detail header mounted the count
    // cannot see the regression site, so it must not pass silently.
    await check('ingest.entry.single', () =>
      detailReady &&
      entrySnap.channelDetailRendered &&
      entrySnap.total === 1 &&
      entrySnap.tagged === 1 &&
      entrySnap.inToolbar === 1 &&
      entrySnap.inChannelHeader === 0,
    `entry buttons=${JSON.stringify(entrySnap)} detailReady=${detailReady}`)

    await check('ingest.dialog.entry.clickable', () =>
      clickTestId(page, 'tg-cache-manager-entry'),
    )
    const opened = await page
      .waitForFunction(() => Boolean(document.querySelector('[data-testid="cache-manager"]')), {
        timeout: WAIT_TIMEOUT_MS,
        intervalMs: 200,
      })
      .then(() => true)
      .catch(() => false)
    if (!opened) {
      console.error('[verify:ingest] pipeline dialog never opened')
      return 1
    }
    await check('ingest.dialog.opened', () => true)

    // The task list is fetched after mount; snapshotting immediately would
    // capture the empty pre-fetch frame and pass every reverse assertion for
    // the wrong reason. Wait for real rows (backend was pre-checked non-empty).
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="cache-task-row"]').length > 0,
      { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
    ).catch(() => {})

    /**
     * Snapshot of everything the pipeline tab renders, taken in one pass so the
     * assertions below cannot race with a poll refresh.
     * @returns {object}
     */
    const snap = await page.evaluate(() => {
      const q = sel => document.querySelector(sel)
      const text = el => (el ? (el.textContent || '').trim() : null)
      const dialog = q('[data-testid="cache-manager"]')
      const rows = Array.from(document.querySelectorAll('[data-testid="cache-task-row"]'))
      const doneRows = rows.filter(r => r.getAttribute('data-status') === 'done')
      const goBtn = doneRows.length
        ? doneRows[0].querySelector('[data-testid="cache-task-golibrary"]')
        : null
      return {
        title: text(dialog ? dialog.querySelector('h4') : null),
        dialogText: dialog ? dialog.textContent || '' : '',
        tabs: Array.from(document.querySelectorAll('[data-testid="cache-tabs"] button')).map(b => ({
          testid: b.getAttribute('data-testid'),
          text: (b.textContent || '').trim(),
          cls: b.className || '',
        })),
        summary: {
          done: text(q('[data-testid="ingest-summary-done"]')),
          active: text(q('[data-testid="ingest-summary-active"]')),
          failed: text(q('[data-testid="ingest-summary-failed"]')),
        },
        rowCount: rows.length,
        statuses: rows.map(r => r.getAttribute('data-status')),
        doneCount: doneRows.length,
        goLibraryLabel: text(goBtn),
        hasSelectAllTestId: Boolean(q('[data-testid="cache-select-all"]')),
        hasDeleteSelectedTestId: Boolean(q('[data-testid="cache-delete-selected"]')),
      }
    })

    // ---- 1. tabs: pipeline first and default ----
    await check('ingest.tab.tasks.present', () =>
      snap.tabs.some(t => t.testid === 'cache-tab-tasks'),
    `tabs: ${JSON.stringify(snap.tabs.map(t => t.testid))}`)
    await check('ingest.tab.tasks.default', () => {
      const tasks = snap.tabs.find(t => t.testid === 'cache-tab-tasks')
      const bytes = snap.tabs.find(t => t.testid === 'cache-tab-bytes')
      return Boolean(tasks && /text-accent/.test(tasks.cls) && bytes && !/text-accent/.test(bytes.cls))
    }, `tabs: ${JSON.stringify(snap.tabs)}`)
    await check('ingest.tab.labels', () => {
      const tasks = snap.tabs.find(t => t.testid === 'cache-tab-tasks')
      const bytes = snap.tabs.find(t => t.testid === 'cache-tab-bytes')
      return Boolean(tasks && /入库/.test(tasks.text) && bytes && /临时文件/.test(bytes.text))
    }, `labels: ${JSON.stringify(snap.tabs.map(t => t.text))}`)
    await check('ingest.title', () => snap.title === '入库流水线', `title=${snap.title}`)

    // ---- 2. summary bar: three segments, numbers agree with the backend ----
    await check('ingest.summary.segments', () =>
      /已入库/.test(snap.summary.done || '') &&
      /入库中/.test(snap.summary.active || '') &&
      /失败/.test(snap.summary.failed || ''),
    `summary=${JSON.stringify(snap.summary)}`)
    await check('ingest.summary.matches.backend', () => {
      const num = s => {
        const m = /(\d+)/.exec(s || '')
        return m ? Number(m[1]) : NaN
      }
      return (
        num(snap.summary.done) === backend.ingested &&
        num(snap.summary.active) === backend.ingesting &&
        num(snap.summary.failed) === backend.failed
      )
    }, `dom=${JSON.stringify(snap.summary)} backend=${JSON.stringify(backend)}`)

    // ---- 3. rows + the "view in library" exit ----
    await check('ingest.rows.rendered', () => snap.rowCount > 0, `rows=${snap.rowCount}`)
    await check('ingest.rows.have.done', () =>
      snap.doneCount === backend.ingested && snap.doneCount > 0,
    `doneRows=${snap.doneCount} backend=${backend.ingested} statuses=${JSON.stringify(snap.statuses)}`)
    await check('ingest.row.done.action', () =>
      snap.goLibraryLabel === '去媒体库查看',
    `label=${snap.goLibraryLabel}`)

    // ---- 4. reverse proof: the removed affordances are gone ----
    await check('rev.no.select.all', () => !snap.dialogText.includes('全选'), 'text contains 全选')
    await check('rev.no.delete.selected', () =>
      !snap.dialogText.includes('删除所选'), 'text contains 删除所选')
    await check('rev.no.select.all.testid', () => !snap.hasSelectAllTestId)
    await check('rev.no.delete.selected.testid', () => !snap.hasDeleteSelectedTestId)
    await check('rev.no.failed.cancelled.bucket', () =>
      !snap.dialogText.includes('失败·已取消') && !snap.dialogText.includes('失败 · 已取消'),
    'text contains the merged failed/cancelled bucket')
    await check('rev.cancelled.out.of.main.view', () => {
      const main = `${snap.summary.done}|${snap.summary.active}|${snap.summary.failed}`
      return !main.includes('已取消')
    }, `summary=${JSON.stringify(snap.summary)}`)

    await page.screenshot(path.join(OUT_DIR, 'ingest-pipeline-tasks.png'), { fullPage: false })

    // ---- 5. the byte reclaim UI moved into tab 2 instead of being deleted ----
    await check('bytes.tab.switch', () => clickTestId(page, 'cache-tab-bytes'))
    // The bytes panel loads its preview asynchronously; wait for the reclaim
    // actions themselves, otherwise the snapshot catches the loading row.
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="cache-bytes-clear-all"]')),
      { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
    ).catch(() => {})
    const bytesSnap = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="cache-manager"]')
      const text = dialog ? dialog.textContent || '' : ''
      const label = id => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        return el ? (el.textContent || '').trim() : null
      }
      return {
        text,
        clearAll: label('cache-bytes-clear-all'),
        clearOrphan: label('cache-bytes-clear-orphan'),
        clearStale: label('cache-bytes-clear-stale'),
        clearFailed: label('cache-bytes-clear-failed'),
        selectAll: label('cache-bytes-select-all'),
      }
    })
    await check('bytes.tab.section', () =>
      bytesSnap.text.includes('回收临时文件') && bytesSnap.text.includes('媒体库条目保留'),
    `section text missing (len=${bytesSnap.text.length})`)
    await check('bytes.tab.actions.reclaimed', () =>
      /^回收/.test(bytesSnap.clearAll || '') &&
      /^回收/.test(bytesSnap.clearOrphan || '') &&
      /^回收/.test(bytesSnap.clearStale || '') &&
      /^回收/.test(bytesSnap.clearFailed || ''),
    `labels=${JSON.stringify(bytesSnap)}`)
    // Selection survived the demotion too (it belongs to byte reclaim, not to
    // the pipeline): it must NOT be on the pipeline tab, but MUST still be here.
    await check('bytes.tab.keeps.selection', () =>
      bytesSnap.selectAll === '全选',
    `selectAll=${bytesSnap.selectAll}`)
    await page.screenshot(path.join(OUT_DIR, 'ingest-pipeline-bytes.png'), { fullPage: false })

    // ---- 6. the exit really works: click it on a done row ----
    await check('ingest.back.to.tasks.tab', () => clickTestId(page, 'cache-tab-tasks'))
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="cache-task-golibrary"]')),
      { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
    ).catch(() => {})
    await check('ingest.golibrary.click', () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-testid="cache-task-row"][data-status="done"]')
        const btn = row && row.querySelector('[data-testid="cache-task-golibrary"]')
        if (!btn) return false
        btn.click()
        return true
      }),
    )
    const viewerUp = await page
      .waitForFunction(() => Boolean(document.querySelector('[data-testid="media-viewer"]')), {
        timeout: WAIT_TIMEOUT_MS,
        intervalMs: 200,
      })
      .then(() => true)
      .catch(() => false)
    await check('ingest.golibrary.opens.viewer', () => viewerUp, 'viewer never opened')
    if (viewerUp) {
      await page.screenshot(path.join(OUT_DIR, 'ingest-pipeline-viewer.png'), { fullPage: false })
      // Closing the player must land on the media library, not back on TG.
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="media-viewer"] button')
        if (btn) btn.click()
      })
      const onLibrary = await page
        .waitForFunction(
          () => {
            const nav = document.querySelector('[data-testid="nav-media"]')
            return Boolean(nav && /text-accent/.test(nav.className || ''))
          },
          { timeout: WAIT_TIMEOUT_MS, intervalMs: 200 },
        )
        .then(() => true)
        .catch(() => false)
      await check('ingest.golibrary.lands.on.library', () => onLibrary,
        'media library view not active after closing the player')
    }

    // ---- 7. no runtime errors ----
    const pageErrors = (page.pageErrors() || []).filter(e => !BENIGN.some(re => re.test(String(e))))
    const consoleErrors = (page.consoleErrors() || []).filter(
      m => !BENIGN.some(re => re.test(String(m))),
    )
    await check('no.page.errors', () => pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
    await check('no.console.errors', () => consoleErrors.length === 0,
      JSON.stringify(consoleErrors.slice(0, 3)))
  } finally {
    // `dispose()` is synchronous -- no promise to await here.
    if (page) {
      try {
        page.dispose()
      } catch (_err) {
        /* page already gone */
      }
    }
    await browser.close().catch(() => {})
  }

  const failed = results.filter(r => !r.ok)
  console.log('--- assertions ---')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  }
  console.log(`[verify:ingest] ${results.length - failed.length}/${results.length} assertions passed`)
  return failed.length === 0 ? 0 : 1
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:ingest] fatal: ${err && err.stack ? err.stack : err}`)
    process.exit(2)
  })
