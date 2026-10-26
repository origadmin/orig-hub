'use strict'

/**
 * Single source of truth for the service endpoints used by the request-storm
 * probes (BUG-239 / BUG-241).
 *
 * WHY THIS EXISTS
 * ---------------
 * The orig-tg port is chosen by the daemon at spawn time and DRIFTS between
 * runs (observed 19787 -> 19788). Every probe used to hard-code it:
 *
 *     const TG = 'http://127.0.0.1:19787'
 *
 * and then filtered captured traffic with `records.filter(r => r.url.startsWith(TG))`.
 * When the daemon picked a different port that filter matched ZERO requests and
 * the probe happily reported "no traffic" -- indistinguishable from a successful
 * fix. That is the most dangerous class of harness bug, so the port must never
 * be hard-coded again.
 *
 * RESOLUTION
 * ----------
 *   daemon : env DAEMON_URL / ORIG_DAEMON_API        -> http://127.0.0.1:19786
 *   app    : env APP_URL / ORIG_APP_API              -> http://127.0.0.1:5180
 *   tg     : env TG_URL / ORIG_TG_API (explicit, used by the negative control)
 *            -> orig-tg port read from GET <daemon>/api/config   (source of truth)
 *               BUG-358 起 config 改插件契约：先读旧键 `tg_port`，再读
 *               `plugins[]` 里 `id="tg"` 的 `port`；两者皆无才 FATAL。
 *
 * FAILURE POLICY
 * --------------
 * If the config endpoint is unreachable, does not answer 200, is not JSON, or
 * lacks a usable numeric `tg_port`, this module prints a FATAL line naming the
 * exact endpoint and exits non-zero. It NEVER silently falls back to 19787.
 * It also pings the resolved `<tg>/health` before any probe runs: a wrong or
 * forced port therefore fails LOUDLY instead of producing a "0 requests" run.
 *
 * Usage:
 *   const endpoints = require('./_lib_endpoints.cjs')
 *   const ep = await endpoints.resolve()      // throws/exits on failure
 *   ep.app            // http://127.0.0.1:5180
 *   ep.tg             // http://127.0.0.1:19788  (resolved at runtime)
 *   ep.daemon         // http://127.0.0.1:19786
 *   ep.isTg(url)      // true when a captured URL targets orig-tg
 *   ep.assertTgTraffic(count, label)  // throws when count === 0
 *   await ep.assertTgAlive(label)     // throws when orig-tg stopped answering mid-run
 *
 * Choosing between the two guards: assertTgTraffic is only valid where a
 * non-zero count is GUARANTEED by the product's contract. Where zero is a
 * legitimate (often desired) outcome, asserting non-zero encodes the buggy
 * behaviour as the baseline -- use assertTgAlive there instead.
 */

const http = require('node:http')

const DEFAULT_DAEMON = 'http://127.0.0.1:19786'
const DEFAULT_APP = 'http://127.0.0.1:5180'

const stripSlash = (u) => String(u || '').replace(/\/+$/, '')

/**
 * Print a fatal, endpoint-naming error and exit non-zero. Used only before the
 * browser is launched, so exiting here never leaks a browser process.
 * @param {string} msg
 * @returns {never}
 */
function fatal(msg) {
  console.error(`\n[endpoints] FATAL: ${msg}`)
  process.exit(1)
}

/**
 * GET a URL over loopback. Node's http module never consults HTTP_PROXY, so the
 * machine's local proxy is bypassed the same way `curl --noproxy '*'` does.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{status:number, body:string, contentType:string}>}
 */
function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () =>
        resolve({ status: res.statusCode, body, contentType: res.headers['content-type'] || '' }),
      )
    })
    req.on('error', (e) => reject(e))
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
  })
}

/** @type {null | {daemon:string, app:string, tg:string, tgPort:number, config:object, isTg:Function, assertTgTraffic:Function, assertTgAlive:Function}} */
let _resolved = null

/**
 * Resolve all service endpoints once (memoised).
 * @returns {Promise<object>} the resolved endpoint descriptor
 */
async function resolve() {
  if (_resolved) return _resolved

  const daemon = stripSlash(process.env.DAEMON_URL || process.env.ORIG_DAEMON_API || DEFAULT_DAEMON)
  const configUrl = `${daemon}/api/config`

  let raw
  try {
    raw = await httpGet(configUrl)
  } catch (e) {
    fatal(
      `cannot reach daemon config endpoint ${configUrl} (${e.message}). ` +
        `Refusing to guess the orig-tg port; start the dev stack or set DAEMON_URL.`,
    )
  }
  if (raw.status !== 200) {
    fatal(`daemon config endpoint ${configUrl} returned HTTP ${raw.status}. Refusing to guess the orig-tg port.`)
  }
  let config
  try {
    config = JSON.parse(raw.body)
  } catch (e) {
    fatal(`daemon config endpoint ${configUrl} did not return JSON (${e.message}).`)
  }
  // orig-tg 端口解析：旧契约 `tg_port`（BUG-358 前）→ 新契约 `plugins[]` 的
  // id="tg".port（BUG-358 后，插件化即插即用）。两者皆无才 FATAL —— 绝不猜 19787。
  let tgPort = null
  if (Number.isInteger(config.tg_port) && config.tg_port > 0) {
    tgPort = config.tg_port
  } else if (Array.isArray(config.plugins)) {
    const tgPlugin = config.plugins.find((p) => p && p.id === 'tg')
    if (tgPlugin && Number.isInteger(tgPlugin.port) && tgPlugin.port > 0) {
      tgPort = tgPlugin.port
    }
  }
  if (tgPort === null) {
    fatal(
      `daemon config ${configUrl} has no usable orig-tg port ` +
        `(neither numeric "tg_port" nor plugins[] entry id="tg" with numeric port). ` +
        `Refusing to guess the orig-tg port.`,
    )
  }

  const overrideTg = stripSlash(process.env.TG_URL || process.env.ORIG_TG_API || '')
  const tg = overrideTg || `http://127.0.0.1:${tgPort}`
  const app = stripSlash(process.env.APP_URL || process.env.ORIG_APP_API || DEFAULT_APP)

  /**
   * Strict orig-tg liveness check. A bare HTTP 200 is NOT sufficient: measured on
   * this machine, the vite dev server (:5180) answers ANY unknown path with
   * `200 text/html` (SPA fallback), so a wrong-but-live port would sail through a
   * status-only check -- the exact silent false-green this module exists to kill.
   * orig-tg's documented response is `200 application/json {"status":"ok"}`.
   *
   * Residual limitation, stated honestly: the daemon's /health returns the
   * IDENTICAL payload (measured), so this rejects non-JSON / non-ok responders but
   * cannot tell orig-tg apart from the daemon on the same host.
   * @param {number} timeoutMs
   * @returns {Promise<null|string>} null when healthy, else a human-readable reason
   */
  async function tgHealthFailure(timeoutMs = 3000) {
    const raw = await httpGet(`${tg}/health`, timeoutMs)
    if (raw.status !== 200) return `HTTP ${raw.status}`
    if (!/application\/json/i.test(raw.contentType)) {
      return `content-type is ${raw.contentType || '(none)'}, expected application/json`
    }
    let parsed
    try {
      parsed = JSON.parse(raw.body)
    } catch (_e) {
      return `body is not JSON (${JSON.stringify(raw.body.slice(0, 60))})`
    }
    if (!parsed || parsed.status !== 'ok') {
      return `body is ${JSON.stringify(raw.body.slice(0, 60))}, expected {"status":"ok"}`
    }
    return null
  }

  // Reachability self-check: a wrong (or deliberately forced) port must fail
  // LOUDLY here rather than silently yielding a "0 requests" capture.
  if (process.env.ORIG_ENDPOINTS_NO_PING !== '1') {
    // BUG-422：orig-tg 的 /health 实测要 ~3.6s（内部做链路探测），旧实现单发 4s
    // 会把「慢但活着」打成「不可达」——同机 /api/media/stats 只要 4ms，端口是对的。
    // 严格性一点不放宽（仍要 200 + application/json + {"status":"ok"}，错端口
    // 的 SPA 兜底/拒连照旧 FATAL），只把慢响应与真故障区分开：3 轮 × 15s。
    let why = 'not attempted'
    let threw = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        why = await tgHealthFailure(15000)
        threw = null
        if (!why) break
      } catch (e) {
        why = e.message
        threw = e
      }
      if (attempt < 3) {
        console.log(`[endpoints] tg ${tg}/health attempt#${attempt} failed (${why}) — retrying`)
      }
    }
    if (why) {
      fatal(
        threw
          ? `orig-tg endpoint ${tg} is not reachable (${why}) after 3 attempts. ` +
              (overrideTg ? 'TG_URL override is wrong. ' : '') +
              `Resolved from ${configUrl} (tg port=${tgPort}). ` +
              `Refusing to run a probe that would report 0 requests.`
          : `orig-tg endpoint ${tg}/health did not answer as orig-tg (${why}) after 3 attempts. ` +
              (overrideTg ? 'TG_URL override is wrong. ' : '') +
              `Resolved from ${configUrl} (tg port=${tgPort}).`,
      )
    }
  }

  let tgOrigin
  try {
    tgOrigin = new URL(tg)
  } catch (_e) {
    tgOrigin = null
  }

  /**
   * True when a captured URL targets orig-tg. Matches on origin/host so the
   * resolved port is compared structurally rather than by string prefix only.
   * @param {string} url
   * @returns {boolean}
   */
  function isTg(url) {
    const s = String(url || '')
    if (s.startsWith(tg)) return true
    if (!tgOrigin) return false
    try {
      const x = new URL(s)
      return x.host === tgOrigin.host
    } catch (_e) {
      return false
    }
  }

  /**
   * Guard against the exact silent-failure mode this module exists to kill:
   * a non-empty capture window with ZERO requests to orig-tg means the port is
   * wrong (or the capture is broken) -- never report it as "no traffic".
   * @param {number} count captured orig-tg requests
   * @param {string} label human-readable window label
   */
  function assertTgTraffic(count, label) {
    if (count > 0) return
    throw new Error(
      `[endpoints] ${label}: captured 0 requests to orig-tg (${tg}). ` +
        `A wrong port produces exactly this "0 traffic" result -- refusing to report it as success. ` +
        `Verify the CDP capture and that the app actually talks to ${tg}.`,
    )
  }

  /**
   * Guard for windows where ZERO orig-tg requests is a legitimate outcome.
   * Asserting a non-zero count there would encode pre-fix behaviour as the
   * baseline and fail a correctly fixed build (BUG-241: the panel auto-selects
   * the first monitored channel at mount, so clicking that same row is an
   * idempotent re-select that correctly issues no new request).
   *
   * The failure mode still worth catching is a mid-run endpoint drift, so
   * re-check liveness instead of constraining the expected count.
   * @param {string} label human-readable window label
   * @returns {Promise<void>} rejects when orig-tg stopped answering
   */
  async function assertTgAlive(label) {
    // Deliberately NOT gated on ORIG_ENDPOINTS_NO_PING: that variable only skips the
    // startup ping, and gating this guard on it would make the guard impossible to
    // falsify (a verification guard that cannot be shown to fail is not a guard).
    let why
    try {
      why = await tgHealthFailure(3000)
    } catch (e) {
      throw new Error(
        `[endpoints] ${label}: orig-tg ${tg} stopped answering mid-run (${e.message}). ` +
          `A dead/renamed endpoint produces exactly the "0 requests" result this window reports.`,
      )
    }
    if (why) {
      throw new Error(`[endpoints] ${label}: orig-tg ${tg} stopped answering as orig-tg mid-run (${why}).`)
    }
  }

  _resolved = { daemon, app, tg, tgPort, config, isTg, assertTgTraffic, assertTgAlive }
  console.log(
    `[endpoints] daemon=${daemon} app=${app} tg=${tg} ` +
      `(tg_port=${tgPort} from ${configUrl}${overrideTg ? `, TG_URL override=${overrideTg}` : ''})`,
  )
  return _resolved
}

module.exports = { resolve, DEFAULT_DAEMON, DEFAULT_APP }
