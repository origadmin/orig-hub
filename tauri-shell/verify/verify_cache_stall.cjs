#!/usr/bin/env node
'use strict'

/**
 * 性能验收：**「缓存中卡顿」是否与 TgPanel 每 5s 的重渲染节拍对齐**。
 *
 * ## 背景（已被两路取证锁定，本脚本只做决定性测量）
 *
 * 用户报：「缓存中，每次缓存进度更新时必然会卡顿一会」。
 *
 *   - 服务端已排除：`GET /api/tg/cache/tasks` 是**纯内存 Arc 克隆**（0 条 SQL），
 *     `serve_local_file` 全程 `.await` 让出、无长同步循环 ⇒ 后端**不存在任何 5s 周期阻塞源**。
 *   - 5s 时钟只能来自客户端：`TgPanel.tsx:800` 每 5s `refreshCacheTasks()` → `:777`
 *     把 `itemBytes` 编进签名 ⇒ 长条目每 5s 必变 ⇒ `:781-782` 必然 `setState` ⇒
 *     **TgPanel 整树重渲染**。放大器：`:286` 用 `useStore()` **不带 selector**、feed
 *     **无虚拟化无上限**。
 *   - 播放器不在该子树（`MainLayout.tsx:198-209` 的 MediaViewer 覆盖层 与 `:259-262`
 *     的 TgPanel 是**兄弟**）⇒ 卡顿只可能来自**主线程被占**（React 重渲染 → 长任务 →
 *     `<video>` 帧呈现被推迟），而非播放器自身重渲染。
 *   - **全仓没有任何 longtask 观测**（`PerformanceObserver`/`longtask` 零命中）
 *     ⇒ 「主线程被阻塞多久」**从未被测过**。这就是本脚本要补的决定性测量。
 *
 * ## 本脚本做什么
 *
 *   1. 打开 5180 → 进 TG 面板（**确保 TgPanel 挂载**，其 5s 轮询才会跑）→
 *      用 store 打开**长条目 607**（H.264 30fps、337s；472 是 60fps HEVC 解码不稳，会污染结论）。
 *      > 注：`view` 是 MainLayout 局部 state；切到媒体库视图会**卸载** TgPanel，5s 轮询随之停止。
 *      > 故「播放长条目」通过 `store.openViewer`（MediaViewer 覆盖层，与 TgPanel 是兄弟）实现，
 *      > 保持 view 停在 `tg`，让 TgPanel 与播放器**同时在场** —— 这正是要复现的争用场景。
 *   2. 装 `PerformanceObserver({ entryTypes: ['longtask'] })`，记录每次 longtask 的
 *      `startTime` / `duration`（**本测核心指标**）。
 *   3. 同时采：`video.requestVideoFrameCallback` 间隔序列、`getVideoPlaybackQuality()`、
 *      `buffered.end(last) - currentTime`、`video.currentSrc`。
 *   4. 测 **3 种条件（每个 ≥60s）**：
 *      - **A 基线**：无活跃缓存任务（库内空闲）。
 *      - **B 缓存中**：库内**存在活跃缓存任务**（**只用既有任务，绝不新建下载、不改用户数据**）。
 *      - **C 缓存中 + 缓存管理面板打开**（面板自轮 `tasks/all` 每 5s，用于区分服务端贡献）。
 *   5. **对齐判定（双判据）**：
 *      - 盲判据：把 longtask `startTime` 按 `t mod 5000ms` 折叠成 20 个 250ms 桶的直方图。
 *        **明显聚集于某相位 ⇒ 与 5s 节拍对齐**；**均匀分布 ⇒ 与 5s 无关**。
 *      - **决定性判据（poll-anchored）**：给 `window.fetch` 打桩（**验收侧插桩，非产品代码**）
 *        记录每次 `GET /api/tg/cache/tasks*` 的**真实发起时刻**（即 TgPanel 5s `setInterval` 的
 *        真实刻度，不受挂载相位未知影响）；统计 longtask 是否**紧随轮询之后**（≤ALIGN_WINDOW_MS）。
 *        多数紧随 ⇒ 对齐（前端成因）；弥散/无关 ⇒ 转后端 I/O 争抢。
 *   5b. **混杂控制**：读 store 的 daemon/orig-core 下载活跃数。**「纯 TG 缓存」要求其为 0** ——
 *       500ms 级 SSE 仅来自 orig-core 下载引擎（非 Range），是 5s 之外的第二个周期源，必须排除。
 *       决定性条件 = **B（缓存中 + 面板关）**：此时 5s 时钟唯一来自 `TgPanel:800 → :777 → :781`。
 *   6. 把「长任务」与「掉帧」直接关联：每个 longtask 覆盖区间内是否存在 rVFC 间隔缺口（>50ms）。
 *   7. **网络维度（连接池争抢假设）**：CDP `Network` 域记录播放窗口内所有到 TG origin 的请求
 *      （`requestWillBeSent` → `loadingFinished`/`loadingFailed`），算「最大并发在途」与
 *      「5s 轮询后并发」，并特别标记 **feed 抽帧请求**（`/api/media/items/<id>/(raw|stream)`
 *      且**非**播放条目）。判据：feed 抽帧 + 并发顶到 6，或 5s 轮询后并发 ≥6 ⇒ **支持**争抢；
 *      到该 origin 仅播放器请求在途 ⇒ **否掉**。
 *
 * ## 用法
 *
 *   先起开发态服务（daemon + orig-tg 19787 + vite dev 5180），再：
 *     node verify/verify_cache_stall.cjs
 *   环境变量：APP_PORT / TG_URL / ORIG_VERIFY_OUT / PROBE_ITEM / STALL_WINDOW_SEC。
 *
 *   **headful**：本脚本用 `cdp.launch({ headless: false })` —— 次判据 `droppedPct`/`presentedFps`/rVFC
 *   需要真实 GPU 合成（headless 会把 rAF/rVFC 钉在 ~60Hz 而失真）；主判据（longtask + poll-anchored
 *   5s 对齐）两态皆有效。启动后**打印一次 UA 并写入产物**自证（判据 = UA **不含** `HeadlessChrome`；
 *   `navigator.gpu` 在 about:blank 下恒为 no-gpu-api，无区分力）。**串行、单浏览器，测完必须关闭。**
 *
 * 产物：`tauri-shell/verify_shots/cache_stall/`（截图 + JSON + Markdown 表）。
 * 退出码：0 = 跑完；1 = 脚本自身/页面异常；2 = 环境不可达。
 *
 * **只读**：仅打开播放器并播放；不新建/取消缓存任务，不写后端（localStorage 的兼容流记忆属客户端）。
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
/** TG origin（媒体/缩略图/缓存任务请求的共同源）—— 连接池争抢分析的作用域。 */
let TG_ORIGIN = TG
try {
  TG_ORIGIN = new URL(TG).origin
} catch (_e) {
  /* 保留原值 */
}
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', 'verify_shots', 'cache_stall'),
)
/** 长条目夹具：607 = H.264 Main 480x852 30fps、时长 337s（可解码，走 /raw）。 */
const ITEM = Number(process.env.PROBE_ITEM || 607)
/** 每个条件的采样窗口（秒）——要求 ≥60s。 */
const WINDOW_SEC = Number(process.env.STALL_WINDOW_SEC || 60)
/** 5s 节拍对齐直方图：桶宽与桶数（20 × 250ms = 5000ms）。 */
const BUCKET_MS = 250
const BUCKET_COUNT = 20
/** rVFC 间隔 > 该值视为「掉帧缺口」（对齐 60Hz 下 >3 帧的缺口）。 */
const GAP_MS = 50
/** longtask 落在轮询后 ≤ 该窗内即视为「紧随 5s 节拍」（poll-anchored 判据）。 */
const ALIGN_WINDOW_MS = 800

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 环境探活（loopback，不查代理；失败即 exit 2，不重试、不等待）
// ---------------------------------------------------------------------------

/**
 * GET 一个 URL 的状态码（loopback，超时即失败）。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<number>} HTTP 状态码；不可达返回 0
 */
function httpStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      done(res.statusCode || 0)
    })
    req.on('error', () => done(0))
    req.on('timeout', () => {
      req.destroy()
      done(0)
    })
  })
}

// ---------------------------------------------------------------------------
// 页面内探针（安装一次、持久存在；避免超长 evaluate 命中 CDP 30s 命令超时）
// ---------------------------------------------------------------------------

/**
 * 安装页面内持久探针 `window.__stall`：
 *   - `install()`：幂等安装 longtask PerformanceObserver（累积到 `lt`）。
 *   - `startRvfc(v)` / `stopRvfc(v)`：开始/结束 rVFC 采集（时间戳与 longtask 同时间轴）。
 *   - `snapshot()`：读取缓冲/质量/当前 src 等快照。
 */
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__stall && window.__stall.__v === 1) return true
    const S = {
      __v: 1,
      lt: [],
      ltErr: null,
      obs: null,
      rvfc: [],
      rvfcHandle: null,
      /**
       * 5s 轮询「真时钟」锚点（本测的对齐基准）。
       *
       * 盲用 `startTime mod 5000` 只是假设存在一条全局 5s 网格；但 TgPanel 的
       * `setInterval` 是在**挂载时**启动的，其相位相对 `performance.now()` 原点未知。
       * 直接给 `window.fetch` 打桩（**验收侧插桩，非产品代码**）记录每次
       * `GET /api/tg/cache/tasks`（含面板的 `/tasks/all`）的发起时刻，才是 5s 节拍的
       * 真实刻度 —— longtask 是否紧随这些刻度之后，就是「是否与 5s 重渲染对齐」的决定性判据。
       */
      polls: [],
      _fetchPatched: false,
      patchFetch() {
        if (this._fetchPatched) return
        this._fetchPatched = true
        const self = this
        const orig = window.fetch ? window.fetch.bind(window) : null
        if (!orig) return
        window.fetch = function (input, init) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            if (url.includes('/api/tg/cache/tasks')) {
              self.polls.push({
                t: performance.now(),
                kind: url.includes('/tasks/all') ? 'all' : 'tasks',
              })
            }
          } catch (_e) {
            /* ignore */
          }
          return orig(input, init)
        }
      },
      install() {
        this.patchFetch()
        if (this.obs) return
        try {
          this.obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              this.lt.push({ start: e.startTime, dur: e.duration, name: e.name })
            }
          })
          this.obs.observe({ entryTypes: ['longtask'] })
        } catch (e) {
          this.ltErr = String(e && e.message ? e.message : e)
        }
      },
      startRvfc(v) {
        this.rvfc = []
        this.rvfcHandle = null
        if (!v || typeof v.requestVideoFrameCallback !== 'function') return false
        const cb = (now) => {
          this.rvfc.push(now)
          this.rvfcHandle = v.requestVideoFrameCallback(cb)
        }
        this.rvfcHandle = v.requestVideoFrameCallback(cb)
        return true
      },
      stopRvfc(v) {
        if (this.rvfcHandle != null && v && typeof v.cancelVideoFrameCallback === 'function') {
          try {
            v.cancelVideoFrameCallback(this.rvfcHandle)
          } catch (_e) {
            /* ignore */
          }
        }
        this.rvfcHandle = null
        return this.rvfc.slice()
      },
      snapshot() {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return { hasVideo: false }
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
        const b = v.buffered
        let ahead = null
        if (b && b.length) ahead = b.end(b.length - 1) - v.currentTime
        const src = String(v.currentSrc || v.src || '')
        return {
          hasVideo: true,
          src,
          path: src.includes('/stream') ? 'stream' : src.includes('/raw') ? 'raw' : 'other',
          vw: v.videoWidth,
          vh: v.videoHeight,
          currentTime: v.currentTime,
          readyState: v.readyState,
          networkState: v.networkState,
          paused: v.paused,
          playbackRate: v.playbackRate,
          ahead,
          frames: q ? q.totalVideoFrames : null,
          dropped: q ? q.droppedVideoFrames : null,
        }
      },
    }
    S.install()
    window.__stall = S
    return true
  })
}

// ---------------------------------------------------------------------------
// 导航 / 打开条目
// ---------------------------------------------------------------------------

/**
 * 进入 TG 面板（点侧栏 `nav-tg`），确保 TgPanel 挂载（其 5s 轮询才会跑）。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function enterTgPanel(page) {
  const present = await page.evaluate(() =>
    !!document.querySelector('[data-testid="nav-tg"]'),
  )
  if (!present) {
    return {
      ok: false,
      reason: 'nav-tg 不在场（TG 特性未就绪）⇒ 无法挂载 TgPanel，5s 轮询不会跑',
    }
  }
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="nav-tg"]')
    if (btn) btn.click()
  })
  // TgPanel 挂载信号：缓存管理入口 / 面板根节点出现
  const mounted = await page
    .waitForFunction(
      () => {
        // TgPanel 挂载后必然渲染出「频道/媒体」双栏骨架；用 media-viewer 之外的稳定锚点判定。
        // 这里用面板内的缓存管理按钮或 feed 容器存在来判定，二者任一即可。
        return (
          !!document.querySelector('[data-testid="tg-cache-manager-open"]') ||
          !!document.querySelector('[data-testid="cache-manager"]') ||
          document.body.innerText.includes('缓存管理') ||
          !!document.querySelector('[data-testid="nav-tg"][aria-current="page"]')
        )
      },
      { timeout: 15000, intervalMs: 250 },
    )
    .then(() => true)
    .catch(() => false)
  return { ok: mounted, reason: mounted ? undefined : 'TgPanel 挂载信号超时' }
}

/**
 * 通过 store 打开长条目（MediaViewer 覆盖层；与 TgPanel 是兄弟，view 保持 tg）。
 * @param {object} page CDP Page
 * @param {number} item 条目 id
 */
async function openItem(page, item) {
  const src = `${TG}/api/media/items/${item}/raw`
  await page.evaluate(
    (url, it) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${it}`,
            chatId: 0,
            messageId: it,
            kind: 'video',
            caption: '',
            description: null,
            src: url,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: '',
      })
    },
    src,
    item,
  )
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="media-viewer"] video'),
    { timeout: 15000, intervalMs: 200 },
  )
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      v.play().catch(() => {})
    }
  })
}

/** 等待视频出帧（readyState≥2 且有尺寸），失败不致命。 */
async function waitFramed(page, timeoutMs = 90000) {
  return page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        return !!v && v.videoWidth > 0 && v.readyState >= 2
      },
      { timeout: timeoutMs, intervalMs: 250 },
    )
    .then(() => true)
    .catch(() => false)
}

// ---------------------------------------------------------------------------
// 活跃缓存任务探测（只读；用既有任务，绝不新建）
// ---------------------------------------------------------------------------

/**
 * 从页面内 GET /api/tg/cache/tasks，判定库内是否存在**活跃**缓存任务。
 * @returns {Promise<{ok:boolean, active:boolean, status?:string|null, task?:object|null, err?:string}>}
 */
async function probeActiveTask(page) {
  return page.evaluate(async (tg) => {
    try {
      const r = await fetch(`${tg}/api/tg/cache/tasks`, { mode: 'cors' })
      if (!r.ok) return { ok: false, active: false, err: `HTTP ${r.status}` }
      const j = await r.json()
      const task = j && j.task ? j.task : null
      const status = task ? String(task.status || '') : null
      const active = status === 'running' || status === 'queued'
      return { ok: true, active, status, task }
    } catch (e) {
      return { ok: false, active: false, err: String(e && e.message ? e.message : e) }
    }
  }, TG)
}

// ---------------------------------------------------------------------------
// CDP Network 域采集：连接池争抢假设的决定性网络维度
// ---------------------------------------------------------------------------

/**
 * 建一个到 TG origin 的请求采集器（CDP `Network` 域）。
 *
 * 目的：验证「同源连接池争抢（HTTP/1.1 每源 6 连接）」假设 ——
 * 播放器请求、feed 抽帧请求、5s 轮询是否**同时在途**并顶到 6 连接上限。
 *
 * 记录每个请求的 `requestWillBeSent`（tStart）→ `loadingFinished`/`loadingFailed`（tEnd），
 * 均为 CDP 单调时间戳（秒，同一轴）—— 因此 5s 相位可直接用**轮询请求自身**的 tStart 作锚，
 * 无需与 `performance.now` 轴换算。
 * @param {object} page CDP Page
 * @param {string} tgOrigin TG origin（如 http://127.0.0.1:19787）
 * @returns {{enable:Function, reset:Function, snapshot:Function}}
 */
function createNetworkCollector(page, tgOrigin) {
  /** @type {Map<string, object>} 在途请求 */
  const inflight = new Map()
  /** @type {Array<object>} 已结束请求 */
  let records = []

  page.conn.on('Network.requestWillBeSent', (p) => {
    const url = String((p && p.request && p.request.url) || '')
    inflight.set(String(p.requestId), {
      id: String(p.requestId),
      url,
      method: String((p && p.request && p.request.method) || 'GET'),
      type: String((p && p.type) || ''),
      tStart: Number(p.timestamp || 0),
      tEnd: null,
      status: null,
      fromCache: false,
      failed: false,
    })
  })
  const settle = (requestId, patch) => {
    const rec = inflight.get(String(requestId))
    if (!rec) return
    Object.assign(rec, patch)
    inflight.delete(String(requestId))
    records.push(rec)
  }
  page.conn.on('Network.responseReceived', (p) => {
    const rec = inflight.get(String(p.requestId))
    if (!rec) return
    const resp = p.response || {}
    rec.status = resp.status == null ? null : resp.status
    rec.fromCache = Boolean(resp.fromDiskCache || resp.fromServiceWorker)
  })
  page.conn.on('Network.loadingFinished', (p) => {
    settle(p.requestId, { tEnd: Number(p.timestamp || 0) })
  })
  page.conn.on('Network.loadingFailed', (p) => {
    settle(p.requestId, { tEnd: Number(p.timestamp || 0), failed: true })
  })

  return {
    async enable() {
      await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    },
    reset() {
      records = []
      inflight.clear()
    },
    snapshot() {
      // 把窗口结束时仍在途的请求也纳入（tEnd 用当前最大已见时间近似）。
      const nowTs = records.reduce((a, r) => Math.max(a, r.tEnd || 0), 0)
      const open = [...inflight.values()].map((r) => ({ ...r, tEnd: r.tEnd == null ? nowTs : r.tEnd }))
      const all = records.concat(open).filter((r) => r.url.startsWith(tgOrigin))
      return { tgOrigin, requests: all, totalSeen: records.length + open.length }
    },
  }
}

/** 在给定时刻 t 的在途数（timeline 为 sweep 后的累积序列）。 */
function inflightCountAt(timeline, t) {
  let c = 0
  for (const e of timeline) {
    if (e.t <= t) c = e.c
    else break
  }
  return c
}

/**
 * 连接池争抢分析：最大并发 / 5s 相位尖峰 / 播放器与 feed 抽帧请求并存情况。
 * @param {object} net createNetworkCollector().snapshot() 结果
 * @param {number} playingItem 正在播放的条目 id
 * @returns {object}
 */
function concurrencyAnalysis(net, playingItem) {
  const reqs = (net && net.requests) || []
  const events = []
  for (const r of reqs) {
    const s = Number(r.tStart || 0)
    const e = r.tEnd != null && r.tEnd > s ? r.tEnd : s + 0.001
    events.push({ t: s, d: 1 })
    events.push({ t: e, d: -1 })
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d)
  const timeline = []
  let cur = 0
  let max = 0
  for (const ev of events) {
    cur += ev.d
    if (cur > max) max = cur
    timeline.push({ t: ev.t, c: cur })
  }

  const polls = reqs.filter((r) => r.url.includes('/api/tg/cache/tasks'))
  const pollTs = polls.map((r) => r.tStart).sort((a, b) => a - b)
  // 5s 相位尖峰：每个轮询后 1s 内的最大在途数
  const afterPoll = pollTs.map((p) => {
    let m = inflightCountAt(timeline, p)
    for (const ev of timeline) {
      if (ev.t > p && ev.t <= p + 1) m = Math.max(m, ev.c)
    }
    return m
  })

  // 是否 /api/media/items/<id>/(raw|stream)（用字符串匹配，避免正则字面量解析歧义）
  const isMediaItemsStream = (url) =>
    url.includes('/api/media/items/') && (url.includes('/raw') || url.includes('/stream'))
  const playerReqs = reqs.filter(
    (r) =>
      isMediaItemsStream(r.url) ||
      r.url.includes('/api/tg/local/') ||
      r.url.includes('/api/tg/file/'),
  )
  const playerRaw = reqs.filter((r) => r.url.includes(`/api/media/items/${playingItem}/raw`))
  // feed 抽帧请求：/api/media/items/<id>/(raw|stream) 且**不是**正在播放的条目
  const feedPoster = reqs.filter(
    (r) =>
      isMediaItemsStream(r.url) &&
      !r.url.includes(`/api/media/items/${playingItem}/`),
  )
  const thumbs = reqs.filter((r) => r.url.includes('/api/tg/thumb/'))

  return {
    tgRequestCount: reqs.length,
    maxConcurrent: max,
    pollRequestCount: polls.length,
    playerRequestCount: playerReqs.length,
    playerRawCount: playerRaw.length,
    feedPosterRequestCount: feedPoster.length,
    thumbRequestCount: thumbs.length,
    maxConcurrentAfterPoll: afterPoll.length ? Math.max(...afterPoll) : 0,
    sampleUrls: reqs.slice(0, 12).map((r) => r.url.replace(net.tgOrigin, '')),
  }
}

/**
 * 连接池争抢判据。
 *   - feed 抽帧请求存在且并发顶到 6 ⇒ 支持争抢。
 *   - 5s 轮询后并发在途 ≥6 ⇒ 支持 5s 相位尖峰。
 *   - 到该 origin 仅播放器请求在途、无 feed 抽帧 ⇒ **否掉**。
 * @param {object} c concurrencyAnalysis 结果
 * @returns {{verdict:'support'|'reject'|'inconclusive', reason:string}}
 */
function networkVerdict(c) {
  if (c.tgRequestCount === 0) {
    return { verdict: 'inconclusive', reason: '窗口内到 TG origin 零请求（Network 采集可能未覆盖）' }
  }
  if (c.feedPosterRequestCount > 0 && c.maxConcurrent >= 6) {
    return {
      verdict: 'support',
      reason: `feed 抽帧请求 ${c.feedPosterRequestCount} 条 + 最大并发 ${c.maxConcurrent}（达 6 连接上限）`,
    }
  }
  if (c.maxConcurrentAfterPoll >= 6) {
    return { verdict: 'support', reason: `5s 轮询后并发在途达 ${c.maxConcurrentAfterPoll}（≥6）` }
  }
  if (c.feedPosterRequestCount === 0 && c.maxConcurrent <= 2) {
    return {
      verdict: 'reject',
      reason: `到 TG origin 仅播放器请求在途（maxConcurrent=${c.maxConcurrent}），无 feed 抽帧争抢`,
    }
  }
  return {
    verdict: 'inconclusive',
    reason: `maxConcurrent=${c.maxConcurrent}, feedPoster=${c.feedPosterRequestCount}, afterPoll=${c.maxConcurrentAfterPoll}`,
  }
}

// ---------------------------------------------------------------------------
// 一个条件的采样窗口
// ---------------------------------------------------------------------------

/**
 * 采样一个窗口：先安装/重置采集，再在 Node 侧等待 `seconds`（避免长 evaluate 超时），
 * 最后快照。返回原始序列，供 Node 侧计算直方图与掉帧关联。
 * @param {object} page CDP Page
 * @param {number} seconds 窗口秒数
 * @returns {Promise<object>} 原始窗口数据
 */
async function measureWindow(page, seconds) {
  // 复位 longtask 缓冲 + 启动 rVFC
  const started = await page.evaluate(() => {
    const S = window.__stall
    if (!S) return { ok: false }
    S.install()
    S.lt.length = 0
    S.polls.length = 0
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const rvfcOk = S.startRvfc(v)
    const snap = S.snapshot()
    return { ok: true, rvfcOk, snap0: snap, ltErr: S.ltErr }
  })

  const t0 = Date.now()
  await delay(seconds * 1000)
  const wallSecs = (Date.now() - t0) / 1000

  const out = await page.evaluate(() => {
    const S = window.__stall
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const rvfc = S.stopRvfc(v)
    const snap1 = S.snapshot()
    return { lt: S.lt.slice(), rvfc, polls: S.polls.slice(), snap1, ltErr: S.ltErr }
  })

  return {
    wallSecs: Number(wallSecs.toFixed(2)),
    rvfcOk: started.rvfcOk,
    ltErr: out.ltErr || started.ltErr || null,
    snap0: started.snap0,
    snap1: out.snap1,
    lt: out.lt,
    rvfc: out.rvfc,
    polls: out.polls || [],
  }
}

/**
 * 采样一个窗口 + 同步采集该窗口内到 TG origin 的网络请求（连接池争抢维度）。
 * @param {object} page CDP Page
 * @param {number} seconds 窗口秒数
 * @param {object|null} collector createNetworkCollector 的返回（可为 null）
 * @param {number} playingItem 正在播放的条目 id
 * @returns {Promise<object>} measureWindow 结果 + `net`/`netAnalysis`
 */
async function measureWindowWithNet(page, seconds, collector, playingItem) {
  if (collector) collector.reset()
  const w = await measureWindow(page, seconds)
  if (collector) {
    const net = collector.snapshot()
    w.net = net
    w.netAnalysis = concurrencyAnalysis(net, playingItem)
  }
  return w
}

// ---------------------------------------------------------------------------
// 纯计算：直方图 / 掉帧关联 / 汇总
// ---------------------------------------------------------------------------

/**
 * 把 longtask 的 startTime 按 `t mod 5000` 折叠成 20 个 250ms 桶。
 * @param {Array<{start:number,dur:number}>} lt
 * @returns {{buckets:number[], max:number, maxBucket:number, expected:number, clustered:boolean, span:string}}
 */
function phaseHistogram(lt) {
  const buckets = new Array(BUCKET_COUNT).fill(0)
  for (const e of lt) {
    const phase = ((e.start % 5000) + 5000) % 5000
    const idx = Math.min(BUCKET_COUNT - 1, Math.floor(phase / BUCKET_MS))
    buckets[idx] += 1
  }
  const n = lt.length
  const max = n ? Math.max(...buckets) : 0
  const maxBucket = n ? buckets.indexOf(max) : -1
  const expected = n / BUCKET_COUNT
  // 判定：样本足够（≥6）且峰值桶 ≥ max(3, 2×均匀期望) ⇒ 明显聚集。
  const clustered = n >= 6 && max >= Math.max(3, expected * 2)
  const span = maxBucket >= 0 ? `${maxBucket * BUCKET_MS}-${(maxBucket + 1) * BUCKET_MS}ms` : '-'
  return { buckets, max, maxBucket, expected, clustered, span }
}

/**
 * 轮询节拍统计：相邻两次 `/api/tg/cache/tasks*` 发起时刻的间隔中位数。
 * ≈5000ms ⇒ 确认 5s 时钟在场（条件 B/C）；无轮询 ⇒ 无 5s 时钟（条件 A 预期）。
 * @param {Array<{t:number,kind:string}>} polls
 * @returns {{count:number, medianMs:number|null, kinds:object}}
 */
function pollCadence(polls) {
  const ts = polls.map((p) => p.t).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1])
  gaps.sort((a, b) => a - b)
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null
  const kinds = polls.reduce((a, p) => {
    a[p.kind] = (a[p.kind] || 0) + 1
    return a
  }, {})
  return { count: polls.length, medianMs: median == null ? null : Number(median.toFixed(1)), kinds }
}

/**
 * **决定性的对齐判据**：把每个 longtask 锚到它**之前最近一次轮询**（lookback 内），
 * 统计「longtask 紧随轮询之后」的比例与延迟分布。
 *
 * 这比盲 `mod 5000` 网格更强：它用的是 TgPanel 5s `setInterval` 的**真实刻度**
 * （fetch 打桩记录），因此不受挂载相位未知的影响。
 *   - 若大多数 longtask 落在轮询后 `<= ALIGN_WINDOW` 内 ⇒ **与 5s 重渲染对齐**（前端成因）。
 *   - 若 longtask 与轮询时刻无关（比例低/延迟弥散）⇒ 与 5s 无关（转后端 I/O 争抢）。
 * @param {Array<{start:number,dur:number}>} lt
 * @param {Array<{t:number}>} polls
 * @param {number} alignWindowMs 「紧随其后」的判定窗
 * @returns {object}
 */
function pollAnchoredAnalysis(lt, polls, alignWindowMs = 800) {
  const LOOKBACK = 2500
  const ts = polls.map((p) => p.t).sort((a, b) => a - b)
  const delays = []
  let matched = 0
  let within = 0
  for (const e of lt) {
    let best = null
    for (const p of ts) {
      const d = e.start - p
      if (d >= -50 && d <= LOOKBACK && (best === null || d < best)) best = d
    }
    if (best !== null) {
      matched += 1
      delays.push(Number(best.toFixed(1)))
      if (best <= alignWindowMs) within += 1
    }
  }
  const ratio = lt.length ? Number((within / lt.length).toFixed(2)) : null
  return {
    pollCount: ts.length,
    matched,
    within,
    withinRatio: ratio,
    alignWindowMs,
    delays,
  }
}

/**
 * 混杂控制：读 store 里 **daemon/orig-core 下载**的活跃数（`status` 为 downloading/queued）。
 *
 * frontend-stall-probe 的口径更正：500ms 级 SSE 仅来自 **orig-core 下载引擎**（非 Range 模式）。
 * 「纯 TG 缓存」场景要求该计数为 0 —— 否则 500ms ticker 会成为 5s 之外的第二个周期源，
 * 污染「卡顿 vs TgPanel 5s 节拍」的归因。本函数只**记录**，不创建/改动任何下载。
 * @returns {Promise<{ok:boolean, total:number, active:number, activeStatuses:string[]}>}
 */
async function probeDaemonDownloads(page) {
  return page.evaluate(() => {
    try {
      const st = window.__origStore.getState()
      const ds = Array.isArray(st.downloads) ? st.downloads : []
      const active = ds.filter((d) => d && (d.status === 'downloading' || d.status === 'queued'))
      return {
        ok: true,
        total: ds.length,
        active: active.length,
        activeStatuses: active.map((d) => String(d.status)),
      }
    } catch (e) {
      return { ok: false, total: 0, active: 0, activeStatuses: [], err: String(e && e.message ? e.message : e) }
    }
  })
}

/**
 * 计算 rVFC 间隔序列，并把每个 longtask 与「其覆盖区间内的 rVFC 缺口（>GAP_MS）」关联。
 * @param {Array<{start:number,dur:number}>} lt
 * @param {number[]} rvfc 已排序的呈现帧时间戳（performance.now 轴）
 * @returns {{intervals:number[], maxGap:number, gapCount:number, ltWithGap:number, ltTotal:number}}
 */
function frameGapAnalysis(lt, rvfc) {
  const sorted = rvfc.slice().sort((a, b) => a - b)
  const intervals = []
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i] - sorted[i - 1])
  const maxGap = intervals.length ? Math.max(...intervals) : 0
  const gapCount = intervals.filter((g) => g > GAP_MS).length
  let ltWithGap = 0
  for (const e of lt) {
    const lo = e.start
    const hi = e.start + e.dur + GAP_MS
    let hit = false
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]
      const b = sorted[i]
      if (b >= lo && a <= hi && b - a > GAP_MS) {
        hit = true
        break
      }
    }
    if (hit) ltWithGap += 1
  }
  return {
    intervals,
    maxGap: Number(maxGap.toFixed(1)),
    gapCount,
    ltWithGap,
    ltTotal: lt.length,
  }
}

/** 计算「呈现帧率 / 丢帧%」，来自 getVideoPlaybackQuality 前后差。 */
function qualityStats(snap0, snap1, wallSecs) {
  if (!snap0 || !snap1 || !snap0.hasVideo || !snap1.hasVideo) {
    return { totalDelta: null, droppedDelta: null, droppedPct: null, presentedFps: null }
  }
  const totalDelta = (snap1.frames || 0) - (snap0.frames || 0)
  const droppedDelta = (snap1.dropped || 0) - (snap0.dropped || 0)
  const droppedPct =
    totalDelta > 0 ? Number(((100 * droppedDelta) / totalDelta).toFixed(1)) : null
  const presentedFps = wallSecs > 0 ? Number((totalDelta / wallSecs).toFixed(1)) : null
  return { totalDelta, droppedDelta, droppedPct, presentedFps }
}

/**
 * 把一个窗口的原始数据汇总成一行结论。
 * @param {string} key A/B/C
 * @param {object} w measureWindow 的返回
 * @returns {object}
 */
function summarizeCondition(key, w) {
  const lt = w.lt || []
  const polls = w.polls || []
  const hist = phaseHistogram(lt)
  const cadence = pollCadence(polls)
  const anchored = pollAnchoredAnalysis(lt, polls, ALIGN_WINDOW_MS)
  const gap = frameGapAnalysis(lt, w.rvfc || [])
  const q = qualityStats(w.snap0, w.snap1, w.wallSecs)
  const maxLt = lt.length ? Number(Math.max(...lt.map((e) => e.dur)).toFixed(1)) : 0
  const aheadMin =
    w.snap1 && w.snap1.hasVideo && typeof w.snap1.ahead === 'number'
      ? Number(w.snap1.ahead.toFixed(2))
      : null
  // 5s 对齐的**合并判据**：盲网格聚集 或 「longtask 多数紧随轮询刻度之后」。
  const anchoredAligned =
    anchored.pollCount >= 2 && anchored.withinRatio != null && anchored.withinRatio >= 0.5
  return {
    condition: key,
    wallSecs: w.wallSecs,
    rvfcSupported: w.rvfcOk,
    longtaskCount: lt.length,
    longtaskMaxMs: maxLt,
    longtaskTotalMs: Number(lt.reduce((a, e) => a + e.dur, 0).toFixed(1)),
    // 判据 1：盲 mod-5000 网格
    phaseClustered: hist.clustered,
    phaseMaxBucket: hist.maxBucket,
    phaseMaxCount: hist.max,
    phaseSpan: hist.span,
    phaseBuckets: hist.buckets,
    // 判据 2（决定性）：poll-anchored
    pollCount: cadence.count,
    pollMedianMs: cadence.medianMs,
    pollKinds: cadence.kinds,
    alignedWithin: anchored.within,
    alignedMatched: anchored.matched,
    alignedRatio: anchored.withinRatio,
    alignedDelays: anchored.delays,
    // 合并
    alignedWith5s: hist.clustered || anchoredAligned,
    rvfcFrames: (w.rvfc || []).length,
    rvfcMaxGapMs: gap.maxGap,
    rvfcGapCount: gap.gapCount,
    ltWithGap: gap.ltWithGap,
    ltTotal: gap.ltTotal,
    droppedDelta: q.droppedDelta,
    droppedPct: q.droppedPct,
    presentedFps: q.presentedFps,
    bufferedAheadMin: aheadMin,
    path: w.snap1 && w.snap1.path ? w.snap1.path : 'n/a',
    currentSrc: w.snap1 && w.snap1.currentSrc ? w.snap1.currentSrc : (w.snap1 && w.snap1.src) || '',
    // 网络维度（连接池争抢）
    net: w.netAnalysis || null,
    netVerdict: w.netAnalysis ? networkVerdict(w.netAnalysis) : null,
    ltErr: w.ltErr,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[stall] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(f).size
  } catch (_e) {
    /* ignore */
  }
  console.log(`[stall] shot ${name} -> ${f} (${size} bytes)`)
}

/** 打印一行条件的结论。 */
function logCondition(r) {
  console.log(
    `[stall] ${r.condition} | longtask ${r.longtaskCount} (max ${r.longtaskMaxMs}ms, total ${r.longtaskTotalMs}ms)` +
      ` | phase clustered=${r.phaseClustered} bucket#${r.phaseMaxBucket} (${r.phaseSpan}, n=${r.phaseMaxCount})` +
      ` | polls ${r.pollCount} (median ${r.pollMedianMs}ms, ${JSON.stringify(r.pollKinds)})` +
      ` | anchored within<=${ALIGN_WINDOW_MS}ms ${r.alignedWithin}/${r.longtaskCount} (ratio ${r.alignedRatio})` +
      ` | ALIGNED=${r.alignedWith5s}` +
      ` | rVFC maxGap ${r.rvfcMaxGapMs}ms gaps=${r.rvfcGapCount} lt-with-gap=${r.ltWithGap}/${r.ltTotal}` +
      ` | dropped ${r.droppedDelta} (${r.droppedPct}%) presented ${r.presentedFps}fps` +
      ` | bufferedMin ${r.bufferedAheadMin}s | path ${r.path}` +
      ` | net[tgReq ${r.net ? r.net.tgRequestCount : '-'} maxConc ${r.net ? r.net.maxConcurrent : '-'}` +
      ` player ${r.net ? r.net.playerRequestCount : '-'} feedPoster ${r.net ? r.net.feedPosterRequestCount : '-'}` +
      ` poll ${r.net ? r.net.pollRequestCount : '-'} afterPoll ${r.net ? r.net.maxConcurrentAfterPoll : '-'}]` +
      ` => connPool ${r.netVerdict ? r.netVerdict.verdict : '-'}`,
  )
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ---- 环境探活（失败即 exit 2，不重试、不等待）----
  const fe = await httpStatus(APP_URL, 3000)
  const be = await httpStatus(`${TG}/api/media/series`, 3000)
  console.log(`[stall] env probe: frontend ${APP_URL} -> ${fe}; backend ${TG} -> ${be}`)
  if (fe === 0 || be === 0) {
    console.error(
      `[stall] ENV: unreachable (frontend=${fe}, backend=${be}); script ready but NOT run.`,
    )
    process.exit(2)
  }

  let browser
  try {
    // headful（BUG-213 已修 cdp.cjs）：次判据 droppedPct/presentedFps/rVFC 需要真实 GPU 合成，
    // headless 会把 rAF/rVFC 钉在 ~60Hz 而失真。主判据（longtask + poll-anchored 5s 对齐）两态皆有效。
    browser = await cdp.launch({ headless: false })
  } catch (e) {
    console.error(`[stall] ENV: browser launch failed: ${e && e.message ? e.message : e}`)
    process.exit(2)
  }

  try {
    const page = await browser.newPage()
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    } catch (e) {
      console.error(`[stall] ENV: dev server unreachable at ${APP_URL}: ${e && e.message ? e.message : e}`)
      process.exit(2)
    }
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })
    console.log('[stall] app ready at', APP_URL)

    /*
     * headful 自证（防「静默退回 headless」）。
     *
     * 判别信号用 `navigator.userAgent` 是否含 `HeadlessChrome` —— **不是** `navigator.gpu`
     * （后者在 about:blank 非安全上下文下恒为 no-gpu-api，两态都一样，无区分力）。
     * 打印一次并写入产物：否则将来没人能确认这批 droppedPct/rVFC 数字是 headful 采的。
     */
    const userAgent = String(await page.evaluate(() => navigator.userAgent))
    const headful = !/HeadlessChrome/i.test(userAgent)
    console.log(`[stall] UA: ${userAgent}`)
    console.log(
      `[stall] headful self-attestation: ${headful} (UA ${headful ? '不含' : '含'} HeadlessChrome)`,
    )
    check('本次为 headful（UA 不含 HeadlessChrome）', headful, userAgent)

    // ---- CDP Network 域：连接池争抢维度采集 ----
    const netCollector = createNetworkCollector(page, TG_ORIGIN)
    let netEnabled = true
    try {
      await netCollector.enable()
    } catch (e) {
      netEnabled = false
      console.log(`[stall] WARN: Network domain unavailable: ${e && e.message ? e.message : e}`)
    }
    console.log(`[stall] Network domain enabled = ${netEnabled} (origin ${TG_ORIGIN})`)

    // ---- 进 TG 面板（确保 TgPanel 挂载）----
    const tgEnter = await enterTgPanel(page)
    console.log(`[stall] enterTgPanel ok=${tgEnter.ok}${tgEnter.reason ? ' reason=' + tgEnter.reason : ''}`)
    check('TgPanel 挂载（5s 轮询前置条件）', tgEnter.ok, tgEnter.reason || 'mounted')
    await shot(page, '00_tg_panel.png')

    // ---- 安装页面内探针 ----
    await installProbe(page)
    const ltSupported = await page.evaluate(() => {
      return !window.__stall.ltErr
    })
    console.log(`[stall] longtask observer supported = ${ltSupported}`)
    check('PerformanceObserver longtask 可用', ltSupported, String(await page.evaluate(() => window.__stall.ltErr)))

    // ---- 探测活跃缓存任务（只读；不新建、不改数据）----
    const activeInfo = await probeActiveTask(page)
    console.log(
      `[stall] active cache task: ok=${activeInfo.ok} active=${activeInfo.active} status=${activeInfo.status} err=${activeInfo.err || ''}`,
    )
    const hasActive = !!(activeInfo.ok && activeInfo.active)

    // ---- 混杂控制：daemon/orig-core 下载活跃数（必须为 0 才算「纯 TG 缓存」）----
    const daemonAtStart = await probeDaemonDownloads(page)
    console.log(
      `[stall] daemon downloads (confounder): total=${daemonAtStart.total} active=${daemonAtStart.active} ${JSON.stringify(daemonAtStart.activeStatuses)}`,
    )
    check(
      '纯 TG 缓存前提：无活跃 daemon 下载（否则 500ms SSE 会污染 5s 归因）',
      daemonAtStart.active === 0,
      `active=${daemonAtStart.active}`,
    )

    // ---- 打开长条目并等待出帧 ----
    await openItem(page, ITEM)
    const framed = await waitFramed(page)
    const snap = await page.evaluate(() => window.__stall.snapshot())
    console.log(`[stall] item ${ITEM} opened: framed=${framed} snap=${JSON.stringify(snap)}`)
    check(`长条目 ${ITEM} 打开并出帧`, framed && snap && snap.hasVideo, JSON.stringify(snap && { path: snap.path, vw: snap.vw, vh: snap.vh, readyState: snap.readyState }))
    await shot(page, `01_item_${ITEM}_opened.png`)

    const results = {
      item: ITEM,
      windowSec: WINDOW_SEC,
      bucketMs: BUCKET_MS,
      bucketCount: BUCKET_COUNT,
      gapMs: GAP_MS,
      alignWindowMs: ALIGN_WINDOW_MS,
      // headful 自证（见上方 UA 判别）：批数字必须可追溯到 headful/headless
      userAgent,
      headful,
      activeTaskAtStart: activeInfo,
      daemonDownloadsAtStart: daemonAtStart,
      tgEnter,
      conditions: {},
      notCoverable: {},
    }

    // ---- 条件 A：基线（无活跃任务）----
    if (!hasActive) {
      console.log(`\n[stall] ===== condition A (baseline, no active task) =====`)
      const ddA = await probeDaemonDownloads(page)
      const w = await measureWindowWithNet(page, WINDOW_SEC, netEnabled ? netCollector : null, ITEM)
      const r = summarizeCondition('A', w)
      r.daemonDownloads = ddA
      results.conditions.A = r
      logCondition(r)
      await shot(page, '10_conditionA_baseline.png')
    } else {
      results.notCoverable.A = '库内存在活跃缓存任务 ⇒ 无法覆盖「无缓存任务」基线'
      console.log('[stall] condition A NOT COVERABLE: 库内存在活跃缓存任务')
    }

    // ---- 条件 B：缓存中（活跃任务在场）----
    if (hasActive) {
      console.log(`\n[stall] ===== condition B (caching, active task) =====`)
      const ddB = await probeDaemonDownloads(page)
      const w = await measureWindowWithNet(page, WINDOW_SEC, netEnabled ? netCollector : null, ITEM)
      const r = summarizeCondition('B', w)
      r.daemonDownloads = ddB
      results.conditions.B = r
      logCondition(r)
      await shot(page, '20_conditionB_caching.png')
    } else {
      results.notCoverable.B = '库内无活跃缓存任务 ⇒ 无法覆盖「缓存中」条件'
      console.log('[stall] condition B NOT COVERABLE: 库内无活跃缓存任务')
    }

    // ---- 条件 C：缓存中 + 缓存管理面板打开 ----
    if (hasActive) {
      console.log(`\n[stall] ===== condition C (caching + cache manager open) =====`)
      const opened = await page.evaluate(() => {
        try {
          window.__origStore.getState().setTgCacheManagerOpen(true)
          return true
        } catch (e) {
          return false
        }
      })
      // 面板打开后稍等一拍（面板自轮 tasks/all 每 5s）
      await delay(800)
      const panelOpen = await page.evaluate(() => !!document.querySelector('[data-testid="cache-manager"]'))
      console.log(`[stall] cache manager open=${opened} panelPresent=${panelOpen}`)
      const ddC = await probeDaemonDownloads(page)
      const w = await measureWindowWithNet(page, WINDOW_SEC, netEnabled ? netCollector : null, ITEM)
      const r = summarizeCondition('C', w)
      r.daemonDownloads = ddC
      results.conditions.C = r
      logCondition(r)
      await shot(page, '30_conditionC_manager_open.png')
      // 收尾：关面板（恢复现场）
      await page.evaluate(() => {
        try {
          window.__origStore.getState().setTgCacheManagerOpen(false)
        } catch (_e) {
          /* ignore */
        }
      })
      await delay(400)
    } else {
      results.notCoverable.C = '库内无活跃缓存任务 ⇒ 无法覆盖「缓存中 + 面板」条件'
      console.log('[stall] condition C NOT COVERABLE: 库内无活跃缓存任务')
    }

    // ---- 页面错误 ----
    const pageErrors = page.pageErrors().slice(0, 20)
    const consoleErrors = page.consoleErrors().slice(0, 20)
    results.pageErrors = pageErrors
    results.consoleErrors = consoleErrors
    console.log('[stall] PAGE_ERRORS:', JSON.stringify(pageErrors))
    console.log('[stall] CONSOLE_ERRORS:', JSON.stringify(consoleErrors))

    // ---- 对齐判定（总答）----
    // 决定性条件 = B（纯 TG 缓存 + 面板关）：此时 5s 时钟**唯一**来自 TgPanel:800 → :777 → :781。
    //   对齐 ⇒ 前端成因；不对齐 ⇒ 转后端 I/O 争抢（frontend-stall-probe 口径更正）。
    const condKeys = Object.keys(results.conditions)
    const alignedConds = condKeys.filter((k) => results.conditions[k].alignedWith5s)
    const bRes = results.conditions.B
    const pureTgOk = daemonAtStart.active === 0
    let answer
    if (!bRes) {
      answer = 'INCONCLUSIVE：条件 B（缓存中/面板关）不可覆盖 ⇒ 无法判定 5s 对齐（需库内有活跃缓存任务）'
    } else if (bRes.longtaskCount === 0) {
      answer = 'NO：条件 B 未观测到任何 longtask（无 >50ms 主线程长任务）⇒ 无「卡顿」可归因于 TgPanel 重渲染'
    } else if (bRes.alignedWith5s) {
      answer =
        `YES：卡顿与 TgPanel 的 5s 重渲染节拍对齐（B: longtask ${bRes.alignedWithin}/${bRes.longtaskCount} 落在轮询后 ≤${ALIGN_WINDOW_MS}ms；` +
        `轮询中位间隔 ${bRes.pollMedianMs}ms；盲网格聚集=${bRes.phaseClustered}）⇒ 支持前端成因`
    } else {
      answer =
        `NO：条件 B 的 longtask 与 5s 轮询刻度不对齐（仅 ${bRes.alignedWithin}/${bRes.longtaskCount} 紧随轮询；` +
        `盲网格聚集=${bRes.phaseClustered}）⇒ 与 5s 节拍无关，应转后端 I/O 争抢`
    }
    results.alignmentVerdict = {
      alignedConditions: alignedConds,
      anyAligned: alignedConds.length > 0,
      decisiveCondition: 'B',
      pureTgCachePremise: pureTgOk,
      answer,
    }
    console.log('[stall] ALIGNMENT VERDICT:', results.alignmentVerdict.answer)

    // ---- 连接池争抢总判（决定性条件 B：缓存中 + 面板关）----
    const bNet = results.conditions.B ? results.conditions.B.netVerdict : null
    results.connPoolVerdict = bNet
      ? { ...bNet, condition: 'B' }
      : { verdict: 'inconclusive', reason: '条件 B 不可覆盖 ⇒ 无法判定连接池争抢' }
    console.log(
      `[stall] CONN-POOL VERDICT: ${results.connPoolVerdict.verdict} - ${results.connPoolVerdict.reason}`,
    )

    // ---- 写产物 ----
    fs.writeFileSync(path.join(OUT, 'cache_stall.json'), JSON.stringify(results, null, 2))

    const lines = []
    lines.push(
      '| 条件 | longtask 次数 | 最长 longtask(ms) | 相位聚集 | 聚集桶 | 轮询次数 | 轮询中位(ms) | 紧随轮询≤' +
        ALIGN_WINDOW_MS +
        'ms | 5s对齐(合并) | daemon活跃 | 到origin请求 | 最大并发 | feed抽帧 | 5s后并发 | 连接池判 | rVFC 最大间隔(ms) | 掉帧% | buffered 最小(s) |',
    )
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    const label = { A: 'A 基线(无任务)', B: 'B 缓存中', C: 'C 缓存中+面板' }
    for (const k of condKeys) {
      const r = results.conditions[k]
      const dd = r.daemonDownloads || {}
      const n = r.net || {}
      lines.push(
        `| ${label[k] || k} | ${r.longtaskCount} | ${r.longtaskMaxMs} | ${r.phaseClustered ? '是' : '否'} | ` +
          `${r.phaseClustered ? `#${r.phaseMaxBucket}(${r.phaseSpan}, n=${r.phaseMaxCount})` : '-'} | ` +
          `${r.pollCount} | ${r.pollMedianMs == null ? '-' : r.pollMedianMs} | ` +
          `${r.alignedWithin}/${r.longtaskCount} (${r.alignedRatio == null ? '-' : r.alignedRatio}) | ` +
          `${r.alignedWith5s ? '是' : '否'} | ${dd.active == null ? '-' : dd.active} | ` +
          `${n.tgRequestCount == null ? '-' : n.tgRequestCount} | ${n.maxConcurrent == null ? '-' : n.maxConcurrent} | ` +
          `${n.feedPosterRequestCount == null ? '-' : n.feedPosterRequestCount} | ` +
          `${n.maxConcurrentAfterPoll == null ? '-' : n.maxConcurrentAfterPoll} | ` +
          `${r.netVerdict ? r.netVerdict.verdict : '-'} | ` +
          `${r.rvfcMaxGapMs} | ${r.droppedPct == null ? '-' : r.droppedPct + '%'} | ${r.bufferedAheadMin} |`,
      )
    }
    lines.push('')
    lines.push('**对齐判定**：' + results.alignmentVerdict.answer)
    lines.push('')
    lines.push(
      '**连接池争抢判定**：' + results.connPoolVerdict.verdict + ' — ' + results.connPoolVerdict.reason,
    )
    if (Object.keys(results.notCoverable).length) {
      lines.push('')
      lines.push('未覆盖条件：')
      for (const k of Object.keys(results.notCoverable)) {
        lines.push(`- ${label[k] || k}：${results.notCoverable[k]}`)
      }
    }
    lines.push('')
    lines.push('（相位直方图 = longtask.startTime mod 5000ms，20×250ms 桶；聚集 ⇒ 与 5s 节拍对齐）')
    lines.push(
      `（决定性判据 = poll-anchored：给 fetch 打桩记录真实轮询刻度，longtask 落在轮询后 ≤${ALIGN_WINDOW_MS}ms 记「紧随」；` +
        `比例 ≥0.5 且轮询 ≥2 次 ⇒ 对齐。纯 TG 缓存场景 daemon 活跃须为 0）`,
    )
    const md = lines.join('\n')
    fs.writeFileSync(path.join(OUT, 'cache_stall.md'), md + '\n')
    console.log('\n[stall] === MARKDOWN ===')
    console.log(md)

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[stall] === SUMMARY ===')
    console.log(`[stall] checks total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) console.log('[stall] FAILED:', failed.map((c) => c.name).join(' | '))
    console.log(`[stall] artifacts in ${OUT}`)
  } catch (e) {
    console.error('[stall] ERROR', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
    console.log('[stall] browser closed')
  }
}

main()
