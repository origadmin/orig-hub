#!/usr/bin/env node
'use strict'

/**
 * BUG-170 验收探针：入库全程「条目连续可见 + 状态单调迁移」（灭闪烁）。
 *
 * 修复前（三源拼接 + 登记推迟）必现消失窗口；本探针在**mock 隔离实例**上以
 * CDP 200ms 采样一次完整 mock 缓存任务（3 条相册 ≈ 7.2s 写盘，保证 5s 轮询
 * 一定能观察到「缓存中」），断言：
 *   1. 后端库列表（`/api/media/items`）里 3 个条目**一旦出现绝不消失**（0 消失窗口）
 *      —— 库列表连续性；
 *   2. TG feed 相册气泡的呈现状态迁移**单调** ∈ {登记/缺字节 → 缓存中 → 完成}
 *      —— 单源派生不倒退、无空洞；
 *   3. 相册气泡全程不离开 DOM（0 消失窗口）。
 * 截图为证（开始 / 进行中 / 完成各一张）。
 *
 * ## 隔离实例（自带拉起与清理，脚本退出必杀进程树 + 删临时目录）
 *
 *   - mock 构建**先重建再起**（mock 产物陈旧会读旧行为——本仓库已知坑）：
 *     `CARGO_TARGET_DIR=target-mock cargo build -p orig-tg --release --features mock`
 *   - 端口 19879（生产 9877 绝不触碰）；库/会话/下载/库根全部在系统临时目录
 *     （`ORIG_TG_LIBRARY_DIR` 一并隔离，P2 归仓不落用户盘）。
 *   - 前端 dev server 由本脚本拉起（`VITE_TG_PORT=19879 npm run dev`，5180，
 *     daemon 的 CORS 只放行该源）。5180 被占用时退出码 2（先关掉手头的 dev）。
 *
 * Usage:   node verify/verify_ingest_no_blink.cjs
 * Env:     MOCK_PORT(默认19879) APP_PORT(默认5180) ORIG_VERIFY_OUT
 * Exit:    0 = 全部断言通过；1 = 断言失败；2 = 环境问题
 */

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const ENGINE_DIR = path.join(REPO_ROOT, 'download-engine')
const SHELL_DIR = path.join(REPO_ROOT, 'tauri-shell')

const MOCK_PORT = Number(process.env.MOCK_PORT || 19879)
const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`

/** mock 夹具（crates/orig-tg/src/mock.rs）：主频道 3 项相册（group 9001）+ 单发视频 4 */
const MOCK_CHAT_ID = -1009876543210
const MOCK_GROUP = 9001
const MESSAGE_IDS = [1, 2, 3]
const REFS = MESSAGE_IDS.map((id) => `${MOCK_CHAT_ID}:${id}`)

const SAMPLE_INTERVAL_MS = 200
const SAMPLE_TIMEOUT_MS = 60000

const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-no-blink')

const results = []
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`)
  return ok
}

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request(
      url,
      { method, headers: data ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          // 非 JSON 响应（如 vite dev 的 HTML）原样带回，调用方只看 status
          let parsed = null
          if (raw && /application\/json/i.test(res.headers['content-type'] || '')) {
            try {
              parsed = JSON.parse(raw)
            } catch (_e) {
              parsed = null
            }
          }
          resolve({ status: res.statusCode, body: parsed, raw })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    if (data) req.write(data)
    req.end()
  })
}

function waitFor(fn, timeoutMs, everyMs = 250) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = async () => {
      try {
        const v = await fn()
        if (v) return resolve(v)
      } catch (_e) {
        /* keep polling */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, everyMs)
    }
    tick()
  })
}

async function main() {
  // 产物目录必须仓外（AGENTS.md §6 污染防线）
  const resolvedOut = path.resolve(OUT_DIR)
  if (resolvedOut.startsWith(path.resolve(REPO_ROOT) + path.sep)) {
    console.error('[verify:no-blink] 产物目录不得在仓库内')
    return 2
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ---- 1. 先重建 mock 构建（陈旧产物会读旧行为——本仓库已知坑） ----
  console.log('[verify:no-blink] building mock binary (target-mock) ...')
  const build = spawnSync('cargo', ['build', '-p', 'orig-tg', '--release', '--features', 'mock'], {
    cwd: ENGINE_DIR,
    env: { ...process.env, CARGO_TARGET_DIR: 'target-mock' },
    encoding: 'utf8',
  })
  if (build.status !== 0) {
    console.error('[verify:no-blink] mock build failed:\n', build.stdout, build.stderr)
    return 2
  }
  const exe = path.join(ENGINE_DIR, 'target-mock', 'release', process.platform === 'win32' ? 'orig-tg.exe' : 'orig-tg')

  // ---- 2. 隔离实例（临时目录 + 19879） ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-noblink-'))
  const downloads = path.join(tmp, 'downloads')
  fs.mkdirSync(downloads, { recursive: true })
  const tgEnv = {
    ...process.env,
    ORIG_TG_PORT: String(MOCK_PORT),
    ORIG_TG_DB: path.join(tmp, 'store.db'),
    ORIG_TG_SESSION: path.join(tmp, 'session.session'),
    ORIG_TG_DOWNLOAD_DIR: downloads,
    ORIG_TG_LIBRARY_DIR: path.join(tmp, 'library'),
    ORIG_TG_MOCK: '1',
  }
  const tg = spawn(exe, [], { env: tgEnv, cwd: path.dirname(exe), stdio: 'ignore', detached: false })
  const cleanups = []
  cleanups.push(() => {
    try {
      tg.kill()
    } catch (_e) {}
  })
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
  console.log(`[verify:no-blink] mock orig-tg pid=${tg.pid} port=${MOCK_PORT} tmp=${tmp}`)

  let devServer = null
  let browser = null
  try {
    await waitFor(async () => {
      const r = await httpJson('GET', `${MOCK_BASE}/api/tg/diag`)
      return r.status === 200 && r.body && r.body.mock === true
    }, 20000)
    console.log('[verify:no-blink] mock instance ready (diag ok, mock=true)')

    // mock 会话初始为 Anonymous：走 mock 登录链（start → code，MOCK_CODE="00000" 即
    // Authorized，见 mock.rs），否则前端渲染「未绑定」引导页，频道/feed 根本不出现。
    await httpJson('POST', `${MOCK_BASE}/api/tg/start`, { phone: '+15550001111' })
    const auth = await httpJson('POST', `${MOCK_BASE}/api/tg/code`, {
      phone: '+15550001111',
      code: '00000',
    })
    if (!check('mock.login.authorized', auth.status === 200, `status=${auth.status}`)) return 2
    await waitFor(async () => {
      const r = await httpJson('GET', `${MOCK_BASE}/api/tg/diag`)
      return r.body && r.body.session_phase === 'Authorized'
    }, 10000)
    console.log('[verify:no-blink] mock session Authorized')

    // ---- 3. dev server（VITE_TG_PORT 指向隔离实例） ----
    // 先查占用再启动（strictPort 5180；被占 = 手头的 dev server，先关掉）。
    const net = require('node:net')
    const portOccupied = await new Promise((resolve) => {
      const s = net.connect(APP_PORT, '127.0.0.1')
      s.once('connect', () => (s.destroy(), resolve(true)))
      s.once('error', () => resolve(false))
    })
    if (portOccupied) {
      console.error(`[verify:no-blink] 端口 ${APP_PORT} 已被占用（手头的 dev server？请先关闭）`)
      return 2
    }
    // Windows 上 .cmd 必须 shell:true（Node ≥18.20 的 EINVAL 防护）；清理走 taskkill
    // /T 杀整棵进程树（shell 包装下 kill() 只杀得到壳）。vite 输出落 tmp 日志，
    // 启动失败时打印（strictPort 冲突 / npm 缺失等都从这看）。
    const devLog = path.join(tmp, 'vite.log')
    const devOut = fs.openSync(devLog, 'a')
    devServer = spawn('npm', ['run', 'dev'], {
      cwd: SHELL_DIR,
      env: { ...process.env, VITE_TG_PORT: String(MOCK_PORT) },
      stdio: ['ignore', devOut, devOut],
      shell: process.platform === 'win32',
    })
    cleanups.push(() => {
      try {
        fs.closeSync(devOut)
      } catch (_e) {}
      try {
        if (process.platform === 'win32' && devServer.pid) {
          spawnSync('taskkill', ['/PID', String(devServer.pid), '/T', '/F'])
        } else {
          devServer.kill()
        }
      } catch (_e) {}
    })
    // 就绪轮询（不用 waitFor：dev server 早退要立刻报出日志，不能吞错干等超时）
    const devStarted = Date.now()
    for (;;) {
      if (devServer.exitCode !== null) {
        console.error(
          `[verify:no-blink] dev server 早退 (code=${devServer.exitCode})：\n` +
            fs.readFileSync(devLog, 'utf8').slice(-2000),
        )
        return 2
      }
      try {
        const r = await httpJson('GET', APP_URL.replace(/\/$/, '') + '/')
        if (r.status === 200) break
      } catch (_e) {
        /* not ready yet */
      }
      if (Date.now() - devStarted > 45000) {
        console.error('[verify:no-blink] dev server 45s 未就绪：\n' + fs.readFileSync(devLog, 'utf8').slice(-2000))
        return 2
      }
      await new Promise((r2) => setTimeout(r2, 250))
    }
    console.log(`[verify:no-blink] dev server ready at ${APP_URL}`)

    // ---- 4. 浏览器：进 TG 视图，选中 Mock Channel，等相册气泡渲染 ----
    browser = await cdp.launch()
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    try {
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="context-bar"]')),
        { timeout: 45000, intervalMs: 200 },
      )
    } catch (_e) {
      const dump = await page.evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        rootChildren: document.querySelector('#root')
          ? document.querySelector('#root').children.length
          : -1,
        testids: Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .slice(0, 40),
        text: (document.body.innerText || '').slice(0, 300).replace(/\n+/g, ' | '),
      }))
      console.error('[verify:no-blink] context-bar 未出现，DOM 转储：', JSON.stringify(dump, null, 2))
      await page.screenshot(path.join(OUT_DIR, 'debug-no-shell.png'))
      return 1
    }
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    // 先等频道清单出现（监控中/全部订阅），再点 "Mock Channel" 进内容视图
    //（tg-toolbar 在频道内容视图才渲染，空面板没有它）。
    await page.waitForFunction(() => /全部订阅/.test(document.body.innerText || ''), {
      timeout: 45000,
      intervalMs: 200,
    })
    // 频道组（BUTTON「全部订阅 n」）默认折叠：等它出现 → 展开 → 等扫描结果把
    // 频道标题渲染出来 → 点 "Mock Channel"（最内层元素，click 冒泡到行）。
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button')).some((b) =>
          (b.textContent || '').startsWith('全部订阅'),
        ),
      { timeout: 45000, intervalMs: 200 },
    )
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((b) =>
        (b.textContent || '').startsWith('全部订阅'),
      )
      if (b) b.click()
    })
    await page.waitForFunction(
      () => (document.body.textContent || '').includes('Mock Channel'),
      { timeout: 30000, intervalMs: 200 },
    )
    // 频道行点击偶发不生效（列表渲染/收起动画竞态，feed 停在「从左侧选择频道」）：
    // 点后短等 feed 出现，未出则重试点击（最多 5 次）。
    let albumReady = false
    for (let attempt = 0; attempt < 5 && !albumReady; attempt++) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('body *')).filter(
          (el) => (el.textContent || '').includes('Mock Channel') && el.children.length === 0,
        )
        const deepest = all[all.length - 1]
        if (deepest) deepest.click()
      })
      try {
        await page.waitForFunction(
          () => Boolean(document.querySelector('[data-testid="album-grid"]')),
          { timeout: 8000, intervalMs: 200 },
        )
        albumReady = true
      } catch (_e) {
        /* 重试 */
      }
    }
    if (!check('feed.channel.selected', albumReady, '点击 Mock Channel 后 album-grid 未出现（重试 5 次）')) return 1
    check('feed.album.rendered', true)
    await page.screenshot(path.join(OUT_DIR, 'blink-0-before.png'))

    // ---- 5. 入队整组缓存任务（3 × 2.4s ≈ 7.2s 写盘） ----
    // **必须走 UI**（点击相册气泡的「缓存」按钮），不能 API 直驱入队：前端轮询是
    // 「无任务零开销」设计（BUG-030 裁定，TgPanel 只在 hasActiveTask 时起 5s 轮询，
    // UI 入队后 refreshCacheTasks() 立即同步任务态）——API 直驱的任务前端永远
    // 不可见，状态机根本不会启动（这正是首轮采样全 `registered` 的根因）。
    // mock 夹具相册 3 项全是 video（mock.rs `mk` video/mp4）→ 按钮文案 `tg.download`
    // =「缓存」，点击即 downloadAlbum（带 groupId 入队 + 立即刷新）。
    const clickedDownload = await page.evaluate(() => {
      const grids = document.querySelectorAll('[data-testid="album-grid"]')
      if (grids.length === 0) return false
      const bubble = grids[0].closest('div.rounded-2xl') || grids[0].parentElement
      if (!bubble) return false
      const btn = Array.from(bubble.querySelectorAll('button')).find(
        (b) => (b.textContent || '').trim() === '缓存',
      )
      if (!btn) return false
      btn.click()
      return true
    })
    if (!check('feed.cache.button.clicked', clickedDownload, '相册气泡里没找到「缓存」按钮')) return 1
    let taskId = null
    try {
      await waitFor(async () => {
        const r = await httpJson('GET', `${MOCK_BASE}/api/tg/cache/tasks`)
        if (r.body && r.body.task && r.body.task.id !== undefined) {
          taskId = r.body.task.id
          return true
        }
        return false
      }, 15000)
    } catch (_e) {
      taskId = null
    }
    if (!check('task.enqueued', taskId !== null, '点击「缓存」后后端未出现任务')) return 1
    console.log(`[verify:no-blink] task #{taskId=${taskId}} enqueued (via UI button)`)

    // 任务 running 后开始采样（此时消息 1 已登记——T0 在字节之前，正是被测保证）
    await waitFor(async () => {
      const r = await httpJson('GET', `${MOCK_BASE}/api/tg/cache/tasks/${taskId}`)
      return r.body && (r.body.status === 'running' || r.body.status === 'done')
    }, 15000)
    console.log('[verify:no-blink] sampling started (200ms)')

    // ---- 6. CDP 200ms 采样 ----
    // 状态判定（单源派生后的 DOM 真实呈现；注意 tg.albumPartial 文案是
    // 「已缓存 n/N」，与终态「已缓存」必须区分）：
    //   caching    = 「缓存中 n/N」进度文案（或部分计数 n/N）；
    //   cached     = 状态行裸「已缓存」（无计数后缀）＝全组完成；
    //   registered = 气泡在但没有上述两者。
    // 库列表连续性：每拍同时拉 `/api/media/items`，断言 3 个 ref 一旦出现绝不消失。
    const RANK = { registered: 0, caching: 1, cached: 2 }
    const readAlbumState = () =>
      page.evaluate(() => {
        const grids = document.querySelectorAll('[data-testid="album-grid"]')
        if (grids.length === 0) return { present: false }
        const bubble = grids[0].closest('div.rounded-2xl') || grids[0].parentElement
        const text = bubble ? bubble.textContent || '' : ''
        // 计数正则必须 `\s+`（albumPartial 模板「已缓存 {n}/{total}」渲染自带空格）：
        // 终态状态行「已缓存」与日期 span 在 textContent 里无分隔拼接成
        // 「已缓存9/25 02:16」，`\s*` 会把日期 9/25 误当成计数 n/N（已踩坑）。
        const caching = /缓存中\s+\d+\/\d+/.test(text) || /Caching\s+\d+\/\d+/.test(text)
        const partial = /已缓存\s+\d+\/\d+/.test(text) || /Cached\s+\d+\/\d+/.test(text)
        const doneMark = text.includes('已缓存') || text.includes('Cached')
        const state = caching || partial ? 'caching' : doneMark ? 'cached' : 'registered'
        // 诊断字段：前端到 /api/tg/cache/tasks 的轮询是否活着、过渡窗快照是否发出
        const names = performance.getEntriesByType('resource').map((e) => e.name)
        return {
          present: true,
          state,
          diag: {
            text: text.replace(/\s+/g, ' ').trim().slice(-80),
            tasksReqN: names.filter((n) => n.includes('/api/tg/cache/tasks')).length,
            downloadedReqN: names.filter((n) => n.includes('/api/tg/downloaded')).length,
            visibility: document.visibilityState,
          },
        }
      })
    const samples = []
    let regressions = []
    let vanish = []
    let libraryVanish = []
    const firstSeen = {}
    const startedAt = Date.now()
    while (Date.now() - startedAt < SAMPLE_TIMEOUT_MS) {
      const dom = await readAlbumState()
      const lib = await httpJson('GET', `${MOCK_BASE}/api/media/items?limit=200`)
      const presentRefs = new Set(
        (lib.body && lib.body.items ? lib.body.items : []).map((it) => it.ref),
      )
      const t = Date.now() - startedAt
      samples.push({ t, ...dom, refs: REFS.filter((r) => presentRefs.has(r)).length })
      for (const ref of REFS) {
        if (presentRefs.has(ref)) {
          if (firstSeen[ref] === undefined) firstSeen[ref] = t
        } else if (firstSeen[ref] !== undefined) {
          libraryVanish.push({ t, ref })
        }
      }
      if (!dom.present) {
        vanish.push({ t })
      } else {
        const prev = samples.length > 1 ? samples[samples.length - 2] : null
        if (prev && prev.state && RANK[dom.state] < RANK[prev.state]) {
          regressions.push({ t, from: prev.state, to: dom.state })
        }
      }
      if (samples.length === 12) await page.screenshot(path.join(OUT_DIR, 'blink-1-during.png'))
      if (samples.length % 25 === 0) {
        console.log(
          `[verify:no-blink] t=${(t / 1000).toFixed(0)}s state=${dom.state} ` +
            `tasksReqN=${dom.diag.tasksReqN} dlReqN=${dom.diag.downloadedReqN} ` +
            `vis=${dom.diag.visibility} text=${JSON.stringify(dom.diag.text)}`,
        )
      }
      if (dom.state === 'cached' && Object.keys(firstSeen).length === REFS.length) {
        // 终态后再补 5 拍确认稳定（不回退、不消失）
        let stable = 0
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS))
          const s = await readAlbumState()
          if (!s.present || s.state !== 'cached') {
            regressions.push({ t: 'stability', state: s.state })
            break
          }
          stable++
        }
        check('state.stable.after.done', stable === 5, `stable=${stable}/5`)
        break
      }
      await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS))
    }
    await page.screenshot(path.join(OUT_DIR, 'blink-2-after.png'))

    // ---- 7. 断言 ----
    const sequence = samples.filter((s) => s.present).map((s) => s.state)
    console.log(
      `[verify:no-blink] samples=${samples.length} window=${samples.length * 200}ms\n` +
        `[verify:no-blink] sequence=${sequence.join(' -> ')}\n` +
        `[verify:no-blink] vanish(dom)=${vanish.length} vanish(library)=${libraryVanish.length} regressions=${regressions.length}`,
    )
    check('probe.samples.collected', samples.length >= 10, `samples=${samples.length}`)
    check('blink.album.continuously.visible', vanish.length === 0, `vanish=${JSON.stringify(vanish.slice(0, 3))}`)
    check(
      'blink.library.continuously.visible',
      libraryVanish.length === 0,
      `libraryVanish=${JSON.stringify(libraryVanish.slice(0, 3))}`,
    )
    check(
      'blink.library.all.present',
      Object.keys(firstSeen).length === REFS.length,
      `firstSeen=${JSON.stringify(firstSeen)}`,
    )
    check(
      'blink.state.monotone',
      regressions.length === 0,
      `regressions=${JSON.stringify(regressions.slice(0, 3))}`,
    )
    const reachedCaching = sequence.includes('caching')
    const reachedCached = sequence[sequence.length - 1] === 'cached'
    check('blink.state.reached.caching', reachedCaching, `sequence=${sequence.join(' -> ')}`)
    check('blink.state.reached.cached', reachedCached, `last=${sequence[sequence.length - 1]}`)

    const failed = results.filter((r) => !r.ok).length
    console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'}  (${results.length - failed} passed, ${failed} failed)`)
    console.log(`[verify:no-blink] artifacts: ${OUT_DIR}`)
    return failed === 0 ? 0 : 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch (_e) {}
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[verify:no-blink] fatal:', e)
    process.exit(2)
  })
