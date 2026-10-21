'use strict'
/**
 * 用户 2026-10-21 复报三句话的**逐条取证**（第二轮：全部有界等待，不用固定 sleep 当判据）。
 *
 *  ①「样式混乱：NanaZip_7.0.1843.0_Binaries.zip 在第一行，TG弹窗标题在第二行」
 *  ②「TG筛选下载逻辑混乱：详情内容无法选择，但是有黑框，不清楚用途」
 *  ③「展示的内容也是混乱的」
 *
 * 用法：node tauri-shell/verify/_diag_round2.cjs
 * 前置：dev 5180 + daemon 19786 + orig-tg 19787。
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'tg-layout')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(page, fn, timeoutMs = 40000, step = 400) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try {
      v = await page.evaluate(fn)
    } catch {
      v = false
    }
    if (v) return { ok: true, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 }
    await sleep(step)
  }
}

const R = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await sleep(2000)

    // ============ ① 文件域（媒体库）首屏 ============
    await page.evaluate(() => document.querySelector('[data-testid="nav-files"]')?.click())
    // 有界等待库探活通过（stats 冷启动可达十几秒，固定 sleep 会把正常首屏读成「服务未运行」）
    const wAlive = await waitFor(
      page,
      () => !document.body.textContent.includes('媒体服务未运行'),
      60000,
    )
    console.log(`库探活到位：ok=${wAlive.ok} ${wAlive.ms}ms`)
    const wItems = await waitFor(
      page,
      () => document.querySelectorAll('[data-testid^="media-card"], [data-testid="media-grid"] > *').length > 0,
      60000,
    )
    console.log(`媒体条目到位：ok=${wItems.ok} ${wItems.ms}ms`)
    await page.screenshot(path.join(OUT, '10-files-loaded.png'))

    const cards = await page.evaluate(() => {
      const out = []
      const els = Array.from(
        document.querySelectorAll('[data-testid^="media-card"], [data-testid="media-grid"] > *, [data-testid="media-row"]'),
      ).slice(0, 12)
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        out.push({
          testid: el.getAttribute('data-testid') || null,
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        })
      }
      return out
    })
    console.log('\n===== ① 媒体库前 12 个条目（按 y）=====')
    cards
      .sort((a, b) => a.rect.y - b.rect.y)
      .forEach((c, i) => console.log(`#${i + 1} y=${c.rect.y} ${c.w}x${c.h} ${c.testid ? `[${c.testid}] ` : ''}"${c.txt}"`))

    // ============ ② TG 域 ============
    await page.evaluate(() => document.querySelector('[data-testid="nav-tg"]')?.click())
    const wRows = await waitFor(
      page,
      () => document.querySelectorAll('[data-testid="tg-filter-row"]').length > 0,
    )
    console.log(`\n筛选行到位：ok=${wRows.ok} ${wRows.ms}ms`)
    // 等默认频道的消息流到位（气泡出现）
    const wFeed = await waitFor(
      page,
      () => document.querySelectorAll('[data-message-key]').length > 0,
    )
    console.log(`消息流到位：ok=${wFeed.ok} ${wFeed.ms}ms`)
    await sleep(800)
    await page.screenshot(path.join(OUT, '11-tg-loaded.png'))

    // ②-1 筛选行内部结构（间距/字号/命中区）
    const frows = await page.evaluate(() => {
      const out = []
      for (const row of document.querySelectorAll('[data-testid="tg-filter-row"]')) {
        const rr = row.getBoundingClientRect()
        const kids = []
        for (const el of row.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          kids.push({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid') || null,
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            fs: getComputedStyle(el).fontSize,
            disabled: el.disabled === true,
          })
        }
        out.push({ rect: R2(rr), kids })
      }
      function R2(r) {
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      return out
    })
    console.log('\n===== ②-1 筛选行结构 =====')
    for (const row of frows) {
      console.log(`row rect=${JSON.stringify(row.rect)}`)
      for (const k of row.kids) {
        console.log(
          `   ${k.tag}${k.testid ? `[${k.testid}]` : ''} "${k.txt}" rect=${JSON.stringify(k.rect)} fs=${k.fs}` +
            `${k.disabled ? ' DISABLED' : ''}`,
        )
      }
    }

    // ②-2 「黑框」：PhotoBlock 的 absolute 缓存钮（压在图上的黑色块）
    const black = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, span')) {
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        // 半透明黑底 + 绝对定位 = 压在内容上的「黑框」
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
        if (!m) continue
        const [rr, gg, bb, aa] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])]
        const isBlack = rr < 60 && gg < 60 && bb < 60
        if (!isBlack || aa >= 1) continue
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue
        out.push({
          testid: el.getAttribute('data-testid') || null,
          tag: el.tagName.toLowerCase(),
          txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          bg,
          pos: cs.position,
        })
      }
      return out
    })
    console.log('\n===== ②-2 压在内容上的半透明黑框（absolute + 黑底）=====')
    black.forEach((b) =>
      console.log(`${b.testid ? `[${b.testid}] ` : ''}${b.tag} "${b.txt}" rect=${JSON.stringify(b.rect)} bg=${b.bg} pos=${b.pos}`),
    )
    if (black.length === 0) console.log('（无）')

    // ②-3 消息气泡内：详情区可交互性（用户「详情内容无法选择」）
    const bubbles = await page.evaluate(() => {
      const out = []
      for (const b of Array.from(document.querySelectorAll('[data-message-key]')).slice(0, 6)) {
        const r = b.getBoundingClientRect()
        const interactive = []
        for (const el of b.querySelectorAll('button, input, label, a, [role="button"]')) {
          const rr = el.getBoundingClientRect()
          if (rr.width < 6 || rr.height < 6) continue
          const cx = Math.round(rr.x + rr.width / 2)
          const cy = Math.round(rr.y + rr.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          interactive.push({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid') || null,
            txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
            rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
            hitOk: !!hit && (hit === el || el.contains(hit)),
            disabled: el.disabled === true,
            fs: getComputedStyle(el).fontSize,
          })
        }
        out.push({
          key: b.getAttribute('data-message-key'),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          txt: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          interactive,
        })
      }
      return out
    })
    console.log('\n===== ②-3 消息气泡可交互元素（命中测试）=====')
    for (const b of bubbles) {
      console.log(`[${b.key}] rect=${JSON.stringify(b.rect)} "${b.txt}"`)
      for (const i of b.interactive) {
        console.log(
          `   ${i.tag}${i.testid ? `[${i.testid}]` : ''} "${i.txt}" rect=${JSON.stringify(i.rect)} fs=${i.fs}` +
            ` ${i.disabled ? 'DISABLED' : ''}${i.hitOk ? '' : ' HIT-FAIL'}`,
        )
      }
    }

    // ②-4 打开第一条筛选规则，量结果面板
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tg-filter-row"] button')
      if (b) b.click()
    })
    const wPanel = await waitFor(
      page,
      () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
    )
    console.log(`\n筛选结果面板出现：ok=${wPanel.ok} ${wPanel.ms}ms`)
    const wHits = await waitFor(
      page,
      () => document.querySelectorAll('[data-testid="tg-filter-hit"], [data-testid="tg-filter-group"]').length > 0,
    )
    console.log(`命中行到位：ok=${wHits.ok} ${wHits.ms}ms`)
    await sleep(600)
    await page.screenshot(path.join(OUT, '12-tg-filter-hits.png'))

    const panel = await page.evaluate(() => {
      const rows = []
      for (const el of Array.from(
        document.querySelectorAll('[data-testid="tg-filter-hit"], [data-testid="tg-filter-group"]'),
      ).slice(0, 3)) {
        const r = el.getBoundingClientRect()
        const kids = []
        for (const k of el.querySelectorAll('input, button, p, span, img')) {
          const rr = k.getBoundingClientRect()
          if (rr.width < 6 || rr.height < 6) continue
          kids.push({
            tag: k.tagName.toLowerCase(),
            testid: k.getAttribute('data-testid') || null,
            txt: (k.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
            rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
            fs: getComputedStyle(k).fontSize,
          })
        }
        rows.push({
          testid: el.getAttribute('data-testid'),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          kids,
        })
      }
      const footer = document.querySelector('[data-testid="tg-filter-select-all"]')
      const fr = footer ? footer.getBoundingClientRect() : null
      const ingest = document.querySelector('[data-testid="tg-filter-ingest"]')
      const ir = ingest ? ingest.getBoundingClientRect() : null
      return {
        rows,
        selectAll: fr ? { rect: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) }, fs: getComputedStyle(footer).fontSize } : null,
        ingest: ir ? { rect: { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) }, fs: getComputedStyle(ingest).fontSize, txt: (ingest.textContent || '').trim() } : null,
      }
    })
    console.log('\n===== ②-4 筛选结果面板 =====')
    console.log(`selectAll=${JSON.stringify(panel.selectAll)}`)
    console.log(`ingest=${JSON.stringify(panel.ingest)}`)
    for (const row of panel.rows) {
      console.log(`${row.testid} rect=${JSON.stringify(row.rect)}`)
      for (const k of row.kids) {
        console.log(`   ${k.tag}${k.testid ? `[${k.testid}]` : ''} "${k.txt}" rect=${JSON.stringify(k.rect)} fs=${k.fs}`)
      }
    }

    console.log(`\n产物：${OUT}`)
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error('DIAG CRASH:', e && e.message ? e.message : e)
  process.exit(1)
})
