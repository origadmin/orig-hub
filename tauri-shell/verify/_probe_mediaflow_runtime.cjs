#!/usr/bin/env node
'use strict'
/**
 * 媒体流运行时取证（**只读**）：T1 播放路径 /raw vs /stream；T2 时长错乱；T3 无字节提示。
 *
 * 硬约束：不 kill 进程、不改任何数据、不触发真实缓存任务；破坏性动作一律不点
 * （不点重新缓存 / 删除 / 重试 / 合并）。全部只做：GET、页面内导航与点击、CDP 网络抓包、读 DOM。
 *
 * Usage:
 *   node verify/_probe_mediaflow_runtime.cjs
 * Env:
 *   APP_URL / TG_API / FFPROBE / MF_HEADFUL=0|1（默认 1，真实 GPU 合成；0=无头）
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const cdp = require('./lib/cdp.cjs')

const APP = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG = (process.env.TG_API || 'http://127.0.0.1:19788').replace(/\/$/, '')
const FFPROBE =
  process.env.FFPROBE || path.join(process.env.LOCALAPPDATA || '', 'OrigHub', 'bin', 'ffprobe.exe')
const HEADFUL = (process.env.MF_HEADFUL || '1') !== '0'
const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
})()
const SHOTS = path.resolve(__dirname, '..', 'verify_shots', `mediaflow-${stamp}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[mf]', ...a)
const head = (t) => console.log(`\n[mf] ===== ${t} =====`)
const raw = (label, v) => console.log(`[mf] ${label} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)

async function jget(u) {
  const r = await fetch(u)
  const t = await r.text()
  let b = null
  try {
    b = JSON.parse(t)
  } catch {
    b = t.slice(0, 200)
  }
  return { status: r.status, body: b }
}

function ffprobeDuration(abs) {
  try {
    const out = execFileSync(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs],
      { encoding: 'utf8', timeout: 30000 },
    )
    const n = Number(String(out).trim())
    return Number.isFinite(n) ? n : { error: `unparsable: ${JSON.stringify(out)}` }
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 240) }
  }
}

/* 页面内插桩：记录 <video>.src 变化序列（相对 performance.now）、媒体事件、/raw 调用点栈。 */
const HOOK = `
(() => {
  if (window.__mf) return;
  var mf = { t0: performance.now(), marker: null, samples: [], events: [], hits: [] };
  window.__mf = mf;
  function now(){ return Math.round(performance.now() - mf.t0); }
  // /raw 调用点归因：谁把 URL 赋给了 src / fetch / xhr
  var RX = /\\/api\\/media\\/items\\/\\d+\\/raw/;
  function rec(kind, url){
    if (typeof url === 'string' && RX.test(url)) {
      mf.hits.push({ kind: kind, url: url, stack: (new Error('t')).stack });
    }
  }
  function defSrc(proto, tag){
    try {
      var d = Object.getOwnPropertyDescriptor(proto, 'src');
      if (d && d.set) Object.defineProperty(proto, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function(v){ rec('src:' + tag, v); return d.set.call(this, v); }
      });
    } catch(e){}
  }
  if (window.HTMLImageElement) defSrc(HTMLImageElement.prototype, 'IMG');
  if (window.HTMLMediaElement) defSrc(HTMLMediaElement.prototype, 'MEDIA');
  try {
    var sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(n, v){ if (n === 'src') rec('setAttribute:' + this.tagName, v); return sa.apply(this, arguments); };
  } catch(e){}
  try {
    var of = window.fetch;
    window.fetch = function(input){ var u = typeof input === 'string' ? input : (input && input.url) || ''; rec('fetch', u); return of.apply(this, arguments); };
  } catch(e){}
  try {
    var xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){ rec('xhr.open', u); return xo.apply(this, arguments); };
  } catch(e){}
  function sampleVideo(){
    var v = document.querySelector('video');
    if (!v) return;
    var cur = v.currentSrc || v.src || '';
    var last = mf.samples[mf.samples.length-1];
    if (!last || last.src !== cur) {
      mf.samples.push({ ms: now(), src: cur, duration: (isFinite(v.duration)?v.duration:null), readyState: v.readyState });
    }
  }
  function attach(v){
    if (!v || v.__mfHooked) return;
    v.__mfHooked = true;
    ['waiting','stalled','playing','pause','error','loadedmetadata','durationchange','emptied','abort','suspend','seeking','seeked','canplay','canplaythrough','loadeddata'].forEach(function(ev){
      v.addEventListener(ev, function(){
        mf.events.push({ ev: ev, ms: now(), rs: v.readyState, ns: v.networkState, ct: +(v.currentTime||0).toFixed(3), dur: (isFinite(v.duration)?v.duration:null), src: (v.currentSrc||v.src||'') });
      });
    });
    sampleVideo();
  }
  function boot(){
    if (!document.documentElement) { setTimeout(boot, 20); return; }
    var mo = new MutationObserver(function(){ var v=document.querySelector('video'); if(v) attach(v); sampleVideo(); });
    mo.observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['src'] });
    setInterval(function(){ var v=document.querySelector('video'); if(v) attach(v); sampleVideo(); }, 100);
  }
  boot();
})()
`

async function videoState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video')
    if (!v) return null
    const seek = []
    try {
      for (let i = 0; i < v.seekable.length; i++) seek.push([+v.seekable.start(i).toFixed(3), +v.seekable.end(i).toFixed(3)])
    } catch { /* ignore */ }
    const buf = []
    try {
      for (let i = 0; i < v.buffered.length; i++) buf.push([+v.buffered.start(i).toFixed(3), +v.buffered.end(i).toFixed(3)])
    } catch { /* ignore */ }
    const timeText = [...document.querySelectorAll('span')]
      .map((s) => (s.textContent || '').trim())
      .filter((t) => /\d+:\d\d\s*\/\s*(\d+:\d\d|--:--)/.test(t))
    const viewer = document.querySelector('[data-testid="media-viewer"]')
    return {
      src: v.currentSrc || v.src || '',
      duration: Number.isFinite(v.duration) ? v.duration : null,
      currentTime: +v.currentTime.toFixed(3),
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      seekable: seek,
      buffered: buf,
      timeText,
      viewerMessageId: viewer ? Number(viewer.dataset.messageId) : null,
      roleAlerts: [...document.querySelectorAll('[role="alert"]')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()),
    }
  })
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  log(`app=${APP} tg=${TG}`)
  log(`shots=${SHOTS}`)
  log(`headful=${HEADFUL} ffprobe=${FFPROBE}`)

  // ---- 环境事实（只读）----
  const itemsRes = await jget(`${TG}/api/media/items?limit=1000`)
  const items = (itemsRes.body && itemsRes.body.items) || []
  const missingVideo = items.filter((i) => i.kind === 'video' && i.bytesPresence !== 'present')
  const presentVideo = items.filter((i) => i.kind === 'video' && i.bytesPresence === 'present')
  raw('items.count', items.length)
  raw('video.present.count', presentVideo.length)
  raw('video.missing.ids', missingVideo.map((i) => i.id))
  const missingIdSet = new Set(missingVideo.map((i) => i.id))
  const byId = new Map(items.map((i) => [i.id, i]))

  let browser = null
  try {
    browser = await cdp.launch({ headless: !HEADFUL }).catch(async (e) => {
      log(`headful launch failed: ${e.message} -> retry headless`)
      return cdp.launch()
    })
    const page = await browser.newPage()

    // 网络层抓包
    const net = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const url = (p.request && p.request.url) || ''
      if (/\/api\/media\/items\/\d+\/(raw|stream)/.test(url)) {
        net.push({ t: Date.now(), method: (p.request && p.request.method) || '', url })
      }
    })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }, { sessionId: page.sessionId })

    await page.goto(APP, { waitForRoot: true, settleMs: 1800 })
    const navOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-media"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!navOk) throw new Error('nav-media 入口未找到')
    // 媒体库默认可能停在「剧集墙」（视图被持久化）；点分类进入 items 海报墙。
    await sleep(1000)
    const toItems = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-cat-all"]')
      if (!el) return false
      el.click()
      return true
    })
    raw('media-cat-all.clicked', toItems)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="media-grid"]') && document.querySelectorAll('[data-testid="media-card"]').length > 0,
      { timeout: 15000 },
    )
    await sleep(800)

    // ================= T3a：items 视图 · 无字节卡片 =================
    head('T3a items 视图：无字节卡片渲染 + 是否可点开')
    const cardScan = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      return cards.map((c) => {
        const kind = (c.querySelector('[data-testid="item-kind"]') || {}).textContent || ''
        const nob = c.querySelector('[data-testid="item-nobytes"]')
        return {
          kind: kind.trim(),
          noBytes: !!nob,
          nobText: nob ? (nob.innerText || '').replace(/\s+/g, ' ').trim() : null,
          nobTitle: nob ? nob.getAttribute('title') : null,
          hasRecacheBtn: !!c.querySelector('[data-testid="item-recache"]'),
        }
      })
    })
    const nbIdx = cardScan.findIndex((c) => c.noBytes)
    raw('cards.total', cardScan.length)
    raw('cards.with_item-nobytes', cardScan.filter((c) => c.noBytes).length)
    raw('cards.by_kind', cardScan.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {}))
    if (nbIdx >= 0) {
      const c = cardScan[nbIdx]
      raw('nobytes.card.kind', c.kind)
      raw('nobytes.item-nobytes.text', c.nobText)
      raw('nobytes.item-nobytes.title', c.nobTitle)
      raw('nobytes.has_item-recache', c.hasRecacheBtn)
      await page.screenshot(path.join(SHOTS, '10-items-grid-nobytes.png'))
      // 点击卡片根（非封面按钮）：无字节卡片封面不是按钮，验证「点不动 / 不开播放器」
      await page.evaluate((i) => {
        const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
        cards[i].click()
      }, nbIdx)
      await sleep(700)
      const opened = await page.evaluate(() => !!document.querySelector('[data-testid="media-viewer"]'))
      raw('nobytes.card.click_root -> viewer_opened', opened)
      // 无字节卡片内是否存在「打开播放器」的封面按钮（只认封面按钮，不认重新缓存）
      const coverBtn = await page.evaluate((i) => {
        const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
        const c = cards[i]
        const btns = [...c.querySelectorAll('button')].map((b) => ({ testid: b.getAttribute('data-testid'), title: b.getAttribute('title') }))
        return btns
      }, nbIdx)
      raw('nobytes.card.buttons', coverBtn)
    } else {
      log('!! items 视图未找到无字节卡片')
    }

    // ================= T1/T2：播放一个有字节 video =================
    head('T1/T2 打开有字节 video 播放')
    const vIdx = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      for (let i = 0; i < cards.length; i++) {
        const kind = ((cards[i].querySelector('[data-testid="item-kind"]') || {}).textContent || '').trim()
        if (/视频|Video/.test(kind) && !cards[i].querySelector('[data-testid="item-nobytes"]')) return i
      }
      return -1
    })
    raw('present_video.card_index', vIdx)
    if (vIdx < 0) throw new Error('网格里没有有字节 video 卡片')
    net.length = 0
    const openWall = Date.now()
    await page.evaluate((i) => {
      const cards = [...document.querySelectorAll('[data-testid="media-card"]')]
      const b = cards[i].querySelector('button') || cards[i]
      b.click()
    }, vIdx)
    await page.waitForFunction(() => !!document.querySelector('[data-testid="media-viewer"]'), { timeout: 12000 })
    await page.evaluate(() => {
      window.__mf.marker = Math.round(performance.now())
      const v = document.querySelector('video')
      if (v && v.paused) v.play().catch(() => {})
    })
    await sleep(1200)
    const st0 = await videoState(page)
    const itemId = st0 ? st0.viewerMessageId : null
    raw('player.itemId', itemId)
    raw('player.api.bytesPresence', itemId != null && byId.has(itemId) ? byId.get(itemId).bytesPresence : 'n/a')
    raw('player.api.filePath', itemId != null && byId.has(itemId) ? byId.get(itemId).filePath : 'n/a')
    raw('player.src(mount)', st0 ? st0.src : null)
    await page.screenshot(path.join(SHOTS, '20-player-mount.png'))

    // 10.5s 采样 currentTime / readyState
    const samples = []
    for (let i = 0; i < 21; i++) {
      const s = await videoState(page)
      samples.push({ ms: i * 500, ct: s && s.currentTime, rs: s && s.readyState, dur: s && s.duration, paused: s && s.paused })
      await sleep(500)
    }
    const stEnd = await videoState(page)
    const mf = await page.evaluate(() => window.__mf)

    head('T1 原始读数：<video>.src 变化序列（相对打开播放器后的 marker，单位 ms）')
    const srcSeq = (mf.samples || []).map((s) => ({ ms: mf.marker != null ? s.ms - mf.marker : s.ms, src: s.src }))
    for (const s of srcSeq) raw('  src', `${s.ms >= 0 ? '+' : ''}${s.ms}ms  ${s.src}`)
    raw('src.sequence.count', srcSeq.length)

    head('T1 原始读数：网络请求（/raw 与 /stream 次数 + URL）')
    const thisItemNet = net.filter((n) => itemId != null && n.url.includes(`/items/${itemId}/`))
    const netAll = net.map((n) => ({ ago: `${n.t - openWall}ms`, method: n.method, url: n.url }))
    raw('net.total(/raw+/stream)', netAll.length)
    raw('net.for_current_item', thisItemNet.map((n) => `${n.method} ${n.url}`))
    for (const n of netAll.slice(0, 40)) raw('  net', `${n.ago} ${n.method} ${n.url}`)
    const rawCount = net.filter((n) => /\/raw(\?|$)/.test(n.url)).length
    const streamCount = net.filter((n) => /\/stream(\?|$)/.test(n.url)).length
    raw('COUNT /raw', rawCount)
    raw('COUNT /stream', streamCount)

    head('T1 归因：/raw 调用点（页面内插桩调用栈）')
    const hits = (mf.hits || []).map((h) => {
      const frames = String(h.stack || '')
        .split('\n')
        .slice(1, 5)
        .map((s) => s.trim().replace(/^at\s+/, ''))
      const file = frames.find((f) => /(src|node_modules)\//.test(f)) || frames[0] || ''
      return { kind: h.kind, url: h.url, file }
    })
    raw('raw.hits.count', hits.length)
    const byFile = hits.reduce((a, h) => ((a[h.file] = (a[h.file] || 0) + 1), a), {})
    raw('raw.hits.by_callsite', byFile)
    for (const h of hits.slice(0, 10)) raw('  raw.hit', `${h.kind} ${h.url} <- ${h.file}`)
    // 播放元素自身的 src 是否出现过 /raw（播放路径判据）
    const playerSrcRaw = (mf.samples || []).some((s) => /\/raw(\?|$)/.test(s.src || ''))
    raw('player.video.src_ever_raw', playerSrcRaw)

    head('T1 播放健康（10.5s 窗口）')
    const ct0 = samples[0] && samples[0].ct
    const ct1 = samples[samples.length - 1] && samples[samples.length - 1].ct
    raw('currentTime.start', ct0)
    raw('currentTime.end', ct1)
    raw('currentTime.advanced(sec, ~10s wall)', ct0 != null && ct1 != null ? +(ct1 - ct0).toFixed(3) : null)
    raw('readyState.series', samples.map((s) => s.rs))
    raw('paused.series', samples.map((s) => s.paused))
    const evCount = (mf.events || []).reduce((a, e) => ((a[e.ev] = (a[e.ev] || 0) + 1), a), {})
    raw('event.counts', evCount)
    raw('event.waiting', (mf.events || []).filter((e) => e.ev === 'waiting').map((e) => `${e.ms}ms`))
    raw('event.stalled', (mf.events || []).filter((e) => e.ev === 'stalled').map((e) => `${e.ms}ms`))
    raw('event.error', (mf.events || []).filter((e) => e.ev === 'error'))

    head('T2 时长读数（有字节条目 #1）')
    raw('video.src.now', stEnd && stEnd.src)
    raw('video.duration', stEnd && stEnd.duration)
    raw('video.currentTime', stEnd && stEnd.currentTime)
    raw('video.readyState', stEnd && stEnd.readyState)
    raw('video.networkState', stEnd && stEnd.networkState)
    raw('video.seekable', stEnd && stEnd.seekable)
    raw('video.buffered', stEnd && stEnd.buffered)
    raw('UI.timeText', stEnd && stEnd.timeText)
    if (itemId != null && byId.has(itemId)) {
      const it = byId.get(itemId)
      raw('api.item.duration', it.duration)
      raw('api.item.absolutePath', it.absolutePath)
      if (it.absolutePath) {
        const ff = ffprobeDuration(it.absolutePath)
        raw('ffprobe.format.duration', ff)
      }
    }
    await page.screenshot(path.join(SHOTS, '21-player-playing.png'))

    // 复现「currentTime / duration 错乱」：连按快进触发 re-anchor（?t= 新流）
    head('T2b 复现时长错乱形态：快进 re-anchor')
    for (let k = 0; k < 3; k++) {
      const fw = await page.evaluate(() => {
        const b = [...document.querySelectorAll('[role="toolbar"] button')].find((x) => /快进|Forward/.test(x.getAttribute('aria-label') || ''))
        if (!b) return false
        b.click()
        return true
      })
      await sleep(1200)
      const s = await videoState(page)
      raw(`reanchor.after_fwd_${k + 1}.src`, s && s.src)
      raw(`reanchor.after_fwd_${k + 1}.duration`, s && s.duration)
      raw(`reanchor.after_fwd_${k + 1}.currentTime`, s && s.currentTime)
      raw(`reanchor.after_fwd_${k + 1}.UI.timeText`, s && s.timeText)
      raw(`reanchor.after_fwd_${k + 1}.forward_clicked`, fw)
    }
    await page.screenshot(path.join(SHOTS, '23-player-reanchor.png'))

    // 第二个有字节视频（换 id）：用 viewer-prev 往回（序列里下一个可能是无字节条目）
    head('T2 时长读数（条目 #2：viewer-prev）')
    const hasPrev = await page.evaluate(() => !!document.querySelector('[data-testid="viewer-prev"]'))
    raw('viewer-prev存在', hasPrev)
    let item2 = null
    if (hasPrev) {
      await page.evaluate(() => document.querySelector('[data-testid="viewer-prev"]').click())
      await sleep(1600)
      await page.evaluate(() => {
        const v = document.querySelector('video')
        if (v && v.paused) v.play().catch(() => {})
      })
      await sleep(1200)
      const st2 = await videoState(page)
      item2 = st2 && st2.viewerMessageId
      raw('player2.itemId', item2)
      raw('player2.src', st2 && st2.src)
      raw('player2.bytesPresence', item2 != null && byId.has(item2) ? byId.get(item2).bytesPresence : 'n/a')
      raw('player2.duration', st2 && st2.duration)
      raw('player2.readyState', st2 && st2.readyState)
      raw('player2.seekable', st2 && st2.seekable)
      raw('player2.UI.timeText', st2 && st2.timeText)
      if (item2 != null && byId.has(item2)) {
        const it = byId.get(item2)
        raw('api.item2.duration', it.duration)
        raw('api.item2.absolutePath', it.absolutePath)
        if (it.absolutePath) raw('ffprobe2.format.duration', ffprobeDuration(it.absolutePath))
      }
      await page.screenshot(path.join(SHOTS, '22-player-item2.png'))
    }

    // ================= T3d：播放器打开「无字节」条目 =================
    head('T3d 播放器打开无字节条目（沿分集列表 viewer-next 前进）')
    let reachedMissing = null
    for (let step = 0; step < 12; step++) {
      const curId = await page.evaluate(() => {
        const v = document.querySelector('[data-testid="media-viewer"]')
        return v ? Number(v.dataset.messageId) : null
      })
      if (curId != null && missingIdSet.has(curId)) {
        reachedMissing = curId
        break
      }
      const next = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="viewer-next"]')
        if (!b) return false
        b.click()
        return true
      })
      if (!next) break
      await sleep(1500)
    }
    if (reachedMissing != null) {
      raw('reached_missing.itemId', reachedMissing)
      await page.evaluate(() => {
        const v = document.querySelector('video')
        if (v && v.paused) v.play().catch(() => {})
      })
      await sleep(2500)
      const stm = await videoState(page)
      raw('missing.src', stm && stm.src)
      raw('missing.duration', stm && stm.duration)
      raw('missing.readyState', stm && stm.readyState)
      raw('missing.roleAlerts', stm && stm.roleAlerts)
      raw('missing.viewerMessageId', stm && stm.viewerMessageId)
      await page.screenshot(path.join(SHOTS, '30-player-nobytes.png'))
    } else {
      log('!! 12 步内未通过 viewer-next 抵达无字节条目')
      const stm = await videoState(page)
      raw('last.src', stm && stm.src)
      raw('last.roleAlerts', stm && stm.roleAlerts)
    }

    // 关闭播放器
    await page.evaluate(() => {
      const vb = document.querySelector('[data-testid="media-viewer"] button')
      if (vb) vb.click()
    })
    await sleep(800)

    // ================= T3b：剧集墙卡片 =================
    head('T3b 剧集墙卡片：是否任何缺字节提示')
    const railOk = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="media-rail-series-all"]')
      if (!el) return false
      el.click()
      return true
    })
    raw('series_rail.clicked', railOk)
    await sleep(1500)
    await page.screenshot(path.join(SHOTS, '40-series-wall.png'))
    const wallScan = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="series-card-root"]')]
      const hintRe = /文件已丢失|缓存已清理|未缓存|无内容|缺字节/
      return {
        count: cards.length,
        withHint: cards.filter((c) => hintRe.test(c.innerText || '')).length,
        sampleTexts: cards.slice(0, 3).map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90)),
      }
    })
    raw('series_wall.card_count', wallScan.count)
    raw('series_wall.cards_with_nobytes_hint', wallScan.withHint)
    raw('series_wall.sample_texts', wallScan.sampleTexts)

    // ================= T3c：剧集详情（含缺字节分集） =================
    head('T3c 剧集详情：分集列表 + 播放本集按钮')
    // 找一部含「缺字节 video 分集」的剧集
    let targetSeries = null
    for (const mv of missingVideo) {
      if (mv.seriesId != null) {
        const sd = await jget(`${TG}/api/media/series/${mv.seriesId}`)
        if (sd.status === 200 && sd.body) {
          targetSeries = { id: mv.seriesId, title: sd.body.title, detail: sd.body, missingItemId: mv.id }
          break
        }
      }
    }
    if (targetSeries) {
      raw('target_series.id', targetSeries.id)
      raw('target_series.title', targetSeries.title)
      raw('target_series.missingItemId', targetSeries.missingItemId)
      const epOfMissing = (targetSeries.detail.episodes || []).find((e) => e.itemId === targetSeries.missingItemId)
      raw('target_series.missing_episode', epOfMissing ? { id: epOfMissing.id, itemId: epOfMissing.itemId, title: epOfMissing.title } : null)

      // 点开剧集墙上的该剧集卡片（封面按钮 series-card = onOpen）
      const openedSeries = await page.evaluate((title) => {
        const cards = [...document.querySelectorAll('[data-testid="series-card-root"]')]
        const t = String(title).slice(0, 12)
        for (const c of cards) {
          if ((c.innerText || '').includes(t)) {
            const b = c.querySelector('[data-testid="series-card"]') || c
            b.click()
            return true
          }
        }
        return false
      }, targetSeries.title)
      raw('series_card.opened', openedSeries)
      try {
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="episode-pick"]').length > 0, { timeout: 8000 })
      } catch {
        raw('series_detail.episode-pick.timeout', true)
      }
      await sleep(600)
      const picks = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="episode-pick"]')].map((b) => ({
          epId: Number(b.dataset.episodeId),
          text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
          hasNobytesMarker: !!b.querySelector('[data-testid="episode-nobytes"]'),
        })),
      )
      raw('series_detail.episode_pick.count', picks.length)
      raw('series_detail.episode_pick.any_nobytes_marker', picks.some((p) => p.hasNobytesMarker))
      for (const p of picks.slice(0, 8)) raw('  pick', `${p.epId} | ${p.text} | nobytes=${p.hasNobytesMarker}`)
      if (epOfMissing) raw('series_detail.missing_episode_row', picks.find((p) => p.epId === epOfMissing.id) || null)

      if (epOfMissing) {
        const focused = await page.evaluate((epId) => {
          const b = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${epId}"]`)
          if (!b) return false
          b.click()
          return true
        }, epOfMissing.id)
        raw('focus_missing_episode.clicked', focused)
        await sleep(900)
        const playBtn = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="episode-play"]')
          if (!b) return null
          return { disabled: b.disabled, title: b.getAttribute('title'), text: (b.innerText || '').replace(/\s+/g, ' ').trim() }
        })
        raw('episode-play', playBtn)
        const recacheBtn = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="episode-recache"]')
          return b ? { disabled: b.disabled, title: b.getAttribute('title') } : null
        })
        raw('episode-recache', recacheBtn)
        await page.screenshot(path.join(SHOTS, '50-series-detail-missing-episode.png'))
      }
    } else {
      log('!! 未找到含缺字节分集的剧集')
    }

    // ================= 汇总 =================
    head('SUMMARY')
    const consoleErrs = page.consoleErrors()
    const raw404 = consoleErrs.filter((t) => /\/api\/media\/items\/\d+\/raw/.test(t))
    const stream404 = consoleErrs.filter((t) => /\/api\/media\/items\/\d+\/stream/.test(t))
    raw('consoleErrors.total', consoleErrs.length)
    raw('consoleErrors.raw404', raw404.length)
    raw('consoleErrors.stream404', stream404.length)
    raw('pageErrors', page.pageErrors().slice(0, 5))
  } finally {
    if (browser) await browser.close()
  }
}

main().catch((e) => {
  console.error('[mf] ERROR', (e && e.stack) || e)
  process.exit(1)
})
