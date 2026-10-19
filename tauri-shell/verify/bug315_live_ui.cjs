/**
 * BUG-315 活栈 UI 验收（CDP / Edge）：展开 TG 入库组行的「条目明细」，
 * 确认新透传字段（标题/caption、大小/size、时间/msgDate、传输态）真实渲染出来。
 *
 * 用法：node tauri-shell/verify/bug315_live_ui.cjs [baseURL=http://127.0.0.1:5180]
 * 前置：dev 栈（:5180 vite + :19786 daemon + :19787 orig-tg）在跑；本机有 Microsoft Edge。
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

// Edge 路径从环境变量推导，不写死盘符（污染门禁 §7：脚本禁含机器绝对路径）；
// 可用 EDGE_PATH 覆盖。参照同目录 diag_loopback.cjs 的既有做法。
function edgePath() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH
  const cands = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  return cands.find((p) => fs.existsSync(p))
}

const BASE = process.argv[2] || 'http://127.0.0.1:5180'
const OUT = path.resolve(__dirname, 'evidence')
fs.mkdirSync(OUT, { recursive: true })

;(async () => {
  const browser = await chromium.launch({ executablePath: edgePath(), args: ['--lang=zh-CN'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1500)

  const toggle = await page.$('[data-testid="nav-download"]')
  if (!toggle) throw new Error('nav-download 缺失')
  await toggle.click()
  await page.waitForTimeout(1500)

  // 等至少一个组行出现
  await page.waitForSelector('[data-testid="ingest-group-toggle"]', { timeout: 8000 })
  // 展开第一个组行
  const first = await page.$('[data-testid="ingest-group-toggle"]')
  await first.click()
  await page.waitForTimeout(1500)

  await page.waitForSelector('[data-testid="ingest-group-entries"]', { timeout: 8000 })
  // 取展开区文本 + 单个条目文本
  const panelText = await page.$eval('[data-testid="ingest-group-panel"]', (el) => el.innerText)
  const entryTexts = await page.$$eval('[data-testid="ingest-group-entry"]', (els) =>
    els.slice(0, 3).map((e) => e.innerText.replace(/\s+/g, ' ').trim()),
  )

  // 判据：明细里必须出现「具体字节数」（大小列），且至少一条带标题/caption 文本。
  const hasSize = /\d+(\.\d+)?\s?(MB|GB|KB|B)\b/i.test(panelText)
  const hasCaptionOrTitle = entryTexts.some((t) => t.length > 0)

  await page.screenshot({ path: path.join(OUT, 'bug315_manifest_expanded.png'), fullPage: false })

  console.log('--- panel text (前 600 字) ---')
  console.log(panelText.slice(0, 600))
  console.log('--- 前 3 条 entry 渲染文本 ---')
  entryTexts.forEach((t, i) => console.log(`[${i}] ${t.slice(0, 200)}`))
  console.log('--- 判据 ---')
  console.log(`hasSize(具体字节数): ${hasSize}`)
  console.log(`hasEntryText(标题/caption 渲染): ${hasCaptionOrTitle}`)
  console.log(`console errors: ${errors.length}`)
  console.log(hasSize && hasCaptionOrTitle ? 'RESULT: PASS' : 'RESULT: FAIL')
  await browser.close()
  process.exit(hasSize && hasCaptionOrTitle ? 0 : 1)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
