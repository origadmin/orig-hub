'use strict'

/**
 * BUG-403 —— 文件管理「点击内容 = 详情 + 可操作功能」，不是选中。
 *
 * 用户裁定（2026-10-23，原话）：「文件管理点击内容应显示详情与可操作功能，而非选中」。
 * 本脚本是这句话的**可证伪验收**，同时是本仓对旧例（Explorer「单击选中、双击打开」）
 * 的**判据翻转**记录 —— 旧判据方向与诉求相反，留着它等于要求实现做用户明确否掉的事。
 *
 * 静态（源码读，缺一即 FAIL —— 不靠页面倒推源码没漂移）：
 *   S1 行点击绑 `onOpenDetail(item)`；源码里**没有**把行双击绑到打开（`onDoubleClick={open}` 等）
 *   S2 面板把 `onOpenDetail` 接到详情状态，并渲染 `<ItemDetailDialog`
 *   S3 详情对话框的动作入口齐全（open/reveal/delete 恒在，edit 仅媒体条目）
 *   S4 locale 提示语不再宣称「双击打开」（文案与语义必须同向）
 *   S5 行内「打开目录」与详情共用 `lib/reveal` 一个通道（禁第三份 try/catch）
 *
 * 运行时（真渲染、真点击）：
 *   ① 单击媒体行 ⇒ 详情出现、**选中数仍为 0**、播放器**未**打开
 *   ② 详情标题 == 该行名称（DOM 文本对齐，不是「有个标题就算过」）
 *   ③ 关闭 ⇒ 详情消失
 *   ④ 复选框 ⇒ 选中 1 行、详情**不**出现（选中是显式动作）
 *   ⑤ 双击行 ⇒ 仍只有 1 个详情、播放器仍不出现（「双击打开」已撤销）
 *   ⑥ 受管成品行（`data-source="download"`）⇒ 详情**不**渲染「编辑信息」
 *   ⑦ 反证：媒体行详情**有**「编辑信息」—— ⑥ 不是「永远不渲染」
 *
 * 用法：node tauri-shell/verify/verify_bug403_item_detail.cjs
 *   需 vite :5180 + orig-tg :19787 + orig-daemon :19786（栈未起 → 直接 FAIL 退出，
 *   不会静默跳过运行时段）。
 */

const fs = require('node:fs')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = {
  fileList: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'media', 'FileListView.tsx'),
    'utf8',
  ),
  panel: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'MediaLibraryPanel.tsx'),
    'utf8',
  ),
  dialog: fs.readFileSync(
    path.join(ROOT, 'tauri-shell', 'src', 'components', 'media', 'ItemDetailDialog.tsx'),
    'utf8',
  ),
  zh: JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'zh-CN.json'), 'utf8'),
  ),
  en: JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tauri-shell', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
  ),
}

const APP_URL = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const TG = process.env.VERIFY_TG_BASE || 'http://127.0.0.1:19787'
const DAEMON = process.env.VERIFY_DAEMON_BASE || 'http://127.0.0.1:19786'
const OUT = process.env.ORIG_SHOT_OUT || path.resolve(ROOT, 'verify_shots', 'bug403-item-detail')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 行点击必须绑详情（BUG-403 的本体）。 */
const rowOpensDetail = /onClick=\{\(\) => onOpenDetail\(item\)\}/.test(SRC.fileList)
/**
 * 行双击**不得**再绑打开：旧实现是 `onDoubleClick={open}` / `onDoubleClick={() => onOpen(...)}`。
 * 复选框上的 `onDoubleClick={(e) => e.stopPropagation()}` 是另一件事，不算违规。
 */
const rowDoubleOpen = /onDoubleClick=\{(?:open|\(\)\s*=>\s*onOpen\()/.test(SRC.fileList)
const rowHasDetailProp = /onOpenDetail:\s*\(item:\s*MediaItem\)\s*=>\s*void/.test(SRC.fileList)
const panelWired = /onOpenDetail=\{setDetailItem\}/.test(SRC.panel) && /<ItemDetailDialog\b/.test(SRC.panel)
const dialogActions =
  /data-testid="item-detail-open"/.test(SRC.dialog) &&
  /data-testid="item-detail-reveal"/.test(SRC.dialog) &&
  /data-testid="item-detail-delete"/.test(SRC.dialog)
/** 编辑入口必须由「非成品」门控（受管成品没有可编辑的库字段）。 */
const dialogEditGated = /\{!fact && onEdit \?/.test(SRC.dialog)
const hintZh = SRC.zh['media.fileList.dblHint'] || ''
const hintEn = SRC.en['media.fileList.dblHint'] || ''
const hintNoDouble = !/双击/.test(hintZh) && !/double-?click/i.test(hintEn)
const revealUnified = /import \{ revealItemPath \} from '\.\.\/\.\.\/lib\/reveal'/.test(SRC.fileList)

async function httpOk(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return r.status < 500
  } catch {
    return false
  }
}

async function main() {
  /* ── 静态段 ── */
  check('S1 行单击绑 onOpenDetail', rowOpensDetail)
  check('S1 行双击不再绑打开（「双击打开」已撤销）', !rowDoubleOpen)
  check('S1 FileRow 声明 onOpenDetail', rowHasDetailProp)
  check('S2 面板接线 onOpenDetail + 渲染 ItemDetailDialog', panelWired)
  check('S3 详情动作入口齐全（open/reveal/delete）', dialogActions)
  check('S3 编辑入口由 !fact 门控', dialogEditGated)
  check('S4 提示语不再宣称双击打开', hintNoDouble, `zh="${hintZh}" en="${hintEn}"`)
  check('S5 行内打开目录走 lib/reveal 单通道', revealUnified)

  if (failures > 0) {
    console.log('\n源码判据已红，运行时段不再执行（先修实现，别拿页面绿盖过源码红）')
    process.exit(1)
  }

  /* ── 运行时段：栈必须真在跑 ── */
  const stack = {
    app: await httpOk(APP_URL),
    tg: await httpOk(`${TG}/api/media/stats`),
    daemon: await httpOk(`${DAEMON}/api/files`),
  }
  if (!stack.app || !stack.tg || !stack.daemon) {
    console.log('')
    check('栈就绪（vite :5180 / orig-tg :19787 / orig-daemon :19786）', false,
      JSON.stringify(stack))
    console.log('\n运行时段无法执行：请先手动启动 scripts/dev/dev-stack.cmd 后重跑。')
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(APP_URL)

    // 进「文件 → 全部文件」
    await page.evaluate(async () => {
      document.querySelector('[data-testid="nav-files"]')?.click()
      await new Promise((r) => setTimeout(r, 1800))
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="file-list-row"]').length > 0,
      { timeoutMs: 20000 },
    )

    /** 挑一行：媒体行（source !== 'download'）与成品行（source === 'download'）。 */
    const pick = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="file-list-row"]')]
        const media = rows.find((r) => r.getAttribute('data-source') !== 'download')
        const fact = rows.find((r) => r.getAttribute('data-source') === 'download')
        const name = (r) =>
          (r?.querySelector('span.min-w-0.truncate')?.textContent || '').trim()
        return {
          mediaId: media?.getAttribute('data-item-id') || '',
          mediaName: name(media),
          factId: fact?.getAttribute('data-item-id') || '',
          factName: name(fact),
          total: rows.length,
        }
      })
    const p = await pick()
    if (!p.mediaId) {
      check('存在媒体行（否则 ①③④⑤⑦ 全部无从谈起）', false, `rows=${p.total}`)
      throw new Error('没有媒体行')
    }

    const snap = () =>
      page.evaluate(() => ({
        dialog: document.querySelectorAll('[data-testid="item-detail-dialog"]').length,
        viewer: document.querySelectorAll('[data-testid="media-viewer"]').length,
        selected: document.querySelectorAll('[data-testid="file-list-row"][data-selected="true"]').length,
        name: (document.querySelector('[data-testid="item-detail-name"]')?.textContent || '').trim(),
        edit: document.querySelectorAll('[data-testid="item-detail-edit"]').length,
        open: document.querySelectorAll('[data-testid="item-detail-open"]').length,
      }))

    // ① 单击媒体行
    await page.evaluate(async (id) => {
      document.querySelector(`[data-testid="file-list-row"][data-item-id="${id}"]`)?.click()
      await new Promise((r) => setTimeout(r, 350))
    }, p.mediaId)
    const s1 = await snap()
    check('① 单击行 ⇒ 打开内容详情', s1.dialog === 1, `dialog=${s1.dialog}`)
    check('① 单击行不改选中（选中只走复选框）', s1.selected === 0, `selected=${s1.selected}`)
    check('① 单击行不打开播放器', s1.viewer === 0, `viewer=${s1.viewer}`)

    // ② 标题与行名对齐（行名可能带「缺字节」徽标，取前缀）
    check('② 详情标题 == 该行名称', p.mediaName !== '' && s1.name.startsWith(p.mediaName.slice(0, 8)),
      `row="${p.mediaName}" dialog="${s1.name}"`)

    // ⑦ 媒体行详情必须有「编辑信息」（为 ⑥ 提供反证）
    check('⑦ 媒体行详情有「编辑信息」', s1.edit === 1 && s1.open === 1,
      `edit=${s1.edit} open=${s1.open}`)

    await page.screenshot(path.join(OUT, '01-media-detail.png'))

    // ③ 关闭
    await page.evaluate(async () => {
      document.querySelector('[data-testid="item-detail-close"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
    })
    const s2 = await snap()
    check('③ 关闭 ⇒ 详情消失', s2.dialog === 0, `dialog=${s2.dialog}`)

    // ④ 复选框 = 选中
    const s3 = await page.evaluate(async (id) => {
      const cb = document.querySelector(
        `[data-testid="file-list-row"][data-item-id="${id}"] input[type="checkbox"]`,
      )
      cb?.click()
      await new Promise((r) => setTimeout(r, 350))
      return {
        dialog: document.querySelectorAll('[data-testid="item-detail-dialog"]').length,
        selected: document.querySelectorAll('[data-testid="file-list-row"][data-selected="true"]').length,
      }
    }, p.mediaId)
    check('④ 复选框 ⇒ 选中 1 行', s3.selected === 1, `selected=${s3.selected}`)
    check('④ 复选框不弹详情', s3.dialog === 0, `dialog=${s3.dialog}`)

    // 复位选中（否则 selectionMode 打开，行内打开按钮会禁用，影响后续动作判据）
    await page.evaluate(async (id) => {
      document
        .querySelector(`[data-testid="file-list-row"][data-item-id="${id}"] input[type="checkbox"]`)
        ?.click()
      await new Promise((r) => setTimeout(r, 300))
    }, p.mediaId)

    // ⑤ 双击不再打开播放器（真双击 = 两次 click + dblclick）
    const s4 = await page.evaluate(async (id) => {
      const row = document.querySelector(`[data-testid="file-list-row"][data-item-id="${id}"]`)
      if (!row) return { dialog: -1, viewer: -1 }
      row.click()
      row.click()
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 400))
      return {
        dialog: document.querySelectorAll('[data-testid="item-detail-dialog"]').length,
        viewer: document.querySelectorAll('[data-testid="media-viewer"]').length,
      }
    }, p.mediaId)
    check('⑤ 双击 ⇒ 仍只有一个详情（覆盖层不叠加）', s4.dialog === 1, `dialog=${s4.dialog}`)
    check('⑤ 双击 ⇒ 播放器仍不打开（「双击打开」已撤销）', s4.viewer === 0, `viewer=${s4.viewer}`)

    await page.evaluate(async () => {
      document.querySelector('[data-testid="item-detail-close"]')?.click()
      await new Promise((r) => setTimeout(r, 250))
    })

    // ⑥ 受管成品行：详情无「编辑信息」
    if (p.factId) {
      const s5 = await page.evaluate(async (id) => {
        document.querySelector(`[data-testid="file-list-row"][data-item-id="${id}"]`)?.click()
        await new Promise((r) => setTimeout(r, 350))
        return {
          dialog: document.querySelectorAll('[data-testid="item-detail-dialog"]').length,
          edit: document.querySelectorAll('[data-testid="item-detail-edit"]').length,
          open: document.querySelectorAll('[data-testid="item-detail-open"]').length,
          reveal: document.querySelectorAll('[data-testid="item-detail-reveal"]').length,
        }
      }, p.factId)
      check('⑥ 成品行详情可开', s5.dialog === 1, `dialog=${s5.dialog}`)
      check('⑥ 成品行详情无「编辑信息」（无可编辑库字段）', s5.edit === 0, `edit=${s5.edit}`)
      check('⑥ 成品行详情仍有打开/定位', s5.open === 1 && s5.reveal === 1,
        `open=${s5.open} reveal=${s5.reveal}`)
      await page.screenshot(path.join(OUT, '02-fact-detail.png'))
    } else {
      check('⑥ 成品行存在（`/api/files` 有成品才有这一行可验）', false, 'no fact row in cat-all')
    }

    const errs = [...page.consoleErrors(), ...page.pageErrors()]
    check('无未捕获页面错误', errs.length === 0, errs.slice(0, 2).join(' | '))
  } finally {
    await browser.close()
  }

  console.log('')
  if (failures > 0) {
    console.log(`FAILED — ${failures} 项`)
    process.exit(1)
  }
  console.log('ALL PASS — BUG-403 语义（点击=详情，选中=复选框）成立')
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e)
  process.exit(1)
})
