'use strict'

/**
 * BUG-306 · 侧栏导航信息架构修正 —— UI 侧验收（活栈 CDP）。
 *
 * 判据（全部来自 docs/bugs/BUG-306.md「可证伪判据」，可反向证伪）：
 *   1. 冗余组标签消失：侧栏不存在文本「管理」「资料库（策划）」「分类（成品内容）」，
 *      且 Sidebar.tsx / 两个 locale 里对应键 0 命中（死键已删）；
 *   2. 文件树父行 = 「文件管理」（en-US === "File Management"）；
 *   3. 下载父行 = 「全部下载」（en-US === "All Downloads"）；
 *   4. 文件域父子排他：选中分类子项或「视频」时父行熄灭，仅父自身（cat-all）点亮；
 *   5. 下载域父子排他：选中某档时父行熄灭，仅 all 档点亮；
 *   6. 剧集下钻保父行（不破原型）：series:<id> 时 nav-files-row 仍高亮；
 *   7. en-US 模式侧栏无硬编码 CJK（i18n 驱动）；
 *   8. 剧集/视频合并：只有一个「视频」入口（标签===「视频」、位于子项最上方、
 *      fmode=lib-series），无平级「剧集」入口、无 cat:video 扁平子项。
 *
 * 牙齿（不靠「看起来没有」）：
 *   - 4/5 的牙：同一父行在「父选中」与「子选中」两态下的 computed backgroundColor
 *     必须不同 —— 证明高亮判据真的在判别，而不是两边都恒亮/恒不亮；
 *   - 8 的牙：API 确有剧集（>0），点「视频」后剧集墙确有卡（>0）——
 *     证明合并入口落到 lib-series 栅格，而不是空视图；
 *   - 2/3 的牙：zh 与 en 两套文本都断言（改任何一套的值都会红）。
 *
 * 反向证伪（本脚本之外，人工一轮）：把 filesActive/dlActive 改回域级判据、
 * 加回任一组标签、把视频入口拆回平级两项 —— 对应判据必须 FAIL。
 *
 * 用法：node tauri-shell/verify/verify_bug306_sidebar_ia.cjs
 *   （需 vite :5180 + orig-tg 媒体 API 在跑；`python scripts/dev_services.py`）
 */

const path = require('node:path')
const fs = require('node:fs')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
const EVIDENCE = path.join(__dirname, 'evidence', 'BUG-306')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ── 页面内：侧栏 DOM / 计算样式 / API 取数 ── */
const PAGE = `
window.__b306 = {
  async api(p) {
    const r = await fetch('${TG}' + p, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status)
    return r.json()
  },
  present(sel) { return document.querySelectorAll(sel).length },
  /** 元素自身 computed background（高亮判据用计算样式，不读 className 推断语义）。 */
  bg(sel) {
    const el = document.querySelector(sel)
    if (!el) return null
    return getComputedStyle(el).backgroundColor
  },
  lit(sel) {
    const bg = this.bg(sel)
    if (bg === null) return null
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
  },
  /** 选择器集合里是否有任一元素带高亮底色。 */
  anyLit(sel) {
    return Array.from(document.querySelectorAll(sel)).some((el) => {
      const bg = getComputedStyle(el).backgroundColor
      return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
    })
  },
  attr(sel, name) {
    const el = document.querySelector(sel)
    return el ? el.getAttribute(name) : null
  },
  /** 侧栏（aside）内所有叶子元素的精确文本（组标签判据用：整体 includes 会被「文件管理」误伤）。 */
  leafTexts() {
    const aside = document.querySelector('aside')
    if (!aside) return []
    return Array.from(aside.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
  },
  /** 文件树子项（排除下载档位子项）：testid + 标签 span 文本。 */
  fileChildren() {
    return Array.from(document.querySelectorAll('[data-testid^="nav-child-"]'))
      .filter((el) => !el.getAttribute('data-testid').startsWith('nav-child-dl-'))
      .map((el) => ({
        testid: el.getAttribute('data-testid'),
        label: (el.querySelector('span') || el).innerText.trim(),
      }))
  },
  click(sel) {
    const el = document.querySelector(sel)
    if (!el) return false
    el.click()
    return true
  },
  async wait(ms) { await new Promise((r) => setTimeout(r, ms)) },
}
`

async function main() {
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.goto(APP_URL)
    await page.evaluate(PAGE)
    await page.screenshot(path.join(EVIDENCE, '1_sidebar_zh_no_group_labels.png'))

    // ── 判据 1：冗余组标签消失（DOM 精确文本 + 源码/locale 死键）──
    const leaves = await page.evaluate(() => window.__b306.leafTexts())
    const gone = ['管理', '资料库（策划）', '分类（成品内容）'].filter((s) => leaves.includes(s))
    check('判据1 侧栏无「管理」「资料库（策划）」「分类（成品内容）」组标签',
      gone.length === 0, gone.length ? `仍存在: ${gone.join(' / ')}` : `aside 叶子文本 ${leaves.length} 个，三者为 0`)
    const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'Sidebar.tsx'), 'utf8')
    const localeZh = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'zh-CN.json'), 'utf8')
    const localeEn = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')
    const deadKeys = ['nav.group.manage', 'files.group.library', 'files.group.category', 'files.lib.series']
    const srcHits = deadKeys.filter((k) => sidebarSrc.includes(`'${k}'`) || sidebarSrc.includes(`t('${k}')`))
    const localeHits = deadKeys.filter((k) => localeZh.includes(`"${k}"`) || localeEn.includes(`"${k}"`))
    check('判据1 四个死键在 Sidebar.tsx 与两个 locale 中 0 命中',
      srcHits.length === 0 && localeHits.length === 0,
      `src=${srcHits.join(',') || '0'} locale=${localeHits.join(',') || '0'}`)

    // ── 判据 2/3：父行改名 ──
    const labels = await page.evaluate(() => ({
      filesTitle: window.__b306.attr('[data-testid="nav-files"]', 'title'),
      dlTitle: window.__b306.attr('[data-testid="nav-download"]', 'title'),
      ctxTitle: (document.querySelector('[data-testid="context-bar-title"]') || {}).innerText,
    }))
    check('判据2 文件树父行 = 「文件管理」', labels.filesTitle === '文件管理', `title=${labels.filesTitle}`)
    check('判据2（牙）顶栏域标题同源 = 「文件管理」', labels.ctxTitle === '文件管理', `ctx=${labels.ctxTitle}`)
    check('判据3 下载父行 = 「全部下载」', labels.dlTitle === '全部下载', `title=${labels.dlTitle}`)

    // ── 判据 8：剧集/视频合并 ──
    const merge = await page.evaluate(() => {
      const children = window.__b306.fileChildren()
      return {
        children,
        catVideo: window.__b306.present('[data-testid="nav-child-video"]'),
        seriesEntries: children.filter((c) => c.label === '剧集').length,
        videoEntries: children.filter((c) => c.label === '视频').length,
        first: children[0] || null,
      }
    })
    check('判据8 无 cat:video 扁平分类子项', merge.catVideo === 0, `nav-child-video count=${merge.catVideo}`)
    check('判据8 无独立「剧集」入口', merge.seriesEntries === 0, `标签=剧集 的子项 ${merge.seriesEntries} 个`)
    check('判据8 唯一「视频」入口且位于子项最上方',
      merge.videoEntries === 1 && merge.first && merge.first.label === '视频',
      `video 入口 ${merge.videoEntries} 个；首项=${merge.first && merge.first.label}`)
    const wall = await page.evaluate(async () => {
      const ok = window.__b306.click('[data-testid="nav-child-lib-series"]')
      await window.__b306.wait(1500)
      const cards = window.__b306.present('[data-testid="series-card-root"]')
      const all = await window.__b306.api('/api/media/series?limit=500')
      return { ok, cards, total: (all.items || []).length }
    })
    check('判据8（牙）API 确有剧集（证明墙有内容可验）', wall.total > 0, `series total=${wall.total}`)
    check('判据8 点「视频」落入剧集栅格（lib-series）', wall.ok === true && wall.cards > 0,
      `cards=${wall.cards} / total=${wall.total}`)

    // ── 判据 4：文件域父子排他 ──
    const music = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-child-music"]')
      await window.__b306.wait(1200)
      return {
        childLit: window.__b306.lit('[data-testid="nav-child-music"]'),
        parentLit: window.__b306.lit('[data-testid="nav-files-row"]'),
        parentBg: window.__b306.bg('[data-testid="nav-files-row"]'),
        childBg: window.__b306.bg('[data-testid="nav-child-music"]'),
      }
    })
    check('判据4 选中分类子项时该子项高亮', music.childLit === true, `childLit=${music.childLit}`)
    check('判据4 选中分类子项时文件父行熄灭（排他）', music.parentLit === false,
      `parentLit=${music.parentLit} bg=${music.parentBg}`)
    await page.screenshot(path.join(EVIDENCE, '2_files_child_selected_parent_dark.png'))
    const seriesEntry = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-child-lib-series"]')
      await window.__b306.wait(1200)
      return {
        childLit: window.__b306.lit('[data-testid="nav-child-lib-series"]'),
        parentLit: window.__b306.lit('[data-testid="nav-files-row"]'),
      }
    })
    check('判据4 选中「视频」入口时该子项高亮', seriesEntry.childLit === true, `childLit=${seriesEntry.childLit}`)
    check('判据4 选中「视频」入口时文件父行熄灭（排他）', seriesEntry.parentLit === false,
      `parentLit=${seriesEntry.parentLit}`)
    const parent = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-files"]')
      await window.__b306.wait(1200)
      return {
        parentLit: window.__b306.lit('[data-testid="nav-files-row"]'),
        parentBg: window.__b306.bg('[data-testid="nav-files-row"]'),
        anyChildLit: window.__b306.anyLit('[data-testid^="nav-child-"]:not([data-testid^="nav-child-dl-"])'),
      }
    })
    check('判据4 父行自身选中（cat-all）时父行高亮', parent.parentLit === true, `parentLit=${parent.parentLit}`)
    check('判据4 父行选中时无文件子项高亮', parent.anyChildLit === false, `anyChildLit=${parent.anyChildLit}`)
    check('判据4（牙）父行两态 computed 背景不同（判据真的在判别）',
      music.parentBg !== parent.parentBg && music.childBg === parent.parentBg,
      `子选中父bg=${music.parentBg} / 父选中父bg=${parent.parentBg} / 子选中子bg=${music.childBg}`)

    // ── 判据 5：下载域父子排他 ──
    const dlChild = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-child-dl-running"]')
      await window.__b306.wait(1200)
      return {
        childLit: window.__b306.lit('[data-testid="nav-child-dl-running"]'),
        parentLit: window.__b306.lit('[data-testid="nav-download-row"]'),
      }
    })
    check('判据5 选中下载档位时该子项高亮', dlChild.childLit === true, `childLit=${dlChild.childLit}`)
    check('判据5 选中下载档位时下载父行熄灭（排他）', dlChild.parentLit === false, `parentLit=${dlChild.parentLit}`)
    const dlParent = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-download"]')
      await window.__b306.wait(1200)
      return {
        parentLit: window.__b306.lit('[data-testid="nav-download-row"]'),
        anyChildLit: window.__b306.anyLit('[data-testid^="nav-child-dl-"]'),
      }
    })
    check('判据5 下载父行自身选中（all）时父行高亮', dlParent.parentLit === true, `parentLit=${dlParent.parentLit}`)
    check('判据5 下载父行选中时无档位子项高亮', dlParent.anyChildLit === false, `anyChildLit=${dlParent.anyChildLit}`)

    // ── 判据 6：剧集下钻保父行（D18/原型规则不破）──
    const drill = await page.evaluate(async () => {
      window.__b306.click('[data-testid="nav-child-lib-series"]')
      await window.__b306.wait(1500)
      const card = document.querySelector('[data-testid="series-card"]')
      if (!card) return { opened: false }
      card.click()
      await window.__b306.wait(1500)
      return {
        opened: window.__b306.present('[data-testid="series-back"]') === 1,
        parentLit: window.__b306.lit('[data-testid="nav-files-row"]'),
        anyChildLit: window.__b306.anyLit('[data-testid^="nav-child-"]:not([data-testid^="nav-child-dl-"])'),
      }
    })
    check('判据6 进入剧集详情（下钻）', drill.opened === true, `series-back=${drill.opened}`)
    check('判据6 剧集下钻时文件父行仍高亮（不破原型）', drill.parentLit === true, `parentLit=${drill.parentLit}`)
    check('判据6 剧集下钻时无文件子项高亮', drill.anyChildLit === false, `anyChildLit=${drill.anyChildLit}`)

    // ── 页面错误（zh 会话）──
    const errs = page.pageErrors()
    check('无未捕获页面错误', errs.length === 0, errs.slice(0, 2).join(' | '))
    await browser.close()

    // ── 判据 7：en-US 模式无硬编码 CJK ──
    // 为什么用第二个浏览器实例而不是 Emulation.setLocaleOverride：实测本机 Edge
    // （headless=new）对该命令无响应（navigator.language 保持 zh-CN，见 2026-10-14 探针），
    // 而 `--lang=en-US` 启动参数可靠改变 navigator.language ⇒ detectLanguage() → en-US。
    // 牙在判据 2/3/8：同一批 DOM 元素在 zh 会话渲染中文，此处必须渲染英文。
    const enBrowser = await cdp.launch({ args: ['--lang=en-US'] })
    try {
      const enPage = await enBrowser.newPage()
      await enPage.goto(APP_URL, { settleMs: 1500 })
      await enPage.evaluate(PAGE)
      const en = await enPage.evaluate(() => {
        const leaves = window.__b306.leafTexts()
        const cjk = leaves.filter((s) => /[\u4e00-\u9fff]/.test(s))
        return {
          cjk,
          filesTitle: window.__b306.attr('[data-testid="nav-files"]', 'title'),
          dlTitle: window.__b306.attr('[data-testid="nav-download"]', 'title'),
          videoLabel: (window.__b306.fileChildren()[0] || {}).label,
        }
      })
      check('判据7 en-US 侧栏无硬编码 CJK 残留', en.cjk.length === 0, `CJK: ${en.cjk.slice(0, 3).join(' / ') || '0'}`)
      check('判据7 en-US 文件父行 = "File Management"', en.filesTitle === 'File Management', `title=${en.filesTitle}`)
      check('判据7 en-US 下载父行 = "All Downloads"', en.dlTitle === 'All Downloads', `title=${en.dlTitle}`)
      check('判据7 en-US 视频入口标签 = "Videos"', en.videoLabel === 'Videos', `label=${en.videoLabel}`)
      await enPage.screenshot(path.join(EVIDENCE, '3_sidebar_en_us.png'))
      const enErrs = enPage.pageErrors()
      check('无未捕获页面错误（en-US）', enErrs.length === 0, enErrs.slice(0, 2).join(' | '))
    } finally {
      await enBrowser.close()
    }
  } finally {
    // browser 已在上方关闭；双保险防止泄漏。
    try { await browser.close() } catch { /* already closed */ }
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — BUG-306 侧栏 IA 判据`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
