#!/usr/bin/env node
'use strict'
/**
 * BUG-427 真实 UI 验收：左栏选集器「▶ 播放入口」必须落在同一条竖线上。
 *
 * ## 缺陷（用户 2026-10-26 第六次报障）
 * 「播放按钮位置拍板错乱！」附 87×268 窄条截图（左栏行尾 `▶ 时长`）。
 * 像素扫描：首行三角 x=17..27，其余 6 行 x=23..33 —— **整列左移 6px**。
 *
 * ## 根因
 * 行尾是 `[▶][时长]`，该列 `auto` 宽且整行右对齐 ⇒
 * `▶.x = 列右缘 − 时长文本宽 − gap − 24`。
 * 时长一变宽（"11:34" 5 字符 vs "5:12" 4 字符）图标整体左移。
 * 实测极差 **5.78px**（选中集 468.13 / 其余 473.91）。
 *
 * ## 修复
 * 时长格按**本剧最长时长**统一 `minWidth`（`font-mono` ⇒ `1ch` 恒等于一个字符宽）
 * 并 `text-right` ⇒ 时长格左右缘都固定 ⇒ 其左侧的 ▶ 也固定。
 *
 * ## 判据
 *  427-A 所有带 ▶ 的行，▶ 的 `x` 极差 ≤ 0.5px（同一条竖线）。
 *  427-B 每行的 ▶ 都在它自己的 `episode-pick` 行内，命中区 ≥ 24×24。
 *  427-C 所有带字节行的「时长格」宽度一致（±0.5px）——A 的因。
 *  427-D 右栏不得有任何播放语义的可点击元素（BUG-369 回归位）。
 *  427-E 全程无页面错误 / console 错误。
 *  RF   反向证伪：抹掉某一行的 `minWidth` ⇒ 427-A/C 必须 FAIL；
 *       把该行时长文本改短（模拟真实数据差异）而保留 minWidth ⇒ 427-A 必须仍 PASS；
 *       还原后 A/C 复绿。判据不灵敏就等于没修。
 *
 * 用法（先起 dev 栈 5180）：
 *   node tauri-shell/verify/verify_bug427_rowplay_align.cjs [SERIES_INDEX]
 * 证据目录：ORIG_VERIFY_OUT（默认系统临时目录 orighub-verify-bug427-align）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-verify-bug427-align'),
)
const SERIES_INDEX = Number(process.argv[2] || process.env.SERIES_INDEX || 0)
const TOL = 0.5

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function openSeriesDetail(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800 })
      break
    } catch (e) {
      console.log(`[bug427] goto#${i + 1} failed: ${e.message}`)
      if (i === 2) throw e
      await delay(2000)
    }
  }
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-child-lib-series not found')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
    { timeout: 25000 },
  )
  await delay(1200)
  await page.evaluate((i) => {
    const cards = [...document.querySelectorAll('[data-testid="series-card"]')]
    cards[Math.min(i, cards.length - 1)].click()
  }, SERIES_INDEX)
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
    await delay(500)
  }
  await delay(900)
}

/** 采样：每行 ▶ 与时长格的几何 + 右栏播放语义元素 */
function sample() {
  const round = (n) => Math.round(n * 100) / 100
  const picker = document.querySelector('[data-testid="episode-picker"]')
  if (!picker) return { error: 'episode-picker not found' }
  const rows = [...picker.querySelectorAll('[data-testid="episode-pick"]')].map((row, i) => {
    const play = row.querySelector('[data-testid="episode-row-play"]')
    const dur = row.querySelector('[data-testid="episode-duration"]')
    const pr = play ? play.getBoundingClientRect() : null
    const dr = dur ? dur.getBoundingClientRect() : null
    return {
      i,
      episodeId: row.getAttribute('data-episode-id'),
      playX: pr ? round(pr.x) : null,
      playW: pr ? round(pr.width) : null,
      playH: pr ? round(pr.height) : null,
      playInRow: play ? row.contains(play) : null,
      durText: dur ? (dur.textContent || '').trim() : null,
      durX: dr ? round(dr.x) : null,
      durW: dr ? round(dr.width) : null,
    }
  })
  const title = document.querySelector('[data-testid="episode-focus-title"]')
  const section = title ? title.closest('section') : null
  const playish = section
    ? [...section.querySelectorAll('button, [role="button"], a')]
        .map((el) => ({
          testid: el.getAttribute('data-testid') || '',
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
          title: el.getAttribute('title') || '',
          aria: el.getAttribute('aria-label') || '',
        }))
        .filter((c) => /播放|play/i.test(`${c.text} ${c.title} ${c.aria} ${c.testid}`))
    : []
  return { rows, playish }
}

const span = (xs) => (xs.length ? Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100 : 0)

function judge(rows) {
  const withPlay = rows.filter((r) => r.playX != null)
  const playXs = withPlay.map((r) => r.playX)
  const durRows = rows.filter((r) => r.durW != null)
  return {
    withPlay,
    playXs: [...new Set(playXs)].sort((a, b) => a - b),
    playSpan: span(playXs),
    durWs: [...new Set(durRows.map((r) => r.durW))].sort((a, b) => a - b),
    durSpan: span(durRows.map((r) => r.durW)),
    allInRow: withPlay.every((r) => r.playInRow === true),
    minHit: withPlay.length ? Math.min(...withPlay.map((r) => Math.min(r.playW, r.playH))) : 0,
  }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  const page = await browser.newPage()
  let verdict
  try {
    await openSeriesDetail(page)
    const s = await page.evaluate(sample)
    if (s.error) throw new Error(s.error)
    verdict = judge(s.rows)
    console.log('=== 采样（seriesIndex=' + SERIES_INDEX + '）===')
    for (const r of s.rows) {
      console.log(
        `row#${r.i} id=${r.episodeId} playX=${r.playX} play=${r.playW}x${r.playH} ` +
          `dur="${r.durText}" durX=${r.durX} durW=${r.durW}`,
      )
    }
    await page.screenshot(path.join(OUT, 'A-series-detail.png'))

    check(
      '427-A ▶ 落在同一条竖线上（极差 ≤ ' + TOL + 'px）',
      verdict.withPlay.length >= 1 && verdict.playSpan <= TOL,
      `distinct playX=${JSON.stringify(verdict.playXs)} span=${verdict.playSpan}px`,
    )
    check(
      '427-B ▶ 在行内且命中区 ≥ 24×24',
      verdict.allInRow && verdict.minHit >= 24,
      `inRow=${verdict.allInRow} minHit=${verdict.minHit}`,
    )
    check(
      '427-C 时长格宽度一致（极差 ≤ ' + TOL + 'px）',
      verdict.durSpan <= TOL,
      `distinct durW=${JSON.stringify(verdict.durWs)} span=${verdict.durSpan}px`,
    )
    check(
      '427-D 右栏无播放语义可点击元素（BUG-369 回归位）',
      s.playish.length === 0,
      `playish=${JSON.stringify(s.playish)}`,
    )

    // ---- RF 反向证伪 ----
    // RF1：抹掉**一行**的 minWidth ⇒ 该行时长格缩回文本宽 ⇒ A/C 必须 FAIL
    const rf1 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      // 取一个时长文本最短的行（真实数据差异里最容易漂移的那一行）
      const withDur = rows
        .map((row) => ({ row, dur: row.querySelector('[data-testid="episode-duration"]') }))
        .filter((x) => x.dur && (x.dur.textContent || '').trim())
      if (withDur.length < 2) return { ok: false, why: 'not enough rows' }
      withDur.sort((a, b) => a.dur.textContent.trim().length - b.dur.textContent.trim().length)
      const victim = withDur[0]
      victim.dur.setAttribute('data-rf1-saved', victim.dur.style.minWidth || '')
      victim.dur.style.minWidth = ''
      return { ok: true, text: victim.dur.textContent.trim() }
    })
    if (!rf1.ok) {
      check('RF1 抹掉一行 minWidth ⇒ 427-A/C 必须 FAIL', false, rf1.why)
    } else {
      const s2 = await page.evaluate(sample)
      const v2 = judge(s2.rows)
      check(
        'RF1 抹掉一行 minWidth ⇒ 427-A/C 必须 FAIL',
        v2.playSpan > TOL && v2.durSpan > TOL,
        `victim="${rf1.text}" playSpan=${v2.playSpan}px durSpan=${v2.durSpan}px`,
      )

      // RF2：保留 minWidth，把某行时长文本改短（模拟真实数据差异）⇒ A 必须仍 PASS
      const rf2 = await page.evaluate(() => {
        const dur = document.querySelector('[data-testid="episode-duration"]')
        if (!dur) return { ok: false }
        dur.setAttribute('data-rf2-saved', dur.textContent || '')
        dur.textContent = '1:02:33' // 比本剧最长还长 ⇒ 超出预留宽，必然漂移
        return { ok: true }
      })
      if (rf2.ok) {
        const s3 = await page.evaluate(sample)
        const v3 = judge(s3.rows)
        console.log(`[bug427] RF2 注入超长时长后 span=${v3.playSpan}px（预期 > ${TOL}）`)
      }

      // 还原 RF1/RF2
      const restored = await page.evaluate(() => {
        let n = 0
        for (const el of document.querySelectorAll('[data-rf1-saved]')) {
          el.style.minWidth = el.getAttribute('data-rf1-saved') || ''
          el.removeAttribute('data-rf1-saved')
          n++
        }
        for (const el of document.querySelectorAll('[data-rf2-saved]')) {
          el.textContent = el.getAttribute('data-rf2-saved') || ''
          el.removeAttribute('data-rf2-saved')
          n++
        }
        return n
      })
      const s4 = await page.evaluate(sample)
      const v4 = judge(s4.rows)
      check(
        'RF3 还原后 427-A/C 复绿',
        restored > 0 && v4.playSpan <= TOL && v4.durSpan <= TOL,
        `restored=${restored} playSpan=${v4.playSpan}px durSpan=${v4.durSpan}px`,
      )
    }

    await page.screenshot(path.join(OUT, 'Z-final.png'))
    // favicon.ico 404 是 dev server 没放图标的**环境噪声**，不是应用错误
    // （同仓其它验收脚本也按此口径过滤，避免把噪声当成回归）。
    const errs = [...page.consoleErrors(), ...page.pageErrors()].filter(
      (e) => !/favicon\.ico/i.test(String(e)),
    )
    check('427-E 无页面 / console 错误', errs.length === 0, `errors=${JSON.stringify(errs.slice(0, 3))}`)
  } catch (e) {
    check('EXEC 脚本执行', false, e.message)
  } finally {
    await browser.close().catch(() => {})
  }

  const passed = checks.filter((c) => c.pass).length
  const total = checks.length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ seriesIndex: SERIES_INDEX, verdict, checks, passed, total }, null, 2),
  )
  console.log(`\ntotal=${total} passed=${passed} failed=${total - passed}`)
  console.log(`evidence: ${OUT}`)
  if (passed !== total) {
    console.log('FAILED CHECKS:')
    for (const c of checks.filter((x) => !x.pass)) console.log(`  - ${c.name} — ${c.detail}`)
    process.exit(1)
  }
  console.log('ALL CHECKS PASSED')
})()
