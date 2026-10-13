#!/usr/bin/env node
'use strict'

/**
 * BUG-252 验收（活栈 · CDP）：MergeSeriesDialog（剧集内页单源合并）文案 i18n。
 *
 * ## 判据（与 docs/bugs/BUG-252.md「验收证据」一一对应）
 *
 *   ⓪ 持久化 `orig-hub:settings.language = "en-US"` + 整页重载后 `<html lang>` 生效；
 *   ① en-US 下打开「合并剧集」弹窗（剧集内页 `series-merge` 入口）：
 *     ①a 弹窗可见文本中 CJK 汉字数为 0（正则 [\u4e00-\u9fff]；
 *         真实剧名是**数据**，用 API 取到的全库剧集名白名单扣除后再数）；
 *     ①b 关键串**等于预期英文译文**（不是「非空」——防键缺失回退成 key 名/中文）：
 *         标题 / 说明段 / 候选项 / 说明段 / 集号规则段 / 确认提示 / 按钮；
 *   ② 中文模式下同一弹窗正常渲染中文（zh-CN 键存在、双语都不破）；
 *   ③ 反向证伪：把 `media.seriesMergeOpen` 的 en-US 值临时改回硬编码中文
 *     ⇒ ①a/①b 必须 FAIL（红态读数照实记录）⇒ **字节级还原**（禁 git checkout），
 *     sha256 一致后复跑必须 PASS。
 *
 * ## 环境
 *
 *   活栈：vite :5180 / orig-daemon :19786 / orig-tg（端口经 `_lib_endpoints.cjs`
 *   从 daemon `/api/config` 的 `tg_port` 运行时解析，不写死）。dev stack 不许动。
 *   夹具自造自删（两条剧集各 1 集，ASCII 标题），绝不碰用户数据。
 *
 * 用法：`node verify/verify_bug_252_merge_dialog_i18n.cjs`
 * Env : ORIG_VERIFY_OUT（截图/result.json 输出目录，默认 verify/evidence/BUG-252）
 * Exit: 0 = 全部通过；2 = 有判据失败（含证伪红态未按预期失败 / 还原后不复绿）。
 */

const path = require('path')
const fs = require('fs')
const os = require('node:os')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-252')
const EN_US = path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json')
const CJK = /[\u4e00-\u9fff]/

/** 证伪目标：en-US 里被临时改回中文的键（标题，弹窗必然渲染）。 */
const TAMPER_KEY = 'media.seriesMergeOpen'
const TAMPER_LINE_EN = '  "media.seriesMergeOpen": "Merge series",'
const TAMPER_LINE_ZH = '  "media.seriesMergeOpen": "合并剧集",'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

// ─────────────────────────── HTTP（仅回环，造夹具 / 取白名单） ───────────────────────────

async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

/** 造一条本地视频条目（假路径即可：合并弹窗不读字节）。 */
async function createItem(title, tg) {
  const fakePath = path.join(os.tmpdir(), `orighub-bug252-${Date.now()}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, status: r.status }
}

async function createSeries(title, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status }
}

async function addEpisode(seriesId, itemId, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo: 1,
  })
  return r.status
}

// ─────────────────────────── 页面操作 ───────────────────────────

/** 强制界面语言：写持久化设置 → 整页重载（与 BUG-259 同机制）。 */
async function forceLanguage(page, appUrl, lang) {
  await page.goto(appUrl, { settleMs: 1500 })
  await page.evaluate((l) => {
    let cur = {}
    try {
      cur = JSON.parse(localStorage.getItem('orig-hub:settings') || '{}')
    } catch (_e) {
      cur = {}
    }
    cur.language = l
    localStorage.setItem('orig-hub:settings', JSON.stringify(cur))
  }, lang)
  await page.goto(appUrl, { settleMs: 2000 })
}

/**
 * 从剧集墙打开目标剧集详情 → 点「合并剧集」→ 等弹窗候选下拉出现。
 * 等待锚点是**候选项文本含源剧集名**（数据、与语言无关），证伪红态下也不会挂死。
 */
async function openMergeDialog(page, targetId, sourceTitle) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await delay(1200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-rail-series-all"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    (sid) => !!document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`),
    { timeout: 25000, args: [targetId] },
  )
  await page.evaluate((sid) => {
    const root = document.querySelector(`[data-testid="series-card-root"][data-series-id="${sid}"]`)
    const card = root && root.querySelector('[data-testid="series-card"]')
    if (card) card.click()
  }, targetId)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="series-merge"]'), {
    timeout: 15000,
  })
  await page.evaluate(() => document.querySelector('[data-testid="series-merge"]').click())
  await page.waitForFunction(
    (st) => [...document.querySelectorAll('option')].some((o) => (o.textContent || '').includes(st)),
    { timeout: 15000, args: [sourceTitle] },
  )
  await delay(400)
}

/** 读弹窗：从含源剧名的 option 上浮到 max-w-md 容器（BUG-259 同款定位）。 */
async function readMergeDialog(page, sourceTitle) {
  return page.evaluate((st) => {
    const opt = [...document.querySelectorAll('option')].find((o) => (o.textContent || '').includes(st))
    if (!opt) return null
    let node = opt
    while (node && !String(node.className || '').includes('max-w-md')) node = node.parentElement
    if (!node) return null
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    return {
      title: norm(node.querySelector('h4') ? node.querySelector('h4').innerText : ''),
      text: node.innerText,
      paragraphs: [...node.querySelectorAll('p')].map((p) => norm(p.innerText)),
      options: [...node.querySelectorAll('option')].map((o) => norm(o.innerText)),
      buttons: [...node.querySelectorAll('button')].map((b) => norm(b.innerText)),
    }
  }, sourceTitle)
}

/** 点「下一步 / Next」进入确认态（主按钮 = 最后一个按钮）。 */
async function gotoConfirmStep(page, sourceTitle) {
  await page.evaluate(() => {
    const opt = [...document.querySelectorAll('option')]
    const sel = opt.length ? opt[0].closest('select') : null
    let node = sel
    while (node && !String(node.className || '').includes('max-w-md')) node = node.parentElement
    const btns = node ? [...node.querySelectorAll('button')] : []
    const next = btns[btns.length - 1]
    if (next) next.click()
  })
  await page.waitForFunction(
    (st) =>
      [...document.querySelectorAll('p')].some((p) => (p.innerText || '').includes(st)),
    { timeout: 10000, args: [sourceTitle] },
  )
  await delay(300)
}

/** 扣除白名单（全库剧集名 = 数据）后的 CJK 残留。 */
function cjkResidue(text, whitelist) {
  let rest = String(text || '')
  for (const n of whitelist) rest = rest.split(n).join(' ')
  return rest.match(new RegExp(CJK.source, 'g')) || []
}

/**
 * 以「弹窗实际渲染的候选项全文」做白名单（数据 = 屏幕上的剧名 = 非文案）。
 * 用全文（含 ` (N eps)`）而非裸剧名：裸剧名之间会子串相互抵消
 * （如 `#投稿` 被另一条裸剧名 split 拆散后无法再被移除，残留误报）。
 * 按长度降序，确保较长条目先被移除，杜绝子串碰撞。
 */
function dataWhitelist(dlg, extra) {
  const opts = (dlg && dlg.options) || []
  return [...new Set([...(extra || []), ...opts])].sort((a, b) => b.length - a.length)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug252] app=${ep.app} tg=${ep.tg} out=${OUT}`)

  // ── 夹具：目标 + 源两条剧集（各 1 集），ASCII 标题 ──
  const ts = Date.now()
  const TGT = `ZZ-BUG252-TGT-${ts}`
  const SRC = `ZZ-BUG252-SRC-${ts}`
  const tgtItem = await createItem(TGT, ep.tg)
  const srcItem = await createItem(SRC, ep.tg)
  const tgtSeries = await createSeries(TGT, ep.tg)
  const srcSeries = await createSeries(SRC, ep.tg)
  if (!tgtItem.id || !srcItem.id || !tgtSeries.id || !srcSeries.id) {
    console.error(`[bug252] 夹具创建失败: ${JSON.stringify({ tgtItem, srcItem, tgtSeries, srcSeries })}`)
    process.exit(2)
  }
  const e1 = await addEpisode(tgtSeries.id, tgtItem.id, ep.tg)
  const e2 = await addEpisode(srcSeries.id, srcItem.id, ep.tg)
  if (e1 !== 200 || e2 !== 200) {
    console.error(`[bug252] 夹具分集添加失败: tgt=${e1} src=${e2}`)
    process.exit(2)
  }
  const created = { series: [tgtSeries.id, srcSeries.id], items: [tgtItem.id, srcItem.id] }
  console.log(`[bug252] fixtures: TGT=${TGT}(${tgtSeries.id}) SRC=${SRC}(${srcSeries.id})`)

  // 证伪前的字节基线（还原校验用）
  const beforeBytes = fs.readFileSync(EN_US)
  const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()

    // ⓐ 强制 en-US ──
    await forceLanguage(page, ep.app, 'en-US')
    const lang = await page.evaluate(() => document.documentElement.lang)
    check('⓪ en-US 已生效（<html lang>）', String(lang).toLowerCase().startsWith('en'), `lang=${lang}`)

    // ① en-US 弹窗（第一步：选源）──
    await openMergeDialog(page, tgtSeries.id, SRC)
    let dlg = await readMergeDialog(page, SRC)
    if (!dlg) {
      check('① 弹窗已打开（候选下拉含源剧集）', false, 'dialog-not-found')
      process.exit(2)
    }
    await page.screenshot(path.join(OUT, '01_merge_dialog_en.png'))
    check('①a 弹窗可见文本 CJK 汉字数 = 0（扣除剧集名数据后）',
      cjkResidue(dlg.text, dataWhitelist(dlg, [TGT, SRC])).length === 0,
      `residue=${JSON.stringify(cjkResidue(dlg.text, dataWhitelist(dlg, [TGT, SRC])).slice(0, 8))}`)
    check('①b 标题 = "Merge series"（media.seriesMergeOpen）',
      dlg.title === 'Merge series', JSON.stringify(dlg.title))
    const expDescEn = `Merge another series into“${TGT}” (1 eps); the source series is then deleted.`
    check('①c 说明段 = 预期英文（前缀 + 弯引号剧名 + 集数后缀）',
      dlg.paragraphs[0] === expDescEn,
      `got=${JSON.stringify(dlg.paragraphs[0])} exp=${JSON.stringify(expDescEn)}`)
    check('①d 候选项 = "' + SRC + ' (1 eps)"（media.seriesMergeOption）',
      dlg.options.includes(`${SRC} (1 eps)`), JSON.stringify(dlg.options.slice(0, 3)))
    check('①e 合并说明段含 "merging makes no judgement about content"',
      dlg.paragraphs.some((p) => p.includes('merging makes no judgement about content')),
      JSON.stringify(dlg.paragraphs.slice(1, 3)))
    check('①f 集号规则段含 "Episode numbering" 与 "the current highest episode number"',
      dlg.paragraphs.some((p) => p.includes('Episode numbering') && p.includes('the current highest episode number')),
      JSON.stringify(dlg.paragraphs.slice(1, 3)))
    check('①g 第一步按钮 = ["Cancel", "Next"]',
      dlg.buttons.length === 2 && dlg.buttons[0] === 'Cancel' && dlg.buttons[1] === 'Next',
      JSON.stringify(dlg.buttons))

    // ① 确认态（第二步）──
    await gotoConfirmStep(page, SRC)
    dlg = await readMergeDialog(page, SRC)
    await page.screenshot(path.join(OUT, '02_merge_dialog_confirm_en.png'))
    const expConfirmEn =
      `The 1 episodes of “${SRC}” will be merged into “${TGT}”. ` +
      'The source series will be deleted, and this cannot be undone.'
    check('①h 确认提示 = 预期英文（media.seriesMergeConfirmBodySingle）',
      dlg.paragraphs.some((p) => p === expConfirmEn),
      `got=${JSON.stringify(dlg.paragraphs.find((p) => p.includes('episodes of')))} exp=${JSON.stringify(expConfirmEn)}`)
    check('①i 确认态 CJK 残留 = 0（扣除剧集名数据后）',
      cjkResidue(dlg.text, dataWhitelist(dlg, [TGT, SRC])).length === 0,
      `residue=${JSON.stringify(cjkResidue(dlg.text, dataWhitelist(dlg, [TGT, SRC])).slice(0, 8))}`)
    // BUG-252 范围仅 i18n：确认态按钮沿用原交互（Cancel + Confirm merge），无 Back 按钮。
    check('①j 确认态按钮 = ["Cancel", "Confirm merge"]',
      dlg.buttons.length === 2 && dlg.buttons[0] === 'Cancel' && dlg.buttons[1] === 'Confirm merge',
      JSON.stringify(dlg.buttons))

    // ② 中文模式回归 ──
    await forceLanguage(page, ep.app, 'zh-CN')
    const zhLang = await page.evaluate(() => document.documentElement.lang)
    await openMergeDialog(page, tgtSeries.id, SRC)
    let zh = await readMergeDialog(page, SRC)
    await page.screenshot(path.join(OUT, '03_merge_dialog_zh.png'))
    check('②a zh-CN 已生效且标题 = "合并剧集"',
      zhLang === 'zh-CN' && zh.title === '合并剧集', `lang=${zhLang} title=${JSON.stringify(zh.title)}`)
    check('②b zh-CN 说明段 = 预期中文（前缀 + 书名号剧名 + 集数后缀）',
      zh.paragraphs[0] === `把另一个剧集的内容并入《${TGT}》（1 集），源剧集随后被删除。`,
      JSON.stringify(zh.paragraphs[0]))
    check('②c zh-CN 弹窗正常渲染中文（残留 > 0，证明键存在而非回退 key 名）',
      cjkResidue(zh.text, dataWhitelist(zh, [TGT, SRC])).length > 0,
      `residue=${cjkResidue(zh.text, dataWhitelist(zh, [TGT, SRC])).length}`)
    await gotoConfirmStep(page, SRC)
    zh = await readMergeDialog(page, SRC)
    const expConfirmZh = `将把《${SRC}》的 1 个分集并入《${TGT}》，源剧集会被删除，此操作无法撤销。`
    check('②d zh-CN 确认提示 = 预期中文',
      zh.paragraphs.some((p) => p === expConfirmZh),
      `got=${JSON.stringify(zh.paragraphs.find((p) => p.includes('分集并入')))}`)

    // ③ 反向证伪：键值临时改回硬编码中文 ⇒ 判据①必须红 ──
    console.log(`[bug252] --- 证伪：${TAMPER_KEY} 的 en-US 值临时改回中文 ---`)
    const beforeText = beforeBytes.toString('utf8')
    if (!beforeText.includes(TAMPER_LINE_EN)) {
      check('③P 证伪锚点存在（en-US.json 含目标行）', false, `anchor-not-found: ${TAMPER_LINE_EN}`)
    } else {
      check('③P 证伪锚点存在（en-US.json 含目标行）', true, TAMPER_KEY)
      let restored = false
      try {
        fs.writeFileSync(EN_US, beforeText.replace(TAMPER_LINE_EN, TAMPER_LINE_ZH))
        await delay(800) // 等 vite watch 失效模块缓存
        await forceLanguage(page, ep.app, 'en-US')
        await openMergeDialog(page, tgtSeries.id, SRC)
        const red = await readMergeDialog(page, SRC)
        await page.screenshot(path.join(OUT, '04_red_state_title_zh_in_en.png'))
        const redResidue = cjkResidue(red.text, dataWhitelist(red, [TGT, SRC]))
        check('③a 红态读数：CJK 残留 > 0（改回中文后判据①a 按预期失败）',
          redResidue.length > 0, `residue=${JSON.stringify(redResidue.slice(0, 8))}`)
        check('③b 红态读数：标题 ≠ "Merge series"（判据①b 按预期失败）',
          red.title !== 'Merge series', `title=${JSON.stringify(red.title)}`)
      } finally {
        // 字节级还原（禁 git checkout——会冲掉并行 agent 的未提交改动）
        fs.writeFileSync(EN_US, beforeBytes)
        restored = true
      }
      const afterBytes = fs.readFileSync(EN_US)
      const shaAfter = crypto.createHash('sha256').update(afterBytes).digest('hex')
      check('③c 字节级还原：sha256 与改前一致',
        restored && shaAfter === shaBefore, `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`)
      await delay(800)
      await forceLanguage(page, ep.app, 'en-US')
      await openMergeDialog(page, tgtSeries.id, SRC)
      const green2 = await readMergeDialog(page, SRC)
      await page.screenshot(path.join(OUT, '05_restore_green.png'))
      check('③d 还原后复跑：标题 = "Merge series" 且 CJK 残留 = 0',
        green2.title === 'Merge series' && cjkResidue(green2.text, dataWhitelist(green2, [TGT, SRC])).length === 0,
        `title=${JSON.stringify(green2.title)} residue=${cjkResidue(green2.text, dataWhitelist(green2, [TGT, SRC])).length}`)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug252] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)
  } finally {
    if (browser) await browser.close()
    for (const id of created.series) {
      await httpJson('DELETE', `${ep.tg}/api/media/series/${id}`).catch(() => undefined)
    }
    for (const id of created.items) {
      await httpJson('DELETE', `${ep.tg}/api/media/items/${id}`).catch(() => undefined)
    }
    // 收尾自证：夹具确实删净（否则后面跑的人会被残留样本干扰）
    const left = await httpJson('GET', `${ep.tg}/api/media/series`)
    const still = ((left.json && left.json.items) || []).filter((s) => created.series.includes(s.id))
    console.log(`[bug252] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`)
    check('④ 夹具已清理（无残留剧集）', still.length === 0, `leftover=${JSON.stringify(still.map((s) => s.id))}`)
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ passed, total: checks.length, all_passed: passed === checks.length, checks }, null, 2),
  )
  console.log(`\nRESULT ${passed}/${checks.length}  shots=${OUT}`)
  process.exit(passed === checks.length ? 0 : 2)
}

main().catch((e) => {
  console.error('FATAL', (e && e.stack) || e)
  process.exit(2)
})
