/**
 * 「剧集里的视频」标题/介绍可改且四处一致 + 播放页只读 —— 真实渲染验收。
 *
 * 主诉（用户）：
 *  ① 「媒体库 剧集里面视频标题无法修改」——分集编辑面板只有季/集/介绍，没有标题；
 *  ② 「剧集里面介绍内容没有填充进视频」——面板与分集行读的是分集行上的副本，
 *     条目里明明有介绍也显示为空；「内容剧集和视频应该是一致的，但是结果天差地远」；
 *  ③ 「播放页…右边列表有个完全无用的播放 ICON」；
 *  ④ 「播放是只读的，但是有个标题编辑按钮」；
 *  ⑤ 「播放页面进入会进行大批量相同请求」（同一部剧集的详情被三个消费者各拉一次）。
 *
 * 断言（运行期读数 + 真实接口对照）：
 *   ⓪ 进入剧集详情；
 *   ① 分集行显示标题与**介绍**（介绍此前不显示）；
 *   ② 打开分集编辑面板：**有标题输入框**，且初值 = 当前标题（不是空）；
 *   ③ 面板里介绍的初值 = 条目的介绍（逐字，此前为空）；
 *   ④ 改标题 + 介绍 → 保存 → 分集行的标题与介绍**立刻**是新值；
 *   ⑤ wire 对照：GET item / GET series 与 UI 逐字一致；
 *   ⑥ 播放页：正文显示新值；**自身不存在任何编辑入口**；
 *   ⑦ 播放页右侧列表行内**没有**图标（装饰性播放图标已去）；
 *   ⑧ 请求计数（按阶段）：开剧集 1 次 / 进播放 0 次增量 / 保存后刷新 1 次；
 *   ⑨ 还原：标题/介绍逐字回到原值。
 *
 * 对真实库只做「改名 → 还原」，并在结束时逐字复核还原结果。
 * 前置：orig-tg 真实实例 9877、vite dev 5180。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node verify/shot_series_text_edit.cjs
 */
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const APP = process.env.APP_URL || 'http://127.0.0.1:5180'
const API = process.env.API_BASE || 'http://127.0.0.1:9877'
const OUT = process.env.ORIG_SHOT_OUT || path.join(__dirname, '..', '..', 'verify_shots', 'ep_text')
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

;(async () => {
  // 选一部**有可播分集**的剧集；记录借用条目的原值以便还原
  const list = await (await fetch(`${API}/api/media/series`)).json()
  let target = null
  for (const s of (list.items || []).slice(0, 12)) {
    const d = await (await fetch(`${API}/api/media/series/${s.id}`)).json()
    const ep = (d.episodes || []).find((e) => e.kind !== 'photo')
    if (ep) {
      target = { series: s, ep }
      break
    }
  }
  if (!target) throw new Error('没有可播剧集，无法验收')
  const { series, ep } = target
  const itemBefore = await (await fetch(`${API}/api/media/items/${ep.itemId}`)).json()
  console.log(`目标剧集 #${series.id}「${series.title}」 分集 ep#${ep.id} item#${ep.itemId}`)
  console.log(
    `原值: title=${JSON.stringify(itemBefore.title)} desc=${JSON.stringify((itemBefore.description || '').slice(0, 30))}`,
  )

  const NEW_T = `验收改名-${Date.now()}`
  const NEW_D = `验收介绍第一行\n第二行必须保留分段`

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')

  // 计数只认**真实请求**：CORS 预检（initiator=preflight）是浏览器行为，
  // 算进来会把「1 次」误报成 2 次（上一版就踩了这个坑）。按阶段分段记账，
  // 这样断言能说清「哪一段多发了请求」。
  let phase = 'boot'
  const reqLog = []
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.initiator && e.initiator.type === 'preflight') return
    if (!e.request.url.includes('/api/media/series')) return
    reqLog.push({ phase, url: e.request.url.replace(API, '') })
  })
  const countIn = (p) =>
    reqLog.filter((r) => r.phase === p && r.url.includes(`/api/media/series/${series.id}`)).length

  try {
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(3500)
    await page.locator('[data-testid="nav-media"]').first().click()
    await sleep(2500)

    // ─── ⓪ 进剧集详情 ───
    phase = 'A-open'
    const card = page.locator(`[data-testid="series-card"][data-series-id="${series.id}"]`).first()
    await card.waitFor({ timeout: 15000 })
    await card.click()
    await page.locator('[data-testid="series-title-edit"]').first().waitFor({ timeout: 15000 })
    await sleep(1200)
    await page.screenshot({ path: path.join(OUT, '01_series_detail.png') })
    check('⓪ 已进入剧集详情', true, `series#${series.id}`)

    // ─── ① 分集行：标题 + 介绍 ───
    const rowText = (
      await page.locator('li', { hasText: series.title.slice(0, 6) }).first().innerText()
    ).replace(/\s+/g, ' ')
    const descBefore = (itemBefore.description || '').trim()
    check(
      '① 分集行显示标题（= 条目当前标题，逐字）',
      rowText.includes(itemBefore.title),
      `row="${rowText.slice(0, 70)}"`,
    )
    check(
      '① 分集行显示**介绍**（此前分集行读的是副本，条目有介绍也不显示）',
      descBefore ? rowText.includes(descBefore.slice(0, 18)) : true,
      descBefore ? `期望含 "${descBefore.slice(0, 18)}…"` : '（该条目本来没有介绍）',
    )

    // ─── ②③ 分集编辑面板 ───
    await page.locator('[data-testid="episode-edit"]').first().click()
    await sleep(500)
    const titleInput = page.locator('[data-testid="episode-title-input"]').first()
    const hasTitle = (await titleInput.count()) > 0
    check('② 分集编辑面板**存在标题输入框**（此前只有季/集/介绍）', hasTitle)
    if (hasTitle) {
      const v = await titleInput.inputValue()
      check('② 标题输入框初值 = 当前标题（不是空）', v === itemBefore.title, `value=${JSON.stringify(v)}`)
    }
    const descArea = page.locator('li textarea').first()
    const descValue = await descArea.inputValue()
    check(
      '③ 介绍初值 = 条目的介绍（逐字）',
      descValue === descBefore,
      `panel=${JSON.stringify(descValue.slice(0, 40))} item=${JSON.stringify(descBefore.slice(0, 40))}`,
    )
    await page.screenshot({ path: path.join(OUT, '02_episode_edit.png') })

    // ─── ④ 改名 + 改介绍 → 保存 ───
    await titleInput.fill(NEW_T)
    await descArea.fill(NEW_D)
    phase = 'C-refresh'
    await page.locator('[data-testid="episode-save"]').first().click()
    await sleep(2200)
    const rowText2 = (
      await page.locator('li', { hasText: NEW_T.slice(0, 6) }).first().innerText()
    ).replace(/\s+/g, ' ')
    check('④ 保存后分集行标题立刻是新值', rowText2.includes(NEW_T), `row="${rowText2.slice(0, 60)}"`)
    check('④ 保存后分集行介绍也是新值（第一行可见）', rowText2.includes(NEW_D.split('\n')[0]))
    await page.screenshot({ path: path.join(OUT, '03_after_save.png') })

    // ─── ⑤ wire 对照 ───
    const itemAfter = await (await fetch(`${API}/api/media/items/${ep.itemId}`)).json()
    const detAfter = await (await fetch(`${API}/api/media/series/${series.id}`)).json()
    const epAfter = (detAfter.episodes || []).find((e) => e.id === ep.id)
    check(
      '⑤ 条目详情 = 新标题（写穿到条目）',
      itemAfter.title === NEW_T,
      `item.title=${JSON.stringify(itemAfter.title)}`,
    )
    check('⑤ 条目详情 = 新介绍（含换行，逐字）', itemAfter.description === NEW_D)
    check(
      '⑤ 剧集详情 = 条目详情（逐字，两边同一份）',
      epAfter.title === itemAfter.title && epAfter.description === itemAfter.description,
    )

    // ─── ⑥⑦ 播放页只读 ───
    phase = 'B-play'
    await page.locator('button[title="播放"]').first().click()
    await sleep(3500)
    const viewer = await page.evaluate(() => {
      const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null)
      const root = document.querySelector('[data-testid="media-viewer"]')
      const aside = root?.querySelector('aside[aria-label]')
      return {
        present: !!root,
        body: txt(root?.querySelector('[data-testid="viewer-text"]')),
        // 只数**播放页自身**的按钮：资料库面板在遮罩下仍挂载，
        // 全文档扫描会把它的卡片「编辑」按钮算进来（上一版就误报了）。
        viewerButtons: root ? [...root.querySelectorAll('button')].map((b) => txt(b)) : null,
        asideRowSvgs: aside ? [...aside.querySelectorAll('button svg')].length : -1,
      }
    })
    check(
      '⑥ 播放页正文显示新介绍（与剧集页同一份）',
      (viewer.body || '').includes(NEW_D.split('\n')[0]),
      `body=${JSON.stringify((viewer.body || '').slice(0, 40))}`,
    )
    const editInViewer = (viewer.viewerButtons || []).filter((t) => /编辑/.test(t || ''))
    check(
      '⑥ 播放页自身**没有任何编辑入口**（播放只读）',
      viewer.present && editInViewer.length === 0,
      `播放页按钮=${JSON.stringify((viewer.viewerButtons || []).slice(0, 8))}`,
    )
    check(
      '⑦ 右侧分集列表的行里**没有图标**（那个点了没反应的播放图标已去）',
      viewer.asideRowSvgs === 0,
      `aside 行内 svg 数=${viewer.asideRowSvgs}`,
    )
    await page.screenshot({ path: path.join(OUT, '04_viewer.png') })

    // ─── ⑧ 请求计数（按阶段）───
    const opens = countIn('A-open')
    const plays = countIn('B-play')
    const refresh = countIn('C-refresh')
    check('⑧ 打开剧集详情只发 1 次（此前 2 次：开详情 + 严格模式双调）', opens === 1, `A-open=${opens}`)
    check(
      '⑧ 进入播放页**零增量**请求（此前 3 次：playItems + 侧栏×2）',
      plays === 0,
      `B-play=${plays} log=${JSON.stringify(reqLog)}`,
    )
    check(
      '⑧ 保存后的刷新恰 1 次（写操作必须重取，缓存不得挡住新值）',
      refresh === 1,
      `C-refresh=${refresh}`,
    )
  } finally {
    // ─── ⑨ 还原（无论成败）───
    const res = await fetch(`${API}/api/media/items/${ep.itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: itemBefore.title, description: itemBefore.description }),
    })
    const back = await (await fetch(`${API}/api/media/items/${ep.itemId}`)).json()
    check(
      '⑨ 还原：被改名条目的标题与介绍逐字回到原值',
      res.status === 200 &&
        back.title === itemBefore.title &&
        back.description === itemBefore.description,
      `status=${res.status} title=${JSON.stringify(back.title)}`,
    )
    await browser.close()
  }

  const passed = checks.filter((c) => c.ok).length
  console.log(`\nRESULT: ${passed}/${checks.length} passed`)
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify(
      { passed, total: checks.length, series: series.id, item: ep.itemId, reqLog, checks },
      null,
      2,
    ),
  )
  if (passed !== checks.length) process.exitCode = 1
})()
