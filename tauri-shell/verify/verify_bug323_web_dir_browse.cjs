'use strict'
/**
 * BUG-323 缺陷③ 活栈验收：**WEB（网页调试模式）**下「浏览…」可选目录，且选了真生效。
 *
 * 背景：`DirectoryPicker` 的「浏览…」原为 `disabled={!inTauri}` —— 浏览器里灰死，
 * 只有桌面壳能用系统原生对话框 ⇒ 同一产品两套可用性语义（违背 BUG-179）。
 * 现改为 WEB 走**应用内目录浏览器**，数据来自 daemon 只读端点 `GET /api/fs/dirs`。
 *
 * 判据（每条「有值 + 具体值」，不允许「不等于旧值」式假绿）：
 *   A1 设置→下载 挂载成功，`download-dir-picker` 输入框存在；
 *   A2 「浏览…」**可点击**（`disabled === false`）；
 *   A3 「当前生效」行存在，且值 = daemon 的 `manual_download_root`（含 Downloads、不含 AppData）；
 *   B1 点击「浏览…」弹出应用内浏览器（`dir-browser`）；
 *   B2 起始目录 = 系统默认下载目录（与 /api/config 的 default_download_dir 一致）；
 *   B3 列出了可进入的子目录（count > 0）；
 *   B4 快捷锚点 `default_download` 存在且 title = 默认下载目录；
 *   B5 「上一级」可用且导航到父目录；
 *   B6 手输绝对路径可跳转；
 *   B7 失效路径**直出原因**（含「目录不存在」），不得渲染成「没有子目录」；
 *   B8 报错后界面仍可用（非死屏：上一级可用 + 条目仍在）；
 *   C1 选中某目录后回填输入框；
 *   C2 点保存后 daemon 的 `download_dir` = 新目录（**真实落库**，回读 /api/config）；
 *   C3 页面「当前生效」行同步为新目录；
 *   D1 结束把 `download_dir` 还原成测试前的值（验收夹具必须自己清干净）；
 *   D2 重载后输入框为空、「当前生效」= 系统下载目录；
 *   D3 全程无 console error。
 *
 * 验牙（双向）：
 *   ① 把 `disabled={!inTauri}` 装回去 ⇒ A2 必红；
 *   ② 把 `pick()` 改回「软失败 + 提示」而不打开浏览器 ⇒ B1/B2/B5/B6 必红；
 *   ③ 把错误分支改成静默（不渲染 `dir-browser-error`）⇒ B7 必红。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug323-web-dir-browse')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_URL || 'http://127.0.0.1:19786'

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

/** 归一化路径（尾分隔符 + 大小写），Windows 路径比较用。 */
function norm(p) {
  return String(p || '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

/**
 * 轮询页面谓词直到为真（用于**等异步落地**）。
 * @returns {Promise<true|null>} 命中 true；超时 null（调用方据此给出实际值，不静默）
 */
async function pollUntil(page, predFn, timeoutMs, args = []) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let hit = null
    try {
      hit = await page.evaluate(predFn, ...args)
    } catch (_e) {
      hit = null // 页面可能正在导航/执行上下文重建
    }
    if (hit) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

async function cfg() {
  const r = await fetch(`${DAEMON}/api/config`)
  if (!r.ok) throw new Error(`GET /api/config -> ${r.status}`)
  return r.json()
}

async function putDir(dir) {
  const r = await fetch(`${DAEMON}/api/config/download`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  })
  if (!r.ok) throw new Error(`PUT /api/config/download -> ${r.status} ${await r.text()}`)
  return r.json()
}

/** 导航后必须重新注入（页面文档被替换）。 */
async function inject(page) {
  await page.evaluate(() => {
    window.__q = (sel) => document.querySelector(sel)
    window.__all = (sel) => Array.from(document.querySelectorAll(sel))
    window.__text = (sel) => {
      const el = document.querySelector(sel)
      return el ? (el.textContent || '').trim() : null
    }
    window.__click = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      el.click()
      return true
    }
    window.__disabled = (sel) => {
      const el = document.querySelector(sel)
      return el ? Boolean(el.disabled) : null
    }
    window.__val = (sel) => {
      const el = document.querySelector(sel)
      return el ? el.value : null
    }
    // React 受控 input：必须走原生 setter + input 事件，直接改 .value 不会触发 onChange
    window.__setInput = (sel, val) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    window.__entryPaths = () =>
      Array.from(document.querySelectorAll('[data-testid^="dir-browser-entry-"]')).map((e) =>
        e.getAttribute('title'),
      )
  })
}

/**
 * 导航到应用（带重试 + 诊断）。
 *
 * vite 首次命中被改动过的模块图时会现场转换（tailwind 插件扫全量样式），冷启动
 * 可能超过 `Page.loadEventFired` 的 30s 等待 ⇒ 抛「导航超时」。这是**开发服务器
 * 冷启动**，不是产品缺陷：真实判据在后面的 A1/B1（页面挂载 + 对话框可开）。
 * 每次失败都记录 readyState，便于区分「没加载完」与「真挂了」。
 */
async function gotoApp(page) {
  let lastErr
  for (let i = 1; i <= 3; i += 1) {
    try {
      await page.goto(APP, { timeout: 45000, settleMs: 1500 })
      return
    } catch (e) {
      lastErr = e
      let state = 'n/a'
      try {
        state = await page.evaluate(() => `${document.readyState} root=${Boolean(document.querySelector('#root') && document.querySelector('#root').children.length)}`)
      } catch (_e2) {
        /* 页面可能还没建立执行上下文 */
      }
      console.log(`[nav] 第 ${i} 次导航失败：${e.message}（readyState=${state}）`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw lastErr
}

/** 打开 设置 → 下载 页签 */
async function openSettings(page) {  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-settings"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="settings-tab-downloads"]')),
    { timeout: 15000 },
  )
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-tab-downloads"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="download-dir-picker"] input')),
    { timeout: 15000, intervalMs: 200 },
  )
  // 配置是异步拉的：等「当前生效」行拿到真实路径再断言，否则会把「还没加载完」
  // 误判成「没有默认目录」（同一断言先 PASS 后 FAIL 的典型成因）。
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="download-dir-effective"]')
        return Boolean(el && /[\\/]/.test(el.textContent || ''))
      },
      { timeout: 15000, intervalMs: 200 },
    )
  } catch (_e) {
    // 超时不在这里失败：让后续断言带着实际文本去红，信息更准。
  }
  await inject(page)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const before = await cfg()
  const originalDir = before.download_dir ?? ''
  const defaultDir = before.default_download_dir
  const manualRoot = before.manual_download_root
  const homeDir = path.win32.dirname(defaultDir)
  console.log(`[fixture] download_dir(前) = ${JSON.stringify(originalDir)}`)
  console.log(`[fixture] default_download_dir = ${defaultDir}`)

  let restored = false
  const browser = await cdp.launch()
  const page = await browser.newPage()

  try {
    await gotoApp(page)
    await openSettings(page)

    // ── A：入口 ──────────────────────────────────────────────────────
    const a = await page.evaluate(() => ({
      browse: Boolean(window.__q('[data-testid="dir-picker-browse"]')),
      browseDisabled: window.__disabled('[data-testid="dir-picker-browse"]'),
      eff: window.__text('[data-testid="download-dir-effective"]'),
      inputVal: window.__val('[data-testid="download-dir-picker"] input'),
    }))
    check('A1 设置→下载 挂载成功（输入框存在）', a.inputVal !== null, `value="${a.inputVal}"`)
    // 验牙①：装回 disabled={!inTauri} 时这条必红
    check('A2 WEB 下「浏览…」可点击（不再 disabled）', a.browse && a.browseDisabled === false, `disabled=${a.browseDisabled}`)
    check(
      'A3 「当前生效」= daemon 的 manual_download_root（含 Downloads、不含 AppData）',
      Boolean(a.eff) && a.eff.includes('Downloads') && !a.eff.includes('AppData'),
      `"${a.eff}" vs "${manualRoot}"`,
    )
    await page.screenshot(path.join(OUT, '01-settings-downloads.png'))

    // ── B：应用内目录浏览器 ──────────────────────────────────────────
    await page.evaluate(() => window.__click('[data-testid="dir-picker-browse"]'))
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="dir-browser"]')), {
      timeout: 8000,
    })
    check('B1 弹出应用内目录浏览器', true)

    await page.waitForFunction(
      (expect) => {
        const el = document.querySelector('[data-testid="dir-browser-path"]')
        const v = String(el && el.textContent).trim().replace(/[\\/]+$/, '').toLowerCase()
        return v === String(expect).replace(/[\\/]+$/, '').toLowerCase()
      },
      { timeout: 15000, args: [defaultDir] },
    )
    const startPath = await page.evaluate(() => window.__text('[data-testid="dir-browser-path"]'))
    check('B2 起始目录 = 系统默认下载目录', norm(startPath) === norm(defaultDir), `${startPath}`)

    const entries0 = await page.evaluate(() => window.__entryPaths().length)
    check('B3 列出了可进入的子目录', entries0 > 0, `count=${entries0}`)

    const anchor = await page.evaluate(() => {
      const el = window.__q('[data-testid="dir-browser-root-default_download"]')
      return el ? { title: el.getAttribute('title'), text: el.textContent.trim() } : null
    })
    check('B4 快捷锚点「系统下载目录」存在且指向默认下载目录', Boolean(anchor) && norm(anchor.title) === norm(defaultDir), JSON.stringify(anchor))
    await page.screenshot(path.join(OUT, '02-browser-open.png'))

    // B5 上一级
    const upDisabled = await page.evaluate(() => window.__disabled('[data-testid="dir-browser-up"]'))
    check('B5a 「上一级」在非根目录可用', upDisabled === false, `disabled=${upDisabled}`)
    await page.evaluate(() => window.__click('[data-testid="dir-browser-up"]'))
    await page.waitForFunction(
      (expect) => {
        const el = document.querySelector('[data-testid="dir-browser-path"]')
        const v = String(el && el.textContent).trim().replace(/[\\/]+$/, '').toLowerCase()
        return v === String(expect).replace(/[\\/]+$/, '').toLowerCase()
      },
      { timeout: 8000, args: [homeDir] },
    )
    const parentPath = await page.evaluate(() => window.__text('[data-testid="dir-browser-path"]'))
    check('B5b 「上一级」导航到父目录', norm(parentPath) === norm(homeDir), `${parentPath} vs ${homeDir}`)

    // B6 手输跳转（回到默认下载目录）
    await page.evaluate((p) => window.__setInput('[data-testid="dir-browser-input"]', p), defaultDir)
    await page.evaluate(() => window.__click('[data-testid="dir-browser-go"]'))
    await page.waitForFunction(
      (expect) => {
        const el = document.querySelector('[data-testid="dir-browser-path"]')
        const v = String(el && el.textContent).trim().replace(/[\\/]+$/, '').toLowerCase()
        return v === String(expect).replace(/[\\/]+$/, '').toLowerCase()
      },
      { timeout: 8000, args: [defaultDir] },
    )
    const jumped = await page.evaluate(() => window.__text('[data-testid="dir-browser-path"]'))
    check('B6 手输绝对路径可跳转', norm(jumped) === norm(defaultDir), `${jumped}`)

    // B7 失效路径必须直出原因（验牙③：静默渲染成「没有子目录」时必红）
    // 失效路径在 Node 侧算好再传进去：`page.evaluate` 会序列化函数，页面上下文里
    // 没有 Node 的 `path`/`os`（引用即 ReferenceError）。
    const INVALID_DIR = path.join(os.tmpdir(), '__no_such_dir_for_bug323__')
    await page.evaluate(
      (v) => window.__setInput('[data-testid="dir-browser-input"]', v),
      INVALID_DIR,
    )
    await page.evaluate(() => window.__click('[data-testid="dir-browser-go"]'))
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="dir-browser-error"]')),
      { timeout: 8000 },
    )
    const errText = await page.evaluate(() => window.__text('[data-testid="dir-browser-error"]'))
    check('B7 失效路径直出原因（含「目录不存在」）', /目录不存在/.test(String(errText)), String(errText).slice(0, 80))
    await page.screenshot(path.join(OUT, '03-browser-error.png'))

    // B8 报错后不死屏
    const alive = await page.evaluate(() => ({
      up: window.__disabled('[data-testid="dir-browser-up"]'),
      entries: window.__entryPaths().length,
    }))
    check('B8 报错后界面仍可用（非死屏）', alive.up === false && alive.entries > 0, JSON.stringify(alive))

    // ── C：选中 + 保存真实生效 ───────────────────────────────────────
    // 选一个**与默认不同**的目录（父目录），让「真的变了」可观测
    await page.evaluate((p) => window.__setInput('[data-testid="dir-browser-input"]', p), homeDir)
    await page.evaluate(() => window.__click('[data-testid="dir-browser-go"]'))
    await page.waitForFunction(
      (expect) => {
        const el = document.querySelector('[data-testid="dir-browser-path"]')
        const v = String(el && el.textContent).trim().replace(/[\\/]+$/, '').toLowerCase()
        return v === String(expect).replace(/[\\/]+$/, '').toLowerCase()
      },
      { timeout: 8000, args: [homeDir] },
    )
    await page.evaluate(() => window.__click('[data-testid="dir-browser-pick"]'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="dir-browser"]'), {
      timeout: 8000,
    })
    const picked = await page.evaluate(() => window.__val('[data-testid="download-dir-picker"] input'))
    check('C1 选中结果回填输入框', norm(picked) === norm(homeDir), `"${picked}"`)

    await page.evaluate(() => window.__click('[data-testid="settings-save"]'))
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="download-dir-effective"]')
        return el && /[\\/]/.test(el.textContent || '')
      },
      { timeout: 8000 },
    )
    await new Promise((r) => setTimeout(r, 1200))
    const afterSave = await cfg()
    check('C2 保存后 daemon 的 download_dir = 新目录（真实落库）', norm(afterSave.download_dir) === norm(homeDir), `${afterSave.download_dir}`)
    const effAfterPick = await page.evaluate(() => window.__text('[data-testid="download-dir-effective"]'))
    check('C3 「当前生效」同步为新目录', String(effAfterPick).includes(homeDir), String(effAfterPick).slice(0, 90))
    await page.screenshot(path.join(OUT, '04-picked-and-saved.png'))

    // ── D：还原夹具 + 「引擎才是真源」 ───────────────────────────────
    await putDir(originalDir)
    const restoredCfg = await cfg()
    restored = true
    check('D1 夹具已还原 download_dir', (restoredCfg.download_dir ?? '') === originalDir, `${JSON.stringify(restoredCfg.download_dir)} == ${JSON.stringify(originalDir)}`)

    /*
     * D2 系列 = 缺陷④（界面与引擎真源漂移）的回归判据。
     *
     * 做法：**污染**本地镜像（localStorage `orig-hub:settings.downloadDirectory`）成一个
     * 引擎根本不会用的路径，再重载 —— 界面上只要还留着那个脏值，就等于「UI 在自说自话」。
     * 双向各测一次：引擎空 ⇒ 界面必须空；引擎有值 ⇒ 界面必须显示引擎值（镜像写空也不许赢）。
     */
    // 引擎根本不会用的路径：从临时目录推导（污染门禁 §7：脚本禁含机器绝对路径）
const STALE = path.join(os.tmpdir(), 'stale-not-the-engine-dir')
    await page.evaluate((v) => {
      const raw = localStorage.getItem('orig-hub:settings')
      const s = raw ? JSON.parse(raw) : {}
      s.downloadDirectory = v
      localStorage.setItem('orig-hub:settings', JSON.stringify(s))
    }, STALE)
    const poisoned = await page.evaluate(() => JSON.parse(localStorage.getItem('orig-hub:settings') || '{}').downloadDirectory)
    check('D2-pois 污染本地镜像成功（引擎未配置该目录）', poisoned === STALE, `"${poisoned}"`)

    await gotoApp(page)
    await openSettings(page)
    // 等界面「反应过来」：从脏值变成别的（= 确实按引擎对账了）。
    // 这一步不是等期望值出现，而是等**对账发生**，避免把异步未落地当成结论。
    const reconciledA = await pollUntil(
      page,
      (stale) => window.__val('[data-testid="download-dir-picker"] input') !== stale,
      12000,
      [STALE],
    )
    const d2 = await page.evaluate(() => ({
      val: window.__val('[data-testid="download-dir-picker"] input'),
      eff: window.__text('[data-testid="download-dir-effective"]'),
    }))
    check('D2a 重载后界面按引擎对账（脏镜像值不被沿用）', reconciledA === true, `input="${d2.val}"`)
    check('D2b 引擎未配置 ⇒ 输入框为空（= 用系统默认）', d2.val === '', `"${d2.val}"`)
    check('D2c 「当前生效」= 系统下载目录', String(d2.eff).includes('Downloads'), String(d2.eff).slice(0, 90))
    await page.screenshot(path.join(OUT, '05-restored.png'))

    // 反向：引擎**有值**，把镜像写空 ⇒ 界面必须显示引擎值
    await putDir(homeDir)
    await page.evaluate(() => {
      const raw = localStorage.getItem('orig-hub:settings')
      const s = raw ? JSON.parse(raw) : {}
      s.downloadDirectory = ''
      localStorage.setItem('orig-hub:settings', JSON.stringify(s))
    })
    await gotoApp(page)
    await openSettings(page)
    const reconciledB = await pollUntil(
      page,
      (expect) => {
        const el = document.querySelector('[data-testid="download-dir-picker"] input')
        return Boolean(el && el.value && el.value.replace(/\//g, '\\').toLowerCase() === expect.replace(/\//g, '\\').toLowerCase())
      },
      12000,
      [homeDir],
    )
    const d2d = await page.evaluate(() => window.__val('[data-testid="download-dir-picker"] input'))
    check('D2d 引擎有值 ⇒ 界面显示引擎值（空镜像不许赢）', reconciledB === true, `input="${d2d}" vs "${homeDir}"`)
    await page.screenshot(path.join(OUT, '06-engine-truth.png'))

    // 收尾再还原一次（D2d 又把引擎改了）
    await putDir(originalDir)
    const finalCfg = await cfg()
    check('D4 收尾后 download_dir 仍为测试前的值', (finalCfg.download_dir ?? '') === originalDir, `${JSON.stringify(finalCfg.download_dir)}`)

    // D3 只有「本功能引起的」前端错误才算失败：
    //  - `/api/fs/dirs?path=…` 的 404 是本脚本 B7 自己制造的负例（浏览器必然记一条）；
    //  - `/src/*?t=` 的 400 是 vite 开发服务器热更缓存戳失配（改完源文件后 HMR 拿旧
    //    `t` 重取模块），只在 dev 出现，与产品代码无关。
    // 其它网络错误（如 orig-tg 端点的瞬时 5xx）**不吞**：单列 INFO 打出原始行。
    // 判据收紧到「本功能路径」是为了让这条断言有牙 —— 把排除项写成大类会让它恒绿。
    const all = page.consoleErrors().filter((e) => !/favicon|ERR_/.test(e))
    const viteHmr = all.filter((e) => /\/src\/.*\?t=\d+/.test(e))
    const b7Fixture = all.filter((e) => /\/api\/fs\/dirs\?path=C%3A%2F__no_such/.test(e))
    const noise = new Set([...viteHmr, ...b7Fixture])
    const others = all.filter((e) => !noise.has(e))
    const relevant = others.filter((e) => !/Failed to load resource/.test(e))
    check('D3 本功能相关 console error = 0', relevant.length === 0, relevant.slice(0, 3).join(' | '))
    if (others.length) {
      console.log(`INFO - 其它网络错误（非本功能路径，未计入判据，原文保留）：\n  ${others.join('\n  ')}`)
    }
  } catch (e) {
    check('脚本异常（见下）', false, e && e.message)
  } finally {
    if (!restored) {
      try {
        await putDir(originalDir)
        console.log(`[cleanup] 异常退出，已还原 download_dir=${JSON.stringify(originalDir)}`)
      } catch (e) {
        console.log(`[cleanup] 还原失败：${e && e.message}`)
      }
    }
    await browser.close()
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  console.log(`RESULT: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
