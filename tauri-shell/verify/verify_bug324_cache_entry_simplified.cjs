'use strict'
/**
 * BUG-324 验收（TG 侧入库入口「简易内容」终态 + 每行下载跳转）。
 *
 * 用户裁定（原话，2026-10-17）：
 *   「编入 不应该有编入. 不应该缺少下载跳转.」
 *   「入口只需要简易内容,全部都在下载里面,其他都不要!」
 *   「两处都撤」+「弹窗每行加下载跳转」
 *
 * 落成三条可观测契约：
 *   ① 全部「编入」字样消失（TG 侧行按钮 + 逐条清单徽标 + 下载域明细抽屉汇总/条目徽标）；
 *   ② TG 侧不再重复条目级明细 —— 逐条清单（`TaskManifestPanel`）整体撤除；
 *   ③ 面板**每行**给出「去下载查看」出口，落到下载域「全部下载」（条目级明细的家）。
 *
 * 判据：
 *   A1 TG 入口存在，点击弹出面板（overlay + cache-manager 都在）；
 *   A2 面板每行都有「去下载查看」（行数 ≥ 1，带按钮行数 === 行数）；
 *   A3 逐条清单已撤：全文档无 `cache-task-manifest-toggle` / `cache-task-manifest-entry`；
 *   A4 面板内文本**不含**「编入」（内部术语不得出现在界面）；
 *   A5 点某行「去下载查看」⇒ 面板关闭（overlay 消失）且落到下载域（page-title=全部下载、
 *      入库组行渲染出来）——「先关面板再跳」的顺序错了会留下 `tgCacheManagerOpen`，
 *      切回 TG 域会又弹面板；
 *   A6 无 console / page error；
 *   A7 下载域明细抽屉（第二处）同样无「编入」；
 *   A7b 条目徽标已是「入库」词表（已入库 / 已登记未入库 / 无条目 / 缺字节）。
 *
 * 验牙（反向证伪）：
 *   `BUG324_NEGATE=1 node verify/verify_bug324_cache_entry_simplified.cjs`
 *   ⇒ A2/A3/A4/A5 取反（要求「没有下载按钮 / 存在逐条清单 / 含编入 / 未落到下载域」），
 *   在正确构建上**必须 FAIL**；不 FAIL 说明断言没咬住（选择器写错或恒真）。
 *   A1/A6/A7 不取反 —— 它们是环境前置与全局约束，不是本次变更的声明。
 *
 * 用法：node tauri-shell/verify/verify_bug324_cache_entry_simplified.cjs [baseURL]
 */
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP = process.argv[2] || process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const NEGATE = process.env.BUG324_NEGATE === '1'
const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug324-cache-entry-simplified')

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

  // ── A1：TG 入口 → 面板 ─────────────────────────────────────────────
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
    { timeout: 20000 },
  )
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tg-cache-manager-entry"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-testid="cache-manager-overlay"]') &&
      !!document.querySelector('[data-testid="cache-manager"]'),
    { timeout: 10000 },
  )
  // 记录列表是异步拉的（`listAllCacheTasks`）：不等就截到一张空面板，
  // 断言也会读到 0 行。等首行出现再拍、再量。
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-testid="cache-manager"] [data-testid="cache-task-row"]',
      ).length > 0,
    { timeout: 20000 },
  )
  await page.screenshot(path.join(OUT, '01-panel-open.png'))
  const a1 = await page.evaluate(() => ({
    overlay: !!document.querySelector('[data-testid="cache-manager-overlay"]'),
    panel: !!document.querySelector('[data-testid="cache-manager"]'),
    title: (() => {
      const el = document.querySelector('[data-testid="page-title"]')
      return el ? (el.textContent || '').trim() : null
    })(),
  }))
  check(
    `A1 点 TG 入口弹出面板（overlay=${a1.overlay}、panel=${a1.panel}、标题="${a1.title}"）`,
    a1.overlay && a1.panel,
    JSON.stringify(a1),
  )

  // ── A2..A4：面板内部契约 ───────────────────────────────────────────
  const inner = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="cache-manager"]')
    if (!panel) return { rows: -1 }
    const rows = Array.from(panel.querySelectorAll('[data-testid="cache-task-row"]'))
    return {
      rows: rows.length,
      withDownload: rows.filter((r) => r.querySelector('[data-testid="cache-task-godownload"]'))
        .length,
      downloadText: (() => {
        const b = panel.querySelector('[data-testid="cache-task-godownload"]')
        return b ? (b.textContent || '').trim() : null
      })(),
      manifestToggle: document.querySelectorAll('[data-testid="cache-task-manifest-toggle"]').length,
      manifestEntry: document.querySelectorAll('[data-testid="cache-task-manifest-entry"]').length,
      hasBianru: (panel.textContent || '').includes('编入'),
    }
  })

  if (NEGATE) {
    check('NEGATE A2 反取：要求没有下载按钮（正确构建上应 FAIL）', !(inner.rows > 0 && inner.withDownload === inner.rows))
    check('NEGATE A3 反取：要求存在逐条清单（正确构建上应 FAIL）', !(inner.manifestToggle === 0 && inner.manifestEntry === 0))
    check('NEGATE A4 反取：要求面板含「编入」（正确构建上应 FAIL）', inner.hasBianru === true)
  } else {
    check(
      `A2 每行都有「去下载查看」（行 ${inner.rows}，带按钮 ${inner.withDownload}，文案="${inner.downloadText}"）`,
      inner.rows > 0 && inner.withDownload === inner.rows,
      JSON.stringify(inner),
    )
    check(
      `A3 逐条清单已撤（manifest-toggle=${inner.manifestToggle}、manifest-entry=${inner.manifestEntry}）`,
      inner.manifestToggle === 0 && inner.manifestEntry === 0,
      JSON.stringify(inner),
    )
    check(`A4 面板内不含「编入」（hasBianru=${inner.hasBianru}）`, inner.hasBianru === false, JSON.stringify(inner))
  }

  // ── A8：窄窗（900px，壳 minWidth）下每行多一个按钮不得溢出 ──────────
  //   本轮给**每一行**加了「去下载查看」⇒ 行内动作簇变宽。900px 是壳的
  //   `minWidth`（最矮受支持窗口），溢出会横向撑破面板（记忆里 ContextBar
  //   右槽就是这么被压的）。判据按 `scrollWidth - clientWidth` 实量，
  //   不看 `overflow` 声明 —— 声明 auto 不等于真的没溢出。
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 600, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
  await new Promise((r) => setTimeout(r, 600))
  const a8 = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="cache-manager"]')
    if (!panel) return { ok: false, reason: 'panel missing' }
    const rows = Array.from(panel.querySelectorAll('[data-testid="cache-task-row"]'))
    const overflowing = rows.filter((r) => r.scrollWidth - r.clientWidth > 1)
    return {
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      rows: rows.length,
      overflowingRows: overflowing.length,
      sample: overflowing[0] ? overflowing[0].textContent.replace(/\s+/g, ' ').slice(0, 120) : null,
    }
  })
  await page.screenshot(path.join(OUT, '04-narrow-900.png'))
  if (NEGATE) {
    // 不取反：布局约束是全局质量门，不属本次变更声明。
    console.log(`  (A8 布局读数：${JSON.stringify(a8)})`)
  } else {
    check(
      `A8 900px 下无横向溢出（面板 ${a8.panelOverflow}px、行 ${a8.rows} 中溢出 ${a8.overflowingRows}）`,
      a8.panelOverflow <= 1 && a8.overflowingRows === 0,
      JSON.stringify(a8),
    )
  }
  // 还原视口（A5 之后要在常规宽度下判落点）
  await page.conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    { sessionId: page.sessionId },
  )
  await new Promise((r) => setTimeout(r, 400))

  // ── A5：点每行的下载跳转 ──────────────────────────────────────────
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="cache-task-godownload"]')
    if (b) b.click()
  })
  let landed = { overlay: true, title: null, ingestRows: 0 }
  try {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="cache-manager-overlay"]'),
      { timeout: 8000 },
    )
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0,
      { timeout: 15000 },
    )
    landed = await page.evaluate(() => ({
      overlay: !!document.querySelector('[data-testid="cache-manager-overlay"]'),
      title: (() => {
        const el = document.querySelector('[data-testid="page-title"]')
        return el ? (el.textContent || '').trim() : null
      })(),
      ingestRows: document.querySelectorAll('[data-testid="ingest-group-row"]').length,
    }))
  } catch (e) {
    console.log(`  (跳转等待超时：${e.message})`)
  }
  await page.screenshot(path.join(OUT, '02-landed-download.png'))
  const a5ok = !landed.overlay && landed.title === '全部下载' && landed.ingestRows > 0
  if (NEGATE) {
    check(
      `NEGATE A5 反取：要求未落到下载域（正确构建上应 FAIL）| overlay=${landed.overlay} 标题="${landed.title}" 组行=${landed.ingestRows}`,
      !a5ok,
    )
  } else {
    check(
      `A5 点每行出口 ⇒ 面板关闭且落到下载域（overlay=${landed.overlay}、标题="${landed.title}"、组行=${landed.ingestRows}）`,
      a5ok,
      JSON.stringify(landed),
    )
  }

  // ── A7：下载域明细抽屉（第二处）也无「编入」且徽标是「入库」词表 ────
  //   注：抽屉顶部汇总（`（已入库 N / 未入库 N / 无条目 N）`）读的是
  //   `latest.manifest`，而下载域列表路径不做该聚合 ⇒ 多数组为 null、不渲染。
  //   所以这里锚**条目徽标**（`entryMeta` / 缺字节），那是恒渲染的一处。
  let bianruAnywhere = false
  const newVocab = new Set()
  const scanned = []
  const groupTotal = landed.ingestRows
  for (let i = 0; i < Math.min(groupTotal, 8); i += 1) {
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
      // 条目清单是**懒加载**（开抽屉才拉 `/items`）：只等 Sheet 出现会读到 0 条。
      // 等条目或「无明细/加载失败」终态落地再读；超时则按空组跳过。
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0 ||
          /无明细|加载失败/.test(
            (document.querySelector('[data-testid="ingest-detail-sheet"]') || {}).textContent || '',
          ),
        { timeout: 6000 },
      )
    } catch {
      continue
    }
    const r = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="ingest-detail-sheet"]')
      const txt = s ? s.textContent || '' : ''
      const rows = Array.from(s ? s.querySelectorAll('[data-testid="ingest-sheet-entry"]') : [])
      return {
        hasBianru: txt.includes('编入'),
        entryRows: rows.length,
        rowTexts: rows.map((x) => (x.textContent || '').replace(/\s+/g, ' ').trim()),
      }
    })
    scanned.push({ group: i, hasBianru: r.hasBianru, entryRows: r.entryRows })
    if (r.hasBianru) bianruAnywhere = true
    for (const t of r.rowTexts) {
      for (const w of ['已入库', '已登记未入库', '无条目', '缺字节']) {
        if (t.includes(w)) newVocab.add(w)
      }
    }
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="ingest-detail-sheet-close"]')
      if (c) c.click()
    })
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="ingest-detail-sheet"]'),
      { timeout: 6000 },
    )
    if (['已入库', '已登记未入库', '无条目'].some((w) => newVocab.has(w))) break
  }
  await page.screenshot(path.join(OUT, '03-detail-sheet.png'))
  console.log('--- A7 扫描过的组 ---')
  scanned.forEach((s) => console.log(JSON.stringify(s)))
  check(
    `A7 下载域明细抽屉无「编入」（扫 ${scanned.length} 组，任一含编入=${bianruAnywhere}）`,
    !bianruAnywhere,
    JSON.stringify(scanned),
  )
  check(
    `A7b 条目徽标已是「入库」词表（命中 ${JSON.stringify([...newVocab])}）`,
    newVocab.size > 0,
    JSON.stringify(scanned),
  )

  // ── A6：错误面 ─────────────────────────────────────────────────────
  const consoleErrs = page.consoleErrors().filter((e) => !/favicon|DevTools/i.test(e))
  const pageErrs = page.pageErrors()
  check(
    `A6 无 console/page error（console=${consoleErrs.length}、page=${pageErrs.length}）`,
    consoleErrs.length === 0 && pageErrs.length === 0,
    [...consoleErrs, ...pageErrs].slice(0, 3).join(' | '),
  )

  await browser.close()
  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-324 TG 入库入口简易化${NEGATE ? '（反向证伪）' : ''}：${pass} pass / ${fail} fail`,
  )
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
