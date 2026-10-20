#!/usr/bin/env node
'use strict'
/**
 * BUG-351 验收：TG 链路自愈历史**在界面上可见**（关于页不再恒绿）。
 *
 * 用户报障（2026-10-21）：「tg 莫名挂了，另一个好的。但是关于中两个状态都是好的。」
 * 实测 daemon 日志 477 次 `link is down → restart`（每 5 分钟一次），而界面只有瞬时
 * `tg_running`，于是关于页两个绿点照常亮。
 *
 * 判据（真实运行栈 5180/19786/19787）：
 *   L1 `/api/config` 下发 `tg_link`（link_down/down_streak/confirms_required/
 *      restarts/last_restart_at/reason），且阈值不低于 2（连续确认）；
 *   L2 健康态（restarts=0、link_down=false）⇒ 状态点绿、无重启条（**反向验牙**：
 *      没有重启事实就不该凭空报警）；
 *   L3 注入 restarts>0 ⇒ 关于页出现 `about-tg-restarts` 且文案含次数与时间，
 *      状态点转琥珀（bg-warning）——「最近重启过」第一次可见；
 *   L4 注入 link_down=true ⇒ 状态点非绿 + 状态文案为「链路不可用」；
 *   L5 无页面错误。
 *
 * 用法::
 *   node _probe_bug351_link_restarts.cjs
 * Exit: 0 = 全 PASS；1 = 有 FAIL
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const cdp = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.DAEMON_URL || 'http://127.0.0.1:19786'
const OUT_DIR =
  process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-bug351-verify')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const assert = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail == null ? '' : '  — ' + detail}`)
}

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })

async function gotoWithRetry(page, url) {
  // vite 文件变更后首次整页加载可 >30s（已知坑）：带重试 + readyState 打印
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitForRoot: true, settleMs: 1500 })
      return
    } catch (e) {
      const rs = await page.evaluate(() => document.readyState).catch(() => 'n/a')
      console.log(`[bug351] goto attempt#${i + 1} failed (${e.message}); readyState=${rs}`)
      if (i === 2) throw e
      await delay(2000)
    }
  }
}

async function openAbout(page) {
  await gotoWithRetry(page, APP_URL)
  const navOk = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-settings"]')
    if (!el) return false
    el.click()
    return true
  })
  if (!navOk) throw new Error('nav-settings not found')
  // 设置页默认落在「常规」分区：必须切到「关于」才有 TG 卡
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="settings-tab-about"]'),
    { timeout: 20000 },
  )
  await page.evaluate(() => {
    document.querySelector('[data-testid="settings-tab-about"]').click()
  })
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="about-tg"]'),
    { timeout: 20000 },
  )
  await delay(600)
}

/** 读关于页 TG 卡的可见事实 */
const readCard = () =>
  ({
    dot: (() => {
      const d = document.querySelector('[data-testid="about-tg-dot"]')
      if (!d) return null
      const cs = getComputedStyle(d)
      return { cls: d.className, bg: cs.backgroundColor }
    })(),
    status: (() => {
      const s = document.querySelector('[data-testid="about-tg-status"]')
      return s ? s.textContent.trim() : null
    })(),
    restarts: (() => {
      const r = document.querySelector('[data-testid="about-tg-restarts"]')
      return r ? r.textContent.trim() : null
    })(),
  })

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()

    // ---- L1：引擎下发 tg_link ----
    const cfg = await getJson(`${DAEMON}/api/config`)
    const link = cfg.tg_link
    const l1 =
      !!link &&
      typeof link.link_down === 'boolean' &&
      typeof link.down_streak === 'number' &&
      typeof link.restarts === 'number' &&
      'last_restart_at' in link &&
      link.confirms_required >= 2
    assert(
      'L1 /api/config 下发 tg_link（含重启历史与连续确认阈值）',
      l1,
      JSON.stringify(link),
    )

    await openAbout(page)

    // ---- L2：健康态 ⇒ 绿点、无重启条（反向验牙）----
    const healthy = await page.evaluate(readCardFn)
    const l2 =
      healthy.dot != null &&
      !/warning|danger/.test(healthy.dot.cls) &&
      healthy.restarts == null
    assert(
      'L2 健康态：状态点绿 + 无重启条（没有事实就不报警）',
      l2,
      JSON.stringify(healthy),
    )

    // ---- L3：注入 restarts>0 ⇒ 重启历史可见 + 状态点转琥珀 ----
    await page.evaluate(() => {
      const store = window.__origStore
      if (!store) throw new Error('dev store hook missing')
      const svc = store.getState().tgService
      store.setState({
        tgService: {
          ...svc,
          link: {
            link_down: false,
            down_streak: 0,
            confirms_required: 3,
            restarts: 7,
            last_restart_at: Math.floor(Date.now() / 1000) - 120,
            reason: 'telegram link unavailable',
          },
        },
      })
    })
    await delay(700)
    const withRestarts = await page.evaluate(readCardFn)
    const l3 =
      withRestarts.restarts != null &&
      /7/.test(withRestarts.restarts) &&
      /warning/.test(withRestarts.dot ? withRestarts.dot.cls : '')
    assert(
      'L3 注入 7 次重启 ⇒ 关于页直出「重启 7 次」+ 状态点转琥珀',
      l3,
      JSON.stringify(withRestarts),
    )
    const shot = path.join(OUT_DIR, 'bug351-about-tg-restarts.png')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="about-tg"]')
      el?.scrollIntoView({ block: 'center' })
    })
    await delay(300)
    await page.screenshot(shot)
    console.log('[bug351] shot ->', shot)

    // ---- L4：注入 link_down ⇒ 状态点非绿 + 文案「链路不可用」----
    await page.evaluate(() => {
      const store = window.__origStore
      const svc = store.getState().tgService
      store.setState({
        tgService: {
          ...svc,
          link: {
            link_down: true,
            down_streak: 2,
            confirms_required: 3,
            restarts: 7,
            last_restart_at: Math.floor(Date.now() / 1000) - 30,
            reason: 'telegram link unavailable',
          },
        },
      })
    })
    await delay(700)
    const down = await page.evaluate(readCardFn)
    const l4 =
      down.dot != null &&
      /warning|danger/.test(down.dot.cls) &&
      !!down.status &&
      /链路不可用/.test(down.status)
    assert(
      'L4 链路 down ⇒ 状态点非绿 + 状态文案「链路不可用」',
      l4,
      JSON.stringify(down),
    )

    // ---- L5：无页面错误 ----
    const errs = page.pageErrors().slice(0, 5)
    assert('L5 无未捕获页面错误', errs.length === 0, JSON.stringify(errs))

    await browser.close()
    const fails = results.filter((r) => !r.ok)
    console.log(`\n[bug351] ${results.length - fails.length}/${results.length} PASS`)
    if (fails.length > 0) process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

function readCardFn() {
  const dotEl = document.querySelector('[data-testid="about-tg-dot"]')
  const statusEl = document.querySelector('[data-testid="about-tg-status"]')
  const restartsEl = document.querySelector('[data-testid="about-tg-restarts"]')
  return {
    dot: dotEl
      ? { cls: dotEl.className, bg: getComputedStyle(dotEl).backgroundColor }
      : null,
    status: statusEl ? statusEl.textContent.trim() : null,
    restarts: restartsEl ? restartsEl.textContent.trim() : null,
  }
}

main().catch((e) => {
  console.error('[bug351] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
