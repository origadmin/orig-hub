'use strict'

/**
 * BUG-283 复报取证（2026-10-13）：媒体库**条目视图卡片**显示为
 * 「标题行空白 + 副标题 = 占位名 `TG <chat_id> · <日期>`」。
 *
 * 背景：`MediaCard.tsx:445-446` 渲染 `item.title`（该条目无标题，属用户 2026-09-30
 * 「剧集已经有名称了」裁定的直接后果，`BUG-200.md:42`），
 * `MediaCard.tsx:469` 渲染 `· {item.seriesTitle}` —— 而后端 `seriesTitle`
 * （`media.rs:1446` 子查询：`ORDER BY e.season, e.episode_no LIMIT 1`）
 * 会取到**占位名剧集**，于是卡片既无标题、又无有效剧名 ⇒ 完全不可辨识。
 *
 * 本脚本把该现象做成可执行断言（**修复前应 PASS、修复后应 FAIL**）：
 *   A. 条目网格存在且渲染了卡片
 *   B. 网格按 `PAGE = 120`（`MediaLibraryPanel.tsx:61`）截断 —— 卡片数 == min(120, API items)
 *   C. **存在**标题行空白的卡片（`item.title` 为空是既裁定行为，非缺陷）
 *   D. **存在**副标题为占位名形态的卡片（本次复报的核心现象），并逐张打印
 *   E. 交叉核对：网格 total 读数与 orig-tg 权威计数一致
 *   F. 判据自证（**反向证伪**）：把首张占位卡的副标题就地改成正常剧名 ⇒ 计数必须 -1；
 *      还原后必须复原 ⇒ 证明 D 读的是**真实 DOM**、不是恒真匹配器
 *
 * 退出码：0 = 全部 PASS；2 = 判据 FAIL；1 = harness 错误。
 *
 * 用法：
 *   node tauri-shell/verify/verify_bug283_placeholder_card.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 *   可选：VERIFY_EXPECT_SUBSTR="<用户报障原文中的副标题>" 断言该串确实出现在卡片上
 *         VERIFY_APP_URL / VERIFY_API_URL 覆盖地址（用于反向证伪）
 */

const path = require('node:path')
const http = require('node:http')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const API_URL = process.env.VERIFY_API_URL || 'http://127.0.0.1:19787'
const EXPECT_SUBSTR = process.env.VERIFY_EXPECT_SUBSTR || ''
const PAGE = 120

/** 占位名形态：`TG <chat_id> · <YYYY-MM-DD>`（与 routes.rs:2314-2315 同源）。 */
const PLACEHOLDER_RE = /^TG\s+-?\d+\s+·\s+\d{4}-\d{2}-\d{2}$/

function apiStats(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/media/stats`, { timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(body) })
        } catch (_e) {
          resolve({ ok: false, data: null })
        }
      })
    })
    req.on('error', () => resolve({ ok: false, data: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, data: null })
    })
  })
}

async function main() {
  const results = []
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }

  const stats = await apiStats(API_URL)
  const apiItems = stats.ok && stats.data ? stats.data.items : -1
  check('取到 orig-tg 权威计数（外部真值）', apiItems > 0,
    stats.ok && stats.data ? `items=${apiItems} series=${stats.data.series}` : `无法访问 ${API_URL}/api/media/stats`)

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 2500))
    await page.evaluate(() => document.querySelector('[data-testid="nav-media"]').click())
    await new Promise((r) => setTimeout(r, 3500))

    /*
     * 媒体库默认落在**剧集墙**（`series-wall-scroll`），条目网格要显式点左栏
     * `media-cat-all` 才出现。点击前必须**轮询等待按钮挂载** ——
     * 固定 sleep 会撞上「按钮还没渲染」而静默点空（首版即栽在这里）。
     */
    /*
     * 先取**默认视图（剧集墙）**的读数：用户打开媒体库第一眼看到的就是它，
     * 占位剧集在这里同样可见。
     *
     * 注意结构：`series-card`（`SeriesCard.tsx:176`）是**封面按钮**，
     * 标题 `<p class="… text-fg-strong">`（`:230`）是它的**兄弟**、同在
     * `series-card-root`（`:127`）内 ⇒ 必须锚 root 再取 `p.text-fg-strong`，
     * 在 `series-card` 内部找标题会**永远找不到**（首版即栽在这里）。
     */
    const wall = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc)
      const roots = Array.from(document.querySelectorAll('[data-testid="series-card-root"]'))
      const titles = roots.map((c) => {
        const p = c.querySelector('p.text-fg-strong')
        return p ? p.textContent.trim() : ''
      })
      return { cards: roots.length, placeholder: titles.filter((t) => re.test(t)) }
    }, PLACEHOLDER_RE.source)
    check('剧集墙渲染了剧集卡片', wall.cards > 0, `series-card-root=${wall.cards}`)
    check('剧集墙存在占位名剧集卡片（`TG <chat_id> · <日期>`）',
      wall.placeholder.length > 0,
      `${wall.placeholder.length} 张：` + wall.placeholder.join(' / '))

    const waitFor = async (fn, timeoutMs = 20000, stepMs = 400) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (await page.evaluate(fn)) return true
        await new Promise((r) => setTimeout(r, stepMs))
      }
      return false
    }
    const hasCatAll = await waitFor(() => !!document.querySelector('[data-testid="media-cat-all"]'))
    check('左栏「全部内容」入口已挂载', hasCatAll, hasCatAll ? 'ok' : '超时未出现 media-cat-all')
    if (!hasCatAll) throw new Error('media-cat-all 未出现，无法进入条目视图')

    await page.evaluate(() => document.querySelector('[data-testid="media-cat-all"]').click())
    const hasGrid = await waitFor(() => !!document.querySelector('[data-testid="media-grid"]'))
    check('切到条目视图后 media-grid 已出现', hasGrid, hasGrid ? 'ok' : '超时未出现 media-grid')
    if (!hasGrid) throw new Error('media-grid 未出现，无法继续')
    await new Promise((r) => setTimeout(r, 800))

    const probe = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc)
      const grid = document.querySelector('[data-testid="media-grid"]')
      if (!grid) return { grid: false }
      const cards = Array.from(grid.querySelectorAll('[data-testid="media-card"]'))
      const rows = cards.map((c) => {
        const tp = c.querySelector('p.text-fg-strong')
        const titleLine = tp ? tp.textContent.trim() : ''
        // 副标题行 = 含来源徽标 (item-source) 的那一行；剧名 span 以 '·' 开头
        const subP = Array.from(c.querySelectorAll('p')).find((p) => p.querySelector('[data-testid="item-source"]'))
        let seriesTitle = ''
        if (subP) {
          const span = Array.from(subP.querySelectorAll('span')).find((s) => s.textContent.trim().startsWith('·'))
          seriesTitle = span ? span.textContent.trim().replace(/^·\s*/, '') : ''
        }
        return { titleLine, seriesTitle }
      })
      return {
        grid: true,
        total: rows.length,
        blankTitle: rows.filter((r) => r.titleLine === '').length,
        placeholder: rows.filter((r) => re.test(r.seriesTitle)),
        samples: rows.filter((r) => re.test(r.seriesTitle))
          .map((r) => `标题行=${JSON.stringify(r.titleLine)}  副标题=${JSON.stringify(r.seriesTitle)}`),
      }
    }, PLACEHOLDER_RE.source)

    check('网格按 PAGE=120 截断（卡片数 == min(120, API items)）',
      probe.total === Math.min(PAGE, apiItems),
      `页面卡片=${probe.total} / min(120, ${apiItems})=${Math.min(PAGE, apiItems)}`)

    check('存在「标题行空白」的卡片（item.title 空 = 既裁定行为，非缺陷）',
      probe.blankTitle > 0,
      `空白标题卡片=${probe.blankTitle} / ${probe.total}`)

    check('★ 存在副标题为占位名的卡片（本次复报核心现象）',
      probe.placeholder.length > 0,
      `${probe.placeholder.length} 张：\n      ` + probe.samples.join('\n      '))

    if (EXPECT_SUBSTR) {
      const hit = probe.samples.some((s) => s.includes(EXPECT_SUBSTR))
      check(`用户报障原文的副标题确实出现在卡片上（${EXPECT_SUBSTR}）`, hit,
        hit ? '命中' : '未命中 —— 可能不在首屏 120 条内')
    }

    // ── F. 判据自证：就地改掉首张占位卡的副标题，计数必须 -1；还原必须复原 ──
    const selfTest = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc)
      const grid = document.querySelector('[data-testid="media-grid"]')
      const count = () => {
        let n = 0
        for (const c of grid.querySelectorAll('[data-testid="media-card"]')) {
          const subP = Array.from(c.querySelectorAll('p')).find((p) => p.querySelector('[data-testid="item-source"]'))
          if (!subP) continue
          const span = Array.from(subP.querySelectorAll('span')).find((s) => s.textContent.trim().startsWith('·'))
          if (span && re.test(span.textContent.trim().replace(/^·\s*/, ''))) n++
        }
        return n
      }
      const before = count()
      if (before === 0) return { before, after: null, restored: null, skipped: true }
      // 找首张占位卡的剧名 span
      let target = null
      for (const c of grid.querySelectorAll('[data-testid="media-card"]')) {
        const subP = Array.from(c.querySelectorAll('p')).find((p) => p.querySelector('[data-testid="item-source"]'))
        if (!subP) continue
        const span = Array.from(subP.querySelectorAll('span')).find((s) => s.textContent.trim().startsWith('·'))
        if (span && re.test(span.textContent.trim().replace(/^·\s*/, ''))) { target = span; break }
      }
      const original = target.textContent
      target.textContent = '· 《判据自证_注入值》'
      const after = count()
      target.textContent = original
      const restored = count()
      return { before, after, restored, original, skipped: false }
    }, PLACEHOLDER_RE.source)

    if (selfTest.skipped) {
      check('判据自证（注入/还原）', false, '首屏无占位卡片，无法自证')
    } else {
      check('判据自证①：注入正常剧名后计数必须 -1（证明匹配器非恒真）',
        selfTest.after === selfTest.before - 1,
        `before=${selfTest.before} after=${selfTest.after}`)
      check('判据自证②：还原后计数必须复原（证明未污染）',
        selfTest.restored === selfTest.before,
        `before=${selfTest.before} restored=${selfTest.restored}`)
    }

    // 反向证伪用：把「不可能命中」的模式喂进同一套判定，必须恒为 0
    const negControl = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc)
      const grid = document.querySelector('[data-testid="media-grid"]')
      let n = 0
      for (const c of grid.querySelectorAll('[data-testid="media-card"]')) {
        const subP = Array.from(c.querySelectorAll('p')).find((p) => p.querySelector('[data-testid="item-source"]'))
        if (!subP) continue
        const span = Array.from(subP.querySelectorAll('span')).find((s) => s.textContent.trim().startsWith('·'))
        if (span && re.test(span.textContent.trim().replace(/^·\s*/, ''))) n++
      }
      return n
    }, '^__BUG283_NO_SUCH_PATTERN__$')
    check('负对照：不可能命中的模式必须恒为 0', negControl === 0, `命中=${negControl}`)

    const shot = path.join(require('node:os').tmpdir(), 'orighub-probe', 'bug283_placeholder_card.png')
    try { await page.screenshot(shot); console.log(`\n截图: ${shot}`) } catch (_e) {}

    const failed = results.filter((r) => !r.pass)
    console.log(`\n${results.length - failed.length}/${results.length} PASS`)
    return failed.length === 0 ? 0 : 2
  } finally {
    await browser.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('VERIFY FAILED:', e && e.message ? e.message : e)
    process.exit(1)
  })
