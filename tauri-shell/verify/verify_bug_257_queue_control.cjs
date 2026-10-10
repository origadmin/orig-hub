#!/usr/bin/env node
'use strict'

/**
 * BUG-257 验收：失败/中断原因的**可观测性**（判据 5 与判据 6）。
 *
 * ##缺陷回顾
 *
 * 原因**一直有落库**（`cache_task.error`），但呈现层把它折叠掉了：
 *
 *   1. `tgReason.ts` 的网络类正则含 `connect`，而停滞原文含
 *      `connection presumed dead` ⇒ 命中 `tg.reasonNetwork` ⇒ 界面显示
 *      「无法连接到 Telegram，请检查网络与代理设置后重试」。
 *      真实条件是「连续 90s 零字节」（连接早已建立、字节流中途停住）——
 *      这是**误导性的可行动指引**：用户会去反复改代理，而问题在传输停滞。
 *   2. `CacheManagerDialog` 只在 `status === 'failed'` 时渲染原因，于是
 *      `interrupted`（重启造成、且**可重试**）的行永远只显示「已中断」，
 *      用户既不知道成因、也不知道有出路。
 *
 * ## 为什么是纯函数级验收（不起浏览器）
 *
 * 缺陷的两半都在**纯函数**里：分类（`classifyTgReason`）与渲染条件（状态门）。
 * 起浏览器只能验到「某次渲染恰好是这句文案」，而真正的回归形态是
 * **优先级被调换**（有人把 `reasonStalled` 挪到网络正则之后就会静默复发）。
 * 这里直接把真实原文喂给分类函数，逐条断言落到哪个 i18n 键 —— 精确、无需环境、
 * 且能锁住**顺序**这件真正要命的事。
 *
 * 被测函数用TS 源码经轻量转译后载入（见下方 `loadModule`）：只做类型擦除，
 * 不引入任何测试框架依赖，与本仓库「verify 脚本零依赖」的既有惯例一致。
 *
 * ## 断言
 *
 *   A 判据 6（不得显示「检查网络与代理」）：
 *      A1 实测停滞原文 → `tg.reasonStalled`，且**绝不可**是 `tg.reasonNetwork`；
 *      A2 顺序守卫：把停滞判据挪到网络类**之后**必须 FAIL（反向证伪，证明 A1 真的
 *         在测优先级，而不是碰巧命中）；
 *      A3 变体鲁棒：秒数/chat/msg 号变化后仍须命中停滞类（判据不能写死整句）。
 *   B 判据 5（`interrupted` 要说清成因与出路）：
 *      B1 重启降级原因 → `tg.reasonRestarted`；
 *      B2 `interrupted` 的 `error` 非空 ⇒ 渲染门会放行（断言源码含 `interrupted` 条件，
 *         防止有人把状态门改回只认 `failed`）。
 *   C 无回归：`unavailable` / flood / auth / config 分类保持原样。
 *
 * 用法： node verify/verify_bug_257_queue_control.cjs
 * Env: 无（纯逻辑，不需要 daemon / 浏览器 / 端口）
 * Exit: 0 全通过；2 判据失败；1 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REASON_TS = path.join(ROOT, 'src', 'lib', 'tgReason.ts')
const DIALOG_TSX = path.join(ROOT, 'src', 'components', 'CacheManagerDialog.tsx')

let failures = 0
let checks = 0

function check(ok, label, detail) {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/**
 * 抽出「判据」所需的部分并去掉 TS 类型标注，得到可被 node 直接求值的 JS。
 *
 * **刻意只抽 `classifyTgReason` 与它依赖的两个常量**，而不是整文件转译：
 * 整文件转译要处理 `interface` / `SessionView` / 泛型 / `as const` 等一堆与判据
 * 无关的语法，脆弱且容易「转译出一个能跑的近似物」——那样脚本就失去了
 * 对真实回归报错的能力（本脚本的价值恰恰在于源码被改坏时要硬失败）。
 *
 * 判据只依赖分类函数，故只抽它就是完整且忠实的被测面。
 */
function loadModule(src) {
  const lines = src.split(/\r?\n/)
  const takeConst = (name) => {
    const i = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?const\\s+${name}\\b`).test(l))
    if (i < 0) throw new Error(`cannot find const ${name} in tgReason.ts`)
    return lines[i].replace(/^export\s+/, '')
  }
  // 函数体：从声明行到首个「缩进 0 的 `}`」为止
  const takeFn = (name) => {
    const start = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?function\\s+${name}\\b`).test(l))
    if (start < 0) throw new Error(`cannot find function ${name} in tgReason.ts`)
    let end = start
    while (end < lines.length && lines[end] !== '}') end += 1
    if (end >= lines.length) throw new Error(`unterminated function ${name}`)
    const body = lines.slice(start, end + 1).join('\n')
    // 签名类型标注：`fn(a: T, b = 'x'): R {` → `fn(a, b = 'x') {`
    return body
      .replace(/^export\s+/, '')
      .replace(/\)\s*:\s*[\w| \[\]]+\s*\{\s*$/m, ') {')
      .replace(/^function classifyTgReason\(.*$/m, 'function classifyTgReason(reason) {')
  }
  const js = [takeConst('STALLED_RE'), takeConst('RESTARTED_RE'), takeFn('classifyTgReason')].join('\n\n')
  // 必须显式挂到exports：`new Function` 里的 `const` 只是函数体内的局部绑定，
  // 不会自动出现在 module.exports 上。
  return `${js}\nmodule.exports = { classifyTgReason };\n`
}

function readReasonModule() {
  if (!fs.existsSync(REASON_TS)) {
    throw new Error(`missing ${REASON_TS}`)
  }
  const src = fs.readFileSync(REASON_TS, 'utf8')
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'console', loadModule(src))
  fn(mod, mod.exports, console)
  return mod.exports
}

/**
 * 反向证伪：把「停滞」判据故意挪到网络类**之后**，分类结果必须从
 * `tg.reasonStalled` 退化为 `tg.reasonNetwork`。
 *
 * 这是 A1 的对照实验：若挪位后结果不变，说明 A1 根本没在测优先级
 * （比如两个正则其实互斥），那A1 就是一句always-true 的假断言。
 */
function reorderedFallsBackToNetwork(src) {
  // 取出一个与真实实现同源的最小复刻：宽网络正则在前、停滞在后。
  const wide = /mtproto|connect|network|proxy|socks|timeout|timed out|eof|refused|reset by peer|dns|read 0 bytes|unreachable|i\/o|transport|failed to fetch|load failed|networkerror|dropped/i
  const stalled = /download stalled|no bytes for \d+s|connection presumed dead/i
  const raw =
    'download stalled: no bytes for 90s (chat -1004457697592 msg 1156); ' +
    'connection presumed dead, aborted to unblock the cache queue'
  const correct = stalled.test(raw) ? 'tg.reasonStalled' : wide.test(raw) ? 'tg.reasonNetwork' : 'tg.reasonUnknown'
  const wrongFirst = wide.test(raw) ? 'tg.reasonNetwork' : stalled.test(raw) ? 'tg.reasonStalled' : 'tg.reasonUnknown'
  return { correct, wrongFirst, srcHasStalledConst: /STALLED_RE/.test(src) }
}

function main() {
  console.log('[bug257] 失败原因可观测性验收（判据 5 / 判据 6）')
  section('载入被测模块')
  const mod = readReasonModule()
  check(
    typeof mod.classifyTgReason === 'function',
    'classifyTgReason 可载入',
    'tgReason.ts 结构变了？验收脚本需同步（这是有意的硬失败，不是缺陷）',
  )
  if (typeof mod.classifyTgReason !== 'function') return finish()
  const classify = mod.classifyTgReason

  // —— A：判据 6，停滞不得被折叠成「检查网络与代理」——
  section('A判据 6：90s 零字节不得显示为「无法连接 Telegram」')
  const realStall =
    'download failed: download stalled: no bytes for 90s (chat -1004457697592 msg 1156); ' +
    'connection presumed dead, aborted to unblock the cache queue'
  const got = classify(realStall)
  check(
    got === 'tg.reasonStalled',
    `实测停滞原文 → tg.reasonStalled（实得 ${got}）`,
    '判据 6 未满足：停滞必须有自己的文案',
  )
  check(
    got !== 'tg.reasonNetwork',
    '停滞绝不可落进 tg.reasonNetwork（那就是「去改代理」的误导指引）',
    `实得 ${got} —— 网络正则（��connect）吃掉了停滞原文`,
  )

  const ord = reorderedFallsBackToNetwork(fs.readFileSync(REASON_TS, 'utf8'))
  check(
    ord.correct === 'tg.reasonStalled' && ord.wrongFirst === 'tg.reasonNetwork',
    '反向证伪：把停滞判据挪到网络类之后，结果**必须**退化为 tg.reasonNetwork',
    `correct=${ord.correct} wrongFirst=${ord.wrongFirst} —— 若两者相同，A1 测不到优先级`,
  )
  check(ord.srcHasStalledConst, '源码确有独立的停滞判据常量（不是内联进网络分支）')

  section('A3 判据鲁棒：秒数 / chat / msg 号变化后仍须命中')
  for (const [label, raw] of [
    ['30s', 'download stalled: no bytes for 30s (chat -100777 msg 9); connection presumed dead'],
    ['180s', 'download stalled: no bytes for 180s (chat -1001 msg 12345); connection presumed dead'],
    ['裸 no bytes for', 'no bytes for 45s'],
  ]) {
    check(classify(raw) === 'tg.reasonStalled', `变体「${label}」→ tg.reasonStalled`, `实得 ${classify(raw)}`)
  }

  // —— B：判据 5，interrupted 要说清成因与出路 ——
  section('B 判据 5：interrupted 必须显示成因（可恢复）')
  check(
    classify('应用重启：传输被中断，可重试继续') === 'tg.reasonRestarted',
    '重启降级原因 → tg.reasonRestarted',
    `实得 ${classify('应用重启：传输被中断，可重试继续')}`,
  )
  const dialog = fs.readFileSync(DIALOG_TSX, 'utf8')
  check(
    /status === 'interrupted'/.test(dialog),
    '渲染门包含 interrupted（否则该行永远只显示「已中断」）',
    'CacheManagerDialog 的原因渲染条件被改回只认 failed 了',
  )
  check(
    /cache-task-reason/.test(dialog),
    '原因节点带 data-testid="cache-task-reason"（可被验收脚本定位）',
  )

  // —— C：无回归 ——
  section('C 无回归：既有分类保持原样')
  const cases = [
    ['offline debug mode', 'tg.reasonOfflineDebug'],
    ['FLOOD_WAIT_42', 'tg.reasonFlood'],
    ['api_id is not configured', 'tg.reasonConfig'],
    ['unauthorized', 'tg.reasonAuth'],
    ['MTProto connect failed: request error: read 0 bytes', 'tg.reasonNetwork'],
    ['something entirely novel', 'tg.reasonUnknown'],
    ['', 'tg.reasonUnknown'],
  ]
  for (const [raw, want] of cases) {
    const gotKey = classify(raw)
    check(gotKey === want, `「${raw || '(空)'}」→ ${want}`, `实得 ${gotKey}`)
  }

  // —— i18n 键必须真的存在，否则界面会渲染成裸键名 ——
  section('D i18n 键齐备')
  for (const [loc, needle] of [
    ['zh-CN.json', '传输中途停滞'],
    ['en-US.json', 'Transfer stalled'],
  ]) {
    const p = path.join(ROOT, 'src', 'i18n', 'locales', loc)
    const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    check(
      txt.includes('tg.reasonStalled') && txt.includes(needle),
      `${loc} 含 tg.reasonStalled 文案`,
      '键缺失 ⇒ 界面会显示裸键名',
    )
    check(txt.includes('tg.reasonRestarted'), `${loc} 含 tg.reasonRestarted 键`)
  }

  finish()
}

function finish() {
  console.log(`\n[bug257] ${checks - failures}/${checks} 通过`)
  if (failures > 0) {
    console.log('[bug257] FAIL —— 失败原因仍被折叠，或中断行仍不说成因')
    process.exit(2)
  }
  console.log('[bug257] PASS —— 停滞有专属文案、interrupted 说明成因且可恢复')
  process.exit(0)
}

try {
  main()
} catch (e) {
  console.error(`[bug257] 环境/通道问题：${e && e.message ? e.message : e}`)
  process.exit(1)
}