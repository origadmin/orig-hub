'use strict'
/**
 * BUG-327 验收：入库明细底部 Sheet 的**选择语义 + 可读性 + 可操作性**。
 *
 * 用户 2026-10-20 原话（同一句里四条投诉）：
 *   「底部弹出样式,操作全部对. 选中的=要下载的. 入库=要下载的. 实际: 全部非选中.
 *     全选和选中偏离,按钮完全无法找到,用户体验极差,大量基础问题,不限于这些.
 *     还有弹出内容字体小得看不清.」
 *
 * 拆成可复核的判据（每条都要具体数值，不允许「不等于旧值」式假绿）：
 *   A0 **默认全选**：可下载（缺字节）条目全部预选中，全选框 checked、非 indeterminate，
 *      批量按钮 enabled 且文案带数量。旧实现默认空集合 ⇒ 10 条全非选中 + 按钮灰着，
 *      与「选中的=要下载的」直接矛盾。
 *   A1 **全选与行复选框同列**：两者左边缘水平距离 ≤ 4px。旧实现全选被 flex-1 标题
 *      挤到最右（实测 x=1387），行复选框在 x≈16 —— 相隔 1371px，「开关」与「被控的框」
 *      在视觉上毫无关系，这就是用户说的「全选和选中偏离」。
 *   A2 **半选可见**：取消 1 条后全选框 indeterminate=true 且 checked=false。
 *      旧实现只有 checked，半选与「一条没选」长得一样。
 *   A3 **半选态点全选 ⇒ 全选**：行全选中、全选框 checked。
 *   A4 **全选态点全选 ⇒ 全不选**：按钮回到 disabled（但仍在原位，不消失）。
 *   A5 **整行可点选**：在行内标题区用真实鼠标事件点击（不是 el.click()）⇒ 该行切换。
 *      旧实现唯一命中区是 12×12px 的复选框。
 *   A6 **按钮可找到**：批量按钮高 ≥ 36px、字号 ≥ 13px、在视口内、命中测试是自己；
 *      且在最矮受支持窗口（tauri.conf.json minHeight=600）下仍在视口内。
 *   A7 **字号**：条目 ≥ 13px、说明 ≥ 12px、面板内**没有 < 12px 的可读文字**。
 *   A8 **复选框**：全选与行复选框都 ≥ 16×16px。
 *
 * 验牙（反向证伪，必须能红）：
 *   `--expect-legacy` 把 A0 反置成「默认一条都不选」（旧行为）⇒ 必须报红。
 *   删掉 `indeterminate` 的 effect ⇒ A2 红；把全选移回右侧 ⇒ A1 红；
 *   去掉 `<li onClick>` ⇒ A5 红；字号退回 11px ⇒ A7 红。
 *
 * 用法：node tauri-shell/verify/verify_bug327_sheet_selection.cjs [--expect-legacy]
 * 前置：dev 栈在 5180（`npm run dev` + `python scripts/dev_services.py --start`）。
 * 产物：verify_shots/bug327-sheet-selection/
 */
const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug327-sheet-selection')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const SRC = path.resolve(__dirname, '..', 'src', 'domains', 'download', 'IngestDetailSheet.tsx')
const EXPECT_LEGACY = process.argv.includes('--expect-legacy')

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
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  await sleep(220)
  return pt
}

async function openSheet(page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-download"]')
    if (el) el.click()
  })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-group-row"]').length > 0,
    { timeout: 15000 },
  )
  await page.evaluate(() => {
    document.querySelector('[data-testid="ingest-group-header"]').click()
  })
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="ingest-detail-sheet"]'),
    { timeout: 8000 },
  )
  // 等清单真的回来（等行数 > 0，不是等容器出现）
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="ingest-sheet-entry"]').length > 0,
    { timeout: 15000 },
  )
}

/** 面板的当前状态快照。 */
const SNAP = () => {
  const box = document.querySelector('[data-testid="ingest-sheet-select-all-box"]')
  const boxes = Array.from(
    document.querySelectorAll('[data-testid="ingest-sheet-entry-checkbox"]'),
  )
  const entries = Array.from(document.querySelectorAll('[data-testid="ingest-sheet-entry"]'))
  const btn = document.querySelector('[data-testid="ingest-sheet-download-selected"]')
  const rowBox = boxes[0]
  const allLabel = document.querySelector('[data-testid="ingest-sheet-select-all"]')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
    }
  }
  const vh = window.innerHeight
  const br = btn ? btn.getBoundingClientRect() : null
  const hit = br
    ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2)
    : null
  return {
    vh,
    entries: entries.length,
    selectable: entries.filter((e) => e.dataset.bytes === '0').length,
    checkedRows: boxes.filter((b) => b.checked).length,
    boxes: boxes.length,
    allChecked: box ? box.checked : null,
    allIndeterminate: box ? box.indeterminate : null,
    allRect: rect(allLabel),
    rowBoxRect: rect(rowBox),
    allBoxRect: rect(box),
    btnText: btn ? btn.textContent.trim() : null,
    btnDisabled: btn ? btn.disabled : null,
    btnFontSize: btn ? parseFloat(getComputedStyle(btn).fontSize) : null,
    btnRect: rect(btn),
    btnInViewport: br ? br.top >= 0 && br.bottom <= vh : null,
    btnHitSelf: !!(hit && btn && (hit === btn || btn.contains(hit))),
    entryFontSize: entries.length
      ? parseFloat(getComputedStyle(entries[0]).fontSize)
      : null,
    noteFontSize: (() => {
      const n = document.querySelector('[data-testid="ingest-group-entry-note"]')
      return n ? parseFloat(getComputedStyle(n).fontSize) : null
    })(),
    /** 面板内所有可见文字节点的最小字号（装饰性 svg 不算）。 */
    minTextFontSize: (() => {
      let min = Infinity
      for (const el of document.querySelectorAll('[data-testid="ingest-detail-sheet"] *')) {
        const txt = (el.textContent || '').trim()
        if (!txt || el.children.length > 0) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const s = parseFloat(cs.fontSize)
        if (s > 0 && s < min) min = s
      }
      return min === Infinity ? null : min
    })(),
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 源码锚：改的是这几处结构，源码里必须有对应痕迹（读不到就 FAIL）
  const src = fs.readFileSync(SRC, 'utf8')
  check(
    '源码：默认全选缺字节条目（load 时 filter !hasBytes 写入 selected）',
    /filter\(\(e\) => !e\.hasBytes\)\.map\(\(e\) => e\.messageId\)/.test(src),
  )
  check(
    '源码：全选走 indeterminate（selectAllRef + indeterminate 赋值）',
    /selectAllRef/ .test(src) && /\.indeterminate =/.test(src),
  )
  check(
    '源码：条目行整行可点（<li> 上有 onClick=…toggleOne）',
    /onClick=\{[^}]*toggleOne\(e\.messageId\)/.test(src),
  )

  const browser = await cdp.launch()
  const page = await browser.newPage()
  await page.goto(APP)
  await openSheet(page)

  // ── A0 默认全选 ────────────────────────────────────────────────────
  const s0 = await page.evaluate(SNAP)
  if (EXPECT_LEGACY) {
    check(
      `[反向证伪] 旧行为：默认一条都不选（实测 ${s0.checkedRows}/${s0.selectable}）`,
      s0.checkedRows === 0,
      `checkedRows=${s0.checkedRows} 说明脚本对「默认全选」这条判据有牙齿`,
    )
  } else {
    check(
      `A0 默认全选可下载条目（${s0.checkedRows}/${s0.selectable}，应为 ${s0.selectable}/${s0.selectable}）`,
      s0.selectable > 0 && s0.checkedRows === s0.selectable && s0.checkedRows === s0.boxes,
      JSON.stringify(s0),
    )
    check(
      `A0b 全选框默认 checked=${s0.allChecked} 且非半选=${s0.allIndeterminate}`,
      s0.allChecked === true && s0.allIndeterminate === false,
    )
    check(
      `A0c 批量按钮默认可用（disabled=${s0.btnDisabled}、文案="${s0.btnText}"）`,
      s0.btnDisabled === false && new RegExp(`下载选中 ${s0.selectable} 项`).test(s0.btnText || ''),
    )
  }

  // ── A1 全选与行复选框同列 ──────────────────────────────────────────
  const dx = s0.allRect && s0.rowBoxRect ? Math.abs(s0.allRect.x - s0.rowBoxRect.x) : null
  check(
    `A1 全选框与行复选框同列（左边缘相距 ${dx}px，应 ≤ 4px）`,
    dx !== null && dx <= 4,
    `all.x=${s0.allRect && s0.allRect.x} rowBox.x=${s0.rowBoxRect && s0.rowBoxRect.x}`,
  )

  // ── A5 整行可点选（真实鼠标事件）──────────────────────────────────
  const before = s0.checkedRows
  await realClick(page, '[data-testid="ingest-sheet-entry-title"]')
  const s1 = await page.evaluate(SNAP)
  check(
    `A5 点行内标题区即可取消该条（${before} → ${s1.checkedRows}，应减 1）`,
    s1.checkedRows === before - 1,
    JSON.stringify({ before, after: s1.checkedRows }),
  )

  // ── A2 半选可见 ────────────────────────────────────────────────────
  check(
    `A2 半选时全选框 indeterminate=${s1.allIndeterminate}、checked=${s1.allChecked}`,
    s1.allIndeterminate === true && s1.allChecked === false,
    JSON.stringify({ allChecked: s1.allChecked, allIndeterminate: s1.allIndeterminate }),
  )
  check(
    `A2b 按钮文案随选择变化（"${s1.btnText}"，应含 ${s1.selectable - 1}）`,
    new RegExp(`下载选中 ${s1.selectable - 1} 项`).test(s1.btnText || ''),
  )

  // ── A3 半选态点全选 ⇒ 全选 ────────────────────────────────────────
  await realClick(page, '[data-testid="ingest-sheet-select-all-box"]')
  const s2 = await page.evaluate(SNAP)
  check(
    `A3 半选态点全选 ⇒ 全部选中（${s2.checkedRows}/${s2.selectable}、全选 checked=${s2.allChecked}、半选=${s2.allIndeterminate}）`,
    s2.checkedRows === s2.selectable && s2.allChecked === true && s2.allIndeterminate === false,
  )

  // ── A4 全选态点全选 ⇒ 全不选，按钮回到 disabled 但不消失 ──────────
  await realClick(page, '[data-testid="ingest-sheet-select-all-box"]')
  const s3 = await page.evaluate(SNAP)
  check(
    `A4 全选态点全选 ⇒ 全不选（${s3.checkedRows} 条）、按钮 disabled=${s3.btnDisabled} 且仍渲染`,
    s3.checkedRows === 0 && s3.btnDisabled === true && !!s3.btnText,
  )
  check(
    `A4b 未选中时按钮**仍在视口内**（不消失，只是禁用）`,
    s3.btnInViewport === true && s3.btnRect !== null,
    JSON.stringify(s3.btnRect),
  )
  // 复位：重新全选，供后面量几何
  await realClick(page, '[data-testid="ingest-sheet-select-all-box"]')
  const s4 = await page.evaluate(SNAP)

  // ── A6 按钮可找到（几何 + 命中）──────────────────────────────────
  check(
    `A6 批量按钮高 ${s4.btnRect && s4.btnRect.h}px（应 ≥ 36）、字号 ${s4.btnFontSize}px（应 ≥ 13）`,
    !!s4.btnRect && s4.btnRect.h >= 36 && s4.btnFontSize >= 13,
  )
  check(
    `A6b 批量按钮在视口内=${s4.btnInViewport}、命中测试是自己=${s4.btnHitSelf}`,
    s4.btnInViewport === true && s4.btnHitSelf === true,
  )

  // ── A7 字号 ───────────────────────────────────────────────────────
  check(
    `A7 条目字号 ${s4.entryFontSize}px（应 ≥ 13）、说明字号 ${s4.noteFontSize}px（应 ≥ 12）`,
    s4.entryFontSize >= 13 && s4.noteFontSize >= 12,
  )
  check(
    `A7b 面板内最小可读字号 ${s4.minTextFontSize}px（应 ≥ 12，不得有 10/11px 正文）`,
    s4.minTextFontSize >= 12,
    `minTextFontSize=${s4.minTextFontSize}`,
  )

  // ── A8 复选框尺寸 ─────────────────────────────────────────────────
  check(
    `A8 复选框尺寸：全选 ${s4.allBoxRect && s4.allBoxRect.w}×${s4.allBoxRect && s4.allBoxRect.h}、行 ${s4.rowBoxRect && s4.rowBoxRect.w}×${s4.rowBoxRect && s4.rowBoxRect.h}（应 ≥ 16×16）`,
    !!s4.allBoxRect && s4.allBoxRect.w >= 16 && !!s4.rowBoxRect && s4.rowBoxRect.w >= 16,
  )

  await page.screenshot(path.join(OUT, '01-default-all-selected.png'))

  // ── A6c 最矮受支持窗口下按钮仍在视口内 ────────────────────────────
  await page.setViewport({ width: MIN_W, height: MIN_H })
  await sleep(600)
  const sNarrow = await page.evaluate(SNAP)
  check(
    `A6c 最矮窗口 ${MIN_W}×${MIN_H} 下按钮仍在视口内（h=${sNarrow.btnRect && sNarrow.btnRect.h}、bottom=${sNarrow.btnRect && sNarrow.btnRect.bottom} ≤ vh=${sNarrow.vh}）`,
    sNarrow.btnInViewport === true,
    JSON.stringify({ btnRect: sNarrow.btnRect, vh: sNarrow.vh }),
  )
  await page.screenshot(path.join(OUT, '02-min-window.png'))

  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ s0, s1, s2, s3, s4, sNarrow, minWindow: { MIN_W, MIN_H } }, null, 2),
    'utf8',
  )
  const pageErrors = page.pageErrors()
  check(
    `运行期无未捕获页面异常（${pageErrors.length}）`,
    pageErrors.length === 0,
    pageErrors.join(' | '),
  )

  await browser.close()
  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} - BUG-327 入库明细 Sheet 选择/可读性：${pass} pass / ${fail} fail — evidence: ${OUT}`,
  )
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
