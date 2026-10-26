#!/usr/bin/env node
'use strict'
/**
 * BUG-432 + BUG-433 真实 UI 验收：TG 里「点视频到底有没有播」+「组内首条能不能点开」。
 *
 * ## 用户诉求（2026-10-26 原话）
 *   「TG中点击视频的严重问题，后台视频在加载，界面依然是展示界面。
 *     也就是说，没有播放行为，但是做了播放动作。」
 *   「如果第一条数据是视频，那么这个数据组的视频将完全无法播放（第一条没有播放功能）。」
 *   「两个都是播放相关，需要重新评估设计，设施功能设计疏漏。」
 *
 * ## 根因
 *   BUG-432 `VideoBlock` 点击分支：`downloaded → local` / `downloading → online` /
 *           其余 → **只 `onDownload()`，不进播放态**。于是「未缓存」这条路径下
 *            用户点一下只看到开始下载，画面永远停在缩略图上。
 *   BUG-433 `AlbumBubble` 宫格原为 `items.slice(1)`（首条被排除，理由是「首图已作
 *            为封面」），而封面的唯一动作是展开/收起、从不 `onPreview`
 *            ⇒ `items[0]` 在两种状态下都没有预览入口，组内首条成了死内容。
 *
 * ## 判据
 *  432-A 点击前：目标视频块 `data-video-state="off"` 且块内没有 `<video>`。
 *  432-B 点击后 15s 内：`data-video-state` 变成 `online`/`local`，且出现 `<video>`。
 *  432-C 该视频块点击前 `data-downloaded="false"`（确保走的就是被修的那条分支）。
 *  433-A 展开第一个可折叠相册后，`tg-album-tile-0` 必须存在。
 *  433-B 瓦片数 == min(组内条目数, 10)，且 ≥ 1。
 *  433-C 点 `tg-album-tile-0` 后播放器打开，且播放器位置显示第 1 项（`1 / N`）。
 *  RF1   把 `tg-album-tile-0` 从 DOM 摘掉 ⇒ 433-A 必须 FAIL（判据灵敏）。
 *  RF2   还原后复绿。
 *
 * 用法（先起 dev 栈 5180 + 媒体 API 19787）：
 *   node tauri-shell/verify/verify_bug432_433_tg_playback.cjs [CHANNEL_ID]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug432-433'),
)
const TG_PORT = Number(process.env.TG_PORT || 19787)
const NAV_TIMEOUT = 90000
/** 默认频道：库里视频全部 `downloaded=false`，正好是 BUG-432 要修的那条分支 */
const CHANNEL_ID = process.argv[2] || process.env.CHANNEL_ID || '-1004457697592'
const ALBUM_MAX_TILES = 10

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function waitFor(page, selector, tries = 60, step = 500) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate((q) => !!document.querySelector(q), selector)) return true
    await delay(step)
  }
  return false
}

/** 打开 TG 面板并点开指定监控频道 */
async function openChannel(page, channelId) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: NAV_TIMEOUT })
  await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
  if (!(await waitFor(page, '[data-testid="tg-panel-root"]', 40))) {
    throw new Error('tg-panel-root not rendered')
  }
  // 监控列表要等监控数据回来才渲染（实测 ~4s）。等不到再尝试展开折叠区一次。
  if (!(await waitFor(page, '[data-testid="tg-monitor-row"]', 40, 500))) {
    await page.evaluate(() =>
      document.querySelector('[data-testid="monitor-collapse-toggle"]')?.click(),
    )
    if (!(await waitFor(page, '[data-testid="tg-monitor-row"]', 40, 500))) {
      throw new Error('tg-monitor-row never rendered')
    }
  }
  await delay(600)
  // 监控列表行统一是 `tg-monitor-row`（testid 不带频道号）。顺序与
  // `GET /api/tg/monitor/channels` 一致（`ORDER BY added_at`），所以按接口顺序
  // 反查下标，而不是靠文本匹配标题（标题会被截断成「【AI短剧|黄果短剧|黄豆魔…」）。
  const order = await (async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${TG_PORT}/api/tg/monitor/channels`)
      const list = await r.json()
      const arr = Array.isArray(list) ? list : list.channels || []
      return arr.map((c) => String(c.channelId))
    } catch {
      return []
    }
  })()
  const wantIdx = Math.max(0, order.indexOf(String(channelId)))
  const picked = await page.evaluate((i) => {
    const rows = [...document.querySelectorAll('[data-testid="tg-monitor-row"]')]
    const hit = rows[i] || rows[0]
    if (!hit) return false
    hit.click()
    return true
  }, wantIdx)
  if (!picked) throw new Error('no monitor channel row')
  if (!(await waitFor(page, '[data-testid="album-cover"]', 60))) {
    throw new Error('album-cover not rendered (feed empty?)')
  }
  await delay(800)
}

/** 展开第一个可折叠相册，返回组内条目数 */
async function expandFirstAlbum(page) {
  const count = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="album-cover"]')
    if (!c) return -1
    const n = Number(c.getAttribute('data-count') || 0)
    c.click()
    return n
  })
  await delay(1200)
  return count
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await openChannel(page, CHANNEL_ID)

    // ---------- BUG-432 ----------
    const target = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('[data-testid="tg-video-block"]')]
      const hit = blocks.find((b) => b.getAttribute('data-downloaded') === 'false')
      if (!hit) return null
      const r = hit.getBoundingClientRect()
      return {
        idx: blocks.indexOf(hit),
        total: blocks.length,
        state: hit.getAttribute('data-video-state'),
        downloaded: hit.getAttribute('data-downloaded'),
        hasVideo: !!hit.querySelector('video'),
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    })
    if (!target) {
      check('432-C 目标视频块未缓存（走被修分支）', false, 'ENV: 当前频道没有 downloaded=false 的视频块，无法判定')
      check('432-A 点击前处于未播放态', false, 'ENV')
      check('432-B 点击后进入播放态并出现 <video>', false, 'ENV')
    } else {
      check(
        '432-C 目标视频块未缓存（走被修分支）',
        target.downloaded === 'false',
        `downloaded=${target.downloaded} blocks=${target.total} size=${target.w}×${target.h}`,
      )
      check(
        '432-A 点击前处于未播放态',
        target.state === 'off' && target.hasVideo === false,
        `state=${target.state} hasVideo=${target.hasVideo}`,
      )
      await page.evaluate((i) => {
        const blocks = [...document.querySelectorAll('[data-testid="tg-video-block"]')]
        blocks[i]?.click()
      }, target.idx)
      // 有界等待：在线流要先连上（实测 1~3s），不用固定 sleep 当「等它发生」
      let after = null
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        after = await page.evaluate((i) => {
          const blocks = [...document.querySelectorAll('[data-testid="tg-video-block"]')]
          const b = blocks[i]
          const v = b ? b.querySelector('video') : null
          return b
            ? { state: b.getAttribute('data-video-state'), hasVideo: !!v, src: v ? v.currentSrc : null }
            : { state: null, hasVideo: false, src: null }
        }, target.idx)
        if (after.hasVideo && after.state !== 'off') break
        await delay(400)
      }
      await page.screenshot(path.join(OUT, '01-video-block-playing.png'))
      const okB = !!after && after.hasVideo && after.state !== 'off'
      check(
        '432-B 点击后进入播放态并出现 <video>',
        okB,
        `state=${after && after.state} hasVideo=${after && after.hasVideo} src=${after && after.src}`,
      )
      // 关掉播放器回到列表，避免影响后续相册判据
      await page.evaluate(() => document.querySelector('[data-testid="media-viewer"]')?.remove())
      await delay(600)
    }

    // ---------- BUG-433 ----------
    const items = await expandFirstAlbum(page)
    if (items < 2) {
      check('433-A 展开后组内首条有独立入口（tg-album-tile-0 存在）', false, `ENV: 首个相册条目数=${items}`)
      check('433-B 瓦片数 = min(条目数,10)', false, 'ENV')
      check('433-C 点首条瓦片打开播放器第 1 项', false, 'ENV')
    } else {
      const grid = await page.evaluate(() => {
        const g = document.querySelector('[data-testid="album-grid"]')
        if (!g) return { exists: false }
        const tiles = [...g.querySelectorAll('[data-testid^="tg-album-tile-"]')]
        return {
          exists: true,
          ids: tiles.map((t) => t.getAttribute('data-testid')),
          n: tiles.length,
        }
      })
      const expect = Math.min(items, ALBUM_MAX_TILES)
      check(
        '433-A 展开后组内首条有独立入口（tg-album-tile-0 存在）',
        !!grid.exists && grid.ids.includes('tg-album-tile-0'),
        `items=${items} tiles=${grid.n} ids=${JSON.stringify(grid.ids)}`,
      )
      check(
        '433-B 瓦片数 = min(条目数,10)',
        grid.exists && grid.n === expect,
        `tiles=${grid.n} expect=${expect}`,
      )
      // 点首条瓦片 → 播放器打开且停在第一项
      await page.evaluate(() => document.querySelector('[data-testid="tg-album-tile-0"]')?.click())
      const opened = await waitFor(page, '[data-testid="media-viewer"]', 40, 400)
      await delay(1200)
      const pos = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="viewer-position"]')
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : null
      })
      await page.screenshot(path.join(OUT, '02-album-tile0-opened.png'))
      check(
        '433-C 点首条瓦片打开播放器第 1 项',
        opened && !!pos && /^1\s*\/\s*\d+/.test(pos),
        `viewer=${opened} position=${JSON.stringify(pos)}`,
      )

      // ---------- BUG-434：TG 视频不得被拼成库域转码流地址 ----------
      // 用户：「后台视频在加载，界面依然是展示界面，没有播放行为却做了播放动作。」
      // 缺陷签名 = 播放器去拉 `/api/media/items/<TG消息号>/stream`（跨域错位，必然 404）。
      // 有界等待：TG 本地流/在线流都要先连上（实测 1~3s），不用固定 sleep。
      const tgMsgId = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="tg-album-tile-0"]')
        return t ? t.getAttribute('data-message-id') : null
      })
      let play = null
      const playDeadline = Date.now() + 20000
      while (Date.now() < playDeadline) {
        play = await page.evaluate(() => {
          const v = document.querySelector('[data-testid="media-viewer"] video')
          if (!v) return null
          return {
            src: (v.currentSrc || v.src || '').replace(/^https?:\/\/[^/]+/, ''),
            readyState: v.readyState,
            currentTime: Math.round(v.currentTime * 100) / 100,
            paused: v.paused,
            error: v.error ? v.error.code : null,
          }
        })
        if (play && play.readyState >= 2 && play.currentTime > 0) break
        await delay(500)
      }
      const wrongStream = await page.evaluate((mid) => {
        const strip = (u) => u.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
        return performance
          .getEntriesByType('resource')
          .map((e) => strip(e.name))
          .filter((p) => mid && p === `/api/media/items/${mid}/stream`)
      }, tgMsgId)
      check(
        '434-A TG 视频真正开始播（readyState≥2 且 currentTime>0）',
        !!play && play.readyState >= 2 && play.currentTime > 0,
        `msg=${tgMsgId} play=${JSON.stringify(play)}`,
      )
      check(
        '434-B 不得请求库域转码流 /api/media/items/<TG消息号>/stream',
        wrongStream.length === 0,
        `wrongStream=${JSON.stringify(wrongStream)}`,
      )
      check(
        '434-C 播放源必须是 TG 域（/api/tg/local/ 或 /api/tg/file/）',
        !!play && /^\/api\/tg\/(local|file)\//.test(play.src || ''),
        `src=${play && play.src}`,
      )

      // ---- RF1：摘掉 tile-0 ⇒ 433-A 必须红 ----
      await page.evaluate(() => {
        const t = document.querySelector('[data-testid="tg-album-tile-0"]')
        if (t) {
          t.setAttribute('data-testid', 'tg-album-tile-removed')
          t.setAttribute('data-rf', '1')
        }
      })
      const rfIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="tg-album-tile-"]')].map((t) =>
          t.getAttribute('data-testid'),
        ),
      )
      check(
        'RF1 摘掉 tile-0 后 433-A 必须 FAIL（判据灵敏）',
        !rfIds.includes('tg-album-tile-0'),
        `after removal ids=${JSON.stringify(rfIds.slice(0, 12))}`,
      )
      await page.evaluate(() => {
        const t = document.querySelector('[data-testid="tg-album-tile-removed"][data-rf="1"]')
        if (t) {
          t.setAttribute('data-testid', 'tg-album-tile-0')
          t.removeAttribute('data-rf')
        }
      })
      const backIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="tg-album-tile-"]')].map((t) =>
          t.getAttribute('data-testid'),
        ),
      )
      check('RF2 还原后复绿', backIds.includes('tg-album-tile-0'), `restored=${JSON.stringify(backIds.slice(0, 12))}`)
    }

    // ---------- 错误 ----------
    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon/i.test(String(e)),
    )
    check('432/433-F 无页面 / console 错误', errs.length === 0, `errors=${JSON.stringify(errs.slice(0, 3))}`)
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.pass)
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ date: new Date().toISOString(), channelId: CHANNEL_ID, checks }, null, 2),
  )
  console.log(`\ntotal=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  console.log(`evidence: ${OUT}`)
  if (failed.length) {
    console.log('FAILED CHECKS:')
    for (const c of failed) console.log(`  - ${c.name} — ${c.detail}`)
    process.exit(1)
  }
  console.log('ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
