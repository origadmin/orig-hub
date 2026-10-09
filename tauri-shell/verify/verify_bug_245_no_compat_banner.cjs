#!/usr/bin/env node
'use strict'

/**
 * BUG-245 验收：播放器常驻「已切换实时转码兼容流」横幅已删除，且真失败提示未被误删。
 *
 * ## 背景
 *
 * BUG-230「stream-first」后，`VideoPlayer` 挂载即 `usingCompat === true`（ compatSrc
 * 无条件提供），于是 `data-testid="player-compat-banner"` 那条为「降级发生了」设计的
 * 提示在**每一条**视频上常驻：既把「能播」播报成「出问题了」，也长期占住画面。
 *
 * 修复（提交 304d57b）：删掉该渲染块 + i18n 键 `player.compatStream`；保留
 * `fatal` / `halted` 遮罩（那两条才是用户需要知道的真失败）。
 *
 * ## 判据（全部通过才算修复；任何一条挂了必须 FAIL）
 *
 * 1. **横幅缺席**：打开视频后 20s 内以 1s 间隔轮询，`player-compat-banner` 恒为 null。
 * 2. **文案级缺席**（防「只删 testid 却留文字」）：同一窗口内 body.innerText 不含
 *    「已切换实时转码兼容流」/「浏览器不支持该视频编码」。
 * 3. **非空断言**（防 1/2 因「播放器压根没渲染」而恒绿）：videoWidth > 0，且
 *    getVideoPlaybackQuality().totalVideoFrames 在 4s 内**持续增长**——打印具体数值。
 * 4. **真失败提示未被误删**（静态核对源码 + i18n）：`player-unsupported-halt` 遮罩、
 *    `fatal` 遮罩渲染代码仍在；i18n 键 `tg.decodeUnsupported` / `tg.decodeFail` 仍在；
 *    已删键 `player.compatStream` 确实不再存在（前后两侧都卡）。
 * 5. 全程 `pageErrors` 为 0，并出一张真实截图。
 *
 * ## 反证（本仓铁律）
 *
 * 新增断言必须证明「装回旧实现必败」：
 *
 *   git stash push -- tauri-shell/src/components/media/VideoPlayer.tsx \
 *                     tauri-shell/src/i18n/locales/zh-CN.json \
 *                     tauri-shell/src/i18n/locales/en-US.json
 *   node verify_bug_245_no_compat_banner.cjs   # 必须在判据 1 或 2 FAIL
 *   git stash pop
 *   node verify_bug_245_no_compat_banner.cjs   # 必须 PASS
 *
 * 用法：先起开发态服务（vite dev 5180 + orig-tg/daemon），再
 *   node verify_bug_245_no_compat_banner.cjs
 * 可调：`PROBE_ITEM`（默认 598）、`PROBE_CHAT_ID`、`ORIG_VERIFY_OUT`。
 * 证据目录默认走系统临时目录（不入库）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const CHAT_ID = Number(process.env.PROBE_CHAT_ID || -1003969766003)
const ITEM = Number(process.env.PROBE_ITEM || 598)

/** 判据 1 的轮询窗口与间隔。 */
const POLL_WINDOW_MS = 20000
const POLL_INTERVAL_MS = 1000

/** 判据 3 的帧增长采样间隔。 */
const FRAME_GROW_WINDOW_MS = 4000

const BANNER_TESTID = 'player-compat-banner'

/**
 * 判据 2：横幅原文片段，**按语言分组**。
 *
 * 为什么必须双语：`detectLanguage()` 取的是 `navigator.language`（见
 * `src/i18n/index.ts:27-28`），浏览器语言一变、界面文案就换。只扫中文等于给自己留了
 * 一条「环境是英文 ⇒ 永远匹配不到 ⇒ 恒绿」的后门 —— 这类"永远不会红的断言"正是
 * 本仓最忌讳的假验收。两条语言的片段都扫，谁的环境都跑不掉。
 *
 * 片段取自 `304d57b~1` 的 `player.compatStream` 原文（各取两个可独立命中的片段）。
 */
const BANNED_WORDS = [
  // zh-CN
  '已切换实时转码兼容流',
  '浏览器不支持该视频编码',
  // en-US
  'switched to the live transcode stream',
  'Codec not supported by the browser',
]

const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug-245'),
)

/** 源码根目录：由脚本自身位置推导，绝不写机器绝对路径（AGENTS.md §6 污染闸）。 */
const SRC_ROOT = path.resolve(__dirname, '..')
const VP_REL = 'src/components/media/VideoPlayer.tsx'
const LOCALE_REL = ['src/i18n/locales/zh-CN.json', 'src/i18n/locales/en-US.json']

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`[verify] ${pass ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

async function shot(page, name) {
  const f = path.join(OUT, name)
  await page.screenshot(f, { fullPage: true })
  let size = -1
  try { size = fs.statSync(f).size } catch (_e) { /* 产物缺失不影响判据 */ }
  console.log(`[verify] shot ${name} -> ${f} (${size} bytes)`)
  return size
}

/** 从 `<video>` 采样一组可观测播放指标（判据 3 用）。 */
async function samplePlayback(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (!v) return null
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    return {
      vw: v.videoWidth,
      vh: v.videoHeight,
      frames: q ? q.totalVideoFrames : -1,
      dropped: q ? q.droppedVideoFrames : -1,
      currentTime: Number(v.currentTime || 0),
      readyState: v.readyState,
      paused: v.paused,
      src: String(v.src || ''),
    }
  })
}

/** 打开一个视频条目（走播放器挂载路径，与 BUG-245 的复现步骤一致）。 */
async function openItem(page, chatId, item) {
  await page.evaluate((cid, mid) => {
    window.__origStore.getState().openViewer({
      items: [{
        key: mid,
        chatId: cid,
        messageId: mid,
        kind: 'video',
        caption: '',
        description: '',
        src: '',
        poster: null,
        episodeNo: null,
        seriesId: null,
      }],
      index: 0,
      title: '',
    })
  }, chatId, item)
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="media-viewer"] video'),
    { timeout: 20000 },
  )
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="media-viewer"] video')
    if (v) { v.muted = true; v.volume = 0; v.play().catch(() => {}) }
  })
}

/**
 * 判据 1 + 2：在时间窗内轮询，收集「横幅节点出现」与「横幅文案出现」两类违规。
 *
 * 两类证据分开收集：`bannerEvidence` 记节点（判据 1），`wordHits` 记文案（判据 2）。
 * 这样能区分「删了 testid 却留了字」这种假修复 —— 判据 1 绿而判据 2 红。
 *
 * @returns {Promise<object>} `{samples, bannerHits, firstBannerAt, bannerEvidence, wordHits, sawPlayer}`
 */
async function pollForBanner(page) {
  const deadline = Date.now() + POLL_WINDOW_MS
  let samples = 0
  const out = {
    samples: 0,
    bannerHits: 0,
    firstBannerAt: null,
    bannerEvidence: [],
    wordHits: [],
    sawPlayer: false,
    // 判据 2 的反恒绿见证：证明 innerText 真的读到了内容（不是空串在刷通过）。
    textLengthMin: Infinity,
    textLengthMax: 0,
    textHead: '',
    navigatorLanguage: null,
  }
  while (Date.now() < deadline) {
    samples++
    const snap = await page.evaluate((testid, words) => {
      const banner = document.querySelector(`[data-testid="${testid}"]`)
      const text = document.body ? String(document.body.innerText || '') : ''
      return {
        bannerPresent: !!banner,
        bannerText: banner ? String(banner.textContent || '').slice(0, 120) : null,
        wordHits: words.filter((w) => text.includes(w)),
        hasPlayer: !!document.querySelector('[data-testid="media-viewer"] video'),
        textLength: text.length,
        textHead: text.slice(0, 80),
        navigatorLanguage: navigator.language || null,
      }
    }, BANNER_TESTID, BANNED_WORDS)

    out.navigatorLanguage = snap.navigatorLanguage
    if (snap.textLength < out.textLengthMin) out.textLengthMin = snap.textLength
    if (snap.textLength > out.textLengthMax) out.textLengthMax = snap.textLength
    if (!out.textHead && snap.textHead) out.textHead = snap.textHead

    if (snap.hasPlayer) out.sawPlayer = true
    if (snap.bannerPresent) {
      out.bannerHits++
      if (out.firstBannerAt === null) out.firstBannerAt = samples
      if (out.bannerEvidence.length < 3) {
        out.bannerEvidence.push({ sample: samples, bannerText: snap.bannerText })
      }
    }
    if (snap.wordHits.length > 0 && out.wordHits.length < 3) {
      out.wordHits.push({
        sample: samples,
        words: snap.wordHits,
        bannerNodePresent: snap.bannerPresent,
        bannerNull: snap.bannerPresent === false,
      })
    }
    await delay(POLL_INTERVAL_MS)
  }
  out.samples = samples
  if (!Number.isFinite(out.textLengthMin)) out.textLengthMin = 0
  return out
}

// ────────────────── 判据 4：静态核对源码与 i18n ──────────────────

function readSource(rel) {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8')
}

function readLocale(rel) {
  return JSON.parse(readSource(rel))
}

function staticChecks() {
  console.log('[verify] --- D: real-failure surfaces must survive the removal ---')
  let vp = ''
  try {
    vp = readSource(VP_REL)
  } catch (err) {
    check('D0: VideoPlayer.tsx is readable', false, String(err && err.message))
    return
  }
  check('D1: halted overlay anchor still rendered (player-unsupported-halt)',
    vp.includes('data-testid="player-unsupported-halt"'),
    `${VP_REL}`)
  check('D2: fatal overlay render still present',
    /\{fatal && \(/.test(vp) && vp.includes("{t('tg.decodeFail')}"),
    `${VP_REL}: {fatal && ( + tg.decodeFail`)
  check('D3: decode-notice branch still renders (decode !== ok)',
    /\{!fatal && !halted && decode !== 'ok' && \(/.test(vp),
    `${VP_REL}: 解码异常提示未被连坐删除`)

  for (const rel of LOCALE_REL) {
    let loc = null
    try {
      loc = readLocale(rel)
    } catch (err) {
      check(`D4: ${path.basename(rel)} parses as JSON`, false, String(err && err.message))
      continue
    }
    for (const key of ['tg.decodeUnsupported', 'tg.decodeFail']) {
      check(`D4: ${path.basename(rel)} still has key ${key}`,
        typeof loc[key] === 'string' && loc[key].length > 0,
        `value head=${JSON.stringify(String(loc[key] || '').slice(0, 24))}`)
    }
    check(`D5: ${path.basename(rel)} no longer has player.compatStream`,
      !('player.compatStream' in loc),
      `removed key absent`)
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  staticChecks()

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
    console.log('[verify] navigated to', APP_URL)
    await page.waitForFunction(() => !!window.__origStore, { timeout: 15000 })

    console.log(`[verify] opening item=${ITEM} chat=${CHAT_ID}`)
    await openItem(page, CHAT_ID, ITEM)

    // ---- 判据 3 的前置：播放器必须真的在出帧，否则 1/2 的「无横幅」毫无意义 ----
    let playing = null
    try {
      await page.waitForFunction(() => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        if (!v) return false
        const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
        return v.videoWidth > 0 && !!q && q.totalVideoFrames > 0
      }, { timeout: 90000 })
    } catch (_err) { /* 交给下面 check 判定 */ }
    playing = await samplePlayback(page)
    console.log('[verify] first playback sample:', JSON.stringify(playing))

    // 判据 1 + 2：轮询窗口（此时播放器已出帧，窗口内的「无横幅」是真阴性）
    const banner = await pollForBanner(page)
    console.log('[verify] banner poll:', JSON.stringify(banner))
    check('1: no player-compat-banner node during the whole window',
      banner.bannerHits === 0,
      `samples=${banner.samples} interval=${POLL_INTERVAL_MS}ms bannerHits=${banner.bannerHits} ` +
        `evidence=${JSON.stringify(banner.bannerEvidence)}`)
    check('2: no compat-banner wording in body text (both locales scanned)',
      banner.wordHits.length === 0,
      `wordHits=${banner.wordHits.length} first=${JSON.stringify(banner.wordHits[0] || null)} ` +
        `navLang=${banner.navigatorLanguage} words=${BANNED_WORDS.length}`)
    // 反恒绿见证：innerText 在整窗里必须真的有内容，否则判据 2 的「无命中」无意义。
    check('2b: innerText witness (text really was scanned, not empty)',
      banner.textLengthMax > 0,
      `innerText len min=${banner.textLengthMin} max=${banner.textLengthMax} ` +
        `head=${JSON.stringify(banner.textHead.replace(/\s+/g, ' ').slice(0, 60))}`)

    // 判据 3：帧持续增长（拿两组样本，打印具体数值）
    const s1 = await samplePlayback(page)
    await delay(FRAME_GROW_WINDOW_MS)
    const s2 = await samplePlayback(page)
    console.log(`[verify] frame growth: ${JSON.stringify(s1)} -> ${JSON.stringify(s2)}`)
    await shot(page, 'bug245-playing-no-banner.png')
    check('3a: video really rendered (videoWidth > 0)',
      !!s1 && s1.vw > 0,
      `vw=${s1 && s1.vw} vh=${s1 && s1.vh} src=${s1 && s1.src}`)
    check('3b: frames keep growing over 4s (actually playing)',
      !!s1 && !!s2 && s2.frames > s1.frames,
      `frames ${s1 && s1.frames} -> ${s2 && s2.frames} (+${s2 && s1 ? s2.frames - s1.frames : 'n/a'}) in ${FRAME_GROW_WINDOW_MS}ms`)
    check('3c: the non-emptiness guard holds (player existed while polling)',
      banner.sawPlayer === true,
      `sawPlayer=${banner.sawPlayer}`)

    await page.evaluate(() => window.__origStore.getState().closeViewer())
    await delay(500)

    // ---- 判据 5：全程无未捕获异常 ----
    const errs = page.pageErrors().slice(0, 10)
    console.log('[verify] PAGE_ERRORS:', JSON.stringify(errs))
    check('5: no uncaught page errors', errs.length === 0, JSON.stringify(errs))

    const failed = checks.filter((c) => !c.pass)
    console.log('\n[verify] === SUMMARY ===')
    console.log(`[verify] evidence dir: ${OUT}`)
    console.log(`[verify] total=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
    if (failed.length) {
      console.log('[verify] FAILED:', failed.map((c) => c.name).join(' | '))
      process.exitCode = 2
    } else {
      console.log('[verify] ALL CHECKS PASSED')
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[verify] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
