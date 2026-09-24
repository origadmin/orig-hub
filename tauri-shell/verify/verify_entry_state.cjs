#!/usr/bin/env node
'use strict'

/**
 * `src/lib/entryState.ts`（BUG-170 单源派生）的**纯逻辑单测**。
 *
 * 零浏览器、零网络：用应用自带的 esbuild（vite 依赖，离线可用）把真实的 TS
 * 模块转译成 JS 后直接断言决策表 —— 保证测的就是产品代码本身，不是复制粘贴的
 * 副本。派生规则一旦被改动，这里先红。
 *
 * Usage:  node verify/verify_entry_state.cjs
 * Exit:   0 = all passed, 1 = at least one assertion failed
 */

const fs = require('node:fs')
const path = require('node:path')

let transform
try {
  ;({ transformSync: transform } = require('esbuild'))
} catch (_e) {
  console.error('[verify:entry-state] esbuild 不可用（node_modules 不完整？先 npm install）')
  process.exit(2)
}

const srcPath = path.join(__dirname, '..', 'src', 'lib', 'entryState.ts')
const js = transform(fs.readFileSync(srcPath, 'utf8'), { loader: 'ts', format: 'cjs' }).code

// 沙箱加载转译产物（模块是纯函数，无副作用）
const module_ = { exports: {} }
new Function('exports', 'module', js)(module_.exports, module_)
const { deriveEntryState } = module_.exports

let pass = 0
let fail = 0
/** @param {string} name @param {unknown} actual @param {unknown} expected */
function eq(name, actual, expected) {
  const ok = actual === expected
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- got=${actual} want=${expected}`}`)
}

const BASE = { source: 'tg', kind: 'video' }

// ── 决策表 ────────────────────────────────────────────────────────────────

// 1) tg-photo 代理语义：即时点亮，任何输入都 cached
eq('tg photo => cached (no bytes ever)', deriveEntryState({ ...BASE, kind: 'photo' }), 'cached')
eq(
  'tg photo => cached even with missing presence',
  deriveEntryState({ ...BASE, kind: 'photo', bytesPresence: 'missing' }),
  'cached',
)

// 2) 字节真值 present 唯一判「能播」
eq('present => cached', deriveEntryState({ ...BASE, bytesPresence: 'present' }), 'cached')
eq(
  'present beats stale prev',
  deriveEntryState({ ...BASE, bytesPresence: 'present', prev: 'caching' }),
  'cached',
)

// 3) 任务活跃压过一切（重跑已缓存条目不倒退）
eq('queued => caching', deriveEntryState({ ...BASE, taskStatus: 'queued' }), 'caching')
eq(
  'running + missing presence => caching (bytes not yet backfilled)',
  deriveEntryState({ ...BASE, bytesPresence: 'missing', taskStatus: 'running' }),
  'caching',
)

// 4) 缺字节：失败 = failed；其余 = bytesMissing（禁播 + 可重试）
eq(
  'missing + failed task => failed',
  deriveEntryState({ ...BASE, bytesPresence: 'missing', taskStatus: 'failed' }),
  'failed',
)
eq(
  'missing + interrupted => failed',
  deriveEntryState({ ...BASE, bytesPresence: 'missing', taskStatus: 'interrupted' }),
  'failed',
)
eq('missing alone => bytesMissing', deriveEntryState({ ...BASE, bytesPresence: 'missing' }), 'bytesMissing')
eq(
  'missing + cancelled => bytesMissing (cancelled is user-initiated, retryable)',
  deriveEntryState({ ...BASE, bytesPresence: 'missing', taskStatus: 'cancelled' }),
  'bytesMissing',
)

// 5) 过渡窗持有（BUG-170 核心）：终态事件不是字节事实，等快照源开口
eq(
  'factPending holds caching across task done',
  deriveEntryState({ ...BASE, taskStatus: 'done', prev: 'caching', factPending: true }),
  'caching',
)
eq(
  'factPending holds caching across task failed (until snapshot arrives)',
  deriveEntryState({ ...BASE, taskStatus: 'failed', prev: 'caching', factPending: true }),
  'caching',
)
eq(
  'factPending without prev falls through to failed',
  deriveEntryState({ ...BASE, taskStatus: 'failed', factPending: true }),
  'failed',
)
eq(
  'snapshot arrival (no pending) + failed task => failed',
  deriveEntryState({ ...BASE, taskStatus: 'failed', prev: 'caching', factPending: false }),
  'failed',
)

// 6) 静默兜底：DB 承诺 / 仅登记
eq('silent + downloadedFlag => cached', deriveEntryState({ ...BASE, downloadedFlag: true }), 'cached')
eq('silent, nothing => registered', deriveEntryState({ ...BASE }), 'registered')
eq(
  'silent + done task, no facts => registered (flag false, no bytes)',
  deriveEntryState({ ...BASE, taskStatus: 'done' }),
  'registered',
)
eq(
  'cleanup revert: silent, no pending, flag false, prev cached => registered',
  deriveEntryState({ ...BASE, prev: 'cached', downloadedFlag: false }),
  'registered',
)

// 非 tg 来源不享受 photo 代理
eq(
  'local photo missing => bytesMissing (proxy is tg-only)',
  deriveEntryState({ source: 'local', kind: 'photo', bytesPresence: 'missing' }),
  'bytesMissing',
)

console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)  ${srcPath}`)
process.exit(fail === 0 ? 0 : 1)
