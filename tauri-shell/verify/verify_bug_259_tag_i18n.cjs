/**
 * BUG-259 验收（第一部分 · 三件套之一）：标签界面文案 i18n —— en-US 语言下
 * 标签相关界面不再出现硬编码中文。
 *
 * 判据（BUG-259.md 现象 5 / 修复方向 6）：
 *   ① 强制 en-US 后，`TagManagerDialog` 打开状态的界面文案（标题 / 说明 / 新建行 /
 *      搜索 / 列表行 / 底部按钮）不含 CJK 汉字——**标签名本身是数据，可以也是
 *      中文，不计入**（脚本用 API 里的真实标签名做白名单扣除）；
 *   ② `ItemEditDialog` 的**标签区**（授权范围仅此一行标题 + 复用的 `TagPicker`）
 *      在 en-US 下无 CJK 残留：标题恰为 "Tags"，`TagPicker` 容器与 placeholder 无汉字；
 *   ③ 同屏截图留证。
 *
 * 强制 en-US 的方法（壳有语言设置，但为可靠起见直接写持久化键后整页重载）：
 *   `localStorage['orig-hub:settings']` 写入 `language: "en-US"` 再重新 goto ——
 *   `loadSettings()`（`src/store/useStore.ts`）在启动时读该键，语言即生效。
 *
 * 前置：dev server（vite :5180，端口经 `_lib_endpoints.cjs` 运行时解析，不写死）。
 * 产物：`verify_shots/bug259/`（ignored），可用 ORIG_VERIFY_OUT 覆盖。
 */
const path = require('path')
const fs = require('fs')

const cdp = require('./lib/cdp.cjs')
const endpoints = require('./_lib_endpoints.cjs')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const OUT = process.env.ORIG_VERIFY_OUT || path.resolve(__dirname, '..', '..', 'verify_shots', 'bug259')
const CJK = /[\u4e00-\u9fff]/
/** CJK 汉字 + CJK 标点（「」、·等），用于非数据文案的残留检查 */
const CJK_OR_PUNCT = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff65]/

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  |  ' + detail : ''}`)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ep = await endpoints.resolve()

  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()

    // ── 强制 en-US：写持久化语言设置 → 整页重载 ──
    await page.goto(ep.app, { settleMs: 1500 })
    await page.evaluate(() => {
      let cur = {}
      try {
        cur = JSON.parse(localStorage.getItem('orig-hub:settings') || '{}')
      } catch (_e) {
        cur = {}
      }
      cur.language = 'en-US'
      localStorage.setItem('orig-hub:settings', JSON.stringify(cur))
    })
    await page.goto(ep.app, { settleMs: 2000 })
    const lang = await page.evaluate(() => ({
      htmlLang: document.documentElement.lang,
      settings: localStorage.getItem('orig-hub:settings'),
    }))
    check(
      '⓪ en-US 已生效（持久化设置 + <html lang>）',
      String(lang.htmlLang).toLowerCase().startsWith('en'),
      `htmlLang=${lang.htmlLang}`,
    )

    // ── 真实标签名清单：数据不算文案，从残留检查里扣除 ──
    const tgBase = ep.tg
    const tagRes = await fetch(`${tgBase}/api/media/tags`).then((r) => r.json())
    const tagNames = (tagRes.items || []).map((t) => String(t.name || ''))
    console.log(`LIB: tags=${tagNames.length}（中文名不计入文案残留）`)

    /** 从一段界面文本里扣除标签名后，看是否还有汉字 */
    function cjkResidue(text) {
      let rest = text
      for (const n of tagNames) rest = rest.split(n).join(' ')
      const hits = rest.match(new RegExp(CJK.source, 'g')) || []
      return hits
    }

    // ── 进入媒体库 ──
    console.log('[step] waiting for media-library nav button')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('nav button')].some((b) =>
          /media library/i.test(b.innerText || ''),
        ),
      { timeout: 20000 },
    )
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('nav button')].find((b) =>
        /media library/i.test(b.innerText || ''),
      )
      btn.click()
    })
    await delay(2000)

    // ── ① TagManagerDialog ──
    console.log('[step] opening tag manager dialog')
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="media-tag-manage"]')), {
      timeout: 15000,
    })
    await page.evaluate(() => document.querySelector('[data-testid="media-tag-manage"]').click())
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="tag-new-input"]')), {
      timeout: 10000,
    })
    await delay(800)

    const dlg = await page.evaluate(() => {
      // 弹窗 = z-50 遮罩内的 max-w-md 容器；用「含 tag-new-input 的层」反查
      const input = document.querySelector('[data-testid="tag-new-input"]')
      let node = input
      while (node && !node.className.includes('max-w-md')) node = node.parentElement
      return {
        title: document.querySelector('[data-testid="tag-new-input"]')
          ? [...document.querySelectorAll('h4')].map((h) => h.innerText)
          : [],
        text: node ? node.innerText : '',
        newPlaceholder: document.querySelector('[data-testid="tag-new-input"]').placeholder,
        searchPlaceholder: document.querySelector('[data-testid="tag-manager-search"]')
          ? document.querySelector('[data-testid="tag-manager-search"]').placeholder
          : '',
        buttons: [...node.querySelectorAll('button')].map((b) => b.innerText.trim()),
        createLabel: document.querySelector('[data-testid="tag-new-submit"]')
          ? document.querySelector('[data-testid="tag-new-submit"]').innerText.trim()
          : '',
      }
    })
    await page.screenshot(path.join(OUT, '01_tag_manager_en.png'))
    check('①a 标题 = "Manage tags"（复用既有键 media.manageTags）',
      dlg.title.some((t) => t === 'Manage tags'), JSON.stringify(dlg.title))
    check('①b 新建输入 placeholder 无 CJK',
      !CJK_OR_PUNCT.test(dlg.newPlaceholder), JSON.stringify(dlg.newPlaceholder))
    check('①c 新建按钮 = "Create"（media.tag.create）',
      dlg.createLabel === 'Create', JSON.stringify(dlg.createLabel))
    check('①d 搜索 placeholder 无 CJK',
      !CJK_OR_PUNCT.test(dlg.searchPlaceholder), JSON.stringify(dlg.searchPlaceholder))
    const cjkDialog = cjkResidue(dlg.text)
    check('①e 弹窗全部文案（扣除标签名数据后）无汉字残留',
      cjkDialog.length === 0, `residue=${JSON.stringify(cjkDialog.slice(0, 10))}`)
    check('①f 底部按钮 = "Done"（media.tag.done）',
      dlg.buttons.includes('Done'), JSON.stringify(dlg.buttons))

    // 关闭弹窗（点 Done）
    await page.evaluate(() => {
      const done = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Done')
      if (done) done.click()
    })
    await delay(500)

    // ── ② ItemEditDialog 标签区（授权范围：标签区标题一行 + TagPicker）──
    // 先切到「全部内容」视图（左栏 section 按钮，en 文案 "All <count>"），
    // 再从卡片悬浮层打开编辑弹窗。
    await page.evaluate(() => {
      const sec = [...document.querySelectorAll('aside button, aside *')].find((b) =>
        /^All\s*\d+$/.test((b.innerText || '').replace(/\s+/g, ' ').trim()),
      )
      if (sec) sec.click()
    })
    await delay(2000)
    const card = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="media-card"]')
      return c ? c.getAttribute('data-testid') : null
    })
    check('②a 媒体网格已渲染（有卡片可开编辑弹窗）', card !== null, `card=${card}`)
    await page.evaluate(() => {
      const edit = document.querySelector('[data-testid="item-edit"]')
      if (edit) edit.click()
    })
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="item-edit-dialog"]')), {
      timeout: 10000,
    })
    await delay(500)
    const editDlg = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="item-edit-dialog"]')
      const labels = [...root.querySelectorAll('label')].map((l) => l.innerText.trim())
      const pickerInput = root.querySelector('[data-testid="tag-picker-input"]')
      let pickerText = ''
      if (pickerInput) {
        let node = pickerInput
        while (node && !node.className.includes('space-y-1.5')) node = node.parentElement
        pickerText = node ? node.innerText : ''
      }
      return { labels, pickerPlaceholder: pickerInput ? pickerInput.placeholder : null, pickerText }
    })
    await page.screenshot(path.join(OUT, '02_item_edit_tag_area_en.png'))
    check('②b 标签区标题 = "Tags"（复用既有键 media.tags）',
      editDlg.labels.includes('Tags'), JSON.stringify(editDlg.labels))
    check('②c TagPicker 搜索 placeholder 无 CJK',
      editDlg.pickerPlaceholder !== null && !CJK_OR_PUNCT.test(editDlg.pickerPlaceholder),
      JSON.stringify(editDlg.pickerPlaceholder))
    const cjkPicker = cjkResidue(editDlg.pickerText)
    check('②d TagPicker 容器文案（扣除标签名数据后）无汉字残留',
      cjkPicker.length === 0, `residue=${JSON.stringify(cjkPicker.slice(0, 10))}`)
  } finally {
    await browser.close()
  }

  const passed = checks.filter((c) => c.ok).length
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ passed, total: checks.length, all_passed: passed === checks.length, checks }, null, 2),
  )
  console.log(`\nRESULT ${passed}/${checks.length}`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
