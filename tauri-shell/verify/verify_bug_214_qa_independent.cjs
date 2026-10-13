#!/usr/bin/env node
'use strict'

/**
 * BUG-214 **独立验证**（fresh eyes）—— 不采信实现者自验，全部判据自带实测原始值。
 *
 * ## 被验对象
 *
 * 提交 `dccd07d`（+ 文档提交 `6b42864`）：剧集墙多选补「批量删除 / 批量打标 / 批量导出」，
 * 并把选择条从滚动容器内的普通流改成内容区底部的悬浮动作条。
 *
 * ## 只读铁律（本脚本对用户数据零写入）
 *
 * - **不创建任何夹具**：直接用库里既有的剧集做选择（`GET /api/media/series`）。
 * - 破坏性动作**只到「确认弹窗出现」为止**，随后一律点 `media-confirm-no` 取消；
 *   绝不点 `media-confirm-yes`、绝不点导出本体 `export-run`、绝不点打标「应用」。
 * - 唯一发起的写端点请求：无（导出只点「校验」= `GET /api/media/export/preview`）。
 *
 * ## 五项判据（每项打印实测值，不写「符合预期」）
 *
 *   1 边界：选中 1 条 → count 含「1」、`series-merge-wall` disabled 且有 title、
 *     `series-bulk-remove` 可用；点清空 → 动作条**从 DOM 消失**；选 3 条 → merge 可点。
 *   2 批量导出不得退化成全库：勾选数 === 2 且总行数 ≠ 2；CDP 抓到的真实请求 URL 必须是
 *     `.../export/preview?seriesIds=<恰好那 2 个 id>`。
 *   3 批量打标 scope 文案：弹窗标题必须是**剧集**口径，不得是 items 口径（两语言都比对）。
 *   4 删除确认链：清单行数 === 选中数、每行含剧名与集数、`series-confirm-keep-items` 非空；
 *     单条删除路径同样要有 keep-items；取消后剧集总数与操作前一致（无幽灵删除）。
 *   5 附带：收集 `/api/media/items/:id/raw` 的**发起方**（CDP initiator 调用栈 + 所处视图阶段），
 *     用于回答「404 是既有还是本次引入」。
 *
 * ## 用法
 *
 *   node verify/verify_bug_214_qa_independent.cjs
 *   APP_PORT=5180 DAEMON_PORT=19786 ORIG_VERIFY_SHOTS=<dir> node ...
 *
 * Exit: 0 = 全部 PASS；2 = 有 FAIL；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, '..', 'verify_shots', 'bug214-qa'),
)

const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
/** i18n 模板替换（`{n}`）。 */
const tpl = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined ? '' : String(vars[k])))

const checks = []
function check(id, label, ok, expected, actual) {
  checks.push({ id, label, ok: Boolean(ok), expected, actual })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}`)
  console.log(`        expected: ${expected}`)
  console.log(`        actual  : ${actual}`)
  return Boolean(ok)
}

async function httpJson(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (_e) { json = null }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

async function resolveTg() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  if (cfg.status !== 200 || !cfg.json || !cfg.json.tg_port) return null
  return `http://127.0.0.1:${cfg.json.tg_port}`
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try { size = fs.statSync(file).size } catch (_e) { /* ignore */ }
  console.log(`[bug214-qa] shot ${name} (${size} bytes)`)
  return { file, size }
}

/** 动作条快照（含所有按钮的存在/文案/禁用/title）。 */
async function barSnapshot(page) {
  return page.evaluate(() => {
    const read = (testid) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)
      if (!el) return null
      return {
        text: String(el.textContent || '').trim(),
        disabled: el.disabled === true,
        title: el.getAttribute('title'),
      }
    }
    const bars = document.querySelectorAll('[data-testid="series-selection-bar"]')
    return {
      barCount: bars.length,
      hasBar: bars.length > 0,
      count: read('series-selection-count'),
      merge: read('series-merge-wall'),
      tag: read('series-bulk-tag'),
      export: read('series-bulk-export'),
      remove: read('series-bulk-remove'),
      clear: read('series-selection-clear'),
    }
  })
}

async function selectSeries(page, ids) {
  for (const id of ids) {
    const ok = await page.evaluate((sid) => {
      const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
      const btn = root && root.querySelector('[data-testid="series-card-select"]')
      if (!btn) return false
      btn.click()
      return true
    }, id)
    if (!ok) throw new Error(`series-card-select for ${id} not found`)
    await delay(200)
  }
}

async function clearSelection(page) {
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="series-selection-clear"]')
    if (b) b.click()
  })
  await delay(400)
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug214-qa] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)

  const TG = await resolveTg()
  if (!TG) { console.error('[bug214-qa] daemon /api/config 未给出 tg_port —— 环境未就绪'); process.exit(1) }
  const app = await httpJson('GET', APP_URL)
  if (app.status !== 200) { console.error(`[bug214-qa] app 不可达 HTTP ${app.status}`); process.exit(1) }

  // 库级前置（只读）：剧集总数 + 取 3 个既有剧集作为选择目标
  const before = await httpJson('GET', `${TG}/api/media/series`)
  const beforeItems = (before.json && before.json.items) || []
  console.log(`[bug214-qa] series BEFORE = ${beforeItems.length}`)
  if (beforeItems.length < 3) {
    console.error(`[bug214-qa] 库中剧集不足 3 条（${beforeItems.length}），无法完成边界判据`)
    process.exit(1)
  }
  const target = beforeItems.slice(0, 3).map((s) => ({ id: s.id, title: s.title, episodeCount: s.episodeCount }))
  console.log(`[bug214-qa] 选择目标: ${JSON.stringify(target)}`)

  let browser = null
  const netRaw = []
  const netExportPreview = []
  let phase = 'boot'

  try {
    browser = await cdp.launch()
    const page = await browser.newPage()

    // ── 网络观测（真实网络层，不靠改 state）──
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = (p.request && p.request.url) || ''
      if (/\/api\/media\/items\/\d+\/raw/.test(url)) {
        const frames = ((p.initiator && p.initiator.stack && p.initiator.stack.callFrames) || []).slice(0, 4)
        netRaw.push({
          phase,
          url,
          initiator: (p.initiator && p.initiator.type) || null,
          frames: frames.map((f) => ({ url: f.url, line: f.lineNumber, fn: f.functionName })),
        })
      }
      if (/\/api\/media\/export\/preview/.test(url)) netExportPreview.push({ phase, url })
    })

    // 页面内插桩（在导航前注入）：捕获 /raw 请求的**JS 发起调用栈**。
    // 说明：CDP 对媒体资源加载（<img>/<video> src）不返回 initiator.stack.callFrames，
    // 故用属性/属性设置器 + fetch/XHR 打桩自行取证调用点（谁把 URL 赋给了谁）。
    await page.conn.send('Page.enable', {}, { sessionId: page.sessionId })
    const HOOK_SRC = `
(() => {
  window.__rawHits = []
  const RX = /\\/api\\/media\\/items\\/\\d+\\/raw/
  const rec = (kind, url) => {
    if (typeof url === 'string' && RX.test(url)) {
      window.__rawHits.push({ kind, url, stack: (new Error('trace')).stack })
    }
  }
  const def = (proto, prop) => {
    try {
      const d = Object.getOwnPropertyDescriptor(proto, prop)
      if (d && d.set) Object.defineProperty(proto, prop, {
        configurable: true, enumerable: d.enumerable,
        get: d.get, set(v) { rec(prop + ':' + proto.constructor.name, v); return d.set.call(this, v) },
      })
    } catch (e) {}
  }
  def(HTMLImageElement.prototype, 'src')
  def(HTMLMediaElement.prototype, 'src')
  try {
    const sa = Element.prototype.setAttribute
    Element.prototype.setAttribute = function(n, v) { rec('setAttribute(' + n + ')@' + this.tagName, n === 'src' || n === 'href' ? v : ''); return sa.apply(this, arguments) }
  } catch (e) {}
  const of = window.fetch
  window.fetch = function(input) {
    const u = typeof input === 'string' ? input : (input && input.url) || ''
    rec('fetch', u); return of.apply(this, arguments)
  }
  const xo = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function(m, u) { rec('xhr.open', u); return xo.apply(this, arguments) }
})()
`
    await page.conn.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: HOOK_SRC },
      { sessionId: page.sessionId },
    )

    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })

    // ── 导航：侧栏媒体库 → 剧集墙（一律 data-testid）──
    phase = 'items-view'
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-child-lib-series 入口不存在')
    await delay(3000) // items 视图渲染窗口（供 /raw 归因）

    const railOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-rail-series-all"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!railOk) throw new Error('media-rail-series-all 入口不存在')
    await page.waitForFunction(
      (ids) => ids.every((id) => !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`)),
      { timeout: 25000, args: [target.map((t) => t.id)] },
    )
    phase = 'series-wall'
    await delay(2500) // 剧集墙渲染窗口（供 /raw 归因）

    // ══════════════ 判据 1：多选边界 ══════════════
    console.log('\n[bug214-qa] === 判据 1：多选边界 ===')
    const barBefore = await barSnapshot(page)
    check('1.0', '未选中时动作条不在 DOM', barBefore.barCount === 0,
      'barCount=0', `barCount=${barBefore.barCount}`)

    await selectSeries(page, [target[0].id])
    await delay(400)
    const bar1 = await barSnapshot(page)
    await shot(page, '01-single-selected-merge-disabled.png')

    check('1.1', '选中 1 条：动作条存在', bar1.hasBar === true, 'hasBar=true', `hasBar=${bar1.hasBar}`)
    check('1.2', '选中 1 条：数量文案含「1」', !!bar1.count && /1/.test(bar1.count.text),
      `count 含 "1"（期望 zh="${tpl(ZH['media.seriesSelectionCount'], { n: 1 })}"）`,
      `count=${JSON.stringify(bar1.count && bar1.count.text)}`)
    check('1.3', '选中 1 条：合并按钮 disabled=true 且 title 非空',
      !!bar1.merge && bar1.merge.disabled === true && !!bar1.merge.title,
      `disabled=true 且 title 非空（期望 title="${ZH['media.series.bulkMergeDisabled']}"）`,
      `merge.disabled=${bar1.merge && bar1.merge.disabled} merge.title=${JSON.stringify(bar1.merge && bar1.merge.title)}`)
    check('1.4', '选中 1 条：批量删除可用（存在、文案非空、未禁用）',
      !!bar1.remove && !!bar1.remove.text && bar1.remove.disabled === false,
      `remove 存在 + 文案非空 + disabled=false`,
      `remove=${JSON.stringify(bar1.remove)}`)

    await clearSelection(page)
    const barCleared = await barSnapshot(page)
    check('1.5', '点清空后动作条从 DOM 消失（不是视觉隐藏）', barCleared.barCount === 0,
      'querySelectorAll(series-selection-bar).length === 0',
      `barCount=${barCleared.barCount}`)

    await selectSeries(page, target.map((t) => t.id))
    await delay(400)
    const bar3 = await barSnapshot(page)
    await shot(page, '02-three-selected-merge-enabled.png')
    check('1.6', '选中 3 条：合并按钮 disabled=false（随数量变化，非恒 disabled）',
      !!bar3.merge && bar3.merge.disabled === false,
      'merge.disabled=false', `count=${JSON.stringify(bar3.count && bar3.count.text)} merge.disabled=${bar3.merge && bar3.merge.disabled}`)
    check('1.7', '选中 3 条：数量文案含「3」', !!bar3.count && /3/.test(bar3.count.text),
      `count 含 "3"（期望 zh="${tpl(ZH['media.seriesSelectionCount'], { n: 3 })}"）`,
      `count=${JSON.stringify(bar3.count && bar3.count.text)}`)

    // ══════════════ 判据 2：批量导出不得退化成全库 ══════════════
    console.log('\n[bug214-qa] === 判据 2：批量导出子集语义 ===')
    await clearSelection(page)
    await selectSeries(page, target.slice(0, 2).map((t) => t.id))
    await delay(400)
    const wantIds = target.slice(0, 2).map((t) => t.id).sort((a, b) => a - b)

    // 双通道证据：CDP 网络层 + 页面内 fetch 打桩
    await page.evaluate(() => {
      window.__qaFetchUrls = []
      const of = window.fetch.bind(window)
      window.fetch = (...a) => {
        const u = (a[0] && a[0].url) || a[0]
        window.__qaFetchUrls.push(String(u))
        return of(...a)
      }
    })
    phase = 'export-preview'
    const openExport = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-export"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!openExport) throw new Error('series-bulk-export 不存在')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="export-preview-dialog"]'), { timeout: 10000 })
    await delay(300)

    const dlg = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="export-preview-dialog"]')
      const cbs = [...d.querySelectorAll('input[type="checkbox"]')]
      return {
        totalRows: cbs.length,
        checkedRows: cbs.filter((c) => c.checked).length,
        checkedTitles: cbs.filter((c) => c.checked).map((c) => {
          const label = c.closest('label')
          return label ? String(label.textContent || '').trim().slice(0, 40) : null
        }),
        hasRun: !!document.querySelector('[data-testid="export-preview-run"]'),
      }
    })
    await shot(page, '03-bulk-export-dialog.png')

    check('2.1', '对话框已勾选数 === 选中的 2 条', dlg.checkedRows === 2,
      'checked=2', `checked=${dlg.checkedRows} / totalRows=${dlg.totalRows}`)
    check('2.2', '对话框总行数 ≠ 2（候选是全库，不是子集）', dlg.totalRows !== 2,
      `totalRows ≠ 2 且 = 库中剧集总数 ${beforeItems.length}`, `totalRows=${dlg.totalRows}`)
    check('2.3', '总行数 === 库中剧集总数（候选未被收窄）', dlg.totalRows === beforeItems.length,
      `totalRows === ${beforeItems.length}`, `totalRows=${dlg.totalRows}`)

    // 只点「校验」（GET，只读），绝不点 export-run
    const runClicked = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="export-preview-run"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!runClicked) throw new Error('export-preview-run 不存在')
    let previewUrl = null
    for (let i = 0; i < 40; i++) {
      if (netExportPreview.length > 0) { previewUrl = netExportPreview[netExportPreview.length - 1].url; break }
      await delay(250)
    }
    const fetchUrls = await page.evaluate(() => window.__qaFetchUrls || [])
    const fetchPreview = fetchUrls.find((u) => u.includes('/api/media/export/preview')) || null
    await delay(500)
    await shot(page, '04-export-preview-request.png')

    let urlIds = null
    if (previewUrl) {
      const m = /seriesIds=([^&]+)/.exec(previewUrl)
      urlIds = m ? m[1].split(',').map(Number).sort((a, b) => a - b) : null
    }
    console.log(`[bug214-qa] CDP Network 抓到 preview 请求: ${JSON.stringify(netExportPreview)}`)
    console.log(`[bug214-qa] 页面 fetch 打桩记录: ${JSON.stringify(fetchUrls.filter((u) => u.includes('export')))}`)

    check('2.4', 'CDP 抓到的真实请求 URL 含 seriesIds 且恰好是选中的 2 个 id',
      !!previewUrl && !!urlIds && urlIds.length === 2 && JSON.stringify(urlIds) === JSON.stringify(wantIds),
      `GET .../api/media/export/preview?seriesIds=${wantIds.join(',')}`,
      `actualUrl=${JSON.stringify(previewUrl)} parsedIds=${JSON.stringify(urlIds)}`)
    check('2.5', '页面 fetch 通道与 CDP 网络层一致（同一个 URL）',
      !!fetchPreview && !!previewUrl && fetchPreview === previewUrl,
      'fetch 打桩 URL === CDP URL',
      `fetch=${JSON.stringify(fetchPreview)}`)

    // 关闭对话框（点遮罩 = onClose），不触发导出
    await page.evaluate(() => {
      const d = document.querySelector('[data-testid="export-preview-dialog"]')
      if (d && d.parentElement) d.parentElement.click()
    })
    await page.waitForFunction(() => !document.querySelector('[data-testid="export-preview-dialog"]'), { timeout: 8000 })
      .catch(() => undefined)
    await delay(300)

    // ══════════════ 判据 3：批量打标 scope 文案 ══════════════
    console.log('\n[bug214-qa] === 判据 3：批量打标文案口径 ===')
    phase = 'tag-dialog'
    const openTag = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-tag"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!openTag) throw new Error('series-bulk-tag 不存在')
    await page.waitForFunction(
      () => [...document.querySelectorAll('h4')].some((h) => /设置标签|Set tags/.test(h.textContent || '')),
      { timeout: 10000 },
    )
    const tagText = await page.evaluate(() => {
      const h4 = [...document.querySelectorAll('h4')].find((h) => /设置标签|Set tags/.test(h.textContent || ''))
      if (!h4) return null
      const box = h4.parentElement
      const p = box.querySelector('p')
      return {
        title: String(h4.textContent || '').trim(),
        hint: p ? String(p.textContent || '').trim() : null,
      }
    })
    await shot(page, '05-tag-dialog-scope.png')

    const seriesTitleZh = tpl(ZH['media.seriesBulkTagTitle'], { n: 2 })
    const itemsTitleZh = tpl(ZH['media.bulkTagTitle'], { n: 2 })
    const seriesTitleEn = tpl(EN['media.seriesBulkTagTitle'], { n: 2 })
    const itemsTitleEn = tpl(EN['media.bulkTagTitle'], { n: 2 })
    const seriesHintZh = ZH['media.seriesBulkTagHint']
    const itemsHintZh = ZH['media.bulkTagHint']

    check('3.1', '打标弹窗标题是「剧集」口径（且不是 items 口径）',
      !!tagText && (tagText.title === seriesTitleZh || tagText.title === seriesTitleEn) &&
        tagText.title !== itemsTitleZh && tagText.title !== itemsTitleEn,
      `标题 ∈ {"${seriesTitleZh}", "${seriesTitleEn}"} 且 ∉ {"${itemsTitleZh}", "${itemsTitleEn}"}`,
      `actualTitle=${JSON.stringify(tagText && tagText.title)}`)
    check('3.2', '打标弹窗提示行是「剧集」口径', !!tagText && tagText.hint === seriesHintZh,
      `hint === "${seriesHintZh}"`, `actualHint=${JSON.stringify(tagText && tagText.hint)}`)
    check('3.3', '标题里的数量是 2', !!tagText && /2/.test(tagText.title),
      '标题含 "2"', `actualTitle=${JSON.stringify(tagText && tagText.title)}`)

    // 取消（找「取消」按钮，绝不点「应用」）
    const tagCancelled = await page.evaluate(() => {
      const h4 = [...document.querySelectorAll('h4')].find((h) => /设置标签|Set tags/.test(h.textContent || ''))
      if (!h4) return false
      const box = h4.parentElement
      const btn = [...box.querySelectorAll('button')].find((b) => /取消|Cancel/.test(b.textContent || ''))
      if (!btn) return false
      btn.click()
      return true
    })
    if (!tagCancelled) console.warn('[bug214-qa] 未找到打标取消按钮（对话框未关闭）')
    await delay(500)

    // ══════════════ 判据 4：删除确认链（不真删） ══════════════
    console.log('\n[bug214-qa] === 判据 4：删除确认链 ===')
    phase = 'confirm-bulk'
    const openRemove = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="series-bulk-remove"]')
      if (!b) return false
      b.click()
      return true
    })
    if (!openRemove) throw new Error('series-bulk-remove 不存在')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-confirm-delete-list"]'), { timeout: 10000 })
    const bulkConfirm = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="series-confirm-delete-item"]')]
      const keep = document.querySelector('[data-testid="series-confirm-keep-items"]')
      const h4 = [...document.querySelectorAll('h4')].map((h) => String(h.textContent || '').trim())
      return {
        rows: rows.length,
        rowTexts: rows.map((r) => String(r.textContent || '').trim()),
        keepText: keep ? String(keep.textContent || '').trim() : null,
        headings: h4,
        hasConfirmYes: !!document.querySelector('[data-testid="media-confirm-yes"]'),
        hasConfirmNo: !!document.querySelector('[data-testid="media-confirm-no"]'),
      }
    })
    await shot(page, '06-confirm-delete-bulk.png')

    check('4.1', '批量确认清单行数 === 选中数(2)', bulkConfirm.rows === 2,
      'rows=2', `rows=${bulkConfirm.rows} rowTexts=${JSON.stringify(bulkConfirm.rowTexts)}`)
    const titlesOk = target.slice(0, 2).every((t) =>
      bulkConfirm.rowTexts.some((r) => r.includes(t.title.slice(0, 8))))
    check('4.2', '清单每行含剧名', titlesOk,
      `每行包含选中剧名（${JSON.stringify(target.slice(0, 2).map((t) => t.title.slice(0, 12)))}）`,
      `rowTexts=${JSON.stringify(bulkConfirm.rowTexts)}`)
    const epsOk = bulkConfirm.rowTexts.every((r) => /集|eps/.test(r))
    check('4.3', '清单每行含集数', epsOk,
      '每行含 "N 集"/"N eps"', `rowTexts=${JSON.stringify(bulkConfirm.rowTexts)}`)
    check('4.4', 'keep-items 口径文案非空且表达「保留 + 仅解除归组」',
      !!bulkConfirm.keepText && bulkConfirm.keepText === ZH['media.seriesConfirmKeepItemsHint'],
      `keepText === "${ZH['media.seriesConfirmKeepItemsHint']}"`,
      `actualKeepText=${JSON.stringify(bulkConfirm.keepText)}`)

    // 取消
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-confirm-no"]')
      if (b) b.click()
    })
    await page.waitForFunction(() => !document.querySelector('[data-testid="series-confirm-delete-list"]'), { timeout: 8000 })
      .catch(() => undefined)
    await delay(400)

    // 单条：卡片上的删除入口（series-card-delete），必须有 keep-items 口径
    phase = 'confirm-single'
    await clearSelection(page)
    await delay(300)
    const singleTarget = target[0]
    const openSingle = await page.evaluate((sid) => {
      const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
      const btn = root && root.querySelector('[data-testid="series-card-delete"]')
      if (!btn) return false
      btn.click()
      return true
    }, singleTarget.id)
    if (!openSingle) throw new Error('series-card-delete 不存在')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="series-confirm-delete-list"]'), { timeout: 10000 })
    const singleConfirm = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="series-confirm-delete-item"]')]
      const keep = document.querySelector('[data-testid="series-confirm-keep-items"]')
      const h4 = [...document.querySelectorAll('h4')].map((h) => String(h.textContent || '').trim())
      return {
        rows: rows.length,
        rowTexts: rows.map((r) => String(r.textContent || '').trim()),
        keepText: keep ? String(keep.textContent || '').trim() : null,
        headings: h4,
      }
    })
    await shot(page, '07-confirm-delete-single.png')

    check('4.5', '单条删除路径也出现 keep-items 口径（两态一致）',
      !!singleConfirm.keepText && singleConfirm.keepText === ZH['media.seriesConfirmKeepItemsHint'],
      `keepText === "${ZH['media.seriesConfirmKeepItemsHint']}"`,
      `actualKeepText=${JSON.stringify(singleConfirm.keepText)}`)
    check('4.6', '单条确认清单允许 1 行且含该剧名',
      singleConfirm.rows === 1 && singleConfirm.rowTexts[0].includes(singleTarget.title.slice(0, 8)),
      `rows=1 且含 "${singleTarget.title.slice(0, 12)}"`,
      `rows=${singleConfirm.rows} rowTexts=${JSON.stringify(singleConfirm.rowTexts)}`)

    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="media-confirm-no"]')
      if (b) b.click()
    })
    await page.waitForFunction(() => !document.querySelector('[data-testid="series-confirm-delete-list"]'), { timeout: 8000 })
      .catch(() => undefined)
    await delay(500)

    // 取消后：剧集总数与操作前一致（无幽灵删除）
    const after = await httpJson('GET', `${TG}/api/media/series`)
    const afterItems = (after.json && after.json.items) || []
    const beforeIds = beforeItems.map((s) => s.id).sort((a, b) => a - b)
    const afterIds = afterItems.map((s) => s.id).sort((a, b) => a - b)
    check('4.7', '取消后剧集总数与操作前一致（无幽灵删除）',
      afterItems.length === beforeItems.length && JSON.stringify(afterIds) === JSON.stringify(beforeIds),
      `total=${beforeItems.length} 且 id 集合完全相同`,
      `totalBefore=${beforeItems.length} totalAfter=${afterItems.length} idsIdentical=${JSON.stringify(afterIds) === JSON.stringify(beforeIds)}`)

    // ══════════════ 判据 5（附带）：/raw 请求发起方归因 ══════════════
    console.log('\n[bug214-qa] === /raw 请求发起方归因（供 404 既有/新增判定）===')
    const byPhase = {}
    for (const r of netRaw) byPhase[r.phase] = (byPhase[r.phase] || 0) + 1
    console.log(`[bug214-qa] /raw 请求总数=${netRaw.length} byPhase=${JSON.stringify(byPhase)}`)
    for (const r of netRaw.slice(0, 12)) {
      console.log(`[bug214-qa]   phase=${r.phase} initiator=${r.initiator} ${r.url}`)
      for (const f of r.frames) console.log(`[bug214-qa]       at ${f.fn || '(anon)'} ${f.url}:${f.line}`)
    }
    // 页面内插桩的 JS 调用栈（决定性归属证据）
    const rawHits = await page.evaluate(() => window.__rawHits || [])
    console.log(`[bug214-qa] 页面内插桩 /raw 调用点命中数=${rawHits.length}`)
    for (const h of rawHits.slice(0, 6)) {
      const lines = String(h.stack || '').split('\n').slice(1, 4).map((s) => s.trim())
      console.log(`[bug214-qa]   hit kind=${h.kind} url=${h.url}`)
      for (const l of lines) console.log(`[bug214-qa]       ${l}`)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    const consoleErrs = page.consoleErrors()
    const raw404 = consoleErrs.filter((t) => /\/api\/media\/items\/\d+\/raw/.test(t))
    console.log(`[bug214-qa] pageErrors=${JSON.stringify(pageErrs)}`)
    console.log(`[bug214-qa] consoleErrors(${consoleErrs.length}) raw404=${raw404.length}: ${JSON.stringify(raw404.slice(0, 8))}`)

    // ══════════════ 汇总 ══════════════
    const failed = checks.filter((c) => !c.ok)
    console.log('\n[bug214-qa] === SUMMARY ===')
    console.log(`[bug214-qa] shots: ${SHOTS}`)
    console.log(`[bug214-qa] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[bug214-qa] FAILED:', failed.map((c) => `${c.id}:${c.label}`).join(' | '))
    process.exitCode = failed.length ? 2 : 0
  } finally {
    if (browser) await browser.close()
  }
}

main().catch((e) => {
  console.error('[bug214-qa] ERROR', (e && e.stack) || e)
  process.exit(1)
})
