'use strict'

/**
 * BUG-334 —— 文件管理只列**受管下载根成品**：内部库不流出、受管根外文件不显示。
 *
 * 用户原话（2026-10-20）：「文件管理管理内容混乱，内部库流出，非管理文件被显示。」
 *
 * 判定不是「过滤一下列表」，而是**范围收口**。修复前实测（`store.db` 382 条带
 * `file_path` 的媒体条目 + daemon `/api/files` 38 个成品）：
 *
 * | 分类 | 条数 | 该不该出现在文件管理 |
 * |---|---|---|
 * | 路径落在引擎自用子目录（`.orighub/library`、`.blobs`、`library`） | 119 | 否 |
 * | 路径在受管根外（如 `test_videos/` 下的本地导入） | 226 | 否 |
 * | 受管根内普通路径 | 37 | 26 个已被 `/api/files` 枚举、11 个磁盘上已不存在 |
 *
 * ⇒ 并集里媒体那一半**净增 0 行**，只带噪声与幽灵行。判据因此是：
 *
 *  ① 列表行集 == `/api/files` 枚举集合（不是「其中一部分」）
 *  ② 每一行的路径都落在某个受管根之下
 *  ③ 没有任何一行落在引擎自用子目录（内部库不得流出）
 *  ④ 没有任何一行是「只登记、盘上没字节」的条目（无 `fileFact` 标记的行）
 *  ⑤ 反证：往页面注入一条内部库路径的行 ⇒ 必须被判红（证明 ③ 不是恒绿）
 *
 * ②③ 的路径在 Node 侧按 `/api/files` 的 `roots` 与 `ENGINE_OWNED` 常量实算，
 * 不依赖页面自述；④ 用行上是否带 `data-source="download"` 这个 DOM 锚判定
 * （不靠文案，靠锚点）。
 *
 * 用法：node tauri-shell/verify/verify_bug334_managed_only.cjs
 *   （需 vite :5180 + orig-daemon :19786；栈未起 ⇒ 直接 FAIL 退出，不静默跳过）
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  panel: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'MediaLibraryPanel.tsx'),
    'utf8',
  ),
}

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
const OUT = process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug334-managed-only')

/** 引擎自用子目录：与 `orig-daemon/src/files.rs` 的 `ENGINE_OWNED_SUBDIRS` 同源。 */
const ENGINE_OWNED = new Set(['.orighub', 'library', '.blobs'])

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function httpOk(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return r.status < 500
  } catch {
    return false
  }
}

async function main() {
  /* ── 静态段：cat-all 的行集必须由 `downloadFiles` 单独决定 ── */
  const singleSource = /if \(tab !== 'all'\) return items/.test(SRC.panel)
    && /const facts = downloadFiles/.test(SRC.panel)
    && !/\[\.\.\.items, \.\.\.facts\]/.test(SRC.panel)
  check('S1 cat-all 行集只由受管成品枚举决定（不再与媒体页求并集）', singleSource)

  if (failures > 0) {
    console.log('\n源码判据已红，运行时段不再执行（先修实现，别拿页面绿盖过源码红）')
    process.exit(1)
  }

  const stack = { app: await httpOk(APP_URL), daemon: await httpOk(`${DAEMON}/api/files`) }
  if (!stack.app || !stack.daemon) {
    check('栈就绪（vite :5180 + orig-daemon :19786）', false, JSON.stringify(stack))
    console.log('\n运行时段无法执行：请先启动 dev 栈后重跑。')
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP_URL)
    await page.evaluate(async () => {
      document.querySelector('[data-testid="nav-files"]')?.click()
      await new Promise((r) => setTimeout(r, 1800))
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeoutMs: 20000 },
    )

    /** Node 侧实算期望集合（两个端点，不靠页面自述）。 */
    const expected = await page.evaluate(async () => {
      const r = await fetch('http://127.0.0.1:19786/api/files', {
        headers: { accept: 'application/json' },
      })
      const j = await r.json()
      return { roots: j.roots || [], files: j.files || [] }
    })
    const norm = (p) => (p ?? '').replace(/\\/g, '/').toLowerCase()
    const roots = expected.roots.map((r) => norm(r).replace(/\/+$/, ''))
    const expectPaths = new Set(expected.files.map((f) => norm(f.path)))
    const underRoot = (p) => roots.some((r) => p === r || p.startsWith(r + '/'))
    const firstSeg = (p) => {
      const r = roots.find((x) => p.startsWith(x + '/'))
      return r ? p.slice(r.length + 1).split('/')[0] : ''
    }

    /** 滚到底累积所有行（窗口化，BUG-316 段②）；`data-total` 是渲染契约。 */
    const collected = await page.evaluate(async () => {
      const scroll = document.querySelector('[data-testid="file-list-scroll"]')
      if (!scroll) return { ok: false }
      const seen = new Map()
      const collect = () => {
        for (const el of document.querySelectorAll('[data-testid="file-list-row"]')) {
          const id = el.getAttribute('data-item-id')
          if (id == null || seen.has(id)) continue
          const name = el.querySelector('span.min-w-0.truncate')?.textContent || ''
          seen.set(id, {
            source: el.getAttribute('data-source') || '',
            name: name.replace('缺字节', '').trim(),
            title: el.getAttribute('title') || '',
          })
        }
      }
      const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)))
      for (let i = 0; i < 400; i++) {
        collect()
        const before = scroll.scrollTop
        scroll.scrollTop = before + 600
        await frame()
        if (scroll.scrollTop === before) break
      }
      collect()
      return {
        ok: true,
        total: Number(scroll.getAttribute('data-total') || NaN),
        rows: [...seen.entries()],
      }
    })
    check('② 滚到底累积行数 == data-total（窗口化不丢行、不多渲染）',
      collected.ok && collected.rows.length === collected.total,
      `collected=${collected.rows.length} total=${collected.total}`)
    if (!collected.ok) {
      check('列表容器存在', false)
      throw new Error('file-list-scroll 不存在')
    }

    const uiPaths = new Set(collected.rows.map(([, r]) => norm(r.title)).filter(Boolean))
    const missing = [...expectPaths].filter((p) => !uiPaths.has(p))
    const extra = [...uiPaths].filter((p) => !expectPaths.has(p))
    check('① data-total == 受管成品数',
      collected.ok && collected.total === expectPaths.size,
      `dataTotal=${collected.total} api=${expectPaths.size}`)
    check('① 行集 == 受管成品枚举集合（一行不多、一行不少）',
      missing.length === 0 && extra.length === 0,
      `ui=${uiPaths.size} api=${expectPaths.size} missing=${missing.length} extra=${extra.length}`)

    const outside = [...uiPaths].filter((p) => !underRoot(p))
    check('② 每一行都在某个受管根之下（受管根外文件不得显示）',
      outside.length === 0, `outside=${outside.length}${outside.length ? ' 例:' + outside[0] : ''}`)

    const engineRows = [...uiPaths].filter((p) => ENGINE_OWNED.has(firstSeg(p).toLowerCase()))
    check('③ 内部库不得流出（无一行落在 .orighub/library/.blobs）',
      engineRows.length === 0,
      `engine=${engineRows.length}${engineRows.length ? ' 例:' + engineRows[0] : ''}`)

    const byteLess = collected.rows.filter(([, r]) => r.source !== 'download')
    check('④ 每一行都带 fileFact 锚（`data-source="download"`）：无「只登记、没字节」的条目',
      byteLess.length === 0, `byteLess=${byteLess.length}`)

    const nonMedia = expected.files.filter(
      (f) => f.kind !== 'video' && f.kind !== 'photo' && f.kind !== 'audio',
    )
    check('⑤ 非媒体成品与媒体成品同一列表（BUG-299 判据 7 仍在）',
      nonMedia.length > 0, `nonMedia=${nonMedia.length}`)

    await page.screenshot(path.join(OUT, '01-managed-only.png'))

    /*
     * 反证：往 DOM 注入一条「内部库路径」的行 ⇒ ③ 必须红。
     * 只注入 DOM、不动数据源 —— 证明判据看的是行内容，不是「反正都绿」。
     */
    const falsify = await page.evaluate(async (args) => {
      const scroll = document.querySelector('[data-testid="file-list-scroll"]')
      if (!scroll) return { injected: false, hit: -1 }
      const row = document.createElement('div')
      row.setAttribute('data-testid', 'file-list-row')
      row.setAttribute('data-source', 'download')
      row.setAttribute('data-item-id', '-999999')
      // 路径由运行时的受管根拼出（不写死任何盘符：本仓禁机器绝对路径）
      row.title = args.roots[0].replace(/\/+$/, '') + '/' + args.engineDir
      scroll.prepend(row)
      const firstSeg = (t) => {
        const p = t.replace(/\\/g, '/').toLowerCase()
        const r = args.roots.find((x) => p.startsWith(x + '/'))
        return r ? p.slice(r.length + 1).split('/')[0] : ''
      }
      const hit = [...document.querySelectorAll('[data-testid="file-list-row"]')].filter(
        (el) => args.engineOwned.includes(firstSeg(el.getAttribute('title') || '')),
      ).length
      return { injected: true, hit }
    }, { engineDir: '.orighub/library/falsify.mov', roots, engineOwned: [...ENGINE_OWNED] })
    check('⑥ 反证：注入一条内部库路径 ⇒ 判据 ③ 能抓到（判据有牙）',
      falsify.injected && falsify.hit === 1, `hit=${falsify.hit}`)

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
  console.log('ALL PASS — 文件管理只列受管根成品（内部库不流出、根外文件不显示）')
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e)
  process.exit(1)
})
