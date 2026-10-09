'use strict'
/**
 * BUG-232 真实 UI 验收：入库流水线行标题必须是**入库内容的标题**，不是频道名/裸 chatId。
 * 驱动真实点击链：nav-tg → tg-cache-manager-entry → 读 cache-task-row 标题。
 * 期望值从运行中的 API 现取（done 任务按 ref 查媒体库条目标题），探针不内嵌任何内容字符串。
 * 断言口径：done/interrupted 且库中存在条目的行必须显示条目标题；无库条目的行允许
 * 退回频道名链（内容标题需引擎在任务上落 caption，登记为 BUG-232 剩余范围）。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-232')
fs.mkdirSync(OUT, { recursive: true })
const TG = 'http://127.0.0.1:19787'

async function main() {
  const browser = await cdp.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { settleMs: 2500 })
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-tg"]'); if (!b) return false; b.click(); return true }))
    throw new Error('nav-tg not found')
  await delay(2500)
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="tg-cache-manager-entry"]'); if (!b) return false; b.click(); return true }))
    throw new Error('tg-cache-manager-entry not found（TG 服务未运行？）')
  await delay(2000)

  // 等 by-ref 标题解析落地
  let rows = null
  for (let i = 0; i < 10; i++) {
    await delay(1500)
    rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-testid="cache-task-row"]')).map((el) => ({
        status: el.getAttribute('data-status'),
        title: (el.querySelector('span.truncate') || {}).textContent || '',
      }))
    })
    const doneRows = rows.filter((r) => r.status === 'done' || r.status === 'interrupted')
    if (doneRows.length && doneRows.some((r) => !/^频道\s*-?\d+\s*·/.test(r.title))) break
  }
  if (!rows || rows.length === 0) throw new Error('流水线无任何任务行')
  await page.screenshot(path.join(OUT, '1_ingest_rows.png'))

  // 期望值：从 API 现取 done/interrupted 任务的库条目标题
  const expected = await page.evaluate(async (TG) => {
    const res = await fetch(`${TG}/api/tg/cache/tasks/all`)
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const data = await res.json()
    const tasks = (data.tasks || []).filter(
      (t) => (t.status === 'done' || t.status === 'interrupted') && t.messageIds && t.messageIds[0] != null,
    )
    const out = []
    for (const t of tasks) {
      const ref = `${t.chatId}:${t.messageIds[0]}`
      try {
        const r1 = await fetch(`${TG}/api/media/items/by-ref?source=tg&ref=${encodeURIComponent(ref)}`)
        const d1 = await r1.json()
        if (d1.id == null) { out.push({ ref, title: null }); continue }
        const r2 = await fetch(`${TG}/api/media/items/${d1.id}`)
        const d2 = await r2.json()
        const item = d2.item ?? d2
        out.push({ ref, title: item.title || null })
      } catch (e) {
        out.push({ ref, title: `ERR:${e.message}` })
      }
    }
    return { tasks: out }
  }, TG)
  if (expected.error) throw new Error(`API 对账失败: ${expected.error}`)
  const withTitle = expected.tasks.filter((x) => x.title && !String(x.title).startsWith('ERR:'))
  console.log(`expected: ${expected.tasks.length} done/interrupted, ${withTitle.length} 有库条目标题`)

  const problems = []
  const libless = expected.tasks.filter((x) => x.title == null)
  // 断言 1（核心）：有库条目的行，显示标题必须以条目标题开头（内容标题，非频道名/裸 ID）
  for (const exp of withTitle) {
    const hit = rows.find((r) => (r.status === 'done' || r.status === 'interrupted') && r.title.startsWith(exp.title))
    if (!hit) problems.push(`行未显示内容标题（期望以「${exp.title.slice(0, 20)}…」开头）`)
  }
  // 断言 2：无库条目的行允许退回频道链，但 done 行若显示裸 ID 属 dialogs 退化（记录但不判失败——
  // 频道名解析是 dialogs 数据域问题，登记为 BUG-232 关联项）
  const bareDone = rows.filter((r) => (r.status === 'done' || r.status === 'interrupted') && /^频道\s*-?\d+\s*·/.test(r.title))
  console.log(`bare-ID done/interrupted rows: ${bareDone.length}（无库条目行数 ${libless.length}，dialogs 空时退化展示）`)
  // 断言 3：修复必须至少让一行显示内容标题（防止空跑绿）
  const contentTitled = rows.filter((r) => !/^频道\s*-?\d+\s*·/.test(r.title))
  if (contentTitled.length === 0) problems.push('没有任何行显示内容标题（修复未生效）')
  await page.screenshot(path.join(OUT, '2_ingest_rows_settled.png'))
  console.log('sample rows:', JSON.stringify(rows.slice(0, 8)))
  console.log(problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS: done/interrupted 行标题 = 入库内容标题')
  await browser.close()
  if (problems.length) process.exit(1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
