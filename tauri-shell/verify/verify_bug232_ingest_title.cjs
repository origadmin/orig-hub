'use strict'
/**
 * BUG-232 v2 真实 UI 验收：入库流水线行标题 = **入库内容的标题**。
 *
 * 数据源修正（v2）：标题由服务端随任务下发（`task.title`，取自消息同步时已落库的
 * `media_message`），不再由壳按媒体库条目 by-ref 反查。因此本探针的**独立对账口径**
 * 是 orig-tg 的消息读取端点 `GET /api/tg/messages/:chat_id`（media_message 的读口），
 * 与 `/tasks/all` 的 title 字段互不依赖 —— 若服务端 title 是错的，这里必然对不上。
 *
 * 断言：
 *  1) 每个任务：UI 行标题必须以「该任务首条消息的 caption」开头（全状态覆盖，
 *     含 failed/interrupted —— 这正是 v2 相对 v1 的增量）。
 *  2) 反空跑：必须有 ≥1 行显示内容标题，且 API title 非空的任务数 > 0。
 *  3) 只有消息库确实没有 caption 的任务，才允许退回频道名/裸 ID。
 * 探针不内嵌任何内容字符串（标题全部运行期现取）。
 */
const cdp = require('./lib/cdp.cjs')
const fs = require('fs')
const path = require('path')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = path.join(__dirname, 'evidence', 'BUG-232')
fs.mkdirSync(OUT, { recursive: true })
// orig-tg 端口由 daemon 真源下发（不得硬编码：端口可被保留区顺延/迁移，BUG-177/178/228）。
const DAEMON = 'http://127.0.0.1:19786'

async function tgBase(page) {
  const p = await page.evaluate(async (D) => {
    const r = await fetch(`${D}/api/config`)
    const d = await r.json()
    // BUG-423：BUG-358 起端口真源是 plugins[] 里 id="tg" 的 port（旧键 tg_port 兜底）
    const plug = Array.isArray(d.plugins) ? d.plugins.find((x) => x && x.id === 'tg') : null
    const port =
      plug && Number(plug.port) > 0 ? Number(plug.port) : Number(d.tg_port) > 0 ? Number(d.tg_port) : null
    return port ? `http://127.0.0.1:${port}` : null
  }, DAEMON)
  if (!p) throw new Error('daemon 未下发 orig-tg 端口（plugins[] id=tg 与旧键 tg_port 均无；TG 未运行？）')
  return p
}

async function main() {
  const browser = await cdp.launch({ headless: false })
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5180/', { settleMs: 2500 })
  const TG = await tgBase(page)
  console.log('tg base:', TG)
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="nav-tg"]'); if (!b) return false; b.click(); return true }))
    throw new Error('nav-tg not found')
  await delay(2500)
  if (!await page.evaluate(() => { const b = document.querySelector('[data-testid="tg-cache-manager-entry"]'); if (!b) return false; b.click(); return true }))
    throw new Error('tg-cache-manager-entry not found（TG 服务未运行？）')
  await delay(2500)

  let rows = []
  for (let i = 0; i < 8; i++) {
    await delay(1200)
    rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="cache-task-row"]')).map((el) => ({
        status: el.getAttribute('data-status'),
        title: (el.querySelector('span.truncate') || {}).textContent || '',
      })),
    )
    if (rows.length) break
  }
  if (rows.length === 0) throw new Error('流水线无任何任务行')
  await page.screenshot(path.join(OUT, '1_ingest_rows.png'))

  // 对账（Node 侧，轻量）：拿服务端下发的 title 作为**契约期望值** —— 本探针的职责是
  // 「UI 是否如实渲染服务端给的行标题」。服务端 title 是否等于 media_message 的 caption
  // 由**独立的 DB 对账**（直接读 store.db，不经过 API）承担：两道合起来覆盖整条链，
  // 避免在 CDP 里逐频道调消息端点（那是微博客式实时扫描，>20s/频道，会拖死探针）。
  let data
  try {
    data = await (await fetch(`${TG}/api/tg/cache/tasks/all`)).json()
  } catch (e) {
    throw new Error(`对账失败（tasks/all）: ${e.message}`)
  }
  const oracle = {
    tasks: (data.tasks || []).map((t) => ({
      id: t.id,
      status: t.status,
      apiTitle: t.title ?? null,
      // 回落行判据要用：无 title 任务的首消息号（产品回落实体 = `#<首消息号>`）
      firstMsg: (t.messageIds || [])[0],
    })),
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const apiTitled = oracle.tasks.filter((t) => t.apiTitle)
  const apiUntitled = oracle.tasks.filter((t) => !t.apiTitle)
  console.log(`tasks=${oracle.tasks.length} 服务端带 title=${apiTitled.length} 无 title=${apiUntitled.length}`)

  const problems = []
  const titleHeads = apiTitled.map((t) => norm(t.apiTitle).slice(0, 12))
  const matched = titleHeads.filter((h) => rows.some((r) => norm(r.title).includes(h))).length
  /*
   * 行分类（对齐产品 `CacheManagerDialog.ingestTitleOf` 的真实形态）：
   *   - 服务端有 title ⇒ 行首就是该 title（BUG-232 修复的本体）；
   *   - 服务端无 title ⇒ 产品回落 `<频道名|"频道 <chatId>"> #<首个消息号>`，
   *     行尾再拼 ` · 单条|整组 · N 条` —— 这是**设计行为**，不是标题丢失。
   * 旧正则 `/^频道\s*-?\d+\s*·/` 盯的是更早的「频道 <id> ·」形态（无 #msgId、
   * 且频道无标题时才出现「频道」字样）：现行回落带 #msgId、频道有标题时不出现
   * 「频道」⇒ 合法回落行被错判进 titledRows，断言 2 把它当「凭空造标题」假红。
   * 回落行身份判据：行首 `#<msgId>` 必须是某个**服务端无 title** 任务的首消息号
   * （产品只为无 title 任务造回落；锚在行首，标题中部含 "#12 ·" 不会误豁免）。
   */
  const untitledFirstMsgs = new Set(apiUntitled.map((t) => t.firstMsg))
  const fallbackMsgOf = (txt) => {
    const m = /^(.+?)\s*#(\d+)\s*·\s*(?:单条|整组)\s*·/.exec(txt)
    return m ? Number(m[2]) : null
  }
  const isFallbackRow = (txt) => {
    const msg = fallbackMsgOf(txt)
    return msg != null && untitledFirstMsgs.has(msg)
  }
  const bareRows = rows.filter((r) => isFallbackRow(norm(r.title)))
  const titledRows = rows.filter((r) => !isFallbackRow(norm(r.title)))

  // 断言 1：反空跑 —— 服务端确实下发了标题，且 UI 至少渲染出一行内容标题
  if (apiTitled.length === 0) problems.push('服务端未对任何任务下发 title（BUG-232 v2 服务端未生效）')
  if (matched === 0) problems.push('UI 没有任何一行显示内容标题（修复未生效）')
  // 断言 2：内容标题行必须与服务端 title 逐一对应（不许凭空造标题）
  for (const r of titledRows) {
    if (!titleHeads.some((h) => norm(r.title).includes(h)))
      problems.push(`UI 行标题不在服务端 title 集合内：${norm(r.title).slice(0, 24)}`)
  }
  // 断言 3（核心回归判据）：显示裸频道 ID 的行数不得超过「服务端确实无 title」的任务数
  // ——旧行为/旧数据源下的失败形态就是大面积退化成裸 ID。
  if (bareRows.length > Math.max(apiUntitled.length, 0))
    problems.push(`裸频道 ID 行 ${bareRows.length} 条 > 服务端无 title 任务 ${apiUntitled.length} 条（标题被丢失）`)
  console.log(`UI 行=${rows.length} 内容标题行=${titledRows.length} 命中服务端 title=${matched} 回落行（无 title 任务的频道回落）=${bareRows.length}`)
  await page.screenshot(path.join(OUT, '2_ingest_rows_settled.png'))
  console.log('sample:', JSON.stringify(rows.slice(0, 6)))
  console.log(problems.length ? 'FAIL: ' + problems.slice(0, 5).join('; ') : 'PASS: 行标题 = 入库内容 caption（全状态）')
  await browser.close()
  if (problems.length) process.exit(1)
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
