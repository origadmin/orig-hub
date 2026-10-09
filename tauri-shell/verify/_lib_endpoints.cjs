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
 *            -> `tg_port` read from GET <daemon>/api/config   (source of truth)
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
 * @returns {Promise<{status:number, body:string}>}
 */
function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', (e) => reject(e))
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
  })
}

/** @type {null | {daemon:string, app:string, tg:string, tgPort:number, config:object, isTg:Function, assertTgTraffic:Function}} */
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
  if (!Number.isInteger(config.tg_port) || config.tg_port <= 0) {
    fatal(
      `daemon config ${configUrl} has no usable numeric "tg_port" (got ${JSON.stringify(config.tg_port)}).`,
    )
  }

  const overrideTg = stripSlash(process.env.TG_URL || process.env.ORIG_TG_API || '')
  const tg = overrideTg || `http://127.0.0.1:${config.tg_port}`
  const app = stripSlash(process.env.APP_URL || process.env.ORIG_APP_API || DEFAULT_APP)

  // Reachability self-check: a wrong (or deliberately forced) port must fail
  // LOUDLY here rather than silently yielding a "0 requests" capture.
  if (process.env.ORIG_ENDPOINTS_NO_PING !== '1') {
    let health
    try {
      health = await httpGet(`${tg}/health`)
    } catch (e) {
      fatal(
        `orig-tg endpoint ${tg} is not reachable (${e.message}). ` +
          (overrideTg ? 'TG_URL override is wrong. ' : '') +
          `Resolved from ${configUrl} (tg_port=${config.tg_port}). ` +
          `Refusing to run a probe that would report 0 requests.`,
      )
    }
    if (health.status !== 200) {
      fatal(
        `orig-tg endpoint ${tg}/health returned HTTP ${health.status}. ` +
          (overrideTg ? 'TG_URL override is wrong. ' : '') +
          `Resolved from ${configUrl} (tg_port=${config.tg_port}).`,
      )
    }
  }

  const tgPort = config.tg_port
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

  _resolved = { daemon, app, tg, tgPort, config, isTg, assertTgTraffic }
  console.log(
    `[endpoints] daemon=${daemon} app=${app} tg=${tg} ` +
      `(tg_port=${tgPort} from ${configUrl}${overrideTg ? `, TG_URL override=${overrideTg}` : ''})`,
  )
  return _resolved
}

module.exports = { resolve, DEFAULT_DAEMON, DEFAULT_APP }
