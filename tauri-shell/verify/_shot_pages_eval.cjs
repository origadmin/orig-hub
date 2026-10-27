#!/usr/bin/env node
'use strict'

/**
 * 逐页截图 + 结构快照（评估用，非门禁）。
 *
 * 用途：把 5 个一级域 / 下载 4 档 / 文件 6 分类 / 剧集墙逐一切换并截图，同时抓
 * 每页的「标题 / 主区文本摘要 / 可见控件数量 / 行数」，作为架构评估的事实底稿。
 *
 * 为什么不截 Tauri 壳：壳的 WebView2 在本机无法创建（另案 BUG-446），
 * 而前端源码在 vite(5180) 下渲染正常（verify_ui_render 24/24 PASS）。
 * 截的是同一份前端代码，页面形态与壳内一致，只是没有窗口边框。
 *
 * 用法：
 *   node verify/_shot_pages_eval.cjs
 *   APP_URL=http://127.0.0.1:5180/ OUT_DIR=<dir> node verify/_shot_pages_eval.cjs
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT_DIR =
  process.env.OUT_DIR || path.resolve(__dirname, '..', '..', 'verify_shots', 'eval-2026-10-27')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面清单：name 决定文件名，steps 是依次点击的 data-testid。 */
const PAGES = [
  { name: '01-files-video', label: '文件域 / 视频', steps: ['nav-files', 'nav-child-cat-video'] },
  { name: '02-files-music', label: '文件域 / 音乐', steps: ['nav-files', 'nav-child-cat-music'] },
  { name: '03-files-image', label: '文件域 / 图片', steps: ['nav-files', 'nav-child-cat-image'] },
  { name: '04-files-doc', label: '文件域 / 文档', steps: ['nav-files', 'nav-child-cat-doc'] },
  { name: '05-files-archive', label: '文件域 / 压缩包', steps: ['nav-files', 'nav-child-cat-archive'] },
  { name: '06-files-other', label: '文件域 / 其他', steps: ['nav-files', 'nav-child-cat-other'] },
  { name: '07-files-series', label: '文件域 / 剧集墙', steps: ['nav-files', 'nav-child-lib-series'] },
  { name: '08-download-all', label: '下载域 / 全部', steps: ['nav-download', 'nav-child-dl-all'] },
  { name: '09-download-running', label: '下载域 / 进行中', steps: ['nav-download', 'nav-child-dl-running'] },
  { name: '10-download-paused', label: '下载域 / 已暂停', steps: ['nav-download', 'nav-child-dl-paused'] },
  { name: '11-download-done', label: '下载域 / 已完成', steps: ['nav-download', 'nav-child-dl-done'] },
  { name: '12-tg', label: 'TG 域', steps: ['nav-tg'] },
  { name: '13-share', label: '分享域', steps: ['nav-share'] },
  { name: '14-settings', label: '设置域', steps: ['nav-settings'] },
]

async function clickTestId(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return { ok: false, reason: 'not-found' }
    el.click()
    return { ok: true }
  }, testId)
}

/** 抓当前页的结构快照（只读 DOM，不做布局断言）。 */
async function snapshot(page) {
  return page.evaluate(() => {
    const txt = (el) => (el ? (el.textContent || '').trim() : '')
    const main = document.querySelector('main') || document.body
    const rows = main.querySelectorAll('[data-testid$="-row"], tr, li').length
    const buttons = [...main.querySelectorAll('button')]
    const cards = main.querySelectorAll('[data-testid*="card"], [data-testid*="item"]').length
    // 可见控件文案（去重、限长），用于判断该页提供了哪些动作
    const actions = [...new Set(buttons.map((b) => (b.textContent || '').trim()).filter(Boolean))]
      .slice(0, 12)
    return {
      pageTitle: txt(document.querySelector('[data-testid="page-title"]')),
      contextBar: txt(document.querySelector('[data-testid="context-bar"]')).slice(0, 300),
      bodyText: (main.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
      rowCount: rows,
      buttonCount: buttons.length,
      cardCount: cards,
      actions,
    }
  })
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  const report = { appUrl: APP_URL, capturedAt: new Date().toISOString(), pages: [] }

  try {
    await page.goto(APP_URL, { timeout: 45000 })
    await sleep(4000)

    for (const p of PAGES) {
      for (const step of p.steps) {
        const r = await clickTestId(page, step)
        if (!r.ok) {
          report.pages.push({ ...p, error: `step ${step} ${r.reason}` })
          break
        }
        await sleep(1100)
      }
      await sleep(700)
      const shot = path.join(OUT_DIR, `${p.name}.png`)
      await page.screenshot(shot)
      let snap = {}
      try {
        snap = await snapshot(page)
      } catch (e) {
        snap = { error: String(e) }
      }
      report.pages.push({ ...p, shot, ...snap })
      console.log(`[shot] ${p.name}  ${p.label}  rows=${snap.rowCount} btns=${snap.buttonCount}`)
    }

    report.consoleErrors = page.consoleErrors ? page.consoleErrors() : []
    report.pageErrors = page.pageErrors ? page.pageErrors() : []
  } finally {
    await browser.close()
  }

  const out = path.join(OUT_DIR, 'report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nreport: ${out}`)
  console.log(`shots:  ${OUT_DIR}`)
}

main().catch((e) => {
  console.error('[shot] FAILED:', e && e.message ? e.message : e)
  process.exit(1)
})
