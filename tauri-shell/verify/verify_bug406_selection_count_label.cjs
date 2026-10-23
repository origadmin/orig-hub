'use strict'

/**
 * BUG-406 —— 批量选择条计数必须带语义文案，不是裸数字。
 *
 * 用户报障（2026-10-23，原话）：「进入剧集合并流程后，底部显示一个数字『2』
 * （表示当前选中数量），但该数字孤立出现、无任何上下文说明它是什么、什么意思，
 * 用户难以理解其真正功能，体验突兀。」
 *
 * 根因（git 实证）：BUG-393 统一选择条形态（提交 eedd515）把下载域的
 * 「已选 {n} 项」换成了裸 `{count}`，剧集墙与 items 视图共用该组件后一并退化
 * —— 形态统一了，语义丢了。本脚本同时是这次退化的**回归闸门**。
 *
 * 既有判据佐证（说明这不是新造的判据方向）：
 *   - `verify_merge_frontend.cjs` 早已断言 `items-selection-count` 匹配
 *     `/已选\s*\d+\s*项|\d+\s*selected/i`；
 *   - `_probe_bug353_download_selection.cjs` F2 早已断言 `dl-batch-count`
 *     匹配 `/已选\s*1\s*项/`。
 *   两条在裸数字实现下都是红的 —— 缺陷形态被旧判据抓着，本脚本把它收口成
 *   一条覆盖三域的验收。
 *
 * 静态（源码读，缺一即 FAIL）：
 *   S1 `SelectionBar` 渲染 `countLabel`，span 里不再出现裸 `{count}`
 *   S2 `countLabel` 是**必填** prop（漏传即 TS 红，不给默认值留后门）
 *   S3 三个调用点全部传 `countLabel`（series / items / download）
 *   S4 三处 i18n 键 zh/en 双份存在且带 `{n}` 占位（下载域不得硬编码中文）
 *
 * 运行时（真渲染、真勾选）：
 *   ① items 域勾 1 张 ⇒ 计数 = 「已选 1 项」
 *   ② 再勾 1 张 ⇒ 计数变「已选 2 项」（随选中数更新，不是写死的文案）
 *   ③ series 域选 2 个剧集 ⇒ 计数 = 「已选 2 条」（量词随域不同）
 *   ④ 下载域勾 1 行 ⇒ 计数 = 「已选 1 项」
 *   ⑤ 反证（真实 DOM 上把节点文本换成裸数字「2」）⇒ 判据必须抓到
 *      （证运行时段不是恒绿：同一断言对裸数字 FAIL、对文案 PASS）
 *
 * 用法：node tauri-shell/verify/verify_bug406_selection_count_label.cjs
 *   需 vite :5180 + orig-tg :19787 + orig-daemon :19786（栈未起 → 直接 FAIL 退出，
 *   不会静默跳过运行时段）。
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  bar: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'ui', 'selection-bar.tsx'),
    'utf8',
  ),
  panel: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'MediaLibraryPanel.tsx'),
    'utf8',
  ),
  dl: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'domains', 'download', 'DownloadPanel.tsx'),
    'utf8',
  ),
  zh: JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json'), 'utf8'),
  ),
  en: JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
  ),
}

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
const OUT = process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug406-selection-count')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 静态判据 ── */

/** S1a：计数 span 渲染的是语义文案，不是裸数字。 */
const barRendersLabel = /data-testid=\{countTestId\}[\s\S]{0,200}?\{countLabel\}/.test(SRC.bar)
/** S1b：span 里**不再**出现裸 `{count}`（BUG-393 退化形态）。 */
const barBareCount = /\{count\}/.test(SRC.bar.split('countLabel')[1] || '')
/** S2：`countLabel` 必填 —— 类型是 `countLabel: string`，不是可选/带默认值。 */
const labelRequired = /countLabel:\s*string\b(?!\?)/.test(SRC.bar) && !/countLabel\s*\?/.test(SRC.bar)
/**
 * S3a/b/c：三个调用点都传 countLabel。
 * 用 `includes` 而不是正则：正则字面量里的插值占位（字母 + 冒号 + 转义反斜杠
 * 三连）会被仓库污染门禁的盘符正则误判成机器绝对路径 —— 判据本身不需要正则，
 * 字符串包含足以钉死接线，格式化漂移由 tsc 与运行时段兜底。
 */
const seriesWired = SRC.panel.includes("countLabel={t('media.seriesSelectionCount'")
const itemsWired = SRC.panel.includes("countLabel={t('media.selected'")
const dlWired = SRC.dl.includes("countLabel={t('download.selectedCount'")
/** S4：i18n 键双份存在且带 {n} 占位（下载域不得在 JSX 里硬编码「已选 N 项」）。 */
const keyOk = (obj, key) => typeof obj[key] === 'string' && obj[key].includes('{n}')
const i18nOk =
  keyOk(SRC.zh, 'media.seriesSelectionCount') &&
  keyOk(SRC.en, 'media.seriesSelectionCount') &&
  keyOk(SRC.zh, 'media.selected') &&
  keyOk(SRC.en, 'media.selected') &&
  keyOk(SRC.zh, 'download.selectedCount') &&
  keyOk(SRC.en, 'download.selectedCount')
const dlNoHardcoded = !/已选\s*\{/.test(SRC.dl)

/**
 * 判据本体：计数文本必须同时满足「有语义标签」+「数量对得上」。
 * 对裸数字 '2' 返回 false（⑤ 的反证就靠这条）。
 */
const countTextOk = (text, n) => {
  const s = String(text || '').trim()
  if (!s) return false
  return new RegExp(`已选\\s*${n}\\s*(项|条)`).test(s) || new RegExp(`^${n}\\s*selected$`, 'i').test(s)
}

async function httpOk(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return r.status < 500
  } catch {
    return false
  }
}

/** 有界等待：固定 sleep 不等同「等它发生」（vite 首编译慢会集体假红）。 */
async function waitFor(page, fn, timeoutMs = 20000) {
  await page.waitForFunction(fn, { timeoutMs })
}

/** 读某域计数节点文本 + 容器在不在 DOM。 */
const readCount = (page, testId) =>
  page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    return {
      present: !!el,
      text: el ? (el.textContent || '').trim() : null,
    }
  }, testId)

async function main() {
  /* ── 静态段 ── */
  check('S1 SelectionBar 渲染 countLabel 语义文案', barRendersLabel)
  check('S1 span 内不再出现裸 {count}（BUG-393 退化形态已去除）', !barBareCount)
  check('S2 countLabel 为必填 prop（无问号、无默认值）', labelRequired)
  check('S3 series 调用点传 countLabel', seriesWired)
  check('S3 items 调用点传 countLabel', itemsWired)
  check('S3 download 调用点传 countLabel（走 i18n）', dlWired)
  check('S4 三处 i18n 键 zh/en 双份存在且带 {n}', i18nOk)
  check('S4 下载域计数未硬编码中文文案', dlNoHardcoded)

  if (failures > 0) {
    console.log('\n源码判据已红，运行时段不再执行（先修实现，别拿页面绿盖过源码红）')
    process.exit(1)
  }

  /* ── 运行时段：栈必须真在跑 ── */
  const stack = {
    app: await httpOk(APP_URL),
    tg: await httpOk(`${TG}/api/media/stats`),
    daemon: await httpOk(`${DAEMON}/api/files`),
  }
  if (!stack.app || !stack.tg || !stack.daemon) {
    console.log('')
    check('栈就绪（vite :5180 / orig-tg :19787 / orig-daemon :19786）', false, JSON.stringify(stack))
    console.log('\n运行时段无法执行：请先手动启动 scripts/dev/dev-stack.cmd 后重跑。')
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP_URL)

    /* ── ① ② items 域 ── */
    await page.evaluate(() => {
      document.querySelector('[data-testid="nav-child-cat-video"]')?.click()
    })
    await waitFor(page, () => document.querySelectorAll('[data-testid="media-card"]').length > 0)

    /** 勾第 idx 张卡片的复选框（idx 从 0 计；点已选中的那张会取消，故必须换张）。 */
    const clickCardSelect = (idx) =>
      page.evaluate(async (i) => {
        const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
        cards[i]?.querySelector('[data-testid="media-card-select"]')?.click()
        await new Promise((r) => setTimeout(r, 120))
      }, idx)

    await clickCardSelect(0)
    await waitFor(page, () => document.querySelector('[data-testid="items-selection-count"]') !== null)
    const c1 = await readCount(page, 'items-selection-count')
    check('① items 勾 1 张 ⇒ 计数 = 「已选 1 项」', countTextOk(c1.text, 1), `text="${c1.text}"`)
    await page.screenshot(path.join(OUT, '01-items-count-1.png'))

    await clickCardSelect(1)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="items-selection-count"]')
        return el && /2/.test(el.textContent || '')
      },
      { timeoutMs: 10000 },
    )
    const c2 = await readCount(page, 'items-selection-count')
    check('② items 勾 2 张 ⇒ 计数变「已选 2 项」（随选中数更新）', countTextOk(c2.text, 2), `text="${c2.text}"`)

    // 清空选择，避免跨域污染（items 选中不得带进 series 视图）
    await page.evaluate(() => {
      document.querySelector('[data-testid="items-selection-clear"]')?.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="items-selection-bar"]') === null,
      { timeoutMs: 10000 },
    )

    /* ── ③ series 域 ── */
    // 注：`media-rail-*` 系列入口已随 BUG-304/D18 从代码里移除（旧脚本
    // verify_bug_214_qa_independent 里的 `media-rail-series-all` 因此过期），
    // 侧栏 `nav-child-lib-series` 直达剧集墙，无需再点 rail。
    await page.evaluate(() => {
      document.querySelector('[data-testid="nav-child-lib-series"]')?.click()
    })
    await waitFor(page, () => document.querySelectorAll('[data-testid="series-card-root"]').length >= 2)
    await page.evaluate(async () => {
      const cards = [...document.querySelectorAll('[data-testid="series-card-root"]')].slice(0, 2)
      for (const c of cards) {
        c.querySelector('[data-testid="series-card-select"]')?.click()
        await new Promise((r) => setTimeout(r, 150))
      }
    })
    await waitFor(page, () => document.querySelector('[data-testid="series-selection-count"]') !== null)
    const c3 = await readCount(page, 'series-selection-count')
    check('③ series 选 2 个剧集 ⇒ 计数 = 「已选 2 条」（量词随域不同）', countTextOk(c3.text, 2), `text="${c3.text}"`)
    await page.screenshot(path.join(OUT, '02-series-count-2.png'))

    await page.evaluate(() => {
      document.querySelector('[data-testid="series-selection-clear"]')?.click()
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="series-selection-bar"]') === null,
      { timeoutMs: 10000 },
    )

    /* ── ④ 下载域 ── */
    await page.evaluate(() => {
      document.querySelector('[data-testid="nav-download"]')?.click()
    })
    await waitFor(
      page,
      () =>
        document.querySelectorAll(
          'input[data-testid="download-item-select"], input[data-testid="ingest-group-select"]',
        ).length > 0,
      25000,
    )
    await page.evaluate(() => {
      document
        .querySelector('input[data-testid="download-item-select"], input[data-testid="ingest-group-select"]')
        ?.click()
    })
    await waitFor(page, () => document.querySelector('[data-testid="dl-batch-count"]') !== null)
    const c4 = await readCount(page, 'dl-batch-count')
    check('④ 下载域勾 1 行 ⇒ 计数 = 「已选 1 项」', countTextOk(c4.text, 1), `text="${c4.text}"`)
    await page.screenshot(path.join(OUT, '03-download-count-1.png'))

    /*
     * ⑤ 反证（在**真实 DOM** 上做，不是单测里自说自话）：
     * 把下载域计数节点文本改回 BUG-406 的缺陷形态（裸数字「1」），
     * 用**同一条判据**再断言一次 ⇒ 必须 FAIL。
     * 这条证明运行时段判据有牙齿：恒绿脚本证不了任何事。
     */
    const bare = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="dl-batch-count"]')
      if (!el) return null
      el.textContent = '1'
      await new Promise((r) => setTimeout(r, 50))
      return (el.textContent || '').trim()
    })
    check('⑤ 反证：裸数字「1」被同一条判据抓到（判据非恒绿）', !countTextOk(bare, 1), `bare="${bare}"`)
    // 还原（后续不再读该节点，仅保持页面干净）
    await page.evaluate(() => {
      document.querySelector('[data-testid="dl-batch-clear"]')?.click()
    })

    /*
     * 排除 `favicon.ico` 的 404：浏览器对每个页面隐式探测该文件，与产品行为无关
     * （仓库既有约定，见 verify_album_cover / verify_bug101 等同一句过滤）。
     * 其余任何 console.error / pageerror 都算失败 —— 不因为「这次是小事」放宽。
     */
    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon\.ico/.test(String(e)),
    )
    check('无未捕获页面错误（favicon 除外）', errs.length === 0, errs.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }

  console.log('')
  if (failures > 0) {
    console.log(`FAILED — ${failures} 项`)
    process.exit(1)
  }
  console.log('ALL PASS — BUG-406 语义（选择条计数带「已选 N 项/条」文案）在三域成立')
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e)
  process.exit(1)
})
