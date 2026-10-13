#!/usr/bin/env node
'use strict'
/**
 * 播放时长错乱根因取证（**只读**）：逐条判定 4 条假设 + 尝试复现 0:32 / 0:01。
 * 不改源码/docs/data，不 kill 进程。仅 GET / 页面内点击 / CDP 输入与网络抓包。
 *
 * Env: APP_URL / TG_API / MF_HEADFUL=0|1（默认 1）
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG = (process.env.TG_API || 'http://127.0.0.1:19788').replace(/\/$/, '')
const HEADFUL = (process.env.MF_HEADFUL || '1') !== '0'
const SHOTS = path.resolve(__dirname, '..', 'verify_shots', 'playback-duration')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[dur]', ...a)
const head = (t) => console.log(`\n[dur] ===== ${t} =====`)
const raw = (label, v) => console.log(`[dur] ${label} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)

const HOOK = `
(() => {
  if (window.__d) return;
  var d = { t0: performance.now(), fetches: [], srcLog: [], events: [] };
  window.__d = d;
  var RX = /\\/api\\/media\\/items\\/\\d+\\/(raw|stream)/;
  function now(){ return Math.round(performance.now() - d.t0); }
  try {
    var of = window.fetch;
    window.fetch = function(input){
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      if (RX.test(u)) d.fetches.push({ ms: now(), url: u });
      return of.apply(this, arguments);
    };
  } catch(e){}
  function attach(v){
    if (!v || v.__dHooked) return;
    v.__dHooked = true;
    ['loadedmetadata','durationchange','playing','waiting','stalled','error','seeked'].forEach(function(ev){
      v.addEventListener(ev, function(){
        d.events.push({ ev: ev, ms: now(), dur: (isFinite(v.duration)?v.duration:null), ct: +(v.currentTime||0).toFixed(3), src: (v.currentSrc||v.src||'') });
      });
    });
  }
  function boot(){
    if (!document.documentElement) { setTimeout(boot, 20); return; }
    new MutationObserver(function(){
      var v = document.querySelector('video'); if (v) attach(v);
      var v2 = document.querySelector('video');
      if (v2 && (v2.currentSrc || v2.src)) {
        var cur = v2.currentSrc || v2.src;
        var last = d.srcLog[d.srcLog.length-1];
        if (!last || last.src !== cur) d.srcLog.push({ ms: now(), src: cur });
      }
    }).observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['src'] });
  }
  boot();
})()
`

async function mouse(page, type, x, y) {
  await page.conn.send(
    'Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 },
    { sessionId: page.sessionId },
  )
}

async function dragBarTo(page, ratio) {
  // 先把鼠标移到播放区中央 → 触发容器 onMouseMove=pokeControls，露出控件层
  const center = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-viewer"]') || document.querySelector('video')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (center) {
    await mouse(page, 'mouseMoved', center.x, center.y)
    await sleep(400)
  }
  const rect0 = await page.evaluate(() => {
    const el = document.querySelector('[role="slider"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  if (!rect0 || rect0.w <= 2) return { ok: false, reason: `bar not visible/compact (w=${rect0 && rect0.w})` }
  const cy = rect0.y + rect0.h / 2
  const startX = rect0.x + rect0.w * 0.02
  const endX = rect0.x + rect0.w * ratio
  await mouse(page, 'mouseMoved', startX, cy)
  await sleep(120)
  await mouse(page, 'mousePressed', startX, cy)
  await sleep(80)
  await mouse(page, 'mouseMoved', (startX + endX) / 2, cy)
  await sleep(80)
  await mouse(page, 'mouseMoved', endX, cy)
  await sleep(80)
  await mouse(page, 'mouseReleased', endX, cy)
  await sleep(900)
  return { ok: true, ratio, rect: rect0 }
}

async function snapshot(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    const slider = document.querySelector('[role="slider"]')
    const spans = [...document.querySelectorAll('span')].map((s) => (s.textContent || '').trim())
    const ui = spans.find((x) => /^\d+:\d\d\s*\/\s*(\d+:\d\d|--:--)$/.test(x)) || null
    const ranges = (tr) => {
      const out = []
      try {
        for (let i = 0; i < tr.length; i++) out.push([+tr.start(i).toFixed(2), +tr.end(i).toFixed(2)])
      } catch { /* ignore */ }
      return out
    }
    return {
      ui,
      ariaMax: slider ? slider.getAttribute('aria-valuemax') : null,
      ariaNow: slider ? slider.getAttribute('aria-valuenow') : null,
      dur: v && Number.isFinite(v.duration) ? +v.duration.toFixed(3) : null,
      ct: v ? +v.currentTime.toFixed(3) : null,
      rs: v ? v.readyState : null,
      ns: v ? v.networkState : null,
      paused: v ? v.paused : null,
      src: v ? v.currentSrc || v.src : null,
      seekable: v ? ranges(v.seekable) : [],
      buffered: v ? ranges(v.buffered) : [],
    }
  })
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  log(`app=${APP} tg=${TG} headful=${HEADFUL} shots=${SHOTS}`)
  let browser = null
  try {
    browser = await cdp.launch({ headless: !HEADFUL }).catch(async (e) => {
      log(`headful failed: ${e.message} -> headless`)
      return cdp.launch()
    })
    const page = await browser.newPage()

    const net = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = (p.request && p.request.url) || ''
      if (/\/api\/media\/items\/\d+\/(raw|stream)/.test(url)) net.push(url)
    })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, { sessionId: page.sessionId })

    await page.goto(APP, { waitForRoot: true, settleMs: 1800, timeout: 60000 })

    // 确定性选目标：优先 item 734（上轮实测可播且有字节），否则任一 present video；
    // 走「剧集墙 → 剧集详情 → 聚焦该集 → 播放本集」进播放器（不靠卡片点击的序号猜测）。
    const itemsRes = await (await fetch(`${TG}/api/media/items?limit=1000`)).json()
    const items = itemsRes.items || []
    const presentIds = new Set(items.filter((i) => i.kind === 'video' && i.bytesPresence === 'present').map((i) => i.id))
    const prefer = presentIds.has(734) ? 734 : items.find((i) => i.kind === 'video' && i.bytesPresence === 'present')?.id
    const prefItem = items.find((i) => i.id === prefer) || {}
    raw('present.video.prefer', prefer)
    raw('present.video.prefer.seriesId', prefItem.seriesId ?? null)
    const seriesId = prefItem.seriesId
    const sd = await (await fetch(`${TG}/api/media/series/${seriesId}`)).json()
    const eps = sd.episodes || []
    const targetEp = eps.find((e) => e.itemId === prefer) || eps.find((e) => presentIds.has(e.itemId))
    raw('target.episode', targetEp ? { id: targetEp.id, itemId: targetEp.itemId, title: targetEp.title } : null)

    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await sleep(1000)
    await page.evaluate(() => document.querySelector('[data-testid="media-rail-series-all"]').click())
    await sleep(1600)
    const opened = await page.evaluate((title) => {
      const cards = [...document.querySelectorAll('[data-testid="series-card-root"]')]
      for (const c of cards) {
        if ((c.innerText || '').includes(title)) {
          ;(c.querySelector('[data-testid="series-card"]') || c).click()
          return true
        }
      }
      return false
    }, sd.title || '')
    raw('series.opened', opened)
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="episode-pick"]').length > 0, { timeout: 10000 })
    net.length = 0
    const focusOk = await page.evaluate((epId) => {
      const b = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${epId}"]`)
      if (!b) return false
      b.click()
      return true
    }, targetEp ? targetEp.id : -1)
    raw('episode.focus', focusOk)
    await sleep(500)
    const playOk = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="episode-play"]')
      if (!b || b.disabled) return false
      b.click()
      return true
    })
    raw('episode.play.clicked', playOk)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), { timeout: 12000 })
    const itemId = await page.evaluate(() => Number(document.querySelector('[data-testid="media-viewer"]').dataset.messageId))
    raw('target.itemId', itemId)
    // 等到真的起播（元素 duration 有限、readyState>=1、currentTime>0）
    for (let i = 0; i < 8; i++) {
      const s = await snapshot(page)
      if (s.dur != null && s.rs >= 1 && s.ct > 0) break
      await page.evaluate(() => {
        const v = document.querySelector('video')
        if (v && v.paused) v.play().catch(() => {})
      })
      await sleep(2000)
    }
    await page.evaluate(() => {
      window.__d.fetches.length = 0
      const v = document.querySelector('video')
      if (v && v.paused) v.play().catch(() => {})
    })
    await sleep(600)

    head('T4/H4 采样：10s 内 [时刻, UI 文本, 元素 duration, currentTime, aria-valuemax]')
    const samples = []
    for (let i = 0; i < 40; i++) {
      const s = await snapshot(page)
      samples.push({ ms: i * 250, ...s })
      await sleep(250)
    }
    for (const s of samples) {
      raw('  sample', `+${s.ms}ms  ui="${s.ui}"  dur=${s.dur}  ct=${s.ct}  ariaMax=${s.ariaMax}  rs=${s.rs}`)
    }
    const uiTotals = [...new Set(samples.map((s) => (s.ui ? s.ui.split('/')[1].trim() : null)))]
    const elemDurs = [...new Set(samples.map((s) => s.dur))]
    raw('H4.ui_total.distinct', uiTotals)
    raw('H4.element_duration.distinct', elemDurs)
    raw('H4.aria-valuemax.distinct', [...new Set(samples.map((s) => s.ariaMax))])
    raw('H4.ui_total_frozen_while_element_fluctuates', uiTotals.length <= 1 && elemDurs.length > 1)
    const lastS = samples[samples.length - 1]
    raw('H4.last.ui', lastS.ui)
    raw('H4.last.element_duration', lastS.dur)
    raw('H4.itemId', itemId)
    await page.screenshot(path.join(SHOTS, '01-sampling.png'))

    // 控件会自动隐藏遮住时间文案：poke 一下再截「current > total」铁证一帧
    const c2 = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-viewer"]') || document.querySelector('video')
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await mouse(page, 'mouseMoved', c2.x, c2.y)
    await sleep(350)
    const uiShot = await snapshot(page)
    raw('H4.ui_shot', { ui: uiShot.ui, dur: uiShot.dur, ct: uiShot.ct, ariaMax: uiShot.ariaMax })
    await page.screenshot(path.join(SHOTS, '06-ui-current-gt-total.png'))

    head('H1 判定：probeStream 是否被调用（特征 = GET …/stream?probe=1）')
    const d = await page.evaluate(() => window.__d)
    const fetchProbe = (d.fetches || []).filter((f) => /probe=1/.test(f.url))
    const netProbe = net.filter((u) => /probe=1/.test(u))
    raw('H1.fetch_calls.总(含raw/stream)', (d.fetches || []).length)
    raw('H1.fetch_calls.probe=1', fetchProbe.map((f) => `${f.ms}ms ${f.url}`))
    raw('H1.network.requests.probe=1', netProbe)
    raw('H1.probeStream_ever_called', fetchProbe.length > 0 || netProbe.length > 0)
    raw('H1.network.requests.all', [...new Set(net)].slice(0, 20))
    raw('H1.srcLog', (d.srcLog || []).map((s) => `${s.ms}ms ${s.src}`))

    head('H3 判定：拖动进度条到 ~25% / ~99% 后的 seekable / currentTime')
    const before = await snapshot(page)
    raw('H3.before', { ui: before.ui, ariaMax: before.ariaMax, ariaNow: before.ariaNow, dur: before.dur, ct: before.ct, seekable: before.seekable, buffered: before.buffered })
    const drag25 = await dragBarTo(page, 0.25)
    raw('H3.drag25', drag25)
    const s25 = await snapshot(page)
    raw('H3.after_drag25', { ui: s25.ui, ariaNow: s25.ariaNow, dur: s25.dur, ct: s25.ct, seekable: s25.seekable, buffered: s25.buffered, src: s25.src })
    await page.screenshot(path.join(SHOTS, '02-drag25.png'))
    const drag99 = await dragBarTo(page, 0.99)
    raw('H3.drag99', drag99)
    const s99 = await snapshot(page)
    raw('H3.after_drag99', { ui: s99.ui, ariaNow: s99.ariaNow, dur: s99.dur, ct: s99.ct, seekable: s99.seekable, buffered: s99.buffered, src: s99.src })
    await page.screenshot(path.join(SHOTS, '03-drag99.png'))

    head('H5 尝试复现 0:32 / 0:01：先切 2x 触发换档，再拖动')
    // 打开倍速菜单
    const speedOpened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => /播放速度|speed/i.test(x.getAttribute('aria-label') || '') || /^\d+(\.\d+)?x$/.test((x.textContent || '').trim()),
      )
      if (!b) return false
      b.click()
      return true
    })
    await sleep(500)
    const picked2x = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[role="menuitemradio"], button')]
      const b = items.find((x) => /^\s*2(\.0)?x\s*$/.test(x.textContent || ''))
      if (!b) return false
      b.click()
      return true
    })
    raw('H5.speed_menu_opened', speedOpened)
    raw('H5.picked_2x', picked2x)
    await sleep(2000)
    const s2x = await snapshot(page)
    raw('H5.after_2x', { ui: s2x.ui, ariaMax: s2x.ariaMax, dur: s2x.dur, ct: s2x.ct, src: s2x.src, seekable: s2x.seekable })
    await page.screenshot(path.join(SHOTS, '04-after-2x.png'))
    const dragMid = await dragBarTo(page, 0.5)
    raw('H5.drag_mid', dragMid)
    const sMid = await snapshot(page)
    raw('H5.after_drag_mid', { ui: sMid.ui, ariaMax: sMid.ariaMax, dur: sMid.dur, ct: sMid.ct, src: sMid.src, seekable: sMid.seekable })
    await page.screenshot(path.join(SHOTS, '05-after-2x-drag.png'))

    head('H5 扫描：UI 文本里是否出现「当前 > 总时长」')
    const bad = []
    for (let i = 0; i < 24; i++) {
      const s = await snapshot(page)
      if (s.ui) {
        const m = s.ui.match(/^(\d+):(\d\d)\s*\/\s*(\d+):(\d\d)$/)
        if (m) {
          const cur = +m[1] * 60 + +m[2]
          const tot = +m[3] * 60 + +m[4]
          if (cur > tot) bad.push({ ms: i * 400, ui: s.ui, dur: s.dur, ct: s.ct, src: s.src })
        }
      }
      await sleep(400)
    }
    raw('H5.current>total.observed', bad)

    const dd = await page.evaluate(() => window.__d)
    raw('H1.final.fetch.probe=1', (dd.fetches || []).filter((f) => /probe=1/.test(f.url)).length)
    raw('events.durationchange.count', (dd.events || []).filter((e) => e.ev === 'durationchange').length)
    raw('events.list', (dd.events || []).map((e) => `${e.ev}@${e.ms}ms dur=${e.dur}`).slice(0, 30))
  } finally {
    if (browser) await browser.close()
  }
}

main().catch((e) => {
  console.error('[dur] ERROR', (e && e.stack) || e)
  process.exit(1)
})
