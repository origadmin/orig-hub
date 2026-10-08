#!/usr/bin/env node
'use strict'

/**
 * BUG-216 回归验收：把「进度条 + 时间文案」的高频状态下沉到叶子组件（父组件不再因
 * `timeupdate` 重渲染）之后，**播放器交互能力必须一个不少**。
 *
 * 为什么单独有这个脚本：
 * BUG-216 的改动触到了进度条的拖拽/提交路径（BUG-165 的语义）与控件渲染结构。
 * `_probe_render_churn.cjs` 只回答「DOM 变更是否降下来」，回答不了「功能是否还在」。
 * 本脚本用**真实 UI 交互**（CDP 派发真实鼠标事件 + 真实点击按钮）证明：
 *
 *   1. 拖进度条期间**不提交 seek**（BUG-165）：暂停后按下并拖到 60% 处，
 *      松手前 `currentTime` 必须仍停在原位；松手后必须真的跳到 ~60%。
 *   2. 倍速菜单可用：点开 → 8 档 → 点「4x」→ `playbackRate === 4` 且按钮显示 4x。
 *   3. 暂停 / 播放按钮可用：点击后 `video.paused` 真的翻转。
 *   4. 进度条 aria（role=slider + aria-valuemin/valuemax/valuenow + aria-label）保留。
 *   5. 时间文案随播放推进（叶子组件仍在更新）。
 *
 * 环境：`APP_URL`（默认 http://127.0.0.1:5180/）、`TG_URL`（默认 http://127.0.0.1:19787）、
 *      `PROBE_ITEM`（默认 472）。浏览器 EDGE_PATH / CHROME_PATH 可覆盖。
 * 退出码：全 PASS=0；有 FAIL=1；环境不可达=2。
 */

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const ITEM = Number(process.env.PROBE_ITEM || 472)
const OUT = path.resolve(__dirname, '..', 'verify_shots', 'bug216_timeline')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
}

function httpStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      fin(res.statusCode || 0)
    })
    req.on('error', () => fin(0))
    req.on('timeout', () => {
      req.destroy()
      fin(0)
    })
  })
}

/** 派发一次真实鼠标事件（CDP Input 域）。 */
async function mouse(page, type, x, y, extra = {}) {
  await page.conn.send(
    'Input.dispatchMouseEvent',
    { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse', ...extra },
    { sessionId: page.sessionId },
  )
}

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
    () => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return !!v && v.videoWidth > 0 && v.readyState >= 2
    },
    { timeout: 30000, intervalMs: 250 },
  )
}

async function shot(page, name) {
  try {
    await page.screenshot(path.join(OUT, name))
  } catch (_e) {
    /* 截图失败不致命 */
  }
}

async function main() {
  const fe = await httpStatus(APP_URL)
  const be = await httpStatus(TG)
  console.log(`环境：前端 ${APP_URL} -> ${fe}；后端 ${TG} -> ${be}`)
  if (!fe || !be) {
    console.log('环境不可达，未运行（退出码 2）')
    process.exit(2)
  }

  const browser = await cdp.launch({
    headless: false,
    args: [
      '--disable-features=CalculateNativeWinOcclusion,MediaSuspend',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
    await page.waitForFunction(() => !!window.__origStore, { timeout: 20000, intervalMs: 200 })
    await page.conn.send('Page.bringToFront', {}, { sessionId: page.sessionId }).catch(() => {})

    console.log(`\n打开条目 ${ITEM} …`)
    await openItem(page, ITEM)
    await delay(800)

    // ---------- 1. aria 契约仍在（BUG-149） ----------
    const aria = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="media-viewer"] [role="slider"]')
      if (!bar) return { ok: false }
      return {
        ok: true,
        label: bar.getAttribute('aria-label'),
        min: bar.getAttribute('aria-valuemin'),
        max: bar.getAttribute('aria-valuemax'),
        now: bar.getAttribute('aria-valuenow'),
      }
    })
    check(
      '进度条 aria 契约保留（role=slider + valuemin/valuemax/valuenow + label）',
      aria.ok && aria.label && aria.min === '0' && aria.max !== null && aria.now !== null,
      JSON.stringify(aria),
    )

    // ---------- 2. 暂停后拖拽：松手前不提交 seek（BUG-165） ----------
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (v) v.pause()
    })
    await delay(400)
    // 回到开头，便于断言
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      if (v) v.currentTime = 0
    })
    await delay(600)

    const geom = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="media-viewer"] [role="slider"]')
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const r = bar.getBoundingClientRect()
      return {
        left: r.left,
        width: r.width,
        top: r.top,
        height: r.height,
        duration: v.duration,
        currentTime: v.currentTime,
        paused: v.paused,
      }
    })
    const y = geom.top + geom.height / 2
    const xStart = geom.left + geom.width * 0.05
    const xMid = geom.left + geom.width * 0.35
    const xEnd = geom.left + geom.width * 0.6

    await mouse(page, 'mousePressed', xStart, y)
    await delay(80)
    await mouse(page, 'mouseMoved', xMid, y, { buttons: 1 })
    await delay(80)
    // 拖拽中（未松手）采样：currentTime 必须没跳到拖拽位置
    const midDrag = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const bar = document.querySelector('[data-testid="media-viewer"] [role="slider"]')
      const played = bar.querySelector('div.bg-accent[style]')
      return {
        currentTime: v.currentTime,
        playedWidth: played ? played.style.width : null,
        ariaNow: bar.getAttribute('aria-valuenow'),
      }
    })
    await shot(page, '01_dragging.png')
    await mouse(page, 'mouseMoved', xEnd, y, { buttons: 1 })
    await delay(80)
    await mouse(page, 'mouseReleased', xEnd, y, { button: 'left', clickCount: 1 })

    const afterRelease = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return { currentTime: v.currentTime, duration: v.duration, paused: v.paused }
    })
    await delay(400)
    const afterSettle = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return { currentTime: v.currentTime, duration: v.duration }
    })

    const target = geom.duration * 0.6
    // 松手前：currentTime 必须仍在原位附近（远未到 60%）
    const midNoCommit = Math.abs(midDrag.currentTime - geom.currentTime) < 2
    const midNotAtTarget = midDrag.currentTime < target * 0.5
    check(
      '拖拽期间不提交 seek（BUG-165）：松手前 currentTime 未跳到拖拽位置',
      midNoCommit && midNotAtTarget,
      `拖拽中 currentTime=${midDrag.currentTime.toFixed(2)}（起始 ${geom.currentTime.toFixed(2)}，目标 ${target.toFixed(2)}）`,
    )
    check(
      '拖拽期间条面跟手（played 宽度已变、aria 已更新）',
      midDrag.playedWidth !== null && midDrag.playedWidth !== '0%',
      `playedWidth=${midDrag.playedWidth} aria-valuenow=${midDrag.ariaNow}`,
    )
    // 松手后：currentTime 必须真的跳到 ~60%
    const committed = Math.abs(afterSettle.currentTime - target) < Math.max(3, geom.duration * 0.02)
    check(
      '松手提交 seek（BUG-165）：currentTime 跳到 ~60%',
      committed,
      `松手后 currentTime=${afterSettle.currentTime.toFixed(2)}（目标 ${target.toFixed(2)}，时长 ${geom.duration.toFixed(1)}）`,
    )

    // ---------- 3. 倍速菜单可用 ----------
    const menu = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="media-viewer"] [aria-haspopup="menu"]')
      if (!btn) return { opened: false, reason: 'no speed button' }
      btn.click()
      return { opened: true, label: btn.textContent }
    })
    await delay(300)
    const menuState = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="media-viewer"] [role="menuitemradio"]'))
      return { count: items.length, texts: items.map((i) => i.textContent.trim()) }
    })
    check('倍速菜单可打开且为 8 档（BUG-209 能力未删）', menuState.count === 8, JSON.stringify(menuState.texts))

    const clicked4x = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="media-viewer"] [role="menuitemradio"]'))
      const four = items.find((i) => i.textContent.trim().startsWith('4x'))
      if (!four) return { clicked: false }
      four.click()
      return { clicked: true }
    })
    await delay(300)
    const rateState = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      const btn = document.querySelector('[data-testid="media-viewer"] [aria-haspopup="menu"]')
      const menuOpen = !!document.querySelector('[data-testid="media-viewer"] [role="menu"]')
      return { playbackRate: v.playbackRate, buttonText: btn ? btn.textContent.trim() : null, menuOpen }
    })
    check(
      '点「4x」后倍速生效（playbackRate=4，按钮显示 4x，菜单收起）',
      clicked4x.clicked && rateState.playbackRate === 4 && rateState.buttonText === '4x' && rateState.menuOpen === false,
      JSON.stringify(rateState),
    )

    // ---------- 4. 暂停 / 播放按钮可用 ----------
    const before = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return { paused: v.paused }
    })
    const clickedPlay = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-testid="media-viewer"] [role="toolbar"] button'))
      if (!btns.length) return false
      btns[0].click()
      return true
    })
    await delay(500)
    const afterPlay = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="media-viewer"] video')
      return { paused: v.paused, currentTime: v.currentTime }
    })
    await shot(page, '02_after_play_4x.png')
    check(
      '播放/暂停按钮可用（paused 翻转）',
      clickedPlay && afterPlay.paused !== before.paused,
      `before.paused=${before.paused} after.paused=${afterPlay.paused}`,
    )

    // ---------- 5. 时间文案随播放推进 ----------
    // BUG-217：播放中控件 3s 后会自动隐藏，而隐藏态控件层已被**真正移出 DOM**，
    // 时间文案随之不可查询。故先用真实 mousemove 把控件唤出再断言（不是弱化断言：
    // 仍要求文案存在且推进）。两次采样间隔 < HIDE_MS(3000)，中途再唤一次。
    const center = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="media-viewer"]')
      const r = c.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const readTimeText = () =>
      page.evaluate(() => {
        const v = document.querySelector('[data-testid="media-viewer"] video')
        const spans = Array.from(document.querySelectorAll('[data-testid="media-viewer"] span'))
        const timeSpan = spans.find((s) => /\/ /.test(s.textContent) && /\d/.test(s.textContent))
        return { ct: v.currentTime, text: timeSpan ? timeSpan.textContent.trim() : null }
      })
    await mouse(page, 'mouseMoved', center.x, center.y)
    await delay(200)
    const t0 = await readTimeText()
    await delay(1200)
    await mouse(page, 'mouseMoved', center.x, center.y)
    await delay(200)
    const t1 = await readTimeText()
    check(
      '时间文案随播放推进（叶子组件仍在更新）',
      t0.text !== null && t1.text !== null && t1.text !== t0.text && t1.ct > t0.ct,
      `text "${t0.text}" -> "${t1.text}"，currentTime ${t0.ct.toFixed(2)} -> ${t1.ct.toFixed(2)}`,
    )

    // 页面错误自证
    const pageErrors = page.pageErrors()
    check('无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`)
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('REGRESSION_FAILED', e && e.stack ? e.stack : e)
  process.exit(1)
})
