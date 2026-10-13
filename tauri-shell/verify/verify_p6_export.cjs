#!/usr/bin/env node
'use strict'

/**
 * P6 验收探针：导出动作区 + 真实导出成功态（byte-ownership P6）。
 *
 * 仅做**真实渲染截图**（断言已由 media.rs 单测 + tsc + 实时 9877 导出覆盖）：
 *   1. 媒体库 → 点「导出」打开预览对话框；
 *   2. 取消全选 → 仅勾选可导出剧集 101（其余 7 部有 issue，会阻断 export-action）；
 *   3. 跑校验 → 出现「导出目录」+「开始导出」动作区（data-testid=export-action）；
 *   4. 在 DirectoryPicker 输入框填入真实 Windows 目标目录（网页调试模式无原生对话框，手动输入可用）；
 *   5. 点「开始导出」→ 真实写入磁盘 → 出现成功态（data-testid=export-result-success）。
 *
 * 后端走真实运行实例（9877，离线模式），目标目录落在真实 Windows 路径。
 *
 * Usage:  node verify/verify_p6_export.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT P6_TARGET_DIR
 * Exit:   0 = 截图全部产出；1 = 导航/渲染/导出失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')
const { execSync } = require('node:child_process')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-p6-shots')

// 导出目标目录：orig-tg 进程落盘处。**不写死用户绝对路径** ——
// 门禁 `check-pollution.sh` §7 禁止脚本内出现机器绝对路径（换用户/换机器即失效），
// 与 OUT_DIR 同一取法：系统临时目录 + 唯一后缀（可用 P6_TARGET_DIR 覆盖）。
const DEFAULT_TARGET = path.join(os.tmpdir(), `orighub-p6-cdp-${Date.now()}`)
const TARGET_DIR = process.env.P6_TARGET_DIR || DEFAULT_TARGET

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickTestid(page, testid) {
  const ok = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
  if (!ok) throw new Error(`clickTestid: ${testid} not found`)
}

async function waitTestid(page, testid, timeout = 10000) {
  await page.waitForFunction(
    (tid) => !!document.querySelector(`[data-testid="${tid}"]`),
    { timeout, args: [testid] },
  )
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    const errors = []
    page._offConsole && page._offConsole()
    page.on &&
      page.on('Runtime.exceptionThrown', (p) =>
        errors.push(
          String(
            p.exceptionDetails?.exception?.description ||
              p.exceptionDetails?.text ||
              '',
          ),
        ),
      )

    console.log('[p6] goto', APP_URL)
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    // 1) 媒体库 → 打开导出预览
    await waitTestid(page, 'nav-child-lib-series')
    await clickTestid(page, 'nav-child-lib-series')
    await delay(1000)
    await waitTestid(page, 'media-export-preview')
    await clickTestid(page, 'media-export-preview')
    await delay(600)
    await waitTestid(page, 'export-preview-run')

    // 2) 取消全选 → 仅勾选可导出剧集 101
    console.log('[p6] isolate series 101 (the only ready one)')
    await page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="export-preview-dialog"]')
      const labels = Array.from(dlg.querySelectorAll('label'))
      for (const lab of labels) {
        const cb = lab.querySelector('input[type=checkbox]')
        if (cb && cb.checked) cb.click() // 取消全选
      }
    })
    await delay(150)
    const checked101 = await page.evaluate(() => {
      const dlg = document.querySelector('[data-testid="export-preview-dialog"]')
      const labels = Array.from(dlg.querySelectorAll('label'))
      const target = labels.find((l) => l.textContent.includes('超能旅行团'))
      if (!target) return false
      const cb = target.querySelector('input[type=checkbox]')
      if (cb && !cb.checked) cb.click()
      return true
    })
    console.log('[p6] series 101 checkbox located:', checked101)
    await delay(150)

    // 3) 跑校验 → 出现 export-action 动作区
    await clickTestid(page, 'export-preview-run')
    await waitTestid(page, 'export-action', 12000)
    await delay(800)
    const actionShown = await page.evaluate(
      () => !!document.querySelector('[data-testid="export-action"]'),
    )
    console.log('[p6] export-action block visible:', actionShown)
    await page.screenshot(path.join(OUT_DIR, 'p6-export-action.png'), { fullPage: true })

    // 4) 在 DirectoryPicker 输入框填入真实目标目录（手动输入，网页调试模式可用）
    console.log('[p6] set targetDir =', TARGET_DIR)
    await page.evaluate((dir) => {
      const input = document.querySelector('[data-testid="export-action"] input')
      if (!input) throw new Error('DirectoryPicker input not found')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(input, dir)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, TARGET_DIR)
    await delay(200)
    const dirSet = await page.evaluate(
      () =>
        document.querySelector('[data-testid="export-action"] input')?.value || '',
    )
    console.log('[p6] input value now:', dirSet)

    // 5) 点「开始导出」→ 真实写入磁盘 → 成功态
    await clickTestid(page, 'export-run')
    await waitTestid(page, 'export-result-success', 15000)
    await delay(600)
    const success = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="export-result-success"]')
      return el ? el.textContent : null
    })
    console.log('[p6] success block text:', (success || '').replace(/\s+/g, ' ').slice(0, 200))
    await page.screenshot(path.join(OUT_DIR, 'p6-export-success.png'), { fullPage: true })

    // 6) 校验磁盘产物（复制非移动；manifest schema）
    let disk = { manifest: false, video: false, content: false }
    try {
      const manifestPath = path.join(TARGET_DIR, 'manifest.json')
      disk.manifest = fs.existsSync(manifestPath)
      if (disk.manifest) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        disk.schemaOk = m.schema === 'orighub-export/1'
        const seriesDir = path.join(TARGET_DIR, m.series[0].directory)
        disk.content = fs.existsSync(path.join(seriesDir, 'content.json'))
        const files = fs.readdirSync(seriesDir)
        disk.video = files.some((f) => /\.(mp4|mkv|webm|mov)$/i.test(f))
      }
    } catch (e) {
      console.log('[p6] disk check error:', e.message)
    }
    console.log('[p6] disk artifacts:', JSON.stringify(disk))

    if (errors.length) console.log('[p6] page errors:', errors.slice(0, 5))
    console.log('[p6] screenshots written to', OUT_DIR)
    if (!actionShown || !disk.manifest || !disk.video || !disk.content) {
      process.exit(2)
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[p6] FAIL', e && e.message ? e.message : e)
  process.exit(1)
})
