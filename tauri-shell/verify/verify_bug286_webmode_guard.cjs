#!/usr/bin/env node
'use strict'

/**
 * BUG-286 验收（活栈 · CDP）：纯浏览器（网页调试模式）下 Tauri 原生调用必须**优雅降级**，
 * 桌面模式（有 `__TAURI_INTERNALS__` IPC 桥）行为必须**完全不变**。
 *
 * ## 判据（与 docs/bugs/BUG-286.md「验收证据」一一对应）
 *
 *   A 组 —— 网页调试模式（组件挂载前显式抹掉 Tauri 全局，见 installNoTauri）：
 *    A0 上下文成立：App 已挂载（#root 有子节点）且 `'__TAURI_INTERNALS__' in window === false`；
 *    A1 设置页可达：nav-settings → downloads tab → `settings-lib-open` 存在；
 *    A2 点「打开库根文件夹」：**无** uncaught 异常、**无** `Cannot read … 'invoke'`
 *       控制台报错、**无** 危险色 toast（三者都是 BUG-286 的报错上屏通道）；
 *    A3 同一点击后出现内联降级提示 `settings-lib-hint` 且含目标路径
 *       ⇒ 真的走了「复制路径 / 展示路径」，而不是把报错换成另一种沉默；
 *    A4 「浏览…」按钮在网页模式下 disabled（能力边界用禁用表达，不常驻道歉）；
 *    A5 「打开调试日志目录」同判据（第二个 openPath 现场）。
 *
 *   B 组 —— 桌面模式（挂载前注入带 invoke 探针的 `window.__TAURI_INTERNALS__`）：
 *    B1 「浏览…」按钮**未**被禁用 ⇒ 守卫没有把桌面入口一起藏掉（反向证伪点 3）；
 *    B2 点「打开库根文件夹」真的下发 IPC 命令（`plugin:opener|open_path`，参数含目标路径）
 *       ⇒ 桌面旧行为完整保留；
 *    B3 桌面模式**不出现**网页模式专属的降级提示。
 *
 *   C 组 —— 运行期环境响应（BUG-286 的`:37` freeze 判据）：
 *    C1 网页模式「浏览…」disabled ⇒ 注入 IPC 桥 + 触发 visibilitychange/focus
 *       ⇒ 按钮转为 enabled ⇒ 组件跟随运行期环境，而非冻结在首帧结论。
 *
 *   D 组 —— 反向证伪（必abytes红）：
 *    D1 把 openLogFolder 临时还原成裸 `openPath` + `setError`（去掉 isTauri 守卫）
 *       ⇒ A5 三个通道必须出现 `Cannot read properties of undefined (reading 'invoke')`；
 *    D2 字节级还原（sha256 与改前一致，禁 git checkout）后复跑必须复绿。
 *
 * ## 环境
 *   活栈：vite :5180 / orig-daemon :19786 / orig-tg。端口经 `_lib_endpoints.cjs`
 *   从 daemon `/api/config` 运行时解析，不写死。dev stack 不许 kill。
 *   本脚本不造后端夹具、不写配置文件（临时路径只填进未保存的输入框，随刷新消失）。
 *
 * 用法：`node tauri-shell/verify/verify_bug286_webmode_guard.cjs`（仓库根目录）
 * Env  : ORIG_VERIFY_OUT（截图/result.json 输出目录，默认 verify/evidence/BUG-286）
 * Exit : 0 = 全部通过；2 = 有判据失败（含证伪未按预期失败 / 还原后不复绿）。
 */

const path = require('path')
const fs = require('fs')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-286')
const SETTINGS_TSX = path.resolve(__dirname, '..', 'src', 'components', 'SettingsPanel.tsx')

/** BUG-286 的原始报错指纹（三个通道共用：toast 文案 / console.error / uncaught）。 */
const INVOKE_FINGERPRINT = /cannot\s+read\s+properties\s+of\s+undefined\s*\(reading\s*'invoke'\)|reading 'invoke'/i
// BUG-323：库根改为**只读派生值**（`<下载路径>/library`），页面不再有「库根输入框」，
// 因此也不需要「临时填一个路径把按钮凑成可点」的辅助常量（见 ensureLibBtnEnabled）。

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

// ─────────────────────────────── 浏览器上下文构造 ───────────────────────────────

/**
 * 在**任何应用脚本之前**把 Tauri 全局抹掉 —— 「网页调试模式」的定义就是没有 IPC 桥。
 * 真实 Chrome 里这两个全局本来就不存在，这里显式 delete 是为了让「无 Tauri」
 * 成为**被构造出来的条件**而不是被假设的默认值（否则如果某天壳被误注入，
 * 本脚本会假绿）。
 * @param {object} page cdp Page
 */
async function installNoTauri(page) {
  const source = `
    (function () {
      try { delete window.__TAURI_INTERNALS__ } catch (_e) {}
      try { delete window.__TAURI__ } catch (_e) {}
      try { delete window.__TAURI_IPC__ } catch (_e) {}
      window.__BUG286_TAURI_STRIPPED = true
    })()
  `
  await page.conn.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
    { sessionId: page.sessionId },
  )
}

/**
 * 整页导航（SPA 就绪判据的标准姿势）。
 *
 * 用 `DOMContentLoaded` + `#root` 挂载（cdp.goto 内置 `waitForRoot`）判就绪，
 * 而**不**等 `load`：① `load` 要等全部子资源，其中包括打到 orig-tg 的外链请求，
 * 慢的那个会连坐；② vite 在源文件变更后会触发自刷新，`load` 事件可能落在自刷新上
 * 而永久悬空 —— 实测**写回同字节**同样复现（用未被本缺陷触碰的文件验证），
 * 故与改动内容无关，是「文件变更后的首次完整加载」这一路径本身慢（可达 30s 量级）。
 * 超时放宽到 120s：断言一字未动，只把「加载慢」与「导航超时」分开。
 *
 * @param {object} page cdp Page
 * @param {string} appUrl 应用地址
 */
const gotoApp = (page, appUrl) =>
  page.goto(appUrl, { waitUntil: 'domcontentloaded', settleMs: 2500, timeout: 120000 })

/**
 * 桌面模式：挂载前注入一个带 **invoke 探针** 的 IPC 桥。
 * 光「存在」不够 —— 必须能证实 openPath 真的下去了一条 IPC 命令，
 * 否则「守卫没坏桌面模式」只是句口号。
 * @param {object} page cdp Page
 */
async function installFakeTauri(page) {
  const source = `
    (function () {
      window.__BUG286_INVOKES = []
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          invoke: function (cmd, args) {
            try {
              window.__BUG286_INVOKES.push({
                cmd: String(cmd),
                args: JSON.parse(JSON.stringify(args === undefined ? null : args)),
              })
            } catch (_e) {
              window.__BUG286_INVOKES.push({ cmd: String(cmd), args: null })
            }
            return Promise.resolve()
          },
          // plugin-opener / plugin-dialog 都走同一条桥，这里只需要 invoke 可用。
          transformCallback: function () { return 0 },
          convertFileSrc: function (p) { return p },
        },
      })
    })()
  `
  await page.conn.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source },
    { sessionId: page.sessionId },
  )
}

// ─────────────────────────────── 页面操作 ───────────────────────────────

/** 进设置页 → downloads tab → 等「打开库根文件夹」按钮出现。 */
async function openDownloadsTab(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-settings"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="settings-tab-downloads"]'), {
    timeout: 25000,
  })
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-tab-downloads"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="settings-lib-open"]'), {
    timeout: 20000,
  })
  await delay(500)
}

/** 进设置页 → 关于 tab → 等「打开调试日志目录」按钮出现。 */
async function openAboutTab(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-settings"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="settings-tab-about"]'), {
    timeout: 25000,
  })
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-tab-about"]')
    if (el) el.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="about-logs-open"]'), {
    timeout: 20000,
  })
  await delay(700) // 等 getConfig 把 logPaths 拉回来
}

/** 一次性读全所有判据需要的 DOM 事实（textContent 口径，不读 className）。 */
async function readPage(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const text = (s) => {
      const el = q(s)
      return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : null
    }
    const btn = (s) => {
      const el = q(s)
      return el ? { exists: true, disabled: !!el.disabled } : { exists: false, disabled: null }
    }
    const root = q('#root')
    return {
      rootMounted: !!(root && root.children.length > 0),
      hasTauri: '__TAURI_INTERNALS__' in window,
      tauriStripped: !!window.__BUG286_TAURI_STRIPPED,
      toast: text('[data-testid="global-toast"]'),
      libHint: text('[data-testid="settings-lib-hint"]'),
      logsHint: text('[data-testid="about-logs-hint"]'),
      libBtn: btn('[data-testid="settings-lib-open"]'),
      logsBtn: btn('[data-testid="about-logs-open"]'),
      /**
       * BUG-323：库根改为**只读派生值**（`<下载路径>/library`），页面不再有输入框；
       * 「浏览…」观测点随之从库根移到**下载目录**（唯一可编辑的路径项）。
       */
      libRootText: text('[data-testid="lib-root-readonly"]'),
      browseBtn: btn('[data-testid="download-dir-picker"] [data-testid="dir-picker-browse"]'),
      dirBrowserOpen: !!q('[data-testid="dir-browser"]'),
      logsDirValue: text('[data-testid="about-logs-dir"]'),
      invokes: Array.isArray(window.__BUG286_INVOKES) ? window.__BUG286_INVOKES.slice() : [],
    }
  })
}

/**
 * 执行一次「原生动作」并采集三个报错通道在这一次点击里的**增量**。
 * 只看增量：活栈是共享的，别的面板/轮询的噪音不能算到这一次点击头上。
 * @returns {Promise<{toast:null|string, newConsole:Array<string>, newPageErrors:Array<string>}>}
 */
async function clickAndCollect(page, selector) {
  const beforeConsole = page.consoleErrors().length
  const beforeErrors = page.pageErrors().length
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el) el.click()
  }, selector)
  await delay(1200)
  const st = await readPage(page)
  return {
    toast: st.toast,
    newConsole: page.consoleErrors().slice(beforeConsole),
    newPageErrors: page.pageErrors().slice(beforeErrors),
  }
}

/** 三个通道里只要有一条出现 BUG-286 指纹，就算「报错被抛到了用户眼前」。 */
function sawInvokeFailure(collected) {
  const toastHit = !!collected.toast && INVOKE_FINGERPRINT.test(collected.toast)
  const consoleHit = collected.newConsole.some((m) => INVOKE_FINGERPRINT.test(String(m)))
  const pageHit = collected.newPageErrors.some((m) => INVOKE_FINGERPRINT.test(String(m)))
  return { toastHit, consoleHit, pageHit, any: toastHit || consoleHit || pageHit }
}

/**
 * 确保「打开库根文件夹」可点。
 *
 * BUG-323 起库根由 daemon 下发（`<下载路径>/library`，只读），页面**没有**可填的
 * 输入框 —— 按钮不可点只可能是 daemon 不可达 / 未下发库根，那就是真的失败，
 * 不再靠「往输入框塞个临时路径」把它凑成可点。
 */
async function ensureLibBtnEnabled(page) {
  const st = await readPage(page)
  if (!st.libBtn.exists || st.libBtn.disabled) {
    throw new Error(
      `settings: 「打开库根文件夹」不可点（库根=${JSON.stringify(st.libRootText)}）—— daemon 不可达或库根未下发`,
    )
  }
  return st
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug286] app=${ep.app} daemon=${ep.daemon} tg=${ep.tg} out=${OUT}`)

  const beforeBytes = fs.readFileSync(SETTINGS_TSX)
  const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')

  let browser = null
  try {
    browser = await cdp.launch()

    // ═══════════════ A 组：网页调试模式（无 Tauri）═══════════════
    const web = await browser.newPage()
    await installNoTauri(web)
    await gotoApp(web, ep.app)

    let st = await readPage(web)
    check(
      'A0a App 已挂载（#root 有子节点）',
      st.rootMounted,
      `rootMounted=${st.rootMounted}`,
    )
    check(
      'A0b 无 Tauri 上下文成立（__TAURI_INTERNALS__ 已抹除）',
      st.hasTauri === false && st.tauriStripped === true,
      `hasTauri=${st.hasTauri} stripped=${st.tauriStripped}`,
    )

    await openDownloadsTab(web)
    await web.screenshot(path.join(OUT, '01_webmode_downloads_tab.png'))
    st = await readPage(web)
    check('A1 设置页 / 下载 tab 可达，且「打开库根文件夹」已渲染', st.libBtn.exists, `exists=${st.libBtn.exists}`)
    check(
      'A4 「浏览…」在网页模式下可点（BUG-323：走应用内目录浏览器，不再是禁用态）',
      st.browseBtn.exists && st.browseBtn.disabled === false,
      `browse=${JSON.stringify(st.browseBtn)}`,
    )

    // 使可点后再测点击
    st = await ensureLibBtnEnabled(web)
    const libTarget = String(st.libRootText || '').trim()
    check(
      'A2p 前置：库根已由 daemon 下发（只读展示有值、按钮可点）',
      !!libTarget && st.libBtn.disabled === false,
      `target=${JSON.stringify(libTarget)} disabled=${st.libBtn.disabled}`,
    )
    const libClick = await clickAndCollect(web, '[data-testid="settings-lib-open"]')
    const libFail = sawInvokeFailure(libClick)
    await web.screenshot(path.join(OUT, '02_webmode_lib_open_clicked.png'))
    check(
      'A2a 点「打开库根文件夹」无 uncaught 异常（含 invoke 指纹）',
      libFail.pageHit === false && libClick.newPageErrors.length === 0,
      `pageErrors=${JSON.stringify(libClick.newPageErrors.slice(0, 3))}`,
    )
    check(
      'A2b 同一点击无 invoke 控制台报错',
      libFail.consoleHit === false,
      `console=${JSON.stringify(libClick.newConsole.slice(0, 3))}`,
    )
    check(
      'A2c UI 未出现危险 toast（原始异常没有上屏）',
      libFail.toastHit === false,
      `toast=${JSON.stringify(libClick.toast)}`,
    )
    st = await readPage(web)
    check(
      'A3 出现内联降级提示且含目标路径（走的是降级，不是沉默）',
      !!st.libHint && st.libHint.includes(libTarget),
      `hint=${JSON.stringify(st.libHint)} target=${JSON.stringify(libTarget)}`,
    )

    // A5：第二个 openPath 现场（打开调试日志目录）
    await openAboutTab(web)
    st = await readPage(web)
    const logTarget = String(st.logsDirValue || '').trim()
    check(
      'A5p 前置：「打开调试日志目录」可点（daemon 下发了 logs.dir）',
      st.logsBtn.exists && st.logsBtn.disabled === false && !!logTarget,
      `btn=${JSON.stringify(st.logsBtn)} dir=${JSON.stringify(logTarget)}`,
    )
    const logClick = await clickAndCollect(web, '[data-testid="about-logs-open"]')
    const logFail = sawInvokeFailure(logClick)
    await web.screenshot(path.join(OUT, '03_webmode_logs_open_clicked.png'))
    check(
      'A5a 点「打开调试日志目录」三个通道均无 invoke 报错',
      logFail.any === false,
      `toast=${JSON.stringify(logClick.toast)} console=${JSON.stringify(logClick.newConsole.slice(0, 2))} page=${JSON.stringify(logClick.newPageErrors.slice(0, 2))}`,
    )
    st = await readPage(web)
    check(
      'A5b 日志入口同样给出含路径的降级提示',
      !!st.logsHint && st.logsHint.includes(logTarget),
      `hint=${JSON.stringify(st.logsHint)} dir=${JSON.stringify(logTarget)}`,
    )

    // ═══════════════ C 组：运行期环境响应（首帧 freeze 反向判据）═══════════════
    //
    // BUG-323 起「浏览…」不再是禁用态（网页模式改走应用内浏览器），观测点随之改为
    // **点击后的行为分叉**：无 Tauri 上下文 ⇒ 打开应用内浏览器（`dir-browser` 出现）；
    // 运行期注入 IPC 桥后 ⇒ 走原生通道（不再开应用内浏览器）。
    // 两次行为必须反映**当下**环境，而不是冻结在首帧结论上。
    await openDownloadsTab(web)
    await web.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="download-dir-picker"] [data-testid="dir-picker-browse"]',
      )
      if (el) el.click()
    })
    await delay(900)
    const c1a = await readPage(web)
    await web.screenshot(path.join(OUT, '04a_webmode_dir_browser.png'))
    check(
      'C1a 无 Tauri：点「浏览…」打开应用内目录浏览器',
      c1a.dirBrowserOpen === true,
      `dirBrowserOpen=${c1a.dirBrowserOpen}`,
    )

    // 关掉应用内浏览器，注入 IPC 桥后再点同一个按钮
    await web.evaluate(() => {
      const el = document.querySelector('[data-testid="dir-browser-close"]')
      if (el) el.click()
    })
    await delay(400)
    await web.evaluate(() => {
      // 运行期才拿到 IPC 桥（模拟壳晚注入）：组件必须自己跟上，而不是停在首帧结论。
      window.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() }
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await delay(1000)
    await web.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="download-dir-picker"] [data-testid="dir-picker-browse"]',
      )
      if (el) el.click()
    })
    await delay(900)
    const afterFlip = await readPage(web)
    await web.screenshot(path.join(OUT, '04_webmode_env_flip.png'))
    check(
      'C1b 注入 IPC 桥后：同一按钮转为走原生通道（不再开应用内浏览器）',
      afterFlip.hasTauri === true && afterFlip.dirBrowserOpen === false,
      `hasTauri=${afterFlip.hasTauri} dirBrowserOpen=${afterFlip.dirBrowserOpen}`,
    )

    // ═══════════════ B 组：桌面模式（有 IPC 桥）═══════════════
    const desk = await browser.newPage()
    await installFakeTauri(desk)
    await gotoApp(desk, ep.app)
    await openDownloadsTab(desk)
    let d = await readPage(desk)
    check('B0 桌面模式上下文成立（IPC 桥已注入）', d.hasTauri === true, `hasTauri=${d.hasTauri}`)
    check(
      'B1 桌面模式「浏览…」未被禁用（守卫没把桌面入口一起藏掉）',
      d.browseBtn.exists && d.browseBtn.disabled === false,
      `browse=${JSON.stringify(d.browseBtn)}`,
    )
    d = await ensureLibBtnEnabled(desk)
    const deskTarget = String(d.libRootText || '').trim()
    const deskClick = await clickAndCollect(desk, '[data-testid="settings-lib-open"]')
    d = await readPage(desk)
    await desk.screenshot(path.join(OUT, '05_desktop_lib_open_clicked.png'))
    const openerCmds = d.invokes.filter((i) => String(i.cmd).includes('plugin:opener'))
    const pathMatched = openerCmds.some((i) => {
      const a = i.args || {}
      return String(a.path || a.openPath || '') === deskTarget
    })
    check(
      'B2a 桌面模式真的下发了 opener IPC 命令（路径 === 目标路径）',
      openerCmds.length > 0 && pathMatched,
      `cmds=${JSON.stringify(d.invokes.slice(0, 4))} target=${JSON.stringify(deskTarget)}`,
    )
    check(
      'B2b 桌面模式未出现 invoke 报错（IPC 桥正常）',
      sawInvokeFailure(deskClick).any === false,
      `toast=${JSON.stringify(deskClick.toast)}`,
    )
    check(
      'B3 桌面模式不出现网页模式专属的降级提示',
      !d.libHint && !d.logsHint,
      `libHint=${JSON.stringify(d.libHint)} logsHint=${JSON.stringify(d.logsHint)}`,
    )

    // ═══════════════ D 组：反向证伪 ═══════════════
    console.log('[bug286] --- 证伪：openLogFolder 临时还原为裸 openPath + setError ---')
    const beforeText = beforeBytes.toString('utf8')
    const GUARDED_BLOCK = [
      '    const target = logPaths?.dir',
      '    if (!target) return',
      '    if (!isTauri()) {',
      '      await degradeToCopyPath(target)',
      '      return',
      '    }',
      '    try {',
    ].join('\n')
    const BARE_BLOCK = ['    const target = logPaths?.dir', '    if (!target) return', '    try {'].join('\n')

    if (!beforeText.includes(GUARDED_BLOCK)) {
      check('D0 证伪锚点存在（SettingsPanel.tsx 含加守卫后的 openLogFolder）', false, 'anchor-not-found')
    } else {
      check('D0 证伪锚点存在（SettingsPanel.tsx 含加守卫后的 openLogFolder）', true, 'openLogFolder')
      let restored = false
      try {
        fs.writeFileSync(SETTINGS_TSX, beforeText.replace(GUARDED_BLOCK, BARE_BLOCK))
        await delay(1500) // 等 vite watch 失效模块缓存
        // 变更后被改模块所在图要重建，本机实测**首次**整页加载可到 30s（与改动内容
        // 无关：用未被本缺陷触碰的文件写回同字节同样成立）—— 默认 30s 档正好压线，
        // 会把「加载慢」报成「导航超时」。这里放宽等待，断言本身一字未动。
        await gotoApp(web, ep.app)
        await openAboutTab(web)
        const red = await clickAndCollect(web, '[data-testid="about-logs-open"]')
        const redLoose = !!red.toast && /invoke/i.test(red.toast)
        const redFail = sawInvokeFailure(red)
        await web.screenshot(path.join(OUT, '06_red_state_bare_openpath.png'))
        check(
          'D1a 红态读数：裸 openPath 后 invoke 报错重新出现（toast 或 console）',
          redFail.toastHit || redFail.consoleHit || redLoose,
          `toast=${JSON.stringify(red.toast)} console=${JSON.stringify(red.newConsole.slice(0, 3))}`,
        )
        const redSt = await readPage(web)
        check(
          'D1b 红态读数：降级提示消失（降级分支被摘掉）',
          !redSt.logsHint,
          `hint=${JSON.stringify(redSt.logsHint)}`,
        )
      } finally {
        // 字节级还原（禁 git checkout —— 会冲掉并行 agent 的未提交改动）
        fs.writeFileSync(SETTINGS_TSX, beforeBytes)
        restored = true
      }
      const afterBytes2 = fs.readFileSync(SETTINGS_TSX)
      const shaAfter = crypto.createHash('sha256').update(afterBytes2).digest('hex')
      check(
        'D2a 字节级还原：sha256 与证伪前一致',
        restored && shaAfter === shaBefore,
        `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`,
      )
      await delay(1500)
      // 整页重载而不是指望 HMR：必须证明**磁盘上那份代码**跑出来的结果是绿的。
      // 同 D1：还原后的首次加载同样走一遍模块图重建，等待档放宽（断言不变）。
      await gotoApp(web, ep.app)
      await openAboutTab(web)
      const green = await clickAndCollect(web, '[data-testid="about-logs-open"]')
      const greenSt = await readPage(web)
      await web.screenshot(path.join(OUT, '07_restore_green.png'))
      check(
        'D2b 还原后复跑：日志入口无 invoke 报错且降级提示回归',
        sawInvokeFailure(green).any === false &&
          !!greenSt.logsHint &&
          String(greenSt.logsDirValue || '').trim() &&
          greenSt.logsHint.includes(String(greenSt.logsDirValue).trim()),
        `toast=${JSON.stringify(green.toast)} hint=${JSON.stringify(greenSt.logsHint)}`,
      )
    }

    const tail = {
      webPageErrors: web.pageErrors().slice(0, 5),
      deskPageErrors: desk.pageErrors().slice(0, 5),
    }
    console.log(`[bug286] tail=${JSON.stringify(tail)}`)
  } finally {
    if (browser) await browser.close()
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ passed, total: checks.length, all_passed: passed === checks.length, checks }, null, 2),
  )
  console.log(`\nRESULT ${passed}/${checks.length}  shots=${OUT}`)
  process.exit(passed === checks.length ? 0 : 2)
}

main().catch((e) => {
  console.error('FATAL', (e && e.stack) || e)
  process.exit(2)
})
