// BUG-422 探针：复现 bug252 ③d —— 篡改+还原 en-US.json 后弹窗 CJK 残留是什么
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cdp = require('./lib/cdp.cjs')
const sandbox = require('./lib/sandbox.cjs')

const APP_URL = 'http://127.0.0.1:5180/'
const DAEMON = 'http://127.0.0.1:19786'
const EN_US = path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json')
const TAMPER_KEY = 'media.seriesMergeOpen'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

async function forceLanguage(page, lang) {
  await page.goto(APP_URL, { settleMs: 1500 })
  await page.evaluate((l) => {
    let cur = {}
    try { cur = JSON.parse(localStorage.getItem('orig-hub:settings') || '{}') } catch (_e) { cur = {} }
    cur.language = l
    localStorage.setItem('orig-hub:settings', JSON.stringify(cur))
  }, lang)
  await page.goto(APP_URL, { settleMs: 2000 })
}

async function main() {
  const base = await sandbox.httpJson('GET', `${DAEMON}/api/config`)
  const TG = `http://127.0.0.1:${sandbox.tgPortOf(base.json) || 19787}`
  const beforeBytes = fs.readFileSync(EN_US)
  const beforeText = beforeBytes.toString('utf8')
  const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')

  // 建两条 ASCII 标题剧集（与 bug252 同夹具形态）
  let fakeN = 0
  const mk = async (title) => {
    const fakePath = path.join(require('node:os').tmpdir(), `orighub-probe252-${Date.now()}-${fakeN++}.mp4`)
    const it = await sandbox.httpJson('POST', `${TG}/api/media/items`, {
      items: [{ path: fakePath, source: 'local', kind: 'video', title }],
    })
    const iid = it.json && Array.isArray(it.json.ids) ? it.json.ids[0] : null
    if (!iid) console.log('[probe] item create FAILED:', it.status, JSON.stringify(it.json).slice(0, 300))
    if (iid != null) await sandbox.detachAutoSeries(TG, iid)
    const r = await sandbox.httpJson('POST', `${TG}/api/media/series`, { title, kind: 'series' })
    const sid = r.json && r.json.id
    let ep = null
    if (sid && iid) {
      ep = (await sandbox.httpJson('POST', `${TG}/api/media/series/${sid}/episodes`, {
        itemId: iid, season: 1, episodeNo: 1,
      })).status
    }
    return { sid, iid, ep }
  }
  const SRC = `ZZ-PROBE-SRC-${Date.now()}`
  const TGT = `ZZ-PROBE-TGT-${Date.now()}`
  const s = await mk(SRC)
  const t = await mk(TGT)
  console.log('[probe] fixtures', JSON.stringify({ s, t }))

  const browser = await cdp.launch()
  const page = await browser.newPage()
  try {
    await forceLanguage(page, 'en-US')
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await delay(2500)

    const readDialog = () => page.evaluate((st) => {
      const opt = [...document.querySelectorAll('option')].find((o) => (o.textContent || '').includes(st))
      if (!opt) return null
      let node = opt
      while (node && !String(node.className || '').includes('max-w-md')) node = node.parentElement
      if (!node) return null
      const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim()
      return {
        title: norm(node.querySelector('h4') ? node.querySelector('h4').innerText : ''),
        text: node.innerText,
        options: [...node.querySelectorAll('option')].map((o) => norm(o.innerText)),
      }
    }, SRC)

    const openMerge = async () => {
      await page.evaluate((sid) => {
        const el = document.querySelector('[data-testid="nav-child-lib-series"]')
        if (el) el.click()
      }, t.sid)
      await delay(1500)
      const diag0 = await page.evaluate((sid) => ({
        cards: document.querySelectorAll('[data-testid="series-card-root"]').length,
        hasTarget: !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`),
      }), t.sid)
      console.log('[probe] wall diag =', JSON.stringify(diag0))
      await page.evaluate((sid) => {
        const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
        const card = root && root.querySelector('[data-testid="series-card"]')
        if (card) card.click()
      }, t.sid)
      await delay(1500)
      const diag1 = await page.evaluate(() => ({
        hasMergeBtn: !!document.querySelector('[data-testid="series-merge"]'),
        dialogs: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
          .filter((x) => /dialog|detail|panel|merge/i.test(x)).slice(0, 12),
      }))
      console.log('[probe] after card click =', JSON.stringify(diag1))
      await page.waitForFunction(() => !!document.querySelector('[data-testid="series-merge"]'), { timeout: 15000 })
      await page.evaluate(() => document.querySelector('[data-testid="series-merge"]').click())
      await page.waitForFunction(
        (st) => [...document.querySelectorAll('option')].some((o) => (o.textContent || '').includes(st)),
        { timeout: 15000, args: [SRC] },
      )
      await delay(500)
    }

    // ① 基线（en）
    await openMerge()
    const base1 = await readDialog()
    const whitelist = (d) => [...new Set([SRC, TGT, ...(d ? d.options : [])])].sort((a, b) => b.length - a.length)
    const residue = (d) => {
      let rest = String(d.text || '').replace(/\s+/g, ' ').trim()
      for (const n of whitelist(d)) rest = rest.split(n).join(' ')
      return rest.match(CJK) || []
    }
    console.log('[probe] ① 基线 residue =', JSON.stringify(residue(base1)), 'title =', JSON.stringify(base1 && base1.title))
    // 诊断：哪些 option 的归一化文本不在 dialog 文本里
    if (base1) {
      const normT = String(base1.text || '').replace(/\s+/g, ' ').trim()
      const bad = base1.options.filter((o) => !normT.includes(o))
      console.log('[probe] 归一化后仍未匹配的 option 数 =', bad.length, JSON.stringify(bad.slice(0, 3)))
      const nbsp = base1.options.filter((o) => /\u00a0/.test(o))
      console.log('[probe] 含 NBSP 的 option 数 =', nbsp.length, JSON.stringify(nbsp.slice(0, 2)))
      const rawOpts = await page.evaluate(() => [...document.querySelectorAll('option')].map((o) => o.innerText).filter((t) => /洞洞杂货铺/.test(t)))
      console.log('[probe] 原始 option innerText =', JSON.stringify(rawOpts))
    }

    // ② 篡改 → 读红态
    const tamperLine = beforeText.split('\n').find((l) => l.includes(TAMPER_KEY))
    console.log('[probe] tamper line =', JSON.stringify(tamperLine))
    fs.writeFileSync(EN_US, beforeText.replace(tamperLine, tamperLine.replace(/"Merge series"/, '"合并剧集"')))
    await delay(1200)
    await forceLanguage(page, 'en-US')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 20000 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await delay(2500)
    await openMerge()
    const red = await readDialog()
    console.log('[probe] ② 红态 title =', JSON.stringify(red && red.title), 'residue =', JSON.stringify(residue(red)))

    // ③ 还原 → 读绿态（先只写回，不 reload；再 reload 各读一次）
    fs.writeFileSync(EN_US, beforeBytes)
    const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(EN_US)).digest('hex')
    console.log('[probe] ③ sha restored =', shaAfter === shaBefore)
    await delay(1200)
    await openMerge()
    const greenNoReload = await readDialog()
    console.log('[probe] ③a 不 reload title =', JSON.stringify(greenNoReload && greenNoReload.title),
      'residue =', JSON.stringify(residue(greenNoReload)))
    if (greenNoReload) {
      let rest = String(greenNoReload.text || '')
      for (const n of whitelist(greenNoReload)) rest = rest.split(n).join(' ')
      const idx = rest.search(CJK)
      console.log('[probe] ③a 残留上下文 =', JSON.stringify(rest.slice(Math.max(0, idx - 60), idx + 60)))
    }
    await forceLanguage(page, 'en-US')
    await page.waitForFunction(() => !!document.querySelector('[data-testid="nav-child-lib-series"]'), { timeout: 20000 })
    await page.evaluate(() => document.querySelector('[data-testid="nav-child-lib-series"]').click())
    await delay(2500)
    await openMerge()
    const greenReload = await readDialog()
    console.log('[probe] ③b reload 后 title =', JSON.stringify(greenReload && greenReload.title),
      'residue =', JSON.stringify(residue(greenReload)))
  } finally {
    fs.writeFileSync(EN_US, beforeBytes) // 兜底还原
    await browser.close().catch(() => {})
    if (s.sid) await sandbox.httpJson('DELETE', `${TG}/api/media/series/${s.sid}`)
    if (t.sid) await sandbox.httpJson('DELETE', `${TG}/api/media/series/${t.sid}`)
    console.log('[probe] cleanup done')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[probe] FAIL', e); process.exit(1) })
