#!/usr/bin/env node
/**
 * BUG-448 验收：daemon 的 `/health` 就绪时间不得被 TG 插件拉起阻塞。
 *
 * 判据（可证伪）：
 *   起一个 daemon，把 `ORIG_TG_PATH` 指向一个**永远不会监听端口**的程序
 *   （默认 notepad.exe —— 它活着、不 bind、不退出）。
 *   于是 `tg_start_on` 必然走满 `TG_START_WAIT_TIMEOUT = 30s`。
 *
 *   - 修复前：`tg_start().await` 挡在 `axum::serve` 之前 ⇒ `/health` 要等 ~30s 才 200。
 *   - 修复后：插件移出就绪路径 ⇒ `/health` 应 **≤ 5s** 就 200。
 *
 * 这是**同一输入、两个二进制**的对照，不是「改完看着像好了」。
 *
 * 用法：
 *   node verify/verify_bug448_startup_readiness.cjs \
 *     --exe ../download-engine/target/release/orig-daemon.exe --label before --expect-max-ms 5000
 *
 * 退出码：0 = 达标；1 = 超时/进程死亡/端口被占。
 *
 * ★ 环回必须绕过代理：本机 `http_proxy` 会接管 127.0.0.1（见 verify/lib/cdp.cjs 同类注释），
 *   本脚本用裸 http.request + 显式 host，不走 env 代理。
 */
'use strict'

const { spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const EXE = path.resolve(arg('exe', ''))
const LABEL = arg('label', 'run')
const EXPECT_MAX_MS = Number(arg('expect-max-ms', '5000'))
const PORT = Number(arg('port', '19890'))
const TG_PORT = PORT + 1
const HARD_TIMEOUT_MS = 45000
/**
 * 对照组开关。`--tg-enabled false` 关掉插件：若此时就绪时间骤降到几百毫秒，
 * 就**证明**慢的是 TG 那条腿，而不是 DB/绑定/别的启动动作（排除误归因）。
 */
const TG_ENABLED = arg('tg-enabled', 'true') !== 'false'

/** 端口是否可 bind（不能 bind = 有人占着，别拿来测） */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** 裸 GET /health，返回 {status, ms}；连不上返回 null */
function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 800, agent: false },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`FAIL ${LABEL}: daemon 不存在 ${EXE}`)
    process.exit(1)
  }
  if (!(await portFree(PORT))) {
    console.error(`FAIL ${LABEL}: 端口 ${PORT} 被占用，换 --port 再测`)
    process.exit(1)
  }

  // 隔离数据目录：绝不碰用户真实库（tg_store.db / 会话 / 日志）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bug448-${LABEL}-`))
  // 「会启动但永不监听」的替身：notepad 活着、不 bind、不退出 ⇒ 必然走满 30s 超时
  // 机器绝对路径在这里是**禁写**的（污染门禁 §7）：系统目录从环境取，
  // 取不到就让 spawn 直接失败 —— 这是验收脚本，不该替用户假设盘符。
  const fakeTg = path.join(process.env.SystemRoot ?? '', 'System32', 'notepad.exe')

  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ORIG_DAEMON_PORT: String(PORT),
      ORIG_TG_DATA: dataDir,
      ORIG_TG_ENABLED: TG_ENABLED ? 'true' : 'false',
      ORIG_TG_PATH: fakeTg,
      // 明确不注入任何凭据：即使替身真的监听，也不会去连 Telegram
      ORIG_TG_API_ID: '',
      ORIG_TG_API_HASH: '',
    },
  })

  let died = null
  child.on('exit', (code, sig) => (died = { code, sig }))
  const stderr = []
  child.stderr.on('data', (b) => stderr.push(b.toString()))

  const t0 = Date.now()
  let readyMs = null
  let lastErr = null
  while (Date.now() - t0 < HARD_TIMEOUT_MS) {
    if (died) {
      lastErr = `daemon 在 ${Date.now() - t0}ms 就退出了（code=${died.code} sig=${died.sig}）`
      break
    }
    const r = await probeHealth(PORT)
    if (r && r.status === 200) {
      readyMs = Date.now() - t0
      break
    }
    await sleep(100)
  }

  // 顺手确认「替身确实没监听」——否则这一轮根本没测到慢路径，结论无效
  const tgListening = !(await portFree(TG_PORT))

  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  await sleep(200)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 文件被占就留着，不影响判据 */
  }

  if (readyMs === null) {
    console.error(`FAIL ${LABEL}: /health 在 ${HARD_TIMEOUT_MS}ms 内未就绪`)
    if (lastErr) console.error(`  ${lastErr}`)
    if (stderr.length) console.error(`  stderr: ${stderr.join('').slice(-800)}`)
    process.exit(1)
  }

  if (tgListening) {
    console.error(
      `FAIL ${LABEL}: 替身程序竟然监听了 ${TG_PORT} —— 本轮没有走到「TG 拖住就绪」的慢路径，结论无效`,
    )
    process.exit(1)
  }

  const ok = readyMs <= EXPECT_MAX_MS
  const verdict = ok ? 'PASS' : 'FAIL'
  console.log(
    `${verdict} ${LABEL}: /health ready in ${readyMs}ms (阈值 ${EXPECT_MAX_MS}ms, port ${PORT})`,
  )
  if (!ok) {
    console.log('  ⇒ 说明 TG 插件的启动等待仍在就绪路径上（BUG-448 未修好）')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(`FAIL ${LABEL}: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
