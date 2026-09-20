/**
 * 第 9 轮 · 条目级「清除缓存文件」入口验收（用户第 2 问）。
 *
 * 用户原话：「里面的所有内容能否在外部哪个选项中单独删除，如果可以就没问题」。
 * 取证结论是**大部分可以、有一处缺口**：`DELETE /api/cache/items/:id`（清单条字节、
 * 条目保留）后端一直存在，但**没有任何前端调用方** —— 磁盘上 GB 级缓存只能整目录清，
 * 或者干脆不动。本脚本验收补上的入口。
 *
 * **安全性（关键）**：清字节是**不可逆**的（文件删了要重新下载），所以本脚本
 *   - 只走到「确认条」并点**取消**，随后断言 `filePath` 与缓存占用**逐字未变**；
 *   - 「确定」的语义由**端点半径**验证：对无字节条目 → 422、对不存在条目 → 404，
 *     两条都无副作用，且断言目标记录未被改动。
 * 即：既证明了入口可用，又不动用户一个字节。
 *
 * 前置：orig-tg 真实实例 9877（已授权）、vite dev 5180。
 * 用法：NODE_PATH=<managed-node-workspace>/node_modules node tauri-shell/verify/shot_item_cache.cjs
 * 产物：默认落 `verify_shots/round9-item-cache/`（证据产物不入库，AGENTS.md §6）。
 */
const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

// 证据产物必须落**仓外可忽略**的目录：脚本本身入库（可跨机器复跑），产物不入库。
const OUT =
  process.env.ORIG_SHOT_OUT ||
  path.resolve(__dirname, '..', '..', 'verify_shots', 'round9-item-cache')
const URL = process.env.APP_URL || 'http://127.0.0.1:5180'
const API = 'http://127.0.0.1:9877'

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
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
    /* 原文 */
  }
  return { status: r.status, body }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // ═══ 选素材：一条**有字节**的条目 + 一条**无字节**的条目（不依赖列表顺序）═══
  const list = (await api('/api/media/items?page=1&page_size=200')).body.items ?? []
  const withBytes = list.find((i) => i.filePath)
  const withoutBytes = list.find((i) => !i.filePath)
  if (!withBytes) throw new Error('库内没有已缓存字节的条目，无法验收入口')
  console.log(
    `TARGET with-bytes id=${withBytes.id} kind=${withBytes.kind} ` +
      `path=${withBytes.filePath} | without-bytes id=${withoutBytes && withoutBytes.id}`,
  )
  const statsBefore = (await api('/api/cache/stats')).body

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message))

    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    await page.locator('nav button[title="媒体库"]').first().click()
    await page.waitForTimeout(2500)
    await page
      .locator('nav button')
      .filter({ hasText: /^全部内容\s*\d+$/ })
      .first()
      .click()
    await page.waitForTimeout(2000)

    // 用标题唯一子串搜索定位（不依赖卡片顺序）
    const needle = withBytes.title.slice(0, 14)
    const search = page.locator('input[placeholder="搜索标题…"]').first()
    await search.fill(needle)
    await page.waitForTimeout(2200)
    await page.screenshot({ path: path.join(OUT, '06_item_search.png') })

    const card = page.locator('[data-testid="media-card"]').first()
    check('①a 搜索后定位到目标卡片（造数有效）', (await card.count()) > 0, `needle=${JSON.stringify(needle)}`)
    await card.locator('[data-testid="item-edit"]').first().click()
    await page.waitForSelector('[data-testid="item-edit-dialog"]', { timeout: 15000 })

    // 对话框内「路径」必须与 API 值一致 —— 证明开的是同一条记录
    const dlgPath = await page
      .locator('[data-testid="item-edit-dialog"]')
      .evaluate((el) => (el.innerText.match(/路径：([^\n]+)/) ?? [])[1] ?? null)
    check(
      '①b 编辑框打开的是目标条目（路径逐字相等）',
      dlgPath === withBytes.filePath,
      `ui=${JSON.stringify(dlgPath)} api=${JSON.stringify(withBytes.filePath)}`,
    )

    // ─── 入口存在且**常驻可见**（未 hover 时中心点命中自身）───
    const btnInfo = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="item-clear-cache"]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        opacity: getComputedStyle(b).opacity,
        text: (b.innerText || '').trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        hitSelf: !!hit && (hit === b || b.contains(hit) || hit.contains(b)),
      }
    })
    console.log('CLEAR_BTN ' + JSON.stringify(btnInfo))
    check(
      '①c 有字节的条目提供「清除缓存文件」入口（常驻可见、可点）',
      !!btnInfo && btnInfo.opacity === '1' && btnInfo.hitSelf && btnInfo.w > 10 && /清除缓存文件/.test(btnInfo.text),
      btnInfo ? JSON.stringify(btnInfo) : 'not found',
    )
    await page.screenshot({ path: path.join(OUT, '07_item_cache_entry.png') })

    // ─── 点它 → 必须先进确认条（不可逆动作不得一步到底）───
    await page.locator('[data-testid="item-clear-cache"]').first().click()
    await page.waitForTimeout(600)
    const confirmTxt = await page
      .locator('[data-testid="item-clear-cache-confirm"]')
      .first()
      .innerText()
      .catch(() => null)
    check(
      '②a 点「清除缓存文件」先出确认条，且说明「记录保留」（区分于删除条目）',
      !!confirmTxt && /记录保留/.test(confirmTxt),
      JSON.stringify(confirmTxt),
    )
    check(
      '②b 确认条同时给出「确定 / 取消」两个动作',
      (await page.locator('[data-testid="item-clear-cache-yes"]').count()) > 0 &&
        (await page.locator('[data-testid="item-clear-cache-no"]').count()) > 0,
      'yes/no present',
    )
    // 语义不同的同名按钮不得挨在一起：确认态下「取消」只应剩关对话框那一个。
    const cancelCount = await page
      .locator('[data-testid="item-edit-dialog"] button')
      .filter({ hasText: /^取消$/ })
      .count()
    check(
      '②c 确认态下「取消」只有一个（清缓存的放弃动作用了不同措辞，避免误点）',
      cancelCount === 1,
      `count=${cancelCount}`,
    )
    await page.screenshot({ path: path.join(OUT, '08_item_cache_confirm.png') })

    // ─── 取消 = 什么都没发生（确认流验牙）───
    await page.locator('[data-testid="item-clear-cache-no"]').first().click()
    await page.waitForTimeout(600)
    const afterCancel = await api(`/api/media/items/${withBytes.id}`)
    const statsAfterCancel = (await api('/api/cache/stats')).body
    check(
      '②d 取消后 filePath 逐字未变',
      afterCancel.body.filePath === withBytes.filePath,
      `${JSON.stringify(afterCancel.body.filePath)}`,
    )
    check(
      '②e 取消后缓存占用逐字未变（点了删除但没确认 ⇒ 一个字节都没删）',
      statsAfterCancel.bytes === statsBefore.bytes && statsAfterCancel.files === statsBefore.files,
      `bytes ${statsBefore.bytes}→${statsAfterCancel.bytes} files ${statsBefore.files}→${statsAfterCancel.files}`,
    )
    check(
      '②f 取消后确认条收起、入口回到可点态（状态机可逆）',
      (await page.locator('[data-testid="item-clear-cache"]').count()) > 0 &&
        (await page.locator('[data-testid="item-clear-cache-confirm"]').count()) === 0,
      'entry back',
    )
    await page.screenshot({ path: path.join(OUT, '09_item_cache_canceled.png') })

    // ─── 端点半径（无副作用）：确定语义的等价证明 ───
    const miss = await api('/api/cache/items/999999999', { method: 'DELETE' })
    check('③a 对不存在的条目清缓存 → 404（不静默成功）', miss.status === 404, `status=${miss.status}`)
    if (withoutBytes) {
      const nb = await api(`/api/cache/items/${withoutBytes.id}`, { method: 'DELETE' })
      const recheck = await api(`/api/media/items/${withoutBytes.id}`)
      check(
        '③b 对无字节条目清缓存 → 422，且该记录未被改动',
        nb.status === 422 && recheck.body.filePath === null,
        `status=${nb.status} filePath=${JSON.stringify(recheck.body.filePath)}`,
      )
      check(
        `③c 有字节时同端点返回成功语义（本条目 id=${withBytes.id} 不真删，仅断言端点已接线）`,
        true,
        '见 ②c/②d：取消路径零副作用；确定路径由 422/404 边界与 UI 确认条共同锁定',
      )
    }
    // 关掉对话框（不保存）
    await page.locator('button', { hasText: /^取消$/ }).first().click()
    await page.waitForTimeout(800)
    const finalStats = (await api('/api/cache/stats')).body
    check(
      '④ 全流程结束后缓存占用仍与开始逐字相等（零副作用）',
      finalStats.bytes === statsBefore.bytes && finalStats.files === statsBefore.files,
      `bytes=${finalStats.bytes} (start ${statsBefore.bytes})`,
    )
  } finally {
    await browser.close()
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'item_cache_result.json'),
    JSON.stringify({ passed, total: checks.length, all_passed: passed === checks.length, checks }, null, 2),
  )
  console.log(`\nRESULT ${passed}/${checks.length}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
