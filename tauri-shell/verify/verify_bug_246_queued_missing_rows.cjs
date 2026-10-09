#!/usr/bin/env node
'use strict'

/**
 * BUG-246 根因复核 / 待人工验收项：排队任务的消息元数据是否落库。
 *
 * ## 它测的是「病」，不是「药」
 *
 * BUG-246 的病根：`cache_task` 的队列标题读的是 `media_message.caption`
 * （`store.rs:502 message_captions_for_channels`），但该行历史上只在 worker **启动
 * 任务时**由 `IngestCtx::prepare()` 补写。排队任务不启动 worker ⇒ 行整条缺失 ⇒
 * 标题恒 None ⇒ 前端退回裸频道名。
 *
 * 所以本脚本的判据是「**排队任务的消息行是否齐全**」：
 *
 *   - 修复未生效（含引擎还是旧二进制的当下）：缺行 ⇒ 判据 FAIL —— 这是**病还在**，
 *     属于预期，用来证明「这个幽灵 BUG 的病根确实存在且可被观测」。
 *   - 修复生效后（重启 + **新入队**一批任务）：不缺行 ⇒ 判据 PASS。
 *
 * 换句话说：**这是给「重启后待人工验收」留的一把尺子**，不是当下的通过凭证。
 *
 * ## 只读铁律
 *
 * 绝不写库。用 node:sqlite 的 `readOnly: true` 打开；脚本内置写保护自检——
 * 若某天被人改成可写，自检会先红出来。
 *
 * 用法：
 *   node verify_bug_246_queued_missing_rows.cjs
 *   ORIG_TG_DB=<其它库路径> node verify_bug_246_queued_missing_rows.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

/** 默认取 live 库（Windows %APPDATA%；其它平台退到 HOME 下同名目录）。 */
function defaultDbPath() {
  const base = process.env.APPDATA || process.env.HOME || ''
  if (!base) return null
  return path.join(base, 'com.origadmin.orighub', 'tg', 'store.db')
}

const DB_PATH = process.env.ORIG_TG_DB || defaultDbPath()

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

/**
 * 把 cache_task.items（JSON 数组）解析成消息号数组；坏数据视为空数组而非崩溃。
 *
 * 超出安全整数范围的 id 直接报错而不是静默丢精度：丢精度的后果是去查一个**不存在
 * 的消息号**，于是「缺行」永远为真 —— 那会让本脚本变成一条永远红（或永远绿）的
 * 假证据，正是本仓最忌讳的东西。
 */
function parseItems(raw) {
  let v
  try {
    v = JSON.parse(raw == null ? '[]' : String(raw))
  } catch (_err) {
    return []
  }
  if (!Array.isArray(v)) return []
  return v.map(Number).filter((x) => Number.isFinite(x)).map((x) => {
    if (!Number.isSafeInteger(x)) {
      throw new RangeError(`message id ${x} exceeds Number.MAX_SAFE_INTEGER`)
    }
    return x
  })
}

function main() {
  console.log('[verify] === BUG-246 queued-task metadata probe (read-only) ===')
  if (!DB_PATH) {
    console.error('[verify] cannot resolve the db path: set ORIG_TG_DB')
    process.exit(1)
  }
  console.log('[verify] db:', DB_PATH)
  if (!fs.existsSync(DB_PATH)) {
    console.error('[verify] db not found:', DB_PATH)
    process.exit(1)
  }

  // readOnly:true —— 这一行是本脚本的安全边界，去掉它脚本就不再是「观测」而是「改写」。
  const db = new DatabaseSync(DB_PATH, { readOnly: true })

  let wroteAnyway = false
  try {
    db.exec('CREATE TABLE _qa_write_probe_should_never_succeed (x INTEGER)')
    wroteAnyway = true
  } catch (err) {
    console.log('[verify] write guard: OK - writes refused ->', String(err && err.message).slice(0, 90))
  }
  check('read-only guarantee (a write must fail)', !wroteAnyway,
    wroteAnyway ? '!! the db accepted a write - this probe is dangerous' : 'CREATE TABLE rejected')

  const has = (sql) => {
    try {
      db.prepare(sql).get()
      return true
    } catch (_err) {
      return false
    }
  }
  check('cache_task table present', has('SELECT 1 FROM cache_task LIMIT 1'))
  check('media_message table present', has('SELECT 1 FROM media_message LIMIT 1'))

  const statusRows = db.prepare(
    'SELECT status, COUNT(*) AS c FROM cache_task GROUP BY status ORDER BY c DESC',
  ).all()
  console.log('[verify] cache_task status counts:', JSON.stringify(statusRows))

  // group_id 是 TG 的 int64（如 14328781992246888 > Number.MAX_SAFE_INTEGER），
  // node:sqlite 默认按 number 取会直接抛 RangeError。它只用于展示，CAST 成 TEXT 最稳。
  const queued = db.prepare(
    'SELECT id, chat_id, CAST(group_id AS TEXT) AS group_id, item_key, items ' +
      "FROM cache_task WHERE status='queued' ORDER BY id DESC",
  ).all()
  console.log(`[verify] queued tasks = ${queued.length}`)

  const existsStmt = db.prepare(
    'SELECT 1 AS hit FROM media_message WHERE message_id = ? LIMIT 1',
  )

  let totalMsgs = 0
  let totalMissing = 0
  const perTask = []
  console.log('[verify] per-task breakdown (queued):')
  console.log('[verify]   task           chat_id      group_id           msgs  missing  missing_ids(head)')
  for (const t of queued) {
    const ids = parseItems(t.items)
    const missing = []
    for (const mid of ids) {
      totalMsgs += 1
      if (!existsStmt.get(mid)) {
        totalMissing += 1
        missing.push(mid)
      }
    }
    perTask.push({ id: t.id, chat: t.chat_id, group: t.group_id, n: ids.length, missing })
    console.log(
      `[verify]   ${String(t.id).padStart(5)}  ${String(t.chat_id).padStart(16)}  ` +
        `${String(t.group_id).padStart(18)}  ${String(ids.length).padStart(4)}  ` +
        `${String(missing.length).padStart(7)}  ${JSON.stringify(missing.slice(0, 10))}`,
    )
  }

  const pct = totalMsgs ? ((100 * totalMissing) / totalMsgs).toFixed(1) : '0.0'
  console.log('[verify] ---')
  console.log(`[verify] queued messages referenced : ${totalMsgs}`)
  console.log(`[verify] missing in media_message   : ${totalMissing}`)
  console.log(`[verify] missing rate               : ${pct}%`)

  const nowMissing = totalMissing > 0
  check('queued tasks have complete message metadata', !nowMissing,
    `missing ${totalMissing}/${totalMsgs} (${pct}%); ` +
      (nowMissing
        ? 'queued tasks still lack rows -> this is the BUG-246 disease (expected while the old engine is running)'
        : 'every queued message has a media_message row -> enqueue-time registration is working'))

  db.close()

  const failed = checks.filter((c) => !c.pass)
  console.log('\n[verify] === SUMMARY ===')
  console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  if (failed.length) {
    console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
    console.log('[verify] NOTE: before the engine restart this check legitimately fails -')
    console.log('[verify]       it measures the disease, not the cure. Re-run after restarting')
    console.log('[verify]       the app/engine and enqueueing a NEW group to confirm the fix.')
    process.exitCode = 2
  } else {
    console.log('[verify] ALL CHECKS PASSED')
  }
}

main()
