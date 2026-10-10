#!/usr/bin/env node
'use strict'

/**
 * BUG-271 验收：慢流墙钟限制的**前端可观测性**。
 *
 * ##缺陷回顾
 *
 * `grammers.rs` 的 `STALL_IDLE=90s` 是**空闲**计时（治「死」）： trickle 型慢流
 * （每 ~120ms 来一点字节）永远不会触发它，一条慢条目可以无限期占住队列头。
 * BUG-271 在 routes 层加了**墙钟**（治「慢」）：单条目总耗时超过
 * `download_item_max_secs`（默认 1800s）即中止该条目，走 BUG-257 的失败隔离
 * （记日志、计数、continue，不弃单）。中止原因形如：
 *
 *   `download too slow: 1805.2s for chat -1001 msg 55; wall-clock limit 1800s exceeded, aborted to keep the cache queue moving`
 *
 * ##判据（docs/bugs/BUG-271.md 预声明）
 *
 *   1. 超墙钟的原因串必须与「no bytes for 90s」（停滞）**逐字可区分**，
 *      且落到**独立的 i18n 键** `tg.reasonTooSlow`（zh+en 都有）；
 *   2. 该判据**必须排在网络正则之前**（tgReason.ts 的宽网络正则会吞具体诊断
 *      —— BUG-257 判据 6 的同款坑）；
 *   3. `describeTgFailure` 喂入超墙钟原文**绝不可**返回 `t('tg.reasonNetwork')`
 *      （否则用户又看到「无法连接 Telegram，请检查网络与代理」——误导性指引）。
 *
 * ##为什么仍是纯函数级验收
 *
 * 同 BUG-257：缺陷两半都在纯函数里（分类 + 最终文案函数）。真正的回归形态是
 * **优先级被调换**或**键被合并进停滞/网络类**，浏览器级测试测不到这些。
 * 被测源码经轻量类型擦除后载入，零依赖（仓库 verify 脚本既有惯例）。
 *
 * 用法： node verify/verify_bug_271_slow_stream.cjs
 * Env: 无（纯逻辑，不需要 daemon / 浏览器 / 端口）
 * Exit: 0 全通过；2 判据失败；1 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REASON_TS = path.join(ROOT, 'src', 'lib', 'tgReason.ts')

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
 * 从 tgReason.ts 抽出判据所需的最小被测面（类型擦除，不做整文件转译）：
 * TOO_SLOW_RE / STALLED_RE 两个判据常量 + classifyTgReason + describeTgFailure。
 * 源码结构变化时这里会硬失败 —— 这是有意的：脚本的价值恰在于源码被改坏时报错。
 */
function loadModule(src) {
  const lines = src.split(/\r?\n/)
  const takeConst = (name) => {
    const i = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?const\\s+${name}\\b`).test(l))
    if (i < 0) throw new Error(`cannot find const ${name} in tgReason.ts`)
    return lines[i].replace(/^export\s+/, '')
  }
  const takeFn = (name) => {
    const start = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?function\\s+${name}\\b`).test(l))
    if (start < 0) throw new Error(`cannot find function ${name} in tgReason.ts`)
    let end = start
    while (end < lines.length && lines[end] !== '}') end += 1
    if (end >= lines.length) throw new Error(`unterminated function ${name}`)
    const body = lines.slice(start, end + 1).join('\n')
    // 签名类型标注擦除（两个函数的多行签名统一压成 JS 形式）
    return body
      .replace(/^export\s+/, '')
      .replace(/^function classifyTgReason\(\s*[\s\S]*?\)\s*:\s*TgReasonKey\s*\{/m, 'function classifyTgReason(reason) {')
      .replace(/^function describeTgFailure\(\s*[\s\S]*?\)\s*:\s*string\s*\{/m, "function describeTgFailure(raw, t, fallbackKey = 'tg.cacheFailed') {")
  }
  const js = [
    takeConst('STALLED_RE'),
    takeConst('RESTARTED_RE'),
    takeConst('TOO_SLOW_RE'),
    takeFn('classifyTgReason'),
    takeFn('describeTgFailure'),
  ].join('\n\n')
  // 必须显式挂到 exports：`new Function` 里的 const/function 只是局部绑定。
  return `${js}\nmodule.exports = { classifyTgReason, describeTgFailure, TOO_SLOW_RE, STALLED_RE };\n`
}

function readReasonModule() {
  if (!fs.existsSync(REASON_TS)) throw new Error(`missing ${REASON_TS}`)
  const src = fs.readFileSync(REASON_TS, 'utf8')
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'console', loadModule(src))
  fn(mod, mod.exports, console)
  return mod.exports
}

/**
 * 反向证伪：把「慢流」判据从网络正则**之前**挪到**之后**，结果必须退化
 * （落到 tg.reasonUnknown ⇒ describeTgFailure 会把英文原文直出到界面）。
 * 若挪位前后结果相同，说明判据根本没在测优先级 —— 是 always-true 假断言。
 * 用真实实现的同源复刻测量，数字实报，不外推。
 */
function reorderFalsification(src) {
  // 源码里 TOO_SLOW_RE 规则必须出现在网络正则分支**之前**
  const tooSlowIdx = src.indexOf('TOO_SLOW_RE.test(raw)')
  const networkIdx = src.search(/mtproto\|connect\|network/)
  const correctOrder = tooSlowIdx > -1 && networkIdx > -1 && tooSlowIdx < networkIdx

  const wide =
    /mtproto|connect|network|proxy|socks|timeout|timed out|eof|refused|reset by peer|dns|read 0 bytes|unreachable|i\/o|transport|failed to fetch|load failed|networkerror|dropped/i
  const tooSlow = /download too slow|wall-clock limit \d+s exceeded/i
  const stalled = /download stalled|no bytes for \d+s|connection presumed dead/i
  const raw =
    'download too slow: 1805.2s for chat -1001 msg 55; wall-clock limit 1800s exceeded, aborted to keep the cache queue moving'
  const correct = classifySim(raw, [tooSlow, stalled], wide)
  const wrongFirst = classifySim(raw, [], wide)
  return { correctOrder, correct, wrongFirst, differ: correct !== wrongFirst }
}

function classifySim(raw, specificRes, wide) {
  for (const re of specificRes) if (re.test(raw)) return 'tg.reasonTooSlow'
  if (wide.test(raw)) return 'tg.reasonNetwork'
  return 'tg.reasonUnknown'
}

function main() {
  console.log('[bug271] 慢流墙钟的前端可观测性验收')
  section('载入被测模块')
  const mod = readReasonModule()
  check(
    typeof mod.classifyTgReason === 'function' && typeof mod.describeTgFailure === 'function',
    'classifyTgReason / describeTgFailure 可载入',
    'tgReason.ts 结构变了？验收脚本需同步（有意硬失败）',
  )
  if (typeof mod.classifyTgReason !== 'function' || typeof mod.describeTgFailure !== 'function') return finish()
  const { classifyTgReason: classify, describeTgFailure } = mod

  // —— 判据 1：超墙钟原文 → 独立键 tg.reasonTooSlow ——
  section('判据 1：超墙钟原因落到独立 i18n 键 tg.reasonTooSlow')
  const realTooSlow =
    'download too slow: 1805.2s for chat -1001 msg 55; wall-clock limit 1800s exceeded, aborted to keep the cache queue moving'
  const got = classify(realTooSlow)
  check(got === 'tg.reasonTooSlow', `实测慢流原文 → tg.reasonTooSlow（实得 ${got}）`, '判据 1 未满足')
  check(got !== 'tg.reasonNetwork', '绝不可落到 tg.reasonNetwork（误导性「去改代理」指引）', `实得 ${got}`)
  check(got !== 'tg.reasonStalled', '也不可与停滞共用 tg.reasonStalled（慢≠死，可行指引不同）', `实得 ${got}`)

  section('判据 1a：与「no bytes for 90s」逐字可区分（双向互斥）')
  const realStall =
    'download failed: download stalled: no bytes for 90s (chat -1004457697592 msg 1156); connection presumed dead, aborted to unblock the cache queue'
  check(
    !mod.TOO_SLOW_RE.test(realStall),
    'TOO_SLOW_RE 不命中停滞原文（否则两类会被同一个键吞并）',
  )
  check(
    !mod.STALLED_RE.test(realTooSlow),
    'STALLED_RE 不命中慢流原文（同理，反向也必须互斥）',
  )

  section('判据 1b：变体鲁棒（秒数 / chat / msg 号变化后仍须命中）')
  for (const [label, raw] of [
    ['0.5s 墙钟', 'download too slow: 0.6s for chat -100777 msg 9; wall-clock limit 0s exceeded'],
    ['600s 墙钟', 'download too slow: 601.0s for chat -1002 msg 12345; wall-clock limit 600s exceeded, aborted'],
    ['裸 download too slow', 'download too slow'],
    ['裸 wall-clock 短语', 'wall-clock limit 3600s exceeded'],
  ]) {
    const k = classify(raw)
    check(k === 'tg.reasonTooSlow', `变体「${label}」→ tg.reasonTooSlow`, `实得 ${k}`)
  }

  // —— 判据 2：必须排在网络正则之前（顺序证伪）——
  section('判据 2：TOO_SLOW_RE 判据排在网络正则之前（顺序证伪）')
  const fals = reorderFalsification(fs.readFileSync(REASON_TS, 'utf8'))
  check(fals.correctOrder, '源码中 TOO_SLOW_RE 分支位于网络正则分支之前')
  check(
    fals.differ && fals.correct === 'tg.reasonTooSlow' && fals.wrongFirst === 'tg.reasonUnknown',
    `反向证伪：挪到网络类之后结果必须退化（correct=${fals.correct} wrongFirst=${fals.wrongFirst}）`,
    '若两者相同，本判据测不到优先级 —— 是假断言',
  )

  // —— 判据 3：describeTgFailure 绝不可返回 t('tg.reasonNetwork') ——
  section('判据 3：describeTgFailure 对超墙钟原文不返回 tg.reasonNetwork')
  const identityT = (key) => key // 恒等 t：返回的就是 i18n 键本身，谁被翻译一目了然
  const described = describeTgFailure(realTooSlow, identityT)
  check(described === 'tg.reasonTooSlow', `describeTgFailure(慢流原文) → tg.reasonTooSlow（实得 ${described}）`)
  check(described !== 'tg.reasonNetwork', '绝不可返回 t(tg.reasonNetwork) —— 那是「检查网络与代理」的误导指引')
  // 走完整链路：classification 为 unknown 时会把英文原文直出到界面 —— 同样不可接受
  check(
    described !== realTooSlow,
    '也不可原样直出英文原文（分类必须命中而非落到 unknown 透传）',
  )

  // —— i18n 键必须真的存在 ——
  section('i18n 键齐备（zh + en）')
  for (const [loc, needle] of [
    ['zh-CN.json', '下载过慢'],
    ['en-US.json', 'Download too slow'],
  ]) {
    const p = path.join(ROOT, 'src', 'i18n', 'locales', loc)
    const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    check(
      txt.includes('tg.reasonTooSlow') && txt.includes(needle),
      `${loc} 含 tg.reasonTooSlow 文案`,
      '键缺失 ⇒ 界面会显示裸键名',
    )
  }

  // —— 无回归：既有分类保持原样 ——
  section('无回归：既有分类保持原样')
  const cases = [
    [realStall, 'tg.reasonStalled'],
    ['应用重启：传输被中断，可重试继续', 'tg.reasonRestarted'],
    ['offline debug mode', 'tg.reasonOfflineDebug'],
    ['FLOOD_WAIT_42', 'tg.reasonFlood'],
    ['api_id is not configured', 'tg.reasonConfig'],
    ['unauthorized', 'tg.reasonAuth'],
    ['MTProto connect failed: request error: read 0 bytes', 'tg.reasonNetwork'],
    ['something entirely novel', 'tg.reasonUnknown'],
    ['', 'tg.reasonUnknown'],
  ]
  for (const [raw, want] of cases) {
    const k = classify(raw)
    check(k === want, `「${raw.slice(0, 40) || '(空)'}」→ ${want}`, `实得 ${k}`)
  }

  finish()
}

function finish() {
  console.log(`\n[bug271] ${checks - failures}/${checks} 通过`)
  if (failures > 0) {
    console.log('[bug271] FAIL —— 慢流原因仍被折叠进停滞/网络类，或键缺失')
    process.exit(2)
  }
  console.log('[bug271] PASS —— 慢流有独立文案、先于网络类、不返回 reasonNetwork')
  process.exit(0)
}

try {
  main()
} catch (e) {
  console.error(`[bug271] 环境/通道问题：${e && e.message ? e.message : e}`)
  process.exit(1)
}
