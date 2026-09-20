/**
 * 第 9 轮 · 媒体库左栏（底部标签区）真实渲染验收。
 *
 * 对应用户原话：
 *   「媒体库底部标签 仍然显示大量 0 视频标签. 问题完全偏离.」
 *   「导航的标签说了省略0标签，还有过长标签截断，最大值，最小值样式都要测试，必须都能在一行显示.」
 *
 * 修复的语义（BUG-068）：
 *   1) 计数 0 **不渲染**（点它必然空 → 等于承诺一个兑现不了的入口）；唯一例外是当前选中项；
 *   2) 计数必须等于筛选结果（旧式 `itemCount + seriesCount` 在内容侧显示 8、点开 6 条）；
 *   3) 单行原语：`whitespace-nowrap` + 名称 `truncate` + 计数 `shrink-0 tabular-nums` + `max-w-full`。
 *
 * 极值造数（真实库 9877，**改完即还原并断言还原**）：
 *   - 最长名：新建一个刻意拉长的标签名并挂到单个条目 → 同时覆盖「最长名」与「最小非零计数(1)」；
 *   - 最大数：直接用库里现有计数最大的标签（不写入）。
 *   - 最小数(0)：库里现存的 0/0 孤儿标签（删除关联表不 GC 的历史产物）→ 断言完全不出现。
 *
 * 前置：orig-tg 真实实例 9877（已授权）、vite dev 5180。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node tauri-shell/verify/shot_media_tags.cjs
 * 产物：默认落 `verify_shots/round9/`（**证据产物不入库**，AGENTS.md §6），可用 ORIG_SHOT_OUT 覆盖。
 *
 * 入库位置说明：脚本本身入库（`tauri-shell/verify/`，与引擎侧 `download-engine/verify/` 对称），
 * 因为「BUG 登记的验收证据必须换台机器也能复核」；截图/JSON 这类产物仍留在 ignored 的
 * `verify_shots/`，否则仓库会被像素级证据撑爆。
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
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'round9')
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

/** 从 DOM 读媒体库左栏标签区 + 分类行的运行期几何。 */
async function readRail(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-testid="media-tag-list"]')
    if (!list) return { ok: false, chips: [], cats: [] }
    const chips = list
      ? [...list.querySelectorAll('button')].map((c) => {
          const spans = [...c.querySelectorAll('span')]
          const nameEl = spans[0] ?? null
          const cntEl = spans[1] ?? null
          const r = c.getBoundingClientRect()
          const listR = list.getBoundingClientRect()
          return {
            tst: c.getAttribute('data-testid'),
            text: c.innerText.replace(/\s+/g, ' ').trim(),
            count: cntEl ? parseInt(cntEl.innerText.trim(), 10) : null,
            height: r.height,
            width: r.width,
            listWidth: listR.width,
            whiteSpace: getComputedStyle(c).whiteSpace,
            nameText: nameEl ? nameEl.innerText : '',
            nameClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : false,
            countWidth: cntEl ? cntEl.getBoundingClientRect().width : 0,
            countClipped: cntEl ? cntEl.scrollWidth > cntEl.clientWidth + 1 : false,
          }
        })
      : []
    // 分类行 = 四个固定类型（用 data-testid 定位；**不要**用 `aside nav` —— 主侧栏
    // 也是 `<aside>`，会命中错的那个容器，第 8 轮已踩过一次）。
    const cats = [...document.querySelectorAll('[data-testid^="media-cat-"]')].map((b) => {
      const txt = b.innerText.replace(/\s+/g, ' ').trim()
      const m = txt.match(/^(.*?)\s*(\d+)$/)
      return {
        key: b.getAttribute('data-testid').replace('media-cat-', ''),
        count: m ? parseInt(m[2], 10) : null,
        text: txt,
      }
    })
    return { ok: true, chips, cats }
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ═══════════ 预取：挑素材（不依赖固定 id / 列表顺序）═══════════
  const tagRes = await api('/api/media/tags')
  const tags = tagRes.body.items ?? []
  if (!tags.length) throw new Error('库内无标签，无法验收')
  const nonzero = tags.filter((t) => (t.itemCount ?? 0) > 0)
  const zero = tags.filter((t) => (t.itemCount ?? 0) === 0 && (t.seriesCount ?? 0) === 0)
  const maxTag = nonzero.slice().sort((a, b) => (b.itemCount ?? 0) - (a.itemCount ?? 0))[0]
  const midTag = nonzero
    .filter((t) => (t.itemCount ?? 0) >= 2 && (t.itemCount ?? 0) <= 8)
    .sort((a, b) => a.itemCount - b.itemCount)[0]
  console.log(
    `LIB: tags=${tags.length} nonzero=${nonzero.length} zero=${zero.length} ` +
      `max=${maxTag?.name}(${maxTag?.itemCount}) mid=${midTag?.name}(${midTag?.itemCount})`,
  )

  // 造数：一条含「超长名 + 计数=1」的标签
  const probeItem = (await api('/api/media/items?page=1&page_size=1')).body
  const hostId = probeItem.items?.[0]?.id
  if (!hostId) throw new Error('库内无条目')
  const hostBefore = await api(`/api/media/items/${hostId}`)
  const hostTagsBefore = (hostBefore.body.tags ?? []).map((t) => t.id).sort((a, b) => a - b)

  const LONG = '超长标签名截断验证用这是一段刻意拉长的名称必须单行显示且计数不被压缩掉'
  const created = await api('/api/media/tags', {
    method: 'POST',
    body: JSON.stringify({ name: LONG }),
  })
  const longId = created.body.id ?? created.body
  const hostAfterTags = [...hostTagsBefore, Number(longId)]
  const put = await api(`/api/media/items/${hostId}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tagIds: hostAfterTags }),
  })
  console.log(`PROBE: long tag id=${longId} attached to item ${hostId} (PUT ${put.status})`)

  let restored = false
  let tagDeleteStatus = null
  let restoredTagDeleted = false
  const restore = async () => {
    if (restored) return
    restored = true
    await api(`/api/media/items/${hostId}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tagIds: hostTagsBefore }),
    })
    const del = await api(`/api/media/tags/${longId}`, { method: 'DELETE' })
    tagDeleteStatus = del.status
    // 断言还原：条目标签集合逐字相等 + 探针标签消失
    const after = await api(`/api/media/items/${hostId}`)
    const ids = (after.body.tags ?? []).map((t) => t.id).sort((a, b) => a - b)
    const all = (await api('/api/media/tags')).body.items ?? []
    restoredTagDeleted = !all.some((t) => t.id === Number(longId))
    check(
      '⓪ 探针已还原（条目标签集合逐字相等 + 探针标签已删）',
      JSON.stringify(ids) === JSON.stringify(hostTagsBefore) && restoredTagDeleted,
      `ids=${JSON.stringify(ids)} expect=${JSON.stringify(hostTagsBefore)} gone=${restoredTagDeleted}`,
    )
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await page.locator('nav button[title="媒体库"]').first().click()
    await page.waitForTimeout(2500)
    // 内容侧：点「全部内容 N」
    await page
      .locator('nav button')
      .filter({ hasText: /^全部内容\s*\d+$/ })
      .first()
      .click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: path.join(OUT, '01_library_content.png') })

    // ─────────── ① 内容侧：0 不渲染 + 单行原语 + 极值 ───────────
    let rail = await readRail(page)
    const zeroIds = zero.map((t) => t.id)
    const shownZero = rail.chips.filter((c) => c.count === 0)
    check(
      '①a 内容侧：没有任何计数为 0 的标签 chip',
      shownZero.length === 0,
      `zero_chips=${shownZero.length} ${JSON.stringify(shownZero.slice(0, 3).map((c) => c.text))}`,
    )
    check(
      '①b 内容侧：库内 0/0 孤儿标签一个都没出现（负例存在性证明）',
      zeroIds.length > 0 && !rail.chips.some((c) => zeroIds.includes(Number((c.tst ?? '').replace('media-tag-chip-', '')))),
      `orphans_in_db=${zeroIds.length} chips=${rail.chips.length}`,
    )
    check(
      '①c 内容侧：分类行（全部内容/视频/图片/音频）无 0 计数',
      rail.cats.length > 0 && rail.cats.every((c) => c.count > 0),
      JSON.stringify(rail.cats.map((c) => c.text)),
    )

    const longChip = rail.chips.find((c) => c.nameText.startsWith('超长标签名'))
    check('①d 超长名标签确实渲染（造数有效，非空跑）', !!longChip, longChip ? longChip.text : 'not found')
    if (longChip) {
      check(
        '①e 最长名 · 单行（chip 高度 ≤ 24px，未折行）',
        longChip.height <= 24,
        `height=${longChip.height.toFixed(1)}`,
      )
      check('①f 最长名 · 名称被截断而非撑破（scrollWidth > clientWidth）', longChip.nameClipped, `name="${longChip.nameText}"`)
      check(
        '①g 最长名 · chip 宽度未超出容器',
        longChip.width <= longChip.listWidth + 0.5,
        `chipW=${longChip.width.toFixed(1)} listW=${longChip.listWidth.toFixed(1)}`,
      )
      check('①h 最长名 · 计数未被压缩掉（可见且未被裁切）', longChip.countWidth > 0 && !longChip.countClipped, `countW=${longChip.countWidth.toFixed(1)} count=${longChip.count}`)
      check('①i 最长名 · 最小非零计数 = 1 如实显示', longChip.count === 1, `count=${longChip.count}`)
    }

    const maxChip = rail.chips.find((c) => c.nameText === maxTag?.name)
    check('①j 最大计数标签在列（数字可见、未被压缩）', !!maxChip && maxChip.countWidth > 0 && !maxChip.countClipped, maxChip ? `count=${maxChip.count} countW=${maxChip.countWidth.toFixed(1)}` : 'not found')
    check(
      '①k 所有 chip 都是单行 nowrap',
      rail.chips.length > 0 && rail.chips.every((c) => c.whiteSpace === 'nowrap' && c.height <= 24),
      `chips=${rail.chips.length} maxHeight=${Math.max(...rail.chips.map((c) => c.height)).toFixed(1)}`,
    )
    await page.locator('[data-testid="media-tag-list"]').screenshot({ path: path.join(OUT, '02_tags_content.png') })

    // ─────────── ② 计数 = 筛选结果（显示的数就是点下去得到的数）───────────
    if (midTag) {
      const chip = page.locator(`[data-testid="media-tag-chip-${midTag.id}"]`)
      await chip.click()
      await page.waitForTimeout(2500)
      const shown = await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="media-grid"]')
        const cards = grid ? grid.querySelectorAll('[data-testid="media-card"]') : []
        return { grid: !!grid, cards: cards.length }
      })
      const chipCount = midTag.itemCount
      check(
        `② 点「${midTag.name}」后的条数 = chip 上显示的数（${chipCount}）`,
        shown.cards === chipCount,
        `cards=${shown.cards} chip=${chipCount} grid=${shown.grid}`,
      )
      await page.screenshot({ path: path.join(OUT, '03_tag_filtered.png') })
      await chip.click() // 取消筛选
      await page.waitForTimeout(1500)
    } else {
      check('② 计数 = 筛选结果', false, '库内无 2~8 条的标签可测')
    }

    // ─────────── ③ 剧集侧：各算各的计数 ───────────
    await page
      .locator('nav button')
      .filter({ hasText: /^全部剧集\s*\d+$/ })
      .first()
      .click()
    await page.waitForTimeout(2500)
    const rail2 = await readRail(page)
    const seriesSideZero = rail2.chips.filter((c) => c.count === 0)
    check(
      '③a 剧集侧：无 0 计数 chip（内容侧有值的标签在剧集侧正确消失）',
      rail2.chips.length > 0 && seriesSideZero.length === 0,
      `chips=${rail2.chips.length} text=${JSON.stringify(rail2.chips.slice(0, 6).map((c) => c.text))}`,
    )
    const itemOnlyTag = nonzero.find((t) => (t.seriesCount ?? 0) === 0 && (t.itemCount ?? 0) > 0)
    check(
      '③b 剧集侧：只在内容侧挂载的标签不出现（两侧各算各的）',
      !!itemOnlyTag && !rail2.chips.some((c) => c.nameText === itemOnlyTag.name),
      itemOnlyTag ? `hidden="${itemOnlyTag.name}"(series=0)` : 'no such tag',
    )
    const seriesTag = tags.filter((t) => (t.seriesCount ?? 0) > 0).sort((a, b) => b.seriesCount - a.seriesCount)[0]
    if (seriesTag) {
      const c2 = rail2.chips.find((c) => c.nameText === seriesTag.name)
      check(
        `③c 剧集侧：挂载到剧集的标签显示 seriesCount（${seriesTag.name} = ${seriesTag.seriesCount}，非 item+series）`,
        !!c2 && c2.count === seriesTag.seriesCount,
        c2 ? `shown=${c2.count} expect=${seriesTag.seriesCount}` : 'not found',
      )
    } else {
      check('③c 剧集侧 seriesCount 显示', false, '库内无挂载到剧集的标签')
    }
    await page.locator('[data-testid="media-tag-list"]').screenshot({ path: path.join(OUT, '04_tags_series.png') })
    await page.screenshot({ path: path.join(OUT, '05_library_series.png') })

    // ─────────── ④ 隐藏 ≠ 删除（UI 过滤不得替用户销毁数据）───────────
    // 先做还原（幂等），这样下面能对「探针标签被显式删除」下断言。
    await restore()
    const afterAll = (await api('/api/media/tags')).body.items ?? []
    check(
      `④ 0/0 孤儿标签在数据层**原样保留**（只隐藏，未替用户删除）：${zero.length} 个仍在库`,
      zero.every((t) => afterAll.some((x) => x.id === t.id)),
      `db_zero_before=${zero.length} still_there=${zero.filter((t) => afterAll.some((x) => x.id === t.id)).length}`,
    )
    check(
      '④b 探针标签经 DELETE /api/media/tags/:id 可被显式删除（入口在，不是删不掉）',
      restoredTagDeleted,
      `delete_status=${tagDeleteStatus}`,
    )
  } finally {
    await browser.close()
    await restore()
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ passed, total: checks.length, all_passed: passed === checks.length, checks }, null, 2),
  )
  console.log(`\nRESULT ${passed}/${checks.length}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
