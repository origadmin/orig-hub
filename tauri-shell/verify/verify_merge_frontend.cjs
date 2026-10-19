#!/usr/bin/env node
'use strict'

/**
 * Real-render acceptance for the two front-end defects of the media "merge"
 * report (2026-09-23). Zero dependency: built-in `WebSocket` + `./lib/cdp.cjs`.
 *
 *  BUG-153 — a range episode (one file holding several episodes, `S1E1-9`) could
 *            only have its START edited; the END input did not exist and the
 *            submit never sent `episodeNoEnd`. Users could not even collapse a
 *            range back to a single episode.
 *  BUG-155 — the media toolbar's "Select page" had no `view === 'items'` guard,
 *            so on the series wall it filled the items-only `selected` set with
 *            ids the user cannot see ("global filter"), and that selection
 *            survived a view switch.
 *            **任务 #9 改版（2026-10-16）**：全选本页移入 items 浮动底部选择条
 *            （选中 ≥1 条才出现，条内含全选/全不选），库级按钮上移到标题区右槽。
 *            守卫判据随之改为「0 选中时 media-select-all 整页缺席 + 勾选后选择条
 *            出现 + 切视图后选择条与计数一并消失」，并新增「选择模式禁入播放详情」
 *            （选择态下点卡片封面不得打开 media-viewer）。
 *
 * 断言必须在**真实浏览器**里跑：这两个缺陷都是「渲染出来的控件有没有 / 点下去
 * 发出的请求里有没有这个键」，用 jsdom 重写一份组件逻辑再断言，测的是「我以为的
 * 代码」，不是「跑起来的页面」。
 *
 * 反向证伪（本项目硬要求）：
 *   1. 死端口 → UNREACHABLE(exit 2)：证脚本不是恒绿。
 *   2. `ORIG_VERIFY_REVERT=1`：在真实 DOM 上**把修复前形态注回**
 *      （删掉结束集输入框 / 把守卫换成恒真），跑同一套断言 → 必须 exit 1。
 *      这条才证到「缺陷真出现时这套断言会红」。
 *
 * Usage:
 *   node verify/verify_merge_frontend.cjs
 *   APP_URL=http://127.0.0.1:59999 node verify/verify_merge_frontend.cjs   # 证伪 1
 *   ORIG_VERIFY_REVERT=1 node verify/verify_merge_frontend.cjs            # 证伪 2（期望 exit 1）
 *   ORIG_VERIFY_OUT=<临时目录> node verify/verify_merge_frontend.cjs
 *
 * Exit codes: 0 = 全部通过, 1 = 断言失败, 2 = 环境/通道问题。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const MEDIA_API = process.env.ORIG_MEDIA_API || 'http://127.0.0.1:9877'

// BUG-161 污染防线：本脚本会写后端；默认拒绝写生产实例（9877），
// 需显式 ORIG_VERIFY_ALLOW_PROD_WRITES=1 或改用隔离实例（见 verify/README.md §4）。
require('./lib/sandbox.cjs').guardWrites('verify_merge_frontend.cjs', MEDIA_API)
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-merge-frontend')
const NAV_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_NAV_TIMEOUT || 45000)
const STEP_TIMEOUT_MS = Number(process.env.ORIG_VERIFY_STEP_TIMEOUT || 20000)

/** 自证伪开关：把修复前形态注回真实 DOM，期望本脚本转红。 */
const REVERT_TO_PRE_FIX = process.env.ORIG_VERIFY_REVERT === '1'

const results = []

/**
 * 记录一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 细节
 * @returns {boolean} ok
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

/** 打印所有断言。 */
function dumpResults() {
  if (results.length === 0) {
    console.log('--- assertions --- (none recorded)')
    return
  }
  console.log('--- assertions ---')
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -- ${item.detail || 'n/a'}`}`)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`[verify:merge-fe] ${results.length - failed}/${results.length} assertions passed`)
}

/** 拒绝把产物写进仓库。 */
function assertOutDirSafe(outDir) {
  const resolved = path.resolve(outDir)
  const repoRoot = path.resolve(__dirname, '..', '..')
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to write artifacts inside the repo (${resolved}). ` +
        'Set ORIG_VERIFY_OUT to a temp directory.',
    )
  }
}

/** TCP 预检。 */
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

/** GET JSON（仅回环）。 */
function httpGetJson(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => {
        body += c
      })
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null)
        try {
          finish(JSON.parse(body))
        } catch (_err) {
          finish(null)
        }
      })
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
  })
}

/**
 * PATCH JSON（仅回环；用于把验收写入的数据还原回原值）。
 * @param {string} url 目标
 * @param {object} payload 请求体
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否 2xx
 */
function httpPatchJson(url, payload, timeoutMs = 5000) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const target = new URL(url)
    const body = JSON.stringify(payload)
    const req = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: target.pathname + target.search,
        method: 'PATCH',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      res => {
        res.resume()
        res.on('end', () => finish(res.statusCode >= 200 && res.statusCode < 300))
      },
    )
    req.on('error', () => finish(false))
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.end(body)
  })
}

/** 等某个 data-testid 出现。 */
async function waitForTestId(page, testid, timeoutMs = STEP_TIMEOUT_MS) {  await page.waitForFunction(
    id => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    { timeout: timeoutMs, intervalMs: 200, args: [testid] },
  )
}

/** 等某个 data-testid 消失。 */
async function waitForTestIdGone(page, testid, timeoutMs = STEP_TIMEOUT_MS) {
  await page.waitForFunction(
    id => !document.querySelector(`[data-testid="${id}"]`),
    { timeout: timeoutMs, intervalMs: 200, args: [testid] },
  )
}

/** 点击一个 data-testid 元素。 */
async function clickTestId(page, testid) {
  return Boolean(
    await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return false
      el.click()
      return true
    }, testid),
  )
}

/** 元素是否存在。 */
async function hasTestId(page, testid) {
  return Boolean(
    await page.evaluate(id => Boolean(document.querySelector(`[data-testid="${id}"]`)), testid),
  )
}

/**
 * 点击左栏「全部剧集」回到 series 视图（剧集墙）。
 *
 * 两个踩过的坑，都必须在这里处理：
 *
 * 1. **不能用「查一次找不到就 return true」**：进入媒体库后剧集列表仍在加载，
 *    此时左栏只有分组标题，按钮一个都还没渲染 —— 那一刻查不到是**正常的中间态**。
 *    实测踩过：`find` 返回 undefined 后照旧 `return true`，脚本带着「已回到 series」
 *    的假前提继续跑（`_tmp_dbg.cjs` 复现：navButtons=8、无「全部剧集」按钮）。
 *
 * 2. **不能 `document.querySelector('nav')`**：页面上有**多个** `<nav>` —— 应用左栏
 *    导航与媒体库面板自己的分类栏。`querySelector` 返回第一个，命中的是**应用左栏**，
 *    于是找不到入口。M0（BUG-298）后媒体库左栏已删、导航收进应用侧栏双树，
 *    「剧集」入口 = 侧栏 `nav-child-lib-series`（旧的 `media-rail-series-all` 随
 *    左栏一并废止，这里同步改锚）。
 *
 * @param {object} page CDP page
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否点到
 */
async function clickRailAllSeries(page, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!btn) return false
      btn.click()
      return true
    })
    if (hit) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/**
 * 按文案（trim 后完全相等）点击一个按钮。
 * @param {object} page CDP page
 * @param {string} text 文案
 * @returns {Promise<boolean>} 是否点到
 */
async function clickButtonByText(page, text) {
  return Boolean(
    await page.evaluate(txt => {
      const hit = Array.from(document.querySelectorAll('button')).find(
        b => (b.textContent || '').trim() === txt,
      )
      if (!hit) return false
      hit.click()
      return true
    }, text),
  )
}

/**
 * 读**含库级按钮的那个 header** 里所有按钮的文案。
 *
 * **不能 `document.querySelector('header')`**：应用外壳自身也有一个 `<header>`
 * （`data-testid="context-bar-header"`）。任务 #9 后库级按钮（导入目录/新建剧集/
 * 导出/标签管理）已上移到标题区右槽（ContextBar files 分支），故「含有导入目录
 * 按钮」的那个 header 现在就是**外壳标题栏** —— 锚定语义从「媒体库工具条」
 * 改为「库级按钮所在处」，按文案包含判定，调用方足够稳。
 *
 * @param {object} page CDP page
 * @returns {Promise<Array<string>>}
 */
async function buttonTexts(page) {
  const list = await page.evaluate(() => {
    const toolbars = Array.from(document.querySelectorAll('header')).filter(h =>
      (h.textContent || '').includes('导入目录'),
    )
    const host = toolbars[0]
    if (!host) {
      // 兜底：没有可锚定的工具条时，退化为全页按钮（调用方按文案包含判定，足够稳）
      return Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim())
    }
    return Array.from(host.querySelectorAll('button')).map(b => (b.textContent || '').trim())
  })
  return Array.isArray(list) ? list : []
}

/**
 * 设置一个受控 input 的值，并派发 React 认得的 input 事件。
 *
 * React 的受控输入监听的是原生 `input` 事件；直接改 `el.value` 不会触发 onChange，
 * 必须用原型上的 value setter 再 dispatch，否则**输入框看着变了、state 没变**，
 * 后面的提交断言就变成在测一个假前提。
 *
 * @param {object} page CDP page
 * @param {string} testid 目标 testid
 * @param {string} value 新值
 * @returns {Promise<boolean>} 是否设置成功
 */
async function setInputValue(page, testid, value) {
  return Boolean(
    await page.evaluate(
      (id, val) => {
        const el = document.querySelector(`[data-testid="${id}"]`)
        if (!el) return false
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        if (desc && desc.set) desc.set.call(el, val)
        else el.value = val
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      testid,
      value,
    ),
  )
}

/**
 * 读取页面上「N 已选」这类计数文本是否存在。
 *
 * BUG-155 的判据锚在**用户看得见的文本**上（而不是组件内部 state）：
 * 用户的原话就是「界面上出现了内容被选中的状态」。文案来自 i18n `media.selected`，
 * 中英文都含 `{n}` 占位与 `selected` / `已选`，故这里用宽松匹配扫整页文本。
 *
 * @param {object} page CDP page
 * @returns {Promise<string|null>} 命中的文本，或 null
 */
async function findSelectedCountText(page) {
  const hit = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : ''
    const m = text.match(/(?:已选\s*\d+\s*项|\d+\s*selected)/i)
    return m ? m[0] : null
  })
  return hit === undefined ? null : hit
}

/**
 * 自证伪（BUG-153）：把「结束集输入框」从真实 DOM 移除，模拟修复前形态。
 * @param {object} page CDP page
 * @returns {Promise<number>} 被移除的元素数
 */
async function removeEndInputInPage(page) {
  return Number(
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="episode-end-input"]')
      if (!el) return 0
      el.remove()
      return 1
    }),
  )
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(`[verify:merge-fe] ERROR: ${err && err.stack ? err.stack : err}`)
    dumpResults()
    console.error('[verify:merge-fe] RESULT: UNREACHABLE (exit 2)')
    process.exit(2)
  })

/**
 * 主流程。
 * @returns {Promise<number>} exit code
 */
async function main() {
  assertOutDirSafe(OUT_DIR)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[verify:merge-fe] target: ${APP_URL}`)
  console.log(`[verify:merge-fe] media api: ${MEDIA_API}`)
  console.log(`[verify:merge-fe] artifacts: ${OUT_DIR}`)
  console.log(`[verify:merge-fe] falsify mode: ${REVERT_TO_PRE_FIX ? 'ON' : 'off'}`)

  // ---- 环境预检 ----
  const target = new URL(APP_URL)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  if (!(await tcpProbe(target.hostname, targetPort))) {
    console.error(`[verify:merge-fe] dev server unreachable: nothing on ${target.host}`)
    dumpResults()
    console.error('[verify:merge-fe] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  const apiTarget = new URL(MEDIA_API)
  if (
    !(await tcpProbe(
      apiTarget.hostname,
      Number(apiTarget.port || (apiTarget.protocol === 'https:' ? 443 : 80)),
    ))
  ) {
    console.error(`[verify:merge-fe] media api unreachable: ${MEDIA_API}`)
    dumpResults()
    console.error('[verify:merge-fe] RESULT: UNREACHABLE (exit 2)')
    return 2
  }

  // ---- 地面真值：找一条带区间的分集（episodeNoEnd != null）----
  const seriesList = await httpGetJson(`${MEDIA_API}/api/media/series`)
  const seriesIds = (seriesList && Array.isArray(seriesList.items) ? seriesList.items : []).map(
    s => s.id,
  )
  let range = null
  let rangeSeriesId = null
  for (const sid of seriesIds) {
    const d = await httpGetJson(`${MEDIA_API}/api/media/series/${sid}`)
    const eps = d && Array.isArray(d.episodes) ? d.episodes : []
    const hit = eps.find(e => e.episodeNoEnd != null)
    if (hit) {
      range = hit
      rangeSeriesId = sid
      break
    }
  }
  if (!range) {
    console.error(
      '[verify:merge-fe] no range episode (episodeNoEnd != null) in the library; ' +
        'BUG-153 cannot be asserted on a meaningful target',
    )
    dumpResults()
    console.error('[verify:merge-fe] RESULT: UNREACHABLE (exit 2)')
    return 2
  }
  console.log(
    `[verify:merge-fe] backend truth: series=${rangeSeriesId} ep=${range.id} ` +
      `S${range.season}E${range.episodeNo}-${range.episodeNoEnd} itemId=${range.itemId}`,
  )

  const browser = await cdp.launch()
  console.log(`[verify:merge-fe] browser: ${browser.executable} (port ${browser.port})`)

  try {
    const page = await browser.newPage()
    /** 捕获本次断言窗口内的 PATCH 请求体。 */
    const capturedPatches = []
    const removedListeners = []
    try {
      await page.goto(APP_URL, {
        waitUntil: 'load',
        timeout: NAV_TIMEOUT_MS,
        settleMs: 1500,
        waitForRoot: false,
      })
    } catch (err) {
      console.error(`[verify:merge-fe] navigation failed: ${err && err.message ? err.message : err}`)
      dumpResults()
      console.error('[verify:merge-fe] RESULT: UNREACHABLE (exit 2)')
      return 2
    }

    // ---- 抓 PATCH 请求体（BUG-153 判据 2/3 的地面真值：**真的发出去的 payload**）----
    const sessionId = page.sessionId
    removedListeners.push(
      page.conn.on('Network.requestWillBeSent', params => {
        if (sessionId && params.sessionId && params.sessionId !== sessionId) return
        const req = params.request || {}
        if (!/\/api\/media\/episodes\/\d+$/.test(String(req.url || ''))) return
        if (String(req.method || '').toUpperCase() !== 'PATCH') return
        capturedPatches.push({ url: req.url, body: req.postData || '' })
      }),
    )
    await page.conn.send('Network.enable', {}, { sessionId })

    console.log('')
    console.log('--- 前置：进入媒体库 ---')
    try {
      await waitForTestId(page, 'nav-child-lib-series', 15000)
    } catch (_err) {
      check('侧栏 nav-child-lib-series 存在', false, '侧栏未渲染（页面白屏？）')
      fs.writeFileSync(path.join(OUT_DIR, 'dom-no-nav-child-lib-series.html'), await page.content(), 'utf8')
      dumpResults()
      console.log('[verify:merge-fe] RESULT: FAIL (app did not render sidebar)')
      return 1
    }
    await clickTestId(page, 'nav-child-lib-series')
    try {
      // M0（BUG-298）后媒体库面板没有自带标题锚点（`media-panel-title` 随
      // 面板头部整改废止）；「面板渲染了」的判据换成 lib-series 落点的
      // 剧集墙滚动容器（series-wall-scroll）—— 只有面板真渲染出内容才有。
      await waitForTestId(page, 'series-wall-scroll', 15000)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    check('媒体库面板渲染（series-wall-scroll）', await hasTestId(page, 'series-wall-scroll'))

    // =========================================================================
    // BUG-155：全选本页的作用域守卫（任务 #9 改版：选择模式弹出化）
    // =========================================================================
    console.log('')
    console.log('--- BUG-155-A：series 视图不存在全选本页（0 选中时任何视图都不存在）---')

    // 任务 #9（2026-10-16 用户裁定）后的形态：全选本页**不再常驻任何视图的头部**，
    // 只在 items 视图选中 ≥1 条后出现在**浮动底部选择条**（items-selection-bar）。
    // 库级按钮（导入目录/新建剧集/导出/标签管理）已上移到标题区右槽
    // （ContextBar files 分支，page-primary-action + 次级）。
    // 故 series 视图（0 选中）下 media-select-all 必须整页缺席 —— 先确认这一点，
    // 否则后面的 items 断言会因为「本来就在 items」而失去对照意义。
    let onSeriesView = false
    try {
      await waitForTestIdGone(page, 'media-select-all', 10000)
      onSeriesView = true
    } catch (_err) {
      onSeriesView = false
    }
    check('默认视图为 series（media-select-all 缺席）', onSeriesView)

    // 若不在 series（用户上次停留视图被持久化），点左栏「剧集」回到 series 视图
    // （M0 导航模型：`media-rail-series-all` 已废止，侧栏入口是 nav-child-lib-series）。
    if (!onSeriesView) {
      const back = await clickRailAllSeries(page)
      check('点击左栏「剧集」回到 series 视图', back)
      try {
        await waitForTestIdGone(page, 'media-select-all', 10000)
      } catch (_err) {
        /* 由下面的断言如实报告 */
      }
    }

    // 自证伪：把「无条件存在的全选本页」注回真实 DOM（模拟修复前的无守卫形态）。
    // 新形态下锚点是**标题区右槽**（ContextBar，含「导入目录」的那个 header）——
    // 库级按钮在任务 #9 后从媒体面板头部落到了那里；注回的按钮等价于
    // 「修复前它在工具栏里无条件渲染」，检测代码与正式断言逐字相同，能证到判别力。
    if (REVERT_TO_PRE_FIX) {
      const injected = await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('header')).find(h =>
          (h.textContent || '').includes('导入目录'),
        )
        if (!host) return false
        const anchor = Array.from(host.querySelectorAll('button')).find(b =>
          (b.textContent || '').includes('导入目录'),
        )
        if (!anchor) return false
        const clone = document.createElement('button')
        clone.setAttribute('data-testid', 'media-select-all')
        clone.textContent = '全选本页'
        clone.setAttribute('data-falsify', '1')
        anchor.parentNode.insertBefore(clone, anchor)
        return true
      })
      console.log(`[verify:merge-fe] FALSIFY(BUG-155): 已把「全选本页」注回 series 视图 = ${injected}`)
    }

    {
      const selectAllInSeries = await hasTestId(page, 'media-select-all')
      const texts = await buttonTexts(page)
      const hasImport = texts.some(t => t.includes('导入目录'))
      const hasNewSeries = texts.some(t => t.includes('新建剧集'))
      const hasManageTags = texts.some(t => t.includes('标签管理'))
      console.log(
        `[verify:merge-fe] series 工具栏按钮: ${JSON.stringify(texts.filter(t => /全选本页|导入目录|新建剧集|标签管理/.test(t)))}`,
      )
      check(
        '★ series 视图：不存在 media-select-all（0 选中时全选本页不渲染）',
        !selectAllInSeries,
        `存在=${selectAllInSeries}`,
      )
      check(
        'series 视图：导入目录 / 新建剧集 / 标签管理 仍在场（库级按钮，标题区右槽）',
        hasImport && hasNewSeries && hasManageTags,
        `importDir=${hasImport} newSeries=${hasNewSeries} manageTags=${hasManageTags}`,
      )
    }

    // 自证伪收尾：清掉注入的克隆按钮，避免它污染后续 items 视图的断言
    // （旧形态下它注在媒体面板头部、items 断言点的是同一个 testid，会假绿）。
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-falsify="1"]'))) el.remove()
    })

    console.log('')
    console.log('--- BUG-155-B：切到 items 视图（视频分类）---')

    // 左栏「视频」分类入口（nav-child-cat-video）→ items 视图的 MediaCard 网格。
    // 必须**轮询到侧栏渲染后再点**：进入媒体库时剧集列表仍在加载，
    // 侧栏分类子项尚未渲染，此时点空是正常中间态（与 clickRailAllSeries 同一坑）。
    let toItems = false
    {
      const deadline = Date.now() + STEP_TIMEOUT_MS
      while (Date.now() < deadline && !toItems) {
        const clicked = await clickTestId(page, 'nav-child-cat-video')
        if (clicked) {
          try {
            // 进了 items 视图的标志：MediaCard 网格渲染（media-grid）
            await waitForTestId(page, 'media-grid', 3000)
            toItems = true
          } catch (_err) {
            toItems = false
          }
        }
        if (!toItems) await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    check('点击左栏「视频」进入 items 视图', toItems)

    // 任务 #9 新形态①：0 选中时头部**没有任何按钮**（含全选本页）——
    // 库级按钮在标题行（ContextBar），选择态动作在浮动条，头部不再混放。
    {
      const selectAllAtZero = await hasTestId(page, 'media-select-all')
      const texts = await buttonTexts(page)
      const hasImport = texts.some(t => t.includes('导入目录'))
      const hasNewSeries = texts.some(t => t.includes('新建剧集'))
      const hasExport = texts.some(t => t.includes('导出'))
      const hasManageTags = texts.some(t => t.includes('标签管理'))
      check(
        '★ items 视图 0 选中：media-select-all 缺席（全选本页移入浮动选择条）',
        !selectAllAtZero,
        `存在=${selectAllAtZero}`,
      )
      check(
        'items 视图：四个库级按钮仍在场（标题区右槽，任务 #9 上移）',
        hasImport && hasNewSeries && hasExport && hasManageTags,
        `importDir=${hasImport} newSeries=${hasNewSeries} export=${hasExport} manageTags=${hasManageTags}`,
      )
    }

    // 任务 #9 新形态②：勾任意一条卡片 → 浮动选择条出现，条内含全选本页 + 全不选。
    // 「功能选择单个后进入选择模式」的闭环入口就在这里。
    let barAppeared = false
    {
      const deadline = Date.now() + STEP_TIMEOUT_MS
      while (Date.now() < deadline && !barAppeared) {
        await clickTestId(page, 'media-card-select')
        try {
          await waitForTestId(page, 'items-selection-bar', 3000)
          barAppeared = true
        } catch (_err) {
          barAppeared = false
        }
        if (!barAppeared) await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    check('勾选一张卡片 → items 浮动选择条出现', barAppeared)
    {
      const bar = await hasTestId(page, 'items-selection-bar')
      const selectAll = await hasTestId(page, 'media-select-all')
      const selectNone = await hasTestId(page, 'media-select-none')
      const count = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="items-selection-count"]')
        return el ? (el.textContent || '').trim() : null
      })
      check(
        '★ 选择条内含 media-select-all（全选本页）',
        bar && selectAll,
        `bar=${bar} selectAll=${selectAll}`,
      )
      check(
        '★ 选择条内含 media-select-none（全不选，任务 #9 新增）',
        selectNone,
        `selectNone=${selectNone}`,
      )
      check(
        '选择条显示计数（N 已选）',
        Boolean(count) && /已选\s*\d+\s*项|\d+\s*selected/i.test(count || ''),
        `count=${count}`,
      )
    }

    console.log('')
    console.log('--- BUG-155-C：选择不得跨视图泄漏 + 选择模式禁入播放详情 ---')

    // 任务 #9 选择模式禁入播放详情（用户裁定「不应该能点击进入播放详情页面」）：
    // 已有 ≥1 条选中时，点另一张卡片的**封面**必须是切换选中，而不是打开播放器。
    // 必须在**全选之前**跑：全选后所有卡片都已勾选，找不到未勾选的对照样本。
    {
      const reason = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="media-card"]'))
        const unchecked = cards.find(c => {
          const box = c.querySelector('[data-testid="media-card-select"]')
          return box && box.getAttribute('aria-checked') !== 'true'
        })
        if (!unchecked) return 'no-unchecked-card'
        const cover = unchecked.querySelector('[data-testid="media-card-cover"]')
        if (!cover) return 'no-cover'
        cover.click()
        return null
      })
      check('选择模式下找到未勾选的卡片封面', reason === null, `reason=${reason}`)
      await new Promise(resolve => setTimeout(resolve, 800))
      const viewerOpen = await hasTestId(page, 'media-viewer')
      check(
        '★ 选择模式点封面不打开播放详情（media-viewer 缺席）',
        !viewerOpen,
        `viewer=${viewerOpen}`,
      )
    }

    // 前置：全选本页真的把当前可见 items 全填进选择集（否则后面的
    // 「切视图后消失」可能因为 selected 本来就是空的而假绿）。
    // 判据是**所有可见卡片的勾选框 aria-checked 全为 true** —— 新形态下选择条
    // 常驻（点了全选按钮也不会消失），不能用「按钮消失」当成功信号（旧形态的
    // 写法在新形态下会恒超时假红）。
    let selectAllWorked = false
    let selectedText = null
    let clickAttempts = 0
    {
      const deadline = Date.now() + STEP_TIMEOUT_MS
      while (Date.now() < deadline && !selectAllWorked) {
        clickAttempts++
        await clickTestId(page, 'media-select-all')
        await new Promise(resolve => setTimeout(resolve, 500))
        const allChecked = await page.evaluate(() => {
          const boxes = Array.from(
            document.querySelectorAll('[data-testid="media-card-select"]'),
          )
          return (
            boxes.length > 0 && boxes.every(b => b.getAttribute('aria-checked') === 'true')
          )
        })
        selectAllWorked = allChecked
      }
      selectedText = selectAllWorked ? await findSelectedCountText(page) : null
    }
    check('点击 media-select-all', clickAttempts > 0)
    check(
      '★ items 视图点全选后全部可见卡片进入选中态（前置：selected 非空）',
      selectAllWorked && Boolean(selectedText),
      `attempts=${clickAttempts} allChecked=${selectAllWorked} text=${selectedText}`,
    )

    // 切回 series 视图：选择条与计数必须一并消失（selected 被作用域重置清空）
    const backToSeries = await clickRailAllSeries(page)
    check('切回 series 视图（左栏「剧集」）', backToSeries)
    try {
      await waitForTestIdGone(page, 'media-select-all', 10000)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    {
      const afterSwitch = await findSelectedCountText(page)
      const barGone = !(await hasTestId(page, 'items-selection-bar'))
      check(
        '★ 切到 series 视图后「N 已选」消失（selected 被清空，不跨视图泄漏）',
        !afterSwitch,
        `text=${afterSwitch}`,
      )
      check(
        '★ 切到 series 视图后浮动选择条消失（选择条只属于 items 视图）',
        barGone,
        `barGone=${barGone}`,
      )
    }

    // =========================================================================
    // BUG-153：合集分集的结束集号可编辑
    // =========================================================================
    console.log('')
    console.log(`--- BUG-153：打开 series ${rangeSeriesId} 的合集分集编辑态 ---`)

    // 进入含区间分集的剧集详情。优先走卡片点击（用户路径）；卡片可能在滚动区外，
    // 故用 JS 直接 click（不依赖可见性）。
    let opened = false
    try {
      await page.waitForFunction(
        id => Boolean(document.querySelector(`[data-testid="series-card"][data-series-id="${id}"]`)),
        { timeout: STEP_TIMEOUT_MS, intervalMs: 250, args: [rangeSeriesId] },
      )
      opened = Boolean(
        await page.evaluate(id => {
          const card = document.querySelector(
            `[data-testid="series-card"][data-series-id="${id}"]`,
          )
          if (!card) return false
          card.click()
          return true
        }, rangeSeriesId),
      )
    } catch (_err) {
      opened = false
    }
    check(`打开剧集卡片 series-id=${rangeSeriesId}`, opened)

    let pickerReady = false
    try {
      // BUG-181（feef4e8）后分集行的 testid 是 `episode-pick`（旧 `episode-slot`
      // 已废止：行本身是 button，点击=切右栏焦点，编辑入口移到右栏标题行）。
      await waitForTestId(page, 'episode-pick', STEP_TIMEOUT_MS)
      pickerReady = true
    } catch (_err) {
      pickerReady = false
    }
    check('剧集详情渲染出分集行（episode-pick）', pickerReady)

    // 校验渲染：合集显示 -N，单集不显示
    // 左列第一个 span = 槽位标签（`episodeSlotLabel`）；中列标题、右列时长/来源
    // 不参与槽位断言（行 textContent 会把它们一起卷进来）。
    {
      const slots = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="episode-pick"]')).map(el => {
          const label = el.querySelector('span')
          return ((label ? label.textContent : el.textContent) || '').trim()
        }),
      )
      const wantRange = `S${range.season}E${range.episodeNo}-${range.episodeNoEnd}`
      const singles = slots.filter(s => /S\d+E\d+$/.test(s))
      const ranges = slots.filter(s => /S\d+E\d+-\d+$/.test(s))
      console.log(`[verify:merge-fe] episode slots: ${JSON.stringify(slots)}`)
      check(
        `★ 渲染：合集槽显示区间（出现 ${wantRange}）`,
        slots.includes(wantRange),
        `want=${wantRange} slots=${JSON.stringify(slots.slice(0, 12))}`,
      )
      check(
        '★ 渲染：单集槽不带 -N',
        slots.every(s => /S\d+E\d+(-\d+)?$/.test(s)),
        `异常槽=${JSON.stringify(slots.filter(s => !/S\d+E\d+(-\d+)?$/.test(s)))}`,
      )
      void singles
      void ranges
    }

    // 找到目标分集并进入编辑态。
    // BUG-181 结构变更后：编辑入口**不在行内**（行 = `episode-pick`，点击只切右栏
    // 焦点），而在**右栏标题行**的 `episode-edit` 按钮。路径分两步：
    // ① 点左栏目标行（左列槽位标签 startsWith S{season}E{no}）
    // ② 右栏出现 `episode-edit` 后点它 → 编辑面板内才有 `episode-end-input`。
    const pickedRow = await page.evaluate(
      (season, no) => {
        for (const row of document.querySelectorAll('[data-testid="episode-pick"]')) {
          const label = (row.querySelector('span')?.textContent || '').trim()
          if (!label.startsWith(`S${season}E${no}`)) continue
          row.click()
          return true
        }
        return false
      },
      range.season,
      range.episodeNo,
    )
    check(
      `选中 S${range.season}E${range.episodeNo} 分集行（episode-pick）`,
      pickedRow,
    )
    let openedEdit = false
    try {
      await waitForTestId(page, 'episode-edit', STEP_TIMEOUT_MS)
      openedEdit = await clickTestId(page, 'episode-edit')
    } catch (_err) {
      openedEdit = false
    }
    check(
      `打开 S${range.season}E${range.episodeNo} 的编辑态（右栏 episode-edit）`,
      openedEdit,
    )

    let endInputReady = false
    try {
      await waitForTestId(page, 'episode-end-input', 10000)
      endInputReady = true
    } catch (_err) {
      endInputReady = false
    }

    if (REVERT_TO_PRE_FIX) {
      const n = await removeEndInputInPage(page)
      console.log(`[verify:merge-fe] FALSIFY(BUG-153): 已从 DOM 移除 ${n} 个结束集输入框`)
      endInputReady = false
    }

    check(
      '★ 编辑态存在 episode-end-input（修复前该元素不存在）',
      endInputReady && (await hasTestId(page, 'episode-end-input')),
    )
    {
      const ph = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="episode-end-input"]')
        return el ? el.getAttribute('placeholder') || '' : null
      })
      check('结束集输入框 placeholder 说明「留空=单集」', Boolean(ph) && ph.includes('留空'), `placeholder=${ph}`)
    }
    {
      const prefilled = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="episode-end-input"]')
        return el ? el.value : null
      })
      check(
        '★ 打开合集分集编辑态：结束集输入框预填该终点值',
        String(prefilled) === String(range.episodeNoEnd),
        `prefill=${prefilled} backend=${range.episodeNoEnd}`,
      )
    }

    // ---- 判据 2：改终点并保存 → payload 含 episodeNoEnd 且等于用户输入 ----
    const newEnd = range.episodeNoEnd + 2
    capturedPatches.length = 0
    const setEnd = await setInputValue(page, 'episode-end-input', String(newEnd))
    check(`把结束集改为 ${newEnd}`, setEnd)
    await clickTestId(page, 'episode-save')
    try {
      await page.waitForFunction(() => true, { timeout: 100 })
    } catch (_err) {
      /* noop */
    }
    await new Promise(resolve => setTimeout(resolve, 2500))
    {
      console.log(`[verify:merge-fe] captured PATCH: ${JSON.stringify(capturedPatches)}`)
      const hit = capturedPatches[capturedPatches.length - 1]
      let body = null
      try {
        body = hit ? JSON.parse(hit.body) : null
      } catch (_err) {
        body = null
      }
      check('提交发出了 PATCH /api/media/episodes/:id', Boolean(hit), `patches=${capturedPatches.length}`)
      check(
        '★ payload 含 episodeNoEnd 键，且值等于用户输入',
        Boolean(body) && 'episodeNoEnd' in body && body.episodeNoEnd === newEnd,
        `body=${hit ? hit.body : 'n/a'}`,
      )
    }

    // 收尾：把终点改回原值，并顺带验证「清空 → 显式 null」
    // 重新进入编辑态（保存成功后编辑面板已收起）。
    // BUG-181 后编辑入口 = 右栏 `episode-edit`（面板收起后按钮仍在，右栏焦点
    // 未变），直接再点一次；失败则兜底重跑「点行 → 点编辑」路径。
    let reopenedEdit = false
    try {
      await waitForTestId(page, 'episode-edit', STEP_TIMEOUT_MS)
      reopenedEdit = await clickTestId(page, 'episode-edit')
    } catch (_err) {
      reopenedEdit = false
    }
    if (!reopenedEdit) {
      await page.evaluate(
        (season, no) => {
          for (const row of document.querySelectorAll('[data-testid="episode-pick"]')) {
            const label = (row.querySelector('span')?.textContent || '').trim()
            if (!label.startsWith(`S${season}E${no}`)) continue
            row.click()
            return
          }
        },
        range.season,
        range.episodeNo,
      )
      try {
        await waitForTestId(page, 'episode-edit', STEP_TIMEOUT_MS)
        reopenedEdit = await clickTestId(page, 'episode-edit')
      } catch (_err) {
        reopenedEdit = false
      }
    }
    check('保存后重新进入编辑态（右栏 episode-edit）', reopenedEdit)
    try {
      await waitForTestId(page, 'episode-end-input', 10000)
    } catch (_err) {
      /* 由下面的断言如实报告 */
    }
    if (REVERT_TO_PRE_FIX) await removeEndInputInPage(page)

    // ---- 判据 3：清空结束集 → payload 的 episodeNoEnd 为 null（不是缺失字段）----
    capturedPatches.length = 0
    const cleared = await setInputValue(page, 'episode-end-input', '')
    check('清空结束集输入框', cleared)
    await clickTestId(page, 'episode-save')
    await new Promise(resolve => setTimeout(resolve, 2500))
    {
      console.log(`[verify:merge-fe] captured PATCH (clear): ${JSON.stringify(capturedPatches)}`)
      const hit = capturedPatches[capturedPatches.length - 1]
      let body = null
      try {
        body = hit ? JSON.parse(hit.body) : null
      } catch (_err) {
        body = null
      }
      check(
        '★ 清空后 payload 的 episodeNoEnd 为 null（键在、值为 null；省略字段则判据不成立）',
        Boolean(body) && 'episodeNoEnd' in body && body.episodeNoEnd === null,
        `body=${hit ? hit.body : 'n/a'}`,
      )
    }

    // 还原后端：把结束集放回原值。
    // 本轮验收对**真实库**做了写操作，必须还原 —— 且还原走 API 直写而不是再点一次 UI：
    // 保存成功后编辑面板会收起，重新定位「编辑」入口要重跑一整套 DOM 查询，
    // 任何一步失手都会把「没还原」伪装成「产品缺陷」。
    {
      const restored = await httpPatchJson(
        `${MEDIA_API}/api/media/episodes/${range.id}`,
        { episodeNoEnd: range.episodeNoEnd },
      )
      const after = await httpGetJson(`${MEDIA_API}/api/media/series/${rangeSeriesId}`)
      const ep = after && Array.isArray(after.episodes)
        ? after.episodes.find(e => e.id === range.id)
        : null
      check(
        `收尾：后端 episodeNoEnd 已还原为 ${range.episodeNoEnd}`,
        restored && Boolean(ep) && ep.episodeNoEnd === range.episodeNoEnd,
        `patched=${restored} actual=${ep ? ep.episodeNoEnd : 'n/a'}`,
      )
    }

    // ---- 运行时健康 ----
    console.log('')
    console.log('--- 运行时健康 ---')
    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))

    for (const off of removedListeners) off()

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const html = await page.content()
    const domPath = path.join(OUT_DIR, `merge-frontend-${stamp}.html`)
    fs.writeFileSync(domPath, html, 'utf8')
    fs.writeFileSync(
      path.join(OUT_DIR, `merge-frontend-${stamp}.json`),
      JSON.stringify({ appUrl: APP_URL, range, capturedPatches, results }, null, 2),
      'utf8',
    )
    console.log(`[verify:merge-fe] DOM 快照: ${domPath}`)

    console.log('')
    const failed = results.filter(r => !r.ok)
    const passed = results.length - failed.length
    console.log(`[verify:merge-fe] ${passed}/${results.length} assertions passed`)
    if (failed.length > 0) {
      console.log('')
      console.log('--- FAILURES ---')
      for (const item of failed) console.log(`  - ${item.name}: ${item.detail || 'n/a'}`)
      console.log(`[verify:merge-fe] RESULT: FAIL (${failed.length} failed)`)
      return 1
    }
    console.log('[verify:merge-fe] RESULT: PASS')
    return 0
  } finally {
    await browser.close()
  }
}
