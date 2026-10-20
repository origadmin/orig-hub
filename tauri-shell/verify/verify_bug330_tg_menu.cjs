'use strict'
/**
 * BUG-330 / TGM-08：TG 二级菜单总验收（真实栈 + CDP，批次门禁的汇总闸门）。
 *
 * 用户诉求（2026-10-20 原话四条）→ 判据分布：
 *   ①「筛选改为标题右上角按钮…当前下方一行的方式严重破坏了整体设计」
 *       → TGM-04 探针 F1/F1b（弹窗化 + 节外无常驻输入行）
 *   ②「显示的标题…同一文字显示 2 串，且排版突兀」
 *       → TGM-04 探针 F3/F4（label≡keyword 去重）+ TGM-07 P1（完整 caption 展开）
 *   ③「筛选需要考虑多个显示超出规则后的折叠和展示」
 *       → TGM-04 探针 F6（超 K 折叠 K=8）
 *   ④「进筛选后分组进不去」「监控中突兀的 ICON」
 *       → TGM-03 探针 M2（主列真切换）+ TGM-02（⭐ 已清、消费序、状态条三数=API）
 *   命中可预览 + 分页 + 勾选口径 → TGM-07 探针 P1–P5
 *
 * 本脚本 = 编排层，不重造判据：按序跑四个批次探针（正向）+ 设计红线 #5 的
 * BUG-329 回归基线，再对四个 TGM 探针跑 `--expect-legacy` 反向证伪
 * （每个都必须 FAIL + exit 1，否则说明判据没牙）。
 *
 * 通过条件（全部满足才 exit 0）：
 *   - 前置：dev 5180 + daemon 19786(orig-tg 19787) 均 200
 *   - 5 个正向脚本全部 exit 0
 *   - 4 个 TGM 探针的 --expect-legacy 全部 exit 1
 *
 * 用法：node tauri-shell/verify/verify_bug330_tg_menu.cjs
 * 产物：verify_shots/bug330-tg-menu/result.txt
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug330-tg-menu')
const DAEMON = process.env.VERIFY_TG_URL || 'http://127.0.0.1:19787'
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const POSITIVE = [
  ['TGM-02 左栏消费序', '_probe_tgm02_left_column.cjs', false],
  ['TGM-03 主列模式切换', '_probe_tgm03_mode_switch.cjs', false],
  ['TGM-04 筛选节', '_probe_tgm04_filter_section.cjs', false],
  ['TGM-07 命中工作台', '_probe_tgm07_filter_hits.cjs', false],
  ['BUG-329 回归基线（红线 #5）', 'verify_bug329_monitor_filters.cjs', false],
]
const LEGACY = [
  ['TGM-02', '_probe_tgm02_left_column.cjs'],
  ['TGM-03', '_probe_tgm03_mode_switch.cjs'],
  ['TGM-04', '_probe_tgm04_filter_section.cjs'],
  ['TGM-07', '_probe_tgm07_filter_hits.cjs'],
]

/*
 * ★ 基础设施崩溃 ≠ 产品回归（2026-10-21 实测）：headless Edge 冷启动偶发
 * `Page.navigate timed out`——`Page.navigate` 命令本身 90s 无响应，是浏览器进程
 * 没起来，与页面内容无关（同一次预热 `/src/main.tsx` 仅 43ms）。这类崩溃没有
 * 任何 PASS/FAIL 行（判据根本没开始跑），重试一次是安全的：它不会把红判成绿，
 * 只会把「浏览器没起来」与「判据不过」区分开。重试次数如实写进日志。
 */
const CDP_CRASH = /probe error: Error: CDP: .*(timed out|failed to spawn)/

function runOnce(script, legacy) {
  const args = [path.join(__dirname, script)]
  if (legacy) args.push('--expect-legacy')
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    // 10min：CDP 导航超时重试会额外花 90s+（实测 5min 会把正常的 BUG-329 基线
    // 误杀成 `exit null`——被 SIGTERM 结束，看起来像产品失败）
    timeout: 600000,
    env: process.env,
  })
  const pass = (r.stdout.match(/^PASS /gm) || []).length
  const fail = (r.stdout.match(/^FAIL /gm) || []).length
  const legacyFailed = /FAIL: /.test(r.stdout)
  // 正向判据取「退出码 0 且零 FAIL 行」——各脚本成功标记格式不一
  // （TGM 探针打 ALL PASS，BUG-329 打 `PASS - …`），退出码才是共同契约。
  return { code: r.status, pass, fail, legacyFailed, stdout: r.stdout, stderr: r.stderr }
}

function run(script, legacy) {
  let attempts = 0
  let r
  // 最多 2 次：仅当「零判据产出 + CDP 崩溃」时重试（有判据产出的红一律不重试）
  for (let i = 0; i < 2; i++) {
    attempts++
    r = runOnce(script, legacy)
    const crash = CDP_CRASH.test(r.stdout || '') || CDP_CRASH.test(r.stderr || '')
    const noCriteria = r.pass === 0 && r.fail === 0
    if (!(crash && noCriteria)) break
    if (i === 0) console.log(`  ↻ ${script} CDP 启动崩溃，重试一次`)
  }
  return { ...r, attempts }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const lines = []
  const problems = []
  const log = (s) => {
    lines.push(s)
    console.log(s)
  }

  // ── 前置：栈健康 ──
  for (const [name, url] of [
    ['dev 5180', APP],
    ['daemon 19786', 'http://127.0.0.1:19786/health'],
    ['orig-tg 19787', `${DAEMON}/health`],
  ]) {
    let ok = false
    try {
      const res = await fetch(url)
      ok = res.ok || res.status === 200
    } catch {
      ok = false
    }
    log(`${ok ? 'PASS' : 'FAIL'} 前置 ${name} 200`)
    if (!ok) problems.push(name)
  }
  if (problems.length > 0) {
    fs.writeFileSync(path.join(OUT, 'result.txt'), lines.join('\n') + '\n', 'utf8')
    console.log(`\nFAIL: 前置不健康（${problems.join(', ')}）`)
    process.exitCode = 1
    return
  }

  /*
   * ── 前置：清理历史遗留夹具（2026-10-21）──
   * `__verify_*` 只可能由探针产生（用户不会把规则命名成这样），历史轮次里探针
   * 崩溃/早退留下的会一直挂在用户库里、把「夹具卫生」判成 FAIL，看起来像本次
   * 验收的回归。跑前清掉并如实记数；跑后核对仍保持严格（本次产生的遗留必被抓）。
   */
  let preCleaned = 0
  try {
    const res = await fetch(`${DAEMON}/api/tg/monitor/filters`)
    const d = await res.json()
    for (const f of d.items || []) {
      if (/^__verify/.test(f.keyword)) {
        await fetch(`${DAEMON}/api/tg/monitor/filters/${f.id}`, { method: 'DELETE' }).catch(() => {})
        preCleaned++
      }
    }
  } catch (e) {
    log(`FAIL 前置清理历史夹具失败：${e.message}`)
    problems.push('preclean')
  }
  log(`PASS 前置清理历史夹具（删除 ${preCleaned} 条 __verify_* 历史遗留）`)

  /*
   * ── 前置：vite 预热（2026-10-21 实测）──
   * 冷启动后首次请求 `/src/main.tsx` 要 transform 整张模块图，实测可达 **50s**，
   * 而 CDP 的 Page.navigate 超时是 30s ⇒ 每个探针都会「导航超时」假红（实测连中
   * 4 次，误以为产品回归）。预热到首次响应 < PREWARM_MAX_MS 再跑子脚本；
   * 超时仍如实报红（不吞失败——慢机和真故障必须区分得开）。
   */
  const PREWARM_MAX_MS = 10_000
  const PREWARM_DEADLINE = Date.now() + 180_000
  let warmMs = -1
  while (Date.now() < PREWARM_DEADLINE) {
    const t = Date.now()
    try {
      await fetch(`${APP}src/main.tsx`).then((r) => r.text())
      warmMs = Date.now() - t
    } catch {
      warmMs = -1
    }
    if (warmMs >= 0 && warmMs < PREWARM_MAX_MS) break
    await sleep(2000)
  }
  const warmOk = warmMs >= 0 && warmMs < PREWARM_MAX_MS
  log(`${warmOk ? 'PASS' : 'FAIL'} 前置 vite 预热（首次 /src/main.tsx ${warmMs}ms，阈值 ${PREWARM_MAX_MS}ms）`)
  if (!warmOk) {
    fs.writeFileSync(path.join(OUT, 'result.txt'), lines.join('\n') + '\n', 'utf8')
    console.log('\nFAIL: vite 未预热成功——探针会因导航超时假红，不跑')
    process.exitCode = 1
    return
  }

  // ── 正向：批次探针 + BUG-329 基线 ──
  for (const [name, script] of POSITIVE) {
    const r = run(script, false)
    const ok = r.code === 0 && r.fail === 0
    log(
      `${ok ? 'PASS' : 'FAIL'} 正向 ${name} — ${r.pass} PASS / ${r.fail} FAIL / exit ${r.code}` +
        (r.attempts > 1 ? `（CDP 崩溃后第 ${r.attempts} 次尝试通过）` : ''),
    )
    if (!ok) {
      problems.push(name)
      if (r.stderr) log(`  stderr: ${r.stderr.split('\n').slice(0, 3).join(' | ')}`)
    }
    fs.writeFileSync(
      path.join(OUT, script.replace(/\.cjs$/, '') + '.log'),
      r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''),
      'utf8',
    )
  }

  // ── 反向证伪：每个 TGM 探针的 legacy 模式必须 FAIL exit 1 ──
  for (const [name, script] of LEGACY) {
    const r = run(script, true)
    const ok = r.code === 1 && r.legacyFailed
    log(
      `${ok ? 'PASS' : 'FAIL'} 反向证伪 ${name} --expect-legacy 必败 — exit ${r.code}（期望 1）` +
        (r.attempts > 1 ? `（CDP 崩溃后第 ${r.attempts} 次尝试）` : ''),
    )
    if (!ok) problems.push(`legacy-${name}`)
    fs.writeFileSync(
      path.join(OUT, script.replace(/\.cjs$/, '') + '.legacy.log'),
      r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''),
      'utf8',
    )
  }

  // ── 夹具卫生：规则表应只剩用户自有规则（探针 finally 自清，这里如实核对） ──
  // 重试 3 次：前一轮子脚本刚结束时 daemon 可能仍在收尾（实测 fetch failed 一次）
  let fixtureOk = false
  let fixtureMsg = ''
  for (let i = 0; i < 3 && !fixtureOk; i++) {
    try {
      const res = await fetch(`${DAEMON}/api/tg/monitor/filters`)
      const d = await res.json()
      const items = d.items || []
      const leftovers = items.filter((f) => /^__verify|^的$/.test(f.keyword))
      fixtureMsg = `无遗留测试规则（现存 ${items.length} 条）`
      log(`${leftovers.length === 0 ? 'PASS' : 'FAIL'} 夹具卫生：${fixtureMsg}`)
      if (leftovers.length > 0) problems.push('fixture-leftover')
      fixtureOk = true
    } catch (e) {
      fixtureMsg = e.message
      if (i === 2) {
        log(`FAIL 夹具卫生核对失败（3 次重试后）：${fixtureMsg}`)
        problems.push('fixture-check')
      } else {
        await sleep(2000)
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'result.txt'), lines.join('\n') + '\n', 'utf8')
  if (problems.length > 0) {
    console.log(`\nFAIL: ${problems.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('\nALL PASS — BUG-330 TG 二级菜单验收通过')
  }
}

main().catch((e) => {
  console.error('verify error:', e)
  process.exitCode = 1
})
