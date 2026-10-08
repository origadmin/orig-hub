#!/usr/bin/env node
'use strict'

/**
 * 条件 B 的「缓存任务保活」驱动（临时工具，验收专用；用完删除）。
 *
 * 目的：条件 B（缓存中 + 面板关）要求**整段 ≥60s 窗口内库内始终存在活跃缓存任务**。
 * 单批 20 条约 145MB、本机 ~3s/条 ⇒ 一批仅够 ~60s；为杜绝「任务中途 done 导致 B 失效」，
 * 本驱动持续**预排队**（实测 POST 新 messageIds 会进入 `queued[]`，running 结束后无缝接续），
 * 保证 running 之后永远有排队批次 ⇒ 零间隙覆盖。
 *
 * 行为：
 *   - 每 TICK_MS 查一次 `GET /api/tg/cache/tasks`；令 ahead = (running?1:0) + queued.length。
 *   - ahead < DESIRED_AHEAD(2) ⇒ POST 下一批（首批 = team-lead 指定批次；其后从
 *     `GET /api/tg/stored?type=video&downloaded=0` 筛 5–40MB、去重后按 20 条切批）。
 *   - 全部动作写 `verify_shots/cache_stall/b_keepalive.json`（时间线，供报告引用）。
 *   - 出现停止文件 `_stop_keepalive` 或超过 MAX_SEC 即退出（**不自动取消**，取消由验收方收尾）。
 *
 * 环境变量：TG_URL / ORIG_VERIFY_OUT / STALL_CHAT_ID / STALL_KEEPALIVE_SEC / STALL_TICK_MS。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', 'verify_shots', 'cache_stall'),
)
const CHAT_ID = Number(process.env.STALL_CHAT_ID || -1001341930464)
const STOP_FILE = path.join(OUT, '_stop_keepalive')
const LOG_FILE = path.join(OUT, 'b_keepalive.json')
const MAX_SEC = Number(process.env.STALL_KEEPALIVE_SEC || 220)
const TICK_MS = Number(process.env.STALL_TICK_MS || 2000)
const BATCH_SIZE = Number(process.env.STALL_BATCH_SIZE || 20)
const DESIRED_AHEAD = Number(process.env.STALL_AHEAD || 2)
const MIN_BYTES = 5 * 1024 * 1024
const MAX_BYTES = 40 * 1024 * 1024

/** team-lead 指定的受控批次（首批，精确使用，不增不减）。 */
const BATCH1 = [
  208031, 206999, 208170, 207839, 207774, 207910, 208096, 206864, 206855, 206838, 207024, 207809,
  207673, 208147, 207951, 207717, 208083, 207330, 206903, 208010,
]

const usedIds = new Set(BATCH1)
const timeline = []
let batch1Used = false
let pool = null // 延迟拉取
let poolCursor = 0
const taskIds = []

function httpJson(method, url, body) {
  return new Promise((resolve) => {
    let payload = null
    if (body != null) payload = Buffer.from(JSON.stringify(body), 'utf8')
    const u = new URL(url)
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      timeout: 12000,
      headers: { 'Content-Type': 'application/json' },
    }
    if (payload) opts.headers['Content-Length'] = payload.length
    const req = http.request(opts, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        let json = null
        try {
          json = d ? JSON.parse(d) : null
        } catch (_e) {
          json = { _raw: d }
        }
        resolve({ status: res.statusCode || 0, json })
      })
    })
    req.on('error', (e) => resolve({ status: 0, json: { _err: String(e && e.message ? e.message : e) } }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: { _err: 'timeout' } })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function nowIso() {
  return new Date().toISOString()
}

function log(entry) {
  const e = { t: nowIso(), ...entry }
  timeline.push(e)
  console.log(`[ka] ${e.action}${e.detail ? ' ' + e.detail : ''}`)
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify({ startedAt: timeline[0] && timeline[0].t, timeline }, null, 2))
  } catch (_e) {
    /* ignore */
  }
}

async function getTasks() {
  const { status, json } = await httpJson('GET', `${TG}/api/tg/cache/tasks`)
  return { status, json: json || {} }
}

async function loadPool() {
  const { status, json } = await httpJson('GET', `${TG}/api/tg/stored?type=video&downloaded=0&limit=300`)
  const items = (json && json.items) || []
  pool = items
    .filter((i) => i && typeof i.size === 'number' && i.size >= MIN_BYTES && i.size <= MAX_BYTES)
    .map((i) => i.messageId)
    .filter((id) => !usedIds.has(id))
  log({ action: 'POOL_LOADED', detail: `http=${status} eligible=${pool.length}` })
}

function nextBatchIds() {
  if (!batch1Used) {
    batch1Used = true
    return BATCH1.slice()
  }
  if (!pool) return null
  const ids = []
  while (ids.length < BATCH_SIZE && poolCursor < pool.length) {
    const id = pool[poolCursor++]
    if (!usedIds.has(id)) {
      usedIds.add(id)
      ids.push(id)
    }
  }
  return ids.length ? ids : null
}

async function enqueueNext() {
  if (!batch1Used && !pool) {
    // 首批不需要 pool；但后续批次需要，提前加载
  }
  const ids = nextBatchIds()
  if (!ids || !ids.length) {
    log({ action: 'POOL_EXHAUSTED', detail: 'no more 5-40MB uncached ids' })
    return false
  }
  const { status, json } = await httpJson('POST', `${TG}/api/tg/cache/tasks`, {
    chatId: CHAT_ID,
    messageIds: ids,
  })
  if (status >= 200 && status < 300 && json && json.id != null) {
    taskIds.push(json.id)
    log({
      action: 'ENQUEUE',
      detail: `http=${status} id=${json.id} n=${ids.length} status=${json.status}`,
      id: json.id,
      messageIds: ids,
      respStatus: json.status,
    })
    return true
  }
  log({ action: 'ENQUEUE_FAILED', detail: `http=${status} ${JSON.stringify(json).slice(0, 200)}` })
  return false
}

async function tick() {
  const { status, json } = await getTasks()
  const task = json.task || null
  const queued = json.queued || []
  const running = task && (task.status === 'running' || task.status === 'queued')
  const ahead = (running ? 1 : 0) + queued.length
  log({
    action: 'TICK',
    detail:
      `http=${status} running=${running ? task.id + ':' + task.status + ' ' + (task.done || 0) + '/' + (task.total || 0) : 'none'}` +
      ` queued=${queued.map((q) => q.id).join(',') || '-'} ahead=${ahead}`,
    task: task ? { id: task.id, status: task.status, done: task.done, total: task.total } : null,
    queued: queued.map((q) => ({ id: q.id, total: q.total })),
  })
  if (ahead < DESIRED_AHEAD) {
    if (!pool) await loadPool()
    // 若首批尚未用，先补一批；不足则继续
    while ((ahead + taskIds.length >= 0) && ahead < DESIRED_AHEAD) {
      const ok = await enqueueNext()
      if (!ok) break
      // 简单重查以刷新 ahead
      const again = await getTasks()
      const t2 = again.json.task
      const q2 = again.json.queued || []
      const r2 = t2 && (t2.status === 'running' || t2.status === 'queued')
      const newAhead = (r2 ? 1 : 0) + q2.length
      if (newAhead <= ahead) break
      break
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE)
  console.log(`[ka] keepalive start; TG=${TG} chat=${CHAT_ID} max=${MAX_SEC}s tick=${TICK_MS}ms`)
  log({ action: 'START', detail: `TG=${TG} chat=${CHAT_ID} max=${MAX_SEC}s` })
  const deadline = Date.now() + MAX_SEC * 1000
  while (Date.now() < deadline) {
    if (fs.existsSync(STOP_FILE)) {
      log({ action: 'STOP', detail: 'stop file detected' })
      break
    }
    try {
      await tick()
    } catch (e) {
      log({ action: 'TICK_ERROR', detail: String(e && e.message ? e.message : e) })
    }
    await new Promise((r) => setTimeout(r, TICK_MS))
  }
  log({ action: 'END', detail: `tasks=${JSON.stringify(taskIds)}` })
  console.log(`[ka] keepalive end; taskIds=${JSON.stringify(taskIds)}`)
}

main()
