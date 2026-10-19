'use strict'
/**
 * BUG-315 验收（**迁移版**，2026-10-17）：图片条目不再显示 TG 内部 message_id
 * （`#163`），而是可读的类型标识「图片」。
 *
 * ## 为什么换家
 *
 * 原脚本走 TG 侧缓存管理面板的逐条清单（`cache-task-manifest-toggle` →
 * `cache-task-manifest-entry`）。2026-10-17 用户裁定「入口只需要简易内容，全部都在
 * 下载里面，其他都不要」：TG 侧那份逐条清单已整体撤除（`TaskManifestPanel` 删除），
 * 条目级明细的家只剩**下载域** `IngestDetailSheet`（`ingest-sheet-entry`）。
 * 判据本身不变（图片标签可读、无裸 `#messageId`），只是观测面搬家 —— 这正是
 * 「验牙连续性」要求的映射：
 *
 *   cache-task-manifest-toggle → ingest-group-toggle（行上「明细 N」按钮）
 *   cache-task-manifest-entry  → ingest-sheet-entry
 *   承载面板 cache-manager     → ingest-detail-sheet
 *
 * ## 判据
 *
 *   A1 下载域能列出入库组（ingest-group-row ≥ 1）；
 *   A2 至少一个组的明细里含**图片**条目（找不到就是环境无图片样本，不是通过）；
 *   A3 该组内「图片」标签行 ≥ 1（媒体类型可读化生效）；
 *   A4 该组内裸 `#<messageId>` 标签行 = 0（photo/video 之外才允许裸号）；
 *   A5 无 console error。
 *
 * ## 验牙（反向证伪）
 *
 *   `BUG315_NEGATE=1 node verify/bug315_photo_label.cjs`
 *   ⇒ 断言取反（要求「图片 0 行 且 裸号 > 0」），在正确构建上**必须 FAIL**。
 *   不 FAIL 说明断言根本没咬住渲染（例如选择器写错、恒读到空数组）。
 *
 * 用法：node tauri-shell/verify/bug315_photo_label.cjs [baseURL]
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.argv[2] || process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const NEGATE = process.env.BUG315_NEGATE === '1'
const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug315-photo-label')
/** 最多探查多少个入库组去找图片样本（避免整表遍历拖长验收）。 */
const MAX_GROUPS = 12

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

async function main() {
  const fs = require('node:fs')
  fs.mkdirSync(OUT, { recursive: true })

  const browser = await cdp.launch()
  const page = await browser.newPage()

  await page.goto(APP)

  // ── A1：下载域列出入库组 ──────────────────────────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0,
    { timeout: 20000 },
  )
  const groupCount = await page.evaluate(
    () => document.querySelectorAll('[data-testid="ingest-group-row"]').length,
  )
  check(`A1 下载域列出入库组（${groupCount} 组）`, groupCount > 0, `count=${groupCount}`)

  // ── A2..A4：逐组开明细，找图片样本 ────────────────────────────────
  let sampled = null
  const scanned = []
  for (let i = 0; i < Math.min(groupCount, MAX_GROUPS); i += 1) {
    const opened = await page.evaluate((idx) => {
      const toggles = document.querySelectorAll('[data-testid="ingest-group-toggle"]')
      const el = toggles[idx]
      if (!el) return false
      el.click()
      return true
    }, i)
    if (!opened) continue

    try {
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="ingest-detail-sheet"]'),
        { timeout: 6000 },
      )
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0,
        { timeout: 6000 },
      )
    } catch {
      // 该组明细没出来（空/超时）：关掉继续
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="ingest-detail-sheet-close"]')
        if (c) c.click()
      })
      continue
    }

    const labels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="ingest-sheet-entry"]')).map((r) => {
        const first = r.firstElementChild
        return (first ? first.textContent : '').trim()
      }),
    )
    const photo = labels.filter((l) => l === '图片').length
    const bare = labels.filter((l) => /^#\d+$/.test(l)).length
    scanned.push({ group: i, total: labels.length, photo, bare })
    if (photo > 0) {
      sampled = { group: i, labels, photo, bare }
      break
    }

    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="ingest-detail-sheet-close"]')
      if (c) c.click()
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="ingest-detail-sheet"]'),
      { timeout: 6000 },
    )
  }

  await page.screenshot(path.join(OUT, 'bug315_photo_label.png'))
  const errors = page
    .consoleErrors()
    .filter((e) => !/favicon|DevTools/i.test(e))
  const pageErrs = page.pageErrors()
  console.log('--- 扫描过的组 ---')
  scanned.forEach((s) => console.log(JSON.stringify(s)))

  const photoRows = sampled ? sampled.photo : 0
  const bareIdRows = sampled ? sampled.bare : -1
  console.log('--- 判据 ---')
  console.log(`命中图片样本的组: ${sampled ? `#${sampled.group}` : '无'}`)
  console.log(`图片标签行数: ${photoRows}`)
  console.log(`裸 #messageId 行数: ${bareIdRows}${sampled ? '' : '（无样本，未测）'}`)
  console.log(`console errors: ${errors.length}`)
  if (pageErrs.length) console.log(`page errors: ${pageErrs.slice(0, 3).join(' | ')}`)

  const okA2 = !!sampled
  const okA3 = sampled ? sampled.photo >= 1 : false
  const okA4 = sampled ? sampled.bare === 0 : false
  const okA5 = errors.length === 0 && pageErrs.length === 0

  if (NEGATE) {
    // 反向证伪：正确构建上必须全红
    check('NEGATE A2 反取：要求找不到图片样本（正确构建上应 FAIL）', !okA2)
    check('NEGATE A3 反取：要求图片标签 0 行（正确构建上应 FAIL）', !okA3)
    check('NEGATE A4 反取：要求存在裸 #id 行（正确构建上应 FAIL）', !okA4)
  } else {
    check(`A2 找到含图片的入库组明细（${sampled ? `#${sampled.group}` : '无'}）`, okA2)
    check(`A3 组内「图片」标签行 ≥ 1（实到 ${photoRows}）`, okA3, JSON.stringify(sampled || {}))
    check(`A4 组内裸 #messageId 行 = 0（实到 ${bareIdRows}）`, okA4, JSON.stringify(sampled || {}))
    check(`A5 无 console error（${errors.length}）`, okA5, errors.slice(0, 3).join(' | '))
  }

  await browser.close()
  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-315 图片标签可读化${NEGATE ? '（反向证伪）' : ''}：${pass} pass / ${fail} fail`,
  )
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
