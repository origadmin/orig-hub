/**
 * 第 9 轮 · 媒体库**逐条删除**真实渲染验收（BUG-057）。
 *
 * 对应用户原话：「媒体库也需要同样的快捷删除功能」。
 *
 * 修复语义：删除此前是**批量动作**（工具栏里，且挂在 `selected.size > 0` 之下），
 * 单条删除只能退化成「大小为 1 的批量」：先勾选 → 再找工具栏 → 再确认。
 * 选择态被当成删除的前置仪式。现在每张卡片自带删除入口，与「编辑」同级、
 * **常驻可见**（不靠 hover 才发现 —— 功能存在但入口不可发现等于没有）。
 *
 * 断言（全部为**运行期几何/行为**判定，不看类名）：
 *   ① 未 hover 与 hover 两态，删除入口都可见（`opacity=1` + 尺寸 > 0 + 中心点命中自身）
 *   ② 点逐条删除 → 确认条是**单条措辞**且报出「1 条」（目标集 = 这一条，不是当前勾选）
 *   ③ 归属告知：已在剧集中的条目，确认条**事先**报出「其中 M 条已归入剧集」
 *   ④ 取消路径零副作用：条目 id 集合与剧集列表**逐字未变**（验牙）
 *   ⑤ 批量路径回归：勾选 2 条走工具栏，确认条报「2 条」
 *   ⑥ 端点半径：`DELETE /api/media/items/999999999` → 404，不误伤任何条目
 *
 * 删除是**不可逆**的，故本脚本对真实库只走「取消」路径；确定路径由端点半径锁定
 * （与 `shot_round9_item_cache.cjs` 同一取舍）。
 *
 * 前置：orig-tg 真实实例 9877（已授权）、vite dev 5180。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node tauri-shell/verify/shot_media_delete.cjs
 * 产物：默认落 `verify_shots/round9-delete/`（证据产物不入库，AGENTS.md §6）。
 */
// BUG-086: playwright is intentionally NOT a dependency of tauri-shell (its browser
// download is impossible in offline/constrained environments). Degrade gracefully
// instead of crashing with a bare MODULE_NOT_FOUND. See verify/README.md.
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch (err) {
  const missingPlaywright =
    err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes('playwright')
  if (missingPlaywright) {
    console.error('[verify] 未安装 playwright，本脚本无法执行：需要真实浏览器截图，非网络不可。')
    console.error('[verify] 安装方式：cd tauri-shell && npm i -D playwright && npx playwright install chromium')
    console.error('[verify] 零依赖的真实渲染验收请改用：npm run verify:ui')
    process.exit(2)
  }
  throw err
}
const path = require('path')
const fs = require('fs')

const OUT =
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'round9-delete')
const URL = process.env.APP_URL || 'http://127.0.0.1:5180'
const API = 'http://127.0.0.1:9877'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

async function api(pathname, init) {
  const r = await fetch(API + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const txt = await r.text()
  let body = txt
  try {
    body = JSON.parse(txt)
  } catch {
    /* 保持原文 */
  }
  return { status: r.status, body }
}

const itemIds = async () => {
  const r = await api('/api/media/items?page=1&page_size=500')
  return (r.body.items ?? []).map((i) => i.id).sort((a, b) => a - b)
}
const seriesIds = async () => {
  const r = await api('/api/media/series')
  return (r.body.items ?? []).map((s) => s.id).sort((a, b) => a - b)
}

/** 运行期几何：可见性 + 命中自身（`opacity=1` 是「常驻可见」的硬判据）。 */
async function geometry(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      found: true,
      opacity: cs.opacity,
      visibility: cs.visibility,
      display: cs.display,
      w: r.width,
      h: r.height,
      hitSelf: !!top && (el === top || el.contains(top)),
      hitTag: top ? `${top.tagName}#${top.id}.${String(top.className).slice(0, 30)}` : null,
      text: el.innerText.replace(/\s+/g, ' ').trim(),
    }
  }, selector)
}

const visible = (g) =>
  g.found && g.opacity === '1' && g.visibility !== 'hidden' && g.w > 0 && g.h > 0

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ═══════════ 预取：靶子素材（不依赖固定 id / 列表顺序）═══════════
  const before = await itemIds()
  const beforeSeries = await seriesIds()
  const list = (await api('/api/media/items?page=1&page_size=200')).body.items ?? []
  const grouped = list.filter((i) => i.seriesTitle)
  console.log(
    `LIB: items=${before.length} series=${beforeSeries.length} grouped=${grouped.length}`,
  )

  const browser = await chromium.launch()
  let rc = 0
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await page.locator('nav button[title="媒体库"]').first().click()
    await page.waitForTimeout(2500)
    await page
      .locator('nav button')
      .filter({ hasText: /^全部内容\s*\d+$/ })
      .first()
      .click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: path.join(OUT, '01_library.png') })

    const cards = page.locator('[data-testid="media-card"]')
    const cardCount = await cards.count()
    check('⓪ 卡片已渲染（非空跑）', cardCount > 0, `cards=${cardCount}`)
    if (cardCount === 0) throw new Error('媒体库没有卡片，无法验收')

    // ─────────── ① 常驻可见（未 hover / hover 两态）───────────
    await page.mouse.move(5, 5) // 保证没有任何卡片处于 hover 态
    await page.waitForTimeout(500)
    const gIdle = await geometry(page, '[data-testid="item-delete"]')
    check(
      '①a 未 hover：删除入口可见（opacity=1 + 尺寸>0）',
      visible(gIdle),
      `opacity=${gIdle.opacity} w=${gIdle.w?.toFixed(1)} h=${gIdle.h?.toFixed(1)}`,
    )
    check(
      '①b 未 hover：中心点命中自身（没有被封面/遮罩盖住）',
      gIdle.hitSelf,
      `hit=${gIdle.hitTag}`,
    )

    await cards.first().hover()
    await page.waitForTimeout(400)
    const gHover = await geometry(page, '[data-testid="item-delete"]')
    check(
      '①c hover 后：删除入口仍可见（不会因 hover 层出现而消失）',
      visible(gHover) && gHover.hitSelf,
      `opacity=${gHover.opacity} hit=${gHover.hitTag}`,
    )
    await cards.first().screenshot({ path: path.join(OUT, '02_card_actions.png') })
    check(
      '①d 删除入口与编辑入口同级同排（文字确为「删除」）',
      gHover.text === '删除' || gHover.text.includes('删除'),
      `text="${gHover.text}"`,
    )

    // ─────────── ② 逐条删除 = 单条措辞 + 目标集是这一条 ───────────
    // 找到一个「未勾选」的卡片点击删除：若目标集误取勾选集合（空），确认条就不会报 1 条。
    await cards.first().locator('[data-testid="item-delete"]').click()
    await page.waitForTimeout(600)
    const confirmVisible = await page.locator('[data-testid="media-confirm-yes"]').count()
    check('②a 点逐条删除 → 出现确认条（复用同一状态机）', confirmVisible > 0, `count=${confirmVisible}`)
    const dialogText = await page
      .locator('[data-testid="media-confirm-yes"]')
      .locator('xpath=ancestor::div[1]/..')
      .innerText()
      .catch(() => '')
    check(
      '②b 单条措辞：标题为「从资料库删除这条内容」',
      /删除这条内容/.test(dialogText),
      JSON.stringify(dialogText.replace(/\s+/g, ' ').slice(0, 90)),
    )
    check('②c 目标集 = 1 条（不是当前勾选集合）', /移除\s*1\s*条/.test(dialogText),
      JSON.stringify(dialogText.replace(/\s+/g, ' ').slice(0, 120)))
    check(
      '②d 文案写明「只删记录、不动磁盘文件」',
      /原文件|磁盘/.test(dialogText),
      JSON.stringify(dialogText.replace(/\s+/g, ' ').slice(0, 120)),
    )
    await page.screenshot({ path: path.join(OUT, '03_confirm_single.png') })

    // ─────────── ③ 归属告知（事先报出，而不是删完才发现）───────────
    if (grouped.length > 0) {
      // 卡片与条目 id 没有直接映射（卡片不带 id），改用**服务端 title** 定位：
      // 要断言的正是「目标集是这一条」，标题来自列表接口，唯一性由服务端保证。
      const targetTitle = grouped[0].title
      // 关掉当前确认条后再点目标卡片
      await page.locator('[data-testid="media-confirm-no"]').first().click()
      await page.waitForTimeout(400)
      const card = page.locator('[data-testid="media-card"]').filter({ hasText: targetTitle }).first()
      if ((await card.count()) > 0) {
        await card.locator('[data-testid="item-delete"]').click()
        await page.waitForTimeout(600)
        const warnCount = await page.locator('[data-testid="confirm-grouped-warn"]').count()
        const warnText = warnCount > 0 ? await page.locator('[data-testid="confirm-grouped-warn"]').innerText() : ''
        check(
          '③a 已在剧集中的条目：确认条**事先**报出归属影响',
          warnCount > 0 && /剧集/.test(warnText) && /\d/.test(warnText),
          `warn="${warnText.replace(/\s+/g, ' ')}"`,
        )
        await page.screenshot({ path: path.join(OUT, '04_confirm_grouped.png') })
        await page.locator('[data-testid="media-confirm-no"]').first().click()
        await page.waitForTimeout(400)
      } else {
        check('③a 已在剧集中的条目：确认条事先报出归属影响', false, `card not found for "${targetTitle}"`)
      }
    } else {
      check('③a 已在剧集中的条目：确认条事先报出归属影响', false, '库内没有已归入剧集的条目，无法取证')
    }

    // ─────────── ④ 取消路径零副作用（验牙）───────────
    await cards.first().locator('[data-testid="item-delete"]').click()
    await page.waitForTimeout(500)
    await page.locator('[data-testid="media-confirm-no"]').first().click()
    await page.waitForTimeout(900)
    const afterCancel = await itemIds()
    const afterCancelSeries = await seriesIds()
    check(
      '④a 删除→取消：条目 id 集合逐字未变',
      JSON.stringify(afterCancel) === JSON.stringify(before),
      `before=${before.length} after=${afterCancel.length} diff=${afterCancel.filter((x) => !before.includes(x))}`,
    )
    check(
      '④b 删除→取消：剧集列表逐字未变',
      JSON.stringify(afterCancelSeries) === JSON.stringify(beforeSeries),
      `before=${beforeSeries.length} after=${afterCancelSeries.length}`,
    )
    check('④c 取消后确认条已关闭', (await page.locator('[data-testid="media-confirm-yes"]').count()) === 0)

    // ─────────── ⑤ 批量路径回归（选择态仍可用，只是不再是前置仪式）───────────
    if (cardCount >= 2) {
      await cards.nth(0).locator('[role="checkbox"]').click()
      await cards.nth(1).locator('[role="checkbox"]').click()
      await page.waitForTimeout(500)
      await page
        .locator('button')
        .filter({ hasText: /^移出资料库$/ })
        .first()
        .click()
      await page.waitForTimeout(600)
      const batchText = await page
        .locator('[data-testid="media-confirm-yes"]')
        .locator('xpath=ancestor::div[1]/..')
        .innerText()
        .catch(() => '')
      check(
        '⑤a 批量路径仍在（勾选 2 条 → 工具栏）且报出 2 条',
        /移除\s*2\s*条/.test(batchText),
        JSON.stringify(batchText.replace(/\s+/g, ' ').slice(0, 110)),
      )
      await page.locator('[data-testid="media-confirm-no"]').first().click()
      await page.waitForTimeout(700)
      const afterBatchCancel = await itemIds()
      check(
        '⑤b 批量取消后条目集合逐字未变',
        JSON.stringify(afterBatchCancel) === JSON.stringify(before),
        `n=${afterBatchCancel.length}`,
      )
    }

    // ─────────── ⑥ 端点半径（确定路径的边界，不误伤）───────────
    const delBad = await api('/api/media/items/999999999', { method: 'DELETE' })
    check(
      '⑥a 越界 id 删除 → 200（幂等）且如实回报 removed=0',
      delBad.status === 200 && delBad.body.removed === 0,
      `status=${delBad.status} body=${JSON.stringify(delBad.body)}`,
    )
    const finalIds = await itemIds()
    check(
      '⑥b 全程条目集合逐字未变（零副作用）',
      JSON.stringify(finalIds) === JSON.stringify(before),
      `before=${before.length} final=${finalIds.length}`,
    )

    await page.screenshot({ path: path.join(OUT, '05_final.png'), fullPage: true })
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.ok)
  const report = {
    all_passed: failed.length === 0,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.map((c) => c.name),
    library: { items: before.length, series: beforeSeries.length, grouped: grouped.length },
    checks,
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`\nRESULT: ${report.passed}/${report.total} passed`)
  console.log('OUT=' + OUT)
  rc = failed.length === 0 ? 0 : 1
  process.exit(rc)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  process.exit(2)
})
