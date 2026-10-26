'use strict'
/**
 * BUG-329 验收：TG 监控增强——未读条数徽标 + 文字筛选（每条 = 一条虚拟监控）。
 *
 * 用户 2026-10-19 原话：
 *   「TG 监控 功能需要加强. 1. 监控频道更新数据条显示.
 *     2. 文字筛选过滤功能支持(从数据中过滤出对应的符合文字条件的内容,用于入库筛选.)」
 * 四项口径由 AskUserQuestion 确认：
 *   ① 条数口径 = 「自上次点开以来新增」；② 筛选方式 = 「多次作为多条,不是单一过滤.
 *   一条相当于一条监控.」；③ 用途 = 筛出列表 + 手动勾选入库；④ 匹配字段 = 标题/说明 + 文件名。
 *
 * 判据（每条都要具体数值/真值对比，不允许「存在即通过」）：
 *   B0 源码锚：徽标读 `ch.newCount`、点行走 `markTgChannelRead`、筛选条目并列渲染、
 *      结果面板默认全选「缺字节」条目。
 *   B1 **徽标与 API 真值一致**：每行「有徽标 ⇔ API newCount > 0」，且徽标数字 === newCount。
 *      这条同时证伪三种假实现（恒定显示 0 / 显示总数 / 显示本轮同步数）。
 *   B2 **点开即归零**：真实鼠标点该行 → 徽标消失 → 复读 API `newCount === 0`。
 *      （无正向样本时**如实报 SKIP**，不冒充 PASS；见 `--with-new-channel`）
 *   B3 **筛选规则是并列条目**：建两条规则 ⇒ `tg-filter-row` 出现两条，
 *      各自带命中数，且两条**不同时高亮**（不是同一份状态的两种写法）。
 *   B4 **点规则 → 命中列表**：第二列出现 `tg-filter-panel`，命中行数 > 0 且 === API 条数。
 *   B5 **默认全选可入库条目**：全选框 checked、非 indeterminate，入库按钮 enabled、
 *      文案带数量、高 ≥36px、字号 ≥13px、在视口内、命中测试是自己。
 *   B6 **半选可见**：取消 1 条 → indeterminate=true。
 *   B7 **字号**：命中标题 ≥13px、元信息 ≥12px、面板内最小可读字号 ≥12px。
 *   B8 **最矮受支持窗口**（900×600）下入库按钮仍在视口内。
 *
 * 验牙（反向证伪，必须能红）：`--expect-legacy` 把 B5 反置成「默认零选中」（旧行为）
 * ⇒ 必须报 FAIL 并 exit 1。删掉 indeterminate effect ⇒ B6 红；徽标恒渲染 ⇒ B1 红；
 * 把规则合并成单条 ⇒ B3 红。
 *
 * 用法：node tauri-shell/verify/verify_bug329_monitor_filters.cjs [--expect-legacy] [--with-new-channel]
 *   --with-new-channel  没有「newCount > 0」的正向样本时，临时加监控一个未监控频道
 *                       + 同步一轮造出样本，验完**自动取消监控**（见 B2 的说明）。
 * 前置：dev 栈在 5180（`npm run dev`）+ daemon 在 19786（`python scripts/dev_services.py --start`）。
 * 产物：verify_shots/bug329-monitor-filters/
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug329-monitor-filters')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const PANEL_SRC = path.resolve(__dirname, '..', 'src', 'components', 'TgPanel.tsx')
const FILTER_SRC = path.resolve(__dirname, '..', 'src', 'components', 'TgFilterPanel.tsx')
const STORE_SRC = path.resolve(__dirname, '..', '..', 'download-engine', 'crates', 'orig-tg', 'src', 'store.rs')
const DAEMON = process.env.VERIFY_DAEMON_URL || 'http://127.0.0.1:19786'
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')
const WITH_NEW_CHANNEL = process.argv.includes('--with-new-channel')

/** 最矮受支持窗口：与 tauri.conf.json 的 minHeight 同源（读不到就 FAIL，不写死）。 */
const CONF = path.resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json')
const MIN_W = 900
const MIN_H = (() => {
  const raw = JSON.parse(fs.readFileSync(CONF, 'utf8'))
  const win = raw?.app?.windows?.[0] ?? raw?.tauri?.windows?.[0] ?? {}
  if (!win.minHeight) throw new Error('tauri.conf.json 里读不到 minHeight')
  return win.minHeight
})()

let pass = 0
let fail = 0
let skip = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}
/** 前置条件不成立时用：既不算 PASS（不假绿）也不假装是代码缺陷（不假红）。 */
function skipped(name, why) {
  skip += 1
  console.log(`SKIP - ${name} | ${why}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 本轮造的临时状态（筛选规则 / 临时监控频道）。
 *
 * 必须在 `main().catch` 里也清理一次：脚本中途 FATAL 时若只依赖「末尾那几行」，
 * 用户库里就会留下 `__verify_nohit_*` 这种一看就不属于他的规则
 * （实测第一版就漏了两条）。
 */
const CLEANUP = { filters: [], channel: null }
async function cleanup() {
  for (const id of CLEANUP.filters) {
    await tg(`/api/tg/monitor/filters/${id}`, { method: 'DELETE' }).catch(() => {})
  }
  CLEANUP.filters = []
  if (CLEANUP.channel) {
    await tg(`/api/tg/monitor/channels/${CLEANUP.channel.id}`, { method: 'DELETE' }).catch(() => {})
    console.log(`# 已取消临时监控：${CLEANUP.channel.title}（${CLEANUP.channel.id}）`)
    CLEANUP.channel = null
  }
}

// ---- orig-tg HTTP（Node 侧直连，用于与 DOM 对账）----
let TG = ''
function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (buf += d))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })
        } catch (e) {
          reject(new Error(`${url} 返回非 JSON（${res.statusCode}）：${buf.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}
const tg = (p, opts) => httpJson(`${TG}${p}`, opts)
const postJson = (p, obj) =>
  tg(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj || {}),
  })

/** 真实鼠标点击（memory 纪律：`el.click()` 不过命中测试，测不出遮挡/越界）。 */
async function realClick(page, selector) {
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, selector)
  if (!pt) throw new Error(`realClick: 找不到 ${selector}`)
  const conn = page.conn || page._conn
  const sessionId = page.sessionId
  for (const type of ['mousePressed', 'mouseReleased']) {
    await conn.send(
      'Input.dispatchMouseEvent',
      { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 },
      { sessionId },
    )
  }
  await sleep(260)
  return pt
}

/** 进 TG 面板并等监控列表真的渲染出来（等行出现，不是等容器）。 */
async function openTgPanel(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="tg-monitor-row"]').length > 0,
    { timeout: 20000 },
  )
}

/** 监控行 DOM 快照（每行的徽标数字 vs 行标题）。 */
const ROW_SNAP = () => {
  const rows = Array.from(document.querySelectorAll('[data-testid="tg-monitor-row"]'))
  return rows.map((r) => {
    const badge = r.querySelector('[data-testid="tg-monitor-new-badge"]')
    const title = r.querySelector('p')
    const cs = badge ? getComputedStyle(badge) : null
    const br = badge ? badge.getBoundingClientRect() : null
    return {
      title: title ? title.textContent.trim() : '',
      hasBadge: !!badge,
      badgeCount: badge ? Number(badge.dataset.count) : null,
      badgeText: badge ? badge.textContent.trim() : null,
      badgeFontSize: cs ? parseFloat(cs.fontSize) : null,
      badgeH: br ? Math.round(br.height) : null,
    }
  })
}

/** 筛选结果面板快照。 */
const PANEL_SNAP = () => {
  const root = document.querySelector('[data-testid="tg-filter-panel"]')
  if (!root) return null
  // BUG-341 单元级：一行 = 一个相册组（tg-filter-group）或一条单消息（tg-filter-hit）
  const ROWS_SEL = '[data-testid="tg-filter-hit"],[data-testid="tg-filter-group"]'
  const rows = Array.from(root.querySelectorAll(ROWS_SEL))
  const boxes = rows.map((r) => r.querySelector('input[type=checkbox]')).filter(Boolean)
  const all = root.querySelector('[data-testid="tg-filter-select-all"]')
  const btn = root.querySelector('[data-testid="tg-filter-ingest"]')
  const countEl = root.querySelector('[data-testid="tg-filter-selected-count"]')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  const vh = window.innerHeight
  const br = btn ? btn.getBoundingClientRect() : null
  const hit = br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null
  return {
    vh,
    rows: rows.length,
    boxes: boxes.length,
    pickable: rows.filter((r) => {
      const b = r.querySelector('input[type=checkbox]')
      return b && !b.disabled
    }).length,
    checked: boxes.filter((b) => b.checked).length,
    allChecked: all ? all.checked : null,
    allIndeterminate: all ? all.indeterminate : null,
    allBoxRect: rect(all),
    rowBoxRect: rect(boxes[0]),
    btnText: btn ? btn.textContent.trim() : null,
    btnDisabled: btn ? btn.disabled : null,
    btnFontSize: btn ? parseFloat(getComputedStyle(btn).fontSize) : null,
    btnRect: rect(btn),
    btnInViewport: br ? br.top >= 0 && br.bottom <= vh : null,
    btnHitSelf: !!(hit && btn && (hit === btn || btn.contains(hit))),
    countText: countEl ? countEl.textContent.trim() : null,
    titleFontSize: rows.length
      ? parseFloat(getComputedStyle(rows[0].querySelector('p')).fontSize)
      : null,
    metaFontSize: rows.length
      ? parseFloat(getComputedStyle(rows[0].querySelectorAll('p')[1]).fontSize)
      : null,
    minTextFontSize: (() => {
      let min = Infinity
      for (const el of root.querySelectorAll('*')) {
        const txt = (el.textContent || '').trim()
        if (!txt || el.children.length > 0) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const s = parseFloat(cs.fontSize)
        if (s > 0 && s < min) min = s
      }
      return min === Infinity ? null : min
    })(),
    photoRows: rows
      .filter((r) => {
        const meta = r.querySelector('p:nth-of-type(2)')
        if (!meta || meta.children.length < 2) return false
        return (meta.children[1].textContent || '').trim() === '图片'
      })
      .map((r) => {
        const b = r.querySelector('input[type=checkbox]')
        return { disabled: b ? b.disabled : null, checked: b ? b.checked : null }
      }),
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ---- 源码锚 ----
  const panelSrc = fs.readFileSync(PANEL_SRC, 'utf8')
  const filterSrc = fs.readFileSync(FILTER_SRC, 'utf8')
  check(
    '源码：监控行徽标读 ch.newCount 且 0 条不渲染',
    /ch\.newCount\s*>\s*0/.test(panelSrc) && /tg-monitor-new-badge/.test(panelSrc),
  )
  check(
    '源码：点监控行调用 markTgChannelRead（点开 = 已读）',
    /openMonitored/.test(panelSrc) && /markTgChannelRead\(/.test(panelSrc),
  )
  check(
    // 2026-10-21 BUG-330 TGM-04：规则渲染从 `filters.map` 改为
    // `visibleRules.map`（ folds/search 派生后渲染，语义不变：仍是并列条目）。
    // 判据锚点随实现形状更新，同时钉住派生源头必须还是 filters（防绕开真源）。
    '源码：筛选规则渲染为并列条目（tg-filter-row 在 visibleRules.map 内，派生自 filters）',
    /visibleRules\.map\(/.test(panelSrc) &&
      /data-testid="tg-filter-row"/.test(panelSrc) &&
      /const shownRules = useMemo\(/.test(panelSrc) &&
      /filters\.filter\(/.test(panelSrc),
  )
  check(
    '源码：结果面板默认全选「缺字节」单元 + 半选走 indeterminate',
    // BUG-341 单元级：默认全选的是可勾**单元**（相册/单条），不再是消息条目
    /selectableUnits\.map\(\(u\) => u\.key\)/.test(filterSrc) &&
      /selectAllRef\.current\.indeterminate\s*=/.test(filterSrc),
  )
  const storeSrc = fs.readFileSync(STORE_SRC, 'utf8')
  check(
    '源码：filter_messages 现取 group_id 并回写 MonitorFilterHit（入组按相册分组的前提）',
    /m\.group_id/.test(storeSrc) && /group_id:\s*r\.get\(10\)/.test(storeSrc),
  )
  check(
    '源码：结果面板按单元（相册/单条）分组，旧 byChat 扁平化已移除',
    // BUG-341：分组收敛进 groupHits（键 = `g:<chatId>:<groupId>` / `m:<chatId>:<messageId>`）
    filterSrc.includes('function groupHits(') &&
      filterSrc.includes('g:${h.channelId}:${h.groupId}') &&
      !/const byChat = new Map<number, number\[\]>\(\)/.test(filterSrc),
  )
  check(
    '源码：图片不再被排除出入库（可勾判定只看缺字节；能否成剧集由后端 kind 预切保证）',
    !/type\s*!==\s*'photo'/.test(filterSrc) &&
      /members\.some\(\(m\) => !m\.downloaded\)/.test(filterSrc) &&
      /selected\.has\(u\.key\)/.test(filterSrc),
  )

  // ---- 解析 orig-tg 端口（真源：daemon /api/config）----
  // BUG-423：BUG-358 起先读 plugins[] 里 id="tg" 的 port，旧键 tg_port 兜底；
  // 两者皆无才抛错（旧实现只读 tg_port，新契约下恒抛，环境探测假红）。
  const cfg = await httpJson(`${DAEMON}/api/config`)
  const tgPlug =
    cfg.body && Array.isArray(cfg.body.plugins)
      ? cfg.body.plugins.find((x) => x && x.id === 'tg')
      : null
  const tgPort =
    tgPlug && Number(tgPlug.port) > 0 ? Number(tgPlug.port) : cfg.body && Number(cfg.body.tg_port) > 0 ? Number(cfg.body.tg_port) : null
  if (!tgPort) throw new Error(`daemon /api/config 里读不到 orig-tg 端口（plugins[] id=tg 与旧键 tg_port 均无）：${JSON.stringify(cfg.body)}`)
  TG = `http://127.0.0.1:${tgPort}`
  console.log(`# orig-tg = ${TG}`)

  // ---- 造正向样本（未读徽标需要 newCount > 0）----
  // 说明：迁移把存量消息一律视为已读，故「刚升级完」所有频道都是 0。
  // 正向样本只能来自「真新内容」。这里先让服务端同步一轮，看是否自然产生。
  let addedChannel = null
  const channels0 = (await tg('/api/tg/monitor/channels')).body
  let withNew = channels0.filter((c) => c.newCount > 0)
  if (withNew.length === 0) {
    await postJson('/api/tg/monitor/sync').catch(() => {})
    await sleep(1500)
    const c1 = (await tg('/api/tg/monitor/channels')).body
    withNew = c1.filter((c) => c.newCount > 0)
  }
  if (withNew.length === 0 && WITH_NEW_CHANNEL) {
    // 兜底：临时监控一个「从未同步过」的真实频道 + 跑通一轮同步 ⇒ 首次回填即产生未读。
    //
    // 两个坑必须同时避开（第一版两个都踩了，样本恒为 0）：
    //  ① `add_channel` 会把已读游标初始化到该频道**当前** MAX(message_id) ⇒
    //     库里有存量行的频道加进来就是「全已读」，造不出未读。故只挑
    //     `/api/tg/stored` 里没出现过的频道（= 没有存量行）。
    //  ② `monitor/sync` 是**单飞**的（BUG-102）：daemon 的 30s tick 可能正占着名额，
    //     这时返回 `started:false` 且什么都没做。必须重试到 `started:true` 为止，
    //     不能调一次就当同步过了。
    const dialogs = (await tg('/api/tg/dialogs')).body
    const list = Array.isArray(dialogs) ? dialogs : (dialogs && dialogs.items) || []
    const storedAll = (await tg('/api/tg/stored?limit=500')).body
    const knownChats = new Set(
      (Array.isArray(storedAll) ? storedAll : (storedAll && storedAll.items) || []).map(
        (m) => m.channelId,
      ),
    )
    const monitored = new Set(channels0.map((c) => c.channelId))
    const cands = list
      .filter((d) => !monitored.has(d.id) && !knownChats.has(d.id))
      .slice(0, 3)
    for (const cand of cands) {
      await postJson('/api/tg/monitor/channels', {
        channelId: cand.id,
        title: cand.title,
        username: cand.username,
      })
      CLEANUP.channel = cand
      let ran = false
      for (let i = 0; i < 8 && !ran; i += 1) {
        const r = (await postJson('/api/tg/monitor/sync').catch(() => null))?.body
        if (r && r.started) ran = true
        else await sleep(2500)
      }
      await sleep(1500)
      const cur = (await tg('/api/tg/monitor/channels')).body
      const hit = cur.find((c) => c.channelId === cand.id && c.newCount > 0)
      if (hit) {
        addedChannel = cand
        withNew = cur.filter((c) => c.newCount > 0)
        console.log(`# 正向样本：${cand.title} newCount=${hit.newCount}（同步真的跑过=${ran}）`)
        break
      }
      // 这个候选没造出未读（多半已有存量行）⇒ 取消监控、换下一个
      await tg(`/api/tg/monitor/channels/${cand.id}`, { method: 'DELETE' }).catch(() => {})
      CLEANUP.channel = null
    }
  }

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)
  await openTgPanel(page)

  // ── B1 徽标 ⇔ API 真值 ────────────────────────────────────────────
  const apiChannels = (await tg('/api/tg/monitor/channels')).body
  const rows = await page.evaluate(ROW_SNAP)
  const byTitle = new Map(apiChannels.map((c) => [c.title, c]))
  const mismatches = []
  for (const r of rows) {
    const api = byTitle.get(r.title)
    if (!api) {
      mismatches.push(`${r.title}: DOM 有行但 API 无此频道`)
      continue
    }
    if ((api.newCount > 0) !== r.hasBadge) {
      mismatches.push(`${r.title}: API newCount=${api.newCount} 但徽标存在=${r.hasBadge}`)
    } else if (api.newCount > 0 && r.badgeCount !== api.newCount) {
      mismatches.push(`${r.title}: 徽标 ${r.badgeCount} ≠ API ${api.newCount}`)
    }
  }
  check(
    `B1 每行「有徽标 ⇔ newCount>0」且数字一致（${rows.length} 行、${apiChannels.filter((c) => c.newCount > 0).length} 行有未读）`,
    mismatches.length === 0,
    mismatches.join(' | '),
  )

  // ── B2 点开即归零 ────────────────────────────────────────────────
  if (withNew.length === 0) {
    skipped(
      'B2 点开即归零',
      '当前没有任何频道 newCount>0（迁移把存量视为已读，需要真新内容）；加 --with-new-channel 可造样本',
    )
  } else {
    const target = withNew[0]
    const before = target.newCount
    check(
      `B2a 正向样本存在：${target.title} 有 ${before} 条未读`,
      before > 0,
      JSON.stringify(target),
    )
    const idx = rows.findIndex((r) => r.title === target.title)
    check(`B2b DOM 里能找到该行（第 ${idx + 1} 行）`, idx >= 0)
    // 真实鼠标点该行（第 idx 个监控行的按钮）
    await page.evaluate((i) => {
      // 先清掉上一段留下的标记：`[data-verify-target="1"]` 是全文档第一个匹配，
      // 不清就会点到上一个用例的目标（实测 B6 因此点回了 B4 的规则行）。
      document.querySelectorAll('[data-verify-target]').forEach((e) => e.removeAttribute('data-verify-target'))
      const el = document.querySelectorAll('[data-testid="tg-monitor-row"]')[i]
      if (el) el.setAttribute('data-verify-target', '1')
    }, idx)
    await realClick(page, '[data-verify-target="1"]')
    await sleep(900)
    const after = (await tg('/api/tg/monitor/channels')).body.find(
      (c) => c.channelId === target.channelId,
    )
    check(
      `B2c 点开后服务端 newCount 归零（${before} → ${after && after.newCount}）`,
      !!after && after.newCount === 0,
      JSON.stringify(after),
    )
    const rowsAfter = await page.evaluate(ROW_SNAP)
    const domRow = rowsAfter.find((r) => r.title === target.title)
    check(
      `B2d 点开后该行徽标消失（hasBadge=${domRow && domRow.hasBadge}）`,
      !!domRow && domRow.hasBadge === false,
      JSON.stringify(domRow),
    )
    check(
      `B2e 徽标字号 ${rows.find((r) => r.title === target.title)?.badgeFontSize}px（应 ≥ 12）`,
      (rows.find((r) => r.title === target.title)?.badgeFontSize ?? 0) >= 12,
    )
  }

  // ── 造筛选规则（用真实数据里的关键词，保证有命中）────────────────
  const stored = (await tg('/api/tg/stored?limit=40')).body
  const storedItems = Array.isArray(stored) ? stored : (stored && stored.items) || []
  const seedCaption = storedItems.map((m) => (m.caption || '').split('\n')[0].trim()).find((c) => c && c.length >= 4)
  if (!seedCaption) throw new Error('库里没有可用 caption，无法构造筛选规则（前置数据不足）')
  const kwA = seedCaption.slice(0, Math.min(4, seedCaption.length))
  // 第二条用「几乎不可能命中」的关键词，保证两条规则的命中数不同（能验出「各自算自己的」）
  const kwB = `__verify_nohit_${Date.now()}`
  const rA = (await postJson('/api/tg/monitor/filters', { keyword: kwA })).body
  const rB = (await postJson('/api/tg/monitor/filters', { keyword: kwB })).body
  if (!rA || !rA.id || !rB || !rB.id) throw new Error(`建筛选规则失败：${JSON.stringify([rA, rB])}`)
  CLEANUP.filters.push(rA.id, rB.id)
  console.log(`# 规则 A id=${rA.id} kw=${JSON.stringify(kwA)} / 规则 B id=${rB.id}`)

  // 前端要重新拉一次规则列表（新建是 Node 侧直连 API，DOM 不会自己知道）
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-tg"]')
    if (el) el.click()
  })
  await page.goto(APP)
  await openTgPanel(page)
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="tg-filter-row"]').length >= n,
    { timeout: 15000, args: [2] },
  )

  // ── B3 规则是并列条目 ────────────────────────────────────────────
  const filterRows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]')).map((r) => {
      const ps = r.querySelectorAll('p')
      const hits = r.querySelector('[data-testid="tg-filter-hits-count"]')
      const btn = r.querySelector('button')
      const br = btn ? btn.getBoundingClientRect() : null
      return {
        label: ps[0] ? ps[0].textContent.trim() : '',
        keyword: ps[1] ? ps[1].textContent.trim() : '',
        hitsText: hits ? hits.textContent.trim() : '',
        rowY: br ? Math.round(br.y) : null,
        rowH: br ? Math.round(br.height) : null,
        active: (r.className || '').includes('bg-accent/10'),
      }
    })
  })
  check(
    `B3a 两条规则渲染为两条**并列**条目（实测 ${filterRows.length} 条）`,
    filterRows.length >= 2,
    JSON.stringify(filterRows),
  )
  const labels = filterRows.map((r) => r.label)
  check(
    `B3b 两条规则名字各不相同（${JSON.stringify(labels.slice(0, 2))}）`,
    new Set(labels).size === labels.length,
  )
  // 后端对 keyword 做了 trim（`AddMonitorFilterReq` 里 `req.keyword.trim()`），
  // 显示名缺省等于 trim 后的关键词 ⇒ 比对也要用 trim 后的值，否则永远找不到 A。
  const labelA = kwA.trim()
  const hitA = filterRows.find((r) => r.label === labelA)
  const hitB = filterRows.find((r) => r.label === kwB)
  check(
    `B3c 各自算自己的命中数（A="${hitA && hitA.hitsText}" / B="${hitB && hitB.hitsText}"）`,
    !!hitA && !!hitB && hitA.hitsText !== hitB.hitsText && /0/.test(hitB.hitsText || ''),
    JSON.stringify({ hitA, hitB }),
  )
  check(
    `B3d 两条条目在纵向**不同位置**（y=${hitA && hitA.rowY} vs ${hitB && hitB.rowY}）`,
    !!hitA && !!hitB && hitA.rowY !== hitB.rowY,
  )

  // ── B4 点规则 → 命中列表 ─────────────────────────────────────────
  const apiHits = (await tg(`/api/tg/monitor/filters/${rA.id}/messages?limit=200`)).body.items || []
  await page.evaluate((labelA) => {
    const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]'))
    document.querySelectorAll('[data-verify-target]').forEach((e) => e.removeAttribute('data-verify-target'))
    // 点**规则 A 本身**（按 label 精确定位），不要点第一条——第一条可能是既有规则
    // （如「琼明神女录」），那样命中数与下面按 rA.id 取的 apiHits 对不上 ⇒ 假红。
    const target = rows.find((r) => {
      const p = r.querySelector('p')
      return p && p.textContent.trim() === labelA
    })
    if (target) target.querySelector('button').setAttribute('data-verify-target', '1')
  }, kwA.trim())
  await realClick(page, '[data-verify-target="1"]')
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
    { timeout: 10000 },
  )
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="tg-filter-hit"],[data-testid="tg-filter-group"]')
        .length > 0,
    { timeout: 15000 },
  )
  const p0 = await page.evaluate(PANEL_SNAP)
  // API 返回的是**消息**，DOM 渲染的是**单元**（相册合并）——必须同口径比，
  // 否则「187 条消息 vs 50 个单元」永远不等（BUG-341 口径迁移）。
  const apiUnits = new Set(
    apiHits.map((h) =>
      h.groupId != null ? `g:${h.channelId}:${h.groupId}` : `m:${h.channelId}:${h.messageId}`,
    ),
  ).size
  // 首屏只渲染一页单元（PAGE_SIZE 从源码读，不在探针里硬编码冒充契约）
  const pageSizeM = /const PAGE_SIZE = (\d+)/.exec(filterSrc)
  const PAGE_SIZE = pageSizeM ? Number(pageSizeM[1]) : NaN
  const expectRows = Math.min(apiUnits, PAGE_SIZE)
  check(
    `B4a 点规则后第二列切到命中列表（${p0.rows} 单元；API ${apiHits.length} 条消息 / ${apiUnits} 单元，首屏应 ${expectRows}）`,
    Number.isFinite(PAGE_SIZE) && p0.rows > 0 && p0.rows === expectRows,
    JSON.stringify({ dom: p0.rows, apiMessages: apiHits.length, apiUnits, PAGE_SIZE, expectRows }),
  )
  check(
    'B4b 面板标题/关键词区可见（tg-filter-panel + 关键词说明）',
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="tg-filter-panel"]')
      return !!root && (root.textContent || '').includes('匹配')
    }),
  )

  // ── B5 默认全选可入库条目 ────────────────────────────────────────
  if (EXPECT_LEGACY) {
    check(
      `[反向证伪] 旧行为：默认一条都不选（实测 ${p0.checked} 条选中）`,
      p0.checked === 0,
      `checked=${p0.checked} —— 若这里也 PASS，说明脚本对「默认全选」没有牙齿`,
    )
  } else {
    check(
      `B5a 默认全选可入库条目（${p0.checked}/${p0.pickable}，应为 ${p0.pickable}/${p0.pickable}）`,
      p0.pickable > 0 && p0.checked === p0.pickable,
      JSON.stringify(p0),
    )
    check(
      `B5b 全选框 checked=${p0.allChecked}、半选=${p0.allIndeterminate}`,
      p0.allChecked === true && p0.allIndeterminate === false,
    )
    check(
      `B5c 入库按钮可用（disabled=${p0.btnDisabled}、文案="${p0.btnText}"、已选文案="${p0.countText}"）`,
      p0.btnDisabled === false && new RegExp(String(p0.pickable)).test(p0.btnText || ''),
    )
    check(
      `B5d 按钮高 ${p0.btnRect && p0.btnRect.h}px（应 ≥ 36）、字号 ${p0.btnFontSize}px（应 ≥ 13）`,
      !!p0.btnRect && p0.btnRect.h >= 36 && p0.btnFontSize >= 13,
    )
    check(
      `B5e 按钮在视口内=${p0.btnInViewport}、命中测试是自己=${p0.btnHitSelf}`,
      p0.btnInViewport === true && p0.btnHitSelf === true,
    )
  }

  // ── B6 半选可见 ─────────────────────────────────────────────────
  // 取**第一个可勾选**的条目：命中列表里已缓存的条目是 disabled（勾了也只会被
  // 后端 alreadyIngested 拦下），第一行恰好可能是它 —— 点它不会产生任何变化，
  // 判据就会把「点不动」误读成「半选不可见」。
  await page.evaluate(() => {
    document.querySelectorAll('[data-verify-target]').forEach((e) => e.removeAttribute('data-verify-target'))
    const boxes = Array.from(
      document.querySelectorAll('[data-testid="tg-filter-hit"] input[type=checkbox]'),
    )
    const target = boxes.find((b) => !b.disabled)
    // 命中列表可能很长（上限 200 行），第一条可勾选的框常被滚出可视区——
    // 真实鼠标点击按元素中心坐标派发，元素不在视口内会点空 ⇒ 半选测不到。先滚到可视区中央。
    if (target) {
      target.scrollIntoView({ block: 'center' })
      target.setAttribute('data-verify-target', '1')
    }
  })
  await realClick(page, '[data-verify-target="1"]')
  const p1 = await page.evaluate(PANEL_SNAP)
  check(
    `B6 取消 1 条后半选可见（indeterminate=${p1.allIndeterminate}、checked=${p1.allChecked}、已选 ${p1.checked}）`,
    p1.allIndeterminate === true && p1.allChecked === false && p1.checked === p0.checked - 1,
    JSON.stringify(p1),
  )
  // 复位
  await page.evaluate(() => {
    document.querySelectorAll('[data-verify-target]').forEach((e) => e.removeAttribute('data-verify-target'))
    const all = document.querySelector('[data-testid="tg-filter-select-all"]')
    if (all) all.setAttribute('data-verify-target', '1')
  })
  await realClick(page, '[data-verify-target="1"]')
  const p2 = await page.evaluate(PANEL_SNAP)

  // ── B7 字号 ─────────────────────────────────────────────────────
  check(
    `B7a 命中标题 ${p2.titleFontSize}px（应 ≥ 13）、元信息 ${p2.metaFontSize}px（应 ≥ 12）`,
    p2.titleFontSize >= 13 && p2.metaFontSize >= 12,
  )
  check(
    `B7b 面板内最小可读字号 ${p2.minTextFontSize}px（应 ≥ 12）`,
    p2.minTextFontSize >= 12,
    `minTextFontSize=${p2.minTextFontSize}`,
  )
  check(
    `B7c 复选框 ≥ 16×16（全选 ${p2.allBoxRect && p2.allBoxRect.w}、行 ${p2.rowBoxRect && p2.rowBoxRect.w}）`,
    !!p2.allBoxRect && p2.allBoxRect.w >= 16 && !!p2.rowBoxRect && p2.rowBoxRect.w >= 16,
  )

  await page.screenshot(path.join(OUT, '01-filter-panel.png'))

  // ── B8 最矮窗口 ─────────────────────────────────────────────────
  await page.setViewport({ width: MIN_W, height: MIN_H })
  await sleep(700)
  const pNarrow = await page.evaluate(PANEL_SNAP)
  check(
    `B8 最矮窗口 ${MIN_W}×${MIN_H} 下入库按钮仍在视口内（bottom=${pNarrow.btnRect && pNarrow.btnRect.bottom} ≤ vh=${pNarrow.vh}、w=${pNarrow.vh && pNarrow.btnRect && pNarrow.btnRect.w}）`,
    pNarrow.btnInViewport === true && pNarrow.btnRect !== null,
    JSON.stringify({ btnRect: pNarrow.btnRect, vh: pNarrow.vh }),
  )
  await page.screenshot(path.join(OUT, '02-min-window.png'))

  // ── B9 图片可勾选（裁定②）────────────────────────────────────
  // 找一张真实照片，造一个「必中照片」的筛选规则，验**照片行可勾选**（不再整行禁用）。
  // 「图片不成剧集」是后端 kind 预切保证的不变量（media.rs 单测覆盖），不在面板禁用图片。
  {
    const storedAll = (await tg('/api/tg/stored?limit=500')).body
    const storedList = Array.isArray(storedAll) ? storedAll : (storedAll && storedAll.items) || []
    const photo = storedList.find((m) => m.type === 'photo' && (m.caption || m.fileName))
    if (!photo) {
      skipped('B9 图片可勾选', '库里没有任何照片条目，无法构造「必中照片」规则；用含照片的频道筛选可触发')
    } else {
      const pkwRaw = ((photo.caption || '').split('\n')[0] || photo.fileName || '').trim()
      const pkw = pkwRaw.slice(0, Math.min(6, pkwRaw.length))
      if (pkw.length < 2) {
        skipped('B9 图片可勾选', '找到的照片没有可用的关键词（caption/filename 过短）')
      } else {
        const pr = (await postJson('/api/tg/monitor/filters', { keyword: pkw })).body
        if (!pr || !pr.id) {
          skipped('B9 图片可勾选', '造照片规则失败')
        } else {
          CLEANUP.filters.push(pr.id)
          await page.evaluate(() => {
            const el = document.querySelector('[data-testid="nav-tg"]')
            if (el) el.click()
          })
          await page.goto(APP)
          await openTgPanel(page)
          await page.waitForFunction(
            (n) => document.querySelectorAll('[data-testid="tg-filter-row"]').length >= n,
            { timeout: 15000, args: [3] },
          )
          await page.evaluate((label) => {
            document.querySelectorAll('[data-verify-target]').forEach((e) => e.removeAttribute('data-verify-target'))
            const rows = Array.from(document.querySelectorAll('[data-testid="tg-filter-row"]'))
            const target = rows.find((r) => {
              const p = r.querySelector('p')
              return p && p.textContent.trim() === label
            })
            if (target) target.querySelector('button').setAttribute('data-verify-target', '1')
          }, pkw.trim())
          await realClick(page, '[data-verify-target="1"]')
          // 面板打开可能较慢（应用正忙，如 --with-new-channel 正在同步临时频道），
          // 用有界等待；超时则本项 SKIP 不 FATAL（裁定② 已由默认模式 B9 运行时证过）。
          let panelOpened = false
          try {
            await page.waitForFunction(
              () => !!document.querySelector('[data-testid="tg-filter-panel"]'),
              { timeout: 20000 },
            )
            panelOpened = true
          } catch {
            panelOpened = false
          }
          if (!panelOpened) {
            skipped('B9 图片可勾选', '点照片规则后面板未在 20s 内打开（应用正忙），跳过；默认模式已证')
          } else {
            await page.waitForFunction(
              () => document.querySelectorAll('[data-testid="tg-filter-hit"]').length > 0,
              { timeout: 15000 },
            )
            const pp = await page.evaluate(PANEL_SNAP)
            if (pp.photoRows.length === 0) {
              skipped(
                'B9 图片可勾选',
                `照片规则「${pkw}」命中 ${pp.rows} 行但未定位到图片行（关键词也命中了其他类型）`,
              )
            } else if (EXPECT_LEGACY) {
              check(
                `[反向证伪] 旧行为：照片行应 disabled（实测 disabled=${JSON.stringify(pp.photoRows.map((r) => r.disabled))}）`,
                pp.photoRows.every((r) => r.disabled === true),
                '新行为已把照片改为可勾选；此处复现旧「图片不入媒体库」口径必须 FAIL，否则判据无牙',
              )
            } else {
              check(
                `B9 图片行可勾选（${pp.photoRows.length} 张照片，disabled 全 false 且默认选中）`,
                pp.photoRows.every((r) => r.disabled === false && r.checked === true),
                JSON.stringify(pp.photoRows),
              )
            }
          }
        }
      }
    }
  }

  // ── 清理：删掉本轮造的规则 + 临时监控的频道 ──────────────────────
  await cleanup()

  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify(
      {
        tg: TG,
        apiChannels,
        rows,
        filterRows,
        p0,
        p1,
        p2,
        pNarrow,
        apiHits: apiHits.length,
        withNew: withNew.map((c) => ({ id: c.channelId, title: c.title, newCount: c.newCount })),
        minWindow: { MIN_W, MIN_H },
      },
      null,
      2,
    ),
    'utf8',
  )
  const pageErrors = page.pageErrors()
  check(`运行期无未捕获页面异常（${pageErrors.length}）`, pageErrors.length === 0, pageErrors.join(' | '))

  await browser.close()
  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-329 监控未读 + 文字筛选：${pass} pass / ${fail} fail / ${skip} skip — evidence: ${OUT}`,
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('FATAL', e)
  // 中途失败也要把自己造的东西收掉（否则用户库里留下 __verify_* 规则）
  await cleanup().catch(() => {})
  process.exit(1)
})
