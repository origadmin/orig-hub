#!/usr/bin/env node
'use strict'

/**
 * P5 验收探针：库根设置 UI + 导出完备性预览（byte-ownership P5）。
 *
 * 仅做**真实渲染截图**，不做断言（断言已由 media.rs 单测 + tsc 覆盖）：
 *   1. 设置页 → 库根目录项（downloads.libDir）可见；
 *   2. 媒体库 → 点「导出」打开预览对话框；
 *   3. 预览对话框 → 跑校验，渲染「可导出（绿）」与「有问题（红/橙）」两类剧集。
 *
 * 后端走真实运行实例（9877），数据来自真实媒体库（既有 8 部剧集 / 1 部可导出）。
 *
 * Usage:  node verify/verify_p5_export_preview.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT
 * Exit:   0 = 截图全部产出；1 = 导航/渲染失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-p5-shots')

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
      page.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '')))

    console.log('[p5] goto', APP_URL)
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })

    // 1) 设置页：库根目录项
    await waitTestid(page, 'nav-settings')
    await clickTestid(page, 'nav-settings')
    await delay(1000)
    // 库根项在 scroll 容器内，强制滚动到可视；截图整页
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-settings"]')
      el && el.scrollIntoView({ block: 'center' })
    })
    const libDirVisible = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('p'))
      return labels.some((p) => p.textContent && p.textContent.includes('库根目录'))
    })
    console.log('[p5] settings libDir label visible:', libDirVisible)
    await page.screenshot(path.join(OUT_DIR, 'p5-settings-libdir.png'), { fullPage: true })

    // 2) 媒体库：打开导出预览
    await clickTestid(page, 'nav-child-lib-series')
    await delay(1000)
    await waitTestid(page, 'media-export-preview')
    await clickTestid(page, 'media-export-preview')
    await delay(600)
    await waitTestid(page, 'export-preview-run')
    // 3) 跑校验
    await clickTestid(page, 'export-preview-run')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="export-preview-result"]'),
      { timeout: 10000 },
    )
    await delay(1200)
    const readyCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid^="export-ready-"]').length,
    )
    console.log('[p5] export-ready badges rendered:', readyCount)
    await page.screenshot(path.join(OUT_DIR, 'p5-export-preview.png'), { fullPage: true })

    if (errors.length) console.log('[p5] page errors:', errors.slice(0, 5))
    console.log('[p5] screenshots written to', OUT_DIR)
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[p5] FAIL', e && e.message ? e.message : e)
  process.exit(1)
})
