#!/usr/bin/env node
'use strict'

/**
 * BUG-212 独立验收（headful）：倍速下「解码吃力」提示**不再误报**，且判据仍是活的。
 *
 * ## 缺陷回顾（`docs/bugs/BUG-212.md`）
 *
 * 2x / 4x 倍速审看时弹出「解码吃力：画面在丢帧，调低播放速度会明显更流畅」
 * （i18n 键 `tg.decodeStrained`，渲染于 `VideoPlayer.tsx:651-655`）。实测本机落屏
 * 2560×1080、合成器刷新 ≈60Hz（rAF），30fps 源 ×2x 需呈现 60fps（正好顶死刷新率）、
 * ×4x 需 120fps ⇒ 丢帧是**呈现端的物理上限**，与解码能力无关（缓冲全程领先、`waiting`/
 * `stalled` 全 0、`totalVideoFrames` 增量恰 = 源帧率 × 倍速）。
 *
 * ## 修复（提交 49d85ba + ffd1b4c，`tauri-shell/src/lib/decodeHealth.ts`）
 *
 *   - **主判据 = 有效倍速**：`effRate = (ΔcurrentTime / (Δt/1000)) / playbackRate`；
 *     `effRate < EFF_RATE_MIN`(0.9) 连续 `STRAIN_STREAK`(4 拍 × 500ms = 2s) 才置 `strained`。
 *     丢帧只影响上屏、不改变 `currentTime` 推进 ⇒ 倍速下丢帧不污染该比值。
 *   - **副判据（丢帧）仅在 `playbackRate <= 1.01`** 时才可能触发。
 *   - `unsupported`（`videoWidth===0` 持续 3s，BUG-207 停载遮罩）逻辑**未动**。
 *
 * ## 本脚本要证明什么（判据，**不得放宽**）
 *
 *   1. **2x 不误报**：607 在 2x、呈现丢帧 > 0 期间，`tg.decodeStrained` 提示**不出现**。
 *   2. **1x 干净**：607 在 1x、丢帧 0% 时提示不出现。
 *   3. **4x 不误报**：472（60fps 源）在 4x 呈现丢帧 ~53–75% 时提示**不出现**。
 *   4. **反向证伪（判据是活的，不是把提示关掉）**：**运行时注入**一个人为「管线饿死」
 *      （给 `HTMLMediaElement.prototype.currentTime` 的 getter 打桩，使 ΔcurrentTime 只有
 *      期望的 ~20%，持续 ≥3s）时提示**必须出现**；注入**自动还原**后提示应在 `calmStreak`
 *      （4 拍 = 2s）内撤销。**且自证工作区未被改动**（注入前后 `git status --porcelain`
 *      与目标源文件 `sha256` 必须一致）。
 *   5. **`unsupported` 回归**：**运行时注入**（把 `HTMLVideoElement.prototype.videoWidth`
 *      getter 打桩为恒 `0`）制造 `unsupported`，断言 BUG-207 停载遮罩出现；同样自动还原 + 自证。
 *   6. **`effRate` 与提示同时记录（逐拍）**：逐拍记录 `currentTime` / `playbackRate` /
 *      `effRate` / `droppedVideoFrames` 增量 / `buffered` 领先秒数 / 提示是否在场，并据此
 *      **区分**「提示出现时 `effRate` 持续 < 0.9（真阳性）」与「`effRate` ≈ 1（误报）」。
 *      已知独立实测 2x 下出现过 2066ms 呈现空档（缓冲还有 26s）——若提示在那时出现，
 *      那是**正确的真阳性**，不是判据 1 的失败。
 *
 * ## 为什么必须 headful
 *
 * headless 下 rAF / rVFC 被钉在 ~60Hz（软件合成假上限）、HEVC `videoWidth` 恒 0（假象），
 * 任何丢帧 / 呈现帧率 / rVFC 数据都失真。故本脚本用 `cdp.launch({ headless: false })`
 * （BUG-213 已修 cdp.cjs），并在启动后**打印一次 `navigator.userAgent`**，把「本次是 headful
 * （UA 不含 `HeadlessChrome`）」作为自证写进产物 —— 否则将来没人能确认这批数字的浏览器形态。
 *
 * ## 注入的「不污染」保证（硬要求）
 *
 * 全部注入均为**页面内运行时打桩**（改 JS 原型 getter），**不修改任何源码文件**；每段注入
 * 结束即 `revert`，并断言 `injectionState()` 已回到未打桩态；且注入前后对
 * `tauri-shell/src/lib/decodeHealth.ts`、`tauri-shell/src/components/media/VideoPlayer.tsx`
 * 取 `sha256`、对 `tauri-shell/src`、`download-engine` 取 `git status --porcelain` 做等值断言。
 *
 * ## 用法
 *
 *   先起开发态服务（daemon + orig-tg 19787 + vite dev 5180），再：
 *     node verify/verify_bug212_rate_notice.cjs
 *   环境变量：APP_PORT / TG_URL / OUT / PROBE_ITEM / PROBE_ITEM_HEVC /
 *             CLEAN_WINDOW_SEC / STRAIN_WINDOW_SEC / INJECT_SEC / RECOVER_SEC。
 *   浏览器：`EDGE_PATH` / `CHROME_PATH` 可覆盖（cdp.cjs 默认优先 Edge）。
 *
 *   **headful、串行、单浏览器**（性能取证严禁并行多浏览器）；测完**必须关闭**浏览器进程。
 *   环境不可达（5180 / 19787 探活失败）⇒ 只报「未运行，脚本已就绪」，**不伪造任何数字**。
 *
 * 产物：`tauri-shell/verify_shots/bug212_notice/`（截图 + JSON + Markdown 汇总表）。
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 环境不可达。
 *
 * **只读**：仅打开播放器并播放 + 页面内运行时打桩（自动还原）；不写后端、不改源码、不改 bug 档。
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
const OUT = path.resolve(
  process.env.OUT || path.join(__dirname, '..', 'verify_shots', 'bug212_notice'),
)
/** 仓库根：脚本位于 tauri-shell/verify/ ⇒ 上溯两级。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..')
/** 首选夹具：607 = H.264 480×852 30fps、时长 337s（1x 丢帧 0%、完美）。 */
const ITEM = Number(process.env.PROBE_ITEM || 607)
/** 高倍速夹具：472 = HEVC 720p 60fps（headful 下能解，走 /raw）。 */
const ITEM_HEVC = Number(process.env.PROBE_ITEM_HEVC || 472)

/** 1x 干净窗口（秒）。 */
const CLEAN_WINDOW_SEC = Number(process.env.CLEAN_WINDOW_SEC || 10)
/** 倍速窗口（秒）——2x / 4x。 */
const STRAIN_WINDOW_SEC = Number(process.env.STRAIN_WINDOW_SEC || 12)
/** 注入持续时间（秒）——须 ≥3s（判据 4 要求）。 */
const INJECT_SEC = Number(process.env.INJECT_SEC || 6)
/** 还原后观察提示撤销的时间（秒）——须 ≥ calmStreak(2s) + 余量。 */
const RECOVER_SEC = Number(process.env.RECOVER_SEC || 6)

/** 改速后的解码器预热静默期（对齐 decodeHealth.ts 的 WARMUP_MS=1500，留余量）。 */
const WARMUP_MS = 1800
/** 有效倍速下限（对齐 decodeHealth.ts 的 EFF_RATE_MIN）。 */
const EFF_RATE_MIN = 0.9
/** 连续判定拍数（对齐 decodeHealth.ts 的 STRAIN_STREAK / CALM_STREAK）。 */
const STRAIN_STREAK = 4
/** 打桩比例：ΔcurrentTime 只保留 20% ⇒ effRate ≈ 0.2 << 0.9。 */
const STARVE_SCALE = 0.2
/** 页面内采样节拍（对齐 decodeHealth.ts 的 SAMPLE_MS）。 */
const SAMPLE_MS = 500
/** 等待出帧 / 等待停载遮罩的超时。 */
const FRAME_WAIT_MS = 90000
const HALT_WAIT_MS = 60000

/** 注入自证要监控的源文件（不得改动）。 */
const SRC_GUARD_FILES = [
  path.join('tauri-shell', 'src', 'lib', 'decodeHealth.ts'),
  path.join('tauri-shell', 'src', 'components', 'media', 'VideoPlayer.tsx'),
]
/** 注入自证要监控的目录（`git status --porcelain` 作用域）。 */
const SRC_GUARD_DIRS = ['tauri-shell/src', 'download-engine']

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
 * 文件 sha256；不可读返回 `ERR:<msg>`（用于自证对比，不作为异常抛出）。
 * @param {string} absPath
 * @returns {string}
 */
function sha256(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
  } catch (e) {
    return `ERR:${(e && e.message) || e}`
  }
}

/**
 * 在仓库根执行 `git status --porcelain -- <paths>`（只读）。
 * @param {string[]} paths
 * @returns {string}
 */
function gitStatusPorcelain(paths) {
  try {
    return String(
      execFileSync('git', ['status', '--porcelain', '--', ...paths], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ).trim()
  } catch (e) {
    return `ERR:${(e && e.message) || e}`
  }
}

/**
 * 采集「工作区未被改动」的自证快照。
 * @returns {{hashes:Object<string,string>, gitStatus:string}}
 */
function guardSnapshot() {
  const hashes = {}
  for (const rel of SRC_GUARD_FILES) hashes[rel] = sha256(path.join(REPO_ROOT, rel))
  return { hashes, gitStatus: gitStatusPorcelain(SRC_GUARD_DIRS) }
}

/**
 * 从 zh-CN locale 读 `tg.decodeStrained` 文案，派生 DOM 匹配标记。
 * 找不到就回退到已知中文标记（其余验收脚本亦按 zh-CN 硬编码）。
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

// ---------------------------------------------------------------------------
// 页面内持久探针（安装一次；避免超长 evaluate 命中 CDP 命令超时）
// ---------------------------------------------------------------------------

/**
 * 安装页面内持久探针 `window.__b212`：
 *   - `start()` / `stop()`：500ms 节拍逐拍采样（对齐 decodeHealth 的 SAMPLE_MS）。
 *   - 逐拍记录 `currentTime` / `playbackRate` / `effRate` / `droppedVideoFrames` 增量 /
 *     `buffered` 领先秒数 / 提示是否在场 / 停载遮罩是否在场 / `currentSrc` 路径。
 *   - `injectStarvation(scale)` / `revertStarvation()`：对 `currentTime` getter 打桩。
 *   - `injectNoVideo()` / `revertNoVideo()`：对 `videoWidth` getter 打桩。
 *   - `injectionState()`：当前打桩态（自证已还原）。
 * @param {object} page CDP Page
 * @param {{strainText:string, strainShort:string}} markers
 * @returns {Promise<void>}
 */
async function installProbe(page, markers) {
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

      /** 沿原型链找属性描述符（`currentTime` 在 HTMLMediaElement.prototype，videoWidth 在 HTMLVideoElement.prototype）。 */
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
       * 找「解码吃力」提示节点。主判据 = 文案匹配（语义）；回退 = 该 `<p>` 的稳定类名
       * （`bottom-20` + `max-w-[80%]`，避免 locale 差异导致漏检）。
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
        // 用当前时刻播种基线，使**第一拍**就有真实 ΔcurrentTime（否则首拍 effRate 为 null，
        // 会削弱「提示 onset 邻域」的证据窗）。
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
       * 只改 getter 的读数，不动元素真实播放；setter 保留（避免破坏 seek）。
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
// 导航 / 打开条目
// ---------------------------------------------------------------------------

/** 通过 store 打开一个视频条目（src 用 /raw；MediaViewer 内部按需补 compatSrc）。 */
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

// ---------------------------------------------------------------------------
// 采样窗口
// ---------------------------------------------------------------------------

/**
 * 跑一个采样窗口：启动页面内探针 → Node 侧等待 → 停止并取回逐拍样本 + 事件计数。
 * @param {object} page CDP Page
 * @param {number} seconds 窗口秒数
 * @returns {Promise<{wallSecs:number, samples:Array<object>, events:object}>}
 */
async function runWindow(page, seconds) {
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
 * 汇总一个窗口：丢帧% / 提示是否在场 / 提示起始点的 effRate 是否持续 <0.9（真阳性 vs 误报）。
 * @param {object} w runWindow 结果
 * @returns {object}
 */
function summarizeWindow(w) {
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
  const aheadMin =
    samples.length && samples.every((s) => s.ahead == null)
      ? null
      : Number(Math.min(...samples.map((s) => (s.ahead == null ? Infinity : s.ahead))).toFixed(2))

  const noticeIdx = samples.findIndex((s) => s.notice)
  const noticePresent = noticeIdx >= 0
  let onset = null
  if (noticePresent) {
    // onset 邻域窗：最多 STRAIN_STREAK+1 拍（含 onset 拍），阈值 STRAIN_STREAK。
    // 容忍窗内 1 个异常样本，同时覆盖「注入恰好从窗首开始」的情形。
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
      // 判据：起始邻域内 ≥STRAIN_STREAK 拍 effRate<0.9 ⇒ 真阳性（判据是活的）。
      sustainedStarve: starveCount >= STRAIN_STREAK,
      whileNoticeEffMax: whileNotice.length ? Number(Math.max(...whileNotice).toFixed(3)) : null,
    }
  }

  const paths = {}
  for (const s of samples) paths[s.path] = (paths[s.path] || 0) + 1
  const lastSample = samples[samples.length - 1] || null

  return {
    wallSecs: w.wallSecs,
    sampleCount: samples.length,
    droppedDelta,
    framesDelta,
    droppedPct,
    aheadMin: aheadMin != null && isFinite(aheadMin) ? aheadMin : null,
    noticePresent,
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
// 主流程
// ---------------------------------------------------------------------------

const checks = []
/**
 * 记录一条判据结果。
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' })
  console.log(`[b212] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, tmpDir, name) {
  const f = path.join(tmpDir, name)
  try {
    await page.screenshot(f)
    return f
  } catch (e) {
    console.log(`[b212] shot ${name} FAILED: ${(e && e.message) || e}`)
    return null
  }
}

async function main() {
  const markers = loadNoticeMarkers()
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`[b212] markers: strainText=${JSON.stringify(markers.strainText)} short=${JSON.stringify(markers.strainShort)}`)
  console.log(`[b212] fixtures: item=${ITEM} (30fps), hevcItem=${ITEM_HEVC} (60fps)`)

  // ---- 环境探活（失败即 exit 2，不重试、不等待、不起任何服务）----
  const fe = await httpStatus(APP_URL, 3000)
  const be = await httpStatus(TG, 3000)
  console.log(`[b212] env probe: frontend ${APP_URL} -> ${fe}; backend ${TG} -> ${be}`)
  if (fe === 0 || be === 0) {
    console.error(
      `[b212] ENV: unreachable (frontend=${fe}, backend=${be}); script ready but NOT run. exit 2.`,
    )
    process.exit(2)
  }

  // ---- 注入自证基线（在任何打桩之前）----
  const guardBefore = guardSnapshot()
  console.log(`[b212] guard(before) hashes=${JSON.stringify(guardBefore.hashes)}`)
  console.log(`[b212] guard(before) git-status=${JSON.stringify(guardBefore.gitStatus)}`)

  let browser
  try {
    // headful（BUG-213 已修 cdp.cjs）：headless 下 rAF/rVFC 被钉在 ~60Hz、HEVC videoWidth 恒 0，
    // 数据失真不可用。不传 options 仍是 headless，故显式 { headless: false }。
    browser = await cdp.launch({ headless: false })
  } catch (e) {
    console.error(`[b212] ENV: browser launch failed: ${(e && e.message) || e}`)
    process.exit(2)
  }

  const SHOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-b212-shots-'))
  const results = {
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    tgUrl: TG,
    item: ITEM,
    itemHevc: ITEM_HEVC,
    windows: { cleanSec: CLEAN_WINDOW_SEC, strainSec: STRAIN_WINDOW_SEC, injectSec: INJECT_SEC, recoverSec: RECOVER_SEC },
    effRateMin: EFF_RATE_MIN,
    starveScale: STARVE_SCALE,
    markers,
    browser: browser.executable,
    phases: {},
    criteria: {},
    checks,
  }

  try {
    const page = await browser.newPage()
    // 真实显示器：清掉 cdp 默认注入的设备仿真（1440×900/DPR1），与真实落屏一致。
    try {
      await page.conn.send('Emulation.clearDeviceMetricsOverride', {}, { sessionId: page.sessionId })
    } catch (_e) {
      /* ignore */
    }
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000 })
    console.log('[b212] app ready at', APP_URL)

    /*
     * headful 自证（防「静默退回 headless」）：判别信号 = `navigator.userAgent` 是否含
     * `HeadlessChrome`。打印一次并写入产物，使本批数字的浏览器形态可追溯。
     */
    const userAgent = String(await page.evaluate(() => navigator.userAgent))
    const headful = !/HeadlessChrome/i.test(userAgent)
    results.userAgent = userAgent
    results.headful = headful
    console.log(`[b212] UA: ${userAgent}`)
    console.log(`[b212] headful self-attestation: ${headful} (UA ${headful ? '不含' : '含'} HeadlessChrome)`)
    check('本次为 headful（UA 不含 HeadlessChrome）', headful, userAgent)

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
    console.log(`[b212] refresh ≈ ${results.refreshHz} Hz (rAF, headful)`)

    await installProbe(page, markers)

    // =====================================================================
    // 判据 2：1x 干净（607 @1x，丢帧 0% 时提示不出现）
    // =====================================================================
    console.log(`\n[b212] ===== C2: ${ITEM} @1x clean =====`)
    await closeViewer(page)
    await openItem(page, ITEM)
    const framed1 = await waitFramed(page)
    await setRateDirect(page, 1)
    await delay(WARMUP_MS)
    const w1x = await runWindow(page, CLEAN_WINDOW_SEC)
    const s1x = summarizeWindow(w1x)
    results.phases.clean1x = s1x
    await shot(page, SHOT_TMP, `C2_item${ITEM}_1x.png`)
    console.log(
      `[b212] C2 1x | dropped +${s1x.droppedDelta} (${s1x.droppedPct}%) frames +${s1x.framesDelta} |` +
        ` notice=${s1x.noticePresent} (${s1x.classification}) | aheadMin ${s1x.aheadMin}s |` +
        ` events ${JSON.stringify(s1x.events)} | path ${JSON.stringify(s1x.paths)}`,
    )
    check(
      'C2 1x 干净：提示不出现',
      framed1 && !s1x.noticePresent,
      `framed=${framed1} notice=${s1x.noticePresent} dropped=${s1x.droppedPct}%`,
    )
    check(
      'C2 1x 丢帧为 0%（夹具质量）',
      s1x.droppedDelta === 0,
      `droppedDelta=${s1x.droppedDelta} (${s1x.droppedPct}%)`,
    )

    // =====================================================================
    // 判据 4：反向证伪（运行时注入「管线饿死」⇒ 提示必须出现；还原后撤销）
    // =====================================================================
    console.log(`\n[b212] ===== C4: reverse falsification via injected starvation (${ITEM} @1x) =====`)
    await closeViewer(page)
    await openItem(page, ITEM)
    await waitFramed(page)
    await setRateDirect(page, 1)
    await delay(WARMUP_MS)
    const preInject = await domState(page)
    console.log(`[b212] C4 pre-inject: notice=${preInject.notice} halt=${preInject.halt}`)
    check('C4 注入前提示不在场（干净基线）', preInject.notice === false, `notice=${preInject.notice}`)

    const inj = await page.evaluate((scale) => window.__b212.injectStarvation(scale), STARVE_SCALE)
    console.log(`[b212] C4 injectStarvation -> ${JSON.stringify(inj)}`)
    check('C4 注入成功（currentTime getter 已打桩）', inj && inj.ok === true, JSON.stringify(inj))

    const wInj = await runWindow(page, INJECT_SEC)
    const sInj = summarizeWindow(wInj)
    results.phases.injectStarve = sInj
    await shot(page, SHOT_TMP, `C4_injected_starve.png`)
    console.log(
      `[b212] C4 injected | effRate onset=${JSON.stringify(sInj.onset && sInj.onset.windowEffRates)}` +
        ` sustainedStarve=${sInj.onset && sInj.onset.sustainedStarve} | notice=${sInj.noticePresent} (${sInj.classification})`,
    )
    check(
      'C4 注入「管线饿死」⇒ 提示必须出现（判据是活的）',
      sInj.noticePresent === true,
      `notice=${sInj.noticePresent}`,
    )
    check(
      'C4 提示出现是真阳性（onset 邻域 effRate 持续 <0.9）',
      !!(sInj.onset && sInj.onset.sustainedStarve),
      `onsetEffRates=${JSON.stringify(sInj.onset && sInj.onset.windowEffRates)}`,
    )

    // 还原打桩
    const rev = await page.evaluate(() => window.__b212.revertStarvation())
    const stAfterRev = await page.evaluate(() => window.__b212.injectionState())
    console.log(`[b212] C4 revertStarvation -> ${JSON.stringify(rev)} state=${JSON.stringify(stAfterRev)}`)
    check('C4 打桩已还原（injectionState.curPatched=false）', stAfterRev.curPatched === false, JSON.stringify(stAfterRev))

    // 还原后提示应在 calmStreak 内撤销
    const wRec = await runWindow(page, RECOVER_SEC)
    const sRec = summarizeWindow(wRec)
    results.phases.recoverFromStarve = sRec
    await shot(page, SHOT_TMP, `C4_recovered.png`)
    console.log(
      `[b212] C4 recovered | notice=${sRec.noticePresent} (${sRec.classification}) | effRate min ${Math.min(
        ...wRec.samples.filter((s) => s.effRate != null).map((s) => s.effRate),
      )}`,
    )
    check(
      'C4 还原后提示在 calmStreak（~2s）内撤销',
      sRec.noticePresent === false,
      `notice=${sRec.noticePresent} classification=${sRec.classification}`,
    )

    // =====================================================================
    // 判据 1：2x 不误报（607 @2x，呈现丢帧 > 0 期间提示不出现）
    // =====================================================================
    console.log(`\n[b212] ===== C1: ${ITEM} @2x no-misreport =====`)
    await closeViewer(page)
    await openItem(page, ITEM)
    await waitFramed(page)
    const set2 = await setRateDirect(page, 2)
    await delay(WARMUP_MS)
    const w2x = await runWindow(page, STRAIN_WINDOW_SEC)
    const s2x = summarizeWindow(w2x)
    results.phases.strain2x = s2x
    await shot(page, SHOT_TMP, `C1_item${ITEM}_2x.png`)
    console.log(
      `[b212] C1 2x (rateActual=${set2.actual}) | dropped +${s2x.droppedDelta} (${s2x.droppedPct}%) |` +
        ` notice=${s2x.noticePresent} (${s2x.classification}) |` +
        ` onset=${JSON.stringify(s2x.onset && s2x.onset.windowEffRates)} | aheadMin ${s2x.aheadMin}s |` +
        ` events ${JSON.stringify(s2x.events)} | path ${JSON.stringify(s2x.paths)}`,
    )
    if (s2x.noticePresent) {
      if (s2x.onset && s2x.onset.sustainedStarve) {
        check(
          'C1 2x 不误报（提示出现但为真阳性：effRate 持续 <0.9，非判据 1 失败）',
          true,
          `onsetEffRates=${JSON.stringify(s2x.onset.windowEffRates)}`,
        )
      } else {
        check('C1 2x 不误报', false, `提示在 effRate≈1 时出现 ⇒ 误报（false-positive）`)
      }
    } else if (s2x.droppedDelta != null && s2x.droppedDelta > 0) {
      check('C1 2x 不误报', true, `丢帧 ${s2x.droppedPct}% 期间提示不出现`)
    } else {
      check(
        'C1 2x 不误报',
        true,
        `提示不出现；但本窗未观察到丢帧（dropped=${s2x.droppedDelta}）⇒ 场景未充分触发，仅弱通过`,
      )
    }
    check('C1 2x 倍速确实生效（playbackRate=2）', set2.ok === true, `actual=${set2.actual}`)

    // =====================================================================
    // 判据 3：4x 不误报（472 @4x，60fps 源，呈现丢帧 ~53–75% 时提示不出现）
    // =====================================================================
    console.log(`\n[b212] ===== C3: ${ITEM_HEVC} @4x no-misreport =====`)
    await closeViewer(page)
    await openItem(page, ITEM_HEVC)
    const framedHevc = await waitFramed(page)
    const preHevc = await domState(page)
    const set4 = await setRateDirect(page, 4)
    await delay(WARMUP_MS)
    const w4x = await runWindow(page, STRAIN_WINDOW_SEC)
    const s4x = summarizeWindow(w4x)
    results.phases.strain4x = s4x
    await shot(page, SHOT_TMP, `C3_item${ITEM_HEVC}_4x.png`)
    console.log(
      `[b212] C3 4x (rateActual=${set4.actual}) framed=${framedHevc} | dropped +${s4x.droppedDelta} (${s4x.droppedPct}%) |` +
        ` notice=${s4x.noticePresent} (${s4x.classification}) | aheadMin ${s4x.aheadMin}s |` +
        ` events ${JSON.stringify(s4x.events)} | path ${JSON.stringify(s4x.paths)} | vw ${s4x.videoWidth}`,
    )
    if (!framedHevc && s4x.videoWidth === 0) {
      results.criteria.c3 = 'NOT COVERABLE：472 在本机未出帧（videoWidth=0）⇒ 4x 误报场景无法覆盖'
      check('C3 4x 不误报', false, results.criteria.c3)
    } else if (s4x.noticePresent) {
      if (s4x.onset && s4x.onset.sustainedStarve) {
        check(
          'C3 4x 不误报（提示出现但为真阳性：effRate 持续 <0.9，非判据 3 失败）',
          true,
          `onsetEffRates=${JSON.stringify(s4x.onset.windowEffRates)}`,
        )
      } else {
        check('C3 4x 不误报', false, '提示在 effRate≈1 时出现 ⇒ 误报（false-positive）')
      }
    } else if (s4x.droppedDelta != null && s4x.droppedDelta > 0) {
      check('C3 4x 不误报', true, `丢帧 ${s4x.droppedPct}% 期间提示不出现（path=${JSON.stringify(s4x.paths)}）`)
    } else {
      check(
        'C3 4x 不误报',
        true,
        `提示不出现；但本窗未观察到丢帧（dropped=${s4x.droppedDelta}）⇒ 场景未充分触发，仅弱通过`,
      )
    }
    check('C3 4x 倍速确实生效（playbackRate=4）', set4.ok === true, `actual=${set4.actual}`)

    // =====================================================================
    // 判据 5：unsupported 回归（注入 videoWidth=0 ⇒ BUG-207 停载遮罩必须出现）
    // =====================================================================
    console.log(`\n[b212] ===== C5: unsupported regression via injected videoWidth=0 (${ITEM}) =====`)
    await closeViewer(page)
    await openItem(page, ITEM)
    await waitFramed(page)
    await setRateDirect(page, 1)
    await delay(600)
    const preHalt = await domState(page)
    check('C5 注入前停载遮罩不在场', preHalt.halt === false, `halt=${preHalt.halt}`)

    const injVw = await page.evaluate(() => window.__b212.injectNoVideo())
    console.log(`[b212] C5 injectNoVideo -> ${JSON.stringify(injVw)}`)
    check('C5 注入成功（videoWidth getter 已打桩为 0）', injVw && injVw.ok === true, JSON.stringify(injVw))

    const haltAppeared = await page
      .waitForFunction(() => !!document.querySelector('[data-testid="player-unsupported-halt"]'), {
        timeout: HALT_WAIT_MS,
        intervalMs: 250,
      })
      .then(() => true)
      .catch(() => false)
    await shot(page, SHOT_TMP, 'C5_unsupported_halt.png')
    const postHalt = await domState(page)
    console.log(`[b212] C5 halt overlay present=${haltAppeared} (vw=${postHalt.videoWidth})`)
    check('C5 注入 videoWidth=0 ⇒ BUG-207 停载遮罩出现（unsupported 未受影响）', haltAppeared, `halt=${postHalt.halt}`)

    const revVw = await page.evaluate(() => window.__b212.revertNoVideo())
    const stAfterRevVw = await page.evaluate(() => window.__b212.injectionState())
    console.log(`[b212] C5 revertNoVideo -> ${JSON.stringify(revVw)} state=${JSON.stringify(stAfterRevVw)}`)
    check('C5 打桩已还原（injectionState.vwPatched=false）', stAfterRevVw.vwPatched === false, JSON.stringify(stAfterRevVw))

    // 收尾：关闭播放器
    await closeViewer(page)

    // ---- 页面错误 ----
    const pageErrors = page.pageErrors().slice(0, 20)
    const consoleErrors = page.consoleErrors().slice(0, 20)
    results.pageErrors = pageErrors
    results.consoleErrors = consoleErrors
    console.log('[b212] PAGE_ERRORS:', JSON.stringify(pageErrors))
    console.log('[b212] CONSOLE_ERRORS:', JSON.stringify(consoleErrors))
    check('全程无页面错误', pageErrors.length === 0, JSON.stringify(pageErrors))
  } catch (e) {
    console.error('[b212] ERROR', (e && e.stack) || e)
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
    console.log('[b212] browser closed')

    // ---- 注入自证：还原后工作区必须与打桩前一致 ----
    const guardAfter = guardSnapshot()
    results.guard = { before: guardBefore, after: guardAfter }
    const hashesEqual = JSON.stringify(guardBefore.hashes) === JSON.stringify(guardAfter.hashes)
    const gitEqual = guardBefore.gitStatus === guardAfter.gitStatus
    console.log(`[b212] guard(after) hashes=${JSON.stringify(guardAfter.hashes)}`)
    console.log(`[b212] guard(after) git-status=${JSON.stringify(guardAfter.gitStatus)}`)
    check('自证：目标源文件 sha256 未被改动', hashesEqual, `before=${JSON.stringify(guardBefore.hashes)} after=${JSON.stringify(guardAfter.hashes)}`)
    check('自证：git status（tauri-shell/src, download-engine）未被改动', gitEqual, `before=${JSON.stringify(guardBefore.gitStatus)} after=${JSON.stringify(guardAfter.gitStatus)}`)

    // ---- 写产物 ----
    try {
      fs.mkdirSync(OUT, { recursive: true })
      for (const f of fs.readdirSync(SHOT_TMP)) {
        fs.copyFileSync(path.join(SHOT_TMP, f), path.join(OUT, f))
      }
      fs.rmSync(SHOT_TMP, { recursive: true, force: true })
    } catch (e) {
      console.log(`[b212] screenshot copy failed: ${(e && e.message) || e}`)
    }
    fs.writeFileSync(path.join(OUT, 'bug212_notice.json'), JSON.stringify(results, null, 2))
    fs.writeFileSync(path.join(OUT, 'bug212_notice.md'), buildMarkdown(results) + '\n')
    console.log(`\n[b212] === MARKDOWN ===`)
    console.log(buildMarkdown(results))

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[b212] === SUMMARY ===')
    console.log(`[b212] checks total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[b212] FAILED:', failed.map((c) => c.name).join(' | '))
      if (process.exitCode !== 1) process.exitCode = 1
    } else if (process.exitCode !== 1) {
      process.exitCode = 0
    }
    console.log(`[b212] artifacts in ${OUT}`)
  }
}

/**
 * 生成 Markdown 汇总表（逐判据 + 逐窗口 + 真阳性/误报分列）。
 * @param {object} r results
 * @returns {string}
 */
function buildMarkdown(r) {
  const lines = []
  lines.push('# BUG-212 验收汇总（headful · 倍速「解码吃力」误报）')
  lines.push('')
  lines.push(`- 时间：${r.startedAt}`)
  lines.push(`- 前端：${r.appUrl} · 后端：${r.tgUrl}`)
  lines.push(`- 浏览器：${r.browser}`)
  lines.push(`- **UA（headful 自证）**：${r.userAgent}`)
  lines.push(`- **headful**：${r.headful}（UA ${r.headful ? '不含' : '含'} HeadlessChrome）`)
  lines.push(`- 落屏刷新率（rAF）：${r.refreshHz} Hz`)
  lines.push(`- 夹具：${r.item}（30fps）· ${r.itemHevc}（60fps 源）`)
  lines.push(`- effRate 下限=${r.effRateMin} · 注入缩放=${r.starveScale}`)
  lines.push('')
  lines.push('## 逐窗口')
  lines.push('')
  lines.push('| 窗口 | 秒 | 丢帧Δ | 丢帧% | 提示在场 | 分类 | 提示起始 effRate | 缓冲最小s | 事件 | 路径 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  const row = (name, s) => {
    if (!s) return
    const onsetEff = s.onset ? JSON.stringify(s.onset.windowEffRates) : '-'
    lines.push(
      `| ${name} | ${s.wallSecs} | ${s.droppedDelta} | ${s.droppedPct == null ? '-' : s.droppedPct + '%'} | ` +
        `${s.noticePresent ? '是' : '否'} | ${s.classification} | ${onsetEff} | ${s.aheadMin} | ` +
        `${JSON.stringify(s.events)} | ${JSON.stringify(s.paths)} |`,
    )
  }
  row('C2 1x 干净', r.phases.clean1x)
  row('C4 注入饿死', r.phases.injectStarve)
  row('C4 还原后', r.phases.recoverFromStarve)
  row('C1 2x 不误报', r.phases.strain2x)
  row('C3 4x 不误报', r.phases.strain4x)
  lines.push('')
  lines.push('## 真阳性 vs 误报（判据 6）')
  lines.push('')
  lines.push('- **真阳性** = 提示出现时，其 onset 邻域内 ≥4 拍 `effRate < 0.9`（管线确实被饿死）。')
  lines.push('- **误报** = 提示出现时 `effRate ≈ 1`（呈现丢帧被错误归因为解码不足）。')
  lines.push('')
  lines.push('## 判据结果')
  lines.push('')
  lines.push('| 判据 | 结果 | 说明 |')
  lines.push('|---|---|---|')
  for (const c of r.checks) {
    lines.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${String(c.detail).replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
  lines.push('## 注入自证（工作区未被改动）')
  lines.push('')
  lines.push(`- 源文件 sha256 一致：${JSON.stringify(r.guard.before.hashes) === JSON.stringify(r.guard.after.hashes)}`)
  lines.push(`- git status 一致：${r.guard.before.gitStatus === r.guard.after.gitStatus}`)
  lines.push(`- before git-status：${JSON.stringify(r.guard.before.gitStatus)}`)
  lines.push(`- after  git-status：${JSON.stringify(r.guard.after.gitStatus)}`)
  lines.push('')
  lines.push('（全部注入均为页面内运行时原型 getter 打桩，不修改任何源码文件；每段注入结束即还原。）')
  return lines.join('\n')
}

main()
