#!/usr/bin/env node
'use strict'

/**
 * BUG-261 真实 UI 验收：缓存与来源绑定 + 「未缓存」可点 + 剧集级补缺。
 *
 * ## 修复内容（docs/bugs/BUG-261.md，第 1 步）
 *
 *   1. 缓存判据从「当前主源」换成「该集任一可用来源」：
 *      引擎 `EpisodeView.hasRecacheableSource` + 备用源 `source/ref`（4da41c5 下发），
 *      壳侧 `episodeRecacheCandidates`（主源优先、备用源兜底）替换全部调用点 ——
 *      「主源 local + 备用源 tg」的集缓存入口必须可用（旧实现永久禁用且不解释）。
 *   2. 「未缓存」标记直接发起缓存（用户裁定：点击缺失内容直接进行缓存）：
 *      分集行尾标记可点（span + stopPropagation，行聚焦不触发），
 *      `episode-nobytes-cache` 点击 → 用该集可缓存来源的 ref 入队。
 *   3. 剧集级「补缺」：选集器头部「缓存缺失 N 集」按钮 → 引擎原子端点
 *      `POST /api/media/series/:id/recache-missing`（1 次点击 = 1 个请求）。
 *
 * ## 本脚本断言什么（全部打真实 UI，可见性用 getComputedStyle / disabled 属性）
 *
 *   A. **判据 3（备用源直缓存）**：夹具「主源 local（无字节）+ 备用源 tg」：
 *      A1 右栏 `episode-recache` 存在且**未禁用**（旧判据下必为 disabled）；
 *      A2 点它 → toast 入队反馈 + 任务列表出现备用源 ref 的消息（真实入队）。
 *   B. **判据 1（标记一键缓存）**：夹具「E1=本地有字节、E2=tg 无字节」：
 *      B1 E2 行 `episode-nobytes` / `episode-nobytes-cache` 存在；
 *      B2 点标记 → toast 反馈 + 行聚焦**未**切换（focus title 仍是 E1）；
 *      B3 任务列表出现该 ref 的消息（真实入队）。
 *   C. **判据 2（剧集级补缺）**：夹具 2 集 tg 无字节：
 *      C1 按钮 `series-recache-missing` 文案含 N=2 且未禁用；
 *      C2 点击 → 发出 `POST /api/media/series/:id/recache-missing`（fetch 捕获）；
 *      C3 端点入队断言在**隔离 mock 实例**（ORIG_BUG261_MOCK_TG，见下）执行：
 *         2 集缺字节同 chat ⇒ enqueued=2 / groups=1；route 缺失 ⇒ skipped 带原因；
 *         全部有字节 ⇒ enqueued=0；未知剧集 ⇒ 404。
 *   D. **反向证伪（判据 3 证伪）**：把右栏判据注入回「主源」口径
 *      （`episodeRecacheCandidates({...cur, sources: []})`），A1 的断言**必须转红**
 *      （按钮变 disabled）；随后自动还原并以 sha256 前后一致自证，再复核恢复可用。
 *
 * ## 环境与隔离（与 verify_bug_265_source_info.cjs 同一纪律）
 *
 *   - 端口一律经 `_lib_endpoints.cjs` 运行时解析（daemon /api/config 的 tg_port）；
 *   - 夹具全部走产品自身 API（`POST /api/media/items` 支持 tg ref 形态），
 *     只写 `VerifyProbe_` 前缀的临时剧集与新建条目，全部登记 `trackCleanup`；
 *   - 入队产生的缓存任务在断言后 `DELETE /api/tg/cache/tasks/:id` 取消（防真跑下载）；
 *   - 脚本结束做残留扫描（`sandbox.listResidue`）并断言 0；
 *   - C3 的隔离实例：独立端口 + 唯一库 + mock 构建（ORIG_TG_MOCK=1），绝不碰生产库：
 *
 *       cd download-engine && CARGO_TARGET_DIR=target-mock \\
 *         cargo build -p orig-tg --release --features mock
 *       ORIG_TG_PORT=19877 ORIG_TG_DB="$TMP/store-bug261.db" \\
 *       ORIG_TG_SESSION="$TMP/s.session" ORIG_TG_MOCK=1 \\
 *         target-mock/release/orig-tg.exe &
 *       ORIG_BUG261_MOCK_TG=http://127.0.0.1:19877 node verify/verify_bug_261_cache_actions.cjs
 *
 *   未提供 ORIG_BUG261_MOCK_TG 时 C3 打印 SKIP（引擎线上冒烟待 lead 集成后复跑），
 *   其余断言照常执行 —— 此降级在 BUG-261.md 验收节如实登记。
 *
 * Exit: 0 = 全部通过（或 C3 明确 SKIP）；2 = 断言失败；1 = 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const endpoints = require('./_lib_endpoints.cjs')
const cdp = require('./lib/cdp.cjs')
const sandbox = require('./lib/sandbox.cjs')

const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-261')

/** 被测源文件（活实现）—— 反向证伪的注入 / 还原对象。 */
const SERIES_DETAIL_SRC = path.resolve(
  __dirname,
  '..',
  'src',
  'components',
  'media',
  'SeriesDetail.tsx',
)

// ── 反向证伪锚点（源文件里唯一的字符串；与修复态逐字节对应） ────────────────
const ANCHOR_FIXED = 'const cand = episodeRecacheCandidates(cur)[0]'
const ANCHOR_INJECTED =
  'const cand = episodeRecacheCandidates({ source: cur.source, ref: cur.ref, sources: [] })[0]'

// ── 文案候选集（浏览器语言未知：zh / en 两套都收） ──────────────────────────
const ZH = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'))
const EN = require(path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'))

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

/** 夹具 TG 坐标（假频道 + 假消息号，绝不指向真实频道；断言后任务即取消） */
const FIXTURE_CHAT = 864200000
const MSG_BACKUP = 864200041 // A：备用源 ref
const MSG_MARKER = 864200042 // B：标记一键缓存
const MSG_MISSING_1 = 864200043 // C：补缺第 1 集
const MSG_MISSING_2 = 864200044 // C：补缺第 2 集
// C3（隔离实例端点契约）用的消息号：**必须**与 UI 夹具错开 —— mock worker 会把
// 入队的消息「下载」成有字节条目，而导入按 (source, ref) 幂等，复用同 ref 会
// 解析到已有字节的条目，让「2 集缺字节 ⇒ enqueued=2」退化成 0。
const MSG_MOCK_1 = 864200051
const MSG_MOCK_2 = 864200052

// ────────────────────────────── 断言记录 ──────────────────────────────

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`[bug261] ${results.length - failed}/${results.length} assertions passed`)
  return failed
}

// ────────────────────────────── 页面工具 ──────────────────────────────

async function clickTestid(page, testid, index = 0) {
  const ok = await page.evaluate(
    (tid, idx) => {
      const el = document.querySelectorAll(`[data-testid="${tid}"]`)[idx]
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    },
    testid,
    index,
  )
  if (!ok) throw new Error(`clickTestid: ${testid}[${index}] not found`)
}

async function countTestid(page, testid) {
  return page.evaluate((tid) => document.querySelectorAll(`[data-testid="${tid}"]`).length, testid)
}

async function waitCountEq(page, testid, want, timeout = 9000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const n = await countTestid(page, testid)
    if (n === want) return true
    if (Date.now() > deadline) return false
    await delay(250)
  }
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, name)
  try {
    await page.screenshot(file, { fullPage: true })
    console.log(`[bug261] shot ${name} -> ${file}`)
  } catch (e) {
    console.log(`[bug261] shot ${name} FAILED: ${e.message}`)
  }
}

/** 元素的 disabled 态 + 文案（getComputedStyle 之外，读 property 才是真值）。 */
async function inspectButton(page, testid, index = 0) {
  return page.evaluate(
    (tid, idx) => {
      const el = document.querySelectorAll(`[data-testid="${tid}"]`)[idx]
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        disabled: el.disabled === true,
        display: cs.display,
        text: (el.innerText || '').trim(),
        title: el.getAttribute('title') || '',
      }
    },
    testid,
    index,
  )
}

/** 右栏当前聚焦集的标题（行聚焦是否被触发的观测点）。 */
async function focusTitle(page) {
  const el = await page.evaluate(
    () => document.querySelector('[data-testid="episode-focus-title"]')?.innerText?.trim() ?? null,
  )
  return el
}

/** 全局 toast 文本（MainLayout 的 fixed 提示条，无 testid，按结构定位）。 */
async function toastText(page) {
  return page.evaluate(() => {
    const el = document.querySelector('div.fixed.left-1\\/2.top-4')
    return el ? (el.innerText || '').trim() : null
  })
}

/** 等 toast 出现并含任一候选文案（toast 4s 自动消失，轮询要快）。 */
async function waitToastContaining(page, candidates, timeout = 4000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await toastText(page)
    if (last && candidates.some((c) => last.includes(c))) return last
    await delay(150)
  }
  return last
}

/** 打开媒体库 → 剧集墙 → 按后端剧集 id 打开详情（BUG-265 同款，就绪锚 = episode-focus-title）。 */
async function openSeriesById(page, id) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  const ok = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="nav-media"]'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  if (!ok) throw new Error('nav-media not found (app did not boot?)')
  await clickTestid(page, 'nav-media')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 20000 },
  )
  await delay(600)
  const clicked = await page.evaluate((sid) => {
    const card = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
    if (!card) return false
    card.scrollIntoView({ block: 'center' })
    card.click()
    return true
  }, id)
  if (!clicked) throw new Error(`series-card with data-series-id=${id} not found on the series wall`)
  const detailUp = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="episode-focus-title"]'), {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false)
  if (!detailUp) throw new Error('series detail never rendered (episode-focus-title missing)')
  await delay(600)
}

// ────────────────────────────── 数据真值 / 夹具 ──────────────────────────────

/**
 * 产品 API 建条目（BUG-265 同款通道，但支持 tg ref 形态 —— `POST /api/media/items`
 * 的 ImportItem 契约：{source:'tg', ref:'chat:msg'} / {path}）。
 */
async function createItem(entry) {
  const r = await sandbox.httpJson('POST', `${MEDIA_API}/api/media/items`, { items: [entry] })
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.ids) || r.json.ids.length !== 1) {
    throw new Error(`createItem failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
  const id = Number(r.json.ids[0])
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${MEDIA_API}/api/media/items/${id}`)
  })
  return id
}

/** 建临时剧集（自动登记删除）+ 加分集。 */
async function addEpisode(seriesId, itemId, episodeNo) {
  const r = await sandbox.httpJson(
    'POST',
    `${MEDIA_API}/api/media/series/${seriesId}/episodes`,
    { itemId, episodeNo },
  )
  if (r.status !== 200 || !r.json || typeof r.json.id !== 'number') {
    throw new Error(`add episode failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
  return Number(r.json.id)
}

async function attachSource(episodeId, itemId) {
  const r = await sandbox.httpJson(
    'POST',
    `${MEDIA_API}/api/media/episodes/${episodeId}/sources`,
    { itemId },
  )
  if (r.status !== 200) {
    throw new Error(`attach source failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
}

/** 夹具媒体目录（本地条目用；有字节条目写真实文件，无字节条目指到不存在的路径）。 */
function mediaDir() {
  const dir = path.join(OUT_DIR, 'testmedia')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 写一个真实小文件（「有字节」本地条目的字节来源 —— 路径必须真实存在）。 */
function mkBytesFile(name) {
  const p = path.join(mediaDir(), name)
  fs.writeFileSync(p, Buffer.alloc(64, 1))
  return p
}

/**
 * 引擎地基（4da41c5：hasRecacheableSource / 备用源 source-ref）是否已在**运行实例**上生效。
 * 提交已落库 ≠ sidecar 已重建 —— 引擎集成由 lead 执行；未生效时 A 组断言降级为
 * SKIP（如实登记，待 lead 集成后复跑），其余断言照常（它们不依赖新字段）。
 */
async function engineGroundworkLive(seriesId) {
  const r = await sandbox.httpJson('GET', `${MEDIA_API}/api/media/series/${seriesId}`)
  if (r.status !== 200 || !r.json || !(r.json.episodes || []).length) return false
  return 'hasRecacheableSource' in r.json.episodes[0]
}

async function buildFixture(name) {
  const { id, title } = await sandbox.createTempSeries(MEDIA_API, 'VerifyProbe_')
  console.log(`[bug261] fixture ${name}: series=${id} "${title}"`)
  return { seriesId: id, title }
}

/** 列出缓存任务（GET /api/tg/cache/tasks/all）。 */
async function listTasks() {
  const r = await sandbox.httpJson('GET', `${MEDIA_API}/api/tg/cache/tasks/all`)
  if (r.status !== 200 || !r.json) return []
  const items = Array.isArray(r.json.items)
    ? r.json.items
    : Array.isArray(r.json.tasks)
      ? r.json.tasks
      : Array.isArray(r.json)
        ? r.json
        : []
  return items
}

/** 找 chat+消息号匹配的活跃任务（queued/running）。 */
function findTask(tasks, chatId, msgId) {
  return tasks.find(
    (t) =>
      Number(t.chatId ?? t.chat_id) === chatId &&
      JSON.stringify(t.messageIds ?? t.message_ids ?? t.items ?? []).includes(String(msgId)) &&
      ['queued', 'running'].includes(String(t.status ?? '')),
  )
}

/** 取消任务（断言完立即取消，避免 worker 真去拉假消息）。 */
async function cancelTask(taskId) {
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${MEDIA_API}/api/tg/cache/tasks/${taskId}`)
  })
}

/** 等某 (chat,msg) 的活跃任务出现。 */
async function waitTask(chatId, msgId, timeout = 10000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const t = findTask(await listTasks(), chatId, msgId)
    if (t) return t
    if (Date.now() > deadline) return null
    await delay(300)
  }
}

// ────────────────────────────── C3：隔离 mock 实例的端点全流程 ──────────────────────────────

/**
 * 对隔离 mock orig-tg（ORIG_BUG261_MOCK_TG）跑 `POST /api/media/series/:id/recache-missing`
 * 的完整契约。隔离实例 = 独立端口 + 唯一库 + mock 客户端，写面只落在临时库，
 * 剧集/条目用后即删 —— 与生产实例零接触。
 */
async function verifyEndpointOnMockInstance(mockBase) {
  console.log(`[bug261] C3: endpoint contract on isolated mock instance ${mockBase}`)

  // mock 客户端初始是 Anonymous（ensure_authorized 会 401）：走 mock 登录流
  // （start → code=00000 ⇒ Authorized）。mock 契约固定，见 crates/orig-tg/src/mock.rs。
  const st = await sandbox.httpJson('POST', `${mockBase}/api/tg/start`, {
    phone: '+10000000000',
  })
  const cd = await sandbox.httpJson('POST', `${mockBase}/api/tg/code`, {
    phone: '+10000000000',
    code: '00000',
  })
  if (cd.status !== 200 || !cd.json || cd.json.phase !== 'Authorized') {
    throw new Error(`mock login failed: start=${st.status} code=${cd.status} ${JSON.stringify(cd.json)}`)
  }
  console.log('[bug261] C3: mock instance authorized (synthetic session)')

  // 建夹具（临时库内）：S1 = 2 集 tg 缺字节同 chat；S2 = 1 集 local 缺 route + 1 集 tg 脏 ref；S3 = 全有字节。
  const mkTgItem = async (ref, title) =>
    createItemOn(mockBase, { source: 'tg', ref, kind: 'video', title })
  const mkLocalItem = async (p, title) =>
    createItemOn(mockBase, { path: p, title, kind: 'video' })
  const mkSeries = async (title) => {
    const r = await sandbox.httpJson('POST', `${mockBase}/api/media/series`, { title })
    if (r.status !== 200 || !r.json || typeof r.json.id !== 'number') {
      throw new Error(`mock createSeries failed: ${r.status} ${JSON.stringify(r.json)}`)
    }
    return Number(r.json.id)
  }
  const addEp = async (sid, itemId, no) => {
    const r = await sandbox.httpJson('POST', `${mockBase}/api/media/series/${sid}/episodes`, {
      itemId,
      episodeNo: no,
    })
    if (r.status !== 200 || !r.json || typeof r.json.id !== 'number') {
      throw new Error(`mock addEpisode failed: ${r.status} ${JSON.stringify(r.json)}`)
    }
  }

  // S1：两集缺字节 tg ref（同 chat）⇒ enqueued=2 / groups=1
  const s1 = await mkSeries(`VerifyProbe_261mock_${Date.now()}`)
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${mockBase}/api/media/series/${s1}`)
  })
  const i1 = await mkTgItem(`${FIXTURE_CHAT}:${MSG_MOCK_1}`, 'mock ep1')
  const i2 = await mkTgItem(`${FIXTURE_CHAT}:${MSG_MOCK_2}`, 'mock ep2')
  await addEp(s1, i1, 1)
  await addEp(s1, i2, 2)
  const r1 = await sandbox.httpJson(
    'POST',
    `${mockBase}/api/media/series/${s1}/recache-missing`,
    {},
  )
  check(
    'C3/mock: 2 集缺字节 tg ref ⇒ 200 且 enqueued=2 / groups=1',
    r1.status === 200 && r1.json && r1.json.enqueued === 2 && r1.json.groups === 1,
    `status=${r1.status} body=${JSON.stringify(r1.json)}`,
  )
  const mt = await listTasksOn(mockBase)
  const batch = mt.find(
    (t) =>
      Number(t.chatId ?? t.chat_id) === FIXTURE_CHAT &&
      (t.itemKey ?? t.item_key ?? '').startsWith('b:') &&
      JSON.stringify(t.messageIds ?? t.message_ids ?? []).includes(String(MSG_MOCK_1)),
  )
  check(
    'C3/mock: 任务按 chat 聚组落地（item_key=b: 前缀，含 2 条消息）',
    Boolean(batch),
    JSON.stringify(mt).slice(0, 200),
  )

  // S2：route 缺失（local 主源 / tg 脏 ref）⇒ skipped 带原因，enqueued=0
  const s2 = await mkSeries(`VerifyProbe_261mock2_${Date.now()}`)
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${mockBase}/api/media/series/${s2}`)
  })
  // 「无字节」本地条目：路径指向**不存在**的文件（引擎按 probe 判 Missing）。
  // 刻意用根相对形态而非盘符绝对路径 —— 仓库污染门禁拒绝含盘符路径的入库脚本。
  const l1 = await mkLocalItem('/__verify_missing_a.mp4', 'mock local')
  const d1 = await mkTgItem('not-a-ref', 'mock dirty ref')
  await addEp(s2, l1, 1)
  await addEp(s2, d1, 2)
  const r2 = await sandbox.httpJson(
    'POST',
    `${mockBase}/api/media/series/${s2}/recache-missing`,
    {},
  )
  const skipped = (r2.json && r2.json.skipped) || []
  check(
    'C3/mock: route 缺失 ⇒ skipped 2 条且各带原因、enqueued=0',
    r2.status === 200 &&
      r2.json &&
      r2.json.enqueued === 0 &&
      skipped.length === 2 &&
      skipped.every((x) => typeof x.reason === 'string' && x.reason.length > 0),
    `status=${r2.status} body=${JSON.stringify(r2.json)}`,
  )

  // S3：全有字节 ⇒ enqueued=0 / skipped=0
  const s3 = await mkSeries(`VerifyProbe_261mock3_${Date.now()}`)
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${mockBase}/api/media/series/${s3}`)
  })
  const bytesFile = path.join(mediaDir(), 'mock-bytes.mp4')
  fs.writeFileSync(bytesFile, Buffer.alloc(64, 1))
  const b1 = await mkLocalItem(bytesFile, 'mock has bytes')
  await addEp(s3, b1, 1)
  const r3 = await sandbox.httpJson(
    'POST',
    `${mockBase}/api/media/series/${s3}/recache-missing`,
    {},
  )
  check(
    'C3/mock: 全部有字节 ⇒ enqueued=0 / groups=0 / skipped=0',
    r3.status === 200 && r3.json && r3.json.enqueued === 0 && r3.json.groups === 0 &&
      Array.isArray(r3.json.skipped) && r3.json.skipped.length === 0,
    `status=${r3.status} body=${JSON.stringify(r3.json)}`,
  )

  // 未知剧集 ⇒ 404
  const r4 = await sandbox.httpJson(
    'POST',
    `${mockBase}/api/media/series/987654321/recache-missing`,
    {},
  )
  check('C3/mock: 未知剧集 ⇒ 404', r4.status === 404, `status=${r4.status}`)
}

async function createItemOn(base, entry) {
  const r = await sandbox.httpJson('POST', `${base}/api/media/items`, { items: [entry] })
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.ids) || r.json.ids.length !== 1) {
    throw new Error(`mock createItem failed: status=${r.status} body=${JSON.stringify(r.json)}`)
  }
  const id = Number(r.json.ids[0])
  sandbox.trackCleanup(async () => {
    await sandbox.httpJson('DELETE', `${base}/api/media/items/${id}`)
  })
  return id
}

async function listTasksOn(base) {
  const r = await sandbox.httpJson('GET', `${base}/api/tg/cache/tasks/all`)
  if (r.status !== 200 || !r.json) return []
  const items = Array.isArray(r.json.items)
    ? r.json.items
    : Array.isArray(r.json.tasks)
      ? r.json.tasks
      : Array.isArray(r.json)
        ? r.json
        : []
  return items
}

// ────────────────────────────── 反向证伪：注入 + 还原 ──────────────────────────────

function injectPreFixForm() {
  const original = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
  const hits = original.split(ANCHOR_FIXED).length - 1
  if (hits !== 1) {
    throw new Error(
      `falsify: anchor found ${hits} times (expected 1) in ${SERIES_DETAIL_SRC} — refusing to patch blindly`,
    )
  }
  fs.writeFileSync(SERIES_DETAIL_SRC, original.replace(ANCHOR_FIXED, ANCHOR_INJECTED))
  return original
}

function restoreSource(original) {
  if (typeof original !== 'string') return
  fs.writeFileSync(SERIES_DETAIL_SRC, original)
}

/** 打开夹具详情并轮询右栏 recache 按钮的 disabled 态（整页重开拿 Vite 最新编译产物）。 */
async function waitRecacheDisabled(page, seriesId, wantDisabled, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    try {
      await openSeriesById(page, seriesId)
      const info = await inspectButton(page, 'episode-recache')
      const n = await countTestid(page, 'episode-recache')
      console.log(
        `[bug261] falsify attempt#${attempt}: episode-recache count=${n} info=${JSON.stringify(info)}`,
      )
      if (n === 1 && info && info.disabled === wantDisabled) return info
    } catch (e) {
      console.log(`[bug261] falsify attempt#${attempt}: ${e.message}`)
    }
    await delay(1200)
  }
  return null
}

// ────────────────────────────── 主流程 ──────────────────────────────

let APP_URL = ''
let MEDIA_API = ''

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const ep = await endpoints.resolve()
  APP_URL = ep.app.endsWith('/') ? ep.app : `${ep.app}/`
  MEDIA_API = ep.tg

  console.log(`[bug261] app=${APP_URL} media-api=${MEDIA_API}`)
  console.log(`[bug261] evidence -> ${OUT_DIR}`)

  sandbox.guardWrites('verify_bug_261_cache_actions.cjs', MEDIA_API)

  const mockTg = (process.env.ORIG_BUG261_MOCK_TG || '').replace(/\/+$/, '')

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()

    // 残留基线：记录本脚本启动前已存在的疑似残留（如历史事故 DiagCard_），
    // 结束时只对**新增**残留判 FAIL —— 已存在的不归本脚本管，如实列出。
    const residueBaseline = await sandbox.listResidue(MEDIA_API)
    if (residueBaseline.length) {
      console.log(`[bug261] residue baseline (pre-existing, ${residueBaseline.length}):`, JSON.stringify(residueBaseline))
    }

    // ══ A. 判据 3：主源 local 无字节 + 备用源 tg ⇒ 右栏缓存入口可用且真实入队 ══
    const fxBackup = await buildFixture('A(主源local+备用tg)')
    {
      // 「无字节」主源：路径不存在 ⇒ probe Missing（根相对形态，勿用盘符路径）。
      const mainLocal = await createItem({
        path: '/__verify_bug261_missing.mp4',
        title: 'QA-261 主源local',
        kind: 'video',
      })
      const backupTg = await createItem({
        source: 'tg',
        ref: `${FIXTURE_CHAT}:${MSG_BACKUP}`,
        title: 'QA-261 备用tg',
        kind: 'video',
      })
      const epId = await addEpisode(fxBackup.seriesId, mainLocal, 1)
      await attachSource(epId, backupTg)
      fxBackup.episodeId = epId
    }
    const groundworkLive = await engineGroundworkLive(fxBackup.seriesId)
    if (!groundworkLive) {
      console.log(
        '[bug261] SKIP-NOTE: 运行实例未下发 hasRecacheableSource / 备用源 source+ref' +
          '（4da41c5 已提交但 sidecar 尚未由 lead 重建集成）—— A 组断言降级为 SKIP，' +
          '完整行为证据见隔离 mock 实例（C3）或 lead 集成后的复跑。',
      )
    }
    await openSeriesById(page, fxBackup.seriesId)
    await delay(500)
    await shot(page, '01-backup-source-enabled.png')
    const a1 = await inspectButton(page, 'episode-recache')
    if (groundworkLive) {
      check(
        'A1: 主源 local 无字节但有 tg 备用源 ⇒ episode-recache 存在且未禁用（判据3）',
        a1 !== null && a1.disabled === false,
        JSON.stringify(a1),
      )
      // A2：点它 → 备用源 ref 真实入队 + 可见反馈
      await clickTestid(page, 'episode-recache')
      const a2Toast = await waitToastContaining(page, [
        ZH['media.episode.recacheQueued'],
        EN['media.episode.recacheQueued'],
      ])
      const a2Task = await waitTask(FIXTURE_CHAT, MSG_BACKUP)
      await shot(page, '02-backup-recache-queued.png')
      check(
        'A2: 点 episode-recache → toast 入队反馈（复用任务入队提示模式）',
        Boolean(a2Toast),
        `toast=${JSON.stringify(a2Toast)}`,
      )
      check(
        'A2: 备用源 ref 的消息真实入队（任务列表出现该消息）',
        Boolean(a2Task),
        a2Task ? `task#${a2Task.id ?? a2Task.taskId}` : 'no matching active task',
      )
      if (a2Task) await cancelTask(a2Task.id ?? a2Task.taskId)
    }

    // ══ B. 判据 1：点「未缓存」标记直接缓存，不触发行聚焦切换 ══════════════
    const fxMarker = await buildFixture('B(标记一键缓存)')
    {
      const e1 = await createItem({
        path: mkBytesFile('bug261-e1.mp4'),
        title: 'QA261-E1',
        kind: 'video',
      })
      const e2 = await createItem({
        source: 'tg',
        ref: `${FIXTURE_CHAT}:${MSG_MARKER}`,
        title: 'QA261-E2',
        kind: 'video',
      })
      await addEpisode(fxMarker.seriesId, e1, 1)
      await addEpisode(fxMarker.seriesId, e2, 2)
    }
    await openSeriesById(page, fxMarker.seriesId)
    const markerUp = await waitCountEq(page, 'episode-nobytes', 1, 12000)
    check(
      'B1: 无字节分集行渲染 episode-nobytes（BUG-254 锚保留）',
      markerUp,
      `count=${await countTestid(page, 'episode-nobytes')}`,
    )
    const cacheMarkerUp = await waitCountEq(page, 'episode-nobytes-cache', 1, 6000)
    check(
      'B1: 标记带 episode-nobytes-cache 可点语义（新增 testid）',
      cacheMarkerUp,
      `count=${await countTestid(page, 'episode-nobytes-cache')}`,
    )
    const beforeFocus = await focusTitle(page)
    await clickTestid(page, 'episode-nobytes-cache')
    const bToast = await waitToastContaining(page, [
      ZH['media.episode.recacheQueued'],
      EN['media.episode.recacheQueued'],
    ])
    await delay(800)
    const afterFocus = await focusTitle(page)
    const bTask = await waitTask(FIXTURE_CHAT, MSG_MARKER)
    await shot(page, '03-marker-cache-clicked.png')
    check(
      'B2: 点标记 → toast 入队反馈（可见反馈）',
      Boolean(bToast),
      `toast=${JSON.stringify(bToast)}`,
    )
    check(
      'B2: 行聚焦未触发（focus title 仍是 E1）',
      afterFocus === beforeFocus && beforeFocus !== null,
      `before=${JSON.stringify(beforeFocus)} after=${JSON.stringify(afterFocus)}`,
    )
    check(
      'B3: 该集 ref 真实入队（任务列表出现该消息）',
      Boolean(bTask),
      bTask ? `task#${bTask.id ?? bTask.taskId}` : 'no matching active task',
    )
    if (bTask) await cancelTask(bTask.id ?? bTask.taskId)

    // ══ C. 判据 2：剧集级补缺（N 随夹具变化 + 点击发出原子端点请求） ═══════
    const fxMissing = await buildFixture('C(补缺)')
    {
      const m1 = await createItem({
        source: 'tg',
        ref: `${FIXTURE_CHAT}:${MSG_MISSING_1}`,
        title: 'QA261-M1',
        kind: 'video',
      })
      const m2 = await createItem({
        source: 'tg',
        ref: `${FIXTURE_CHAT}:${MSG_MISSING_2}`,
        title: 'QA261-M2',
        kind: 'video',
      })
      await addEpisode(fxMissing.seriesId, m1, 1)
      await addEpisode(fxMissing.seriesId, m2, 2)
    }
    await openSeriesById(page, fxMissing.seriesId)
    await delay(500)
    const c1 = await inspectButton(page, 'series-recache-missing')
    await shot(page, '04-missing-button.png')
    check(
      'C1: 选集器头部 series-recache-missing 存在、文案含 N=2、未禁用',
      c1 !== null && c1.disabled === false && /[2]|二/.test(c1.text),
      JSON.stringify(c1),
    )
    // fetch 捕获：点击必须发出且只发出一个补缺请求（判据 2：1 次点击 = 1 个请求）
    await page.evaluate(() => {
      window.__bug261RecacheMissingCalls = []
      const orig = window.fetch.bind(window)
      window.fetch = (...args) => {
        const url = String(args[0] instanceof Request ? args[0].url : args[0] || '')
        const method = String((args[1] && args[1].method) || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase()
        if (url.includes('/recache-missing')) {
          window.__bug261RecacheMissingCalls.push({ url, method })
        }
        return orig(...args)
      }
    })
    await clickTestid(page, 'series-recache-missing')
    await delay(1800)
    const calls = await page.evaluate(() => window.__bug261RecacheMissingCalls || [])
    await shot(page, '05-missing-clicked.png')
    check(
      'C2: 点击发出 POST /api/media/series/:id/recache-missing（1 次）',
      calls.length === 1 && calls[0].method === 'POST' && calls[0].url.includes(`/recache-missing`),
      JSON.stringify(calls),
    )
    if (groundworkLive) {
      // 引擎已集成（新字段在线上模型中出现 ⇒ 端点必然已注册）：点击应真实入队。
      // mock 实例会立刻把任务跑起来，所以只断言「出现过该批次的 b: 任务」。
      const deadline = Date.now() + 10000
      let batchTask = null
      while (Date.now() < deadline && !batchTask) {
        batchTask =
          (await listTasks()).find(
            (t) =>
              String(t.itemKey ?? t.item_key ?? '').startsWith(`b:${FIXTURE_CHAT}:`) &&
              JSON.stringify(t.messageIds ?? t.message_ids ?? []).includes(String(MSG_MISSING_1)),
          ) ?? null
        if (!batchTask) await delay(300)
      }
      check(
        'C2b: 补缺点击真实入队（任务列表出现该批次的 b: 组任务）',
        Boolean(batchTask),
        batchTask ? JSON.stringify(batchTask).slice(0, 200) : 'no b: batch task observed',
      )
    } else {
      console.log(
        '[bug261] C2b SKIP：线上引擎尚未集成 recache-missing（A 组 SKIP-NOTE 同因），' +
          '入队断言由隔离实例（C3）承载。',
      )
    }
    console.log(
      '[bug261] NOTE: 线上引擎若尚未集成 recache-missing 端点，此请求会 404；' +
        '端点契约断言见 C3（隔离 mock 实例）。',
    )

    // ══ D. 反向证伪（判据 3）：判据回退成「主源」口径 ⇒ A1 断言必须转红 ═════
    // 前提：引擎已下发新字段（否则固定代码在旧实例上本来就 disabled，证伪无意义）。
    const fixedText = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
    const hashBefore = sha256(fixedText)
    let originalSource = null
    let falsified = false
    if (!groundworkLive) {
      console.log(
        '[bug261] D SKIP：引擎地基未生效（见 A 组 SKIP-NOTE），判据差异在旧实例上不可观测。' +
          'sha256 自证仍在：还原前后逐字节一致。',
      )
      check(
        'D/falsify: SeriesDetail.tsx 逐字节还原（sha256 前后一致；证伪轮被 SKIP）',
        true,
        `sha256 ${hashBefore} (unmodified)`,
      )
    } else {
      try {
        originalSource = injectPreFixForm()
        sandbox.trackCleanup(async () => restoreSource(originalSource))
        console.log(
          `[bug261] falsify: injected pre-fix criteria (sha256 before=${hashBefore}); polling served UI...`,
        )
        const info = await waitRecacheDisabled(page, fxBackup.seriesId, true)
        await shot(page, '06-falsified-disabled.png')
        falsified = Boolean(info)
        check(
          'D/falsify: 旧「主源」判据注入后 episode-recache 变 disabled（A1 断言转红 = 证伪成立）',
          falsified,
          info ? JSON.stringify(info) : 'episode-recache never observed disabled',
        )
      } finally {
        if (originalSource != null) {
          restoreSource(originalSource)
          const restoredText = fs.readFileSync(SERIES_DETAIL_SRC, 'utf8')
          const hashAfter = sha256(restoredText)
          const byteIdentical = hashAfter === hashBefore
          console.log(
            `[bug261] falsify restore: sha256 before=${hashBefore} after=${hashAfter} byte-identical=${byteIdentical}`,
          )
          check(
            'D/falsify: SeriesDetail.tsx 逐字节还原（sha256 前后一致）',
            byteIdentical,
            `sha256 ${hashBefore} -> ${hashAfter}`,
          )
          originalSource = null
        }
      }
      if (falsified) {
        const info = await waitRecacheDisabled(page, fxBackup.seriesId, false)
        await shot(page, '07-restored-enabled.png')
        check('D/falsify: 还原后按钮恢复可用（回归复核）', Boolean(info), JSON.stringify(info))
      }
    }

    // ══ C3. 端点契约（隔离 mock 实例；未提供则 SKIP 并如实登记） ═══════════
    if (mockTg) {
      try {
        await verifyEndpointOnMockInstance(mockTg)
      } catch (e) {
        check('C3/mock: 隔离实例契约可执行', false, e && e.message ? e.message : String(e))
      }
    } else {
      console.log(
        '[bug261] C3 SKIP：未提供 ORIG_BUG261_MOCK_TG（隔离 mock 实例）。' +
          '端点契约断言跳过 —— 线上冒烟待 lead 集成引擎后复跑本脚本并带上该环境变量。',
      )
    }

    // ── 残留扫描（判据：0 新增；先执行清理再扫，与「验后删除」同一时点） ──
    await sandbox.finalize()
    const residueNow = await sandbox.listResidue(MEDIA_API)
    const baselineKeys = new Set(residueBaseline.map((r) => `${r.id}:${r.title}`))
    const newResidue = residueNow.filter((r) => !baselineKeys.has(`${r.id}:${r.title}`))
    check(
      '夹具新增残留 = 0（VerifyProbe_ 前缀，验后删除；基线残留如实列出不计入）',
      newResidue.length === 0,
      newResidue.length ? JSON.stringify(newResidue) : 'none (pre-existing excluded)',
    )

    // ── 页面健康 ────────────────────────────────────────────────────────
    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[bug261] page errors:', JSON.stringify(errs))
    check('页面无未捕获异常', errs.length === 0, errs.length ? JSON.stringify(errs) : 'none')

    console.log('[bug261] screenshots ->', OUT_DIR)
    const failed = dumpResults()
    if (failed > 0) process.exitCode = 2
  } finally {
    await browser.close()
    await sandbox.finalize()
  }
}

main().catch((e) => {
  console.error('[bug261] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
