'use strict'
/**
 * BUG-314 撤档视觉自证：侧栏下载树展开后**只有三项**子项（running/paused/done），
 * 且第四项「已取消」不存在。真实 Edge + dev :5180 活栈。
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

async function main() {
  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/')
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  // 展开下载父行（再点一次 = 展开子树；Sidebar 父行点击即展开/收起）
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="nav-download"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  const info = await page.evaluate(() => {
    const kids = Array.from(document.querySelectorAll('[data-testid^="nav-child-dl-"]'))
    return {
      count: kids.length,
      ids: kids.map((k) => k.getAttribute('data-testid')),
      texts: kids.map((k) => (k.textContent || '').trim()),
      hasCancelled: !!document.querySelector('[data-testid="nav-child-dl-cancelled"]'),
    }
  })
  console.log(JSON.stringify(info))
  await page.screenshot(
    path.resolve(__dirname, '..', '..', 'verify_shots', 'bug314-sidebar-download-tree.png'),
  )
  await browser.close()
  if (info.count !== 3 || info.hasCancelled) {
    console.error('FAIL - 下载树子项不是恰三项或仍含已取消')
    process.exit(1)
  }
  console.log('PASS - 下载树恰三项（running/paused/done），无「已取消」')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
