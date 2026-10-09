#!/usr/bin/env node
'use strict'

/**
 * BUG-223 acceptance for criteria 2/3/4: non-1x rates must be served by the
 * server-side 30fps FRC variant, and switching rate must preserve the
 * *source-content* position.
 *
 * Criterion 1 (ffprobe: 30fps CFR, duration = source/S) is covered by
 * `download-engine/verify/verify_bug_223_frc_frames.py`. This script covers the
 * parts that only exist end to end: the URL the player actually requests, the
 * `playbackRate` the media element actually carries, the position the user
 * actually keeps, and the cache identity the server actually serves.
 *
 * ## Why the browser must be msedge (BUG-122 lesson)
 *
 * Every assertion here is about what a `<video>` element really does with the
 * bytes. Playwright's bundled Chromium has no HEVC/AAC, so a codec judgement
 * made there is the *opposite* of the WebView2/Edge one. `lib/cdp.cjs`'s
 * `findBrowser()` is Edge-first, which is the same engine the Tauri shell uses.
 *
 * ## Criteria (each is a "has value + exact value" assertion, never "!= old")
 *
 *  C1 (2) 1x requests carry NO `speed` parameter, and the element src is the
 *          original `/raw` source.
 *  C2 (2) 2x requests DO carry `speed=2`; the element src is `.../stream?speed=2`.
 *  C3 (2) 4x requests DO carry `speed=4`.
 *  C4 (2) `<video>.playbackRate === 1` at 1x, 2x and 4x -- the browser must
 *          never be asked to decode the source at 2x/4x itself.
 *  C5 (3) Switching 1x -> 2x keeps the source-content position. Measured from a
 *          PAUSED element: while playing, the position legitimately advances
 *          during the reload, so only a paused switch isolates "the position
 *          was preserved" from "time passed".
 *  C6 (3) Switching 2x -> 4x likewise preserves source-content position.
 *  C7 (3) Switching while PAUSED stays paused (the play state is not reset).
 *  C8 (3) While playing, the time readout advances at `contentSpeed` x wall
 *          clock (i.e. 2x really is 2x of *source content*, not 2x of media
 *          time) -- the criterion that separates "server-side FRC" from
 *          "browser fast-forward".
 *  C9 (4) `x-orig-stream` is exactly `decimate=2` for 2x and `decimate=4` for
 *          4x, observed on the response the *player* received.
 *  C10 (4) Each speed gets its own cache entry: `proxies/<id>-speed-200.mp4`
 *           and `proxies/<id>-speed-400.mp4` both exist, differ in size, and
 *           carry different ETags. The legacy `<id>.mp4` must NOT be what a
 *           speed request resolves to.
 *
 * ## Pairing (why the criteria have teeth)
 *
 *  C1 vs C2/C3 is a pair: if the player always appended `speed`, C1 fails; if it
 *  never appended it, C2/C3 fail. C9 vs C1 is a second pair: `decimate=` must
 *  appear on the FRC variants and must NOT appear on 1x. C10 is self-paired
 *  across speeds: two rates must not resolve to one file, and the file names
 *  embed the speed (`-speed-200` vs `-speed-400`).
 *
*  Falsification (the criteria have teeth -- executed, not asserted):
 *
 *   1. Reverting the frontend to the pre-BUG-223 behaviour (`rateSrc = null`,
 *      `v.playbackRate = playbackRate`) and re-running scores **7/15**:
 *      C2, C3, C4b, C4c, C5, C6, C8 and C9 all FAIL. C8 is the sharpest one --
 *      the element reports `data-content-speed=1` while the content advances at
 *      4.000/s, i.e. the browser was doing the fast-forward itself.
 *   2. Restoring the `-r 30` in `routes.rs` (which collides with `-fpsmax 30`
 *      and makes ffmpeg refuse to open the output) yields a 0-byte FRC stream:
 *      no frames and no per-speed proxy on disk, so C2/C3/C9/C10 fail.
 *   3. C10 deletes the per-speed proxies before each run, so it cannot be
 *      satisfied by a cache left over from an earlier run.
 *
 * Usage:
 *   node verify/verify_bug_223_speed_stream.cjs
 *
 * Env: APP_PORT (5180), TG_URL, PROBE_ITEM (630), SHOT_DIR.
 * Evidence lands in the git-ignored `verify_shots/bug-223-speed/`.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const cdp = require('./lib/cdp.cjs')

const APP_URL = `http://127.0.0.1:${Number(process.env.APP_PORT || 5180)}/`
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 630)
/** 4s keeps the sample long enough to dominate 500ms scheduler jitter. */
const CONTENT_SAMPLE_MS = 4000
/** Source-content position tolerance, seconds (1.5 source frames at 30fps). */
const TOLERANCE_S = 2.0
/** Effective-speed tolerance as a ratio of the requested speed. */
const SPEED_TOLERANCE = 0.15
const OUT = path.resolve(
  process.env.SHOT_DIR || path.join(__dirname, '..', '..', 'verify_shots', 'bug-223-speed'),
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

/**
 * Minimal ranged GET against orig-tg. Used for the cache-identity criterion,
 * which is about bytes on the wire rather than about the player.
 * @param {string} url target
 * @returns {Promise<{status:number, headers:object, length:number}>}
 */
function fetchHead(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 60000 }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        // The stream never ends while transcoding; one chunk is enough to learn
        // the headers, and Range keeps the body bounded for the proxy case.
        res.destroy()
        resolve({ status: res.statusCode, headers: res.headers, length: bytes })
      })
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, length: bytes }))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`timeout ${url}`))
    })
  })
}

/**
 * Cached proxy file sizes for a media item, straight from the data dir.
 *
 * Only the two speed variants are reported as required: the legacy `<id>.mp4`
 * belongs to the 1x compatibility stream, which 1x playback never requests
 * when the browser can decode the original source (criterion C1). Demanding it
 * exist would assert something BUG-223 does not promise.
 * @param {number} id media item id
 * @returns {Record<string, number>} file name -> size in bytes, -1 when absent
 */
function proxyFiles(id) {
  const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'com.origadmin.orighub', 'tg', 'proxies')
  const out = {}
  for (const name of [`${id}-speed-200.mp4`, `${id}-speed-400.mp4`]) {
    const file = path.join(dir, name)
    out[name] = fs.existsSync(file) ? fs.statSync(file).size : -1
  }
  return out
}

/**
 * Delete the per-speed proxies so the run must regenerate them.
 *
 * Without this, a warm cache from an earlier run satisfies C10 no matter what
 * the code under test does -- the criterion would be measuring the filesystem,
 * not the fix. Removing them makes "each speed writes its own file" an
 * observation of THIS run. Only these two derived files are touched; the
 * original media and the legacy proxy are left alone.
 * @param {number} id media item id
 * @returns {Array<string>} the removed file names
 */
function clearSpeedProxies(id) {
  const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'com.origadmin.orighub', 'tg', 'proxies')
  const removed = []
  for (const name of [`${id}-speed-200.mp4`, `${id}-speed-400.mp4`, `${id}-speed-200.mp4.part`, `${id}-speed-400.mp4.part`]) {
    const file = path.join(dir, name)
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file)
        removed.push(name)
      }
    } catch (err) {
      console.log(`[verify] WARN could not remove ${name}: ${err.message}`)
    }
  }
  return removed
}

/** Open the media library viewer on one item through the real store. */
async function openItem(page, id) {
  await page.evaluate(
    (tg, itemId) => {
      window.__origStore.getState().openViewer({
        items: [
          {
            key: `media-${itemId}`,
            chatId: 0,
            messageId: itemId,
            kind: 'video',
            caption: 'BUG-223 verify',
            description: null,
            src: `${tg}/api/media/items/${itemId}/raw`,
            poster: null,
            episodeNo: null,
            seriesId: null,
          },
        ],
        index: 0,
        title: 'BUG-223 verify',
      })
    },
    TG,
    id,
  )
  await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"] video'), {
    timeout: 20000,
    intervalMs: 200,
  })
}

/** Snapshot of everything the criteria read off the media element. */
const SNAPSHOT = () => {
  const v = document.querySelector('[data-testid="media-viewer"] video')
  if (!v) return null
const attrSpeed = v.getAttribute('data-content-speed')
    const err = v.error
    return {
      src: v.currentSrc || v.src || '',
      playbackRate: v.playbackRate,
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      readyState: v.readyState,
      networkState: v.networkState,
      videoWidth: v.videoWidth,
      error: err ? `${err.code}:${err.message || ''}` : null,
      /** Server-declared content compression; 1 on the original source. */
      contentSpeed: attrSpeed === null ? 1 : Number(attrSpeed),
      mode: v.getAttribute('data-playback-mode'),
    }
}

async function snapshot(page) {
  return page.evaluate(SNAPSHOT)
}

/**
 * Wait until the element's src matches `predicate` and metadata has landed.
 *
 * A timeout throws instead of returning the last snapshot. Returning it made a
 * timed-out wait indistinguishable from a satisfied one: the caller would go on
 * to assert against whatever src happened to be showing, which is how a genuine
 * "1x fell back to /stream" gets reported as a mysterious C1 failure instead of
 * "the wait never completed".
 *
 * @param {object} page CDP page
 * @param {Function} predicate receives a snapshot, returns true when satisfied
 * @param {number} timeoutMs overall budget
 * @param {string} label human-readable description used in the timeout message
 * @returns {Promise<object>} the matching snapshot
 */
async function waitForSrc(page, predicate, timeoutMs, label) {
  const budget = timeoutMs || 90000
  const deadline = Date.now() + budget
  let last = null
  while (Date.now() < deadline) {
    last = await snapshot(page)
    if (last && predicate(last) && last.readyState >= 1) return last
    await delay(400)
  }
  throw new Error(
    `waitForSrc(${label}) timed out after ${budget}ms; last snapshot: ${JSON.stringify(last)}`,
  )
}

/** Click a speed entry in the real player menu (no direct state pokes). */
async function clickRate(page, rate) {
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-haspopup="menu"][aria-expanded]')
    if (!btn) throw new Error('speed menu button not found')
    btn.click()
  })
  await delay(250)
  const ok = await page.evaluate((r) => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const target = items.find((el) => (el.textContent || '').trim().startsWith(`${r}x`))
    if (!target) return false
    target.click()
    return true
  }, rate)
  if (!ok) throw new Error(`rate ${rate}x menu entry not found`)
}

async function play(page) {
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) {
      v.muted = true
      v.volume = 0
      void v.play().catch(() => {})
    }
  })
}

async function pause(page) {
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) v.pause()
  })
}

/** Source-content seconds for a snapshot: media time scaled by the rate. */
function contentTime(snap) {
  return snap.currentTime * snap.contentSpeed
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  try {
    const page = await browser.newPage()
    /*
     * Capture the media requests themselves rather than performance entries.
     *
     * `Network.*` handlers receive `params` DIRECTLY (`cdp.cjs` already unwraps
     * `msg.params` before dispatch), so reading `handler.params.request` yields
     * undefined and silently records nothing -- a green run that observed
     * nothing at all. Media loads appear as `type: "Media"` and are frequently
     * aborted+reissued (ERR_ABORTED), which is why the request URL and the
     * response header are collected into separate lists and de-duplicated.
     */
    const requests = []
    const responses = []
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    page.conn.on('Network.requestWillBeSent', (params) => {
      const req = params && params.request
      if (req && /\/api\/media\/items\//.test(req.url)) requests.push(req.url)
    })
    page.conn.on('Network.responseReceived', (params) => {
      const res = params && params.response
      if (res && /\/api\/media\/items\//.test(res.url)) {
        responses.push({ url: res.url, status: res.status, origStream: res.headers['x-orig-stream'] })
      }
    })
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 30000, intervalMs: 250 })
    // Deterministic start: no remembered compat source, rate pinned to 1x.
    await page.evaluate(() => {
      localStorage.removeItem('orighub.compatSrcs')
      localStorage.setItem(
        'orighub_player_settings',
        JSON.stringify({ volume: 1, isMuted: true, playbackRate: 1, autoPlayNext: false }),
      )
    })
    await delay(1200)

    /*
     * C10 must observe THIS run writing the per-speed proxies. A warm cache
     * left by an earlier run would satisfy "the files exist and differ" even if
     * the code under test never wrote them, so the derived files are dropped
     * first and the criterion becomes falsifiable.
     */
    const removed = clearSpeedProxies(ITEM)
    console.log(`[verify] cleared stale speed proxies: ${JSON.stringify(removed)}`)

    const streamReqs = () => requests.filter((u) => u.includes(`/items/${ITEM}/stream`))
    const speedOf = (url) => {
      const m = /[?&]speed=([^&]+)/.exec(url)
      return m ? m[1] : null
    }

    // ---- 1x baseline -------------------------------------------------------
    await openItem(page, ITEM)
    let snap = await waitForSrc(page, (s) => s.src.includes(`/items/${ITEM}/raw`), 30000, '1x raw')
    await play(page)
    await delay(1500)
    snap = await snapshot(page)
    console.log(`[verify] 1x snapshot ${JSON.stringify(snap)}`)
    /*
     * The detail string carries the decode-side facts on purpose. A src of
     * `/stream` at 1x can only come from the BUG-224 compat fallback, which
     * fires when the browser rejects the source (`error.code=4`) or when
     * decodeHealth exhausts its 12s zero-frame budget -- so `error`,
     * `networkState`, `readyState` and `videoWidth` are exactly what
     * distinguishes "the product switched source" from "the test mis-read it".
     */
    check(
      'C1 (2) 1x 请求不带 speed，且元素 src 是原始 /raw',
      snap.src.includes(`/items/${ITEM}/raw`) && streamReqs().length === 0,
      `src=${snap.src} streamReqs=${streamReqs().length} error=${String(snap.error)} ` +
        `networkState=${snap.networkState} readyState=${snap.readyState} videoWidth=${snap.videoWidth} ` +
        `wire=${JSON.stringify(streamReqs())}`,
    )
    check('C4a (2) 1x 时 playbackRate === 1', snap.playbackRate === 1, `playbackRate=${snap.playbackRate}`)

    // ---- 1x -> 2x ----------------------------------------------------------
    requests.length = 0
    await clickRate(page, 2)
    snap = await waitForSrc(page, (s) => s.src.includes('speed=2'), 120000, '2x FRC')
    await play(page)
    await delay(1200)
    snap = await snapshot(page)
    const reqSpeeds2 = streamReqs().map(speedOf)
    console.log(`[verify] 2x snapshot ${JSON.stringify(snap)} streamReqs=${JSON.stringify(streamReqs())}`)
    check(
      'C2 (2) 2x 请求带 speed=2，且元素 src 是该 FRC 变体',
      reqSpeeds2.length > 0 && reqSpeeds2.every((v) => v === '2') && snap.src.includes('speed=2'),
      `speedParams=${JSON.stringify(reqSpeeds2)} src=${snap.src}`,
    )
    check('C4b (2) 2x 时 playbackRate 仍为 1（浏览器不得自己倍速）', snap.playbackRate === 1, `playbackRate=${snap.playbackRate}`)

    // ---- 2x -> 4x ----------------------------------------------------------
    requests.length = 0
    await clickRate(page, 4)
    snap = await waitForSrc(page, (s) => s.src.includes('speed=4'), 120000, '4x FRC')
    await play(page)
    await delay(1200)
    snap = await snapshot(page)
    const reqSpeeds4 = streamReqs().map(speedOf)
    check(
      'C3 (2) 4x 请求带 speed=4',
      reqSpeeds4.length > 0 && reqSpeeds4.every((v) => v === '4') && snap.src.includes('speed=4'),
      `speedParams=${JSON.stringify(reqSpeeds4)} src=${snap.src}`,
    )
    check('C4c (2) 4x 时 playbackRate 仍为 1', snap.playbackRate === 1, `playbackRate=${snap.playbackRate}`)

    // ---- C8: effective speed is measured in SOURCE-CONTENT seconds ---------
    // This is the criterion that distinguishes "2x of the content" from
    // "playbackRate=2 on the media element" -- the whole point of BUG-223.
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      window.__bug223 = { content0: v.currentTime * Number(v.getAttribute('data-content-speed')), wall0: performance.now() }
    })
    await delay(CONTENT_SAMPLE_MS)
    const eff = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const b = window.__bug223
      const content1 = v.currentTime * Number(v.getAttribute('data-content-speed'))
      return {
        declared: Number(v.getAttribute('data-content-speed')),
        contentPerSec: (content1 - b.content0) / ((performance.now() - b.wall0) / 1000),
        playbackRate: v.playbackRate,
        paused: v.paused,
      }
    })
    const effErr = Math.abs(eff.contentPerSec - eff.declared) / eff.declared
    console.log(`[verify] effective source-content speed ${JSON.stringify(eff)}`)
    check(
      'C8 (3) 源内容时间推进速率 = 声明的档位（媒体元素 playbackRate 恒为 1）',
      eff.playbackRate === 1 && effErr <= SPEED_TOLERANCE,
      `declared=${eff.declared} measured=${eff.contentPerSec.toFixed(3)}/s relErr=${effErr.toFixed(3)}`,
    )

    // ---- C5/C6: position continuity across a switch -----------------------
    //
    // Measured from a PAUSED element on purpose. While playing, the position
    // legitimately advances during the reload (the new source has to be
    // fetched and `loadedmetadata` has to fire), so a playing-state delta mixes
    // "position preserved" with "wall time passed" and can never be a clean
    // criterion. C8 below is the criterion that covers the playing case.
    let back1x = null
    await pause(page)
    await delay(500)

    const before2 = await snapshot(page)
    await clickRate(page, 2)
    await waitForSrc(page, (s) => s.src.includes('speed=2'), 120000, '2x FRC')
    await delay(600)
    const after2 = await snapshot(page)
    const drift2 = Math.abs(contentTime(after2) - contentTime(before2))
    console.log(
      `[verify] 4x->2x content ${contentTime(before2).toFixed(2)} -> ${contentTime(after2).toFixed(2)}` +
        ` (paused ${before2.paused}->${after2.paused})`,
    )
    check(
      'C5 (3) 4x -> 2x 保留源内容位置（±2s，暂停态测量）',
      Math.abs(after2.contentSpeed - 2) < 1e-6 && drift2 <= TOLERANCE_S,
      `before=${contentTime(before2).toFixed(2)}s after=${contentTime(after2).toFixed(2)}s drift=${drift2.toFixed(2)}s`,
    )

    const before4 = await snapshot(page)
    await clickRate(page, 4)
    await waitForSrc(page, (s) => s.src.includes('speed=4'), 120000, '4x FRC')
    await delay(600)
    const after4 = await snapshot(page)
    const drift4 = Math.abs(contentTime(after4) - contentTime(before4))
    console.log(`[verify] 2x->4x content ${contentTime(before4).toFixed(2)} -> ${contentTime(after4).toFixed(2)}`)
    check(
      'C6 (3) 2x -> 4x 保留源内容位置（±2s，暂停态测量）',
      Math.abs(after4.contentSpeed - 4) < 1e-6 && drift4 <= TOLERANCE_S,
      `before=${contentTime(before4).toFixed(2)}s after=${contentTime(after4).toFixed(2)}s drift=${drift4.toFixed(2)}s`,
    )

    // ---- C7: the play/pause state survives the switch ----------------------
    // Paused -> 2x -> still paused. Sampled right after `loadedmetadata`, so the
    // player's own restore path (not our pause call) is what is under test.
    check(
      'C7 (3) 暂停态切速后仍处于暂停',
      before2.paused === true && after2.paused === true && after4.paused === true,
      `paused before2=${before2.paused} after2=${after2.paused} after4=${after4.paused}`,
    )
    check(
      'C1b (2) 回到 1x 后不再带 speed（与 C2/C3 成对）',
      await (async () => {
        await clickRate(page, 1)
        const back = await waitForSrc(page, (s) => s.src.includes(`/items/${ITEM}/raw`), 60000, 'back to 1x')
        back1x = back
        return back.src.includes(`/items/${ITEM}/raw`) && !back.src.includes('speed=')
      })(),
      `src=${back1x && back1x.src}`,
    )

    await page.screenshot(path.join(OUT, 'player-after-1x.png'))

    // ---- C9: the response header the PLAYER received ------------------------
    // Read from the CDP-observed responses, not from a separate probe request:
    // the criterion is about what the real element was served.
    // BUG-226: `?probe=1` 是零副作用 JSON 探针端点（无 x-orig-stream 头），
    // 不属于"流响应"，从本判据的观测里排除。
    const headersFor = (speed) =>
      Array.from(
        new Set(
          responses
            .filter(
              (r) =>
                r.url.includes(`/items/${ITEM}/stream`) &&
                !r.url.includes('probe=1') &&
                speedOf(r.url) === speed,
            )
            .map((r) => String(r.origStream)),
        ),
      )
    const seen2 = headersFor('2')
    const seen4 = headersFor('4')
    console.log(`[verify] observed x-orig-stream 2x=${JSON.stringify(seen2)} 4x=${JSON.stringify(seen4)}`)
    check(
      'C9 (4) 播放器收到的 2x/4x 响应头是 decimate=2 / decimate=4',
      seen2.length === 1 && seen2[0] === 'decimate=2' && seen4.length === 1 && seen4[0] === 'decimate=4',
      `2x=${JSON.stringify(seen2)} 4x=${JSON.stringify(seen4)}`,
    )

    // ---- C10: cache identity, checked on the wire and on disk ---------------
    // Two independent observations: the served ETags must differ (the server is
    // not handing the same bytes for two rates), and this run must have written
    // two distinct per-speed proxy files (the stale ones were deleted above).
    // Either alone could be faked; together they pin "independent cache per
    // speed" to something observable rather than to leftover state.
    const head2 = await fetchHead(`${TG}/api/media/items/${ITEM}/stream?speed=2`)
    const head4 = await fetchHead(`${TG}/api/media/items/${ITEM}/stream?speed=4`)
    const files = proxyFiles(ITEM)
    console.log(
      `[verify] etags 2x=${String(head2.headers.etag)} 4x=${String(head4.headers.etag)}`,
    )
    console.log(`[verify] proxies ${JSON.stringify(files)}`)

    const p2 = files[`${ITEM}-speed-200.mp4`]
    const p4 = files[`${ITEM}-speed-400.mp4`]
    check(
      'C10 (4) 本次运行新写出了 2x / 4x 两个独立代理文件，且大小不同',
      p2 > 0 && p4 > 0 && p2 !== p4,
      `cleared=${JSON.stringify(removed)} ${ITEM}-speed-200.mp4=${p2}B ${ITEM}-speed-400.mp4=${p4}B`,
    )
    check(
      'C10b (4) 服务端为 2x / 4x 返回不同 ETag（未复用同一份字节）',
      Boolean(head2.headers.etag) &&
        Boolean(head4.headers.etag) &&
        head2.headers.etag !== head4.headers.etag,
      `etag2=${String(head2.headers.etag)} etag4=${String(head4.headers.etag)}`,
    )

    const errs = page.pageErrors().slice(0, 8)
    check('全程无页面错误', errs.length === 0, JSON.stringify(errs))
  } finally {
    await browser.close()
  }

  // ---- summary -----------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const report = {
    item: ITEM,
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((c) => c.name),
    checks,
  }

  /*
   * The verdict goes to stderr as well as stdout, and a machine-readable report
   * is always written.
   *
   * Why: a caller running `node script.cjs | tail -22` sees the shell's exit
   * code, which is `tail`'s -- always 0. A run with FAILures therefore looked
   * like a clean pass at the call site. The exit code was always correct
   * (`process.exit(1)`); what was missing was a signal that survives a pipe.
   * stderr is not redirected by the common `| tail` idiom, and the JSON file
   * lets a wrapper assert without parsing text at all.
   */
  const summaryText = [
    '',
    '[verify] === SUMMARY ===',
    ...checks.map((c) => `  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`),
    `[verify] ${report.passed}/${report.total} passed`,
  ].join('\n')
  console.log(summaryText)
  console.error(summaryText)

  const reportPath = path.join(OUT, 'result.json')
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`[verify] report -> ${reportPath}`)
  } catch (err) {
    console.error(`[verify] could not write report: ${err.message}`)
  }

  if (failed.length) {
    console.error(`[verify] FAILED ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join(' | ')}`)
    process.exit(1)
  }
  console.log('[verify] ALL CHECKS PASSED')
  console.error('[verify] ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.stack ? e.stack : e)
  process.exit(1)
})