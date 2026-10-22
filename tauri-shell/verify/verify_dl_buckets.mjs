#!/usr/bin/env node
/**
 * 下载域「树档」语义判据（BUG-377）。
 *
 * 用户 2026-10-22 原话：「全部下载 -> 已暂停没有看到暂停内容（失败、取消、错误），
 * **所有停止项都应该在里面**」。
 *
 * 旧实现把「已暂停」档写成 `status === 'paused'`（引擎侧）与 `return false`
 * （入库侧）⇒ 失败/取消/错误/中断**任何一档都看不见**：它们既不在「下载中」，
 * 也不在「已完成」，而「已暂停」又不收它们。用户看到的就是「内容消失了」。
 *
 * 本判据的写法：**不列举「应该包含谁」，而是断言分区完备且互斥** ——
 * 每个状态在 {running, paused, done} 三档里**恰好命中一档**。
 * 这一条同时抓「漏收」（某状态三档都不收 ⇒ 任何视图都看不到它）与
 * 「重复收」（同一行在两个档里各出现一次 ⇒ 用户以为有两个任务）。
 *
 * 纯逻辑、不需要浏览器/栈：直接 import 产品源码里的纯函数（Node 22 类型剥离）。
 * 因此它可以在任何时刻跑，不受 daemon/orig-tg 存活影响。
 *
 * 用法：
 *   node tauri-shell/verify/verify_dl_buckets.mjs
 *   node tauri-shell/verify/verify_dl_buckets.mjs --expect-legacy   # 反向证伪
 *
 * `--expect-legacy` 用**旧语义**（引擎 paused 档只收 paused、入库 paused 档恒 false）
 * 跑同一批断言，必须全红 —— 否则说明这批断言根本没在判「停止项可见」，
 * 只是自我复述。
 */

const LEGACY = process.argv.includes('--expect-legacy')

const dl = await import('../src/domains/download/dlBuckets.ts')
const ig = await import('../src/domains/download/ingestGroups.ts')

const BUCKETS = ['running', 'paused', 'done']

/** 被测实现（旧语义可切换，用于反向证伪）。 */
function engineIn(status, f) {
  if (LEGACY) {
    if (f === 'running') return ['downloading', 'queued', 'idle'].includes(status)
    if (f === 'paused') return status === 'paused'
    if (f === 'done') return status === 'completed'
    return true
  }
  return dl.engineInBucket(status, f)
}

function ingestIn(status, f) {
  if (LEGACY) {
    if (f === 'running') return status === 'queued' || status === 'running'
    if (f === 'paused') return false
    if (f === 'done') return status === 'done'
    return true
  }
  return ig.groupInBucket(status, f)
}

const ENGINE_STATUSES = ['idle', 'queued', 'downloading', 'paused', 'completed', 'error', 'cancelled', 'interrupted']
const CACHE_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted']

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── ① 分区完备且互斥（引擎） ──────────────────────────────────────────
// 「恰好一档」= 没有状态会从所有视图里消失，也没有状态被重复计两次。
const engineMissed = []
const engineDup = []
for (const s of ENGINE_STATUSES) {
  const hits = BUCKETS.filter((f) => engineIn(s, f))
  if (hits.length === 0) engineMissed.push(s)
  if (hits.length > 1) engineDup.push(`${s}->[${hits.join(',')}]`)
}
check(
  'B1 引擎任务：每个状态至少落在一个树档里（无「哪儿都看不到」）',
  engineMissed.length === 0,
  `missed=[${engineMissed.join(',')}] of ${ENGINE_STATUSES.length}`,
)
check(
  'B2 引擎任务：每个状态只落在一个树档里（无重复计数）',
  engineDup.length === 0,
  `dup=[${engineDup.join(',')}]`,
)

// ── ② 「已暂停」档 = 所有停止项（用户诉求逐字对照） ──────────────────
const ENGINE_STOPPED = ['paused', 'error', 'cancelled', 'interrupted']
const ENGINE_NOT_STOPPED = ['downloading', 'queued', 'idle', 'completed']
check(
  'B3 引擎「已暂停」档收全部停止项（paused/error/cancelled/interrupted）',
  ENGINE_STOPPED.every((s) => engineIn(s, 'paused')),
  ENGINE_STOPPED.map((s) => `${s}=${engineIn(s, 'paused')}`).join(' '),
)
check(
  'B4 引擎「已暂停」档不收在传/已完成（否则与另两档重复）',
  ENGINE_NOT_STOPPED.every((s) => !engineIn(s, 'paused')),
  ENGINE_NOT_STOPPED.map((s) => `${s}=${engineIn(s, 'paused')}`).join(' '),
)

// ── ③ 入库侧同构 ─────────────────────────────────────────────────────
const ingestMissed = []
const ingestDup = []
for (const s of CACHE_STATUSES) {
  const hits = BUCKETS.filter((f) => ingestIn(s, f))
  if (hits.length === 0) ingestMissed.push(s)
  if (hits.length > 1) ingestDup.push(`${s}->[${hits.join(',')}]`)
}
check(
  'B5 入库任务：每个状态至少落在一个树档里',
  ingestMissed.length === 0,
  `missed=[${ingestMissed.join(',')}] of ${CACHE_STATUSES.length}`,
)
check('B6 入库任务：每个状态只落在一个树档里', ingestDup.length === 0, `dup=[${ingestDup.join(',')}]`)
check(
  'B7 入库「已暂停」档收全部停止项（failed/cancelled/interrupted）',
  ['failed', 'cancelled', 'interrupted'].every((s) => ingestIn(s, 'paused')),
  ['failed', 'cancelled', 'interrupted'].map((s) => `${s}=${ingestIn(s, 'paused')}`).join(' '),
)
check(
  'B8 入库「已暂停」档不收在传/已完成',
  ['queued', 'running', 'done'].every((s) => !ingestIn(s, 'paused')),
  ['queued', 'running', 'done'].map((s) => `${s}=${ingestIn(s, 'paused')}`).join(' '),
)

// ── ④ 「全部」档必须仍是全集（否则停止项在 all 里也消失） ─────────────
check(
  'B9 引擎「全部」档含所有状态',
  ENGINE_STATUSES.every((s) => engineIn(s, 'all')),
  ENGINE_STATUSES.filter((s) => !engineIn(s, 'all')).join(',') || 'all covered',
)
check(
  'B10 入库「全部」档含所有状态',
  CACHE_STATUSES.every((s) => ingestIn(s, 'all')),
  CACHE_STATUSES.filter((s) => !ingestIn(s, 'all')).join(',') || 'all covered',
)

// ── ⑤ 侧栏徽标与列表同源（同一谓词 ⇒ 数出来的行数必须等于筛出来的行数） ──
// 这条防的是「徽标 0 行、列表 5 行」的分裂（三处同源纪律）。
const sample = ENGINE_STATUSES.map((s, i) => ({ id: `e${i}`, status: s }))
for (const f of BUCKETS) {
  const listed = sample.filter((d) => engineIn(d.status, f)).length
  const counted = LEGACY ? listed : dl.countEngineBucket(sample, f)
  check(`B11 引擎「${f}」档：徽标计数 = 列表行数`, counted === listed, `counted=${counted} listed=${listed}`)
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${LEGACY ? 'LEGACY ' : ''}PASS: ${passed}/${results.length}`)
if (LEGACY) {
  const red = results.filter((r) => !r.ok).length
  console.log(`LEGACY_EXPECTED_FAILURES: ${red}（必须 > 0，否则判据没有牙齿）`)
  process.exit(red > 0 ? 0 : 1)
}
process.exit(passed === results.length ? 0 : 1)
