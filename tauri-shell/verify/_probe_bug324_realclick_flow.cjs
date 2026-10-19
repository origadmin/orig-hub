'use strict'
/**
 * 复现：TG 面板每行「去下载查看」→ 下载域，且落点页面的条目级功能可用。
 *
 * 与 `verify_bug324_cache_entry_simplified.cjs` 的差别：本探针用**真实鼠标事件**
 * （`Input.dispatchMouseEvent`，按元素中心坐标派发）而不是 `el.click()` —— 合成
 * click 不经过命中测试/遮挡判定，用户报「点了没反应」时必须用真事件复现。
 *
 * 用法：node tauri-shell/verify/_repro_bug324_godownload.cjs [baseURL]
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.argv[2] || 'http://127.0.0.1:5180/'
const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug324-realclick-flow')

async function mouseClick(page, selector, nth = 0) {
  const box = await page.evaluate(
    (sel, i) => {
      const el = document.querySelectorAll(sel)[i]
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
        disabled: el.disabled === true,
        pointerEvents: cs.pointerEvents,
        text: (el.textContent || '').trim(),
        // 命中测试：中心点上最顶层元素是不是它（或它的后代）
        topIsSelf: (() => {
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return Boolean(top && (top === el || el.contains(top)))
        })(),
      }
    },
    selector,
    nth,
  )
  if (!box) throw new Error(`missing ${selector}[${nth}]`)
  const sid = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.conn.send(
      'Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 },
      { sessionId: sid },
    )
  }
  return box
}

async function main() {
  const fs = require('node:fs')
  fs.mkdirSync(OUT, { recursive: true })

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)

  const say = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`)

  // 1) TG → 入口 → 面板
  await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]').click())
  await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'), { timeout: 20000 })
  await page.evaluate(() => document.querySelector('[data-testid="tg-cache-manager-entry"]').click())
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="cache-manager"] [data-testid="cache-task-row"]').length > 0,
    { timeout: 20000 },
  )

  // 2) 真鼠标点第一行的「去下载查看」
  const before = await page.evaluate(() => ({
    title: (document.querySelector('[data-testid="page-title"]') || {}).textContent,
    rows: document.querySelectorAll('[data-testid="cache-task-row"]').length,
    firstRowTask: (() => {
      const r = document.querySelector('[data-testid="cache-task-row"]')
      return r ? { id: r.getAttribute('data-task-id'), text: (r.textContent || '').replace(/\s+/g, ' ').slice(0, 100) } : null
    })(),
  }))
  say('before', before)

  const box = await mouseClick(page, '[data-testid="cache-task-godownload"]', 0)
  say('clicked', box)

  // 面板消失是同步的，可以立刻断言；但下载域列表要等 ingest 分组回来，
  // **不能固定 sleep**（1.2s 时常不够 ⇒ 读到 0 行，把后面的抽屉步骤整段跳过）。
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="cache-manager-overlay"]'),
    { timeout: 8000 },
  )
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0 ||
      /暂无|没有|空/.test((document.querySelector('[data-testid="page-body"]') || document.body).textContent || ''),
    { timeout: 20000 },
  )
  const after = await page.evaluate(() => ({
    overlay: !!document.querySelector('[data-testid="cache-manager-overlay"]'),
    title: (document.querySelector('[data-testid="page-title"]') || {}).textContent,
    ingestRows: document.querySelectorAll('[data-testid="ingest-group-row"]').length,
    tgPanelMounted: !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
  }))
  say('after-click', after)
  await page.screenshot(path.join(OUT, '01-after-real-click.png'))

  // 3) 落点页面的条目级功能：明细入口 → Sheet
  let sheetInfo = null
  if (after.ingestRows > 0) {
    const t2 = await mouseClick(page, '[data-testid="ingest-group-toggle"]', 0)
    say('clicked-detail-toggle', t2)
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="ingest-detail-sheet"]'), { timeout: 8000 })
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0 ||
          /无明细|加载失败/.test((document.querySelector('[data-testid="ingest-detail-sheet"]') || {}).textContent || ''),
        { timeout: 8000 },
      )
      sheetInfo = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="ingest-detail-sheet"]')
        return {
          open: true,
          entries: s.querySelectorAll('[data-testid="ingest-sheet-entry"]').length,
          entryDownloads: s.querySelectorAll('[data-testid="ingest-sheet-entry-download"]').length,
          hasStopNote: /条目级停止不存在/.test(s.textContent || ''),
          head: (s.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
        }
      })
    } catch (e) {
      sheetInfo = { open: false, err: e.message }
    }
    await page.screenshot(path.join(OUT, '02-detail-sheet.png'))
  }
  say('sheet', sheetInfo)

  // 4) 行内动作按钮清单（落点页面）
  const rowActions = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="ingest-group-row"]')
    if (!row) return null
    return {
      testids: Array.from(row.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')),
      text: (row.textContent || '').replace(/\s+/g, ' ').slice(0, 160),
    }
  })
  say('row-actions', rowActions)

  // 5) 跳走后再回 TG 域：面板**不该**又自动弹出来（`onClose()` 先行的意义）
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="ingest-detail-sheet-close"]')
    if (c) c.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]').click())
  await new Promise((r) => setTimeout(r, 1500))
  const backToTg = await page.evaluate(() => ({
    title: (document.querySelector('[data-testid="page-title"]') || {}).textContent,
    overlayReopened: !!document.querySelector('[data-testid="cache-manager-overlay"]'),
    entryPresent: !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
  }))
  say('back-to-tg', backToTg)
  await page.screenshot(path.join(OUT, '03-back-to-tg.png'))

  const errs = page.consoleErrors().filter((e) => !/favicon|DevTools/i.test(e))
  say('console-errors', errs.slice(0, 5))
  say('page-errors', page.pageErrors().slice(0, 5))

  await browser.close()
  console.log(`shots -> ${OUT}`)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
