'use strict'
/**
 * 诊断：从 Node 以 `spawn` 方式启动 release APP 时，前端 JS 到底有没有跑起来。
 *
 * 背景：`verify_bug326_daemon_reuse.cjs` 用 `spawn(EXE, [], {stdio:'ignore'})`
 * 启动时，窗口标题出现但 90s 内 `%TEMP%/orighub-shell-trace.log` 始终为空；
 * 而同一个 exe 从 bash 直接跑，20s 内就写出 `[ensure_daemon] ...` 两行。
 * 本脚本把「两种启动方式的差异」当变量，逐 3s 打点，定位差异到底在不在 spawn。
 *
 * 用法：node tauri-shell/verify/_diag_app_spawn.cjs [--inherit]
 *   --inherit  用 stdio:'inherit'（能看到壳的 stderr），其余完全一致
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const EXE = path.resolve(__dirname, '..', 'src-tauri', 'target', 'release', 'orig-hub.exe')
const TRACE = path.join(os.tmpdir(), 'orighub-shell-trace.log')
const INHERIT = process.argv.includes('--inherit')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function webviewCount() {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq msedgewebview2.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    )
    return (out.match(/msedgewebview2\.exe/gi) || []).length
  } catch {
    return -1
  }
}

async function main() {
  console.log(`tmpdir=${os.tmpdir()}`)
  console.log(`trace=${TRACE}`)
  if (fs.existsSync(TRACE)) fs.rmSync(TRACE)
  console.log(`before: traceExists=${fs.existsSync(TRACE)} webview=${webviewCount()}`)

  const child = spawn(EXE, [], {
    stdio: INHERIT ? 'inherit' : 'ignore',
    detached: false,
  })
  let exited = false
  child.on('exit', (code, sig) => {
    exited = true
    console.log(`[spawn] exit code=${code} sig=${sig}`)
  })

  for (let i = 1; i <= 20; i += 1) {
    await sleep(3000)
    const exists = fs.existsSync(TRACE)
    const text = exists ? fs.readFileSync(TRACE, 'utf8').trim() : ''
    console.log(
      `t=${(i * 3).toString().padStart(2)}s exited=${exited} traceExists=${exists} ` +
        `len=${text.length} webview=${webviewCount()} :: ${text.replace(/\n/g, ' | ')}`,
    )
    if (/reusing daemon/.test(text)) break
  }

  try {
    if (!exited) child.kill()
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
