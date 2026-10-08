'use strict'

/**
 * BUG-224 acceptance: the "cannot decode" verdict must not fire on files this
 * browser demonstrably decodes.
 *
 * Measured facts this script is pinned to (see
 * `verify/_probe_bug224_decode.cjs`, which produced them on this machine):
 *
 *   | source                                | first frame | verdict        |
 *   |---------------------------------------|-------------|----------------|
 *   | items/415/raw  (720p HEVC/hvc1)       | 0.63s       | videoWidth 720 |
 *   | items/673/raw  (1080p HEVC/hvc1)      | 0.92s       | videoWidth 1920|
 *   | items/415/stream (server H.264 proxy) | 2.67s       | videoWidth 720 |
 *   | items/673/stream (server H.264 proxy) | 2.89s       | videoWidth 1920|
 *
 * So the local Chromium DOES decode HEVC: "this machine cannot play the format"
 * was never a fact here. The old 3000ms budget sat 110-330ms under the
 * compatibility stream's first frame, i.e. on the edge of the cliff -- one bit
 * of scheduler jitter and `VideoPlayer` would switch source, re-judge, and halt
 * a file that plays in 0.6s on the original stream.
 *
 * Run:  node verify/verify_bug_224_decode_verdict.cjs
 * Falsify: PROVE_OLD_BUDGET=3000 makes criterion 3 fail (the criteria have teeth).
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const REPO = path.resolve(__dirname, '..')
const SRC = path.join(REPO, 'src', 'lib', 'decodeHealth.ts')
const OLD_BUDGET = 3000

/** Measured first-frame times, in ms, per `verify/_probe_bug224_decode.cjs`. */
const MEASURED = [
  { label: 'items/415/raw 720p HEVC (plays natively)', ms: 630 },
  { label: 'items/673/raw 1080p HEVC (plays natively)', ms: 920 },
  { label: 'items/415/stream H.264 proxy (cold transcode)', ms: 2670 },
  { label: 'items/673/stream H.264 proxy (cold transcode)', ms: 2890 },
]

/** 20% scheduler jitter on the slowest measured compatibility stream. */
const JITTER = 1.2

function loadModule() {
  // esbuild's JS API, not the `.bin` shim: Node 22 on Windows cannot spawn a
  // `.cmd` shim directly (`EINVAL`), and the shim would also add a shell layer
  // between the criteria and the code under test.
  const esbuild = require('esbuild')
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-bug224-')), 'decodeHealth.cjs')
  esbuild.buildSync({ entryPoints: [SRC], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return require(out)
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, ok, detail })
}

const mod = loadModule()
const { zeroFrameVerdict, MEDIA_ERR_SRC_NOT_SUPPORTED } = mod

const budgetMs = Number(process.env.PROVE_OLD_BUDGET || 0) || undefined

/** A live source: metadata ready, no frames yet, no media error. */
function zeroFrameAt(ms) {
  return zeroFrameVerdict({
    readyState: 4,
    videoWidth: 0,
    mediaErrorCode: null,
    zeroFrameSince: 0,
    now: ms,
    ...(budgetMs ? { budgetMs } : {}),
  })
}

// 1) Every measured first frame in this repository must not be judged dead.
let c1ok = true
const c1detail = []
for (const m of MEASURED) {
  const v = zeroFrameAt(m.ms)
  if (v.unsupported) c1ok = false
  c1detail.push(`${m.label}: ${m.ms}ms -> ${v.reason}`)
}
check('1', '本机实测能出的画面一律不判死（4/4）', c1ok, c1detail.join('; '))

// 2) Once a frame exists the verdict can never be "unsupported" (regression guard
//    for the early return that keeps a playing source alive).
const playing = zeroFrameVerdict({
  readyState: 4,
  videoWidth: 1920,
  mediaErrorCode: null,
  zeroFrameSince: 0,
  now: 999999,
  ...(budgetMs ? { budgetMs } : {}),
})
check('2', '已有画面尺寸时永不判死', playing.unsupported === false && playing.reason === 'playing', playing.reason)

// 3) THE TEETH: with the old 3000ms budget the slowest measured compatibility
//    stream plus 20% jitter (3468ms) was judged dead -- a file that plays in
//    2.89s. The new budget must keep it alive.
const jittered = Math.round(2890 * JITTER)
const c3 = zeroFrameAt(jittered)
check(
  '3',
  `最慢兼容流 +${Math.round((JITTER - 1) * 100)}% 抖动（${jittered}ms）不判死（旧 3000ms 预算会判死）`,
  c3.unsupported === false,
  c3.reason,
)

// 4) A browser that explicitly reports "source not supported" is still believed
//    immediately -- the escape hatch must not be lost.
const hardErr = zeroFrameVerdict({
  readyState: 0,
  videoWidth: 0,
  mediaErrorCode: MEDIA_ERR_SRC_NOT_SUPPORTED,
  zeroFrameSince: 0,
  now: 10,
})
check('4', '媒体元素明确报 MEDIA_ERR_SRC_NOT_SUPPORTED 时立即判死', hardErr.unsupported === true, hardErr.reason)

// 5) Genuinely undecodable, silent (no error event) still ends in a verdict --
//    just later than before.
const inside = zeroFrameAt(11999)
const outside = zeroFrameVerdict({
  readyState: 4,
  videoWidth: 0,
  mediaErrorCode: null,
  zeroFrameSince: 0,
  now: 12001,
})
check(
  '5',
  '真解不了且无错误码：预算内不判、预算外判死（兜底未被取消，只是推迟）',
  inside.unsupported === false && outside.unsupported === true && outside.reason === 'budget-exhausted',
  `11999ms=${inside.reason}, 12001ms=${outside.reason}`,
)

// 6) Metadata not ready yet is never "cannot decode".
const pending = zeroFrameVerdict({
  readyState: 1,
  videoWidth: 0,
  mediaErrorCode: null,
  zeroFrameSince: 0,
  now: 60000,
})
check('6', '元数据未就绪不判死', pending.unsupported === false && pending.reason === 'metadata-pending', pending.reason)

const failed = results.filter((r) => !r.ok)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} [${r.id}] ${r.name}${r.detail ? '  <- ' + r.detail : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  if (process.env.PROVE_OLD_BUDGET) {
    console.log(
      `FALSIFY OK: with PROVE_OLD_BUDGET=${OLD_BUDGET} the criteria reject the old verdict ` +
        `(failed: ${failed.map((f) => f.id).join(',')})`,
    )
    process.exit(1)
  }
  process.exit(1)
}
if (process.env.PROVE_OLD_BUDGET) {
  console.error(`FALSIFY FAILED: PROVE_OLD_BUDGET=${OLD_BUDGET} still passed every criterion`)
  process.exit(1)
}
console.log(`OK - BUG-224 decode verdict criteria hold (budget widened, escape hatch intact)`)