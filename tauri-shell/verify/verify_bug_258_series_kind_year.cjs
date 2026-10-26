#!/usr/bin/env node
'use strict'

/**
 * BUG-258 真实栈验收（产品裁定后口径）：剧集类型收敛为唯一值 `series`，UI **不再有**
 * 任何类型选择控件；数据层写入仍持久；年份必须能清空；内容编辑弹窗里的同名「类型」
 * 是本地化的**只读**派生值。
 *
 * ## 缺陷回顾（三条独立缺陷，同一份报告）
 *
 * 1. **类型被静默撤销**：`migrate()` 里
 *    `UPDATE media_series SET kind='series' WHERE kind IS NOT 'series' AND 有分集 AND 分集全 video/photo`
 *    由 `Store::open` **无条件**调用。最后那个子句被同一份 `migrate()` 建的
 *    `trg_media_episode_media_only_*` 触发器保证**恒真** ⇒ 任何有分集的剧集
 *    **每次启动**都被打回 `series`。用户在编辑面板改成「图集」，当场保存成功，
 *    重启后变回「剧集」，无任何提示。
 *    修复：改成**一次性**迁移（`app_setting` 标记键 `mig.series_kind_normalize_v1`）。
 *    **产品裁定**：随后 kind 收敛为唯一值 `series` —— UI 移除类型选择控件，引擎侧
 *    保留枚举 422 校验与一次性迁移作为数据层防线（历史库守卫 + 封死非 UI 写路径）。
 * 2. **年份全库为空且清不掉**：`media_series.year` 在**原始 DDL** 里，从没有过回填
 *    （TG 入库路径 `routes.rs` 传 `year: None`）⇒ 全库 NULL；且 `SeriesPatch.year`
 *    是该结构里**唯一**漏掉 `nullable` 契约的可空字段，`None` 同时表示「不改」与
 *    「清空」⇒ **填错就永远改不掉**。修复：`Option<Option<i64>>` 三态。
 * 3. **内容弹窗的类型是只读原始枚举**：`<p>类型：{item.kind}</p>` —— 硬编码中文标签
 *    + 直接渲染后端枚举（`video`/`photo`/`audio`/`file`），没走 i18n，也没说不可改。
 *    修复：走 `media.kind*` 既有键，渲染成 disabled 的 `<select>`（visibly read-only）。
 *
 * ## 判据（打在**真实调用链**上 —— BUG-156：不得只看接口返回）
 *
 *   夹具：自造 1 条**有分集**的剧集 + 1 个 video 条目。收尾按 id 精确删除，绝不动用户数据。
 *
 *   G  **活体门（gate）**：先在**夹具**上探 `PATCH {"kind":"garbage"}` 是否 422。
 *        生产/开发栈里跑的 `orig-tg` 可能仍是**修复前**的二进制，此时 A2 / B1b / B3
 *        必然 FAIL —— 但那是「引擎没重建」，**不是**「修复无效」。不设这道门会把
 *        两者混成一个结论。返回 200/500 ⇒ 引擎不含本次修复 ⇒ 报 BLOCKED 并 exit 1。
 *        ⚠️ 该探测**只打夹具剧集**：修复前的引擎会照单全收，任何打到真实 id 的探针
 *        都会把脏值写进用户的库（实测已发生过一次，已复原）。
 *   P  前置：真实库里存在「有分集」的剧集（打印样本），证明结论不是空库上的巧合。
 *   A1 **判据 1（UI 收敛·编辑面板，正向）**：打开真实 `series-edit-panel`，断言
 *      `series-kind-select` 与**任何**类型选择控件（类型 select / kind radio）
 *      **都不存在** —— 裁定是「不渲染」而不是「禁用」，也不允许留隐藏编辑通道。
 *   A1b **判据 1（UI 收敛·新建弹窗）**：打开「新建剧集」弹窗，断言其中同样**不存在**
 *      任何类型选择控件（此前是 `KIND_OPTIONS` 三选一 radio）。创建恒定 `kind:'series'`。
 *   A2 **判据 1（数据层·重启后持久，走 API 层）**：UI 已无类型入口，持久性判据改打
 *      **API 层** —— `PATCH kind='album'`（合法枚举值，探针性质）→ `POST /api/tg/restart`
 *      重启 orig-tg（daemon 是唯一执行者）→ GET 仍是 `album`。缺陷原形下重启后必然
 *      读回 `series`。
 *   A3 **夹具复位**：`PATCH kind='series'` 把夹具复位回唯一合法业务值并 GET 确认 ——
 *      与 A2 合起来证明写路径双向可逆，且脚本不把非 series 的探针值留在用户库里。
 *   B1 **判据 3**：设年份 `2024` → 保存 → 清空输入框 → 保存 → 读回 `year === null`。
 *   B2 **判据 4（负控）**：年份保持为空、且用户**没碰过**年份框时，只改标题保存，
 *      读回 `year` 仍应是原值（不得被误清）。
 *   B3 **422 契约**：`PATCH {"kind":"garbage"}` 必须 422，且库里的 kind 不得被改动
 *      （非法状态不可表达；引擎侧防线，封死非 UI 写路径）。
 *   C1 **判据 5**：`item-edit-dialog` 里的类型行是**本地化**文案（不得出现裸
 *      `video`/`photo`/`audio`/`file`），且该控件 **`disabled === true`**（visibly read-only）。
 *   S  截图：编辑面板（无类型控件）、新建弹窗（无类型控件）、年份清空态、内容弹窗类型行。
 *
 * ## 牙齿检查（teeth）：为什么这个脚本会 FAIL 在缺陷原形上
 *
 * 把 `media.rs` 的 `normalize_series_kind_once` 改回「每次启动都跑那条 UPDATE」
 * （即恢复 `migrate()` 里的内联 UPDATE、删掉标记键守卫）后：
 *   - **A2 必然 FAIL** —— 重启触发 `Store::open` → `migrate()` → 打回 `series`；
 *   - B1 必然 FAIL（把 `SeriesPatch.year` 改回 `Option<i64>` 时同理，`null` 被当成「不改」）。
 * **UI 收敛的反向验牙**：把旧 `<select data-testid="series-kind-select">`（或
 * `KIND_OPTIONS` radio 组）临时加回 `SeriesEditPanel.tsx` / `SeriesDialog.tsx` 后，
 * **A1 / A1b 必然 FAIL** —— `findSeriesKindControls` 不只盯一个 testid，而是三条特征
 * 全查（专用 testid / option 含类型枚举值 / `name="series-kind"` 的 radio），换 testid
 * 加回来也逃不掉。
 *
 * ## 环境
 *
 *   vite dev + 后端。未就绪时用 `scripts/dev_services.py` 拉起（**不裸跑** orig-tg/daemon）。
 *   orig-tg 端口从 daemon `/api/config` 的 `tg_port` 取真源，不硬编码。
 *   重启用 daemon 的 `POST /api/tg/restart`（前端 `api/daemon.ts#restartTgService` 同一条通道）。
 *
 * 用法：`node verify/verify_bug_258_series_kind_year.cjs`
 * Env : APP_PORT(5180) / DAEMON_PORT(19786) / ORIG_VERIFY_SHOTS
 *        BUG258_SKIP_RESTART=1 —— 跳过 A2/A3 的重启段（引擎不可重启时用；会明确标注跳过）
 * Exit: 0 = 全部通过；2 = 有判据失败；1 = 环境/通道问题（含「引擎未重建」）。
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

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, '..', 'verify_shots', 'bug258'),
)

/** 判据 1 用的目标类型：必须是「非 series」的那一档，否则整条判据恒绿。 */
const TARGET_KIND = 'album'
/** 判据 3 用的年份（一个明显是用户会填的值，不是默认值）。 */
const TEST_YEAR = 2024
/** 跳过重启段（引擎不可重启时用；跳过的判据会**明确标注**，不静默省略）。 */
const SKIP_RESTART = process.env.BUG258_SKIP_RESTART === '1'

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
    const t = setTimeout(() => ctrl.abort(), 15000)
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

/** 从 daemon 真源取 orig-tg 端口（不硬编码）。 */
async function resolveTgBase() {
  const cfg = await httpJson('GET', `${DAEMON}/api/config`)
  // BUG-358 起 `/api/config` 的 `tg_port` 收进 `plugins[]`（id='tg'）—— 旧键直读
  // 会恒得 undefined（BUG-422 实测假红）。适配器双契约兼容，只此一处。
  const tgPort = sandbox.tgPortOf(cfg.json)
  if (cfg.status !== 200 || !cfg.json || !tgPort) return null
  return { base: `http://127.0.0.1:${tgPort}`, tgRunning: sandbox.tgRunningOf(cfg.json) }
}

function startDevServices() {
  const repo = path.resolve(__dirname, '..', '..')
  const script = path.join(repo, 'scripts', 'dev_services.py')
  console.log(`[bug258] dev services not ready — starting ${script}`)
  execFileSync('python', [script], { cwd: repo, stdio: 'inherit', timeout: 180000 })
}

async function waitForEnv(timeoutMs = 90000) {
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

/** orig-tg 探活（重启后必须重新确认服务真的回来了，否则会把「服务没起来」误判成 FAIL）。 */
async function waitForTgReady(tgBase, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const r = await httpJson('GET', `${tgBase}/api/media/stats`)
    if (r.status === 200) return { ok: true, at: Date.now() }
    last = r
    await delay(1000)
  }
  return { ok: false, last }
}

// ─────────────────────────── 夹具（只造自己的） ───────────────────────────

async function createItem(title, ts, tg) {
  const fakePath = path.join(os.tmpdir(), `orighub-bug258-${ts}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
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
 * 造一条**有分集**的剧集 + 一个 video 条目。
 *
 * 「有分集」是**判据成立的必要条件**：缺陷原形的 UPDATE 带 `EXISTS(分集)` 守卫，
 * 零分集剧集在缺陷原形下也 PASS —— 用它当夹具会让判据恒绿（假阴性）。
 * 所以这里造有分集的，并在 P 段另行取真实库样本作对照。
 */
async function makeFixture(tg) {
  const ts = Date.now()
  const item = await createItem(`ZZ-BUG258-V-${ts}`, ts, tg)
  if (item.id == null) throw new Error(`fixture item not created (status=${item.status})`)
  const ser = await createSeries(`ZZ-BUG258-S-${ts}`, tg)
  if (ser.id == null) throw new Error(`fixture series not created (status=${ser.status})`)
  const epStatus = await addEpisode(ser.id, item.id, tg)
  if (epStatus !== 200) {
    throw new Error(`fixture episode not added (status=${epStatus}) — 无分集则判据 1 恒绿`)
  }
  return { seriesId: ser.id, itemId: item.id, title: `ZZ-BUG258-S-${ts}` }
}

// ─────────────────────────── DOM 操作 ───────────────────────────

async function navToSeriesWall(page) {
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-child-lib-series 入口不存在')
  await delay(1500)
  await delay(1200)
}

/** 点开指定剧集的详情页（`series-card` 的点击区）。 */
async function openSeriesDetail(page, seriesId) {
  await page.evaluate((sid) => {
    const el = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (el) el.click()
  }, seriesId)
  // BUG-422：固定 `delay(1200)` 不等价于「详情已打开」。A2 段重启 orig-tg 后详情
  // 首拉是冷请求（B 段重导航），1200ms 内视图还没切 ⇒ openSeriesEditPanel 找不到
  // `series-desc-edit`，误报「入口不存在（SeriesEditPanel 打不开）」。
  // 改为有界等待详情视图锚点（`series-title`），超时报出真实原因。
  const opened = await page.waitForFunction(
    () => !!document.querySelector('[data-testid="series-title"]'),
    { timeout: 20000 },
  ).then(() => true).catch(() => false)
  if (!opened) throw new Error('剧集详情视图未打开（点击 series-card 后 20s 内无 series-title）')
  await delay(300)
}

/** 从剧集详情页打开 `SeriesEditPanel`（`series-desc-edit` 是该面板的唯一入口）。 */
async function openSeriesEditPanel(page) {
  const ok = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="series-desc-edit"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!ok) throw new Error('series-desc-edit 入口不存在（SeriesEditPanel 打不开）')
  await page.waitForFunction(() => !!document.querySelector('[data-testid="series-edit-panel"]'), {
    timeout: 10000,
  })
  await delay(300)
}

/**
 * 在给定根容器内**寻找任何剧集类型选择控件**（BUG-258 产品裁定后必须一个都没有）。
 *
 * 反向验牙的关键：检查不能只盯 `series-kind-select` 这一个 testid —— 有人把旧 UI
 * 加回来时可能换了 testid，所以三条特征全查：
 *   1. `data-testid="series-kind-select"`（旧编辑面板下拉的专用标识）
 *   2. 任何 `<select>` 的 option 里含 `collection` / `album`（类型枚举的特征值）
 *   3. 任何 `input[type=radio][name="series-kind"]`（旧新建弹窗 KIND_OPTIONS radio 组）
 *
 * @returns {{present: boolean, hits: string[], reason: string}}
 */
async function findSeriesKindControls(page, rootSelector) {
  return page.evaluate((root) => {
    const scope = root ? document.querySelector(root) : document
    if (!scope) return { present: false, hits: [], reason: 'root-missing' }
    const hits = []
    const byTestid = scope.querySelector('[data-testid="series-kind-select"]')
    if (byTestid) hits.push('select[data-testid=series-kind-select]')
    for (const sel of scope.querySelectorAll('select')) {
      const vals = [...sel.querySelectorAll('option')].map((o) => String(o.value))
      if (vals.includes('collection') || vals.includes('album')) {
        hits.push(`select(options=${vals.join('|')})`)
      }
    }
    for (const r of scope.querySelectorAll('input[type="radio"]')) {
      if (String(r.name) === 'series-kind') hits.push('radio[name=series-kind]')
    }
    return { present: hits.length > 0, hits, reason: 'ok' }
  }, rootSelector)
}

/** 从剧集墙打开「新建剧集」弹窗（`media-new-series` 入口）。 */
async function openCreateDialog(page) {
  const ok = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-new-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!ok) throw new Error('media-new-series 入口不存在（新建剧集弹窗打不开）')
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="series-create-dialog"]'),
    { timeout: 10000 },
  )
  await delay(300)
}

/** 关闭「新建剧集」弹窗（点组件内硬编码的「取消」按钮，绝不真的创建）。 */
async function closeCreateDialog(page) {
  await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="series-create-dialog"]')
    const btn =
      dlg &&
      [...dlg.querySelectorAll('button')].find(
        (b) => String(b.textContent || '').trim() === '取消',
      )
    if (btn) btn.click()
  })
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="series-create-dialog"]'), {
      timeout: 10000,
    })
    .catch(() => undefined)
  await delay(300)
}

/** 关闭编辑面板（点遮罩层 —— 面板容器的父节点，点击即 onClose）。 */
async function closeSeriesEditPanel(page) {
  await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="series-edit-panel"]')
    const backdrop = panel && panel.parentElement
    if (backdrop) backdrop.click()
  })
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="series-edit-panel"]'), {
      timeout: 10000,
    })
    .catch(() => undefined)
  await delay(300)
}

/** 在真实 DOM 输入框上设年份（同样走原生 setter + input 事件，见 setKindSelect 的说明）。 */
async function setYearInput(page, value) {
  const ok = await page.evaluate((v) => {
    const input = document.querySelector('[data-testid="series-year-input"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value === v
  }, String(value))
  if (!ok) throw new Error(`series-year-input 未能设为 ${value}`)
  await delay(150)
}

/** 读年份输入框当前值（空串 = 界面上是空的）。 */
function readYearInput(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="series-year-input"]')
    return input ? String(input.value) : null
  })
}

async function clickSeriesSave(page) {
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="series-save"]')
    if (b) b.click()
  })
  // 面板保存后应关闭
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="series-edit-panel"]'), {
      timeout: 15000,
    })
    .catch(() => undefined)
  await delay(800)
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
  console.log(`[bug258] shot ${name} -> ${file} (${size} bytes)`)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  console.log(`[bug258] app=${APP_URL} daemon=${DAEMON} shots=${SHOTS}`)

  let envInfo = await resolveTgBase()
  if (!envInfo || !envInfo.tgRunning) {
    startDevServices()
    envInfo = await waitForEnv()
  }
  if (!envInfo || !envInfo.base || !envInfo.tgRunning) {
    console.error(`[bug258] 环境未就绪：${JSON.stringify(envInfo)}`)
    process.exit(1)
  }
  const TG = envInfo.base
  console.log(`[bug258] orig-tg = ${TG}（取自 daemon tg_port 真源）`)

  // ── 前置 P：真实库必须存在「有分集」的剧集，否则结论只在夹具上成立 ──
  const lib = await httpJson('GET', `${TG}/api/media/series`)
  const allSeries = lib.json && Array.isArray(lib.json.items) ? lib.json.items : []
  const withEpisodes = allSeries.filter((s) => (s.episodeCount || 0) > 0)
  const kindDist = allSeries.reduce((acc, s) => {
    const k = typeof s.kind === 'string' ? s.kind : '(null)'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})
  console.log(
    `[bug258] 全库剧集=${allSeries.length} 有分集=${withEpisodes.length} kind 分布=${JSON.stringify(kindDist)}`,
  )
  console.log(
    `[bug258] 有分集样本(前3)=${JSON.stringify(withEpisodes.slice(0, 3).map((s) => ({ id: s.id, kind: s.kind, eps: s.episodeCount })))}`,
  )
  check(
    'P: 真实库中存在「有分集」的剧集（前置非空证明）',
    withEpisodes.length > 0,
    `series=${allSeries.length} withEpisodes=${withEpisodes.length} kindDist=${JSON.stringify(kindDist)}`,
    'P',
  )

  const created = { series: [], items: [] }
  let browser = null
  let pageRef = null
  let staleEngine = false
  try {
    const fx = await makeFixture(TG)
    created.series.push(fx.seriesId)
    created.items.push(fx.itemId)
    console.log(`[bug258] fixture: ${JSON.stringify(fx)}`)

    // ── G 段：活体门 —— 引擎是否**真的**包含本次修复？ ──
    // 探针只打**夹具**剧集：修复前的引擎对任意 kind 都照单全收，打到真实 id 会污染用户库。
    const gate = await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, {
      kind: '__bug258_probe__',
    })
    const gateAfter = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    const gateKind = gateAfter.json ? gateAfter.json.kind : null
    const engineHasFix = gate.status === 422 && gateKind === 'series'
    console.log(
      `[bug258] GATE: PATCH kind=__bug258_probe__ -> ${gate.status}; 列值=${JSON.stringify(gateKind)}; ` +
        `engineHasFix=${engineHasFix}`,
    )
    // 无论探针结果如何，都把夹具的类型恢复成合法值（修复前的引擎已经写进去了）。
    await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, { kind: 'series' })
    if (!engineHasFix) {
      staleEngine = true
      check(
        'G: 运行的 orig-tg **包含** BUG-258 修复（422 + 列值未变）',
        false,
        `PATCH 脏 kind 返回 ${gate.status}（期望 422），列值=${JSON.stringify(gateKind)}` +
          '  ← 引擎二进制比工作树旧：A2/B1b/B3 的 FAIL 是「未重建」，不是「修复无效」。' +
          ' 请重建并重启 orig-tg 后重跑（cargo build --release -p orig-tg -p orig-daemon）',
        'G',
      )
    } else {
      check('G: 运行的 orig-tg **包含** BUG-258 修复（422 + 列值未变）', true, `status=${gate.status}`, 'G')
    }

    browser = await cdp.launch()
    const page = await browser.newPage()
    pageRef = page
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2500 })

    // ═════════ A 段：类型选择控件已移除（UI 收敛）+ 数据层持久性（API 层） ═════════
    await navToSeriesWall(page)
    await page.waitForFunction(
      (sid) => !!document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`),
      { timeout: 25000, args: [fx.seriesId] },
    )
    await openSeriesDetail(page, fx.seriesId)
    await openSeriesEditPanel(page)

    // A1：编辑面板里**不存在**任何类型选择控件（裁定：不渲染，不是禁用；无隐藏编辑通道）
    const panelKind = await findSeriesKindControls(page, '[data-testid="series-edit-panel"]')
    await shot(page, '01-series-edit-panel-no-kind-select.png')
    check(
      'A1: 编辑面板**不再存在**任何类型选择控件（series-kind-select / 类型 select / kind radio）',
      panelKind.reason === 'ok' && panelKind.present === false,
      `hits=${JSON.stringify(panelKind.hits)}` +
        (panelKind.present ? '  ← 类型选择控件还在 = 裁定未落实' : ''),
      'A1',
    )
    await closeSeriesEditPanel(page)

    // A1b：新建弹窗同样不得有任何类型选择控件（此前是 KIND_OPTIONS 三选一 radio）
    await openCreateDialog(page)
    const dlgKind = await findSeriesKindControls(page, '[data-testid="series-create-dialog"]')
    await shot(page, '02-series-create-dialog-no-kind-controls.png')
    check(
      'A1b: 新建剧集弹窗**不存在**任何类型选择控件（创建恒定 kind=series）',
      dlgKind.reason === 'ok' && dlgKind.present === false,
      `hits=${JSON.stringify(dlgKind.hits)}` +
        (dlgKind.reason === 'root-missing' ? '  ← 弹窗容器未找到（检查 testid）' : ''),
      'A1b',
    )
    await closeCreateDialog(page)

    // A2：数据层持久性 —— UI 已无类型入口，改走 **API 层**：
    //     PATCH kind=album（合法枚举值，探针性质）→ 重启 orig-tg → 仍 album。
    let patchOk = false
    let patchStatus = null
    let kindAfterPatch = null
    if (!SKIP_RESTART) {
      const patched = await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, {
        kind: TARGET_KIND,
      })
      patchStatus = patched.status
      const afterPatch = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
      kindAfterPatch = afterPatch.json ? afterPatch.json.kind : null
      patchOk = patched.status === 200 && kindAfterPatch === TARGET_KIND
      console.log('[bug258] restarting orig-tg via daemon POST /api/tg/restart ...')
      const restartRes = await httpJson('POST', `${DAEMON}/api/tg/restart`, {})
      console.log(
        `[bug258] restart responded: status=${restartRes.status} body=${JSON.stringify(restartRes.json)}`,
      )
      const ready = await waitForTgReady(TG)
      if (!ready.ok) {
        check(
          'A2: 重启后 orig-tg 恢复服务',
          false,
          `服务未在超时内恢复：${JSON.stringify(ready.last)}`,
          'A2',
        )
        throw new Error('orig-tg 重启后未恢复，后续判据无意义')
      }
      // 多等一会儿：migrate() 在 Store::open 里跑，读数必须晚于它完成。
      await delay(1500)

      const afterRestart = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
      const kindAfterRestart = afterRestart.json ? afterRestart.json.kind : null
      check(
        'A2: **API 写入 album 并重启 orig-tg 后**仍是 album（数据层持久性）',
        patchOk && kindAfterRestart === TARGET_KIND,
        `patchStatus=${patchStatus} afterPatch=${JSON.stringify(kindAfterPatch)} ` +
          `afterRestart=${JSON.stringify(kindAfterRestart)} tgReady=true` +
          (kindAfterRestart === 'series' && patchOk
            ? '  ← 被 migrate() 打回 series = 缺陷原形'
            : '') +
          (staleEngine ? '  （注意：引擎未重建，此 FAIL 不可归因于代码）' : ''),
        'A2',
      )
    } else {
      check(
        'A2: **API 写入 album 并重启 orig-tg 后**仍是 album（数据层持久性）',
        false,
        'SKIP: BUG258_SKIP_RESTART=1 —— 重启段被显式跳过。**未验证**，不得据此声称判据 1 成立。',
        'A2',
      )
    }

    // A3：夹具复位 —— PATCH kind=series（唯一合法业务值）并确认写回成功。
    //     与 A2 合起来证明写路径双向可逆，且脚本不把探针值留在用户库里。
    const reset = await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, {
      kind: 'series',
    })
    const afterReset = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    check(
      'A3: 夹具 kind 已复位回 series（PATCH 写回路径双向可逆）',
      reset.status === 200 && afterReset.json && afterReset.json.kind === 'series',
      `resetStatus=${reset.status} kind=${JSON.stringify(afterReset.json && afterReset.json.kind)}` +
        (staleEngine && reset.status !== 200 ? '  （引擎未重建：不可归因于代码）' : ''),
      'A3',
    )

    // ═════════ B 段：年份三态（重启可能发生过，回到真实 UI 重新导航） ═════════
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2500 })
    await navToSeriesWall(page)
    await page.waitForFunction(
      (sid) => !!document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`),
      { timeout: 25000, args: [fx.seriesId] },
    )
    await openSeriesDetail(page, fx.seriesId)
    await openSeriesEditPanel(page)

    // B1-a：先设年份
    await setYearInput(page, TEST_YEAR)
    await clickSeriesSave(page)
    const y1 = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    check(
      'B1a: 真实 UI 设年份并保存后读回该值',
      y1.json && y1.json.year === TEST_YEAR,
      `year=${JSON.stringify(y1.json && y1.json.year)} expected=${TEST_YEAR}`,
      'B1a',
    )

    // B1-b：**清空**年份框再保存 → 必须真的清成 NULL（BUG-258 判据 3）
    await openSeriesEditPanel(page)
    const yearBoxBefore = await readYearInput(page)
    await setYearInput(page, '')
    const yearBoxAfter = await readYearInput(page)
    await shot(page, '03-year-cleared-in-panel.png')
    await clickSeriesSave(page)
    const y2 = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    const clearedOk = y2.json && y2.json.year === null
    check(
      'B1b: 清空年份框 + 保存 → year 变 NULL（BUG-258 判据 3）',
      clearedOk,
      `inputBefore=${JSON.stringify(yearBoxBefore)} inputAfter=${JSON.stringify(yearBoxAfter)} ` +
        `apiYear=${JSON.stringify(y2.json && y2.json.year)}` +
        (clearedOk
          ? ''
          : staleEngine
            ? '  （引擎未重建：修复前的 year 是单态，null 被当成「不改」—— 不可归因于代码）'
            : '  ← 仍是原值 = year: null 被当成「不改」'),
      'B1b',
    )

    // B2（判据 4 负控）：**没碰过**年份框时只改标题，年份不得被误清/误写。
    //     先把年份设回去，再只改标题保存。
    await openSeriesEditPanel(page)
    await setYearInput(page, TEST_YEAR)
    await clickSeriesSave(page)
    await openSeriesEditPanel(page)
    // 关键：**不触碰** series-year-input，只改标题
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="series-title-input"]')
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, `${input.value}·T`)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await delay(200)
    await clickSeriesSave(page)
    const y3 = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    check(
      'B2: 未触碰年份框、只改标题 → 年份保持原值（判据 4 负控）',
      y3.json && y3.json.year === TEST_YEAR,
      `year=${JSON.stringify(y3.json && y3.json.year)} expected=${TEST_YEAR} title=${JSON.stringify(y3.json && y3.json.title)}`,
      'B2',
    )

    // B3：422 契约 —— 非法类型枚举不得进列（活体门已用同一探针验过，这里复核夹具已复位）
    // 「未被改动」必须与 **PATCH 前实测到的那个值** 逐字比对，不能硬编码 'series'：
    // A2/A3 对夹具做过 album↔series 的往返写入，硬编码会假失败。
    const beforeGarbage = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    const kindBefore = beforeGarbage.json && beforeGarbage.json.kind
    const garbage = await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, {
      kind: 'garbage',
    })
    const afterGarbage = await httpJson('GET', `${TG}/api/media/series/${fx.seriesId}`)
    const b3ok =
      garbage.status === 422 &&
      typeof kindBefore === 'string' &&
      afterGarbage.json &&
      afterGarbage.json.kind === kindBefore
    // 无论成败都复位夹具类型（修复前的引擎已经把脏值写进去了）。
    await httpJson('PATCH', `${TG}/api/media/series/${fx.seriesId}`, { kind: 'series' })
    check(
      'B3: PATCH {"kind":"garbage"} → 422 且列值未被改动',
      b3ok,
      `status=${garbage.status} body=${JSON.stringify(garbage.json)} kindBefore=${JSON.stringify(kindBefore)} kindAfter=${JSON.stringify(afterGarbage.json && afterGarbage.json.kind)}` +
        (b3ok ? '' : staleEngine ? '  （引擎未重建：修复前无枚举校验 —— 不可归因于代码）' : ''),
      'B3',
    )

    // ═════════ C 段：内容弹窗的类型是本地化 + 只读 ═════════
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 2500 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (el) el.click()
    })
    await delay(1500)
    // 切到「内容」分类。左栏 testid 是 `media-cat-<tab>`（`MediaLibraryPanel`
    // 的 `media.contentAll` 分组），**不是** `media-rail-items-all`（不存在）。
    const catOk = await page.evaluate(() => {
      // M0（BUG-298）：media-cat-* 系列已废止，items 视图入口是侧栏 nav-child-cat-video。
      const el = document.querySelector('[data-testid="nav-child-cat-video"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!catOk) throw new Error('左栏内容分类入口（media-cat-*）不存在')
    await delay(1200)
    await page
      .waitForFunction(
        (iid) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${iid}"]`),
        { timeout: 25000, args: [fx.itemId] },
      )
      .catch(() => undefined)
    // 内容卡的编辑入口 `item-edit` 在 hover 层里，直接点 DOM 节点
    const opened = await page.evaluate((iid) => {
      const root = document.querySelector(`[data-testid="media-card"][data-item-id="${iid}"]`)
      const btn = root && root.querySelector('[data-testid="item-edit"]')
      if (!btn) return false
      btn.click()
      return true
    }, fx.itemId)
    if (!opened) {
      check('C1: 内容编辑弹窗可打开（item-edit 入口）', false, `未找到 media-card[data-item-id=${fx.itemId}] 内的 item-edit`, 'C1')
    } else {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="item-edit-dialog"]'), {
        timeout: 15000,
      })
      await delay(400)
      const kindRow = await page.evaluate(() => {
        const sel = document.querySelector('[data-testid="item-edit-kind"]')
        if (!sel) return null
        return {
          text: String(sel.textContent || '').trim(),
          value: String(sel.value || ''),
          disabled: sel.disabled === true,
          title: String(
            (sel.closest('label') && sel.closest('label').getAttribute('title')) || '',
          ),
        }
      })
      await shot(page, '04-item-edit-kind-readonly.png')
      const localized =
        kindRow != null &&
        /视频|图片|音频|文档|Video|Photo|Audio|Document/.test(kindRow.text) &&
        !/^(video|photo|audio|file)$/i.test(kindRow.text)
      check(
        'C1a: 内容弹窗的类型是本地化文案（不出现裸 video/photo/audio/file）',
        localized,
        `row=${JSON.stringify(kindRow)}`,
        'C1a',
      )
      check(
        'C1b: 内容弹窗的类型控件 visibly read-only（disabled === true）',
        kindRow != null && kindRow.disabled === true,
        `disabled=${kindRow && kindRow.disabled} title=${JSON.stringify(kindRow && kindRow.title)}` +
          (kindRow && !kindRow.disabled ? '  ← 可编辑外观 = BUG-148 违反' : ''),
        'C1b',
      )
      // 收尾：取消，绝不真的保存任何东西
      await page.evaluate(() => {
        const dlg = document.querySelector('[data-testid="item-edit-dialog"]')
        const btn = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消')
        if (btn) btn.click()
      })
      await delay(300)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug258] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[bug258] === SUMMARY ===')
    console.log(`[bug258] shots: ${SHOTS}`)
    console.log(
      `[bug258] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`,
    )
    if (failed.length) console.log('[bug258] FAILED:', failed.map((c) => `${c.id}:${c.name}`).join(' | '))
    if (failed.length) {
      // 引擎未重建 ⇒ 判据失败**不可归因于代码**。这是环境问题（exit 1）而不是
      // 修复无效（exit 2）：两者混同会让「代码没写对」与「二进制没更新」无法分辨。
      process.exitCode = staleEngine ? 1 : 2
      if (staleEngine) {
        console.log(
          '[bug258] VERDICT: BLOCKED —— 运行的 orig-tg 是**修复前**的二进制，本次判据无法归因。',
        )
      }
    }
  } finally {
    if (browser) await browser.close()
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
      `[bug258] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`,
    )
  }
}

main().catch((e) => {
  console.error('[bug258] ERROR', (e && e.message) || e)
  process.exit(1)
})
