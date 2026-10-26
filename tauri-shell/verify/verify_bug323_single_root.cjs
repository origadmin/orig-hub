'use strict'
/**
 * BUG-323 复报（用户 2026-10-16）活栈验收：**单一根**规则。
 *
 * 用户裁定原文：「库根跟下载走，所有文件不允许脱离下载路径，下载路径是所有权限的限制路径。」
 *
 * 规则落地后的三条硬约束（本脚本逐条断言）：
 *   R1 库根 = `<生效下载路径>/library`，**派生值**，daemon 与 orig-tg 两侧必须一致；
 *   R2 库根**不可独立配置**（两个端点都 422）—— 「脱离」在接口层不可表达；
 *   R3 下载路径是权限边界：界外文件一律拒（403），且**不得被删除**。
 *
 * 判据（每条「有值 + 具体值」，不用「不等于旧值」式假绿）：
 *   A1 daemon `effective_download_root` 非空；
 *   A2 `library_root` === `effective_download_root` + `\library`（派生关系自证）；
 *   A3 orig-tg `libraryDir` === daemon `library_root`（两进程同源同值）；
 *   A4 daemon 不再下发旧键 `library_dir`（契约切换完成）；
 *   A5 库根不再落在应用内部目录（AppData）—— 旧默认值已废；
 *   B1 `PUT /api/tg/config {libraryDir}` → 422；
 *   B2 `PUT /api/config/library {dir}` → 422；
 *   B3 `PUT /api/tg/config {downloadDir}` → 200 且返回的 `libraryDir` 已跟随；
 *   C1 改 daemon 下载目录 → 响应里 `effective_download_root` / `library_root` 同步；
 *   C2 **不改 daemon 配置**直读 orig-tg，`libraryDir` 已跟随（daemon 主动下发，无需重启）；
 *   C3 重载设置页：库根只读展示 === 新库根，「当前生效」=== 新下载路径；
 *   D1 界外**真实存在**的文件 → DELETE 403，且文件仍在（边界是硬约束）；
 *   D2 界内不存在的路径 → 404（说明判定走到存在性分支，不是被边界拦）；
 *   E1 库根是只读展示（无输入框）；
 *   E2 「打开库根文件夹」可点（库根有值）；
 *   F1 配置已还原（daemon `download_dir` === 测试前值）；
 *   F2 临时夹具目录已删除。
 *
 * 验牙（双向）：
 *   ① 把 `Store::library_root()` 装回旧四级链（app_setting library_dir 优先）⇒ A3/C2/C3 必红；
 *   ② 把 `PUT /api/tg/config` 的 libraryDir 拒绝改回接受 ⇒ B1 必红；
 *   ③ 把 `resolve_managed_path` 的边界校验去掉 ⇒ D1 会变 200/404（不再 403）⇒ D1 红。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cdp = require(path.join(__dirname, 'lib', 'cdp.cjs'))

const OUT = path.resolve(__dirname, '..', '..', 'verify_shots', 'bug323-single-root')
const APP = process.env.VERIFY_APP_URL || 'http://127.0.0.1:5180/'
const DAEMON = process.env.VERIFY_DAEMON_URL || 'http://127.0.0.1:19786'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`PASS - ${name}`)
  } else {
    fail += 1
    console.log(`FAIL - ${name}${detail ? ` | ${detail}` : ''}`)
  }
}

/** 归一化路径（尾分隔符 + 正斜杠 + 小写），Windows 路径比较用。 */
function norm(p) {
  return String(p || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function pollUntil(page, predFn, timeoutMs, args = []) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let hit = null
    try {
      hit = await page.evaluate(predFn, ...args)
    } catch (_e) {
      hit = null
    }
    if (hit) return true
    await delay(250)
  }
  return null
}

async function cfg() {
  const r = await fetch(`${DAEMON}/api/config`)
  if (!r.ok) throw new Error(`GET /api/config -> ${r.status}`)
  return r.json()
}

async function tgCfg(tgPort) {
  const r = await fetch(`http://127.0.0.1:${tgPort}/api/tg/config`)
  if (!r.ok) throw new Error(`GET /api/tg/config -> ${r.status}`)
  return r.json()
}

/** 发一个 JSON 请求，**不 throw**：4xx 正是要断言的语义。 */
async function send(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_e) {
    /* 非 JSON 响应保留原文 */
  }
  return { status: r.status, json, text }
}

async function gotoApp(page) {
  let lastErr = null
  for (let i = 1; i <= 3; i += 1) {
    try {
      await page.goto(APP, { settleMs: 2500 })
      return
    } catch (e) {
      lastErr = e
      let state = 'n/a'
      try {
        state = await page.evaluate(
          () =>
            `${document.readyState} root=${Boolean(
              document.querySelector('#root') && document.querySelector('#root').children.length,
            )}`,
        )
      } catch (_e2) {
        /* 上下文未建立 */
      }
      console.log(`[nav] 第 ${i} 次导航失败：${e.message}（readyState=${state}）`)
      await delay(2000)
    }
  }
  throw lastErr
}

async function inject(page) {
  await page.evaluate(() => {
    window.__q = (sel) => document.querySelector(sel)
    window.__text = (sel) => {
      const el = document.querySelector(sel)
      return el ? (el.textContent || '').trim() : null
    }
    window.__click = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      el.click()
      return true
    }
    window.__disabled = (sel) => {
      const el = document.querySelector(sel)
      return el ? Boolean(el.disabled) : null
    }
    window.__val = (sel) => {
      const el = document.querySelector(sel)
      return el ? el.value : null
    }
  })
}

/** 打开 设置 → 下载 页签，并等库根（daemon 下发）与「当前生效」都到位。 */
async function openSettings(page) {
  await inject(page)
  await page.evaluate(() => window.__click('[data-testid="nav-settings"]'))
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="settings-tab-downloads"]')),
    { timeout: 15000 },
  )
  await page.evaluate(() => window.__click('[data-testid="settings-tab-downloads"]'))
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="download-dir-picker"] input')),
    { timeout: 15000, intervalMs: 200 },
  )
  // 库根与生效路径都是异步拉的：等它们真的拿到路径再断言，
  // 否则会把「还没加载完」误判成「没有值」（同一断言先 PASS 后 FAIL 的典型成因）。
  try {
    await page.waitForFunction(
      () => {
        const lib = document.querySelector('[data-testid="lib-root-readonly"]')
        const eff = document.querySelector('[data-testid="download-dir-effective"]')
        return (
          Boolean(lib && /[\\/]/.test(lib.textContent || '')) &&
          Boolean(eff && /[\\/]/.test(eff.textContent || ''))
        )
      },
      { timeout: 15000, intervalMs: 200 },
    )
  } catch (_e) {
    /* 超时不在这里失败：让后续断言带实际值去红，信息更准 */
  }
  await inject(page)
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const before = await cfg()
  const originalDir = before.download_dir ?? ''
  // BUG-423：端口真源 BUG-358 起是 plugins[] id="tg".port（旧键 tg_port 兜底）
  const tgPlug = Array.isArray(before.plugins) ? before.plugins.find((x) => x && x.id === 'tg') : null
  const tgPort = tgPlug && Number(tgPlug.port) > 0 ? Number(tgPlug.port) : before.tg_port
  console.log(
    `[fixture] download_dir(前)=${JSON.stringify(originalDir)} tg_port=${tgPort} effective=${before.effective_download_root}`,
  )

  // 临时夹具：改下载目录用（测试结束删掉，不留垃圾）
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-bug323-root-'))
  const tmpDir = path.join(tmpRoot, 'Downloads')

  let restored = false
  const browser = await cdp.launch()
  const page = await browser.newPage()

  try {
    await gotoApp(page)
    await openSettings(page)

    // ── A：单一根（配置真源） ─────────────────────────────────────────
    const a = await readState(page)
    // 引擎真值直接取自 daemon（页面只用于断言「界面与引擎一致」）
    const eff0 = String(before.effective_download_root || '').trim()
    const lib0 = String(before.library_root || '').trim()
    check('A1 daemon 下发 effective_download_root', eff0.length > 3, `"${eff0}"`)
    check(
      'A2 library_root === effective_download_root + \\library（派生关系）',
      norm(lib0) === norm(path.win32.join(eff0, 'library')),
      `lib="${lib0}" eff="${eff0}"`,
    )
    check('A2b 「当前生效」= daemon 的 effective_download_root', norm(a.effText) === norm(eff0), `"${a.effText}"`)

    const tg0 = await tgCfg(tgPort)
    check(
      'A3 orig-tg 库根 === daemon 库根（两进程同源同值）',
      norm(tg0.libraryDir) === norm(lib0),
      `tg="${tg0.libraryDir}" daemon="${lib0}"`,
    )
    check(
      'A4 daemon 不再下发旧键 library_dir（契约已切换为 library_root）',
      !Object.prototype.hasOwnProperty.call(before, 'library_dir'),
      `keys=${Object.keys(before).filter((k) => k.includes('library')).join(',')}`,
    )
    check('A5 库根不再落在应用内部目录（AppData）', !norm(lib0).includes('appdata'), `"${lib0}"`)

    // ── E：界面（只读派生） ──────────────────────────────────────────
    check('E1 库根为只读展示（无输入框，改不了才叫「跟下载走」）', a.libInputAbsent === true, `libInputAbsent=${a.libInputAbsent}`)
    check('E2 「打开库根文件夹」可点（库根有值）', a.openBtnDisabled === false, `disabled=${a.openBtnDisabled}`)
    await page.screenshot(path.join(OUT, '01-settings-single-root.png'))

    // ── B：库根不可独立配置 ─────────────────────────────────────────
    const b1 = await send(`http://127.0.0.1:${tgPort}/api/tg/config`, 'PUT', {
      libraryDir: path.join(tmpRoot, 'elsewhere', 'library'),
    })
    check('B1 PUT orig-tg libraryDir → 422（库根不可独立配置）', b1.status === 422, `status=${b1.status} body=${b1.text.slice(0, 120)}`)
    const b2 = await send(`${DAEMON}/api/config/library`, 'PUT', {
      dir: path.join(tmpRoot, 'elsewhere', 'library'),
    })
    check('B2 PUT daemon /api/config/library → 422（端点已废）', b2.status === 422, `status=${b2.status} body=${b2.text.slice(0, 120)}`)
    // 反向证伪：库根不得因这两次请求而改变
    const tg1 = await tgCfg(tgPort)
    check('B2b 两次越界写入请求均未改变任何一侧的库根', norm(tg1.libraryDir) === norm(lib0), `tg="${tg1.libraryDir}"`)

    // ── C：改下载目录 ⇒ 库根跟随 ─────────────────────────────────────
    const c1 = await send(`${DAEMON}/api/config/download`, 'PUT', { dir: tmpDir })
    const cj = c1.json || {}
    check('C1a PUT 下载目录成功', c1.status === 200, `status=${c1.status} body=${c1.text.slice(0, 120)}`)
    check(
      'C1b 响应 effective_download_root = 新目录',
      norm(cj.effective_download_root) === norm(tmpDir),
      `"${cj.effective_download_root}"`,
    )
    check(
      'C1c 响应 library_root = 新目录\\library（派生）',
      norm(cj.library_root) === norm(path.win32.join(tmpDir, 'library')),
      `"${cj.library_root}"`,
    )
    check('C1d daemon 回报已把下载路径同步给 orig-tg', cj.tg_synced === true, `tg_synced=${cj.tg_synced} err=${cj.tg_error}`)

    // C2：**不碰 daemon 配置**，直读 TG —— 跟随必须是引擎之间的事，不是前端补的
    const tg2 = await tgCfg(tgPort)
    check(
      'C2 orig-tg 库根已跟随到新下载路径（无需重启、无需前端介入）',
      norm(tg2.libraryDir) === norm(path.win32.join(tmpDir, 'library')),
      `tg="${tg2.libraryDir}"`,
    )

    // C3：界面重载后与引擎一致
    await gotoApp(page)
    await openSettings(page)
    const c3 = await readState(page)
    check(
      'C3a 设置页库根只读值 === 引擎派生的新库根',
      norm(c3.libRoot) === norm(path.win32.join(tmpDir, 'library')),
      `ui="${c3.libRoot}"`,
    )
    check('C3b 设置页「当前生效」=== 新下载路径', norm(c3.effText) === norm(tmpDir), `"${c3.effText}"`)
    await page.screenshot(path.join(OUT, '02-settings-followed.png'))

    // ── D：权限边界 = 下载路径 ───────────────────────────────────────
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orighub-bug323-out-'))
    const outsideFile = path.join(outsideDir, 'outside.mp4')
    fs.writeFileSync(outsideFile, 'x')
    const d1 = await send(`${DAEMON}/api/files?path=${encodeURIComponent(outsideFile)}`, 'DELETE')
    check('D1a 界外文件的删除请求被拒（403）', d1.status === 403, `status=${d1.status} body=${d1.text.slice(0, 120)}`)
    check('D1b 界外文件仍在（边界是硬约束，不是提示）', fs.existsSync(outsideFile), outsideFile)
    fs.rmSync(outsideDir, { recursive: true, force: true })
    check('D1c 夹具（界外临时目录）已清理', !fs.existsSync(outsideDir), outsideDir)

    const insideAbsent = path.win32.join(tmpDir, '__bug323_absent__.mp4')
    const d2 = await send(`${DAEMON}/api/files?path=${encodeURIComponent(insideAbsent)}`, 'DELETE')
    check(
      'D2 界内不存在的路径 → 404（判定走到存在性分支，不是被边界拦）',
      d2.status === 404,
      `status=${d2.status}`,
    )

    // ── F：还原夹具 ─────────────────────────────────────────────────
    await send(`${DAEMON}/api/config/download`, 'PUT', { dir: originalDir })
    restored = true
    const after = await cfg()
    check('F1 配置已还原 download_dir', norm(after.download_dir ?? '') === norm(originalDir), `"${after.download_dir}"`)
    const tg3 = await tgCfg(tgPort)
    check(
      'F1b 还原后 orig-tg 库根回到默认派生值',
      norm(tg3.libraryDir) === norm(path.win32.join(after.effective_download_root, 'library')),
      `tg="${tg3.libraryDir}"`,
    )
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    check('F2 临时夹具目录已删除', !fs.existsSync(tmpRoot), tmpRoot)

    await gotoApp(page)
    await openSettings(page)
    const f3 = await readState(page)
    await page.screenshot(path.join(OUT, '03-restored.png'))
    check('F3 重载后界面回到还原值', norm(f3.effText) === norm(after.effective_download_root), `"${f3.effText}"`)

    // ── G：无 console error（只看本功能路径） ────────────────────────
    const errs = page
      .consoleErrors()
      .filter((e) => !/favicon|ERR_/.test(e))
      .filter((e) => !/\/api\/files\?path=/.test(e))
      .filter((e) => !/\/src\/.*\?t=\d+/.test(e))
    check('G1 全程无 console error（排除 D 组负例 404 与 vite 热更）', errs.length === 0, errs.slice(0, 3).join(' | '))
  } catch (e) {
    fail += 1
    console.log(`FAIL - 执行异常：${e && e.message}`)
  } finally {
    if (!restored) {
      try {
        await send(`${DAEMON}/api/config/download`, 'PUT', { dir: originalDir })
        console.log(`[fixture] 兜底还原 download_dir -> ${JSON.stringify(originalDir)}`)
      } catch (e) {
        console.log(`[fixture] 兜底还原失败：${e && e.message}`)
      }
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch (_e) {
      /* 已删 */
    }
    if (browser) await browser.close().catch(() => {})
  }

  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`)
  process.exit(fail === 0 ? 0 : 1)
}

/** 读页面上的库根 / 生效路径 / 只读性。 */
async function readState(page) {
  return page.evaluate(() => {
    const lib = window.__text('[data-testid="lib-root-readonly"]')
    const effLine = window.__text('[data-testid="download-dir-effective"]')
    const effText = effLine ? effLine.replace(/^当前生效：?/, '').trim() : null
    return {
      libRoot: lib,
      effText,
      libInputAbsent: window.__q('[data-testid="lib-dir-picker"]') === null,
      openBtnDisabled: window.__disabled('[data-testid="settings-lib-open"]'),
    }
  })
}

main()
