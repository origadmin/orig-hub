'use strict'
/**
 * BUG-243 真实 UI 验收：设置-关于页签必须给出**调试日志路径**，且该路径与引擎真源一致。
 *
 * 契约（防「看起来有、其实对不上」）：
 *   1) 关于页 `about-logs-dir` 的文本 === daemon `GET /api/config` 的 `logs.dir`（逐字符）；
 *   2) 该目录在磁盘上真实存在，且 `errors.log` 可读非空（核心错误跟踪真的在写）；
 *   3) 反空跑：若引擎未下发 `logs`，或 UI 显示的是占位文案，直接 FAIL。
 *
 * 前端不拼路径 —— 路径唯一真源是引擎（`orig-daemon/src/state.rs::log_dir`），
 * 所以这里用「引擎回答什么、UI 就必须显示什么」做对账，而不是自己造期望值。
 *
 * 环境：
 *   VERIFY_ORIGIN  前端地址（默认 http://127.0.0.1:5180）
 *   VERIFY_DAEMON  daemon 地址（默认 http://127.0.0.1:19786）
 * 需要 `errors.log` 已存在时设 VERIFY_EXPECT_ERRORS=1（验收环境会先制造一次拉起失败）。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const ORIGIN = process.env.VERIFY_ORIGIN || 'http://127.0.0.1:5180'
const DAEMON = process.env.VERIFY_DAEMON || 'http://127.0.0.1:19786'
const EXPECT_ERRORS = process.env.VERIFY_EXPECT_ERRORS === '1'
const OUT = path.join(__dirname, 'evidence', 'BUG-243')
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto(ORIGIN + '/', { settleMs: 2500 })
  if (
    !(await page.evaluate(() => {
      const b = document.querySelector('[data-testid="nav-settings"]')
      if (!b) return false
      b.click()
      return true
    }))
  )
    throw new Error('nav-settings not found')
  await delay(1500)
  if (
    !(await page.evaluate(() => {
      const b = document.querySelector('[data-testid="settings-tab-about"]')
      if (!b) return false
      b.click()
      return true
    }))
  )
    throw new Error('settings-tab-about not found（设置页默认页签是「下载」，必须先切页签）')
  await delay(1500)
  // 路径随 `GET /api/config` 到达（设置页挂载时拉一次），是异步落地 —— 轮询到「不再是占位
  // 文案」为止，最长 8s。固定 sleep 会把「异步还没落地」误判成「没实现」（本仓既有教训）。
  let ui = null
  for (let i = 0; i < 16; i++) {
    ui = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="about-logs"]')
      const dir = document.querySelector('[data-testid="about-logs-dir"]')
      const open = document.querySelector('[data-testid="about-logs-open"]')
      return {
        hasBox: !!box,
        dirText: dir ? dir.textContent.trim() : null,
        openDisabled: open ? open.disabled === true || open.getAttribute('disabled') !== null : null,
        boxText: box ? box.innerText.replace(/\s+/g, ' ').trim().slice(0, 240) : null,
      }
    })
    if (ui.dirText && !/暂无/.test(ui.dirText)) break
    await delay(500)
  }
  await page.screenshot(path.join(OUT, '1_about_logs.png'))

  const cfg = await page.evaluate(async (D) => {
    try {
      const r = await fetch(`${D}/api/config`)
      const d = await r.json()
      return { logs: d.logs || null }
    } catch (e) {
      return { error: e.message }
    }
  }, DAEMON)

  const problems = []
  if (!ui.hasBox) problems.push('关于页无调试日志区块（about-logs 缺失）')
  if (cfg.error) problems.push(`daemon /api/config 读取失败：${cfg.error}`)
  else if (!cfg.logs || !cfg.logs.dir) problems.push('引擎未下发 logs.dir（服务端未生效）')

  // 断言 1：UI 显示值 === 引擎真源（逐字符，不「近似」）
  const expected = cfg.logs && cfg.logs.dir ? cfg.logs.dir : null
  if (expected && ui.dirText !== expected)
    problems.push(`UI 路径与引擎真源不一致：UI=${ui.dirText} 引擎=${expected}`)
  if (ui.dirText && /暂无/.test(ui.dirText)) problems.push(`UI 仍是占位文案：${ui.dirText}`)

  // 断言 2：目录与文件在磁盘上真实存在（Node 侧核对，非浏览器自证）
  let disk = null
  if (expected) {
    const errFile = cfg.logs.errors
    disk = {
      dirExists: fs.existsSync(expected),
      errorsExists: errFile ? fs.existsSync(errFile) : false,
      errorsBytes: errFile && fs.existsSync(errFile) ? fs.statSync(errFile).size : 0,
    }
    if (!disk.dirExists) problems.push(`日志目录不存在：${expected}`)
    if (EXPECT_ERRORS) {
      if (!disk.errorsExists) problems.push(`errors.log 不存在：${errFile}`)
      else if (disk.errorsBytes === 0) problems.push('errors.log 为空（核心错误未落盘）')
      else {
        const head = fs.readFileSync(errFile, 'utf8').trim().split('\n').slice(-1)[0]
        console.log('errors.log 末行:', head.slice(0, 160))
      }
    }
  }
  if (ui.openDisabled === true && expected) problems.push('「打开日志目录」按钮在已拿到路径时仍被禁用')

  console.log('origin:', ORIGIN, 'daemon:', DAEMON)
  console.log('ui:', JSON.stringify(ui))
  console.log('engine logs:', JSON.stringify(cfg.logs))
  console.log('disk:', JSON.stringify(disk))
  console.log(
    problems.length
      ? 'FAIL: ' + problems.join('; ')
      : 'PASS: 关于页显示调试日志路径，与引擎真源逐字符一致且目录/错误日志真实存在',
  )
  await browser.close()
  if (problems.length) process.exit(1)
}
main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
