/**
 * 第 9 轮 · 缓存「清理中心」真实渲染验收（BUG-059）。
 *
 * 对应用户原话：「『清除缓存文件』点击不应直接清理，而是选择内容清理。设置模块里面清理需要加强。」
 *
 * 修复语义：这个按钮此前是一个**动作**（点确认就把下载目录内全部缓存字节清光），
 * 粒度只有「全清」与「逐条」两档，中间整层缺失 —— 最危险的档位被直接摆在一个按钮下面。
 * 现在它是一个**入口**：打开清理中心并落在「缓存字节」页签，先给分档预览
 * （条目数 / 字节 / 孤儿 / 外部文件不参与），由用户按档或多选后再执行。
 *
 * 断言（运行期几何 + 真实接口读数）：
 *   ⓪b 判据**未读回**时入口不禁用（延迟预览请求造态，验牙）—— 「未就绪」不谎报「没什么可清」
 *   ① 设置页入口存在，且**禁用状态与「有无可清理内容」一致**
 *   ② 点击后打开清理中心，并**落在「缓存字节」页签**（不再就地清理）
 *   ③ 预览读数与 `/api/cache/stats` 一致；外部文件数如实标注（有则报数、无则不出现）
 *   ④ 分档按钮齐备：全部 / 孤儿 / 陈旧 / 失败残留（各自按可清理量禁用）
 *   ④f-④j 按频道选定：chip 数 = 在库条目频道数、显示频道**标题**（非 `#-100…`）、
 *          点一下即选中该频道全部条目、确认条报数 = 该频道条数、取消不丢选区
 *   ⑤ 点「清空全部」→ 确认条报出 N 与大小 → **取消** → 占用与条目快照逐字未变（验牙）
 *   ⑥ 「任务记录」页签仍在（回归：清理中心没有把时间线挤掉）
 *   ⑦ 端点半径：`?ids=` 空 → 422、`?ids=abc` → 422、越界 id → removed 0
 *
 * 本脚本对真实库只走「取消」路径（清理不可逆）；确定路径的清理语义由隔离实例的
 * `download-engine/verify/verify_cache_scopes.py` 全量验证。
 *
 * 定位约定：一律 `data-testid`。设置页默认落在「下载」页签，清理入口挂在**「常规」**下，
 * 所以进设置页后必须先切页签（`settings-tab-general`），否则入口永远不渲染。
 *
 * 前置：orig-tg 真实实例 9877（已授权）、vite dev 5180。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node tauri-shell/verify/shot_clear_center.cjs
 * 产物：默认落 `verify_shots/round9-clear/`（证据产物不入库，AGENTS.md §6）。
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
  process.env.ORIG_SHOT_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'round9-clear')
const URL = process.env.APP_URL || 'http://127.0.0.1:5180'
const API = 'http://127.0.0.1:9877'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

/** 与前端 `lib/tgmedia.ts::fmtSize` 同规则（>1 位小数取整阈值在 100）。
 *  复刻它是为了让「界面显示值」与「接口字节数」能做**具体值**比对 ——
 *  只断言「有个数字」等于没断言。 */
function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

async function api(pathname, init) {
  const r = await fetch(API + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const txt = await r.text()
  let body = txt
  try {
    body = JSON.parse(txt)
  } catch {
    /* 保持原文 */
  }
  return { status: r.status, body }
}

const stats = async () => (await api('/api/cache/stats')).body
const preview = async () => (await api('/api/cache/clear/preview')).body
const filePaths = async () => {
  const r = await api('/api/media/items?page=1&page_size=500')
  return (r.body.items ?? [])
    .map((i) => `${i.id}:${i.filePath ?? ''}`)
    .sort()
    .join('|')
}

/** 运行期几何：可见性 + 中心点命中自身。 */
async function geometry(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      found: true,
      opacity: cs.opacity,
      w: r.width,
      h: r.height,
      hitSelf: !!top && (el === top || el.contains(top)),
      hitTag: top ? `${top.tagName}.${String(top.className).slice(0, 30)}` : null,
      text: el.innerText.replace(/\s+/g, ' ').trim(),
    }
  }, selector)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const st0 = await stats()
  const pv0 = await preview()
  const clearable = (pv0.total?.count ?? 0) + (pv0.orphan?.count ?? 0)
  const paths0 = await filePaths()
  console.log(
    `CACHE: files=${st0.files} bytes=${st0.bytes} external=${st0.external} ` +
      `clearable=${clearable} orphan=${pv0.orphan?.count}`,
  )

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    // 进设置页。两个坑都在这里（首版就在此 FATAL）：
    // 1) 定位用 `data-testid` —— `nav button[title=…]` 既依赖翻译文案，又会命中**设置页自身的
    //    aside>nav**（它也渲染「常规/下载/…」按钮），是不同的导航层；
    // 2) 设置页默认落在**「下载」页签**，而清理入口挂在**「常规」**下 —— 不切页签就永远等不到它。
    const entry = page.locator('[data-testid="clear-cache-files"]').first()
    const usage = page.locator('[data-testid="clear-cache-usage"]').first()
    const tabGeneral = page.locator('[data-testid="settings-tab-general"]').first()

    /** 进设置页 → 切到「常规」。`delayPreview` > 0 时把预览请求卡住，用于造「判据未就绪」态。 */
    const openSettings = async (delayPreview = 0) => {
      if (delayPreview > 0) {
        await page.route('**/api/cache/clear/preview**', async (route) => {
          await new Promise((r) => setTimeout(r, delayPreview))
          await route.continue()
        })
      }
      await page.locator('[data-testid="nav-settings"]').first().click()
      await tabGeneral.waitFor({ timeout: 15000 })
      await tabGeneral.click()
    }

    // ─────────── ⓪b 判据**未就绪**时不得禁用（验牙：预览请求延后 3s）───────────
    // 「未就绪」与「无可清」都是点不了，但含义相反：前者读数是「正在读取占用…」，
    // 此时挂灰按钮 = 谎报「没什么可清」。转瞬即逝，却正是用户进设置页看到的第一帧。
    await openSettings(3000)
    await page.waitForTimeout(700)
    const loadingText = (await usage.innerText()).replace(/\s+/g, ' ')
    const loadingDisabled = await entry.isDisabled()
    check(
      '⓪b 判据未读完（读数仍是「正在读取占用…」）时入口不禁用 —— 不谎报「没什么可清」',
      !/\d/.test(loadingText) && loadingDisabled === false,
      `text="${loadingText}" disabled=${loadingDisabled}`,
    )
    await page.waitForTimeout(2400) // 让被延后的那次请求自然走完，再撤掉拦截
    await page.unroute('**/api/cache/clear/preview**')
    // 离开设置页再回来，强制重挂载。用「媒体库」而不是「全部文件」：后者是
    // 「一个视觉单元、两个独立动作」（chevron 管子菜单、文字管切视图），点中心可能落在 chevron 上。
    await page.locator('[data-testid="nav-media"]').first().click()
    await page.waitForTimeout(600)

    await openSettings()
    // 等判据**读回来**再量几何：占用读数出现数字（「正在读取占用…」无数字）。
    // 不等就会抓在 200ms 的 `transition-all` 中间帧上，量到 `disabled:opacity-50` 的
    // 半透明状态 —— 首版 ①a 的假失败正是此因（禁用态在判据读回后本就应消失）。
    await page.waitForFunction(
      () => /\d/.test(document.querySelector('[data-testid="clear-cache-usage"]')?.innerText ?? ''),
      null,
      { timeout: 10000 },
    )
    const generalClass = (await tabGeneral.getAttribute('class')) || ''
    check(
      '⓪ 已进入设置页的「常规」页签（清理入口所在页签，激活态）',
      /accent/.test(generalClass),
      `class="${generalClass.slice(0, 40)}"`,
    )

    await entry.waitFor({ timeout: 15000 })
    await page.screenshot({ path: path.join(OUT, '01_settings.png') })

    // ─────────── ① 入口存在 + 禁用状态与可清理量一致 ───────────
    const entryGeom = await geometry(page, '[data-testid="clear-cache-files"]')
    check(
      '①a 设置页入口可见（几何：opacity=1 + 尺寸>0 + 命中自身）',
      entryGeom.found && entryGeom.opacity === '1' && entryGeom.w > 0 && entryGeom.h > 0 && entryGeom.hitSelf,
      `opacity=${entryGeom.opacity} hit=${entryGeom.hitTag}`,
    )
    const entryDisabled = await entry.first().isDisabled()
    check(
      '①b 入口禁用状态 = 「无可清理内容」判据（缓存条目+孤儿）',
      entryDisabled === (clearable === 0),
      `disabled=${entryDisabled} clearable=${clearable}（stats.files=${st0.files} orphan=${pv0.orphan?.count}）`,
    )
    const usageText = await page.locator('[data-testid="clear-cache-usage"]').first().innerText()
    check(
      '①c 占用读数与后端逐字一致（含文件数）',
      usageText.includes(String(st0.files)),
      `ui="${usageText.replace(/\s+/g, ' ')}" api.files=${st0.files}`,
    )
    // ①c-2 孤儿字节必须**单独报出且数值相符**：`stats.bytes` 只统计条目背书的字节，
    // 孤儿（磁盘有、库里无）不在其中 —— 漏报就是读数低估，会让用户以为「才 850 MB」
    // 而错过 1.1 GB 可清理字节。
    const orphanHint = page.locator('[data-testid="clear-cache-orphan-hint"]')
    const orphanN = await orphanHint.count()
    const orphanText =
      orphanN > 0 ? (await orphanHint.first().innerText()).replace(/\s+/g, ' ').trim() : ''
    const orphanBytes = pv0.orphan?.bytes ?? 0
    check(
      '①c-2 孤儿字节在入口读数里单独报出，数值与接口逐字相符（为 0 时不出现）',
      orphanBytes > 0
        ? orphanN > 0 && orphanText.includes(fmtSize(orphanBytes))
        : orphanN === 0,
      `api.orphan=${orphanBytes}（期望显示 “${fmtSize(orphanBytes)}”）ui="${orphanText}"`,
    )

    if (clearable === 0) {
      check('①d 无可清理内容时点击不打开面板', true, 'clearable=0，跳过点击断言')
      await page.screenshot({ path: path.join(OUT, '02_final.png'), fullPage: true })
    } else {
      // ─────────── ② 点击 = 打开清理中心（不再就地清理）───────────
      await entry.first().click()
      await page.waitForTimeout(1800)
      const manager = await page.locator('[data-testid="cache-manager"]').count()
      check('②a 点击入口打开了清理中心（不再 window.confirm 直接清）', manager > 0, `count=${manager}`)

      const tabBytes = await page.locator('[data-testid="cache-tab-bytes"]').first()
      const tabTasks = await page.locator('[data-testid="cache-tab-tasks"]').first()
      const bytesClass = (await tabBytes.getAttribute('class')) || ''
      const previewVisible = (await page.locator('[data-testid="cache-bytes-preview"]').count()) > 0
      check(
        '②b 落在「缓存字节」页签（激活态 + 预览已渲染）',
        /accent/.test(bytesClass) && previewVisible,
        `class="${bytesClass.slice(0, 40)}" preview=${previewVisible}`,
      )
      const tabsGeom = await geometry(page, '[data-testid="cache-tab-bytes"]')
      check('②c 页签可点（几何命中自身）', tabsGeom.hitSelf, `hit=${tabsGeom.hitTag}`)
      await page.screenshot({ path: path.join(OUT, '03_bytes_tab.png') })

      // ─────────── ③ 预览读数与后端一致 ───────────
      const previewText = await page.locator('[data-testid="cache-bytes-preview"]').first().innerText()
      const m = previewText.match(/(\d+)\s*条/)
      check(
        '③a 预览条目数与 /api/cache/stats 的 files 逐字一致',
        !!m && Number(m[1]) === st0.files,
        `ui="${previewText.replace(/\s+/g, ' ')}" api.files=${st0.files}`,
      )
      const staleText = await page.locator('[data-testid="cache-bytes-stale"]').first().innerText()
      check(
        '③b 陈旧档读数如实（含阈值天数与条数）',
        /\d/.test(staleText) && /30/.test(staleText),
        `"${staleText.replace(/\s+/g, ' ')}"`,
      )
      const extRows = await page.locator('[data-testid="cache-bytes-external"]').count()
      const extText = extRows > 0 ? await page.locator('[data-testid="cache-bytes-external"]').first().innerText() : ''
      check(
        '③c 外部文件数如实（有则报数、无则不出现）',
        st0.external > 0 ? extRows > 0 && extText.includes(String(st0.external)) : extRows === 0,
        `api.external=${st0.external} ui="${extText.replace(/\s+/g, ' ')}" rows=${extRows}`,
      )

      // ─────────── ④ 分档按钮齐备且按可清理量禁用 ───────────
      for (const [tid, label] of [
        ['cache-bytes-clear-all', '全部'],
        ['cache-bytes-clear-orphan', '孤儿'],
        ['cache-bytes-clear-stale', '陈旧'],
        ['cache-bytes-clear-failed', '失败残留'],
      ]) {
        const loc = page.locator(`[data-testid="${tid}"]`)
        const n = await loc.count()
        const d = n > 0 ? await loc.first().isDisabled() : null
        check(`④ ${label}档按钮存在且可见`, n > 0, `count=${n} disabled=${d}`)
      }
      const orphanDisabled = await page.locator('[data-testid="cache-bytes-clear-orphan"]').first().isDisabled()
      check(
        '④e 孤儿为 0 时「清理孤儿」按钮禁用（不做无意义动作）',
        orphanDisabled === ((pv0.orphan?.count ?? 0) === 0),
        `disabled=${orphanDisabled} orphan=${pv0.orphan?.count}`,
      )

      // ─────────── ④f 按频道选定（「只清这个频道」= 一次点击，不是手点 N 次）───────────
      // 频道归属已在预览明细里（每条带 chatId），所以这里**只走勾选通道**（`?ids=`）——
      // 不新增清理档、不扩大危险半径；顺带验频道标题是否真的透传（否则静默退化成 `#-100…`）。
      const inside = (pv0.items ?? []).filter((x) => x.inside)
      const chatIds = [...new Set(inside.map((x) => x.chatId))]
      const chips = await page.locator('[data-testid^="cache-bytes-chat-"]').count()
      check(
        '④f 按频道 chip 数 = 在库条目涉及的频道数（1 个频道时与「全选」等价，故不出现）',
        chips === (chatIds.length > 1 ? chatIds.length : 0),
        `chips=${chips} chats=${chatIds.length}`,
      )

      const titles = new Map()
      try {
        const d = await api('/api/tg/dialogs?limit=200&offset=0')
        for (const c of d.body?.items ?? d.body?.dialogs ?? []) titles.set(c.id, c.title)
      } catch {
        /* 拿不到标题就退化为 `#id` 断言 */
      }

      if (chips > 0) {
        const target = chatIds
          .map((id) => ({ id, n: inside.filter((x) => x.chatId === id).length }))
          .sort((a, b) => b.n - a.n)[0]
        const chip = page.locator(`[data-testid="cache-bytes-chat-${target.id}"]`).first()
        // 标题是**异步**来的（对话框自己在没有 hosts 频道列表时翻页拉取）：等它收敛，
        // 最多 8s；届时仍停在 `#id` 才算失败 —— 断言不变（必须显示标题），只是不抓中间帧。
        await page
          .waitForFunction(
            (sel) => {
              const el = document.querySelector(sel)
              return !!el && !el.innerText.trim().startsWith('#')
            },
            `[data-testid="cache-bytes-chat-${target.id}"]`,
            { timeout: 8000 },
          )
          .catch(() => {})
        const chipText = (await chip.innerText()).replace(/\s+/g, ' ')
        const want = titles.get(target.id)
        check(
          '④g 频道 chip 显示**频道标题**（不是 `#-100…` 数字）—— 标题透传链路有效',
          want ? chipText.includes(want) : chipText.includes(`#${target.id}`),
          `"${chipText}" title=${JSON.stringify(want)}`,
        )

        await chip.click()
        await page.waitForTimeout(500)
        const selText = await page
          .locator('[data-testid="cache-bytes-selected-count"]')
          .first()
          .innerText()
        const sm = selText.match(/(\d+)/)
        check(
          '④h 点频道 chip → 勾选数 = **该频道**在库条目数（不多选别的频道）',
          !!sm && Number(sm[1]) === target.n,
          `ui="${selText}" expect=${target.n} chat=${target.id}`,
        )

        await page.locator('[data-testid="cache-bytes-clear-selected"]').first().click()
        await page.waitForTimeout(500)
        const cText = await page
          .locator('[data-testid="cache-bytes-confirm"]')
          .first()
          .innerText()
        const cM = cText.match(/(\d+)\s*个缓存文件/)
        check(
          '④i 按频道清理的确认条报数 = 该频道条数（影响面如实，不是全库数）',
          !!cM && Number(cM[1]) === target.n,
          `"${cText.replace(/\s+/g, ' ').slice(0, 70)}" expect=${target.n}`,
        )
        await page.screenshot({ path: path.join(OUT, '03b_chat_select.png') })

        await page.locator('[data-testid="cache-bytes-confirm-no"]').first().click()
        await page.waitForTimeout(500)
        const selAfter = await page
          .locator('[data-testid="cache-bytes-selected-count"]')
          .first()
          .innerText()
        const sm2 = selAfter.match(/(\d+)/)
        check(
          '④j 取消确认**不丢选区**（选区是用户的工作成果，确认条只是最后一道闸）',
          !!sm2 && Number(sm2[1]) === target.n,
          `ui="${selAfter}" expect=${target.n}`,
        )
      }

      // ─────────── ⑤ 全清 → 确认条 → 取消（验牙）───────────
      await page.locator('[data-testid="cache-bytes-clear-all"]').first().click()
      await page.waitForTimeout(600)
      const confirmCount = await page.locator('[data-testid="cache-bytes-confirm"]').count()
      const confirmText = confirmCount > 0 ? await page.locator('[data-testid="cache-bytes-confirm"]').first().innerText() : ''
      check('⑤a 点全清 → 出现确认条（不是立刻执行）', confirmCount > 0, `count=${confirmCount}`)
      const cm = confirmText.match(/(\d+)\s*个缓存文件/)
      check(
        '⑤b 确认条报出将清理的文件数（= 预览条目数）',
        !!cm && Number(cm[1]) === st0.files,
        `"${confirmText.replace(/\s+/g, ' ').slice(0, 80)}" api.files=${st0.files}`,
      )
      await page.screenshot({ path: path.join(OUT, '04_confirm_all.png') })

      const stBefore = await stats()
      const pathsBefore = await filePaths()
      await page.locator('[data-testid="cache-bytes-confirm-no"]').first().click()
      await page.waitForTimeout(900)
      const stAfter = await stats()
      const pathsAfter = await filePaths()
      check(
        '⑤c 取消后：占用读数逐字未变（验牙）',
        JSON.stringify(stBefore) === JSON.stringify(stAfter),
        `before=${JSON.stringify(stBefore)} after=${JSON.stringify(stAfter)}`,
      )
      check(
        '⑤d 取消后：条目 filePath 快照逐字未变（没删任何字节）',
        pathsBefore === pathsAfter,
        `changed=${pathsBefore.length !== pathsAfter.length}`,
      )
      check('⑤e 取消后确认条已关闭', (await page.locator('[data-testid="cache-bytes-confirm"]').count()) === 0)

      // ─────────── ⑥ 任务记录页签回归 ───────────
      await tabTasks.click()
      await page.waitForTimeout(1200)
      const tasksUi = await page.locator('[data-testid="cache-select-all"]').count()
      const scopeTabs = await page.locator('[data-testid="cache-scope-all"]').count()
      check(
        '⑥a 切回「任务记录」页签：时间线仍在（全选 + 筛选档都在）',
        tasksUi > 0 && scopeTabs > 0,
        `selectAll=${tasksUi} scopeAll=${scopeTabs}`,
      )
      await page.screenshot({ path: path.join(OUT, '05_tasks_tab.png') })

      await page.locator('[data-testid="cache-close"]').first().click()
      await page.waitForTimeout(800)
    }

    // ─────────── ⑦ 端点半径（只走无害路径）───────────
    const bad1 = await api('/api/cache/clear?ids=', { method: 'POST' })
    check('⑦a `?ids=` 空 → 422（没选东西不能当成全清）', bad1.status === 422, `status=${bad1.status}`)
    const bad2 = await api('/api/cache/clear?ids=abc', { method: 'POST' })
    check('⑦b `?ids=abc` → 422（非法项不得静默跳过）', bad2.status === 422, `status=${bad2.status}`)
    const bad3 = await api('/api/cache/clear?ids=999999999', { method: 'POST' })
    check(
      '⑦c 越界 id → 200 且 removed=0（不误伤）',
      bad3.status === 200 && bad3.body.removed === 0,
      `status=${bad3.status} body=${JSON.stringify(bad3.body)}`,
    )
    const bad4 = await api('/api/cache/clear?scope=everything', { method: 'POST' })
    check('⑦d 未知 scope → 422（不得回落到全清）', bad4.status === 422, `status=${bad4.status}`)

    const stEnd = await stats()
    const pathsEnd = await filePaths()
    check(
      '⑦e 全程占用与条目 filePath 逐字未变（零副作用）',
      JSON.stringify(stEnd) === JSON.stringify(st0) && pathsEnd === paths0,
      `stats=${JSON.stringify(stEnd)}`,
    )

    await page.screenshot({ path: path.join(OUT, '06_final.png'), fullPage: true })
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.ok)
  const report = {
    all_passed: failed.length === 0,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.map((c) => c.name),
    cache: { files: st0.files, bytes: st0.bytes, external: st0.external, clearable },
    checks,
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`\nRESULT: ${report.passed}/${report.total} passed`)
  console.log('OUT=' + OUT)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  process.exit(2)
})
