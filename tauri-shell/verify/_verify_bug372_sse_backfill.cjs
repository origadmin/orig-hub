#!/usr/bin/env node
'use strict'
/**
 * 2026-10-22 BUG-372「未知文件」修复验证：SSE 事件引用陌生 id 时的补齐。
 *
 * 场景（用户截图实录）：任务在别处创建 ⇒ completed 事件带着 {id,status,hash}
 * （无 filename）到达 ⇒ 旧代码造残缺记录 ⇒ 列表/Sheet 标题「未知文件」。
 * 判据：页面已订阅 SSE 的前提下新建任务，行标题必须是真 filename。
 */

const cdp = require('./lib/cdp.cjs')
const DAEMON = 'http://127.0.0.1:19786'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1. 先起页面并停在下载域（SSE 已订阅，store 里还没有新任务）
  const browser = await cdp.launch()
  let created = null
  try {
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:5180/', { waitForRoot: true, settleMs: 2000 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-download"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="dl-group-list"]') !== null,
      { timeout: 30000 },
    )
    await delay(1500)

    // 2. 经 API 新建一个秒完的 mock 任务（页面没经手创建 ⇒ 复现陌生 id 路径）
    const res = await fetch(DAEMON + '/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'mock://ssebackfill.bin?size=1048576&rate=50m', filename: 'ssebackfill.bin' }),
    })
    created = await res.json()
    console.log('created:', created.id)

    // 3. 等行出现（SSE 事件 + 补齐刷新），读标题
    await page.waitForFunction(
      (fname) =>
        [...document.querySelectorAll('[data-testid="download-item"]')].some((r) =>
          (r.textContent || '').includes(fname),
        ),
      { timeout: 20000, args: [created.filename] },
    )
    await delay(1200)
    const row = await page.evaluate((fname) => {
      const r = [...document.querySelectorAll('[data-testid="download-item"]')].find((x) =>
        (x.textContent || '').includes(fname),
      )
      const titleP = r ? r.querySelector('p.truncate') : null
      return {
        found: !!r,
        title: titleP ? titleP.textContent : null,
        status: r ? r.getAttribute('data-status') : null,
        anyUnknown: [...document.querySelectorAll('[data-testid="download-item"]')].some((x) =>
          (x.textContent || '').includes('未知文件'),
        ),
      }
    }, created.filename)
    console.log(JSON.stringify(row))
    const pass = row.found && row.title === 'ssebackfill.bin' && !row.anyUnknown
    console.log(pass ? 'PASS：SSE 补齐后行标题是真 filename' : 'FAIL')
    process.exitCode = pass ? 0 : 1
  } finally {
    await browser.close()
    // 4. 清掉这条自己的测试记录（走应用删除契约）
    if (created && created.id) {
      await fetch(DAEMON + '/api/downloads/' + created.id, { method: 'DELETE' })
      console.log('cleaned up test record', created.id)
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
