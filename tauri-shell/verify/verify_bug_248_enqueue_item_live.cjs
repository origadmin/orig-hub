#!/usr/bin/env node
'use strict'

/**
 * BUG-248 运行时真值验收（A/B 隔离实例对照）——**入队瞬间**媒体库条目是否已登记。
 *
 * ## 它回答的问题
 *
 * BUG-248 的修复（`routes.rs`：抽出 `register_media_item_t0`，由入队处理器在
 * BUG-246 那个同一个后台协程里调用）目前只有**代码层**证据。生产 `orig-tg` 跑的是
 * 修复前的二进制，「代码存在」不等于「运行时生效」。本脚本用**两个隔离实例跑同一条
 * 真实消息**取运行时真值：
 *
 *   - **A 组（对照 / 修复前）**：HEAD 提交构建（**含 BUG-246**，**不含 BUG-248**）
 *   - **B 组（实验 / 修复后）**：当前工作树构建（含 BUG-248）
 *
 * 两组差异**只有二进制**：同一份数据副本、同一条目标消息、同一串 HTTP 调用。判据成对：
 *
 *   - A 组：目标任务停在 `queued` 时，媒体库里 `(tg, "{chat}:{msg}")` **必须查不到条目**；
 *   - B 组：同样停在 `queued` 时，**必须查得到条目**，且 `file_path` 为 **NULL**
 *     （信息已在、字节未到——这正是 BUG-170 裁定而未兑现的那一半）。
 *
 * 只有 A FAIL + B PASS 同时成立，才证明「改动是因」。若 A 组意外也 PASS，脚本判定为
 * **矛盾（contradiction）**并如实报出，不粉饰。
 *
 * ## 为什么必须让任务停在 `queued`
 *
 * 缓存 worker 是**全局单飞**：任务一旦被领取就立刻跑 `IngestCtx::register_item()`
 * ——修复前后**都会**登记条目，那是 worker 的老行为。若目标任务开跑，A/B 两组都会
 * 拿到条目，对照失效（假阴性）。所以这里先入队一个**占位任务**占住 worker，
 * 使目标任务稳定停在 `queued` —— 正是用户反馈的真实形态。
 *
 * ## 反向对照（区分「没测成」与「修复无效」）
 *
 * 取消占位任务后让目标任务真的跑起来：若此时两组都拿到字节（`file_path` 非 NULL），
 * 说明本环境确实能下载、路由确实写得进条目 ⇒ A 组的「排队时没有」是**病**，
 * 不是没测成。反之（跑起来也拿不到）判 BLOCKED —— 不允许据此声称修复有效。
 *
 * ## 依赖的外部环境（**未经确认不要跑**）
 *
 * 1. Windows + `%APPDATA%/com.origadmin.orighub/tg/` 下有**已授权**的 `session.session`
 *    与 `store.db`（其它平台退到 `$HOME/.local/share/com.origadmin.orighub/tg`）。
 * 2. 两个待测二进制存在（默认见下，可用环境变量覆盖）：
 *      A = `ORIG_TG_BIN_A`（HEAD 构建，含 246 不含 248）
 *      B = `ORIG_TG_BIN_B`（当前工作树构建，含 248）
 *    两者 md5 相同 ⇒ 对照失效，脚本直接失败。md5/大小/mtime 会打进证据，先核对再信结论。
 * 3. 需要连 Telegram（走 `tg/config.json` 的 socks5 代理）。会真实连 MTProto、会真实
 *    下载占位/目标任务的媒体字节到隔离目录。本进程与生产共用同一份 auth key，存在被
 *    服务端要求重登的理论风险；日志里一旦出现重登/验证码/FLOOD/AUTH_KEY_DUPLICATED
 *    迹象立即自杀并报 BLOCKED。
 * 4. Node >= 22（用到 `node:sqlite`）。零第三方依赖。
 *
 * ## 安全边界
 *
 * - 生产目录**只读**：只从那里 `copyFileSync` 出来，绝不写回。
 * - 两组各用 `os.tmpdir()/orig-verify-248/{a,b}` 下的**副本**（session + store.db）。
 * - 下载目录显式指向隔离目录（`dir` 入参优先级高于库里的 `download_dir` 设置），
 *   绝不落到生产下载目录。
 * - 只杀**自己 spawn 的 PID**；任何异常路径都会 `kill` 自己的子进程。
 * - 启动前校验：解析出的 session/db/下载目录必须在临时工作目录内，且不等于生产路径。
 *
 * ## 判据（本仓铁律：有值 + 具体值，禁 always-green）
 *
 *   1. `truth.caption` 非空（MTProto 真值存在）；
 *   2. A 组：目标任务 `status === 'queued'` 且隔离库中该 ref 的 `media_item` 行数 **=== 0**；
 *   3. B 组：目标任务 `status === 'queued'` 且该 ref **恰好 1 行**、`file_path === null`
 *      （逐值打印 item id），且 title === 真值 caption 首行（与 worker 同一把尺子）；
 *   4. 反向对照：取消占位后目标任务真跑起来，两组最终都要拿到 `file_path` 非 NULL。
 *
 * 退出码：`0` = 成对对照成立；`2` = 判据未成立/出现矛盾；`1` = BLOCKED。
 *
 * 用法：
 *   node verify_bug_248_enqueue_item_live.cjs
 *   VERIFY248_CHAT=-1004457697592 node verify_bug_248_enqueue_item_live.cjs
 *   ORIG_TG_BIN_A=... ORIG_TG_BIN_B=... node verify_bug_248_enqueue_item_live.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')

// ---- 路径派生：全部相对/环境派生，绝不内嵌机器绝对路径 ----
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const WORK_ROOT = process.env.ORIG_VERIFY_WORKDIR || path.join(os.tmpdir(), 'orig-verify-248')
const BIN_A = process.env.ORIG_TG_BIN_A || ''
const BIN_B = process.env.ORIG_TG_BIN_B || ''
const CHAT_ID = process.env.VERIFY248_CHAT ? Number(process.env.VERIFY248_CHAT) : -1004457697592
const PORT_A = Number(process.env.VERIFY248_PORT_A || 19886)
const PORT_B = Number(process.env.VERIFY248_PORT_B || 19887)
const OBSERVE_MS = Number(process.env.VERIFY248_OBSERVE_MS || 5000)
const META_MS = Number(process.env.VERIFY248_META_MS || 45000)
const DRAIN_MS = Number(process.env.VERIFY248_DRAIN_MS || 60000)
const REPICK = process.env.VERIFY248_REPICK === '1'
const FORCE_PROBE_ID = process.env.VERIFY248_PROBE_ID ? Number(process.env.VERIFY248_PROBE_ID) : null
const FORCE_BLOCKER_ID = process.env.VERIFY248_BLOCKER_ID ? Number(process.env.VERIFY248_BLOCKER_ID) : null
const EVIDENCE_DIR = path.join(__dirname, 'evidence')

const PROD_DIR = (function () {
  const base = process.env.APPDATA || (process.env.HOME ? path.join(process.env.HOME, '.local', 'share') : '')
  return base ? path.join(base, 'com.origadmin.orighub', 'tg') : null
})()

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' })
  console.log(`[verify248] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const snippet = (s, n) => String(s == null ? '' : s).slice(0, n)

function fatal(msg) {
  console.error(`[verify248] BLOCKED: ${msg}`)
  process.exitCode = 1
  throw new Error(msg)
}

/**
 * caption 首行 = 后端 `split_caption` 的标题口径。
 *
 * 必须**逐字复刻**后端规则（`media.rs::split_caption`）：取首行 → 按空白分词 →
 * 行尾连续的 `#标签` 全部弹出（行首第一个词若以 `#` 开头则是标题，不弹）。
 * 上一版只做 `.trim()`，于是把「行尾 #标签」也算进期望值，把一个正确的标题判成 FAIL
 * —— 判定尺子必须先与实现一致，否则验的是脚本不是代码。
 */
function titleOf(caption) {
  const first = String(caption || '').split('\n')[0].trim()
  const toks = first.split(/\s+/).filter(Boolean)
  const from = toks.length > 0 && toks[0].startsWith('#') ? 1 : 0
  while (toks.length > from && toks[toks.length - 1].startsWith('#')) toks.pop()
  return toks.join(' ')
}

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
      console.warn('[verify248] config.json unreadable:', e.message)
    }
  }
  return out
}

function backupProduction() {
  const dst = path.join(WORK_ROOT, 'backup-prod')
  fs.mkdirSync(dst, { recursive: true })
  for (const f of ['session.session', 'store.db', 'config.json']) {
    const src = path.join(PROD_DIR, f)
    const out = path.join(dst, f)
    if (fs.existsSync(src) && !fs.existsSync(out)) {
      fs.copyFileSync(src, out)
      console.log(`[verify248] backup ${f} -> ${out}`)
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

/**
 * 造一份隔离数据目录：session 副本 + store.db 副本 + 独立下载目录，
 * 并**剥掉**历史噪声：监控频道（后台 tick 会补行）与历史 cache_task
 * （item_key 命中会走「复用活跃任务」分支，入队处理器就不写新任务了）。
 */
function prepareGroup(group) {
  const dir = path.join(WORK_ROOT, group)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
  for (const f of ['session.session', 'store.db']) {
    fs.copyFileSync(path.join(WORK_ROOT, 'backup-prod', f), path.join(dir, f))
  }
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
  console.log(`[verify248] group ${group}: isolated dir ready ${dir} (stripped ${JSON.stringify(stripped)})`)
  return dir
}

function buildEnv(dir, port, creds) {
  const sessionPath = path.join(dir, 'session.session')
  const dbPath = path.join(dir, 'store.db')
  const downloadDir = path.join(dir, 'downloads')
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
  // 调试构建默认离线（旧语义）；ONLINE=1 强制真实 MTProto。
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

/**
 * 从 MTProto 拉一页真实媒体消息，挑出实验消息。
 *
 * 过滤条件比 BUG-246 更严：**必须同时**不在 `media_message`、不在任何历史 `cache_task`、
 * 且**没有对应的 `media_item` 行** —— 最后一条是本条的关键：probe 若已入库，
 * A 组「排队时查不到条目」的判据会被旧条目污染成假阴性。
 */
function pickTargets(page, chatId) {
  const prodDb = new DatabaseSync(path.join(WORK_ROOT, 'backup-prod', 'store.db'), { readOnly: true })
  const inDb = new Set(
    prodDb.prepare('SELECT message_id FROM media_message WHERE channel_id = ?').all(chatId)
      .map((r) => r.message_id),
  )
  const inTask = new Set()
  for (const r of prodDb.prepare('SELECT items FROM cache_task').all()) {
    try { for (const x of JSON.parse(r.items || '[]')) inTask.add(Number(x)) } catch (_e) { /* skip */ }
  }
  let itemRows = 0
  try {
    itemRows = prodDb.prepare("SELECT COUNT(*) c FROM media_item WHERE source = 'tg' AND ref LIKE ?")
      .get(`${chatId}:%`).c
  } catch (_e) { itemRows = -1 }
  prodDb.close()

  const items = (page.items || []).filter((m) => Number.isFinite(m.id))
  const clean = items.filter((m) => !inDb.has(m.id) && !inTask.has(m.id) && m.hasMedia !== false)
  const byId = (id) => (id == null ? null : clean.find((m) => m.id === id) || items.find((m) => m.id === id) || null)
  // 探针：干净消息里**体量最小且 caption 非空**者 —— 元数据拉取与后续字节都快，
  // 把「MTProto 限流」这个干扰项压到最小（反向对照阶段要真的把这条任务跑完）。
  const probe = (FORCE_PROBE_ID != null ? byId(FORCE_PROBE_ID) : null) ||
    clean.filter((m) => (m.caption || '').trim().length > 0)
      .sort((a, b) => (a.size || 0) - (b.size || 0))[0]
  // 占位：必须**真的能占住单飞 worker**（否则目标任务立刻开跑，对照失效）。
  // 判据是「体量足够大」：优先 ≥30MB 的视频，其次体量最大的任意媒体。
  // 上一版按「≤40MB 里取最大」挑，结果挑到一张 size 为 null 的照片 —— worker 秒完，
  // 目标任务当场开跑，A 组对照直接失效（实测已发生）。
  const rest = clean.filter((m) => m.id !== (probe && probe.id))
  const bigEnough = rest.filter((m) => (m.size || 0) >= 30_000_000)
  const pool = bigEnough.length ? bigEnough : rest.filter((m) => (m.size || 0) > 0)
  const blocker = (FORCE_BLOCKER_ID != null ? byId(FORCE_BLOCKER_ID) : null) ||
    pool.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0] ||
    null
  return {
    probe, blocker, cleanCount: clean.length, itemRows,
    dbRowsForChat: inDb.size, inTaskCount: inTask.size,
  }
}

/** 读隔离库里某个 ref 的条目（进程仍在跑，读冲突重试）。 */
function queryItem(dbPath, refKey) {
  let lastErr = null
  for (let i = 0; i < 10; i++) {
    let db = null
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare(
        'SELECT id, source, ref, title, kind, file_path FROM media_item ' +
          'WHERE source = ? AND ref = ?',
      ).all('tg', refKey)
      return {
        count: rows.length,
        id: rows.length ? rows[0].id : null,
        file_path: rows.length ? rows[0].file_path : null,
        title: rows.length ? rows[0].title : null,
        kind: rows.length ? rows[0].kind : null,
        rows,
      }
    } catch (e) {
      lastErr = e
      try { if (db) db.close() } catch (_e) { /* noop */ }
      const until = Date.now() + 500
      while (Date.now() < until) { /* busy wait; 同步脚本无法 await */ }
    }
  }
  return { count: -1, id: null, file_path: null, title: null, kind: null, error: String(lastErr && lastErr.message) }
}

async function runGroup({ group, label, bin, port }) {
  console.log(`\n[verify248] ===== group ${group.toUpperCase()} (${label}) port=${port} =====`)
  const dir = prepareGroup(group)
  const creds = readCredentials()
  const { env, dbPath, downloadDir } = buildEnv(dir, port, creds)
  const logFile = path.join(dir, 'orig-tg.log')
  const logFd = fs.openSync(logFile, 'w')
  const child = spawn(bin, [], { env, cwd: dir, stdio: ['ignore', logFd, logFd] })
  console.log(`[verify248] spawned pid=${child.pid} bin=${bin}`)
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
    console.log(`[verify248] ${group}: diag ${JSON.stringify(ready.diag)}`)

    // ---- 取真值并挑定实验消息（两组共用同一条，落盘复用） ----
    const choiceFile = path.join(WORK_ROOT, 'probe-choice.json')
    let choice = (!REPICK && fs.existsSync(choiceFile)) ? JSON.parse(fs.readFileSync(choiceFile, 'utf8')) : null
    if (!choice) {
      const r = await api('GET', `http://127.0.0.1:${port}/api/tg/messages/${CHAT_ID}?limit=60`)
      if (r.status !== 200 || !r.json) {
        result.blocked = `GET /api/tg/messages/${CHAT_ID} -> HTTP ${r.status}: ${snippet(r.text, 200)}`
        return result
      }
      const picked = pickTargets(r.json, CHAT_ID)
      if (!picked.probe || !picked.blocker) {
        result.blocked = `no usable probe/blocker in chat ${CHAT_ID} ` +
          `(clean=${picked.cleanCount} dbRowsForChat=${picked.dbRowsForChat} ` +
          `inTask=${picked.inTaskCount} itemRows=${picked.itemRows}; ` +
          'a blocker with a known size is required to hold the single-flight worker)'
        return result
      }
      choice = {
        chatId: CHAT_ID,
        probeId: picked.probe.id,
        probeCaption: picked.probe.caption,
        probeSize: picked.probe.size || null,
        probeMediaType: picked.probe.mediaType || picked.probe.type || null,
        blockerId: picked.blocker.id,
        blockerSize: picked.blocker.size || null,
        pickedBy: 'A/B shared: not in media_message, not in any cache_task, smallest with caption (probe); ' +
          'largest with known size >=30MB, else largest (blocker — must hold the single-flight worker)',
      }
      fs.writeFileSync(choiceFile, JSON.stringify(choice, null, 2))
    }
    result.choice = choice
    result.refKey = `${choice.chatId}:${choice.probeId}`
    console.log(`[verify248] ${group}: target chat=${choice.chatId} probeMsg=${choice.probeId} ` +
      `(size=${choice.probeSize}) blockerMsg=${choice.blockerId} (size=${choice.blockerSize}) ref=${result.refKey}`)
    // 隔离库里这条 ref 必须**本来没有**条目，否则 A 组的「查不到」不成立。
    result.itemBefore = queryItem(dbPath, result.refKey)
    console.log(`[verify248] ${group}: media_item before enqueue = ${result.itemBefore.count} rows`)

    // ---- 入队占位任务，占住单飞 worker ----
    const b = await api('POST', `http://127.0.0.1:${port}/api/tg/cache/tasks`,
      { chatId: choice.chatId, messageIds: [choice.blockerId], dir: downloadDir })
    result.blockerEnqueue = { status: b.status, body: snippet(b.text, 400) }
    console.log(`[verify248] ${group}: POST /api/tg/cache/tasks (blocker) -> HTTP ${b.status} ${snippet(b.text, 200)}`)
    if (b.status !== 200 || !b.json || !b.json.id) {
      result.blocked = `blocker enqueue failed: HTTP ${b.status} ${snippet(b.text, 200)}`
      return result
    }
    result.blockerId = b.json.id
    let blockerStatus = null
    for (let i = 0; i < 40; i++) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.blockerId)
      if (t) blockerStatus = t.status
      if (blockerStatus === 'running') break
      await sleep(500)
    }
    result.blockerStatus = blockerStatus
    console.log(`[verify248] ${group}: blocker task ${result.blockerId} status=${blockerStatus}`)
    if (blockerStatus !== 'running') {
      result.blocked = `blocker task did not reach running (status=${blockerStatus}); ` +
        'without it the probe task would start immediately and the A/B contrast would be void'
      return result
    }

    // ---- 入队目标消息（本次实验的动作） ----
    const t0 = Date.now()
    const p = await api('POST', `http://127.0.0.1:${port}/api/tg/cache/tasks`,
      { chatId: choice.chatId, messageIds: [choice.probeId], dir: downloadDir })
    result.probeEnqueue = { status: p.status, body: snippet(p.text, 400), atMs: Date.now() - t0 }
    console.log(`[verify248] ${group}: POST /api/tg/cache/tasks (probe) -> HTTP ${p.status} ${snippet(p.text, 400)}`)
    if (p.status !== 200 || !p.json || !p.json.id) {
      result.blocked = `probe enqueue failed: HTTP ${p.status} ${snippet(p.text, 300)}`
      return result
    }
    result.probeId = p.json.id

    // ---- 观察窗口：任务状态 + 该 ref 的条目是否就地可查 + 占位任务是否真的在搬字节 ----
    // 占位任务的字节进度是「这个隔离实例确实活着、worker 确实在忙」的**活体证据**：
    // 反向对照（等 worker 处理到探针）在 246MB 的占位下载面前要等数分钟，不现实；
    // 用「字节在流」代替它，既证明环境真实，又不必把验收拖成十分钟。
    const samples = []
    let blockerProgress = 0
    const deadline = Date.now() + OBSERVE_MS
    while (Date.now() <= deadline) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const tasks = (all.json && all.json.tasks) || []
      const t = tasks.find((x) => x.id === result.probeId)
      const bl = tasks.find((x) => x.id === result.blockerId)
      if (bl && Number.isFinite(bl.progressBytes)) blockerProgress = Math.max(blockerProgress, bl.progressBytes)
      const item = queryItem(dbPath, result.refKey)
      samples.push({
        atMs: Date.now() - t0,
        status: t ? t.status : null,
        title: t ? (Object.prototype.hasOwnProperty.call(t, 'title') ? t.title : '<absent>') : null,
        blockerStatus: bl ? bl.status : null,
        blockerProgressBytes: bl ? (bl.progressBytes ?? null) : null,
        itemCount: item.count,
        itemId: item.id,
        itemFilePath: item.file_path,
      })
      await sleep(500)
    }
    result.samples = samples
    result.blockerProgressBytes = blockerProgress
    const last = samples[samples.length - 1]
    result.observed = last
    console.log(`[verify248] ${group}: ${samples.length} samples in ${OBSERVE_MS}ms; final -> ` +
      `status=${last.status} itemCount=${last.itemCount} itemId=${last.itemId} file_path=${JSON.stringify(last.itemFilePath)}`)
    result.item = queryItem(dbPath, result.refKey)
    console.log(`[verify248] ${group}: media_item rows=${result.item.count} id=${result.item.id} ` +
      `title=${JSON.stringify(snippet(result.item.title, 80))} kind=${result.item.kind} ` +
      `file_path=${JSON.stringify(result.item.file_path)}`)

    // ---- 元数据补强窗口（≤META_MS）：**任务必须仍在 `queued`** ----
    // 入队协程的第 ②/③ 步要等 MTProto 回一条 `message_meta`（实测与下载争用时 ≤30s），
    // 之后才把标题/kind 补强进那一行。这一步不等 worker —— 这正是「先入信息」的意义：
    // 排队几十分钟也**不该**让条目停在认不出的空卡上。
    let metaLate = null
    const mStart = Date.now()
    while (Date.now() - mStart < META_MS) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.probeId)
      const status = t ? t.status : null
      const item = queryItem(dbPath, result.refKey)
      if (item.title) {
        metaLate = { atMs: Date.now() - mStart, status, title: item.title, kind: item.kind, itemId: item.id }
        break
      }
      if (status !== 'queued') {
        metaLate = { atMs: Date.now() - mStart, status, leftQueue: true, itemId: item.id }
        break
      }
      await sleep(500)
    }
    result.metaLate = metaLate
    result.itemAfterMeta = queryItem(dbPath, result.refKey)
    console.log(`[verify248] ${group}: metadata window -> ${JSON.stringify(metaLate)} ; ` +
      `item id=${result.itemAfterMeta.id} title=${JSON.stringify(snippet(result.itemAfterMeta.title, 60))} ` +
      `kind=${result.itemAfterMeta.kind}`)

    // ---- 反向对照（信息性）：取消占位任务，看目标任务能否真的流转 ----
    // 注意：占位是数百 MB 的真实下载，取消只在**条目间隙**生效，worker 不会被立刻打断，
    // 故这一段只作为「信息读数」记录，**不参与判定**（拿它当判据会把验收拖成十分钟且不稳）。
    await api('DELETE', `http://127.0.0.1:${port}/api/tg/cache/tasks/${result.blockerId}`)
    let drained = null
    const dStart = Date.now()
    while (Date.now() - dStart < DRAIN_MS) {
      const all = await api('GET', `http://127.0.0.1:${port}/api/tg/cache/tasks/all`)
      const t = (all.json && all.json.tasks || []).find((x) => x.id === result.probeId)
      const item = queryItem(dbPath, result.refKey)
      const status = t ? t.status : null
      if (item.file_path || (status && status !== 'queued')) {
        drained = { atMs: Date.now() - dStart, status, file_path: item.file_path, itemId: item.id }
        break
      }
      await sleep(1000)
    }
    result.drained = drained
    result.drainItem = queryItem(dbPath, result.refKey)
    console.log(`[verify248] ${group}: after blocker cancel (informational) -> ${JSON.stringify(drained)} ; ` +
      `item now id=${result.drainItem.id} file_path=${JSON.stringify(result.drainItem.file_path)}`)
    return result
  } finally {
    await stop()
    console.log(`[verify248] ${group}: instance stopped (pid=${child.pid})`)
  }
}

async function main() {
  console.log('[verify248] === BUG-248 runtime A/B verification (isolated instances) ===')
  console.log(`[verify248] workRoot : ${WORK_ROOT}`)
  console.log(`[verify248] prodDir  : ${PROD_DIR} (read-only source of the copies)`)
  if (!PROD_DIR || !fs.existsSync(path.join(PROD_DIR, 'store.db'))) {
    fatal('production store.db not found; cannot derive an isolated copy')
  }
  if (!BIN_A || !fs.existsSync(BIN_A)) fatal(`control binary (A) missing: ${BIN_A || '<unset>'}`)
  if (!BIN_B || !fs.existsSync(BIN_B)) fatal(`experiment binary (B) missing: ${BIN_B || '<unset>'}`)

  const A_bin = snapshotBinary(BIN_A, 'ctrl-head')
  const B_bin = snapshotBinary(BIN_B, 'fixed-worktree')
  console.log(`[verify248] binary A (control / HEAD, no BUG-248) : ${A_bin.src}\n` +
    `[verify248]   md5=${A_bin.md5} bytes=${A_bin.bytes} mtime=${A_bin.mtime}`)
  console.log(`[verify248] binary B (experiment / BUG-248 fixed): ${B_bin.src}\n` +
    `[verify248]   md5=${B_bin.md5} bytes=${B_bin.bytes} mtime=${B_bin.mtime}`)
  if (A_bin.md5 === B_bin.md5) fatal('A and B binaries are identical - the A/B contrast is void')

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  backupProduction()

  const ra = await runGroup({ group: 'a', label: 'control / HEAD build (BUG-246 yes, BUG-248 no)', bin: A_bin.snapshot, port: PORT_A })
  const rb = await runGroup({ group: 'b', label: 'experiment / BUG-248 fixed', bin: B_bin.snapshot, port: PORT_B })

  console.log('\n[verify248] === EVIDENCE ===')
  for (const r of [ra, rb]) {
    console.log(`--- group ${r.group.toUpperCase()} (${r.label}) ---`)
    console.log(`  bin            : ${r.bin}`)
    console.log(`  pid            : ${r.pid}`)
    console.log(`  diag           : ${JSON.stringify(r.diag || null)}`)
    console.log(`  choice         : ${JSON.stringify(r.choice || null)}`)
    console.log(`  refKey         : ${r.refKey}`)
    console.log(`  item before    : ${JSON.stringify(r.itemBefore || null)}`)
    console.log(`  blocker status : ${r.blockerStatus}`)
    console.log(`  probe enqueue  : HTTP ${r.probeEnqueue && r.probeEnqueue.status} ${r.probeEnqueue && r.probeEnqueue.body}`)
    console.log(`  observed       : ${JSON.stringify(r.observed || null)}`)
    console.log(`  item while q   : ${JSON.stringify(r.item || null)}`)
    console.log(`  drained        : ${JSON.stringify(r.drained || null)}`)
    console.log(`  item after     : ${JSON.stringify(r.drainItem || null)}`)
    if (r.blocked) console.log(`  BLOCKED        : ${r.blocked}`)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const evidenceFile = path.join(EVIDENCE_DIR, `bug-248-runtime-${stamp}.json`)
  fs.writeFileSync(evidenceFile, JSON.stringify({
    bug: 'BUG-248',
    stamp,
    workRoot: WORK_ROOT,
    chatId: CHAT_ID,
    bins: { A: A_bin, B: B_bin },
    groups: {
      a: {
        label: ra.label, pid: ra.pid, diag: ra.diag, choice: ra.choice, refKey: ra.refKey,
        itemBefore: ra.itemBefore, blockerStatus: ra.blockerStatus, probeEnqueue: ra.probeEnqueue,
        observed: ra.observed, item: ra.item, metaLate: ra.metaLate, itemAfterMeta: ra.itemAfterMeta, drained: ra.drained, drainItem: ra.drainItem,
        samples: ra.samples, blocked: ra.blocked || null,
      },
      b: {
        label: rb.label, pid: rb.pid, diag: rb.diag, choice: rb.choice, refKey: rb.refKey,
        itemBefore: rb.itemBefore, blockerStatus: rb.blockerStatus, probeEnqueue: rb.probeEnqueue,
        observed: rb.observed, item: rb.item, metaLate: rb.metaLate, itemAfterMeta: rb.itemAfterMeta, drained: rb.drained, drainItem: rb.drainItem,
        samples: rb.samples, blocked: rb.blocked || null,
      },
    },
  }, null, 2))
  console.log(`[verify248] evidence -> ${evidenceFile}`)

  if (ra.blocked || rb.blocked) {
    console.log('\n[verify248] RESULT: BLOCKED - runtime truth not obtained (see BLOCKED lines above).')
    process.exitCode = 1
    return
  }

  // 若观察窗内目标任务已经离开 `queued`，说明占位任务没占住单飞 worker ——
  // 那是**没测成**，不是「修复无效」，必须如实标成 BLOCKED。
  const aQueued = ra.observed && ra.observed.status === 'queued'
  const bQueued = rb.observed && rb.observed.status === 'queued'
  if (!aQueued || !bQueued) {
    console.log('\n[verify248] RESULT: BLOCKED - the probe task left `queued` inside the observation ' +
      `window (a=${ra.observed && ra.observed.status} b=${rb.observed && rb.observed.status}); ` +
      'the blocker failed to hold the single-flight worker, so the queued-time criterion was never exercised.')
    process.exitCode = 1
    return
  }

  const truth = (rb.choice || ra.choice).probeCaption
  const probeId = (rb.choice || ra.choice).probeId
  const truthTitle = titleOf(truth)
  check('ground truth caption is non-empty', !!truth && truth.trim().length > 0,
    `probeMsg=${probeId} truth=${JSON.stringify(snippet(truth, 90))}`)
  check('both groups started from a clean ref (no pre-existing media_item)',
    ra.itemBefore.count === 0 && rb.itemBefore.count === 0,
    `a=${ra.itemBefore.count} b=${rb.itemBefore.count}`)

  // A 组（对照）：修复前的病态 —— 排队任务的下游条目在媒体库里**不存在**。
  check('A (control): probe task is still queued', aQueued,
    `status=${ra.observed && ra.observed.status}`)
  check('A (control): NO media_item for the ref while queued (the BUG-248 disease)',
    ra.item.count === 0,
    `rows=${ra.item.count} id=${ra.item.id}`)

  // B 组（实验）：修复后 —— 排队任务的下游条目**在库且无字节**。
  check('B (fixed): probe task is still queued', bQueued,
    `status=${rb.observed && rb.observed.status}`)
  check('B (fixed): media_item exists exactly once while queued',
    rb.item.count === 1, `rows=${rb.item.count} id=${rb.item.id}`)
  check('B (fixed): registered item has file_path === NULL (info yes, bytes no)',
    rb.item.count === 1 && rb.item.file_path === null,
    `id=${rb.item.id} file_path=${JSON.stringify(rb.item.file_path)}`)
  check('B (fixed): item title === truth caption first line (same ruler as the worker)',
    rb.itemAfterMeta.count === 1 && rb.itemAfterMeta.title === truthTitle,
    `got=${JSON.stringify(snippet(rb.itemAfterMeta.title, 80))} want=${JSON.stringify(snippet(truthTitle, 80))}` +
    ` (metaLate=${JSON.stringify(rb.metaLate && { atMs: rb.metaLate.atMs, status: rb.metaLate.status })})`)
  check('B (fixed): the title arrived while the task was STILL queued (no worker involved)',
    !!rb.metaLate && rb.metaLate.status === 'queued' && !!rb.metaLate.title,
    `metaLate=${JSON.stringify(rb.metaLate)}`)

  // 反向对照（活体证据）：证明这个隔离实例**真的在工作**，从而排除
  // 「环境坏了，所以两边的『没有』都不算数」这个假阴性解释。
  //
  // 判据刻意**不依赖时序**（前一版把「5s 内取到 caption」当活体证据，MTProto 慢一点就假红）：
  //   1. diag：已授权、链路活着、非 mock —— 实例拿的是真会话；
  //   2. 占位任务真的被 worker 领走（`running`）—— 队列与执行器真的在动；
  //   3. B 组自己的**条目标题逐字等于 MTProto caption** —— 真值确实从链路上取回来了。
  const diagLive = (r) =>
    !!r.diag && r.diag.available === true && r.diag.mock === false &&
    r.diag.link_alive === true && r.diag.session_phase === 'Authorized' &&
    r.blockerStatus === 'running'
  const liveA = diagLive(ra)
  const liveB = diagLive(rb) && !!rb.metaLate && !!rb.metaLate.title && rb.itemAfterMeta.title === truthTitle
  check('live instance: A booted an authorized, non-mock instance whose worker runs a real task', liveA,
    `diag=${JSON.stringify(ra.diag && { available: ra.diag.available, mock: ra.diag.mock, link_alive: ra.diag.link_alive, phase: ra.diag.session_phase })} blockerStatus=${ra.blockerStatus}`)
  check('live instance: B pulled a verbatim MTProto caption onto its own library row', liveB,
    `title=${JSON.stringify(snippet(rb.itemAfterMeta.title, 50))} blockerStatus=${rb.blockerStatus} blockerProgressBytes=${rb.blockerProgressBytes}`)

  const aFailed = aQueued && ra.item.count === 0 && liveA
  const bPassed = bQueued && rb.item.count === 1 && rb.item.file_path === null &&
    rb.itemAfterMeta.title === truthTitle && !!rb.metaLate && rb.metaLate.status === 'queued' && liveB

  console.log('\n[verify248] === SUMMARY ===')
  const failed = checks.filter((c) => !c.pass)
  console.log(`[verify248] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  if (aFailed && bPassed) {
    console.log('[verify248] VERDICT: runtime PASS - A(control) had no library entry while queued, ' +
      `B(fixed) had item id=${rb.item.id} with file_path=NULL at the same moment; the change is the cause.`)
    process.exitCode = 0
  } else if (!aFailed && bPassed) {
    console.log('[verify248] VERDICT: CONTRADICTION - A(control) also produced the queued entry. ' +
      'The control binary behaves differently from the documented disease; do NOT claim the fix works.')
    process.exitCode = 2
  } else if (aFailed && !bPassed && rb.item.count === 1) {
    console.log('[verify248] VERDICT: FIX NOT EFFECTIVE AT RUNTIME - A behaved as the disease, and ' +
      'B got the entry WITHOUT the title/kind it should have (or only after the task left the ' +
      'queue), i.e. enqueue-time registration/strengthening did not happen in this binary.')
    process.exitCode = 2
  } else {
    console.log('[verify248] VERDICT: BLOCKED - the isolated instance could not be shown live ' +
      '(authorized non-mock instance + worker actually running + the strengthened B row ' +
      'carrying its verbatim MTProto title); no verdict on the fix.')
    process.exitCode = 1
  }
}

main().catch((e) => {
  if (process.exitCode == null) process.exitCode = 1
  console.error('[verify248] aborted:', e && e.stack ? e.stack : String(e))
})
