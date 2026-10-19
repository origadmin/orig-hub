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
 *   1b. 前置：**没有其它 orig-hub.exe 在跑** —— 壳装了单实例插件，第二个进程
 *      会立刻退出（只 focus 已有窗口），trace 是全局追加文件，旧实例在场时
 *      判据归属不明（实测假红：窗口标题有了、trace 空了 90s）；
 *   2. 启动 release `orig-hub.exe`，**有界等待**（≤90s）到壳侧写出
 *      `[ensure_daemon]` trace —— 不用固定 sleep：trace 由前端 JS invoke 后才写，
 *      WebView2 冷启动实测可 >15s，固定 15s 曾把正常 APP 判成假红；
 *   3. 进程存活 + **窗口标题非空**（进程活着 ≠ 界面起来了）；
 *   4. **pid 必须不变**（没被杀、没有 kill+respawn）；
 *   5. `/health` 仍 200；
 *   6. 壳 trace 出现 `reusing daemon`，且**不出现** `killing port owner`；
 *   7. 端点文件仍是同一端口（无端口漂移）。
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

/** 当前有几个 orig-hub.exe 在跑（单实例插件会让第二个进程直接退出）。 */
function runningHubCount() {
  try {
    const text = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq orig-hub.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
    return (text.match(/orig-hub\.exe/gi) || []).length
  } catch {
    return 0
  }
}

/**
 * 有界等待：轮询到 `pred()` 为真即返回，超时返回 false。
 *
 * 为什么不用固定 `sleep`：壳侧 trace 由**前端 JS** 调 `ensure_daemon` 后才写，
 * 而 WebView2 首次冷启动（进程起来 → 用户数据目录初始化 → 加载 dist → React
 * 挂载 → invoke）实测可超过 15s。固定 15s 曾把「APP 完全正常」判成
 * 「trace 为空 ⇒ 复用分支没走」（假红）。判据要等**条件成立**，不是等一个钟点。
 * 超时仍然如实报红（不吞失败），只在 detail 里带上真实耗时便于分辨慢机与真故障。
 */
async function waitFor(pred, timeoutMs, intervalMs = 400) {
  const started = Date.now()
  for (;;) {
    if (pred()) return { ok: true, elapsed: Date.now() - started }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, elapsed: Date.now() - started }
    }
    await sleep(intervalMs)
  }
}

/** release 的 GUI 子系统窗口标题（`tasklist /V` 才有这一列；`/FO CSV` 末列）。 */
function windowTitleOf(imageName) {
  try {
    const text = execFileSync(
      'tasklist',
      ['/V', '/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
    const line = text.split(/\r?\n/).find((l) => l.includes(imageName))
    if (!line) return null
    // CSV: "Image","PID","Session","Session#","Mem","Status","User","CPU","Title"
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []
    const title = (cols[8] || '').replace(/^"|",?$/g, '').replace(/""/g, '"')
    return title || null
  } catch {
    return null
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

  /*
   * 前置：不能有别的实例在跑。
   *
   * 壳装了 `tauri-plugin-single-instance`（`lib.rs::run`）：**第二个进程会立刻退出**，
   * 只把已有窗口 show+focus。于是「trace 里有没有本次启动的 `[ensure_daemon]`」
   * 这个判据在旧实例存在时完全失效 —— trace 是全局追加文件，读到的可能是上一次的；
   * 而新进程根本没跑前端。实测就吃过这个假红（窗口标题有了、trace 空了 90s）。
   */
  const hubCountBefore = runningHubCount()
  check(
    `前置：没有其它 orig-hub 实例在跑（当前 ${hubCountBefore} 个）`,
    hubCountBefore === 0,
    '先关掉已打开的 Orig Hub —— 单实例插件会让本次启动的进程直接退出，trace 归属不明',
  )
  if (hubCountBefore !== 0) {
    console.log('\n前置不成立，无法验证（不是产品缺陷）。')
    process.exit(1)
  }

  // 清空 trace，确保下面的判据只反映本次启动
  if (fs.existsSync(TRACE)) fs.rmSync(TRACE)

  // ── 启动 APP ────────────────────────────────────────────────────────
  const child = spawn(EXE, [], { stdio: 'ignore', detached: false })
  let exited = false
  child.on('exit', () => {
    exited = true
  })

  // ── 等壳侧走到决策点（有界等待，不是固定 sleep）────────────────────
  // 判据需要的是「前端确实 invoke 了 ensure_daemon」这件事发生，而不是「过了 15 秒」。
  const traceText = () =>
    fs.existsSync(TRACE) ? fs.readFileSync(TRACE, 'utf8') : ''
  const waited = await waitFor(
    () => exited || /\[ensure_daemon\]/.test(traceText()),
    90000,
  )

  // ── 判据 ────────────────────────────────────────────────────────────
  const pidAfter = listenerPid()
  const healthyAfter = await healthOk()
  const trace = traceText()
  const endpointAfter = fs.existsSync(ENDPOINT)
    ? fs.readFileSync(ENDPOINT, 'utf8').trim()
    : null
  const winTitle = exited ? null : windowTitleOf('orig-hub.exe')

  check(
    `APP 进程存活（未启动即崩）`,
    exited === false,
    'exe 启动后立即退出',
  )
  check(
    `APP 真的把窗口显示出来了（窗口标题="${winTitle}"、进程存活=${!exited}）`,
    exited === false && !!winTitle,
    '进程活着不等于界面起来了：窗口标题为空说明 WebView 没挂上内容',
  )
  check(
    `壳侧走到 ensure_daemon 决策点（等待 ${waited.elapsed}ms，上限 90000ms）`,
    /\[ensure_daemon\] port=/.test(trace),
    trace.trim() || '(trace 为空 —— 前端 JS 没有 invoke ensure_daemon)',
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
      { pidBefore, pidAfter, healthyBefore, healthyAfter, endpointBefore, endpointAfter,
        waitedMs: waited.elapsed, winTitle },
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
