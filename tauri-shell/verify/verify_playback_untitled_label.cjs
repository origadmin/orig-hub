#!/usr/bin/env node
'use strict'

/**
 * BUG-206 真实 UI 验收：播放（消费）面不得把内部 id 当「无标题」兜底显示。
 *
 * ## 缺陷回顾（用户 2026-09-30 反馈「来源编辑显示ID没什么问题,但是播放显示ID是不是过了?」）
 *
 * 内部主键（media_item.id）属于管理/仓储概念：编辑面（SeriesDetail 的来源徽标
 * `#<itemId>`）显示它是为了管理定位，用户认可；但播放面（MediaViewer /
 * EpisodeList）是**消费界面**，此前有 4 处在「标题与文案都为空」时把
 * `#<内部id>` 当兜底文案渲染出来 —— 把 DB 主键漏给了观看者：
 *
 *   1. MediaViewer 返回行标题      `#${cur.messageId}`
 *   2. MediaViewer 图片缩略带 hover `#${it.messageId}`
 *   3. MediaViewer「即将播放」卡片   `#${nextItem.messageId}`
 *   4. EpisodeList 无标题视频集      `#${ep.itemId}`
 *
 * ## 修复要点
 *
 * 四处兜底统一换成中性文案 `t('player.untitled')`（未命名 / Untitled）；
 * 内部 id 不进可视文案，但 `data-testid="media-viewer"` 上的
 * `data-message-id` 属性**保留** —— 自动化/探针仍按 id 定位，用户看不见。
 *
 * ## 判据（全部通过才算修复）
 *
 * 1. 打开一个 caption/title 全空的视频项：返回行标题 === 「未命名」，且不以 `#` 开头。
 * 2. `data-message-id` 属性仍是内部 id（工具可用、用户不可见）。
 * 3. 打开两个 caption 全空的图片项：缩略带 `title` 提示 === 「未命名」，不以 `#` 开头。
 * 4. 全程无页面错误。
 *
 * 用法：先起开发态服务（`python scripts/dev_services.py` + vite dev 5180），
 * 再 `node verify/verify_playback_untitled_label.cjs`。
 * 证据目录：`ORIG_VERIFY_OUT`（默认系统临时目录 `orighub-verify-playback-untitled`）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-playback-untitled'),
)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try { size = fs.statSync(f).size } catch (_e) {}
  console.log(`[verify] shot ${name} -> ${f} (${size} bytes)`)
}

/** 1×1 透明 PNG：只作占位 src，标题断言不依赖它能否解码 */
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    console.log('[verify] navigated to', APP_URL)

    // dev 构建的调试钩子（useStore.ts 挂载）：直接驱动 store，避免脆弱的 UI 导航
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })
    console.log('[verify] __origStore ready')

    // ---- A：无标题视频 → 返回行标题必须是「未命名」，不是 #id ----
    await page.evaluate((png) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: 990001,
            chatId: -100,
            messageId: 990001,
            kind: 'video',
            caption: '',
            description: '',
            src: png,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    }, PNG_1x1)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), { timeout: 8000 })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="viewer-title"]'), { timeout: 8000 })
    await delay(700)
    const a = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="viewer-title"]')
      const v = el ? (el.textContent || '').trim() : null
      const msgAttr = document
        .querySelector('[data-testid="media-viewer"]')
        ?.getAttribute('data-message-id')
      return { title: v, msgAttr }
    })
    console.log('[verify] A title=', JSON.stringify(a))
    await shot(page, 'A-untitled-video.png')
    check('A: untitled video title is the neutral label (not an id)', a.title === '未命名', `title="${a.title}"`)
    check('A: viewer title does NOT start with #', !(a.title || '').startsWith('#'), `title="${a.title}"`)
    check(
      'A: data-message-id attribute still carries the internal id for tooling',
      String(a.msgAttr) === '990001',
      `data-message-id=${a.msgAttr}`,
    )

    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(300)

    // ---- B：两张无标题图片 → 缩略带 title 提示必须是「未命名」，不是 #id ----
    await page.evaluate((png) => {
      window.__origStore.getState().openViewer({
        items: [
          { key: 990002, chatId: -100, messageId: 990002, kind: 'photo', caption: '', description: '', src: png, poster: png, episodeNo: null, seriesId: null },
          { key: 990003, chatId: -100, messageId: 990003, kind: 'photo', caption: '', description: '', src: png, poster: png, episodeNo: null, seriesId: null },
        ],
        index: 0,
        title: '',
      })
    }, PNG_1x1)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="photo-strip-item"]'), { timeout: 8000 })
    await delay(500)
    const b = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="photo-strip-item"]')
      return { titleAttr: el ? el.getAttribute('title') || '' : null }
    })
    console.log('[verify] B photoStrip=', JSON.stringify(b))
    await shot(page, 'B-untitled-photos.png')
    check('B: untitled photo-strip tooltip is the neutral label', b.titleAttr === '未命名', `title="${b.titleAttr}"`)
    check('B: photo-strip tooltip does NOT start with #', !(b.titleAttr || '').startsWith('#'), `title="${b.titleAttr}"`)

    const errs = page.pageErrors().slice(0, 10)
    const cerrs = page
      .consoleErrors()
      .slice(0, 10)
      .filter((e) => !/favicon|Failed to load resource|net::ERR|media resource|autoplay|Widevine|tensor/i.test(e))
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(errs))
    console.log('[verify] CONSOLE_ERRORS:', JSON.stringify(cerrs))
    check('no page errors', errs.length === 0, JSON.stringify(errs))
    check('no console errors', cerrs.length === 0, JSON.stringify(cerrs))

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    await browser.close()
  }
}
main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
