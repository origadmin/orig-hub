'use strict'
/**
 * BUG-326 回归：**release APP 启动不得杀掉已在运行的 daemon**。
 *
 * 背景（2026-10-20 用户报「APP打开有问题,dev打开正常」）：
 * 壳的 `ensure_daemon` 曾用 `wmic` 取端口占用者路径判定「是不是自家 daemon」。
 * wmic 自 Windows 11 22H2 起被弃用，调用失败即 `return false` ⇒ 把 `/health` 已 200
 * 的健康 daemon 判成 owner mismatch ⇒ **直接杀掉**。实测后果：打开 APP 后
 * `19786 -> 000`（dev 栈 daemon 被杀）、新 daemon 漂到 `19787` 并改写端点文件
 * ⇒ APP 与 dev 同时不可用。修复见 `src-tauri/src/lib.rs::port_owner_is_daemon_on`
 * （改 tasklist + 三态，查不出不杀）。
 *
 * 判据（任一条不满足即红）：
 *   1. 前置：19786 有健康 daemon（`/health` 200），记下其 pid；
 *   2. 启动 release `orig-hub.exe`，等 15s；
 *   3. **pid 必须不变**（没被杀、没有 kill+respawn）；
 *   4. `/health` 仍 200；
 *   5. 壳 trace（`%TEMP%/orighub-shell-trace.log`）出现 `reusing daemon`，
 *      且**不出现** `killing port owner`；
 *   6. 端点文件仍是同一端口（无端口漂移）。
 *
 * 验牙（反向证伪，必须能红）：
 *   把 `port_owner_is_daemon_on` 改回 `wmic` 版本 ⇒ 第 3/5 条转红（pid 变、出现 killing）。
 *   本脚本自身反向：`--expect-kill` 参数把第 3 条反置，用于证明判据不是恒绿
 *   （对已在跑的 daemon 主动 kill 时脚本必须报红）。
 *
 * 用法：node tauri-shell/verify/verify_bug326_daemon_reuse.cjs
 *   前置：daemon 在 19786 跑（`python scripts/dev_services.py --start`）、
 *        release 已构建（`npm run tauri:build`）。产物落 verify_shots/bug326-daemon-reuse/。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(ROOT, 'verify_shots', 'bug326-daemon-reuse')
const EXE = path.resolve(
  __dirname,
  '..',
  'src-tauri',
  'target',
  'release',
  'orig-hub.exe',
)
const ENDPOINT = path.join(
  process.env.APPDATA || '',
  'com.origadmin.orighub',
  'daemon.endpoint',
)
const TRACE = path.join(os.tmpdir(), 'orighub-shell-trace.log')
const HEALTH = 'http://127.0.0.1:19786/health'

const EXPECT_KILL = process.argv.includes('--expect-kill')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

/** 取监听 19786 的 pid（Windows: netstat -ano；其它: lsof）。 */
function listenerPid() {
  try {
    if (process.platform === 'win32') {
      const text = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
      const line = text
        .split(/\r?\n/)
        .find((l) => l.includes('LISTENING') && /:19786\s/.test(l))
      if (!line) return null
      const pid = line.trim().split(/\s+/).pop()
      return Number.parseInt(pid, 10) || null
    }
    const out = execFileSync('lsof', ['-ti', 'tcp:19786'], { encoding: 'utf8' })
    return Number.parseInt(out.trim().split(/\s+/)[0], 10) || null
  } catch {
    return null
  }
}

async function healthOk() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(2500) })
    return r.status === 200
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ── 前置 ────────────────────────────────────────────────────────────
  const pidBefore = listenerPid()
  const healthyBefore = await healthOk()
  check(
    `前置：19786 有健康 daemon（pid=${pidBefore}、health=${healthyBefore}）`,
    pidBefore !== null && healthyBefore === true,
    '先跑 `python scripts/dev_services.py --start`',
  )
  if (pidBefore === null || !healthyBefore) {
    console.log('\n前置不成立，无法验证（不是产品缺陷）。')
    process.exit(1)
  }
  const endpointBefore = fs.existsSync(ENDPOINT)
    ? fs.readFileSync(ENDPOINT, 'utf8').trim()
    : null

  check(`前置：release 产物存在（${path.relative(ROOT, EXE)}）`, fs.existsSync(EXE))

  // 清空 trace，确保下面的判据只反映本次启动
  if (fs.existsSync(TRACE)) fs.rmSync(TRACE)

  // ── 启动 APP ────────────────────────────────────────────────────────
  const child = spawn(EXE, [], { stdio: 'ignore', detached: false })
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  await sleep(15000)

  // ── 判据 ────────────────────────────────────────────────────────────
  const pidAfter = listenerPid()
  const healthyAfter = await healthOk()
  const trace = fs.existsSync(TRACE) ? fs.readFileSync(TRACE, 'utf8') : ''
  const endpointAfter = fs.existsSync(ENDPOINT)
    ? fs.readFileSync(ENDPOINT, 'utf8').trim()
    : null

  check(
    `APP 进程存活（未启动即崩）`,
    exited === false,
    'exe 启动后立即退出',
  )
  // 反向证伪模式：--expect-kill 时把第 3 条反置，用来证明判据不是恒绿
  if (EXPECT_KILL) {
    check(
      `[反向证伪] daemon 应当被杀（pid 从 ${pidBefore} 变为 ${pidAfter} 或消失）`,
      pidAfter !== pidBefore,
      `pidBefore=${pidBefore} pidAfter=${pidAfter}`,
    )
  } else {
    check(
      `daemon pid 未被杀（前 ${pidBefore} / 后 ${pidAfter}）`,
      pidAfter === pidBefore,
      `pidBefore=${pidBefore} pidAfter=${pidAfter}`,
    )
  }
  check(`daemon /health 仍 200（${healthyAfter}）`, healthyAfter === true)
  check(
    `trace 出现 reusing daemon（说明走了复用分支）`,
    /reusing daemon/.test(trace),
    trace.trim() || '(trace 为空)',
  )
  check(
    `trace 不出现 killing port owner（没有误杀）`,
    !/killing port owner/.test(trace),
    trace.trim() || '(trace 为空)',
  )
  check(
    `端点文件端口未漂移（前 "${endpointBefore}" / 后 "${endpointAfter}"）`,
    endpointBefore === endpointAfter,
    `before=${endpointBefore} after=${endpointAfter}`,
  )

  fs.writeFileSync(path.join(OUT, 'trace.log'), trace, 'utf8')
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify(
      { pidBefore, pidAfter, healthyBefore, healthyAfter, endpointBefore, endpointAfter },
      null,
      2,
    ),
    'utf8',
  )

  // ── 收尾：只关掉本次启动的 APP（不碰 daemon）──────────────────────
  try {
    if (!exited) child.kill()
  } catch {
    /* 已退出 */
  }

  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-326 daemon 复用回归：${pass} pass / ${fail} fail — evidence: ${OUT}`,
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
