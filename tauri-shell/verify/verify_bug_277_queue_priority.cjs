#!/usr/bin/env node
'use strict'

/**
 * BUG-277 真实栈验收：入库流水线队列**可置顶**（优先级）。
 *
 * ## 缺陷回顾
 *
 * 队列顺序此前是写死的 `ORDER BY id ASC`：用户想让自己马上要看的那条**先下**，
 * 既不能置顶、也不能切换（「队列是死的」）。裁定 A：加 `priority` 列 + 原子端点
 * + 面板置顶按钮。置顶语义 = **当前任务跑完后下一个跑它**，**不是**抢占。
 *
 * ## 本脚本验什么
 *
 *   A 端点契约（HTTP，走产品 API）：置顶 = 后端算 max+1；批量一次请求；
 *     非法 body 一律 422；未知 id 404；越界 id 不动手也不报错。
 *   B 真实 UI（CDP）：置顶按钮只出现在排队/已置顶的行；点置顶 ⇒ 该行出现
 *     「已置顶」徽标且**渲染在队列前部**（DOM 顺序，不读 className）；
 *     取消置顶 ⇒ 回退；批量置顶**只发 1 个 POST**（fetch 计数）。
 *   C 不抢占 + 执行序：置顶期间当前 running 任务一字不动；当前任务跑完后
 *     **下一个跑的必是被置顶的那条**；它跑完后回到 FIFO（同优先级仍 id ASC）。
 *   D 截图 + 夹具清理 + 残留扫描。
 *
 * ## ⚠️ 硬约束
 *
 *   - 夹具一律走**产品 API**（`POST /api/tg/cache/tasks` 真入队），不写库、不写文件；
 *   - 验后 cancel + delete 夹具记录，再扫残留（与开始前基线比对，新增必须为 0）；
 *   - 不重启任何服务；端口运行时解析（默认走 `_lib_endpoints.cjs` 的 daemon 真源，
 *     `APP_URL`+`TG_URL` 同时给出时用于隔离栈）。
 *
 * 用法： node verify/verify_bug_277_queue_priority.cjs
 * Env:  APP_URL / TG_URL / DAEMON_URL / ORIG_VERIFY_SHOTS
 * Exit: 0 全通过；2 有判据失败；1 环境/通道问题。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

/** mock 频道（download-engine/crates/orig-tg/src/mock.rs 的 MOCK_CHAT_ID）。 */
const CHAT = -1009876543210
/** mock 登录码（同上：`MOCK_CODE`）。 */
const MOCK_CODE = '00000'

// 夹具消息号：与既有夹具（1..4 / 相册 1..10）不相交，避免撞到别的验收脚本的读数。
/**
 * 夹具消息号**每次运行都不同**。
 *
 * 为什么不能写死：worker 对「已缓存且文件存在」的条目幂等跳过，而夹具数据库
 * （隔离栈）在多次运行之间是同一份 —— 用同一批消息号再跑一次，任务会在**瞬间**
 * 完成，队列秒空，UI 段就没有任何 `queued` 行可点（表现为一批莫名其妙的 FAIL）。
 * 每次换号 ⇒ 每次都是真下载（mock ≈2.9s/条）。
 */
const RUN_TAG = Number(String(Date.now()).slice(-6))
/** 挡在队首的「慢」任务：20 条 × ≈2.9s/条 ≈ 60s，给 UI 段留出可操作窗口。 */
const BLOCKER_MSGS = Array.from({ length: 20 }, (_unused, i) => RUN_TAG * 100 + 1 + i)
/** 三条排队任务（入队顺序 = id 顺序）：A 最老、C 最新。 */
const QUEUED_MSGS = [RUN_TAG * 100 + 61, RUN_TAG * 100 + 62, RUN_TAG * 100 + 63]

/** 越界 id：后端视作「读不到」——不动手、不报错。 */
const GHOST_ID = 999999999

const SHOTS = path.resolve(
  process.env.ORIG_VERIFY_SHOTS || path.join(__dirname, 'evidence', 'BUG-277'),
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail, id = '') {
  checks.push({ name, pass: Boolean(pass), detail, id })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(pass)
}

/** 明确的环境/夹具不足 ⇒ 如实 SKIP（不伪造样本、不算通过）。 */
function skip(name, why, id = '') {
  checks.push({ name, pass: true, skipped: true, detail: why, id })
  console.log(`SKIP  ${name}  -> ${why}`)
}

// ─────────────────────────── HTTP（仅回环） ───────────────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 15000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

/**
 * 端点解析：默认走 `_lib_endpoints.cjs`（daemon `/api/config` 的 `tg_port` 真源，
 * 绝不硬编码端口）；隔离栈（APP_URL + TG_URL 同时给出）直接用给定值。
 */
async function resolveEndpoints() {
  const appOverride = process.env.APP_URL || process.env.ORIG_APP_API || ''
  const tgOverride = process.env.TG_URL || process.env.ORIG_TG_API || ''
  if (appOverride && tgOverride) {
    console.log(
      `[bug277] 使用显式端点（隔离栈）：app=${appOverride} tg=${tgOverride}`,
    )
    return {
      app: appOverride.replace(/\/+$/, ''),
      tg: tgOverride.replace(/\/+$/, ''),
      isolated: true,
    }
  }
  const ep = await endpoints.resolve()
  return { app: ep.app, tg: ep.tg, isolated: false }
}

/** 引擎是否已有 BUG-277 端点（未集成的旧构建 ⇒ 404 且无 JSON error）。 */
async function engineSupportsPriority(tg) {
  const r = await httpJson('POST', `${tg}/api/tg/cache/tasks/${GHOST_ID}/priority`, {
    priority: 0,
  })
  const supported =
    r.status === 404 && !!r.json && String(r.json.error || '').includes('cache task not found')
  return { supported, probe: `status=${r.status} body=${JSON.stringify(r.text).slice(0, 120)}` }
}

/**
 * 隔离栈专用：**最小 daemon 桩**（仅隔离模式启用）。
 *
 * 为什么需要它：侧边栏的 TG 入口与「入库流水线」按钮是否出现，判据是 daemon
 * `/api/config` 回答的 `tg_running`（BUG-178：进程在不在只由 daemon 回答）；
 * 而前端的 orig-tg 端口也是由同一份 config 的 `tg_port` 覆盖的。隔离栈没有真
 * daemon，于是要么入口整个不出现（无法做真实 UI 验收），要么端口被真 daemon
 * 改写回生产实例（那就会去动真实队列 —— 绝不允许）。
 *
 * 因此这里起一个只回答 `/api/config`（`plugins[]` 的 id="tg".port 指向本次的
 * 隔离引擎，BUG-423 新契约；旧键 tg_port 一并答上）与空列表的桩：它**不替代
 * 任何产品行为**，只是让壳走完它本来就有的那条「按 config 定位服务」的路径。
 * 生产/开发栈（有真 daemon）**不会**起它。
 */
function startStubDaemon(port, tgPort) {
  const server = http.createServer((req, res) => {
    const url = String(req.url || '')
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': 'application/json',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    // SSE：壳用 EventSource 订阅 daemon 事件。答成 JSON 会被浏览器直接断开
    // （MIME 不是 text/event-stream），界面整块不渲染 —— 那是桩没答对，不是本 BUG。
    if (url.startsWith('/api/events')) {
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const ping = setInterval(() => res.write(': keepalive\n\n'), 15000)
      req.on('close', () => clearInterval(ping))
      res.write(': connected\n\n')
      return
    }
    let body = '{}'
    if (url.startsWith('/api/config')) {
      body = JSON.stringify({
        port,
        // BUG-423：前端自 BUG-358 起只认 plugins[]（useStore 的
        // `tgServiceFromPlugins(cfg)` 按 id 取；没有 tg 插件 ⇒ tgService=null
        // ⇒ 侧栏 TG 入口与入库按钮整个不出现，真实 UI 验收直接做不了）。
        // 桩必须答新契约；旧键一并保留（双契约 readers 可用，成本为零）。
        plugins: [
          {
            id: 'tg',
            label: 'Telegram',
            enabled: true,
            running: true,
            port: tgPort,
            lastError: null,
            health: null,
          },
        ],
        tg_enabled: true,
        tg_running: true,
        tg_port: tgPort,
        tg_last_error: null,
        classify_enabled: false,
        classify_rules: {},
        download_dir: '/tmp',
        default_download_dir: '/tmp',
        max_connections: 8,
        proxy: { mode: 'direct', url: null },
        version: 'bug277-stub',
      })
    } else if (url.startsWith('/api/downloads')) {
      // 真 daemon 这里直接给数组；给对象会让壳在 `downloads.map` 上炸掉。
      body = JSON.stringify([])
    } else if (url.startsWith('/api/interfaces')) {
      body = JSON.stringify({ primary: null, secondaries: [] })
    }
    res.writeHead(200, cors)
    res.end(body)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function allTasks(tg) {
  const r = await httpJson('GET', `${tg}/api/tg/cache/tasks/all`)
  const list = (r.json && Array.isArray(r.json.tasks) && r.json.tasks) || []
  return list
}

function taskById(list, id) {
  return list.find((t) => t.id === id) || null
}

/** 队列（queued）按服务端呈现序的 id 列表。 */
function queuedIds(list) {
  return list.filter((t) => t.status === 'queued').map((t) => t.id)
}

// ─────────────────────────── DOM 判据 ───────────────────────────

/** 当前 DOM 里排队行的 id（按渲染顺序）。 */
async function domQueuedIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="cache-task-row"]')]
      .filter((r) => r.getAttribute('data-status') === 'queued')
      .map((r) => Number(r.getAttribute('data-task-id')))
      .filter((n) => Number.isFinite(n)),
  )
}

/** 单行快照：优先级、徽标、按钮。 */
async function domRow(page, id) {
  return page.evaluate((taskId) => {
    const row = document.querySelector(`[data-task-id="${taskId}"]`)
    if (!row) return null
    const has = (t) => !!row.querySelector(`[data-testid="${t}"]`)
    const txt = (t) => {
      const el = row.querySelector(`[data-testid="${t}"]`)
      return el ? String(el.textContent || '').trim() : null
    }
    return {
      status: row.getAttribute('data-status'),
      priority: Number(row.getAttribute('data-priority')),
      pinnedBadge: has('cache-task-pinned'),
      pinnedText: txt('cache-task-pinned'),
      pin: has('cache-task-pin'),
      unpin: has('cache-task-unpin'),
      cancel: has('cache-task-cancel'),
    }
  }, id)
}

/** 点某一行内的按钮（真实点击，不是改 state）。 */
async function clickRowButton(page, id, testid) {
  return page.evaluate(
    (taskId, tid) => {
      const row = document.querySelector(`[data-task-id="${taskId}"]`)
      if (!row) return { ok: false, why: 'row not found' }
      const btn = row.querySelector(`[data-testid="${tid}"]`)
      if (!btn) return { ok: false, why: `button ${tid} not found` }
      if (btn.disabled === true) return { ok: false, why: `button ${tid} is disabled` }
      btn.click()
      return { ok: true }
    },
    id,
    testid,
  )
}

/** 点某行的勾选框。 */
async function clickRowSelect(page, id) {
  return page.evaluate((taskId) => {
    const row = document.querySelector(`[data-task-id="${taskId}"]`)
    if (!row) return false
    const cb = row.querySelector('[data-testid="cache-select-row"]')
    if (!cb) return false
    cb.click()
    return true
  }, id)
}

/** 装 fetch 记录器：只数发往 `/priority` 的 POST（批量原子性的判据）。 */
async function installFetchRecorder(page) {
  await page.evaluate(() => {
    window.__prio = []
    if (window.__prioPatched) {
      window.__prio.length = 0
      return
    }
    window.__prioPatched = true
    const orig = window.fetch.bind(window)
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const method = String(((init && init.method) || (input && input.method) || 'GET')).toUpperCase()
        if (String(url).includes('/priority') && method === 'POST') {
          window.__prio.push({ url: String(url), body: (init && init.body) || '' })
        }
      } catch (_e) {
        /* 记录器本身不得影响请求 */
      }
      return orig(input, init)
    }
  })
}

async function readPosts(page) {
  return page.evaluate(() => (Array.isArray(window.__prio) ? window.__prio.slice() : []))
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    /* 产物缺失不影响判据 */
  }
  console.log(`[bug277] shot ${name} -> ${file} (${size} bytes)`)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const { app, tg, isolated } = await resolveEndpoints()
  console.log(`[bug277] app=${app} tg=${tg} shots=${SHOTS}`)

  // 隔离栈（mock）须先登录：mock tg 初始 Anonymous，/api/tg/start + /api/tg/code=00000 ⇒ Authorized。
  // 登录是**全局**会话（mock 模式单会话，已实测）：登录后夹具入队与壳层轮询均无需再带凭证。
  // 必须在造夹具与前端点亮界面**之前**完成，否则壳层首屏 / 队列面板会因未授权而不出现。
  if (isolated) {
    const st = await httpJson('POST', `${tg}/api/tg/start`, { phone: '+10000000000' })
    const cd = await httpJson('POST', `${tg}/api/tg/code`, { phone: '+10000000000', code: '00000' })
    if (cd.status !== 200 || !cd.json || cd.json.phase !== 'Authorized') {
      console.error(
        `[bug277] mock 登录失败：start=${st.status} code=${cd.status} ${JSON.stringify(cd.json)}`,
      )
      process.exit(1)
    }
    console.log('[bug277] mock 实例已登录（全局会话，Authorized）')
  }

  let stub = null
  if (isolated) {
    const stubPort = Number(process.env.BUG277_STUB_DAEMON_PORT || 19999)
    const tgPort = Number(new URL(tg).port || 80)
    stub = await startStubDaemon(stubPort, tgPort)
    console.log(`[bug277] 隔离栈 daemon 桩已起：http://127.0.0.1:${stubPort}（tg_port=${tgPort}）`)
  }

  const support = await engineSupportsPriority(tg)
  console.log(`[bug277] 引擎端点探测：${support.supported ? '支持' : '不支持'}（${support.probe}）`)

  /**
   * **先预热浏览器并打开面板，再造夹具**。
   *
   * 为什么顺序要反过来：本脚本的样本是**真实在跑的队列** —— 挡在队首的任务跑完，
   * 后面三条就不再是 `queued`（按钮随之消失），判据无从构成。而拉起 Chrome +
   * 首屏 + 导航实测要 20~30s，比一条任务的下载还慢。所以必须在夹具入队**之前**
   * 把界面停到「入库流水线」面板上，入队后只做几次点击。
   */
  let browser = null
  let page = null
  try {
    browser = await cdp.launch()
    page = await browser.newPage()
    await page.goto(app, { waitForRoot: true, settleMs: 1500 })
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-tg 入口不存在')
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
      { timeout: 30000 },
    )
    // 刻意**先不打开面板**：面板只在挂载时拉一次，之后靠 5s 轮询（且只在有活跃任务
    // 时才轮询）。预热时就打开的话，入队后它不会自己重拉 —— 那时界面还是空的。
    console.log('[bug277] 界面已预热到 TG 视图（面板待夹具入队后再开）')
  } catch (e) {
    console.error(`[bug277] 预热失败：${e && e.message ? e.message : e}`)
    if (browser) await browser.close().catch(() => undefined)
    process.exit(1)
  }

  /**
   * 夹具：真入队（产品 API）。挡在队首的任务有 20 条消息（mock 下载 ≈2.4s/条，
   * ≈60s），它跑着 ⇒ 后三条稳定停留在 `queued`。
   */
  const baseline = new Set((await allTasks(tg)).map((t) => t.id))
  const enqueue = async (messageIds) => {
    const r = await httpJson('POST', `${tg}/api/tg/cache/tasks`, { chatId: CHAT, messageIds })
    return r.json && r.json.id ? r.json : null
  }
  const blocker = await enqueue(BLOCKER_MSGS)
  if (!blocker) {
    console.error('[bug277] 环境未就绪：入队失败（未登录？端点不对？）')
    process.exit(1)
  }
  const q = []
  for (const m of QUEUED_MSGS) q.push(await enqueue([m]))
  if (q.some((t) => !t)) {
    console.error('[bug277] 夹具不足：排队任务入队失败')
    process.exit(1)
  }
  const [A, B, C] = q
  console.log(
    `[bug277] 夹具：blocker=${blocker.id}（${BLOCKER_MSGS.length} 条） queued=${A.id},${B.id},${C.id}`,
  )

  // 等 worker 真的开跑（blocker 进入 running），否则「不抢占」无从谈起。
  let blockerRunning = false
  for (let i = 0; i < 40; i++) {
    const t = taskById(await allTasks(tg), blocker.id)
    if (t && t.status === 'running') {
      blockerRunning = true
      break
    }
    await delay(250)
  }
  if (!blockerRunning) {
    console.error('[bug277] 夹具不足：队首任务没有进入 running')
    process.exit(1)
  }

  try {
    // ─────────────── A 段：端点契约 ───────────────
    if (!support.supported) {
      skip('A: 置顶端点契约（判据 1/3 的服务端半边）', `引擎未集成 BUG-277（${support.probe}）`, 'A')
    } else {
      // A1 单条置顶：数值由后端算（前端不猜）。
      const pinB = await httpJson('POST', `${tg}/api/tg/cache/tasks/${B.id}/priority`, { top: true })
      check(
        'A1: POST /api/tg/cache/tasks/:id/priority {top:true} ⇒ 200 且 priority ≥ 1',
        pinB.status === 200 &&
          pinB.json &&
          pinB.json.tasks &&
          pinB.json.tasks[0] &&
          pinB.json.tasks[0].priority >= 1,
        `status=${pinB.status} body=${JSON.stringify(pinB.json)}`,
        'A1',
      )
      // A2 呈现序与执行序同向：被置顶的那条排在队列前部。
      let list = await allTasks(tg)
      const prioB = taskById(list, B.id)?.priority ?? -1
      check(
        'A2: 置顶后 /tasks/all 里该任务 priority > 0 且排在 queued 前部',
        prioB > 0 && queuedIds(list)[0] === B.id,
        `priority=${prioB} queuedOrder=${JSON.stringify(queuedIds(list))}`,
        'A2',
      )
      // A3 批量：一个请求改多条，批内保持 FIFO（先入队的先跑）。
      const batch = await httpJson('POST', `${tg}/api/tg/cache/tasks/priority`, {
        ids: [C.id, A.id],
        top: true,
      })
      const map = {}
      for (const t of (batch.json && batch.json.tasks) || []) map[t.id] = t.priority
      check(
        'A3: 批量置顶一次请求改多条，且批内保持 FIFO（先入队的 priority 更大）',
        batch.status === 200 &&
          Object.keys(map).length === 2 &&
          map[A.id] > map[C.id] &&
          map[A.id] > prioB,
        `status=${batch.status} map=${JSON.stringify(map)} prioB=${prioB}`,
        'A3',
      )
      // A4 契约边界：非法 body 422 / 未知 id 404 / 越界 id 不动手。
      const bad = []
      for (const body of [{}, { priority: 1, top: true }, { top: false }, { priority: -1 }]) {
        const r = await httpJson('POST', `${tg}/api/tg/cache/tasks/${A.id}/priority`, body)
        bad.push(`${JSON.stringify(body)}→${r.status}`)
        if (r.status !== 422) bad.push(`!!${JSON.stringify(body)} 应为 422`)
      }
      const noIds = await httpJson('POST', `${tg}/api/tg/cache/tasks/priority`, { top: true })
      const ghost = await httpJson('POST', `${tg}/api/tg/cache/tasks/priority`, {
        ids: [GHOST_ID, A.id],
        priority: 0,
      })
      check(
        'A4: 非法 body 一律 422；未知 id 404；越界 id 不动手也不报错',
        !bad.some((s) => s.startsWith('!!')) &&
          noIds.status === 422 &&
          ghost.status === 200 &&
          (ghost.json.tasks || []).length === 1,
        `bodies=${bad.join(' ')} noIds=${noIds.status} ghost=${ghost.status}/${JSON.stringify(ghost.json)}`,
        'A4',
      )
      // 复位：全部取消置顶（回到 FIFO），B 段/C 段从这里出发。
      for (const id of [A.id, B.id, C.id]) {
        await httpJson('POST', `${tg}/api/tg/cache/tasks/${id}/priority`, { priority: 0 })
      }
    }

    // ─────────────── B/C 段：真实 UI（界面已预热，这里开面板后只做点击与读数） ───────────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tg-cache-manager-entry"]')
      if (el) el.click()
    })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-manager"]'), {
      timeout: 20000,
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="cache-task-row"]').length >= 4,
      { timeout: 30000 },
    )
    await delay(400)

    // B1 入口：置顶按钮只出现在「排队中」的行；已置顶的行给「取消置顶」。
    const rowA0 = await domRow(page, A.id)
    const rowBlocker0 = await domRow(page, blocker.id)
    check(
      'B1: 排队行有「置顶」入口，正在跑的行没有（置顶只对排队有意义）',
      Boolean(rowA0) && rowA0.pin === true && rowA0.unpin === false && rowA0.pinnedBadge === false,
      `rowA=${JSON.stringify(rowA0)}`,
      'B1',
    )
    check(
      'B1b: 正在跑的行不给置顶入口（不抢占：当前任务没有可重排的余地）',
      Boolean(rowBlocker0) && rowBlocker0.pin === false,
      `rowBlocker=${JSON.stringify(rowBlocker0)}`,
      'B1b',
    )
    await shot(page, '01-queue-before-pin.png')

    if (!support.supported) {
      skip('B2/B3: 置顶与取消置顶的真实渲染变化', `引擎未集成 BUG-277（${support.probe}）`, 'B')
      skip('B4: 批量置顶只发 1 个 POST', `引擎未集成 BUG-277（${support.probe}）`, 'B4')
      skip('C: 置顶后执行序与不抢占', `引擎未集成 BUG-277（${support.probe}）`, 'C')
    } else {
      // 置顶前：排队行的渲染顺序（同优先级 = 服务端呈现序）
      const before = await domQueuedIds(page)
      check(
        'B2-pre: 置顶前 B 不是队列首行（构成「置顶改变了顺序」的对照）',
        before.length >= 3 && before[0] !== B.id,
        `queuedDomOrder=${JSON.stringify(before)} B=${B.id}`,
        'B2-pre',
      )

      // B2 点置顶（B 是三条里的中间那条：既不是队首也不是队尾）
      const clicked = await clickRowButton(page, B.id, 'cache-task-pin')
      check('B2a: 置顶按钮可点（真实点击，非改 state）', clicked.ok === true, JSON.stringify(clicked), 'B2a')
      await page
        .waitForFunction(
          (id) => {
            const el = document.querySelector(`[data-task-id="${id}"]`)
            return !!el && Number(el.getAttribute('data-priority')) > 0
          },
          { timeout: 15000 },
          B.id,
        )
        .catch(() => undefined)
      await delay(600)
      const rowB1 = await domRow(page, B.id)
      const afterPin = await domQueuedIds(page)
      check(
        'B2: 置顶后该行出现「已置顶」徽标且 priority > 0（DOM 读数，不读 className）',
        Boolean(rowB1) && rowB1.pinnedBadge === true && rowB1.priority > 0 && rowB1.unpin === true,
        `rowB=${JSON.stringify(rowB1)}`,
        'B2',
      )
      check(
        'B2b: 置顶后该行**渲染在队列前部**（DOM 顺序可核：它是 queued 行里的第一条）',
        afterPin.length >= 3 && afterPin[0] === B.id,
        `before=${JSON.stringify(before)} after=${JSON.stringify(afterPin)}`,
        'B2b',
      )
      await shot(page, '02-after-pin.png')

      // C1 不抢占：**就在置顶生效的这一刻**验（队列是真实在动的，拖到后面验就
      // 变成「当前任务已经跑完、自然换了一条」，那条断言就什么都没证明）。
      const cur1 = await httpJson('GET', `${tg}/api/tg/cache/tasks`)
      const t1 = cur1.json && cur1.json.task
      check(
        'C1: 置顶不抢占 —— 置顶生效时当前任务仍是那条 running（id/状态都不变）',
        Boolean(t1) && t1.id === blocker.id && t1.status === 'running',
        `current=${JSON.stringify({ id: t1 && t1.id, status: t1 && t1.status })} blocker=${blocker.id}`,
        'C1',
      )
      const counts1 = (await httpJson('GET', `${tg}/api/tg/cache/tasks/all`)).json?.counts || {}
      check(
        'C1b: 单飞契约不回退 —— running 计数 === 1',
        Number(counts1.running || 0) === 1,
        `counts=${JSON.stringify(counts1)}`,
        'C1b',
      )

      // B3 取消置顶 ⇒ 回退
      const clickedUnpin = await clickRowButton(page, B.id, 'cache-task-unpin')
      check('B3a: 取消置顶按钮可点', clickedUnpin.ok === true, JSON.stringify(clickedUnpin), 'B3a')
      await page
        .waitForFunction(
          (id) => {
            const el = document.querySelector(`[data-task-id="${id}"]`)
            return !!el && Number(el.getAttribute('data-priority')) === 0
          },
          { timeout: 15000 },
          B.id,
        )
        .catch(() => undefined)
      await delay(600)
      const rowB2 = await domRow(page, B.id)
      const afterUnpin = await domQueuedIds(page)
      check(
        'B3: 取消置顶后徽标消失、priority 归零、渲染顺序回退',
        Boolean(rowB2) &&
          rowB2.pinnedBadge === false &&
          rowB2.priority === 0 &&
          rowB2.pin === true &&
          JSON.stringify(afterUnpin) === JSON.stringify(before),
        `rowB=${JSON.stringify(rowB2)} before=${JSON.stringify(before)} after=${JSON.stringify(afterUnpin)}`,
        'B3',
      )
      await shot(page, '03-after-unpin.png')

      // B4 批量：勾选 2 条 → 一次请求（fetch 计数）
      await installFetchRecorder(page)
      await clickRowSelect(page, A.id)
      await clickRowSelect(page, C.id)
      await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-batch-bar"]'), {
        timeout: 10000,
      })
      await delay(400)
      await shot(page, '04-batch-bar.png')
      const batchBtn = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="cache-batch-pin"]')
        if (!el) return null
        return { text: String(el.textContent || '').trim(), disabled: el.disabled === true }
      })
      check(
        'B4a: 批量动作条出现「置顶」入口且可用',
        Boolean(batchBtn) && batchBtn.disabled === false,
        `btn=${JSON.stringify(batchBtn)}`,
        'B4a',
      )
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="cache-batch-pin"]')
        if (el) el.click()
      })
      await delay(1200)
      const posts = await readPosts(page)
      let bodyIds = []
      try {
        bodyIds = posts.length ? JSON.parse(posts[0].body).ids || [] : []
      } catch (_e) {
        bodyIds = []
      }
      check(
        'B4: 批量置顶**只发 1 个 POST**（不是逐条循环）且 body 含 2 个 id',
        posts.length === 1 && bodyIds.length === 2,
        `posts=${posts.length} urls=${JSON.stringify(posts.map((p) => p.url))} ids=${JSON.stringify(bodyIds)}`,
        'B4',
      )
      const prioAfterBatch = await (async () => {
        const list = await allTasks(tg)
        return { A: taskById(list, A.id)?.priority, C: taskById(list, C.id)?.priority }
      })()
      check(
        'B4b: 批量置顶真的生效，且批内保持 FIFO（先入队的 priority 更大）',
        prioAfterBatch.A > 0 && prioAfterBatch.C > 0 && prioAfterBatch.A > prioAfterBatch.C,
        `priority=${JSON.stringify(prioAfterBatch)}`,
        'B4b',
      )
      // 批量取消置顶：同样只发 1 个 POST
      await installFetchRecorder(page)
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="cache-batch-unpin"]')
        if (el) el.click()
      })
      await delay(1200)
      const posts2 = await readPosts(page)
      check(
        'B4c: 批量取消置顶同样只发 1 个 POST',
        posts2.length === 1,
        `posts=${posts2.length} urls=${JSON.stringify(posts2.map((p) => p.url))}`,
        'B4c',
      )
      // 取消勾选，回到干净状态
      await clickRowSelect(page, A.id)
      await clickRowSelect(page, C.id)

      // ───────── C 段：不抢占 + 执行序 ─────────
      // 重新置顶 B（中间那条：FIFO 下它本不该是下一个），然后等当前任务跑完。
      await clickRowButton(page, B.id, 'cache-task-pin')
      await page
        .waitForFunction(
          (id) => {
            const el = document.querySelector(`[data-task-id="${id}"]`)
            return !!el && Number(el.getAttribute('data-priority')) > 0
          },
          { timeout: 15000 },
          B.id,
        )
        .catch(() => undefined)

      // C2 执行序：当前任务跑完后，下一个跑的**必须是被置顶的那条**。
      // 观察窗口 = 挡在队首的 16 条消息跑完（≈38s）。
      const observed = await waitForNextRunning(tg, blocker.id, [A.id, B.id, C.id], 150000)
      check(
        'C2: 当前任务跑完后，下一个跑的**必是被置顶的那条**（判据 1 的真实栈形态）',
        observed.next === B.id,
        `next=${observed.next}（期望被置顶的 ${B.id}）序列=${JSON.stringify(observed.sequence)}`,
        'C2',
      )
      await shot(page, '05-pinned-runs-next.png')

      // C3 同优先级仍 FIFO：B 跑完后，剩下的 A(最先入队) 应先于 C。
      const observed2 = observed.next
        ? await waitForNextRunning(tg, observed.next, [A.id, C.id], 60000)
        : { next: null, sequence: [] }
      check(
        'C3: 被置顶的跑完后回到 FIFO（同优先级仍先入先出）',
        observed2.next === A.id,
        `next=${observed2.next}（期望 A=${A.id}）序列=${JSON.stringify(observed2.sequence)}`,
        'C3',
      )
    }
  } catch (e) {
    console.error(`[bug277] 通道/脚本异常：${e && e.stack ? e.stack : e}`)
    checks.push({ name: '通道异常', pass: false, detail: String((e && e.message) || e) })
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch (_e) {
        /* 关闭失败不影响判据 */
      }
    }
  }

  // ─────────────── D 段：夹具清理 + 残留扫描 ───────────────
  const fixtureIds = [blocker.id, A.id, B.id, C.id]
  const cancelRes = await httpJson(
    'POST',
    `${tg}/api/cache/tasks/cancel?ids=${encodeURIComponent(fixtureIds.join(','))}`,
  )
  const delRes = await httpJson(
    'DELETE',
    `${tg}/api/cache/tasks?ids=${encodeURIComponent(fixtureIds.join(','))}`,
  )
  console.log(
    `[bug277] 夹具清理：cancel=${cancelRes.status} delete=${delRes.status} removed=${delRes.json && delRes.json.removed}`,
  )
  await delay(800)
  const after = await allTasks(tg)
  const residue = after.filter((t) => fixtureIds.includes(t.id) || !baseline.has(t.id))
  check(
    'D: 夹具清理后残留为 0（与开始前基线比对）',
    residue.length === 0,
    `residue=${JSON.stringify(residue.map((t) => ({ id: t.id, status: t.status })))}`,
    'D',
  )

  if (stub) {
    try {
      stub.close()
    } catch (_e) {
      /* 桩关闭失败不影响判据 */
    }
  }

  const failed = checks.filter((c) => !c.pass)
  const skipped = checks.filter((c) => c.skipped)
  console.log(
    `\n[bug277] 汇总：${checks.length - failed.length - skipped.length}/${checks.length - skipped.length} 通过` +
      `（SKIP ${skipped.length}，FAIL ${failed.length}）`,
  )
  if (failed.length > 0) {
    console.error(`[bug277] FAILED: ${failed.map((f) => f.id || f.name).join(', ')}`)
    process.exitCode = 2
  }
}

/**
 * 等 `fromId` 这条任务离开 running，记录**下一条进入 running 的是谁**。
 *
 * 每 300ms 采一次（任务一旦终态，单飞 worker 立刻接续；采样间隔远小于一条
 * 2.4s 的下载时长，不会漏掉中间态）。
 */
async function waitForNextRunning(tg, fromId, candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const sequence = []
  let lastRunning = fromId
  let left = false
  while (Date.now() < deadline) {
    const list = await allTasks(tg)
    const running = list.filter((t) => t.status === 'running').map((t) => t.id)
    for (const id of running) {
      if (!sequence.includes(id)) sequence.push(id)
    }
    const from = list.find((t) => t.id === fromId)
    if (from && from.status !== 'running' && from.status !== 'queued') left = true
    const next = running.find((id) => id !== fromId && candidates.includes(id))
    if (left && next !== undefined) return { next, sequence }
    await delay(300)
  }
  return { next: lastRunning, sequence }
}

main().catch((e) => {
  console.error(`[bug277] 未捕获异常：${e && e.stack ? e.stack : e}`)
  process.exitCode = 1
})
