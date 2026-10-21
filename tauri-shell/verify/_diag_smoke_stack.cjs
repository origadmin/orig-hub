'use strict'
/**
 * dev 栈冒烟诊断（不是门禁，是「服务到底能不能用」的现场体检）。
 *
 * 背景：`curl 200` 不证明可用（MEMORY「白屏最核失败」条），端口活着不等于界面起来了。
 * 本脚本按真实渲染 + 真实鼠标事件给出一份可复算的体检单：
 *   S1 前端真实挂载：`#root` 有子节点、`page-title` 有非空文字（白屏反判据）。
 *   S2 壳层导航齐全且可见：nav-download / nav-files / nav-tg / nav-settings 宽高 > 0。
 *   S3 页面有实质文本（> 50 字符），排除「骨架屏卡死 / 全空容器」。
 *   S4 前端 → daemon 通路：**在页面内** `fetch('http://127.0.0.1:19786/api/config')`
 *      （即应用真实调用路径，`src/api/daemon.ts` 的 `daemonBase()`）。判据随契约变更
 *      （BUG-358）：插件态只在 `plugins: [{id,label,enabled,running,port}]` 里，
 *      顶层**不得**再出现 `tg_` 前缀键；同时所有路径字段**不得**含反斜杠（BUG-357）。
 *      注意：`curl http://localhost:5180/api/config` 返回 200 是 vite 的 SPA 兜底 HTML，
 *      不是代理 —— 本项目**没有** vite proxy，这正是「curl 200 不证明」的现场实例。
 *   S5 TG 面板可用：真实鼠标点 nav-tg ⇒ `tg-panel-root` 出现，且**不出现**
 *      `tg-panel-broken`（后端不可达时组件会渲染该态）。
 *   S6 左栏频道行：频道节默认**折叠**（`channelOpen` 初值 false），须先真实点
 *      `channel-collapse-toggle` 展开，再对 `tg-group-row` 做有界等待（上限 90s），
 *      超时如实报红并带实测耗时 + testid 普查。
 *   S7 最矮受支持窗口（900×600，壳 minHeight=600）无横向溢出。
 *
 * 用法：node tauri-shell/verify/_diag_smoke_stack.cjs
 * 前置：dev 5180 + daemon 19786（orig-tg 19787）。产物 verify_shots/smoke-stack/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'smoke-stack')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_URL || 'http://127.0.0.1:19786'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function realClick(page, selector) {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const hit = document.elementFromPoint(x, y)
    return { x, y, hitOk: !!hit && (el === hit || el.contains(hit)) }
  }, selector)
  if (!pt) throw new Error(`realClick: 找不到或不可见 ${selector}`)
  if (!pt.hitOk) throw new Error(`realClick: ${selector} 的点击点被其它元素占据`)
  const conn = page.conn || page._conn
  const sessionId = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send('Input.dispatchMouseEvent', {
      type,
      x: pt.x,
      y: pt.y,
      button: 'left',
      clickCount: 1,
    }, { sessionId })
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const lines = []
  const problems = []
  const info = []
  const push = (ok, name, detail) => {
    lines.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok) problems.push(name)
  }
  const note = (name, detail) => {
    info.push(`INFO ${name}${detail ? ` — ${detail}` : ''}`)
  }

  let browser
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const t0 = Date.now()
    await page.goto(APP, { timeout: 60000 })
    note('首屏导航', `${Date.now() - t0}ms`)

    // ---- S1 前端真实挂载 ----
    const shell = await page.evaluate(() => {
      const root = document.querySelector('#root')
      const title = document.querySelector('[data-testid="page-title"]')
      return {
        rootChildren: root ? root.children.length : 0,
        title: title ? (title.textContent || '').trim() : '',
        bodyText: (document.body.innerText || '').trim().length,
      }
    })
    push(shell.rootChildren > 0, 'S1a #root 已挂载', `children=${shell.rootChildren}`)
    push(shell.title.length > 0, 'S1b page-title 有文字', `"${shell.title}"`)

    // ---- S2 导航齐全 ----
    const navIds = ['nav-download', 'nav-files', 'nav-tg', 'nav-settings']
    const navGeom = await page.evaluate((ids) => ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (!el) return { id, found: false }
      const r = el.getBoundingClientRect()
      return { id, found: true, w: Math.round(r.width), h: Math.round(r.height) }
    }), navIds)
    const navBad = navGeom.filter((n) => !n.found || n.w === 0 || n.h === 0)
    push(navBad.length === 0, 'S2 导航四项均可见', navGeom.map((n) => `${n.id}:${n.found ? `${n.w}x${n.h}` : '缺失'}`).join(' '))

    // ---- S3 实质文本 ----
    push(shell.bodyText > 50, 'S3 页面有实质内容（非白屏）', `innerText=${shell.bodyText} 字符`)

    // ---- S4 前端 → daemon 通路（页面内 fetch，即应用真实路径） ----
    // 判据随契约变更（BUG-358）：`/api/config` 里**不再**有 `tg_port`/`tg_running`
    // 这类把插件名写死的键，插件态一律在 `plugins: [{id,label,enabled,running,port}]`。
    // 这里同时把两条裁定做成**结构性反判据**（换形态长回来就红）：
    //   ① 顶层不得出现任何 `tg_` 前缀的键（插件名不得进契约）；
    //   ② 所有路径字段不得含反斜杠（BUG-357：同一响应里只能有一种形态）。
    let proxyOk = false
    let proxyDetail = ''
    try {
      const got = await page.evaluate(async () => {
        const res = await fetch('http://127.0.0.1:19786/api/config')
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON */ }
        return { status: res.status, json, head: text.slice(0, 60) }
      })
      const cfg = got.json
      const plugins = Array.isArray(cfg?.plugins) ? cfg.plugins : []
      const tg = plugins.find((p) => p.id === 'tg')
      const leaked = cfg ? Object.keys(cfg).filter((k) => k.toLowerCase().startsWith('tg_')) : []
      const pathKeys = [
        'download_dir', 'library_root', 'effective_download_root',
        'manual_download_root', 'default_download_dir',
      ]
      const backslash = pathKeys.filter((k) => typeof cfg?.[k] === 'string' && cfg[k].includes('\\'))
      const logsBackslash = ['dir', 'orig_tg', 'errors'].filter(
        (k) => typeof cfg?.logs?.[k] === 'string' && cfg.logs[k].includes('\\'),
      )
      proxyOk =
        got.status === 200 &&
        !!tg &&
        typeof tg.running === 'boolean' &&
        typeof tg.port === 'number' &&
        leaked.length === 0 &&
        backslash.length === 0 &&
        logsBackslash.length === 0
      proxyDetail = cfg
        ? `status=${got.status} plugins=${plugins.length} tg.port=${tg?.port} tg.running=${tg?.running}` +
          ` 泄漏tg_键=${leaked.length ? leaked.join(',') : '无'}` +
          ` 路径反斜杠=${backslash.length ? backslash.join(',') : '无'}` +
          ` logs反斜杠=${logsBackslash.length ? logsBackslash.join(',') : '无'}`
        : `status=${got.status} 非 JSON: ${got.head}`
    } catch (err) {
      proxyDetail = `异常 ${err.message}`
    }
    push(proxyOk, 'S4 页面内 fetch → daemon /api/config（plugins 契约 + 路径单形态）', proxyDetail)

    // 直连 daemon 对照（排除「页面报错但后端其实活着」）
    try {
      const h = await fetch(`${DAEMON}/health`).then((r) => r.json())
      note('daemon 直连 /health', JSON.stringify(h))
    } catch (err) {
      note('daemon 直连 /health', `异常 ${err.message}`)
    }

    // ---- S5 TG 面板 ----
    await realClick(page, '[data-testid="nav-tg"]')
    let panelUp = true
    try {
      await page.waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), { timeout: 20000 })
    } catch {
      panelUp = false
    }
    const broken = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tg-panel-broken"]')
      if (!b) return null
      const t = document.querySelector('[data-testid="tg-panel-broken-title"]')
      return (t && t.textContent || b.textContent || '').trim().slice(0, 120)
    })
    push(panelUp, 'S5a 点 nav-tg ⇒ tg-panel-root 出现', panelUp ? '' : '20s 内未出现')
    push(panelUp && broken === null, 'S5b 未渲染「后端不可达」态', broken ? `tg-panel-broken="${broken}"` : '')

    // ---- S6 左栏频道行（先展开频道节，再有界等待） ----
    let expanded = false
    try {
      await realClick(page, '[data-testid="channel-collapse-toggle"]')
      expanded = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="channel-collapse-toggle"]')
        return !!t && t.getAttribute('aria-expanded') === 'true'
      })
    } catch (err) {
      note('展开频道节', `失败 ${err.message}`)
    }
    const tCh = Date.now()
    let rows = 0
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      rows = await page.evaluate(() => document.querySelectorAll('[data-testid="tg-group-row"]').length)
      if (rows > 0) break
      await sleep(500)
    }
    const chCost = Date.now() - tCh
    push(rows > 0, 'S6 展开频道节后 tg-group-row ≥ 1', `expanded=${expanded} rows=${rows} 等待=${chCost}ms`)
    if (rows === 0) {
      const census = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="tg-panel-root"]')
        const out = {}
        if (root) {
          root.querySelectorAll('[data-testid]').forEach((el) => {
            const k = el.getAttribute('data-testid')
            out[k] = (out[k] || 0) + 1
          })
        }
        return {
          census: out,
          text: root ? (root.innerText || '').replace(/\s+/g, ' ').slice(0, 400) : '(无 tg-panel-root)',
        }
      })
      note('面板 testid 普查', JSON.stringify(census.census))
      note('面板文本', census.text)
    }

    // ---- S6b 左栏计数与 API 真值收敛（有界等待，不拿首帧 0 当结论） ----
    let apiTotal = null
    try {
      const cfg = await fetch(`${DAEMON}/api/config`).then((r) => r.json())
      if (cfg.tg_port) {
        const d = await fetch(`http://127.0.0.1:${cfg.tg_port}/api/tg/dialogs?limit=1`).then((r) => r.json()).catch(() => null)
        if (d && typeof d.total === 'number') apiTotal = d.total
      }
    } catch { /* 取不到只影响本项 */ }
    const tCount = Date.now()
    let rowState = []
    const cDeadline = Date.now() + 60000
    while (Date.now() < cDeadline) {
      rowState = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="tg-group-row"]')).map((el) => {
        const spans = el.querySelectorAll('span')
        const title = (spans[0] && spans[0].textContent || '').trim()
        const count = Number((spans[spans.length - 1] && spans[spans.length - 1].textContent || '').trim())
        return { title, count }
      }))
      const allRow = rowState.find((r) => r.title.includes('全部订阅') || /all/i.test(r.title))
      if (apiTotal === null ? rowState.some((r) => r.count > 0) : Boolean(allRow && allRow.count === apiTotal)) break
      await sleep(500)
    }
    const countCost = Date.now() - tCount
    const allRowFinal = rowState.find((r) => r.title.includes('全部订阅') || /all/i.test(r.title))
    const countOk = apiTotal === null ? Boolean(allRowFinal && allRowFinal.count > 0) : Boolean(allRowFinal && allRowFinal.count === apiTotal)
    push(
      countOk,
      'S6b 左栏「全部订阅」计数 === API dialogs total',
      `UI=${allRowFinal ? allRowFinal.count : '无行'} API=${apiTotal === null ? '未取到' : apiTotal} 等待=${countCost}ms 行数=${rowState.length}`,
    )
    note('分组行明细', rowState.map((r) => `${r.title}:${r.count}`).join(' | ') || '(空)')

    // ---- S8（仅 INFO，不判死）中列缩略图加载率：空白灰块 vs 真实缩略图 ----
    const thumbs = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'))
      const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length
      const bg = Array.from(document.querySelectorAll('div,span'))
        .filter((el) => {
          const s = getComputedStyle(el)
          return s.backgroundImage && s.backgroundImage !== 'none'
        }).length
      return { imgs: imgs.length, loaded, bgImage: bg, sample: imgs.slice(0, 4).map((i) => `${i.getAttribute('loading') || '-'}|${(i.currentSrc || i.src || '').slice(0, 90)}|nw=${i.naturalWidth}`) }
    })
    note('中列缩略图', `img=${thumbs.imgs} 已解码=${thumbs.loaded} 背景图元素=${thumbs.bgImage}`)
    for (const s of thumbs.sample) note('  ↳ img', s)

    await page.screenshot(path.join(OUT, 'tg-panel-1440x900.png'))

    // ---- S7 最矮受支持窗口 ----
    await page.setViewport({ width: 900, height: 600 })
    await sleep(600)
    const overflow = await page.evaluate(() => {
      const de = document.scrollingElement || document.documentElement
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, viewportW: window.innerWidth }
    })
    push(
      overflow.viewportW === 900 && overflow.scrollW <= overflow.clientW + 1,
      'S7 900×600 无横向溢出',
      `viewportW=${overflow.viewportW} scrollW=${overflow.scrollW} clientW=${overflow.clientW}`,
    )
    await page.screenshot(path.join(OUT, 'tg-panel-900x600.png'))

    const errs = typeof page.consoleErrors === 'function' ? page.consoleErrors() : []
    note('控制台 error 数', String(errs.length))
    for (const e of errs.slice(0, 5)) note('  ↳', String(e).slice(0, 200))

    const pageErrs = typeof page.pageErrors === 'function' ? page.pageErrors() : []
    note('页面未捕获异常数', String(pageErrs.length))
    for (const e of pageErrs.slice(0, 3)) note('  ↳', String(e).slice(0, 200))
  } finally {
    if (browser) await browser.close().catch(() => {})
  }

  const out = [...lines, ...info, '', problems.length ? `SMOKE FAIL (${problems.length}): ${problems.join(', ')}` : 'SMOKE ALL PASS'].join('\n')
  fs.writeFileSync(path.join(OUT, 'result.txt'), `${out}\n`, 'utf8')
  console.log(out)
  process.exit(problems.length ? 1 : 0)
}

main().catch((err) => {
  console.error(`SMOKE CRASH: ${err && err.stack || err}`)
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'result.txt'), `SMOKE CRASH: ${err && err.message}\n`, 'utf8')
  } catch { /* ignore */ }
  process.exit(1)
})
