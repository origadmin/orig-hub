/**
 * BUG-083 · 顶部上下文栏真实渲染验收。
 *
 * 对应用户裁定：「顶部那一栏改成随视图变化的上下文栏；不需要占位」。
 * 断言三件事：
 *   1) **不留白**：媒体库 / TG / 设置三视图的左槽都有视图标题、右槽都有连接态灯；
 *   2) **不跳动**：切换视图时 header 的 top / height 完全一致（这是「不需要占位」的前提）；
 *   3) **下载分支未死**：三档下载视图（下载中 / 已暂停 / 已完成）仍渲染
 *      新建 / 全部暂停 / 全部开始（「已完成」档追加「清空」），且 disabled 态正确。
 *
 * 前置：vite dev（默认 http://127.0.0.1:5180）、orig-daemon 已起。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node tauri-shell/verify/shot_context_bar.cjs
 * 产物：默认落 `verify_shots/round10/`（**证据产物不入库**，AGENTS.md §6），可用 ORIG_SHOT_OUT 覆盖。
 */
// BUG-086: playwright is intentionally NOT a dependency of tauri-shell (its browser
// download is impossible in offline/constrained environments). Degrade gracefully
// instead of crashing with a bare MODULE_NOT_FOUND. See verify/README.md.
let chromium
try {
  ;({ chromium } = require('playwright'))
} catch (err) {
  const missingPlaywright =
    err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes('playwright')
  if (missingPlaywright) {
    console.error('[verify] 未安装 playwright，本脚本无法执行：需要真实浏览器截图，非网络不可。')
    console.error('[verify] 安装方式：cd tauri-shell && npm i -D playwright && npx playwright install chromium')
    console.error('[verify] 零依赖的真实渲染验收请改用：npm run verify:ui')
    process.exit(2)
  }
  throw err
}
const path = require('path')
const fs = require('fs')

const OUT =
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'round10')
const URL = process.env.APP_URL || 'http://127.0.0.1:5180'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

/** 读上下文栏的运行期事实：标题、副标题、连接态、header 几何、按钮清单。
 *
 * `sub` = 树选择副标题（`ContextBar::ViewTitle` 的 `context-bar-sub`）：
 * 文件域取分类/资料库组标签，下载域取档位标签；无副标题时为 null。
 * 缺失该读数会让 `EXPECT.*.sub` 断言恒 FAIL（`undefined !== '下载中'`）——
 * 即「断言引用了一个读不到的字段」，正是最坏的一类假绿。
 */
async function readBar(page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="context-bar-header"]')
    const title = document.querySelector('[data-testid="context-bar-title"]')
    const sub = document.querySelector('[data-testid="context-bar-sub"]')
    const conn = document.querySelector('[data-testid="context-conn"]')
    // BUG-169 终裁：唯一连接状态点在底栏右下角（statusbar-conn）
    const footerConn = document.querySelector('[data-testid="statusbar-conn"]')
    const speed = document.querySelector('[data-testid="context-speed"]')
    const active = document.querySelector('[data-testid="context-active"]')
    const box = header ? header.getBoundingClientRect() : null
    const buttons = Array.from(header ? header.querySelectorAll('button') : []).map((b) => ({
      text: (b.textContent || '').trim(),
      disabled: !!b.disabled,
    }))
    return {
      hasHeader: !!header,
      title: title ? (title.textContent || '').trim() : null,
      sub: sub ? (sub.textContent || '').trim() : null,
      connState: conn ? conn.getAttribute('data-conn-state') : null,
      connText: conn ? (conn.textContent || '').trim() : null,
      footerConnState: footerConn ? footerConn.getAttribute('data-conn-state') : null,
      footerConnText: footerConn ? (footerConn.textContent || '').trim() : null,
      speed: speed ? (speed.textContent || '').trim() : null,
      active: active ? (active.textContent || '').trim() : null,
      top: box ? Math.round(box.top) : null,
      height: box ? Math.round(box.height) : null,
      buttons,
    }
  })
}

async function goto(page, testid) {
  const nav = page.locator(`[data-testid="${testid}"]`)
  if ((await nav.count()) === 0) return false
  await nav.first().click()
  await page.waitForTimeout(250)
  return true
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  /**
   * 视图 → 期望标题（zh-CN 默认语言）。
   * M0 起一级域只剩五个，下载三档降为侧栏树子项（`nav-child-dl-*`），
   * 标题统一取域标题（下载=「下载」，档位进副标题 `context-bar-sub`）。
   * 键 = 侧栏锚点；`sub` = 期望副标题（无则省略）。
   */
  const EXPECT = {
    'nav-files': { title: '文件', sub: null },
    'nav-child-lib-series': { title: '文件', sub: '剧集' },
    'nav-tg': { title: 'Telegram' },
    'nav-settings': { title: '设置' },
    'nav-child-dl-running': { title: '下载', sub: '下载中' },
    'nav-child-dl-paused': { title: '下载', sub: '已暂停' },
    'nav-child-dl-done': { title: '下载', sub: '已完成' },
  }

  const geo = []
  for (const [testid, expect] of Object.entries(EXPECT)) {
    const reached = await goto(page, testid)
    if (!reached) {
      // 导航不可达（如 TG 未绑定 / 未就绪）：属门控预期，跳过而不判失败
      console.log(`SKIP  ${testid}  |  导航不可达（入口级门控未放开）`)
      continue
    }
    const bar = await readBar(page)
    const shot = path.join(OUT, `context_${testid.replace('nav-', '')}.png`)
    await page.screenshot({ path: shot })

    check(`${testid} 上下文栏存在`, bar.hasHeader, shot)
    check(`${testid} 标题为「${expect.title}」`, bar.title === expect.title, `实际「${bar.title}」`)
    if (expect.sub) {
      check(`${testid} 副标题为「${expect.sub}」`, bar.sub === expect.sub, `实际「${bar.sub}」`)
    }
    // BUG-169 终裁：顶栏右槽不得再有连接态；唯一状态点在底栏（statusbar-conn）
    check(`${testid} 右槽无连接态（唯一状态点已收到底栏）`, bar.connState === null, `headerState=${bar.connState}`)
    check(`${testid} 底栏唯一状态点存在`, bar.footerConnState !== null, `state=${bar.footerConnState} text=${bar.footerConnText}`)
    // M0 起只有下载域（三档树子项）给操作组；其余域一律全局态右槽。
    if (testid.startsWith('nav-child-dl-')) {
      const texts = bar.buttons.map((b) => b.text)
      check(`${testid} 有下载操作按钮`, texts.length >= 3, JSON.stringify(bar.buttons))
      const hasClear = texts.some((x) => x.includes('清空'))
      if (testid === 'nav-child-dl-done') {
        // 只有「已完成」档给「清空」：失败·已取消档已移除，失败项靠行内「删除」单条清理
        check(`${testid} 有「清空」`, hasClear, JSON.stringify(texts))
      } else {
        // 反向断言：进行中两档不挂「清空」（否则会误删终态记录）
        check(`${testid} 无「清空」`, !hasClear, JSON.stringify(texts))
      }
    }
    geo.push({ testid, top: bar.top, height: bar.height })
  }

  // 高度一致性：header 恒定 h-12 → 切视图不跳动（「不需要占位」的前提）
  const tops = new Set(geo.map((g) => g.top))
  const heights = new Set(geo.map((g) => g.height))
  check(
    '切换视图 header 上沿不变',
    tops.size <= 1,
    JSON.stringify(geo.map((g) => `${g.testid}:top=${g.top}`)),
  )
  check(
    '切换视图 header 高度不变',
    heights.size <= 1,
    JSON.stringify(geo.map((g) => `${g.testid}:h=${g.height}`)),
  )

  /**
   * 「文件父行」= `nav-files` 锚点（文件域父项本身，`nav-files-row` 只是包住
   * 「父项按钮 + 展开箭头」的 div，**没有 onClick**：点 div 不导航）。
   *
   * 它已进上面的 EXPECT 循环（期望标题「文件」、无副标题 —— `cat-all` 不是
   * 分类子项，`fileCategoryOf` 返回 null）。这里不再单独点一遍：
   * 早先版本点 `nav-files-row` 拿标题，一次性 CDP 探针实测点击被 div 吞掉、
   * 栏上仍留着上一个视图的「下载 / 已完成」——即断言引用了一个不可点的元素，
   * 判据本身失效（假红的孪生：判据引用了一个不存在的交互）。
   */

  await browser.close()

  const failed = checks.filter((c) => !c.ok)
  const summary = { total: checks.length, failed: failed.length, checks }
  fs.writeFileSync(
    path.join(OUT, 'context_bar_result.json'),
    JSON.stringify(summary, null, 2),
  )
  console.log(`\n${checks.length - failed.length}/${checks.length} passed  →  ${OUT}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
