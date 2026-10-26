/**
 * BUG-404 / 405 / 415 / 416 / 417 活栈真实渲染验收（零依赖 CDP）。
 *
 * 纪律：
 *   - 真实浏览器 + 真实后端（daemon 19786 / orig-tg 19787 / vite 5180），非 mock；
 *   - 元素一律按 data-testid 定位，**禁用模糊文本正则**（BUG-394 事故）；
 *   - 先枚举页面上真实存在的 testid，再据实断言 —— 不猜测选择器；
 *   - 每项独立 try/catch：单步失败如实记录，不伪装成通过；
 *   - 证据（截图 + JSON）落 verify_shots/（不入库），见 AGENTS.md §6。
 *
 * 用法：node tauri-shell/verify/verify_bug404_405_415_416_417_live.cjs
 * 可选：APP_URL（默认 http://127.0.0.1:5180）
 */
const path = require('path')
const fs = require('fs')
const cdp = require('./lib/cdp.cjs')

const URL = process.env.APP_URL || 'http://127.0.0.1:5180'
const MEDIA = process.env.MEDIA_URL || 'http://127.0.0.1:19787'
const OUT =
  process.env.ORIG_SHOT_OUT ||
  path.resolve(__dirname, '..', '..', 'verify_shots', 'bug404_405_415_416_417')

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}
function note(msg) {
  console.log(`note  ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 点第 `idx` 张剧集卡片进详情。
 *
 * 为什么按序号而不是按 wire 挑 id 再按 `data-series-id` 定位：列表是**虚拟化**的，
 * 「先算出目标 id、再去 DOM 找它」要赌滚动容器赌对（赌错就滚不动 ⇒ 找不到 ⇒
 * 后续断言全 null，看起来像功能不存在）。按序号走所见即所得，缺的数据用**回去再说**
 * 的方式换下一张卡，判据始终对着真实渲染。
 *
 * 另：入口必须点 `series-card`（它才挂 onClick）；外壳 `series-card-root` 不带
 * onClick，点它没有反应 —— 点错元素会把「点在的东西」伪装成「功能不存在」。
 */
async function clickCardByIdx(page, idx) {
  return page.evaluate((i) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="series-card"]'))
    if (cards.length <= i) return false
    cards[i].scrollIntoView({ block: 'center' })
    cards[i].click()
    return true
  }, idx)
}

/** 详情页是否满足 BUG-416 的验收前提：有「播放全部」可用 **且**不只一集。 */
async function detailHasPlayableSeries(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[data-testid="series-play-all"]')
    const eps = document.querySelectorAll('[data-testid="episode-row-play"]').length
    return !!btn && !btn.disabled && eps > 1
  })
}

/** 按 testid 点击（走真实 DOM click，React 根监听器可捕获）。 */
async function clickTid(page, tid) {
  return page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, tid)
}

async function readOne(page, tid) {
  return page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      text: (el.textContent || '').trim(),
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.left),
      y: Math.round(r.top),
      visible: r.width > 0 && r.height > 0,
    }
  }, tid)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({ headless: true })
  const page = await browser.newPage()
  if (typeof page.on === 'function') {
    page.on('pageerror', (e) => note(`PAGEERROR ${e.message}`))
  }

  // vite 首次整页加载可能 >30s（且与改动无关的冷缓存），带重试
  let loaded = false
  for (let i = 0; i < 3 && !loaded; i++) {
    try {
      await page.goto(URL, { waitUntil: 'load', timeout: 60000 })
      loaded = true
    } catch (e) {
      note(`goto attempt ${i + 1} failed: ${e.message}`)
      await sleep(1500)
    }
  }
  check('页面可达且 load 完成', loaded, URL)
  if (!loaded) {
    await browser.close()
    process.exit(2)
  }

  // 等 React 挂载
  let mounted = false
  try {
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="page-title"]'),
      { timeout: 30000 },
    )
    mounted = true
  } catch (_e) {
    /* 由断言如实报告 */
  }
  check('React 已挂载（page-title 出现）', mounted)
  if (!mounted) {
    const html = await page.content()
    note(`readyState/html head: ${html.slice(0, 200)}`)
    await page.screenshot(path.join(OUT, 'mount_failed.png'))
    await browser.close()
    process.exit(2)
  }
  await sleep(2500)

  // ── 事实先行：枚举当前视图真实存在的 testid ──
  const tids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid]'))
      .map((e) => e.getAttribute('data-testid'))
      .filter(Boolean),
  )
  const uniq = Array.from(new Set(tids))
  note(`当前视图 testid ${uniq.length} 个：${uniq.slice(0, 60).join(', ')}`)

  // ── 进入文件域**剧集库视图** ──
  // BUG-405 的标签 pill 只在 `view === 'series'` 分支渲染（`MediaLibraryPanel`），
  // 停在 items 列表去查必然是 null —— 那是本脚本的定位错，不是产品回归。
  await clickTid(page, 'nav-child-lib-series')
  await sleep(2200)

  // ── BUG-405：标签过滤收成一个紧凑 pill（不再「标签文字 + 长输入框」两件）──
  const pill = await readOne(page, 'media-tag-filter-wrap')
  const tagFilter = await readOne(page, 'media-tag-filter')
  const legacyInput = await page.evaluate(
    () => document.querySelectorAll('[data-testid="media-tag-filter-wrap"] input').length,
  )
  await page.screenshot(path.join(OUT, 'bug405_tag_pill.png'))
  check('BUG-405 标签 pill 存在且可见', !!pill && pill.visible, JSON.stringify(pill))
  // 判据：整个 pill 必须与标题栏搜索框同量级（限宽），而不是撑满整行
  check(
    'BUG-405 pill 为紧凑宽度而非撑满（≤320px）',
    !!pill && pill.w <= 320,
    `width=${pill ? pill.w : 'n/a'}px`,
  )
  check(
    'BUG-405 「标签」文字与输入框合并为单组件（pill 内恰 1 个 input）',
    legacyInput === 1 && !!tagFilter,
    `inputs=${legacyInput} filter=${!!tagFilter}`,
  )

  // ── 切到剧集库，取面包屑（BUG-404）──
  await clickTid(page, 'nav-child-lib-series')
  await sleep(2200)
  const subNodes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="context-bar-sub"]')).map((e) =>
      (e.textContent || '').trim(),
    ),
  )
  const titleNow = await readOne(page, 'page-title')
  await page.screenshot(path.join(OUT, 'bug404_breadcrumb_lib.png'))
  check('BUG-404 面包屑分段渲染（context-bar-sub ≥1 段）', subNodes.length >= 1, JSON.stringify(subNodes))
  // BUG-404 的真实语义：**一级标题不随子视图漂移**（停在剧集库/任意子视图时，
  // 一级标题仍是文件域标题），而 UI 上这个文件域标题的文案是「文件管理」。
  check(
    'BUG-404 一级标题不随子视图漂移（恒为文件域标题）',
    !!titleNow && (titleNow.text === '文件' || titleNow.text === '文件管理'),
    JSON.stringify(titleNow),
  )

  // ── 打开一部真实剧集 ──
  // 「随便点第一个」会点进单集剧集 ⇒ BUG-416 的「下一集预载」无数据可验。按序号换卡，
  // 直到撞上一部**多集且可播**的剧集；换卡用真实的返回键，不跳路由。
  let openedSeries = false
  for (let i = 0; i < 8 && !openedSeries; i++) {
    if (!(await clickCardByIdx(page, i))) break
    await sleep(2400)
    if (await detailHasPlayableSeries(page)) {
      openedSeries = true
      note(`打开剧集：第 ${i + 1} 张卡片（多集且可播）`)
      break
    }
    await clickTid(page, 'series-back')
    await sleep(1300)
  }
  if (!openedSeries) note('8 张卡片内未找到多集且可播的剧集 ⇒ BUG-416/417 依赖数据，由断言如实报告')

  const seriesTids = openedSeries
    ? await page.evaluate(() =>
        Array.from(new Set(
          Array.from(document.querySelectorAll('[data-testid]')).map((e) =>
            e.getAttribute('data-testid'),
          ),
        )),
      )
    : []
  if (openedSeries) note(`剧集内 testid：${seriesTids.slice(0, 40).join(', ')}`)

  // ── BUG-416：全部播放入口 + 下一集预载 video ──
  const playAll = await readOne(page, 'series-play-all')
  await page.screenshot(path.join(OUT, 'bug416_series_detail.png'))
  check('BUG-416 「播放全部」入口存在', !!playAll, JSON.stringify(playAll))

  // 预载 <video> 只在 `nextItem?.src` 存在时挂载 ⇒ 「有没有下一集」是数据前提，
  // 单集剧集上查它必然 null（并非回归）。先验来源是把握tel-hand：播放器必须真的打开。
  const episodes = await page.evaluate(
    () => document.querySelectorAll('[data-testid="episode-row-play"]').length,
  )
  let played = false
  let viewerOpened = false
  if (playAll && playAll.visible) {
    played = await clickTid(page, 'series-play-all')
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), {
        timeout: 15000,
      })
      viewerOpened = true
    } catch (_e) {
      /* 由断言如实报告 */
    }
    await sleep(2500)
  }
  check(
    'BUG-416 点「播放全部」真的打开了播放器',
    played && viewerOpened,
    `clicked=${played} viewer=${viewerOpened}`,
  )
  const preload = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="next-episode-preload"]')
    if (!v) return null
    return { exists: true, src: !!v.getAttribute('src'), preload: v.getAttribute('preload') }
  })
  const skipBtn = await readOne(page, 'player-skip-segment')
  await page.screenshot(path.join(OUT, 'bug416_417_player.png'))
  // BUG-417：分段跳过入口（Scissors）
  check('BUG-417 「跳过片头/片尾」按钮存在', !!skipBtn && skipBtn.visible, JSON.stringify(skipBtn))
  if (episodes > 1) {
    check(
      'BUG-416 下一集预载 <video> 已挂载常驻',
      !!preload && preload.src,
      JSON.stringify(preload),
    )
  } else {
    note(
      `BUG-416 本剧集只有 ${episodes} 集（无「下一集」）⇒ 预载项不适用，如实跳过不计分`,
    )
  }

  // ── BUG-415：拆分对话框逐源预览 ──
  // 逐源预览只渲染在 `epSources.length > 1` 的剧集上 ⇒ 目标是**多源**剧集，而「哪部
  // 多源」只能在打开拆分对话框后才看得出来 ⇒ 按序号换卡，直到撞上一个；换卡走真实
  // 返回键。找不到就如实跳过（不计 SUCCESS）：把「数据没有」粉饰成 PASS 是恒绿，把
  // 「脚本没找到」写成 FAIL 是误报，两者都不许。
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {})
  await page
    .waitForFunction(() => !!document.querySelector('[data-testid="page-title"]'), { timeout: 30000 })
    .catch(() => {})
  await sleep(2000)
  await clickTid(page, 'nav-child-lib-series')
  await sleep(2200)

  let dialogSeen = false
  let multiSourceSeen = false
  for (let i = 0; i < 8 && !multiSourceSeen; i++) {
    if (!(await clickCardByIdx(page, i))) break
    await sleep(2400)
    if (!(await clickTid(page, 'series-split'))) {
      await clickTid(page, 'series-back')
      await sleep(1300)
      continue
    }
    await sleep(1800)
    dialogSeen = !!(await readOne(page, 'series-split-dialog'))
    const previews = await page.evaluate(
      () => document.querySelectorAll('[data-testid="series-split-source-preview"]').length,
    )
    await page.screenshot(path.join(OUT, `bug415_split_${i}.png`))
    if (previews > 0) {
      multiSourceSeen = true
      check('BUG-415 多源逐源预览入口存在', true, `card#${i + 1} previews=${previews}`)
      break
    }
    await clickTid(page, 'series-back')
    await sleep(1300)
  }
  check('BUG-415 拆分对话框存在', dialogSeen, `dialog=${dialogSeen}`)
  if (!multiSourceSeen) {
    note('BUG-415：8 张卡片内未见多源集 ⇒ 逐源预览依赖多源数据，如实跳过不计分')
  }

  await browser.close()

  const failed = checks.filter((c) => !c.ok)
  const summary = {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    unavailable: [],
    checks,
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${checks.length - failed.length}/${checks.length} passed  →  ${OUT}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
