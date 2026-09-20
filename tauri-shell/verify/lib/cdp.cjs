'use strict'

/**
 * Zero-dependency Chrome DevTools Protocol (CDP) driver.
 *
 * BUG-086: `tauri-shell` cannot depend on `playwright` (its browser download is
 * impossible in constrained/offline environments), so the acceptance channel must
 * work with Node built-ins only. This module drives a locally installed
 * Edge/Chrome over CDP using Node's built-in `WebSocket` (Node >= 22) plus the
 * standard library -- no `node_modules` required at all.
 *
 * Guarantees:
 *   - auto-detects a local Edge/Chrome (overridable via EDGE_PATH / CHROME_PATH)
 *   - launches a *resident* headless instance on a probed free port (never 9333
 *     hard-coded, so parallel runs cannot collide)
 *   - polls /json/version until ready and fails loudly on timeout (never hangs)
 *   - `close()` always kills the browser process tree (no orphan processes)
 *
 * API: launch() -> browser; browser.newPage() -> page
 *      page.goto(url, opts) / content() / evaluate(fn, ...args) /
 *      screenshot(path) / consoleErrors() / pageErrors() / close()
 *
 * Usage:
 *   const cdp = require('./lib/cdp.cjs')
 *   const browser = await cdp.launch()
 *   const page = await browser.newPage()
 *   await page.goto('http://127.0.0.1:5180/')
 *   const html = await page.content()
 *   await browser.close()
 */

const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

/** Default viewport used for every new page. */
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 })

/** Max time (ms) to wait for the DevTools HTTP endpoint to answer. */
const DEFAULT_READY_TIMEOUT_MS = 30000

/**
 * Windows browser candidates, composed from environment variables.
 *
 * Drive letters are deliberately NOT hard-coded: scripts containing
 * machine-absolute paths are rejected by the pollution gate (AGENTS.md §6),
 * and a hard-coded path would break on any machine with a different layout.
 * @returns {Array<string>}
 */
function windowsCandidates() {
  const out = []
  const sysDrive = process.env.SystemDrive || ''
  const pf86 = process.env['ProgramFiles(x86)'] || (sysDrive ? sysDrive + '\\Program Files (x86)' : '')
  const pf = process.env.ProgramFiles || (sysDrive ? sysDrive + '\\Program Files' : '')
  const localAppData = process.env.LOCALAPPDATA || ''
  // Edge first (preferred), then Chrome -- keeps the documented probe order.
  for (const base of [pf86, pf]) {
    if (base) out.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  for (const base of [pf86, pf]) {
    if (base) out.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  if (localAppData) {
    out.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    out.push(path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  }
  return out
}

/** Browser binaries probed in order; first existing one wins. */
function browserCandidates() {
  const candidates = []
  const envPaths = [process.env.EDGE_PATH, process.env.CHROME_PATH].filter(Boolean)
  candidates.push(...envPaths)

  if (process.platform === 'win32') {
    candidates.push(...windowsCandidates())
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    )
  }
  return candidates
}

/**
 * Locate a usable Edge/Chrome binary.
 * @returns {string} absolute path to the browser executable
 * @throws {Error} when no candidate exists on disk
 */
function findBrowser() {
  const tried = browserCandidates()
  for (const candidate of tried) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch (_err) {
      // Unreadable path -- treat as "not found" and keep probing.
    }
  }
  throw new Error(
    'CDP: no local Edge/Chrome found. Tried:\n  ' +
      tried.join('\n  ') +
      '\nSet EDGE_PATH or CHROME_PATH to override.',
  )
}

/** Sleep helper. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Probe a free TCP port on 127.0.0.1.
 * @returns {Promise<number>} a port number that was free at probe time
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * GET a JSON document over HTTP (loopback only, proxy env is never consulted).
 * @param {string} url target url
 * @param {number} timeoutMs per-request timeout
 * @returns {Promise<object|null>} parsed JSON, or null on any failure
 */
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish(null)
          return
        }
        try {
          finish(JSON.parse(body))
        } catch (_err) {
          finish(null)
        }
      })
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => {
      req.destroy()
      finish(null)
    })
  })
}

/**
 * Poll http://127.0.0.1:<port>/json/version until the DevTools endpoint answers.
 * @param {number} port remote debugging port
 * @param {number} timeoutMs overall timeout
 * @returns {Promise<object>} the /json/version payload
 */
async function waitForDevtools(port, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    const info = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 2000)
    if (info && info.webSocketDebuggerUrl) return info
    await delay(150)
  }
  throw new Error(
    `CDP: DevTools endpoint on 127.0.0.1:${port} did not become ready within ${timeoutMs}ms (${lastError}).`,
  )
}

/**
 * Minimal CDP connection over Node's built-in WebSocket.
 *
 * Multiplexes browser-level and (flattened) session-level traffic on one socket:
 * commands carry an optional `sessionId`, events are dispatched by method name.
 */
class CdpConnection {
  /**
   * @param {string} wsUrl webSocketDebuggerUrl from /json/version
   * @param {number} timeoutMs default command timeout
   */
  constructor(wsUrl, timeoutMs = 30000) {
    this.wsUrl = wsUrl
    this.timeoutMs = timeoutMs
    this.nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map()
    /** @type {Map<string, Array<Function>>} */
    this.listeners = new Map()
    this.connected = false
  }

  /** Open the socket and resolve once usable. */
  async connect() {
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.connected = true
        resolve()
      }
      const onError = err => reject(new Error(`CDP: websocket error (${err && err.message ? err.message : err})`))
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })
    })
    ws.addEventListener('message', event => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
      let msg
      try {
        msg = JSON.parse(raw)
      } catch (_err) {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) {
          entry.reject(new Error(`CDP ${msg.method || 'command'} failed: ${msg.error.message || JSON.stringify(msg.error)}`))
        } else {
          entry.resolve(msg.result || {})
        }
        return
      }
      if (msg.method) {
        const handlers = this.listeners.get(msg.method)
        if (handlers) {
          for (const handler of handlers.slice()) handler(msg.params || {})
        }
      }
    })
    return this
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} method event name
   * @param {Function} handler callback
   * @returns {Function} unsubscribe
   */
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(handler)
    return () => {
      const handlers = this.listeners.get(method)
      if (!handlers) return
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    }
  }

  /**
   * Send a CDP command and await its result.
   * @param {string} method command name
   * @param {object} params command params
   * @param {object} options `{ sessionId, timeoutMs }`
   * @returns {Promise<object>} command result
   */
  send(method, params = {}, options = {}) {
    if (!this.connected) return Promise.reject(new Error('CDP: connection is not open'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (options.sessionId) payload.sessionId = options.sessionId
    const timeoutMs = options.timeoutMs || this.timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP: ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        },
      })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** Wait for a single occurrence of an event, with optional predicate. */
  waitFor(method, predicate = () => true, timeoutMs = this.timeoutMs, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`CDP: timed out waiting for event ${method} after ${timeoutMs}ms`))
      }, timeoutMs)
      const unsubscribe = this.on(method, params => {
        if (sessionId && params.sessionId && params.sessionId !== sessionId) return
        let ok = false
        try {
          ok = predicate(params)
        } catch (_err) {
          ok = false
        }
        if (!ok) return
        clearTimeout(timer)
        unsubscribe()
        resolve(params)
      })
    })
  }

  /** Close the socket. */
  closeSocket() {
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close()
    } catch (_err) {
      // Best effort: a dead socket is already "closed" for our purposes.
    }
    this.connected = false
  }
}

/** A single CDP target (tab) with the minimal page API used by verify scripts. */
class Page {
  /**
   * @param {CdpConnection} conn CDP connection
   * @param {string} sessionId flattened session id
   */
  constructor(conn, sessionId) {
    this.conn = conn
    this.sessionId = sessionId
    /** @type {Array<string>} */
    this._consoleErrors = []
    /** @type {Array<string>} */
    this._pageErrors = []
    this._url = 'about:blank'
  }

  /** Enable the domains needed for rendering, logging and screenshots. */
  async _enable() {
    const sessionId = this.sessionId
    this._offConsole = this.conn.on('Runtime.consoleAPICalled', params => {
      if (params.type !== 'error') return
      const text = (params.args || [])
        .map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || ''))
        .join(' ')
      this._consoleErrors.push(text)
    })
    this._offLog = this.conn.on('Log.entryAdded', params => {
      const entry = params.entry || {}
      if (entry.level !== 'error') return
      // Keep the url in the message: without it a bare "404 (Not Found)" cannot be
      // told apart from a real app failure (e.g. the implicit /favicon.ico probe).
      const text = entry.url ? `${entry.text || ''} [${entry.url}]` : String(entry.text || '')
      this._consoleErrors.push(text)
    })
    this._offException = this.conn.on('Runtime.exceptionThrown', params => {
      const details = params.exceptionDetails || {}
      const text = (details.exception && details.exception.description) || details.text || 'unknown exception'
      this._pageErrors.push(String(text))
    })

    await this.conn.send('Page.enable', {}, { sessionId })
    await this.conn.send('Runtime.enable', {}, { sessionId })
    try {
      await this.conn.send('Log.enable', {}, { sessionId })
    } catch (_err) {
      // Log domain is optional; consoleAPICalled already covers console.error.
    }
    await this.conn.send(
      'Emulation.setDeviceMetricsOverride',
      { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height, deviceScaleFactor: 1, mobile: false },
      { sessionId },
    )
  }

  /** Current page url as known to the driver. */
  url() {
    return this._url
  }

  /**
   * Navigate and wait for the document (and, by default, the React root) to settle.
   * @param {string} url target url
   * @param {object} options `{ waitUntil, timeout, settleMs, waitForRoot, rootSelector }`
   * @returns {Promise<void>}
   */
  async goto(url, options = {}) {
    const waitUntil = options.waitUntil || 'load'
    const timeout = options.timeout || 30000
    const settleMs = options.settleMs === undefined ? 1200 : options.settleMs
    const waitForRoot = options.waitForRoot !== false
    const rootSelector = options.rootSelector || '#root'
    const sessionId = this.sessionId

    const loadEvent = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
    const loadPromise = this.conn.waitFor(loadEvent, () => true, timeout, sessionId)
    const result = await this.conn.send('Page.navigate', { url }, { sessionId })
    if (result && result.errorText) {
      throw new Error(`CDP: navigation to ${url} failed: ${result.errorText}`)
    }
    await loadPromise
    this._url = url

    if (waitForRoot) {
      await this.waitForFunction(
        selector => {
          const root = document.querySelector(selector)
          return Boolean(root && root.children.length > 0)
        },
        { timeout, intervalMs: 200, args: [rootSelector] },
      )
    }
    if (settleMs > 0) await delay(settleMs)
  }

  /**
   * Poll a predicate inside the page until it returns true.
   * @param {Function} fn predicate executed in the page
   * @param {object} options `{ timeout, intervalMs, args }`
   * @returns {Promise<void>}
   */
  async waitForFunction(fn, options = {}) {
    const timeout = options.timeout || 30000
    const intervalMs = options.intervalMs || 200
    const args = options.args || []
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await this.evaluate(fn, ...args)
      if (value) return
      await delay(intervalMs)
    }
    throw new Error(`CDP: waitForFunction timed out after ${timeout}ms`)
  }

  /**
   * Evaluate a function (or expression string) in the page and return its value.
   * @param {Function|string} fnOrExpr function or expression
   * @param {...any} args arguments (functions only)
   * @returns {Promise<any>} JSON-serializable result
   */
  async evaluate(fnOrExpr, ...args) {
    let expression
    if (typeof fnOrExpr === 'function') {
      const argsJson = args.map(arg => JSON.stringify(arg === undefined ? null : arg)).join(',')
      expression = `(async () => { return (${fnOrExpr.toString()})(${argsJson}) })()`
    } else {
      expression = `(() => { return (${String(fnOrExpr)}) })()`
    }
    const result = await this.conn.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      { sessionId: this.sessionId },
    )
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails
      throw new Error(
        `CDP: evaluate threw: ${(details.exception && details.exception.description) || details.text || 'unknown'}`,
      )
    }
    return result ? result.result && result.result.value : undefined
  }

  /**
   * Full *rendered* HTML (post-JS), equivalent to Playwright's `content()`.
   * @returns {Promise<string>}
   */
  async content() {
    const html = await this.evaluate(() => document.documentElement.outerHTML)
    return String(html || '')
  }

  /** Visible text of the rendered document. */
  async innerText() {
    const text = await this.evaluate(() => document.body ? document.body.innerText : '')
    return String(text || '')
  }

  /**
   * Capture a PNG screenshot.
   * @param {string} filePath destination (parent dirs created automatically)
   * @param {object} options `{ fullPage }`
   * @returns {Promise<string>} the path written
   */
  async screenshot(filePath, options = {}) {
    const target = path.resolve(filePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const params = { format: 'png' }
    if (options.fullPage) params.captureBeyondViewport = true
    const result = await this.conn.send('Page.captureScreenshot', params, {
      sessionId: this.sessionId,
      timeoutMs: 60000,
    })
    fs.writeFileSync(target, Buffer.from(String(result.data || ''), 'base64'))
    return target
  }

  /**
   * Console error messages collected so far.
   * @returns {Array<string>}
   */
  consoleErrors() {
    return this._consoleErrors.slice()
  }

  /**
   * Uncaught page exceptions collected so far.
   * @returns {Array<string>}
   */
  pageErrors() {
    return this._pageErrors.slice()
  }

  /** Detach listeners for this page (browser close also cleans up). */
  dispose() {
    for (const off of [this._offConsole, this._offLog, this._offException]) {
      if (typeof off === 'function') off()
    }
  }
}

/** A launched browser instance owning one child process. */
class Browser {
  /**
   * @param {object} refs `{ proc, conn, port, executable, userDataDir, version }`
   */
  constructor(refs) {
    this.proc = refs.proc
    this.conn = refs.conn
    this.port = refs.port
    this.executable = refs.executable
    this.userDataDir = refs.userDataDir
    this.version = refs.version
    /** @type {Array<Page>} */
    this.pages = []
    this._closed = false
  }

  /**
   * Open a new tab and return a Page bound to it.
   * @returns {Promise<Page>}
   */
  async newPage() {
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this.conn, sessionId)
    await page._enable()
    this.pages.push(page)
    return page
  }

  /**
   * Kill the browser and all its children; safe to call twice.
   * @returns {Promise<void>}
   */
  async close() {
    if (this._closed) return
    this._closed = true
    for (const page of this.pages) page.dispose()
    try {
      await Promise.race([
        this.conn.send('Browser.close', {}, { timeoutMs: 3000 }),
        delay(3000),
      ])
    } catch (_err) {
      // Ignore: we are tearing down anyway and fall through to process kill.
    }
    this.conn.closeSocket()
    await this._killProcess()
    this._removeUserDataDir()
  }

  /** Wait up to 5s for a clean exit, then force-kill the process tree. */
  async _killProcess() {
    const proc = this.proc
    if (!proc) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const exited = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 5000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (exited) return
    const pid = proc.pid
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch (_err) {
      // Already gone or access denied -- nothing left to do.
    }
  }

  /** Best-effort cleanup of the temp profile directory. */
  _removeUserDataDir() {
    try {
      if (this.userDataDir) fs.rmSync(this.userDataDir, { recursive: true, force: true })
    } catch (_err) {
      // Temp dir cleanup is best effort; OS temp sweeps the rest.
    }
  }
}

/**
 * Launch a resident headless Edge/Chrome and connect to its DevTools endpoint.
 *
 * @param {object} options `{ executable, port, readyTimeoutMs, args, headless }`
 * @returns {Promise<Browser>}
 */
async function launch(options = {}) {
  const executable = options.executable || findBrowser()
  const port = options.port || (await getFreePort())
  const readyTimeoutMs = options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS
  const headless = options.headless === undefined ? true : options.headless
  const userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-cdp-'))

  const args = [
    headless ? '--headless=new' : '--headless',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-proxy-server',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    'about:blank',
  ]
  if (Array.isArray(options.args) && options.args.length > 0) args.push(...options.args)

  const proc = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
  proc.on('error', err => {
    // Surfaced by waitForDevtools timeout if the binary cannot start at all.
    console.error(`CDP: failed to spawn browser: ${err.message}`)
  })

  let version
  try {
    version = await waitForDevtools(port, readyTimeoutMs)
  } catch (err) {
    try {
      proc.kill()
    } catch (_err) {
      // Process already dead.
    }
    throw err
  }

  const conn = new CdpConnection(version.webSocketDebuggerUrl)
  await conn.connect()
  return new Browser({ proc, conn, port, executable, userDataDir, version })
}

module.exports = { launch, findBrowser, getFreePort, DEFAULT_VIEWPORT, Browser, Page, CdpConnection }
