'use strict'
/**
 * BUG-233 真实 UI 验收：设置-关于页签必须显示 Telegram 插件状态
 * （服务层进程状态 + Telegram 链路状态），而不是只有下载引擎一项。
 *
 * 驱动：nav-settings → settings-tab-about → 读 about-tg / about-tg-status。
 * 状态真源：daemon `/api/config`（tg_enabled/tg_running/tg_port/tg_last_error），
 * 探针据此核对 UI 文案，不内嵌文案字符串判断逻辑之外的期望值。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-233')
fs.mkdirSync(OUT, { recursive: true })
const DAEMON = 'http://127.0.0.1:19786'

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { settleMs: 2500 })
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-settings"]'); if (!b) return false; b.click(); return true }))
    throw new Error('nav-settings not found')
  await delay(1500)
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="settings-tab-about"]'); if (!b) return false; b.click(); return true }))
    throw new Error('settings-tab-about not found（设置页默认页签是「下载」，必须先切页签）')
  await delay(1500)

  const ui = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="about-tg"]')
    const status = document.querySelector('[data-testid="about-tg-status"]')
    return {
      hasBox: !!box,
      status: status ? status.textContent.trim() : null,
      boxText: box ? box.innerText.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    }
  })
  await page.screenshot(path.join(OUT, '1_about_tg.png'))

  const cfg = await page.evaluate(async (D) => {
    try {
      const r = await fetch(`${D}/api/config`)
      const d = await r.json()
      return { enabled: d.tg_enabled, running: d.tg_running, port: d.tg_port, err: d.tg_last_error }
    } catch (e) {
      return { error: e.message }
    }
  }, DAEMON)

  const problems = []
  if (!ui.hasBox) problems.push('关于页无 Telegram 插件区块（about-tg 缺失）')
  if (!ui.status) problems.push('关于页 TG 状态文本为空（about-tg-status 缺失）')
  if (cfg.error) problems.push(`daemon /api/config 读取失败：${cfg.error}`)
  else {
    // 与引擎真源核对：开关状态必须一致（运行中 → 文案含端口；停用 → 不能显示运行中）
    if (cfg.enabled && cfg.running && cfg.port && !String(ui.status).includes(String(cfg.port)))
      problems.push(`引擎报运行中(端口 ${cfg.port})，但关于页未显示端口：${ui.status}`)
    if (!cfg.enabled && /运行中/.test(String(ui.status)))
      problems.push(`引擎报已停用，关于页却显示运行中：${ui.status}`)
  }
  console.log('ui:', JSON.stringify(ui))
  console.log('engine:', JSON.stringify(cfg))
  console.log(problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS: 关于页显示 TG 插件状态且与引擎真源一致')
  await browser.close()
  if (problems.length) process.exit(1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
