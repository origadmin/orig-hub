#!/usr/bin/env node
'use strict'

/**
 * 单脚本 · 单浏览器 · 一次跑完的播放验收（BUG-212 验收 + 缓存卡顿 5s 节拍对齐）。
 *
 * ## 为什么存在
 *
 * 用户原话：「处理流程就有严重问题，一直在跑 edge，不清楚在跑什么，大量浪费了时间，
 * 所有内容不能一次跑完吗？」——此前的验收被拆成多个脚本、反复起浏览器、跑一轮报一轮，
 * 用户既看不到进度、也看不到终点。本脚本把「一次跑完」变成现实：
 *
 *   - **一条命令**：`node verify/verify_playback_all.cjs`
 *   - **只起一个 headful 浏览器**，所有阶段复用同一个 page（不反复重启、不新起实例）
 *   - **全程打印进度**：每进入/完成一个阶段都打印 `[序号/总数] 在测什么 … 结果`
 *   - **最后给一张总表**（阶段 / 判据 / 结果 / 关键数字 / 是否覆盖）
 *
 * ## 阶段清单（7 步，单浏览器单会话）
 *
 *   [0/7] 环境与自证    探活 5180/19787 · 打印 headful UA（自证非 HeadlessChrome）· 确认落在 TG 视图
 *   [1/7] BUG-212 C1    ${ITEM}@2x 呈现丢帧 > 0 期间「解码吃力」提示**不出现**（误报消除）
 *   [2/7] BUG-212 C2    ${ITEM}@1x 丢帧 0% 且提示**不出现**（干净基线）
 *   [3/7] BUG-212 C3    ${ITEM_HEVC}@4x 呈现丢帧显著时提示**不出现**（误报消除）
 *   [4/7] BUG-212 C4    **运行时注入**「管线饿死」⇒ 提示**必须出现**（反向证伪，证明判据是活的）；自动还原
 *   [5/7] BUG-212 C5    **运行时注入** videoWidth=0 ⇒ BUG-207 停载遮罩出现（回归）；自动还原
 *   [6/7] 缓存卡顿对齐   自造「缓存中」条件 · 60s 窗口 longtask 直方图 + poll-anchored 判定 + rVFC/质量/缓冲
 *   [7/7] 输出总表       落盘 playback_all.json / playback_all.md · 计算退出码
 *
 * ## 硬约束（与 team-lead 约定）
 *
 *   - **只起一个 headful 浏览器**：`cdp.launch({ headless: false })`（BUG-213 已修；不传 options 仍是
 *     headless，故必须显式传）。启动后打印一次 `navigator.userAgent` 自证 headful 并写入产物。
 *   - **所有阶段复用同一 page**；需要重载时用 `page.navigate`/`page.goto`，**绝不新起浏览器**。
 *   - `finally` 关闭浏览器；结束后不残留游离进程（不误杀其它 msedge）。
 *   - **不改 `tauri-shell/src/` 或 `download-engine/`**：阶段 4/5 仅**运行时原型打桩**且**自动还原**，
 *     并以 `sha256` + `git status --porcelain` 自证工作区未被污染。
 *   - 环境不可达（5180 / 19787 探活失败）⇒ 只做自检、如实报告「未运行」，退出码 2，**不伪造数字**。
 *
 * ## 产物与退出码
 *
 *   产物：`tauri-shell/verify_shots/playback_all/`（playback_all.json + playback_all.md + 截图）
 *   退出码：全 PASS=0；有 FAIL=1；环境不可达=2。
 *
 * ## 环境变量
 *
 *   APP_PORT / APP_URL / TG_URL / OUT / PROBE_ITEM / PROBE_ITEM_HEVC /
 *   CLEAN_WINDOW_SEC / STRAIN_WINDOW_SEC / INJECT_SEC / RECOVER_SEC / STALL_WINDOW_SEC /
 *   STALL_CHAT_ID / STALL_AHEAD / STALL_TICK_MS。浏览器 EDGE_PATH / CHROME_PATH 可覆盖。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const cdp = require('./lib/cdp.cjs')

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
/** TG origin（媒体/缩略图/缓存任务请求的共同源）—— 连接池分析的作用域。 */
let TG_ORIGIN = TG
try {
  TG_ORIGIN = new URL(TG).origin
} catch (_e) {
  /* 保留原值 */
}
const OUT = path.resolve(
  process.env.OUT || path.join(__dirname, '..', 'verify_shots', 'playback_all'),
)
/** 仓库根：脚本位于 tauri-shell/verify/ ⇒ 上溯两级。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..')

/** 首选夹具：607 = H.264 480×852 30fps（1x 实测丢帧 0%）。 */
const ITEM = Number(process.env.PROBE_ITEM || 607)
/** 高倍速夹具：472 = HEVC 720p 60fps。 */
const ITEM_HEVC = Number(process.env.PROBE_ITEM_HEVC || 472)

/** 1x 干净窗口（秒）。 */
const CLEAN_WINDOW_SEC = Number(process.env.CLEAN_WINDOW_SEC || 10)
/** 倍速窗口（秒）。 */
const STRAIN_WINDOW_SEC = Number(process.env.STRAIN_WINDOW_SEC || 12)
/** 注入持续时间（秒）——须 ≥3s。 */
const INJECT_SEC = Number(process.env.INJECT_SEC || 6)
/** 还原后观察提示撤销的时间（秒）。 */
const RECOVER_SEC = Number(process.env.RECOVER_SEC || 6)

/** 改速后的解码器预热静默期（对齐 decodeHealth.ts 的 WARMUP_MS=1500，留余量）。 */
const WARMUP_MS = 1800
/** 有效倍速下限（对齐 decodeHealth.ts 的 EFF_RATE_MIN）。 */
const EFF_RATE_MIN = 0.9
/** 连续判定拍数（对齐 decodeHealth.ts 的 STRAIN_STREAK）。 */
const STRAIN_STREAK = 4
/** 打桩比例：ΔcurrentTime 只保留 20% ⇒ effRate ≈ 0.2 << 0.9。 */
const STARVE_SCALE = 0.2
/** 页面内采样节拍（对齐 decodeHealth.ts 的 SAMPLE_MS）。 */
const SAMPLE_MS = 500
/** 等待出帧 / 停载遮罩的超时。 */
const FRAME_WAIT_MS = 90000
const HALT_WAIT_MS = 60000

// ---- 缓存卡顿（阶段 6）----
/** 「缓存中」测量窗口（秒）——要求 ≥60s。 */
const STALL_WINDOW_SEC = Number(process.env.STALL_WINDOW_SEC || 60)
/** 5s 相位直方图：桶宽与桶数（20 × 250ms = 5000ms）。 */
const BUCKET_MS = 250
const BUCKET_COUNT = 20
/** rVFC 间隔 > 该值视为「掉帧缺口」。 */
const GAP_MS = 50
/** longtask 落在轮询后 ≤ 该窗内即视为「紧随 5s 节拍」（poll-anchored 判据）。 */
const ALIGN_WINDOW_MS = 800
/** 受控缓存批次所属频道（team-lead 指定）。 */
const STALL_CHAT_ID = Number(process.env.STALL_CHAT_ID || -1001341930464)
const BATCH_SIZE = Number(process.env.STALL_BATCH_SIZE || 20)
/** 目标「领先批次」：running(1) + queued 少于该值即续排，撑满窗口。 */
const DESIRED_AHEAD = Number(process.env.STALL_AHEAD || 3)
const MIN_BYTES = 5 * 1024 * 1024
const MAX_BYTES = 40 * 1024 * 1024
const KEEPALIVE_TICK_MS = Number(process.env.STALL_TICK_MS || 2000)

/**
 * team-lead 指定的受控首批（精确使用，不增不减）：
 * 20 条、单条 5–40MB、合计约 145MB；多条目 ⇒ 可在条目间隙取消。
 */
const BATCH1 = [
  208031, 206999, 208170, 207839, 207774, 207910, 208096, 206864, 206855, 206838, 207024, 207809,
  207673, 208147, 207951, 207717, 208083, 207330, 206903, 208010,
]

/** 每个阶段的硬超时（毫秒）——超时即如实记 FAIL 并继续，绝不卡死。 */
const STAGE_TIMEOUT = {
  C1: 100000,
  C2: 100000,
  C3: 130000,
  C4: 100000,
  C5: 130000,
  STALL: 180000,
}

/** 注入自证要监控的源文件（不得改动）。 */
const SRC_GUARD_FILES = [
  path.join('tauri-shell', 'src', 'lib', 'decodeHealth.ts'),
  path.join('tauri-shell', 'src', 'components', 'media', 'VideoPlayer.tsx'),
]
/** 注入自证要监控的目录（`git status --porcelain` 作用域）。 */
const SRC_GUARD_DIRS = ['tauri-shell/src', 'download-engine']

const TOTAL_STAGES = 7

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * GET 一个 URL 的状态码（loopback，超时即失败）。
 * @param {string} url
 * @param {number} [timeoutMs]
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

/**
 * 发起一个 JSON HTTP 请求（loopback）。
 * @param {string} method GET / POST / DELETE
 * @param {string} url
 * @param {object|null} [body]
 * @returns {Promise<{status:number, json:object|null}>}
 */
function httpJson(method, url, body) {
  return new Promise((resolve) => {
    let payload = null
    if (body != null) payload = Buffer.from(JSON.stringify(body), 'utf8')
    const u = new URL(url)
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    }
    if (payload) opts.headers['Content-Length'] = payload.length
    const req = http.request(opts, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        let json = null
        try {
          json = d ? JSON.parse(d) : null
        } catch (_e) {
          json = { _raw: d }
        }
        resolve({ status: res.statusCode || 0, json })
      })
    })
    req.on('error', (e) => resolve({ status: 0, json: { _err: String((e && e.message) || e) } }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: { _err: 'timeout' } })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/** 文件 sha256；不可读返回 `ERR:<msg>`（用于自证对比，不作为异常抛出）。 */
function sha256(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
  } catch (e) {
    return `ERR:${(e && e.message) || e}`
  }
}

/** 同步睡眠（用于 git 重试；不阻塞事件循环之外的东西）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch (_e) {
    /* 极端环境下退化为不睡眠 */
  }
}

/**
 * 在仓库根执行 `git status --porcelain -- <paths>`（只读）。
 *
 * 带**重试**：本团队多成员并发跑 git 时 `git status` 偶发 `spawnSync git EBUSY`；
 * 若不重试，自证快照可能「前一次失败、后一次成功」⇒ 误报「工作区被改动」。
 */
function gitStatusPorcelain(paths) {
  let lastErr = ''
  for (let i = 0; i < 6; i++) {
    try {
      return String(
        execFileSync('git', ['status', '--porcelain', '--', ...paths], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      ).trim()
    } catch (e) {
      lastErr = (e && e.message) || String(e)
      sleepSync(300)
    }
  }
  return `ERR:${lastErr}`
}

/** 采集「工作区未被改动」的自证快照。 */
function guardSnapshot() {
  const hashes = {}
  for (const rel of SRC_GUARD_FILES) hashes[rel] = sha256(path.join(REPO_ROOT, rel))
  return { hashes, gitStatus: gitStatusPorcelain(SRC_GUARD_DIRS) }
}

/**
 * 从 zh-CN locale 读 `tg.decodeStrained` 文案，派生 DOM 匹配标记。
 * 找不到就回退到已知中文标记。
 * @returns {{strainText:string, strainShort:string}}
 */
function loadNoticeMarkers() {
  let strainText = '解码吃力：画面在丢帧，调低播放速度会明显更流畅'
  try {
    const p = path.join(REPO_ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (j && j.tg && typeof j.tg.decodeStrained === 'string') strainText = j.tg.decodeStrained
  } catch (_e) {
    /* 回退到默认标记 */
  }
  const cut = strainText.split(/[：:]/)[0]
  const strainShort = cut && cut.length >= 2 ? cut : strainText
  return { strainText, strainShort }
}

/** 带超时的 promise 竞争（超时抛错，由调用方记 FAIL 并继续）。 */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// 进度打印（用户「不清楚在跑什么」的直接解药）
// ---------------------------------------------------------------------------

/**
 * 打印阶段开始行。
 * @param {number} idx 阶段序号（0 = 环境准备）
 * @param {number} total 阶段总数
 * @param {string} title 在测什么
 */
function stageStart(idx, total, title) {
  console.log(`\n[${idx}/${total}] ${title} … 开始`)
}

/**
 * 打印阶段结束行。
 * @param {number} idx 阶段序号
 * @param {number} total 阶段总数
 * @param {string} title 在测什么
 * @param {string} verdict PASS / FAIL / NOT-COVERABLE
 * @param {string} detail 关键数字
 * @param {number} secs 用时（秒）
 */
function stageEnd(idx, total, title, verdict, detail, secs) {
  console.log(`[${idx}/${total}] ${title} … ${verdict}（${detail}） 用时 ${secs}s`)
}

// ---------------------------------------------------------------------------
// 页面内持久探针 A：BUG-212 提示 / 停载遮罩 / 打桩（`window.__b212`）
// ---------------------------------------------------------------------------

/**
 * 安装页面内持久探针 `window.__b212`：
 *   - `start()` / `stop()`：500ms 节拍逐拍采样。
 *   - 逐拍记录 `currentTime` / `playbackRate` / `effRate` / `droppedVideoFrames` 增量 /
 *     `buffered` 领先秒数 / 提示是否在场 / 停载遮罩是否在场 / `currentSrc` 路径。
 *   - `injectStarvation(scale)` / `revertStarvation()`：对 `currentTime` getter 打桩。
 *   - `injectNoVideo()` / `revertNoVideo()`：对 `videoWidth` getter 打桩。
 *   - `injectionState()`：当前打桩态（自证已还原）。
 * @param {object} page CDP Page
 * @param {{strainText:string, strainShort:string}} markers
 * @returns {Promise<void>}
 */
async function installNoticeProbe(page, markers) {
  await page.evaluate((cfg) => {
    if (window.__b212 && window.__b212.__v === 1) {
      window.__b212.strainText = cfg.strainText
      window.__b212.strainShort = cfg.strainShort
      return true
    }
    const S = {
      __v: 1,
      strainText: cfg.strainText,
      strainShort: cfg.strainShort,
      haltSelector: '[data-testid="player-unsupported-halt"]',
      samples: [],
      intervalId: null,
      lastT: null,
      lastCt: null,
      lastDropped: null,
      lastFrames: null,
      events: { waiting: 0, stalled: 0, playing: 0, ratechange: 0, seeked: 0, error: 0 },
      _evBound: null,
      _evList: null,
      _curDesc: null,
      _curProto: null,
      _vwDesc: null,
      _vwProto: null,
      curPatched: false,
      vwPatched: false,

      /** 沿原型链找属性描述符。 */
      _findProp(obj, name) {
        let o = obj
        while (o) {
          const d = Object.getOwnPropertyDescriptor(o, name)
          if (d) return { owner: o, desc: d }
          o = Object.getPrototypeOf(o)
        }
        return null
      },

      /**
       * 找「解码吃力」提示节点。主判据 = 文案匹配（语义）；回退 = 稳定类名。
       * @returns {Element|null}
       */
      findNotice() {
        const t = this.strainShort || this.strainText
        if (t) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let n = walker.nextNode()
          while (n) {
            if (n.nodeValue && n.nodeValue.indexOf(t) >= 0) return n.parentElement
            n = walker.nextNode()
          }
        }
        const ps = document.querySelectorAll('p')
        for (const el of ps) {
          const cls = String(el.className || '')
          if (cls.indexOf('bottom-20') >= 0 && cls.indexOf('max-w-[80%]') >= 0) return el
        }
        return null
      },

      /** 单拍采样。 */
      sample() {
        const now = performance.now()
        const v = document.querySelector('[data-testid="media-viewer"] video')
        const rec = { t: Number(now.toFixed(1)) }
        if (!v) {
          rec.hasVideo = false
          this.samples.push(rec)
          this.lastT = now
          this.lastCt = null
          return
        }
        rec.hasVideo = true
        const ct = v.currentTime
        const rate = v.playbackRate
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
        const dropped = q ? q.droppedVideoFrames : null
        const frames = q ? q.totalVideoFrames : null
        let ahead = null
        try {
          const b = v.buffered
          if (b && b.length) ahead = b.end(b.length - 1) - ct
        } catch (_e) {
          /* ignore */
        }
        const dt = this.lastT == null ? null : now - this.lastT
        const advanced = this.lastCt == null ? null : ct - this.lastCt
        const effRate =
          dt != null && dt > 0 && advanced != null
            ? advanced / (dt / 1000) / Math.max(rate, 0.01)
            : null
        const src = String(v.currentSrc || v.src || '')
        rec.ct = Number(ct.toFixed(3))
        rec.rate = rate
        rec.dt = dt == null ? null : Number(dt.toFixed(1))
        rec.advanced = advanced == null ? null : Number(advanced.toFixed(3))
        rec.effRate = effRate == null ? null : Number(effRate.toFixed(3))
        rec.dropped = dropped
        rec.frames = frames
        rec.droppedDelta = dropped != null && this.lastDropped != null ? dropped - this.lastDropped : null
        rec.ahead = ahead == null ? null : Number(ahead.toFixed(2))
        rec.readyState = v.readyState
        rec.videoWidth = v.videoWidth
        rec.paused = v.paused
        rec.notice = !!this.findNotice()
        rec.halt = !!document.querySelector(this.haltSelector)
        rec.path = src.indexOf('/stream') >= 0 ? 'stream' : src.indexOf('/raw') >= 0 ? 'raw' : 'other'
        rec.src = src
        this.lastT = now
        this.lastCt = ct
        this.lastDropped = dropped
        this.lastFrames = frames
        this.samples.push(rec)
      },

      bindEvents() {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return
        if (this._evBound === v) return
        this.unbindEvents()
        const self = this
        this._evList = ['waiting', 'stalled', 'playing', 'ratechange', 'seeked', 'error'].map((name) => {
          const f = () => {
            self.events[name] = (self.events[name] || 0) + 1
          }
          v.addEventListener(name, f)
          return [name, f]
        })
        this._evBound = v
      },
      unbindEvents() {
        if (this._evBound && this._evList) {
          for (const pair of this._evList) this._evBound.removeEventListener(pair[0], pair[1])
        }
        this._evList = null
        this._evBound = null
      },

      start() {
        this.samples = []
        const v0 = document.querySelector('[data-testid="media-viewer"] video')
        this.lastT = performance.now()
        this.lastCt = v0 ? v0.currentTime : null
        const q0 = v0 && v0.getVideoPlaybackQuality ? v0.getVideoPlaybackQuality() : null
        this.lastDropped = q0 ? q0.droppedVideoFrames : null
        this.lastFrames = q0 ? q0.totalVideoFrames : null
        this.events = { waiting: 0, stalled: 0, playing: 0, ratechange: 0, seeked: 0, error: 0 }
        this.bindEvents()
        if (this.intervalId != null) return
        this.intervalId = window.setInterval(() => {
          try {
            this.sample()
          } catch (_e) {
            /* 单拍失败不影响后续 */
          }
        }, 500)
      },
      stop() {
        if (this.intervalId != null) {
          window.clearInterval(this.intervalId)
          this.intervalId = null
        }
        this.unbindEvents()
        return this.samples.slice()
      },

      /**
       * 注入「管线饿死」：把 `currentTime` getter 的**增量**按 `scale` 缩放。
       * 期望推进 = rate×wall；报告推进 = scale×rate×wall ⇒ effRate ≈ scale。
       */
      injectStarvation(scale) {
        if (this.curPatched) return { ok: false, reason: 'already patched' }
        const found = this._findProp(HTMLMediaElement.prototype, 'currentTime')
        if (!found || !found.desc || typeof found.desc.get !== 'function') {
          return { ok: false, reason: 'currentTime getter not found' }
        }
        this._curDesc = found.desc
        this._curProto = found.owner
        const realGet = found.desc.get
        const realSet = found.desc.set
        let baseReal = null
        let baseReported = null
        Object.defineProperty(found.owner, 'currentTime', {
          configurable: true,
          enumerable: found.desc.enumerable,
          get() {
            const real = realGet.call(this)
            if (baseReal === null) {
              baseReal = real
              baseReported = real
            }
            return baseReported + (real - baseReal) * scale
          },
          set(v) {
            if (realSet) realSet.call(this, v)
          },
        })
        this.curPatched = true
        return { ok: true, scale }
      },
      revertStarvation() {
        if (!this.curPatched) return { ok: true, already: true }
        Object.defineProperty(this._curProto, 'currentTime', this._curDesc)
        this.curPatched = false
        return { ok: true }
      },

      /** 注入「视频轨解不出来」：`videoWidth` getter 恒 0。 */
      injectNoVideo() {
        if (this.vwPatched) return { ok: false, reason: 'already patched' }
        const found = this._findProp(HTMLVideoElement.prototype, 'videoWidth')
        if (!found || !found.desc) return { ok: false, reason: 'videoWidth descriptor not found' }
        this._vwDesc = found.desc
        this._vwProto = found.owner
        Object.defineProperty(found.owner, 'videoWidth', {
          configurable: true,
          enumerable: found.desc.enumerable,
          get() {
            return 0
          },
          set: found.desc.set,
        })
        this.vwPatched = true
        return { ok: true }
      },
      revertNoVideo() {
        if (!this.vwPatched) return { ok: true, already: true }
        Object.defineProperty(this._vwProto, 'videoWidth', this._vwDesc)
        this.vwPatched = false
        return { ok: true }
      },

      injectionState() {
        return { curPatched: this.curPatched, vwPatched: this.vwPatched }
      },
    }
    window.__b212 = S
    return true
  }, markers)
}

// ---------------------------------------------------------------------------
// 页面内持久探针 B：缓存卡顿（`window.__stall`）
// ---------------------------------------------------------------------------

/**
 * 安装页面内持久探针 `window.__stall`：
 *   - `install()`：幂等安装 longtask PerformanceObserver（累积到 `lt`）+ 给 fetch 打桩记录轮询刻度。
 *   - `startRvfc(v)` / `stopRvfc(v)`：开始/结束 rVFC 采集。
 *   - `snapshot()`：读取缓冲/质量/当前 src 等快照。
 * @param {object} page CDP Page
 * @returns {Promise<void>}
 */
async function installStallProbe(page) {
  await page.evaluate(() => {
    if (window.__stall && window.__stall.__v === 1) return true
    const S = {
      __v: 1,
      lt: [],
      ltErr: null,
      obs: null,
      rvfc: [],
      rvfcHandle: null,
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
          ended: v.ended,
          playbackRate: v.playbackRate,
          visibilityState: document.visibilityState,
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
// 导航 / 打开条目（复用同一个 page）
// ---------------------------------------------------------------------------

/**
 * 进入 TG 面板（点侧栏 `nav-tg`），确保 TgPanel 挂载（其 5s 轮询才会跑）。
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function enterTgPanel(page) {
  const present = await page.evaluate(() => !!document.querySelector('[data-testid="nav-tg"]'))
  if (!present) {
    return { ok: false, reason: 'nav-tg 不在场（TG 特性未就绪）⇒ 无法挂载 TgPanel' }
  }
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="nav-tg"]')
    if (btn) btn.click()
  })
  const mounted = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
      timeout: 15000,
      intervalMs: 250,
    })
    .then(() => true)
    .catch(() => false)
  return { ok: mounted, reason: mounted ? undefined : 'TgPanel 挂载信号超时' }
}

/**
 * 强制 TgPanel 重新挂载：先切到媒体库视图（卸载 TgPanel），再切回 TG（重新挂载）。
 *
 * 为什么需要：TgPanel 的 5s 轮询**只在它自己知道有活跃任务时**才跑
 * （`hasActiveTask` ← 本地 `cacheTask` ← `refreshCacheTasks()` ← 仅在挂载时跑一次）。
 * 我们是**带外**（Node HTTP）入队的，面板本地态不会自动刷新 ⇒ 若面板在「无任务」时
 * 挂载，interval 永不启动（`polls=0`），实验失效。重挂载让挂载期 `refreshCacheTasks()`
 * 看到活跃任务 → interval 启动。**结束仍在 TG 视图**。
 *
 * 注：播放器覆盖层会盖住侧栏导航，故先关闭播放器再点导航。
 * @returns {Promise<{clickedAway:boolean, clickedBack:boolean, mounted:boolean}>}
 */
async function forceTgPanelRemount(page) {
  await closeViewer(page)
  const clickedAway = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-media"]')
    if (!b) return false
    b.click()
    return true
  })
  await delay(900)
  const clickedBack = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="nav-tg"]')
    if (!b) return false
    b.click()
    return true
  })
  const mounted = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="tg-panel-root"]'), {
      timeout: 15000,
      intervalMs: 250,
    })
    .then(() => true)
    .catch(() => false)
  return { clickedAway, clickedBack, mounted }
}

/**
 * 等待 fetch 打桩记录到至少一次 `/api/tg/cache/tasks` 轮询（确认 5s interval 已启动）。
 * @returns {Promise<number>} 已记录的轮询数（超时返回已见值，可能为 0）
 */
async function waitForPoll(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let n = 0
  while (Date.now() < deadline) {
    n = await page.evaluate(() => (window.__stall ? window.__stall.polls.length : 0)).catch(() => 0)
    if (n >= 1) return n
    await delay(500)
  }
  return n
}

/**
 * 通过 store 打开一个视频条目（MediaViewer 覆盖层；与 TgPanel 是兄弟，view 保持 tg）。
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
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 15000,
    intervalMs: 200,
  })
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      v.play().catch(() => {})
    }
  })
}

async function closeViewer(page) {
  try {
    await page.evaluate(() => {
      const s = window.__origStore
      if (s && s.getState) s.getState().closeViewer()
    })
  } catch (_e) {
    /* ignore */
  }
  await delay(400)
}

/** 等待视频出帧（readyState≥2 且有尺寸）。 */
async function waitFramed(page, timeoutMs = FRAME_WAIT_MS) {
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

/** 设倍速（直接写 video.playbackRate，避免 UI 菜单的脆弱依赖）。 */
async function setRateDirect(page, rate) {
  const actual = await page.evaluate((r) => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    v.playbackRate = r
    return v.playbackRate
  }, rate)
  return { ok: actual === rate, actual }
}

/**
 * 保证播放器在场且以 **1x** 播放：viewer 不在（或被关闭）则重开条目；强制
 * `playbackRate=1` + muted + play。
 * @returns {Promise<{wasPresent:boolean, present:boolean, rate:number|null}>}
 */
async function ensurePlaying(page, item) {
  const wasPresent = await page.evaluate(
    () => !!document.querySelector('[data-testid="media-viewer"] video'),
  )
  if (!wasPresent) {
    await openItem(page, item)
    await waitFramed(page)
  }
  const info = await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return { present: false, rate: null }
    v.playbackRate = 1
    v.muted = true
    void v.play().catch(() => {})
    return { present: true, rate: v.playbackRate }
  })
  return { wasPresent, present: info.present, rate: info.rate }
}

/** 当前停载遮罩 / 提示快照（用于单点断言）。 */
async function domState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const S = window.__b212
    return {
      hasVideo: !!v,
      videoWidth: v ? v.videoWidth : null,
      readyState: v ? v.readyState : null,
      currentSrc: v ? String(v.currentSrc || v.src || '') : null,
      notice: S ? !!S.findNotice() : null,
      halt: !!document.querySelector('[data-testid="player-unsupported-halt"]'),
    }
  })
}

/** 把窗口提到前台（防 headful 窗口被遮挡导致 renderer 后台化、rVFC/掉帧降频失真）。 */
function keepFront(page, periodMs = 8000) {
  const bring = () => {
    page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})
  }
  bring()
  const h = setInterval(bring, periodMs)
  return () => clearInterval(h)
}

// ---------------------------------------------------------------------------
// BUG-212 采样窗口
// ---------------------------------------------------------------------------

/**
 * 跑一个 BUG-212 采样窗口：启动页面内探针 → Node 侧等待 → 停止并取回逐拍样本 + 事件计数。
 * @returns {Promise<{wallSecs:number, samples:Array<object>, events:object}>}
 */
async function runNoticeWindow(page, seconds) {
  await page.evaluate(() => {
    window.__b212.start()
  })
  const t0 = Date.now()
  await delay(seconds * 1000)
  const wallSecs = (Date.now() - t0) / 1000
  const out = await page.evaluate(() => ({
    samples: window.__b212.stop(),
    events: window.__b212.events,
  }))
  return { wallSecs: Number(wallSecs.toFixed(2)), samples: out.samples || [], events: out.events || {} }
}

/**
 * 汇总一个 BUG-212 窗口：丢帧% / 提示是否在场 / 提示起始点 effRate 是否持续 <0.9（真阳性 vs 误报）。
 * @param {object} w runNoticeWindow 结果
 * @returns {object}
 */
function summarizeNoticeWindow(w) {
  const samples = (w.samples || []).filter((s) => s.hasVideo)
  const first = samples[0] || null
  const last = samples[samples.length - 1] || null
  const droppedDelta =
    first && last && first.dropped != null && last.dropped != null ? last.dropped - first.dropped : null
  const framesDelta =
    first && last && first.frames != null && last.frames != null ? last.frames - first.frames : null
  const droppedPct =
    framesDelta != null && framesDelta > 0 && droppedDelta != null
      ? Number(((100 * droppedDelta) / framesDelta).toFixed(1))
      : null
  const aheadVals = samples.map((s) => s.ahead).filter((a) => a != null)
  const aheadMin = aheadVals.length ? Number(Math.min(...aheadVals).toFixed(2)) : null

  const noticeIdx = samples.findIndex((s) => s.notice)
  const noticePresent = noticeIdx >= 0
  let onset = null
  if (noticePresent) {
    const lo = Math.max(0, noticeIdx - STRAIN_STREAK)
    const win = samples.slice(lo, noticeIdx + 1)
    const effs = win.map((s) => s.effRate)
    const starveCount = effs.filter((e) => e != null && e < EFF_RATE_MIN).length
    const whileNotice = samples.slice(noticeIdx).map((s) => s.effRate).filter((e) => e != null)
    onset = {
      at: samples[noticeIdx].t,
      sampleIndex: noticeIdx,
      windowEffRates: effs,
      starveCount,
      windowSize: win.length,
      sustainedStarve: starveCount >= STRAIN_STREAK,
      whileNoticeEffMax: whileNotice.length ? Number(Math.max(...whileNotice).toFixed(3)) : null,
    }
  }

  const paths = {}
  for (const s of samples) paths[s.path] = (paths[s.path] || 0) + 1
  const lastSample = samples[samples.length - 1] || null

  /*
   * 提示时间线：`noticePresent` 只表示「窗内**出现过**提示」，不能用于「是否已撤销」的断言
   * —— 还原窗口起始时提示本就还挂着（刚注入过），若拿「窗内出现过」当判据，即便它在
   * calmStreak（~2s）内已撤销，也会被误判为失败。故补 `noticeLastSeenIndex`（最后一次
   * 出现所在拍）与 `noticeAtEnd`（末拍是否仍挂着），「已撤销」以末拍为准。
   */
  const noticeTimeline = samples.map((s) => (s.notice ? 1 : 0))
  let noticeLastSeenIndex = -1
  for (let i = 0; i < samples.length; i++) if (samples[i].notice) noticeLastSeenIndex = i
  const noticeAtEnd = samples.length ? !!samples[samples.length - 1].notice : false

  return {
    wallSecs: w.wallSecs,
    sampleCount: samples.length,
    droppedDelta,
    framesDelta,
    droppedPct,
    aheadMin,
    noticePresent,
    noticeTimeline,
    noticeLastSeenIndex,
    noticeAtEnd,
    onset,
    classification: noticePresent ? (onset && onset.sustainedStarve ? 'true-positive' : 'false-positive') : 'absent',
    paths,
    videoWidth: lastSample ? lastSample.videoWidth : null,
    readyState: lastSample ? lastSample.readyState : null,
    currentSrc: lastSample ? lastSample.src : null,
    rateObserved: lastSample ? lastSample.rate : null,
    pausedSamples: samples.filter((s) => s.paused).length,
    events: w.events,
  }
}

// ---------------------------------------------------------------------------
// 缓存卡顿采样（阶段 6）
// ---------------------------------------------------------------------------

/**
 * 建一个到 TG origin 的请求采集器（CDP `Network` 域）——连接池争抢维度。
 * @param {object} page CDP Page
 * @param {string} tgOrigin TG origin
 * @returns {{enable:Function, reset:Function, snapshot:Function}}
 */
function createNetworkCollector(page, tgOrigin) {
  const inflight = new Map()
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
      bytes: 0,
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
    settle(p.requestId, { tEnd: Number(p.timestamp || 0), bytes: Number(p.encodedDataLength || 0) })
  })
  page.conn.on('Network.loadingFailed', (p) => {
    settle(p.requestId, { tEnd: Number(p.timestamp || 0), failed: true, bytes: 0 })
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

/** 连接池争抢分析。 */
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
  const afterPoll = pollTs.map((p) => {
    let m = inflightCountAt(timeline, p)
    for (const ev of timeline) {
      if (ev.t > p && ev.t <= p + 1) m = Math.max(m, ev.c)
    }
    return m
  })

  const isMediaItemsStream = (url) =>
    url.includes('/api/media/items/') && (url.includes('/raw') || url.includes('/stream'))
  const playerReqs = reqs.filter(
    (r) =>
      isMediaItemsStream(r.url) ||
      r.url.includes('/api/tg/local/') ||
      r.url.includes('/api/tg/file/'),
  )
  const playerRaw = reqs.filter((r) => r.url.includes(`/api/media/items/${playingItem}/raw`))
  const feedPoster = reqs.filter(
    (r) => isMediaItemsStream(r.url) && !r.url.includes(`/api/media/items/${playingItem}/`),
  )
  const thumbs = reqs.filter((r) => r.url.includes('/api/tg/thumb/'))

  return {
    tgRequestCount: reqs.length,
    maxConcurrent: max,
    pollRequestCount: polls.length,
    playerRequestCount: playerReqs.length,
    playerRawCount: playerRaw.length,
    playerRawBytes: playerRaw.reduce((a, r) => a + Number(r.bytes || 0), 0),
    feedPosterRequestCount: feedPoster.length,
    thumbRequestCount: thumbs.length,
    totalBytes: reqs.reduce((a, r) => a + Number(r.bytes || 0), 0),
    maxConcurrentAfterPoll: afterPoll.length ? Math.max(...afterPoll) : 0,
    sampleUrls: reqs.slice(0, 12).map((r) => r.url.replace(net.tgOrigin, '')),
  }
}

/** 连接池争抢判据。 */
function networkVerdict(c) {
  if (c.tgRequestCount === 0) {
    return { verdict: 'inconclusive', reason: '窗口内到 TG origin 零请求' }
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

/** 把 longtask 的 startTime 按 `t mod 5000` 折叠成 20 个 250ms 桶。 */
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
  const clustered = n >= 6 && max >= Math.max(3, expected * 2)
  const span = maxBucket >= 0 ? `${maxBucket * BUCKET_MS}-${(maxBucket + 1) * BUCKET_MS}ms` : '-'
  return { buckets, max, maxBucket, expected, clustered, span }
}

/** 轮询节拍统计：相邻两次 `/api/tg/cache/tasks*` 发起时刻的间隔中位数。 */
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

/** **决定性的对齐判据**：把每个 longtask 锚到它之前最近一次轮询，统计「紧随轮询之后」的比例。 */
function pollAnchoredAnalysis(lt, polls, alignWindowMs = ALIGN_WINDOW_MS) {
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
  return { pollCount: ts.length, matched, within, withinRatio: ratio, alignWindowMs, delays }
}

/** 计算 rVFC 间隔序列，并把每个 longtask 与「其覆盖区间内的 rVFC 缺口（>GAP_MS）」关联。 */
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
  return { intervals, maxGap: Number(maxGap.toFixed(1)), gapCount, ltWithGap, ltTotal: lt.length }
}

/** 计算「呈现帧率 / 丢帧%」，来自 getVideoPlaybackQuality 前后差。 */
function qualityStats(snap0, snap1, wallSecs) {
  if (!snap0 || !snap1 || !snap0.hasVideo || !snap1.hasVideo) {
    return { totalDelta: null, droppedDelta: null, droppedPct: null, presentedFps: null }
  }
  const totalDelta = (snap1.frames || 0) - (snap0.frames || 0)
  const droppedDelta = (snap1.dropped || 0) - (snap0.dropped || 0)
  const droppedPct = totalDelta > 0 ? Number(((100 * droppedDelta) / totalDelta).toFixed(1)) : null
  const presentedFps = wallSecs > 0 ? Number((totalDelta / wallSecs).toFixed(1)) : null
  return { totalDelta, droppedDelta, droppedPct, presentedFps }
}

/** 读 store 里 daemon/orig-core 下载的活跃数（混杂控制）。 */
async function probeDaemonDownloads(page) {
  return page.evaluate(() => {
    try {
      const st = window.__origStore.getState()
      const ds = Array.isArray(st.downloads) ? st.downloads : []
      const active = ds.filter((d) => d && (d.status === 'downloading' || d.status === 'queued'))
      return { ok: true, total: ds.length, active: active.length, activeStatuses: active.map((d) => String(d.status)) }
    } catch (e) {
      return { ok: false, total: 0, active: 0, activeStatuses: [], err: String((e && e.message) || e) }
    }
  })
}

/**
 * 汇总一个缓存卡顿窗口。
 * @param {object} w measureStallWindow 结果
 * @returns {object}
 */
function summarizeStallWindow(w) {
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
  const anchoredAligned =
    anchored.pollCount >= 2 && anchored.withinRatio != null && anchored.withinRatio >= 0.5
  return {
    wallSecs: w.wallSecs,
    rvfcSupported: w.rvfcOk,
    longtaskCount: lt.length,
    longtaskMaxMs: maxLt,
    longtaskTotalMs: Number(lt.reduce((a, e) => a + e.dur, 0).toFixed(1)),
    phaseClustered: hist.clustered,
    phaseMaxBucket: hist.maxBucket,
    phaseMaxCount: hist.max,
    phaseSpan: hist.span,
    phaseBuckets: hist.buckets,
    pollCount: cadence.count,
    pollMedianMs: cadence.medianMs,
    pollKinds: cadence.kinds,
    alignedWithin: anchored.within,
    alignedMatched: anchored.matched,
    alignedRatio: anchored.withinRatio,
    alignedDelays: anchored.delays,
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
    currentSrc: w.snap1 ? w.snap1.src || '' : '',
    net: w.netAnalysis || null,
    netVerdict: w.netAnalysis ? networkVerdict(w.netAnalysis) : null,
    playbackValid: !!(w.snap1 && w.snap1.hasVideo) && !(w.snap1 && w.snap1.ended),
    endPlaybackRate: w.snap1 && w.snap1.hasVideo ? w.snap1.playbackRate : null,
    endVisibility: w.snap1 && w.snap1.hasVideo ? w.snap1.visibilityState : null,
    endCurrentTime: w.snap1 && w.snap1.hasVideo ? Number(w.snap1.currentTime.toFixed(2)) : null,
    ltErr: w.ltErr,
  }
}

// ---------------------------------------------------------------------------
// 缓存任务保活驱动（吸收原 _b_keepalive.cjs 的逻辑）
// ---------------------------------------------------------------------------

/** 从 `GET /api/tg/stored` 拉一批 5–40MB、未缓存、未用过的 id。 */
async function loadPool(usedIds) {
  const { json } = await httpJson('GET', `${TG}/api/tg/stored?type=video&downloaded=0&limit=300`)
  const items = (json && json.items) || []
  return items
    .filter((i) => i && typeof i.size === 'number' && i.size >= MIN_BYTES && i.size <= MAX_BYTES)
    .map((i) => i.messageId)
    .filter((id) => !usedIds.has(id))
}

/**
 * 建一个「缓存任务保活」驱动：每 tick 检查领先批次数，不足即续排下一批（首批 = BATCH1）。
 * 目的：确保整段 60s 窗口内库内**始终存在活跃缓存任务**（「缓存中」条件）。
 * @returns {{tick:Function, taskIds:number[], timeline:Array<object>}}
 */
function createCacheKeepalive() {
  const usedIds = new Set(BATCH1)
  const taskIds = []
  const timeline = []
  let batch1Used = false
  let pool = null
  let poolCursor = 0

  async function tick() {
    const { status, json } = await httpJson('GET', `${TG}/api/tg/cache/tasks`)
    const task = (json && json.task) || null
    const queued = (json && json.queued) || []
    const running = task && (task.status === 'running' || task.status === 'queued')
    const ahead = (running ? 1 : 0) + queued.length
    timeline.push({
      t: Date.now(),
      http: status,
      status: task ? task.status : 'none',
      ahead,
    })
    if (ahead >= DESIRED_AHEAD) return
    let ids
    if (!batch1Used) {
      batch1Used = true
      ids = BATCH1.slice()
    } else {
      if (!pool) {
        pool = await loadPool(usedIds)
        timeline.push({ t: Date.now(), action: 'POOL_LOADED', eligible: pool.length })
      }
      ids = []
      while (ids.length < BATCH_SIZE && poolCursor < pool.length) {
        const id = pool[poolCursor++]
        if (!usedIds.has(id)) {
          usedIds.add(id)
          ids.push(id)
        }
      }
    }
    if (!ids || !ids.length) {
      timeline.push({ t: Date.now(), action: 'POOL_EXHAUSTED' })
      return
    }
    const res = await httpJson('POST', `${TG}/api/tg/cache/tasks`, {
      chatId: STALL_CHAT_ID,
      messageIds: ids,
    })
    if (res.status >= 200 && res.status < 300 && res.json && res.json.id != null) {
      taskIds.push(res.json.id)
      timeline.push({ t: Date.now(), action: 'ENQUEUE', id: res.json.id, n: ids.length, status: res.json.status })
    } else {
      timeline.push({ t: Date.now(), action: 'ENQUEUE_FAILED', http: res.status })
    }
  }

  return { tick, taskIds, timeline }
}

/**
 * 跑一个缓存卡顿窗口：启动 longtask/rVFC 采集 → 在 Node 侧按 `seconds` 等待（期间运行 keepalive）
 * → 停止并取回 longtask/rVFC/轮询刻度/快照。
 * @param {object} page CDP Page
 * @param {number} seconds 窗口秒数
 * @param {object|null} collector 网络采集器
 * @param {number} playingItem 正在播放的条目 id
 * @param {object} keepalive createCacheKeepalive 的返回
 * @returns {Promise<object>}
 */
async function measureStallWindow(page, seconds, collector, playingItem, keepalive) {
  if (collector) collector.reset()
  const started = await page.evaluate(() => {
    const S = window.__stall
    if (!S) return { ok: false }
    S.install()
    S.lt.length = 0
    S.polls.length = 0
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const rvfcOk = S.startRvfc(v)
    return { ok: true, rvfcOk, snap0: S.snapshot(), ltErr: S.ltErr }
  })

  const t0 = Date.now()
  const deadline = t0 + seconds * 1000
  while (Date.now() < deadline) {
    try {
      await keepalive.tick()
    } catch (_e) {
      /* 单次 tick 失败不影响窗口 */
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(KEEPALIVE_TICK_MS, remaining))
  }
  const wallSecs = (Date.now() - t0) / 1000

  const out = await page.evaluate(() => {
    const S = window.__stall
    const v = document.querySelector('[data-testid="media-viewer"] video')
    const rvfc = S.stopRvfc(v)
    return { lt: S.lt.slice(), rvfc, polls: S.polls.slice(), snap1: S.snapshot(), ltErr: S.ltErr }
  })

  const w = {
    wallSecs: Number(wallSecs.toFixed(2)),
    rvfcOk: started.rvfcOk,
    ltErr: out.ltErr || started.ltErr || null,
    snap0: started.snap0,
    snap1: out.snap1,
    lt: out.lt,
    rvfc: out.rvfc,
    polls: out.polls || [],
  }
  if (collector) {
    const net = collector.snapshot()
    w.net = net
    w.netAnalysis = concurrencyAnalysis(net, playingItem)
  }
  return w
}

// ---------------------------------------------------------------------------
// 判据 / 阶段结果收集
// ---------------------------------------------------------------------------

/** @type {Array<{name:string, pass:boolean, detail:string}>} */
const checks = []
/** @type {Array<object>} */
const stages = []
/** 主结果容器（main 里填充）。 */
const results = {
  startedAt: new Date().toISOString(),
  appUrl: APP_URL,
  tgUrl: TG,
  item: ITEM,
  itemHevc: ITEM_HEVC,
  stages: [],
  checks,
  phases: {},
  guard: null,
  cacheStats: {},
  keepaliveTimeline: [],
  cancelResults: [],
  pageErrors: [],
  consoleErrors: [],
}

/**
 * 记录一条判据。
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' })
  console.log(`   · ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

/**
 * 运行一个阶段：打印开始行 → 执行（带硬超时）→ 打印结束行。
 * @param {number} idx 阶段序号
 * @param {string} title 在测什么
 * @param {Function} fn 阶段体，返回 `{verdict, detail, metrics}`
 * @param {number} timeoutMs 硬超时
 * @returns {Promise<object>}
 */
async function runStage(idx, title, fn, timeoutMs) {
  stageStart(idx, TOTAL_STAGES, title)
  const t0 = Date.now()
  let res
  try {
    res = await withTimeout(fn(), timeoutMs, title)
  } catch (e) {
    res = { verdict: 'FAIL', detail: `异常/超时：${(e && e.message) || e}`, metrics: {} }
  }
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1))
  const out = {
    idx,
    title,
    verdict: res.verdict,
    detail: res.detail,
    metrics: res.metrics || {},
    seconds: secs,
  }
  stages.push(out)
  results.stages = stages
  stageEnd(idx, TOTAL_STAGES, title, res.verdict, res.detail, secs)
  return out
}

/** 截图到 OUT（失败不致命）。 */
async function shot(page, name) {
  const f = path.join(OUT, name)
  try {
    await page.screenshot(f)
    return f
  } catch (e) {
    console.log(`   · 截图 ${name} 失败：${(e && e.message) || e}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 各阶段实现
// ---------------------------------------------------------------------------

/** [0/7] 环境与自证。 */
async function stageEnv(page) {
  stageStart(0, TOTAL_STAGES, '环境与自证：探活 + headful 自证 + 确认落在 TG 视图')
  const t0 = Date.now()
  const fe = await httpStatus(APP_URL, 3000)
  const be = await httpStatus(TG, 3000)
  console.log(`   · 探活：前端 ${APP_URL} -> ${fe}；后端 ${TG} -> ${be}`)
  if (fe === 0 || be === 0) {
    throw new Error(`环境不可达（frontend=${fe}, backend=${be}）`)
  }

  const userAgent = String(await page.evaluate(() => navigator.userAgent))
  const headful = !/HeadlessChrome/i.test(userAgent)
  results.userAgent = userAgent
  results.headful = headful
  console.log(`   · UA：${userAgent}`)
  console.log(`   · headful 自证：${headful}（UA ${headful ? '不含' : '含'} HeadlessChrome）`)

  const refreshHz = await page.evaluate(async () => {
    let count = 0
    const t0 = performance.now()
    await new Promise((resolve) => {
      const tick = () => {
        count += 1
        if (performance.now() - t0 >= 2000) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return count / ((performance.now() - t0) / 1000)
  })
  results.refreshHz = Number(Number(refreshHz).toFixed(1))
  console.log(`   · 落屏刷新率 ≈ ${results.refreshHz} Hz (rAF, headful)`)

  const tgEnter = await enterTgPanel(page)
  results.tgEnter = tgEnter
  console.log(`   · 进入 TG 面板：ok=${tgEnter.ok}${tgEnter.reason ? ' reason=' + tgEnter.reason : ''}`)

  await shot(page, '00_tg_view.png')

  check('前端可达（5180）', fe !== 0, `http=${fe}`)
  check('后端可达（19787）', be !== 0, `http=${be}`)
  check('本次为 headful（UA 不含 HeadlessChrome）', headful, userAgent)
  check('TgPanel 已挂载（5s 轮询前置条件）', tgEnter.ok, tgEnter.reason || 'mounted')

  const verdict = fe !== 0 && be !== 0 && headful && tgEnter.ok ? 'PASS' : 'FAIL'
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1))
  stages.push({
    idx: 0,
    title: '环境与自证',
    verdict,
    detail: `5180=${fe} 19787=${be} headful=${headful} tgPanel=${tgEnter.ok}`,
    metrics: { fe, be, headful, refreshHz: results.refreshHz },
    seconds: secs,
  })
  results.stages = stages
  stageEnd(0, TOTAL_STAGES, '环境与自证：探活 + headful 自证 + 确认落在 TG 视图', verdict, `5180=${fe} 19787=${be} headful=${headful}`, secs)
  return { verdict }
}

/** [1/7] BUG-212 C1：${ITEM}@2x 不误报。 */
async function stageC1(page) {
  await closeViewer(page)
  await openItem(page, ITEM)
  const framed = await waitFramed(page)
  const set2 = await setRateDirect(page, 2)
  await delay(WARMUP_MS)
  const w = await runNoticeWindow(page, STRAIN_WINDOW_SEC)
  const s = summarizeNoticeWindow(w)
  results.phases.C1 = s
  await shot(page, `C1_item${ITEM}_2x.png`)

  let verdict = 'FAIL'
  let detail = ''
  if (s.noticePresent && s.onset && s.onset.sustainedStarve) {
    verdict = 'PASS'
    detail = `提示出现但为真阳性（effRate 持续 <0.9）；丢帧 ${s.droppedPct}%`
  } else if (s.noticePresent) {
    verdict = 'FAIL'
    detail = `误报：提示在 effRate≈1 时出现；丢帧 ${s.droppedPct}%`
  } else if (s.droppedDelta != null && s.droppedDelta > 0) {
    verdict = 'PASS'
    detail = `丢帧 ${s.droppedPct}% 期间提示未出现（2x）`
  } else {
    verdict = 'PASS'
    detail = `提示未出现；本窗未观察到丢帧（dropped=${s.droppedDelta}）⇒ 弱通过`
  }
  check(`C1 ${ITEM}@2x 不误报`, verdict === 'PASS', detail)
  check(`C1 倍速生效（playbackRate=2）`, set2.ok === true, `actual=${set2.actual}`)
  return {
    verdict,
    detail,
    metrics: {
      framed,
      droppedPct: s.droppedPct,
      droppedDelta: s.droppedDelta,
      noticePresent: s.noticePresent,
      classification: s.classification,
      rateActual: set2.actual,
    },
  }
}

/** [2/7] BUG-212 C2：${ITEM}@1x 干净。 */
async function stageC2(page) {
  await closeViewer(page)
  await openItem(page, ITEM)
  const framed = await waitFramed(page)
  await setRateDirect(page, 1)
  await delay(WARMUP_MS)
  const w = await runNoticeWindow(page, CLEAN_WINDOW_SEC)
  const s = summarizeNoticeWindow(w)
  results.phases.C2 = s
  await shot(page, `C2_item${ITEM}_1x.png`)

  const cleanNoNotice = !s.noticePresent
  const zeroDrop = s.droppedDelta === 0
  const verdict = framed && cleanNoNotice && zeroDrop ? 'PASS' : 'FAIL'
  const detail = `丢帧 ${s.droppedPct}%（Δ${s.droppedDelta}）提示${s.noticePresent ? '出现' : '未出现'}`
  check(`C2 ${ITEM}@1x 提示不出现（干净基线）`, framed && cleanNoNotice, detail)
  check(`C2 ${ITEM}@1x 丢帧为 0%`, zeroDrop, `droppedDelta=${s.droppedDelta}`)
  return { verdict, detail, metrics: { framed, droppedPct: s.droppedPct, droppedDelta: s.droppedDelta, noticePresent: s.noticePresent } }
}

/** [3/7] BUG-212 C3：${ITEM_HEVC}@4x 不误报。 */
async function stageC3(page) {
  await closeViewer(page)
  await openItem(page, ITEM_HEVC)
  const framedHevc = await waitFramed(page)
  const set4 = await setRateDirect(page, 4)
  await delay(WARMUP_MS)
  const w = await runNoticeWindow(page, STRAIN_WINDOW_SEC)
  const s = summarizeNoticeWindow(w)
  results.phases.C3 = s
  await shot(page, `C3_item${ITEM_HEVC}_4x.png`)

  let verdict = 'FAIL'
  let detail = ''
  if (!framedHevc && s.videoWidth === 0) {
    verdict = 'NOT-COVERABLE'
    detail = `${ITEM_HEVC} 在本机未出帧（videoWidth=0）⇒ 4x 误报场景无法覆盖`
  } else if (s.noticePresent && s.onset && s.onset.sustainedStarve) {
    verdict = 'PASS'
    detail = `提示出现但为真阳性（effRate 持续 <0.9）；丢帧 ${s.droppedPct}%`
  } else if (s.noticePresent) {
    verdict = 'FAIL'
    detail = `误报：提示在 effRate≈1 时出现；丢帧 ${s.droppedPct}%`
  } else if (s.droppedDelta != null && s.droppedDelta > 0) {
    verdict = 'PASS'
    detail = `丢帧 ${s.droppedPct}% 期间提示未出现（4x，path=${JSON.stringify(s.paths)}）`
  } else {
    verdict = 'PASS'
    detail = `提示未出现；本窗未观察到丢帧（dropped=${s.droppedDelta}）⇒ 弱通过`
  }
  check(`C3 ${ITEM_HEVC}@4x 不误报`, verdict !== 'FAIL', detail)
  check(`C3 倍速生效（playbackRate=4）`, set4.ok === true, `actual=${set4.actual}`)
  return {
    verdict,
    detail,
    metrics: { framed: framedHevc, videoWidth: s.videoWidth, droppedPct: s.droppedPct, noticePresent: s.noticePresent, classification: s.classification, rateActual: set4.actual, paths: s.paths },
  }
}

/** [4/7] BUG-212 C4：反向证伪（注入「管线饿死」⇒ 提示必须出现；还原后撤销）。 */
async function stageC4(page) {
  await closeViewer(page)
  await openItem(page, ITEM)
  await waitFramed(page)
  await setRateDirect(page, 1)
  await delay(WARMUP_MS)

  const pre = await domState(page)
  check('C4 注入前提示不在场（干净基线）', pre.notice === false, `notice=${pre.notice}`)

  const inj = await page.evaluate((scale) => window.__b212.injectStarvation(scale), STARVE_SCALE)
  console.log(`   · injectStarvation -> ${JSON.stringify(inj)}`)
  check('C4 注入成功（currentTime getter 已打桩）', !!(inj && inj.ok), JSON.stringify(inj))

  const wInj = await runNoticeWindow(page, INJECT_SEC)
  const sInj = summarizeNoticeWindow(wInj)
  results.phases.C4_inject = sInj
  await shot(page, 'C4_injected_starve.png')
  console.log(
    `   · 注入窗口：提示=${sInj.noticePresent} 分类=${sInj.classification} onsetEffRates=${JSON.stringify(sInj.onset && sInj.onset.windowEffRates)}`,
  )
  check('C4 注入「管线饿死」⇒ 提示必须出现（判据是活的）', sInj.noticePresent === true, `notice=${sInj.noticePresent}`)
  check('C4 提示出现是真阳性（onset 邻域 effRate 持续 <0.9）', !!(sInj.onset && sInj.onset.sustainedStarve), `onsetEffRates=${JSON.stringify(sInj.onset && sInj.onset.windowEffRates)}`)

  const rev = await page.evaluate(() => window.__b212.revertStarvation())
  const stAfterRev = await page.evaluate(() => window.__b212.injectionState())
  console.log(`   · revertStarvation -> ${JSON.stringify(rev)} state=${JSON.stringify(stAfterRev)}`)
  check('C4 打桩已还原（curPatched=false）', stAfterRev.curPatched === false, JSON.stringify(stAfterRev))

  const wRec = await runNoticeWindow(page, RECOVER_SEC)
  const sRec = summarizeNoticeWindow(wRec)
  results.phases.C4_recover = sRec
  await shot(page, 'C4_recovered.png')
  // 「已撤销」以**末拍**为准（见 summarizeNoticeWindow 的提示时间线注释）：
  // 撤销时间 = (noticeLastSeenIndex+1) × 采样拍(500ms)，须落在 calmStreak(~2s) + 采样相位余量内。
  const recoverCleared = sRec.noticeAtEnd === false && sRec.noticeLastSeenIndex <= 6
  const clearedAtSec =
    sRec.noticeLastSeenIndex < 0
      ? 0
      : Number((((sRec.noticeLastSeenIndex + 1) * SAMPLE_MS) / 1000).toFixed(1))
  console.log(
    `   · 还原窗口：提示时间线=${JSON.stringify(sRec.noticeTimeline)} 末拍提示=${sRec.noticeAtEnd} 撤销于≈${clearedAtSec}s`,
  )
  check(
    'C4 还原后提示在 calmStreak（~2s）内撤销',
    recoverCleared,
    `末拍提示=${sRec.noticeAtEnd} 撤销于≈${clearedAtSec}s（最后出现拍#${sRec.noticeLastSeenIndex}）`,
  )

  const pass =
    pre.notice === false &&
    !!(inj && inj.ok) &&
    sInj.noticePresent === true &&
    stAfterRev.curPatched === false &&
    recoverCleared
  return {
    verdict: pass ? 'PASS' : 'FAIL',
    detail: `注入后提示=${sInj.noticePresent}（真阳性=${!!(sInj.onset && sInj.onset.sustainedStarve)}），还原后提示撤销于≈${clearedAtSec}s`,
    metrics: {
      injectOk: !!(inj && inj.ok),
      noticeAfterInject: sInj.noticePresent,
      sustainedStarve: !!(sInj.onset && sInj.onset.sustainedStarve),
      curPatchedAfterRevert: stAfterRev.curPatched,
      noticeAfterRecover: sRec.noticeAtEnd,
      recoverClearedAtSec: clearedAtSec,
      noticeTimeline: sRec.noticeTimeline,
    },
  }
}

/** [5/7] BUG-212 C5：unsupported 回归（注入 videoWidth=0 ⇒ 停载遮罩出现；还原）。 */
async function stageC5(page) {
  await closeViewer(page)
  await openItem(page, ITEM)
  await waitFramed(page)
  await setRateDirect(page, 1)
  await delay(600)

  const pre = await domState(page)
  check('C5 注入前停载遮罩不在场', pre.halt === false, `halt=${pre.halt}`)

  const inj = await page.evaluate(() => window.__b212.injectNoVideo())
  console.log(`   · injectNoVideo -> ${JSON.stringify(inj)}`)
  check('C5 注入成功（videoWidth getter 已打桩为 0）', !!(inj && inj.ok), JSON.stringify(inj))

  const haltAppeared = await page
    .waitForFunction(() => !!document.querySelector('[data-testid="player-unsupported-halt"]'), {
      timeout: HALT_WAIT_MS,
      intervalMs: 250,
    })
    .then(() => true)
    .catch(() => false)
  await shot(page, 'C5_unsupported_halt.png')
  check('C5 注入 videoWidth=0 ⇒ BUG-207 停载遮罩出现（unsupported 未受影响）', haltAppeared, `halt=${haltAppeared}`)

  const rev = await page.evaluate(() => window.__b212.revertNoVideo())
  const stAfterRev = await page.evaluate(() => window.__b212.injectionState())
  console.log(`   · revertNoVideo -> ${JSON.stringify(rev)} state=${JSON.stringify(stAfterRev)}`)
  check('C5 打桩已还原（vwPatched=false）', stAfterRev.vwPatched === false, JSON.stringify(stAfterRev))

  const pass = pre.halt === false && !!(inj && inj.ok) && haltAppeared && stAfterRev.vwPatched === false
  return {
    verdict: pass ? 'PASS' : 'FAIL',
    detail: `注入后停载遮罩=${haltAppeared}，还原后 vwPatched=${stAfterRev.vwPatched}`,
    metrics: { injectOk: !!(inj && inj.ok), haltAppeared, vwPatchedAfterRevert: stAfterRev.vwPatched },
  }
}

/**
 * [6/7] 缓存卡顿与 5s 节拍对齐。
 * 自造「缓存中」条件（POST BATCH1 + keepalive 续排），60s 窗口观测 longtask/poll/rVFC/质量/缓冲。
 */
async function stageStall(page, collector) {
  // 留在 TG 视图（切到媒体库会卸载 TgPanel，5s 轮询消失）
  const tgNow = await page.evaluate(() => !!document.querySelector('[data-testid="tg-panel-root"]'))
  if (!tgNow) {
    const re = await enterTgPanel(page)
    console.log(`   · 重新进入 TG 面板：ok=${re.ok}`)
  }

  // 安装 longtask/rVFC/fetch 打桩探针（须在入队前装好，才能记录 5s 轮询真实刻度）
  await installStallProbe(page)
  const ltSupported = await page.evaluate(() => !window.__stall.ltErr)
  check('PerformanceObserver longtask 可用', ltSupported, String(await page.evaluate(() => window.__stall.ltErr)))

  // 混杂控制：纯 TG 缓存要求 daemon 下载活跃数为 0
  const daemonAtStart = await probeDaemonDownloads(page)
  console.log(`   · daemon 下载（混杂控制）：active=${daemonAtStart.active}`)
  check('纯 TG 缓存前提：无活跃 daemon 下载', daemonAtStart.active === 0, `active=${daemonAtStart.active}`)

  // 入队前缓存占用
  const statsBefore = await httpJson('GET', `${TG}/api/cache/stats`)
  results.cacheStats.before = statsBefore.json || null
  console.log(`   · 缓存占用（前）：${JSON.stringify(statsBefore.json)}`)

  // ---- 自造「缓存中」：入队 BATCH1，立即断言非终态；若秒变 done 则续排直到撑满窗口 ----
  const ka = createCacheKeepalive()
  let activeNow = false
  let initialStatus = null
  for (let i = 0; i < 6 && !activeNow; i++) {
    await ka.tick()
    await delay(600)
    const g = await httpJson('GET', `${TG}/api/tg/cache/tasks`)
    const t = g.json && g.json.task
    initialStatus = t ? t.status : null
    activeNow = initialStatus === 'running' || initialStatus === 'queued'
    console.log(`   · 入队尝试 #${i + 1}：task.status=${initialStatus} active=${activeNow}`)
  }
  check('「缓存中」条件已造出（task.status 非终态）', activeNow, `status=${initialStatus}`)
  console.log(`   · 已入队任务 id：${JSON.stringify(ka.taskIds)}`)

  /*
   * 关键（本次实测踩到的坑）：TgPanel 的 5s 轮询**只在它自己知道有活跃任务时**才跑。
   * 我们是带外（Node HTTP）入队的，面板本地态不会自动刷新 ⇒ 若面板在「无任务」时挂载，
   * interval 永不启动（polls=0），实验失效。故**重挂载** TgPanel（切走再切回），让挂载期
   * `refreshCacheTasks()` 看到活跃任务 → interval 启动。实验结束仍在 TG 视图。
   */
  const remount = await forceTgPanelRemount(page)
  const pollStarted = await waitForPoll(page, 12000)
  console.log(
    `   · TgPanel 重挂载：away=${remount.clickedAway} back=${remount.clickedBack} mounted=${remount.mounted}；已记录轮询=${pollStarted}`,
  )
  check('TgPanel 5s 轮询已启动（fetch 打桩记录到轮询）', pollStarted >= 1, `polls=${pollStarted}`)

  // 打开长条目 607 并以 1x 播放（面板保持挂载：viewer 是覆盖层，与 TgPanel 是兄弟）
  await openItem(page, ITEM)
  const framed = await waitFramed(page)
  const play = await ensurePlaying(page, ITEM)
  console.log(`   · 播放器：framed=${framed} present=${play.present} rate=${play.rate}`)
  check(`长条目 ${ITEM} 打开并出帧`, framed && play.present, `framed=${framed} rate=${play.rate}`)

  // 60s 窗口（keepalive 在窗口内持续续排）
  const stopFront = keepFront(page)
  const w = await measureStallWindow(page, STALL_WINDOW_SEC, collector, ITEM, ka)
  stopFront()
  const s = summarizeStallWindow(w)
  results.phases.stall = s
  results.keepaliveTimeline = ka.timeline
  await shot(page, '60_cache_stall_window.png')
  console.log(
    `   · 窗口：longtask ${s.longtaskCount}（max ${s.longtaskMaxMs}ms）| 轮询 ${s.pollCount}（中位 ${s.pollMedianMs}ms）|` +
      ` 紧随轮询≤${ALIGN_WINDOW_MS}ms ${s.alignedWithin}/${s.longtaskCount}（ratio ${s.alignedRatio}）|` +
      ` 相位聚集=${s.phaseClustered}（桶#${s.phaseMaxBucket} ${s.phaseSpan}）| rVFC maxGap ${s.rvfcMaxGapMs}ms |` +
      ` 丢帧 ${s.droppedPct}% | bufferedMin ${s.bufferedAheadMin}s | path ${s.path}`,
  )

  // 收尾：取消所有本次入队任务 + 取收尾后缓存占用
  for (const id of ka.taskIds) {
    const r = await httpJson('DELETE', `${TG}/api/tg/cache/tasks/${id}`)
    results.cancelResults.push({ id, http: r.status, json: r.json })
  }
  console.log(`   · 取消结果：${JSON.stringify(results.cancelResults)}`)
  await delay(1500)
  const statsAfter = await httpJson('GET', `${TG}/api/cache/stats`)
  results.cacheStats.after = statsAfter.json || null
  console.log(`   · 缓存占用（后）：${JSON.stringify(statsAfter.json)}`)

  // 判据（提前认下，照此判）
  const ltCount = s.longtaskCount
  let verdict
  let detail
  if (ltCount === 0) {
    verdict = 'PASS'
    detail = `长任务 0 ⇒ 前端不构成可测阻塞（轮询 ${s.pollCount} 次，中位 ${s.pollMedianMs}ms）`
  } else if (s.alignedRatio != null && s.alignedRatio >= 0.5 && s.phaseClustered) {
    verdict = 'FAIL'
    detail = `前端 5s 重渲染坐实：longtask ${s.alignedWithin}/${ltCount} 紧随轮询（ratio ${s.alignedRatio}）且相位聚集`
  } else if (s.alignedRatio != null && s.alignedRatio >= 0.5) {
    verdict = 'FAIL'
    detail = `longtask ${s.alignedWithin}/${ltCount} 紧随轮询（ratio ${s.alignedRatio}，≥0.5）⇒ 与 5s 节拍对齐`
  } else {
    verdict = 'PASS'
    detail = `longtask 与 5s 轮询不对齐（ratio ${s.alignedRatio}，相位聚集=${s.phaseClustered}）⇒ 不是 5s 节拍问题`
  }
  check('缓存卡顿 5s 节拍对齐判定', true, detail)
  return {
    verdict,
    detail,
    metrics: {
      longtaskCount: s.longtaskCount,
      longtaskMaxMs: s.longtaskMaxMs,
      pollCount: s.pollCount,
      pollMedianMs: s.pollMedianMs,
      alignedRatio: s.alignedRatio,
      phaseClustered: s.phaseClustered,
      droppedPct: s.droppedPct,
      bufferedAheadMin: s.bufferedAheadMin,
      netVerdict: s.netVerdict,
    },
  }
}

// ---------------------------------------------------------------------------
// 汇总 Markdown
// ---------------------------------------------------------------------------

/**
 * 生成总表（阶段 / 在测什么 / 判据 / 结果 / 关键数字 / 是否覆盖）。
 * @param {object} r results
 * @returns {string}
 */
function buildMarkdown(r) {
  const L = []
  L.push('# 播放验收总表（单脚本 · 单浏览器 · 一次跑完）')
  L.push('')
  L.push(`- 时间：${r.startedAt}`)
  L.push(`- 前端：${r.appUrl} · 后端：${r.tgUrl}`)
  L.push(`- 浏览器：${r.browser || '-'}`)
  L.push(`- **UA（headful 自证）**：${r.userAgent || '-'}`)
  L.push(`- **headful**：${r.headful}（UA ${r.headful ? '不含' : '含'} HeadlessChrome）`)
  L.push(`- 落屏刷新率（rAF）：${r.refreshHz || '-'} Hz`)
  L.push(`- 夹具：${r.item}（30fps）· ${r.itemHevc}（60fps 源）`)
  L.push('')
  L.push('## 阶段总表')
  L.push('')
  L.push('| 阶段 | 在测什么 | 结果 | 关键数字 | 是否覆盖 |')
  L.push('|---|---|---|---|---|')
  const covered = (v) => (v === 'NOT-COVERABLE' ? '不可覆盖' : '已覆盖')
  for (const s of r.stages) {
    const m = s.metrics || {}
    let key = ''
    if (s.idx === 1) key = `丢帧 ${m.droppedPct}%，提示${m.noticePresent ? '出现' : '未出现'}`
    else if (s.idx === 2) key = `丢帧 ${m.droppedPct}%（Δ${m.droppedDelta}），提示${m.noticePresent ? '出现' : '未出现'}`
    else if (s.idx === 3) key = `丢帧 ${m.droppedPct}%，videoWidth=${m.videoWidth}，提示${m.noticePresent ? '出现' : '未出现'}`
    else if (s.idx === 4) key = `注入后提示=${m.noticeAfterInject}（真阳性=${m.sustainedStarve}），还原后提示末拍=${m.noticeAfterRecover}（撤销于≈${m.recoverClearedAtSec}s）`
    else if (s.idx === 5) key = `停载遮罩=${m.haltAppeared}，还原后 vwPatched=${m.vwPatchedAfterRevert}`
    else if (s.idx === 6) key = `longtask ${m.longtaskCount}，轮询 ${m.pollCount}（中位 ${m.pollMedianMs}ms），紧随比例 ${m.alignedRatio}，相位聚集=${m.phaseClustered}`
    else if (s.idx === 0) key = `5180=${m.fe} 19787=${m.be} headful=${m.headful}`
    else key = ''
    L.push(`| [${s.idx}/7] ${s.title} | ${s.title} | ${s.verdict} | ${key} | ${covered(s.verdict)} |`)
  }
  L.push('')
  L.push('## 逐判据')
  L.push('')
  L.push('| 判据 | 结果 | 说明 |')
  L.push('|---|---|---|')
  for (const c of r.checks) {
    L.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${String(c.detail).replace(/\|/g, '\\|')} |`)
  }
  L.push('')
  L.push('## 缓存卡顿（阶段 6）细节')
  L.push('')
  if (r.phases.stall) {
    const s = r.phases.stall
    L.push(`- 窗口时长：${s.wallSecs}s（轮询 ${s.pollCount} 次，中位间隔 ${s.pollMedianMs}ms）`)
    L.push(`- longtask：${s.longtaskCount} 个（最长 ${s.longtaskMaxMs}ms，合计 ${s.longtaskTotalMs}ms）`)
    L.push(`- 相位直方图（startTime mod 5000ms，20×250ms）：${JSON.stringify(s.phaseBuckets)}`)
    L.push(`- 相位聚集：${s.phaseClustered}（峰值桶 #${s.phaseMaxBucket} ${s.phaseSpan}，n=${s.phaseMaxCount}）`)
    L.push(`- 紧随轮询 ≤${ALIGN_WINDOW_MS}ms：${s.alignedWithin}/${s.longtaskCount}（ratio ${s.alignedRatio}）`)
    L.push(`- rVFC：${s.rvfcFrames} 帧，最大间隔 ${s.rvfcMaxGapMs}ms，缺口数 ${s.rvfcGapCount}，longtask 含缺口 ${s.ltWithGap}/${s.ltTotal}`)
    L.push(`- 掉帧：${s.droppedDelta}（${s.droppedPct}%），呈现 ${s.presentedFps}fps，buffered 最小 ${s.bufferedAheadMin}s`)
    L.push(`- 网络：${s.net ? JSON.stringify({ tgReq: s.net.tgRequestCount, maxConcurrent: s.net.maxConcurrent, player: s.net.playerRequestCount, feedPoster: s.net.feedPosterRequestCount, afterPoll: s.net.maxConcurrentAfterPoll }) : '-'}`)
    L.push(`- 连接池判定：${s.netVerdict ? s.netVerdict.verdict + ' — ' + s.netVerdict.reason : '-'}`)
  } else {
    L.push('- 阶段 6 未产出数据（未覆盖）。')
  }
  L.push('')
  L.push('## 缓存磁盘增量（阶段 6）')
  L.push('')
  const b = r.cacheStats.before
  const a = r.cacheStats.after
  const bBytes = b && typeof b.bytes === 'number' ? b.bytes : null
  const aBytes = a && typeof a.bytes === 'number' ? a.bytes : null
  L.push(`- 入队前：${JSON.stringify(b)}`)
  L.push(`- 收尾后：${JSON.stringify(a)}`)
  L.push(`- 本次实际新增磁盘字节：${bBytes != null && aBytes != null ? aBytes - bBytes : 'n/a'}（bytes 口径）`)
  L.push(`- 取消结果：${JSON.stringify(r.cancelResults)}`)
  L.push('')
  L.push('## 注入自证（工作区未被改动）')
  L.push('')
  if (r.guard) {
    L.push(`- 源文件 sha256 一致：${JSON.stringify(r.guard.before.hashes) === JSON.stringify(r.guard.after.hashes)}`)
    L.push(`- git status 一致：${r.guard.before.gitStatus === r.guard.after.gitStatus}`)
    L.push(`- before git-status：${JSON.stringify(r.guard.before.gitStatus)}`)
    L.push(`- after  git-status：${JSON.stringify(r.guard.after.gitStatus)}`)
  } else {
    L.push('- 未取到自证快照。')
  }
  L.push('')
  L.push('（全部注入均为页面内运行时原型 getter 打桩，不修改任何源码文件；每段注入结束即还原。）')
  L.push('')
  L.push('（单浏览器单会话：全部阶段复用同一个 page；阶段间不重启浏览器。环境不可达时脚本只自检、如实报「未运行」。）')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  console.log('='.repeat(78))
  console.log('播放验收 · 单脚本 · 单浏览器 · 一次跑完')
  console.log(`前端 ${APP_URL} · 后端 ${TG} · 产物 ${OUT}`)
  console.log(`阶段：环境自证 → C1/C2/C3（误报消除）→ C4/C5（反向证伪）→ 缓存卡顿 5s 对齐 → 总表`)
  console.log('='.repeat(78))

  // 环境探活（提前一档：不可达只自检、如实报告、退出码 2）
  const fe0 = await httpStatus(APP_URL, 3000)
  const be0 = await httpStatus(TG, 3000)
  console.log(`[探活] 前端 ${APP_URL} -> ${fe0}；后端 ${TG} -> ${be0}`)
  if (fe0 === 0 || be0 === 0) {
    console.error(`[未运行] 环境不可达（frontend=${fe0}, backend=${be0}）⇒ 脚本已就绪但未执行。exit 2。`)
    process.exit(2)
  }

  // 注入自证基线（在任何打桩之前）
  const guardBefore = guardSnapshot()
  console.log(`[自证] before hashes=${JSON.stringify(guardBefore.hashes)}`)
  console.log(`[自证] before git-status=${JSON.stringify(guardBefore.gitStatus)}`)

  const markers = loadNoticeMarkers()
  results.markers = markers
  console.log(`[标记] strainText=${JSON.stringify(markers.strainText)} short=${JSON.stringify(markers.strainShort)}`)

  let browser
  try {
    // headful（BUG-213 已修 cdp.cjs）：不传 options 仍是 headless，故显式 { headless: false }。
    // 附加防节流开关：headful 窗口被遮挡后 renderer 会被后台化、rAF/rVFC 降频失真。
    browser = await cdp.launch({
      headless: false,
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
      ],
    })
  } catch (e) {
    console.error(`[未运行] 浏览器启动失败：${(e && e.message) || e}`)
    process.exit(2)
  }
  results.browser = browser.executable
  console.log(`[浏览器] headful：${browser.executable}（pid=${browser.proc ? browser.proc.pid : '-'}）`)

  // 防游离进程：被 Ctrl-C / 被 kill 时也要关闭浏览器（否则 SIGTERM 会绕过 finally 留下孤儿 msedge）。
  const onSignal = (sig) => {
    console.log(`\n[信号] 收到 ${sig} ⇒ 关闭浏览器后退出`)
    browser
      .close()
      .catch(() => {})
      .finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let collector = null
  try {
    // ---- 单浏览器单会话：一次 newPage，全程复用 ----
    const page = await browser.newPage()
    try {
      await page.conn.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId: page.sessionId })
    } catch (_e) {
      /* ignore */
    }
    // 页面/命令放宽超时（重载/卡顿页面会让 Runtime.evaluate 变慢）
    page.conn.timeoutMs = 150000

    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
    console.log(`[浏览器] 应用就绪：${APP_URL}`)

    await installNoticeProbe(page, markers)

    // 网络采集器（连接池维度，可选）
    collector = createNetworkCollector(page, TG_ORIGIN)
    try {
      await collector.enable()
      console.log('[网络] Network 域已启用')
    } catch (e) {
      collector = null
      console.log(`[网络] Network 域不可用（跳过）：${(e && e.message) || e}`)
    }

    // ---- [0/7] 环境与自证 ----
    await stageEnv(page)

    // ---- [1/7] C1 ----
    await runStage(1, `BUG-212 C1：${ITEM}@2x 提示检测`, () => stageC1(page), STAGE_TIMEOUT.C1)

    // ---- [2/7] C2 ----
    await runStage(2, `BUG-212 C2：${ITEM}@1x 干净基线`, () => stageC2(page), STAGE_TIMEOUT.C2)

    // ---- [3/7] C3 ----
    await runStage(3, `BUG-212 C3：${ITEM_HEVC}@4x 提示检测`, () => stageC3(page), STAGE_TIMEOUT.C3)

    // ---- [4/7] C4 ----
    await runStage(4, `BUG-212 C4：注入「管线饿死」反向证伪`, () => stageC4(page), STAGE_TIMEOUT.C4)

    // ---- [5/7] C5 ----
    await runStage(5, `BUG-212 C5：注入 videoWidth=0 回归`, () => stageC5(page), STAGE_TIMEOUT.C5)

    // ---- [6/7] 缓存卡顿 5s 对齐 ----
    await runStage(6, `缓存卡顿：5s 节拍对齐（${STALL_WINDOW_SEC}s 窗口）`, () => stageStall(page, collector), STAGE_TIMEOUT.STALL)

    // 页面错误
    results.pageErrors = page.pageErrors().slice(0, 20)
    results.consoleErrors = page.consoleErrors().slice(0, 20)
    console.log(`[页面] PAGE_ERRORS: ${JSON.stringify(results.pageErrors)}`)
    console.log(`[页面] CONSOLE_ERRORS: ${JSON.stringify(results.consoleErrors)}`)
  } catch (e) {
    console.error(`[错误] ${(e && e.stack) || e}`)
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
    console.log('[浏览器] 已关闭')

    // ---- 注入自证：还原后工作区必须与打桩前一致 ----
    const guardAfter = guardSnapshot()
    results.guard = { before: guardBefore, after: guardAfter }
    const hashesEqual = JSON.stringify(guardBefore.hashes) === JSON.stringify(guardAfter.hashes)
    const gitEqual = guardBefore.gitStatus === guardAfter.gitStatus
    console.log(`[自证] after  hashes=${JSON.stringify(guardAfter.hashes)}`)
    console.log(`[自证] after  git-status=${JSON.stringify(guardAfter.gitStatus)}`)
    check('自证：目标源文件 sha256 未被改动', hashesEqual, `before=${JSON.stringify(guardBefore.hashes)} after=${JSON.stringify(guardAfter.hashes)}`)
    check('自证：git status（tauri-shell/src, download-engine）未被改动', gitEqual, `before=${JSON.stringify(guardBefore.gitStatus)} after=${JSON.stringify(guardAfter.gitStatus)}`)

    // ---- [7/7] 输出总表与退出码 ----
    stageStart(7, TOTAL_STAGES, '输出总表与退出码')
    const t0 = Date.now()
    fs.writeFileSync(path.join(OUT, 'playback_all.json'), JSON.stringify(results, null, 2))
    fs.writeFileSync(path.join(OUT, 'playback_all.md'), buildMarkdown(results) + '\n')
    console.log('\n' + buildMarkdown(results))
    const secs = Number(((Date.now() - t0) / 1000).toFixed(1))

    const failed = checks.filter((c) => !c.pass)
    const notCoverable = stages.filter((s) => s.verdict === 'NOT-COVERABLE')
    const stageFails = stages.filter((s) => s.verdict === 'FAIL')
    const verdict = failed.length || stageFails.length ? 'FAIL' : 'PASS'
    stageEnd(7, TOTAL_STAGES, '输出总表与退出码', verdict, `判据 ${checks.length - failed.length}/${checks.length} PASS，未覆盖 ${notCoverable.length}`, secs)

    console.log('\n' + '='.repeat(78))
    console.log(`总判据：${checks.length} 项，PASS ${checks.length - failed.length}，FAIL ${failed.length}`)
    if (failed.length) console.log('FAILED：' + failed.map((c) => c.name).join(' | '))
    console.log(`阶段：PASS ${stages.filter((s) => s.verdict === 'PASS').length}，FAIL ${stageFails.length}，未覆盖 ${notCoverable.length}`)
    if (notCoverable.length) console.log('不可覆盖：' + notCoverable.map((s) => s.title).join(' | '))
    console.log(`产物：${OUT}`)
    console.log('='.repeat(78))

    if (process.exitCode !== 1) process.exitCode = failed.length || stageFails.length ? 1 : 0
  }
}

main()
