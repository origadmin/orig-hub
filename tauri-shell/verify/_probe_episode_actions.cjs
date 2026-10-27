#!/usr/bin/env node
'use strict'
/**
 * BUG-476c 取证：右栏「本集动作区」重排后的真实渲染几何 + 截图。
 *
 * 背景（用户 2026-10-28）：上一版把 7 颗按钮塞进 2 列网格，奇偶填充断行错位、
 * 导航/排序/编辑混排 —— 用户判「更混乱了」。本轮重排为三层（主操作/工具带/危险）
 * 并撤销与编辑面板重复的独立挂图按钮。本脚本只取证不修改：
 *   A. 动作区每颗按钮的 text / rect / 是否同处一行（行分组事实）；
 *   B. 全页截图（滚动到动作区可见）。
 *
 * 用法：node tauri-shell/verify/_probe_episode_actions.cjs [SERIES_ID] [EPISODE_ROW]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-probe-episode-actions'),
)
const SERIES_ID = process.argv[2] ? Number(process.argv[2]) : null
const EPISODE_ROW = Number(process.argv[3] || process.env.EPISODE_ROW || 0)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function openSeriesDetail(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(APP_URL, { waitForRoot: true, settleMs: 1800, timeout: 90000 })
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-child-lib-series"]')
      if (!el) return false
      el.click()
      return true
    })
    if (!ok) {
      await delay(2000)
      continue
    }
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="series-card"]').length > 0,
        { timeout: 25000 },
      )
    } catch {
      await delay(2000)
      continue
    }
    await delay(1000)
    const clicked = await page.evaluate((sid) => {
      const sel = sid
        ? `[data-testid="series-card"][data-series-id="${sid}"]`
        : '[data-testid="series-card"]'
      const card = document.querySelector(sel)
      if (!card) return false
      card.click()
      return card.getAttribute('data-series-id')
    }, SERIES_ID)
    if (!clicked) {
      console.log(`[actions-probe] attempt#${attempt + 1}: series card not found`)
      await delay(1500)
      continue
    }
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-focus-title"]'))) break
      await delay(500)
    }
    const inDetail = await page.evaluate(
      () => !!document.querySelector('[data-testid="episode-focus-title"]'),
    )
    if (!inDetail) {
      console.log(`[actions-probe] attempt#${attempt + 1}: detail pane not opened`)
      await delay(1500)
      continue
    }
    console.log(`[actions-probe] opened series ${clicked}`)
    await delay(900)
    return
  }
  throw new Error('series detail not reachable')
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await openSeriesDetail(page)

    // 选中一集（第 EPISODE_ROW 行），等动作区渲染
    const picked = await page.evaluate((row) => {
      const rows = [...document.querySelectorAll('[data-testid="episode-pick"]')]
      if (!rows[row]) return null
      rows[row].click()
      return row
    }, EPISODE_ROW)
    if (picked == null) throw new Error(`episode row ${EPISODE_ROW} not found`)
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => !!document.querySelector('[data-testid="episode-action-secondary"]'))) break
      await delay(500)
    }
    await delay(800)

    // A1. 左栏剧集动作几何（BUG-486 后 IA）：播放=选集器列表下方、编辑=介绍块小字钮
    //     （标题行孤框已撤）、安静行=合并/拆分/删除、卡片级导出/标签入口应不存在 ⇒ 页级探测
    const series = await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="series-actions"]')
      const cover = document.querySelector('[data-testid="series-cover"]')
      const picker = document.querySelector('[data-testid="episode-picker"]')
      const title = document.querySelector('[data-testid="series-title"]')
      const zr = zone ? zone.getBoundingClientRect() : null
      const g = (tid) => {
        const b = document.querySelector(`[data-testid="${tid}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      }
      return {
        zoneW: zr ? Math.round(zr.width) : 0,
        zoneY: zr ? Math.round(zr.y) : null,
        coverRect: cover
          ? (({ x, y, w, h }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }))(cover.getBoundingClientRect())
          : null,
        pickerBottom: picker ? Math.round(picker.getBoundingClientRect().bottom) : null,
        titleRect: title
          ? (({ x, y, w, h }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }))(title.getBoundingClientRect())
          : null,
        play: g('series-play-all'),
        edit: g('series-desc-edit'),
        editOrphan: g('series-edit'),
        merge: g('series-merge'),
        split: g('series-split'),
        del: g('series-delete'),
        exportBtn: !!document.querySelector('[data-testid="series-export"]'),
        tagEdit: !!document.querySelector('[data-testid="series-tag-edit"]'),
      }
    })

    // A2. 右栏动作区几何：全部工具带一行（编辑不再独占全宽）
    const probe = await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="episode-action-secondary"]')
      if (!zone) return null
      const zr = zone.getBoundingClientRect()
      const buttons = [...zone.querySelectorAll('button')]
        .map((b) => {
          const r = b.getBoundingClientRect()
          return {
            testid: b.getAttribute('data-testid') || '',
            text: (b.textContent || '').trim().slice(0, 20),
            x: Math.round(r.x - zr.x),
            y: Math.round(r.y - zr.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          }
        })
      // 行聚类：y 中心差 < 10px 视为同一行
      const rows = []
      for (const b of buttons) {
        const cy = b.y + b.h / 2
        const row = rows.find((r) => Math.abs(r.cy - cy) < 10)
        if (row) {
          row.items.push(b)
          row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length
        } else {
          rows.push({ cy, items: [b] })
        }
      }
      return {
        zoneSize: { w: Math.round(zr.width), h: Math.round(zr.height) },
        buttonCount: buttons.length,
        rows: rows.map((r, i) => ({
          row: i + 1,
          buttons: r.items.map((b) => `${b.testid}(${b.text}) x=${b.x} w=${b.w}`),
        })),
      }
    })
    console.log('[actions-probe] geometry:', JSON.stringify(probe, null, 1))

    // B. 滚动到动作区可见并截图
    await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="episode-action-secondary"]')
      if (zone) zone.scrollIntoView({ block: 'center' })
    })
    await delay(600)
    const shotPath = path.join(OUT, 'episode-actions-after.png')
    await page.screenshot(shotPath)
    console.log(`[actions-probe] screenshot -> ${shotPath}`)

    // C. 断言（取证即验收，直接给 PASS/FAIL，不做恒绿）：
    const checks = []
    const flat = probe ? probe.rows.flatMap((r) => r.buttons) : []
    const joined = flat.join('\n')
    // 行分布：主操作行 1（编辑），工具带行 2（goto/move）
    const rowOf = (tid) => {
      const rowsArr = (probe && probe.rows) || []
      return rowsArr.filter((r) => r.buttons.some((b) => b.startsWith(tid + '('))).map((r) => r.row)
    }
    const editRow = rowOf('episode-edit')
    const gotoRow = rowOf('episode-goto-item')
    const upRow = rowOf('episode-move-up')
    const downRow = rowOf('episode-move-down')
    // 右栏：编辑本集不再独占全宽 —— 与查看内容/上移/下移同处一条工具带
    checks.push([`右栏编辑并入工具带 (edit=${editRow} goto=${gotoRow} up=${upRow} down=${downRow})`,
      editRow.length === 1 && gotoRow.length === 1 && upRow.length === 1 && downRow.length === 1
      && editRow[0] === gotoRow[0] && gotoRow[0] === upRow[0] && upRow[0] === downRow[0]])
    checks.push(['挂图独立按钮已撤销', !joined.includes('episode-attach-images')])
    // BUG-486：移除本集并入工具带行（与 move-down 同行），不再 w-full 独占一行
    const removeRow = rowOf('episode-remove')
    checks.push([`移除本集并入工具带行 (remove=${removeRow} down=${downRow})`,
      removeRow.length === 1 && downRow.length === 1 && removeRow[0] === downRow[0]])
    // 左栏（BUG-486 后 IA）：播放=选集器列表下方（非封面覆盖）；编辑=介绍块小字钮；
    // 卡片底部安静行 = 合并/拆分/删除 同行；导出/标签入口已拆除
    if (series) {
      const quiet = [series.merge, series.split, series.del]
      checks.push(['播放钮在选集器下方且非覆盖形态（y > picker 底部、h ≤ 32 非圆钮）',
        !!series.play && series.pickerBottom != null && series.play.y >= series.pickerBottom - 2 && series.play.h <= 32])
      checks.push([`左栏底部安静行同处一行 (y=${quiet.map((b) => (b ? b.y : 'missing')).join('/')})`,
        quiet.every(Boolean) && quiet.every((b) => Math.abs(b.y - quiet[0].y) <= 10)])
      checks.push(['左栏删除为行内安静形态（宽度 <70% 动作区）',
        !!series.del && series.del.w < series.zoneW * 0.7])
      checks.push(['标题行无孤框编辑钮（series-edit 不存在）', !series.editOrphan])
      checks.push(['介绍块编辑入口存在（series-desc-edit）', !!series.edit])
      checks.push(['卡片级导出入口已拆除', !series.exportBtn])
      checks.push(['卡片级标签入口已拆除', !series.tagEdit])
    } else {
      checks.push(['左栏 series-actions 探到', false])
    }
    checks.push([`查看内容/上移/下移同处工具带行 (${gotoRow}/${upRow}/${downRow})`,
      gotoRow.length === 1 && upRow.length === 1 && downRow.length === 1 && gotoRow[0] === upRow[0] && upRow[0] === downRow[0]])
    let fails = 0
    for (const [name, ok] of checks) {
      console.log(`[actions-probe] ${ok ? 'PASS' : 'FAIL'}: ${name}`)
      if (!ok) fails++
    }
    console.log(`[actions-probe] summary: ${checks.length - fails}/${checks.length} PASS`)
    fs.writeFileSync(path.join(OUT, 'probe-result.json'), JSON.stringify({ series, probe, checks }, null, 2))
    process.exitCode = fails === 0 ? 0 : 1
  } finally {
    await browser.close()
  }
})().catch((e) => {
  console.error('[actions-probe] fatal:', e && e.message)
  process.exitCode = 2
})
