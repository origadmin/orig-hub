#!/usr/bin/env node
'use strict'

/**
 * 标签「# 文本模式」验收探针（commit c42fa4a）。
 *
 * 真实浏览器渲染 + 断言（每条都会打印实测值，且对改版前的代码必然失败）：
 *   1. 侧栏 media-tag-chip-*：inline background/backgroundColor 必须是空串，文本以 `#` 开头
 *      （改版前 `style={{ background: tag.color ?? '#64748b' }}` 恒设内联底色 → 必然非空）；
 *   2. 标签管理弹窗内「小圆点」计数必须 === 0（改版前有 8 个调色点 + 每行 1 个色点 + 每行
 *      PALETTE.slice(0,4) 4 个固定点，全是 ≤16px 的圆形 → 必然 > 0）；
 *      同时打印 tag-row-* 行数，自证扫到的是非空弹窗；
 *   3. tag-manager-search 过滤：输入已有标签的子串 → 行数变成非零且小于全量；清空 → 回到全量；
 *   4. TagPicker：搜不到时出现「新建 #zzz-probe-9」；搜到时每个选项都以 `#` 开头；
 *      点一个未选中项 → 出现 tag-picked-${id}（不点保存，不写库）；
 *   5. 剧集详情 Hero 标签行：每个标签元素以 `#` 开头且无内联底色；
 *   6. 4 张真实截图（先 scrollIntoView 再截），打印绝对路径 + 字节数（0 字节/缺失即失败）。
 *
 * Usage:  node verify/verify_tag_hash_mode.cjs
 * Env:    APP_PORT(默认5180) ORIG_VERIFY_OUT PROBE(1=只 dump testid)
 * Exit:   0 = 全部通过；2 = 断言失败
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const cdp = require('./lib/cdp.cjs')

const APP_PORT = Number(process.env.APP_PORT || 5180)
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
const OUT_DIR = process.env.ORIG_VERIFY_OUT || path.join(os.tmpdir(), 'orighub-tag-hash-shots')
const PROBE = process.env.PROBE === '1'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function clickTestid(page, testid) {
  const ok = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (!el) return false
    el.click()
    return true
  }, testid)
  if (!ok) throw new Error(`clickTestid: ${testid} not found`)
}

async function waitTestid(page, testid, timeout = 10000) {
  await page.waitForFunction((tid) => !!document.querySelector(`[data-testid="${tid}"]`), {
    timeout,
    args: [testid],
  })
}

async function waitTestidSoft(page, testid, timeout = 6000) {
  try {
    await waitTestid(page, testid, timeout)
    return true
  } catch (_e) {
    return false
  }
}

/**
 * 受控 input 写值：走原生 value setter 再派发 input 事件。
 * 直接赋值 `el.value = x` 会被 React 的 value tracker 吞掉（收不到变更）。
 */
async function setInput(page, testid, value) {
  return page.evaluate(
    (tid, val) => {
      const el = document.querySelector(`[data-testid="${tid}"]`)
      if (!el) return false
      el.focus()
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    testid,
    value,
  )
}

/** scrollIntoView 后截图（内滚动容器里的折叠内容 captureBeyondViewport 截不到） */
async function shot(page, name, testid) {
  await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    if (el) el.scrollIntoView({ block: 'center' })
    else window.scrollTo(0, 0)
  }, testid)
  await delay(450)
  const file = path.join(OUT_DIR, name)
  await page.screenshot(file, { fullPage: true })
  let size = -1
  try {
    size = fs.statSync(file).size
  } catch (_e) {
    size = -1
  }
  console.log(`[tag] shot ${name} -> ${file} (${size} bytes)`)
  return { file, size }
}

/**
 * 统计弹窗内「小圆点」：渲染宽高都 ≤18px 且是圆形（radius ≥50% 或 ≥9999px）。
 * 改版前这里会命中 8 个调色点(16px) + 每行 1 个色点(12px) + 每行 PALETTE.slice(0,4) 4 个点(12px)。
 */
function scanDots() {
  const anchor = document.querySelector('[data-testid="tag-manager-search"]')
  const root = anchor ? anchor.closest('div.fixed') : null
  if (!root) return { error: 'tag manager dialog root (div.fixed) not found' }
  const isCircle = (br, w, h) => {
    const first = String(br || '0px').trim().split(/\s+/)[0]
    if (first.endsWith('%')) return parseFloat(first) >= 50
    const px = parseFloat(first)
    if (!isFinite(px)) return false
    return px >= 9999 || px >= Math.min(w, h) / 2 - 0.01
  }
  const dots = []
  let scanned = 0
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    scanned++
    if (r.width > 18 || r.height > 18) continue
    const cs = getComputedStyle(el)
    if (!isCircle(cs.borderRadius, r.width, r.height)) continue
    dots.push({
      tag: el.tagName.toLowerCase(),
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      radius: cs.borderRadius,
      bg: cs.backgroundColor,
      cls: (el.className || '').toString().slice(0, 60),
    })
  }
  return {
    scanned,
    dots,
    dotCount: dots.length,
    rows: document.querySelectorAll('[data-testid^="tag-row-"]').length,
  }
}

async function gotoMediaLibrary(page) {
  await page.goto(APP_URL, { waitForRoot: true, settleMs: 1500 })
  await waitTestid(page, 'nav-child-lib-series', 15000)
  await clickTestid(page, 'nav-child-lib-series')
  await waitTestid(page, 'media-tag-list', 15000)
  await delay(900)
}

/** 逐个点剧集卡，直到打开一个「Hero 带标签」的详情（没有标签的详情验不到第 5 条） */
async function openSeriesWithHeroTags(page) {
  const n = await page.evaluate(() => document.querySelectorAll('[data-testid="series-card"]').length)
  console.log('[tag] series-card count:', n)
  for (let i = 0; i < n; i++) {
    await gotoMediaLibrary(page)
    const clicked = await page.evaluate((idx) => {
      const cards = Array.from(document.querySelectorAll('[data-testid="series-card"]'))
      if (!cards[idx]) return false
      cards[idx].click()
      return true
    }, i)
    if (!clicked) break
    const ok = await waitTestidSoft(page, 'series-tag-edit', 8000)
    if (!ok) continue
    await delay(700)
    const hasTags = await page.evaluate(() => !!document.querySelector('[data-testid="series-hero-tags"]'))
    if (hasTags) return i
  }
  return null
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const browser = await cdp.launch()
  const fails = []
  try {
    const page = await browser.newPage()

    console.log('[tag] goto', APP_URL)
    await gotoMediaLibrary(page)

    if (PROBE) {
      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]'))
          .map((e) => e.getAttribute('data-testid'))
          .filter((v, i, a) => a.indexOf(v) === i),
      )
      console.log('[tag] PROBE testids on media page:\n  ' + ids.join('\n  '))
      return
    }

    // ── 1) 侧栏标签 chip：无内联底色 + `#` 前缀 ──────────────────────────────
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="media-tag-chip-"]').length > 0,
      { timeout: 15000 },
    )
    const chips = await page.evaluate(() => {
      const out = []
      for (const el of Array.from(document.querySelectorAll('[data-testid^="media-tag-chip-"]'))) {
        out.push({
          testid: el.getAttribute('data-testid'),
          text: (el.textContent || '').trim(),
          inlineBg: el.style.background,
          inlineBgc: el.style.backgroundColor,
          styleAttr: el.getAttribute('style') || '',
          computedBg: getComputedStyle(el).backgroundColor,
        })
      }
      return out
    })
    const badBg = chips.filter((c) => c.inlineBg !== '' || c.inlineBgc !== '')
    const badHash = chips.filter((c) => !c.text.startsWith('#'))
    console.log('[tag] sidebar chip count:', chips.length)
    console.log(
      '[tag] sample chip:',
      JSON.stringify({
        testid: chips[0] && chips[0].testid,
        text: chips[0] && chips[0].text,
        computedBg: chips[0] && chips[0].computedBg,
        inlineBg: JSON.stringify(chips[0] && chips[0].inlineBg),
        styleAttr: JSON.stringify(chips[0] && chips[0].styleAttr),
      }),
    )
    if (chips.length === 0) fails.push('no media-tag-chip rendered in sidebar')
    if (badBg.length) {
      fails.push(
        `sidebar chips still carry inline color: ${JSON.stringify(
          badBg.slice(0, 3).map((c) => ({ t: c.text, bg: c.inlineBg, bgc: c.inlineBgc, style: c.styleAttr })),
        )}`,
      )
    }
    if (badHash.length) {
      fails.push(
        `sidebar chips not #-prefixed: ${JSON.stringify(badHash.slice(0, 3).map((c) => c.text))}`,
      )
    }
    await shot(page, 'tag-sidebar.png', 'media-tag-list')

    // ── 2) 标签管理弹窗：小圆点必须为 0 ─────────────────────────────────────
    await clickTestid(page, 'media-tag-manage')
    await waitTestid(page, 'tag-manager-search', 10000)
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="tag-row-"]').length > 0,
      { timeout: 10000 },
    )
    await delay(400)

    const scan = await page.evaluate(scanDots)
    if (scan.error) {
      fails.push(scan.error)
    } else {
      console.log('[tag] dialog elements scanned:', scan.scanned)
      console.log('[tag] tag-row-* count (non-empty proof):', scan.rows)
      console.log('[tag] small circle dots in dialog:', scan.dotCount, JSON.stringify(scan.dots.slice(0, 6)))
      if (scan.rows <= 0) fails.push('tag manager dialog rendered 0 tag-row-* (scan would be vacuous)')
      if (scan.dotCount !== 0) {
        fails.push(`color dots still rendered in tag manager: ${scan.dotCount} -> ${JSON.stringify(scan.dots.slice(0, 6))}`)
      }
    }

    // 2b) 探测器自检：注入两个「改版前样式」的圆点（16/12px rounded-full），
    //     必须被抓到 —— 否则上面的 `=== 0` 只是一个永远成立的空断言。
    const injected = await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="tag-manager-search"]')
      const root = anchor ? anchor.closest('div.fixed') : null
      if (!root) return 0
      const host = root.querySelector('footer') || root
      const mk = (cls, bg) => {
        const d = document.createElement('button')
        d.className = cls
        d.setAttribute('style', `background:${bg}`)
        d.setAttribute('data-dot-selftest', '1')
        host.appendChild(d)
      }
      mk('h-4 w-4 rounded-full border-2', '#2563eb') // 旧：新建行的 8 个调色点
      mk('h-3 w-3 rounded-full', '#dc2626') // 旧：每行 PALETTE.slice(0,4) 的 4 个固定点
      return document.querySelectorAll('[data-dot-selftest]').length
    })
    await delay(300)
    const withDots = await page.evaluate(scanDots)
    console.log(
      '[tag] detector self-test (injected',
      injected,
      'old-style dots) -> detected:',
      withDots.dotCount,
      JSON.stringify((withDots.dots || []).map((d) => ({ w: d.w, h: d.h, bg: d.bg }))),
    )
    if (!(withDots.dotCount >= 2)) {
      fails.push(`dot detector is blind: injected ${injected} old-style dots but detected ${withDots.dotCount}`)
    }
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-dot-selftest]'))) el.remove()
    })
    await delay(250)
    const afterRemove = await page.evaluate(scanDots)
    console.log('[tag] dots after removing self-test nodes:', afterRemove.dotCount)
    if (afterRemove.dotCount !== 0) {
      fails.push(`dot count not back to 0 after cleanup: ${afterRemove.dotCount}`)
    }
    await shot(page, 'tag-manager.png', 'tag-manager-search')

    // ── 3) 标签管理搜索：过滤 → 清空还原 ──────────────────────────────────
    const fullRows = await page.evaluate(
      () => document.querySelectorAll('[data-testid^="tag-row-"]').length,
    )
    const firstName = await page.evaluate(() => {
      const row = document.querySelector('[data-testid^="tag-row-"]')
      if (!row) return null
      const sp = row.querySelector('span')
      const t = (sp ? sp.textContent : row.textContent || '').trim()
      return t.startsWith('#') ? t.slice(1) : t
    })
    console.log('[tag] tag manager full row count:', fullRows, '| first tag name:', JSON.stringify(firstName))
    if (!firstName) {
      fails.push('could not read a tag name from the first tag-row-*')
    } else {
      await setInput(page, 'tag-manager-search', firstName)
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid^="tag-row-"]').length !== n,
        { timeout: 6000, args: [fullRows] },
      )
      await delay(300)
      const filteredRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid^="tag-row-"]').length,
      )
      console.log('[tag] filtered row count for', JSON.stringify(firstName), ':', filteredRows)
      if (!(filteredRows > 0 && filteredRows < fullRows)) {
        fails.push(
          `tag manager search did not narrow the list: full=${fullRows} filtered=${filteredRows} kw=${JSON.stringify(firstName)}`,
        )
      }
      await setInput(page, 'tag-manager-search', '')
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid^="tag-row-"]').length === n,
        { timeout: 6000, args: [fullRows] },
      )
      const restoredRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid^="tag-row-"]').length,
      )
      console.log('[tag] restored row count after clearing search:', restoredRows)
      if (restoredRows !== fullRows) {
        fails.push(`clearing search did not restore full list: ${restoredRows} != ${fullRows}`)
      }
    }

    // 关掉弹窗（点遮罩根节点，走 root 的 onClick={onClose}）
    await page.evaluate(() => {
      const anchor = document.querySelector('[data-testid="tag-manager-search"]')
      const root = anchor ? anchor.closest('div.fixed') : null
      if (root) root.click()
    })
    await page.waitForFunction(() => !document.querySelector('[data-testid="tag-manager-search"]'), {
      timeout: 6000,
    })
    await delay(300)

    // ── 4/5) 打开一个 Hero 带标签的剧集详情 ───────────────────────────────
    const opened = await openSeriesWithHeroTags(page)
    console.log('[tag] opened series-card index with hero tags:', opened)
    if (opened === null) {
      fails.push('no series detail with hero tags could be opened (series-card walk exhausted)')
      console.log('[tag] FAILS:', fails.length ? JSON.stringify(fails) : 'none')
      process.exitCode = 2
      return
    }

    // ── 5) Hero 标签行：`#` 前缀 + 无内联底色 ─────────────────────────────
    const hero = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="series-hero-tags"]')
      if (!box) return null
      const out = []
      for (const el of Array.from(box.children)) {
        out.push({
          text: (el.textContent || '').trim(),
          inlineBg: el.style.background,
          inlineBgc: el.style.backgroundColor,
          styleAttr: el.getAttribute('style') || '',
          computedBg: getComputedStyle(el).backgroundColor,
        })
      }
      return out
    })
    if (!hero || hero.length === 0) {
      fails.push('series-hero-tags present but has no children')
    } else {
      const heroBad = hero.filter((h) => h.inlineBg !== '' || h.inlineBgc !== '')
      const heroNoHash = hero.filter((h) => !h.text.startsWith('#'))
      console.log('[tag] hero tag count:', hero.length)
      console.log(
        '[tag] sample hero tag:',
        JSON.stringify({
          text: hero[0].text,
          computedBg: hero[0].computedBg,
          inlineBg: JSON.stringify(hero[0].inlineBg),
          styleAttr: JSON.stringify(hero[0].styleAttr),
        }),
      )
      if (heroBad.length) {
        fails.push(`hero tags still carry inline color: ${JSON.stringify(heroBad.slice(0, 3))}`)
      }
      if (heroNoHash.length) {
        fails.push(`hero tags not #-prefixed: ${JSON.stringify(heroNoHash.slice(0, 3).map((h) => h.text))}`)
      }
    }
    await shot(page, 'tag-detail-hero.png', 'series-hero-tags')

    // ── 4) TagPicker `#` 模式 ────────────────────────────────────────────
    await clickTestid(page, 'series-tag-edit')
    await waitTestid(page, 'tag-picker-input', 10000)
    await delay(400)

    // 4a) 搜不到 → 出现「新建 #zzz-probe-9」
    await setInput(page, 'tag-picker-input', 'zzz-probe-9')
    await waitTestid(page, 'tag-picker-create', 8000)
    await delay(250)
    const noMatch = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="tag-picker-create"]')
      return {
        text: btn ? (btn.textContent || '').trim() : null,
        options: document.querySelectorAll('[data-testid^="tag-option-"]').length,
      }
    })
    console.log('[tag] create button for non-matching query:', JSON.stringify(noMatch))
    if (!noMatch.text || !noMatch.text.includes('#zzz-probe-9')) {
      fails.push(`tag-picker-create text wrong for zzz-probe-9: ${JSON.stringify(noMatch)}`)
    }
    if (noMatch.options !== 0) {
      fails.push(`zzz-probe-9 is supposed to match nothing but rendered ${noMatch.options} options`)
    }

    // 4b) 真实标签前缀 → 选项全部以 `#` 开头
    await setInput(page, 'tag-picker-input', '')
    await delay(300)
    const firstOptionName = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="tag-option-"]')
      if (!el) return null
      const t = (el.textContent || '').trim()
      return t.startsWith('#') ? t.slice(1) : t
    })
    console.log('[tag] first picker option name:', JSON.stringify(firstOptionName))
    if (!firstOptionName || firstOptionName.length < 2) {
      fails.push(`cannot derive a real tag prefix from picker options: ${JSON.stringify(firstOptionName)}`)
    } else {
      const prefix = firstOptionName.slice(0, firstOptionName.length - 1)
      await setInput(page, 'tag-picker-input', prefix)
      await delay(400)
      const opts = await page.evaluate(() => {
        const list = Array.from(document.querySelectorAll('[data-testid^="tag-option-"]'))
        return {
          count: list.length,
          texts: list.map((e) => (e.textContent || '').trim()),
          create: (() => {
            const b = document.querySelector('[data-testid="tag-picker-create"]')
            return b ? (b.textContent || '').trim() : null
          })(),
        }
      })
      console.log(
        '[tag] options for prefix',
        JSON.stringify(prefix),
        ':',
        JSON.stringify({ count: opts.count, sample: opts.texts[0] || null, create: opts.create }),
      )
      if (opts.count <= 0) {
        fails.push(`no tag-option-* for prefix ${JSON.stringify(prefix)}`)
      }
      const notHash = opts.texts.filter((t) => !t.startsWith('#'))
      if (notHash.length) {
        fails.push(`picker options not #-prefixed: ${JSON.stringify(notHash.slice(0, 3))}`)
      }
      if (!opts.create) {
        fails.push('create row not visible alongside options (screenshot would miss the create row)')
      }
      await shot(page, 'tag-picker.png', 'tag-picker-input')

      // 4c) 点一个「当前未选中」的选项 → 出现 tag-picked-${id}
      await setInput(page, 'tag-picker-input', '')
      await delay(350)
      const pick = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll('[data-testid^="tag-option-"]'))
        const picked = new Set(
          Array.from(document.querySelectorAll('[data-testid^="tag-picked-"]')).map((e) =>
            e.getAttribute('data-testid'),
          ),
        )
        for (const o of opts) {
          const tid = o.getAttribute('data-testid') || ''
          const id = tid.slice('tag-option-'.length)
          if (!picked.has(`tag-picked-${id}`)) {
            return { id, text: (o.textContent || '').trim() }
          }
        }
        return null
      })
      console.log('[tag] candidate unselected option:', JSON.stringify(pick))
      if (!pick) {
        fails.push('every picker option is already selected — cannot prove the pick token appears')
      } else {
        await clickTestid(page, `tag-option-${pick.id}`)
        const appeared = await waitTestidSoft(page, `tag-picked-${pick.id}`, 6000)
        const pickedText = appeared
          ? await page.evaluate(
              (tid) => {
                const el = document.querySelector(`[data-testid="${tid}"]`)
                return el ? (el.textContent || '').trim() : null
              },
              `tag-picked-${pick.id}`,
            )
          : null
        console.log('[tag] picked token', `tag-picked-${pick.id}`, '->', JSON.stringify(pickedText))
        if (!appeared) {
          fails.push(`clicking tag-option-${pick.id} did not produce tag-picked-${pick.id}`)
        }
        // 不点「保存标签」：避免写库
      }
    }

    // ── 6) 截图文件真实落盘 ──────────────────────────────────────────────
    for (const name of ['tag-sidebar.png', 'tag-detail-hero.png', 'tag-manager.png', 'tag-picker.png']) {
      const file = path.join(OUT_DIR, name)
      let size = -1
      try {
        size = fs.statSync(file).size
      } catch (_e) {
        size = -1
      }
      console.log(`[tag] file ${name}: ${file} (${size} bytes)`)
      if (size <= 0) fails.push(`screenshot missing or empty: ${file}`)
    }

    const errs = page.pageErrors().slice(0, 5)
    if (errs.length) console.log('[tag] page errors:', JSON.stringify(errs))

    console.log('[tag] screenshots ->', OUT_DIR)
    console.log('[tag] FAILS:', fails.length ? JSON.stringify(fails, null, 1) : 'none')
    if (fails.length) process.exitCode = 2
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error('[tag] ERROR', e && e.message ? e.message : e)
  process.exit(1)
})
