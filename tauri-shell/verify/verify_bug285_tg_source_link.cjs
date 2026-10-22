#!/usr/bin/env node
'use strict'

/**
 * BUG-285 验收（活栈 · CDP）：媒体库剧集内页「来源」块新增「跳回 TG 源消息」入口。
 *
 * ## 判据（对应 docs/bugs/BUG-285.md「验收证据」）
 *
 *   ⓪ 夹具自造自删：1 部剧集 + 2 集（E1 = TG 来源带 `<chat>:<msg>` ref；
 *      E2 = 本地来源，无 TG 坐标）。绝不碰用户数据。导入即被 BUG-304
 *      自动归档，故挂载前先撤销自动归档（`media_episode` 有 UNIQUE(item_id)，
 *      详见 `detachCurrentEpisode` 注释）。
 *   ① **TG 来源行有入口**：聚焦 TG 集时，`episode-source-info` 块内存在一个
 *      `<a data-testid="episode-source-view-tg">`，且
 *      ①a 它是**可点链接**（tagName === 'A' 且 href 非空）；
 *      ①b href === `https://t.me/c/<chat>/<msg>`（与夹具 ref 逐字一致）；
 *      ①c 入口与被解释的来源**同一行**（是主版本行的后代节点，非独立区块/弹窗）；
 *      ①d 可见文案 === "Open in browser"（i18n 键 media.episode.openInBrowser，非回退
 *          key 名）。BUG-364 起由原键 media.episode.viewInTg（"View in TG"）改键改名：
 *          来源块内应用内跳转与外链文案曾完全相同，用户分不出哪个会离开应用；
 *          testid 与 href 形状（①a/①b）不变，仅文案值由 BUG-364 supersede。
 *   ② **本地来源行无入口**：聚焦本地集时，同一块内 `[data-testid="episode-source-view-tg"]`
 *      数量为 0（无 TG 消息可跳 ⇒ 不给入口）。
 *   ③ **en-US 无硬编码中文**：整块可见文本 CJK 汉字数 = 0（夹具标题全 ASCII）。
 *   ④ 反向证伪：临时摘掉入口（`curTgUrl = null`）⇒ 判据①必须 FAIL（红态读数）⇒
 *      **字节级还原**（禁 git checkout）sha256 一致 ⇒ 复跑必须复绿。
 *   ⑤ 夹具已清理（无残留剧集 / 条目）。
 *
 * ## 环境
 *
 *   活栈：vite :5180 / orig-daemon :19786 / orig-tg（端口经 `_lib_endpoints.cjs`
 *   从 daemon `/api/config` 的 `tg_port` 运行时解析，不写死）。dev stack 不许动。
 *
 * 用法：`node tauri-shell/verify/verify_bug285_tg_source_link.cjs`（仓库根）
 * Env : ORIG_VERIFY_OUT（截图/result.json 输出目录，默认 verify/evidence/BUG-285）
 * Exit: 0 = 全部通过；2 = 有判据失败（含证伪红态未按预期失败 / 还原后不复绿）。
 */

const path = require('path')
const fs = require('fs')
const os = require('node:os')
const crypto = require('node:crypto')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, 'evidence', 'BUG-285')
const SERIES_DETAIL_TSX = path.resolve(__dirname, '..', 'src', 'components', 'media', 'SeriesDetail.tsx')
const CJK = /[一-鿿]/ // CJK 汉字区间 U+4E00..U+9FFF（等同 /[\u4e00-\u9fff]/）

/** 证伪锚点：把主版本行的入口开关置死（等价于「摘掉入口」），还原只需换回原行。 */
const TAMPER_FROM = '  const curTgUrl = cur ? sourceMessageUrl(cur.source, cur.ref) : null'
const TAMPER_TO = '  const curTgUrl = null'

/** 夹具 TG 坐标（占位符，非真实频道/消息 —— 遵循 BUG-232「内容数据不入库」） */
const TG_CHAT = '100000001'
const TG_MSG = '4242'
const TG_REF = `${TG_CHAT}:${TG_MSG}`
const TG_URL = `https://t.me/c/${TG_CHAT}/${TG_MSG}`
// BUG-364：外链文案由 "View in TG"（media.episode.viewInTg）改为 "Open in browser"
// （media.episode.openInBrowser）—— 与相邻的应用内跳转「View in TG」区分开。
const EXPECT_LABEL_EN = 'Open in browser'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

// ─────────────────────────── HTTP（仅回环，造夹具 / 读真值） ───────────────────────────

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
 * 造一条 TG 来源条目：`source='tg'` + `ref='<chat>:<msg>'`。
 * 字段名是**裸 `ref`**（后端 `ImportItem` 把 `tg_ref` 序列化重命名为 `ref`），
 * 写成 `tg_ref` 会被当成「没有坐标」而静默整条跳过（`count:0`）——夹具造不出来，
 * 判据却照样跑，属于最危险的静默失败，故这里显式按 `ref` 下发。
 */
async function createTgItem(title, tg) {
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ source: 'tg', ref: TG_REF, kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, status: r.status, raw: r.text.slice(0, 200) }
}

/** 造一条本地来源条目（有真实字节的临时文件；ref = 本地路径，无 TG 坐标）。 */
async function createLocalItem(title, tg) {
  const filePath = path.join(os.tmpdir(), `orighub-bug285-${Date.now()}-local.mp4`)
  fs.writeFileSync(filePath, Buffer.alloc(2048, 7))
  const r = await httpJson('POST', `${tg}/api/media/items`, {
    items: [{ path: filePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, filePath, status: r.status, raw: r.text.slice(0, 200) }
}

async function createSeries(title, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status, raw: r.text.slice(0, 200) }
}

async function addEpisode(seriesId, itemId, episodeNo, tg) {
  const r = await httpJson('POST', `${tg}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo,
  })
  return { status: r.status, raw: r.text.slice(0, 200) }
}

/**
 * 撤掉条目被 BUG-304 自动归档的归属（若有），解放 `UNIQUE(item_id)` 槽位。
 *
 * 为什么必须有这一步：BUG-304「导入即成剧」—— `POST /api/media/items` 内部会
 * `file_items_into_series` 把每条 video 条目自动归档进单集剧集（写
 * `media_episode` 行）；而 `media_episode` 有 `UNIQUE(item_id)`
 * （活库索引 `idx_media_episode_item_unique`，BUG-292/297 上线）。夹具再往
 * 自己的剧集挂载 ⇒ INSERT 撞唯一约束 ⇒ 500
 * `UNIQUE constraint failed: media_episode.item_id`。这是**产品既定行为**
 * （导入即归档是对的口号），不是缺陷——探针必须适配：挂载前先撤销自动归档。
 *
 * 撤销手法：自动剧集只挂 our 条目（导入键 `item:{id}` / `tg:msgs:...` 均
 * 夹具独有）⇒ 直接删整剧（`DELETE /api/media/series/:id` =
 * `delete_series_explicit`：删剧且清墓碑）。**不摘单集**——
 * `remove_episode` 会写带 `source_key` 的墓碑（BUG-126「删了又回来」保护，
 * 设计上必须活过剪枝），探针每跑一轮就攒 2 条 inert 行；删剧路径零残留。
 * 兜底：剧集里若还有别的内容（不该发生）⇒ 只摘自己那一集。
 *
 * 条目未被自动归档时（`seriesId` 为空）返回 `{ detached: false }`——
 * 调用方照常挂载，让挂载结果自己说话。
 */
async function detachCurrentEpisode(itemId, tg) {
  const item = await httpJson('GET', `${tg}/api/media/items/${itemId}`)
  // MediaItem 是 `rename_all = "camelCase"` —— 归属字段叫 `seriesId`，
  // 写成 `series_id` 会永远读到 undefined（静默误判「未归档」）。
  const sid = item.json && typeof item.json.seriesId === 'number' ? item.json.seriesId : null
  if (!sid) return { detached: false, reason: 'not-filed', itemStatus: item.status }
  const detail = await httpJson('GET', `${tg}/api/media/series/${sid}`)
  const eps = (detail.json && detail.json.episodes) || []
  // EpisodeView 同是 camelCase：条目字段叫 `itemId`（不是 `item_id`）。
  const mine = eps.filter((e) => e && (e.itemId === itemId || e.item_id === itemId))
  if (mine.length !== 1) {
    return { detached: false, reason: 'episode-row-missing', seriesId: sid, episodeCount: eps.length }
  }
  if (eps.length === 1) {
    const del = await httpJson('DELETE', `${tg}/api/media/series/${sid}`)
    return {
      detached: del.status === 200,
      reason: del.status === 200 ? 'auto-series-deleted' : `series-delete-${del.status}`,
      seriesId: sid,
      deleteStatus: del.status,
      deleteRaw: del.text.slice(0, 200),
    }
  }
  const del = await httpJson('DELETE', `${tg}/api/media/episodes/${mine[0].id}`)
  return {
    detached: del.status === 200,
    reason: del.status === 200 ? 'detached' : `delete-${del.status}`,
    seriesId: sid,
    episodeId: mine[0].id,
    deleteStatus: del.status,
    deleteRaw: del.text.slice(0, 200),
  }
}

// ─────────────────────────── 页面操作 ───────────────────────────

/** 强制界面语言：写持久化设置 → 整页重载（与 BUG-263/BUG-259 同机制）。 */
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
 * 打开夹具剧集内页：媒体库 → 剧集墙 → 点卡片（卡片缺失时回退侧栏同名按钮）。
 * 剧集 id 已知，故用 `series-card[data-series-id]` 直击，不依赖标题文案。
 */
async function openSeriesDetail(page, seriesId, title) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (el) el.click()
  })
  await delay(1200)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="media-rail-series-all"]')
    if (el) el.click()
  })
  await delay(1200)

  let opened = false
  try {
    await page.waitForFunction(
      (sid) => !!document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`),
      { timeout: 20000, args: [seriesId] },
    )
    await page.evaluate((sid) => {
      const el = document.querySelector(`[data-testid="series-card"][data-series-id="${sid}"]`)
      if (el) el.click()
    }, seriesId)
    opened = true
  } catch (_e) {
    // 回退：侧栏剧集按钮（`title` = 剧集标题）
    const ok = await page.evaluate((t) => {
      const btn = [...document.querySelectorAll('button[title]')].find(
        (b) => String(b.getAttribute('title')) === t,
      )
      if (btn) {
        btn.click()
        return true
      }
      return false
    }, title)
    opened = !!ok
  }
  if (!opened) return false
  await page.waitForFunction(() => !!document.querySelector('[data-testid="episode-source-info"]'), {
    timeout: 25000,
  })
  await delay(500)
  return true
}

/** 聚焦指定分集（左栏 `episode-pick` 带 `data-episode-id`）。 */
async function focusEpisode(page, episodeId) {
  await page.evaluate((eid) => {
    const el = document.querySelector(`[data-testid="episode-pick"][data-episode-id="${eid}"]`)
    if (el) el.click()
  }, episodeId)
  await delay(700)
}

/** 读「来源」块快照：入口元素 + 它所在的行 + 整块可见文本。 */
async function readSourceBlock(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const block = document.querySelector('[data-testid="episode-source-info"]')
    if (!block) return null
    const kids = [...block.children]
    // 结构：[0] 区块标题 span，[1] 主版本行 div，[2] 备用源 ul（无备用源时不进 DOM）
    const primaryRow = kids[1] || null
    const links = [...block.querySelectorAll('[data-testid="episode-source-view-tg"]')]
    const l = links[0] || null
    const focusTitle = document.querySelector('[data-testid="episode-focus-title"]')
    return {
      blockText: norm(block.innerText),
      primaryRowText: primaryRow ? norm(primaryRow.innerText) : null,
      linkCount: links.length,
      link: l
        ? {
            tag: l.tagName,
            href: l.getAttribute('href'),
            target: l.getAttribute('target'),
            text: norm(l.textContent),
            inPrimaryRow: !!(primaryRow && primaryRow.contains(l)),
          }
        : null,
      focusTitle: focusTitle ? norm(focusTitle.innerText) : null,
    }
  })
}

function cjkCount(text) {
  return (String(text || '').match(new RegExp(CJK.source, 'g')) || []).length
}

/** 删夹具（剧集 → 条目 → 临时文件）。提前失败的路径也要走，绝不把样本留在共享库里。 */
async function cleanup(tg, seriesIds, itemIds, filePath) {
  for (const id of seriesIds || []) {
    await httpJson('DELETE', `${tg}/api/media/series/${id}`).catch(() => undefined)
  }
  for (const id of itemIds || []) {
    await httpJson('DELETE', `${tg}/api/media/items/${id}`).catch(() => undefined)
  }
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (_e) {
    /* 临时文件已随条目删除 */
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()
  console.log(`[bug285] app=${ep.app} tg=${ep.tg} out=${OUT}`)

  // ── 夹具：1 部剧集 + 2 集（E1 = TG 带 ref / E2 = 本地无坐标）──
  const ts = Date.now()
  const TG_TITLE = `ZZ-BUG285-TG-${ts}`
  const LOCAL_TITLE = `ZZ-BUG285-LOCAL-${ts}`
  const SER_TITLE = `ZZ-BUG285-SER-${ts}`

  const tgItem = await createTgItem(TG_TITLE, ep.tg)
  const localItem = await createLocalItem(LOCAL_TITLE, ep.tg)
  const ser = await createSeries(SER_TITLE, ep.tg)
  if (!tgItem.id || !localItem.id || !ser.id) {
    console.error(`[bug285] 夹具创建失败: ${JSON.stringify({ tgItem, localItem, ser })}`)
    await cleanup(ep.tg, [ser.id].filter(Boolean), [tgItem.id, localItem.id].filter(Boolean), localItem.filePath)
    process.exit(2)
  }
  // BUG-304 适配：导入即自动归档 ⇒ 先撤销自动归档（删自动剧集），再往夹具
  // 剧集挂载（详见 detachCurrentEpisode 的契约注释；UNIQUE(item_id) 是硬约束）。
  const d1 = await detachCurrentEpisode(tgItem.id, ep.tg)
  const d2 = await detachCurrentEpisode(localItem.id, ep.tg)
  const e1 = await addEpisode(ser.id, tgItem.id, 1, ep.tg)
  const e2 = await addEpisode(ser.id, localItem.id, 2, ep.tg)
  if (e1.status !== 200 || e2.status !== 200) {
    console.error(`[bug285] 分集挂载失败: ${JSON.stringify({ e1, e2, d1, d2 })}`)
    await cleanup(ep.tg, [ser.id], [tgItem.id, localItem.id], localItem.filePath)
    process.exit(2)
  }
  if (d1.detached || d2.detached) {
    console.log(`[bug285] detached auto-filed episodes: TG=${JSON.stringify(d1)} LOCAL=${JSON.stringify(d2)}`)
  }
  const created = { series: [ser.id], items: [tgItem.id, localItem.id] }
  console.log(`[bug285] fixtures: SER=${SER_TITLE}(${ser.id}) TG=${tgItem.id}(${TG_REF}) LOCAL=${localItem.id}`)

  // 夹具真值：哪一集是 TG / 哪一集是本地（读后端，不靠猜）
  const detail = await httpJson('GET', `${ep.tg}/api/media/series/${ser.id}`)
  const eps = (detail.json && detail.json.episodes) || []
  const tgEp = eps.find((x) => x.source === 'tg' && x.ref === TG_REF)
  const localEp = eps.find((x) => x.source === 'local' || (!x.ref && x.source !== 'tg'))
  if (!tgEp || !localEp || tgEp.id === localEp.id) {
    console.error(`[bug285] 夹具分集真值不符预期: ${JSON.stringify(eps.map((x) => ({ id: x.id, source: x.source, ref: x.ref })))}`)
    process.exit(2)
  }
  check('⓪ 夹具成立：一集 TG（带 ref）＋一集本地（无坐标）',
    true,
    `tgEp=${tgEp.id}/${tgEp.source}/${tgEp.ref} localEp=${localEp.id}/${localEp.source}/${JSON.stringify(localEp.ref)}`)

  // 证伪前的字节基线（还原校验用）
  const beforeBytes = fs.readFileSync(SERIES_DETAIL_TSX)
  const shaBefore = crypto.createHash('sha256').update(beforeBytes).digest('hex')

  let browser = null
  try {
    browser = await cdp.launch()
    const page = await browser.newPage()

    // 强制 en-US ──
    await forceLanguage(page, ep.app, 'en-US')
    const lang = await page.evaluate(() => document.documentElement.lang)
    check('⓪b en-US 已生效（<html lang>）', String(lang).toLowerCase().startsWith('en'), `lang=${lang}`)

    const opened = await openSeriesDetail(page, ser.id, SER_TITLE)
    if (!opened) {
      check('⓪c 剧集内页已打开（episode-source-info 可见）', false, 'series-detail-not-open')
      process.exit(2)
    }
    check('⓪c 剧集内页已打开（episode-source-info 可见）', true, `series=${ser.id}`)

    // ① TG 来源行有入口 ──
    await focusEpisode(page, tgEp.id)
    const tg = await readSourceBlock(page)
    await page.screenshot(path.join(OUT, '01_tg_source_row_en.png'))
    if (!tg) {
      check('① 来源块可读', false, 'episode-source-info missing')
      process.exit(2)
    }
    check('①a TG 来源行有可点入口（<a> 且 href 非空）',
      !!tg.link && tg.link.tag === 'A' && !!tg.link.href,
      `link=${JSON.stringify(tg.link)}`)
    check(`①b href === ${TG_URL}（ref ${TG_REF} 还原出的 t.me 深链）`,
      !!tg.link && tg.link.href === TG_URL, `href=${JSON.stringify(tg.link && tg.link.href)}`)
    check('①c 入口与被解释的来源同一行（主版本行的后代，非独立区块/弹窗）',
      !!tg.link && tg.link.inPrimaryRow === true,
      `inPrimaryRow=${tg.link && tg.link.inPrimaryRow} primaryRowText=${JSON.stringify(tg.primaryRowText)}`)
    check('①d 文案 === "Open in browser"（media.episode.openInBrowser，非回退 key 名；BUG-364 supersede 文案值）',
      !!tg.link && tg.link.text === EXPECT_LABEL_EN, `text=${JSON.stringify(tg.link && tg.link.text)}`)
    check('①e 入口在新标签打开（target="_blank"）',
      !!tg.link && tg.link.target === '_blank', `target=${JSON.stringify(tg.link && tg.link.target)}`)

    // ② 本地来源行无入口 ──
    await focusEpisode(page, localEp.id)
    const loc = await readSourceBlock(page)
    await page.screenshot(path.join(OUT, '02_local_source_row_en.png'))
    if (!loc) {
      check('② 本地集来源块可读', false, 'episode-source-info missing')
      process.exit(2)
    }
    check(`② 本地来源行无入口（linkCount = 0，聚焦 ep=${localEp.id}）`,
      loc.linkCount === 0,
      `linkCount=${loc.linkCount} focusTitle=${JSON.stringify(loc.focusTitle)} primaryRowText=${JSON.stringify(loc.primaryRowText)}`)
    check('②b 本地来源行仍显示来源标签（未因无入口而整行消失）',
      !!loc.primaryRowText && loc.primaryRowText.length > 0,
      JSON.stringify(loc.primaryRowText))

    // ③ en-US 无硬编码中文 ──
    check('③ en-US 来源块可见文本 CJK 汉字数 = 0（夹具标题全 ASCII）',
      cjkCount(loc.blockText) === 0 && cjkCount(tg.blockText) === 0,
      `tg=${cjkCount(tg.blockText)} local=${cjkCount(loc.blockText)} localText=${JSON.stringify(loc.blockText)}`)

    // ④ 反向证伪 ──
    console.log(`[bug285] --- 证伪：临时摘掉主版本行入口（${TAMPER_FROM.trim()} → ${TAMPER_TO.trim()}）---`)
    const beforeText = beforeBytes.toString('utf8')
    if (!beforeText.includes(TAMPER_FROM)) {
      check('④P 证伪锚点存在（SeriesDetail.tsx 含目标行）', false, `anchor-not-found: ${TAMPER_FROM}`)
    } else {
      check('④P 证伪锚点存在（SeriesDetail.tsx 含目标行）', true, TAMPER_FROM.trim())
      let restored = false
      try {
        fs.writeFileSync(SERIES_DETAIL_TSX, beforeText.replace(TAMPER_FROM, TAMPER_TO))
        await delay(900) // 等 vite watch 失效模块缓存
        await forceLanguage(page, ep.app, 'en-US')
        if (!(await openSeriesDetail(page, ser.id, SER_TITLE))) {
          check('④a 红态可读（剧集内页仍可打开，证伪未弄坏应用）', false, 'reopen-failed')
        } else {
          await focusEpisode(page, tgEp.id)
          const red = await readSourceBlock(page)
          await page.screenshot(path.join(OUT, '03_red_state_no_entry.png'))
          check('④a 红态读数：TG 来源行入口消失（判据①a/①b 按预期失败）',
            !!red && red.linkCount === 0 && !red.link,
            `linkCount=${red && red.linkCount} primaryRowText=${JSON.stringify(red && red.primaryRowText)}`)
          check('④b 红态读数：块内已无 "View in TG" 文案',
            !!red && !String(red.blockText).includes(EXPECT_LABEL_EN),
            JSON.stringify(red && red.blockText))
        }
      } finally {
        // 字节级还原（禁 git checkout —— 会冲掉并行 agent 的未提交改动）
        fs.writeFileSync(SERIES_DETAIL_TSX, beforeBytes)
        restored = true
      }
      const afterBytes = fs.readFileSync(SERIES_DETAIL_TSX)
      const shaAfter = crypto.createHash('sha256').update(afterBytes).digest('hex')
      check('④c 字节级还原：sha256 与改前一致',
        restored && shaAfter === shaBefore,
        `before=${shaBefore.slice(0, 12)} after=${shaAfter.slice(0, 12)}`)

      await delay(900)
      await forceLanguage(page, ep.app, 'en-US')
      await openSeriesDetail(page, ser.id, SER_TITLE)
      await focusEpisode(page, tgEp.id)
      const green = await readSourceBlock(page)
      await page.screenshot(path.join(OUT, '04_restore_green.png'))
      check('④d 还原后复跑：入口回来、href 正确、文案正确',
        !!green && !!green.link && green.link.href === TG_URL && green.link.text === EXPECT_LABEL_EN,
        `link=${JSON.stringify(green && green.link)}`)
      await focusEpisode(page, localEp.id)
      const green2 = await readSourceBlock(page)
      check('④e 还原后复跑：本地来源行仍无入口',
        !!green2 && green2.linkCount === 0, `linkCount=${green2 && green2.linkCount}`)
    }

    const pageErrs = page.pageErrors().slice(0, 5)
    console.log(`[bug285] PAGE_ERRORS: ${JSON.stringify(pageErrs)}`)
  } finally {
    if (browser) await browser.close()
    await cleanup(ep.tg, created.series, created.items, localItem.filePath)
    // 收尾自证：夹具确实删净（否则后面跑的人会被残留样本干扰）
    const left = await httpJson('GET', `${ep.tg}/api/media/series`)
    const still = ((left.json && left.json.items) || []).filter((s) => created.series.includes(s.id))
    console.log(`[bug285] cleanup: series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)} leftover=${JSON.stringify(still.map((s) => s.id))}`)
    check('⑤ 夹具已清理（无残留剧集）', still.length === 0, `leftover=${JSON.stringify(still.map((s) => s.id))}`)
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify(
      {
        bug: 'BUG-285',
        passed,
        total: checks.length,
        all_passed: passed === checks.length,
        tg_ref: TG_REF,
        expected_url: TG_URL,
        checks,
      },
      null,
      2,
    ),
  )
  console.log(`\nRESULT ${passed}/${checks.length}  shots=${OUT}`)
  process.exit(passed === checks.length ? 0 : 2)
}

main().catch((e) => {
  console.error('FATAL', (e && e.stack) || e)
  process.exit(2)
})
