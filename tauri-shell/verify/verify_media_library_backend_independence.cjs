#!/usr/bin/env node
/**
 * 媒体库「与来源服务解耦」验收 —— BUG-176。
 *
 * 契约（`tauri-shell/src/lib/mediaSources.ts:110` 与 `MediaLibraryPanel.tsx:91` 自述）：
 *   媒体库管的是「入库之后的字节」，TG 只是**来源之一**；TG 挂掉不该让库变成空面板。
 *
 * 本脚本用同一份库做 A/B：只切换「资料库后端可达 / 不可达」，断言界面在这两种状态下
 * **都能让用户正确判断库的真实内容量**。核心判据（用户困惑的原点）：
 *   **服务不可达时，界面必须显式说明「内容暂不可读取」，而不是把它渲染成一个看起来
 *   像「库里没有内容」的空列表 —— 否则用户无法区分「没数据」与「取不到数据」。**
 *
 * 用法：
 *   node verify_media_library_backend_independence.cjs
 * 环境变量：
 *   APP_URL     默认 http://127.0.0.1:5180/
 *   TG_BASE     默认 http://127.0.0.1:9877   （资料库后端实际端口）
 *   OUT_DIR     默认 <repo>/verify_shots/media-library/   （证据落盘，ignored）
 *
 * 退出码：0 = 全部断言通过；1 = 存在 FAIL（缺陷存在）。
 */
const fs = require('fs')
const path = require('path')
const { launch } = require('./lib/cdp.cjs')

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5180/'
const TG_BASE = (process.env.TG_BASE || 'http://127.0.0.1:9877').replace(/\/$/, '')
const OUT_DIR =
  process.env.OUT_DIR ||
  path.join(__dirname, '..', '..', 'verify_shots', 'media-library')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, status: res.status, body: await res.json() }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  } finally {
    clearTimeout(t)
  }
}

;(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ---- 1. 资料库后端此刻是否可达，以及它自己报告的真实条目数 ----
  const stats = await fetchJson(`${TG_BASE}/api/media/stats`)
  const backendUp = Boolean(stats.ok)
  const realItems = backendUp ? Number(stats.body.items || 0) : null
  console.log(
    `[env] library backend ${TG_BASE} : ${backendUp ? 'UP' : 'DOWN'}` +
      (backendUp ? `  items=${realItems}` : `  (${stats.error || ('http ' + stats.status)})`),
  )

  // ---- 2. 打开真实产品，进入媒体库 ----
  const browser = await launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(APP_URL)
  await sleep(2500)

  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="nav-child-lib-series"]')
    if (!el) return false
    el.click()
    return true
  })
  await sleep(3500)

  const dom = await page.evaluate(() => {
    const text = document.body.innerText || ''
    const readCount = (hint) => {
      // 形如「全部内容    6」/「视频    6」，匹配提示词后最近的一个数字/破折号
      const re = new RegExp(hint + '\\s*\\n?\\s*([0-9]+|—|-)')
      const m = text.match(re)
      return m ? m[1] : null
    }
    return {
      text,
      headerStats: /(\d+)\s*项\s*·/.test(text) ? text.match(/(\d+)\s*项\s*·/)[1] : null,
      contentCount: readCount('全部内容'),
      serviceDown:
        text.includes('媒体服务未运行') ||
        text.includes('服务未运行') ||
        Boolean(document.querySelector('[data-testid="media-service-down"]')),
      // 「暂不可读取 / 并非没有内容」这一层语义 —— 用户能否区分「没数据」与「取不到」
      explicitness:
        /暂不可读|无法读取|取不到|并非没有|不是没有|数据仍在|库内仍/.test(text),
      sourceOfflineBanner: Boolean(
        document.querySelector('[data-testid="media-source-offline-banner"]'),
      ),
    }
  })

  const png = path.join(OUT_DIR, `backend-${backendUp ? 'up' : 'down'}.png`)
  await page.screenshot(png)
  await browser.close()

  check('#root mounted, 媒体库入口可点击', clicked, clicked ? '' : 'nav-child-lib-series 未找到')
  check(
    '媒体库渲染出可判读的内容计数（统计行或内容计数至少一个存在）',
    dom.headerStats !== null || dom.contentCount !== null,
    `headerStats=${dom.headerStats} contentCount=${dom.contentCount}`,
  )

  if (backendUp) {
    // 可达：界面必须如实反映后端报出的条目数
    check(
      `后端可达时，界面计数 = 后端真实条目数（${realItems}）`,
      dom.headerStats === String(realItems) || dom.contentCount === String(realItems),
      `headerStats=${dom.headerStats} contentCount=${dom.contentCount} real=${realItems}`,
    )
  } else {
    // 不可达：不得把「取不到」渲染成「没有」——必须显式说明
    check(
      '后端不可达时，界面显式告知「库内容暂不可读取（并非没有内容）」',
      dom.explicitness,
      `explicitness=${dom.explicitness} serviceDown=${dom.serviceDown}`,
    )
    check(
      '后端不可达时，界面不得仅呈现一个看似「库里没有内容」的空计数而不加说明',
      !(dom.contentCount === '—' || dom.contentCount === '0') || dom.explicitness,
      `contentCount=${dom.contentCount} explicitness=${dom.explicitness}`,
    )
  }

  const failed = results.filter((r) => !r.ok)
  const summary = {
    at: new Date().toISOString(),
    appUrl: APP_URL,
    libraryBackend: TG_BASE,
    backendUp,
    realItems,
    dom: {
      headerStats: dom.headerStats,
      contentCount: dom.contentCount,
      serviceDown: dom.serviceDown,
      explicitness: dom.explicitness,
      sourceOfflineBanner: dom.sourceOfflineBanner,
    },
    results,
    passed: results.length - failed.length,
    total: results.length,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    screenshots: [png],
  }
  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(summary, null, 2))
  console.log(`\n[verify:media-decouple] ${summary.passed}/${summary.total} ${summary.verdict}`)
  console.log(`[verify:media-decouple] evidence → ${OUT_DIR}`)
  process.exit(failed.length === 0 ? 0 : 1)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
