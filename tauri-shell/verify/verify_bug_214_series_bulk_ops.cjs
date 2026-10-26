#!/usr/bin/env node
'use strict'

/**
 * BUG-214 真实 UI 验收：剧集墙多选补基础批量操作（删除/打标/导出）+ 动作条改底部悬浮。
 *
 * ## 缺陷回顾（用户复报原话）
 *
 * 「多选批量操作问题也没有修复，批量不应该只有合并，删除，等等其他基础功能也必须支持。」
 * 剧集墙多选（BUG-186）落地时只覆盖了**合并**：动作条 `series-selection-bar` 仅挂
 * 「合并剧集 / 清空选择」，且渲染在滚动容器内**顶部普通流**里 —— 勾选视口外的卡片后
 * 向上浏览时动作条已滚出视野，动作不可达。
 *
 * ## 本脚本断言什么（打真实渲染的 DOM + 真实后端）
 *
 *   A1 能力：选中 2 条剧集 → 动作条出现，且「批量删除 / 批量打标 / 批量导出」三个按钮
 *      **存在 + 文案非空 + 未禁用**，「合并剧集」可点（`disabled === false`）。
 *   A2 位置：动作条水平居中于内容区（|Δ中心| ≤ 2px）、距内容区底边 16px（|误差| ≤ 4px），
 *      并打印 viewport 相对值以备核对。
 *   A3 滚动不丢失：把剧集墙滚动容器 `scrollTop = 400` 后动作条仍在视口内。
 *      **反恒绿前置**：容器必须真的可滚（scrollHeight − clientHeight ≥ 300）且确实滚动了。
 *   A4 删除确认：点「批量删除」→ 出现删除清单，清单行数 === 选中剧集数，且
 *      「条目与已下载文件会保留」口径文案非空 → 点**取消**（绝不点确认，不碰用户库）。
 *
 * ## B 段（验牙 / 反证）
 *
 * `--simulate-legacy`（或 `ORIG_VERIFY_LEGACY=1`）把 DOM 还原成 BUG-214 之前的形态：
 * 动作条摘掉三个新按钮、并搬回滚动容器内顶部普通流。然后**重跑 A1/A2/A3 判据**，
 * 三条必须全 FAIL（A1 的失败原因必须是「找不到批量删除入口」，而不是脚本自身异常）。
 * 两段结果在结尾打对照表。
 *
 * ## 环境
 *
 *   vite dev + 后端。二者未就绪时脚本用 `scripts/dev_services.py` 拉起
 *   （**不裸跑** orig-tg / orig-daemon —— daemon 是唯一启动者，BUG-177/178 契约）。
 *   orig-tg 端口**从 daemon `/api/config` 的 `tg_port` 取真源**，不硬编码。
 *
 * 用法：
 *   node verify/verify_bug_214_series_bulk_ops.cjs
 *   node verify/verify_bug_214_series_bulk_ops.cjs --simulate-legacy   # B 段验牙
 *
 * Env: APP_PORT(5180) / DAEMON_PORT(19786) / ORIG_VERIFY_SHOTS / ORIG_VERIFY_LEGACY
 * Exit: 0 = 全部通过；2 = A 段有判据失败；3 = B 段验牙失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')
const sandbox = require('./lib/sandbox.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 19786)
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`
const LEGACY = process.argv.includes('--simulate-legacy') || process.env.ORIG_VERIFY_LEGACY === '1'

/** 回退链上要复核的三个新按钮（BUG-214 的增量）。 */
const BULK_TESTIDS = ['series-bulk-tag', 'series-bulk-export', 'series-bulk-remove']
const REMOVE_TESTID = 'series-bulk-remove'

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS ||
    path.join(__dirname, '..', 'verify_shots', 'bug214'),
)

/** 动作条与内容区的几何期望（与实现里的 `bottom-4 left-1/2` 对应）。 */
const EXPECT_BOTTOM_GAP = 16
const BOTTOM_GAP_TOL = 4
const CENTER_TOL = 2
/** 滚动不丢失的滚动量。 */
const SCROLL_BY = 400
/** 反恒绿：墙必须真的能滚这么多。 */
const MIN_SCROLLABLE = 300

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail, id = '') {
  checks.push({ name, pass: Boolean(pass), detail, id })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(pass)
}

// ─────────────────────────── HTTP（仅回环） ───────────────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

/** 从 daemon 真源取 orig-tg 端口（不硬编码；端口可被保留区顺延/迁移）。 */
async function resolveTgBase() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  // BUG-358 起 `/api/config` 的 `tg_port` 收进 `plugins[]`（id='tg'）—— 旧键直读
  // 会恒得 undefined（BUG-422 实测假红）。适配器双契约兼容，只此一处。
  const tgPort = sandbox.tgPortOf(cfg.json)
  if (cfg.status !== 200 || !cfg.json || !tgPort) return null
  return { base: `http://127.0.0.1:${tgPort}`, tgRunning: sandbox.tgRunningOf(cfg.json) }
}

/** 环境未就绪时按仓库约定拉起（daemon 是唯一启动者）。 */
function startDevServices() {
  const repo = path.resolve(__dirname, '..', '..')
  const script = path.join(repo, 'scripts', 'dev_services.py')
  console.log(`[bug214] dev services not ready — starting ${script}`)
  execFileSync('python', [script], { cwd: repo, stdio: 'inherit', timeout: 120000 })
}

async function waitForEnv(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const tg = await resolveTgBase()
    const app = await httpJson('GET', APP_URL)
    if (tg && tg.tgRunning && app.status === 200) return tg
    last = { tg, appStatus: app.status }
    await delay(1000)
  }
  return last
}

// ─────────────────────────── 夹具（只造自己的） ───────────────────────────

async function createItem(title, ts, tg) {
  const fakePath = path.join(os.tmpdir(), `orighub-bug214-${ts}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  // BUG-422：导入即被 BUG-304 自动归档进单集剧集；不先撤销归属，后面往自己的
  // 剧集挂载会撞 media_episode.item_id 唯一约束（HTTP 500）。
  if (id != null) await sandbox.detachAutoSeries(tg, id)
  return { id, status: r.status }
}

async function createSeries(title, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status }
}

async function addEpisode(seriesId, itemId, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo: 1,
  })
  return r.status
}

/**
 * 造 2 条**自己拥有的**剧集（各 1 集）。
 *
 * 为什么不用库里已有剧集：A4 要断言「清单行数 === 选中数」，用自造夹具才有确定的目标集；
 * 收尾按记录的 id 精确删除，绝不碰用户数据。
 */
async function makeFixtures(tg) {
  const ts = Date.now()
  const out = []
  for (const key of ['A', 'B']) {
    const title = `ZZ-BUG214-${key}-${ts}`
    const item = await createItem(title, ts, tg)
    if (item.id == null) throw new Error(`fixture item ${key} not created (status=${item.status})`)
    const s = await createSeries(title, tg)
    if (s.id == null) throw new Error(`fixture series ${key} not created (status=${s.status})`)
    const epStatus = await addEpisode(s.id, item.id, tg)
    if (epStatus !== 200) throw new Error(`fixture episode ${key} not added (status=${epStatus})`)
    out.push({ key, title, seriesId: s.id, itemId: item.id })
  }
  return out
}

// ─────────────────────────── DOM 判据 ───────────────────────────

/** 在剧集墙上点选给定的剧集卡（真实点击，不是改 state）。 */
async function selectSeries(page, ids) {
  for (const id of ids) {
    const ok = await page.evaluate((sid) => {
      const root = document.querySelector(
        `[data-testid="series-card-root"][data-series-id="${sid}"]`,
      )
      const btn = root && root.querySelector('[data-testid="series-card-select"]')
      if (!btn) return false
      btn.click()
      return true
    }, id)
    if (!ok) throw new Error(`series-card-select for ${id} not found`)
    await delay(200)
  }
}

/**
 * A1：批量能力的存在与可用性。返回 `{ok, detail, reason}` —— `reason` 区分
 * 「按钮缺失」与「按钮存在但不可用」，B 段据此断言失败原因必须是前者。
 */
async function judgeA1(page) {
  const snap = await page.evaluate((ids, removeId) => {
    const read = (testid) => {
      const el = document.querySelector(`[data-testid="${testid}"]`)
      if (!el) return null
      return {
        text: String(el.textContent || '').trim(),
        disabled: el.disabled === true,
      }
    }
    const bar = document.querySelector('[data-testid="series-selection-bar"]')
    return {
      hasBar: !!bar,
      count: read('series-selection-count'),
      merge: read('series-merge-wall'),
      bulk: Object.fromEntries(ids.map((id) => [id, read(id)])),
      removePresent: !!document.querySelector(`[data-testid="${removeId}"]`),
    }
  }, BULK_TESTIDS, REMOVE_TESTID)

  if (!snap.hasBar) {
    return { ok: false, snap, reason: '动作条 [series-selection-bar] 不存在（选中后未出现）', detail: 'hasBar=false' }
  }
  const missing = BULK_TESTIDS.filter((id) => snap.bulk[id] === null)
  if (missing.length > 0) {
    // 失败原因必须精确到「找不到批量删除入口」——B 段验牙就靠这句话。
    return {
      ok: false,
      snap,
      reason: `找不到批量删除入口（缺失按钮：${missing.join(' / ')}）`,
      detail: `missing=${JSON.stringify(missing)}`,
    }
  }
  const badText = []
  const badDisabled = []
  for (const id of BULK_TESTIDS) {
    if (!snap.bulk[id].text) badText.push(id)
    if (snap.bulk[id].disabled) badDisabled.push(id)
  }
  if (!snap.count || !snap.count.text) badText.push('series-selection-count')
  if (!snap.merge || !snap.merge.text) badText.push('series-merge-wall')
  if (snap.merge && snap.merge.disabled) badDisabled.push('series-merge-wall')

  const ok = badText.length === 0 && badDisabled.length === 0
  return {
    ok,
    snap,
    reason: ok ? '' : `按钮文案为空：${JSON.stringify(badText)} / 被禁用：${JSON.stringify(badDisabled)}`,
    detail:
      `count=${JSON.stringify(snap.count && snap.count.text)} ` +
      `merge=${JSON.stringify(snap.merge && snap.merge.text)}/${snap.merge && snap.merge.disabled} ` +
      `tag=${JSON.stringify(snap.bulk['series-bulk-tag'] && snap.bulk['series-bulk-tag'].text)} ` +
      `export=${JSON.stringify(snap.bulk['series-bulk-export'] && snap.bulk['series-bulk-export'].text)} ` +
      `remove=${JSON.stringify(snap.bulk[REMOVE_TESTID] && snap.bulk[REMOVE_TESTID].text)}`,
  }
}

/** A2：动作条几何位置（相对**内容区**，不是视口）。 */
async function judgeA2(page, tag) {
  // 判据翻转（BUG-422，与 B5b 同型）：原判据要求动作条 `position: absolute`
  // 且相对**滚动容器**居中/贴底。BUG-393（2026-10-23，用户裁定「样式就应该统一」）
  // 把三域选择条收口为**全仓标准形态**：`fixed bottom-4 left-1/2 -translate-x-1/2`
  // —— 视口相对。理由有实测：两域包含块不同（剧集墙的条挂在带内边距的面板里，
  // absolute 落点比下载域右偏 96px、上移 32px），写同一串 absolute 类名也得不到
  // 同一个落点（见 selection-bar.tsx 注释与 docs/standards/style.md §选择条）。
  // 旧判据方向与现标准相反，留着等于要求产品退回 BUG-393 已修掉的不一致。
  // 现判据验的是同一个意图（浮在底部、水平居中），基准从「内容区」换成「视口」。
  const geo = await page.evaluate((expectGap) => {
    const bar = document.querySelector('[data-testid="series-selection-bar"]')
    if (!bar) return { hasBar: false }
    const b = bar.getBoundingClientRect()
    return {
      hasBar: true,
      bar: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height },
      // 视口居中（left-1/2 -translate-x-1/2 的必然结果）
      centerDelta: (b.left + b.right) / 2 - window.innerWidth / 2,
      // 距视口底边（bottom-4 = 16px）
      bottomGap: window.innerHeight - b.bottom,
      expectGap,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      pos: getComputedStyle(bar).position,
    }
  }, EXPECT_BOTTOM_GAP)

  if (!geo.hasBar) {
    return { ok: false, geo, reason: '动作条缺失，几何无从判定', detail: JSON.stringify(geo) }
  }
  const centerOk = Math.abs(geo.centerDelta) <= CENTER_TOL
  const gapOk = Math.abs(geo.bottomGap - EXPECT_BOTTOM_GAP) <= BOTTOM_GAP_TOL
  const fixedOk = geo.pos === 'fixed'
  const detail =
    `centerDelta=${geo.centerDelta.toFixed(2)}px (tol ${CENTER_TOL}) ` +
    `bottomGap=${geo.bottomGap.toFixed(2)}px (expect ${EXPECT_BOTTOM_GAP}±${BOTTOM_GAP_TOL}) ` +
    `position=${geo.pos} ` +
    `viewport=${geo.innerWidth}x${geo.innerHeight} ` +
    `bar=[${geo.bar.left.toFixed(1)},${geo.bar.top.toFixed(1)}..${geo.bar.right.toFixed(1)},${geo.bar.bottom.toFixed(1)}]`
  return {
    ok: centerOk && gapOk && fixedOk,
    geo,
    reason:
      !fixedOk ? '动作条不是 fixed 定位（BUG-393 标准形态：fixed bottom-4 left-1/2）' :
      !centerOk ? `视口水平中心偏差 ${geo.centerDelta.toFixed(2)}px 超过 ${CENTER_TOL}px` :
      !gapOk ? `距视口底边 ${geo.bottomGap.toFixed(2)}px，偏离 ${EXPECT_BOTTOM_GAP}±${BOTTOM_GAP_TOL}` : '',
    detail,
    shot: tag,
  }
}

/**
 * A3：滚动后动作条仍在视口内。
 *
 * 反恒绿：先证明容器**真的可滚**（scrollHeight − clientHeight ≥ MIN_SCROLLABLE）
 * 且 `scrollTop` 真的被写成 SCROLL_BY —— 否则「滚动后仍可见」是废话。
 */
async function judgeA3(page) {
  const scrolled = await page.evaluate((by, minScrollable) => {
    const scroller = document.querySelector('[data-testid="series-wall-scroll"]')
    if (!scroller) return { ok: false, why: 'no series-wall-scroll container' }
    const max = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTop = by
    return {
      maxScrollable: max,
      scrollTop: scroller.scrollTop,
      scrollable: max >= minScrollable,
    }
  }, SCROLL_BY, MIN_SCROLLABLE)

  if (!scrolled.scrollable) {
    return {
      ok: false,
      scrolled,
      reason: `剧集墙不可滚或滚动量不足（scrollHeight−clientHeight=${scrolled.maxScrollable} < ${MIN_SCROLLABLE}）：无法构成滚动证伪`,
      detail: JSON.stringify(scrolled),
    }
  }

  // 有界等待：等浏览器把这拍滚动落地（不再无条件 sleep 后直接 PASS）。
  let landed = false
  try {
    await page.waitForFunction(
      (by) => {
        const s = document.querySelector('[data-testid="series-wall-scroll"]')
        return !!s && s.scrollTop >= by
      },
      { timeout: 5000, args: [SCROLL_BY] },
    )
    landed = true
  } catch (_e) {
    landed = false
  }

  const vis = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="series-selection-bar"]')
    if (!bar) return { hasBar: false }
    const r = bar.getBoundingClientRect()
    return {
      hasBar: true,
      top: r.top,
      bottom: r.bottom,
      innerHeight: window.innerHeight,
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
    }
  })

  if (!landed || !vis.hasBar) {
    return {
      ok: false,
      scrolled,
      vis,
      reason: !landed ? '滚动未落地/动作条被滚走' : '动作条缺失',
      detail: `landed=${landed} bar=${JSON.stringify(vis)}`,
    }
  }
  return {
    ok: vis.inViewport === true,
    scrolled,
    vis,
    reason: vis.inViewport ? '' : `滚动后动作条不在视口内（top=${vis.top.toFixed(1)} bottom=${vis.bottom.toFixed(1)} vh=${vis.innerHeight}）`,
    detail:
      `scrollTop=${scrolled.scrollTop}/${scrolled.maxScrollable} ` +
      `bar.top=${vis.top.toFixed(1)} bar.bottom=${vis.bottom.toFixed(1)} innerHeight=${vis.innerHeight} inViewport=${vis.inViewport}`,
  }
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    /* 产物缺失不影响判据 */
  }
  console.log(`[bug214] shot ${name} -> ${file} (${size} bytes)`)
}

/** 把 DOM 还原成 BUG-214 之前的形态（顶部普通流 + 只有合并/清空）。 */
async function injectLegacyDom(page) {
  return page.evaluate((bulkIds) => {
    const bar = document.querySelector('[data-testid="series-selection-bar"]')
    if (!bar) return { ok: false, why: '动作条不存在，无法注入' }
    const removed = []
    for (const id of bulkIds) {
      const el = bar.querySelector(`[data-testid="${id}"]`)
      if (el) {
        el.remove()
        removed.push(id)
      }
    }
    // 旧形态：动作条在滚动容器内**顶部普通流**（BUG-214 之前的类名即如此）。
    bar.className =
      'mb-3 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2'
    const scroller = document.querySelector('[data-testid="series-wall-scroll"]')
    if (scroller) scroller.prepend(bar)
    return { ok: true, removed }
  }, BULK_TESTIDS)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug214] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS} mode=${LEGACY ? 'legacy(B)' : 'normal(A)'}`)

  // ── 环境（未就绪按仓库约定拉起 daemon；绝不裸跑 orig-tg）──
  let envInfo = await resolveTgBase()
  if (!envInfo || !envInfo.tgRunning) {
    startDevServices()
    envInfo = await waitForEnv()
  }
  if (!envInfo || !envInfo.base || !envInfo.tgRunning) {
    console.error(`[bug214] 环境未就绪：${JSON.stringify(envInfo)}`)
    process.exit(1)
  }
  const TG = envInfo.base
  console.log(`[bug214] orig-tg = ${TG}（取自 daemon tg_port 真源）`)

  let created = { series: [], items: [] }
  let browser = null
  try {
    const fixture = await makeFixtures(TG)
    created = { series: fixture.map((f) => f.seriesId), items: fixture.map((f) => f.itemId) }
    console.log(`[bug214] fixtures: ${JSON.stringify(fixture.map((f) => ({ id: f.seriesId, title: f.title })))}`)

    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2000 })

    // ── 导航（一律 data-testid）：媒体库 → 剧集墙 ──
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-child-lib-series 入口不存在')
    await delay(1500)
  // M0 导航模型（BUG-298）：`media-rail-series-all` 已废止，侧栏入口直达剧集墙；
  // 墙可达性由下面的 series-card-root 有界等待承担（不再点已删除的 rail）。

    // 有界等待：两条夹具的卡片都要出现在墙上。
    await page.waitForFunction(
      (ids) =>
        ids.every((id) =>
          !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${id}"]`),
        ),
      { timeout: 25000, args: [fixture.map((f) => f.seriesId)] },
    )
    // 动作条在这一刻还不该出现（未选任何卡片）——「选中才出现」的前置。
    const preBar = await page.evaluate(
      () => !!document.querySelector('[data-testid="series-selection-bar"]'),
    )
    check('A0: 未选中任何剧集时动作条不出现', preBar === false, `hasBar=${preBar}`, 'A0')

    await selectSeries(page, fixture.map((f) => f.seriesId))
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="series-selection-bar"]'),
      { timeout: 10000 },
    )
    await delay(300)
    await shot(page, '01-wall-selection.png')

    // ── A 段 ──
    console.log('[bug214] --- A 段：修复后判据（必须全 PASS）---')
    const a1 = await judgeA1(page)
    check('A1: 批量删除/打标/导出入口存在且可用（文案非空 + 未禁用）', a1.ok, a1.detail || a1.reason, 'A1')

    const a2 = await judgeA2(page)
    check('A2: 动作条浮在内容区底部并水平居中', a2.ok, a2.detail, 'A2')
    await shot(page, '02-actionbar-bottom.png')

    const a3 = await judgeA3(page)
    check('A3: 滚动后动作条仍在视口内', a3.ok, a3.detail, 'A3')
    await shot(page, '03-scrolled-still-visible.png')

    // A4：删除确认（只到「取消」为止，绝不点确认）
    let a4 = { ok: false, detail: 'not reached', reason: 'not reached' }
    if (a1.ok) {
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="series-bulk-remove"]')
        if (b) b.click()
      })
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="series-confirm-delete-list"]'),
        { timeout: 10000 },
      )
      const snap = await page.evaluate(() => {
        const rows = document.querySelectorAll('[data-testid="series-confirm-delete-item"]')
        const keep = document.querySelector('[data-testid="series-confirm-keep-items"]')
        return {
          rowCount: rows.length,
          texts: [...rows].map((r) => String(r.textContent || '').trim()),
          keepText: keep ? String(keep.textContent || '').trim() : null,
        }
      })
      const expected = fixture.length
      const titlesShown = fixture.every((f) => snap.texts.some((t) => t.includes(f.title)))
      a4 = {
        ok: snap.rowCount === expected && titlesShown && Boolean(snap.keepText),
        detail:
          `rows=${snap.rowCount}/${expected} titlesShown=${titlesShown} ` +
          `keepText=${JSON.stringify(snap.keepText)} rows=${JSON.stringify(snap.texts)}`,
        reason:
          snap.rowCount !== expected ? `清单行数 ${snap.rowCount} ≠ 选中数 ${expected}` :
          !titlesShown ? '清单未列出将删剧名' :
          !snap.keepText ? '缺少「条目与文件保留」口径文案' : '',
      }
      check('A4: 删除确认列出清单行数 = 选中数 + 明示「条目保留」口径', a4.ok, a4.detail, 'A4')
      // 取消（不点确认 —— 不真删用户库）
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="media-confirm-no"]')
        if (b) b.click()
      })
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="series-confirm-delete-list"]'),
        { timeout: 8000 },
      ).catch(() => undefined)
    } else {
      check('A4: 删除确认列出清单行数 = 选中数 + 明示「条目保留」口径', false, 'A1 未通过，跳过', 'A4')
    }

    // ── B 段（验牙）：还原旧形态 → A1/A2/A3 必须 FAIL ──
    let bResult = null
    if (LEGACY) {
      console.log('[bug214] --- B 段：注入 BUG-214 之前的形态（判据必须全 FAIL）---')
      const inj = await injectLegacyDom(page)
      console.log(`[bug214] legacy DOM injected: ${JSON.stringify(inj)}`)
      const b1 = await judgeA1(page)
      check('B1(验牙): 旧形态下 A1 必须 FAIL', !b1.ok, `reason=${b1.reason} detail=${b1.detail}`, 'B1')
      const b2 = await judgeA2(page)
      check('B2(验牙): 旧形态下 A2 必须 FAIL', !b2.ok, `reason=${b2.reason} detail=${b2.detail}`, 'B2')
      const b3 = await judgeA3(page)
      check('B3(验牙): 旧形态下 A3 必须 FAIL', !b3.ok, `reason=${b3.reason} detail=${b3.detail}`, 'B3')
      // 失败原因必须是「找不到批量删除入口」这个产品原因，而不是脚本异常。
      const reasonOk = /找不到批量删除入口/.test(b1.reason)
      check('B4(验牙): A1 的失败原因是「找不到批量删除入口」而非脚本异常', reasonOk,
        `reason=${JSON.stringify(b1.reason)}`, 'B4')

      bResult = {
        a: { a1: a1.ok, a2: a2.ok, a3: a3.ok },
        b: { a1: b1.ok, a2: b2.ok, a3: b3.ok },
        reasons: { a1: b1.reason, a2: b2.reason, a3: b3.reason },
      }
      console.log('[bug214] --- A/B 对照表 ---')
      console.log(`[bug214] A1 修复后=${a1.ok ? 'PASS' : 'FAIL'}  旧形态=${b1.ok ? 'PASS' : 'FAIL'}  reason=${b1.reason}`)
      console.log(`[bug214] A2 修复后=${a2.ok ? 'PASS' : 'FAIL'}  旧形态=${b2.ok ? 'PASS' : 'FAIL'}  reason=${b2.reason}`)
      console.log(`[bug214] A3 修复后=${a3.ok ? 'PASS' : 'FAIL'}  旧形态=${b3.ok ? 'PASS' : 'FAIL'}  reason=${b3.reason}`)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug214] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)
    check('A5: 页面无未捕获异常', pageErrs.length === 0, JSON.stringify(pageErrs), 'A5')

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[bug214] === SUMMARY ===')
    console.log(`[bug214] shots: ${SHOTS}`)
    console.log(`[bug214] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[bug214] FAILED:', failed.map((c) => `${c.id}:${c.name}`).join(' | '))

    if (LEGACY) {
      // B 段：三条验牙判据全 FAIL + 原因正确 ⇒ 通过（exit 0）；否则 exit 3。
      const teeth = bResult.b.a1 === false && bResult.b.a2 === false && bResult.b.a3 === false
      console.log(`[bug214] 验牙结论: three-judges-red=${teeth} reason-is-product=${/找不到批量删除入口/.test(bResult.reasons.a1)}`)
      if (!teeth) process.exitCode = 3
    } else if (failed.length) {
      process.exitCode = 2
    }
  } finally {
    if (browser) await browser.close()
    // ── 收尾：只删自己造的夹具（按记录 id，幂等）──
    for (const id of created.series) {
      await httpJson('DELETE', `${TG}/api/media/series/${id}`).catch(() => undefined)
    }
    for (const id of created.items) {
      await httpJson('DELETE', `${TG}/api/media/items/${id}`).catch(() => undefined)
    }
    const left = await httpJson('GET', `${TG}/api/media/series`)
    const still = (left.json && left.json.items ? left.json.items : []).filter((s) =>
      created.series.includes(s.id),
    )
    console.log(
      `[bug214] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`,
    )
  }
}

main().catch((e) => {
  console.error('[bug214] ERROR', (e && e.message) || e)
  process.exit(1)
})
