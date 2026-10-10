#!/usr/bin/env node
'use strict'

/**
 * 引擎「重启结算」探针 —— 一条命令证明**引擎侧改动**是否都已随重启落地。
 *
 * ## 它回答的问题
 *
 * 本轮（BUG-234 / 243 / 249 / 250）的修复都已提交，但**运行中的进程**是重建之前的
 * 旧二进制（daemon PID 起于重启前、orig-tg 同理）。用户把 daemon + orig-tg 重启后，
 * 需要一条命令确认「新代码真的在跑」，而不是靠翻提交记录或逐条手点。
 *
 * 本脚本对**当前在跑**的服务发若干**只读**探测（唯一的写是一条幂等回写，见下），
 * 逐条断言「具体值」：
 *
 *   - 重启前：这些端点/字段都还不存在 ⇒ 全红（旧引擎不具备任一新判据）；
 *   - 重启后：全绿。
 * 这两次运行就是「新增断言必须验牙」的现成证据。
 *
 * ## 覆盖清单（每条都断言具体值，禁止「非空即通过」这类无牙断言）
 *
 *   1. **BUG-234** `PUT /api/config/download` 不再 404（旧 daemon 404）。
 *   2. **BUG-243** `GET /api/config` 含 `logs.{dir,orig_tg,errors}`（旧 daemon 无此字段）。
 *   3. **BUG-250**（引擎侧）`GET /api/media/series` **每一条**都含
 *      `videoCount`/`photoCount`/`coverHasBytes` 且非 null（旧引擎整条字段都不存在）。
 *   4. **BUG-249** `POST /api/cache/tasks/retry`（不带 ids）与
 *      `POST /api/cache/tasks/cancel`（不带 ids）都返回 **422**
 *      （旧引擎被 `:id` 段吃掉 → 405）。
 *
 * ## 不在本脚本里
 *
 *   - **BUG-248**：运行时判据需要**真入队**一条消息才能判「排队期间条目是否已登记」，
 *     故单独走隔离 A/B 脚本 ——
 *     **`tauri-shell/verify/verify_bug_248_enqueue_item_live.cjs`**（需授权会话 + 两个二进制）。
 *     重启结算只做只读探测，不在此覆盖。
 *
 * ## 只读优先（硬性）
 *
 * 除第 1 条外，**不发任何会改状态 / 改数据**的请求：全部是 GET，或「发不出去的」
 * 空参 POST（旧引擎 405 / 新引擎 422，都不会落到 handler 主体改动任务）。每条请求的
 * 注释都标了「是否改写状态」。第 1 条的 PUT 是**幂等回写**：先 `GET /api/config` 取
 * 当前 `download_dir`，再把它**原样写回**（当前为空则写空串 = 清除回退默认，仍是当前态），
 * 所以不改动用户设置；且在旧 daemon 上该 PUT 直接 404，连写都不会发生。
 *
 * ## 出口
 *
 *   全部 PASS → exit 0；任一 FAIL → exit 1，并逐条打印「判据 / 期望 / 实测」三列
 *   （实测一律是原始值：HTTP 状态码、字段名与值、JSON 片段）。
 *
 * ## 用法（不依赖任何机器绝对路径；base url 从 env 读）
 *
 *   node download-engine/verify/verify_engine_restart_settlement.cjs
 *   ORIG_TG_BASE=http://127.0.0.1:19787 ORIG_DAEMON_BASE=http://127.0.0.1:19786 \
 *     node download-engine/verify/verify_engine_restart_settlement.cjs
 *
 *   ⚠️ 不设 ORIG_TG_BASE 时**从 daemon /api/config 的 tg_port 运行时解析**（不再写死
 *   19788 —— 端口由 `python scripts/dev_services.py` 下发，写死会让 orig-tg 侧判据
 *   全部打到空端口、报 `HTTP null`，被误读成「修复未随重启生效」）。
 */

// ---- base url：env 优先；orig-tg 端口运行时解析，绝不写死 ----
const stripSlash = (s) => String(s || '').replace(/\/+$/, '')
// orig-daemon（配置面：/api/config、/api/config/download）；引擎默认端口 19786。
const ORIG_DAEMON_BASE = stripSlash(process.env.ORIG_DAEMON_BASE || 'http://127.0.0.1:19786')
// orig-tg 引擎（媒体库、缓存任务面）：env 优先，否则读 daemon /api/config 的 tg_port。
let ORIG_TG_BASE = stripSlash(process.env.ORIG_TG_BASE || '')

/** 从 daemon /api/config 解析真实 tg_port 并回填 ORIG_TG_BASE。解析不到则保留原值。 */
async function resolveTgBase() {
  if (ORIG_TG_BASE) return ORIG_TG_BASE
  try {
    const r = await req('GET', `${ORIG_DAEMON_BASE}/api/config`)
    const port = r && r.json && (r.json.tg_port || r.json.tgPort)
    if (port) {
      ORIG_TG_BASE = `http://127.0.0.1:${port}`
      console.log(`${C.dim}  [resolve] tg_port=${port} → ${ORIG_TG_BASE}${C.reset}`)
    }
  } catch (_) {
    /* 解析失败不致命：下面的判据会各自报 HTTP null */
  }
  if (!ORIG_TG_BASE) ORIG_TG_BASE = 'http://127.0.0.1:19787'
  return ORIG_TG_BASE
}

const TIMEOUT_MS = Number(process.env.ORIG_VERIFY_TIMEOUT_MS || 8000)

const C = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
const results = []

/**
 * 一条 HTTP 请求。返回 { status, bodyText, json, error }。
 * status=null 表示连接层失败（服务没在跑 / 拒绝连接），error 里带原因。
 */
async function req(method, url, body) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const init = { method, signal: ctrl.signal, headers: {} }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  try {
    const res = await fetch(url, init)
    const bodyText = await res.text()
    let json = null
    try { json = JSON.parse(bodyText) } catch { /* 非 JSON（如 404 空体）保持 null */ }
    return { status: res.status, bodyText, json, error: null }
  } catch (e) {
    return { status: null, bodyText: '', json: null, error: String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(t)
  }
}

const snip = (s, n) => String(s == null ? '' : s).slice(0, n)

/**
 * 记一条判据并打印「判据 / 期望 / 实测」三列。
 * actual 必须是**原始值**（状态码 / 字段值 / JSON 片段），不接受「非空」这类转述。
 */
function check(id, criterion, expected, actual, pass) {
  results.push({ id, criterion, expected, actual, pass: !!pass })
  const tag = pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`
  console.log(`${C.bold}[${tag}${C.bold}] ${id} — ${criterion}${C.reset}`)
  console.log(`        期望: ${expected}`)
  console.log(`        实测: ${actual}`)
}

/** BUG-234 —— PUT /api/config/download 不再 404（幂等回写）。 */
async function checkBug234() {
  // ① 读当前值（只读，不改状态）。
  const before = await req('GET', `${ORIG_DAEMON_BASE}/api/config`)
  if (before.status !== 200) {
    check('BUG-234', `PUT /api/config/download 可用（先决：GET /api/config 可达）`,
      `GET ${ORIG_DAEMON_BASE}/api/config → HTTP 200`,
      `HTTP ${before.status}${before.error ? ' (' + before.error + ')' : ''} body=${snip(before.bodyText, 120)}`,
      false)
    return
  }
  const cur = Object.prototype.hasOwnProperty.call(before.json || {}, 'download_dir')
    ? before.json.download_dir : null
  // ② 幂等回写：把当前生效值原样写回。当前为空 ⇒ 写空串（= 清除回退系统默认，等于当前态）。
  //    —— 这样即便重启后新端点真的落盘，写的也是用户原本的值，不改变任何设置。
  //    （是否改写状态：**幂等写**，写回同一值；旧 daemon 上直接 404，连写都不发生。）
  const dirToWrite = (typeof cur === 'string') ? cur : ''
  const put = await req('PUT', `${ORIG_DAEMON_BASE}/api/config/download`, { dir: dirToWrite })

  check('BUG-234', `PUT /api/config/download 不再 404（旧 daemon 404 ⇒ 修复不可达）`,
    'HTTP 200',
    `HTTP ${put.status}${put.error ? ' (' + put.error + ')' : ''} body=${snip(put.bodyText, 120)} wrote dir=${JSON.stringify(dirToWrite)}`,
    put.status === 200)

  // ③ 回读确认写入确实生效（round-trip）：写空串 ⇒ 读回 null；写路径 ⇒ 读回同一路径。
  const after = await req('GET', `${ORIG_DAEMON_BASE}/api/config`)
  const afterVal = after.status === 200 && after.json
    ? (Object.prototype.hasOwnProperty.call(after.json, 'download_dir') ? after.json.download_dir : undefined)
    : undefined
  const wantAfter = dirToWrite === '' ? null : dirToWrite
  // 注意「假绿」陷阱：PUT 未成功（如旧 daemon 404）时，回读仍等于「没写过的当前值」，
  // 看似一致 —— 但那是**什么都没写**，不能算「写入生效」。故必须 PUT 成功才判 PASS。
  check('BUG-234', `幂等回写后回读一致（download_dir 往返，且 PUT 确实成功）`,
    `PUT 200 且 download_dir === ${JSON.stringify(wantAfter)}`,
    `PUT HTTP ${put.status}; download_dir === ${JSON.stringify(afterVal)} (GET HTTP ${after.status})`,
    put.status === 200 && after.status === 200 && afterVal === wantAfter)
}

/** BUG-243 —— GET /api/config 含 logs.{dir,orig_tg,errors}（绝对路径字符串）。 */
async function checkBug243() {
  const got = await req('GET', `${ORIG_DAEMON_BASE}/api/config`)
  const cfg = got.status === 200 ? got.json : null
  const hasLogs = !!cfg && Object.prototype.hasOwnProperty.call(cfg, 'logs') && cfg.logs !== null
  check('BUG-243', `GET /api/config 含 logs 字段（旧 daemon 无此键）`,
    'config.logs 为用户对象，非 null',
    `HTTP ${got.status}; logs=${hasLogs ? 'object' : JSON.stringify(cfg ? cfg.logs : undefined)}; topKeys=[${cfg ? Object.keys(cfg).join(',') : ''}]`,
    hasLogs && typeof cfg.logs === 'object')

  const l = hasLogs ? cfg.logs : null
  const subOk = !!l && ['dir', 'orig_tg', 'errors'].every((k) => typeof l[k] === 'string' && l[k].length > 0)
  check('BUG-243', `logs 三项 dir/orig_tg/errors 均为非空字符串（绝对路径）`,
    '{dir:str, orig_tg:str, errors:str} 皆非空',
    `logs=${JSON.stringify(l)}`,
    subOk)

  // 断言三者是**同一日志目录**下的文件（BUG-243 契约：目录与文件同源）。
  const sameDir = !!l && typeof l.dir === 'string' && typeof l.orig_tg === 'string' &&
    typeof l.errors === 'string' && l.orig_tg.startsWith(l.dir) && l.errors.startsWith(l.dir)
  check('BUG-243', `orig_tg / errors 都位于 logs.dir 之下（同源，前端不拼路径）`,
    'orig_tg.startsWith(dir) && errors.startsWith(dir)',
    l ? `dir=${JSON.stringify(l.dir)} orig_tg=${JSON.stringify(l.orig_tg)} errors=${JSON.stringify(l.errors)}` : 'logs=null',
    sameDir)
}

/** BUG-250（引擎侧）—— /api/media/series 每条都含 videoCount/photoCount/coverHasBytes 且非 null。 */
async function checkBug250() {
  const got = await req('GET', `${ORIG_TG_BASE}/api/media/series`)
  const items = got.status === 200 && got.json && Array.isArray(got.json.items) ? got.json.items : null
  if (!items || items.length === 0) {
    check('BUG-250', `GET /api/media/series 有可判条目（先决：非空）`,
      `items.length > 0`,
      `HTTP ${got.status}; items.length=${items ? items.length : 'n/a'}`,
      false)
    return
  }
  const FIELDS = ['videoCount', 'photoCount', 'coverHasBytes']
  const missing = []
  const nul = []
  for (const it of items) {
    for (const f of FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(it, f)) missing.push(`${it.id}.${f}`)
      else if (it[f] === null) nul.push(`${it.id}.${f}`)
    }
  }
  const allPresent = missing.length === 0
  const allNonNull = nul.length === 0
  const s = items[0]
  const sample = `id=${s.id} videoCount=${JSON.stringify(s.videoCount)} photoCount=${JSON.stringify(s.photoCount)} coverHasBytes=${JSON.stringify(s.coverHasBytes)}`
  check('BUG-250', `**全部** ${items.length} 条 series 都含 videoCount/photoCount/coverHasBytes（不是「至少一条」）`,
    `全部 ${items.length} 条都含三字段`,
    `条目总数=${items.length}; 缺字段=${missing.length}${missing.length ? ' 例:[' + missing.slice(0, 5).join(',') + ']' : ''}; 样本[0]: ${sample}`,
    allPresent)
  // 防「假绿」：字段**缺失**时值为 undefined，若只判「!= null」会误过。故要求既在场又非 null。
  check('BUG-250', `三字段一律在场且非 null（旧引擎整条字段都不存在，会记为缺失）`,
    `present && non-null（${items.length} 条 × 3 字段）`,
    `缺失=${missing.length} null=${nul.length}${(missing.length + nul.length) ? ' 例:[' + [...missing, ...nul].slice(0, 5).join(',') + ']' : ''}; 样本[0]: ${sample}`,
    allPresent && allNonNull)
}

/** BUG-249 —— 批量端点空参 → 422（旧引擎 405）。 */
async function checkBug249() {
  for (const verb of ['retry', 'cancel']) {
    // 空参（不带 ?ids=）：**不改写任何任务状态**——新引擎 422 拒绝，旧引擎 405 不匹配。
    const got = await req('POST', `${ORIG_TG_BASE}/api/cache/tasks/${verb}`)
    check('BUG-249', `POST /api/cache/tasks/${verb}（不带 ids）→ 422（旧引擎被 :id 段吃掉 → 405）`,
      'HTTP 422',
      `HTTP ${got.status} body=${snip(got.bodyText, 160)}`,
      got.status === 422)
  }
}

async function main() {
  console.log(`${C.bold}[verify-engine-restart] 引擎重启结算探针${C.reset}`)
  await resolveTgBase()
  console.log(`${C.dim}  orig-tg   = ${ORIG_TG_BASE}${C.reset}`)
  console.log(`${C.dim}  orig-daemon = ${ORIG_DAEMON_BASE}${C.reset}`)
  console.log(`${C.dim}  说明：BUG-248 的运行时判据在隔离 A/B 脚本 ` +
    `tauri-shell/verify/verify_bug_248_enqueue_item_live.cjs，本脚本不覆盖。${C.reset}\n`)

  await checkBug234()
  await checkBug243()
  await checkBug250()
  await checkBug249()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${C.bold}=== SUMMARY ===${C.reset}`)
  console.log(`  判据 total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
  if (failed.length) {
    console.log(`${C.red}${C.bold}VERDICT: FAIL${C.reset} —— 引擎侧改动尚未随重启落地（下列判据未过）：`)
    for (const f of failed) console.log(`  - ${f.id}: ${f.criterion}`)
    console.log(`  ⇒ 若刚提交了修复：请重启 daemon + orig-tg 后重跑本脚本。`)
    process.exitCode = 1
  } else {
    console.log(`${C.green}${C.bold}VERDICT: PASS${C.reset} —— 引擎侧改动（BUG-234/243/249/250）均已随重启生效。`)
    process.exitCode = 0
  }
}

main().catch((e) => {
  console.error('[verify-engine-restart] aborted:', e && e.stack ? e.stack : String(e))
  if (process.exitCode == null) process.exitCode = 1
})
