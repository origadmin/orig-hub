#!/usr/bin/env node
'use strict'

/**
 * BUG-263 验收（活栈 · CDP）：内容编辑弹窗（ItemEditDialog）整窗文案 i18n。
 *
 * ## 判据（与 docs/bugs/BUG-263.md「验收证据」一一对应）
 *
 *   ⓪ 持久化 `orig-hub:settings.language = "en-US"` + 整页重载后 `<html lang>` 生效；
 *   ① en-US 下打开内容编辑弹窗（媒体库卡片 `item-edit` 入口）：
 *     ①a 弹窗可见文本中 CJK 汉字数为 0（正则 [\u4e00-\u9fff]；
 *         夹具剧名/条目标题是**数据**，白名单扣除后再数）；
 *     ①b 关键串**等于预期英文译文**（不是「非空」——防键缺失回退成 key 名/中文）：
 *         标题 / 类型 / 来源 / 大小 / 路径 / 归属 / 标题 / 介绍 / 介绍提示 /
 *         placeholder / 清除缓存三态 / 底部按钮；
 *   ② 中文模式下同一弹窗正常渲染中文（zh-CN 键存在、双语都不破）；
 *   ③ 反向证伪：把 `media.item.editMeta` 的 en-US 值临时改回硬编码中文
 *     ⇒ ①a/①b 必须 FAIL（红态读数照实记录）⇒ **字节级还原**（禁 git checkout），
 *     sha256 一致后复跑必须 PASS。
 *
 * ## 环境
 *
 *   活栈：vite :5180 / orig-daemon :19786 / orig-tg（端口经 `_lib_endpoints.cjs`
 *   从 daemon `/api/config` 的 `tg_port` 运行时解析，不写死）。dev stack 不许动。
 *   夹具自造自删（1 条真实字节视频 + 1 条剧集挂载，ASCII 标题），绝不碰用户数据。
 *
 * 用法：`node verify/verify_bug_263_item_edit_i18n.cjs`
 * Env : ORIG_VERIFY_OUT（截图/result.json 输出目录，默认 verify/evidence/BUG-263）
 * Exit: 0 = 全部通过；2 = 有判据失败（含证伪红态未按预期失败 / 还原后不复绿）。
 */

const path = require('path')
const fs = require('fs')
const os = require('node:os')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-263')
const EN_US = path.resolve(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json')
const CJK = /[\u4e00-\u9fff]/

/** 证伪目标：en-US 里被临时改回中文的键（弹窗标题，必然渲染）。 */
const TAMPER_KEY = 'media.item.editMeta'
const TAMPER_LINE_EN = '  "media.item.editMeta": "Edit content",'
const TAMPER_LINE_ZH = '  "media.item.editMeta": "编辑内容",'

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

/**
 * 造一条**有真实字节**的本地视频条目：`hasMediaBytes` 对本地条目回退
 * `Boolean(filePath)`，但后端可能下发 `bytesPresence` —— 用假路径会落到
 * 「无已缓存文件」分支，验不到「清除缓存文件」三态，故落一个真文件。
 */
async function createRealItem(title, tg) {
  const filePath = path.join(os.tmpdir(), `orighub-bug263-${Date.now()}-${title.replace(/[^\w.-]/g, '_')}.mp4`)
  fs.writeFileSync(filePath, Buffer.alloc(2048, 7))
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: filePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, filePath, status: r.status }
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

/** 媒体库 → 「全部内容」→ 点夹具卡片编辑入口 → 等内容编辑弹窗。 */
async function openItemEditDialog(page, itemId) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-media"]')
    if (el) el.click()
  })
  await delay(1200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-cat-all"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    (iid) => !!document.querySelector(`[data-testid="media-card"][data-item-id="${iid}"]`),
    { timeout: 25000, args: [itemId] },
  )
  await page.evaluate((iid) => {
    const card = document.querySelector(`[data-testid="media-card"][data-item-id="${iid}"]`)
    const edit = card && card.querySelector('[data-testid="item-edit"]')
    if (edit) edit.click()
  }, itemId)
  await page.waitForFunction(() => !!document.querySelector('[data-testid="item-edit-dialog"]'), {
    timeout: 15000,
  })
  await delay(400)
}

/** 读弹窗全文快照（testid 定位 + 规范化空白）。 */
async function readItemEditDialog(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="item-edit-dialog"]')
    if (!root) return null
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    // 元信息四行：来源 / 大小 / 路径 / 归属（同一父容器的直接 p 子节点，按序）
    const srcP = root.querySelector('[data-testid="item-edit-source"]')
    const metaRows = srcP && srcP.parentElement
      ? [...srcP.parentElement.children].filter((el) => el.tagName === 'P').map((el) => norm(el.innerText))
      : []
    // 「类型」行：label 内第一个 span（只取标签本身，不含 select 里的选项文本）
    const kindLabelEl = [...root.querySelectorAll('label')].find((l) =>
      l.querySelector('[data-testid="item-edit-kind"]'),
    )
    const kindSpan = kindLabelEl ? kindLabelEl.querySelector('span') : null
    const kindSelect = root.querySelector('[data-testid="item-edit-kind"]')
    const kindOption = kindSelect ? norm(kindSelect.options[kindSelect.selectedIndex].innerText) : null
    const descInput = root.querySelector('[data-testid="item-edit-desc"]')
    // 标签是**数据**（库里所有标签都会以 option 形式平铺在 TagPicker 里），
    // 不能当作文案计入 i18n 验收。字符串白名单（split 整串）在标签间大量子串
    // 重叠（短剧 / 妈妈 …）且 `#` 前缀与 root.innerText 不一致时会整体失效，
    // 故改为在 DOM 里把整棵 TagPicker 子树（option / picked / 搜索框 / 新建按钮）
    // 剔除后再数 CJK —— 与字符串顺序无关，零碰撞。
    const tagExclude = (el) =>
      el.matches('[data-testid^="tag-option-"], [data-testid^="tag-picked-"], [data-testid="tag-picker-input"], [data-testid="tag-picker-create"]')
    let textNoTags = ''
    const walkNoTags = (node) => {
      if (node.nodeType === 3) textNoTags += node.textContent
      else if (node.nodeType === 1) {
        if (tagExclude(node)) return
        for (const c of node.childNodes) walkNoTags(c)
      }
    }
    walkNoTags(root)
    return {
      title: norm(root.querySelector('h4') ? root.querySelector('h4').innerText : ''),
      text: root.innerText,
      textNoTags,
      metaRows,
      kindLabel: kindSpan ? norm(kindSpan.innerText) : null,
      kindOption,
      labels: [...root.querySelectorAll('label')].map((l) => norm(l.innerText)),
      descPlaceholder: descInput ? descInput.placeholder : null,
      buttons: [...root.querySelectorAll('button')].map((b) => norm(b.innerText)),
      tagNames: [...root.querySelectorAll('[data-testid^="tag-option-"], [data-testid^="tag-picked-"]')]
        .map((el) => norm(el.innerText))
        .filter(Boolean),
      cacheConfirm: (() => {
        const el = root.querySelector('[data-testid="item-clear-cache-confirm"]')
        return el ? norm(el.innerText) : null
      })(),
      cacheNone: (() => {
        const el = root.querySelector('[data-testid="item-clear-cache-na"]')
        return el ? norm(el.innerText) : null
      })(),
    }
  })
}

/** 进入「清除缓存」确认态（点入口按钮，**绝不点确定**）。 */
async function openCacheConfirm(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="item-clear-cache"]')
    if (btn) btn.click()
  })
  await page.waitForFunction(() => !!document.querySelector('[data-testid="item-clear-cache-confirm"]'), {
    timeout: 10000,
  })
  await delay(300)
}

/** 退出确认态（点「不清了 / Keep it」）。 */
async function closeCacheConfirm(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="item-clear-cache-no"]')
    if (btn) btn.click()
  })
  await delay(300)
}

/** 扣除白名单（夹具标题 = 数据）后的 CJK 残留。 */
function cjkResidue(text, whitelist) {
  let rest = String(text || '')
  for (const n of whitelist) rest = rest.split(n).join(' ')
  return rest.match(new RegExp(CJK.source, 'g')) || []
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug263] app=${ep.app} tg=${ep.tg} out=${OUT}`)

  // ── 夹具：1 条真实字节视频 + 1 条剧集（挂载后弹窗才有「归属」行）──
  const ts = Date.now()
  const ITEM = `ZZ-BUG263-ITEM-${ts}`
  const SER = `ZZ-BUG263-SER-${ts}`
  const item = await createRealItem(ITEM, ep.tg)
  const ser = await createSeries(SER, ep.tg)
  if (!item.id || !ser.id) {
    console.error(`[bug263] 夹具创建失败: ${JSON.stringify({ item, ser })}`)
    process.exit(2)
  }
  const ep2 = await addEpisode(ser.id, item.id, ep.tg)
  if (ep2 !== 200) {
    console.error(`[bug263] 夹具分集添加失败: status=${ep2}`)
    process.exit(2)
  }
  const created = { series: [ser.id], items: [item.id] }
  const base = [ITEM, SER]
  console.log(`[bug263] fixtures: ITEM=${ITEM}(${item.id}) SER=${SER}(${ser.id}) file=${item.filePath}`)

  // 证伪前的字节基线（还原校验用）
  const beforeBytes = fs.readFileSync(EN_US)
  const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()

    // ⓪ 强制 en-US ──
    await forceLanguage(page, ep.app, 'en-US')
    const lang = await page.evaluate(() => document.documentElement.lang)
    check('⓪ en-US 已生效（<html lang>）', String(lang).toLowerCase().startsWith('en'), `lang=${lang}`)

    // ① en-US 弹窗 ──
    await openItemEditDialog(page, item.id)
    let dlg = await readItemEditDialog(page)
    if (!dlg) {
      check('① 弹窗已打开（item-edit-dialog）', false, 'dialog-not-found')
      process.exit(2)
    }
    await page.screenshot(path.join(OUT, '01_item_edit_en.png'))
    check('①a 弹窗可见文本 CJK 汉字数 = 0（扣除夹具标题 + 标签数据后）',
      cjkResidue(dlg.textNoTags, base).length === 0,
      `residue=${JSON.stringify(cjkResidue(dlg.textNoTags, base).slice(0, 8))}`)
    check('①b 标题 = "Edit content"（media.item.editMeta）',
      dlg.title === 'Edit content', JSON.stringify(dlg.title))
    check('①c 类型行标签 = "Type"，选项 = "Video"（media.item.kind + kindLabelKey）',
      dlg.kindLabel === 'Type' && dlg.kindOption === 'Video',
      `label=${JSON.stringify(dlg.kindLabel)} option=${JSON.stringify(dlg.kindOption)}`)
    check('①d 来源行 = "Source: Local"（复用 media.fromSource + sourceLabelKey）',
      dlg.metaRows[0] === 'Source: Local', JSON.stringify(dlg.metaRows[0]))
    check('①e 大小行以 "Size: " 开头（media.item.size）',
      dlg.metaRows[1] != null && dlg.metaRows[1].startsWith('Size: '), JSON.stringify(dlg.metaRows[1]))
    check('①f 路径行以 "Path: " 开头（media.item.path）',
      dlg.metaRows[2] != null && dlg.metaRows[2].startsWith('Path: '), JSON.stringify(dlg.metaRows[2]))
    check('①g 归属行 = "Series: ' + SER + '"（media.item.series）',
      dlg.metaRows[3] === `Series: ${SER}`, JSON.stringify(dlg.metaRows[3]))
    check('①h 字段标签含 "Title" / "Tags"（media.item.title / media.tags）',
      dlg.labels.includes('Title') && dlg.labels.includes('Tags'), JSON.stringify(dlg.labels))
    check('①i 介绍标签以 "Description" 开头且提示含 "the same field as the series description"',
      dlg.labels.some((l) => l.startsWith('Description') && l.includes('the same field as the series description')),
      JSON.stringify(dlg.labels))
    check('①j 介绍 placeholder = "Leave empty to clear the description"',
      dlg.descPlaceholder === 'Leave empty to clear the description', JSON.stringify(dlg.descPlaceholder))
    const actionButtons = dlg.buttons.filter((b) => !(dlg.tagNames || []).some((t) => b.includes(t)))
    check('①k 底部按钮 = ["Clear cached file", "Cancel", "Save"]（标签属数据，排除）',
      actionButtons.length === 3 && actionButtons[0] === 'Clear cached file' && actionButtons[1] === 'Cancel' && actionButtons[2] === 'Save',
      JSON.stringify(actionButtons))

    // ① 清缓存确认态（点入口 → 验三态 → 点「不清了」退出，绝不真清）──
    await openCacheConfirm(page)
    dlg = await readItemEditDialog(page)
    await page.screenshot(path.join(OUT, '02_cache_confirm_en.png'))
    check('①l 清缓存确认文案 = "Clear the cached file? The record is kept and can be cached again."',
      dlg.cacheConfirm === 'Clear the cached file? The record is kept and can be cached again.',
      JSON.stringify(dlg.cacheConfirm))
    const actionButtons2 = dlg.buttons.filter((b) => !(dlg.tagNames || []).some((t) => b.includes(t)))
    check('①m 确认态按钮 = ["Confirm", "Keep it", "Cancel", "Save"]（标签属数据，排除）',
      actionButtons2.length === 4 && actionButtons2[0] === 'Confirm' && actionButtons2[1] === 'Keep it' && actionButtons2[2] === 'Cancel' && actionButtons2[3] === 'Save',
      JSON.stringify(actionButtons2))
    await closeCacheConfirm(page)

    // ② 中文模式回归 ──
    await forceLanguage(page, ep.app, 'zh-CN')
    const zhLang = await page.evaluate(() => document.documentElement.lang)
    await openItemEditDialog(page, item.id)
    let zh = await readItemEditDialog(page)
    await page.screenshot(path.join(OUT, '03_item_edit_zh.png'))
    check('②a zh-CN 已生效且标题 = "编辑内容"',
      zhLang === 'zh-CN' && zh.title === '编辑内容', `lang=${zhLang} title=${JSON.stringify(zh.title)}`)
    check('②b zh-CN 元信息四行 = 来源：本地 / 大小：… / 路径：… / 归属：' + SER,
      zh.metaRows[0] === '来源：本地' &&
        zh.metaRows[1] != null && zh.metaRows[1].startsWith('大小：') &&
        zh.metaRows[2] != null && zh.metaRows[2].startsWith('路径：') &&
        zh.metaRows[3] === `归属：${SER}`,
      JSON.stringify(zh.metaRows))
    check('②c zh-CN 弹窗正常渲染中文（残留 > 0，证明键存在而非回退 key 名）',
      cjkResidue(zh.textNoTags, base).length > 0,
      `residue=${cjkResidue(zh.textNoTags, base).length}`)
    await openCacheConfirm(page)
    zh = await readItemEditDialog(page)
    check('②d zh-CN 清缓存确认文案 = "确定清除已缓存文件？记录保留，可重新缓存"',
      zh.cacheConfirm === '确定清除已缓存文件？记录保留，可重新缓存', JSON.stringify(zh.cacheConfirm))
    await closeCacheConfirm(page)

    // ③ 反向证伪：键值临时改回硬编码中文 ⇒ 判据①必须红 ──
    console.log(`[bug263] --- 证伪：${TAMPER_KEY} 的 en-US 值临时改回中文 ---`)
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
        await openItemEditDialog(page, item.id)
        const red = await readItemEditDialog(page)
        await page.screenshot(path.join(OUT, '04_red_state_title_zh_in_en.png'))
        const redResidue = cjkResidue(red.textNoTags, base)
        check('③a 红态读数：CJK 残留 > 0（改回中文后判据①a 按预期失败）',
          redResidue.length > 0, `residue=${JSON.stringify(redResidue.slice(0, 8))}`)
        check('③b 红态读数：标题 ≠ "Edit content"（判据①b 按预期失败）',
          red.title !== 'Edit content', `title=${JSON.stringify(red.title)}`)
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
      await openItemEditDialog(page, item.id)
      const green2 = await readItemEditDialog(page)
      await page.screenshot(path.join(OUT, '05_restore_green.png'))
      check('③d 还原后复跑：标题 = "Edit content" 且 CJK 残留 = 0',
        green2.title === 'Edit content' && cjkResidue(green2.textNoTags, base).length === 0,
        `title=${JSON.stringify(green2.title)} residue=${cjkResidue(green2.textNoTags, base).length}`)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug263] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)
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
    console.log(`[bug263] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`)
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
