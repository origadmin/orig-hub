#!/usr/bin/env node
'use strict'

/**
 * 一次性探针：点相册折叠封面后，DOM 到底变了什么（MutationObserver 记账）。
 *
 * 目的：区分三种可能
 *   ① 处理器根本没接上（点了 DOM 无变化）；
 *   ② 状态变了但被别的渲染路径覆盖（变了又变回去）；
 *   ③ 变了但 testid 不是 `album-grid`（判据认错形态）。
 *
 * Usage: node verify/_probe_album_mutation.cjs
 */

const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 900, height: 600 })
    await page.goto(APP, { waitForRoot: true, settleMs: 1500, timeout: 90000, attempts: 3 })
    await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="nav-tg"]')
      if (nav) nav.click()
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0, { timeout: 60000 })
    await page.evaluate(() => document.querySelector('[data-testid="tg-monitor-row"]').click())
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="album-cover"]').length > 0, { timeout: 60000 })
    await delay(1500)

    const res = await page.evaluate(async () => {
      // ★ 资源时间线默认只留 250 条，缩略图一多就把早先的记录挤掉 ⇒ 必须先抬高上限，
      //   否则「封面没发请求」是缓冲区溢出，不是事实。
      performance.setResourceTimingBufferSize(20000)
      const findCover = () => document.querySelector('[data-testid="album-cover"]')
      const first = findCover()
      if (!first) return { error: 'no album-cover' }
      first.scrollIntoView({ block: 'center' })
      await new Promise((r) => setTimeout(r, 400))

      const msgId = first.getAttribute('data-message-id')
      const chatId = first.getAttribute('data-chat-id')
      const snap = () => ({
        cover: document.querySelectorAll('[data-testid="album-cover"]').length,
        grid: document.querySelectorAll('[data-testid="album-grid"]').length,
        collapse: document.querySelectorAll('[data-testid="album-collapse"]').length,
        tiles: document.querySelectorAll('[data-testid^="tg-album-tile-"]').length,
        sameCoverStill: !!document.querySelector(
          `[data-testid="album-cover"][data-message-id="${msgId}"]`,
        ),
      })

      const before = snap()
      const mutations = []
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (mutations.length >= 40) break
          const t = r.target
          mutations.push(
            r.type === 'attributes'
              ? `attr:${t.tagName.toLowerCase()}#${t.getAttribute('data-testid') || '-'}@${r.attributeName}`
              : `child:${t.tagName.toLowerCase()}#${t.getAttribute('data-testid') || '-'}+${r.addedNodes.length}-${r.removedNodes.length}`,
          )
        }
      })
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-testid', 'class', 'style'] })

      // ★ 点击前**重新查询**：轮询重渲染会把先前抓到的节点换成游离节点，
      //   对游离节点 click() 不产生任何 DOM 变更（假「点了没反应」）。
      const el = findCover()
      const detached = !document.contains(el)
      const snapNow = () => ({
        grid: document.querySelectorAll('[data-testid="album-grid"]').length,
        collapse: document.querySelectorAll('[data-testid="album-collapse"]').length,
        cover: document.querySelectorAll('[data-testid="album-cover"]').length,
      })
      // 第一次点击 → 看是否展开
      el.click()
      await new Promise((r) => setTimeout(r, 1200))
      const afterClick1 = snapNow()
      // 若没展开，再点一次（区分「首次点击被吞」与「处理器没接上」）
      let afterClick2 = null
      if (afterClick1.grid === 0) {
        const el2 = findCover()
        if (el2) el2.click()
        await new Promise((r) => setTimeout(r, 1200))
        afterClick2 = snapNow()
      }
      await new Promise((r) => setTimeout(r, 1300))
      obs.disconnect()
      const after = snap()

      const thumbs = performance
        .getEntriesByType('resource')
        .map((e) => /\/api\/tg\/thumb\/([^/]+)\/([^/?#]+)/.exec(e.name))
        .filter(Boolean)
        .map((m) => m[1] + ':' + m[2])

      return {
        msgId,
        chatId,
        detached,
        before,
        afterClick1,
        afterClick2,
        after,
        mutations: mutations.slice(0, 40),
        coverThumbSeen: thumbs.includes(`${chatId}:${msgId}`),
        thumbEntries: thumbs.length,
      }
    })

    console.log(JSON.stringify(res, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[probe] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
