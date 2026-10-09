#!/usr/bin/env node
'use strict'

/**
 * BUG-246 运行时真值验收（A/B 隔离实例对照）——「排队中」任务在入队瞬间是否登记消息元数据。
 *
 * ## 它回答的问题
 *
 * BUG-246 的修复（`routes.rs` 的 `ensure_message_rows`，入队处理器与 `IngestCtx::prepare()`
 * 共用同一函数）此前只有**代码层**证据：生产 `orig-tg` 进程跑的是修复前的二进制，
 * 「代码存在」不等于「运行时生效」。本脚本用**两个隔离实例跑同一条真实消息**取运行时真值：
 *
 *   - **A 组（对照 / 修复前）**：`download-engine/target/debug/orig-tg.exe`（旧产物）
 *   - **B 组（实验 / 修复后）**：`download-engine/target/release/orig-tg.exe`（新产物）
 *
 * 两组差异**只有二进制**：同一份数据副本、同一个端口策略之外的同一端口段、同一条目标消息、
 * 同一串 HTTP 调用。判据是**成对/反向**的：
 *
 *   - A 组必须在「title 非空且等于真值 caption」这条判据上 **FAIL**（修复前的病态）；
 *   - B 组必须 **PASS**，且 title 逐字等于 MTProto 给出的 caption 真值（不是「不等于旧值」）。
 * 只有 A FAIL + B PASS 同时成立，才证明「改动是因」。若 A 组意外也 PASS，脚本判定为
 * **矛盾（contradiction）**并如实报出，不粉饰。
 *
 * ## 为什么必须让任务停在 `queued`
 *
 * 缓存 worker 是**全局单飞**（`routes.rs::spawn_cache_task`）：任务一旦被 worker 领取就会
 * 立刻跑 `IngestCtx::prepare()`，而 `prepare()` 同样会补 `media_message` 行。若目标任务直接
 * 开跑，A/B 两组都会拿到标题 —— 对照就失效了（假阴性）。所以本脚本先入队一个**占位任务**
 * 占住 worker，再入队目标消息，使目标任务稳定停在 `queued` —— 这正是生产里 12/12 排队任务
 * 拿不到标题的真实形态。
 *
 * ## 真值（ground truth）从哪来
 *
 * 目标消息的 caption 由 `GET /api/tg/messages/:chat_id`（真实 MTProto 拉取）给出，
 * 在入队**之前**取到并落盘为 `truth`；随后 B 组的 title 与它**逐字比对**（`===`），
 * 不是「非空即可」。A 组不要求等于真值，只要求**拿不到** title。
 *
 * ## 依赖的外部环境（**未经确认不要跑**）
 *
 * 1. Windows + `%APPDATA%/com.origadmin.orighub/tg/` 下有**已授权**的 `session.session` 与
 *    `store.db`（其它平台退到 `$HOME/.local/share/com.origadmin.orighub/tg`）。
 * 2. 两个待测二进制存在：`download-engine/target/{debug,release}/orig-tg.exe`。
 *    **debug 产物是修复前的基线**；若它被重建过，本脚本的对照就失去意义 —— 脚本会把
 *    每个二进制的 md5/大小/mtime 打进证据，请先核对这组数字再信结论。
 * 3. 需要连 Telegram（走 `tg/config.json` 的 socks5 代理）。**会真实连 MTProto、会真实下载
 *    占位任务的媒体字节到临时目录**：本进程与生产 `orig-tg` 共用同一份 auth key，存在被服务端
 *    要求重登的理论风险。脚本一旦在日志里发现重登/验证码/FLOOD/AUTH_KEY_DUPLICATED 迹象
 *    立即自杀并报 BLOCKED。
 * 4. Node >= 22（用到 `node:sqlite`）。零第三方依赖。
 *
 * ## 安全边界
 *
 * - 生产目录**只读**：只从那里 `copyFileSync` 出来，绝不写回。
 * - 两个隔离实例各用 `os.tmpdir()/orig-verify-246/{a,b}` 下的**副本**（session + store.db）。
 * - 下载目录显式指向隔离目录（`dir` 入参优先级高于库里的 `download_dir` 设置），
 *   绝不落到生产下载目录。
 * - 只杀**自己 spawn 的 PID**；任何异常路径都会 `kill` 自己的子进程。
 * - 脚本启动前校验：解析出的 session/db 路径必须在临时工作目录内，且不等于生产路径。
 *
 * ## 判据（本仓铁律：有值 + 具体值，禁 always-green）
 *
 *   1. `truth.caption` 非空（MTProto 真值存在）；
 *   2. A 组：目标任务 `status === 'queued'` 且任务 JSON **无** `title`（或为 null），
 *      且隔离库中该 (chat,message) 行数为 **0**；
 *   3. B 组：目标任务 `status === 'queued'` 且 `title === truth.caption`（逐字），
 *      且隔离库中该 (chat,message) 行数 **>= 1** 且 caption 逐字等于真值。
 *
 * 退出码：`0` = 成对对照成立（修复运行时生效）；`2` = 判据未成立/出现矛盾；
 * `1` = BLOCKED（环境缺失或登录态异常，未取到真值）。
 *
 * 用法：
 *   node verify_bug_246_enqueue_title_live.cjs
 *   VERIFY246_CHAT=-1004457697592 node verify_bug_246_enqueue_title_live.cjs
 *   VERIFY246_REFRESH_BACKUP=1 node ...      # 重新备份生产 session/store（默认沿用已有备份）
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

// ---- 路径派生：全部相对/环境派生，绝不内嵌机器绝对路径 ----
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const WORK_ROOT = process.env.ORIG_VERIFY_WORKDIR || path.join(os.tmpdir(), 'orig-verify-246')
const BIN_OLD = process.env.ORIG_TG_BIN_OLD ||
  path.join(REPO_ROOT, 'download-engine', 'target', 'debug', 'orig-tg.exe')
const BIN_NEW = process.env.ORIG_TG_BIN_NEW ||
  path.join(REPO_ROOT, 'download-engine', 'target', 'release', 'orig-tg.exe')
const CHAT_ID = process.env.VERIFY246_CHAT ? Number(process.env.VERIFY246_CHAT) : -1004457697592
const PORT_A = Number(process.env.VERIFY246_PORT_A || 19888)
const PORT_B = Number(process.env.VERIFY246_PORT_B || 19889)
const OBSERVE_MS = Number(process.env.VERIFY246_OBSERVE_MS || 3000)
const LATE_MS = Number(process.env.VERIFY246_LATE_MS || 15000)
const DRAIN_MS = Number(process.env.VERIFY246_DRAIN_MS || 25000)
const FORCE_PROBE_ID = process.env.VERIFY246_PROBE_ID ? Number(process.env.VERIFY246_PROBE_ID) : null
const FORCE_BLOCKER_ID = process.env.VERIFY246_BLOCKER_ID ? Number(process.env.VERIFY246_BLOCKER_ID) : null
const REFRESH_BACKUP = process.env.VERIFY246_REFRESH_BACKUP === '1'

const PROD_DIR = (function () {
  const base = process.env.APPDATA || (process.env.HOME ? path.join(process.env.HOME, '.local', 'share') : '')
  return base ? path.join(base, 'com.origadmin.orighub', 'tg') : null
})()

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' })
  console.log(`[verify246] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const snippet = (s, n) => String(s == null ? '' : s).slice(0, n)

function fatal(msg) {
  console.error(`[verify246] BLOCKED: ${msg}`)
  process.exitCode = 1
  throw new Error(msg)
}

/** 生产目录中读取凭据（`tg/config.json`，桌面壳写凭据的地方）。 */
function readCredentials() {
  const out = {
    api_id: process.env.ORIG_TG_API_ID || '',
    api_hash: process.env.ORIG_TG_API_HASH || '',
    proxy: process.env.ORIG_TG_PROXY || '',
  }
  const cfgPath = path.join(PROD_DIR, 'config.json')
  if (fs.existsSync(cfgPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      out.api_id = out.api_id || String(c.api_id || '')
      out.api_hash = out.api_hash || String(c.api_hash || '')
      out.proxy = out.proxy || String(c.proxy || '')
    } catch (e) {
      console.warn('[verify246] config.json unreadable:', e.message)
    }
  }
  return out
}

/** 把生产 session/store 复制到工作目录（生产目录只读，绝不写回）。 */
function backupProduction() {
  const dst = path.join(WORK_ROOT, 'backup-prod')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['session.session', 'store.db', 'config.json']) {
    const src = path.join(PROD_DIR, f)
    const out = path.join(dst, f)
    if (fs.existsSync(src) && (!fs.existsSync(out) || REFRESH_BACKUP)) {
      fs.copyFileSync(src, out)
      console.log(`[verify246] backup ${f} -> ${out}`)
    }
  }
  return dst
}

/** 二进制快照：防止对照基线在测试过程中被他人重建替换。 */
function snapshotBinary(src, label) {
  const dst = path.join(WORK_ROOT, 'bin')
  fs.mkdirSync(dst, { recursive: true })
  const buf = fs.readFileSync(src)
  const md5 = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12)
  const st = fs.statSync(src)
  const out = path.join(dst, `${label}-${md5}.exe`)
  fs.writeFileSync(out, buf)
  return { src, snapshot: out, md5, bytes: st.size, mtime: st.mtime.toISOString() }
}

/** 造一份隔离数据目录：session 副本 + store.db 副本 + 独立下载目录。 */
function prepareGroup(group) {
  const dir = path.join(WORK_ROOT, group)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
  for (const f of ['session.session', 'store.db']) {
    fs.copyFileSync(path.join(WORK_ROOT, 'backup-prod', f), path.join(dir, f))
  }
  // 隔离副作用：清掉监控频道（否则后台 tick 会往 media_message 灌行，污染 A 组对照）
  // 与历史 cache_task（否则 item_key 命中会走「复用活跃任务」分支，入队处理器根本不写行）。
  const db = new DatabaseSync(path.join(dir, 'store.db'))
  const stripped = {}
  try {
    stripped.monitored = db.prepare('SELECT COUNT(*) c FROM monitored_channel').get().c
    db.exec('DELETE FROM monitored_channel')
  } catch (e) { stripped.monitored = `skip: ${e.message}` }
  try {
    stripped.cacheTask = db.prepare('SELECT COUNT(*) c FROM cache_task').get().c
    db.exec('DELETE FROM cache_task')
  } catch (e) { stripped.cacheTask = `skip: ${e.message}` }
  db.close()
  console.log(`[verify246] group ${group}: isolated dir ready ${dir} (stripped ${JSON.stringify(stripped)})`)
  return dir
}

function buildEnv(dir, port, creds) {
  const sessionPath = path.join(dir, 'session.session')
  const dbPath = path.join(dir, 'store.db')
  const downloadDir = path.join(dir, 'downloads')
  // 安全边界：解析出的库/会话必须落在临时工作目录内，绝不能指向生产目录。
  for (const p of [sessionPath, dbPath, downloadDir]) {
    const norm = path.resolve(p)
    const root = path.resolve(WORK_ROOT)
    if (!norm.startsWith(root)) fatal(`refusing to use a path outside the temp workdir: ${norm}`)
    if (PROD_DIR && norm.startsWith(path.resolve(PROD_DIR))) {
      fatal(`refusing to point an isolated instance at the production data dir: ${norm}`)
    }
  }
  const env = { ...process.env }
  env.ORIG_TG_PORT = String(port)
  env.ORIG_TG_SESSION = sessionPath
  env.ORIG_TG_DB = dbPath
  env.ORIG_TG_DOWNLOAD_DIR = downloadDir
  env.ORIG_TG_MONITOR_INTERVAL = '3600'
  if (creds.api_id) env.ORIG_TG_API_ID = creds.api_id
  if (creds.api_hash) env.ORIG_TG_API_HASH = creds.api_hash
  if (creds.proxy) env.ORIG_TG_PROXY = creds.proxy
  // 调试构建默认离线（BUG-179 之前的旧语义）；ONLINE=1 强制真实 MTProto。
  // 严禁 ORIG_TG_OFFLINE / ORIG_TG_MOCK —— 验收服务必须与生产同源。
  env.ORIG_TG_ONLINE = '1'
  delete env.ORIG_TG_OFFLINE
  delete env.ORIG_TG_MOCK
  return { env, sessionPath, dbPath, downloadDir }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (_e) { /* keep raw */ }
  return { status: res.status, text, json }
}

/** 登录态异常的迹象：出现任一条都立刻止损（生产 session 安全优先于验收成功）。 */
const LOG_ALARM = /(AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|auth key|FLOOD_WAIT|phone_code|SendCode|sign in|2FA|password required|LOGIN_REQUIRED)/i

async function waitReady(port, logFile, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const r = await api('GET', `http://127.0.0.1:${port}/api/tg/diag`)
      last = r.json || last
      if (r.json && r.json.available === true && r.json.mock === false &&
          r.json.session_phase === 'Authorized' && r.json.link_alive === true) {
        return { ok: true, diag: r.json }
      }
    } catch (_e) { /* not up yet */ }
    if (fs.existsSync(logFile)) {
      const tail = fs.readFileSync(logFile, 'utf8')
      const m = tail.match(LOG_ALARM)
      if (m) return { ok: false, alarm: m[0], logTail: tail.slice(-1200) }
    }
    await sleep(1000)
  }
  return { ok: false, alarm: 'timeout waiting for an Authorized non-mock instance', diag: last }
}

/** 从 MTProto 拉一页真实媒体消息，并与（只读的）生产库求差，挑出实验消息。 */
function pickTargets(page, chatId) {
  const prodDb = new DatabaseSync(path.join(WORK_ROOT, 'backup-prod', 'store.db'), { readOnly: true })
  const inDb = new Set(
    prodDb.prepare('SELECT message_id FROM media_message WHERE channel_id = ?').all(chatId)
      .map((r) => r.message_id),
  )
  const dbRowsForChat = inDb.size
  const inTask = new Set()
  for (const r of prodDb.prepare('SELECT items FROM cache_task').all()) {
    try { for (const x of JSON.parse(r.items || '[]')) inTask.add(Number(x)) } catch (_e) { /* skip */ }
  }
  prodDb.close()

  const items = (page.items || []).filter((m) => Number.isFinite(m.id))
  const clean = items.filter((m) => !inDb.has(m.id) && !inTask.has(m.id) && m.hasMedia !== false)
  const byId = (id) => (id == null ? null : clean.find((m) => m.id === id) || items.find((m) => m.id === id) || null)
  // 探针：库里没有行、不在任何历史任务里、caption 非空（真值可比对）。
  // 同档候选里**偏好体量最小**的（照片/小视频）——元数据拉取快，能把「MTProto 被限流」
  // 这个干扰项压到最小：大文件的 getMessages 偶发 FLOOD_WAIT，会被误读成「修复没生效」。
  const probe = (FORCE_PROBE_ID != null ? byId(FORCE_PROBE_ID) : null) ||
    clean.filter((m) => (m.caption || '').trim().length > 0)
      .sort((a, b) => (a.size || 0) - (b.size || 0))[0]
  // 占位：体量中等偏大者（足够撑满观察窗口；过大反而可能因限流卡在 prepare，白等）。
  const pool = clean.filter((m) => m.id !== (probe && probe.id))
  const blocker = (FORCE_BLOCKER_ID != null ? byId(FORCE_BLOCKER_ID) : null) ||
    pool.filter((m) => (m.size || 0) <= 40_000_000).sort((a, b) => (b.size || 0) - (a.size || 0))[0] ||
    pool.sort((a, b) => (b.size || 0) - (a.size || 0))[0]
  return { probe, blocker, dbRowsForChat, inTaskCount: inTask.size, cleanCount: clean.length }
}

async function runGroup({ group, label, bin, port }) {
  console.log(`\n[verify246] ===== group ${group.toUpperCase()} (${label}) port=${port} =====`)
  const dir = prepareGroup(group)
  const creds = readCredentials()
  const { env, dbPath, downloadDir } = buildEnv(dir, port, creds)
  const logFile = path.join(dir, 'orig-tg.log')
  const logFd = fs.openSync(logFile, 'w')
  const child = spawn(bin, [], { env, cwd: dir, stdio: ['ignore', logFd, logFd] })
  console.log(`[verify246] spawned pid=${child.pid} bin=${bin}`)
  const result = { group, label, port, bin, pid: child.pid, dir, dbPath, downloadDir, logFile }

  const stop = async () => {
    if (!child.killed) {
      try { process.kill(child.pid) } catch (_e) { /* already gone */ }
    }
    await sleep(1500)
    try { fs.closeSync(logFd) } catch (_e) { /* already closed */ }
  }

  try {
    const ready = await waitReady(port, logFile)
    result.diag = ready.diag
    if (!ready.ok) {
      result.blocked = ready.alarm
      result.logTail = snippet(ready.logTail || (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''), 1200)
      return result
    }
    console.log(`[verify246] ${group}: diag ${JSON.stringify(ready.diag)}`)

    // ---- 取真值并挑定实验消息（两组共用同一条，落盘复用） ----
    const choiceFile = path.join(WORK_ROOT, 'probe-choice.json')
    let choice = fs.existsSync(choiceFile) ? JSON.parse(fs.readFileSync(choiceFile, 'utf8')) : null
    if (!choice) {
      const r = await api('GET', `http://127.0.0.1:${port}/api/tg/messages/${CHAT_ID}?limit=60`)
      if (r.status !== 200 || !r.json) {
        result.blocked = `GET /api/tg/messages/${CHAT_ID} -> HTTP ${r.status}: ${snippet(r.text, 200)}`
        return result
      }
      const picked = pickTargets(r.json, CHAT_ID)
      if (!picked.probe || !picked.blocker) {
        result.blocked = `no usable probe/blocker in chat ${CHAT_ID} ` +
          `(clean=${picked.cleanCount} dbRowsForChat=${picked.dbRowsForChat} inTask=${picked.inTaskCount})`
        return result
      }
      choice = {
        chatId: CHAT_ID,
        probeId: picked.probe.id,
        probeCaption: picked.probe.caption,
        probeSize: picked.probe.size || null,
        blockerId: picked.blocker.id,
        blockerSize: picked.blocker.size || null,
        dbRowsForChat: picked.dbRowsForChat,
        pickedBy: 'A/B shared: not in media_message, not in any cache_task, caption non-empty (probe); largest size (blocker)',
      }
      fs.writeFileSync(choiceFile, JSON.stringify(choice, null, 2))
    }
    result.choice = choice
    console.log(`[verify246] ${group}: target chat=${choice.chatId} probeMsg=${choice.probeId} ` +
      `blockerMsg=${choice.blockerId} (blockerSize=${choice.blockerSize})`)

    // ---- 入队占位任务，占住单飞 worker ----
    const blockerReq = { chatId: choice.chatId, messageIds: [choice.blockerId], dir: downloadDir }
    const b = await api('POST', `http://127.0.0.1:${port}/api/tg/cache/tasks`, blockerReq)
    result.blockerEnqueue = { status: b.status, body: snippet(b.text, 400) }
    console.log(`[verify246] ${group}: POST /api/tg/cache/tasks (blocker) -> HTTP ${b.status} ${snippet(b.text, 200)}`)
    if (b.status !== 200 || !b.json || !b.json.id) {
      result.blocked = `blocker enqueue failed: HTTP ${b.status} ${snippet(b.text, 200)}`
      return result
    }
    result.blockerId = b.json.id
    // 等 worker 真正领取占位任务（running），否则目标任务会立刻开跑、对照失效。
    let blockerStatus = null
    for (let i = 0; i < 40; i++) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.blockerId)
      if (t) blockerStatus = t.status
      if (blockerStatus === 'running') break
      await sleep(500)
    }
    result.blockerStatus = blockerStatus
    console.log(`[verify246] ${group}: blocker task ${result.blockerId} status=${blockerStatus}`)
    if (blockerStatus !== 'running') {
      result.blocked = `blocker task did not reach running (status=${blockerStatus}); ` +
        'without it the probe task would start immediately and the A/B contrast would be void'
      return result
    }

    // ---- 入队目标消息（本次实验的动作） ----
    const probeReq = { chatId: choice.chatId, messageIds: [choice.probeId], dir: downloadDir }
    const t0 = Date.now()
    const p = await api('POST', `http://127.0.0.1:${port}/api/tg/cache/tasks`, probeReq)
    result.probeEnqueue = { status: p.status, body: snippet(p.text, 400), atMs: Date.now() - t0 }
    console.log(`[verify246] ${group}: POST /api/tg/cache/tasks (probe) -> HTTP ${p.status} ${snippet(p.text, 400)}`)
    if (p.status !== 200 || !p.json || !p.json.id) {
      result.blocked = `probe enqueue failed: HTTP ${p.status} ${snippet(p.text, 300)}`
      return result
    }
    result.probeId = p.json.id

    // ---- ≤3s 窗口内观察任务 JSON ----
    const samples = []
    const deadline = Date.now() + OBSERVE_MS
    while (Date.now() <= deadline) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.probeId)
      samples.push({
        atMs: Date.now() - t0,
        http: all.status,
        status: t ? t.status : null,
        title: t ? (Object.prototype.hasOwnProperty.call(t, 'title') ? t.title : '<absent>') : null,
        json: t ? JSON.stringify(t).slice(0, 400) : null,
      })
      await sleep(500)
    }
    result.samples = samples
    const last = samples[samples.length - 1]
    result.observed = last
    console.log(`[verify246] ${group}: ${samples.length} samples in ${OBSERVE_MS}ms; final -> ` +
      `status=${last.status} title=${JSON.stringify(last.title)}`)
    console.log(`[verify246] ${group}: final task JSON -> ${last.json}`)

    // ---- 宽窗口续观（≤LATE_MS）：仍**只认排队态**，用来把「慢」与「没有」分开 ----
    let late = null
    while (Date.now() - t0 < LATE_MS) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.probeId)
      const title = t ? (Object.prototype.hasOwnProperty.call(t, 'title') ? t.title : null) : null
      if (t && t.status === 'queued' && title) { late = { atMs: Date.now() - t0, title }; break }
      if (t && t.status !== 'queued') { late = { atMs: Date.now() - t0, leftQueue: t.status }; break }
      await sleep(500)
    }
    result.late = late
    console.log(`[verify246] ${group}: late window -> ${JSON.stringify(late)}`)

    // ---- 隔离库核对：该 (chat,message) 有没有 media_message 行 ----
    result.dbRows = queryRows(dbPath, choice.chatId, choice.probeId)
    console.log(`[verify246] ${group}: media_message rows for (${choice.chatId},${choice.probeId}) = ` +
      `${result.dbRows.count} caption=${JSON.stringify(snippet(result.dbRows.caption, 120))}`)

    // ---- 反向对照（排除「MTProto 被限流」这个假阴性）：取消占位任务，让探针任务真的跑起来 ----
    // 若探针开跑后 title 也拿不到，说明 message_meta 在本环境根本取不到 —— 那是「没测成」，
    // 不能算成「修复无效」；反之则坐实「排队时没有、开跑时才有」，即入队登记未生效。
    await api('DELETE', `http://127.0.0.1:${port}/api/tg/cache/tasks/${result.blockerId}`)
    let drained = null
    const dStart = Date.now()
    while (Date.now() - dStart < DRAIN_MS) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.probeId)
      const title = t ? (Object.prototype.hasOwnProperty.call(t, 'title') ? t.title : null) : null
      if (title) { drained = { atMs: Date.now() - dStart, status: t.status, title }; break }
      await sleep(500)
    }
    result.drained = drained
    result.drainRows = queryRows(dbPath, choice.chatId, choice.probeId)
    console.log(`[verify246] ${group}: after blocker cancel -> ${JSON.stringify(drained)} ; ` +
      `rows now ${result.drainRows.count}`)
    return result
  } finally {
    await stop()
    console.log(`[verify246] ${group}: instance stopped (pid=${child.pid})`)
  }
}

/** 读隔离库（进程仍在跑，读冲突重试）。 */
function queryRows(dbPath, chatId, messageId) {
  let lastErr = null
  for (let i = 0; i < 10; i++) {
    let db = null
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare(
        'SELECT message_id, caption, media_type, size FROM media_message ' +
          'WHERE channel_id = ? AND message_id = ?',
      ).all(chatId, messageId)
      return { count: rows.length, caption: rows.length ? rows[0].caption : null, rows }
    } catch (e) {
      lastErr = e
      try { if (db) db.close() } catch (_e) { /* noop */ }
      const until = Date.now() + 500
      while (Date.now() < until) { /* busy wait; 同步脚本无法 await */ }
    }
  }
  return { count: -1, caption: null, error: String(lastErr && lastErr.message) }
}

async function main() {
  console.log('[verify246] === BUG-246 runtime A/B verification (isolated instances) ===')
  console.log(`[verify246] workRoot : ${WORK_ROOT}`)
  console.log(`[verify246] prodDir  : ${PROD_DIR} (read-only source of the copies)`)
  if (!PROD_DIR || !fs.existsSync(path.join(PROD_DIR, 'store.db'))) {
    fatal('production store.db not found; cannot derive an isolated copy')
  }

  const A_bin = snapshotBinary(BIN_OLD, 'old-debug')
  const B_bin = snapshotBinary(BIN_NEW, 'new-release')
  console.log(`[verify246] binary A (control / pre-fix) : ${A_bin.src}\n` +
    `[verify246]   md5=${A_bin.md5} bytes=${A_bin.bytes} mtime=${A_bin.mtime}`)
  console.log(`[verify246] binary B (experiment / fixed): ${B_bin.src}\n` +
    `[verify246]   md5=${B_bin.md5} bytes=${B_bin.bytes} mtime=${B_bin.mtime}`)
  if (A_bin.md5 === B_bin.md5) fatal('A and B binaries are identical - the A/B contrast is void')

  backupProduction()

  const ra = await runGroup({ group: 'a', label: 'control / pre-fix debug build', bin: A_bin.snapshot, port: PORT_A })
  const rb = await runGroup({ group: 'b', label: 'experiment / fixed release build', bin: B_bin.snapshot, port: PORT_B })

  console.log('\n[verify246] === EVIDENCE ===')
  for (const r of [ra, rb]) {
    console.log(`--- group ${r.group.toUpperCase()} (${r.label}) ---`)
    console.log(`  bin            : ${r.bin}`)
    console.log(`  pid            : ${r.pid}`)
    console.log(`  diag           : ${JSON.stringify(r.diag || null)}`)
    console.log(`  choice         : ${JSON.stringify(r.choice || null)}`)
    console.log(`  blocker enqueue: HTTP ${r.blockerEnqueue && r.blockerEnqueue.status} ${r.blockerEnqueue && r.blockerEnqueue.body}`)
    console.log(`  blocker status : ${r.blockerStatus}`)
    console.log(`  probe enqueue  : HTTP ${r.probeEnqueue && r.probeEnqueue.status} ${r.probeEnqueue && r.probeEnqueue.body}`)
    console.log(`  observed       : ${JSON.stringify(r.observed || null)}`)
    console.log(`  db rows        : ${JSON.stringify(r.dbRows || null)}`)
    if (r.blocked) console.log(`  BLOCKED        : ${r.blocked}`)
  }

  if (ra.blocked || rb.blocked) {
    console.log('\n[verify246] RESULT: BLOCKED - runtime truth not obtained (see BLOCKED lines above).')
    process.exitCode = 1
    return
  }

  const truth = (rb.choice || ra.choice).probeCaption
  const probeId = (rb.choice || ra.choice).probeId
  check('ground truth caption is non-empty', !!truth && truth.trim().length > 0,
    `probeMsg=${probeId} truth=${JSON.stringify(snippet(truth, 90))}`)

  // A 组：修复前的病态 —— 排队任务拿不到 title，库里没有行。
  const aQueued = ra.observed && ra.observed.status === 'queued'
  const aNoTitle = ra.observed && (ra.observed.title === '<absent>' || ra.observed.title == null)
  const aLateTitle = ra.late && ra.late.title
  check('A (pre-fix): probe task is still queued', aQueued, `status=${ra.observed && ra.observed.status}`)
  check('A (pre-fix): queued task has NO title (3s)', aNoTitle, `title=${JSON.stringify(ra.observed && ra.observed.title)}`)
  check('A (pre-fix): still no title while queued (late window)', !aLateTitle,
    `late=${JSON.stringify(ra.late)}`)
  check('A (pre-fix): media_message row absent while queued', ra.dbRows.count === 0, `rows=${ra.dbRows.count}`)
  // A 组的反向对照：占位任务取消后探针真的开跑 —— 此时**必须**拿到真值 caption。
  // 它证明「本环境取得到 message_meta」，A 组的「没有」是病，不是没测成。
  check('A (pre-fix): once the probe actually runs, title === truth (control)',
    !!ra.drained && ra.drained.title === truth,
    `drained=${JSON.stringify(ra.drained && { atMs: ra.drained.atMs, status: ra.drained.status, title: snippet(ra.drained.title, 60) })}`)

  // B 组：修复后 —— 排队任务就该拿到 title，且逐字等于真值。
  const bQueued = rb.observed && rb.observed.status === 'queued'
  const bTitle3s = rb.observed && rb.observed.title !== '<absent>' ? rb.observed.title : null
  const bTitleLate = rb.late && rb.late.title
  const bQueuedTitle = bTitle3s || bTitleLate
  check('B (fixed): probe task is still queued', bQueued, `status=${rb.observed && rb.observed.status}`)
  check('B (fixed): queued task title === ground-truth caption (verbatim)',
    bQueued && bQueuedTitle === truth,
    `title3s=${JSON.stringify(snippet(bTitle3s, 60))} late=${JSON.stringify(snippet(bTitleLate, 60))}`)
  check('B (fixed): media_message row present with the truth caption',
    rb.dbRows.count >= 1 && rb.dbRows.caption === truth,
    `rows=${rb.dbRows.count} caption=${JSON.stringify(snippet(rb.dbRows.caption, 60))}`)

  const aFailed = aQueued && aNoTitle && !aLateTitle && ra.dbRows.count === 0
  const bPassed = bQueued && bQueuedTitle === truth && rb.dbRows.count >= 1 && rb.dbRows.caption === truth
  // 「B 排队时没有」有两种可能：修复没生效，或 message_meta 在本环境取不到（限流）。
  // 用 drain 对照分开：开跑后能拿到真值 ⇒ 取得到 ⇒ 是修复没生效；拿不到 ⇒ 没测成（BLOCKED）。
  const bMetaWorks = !!rb.drained && rb.drained.title === truth

  console.log('\n[verify246] === SUMMARY ===')
  const failed = checks.filter((c) => !c.pass)
  console.log(`[verify246] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  if (aFailed && bPassed) {
    console.log('[verify246] VERDICT: runtime PASS - A(pre-fix) lacked the queued title, ' +
      'B(fixed) carried the verbatim caption while still queued; the change is the cause.')
    process.exitCode = 0
  } else if (!aFailed && bPassed) {
    console.log('[verify246] VERDICT: CONTRADICTION - A(pre-fix) also produced the title. ' +
      'The old binary behaves differently from the documented disease; do NOT claim the fix works.')
    process.exitCode = 2
  } else if (aFailed && !bPassed && bMetaWorks) {
    console.log('[verify246] VERDICT: FIX NOT EFFECTIVE AT RUNTIME - A behaved as the disease, and ' +
      'B only got the title AFTER the task left the queue (prepare path), i.e. enqueue-time ' +
      'registration did not happen in this binary.')
    process.exitCode = 2
  } else if (aFailed && !bPassed && !bMetaWorks) {
    console.log('[verify246] VERDICT: BLOCKED - B never produced the truth caption even after the ' +
      'task started; message_meta could not be exercised here, so no verdict on the fix.')
    process.exitCode = 1
  } else {
    console.log('[verify246] VERDICT: INCONCLUSIVE - neither side matched expectation.')
    process.exitCode = 2
  }
}

main().catch((e) => {
  if (process.exitCode == null) process.exitCode = 1
  console.error('[verify246] aborted:', e && e.stack ? e.stack : String(e))
})
