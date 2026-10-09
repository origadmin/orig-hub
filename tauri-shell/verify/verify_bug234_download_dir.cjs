'use strict'
/**
 * BUG-234 真实 UI 验收：设置页改下载目录 → 引擎**真的收到并生效**。
 *
 * 旧行为（BUG）：handleSave 只写 localStorage，daemon 无 download_dir 更新端点 ——
 * 保存后 `/api/config` 的 download_dir 不变，下载照旧落原处。
 * 本探针驱动真实 UI：设置页输入新目录 → 点保存 → 读引擎 `/api/config`，
 * 断言 download_dir == 输入值（值为运行期构造的唯一路径，非硬编码）。
 * 结束后恢复原值（不把用户配置留在探针的测试目录上）。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-234')
fs.mkdirSync(OUT, { recursive: true })
const DAEMON = 'http://127.0.0.1:19786'

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { settleMs: 2500 })

  const before = await page.evaluate(async (D) => {
    const r = await fetch(`${D}/api/config`)
    const d = await r.json()
    return { dir: d.download_dir, def: d.default_download_dir }
  }, DAEMON)
  // 测试目录由**引擎自报路径**推导（不写机器绝对路径：污染门禁 + 换机可跑）。
  const base = before.def || before.dir
  if (!base) throw new Error('引擎未下发 default_download_dir/download_dir，无法构造测试目录')
  const target = `${String(base).replace(/\\/g, '/')}/orig-verify-BUG-234`
  console.log('engine before:', JSON.stringify(before), '\ntarget:', target)

  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-settings"]'); if (!b) return false; b.click(); return true }))
    throw new Error('nav-settings not found')
  await delay(1500)
  // 设置页默认页签就是「下载」（下载目录在此）
  const typed = await page.evaluate((v) => {
    const wrap = document.querySelector('[data-testid="download-dir-picker"]')
    if (!wrap) return 'no-picker'
    const input = wrap.querySelector('input')
    if (!input) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  }, target)
  if (typed !== target) throw new Error(`目录输入失败：${typed}`)
  await delay(400)
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="settings-save"]'); if (!b) return false; b.click(); return true }))
    throw new Error('settings-save not found')

  // 等引擎读回变化（接口延迟 + 落盘）
  let after = null
  for (let i = 0; i < 12; i++) {
    await delay(600)
    after = await page.evaluate(async (D) => {
      const r = await fetch(`${D}/api/config`)
      const d = await r.json()
      return { dir: d.download_dir }
    }, DAEMON)
    if (after.dir && after.dir.replace(/\\/g, '/') === target) break
  }
  await page.screenshot(path.join(OUT, '1_settings_after_save.png'))
  console.log('engine after:', JSON.stringify(after))

  const problems = []
  if (!after.dir) problems.push('引擎 download_dir 仍为空（保存未到达引擎）')
  else if (after.dir.replace(/\\/g, '/') !== target) problems.push(`引擎 download_dir=${after.dir}，期望 ${target}`)

  // 还原原值（探针不留副作用）
  await page.evaluate(async (args) => {
    try {
      await fetch(`${args.D}/api/config/download`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: args.dir || '' }),
      })
    } catch (e) { /* ignore */ }
  }, { D: DAEMON, dir: before.dir })
  const restored = await page.evaluate(async (D) => {
    const r = await fetch(`${D}/api/config`)
    const d = await r.json()
    return d.download_dir
  }, DAEMON)
  console.log('restored engine download_dir:', restored)

  console.log(problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS: 设置页保存下载目录 → 引擎运行时生效（/api/config 读回一致）')
  await browser.close()
  if (problems.length) process.exit(1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
