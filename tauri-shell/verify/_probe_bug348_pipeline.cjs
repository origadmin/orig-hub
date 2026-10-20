/**
 * BUG-346 / BUG-347 / BUG-348 / BUG-349 流水线验收探针（真实运行栈，CDP）。
 *
 * 用法：`node verify/_probe_bug348_pipeline.cjs [--expect-legacy]`
 *
 * 判据：
 *   S1 BUG-346 选中态是**行**的属性：勾选后容器的 `backgroundColor` /
 *      `borderColor` 必须真的变化（不是只有 checkbox 自己的勾），且
 *      `data-selected="1"`；
 *   S2 BUG-348 行是**一行**：行内所有动作元素（时间/图标钮/主操作/删除）的
 *      `top` 必须同排（±2px），行高 ≤ 单行阈值；
 *   S3 BUG-348 进度词汇缺席：行内不得再出现进度条 / 百分比 / 字节 / 速度 /
 *      ETA / 停滞读数；
 *   S4 BUG-347 读数不恒 0：统计条三段之和必须 > 0，且与「全部」页签读数一致；
 *   S5 BUG-349 TG 视图只留一条链：面板打开期间 `/api/activity` 出现 **0** 次，
 *      `/api/tg/cache/tasks/all` 轮次受 5s 节拍约束（≤ 上限）。
 *
 * 验牙（`--expect-legacy`）：反置 S1/S3/S5 为**旧实现可观测**形态。
 *   - 旧实现：选中不换行容 ⇒ S1 必 FAIL；
 *   - 旧实现：行内挂 progress/pct/bytes/speed/eta ⇒ S3 必 FAIL；
 *   - 旧实现：面板打开时 activity 与 tasks/all 并行 ⇒ S5 必 FAIL。
 *   两个方向都证（新实现 PASS / 旧实现 FAIL），断言才有牙（禁恒绿）。
 *
 * 清理：只读（勾选一行后会取消勾选，不删任何东西、不落盘）。
 */
const path = require('node:path')
const fs = require('node:fs')
const cdp = require(path.resolve(__dirname, 'lib', 'cdp.cjs'))

const APP = process.env.APP || 'http://127.0.0.1:5180/'
const LEGACY = process.argv.includes('--expect-legacy')
const SHOTS = path.resolve(__dirname, '..', '..', 'verify_shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function push(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await cdp.launch()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const hits = []
    page.conn.on('Network.requestWillBeSent', (p) => {
      const u = (p.request && p.request.url) || ''
      if (!u || u.startsWith('data:')) return
      if (u.includes('/src/') || u.includes('/node_modules/') || u.includes('favicon')) return
      hits.push(u.replace(/^https?:\/\/[^/]+/, ''))
    })
    await page.conn.send('Network.enable', {}, { sessionId: page.sessionId })
    /**
     * BUG-349 的观测前提：`useIngestGroups` 是否启用，在**无活稳态**下是看不出来的
     *     （BUG-343 的三闸让两条链都休眠 ⇒ 旧写法也 0 次请求 ⇒ 判据恒绿）。
     *
     * 所以这里把浏览器看到的 `/api/activity` 改写成「有一条在传的任务」，让 activity
     * 链进入 3s 跟手轮询：**纯观测侧注入，不碰真实数据**（不发真实下载、不写入库）。
     * 于是 「TG 视图还留着这条链吗」变成可测的：旧写法每 3s 一次，面板在场的新写法 0 次。
     */
    await page.conn.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(function(){
  var orig = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (url.indexOf('/api/activity') >= 0) {
      window.__activityCalls = (window.__activityCalls || 0) + 1;
      var body = JSON.stringify({
        sources: [{ kind: 'cache', available: true }],
        tasks: [{
          kind: 'cache',
          control: { native_id: 999999 },
          chatId: -1000000,
          groupKey: 'probe:fake:1',
          messageIds: [1],
          total: 1,
          done: 0,
          status: 'running',
          updated_at: Math.floor(Date.now() / 1000),
          name: 'probe-fake-running',
          priority: 0,
        }],
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return orig.apply(this, arguments);
  };
})()`,
      },
      { sessionId: page.sessionId },
    )
    await page.goto(APP, { timeout: 90000 })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nav-tg"]')
      if (el) el.click()
    })
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="tg-cache-manager-entry"]'),
      { timeout: 30000 },
    )
    await sleep(1200)
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tg-cache-manager-entry"]')
      if (b) b.click()
    })
    await page.waitForFunction(() => !!document.querySelector('[data-testid="cache-manager"]'), {
      timeout: 20000,
    })
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="cache-task-row"]').length > 0,
      { timeout: 20000 },
    )
    await sleep(1000)

    // ── S1：选中态是行的属性（BUG-346） ──
    const readRow = () =>
      page.evaluate(() => {
        const row = document.querySelector('[data-testid="cache-task-row"]')
        if (!row) return null
        const cs = getComputedStyle(row)
        const cb = row.querySelector('[data-testid="cache-select-row"]')
        return {
          id: row.getAttribute('data-task-id'),
          selected: row.getAttribute('data-selected'),
          ariaSelected: row.getAttribute('aria-selected'),
          bg: cs.backgroundColor,
          border: cs.borderColor,
          h: Math.round(row.getBoundingClientRect().height),
          cbSize: cb
            ? Math.round(cb.getBoundingClientRect().width) +
              'x' +
              Math.round(cb.getBoundingClientRect().height)
            : null,
        }
      })
    const before = await readRow()
    await page.evaluate(() => {
      const cb = document.querySelector(
        '[data-testid="cache-task-row"] [data-testid="cache-select-row"]',
      )
      if (cb) cb.click()
    })
    await sleep(400)
    const after = await readRow()
    const changed = before && after && (before.bg !== after.bg || before.border !== after.border)
    if (LEGACY) {
      push(
        'S1(legacy) 选中不换行容（旧实现形态）',
        // 旧形态：容器样式无 selected 分支 ⇒ 勾选前后 **行的 computed style 一字不变**
        //（`data-selected` 属性也是新加的，旧形态下恒 null）。
        before && after && before.selected === after.selected && !changed,
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      )
    } else {
      push(
        'S1 勾选后行容器真的变色 + data-selected=1 + 复选框 16px（BUG-346）',
        !!after &&
          after.selected === '1' &&
          after.ariaSelected === 'true' &&
          after.cbSize === '16x16' &&
          changed,
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)} changed=${changed}`,
      )
    }
    await page.screenshot(path.join(SHOTS, 'bug346-selected-row.png'))
    // 取消勾选，保持只读
    await page.evaluate(() => {
      const cb = document.querySelector(
        '[data-testid="cache-task-row"] [data-testid="cache-select-row"]',
      )
      if (cb) cb.click()
    })

    // ── S2：一行一排（BUG-348 排版） ──
    // 只看**第一行信息排**（row.children[0]）：异常行的「成因 / 未入库」是设计保留
    // 的第二信息行，不该被算成「换行」；用户抱怨的错位发生在第一行。
    const layout = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="cache-task-row"]'))
      const out = []
      for (const row of rows.slice(0, 12)) {
        const head = row.children[0]
        if (!head) continue
        const kids = Array.from(head.querySelectorAll('button, span, input')).filter((k) => {
          const kr = k.getBoundingClientRect()
          return kr.width > 0 && kr.height > 0
        })
        // 换行与否看**中心线**（容器是 items-center：高度不同的元素顶端本就不齐，
        // 只有落到第二排才会让中心线错开）。
        const mid = kids.map((k) => {
          const kr = k.getBoundingClientRect()
          return Math.round(kr.top + kr.height / 2)
        })
        const headMid = Math.round(head.getBoundingClientRect().top + head.getBoundingClientRect().height / 2)
        out.push({
          h: Math.round(row.getBoundingClientRect().height),
          spread: Math.max(...mid.map((m) => Math.abs(m - headMid))),
          buttons: head.querySelectorAll('button').length,
          infoLines: row.children.length,
        })
      }
      return out
    })
    const maxSpread = Math.max(...layout.map((x) => x.spread))
    const maxBtns = Math.max(...layout.map((x) => x.buttons))
    // 单行行 = 没有第二信息行（成因/未入库）的那些
    const oneLine = layout.filter((x) => x.infoLines === 1).map((x) => x.h)
    const maxOneLineH = oneLine.length ? Math.max(...oneLine) : 0
    const maxH = Math.max(...layout.map((x) => x.h))
    if (LEGACY) {
      push(
        'S2(legacy) 行是多行且/或多颗带字按钮（旧实现形态）',
        maxSpread > 0 || maxBtns > 3,
        `maxH=${maxH} maxSpread=${maxSpread} maxButtons=${maxBtns}`,
      )
    } else {
      // 单行：内容同排（±2px），且行高不超过单行的合理上限（含 p-2.5 上下 10px + 28px 控件）
      push(
        'S2 信息排同排不换行 + 单行行高 ≤52 + 动作 ≤3 颗（BUG-348）',
        maxSpread <= 2 && maxOneLineH <= 52 && maxBtns <= 3,
        `maxSpread=${maxSpread} maxOneLineH=${maxOneLineH} maxAllH=${maxH} maxButtons=${maxBtns} rows=${layout.length}`,
      )
    }

    // ── S3：进度词汇缺席（BUG-348） ──
    const progressJunk = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="cache-manager"]')
      if (!panel) return null
      const sel =
        '[role="progressbar"],[data-testid="cache-task-bytes-pct"],[data-testid="cache-task-bytes"],' +
        '[data-testid="cache-task-speed"],[data-testid="cache-task-eta"],' +
        '[data-testid="cache-task-stalled"],[data-testid="cache-task-preparing"],' +
        '[data-testid="cache-task-godownload"]'
      const junk = Array.from(panel.querySelectorAll(sel))
      return junk.map((x) => x.getAttribute('data-testid') || x.getAttribute('role'))
    })
    if (LEGACY) {
      push(
        'S3(legacy) 行内挂着进度读数与跨界出口（旧实现形态）',
        progressJunk !== null && progressJunk.length > 0,
        JSON.stringify(progressJunk),
      )
    } else {
      push(
        'S3 行内无进度条/百分比/字节/速度/ETA/停滞/去下载查看（BUG-348）',
        progressJunk !== null && progressJunk.length === 0,
        JSON.stringify(progressJunk),
      )
    }

    // ── S4：读数不恒 0，且与页签一致（BUG-347） ──
    const reads = await page.evaluate(() => {
      const num = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const m = (el.textContent || '').match(/(\d+)/)
        return m ? Number(m[1]) : null
      }
      const tabAll = num('[data-testid="cache-scope-all"]')
      return {
        done: num('[data-testid="ingest-summary-done"]'),
        active: num('[data-testid="ingest-summary-active"]'),
        failed: num('[data-testid="ingest-summary-failed"]'),
        tabAll,
        rows: document.querySelectorAll('[data-testid="cache-task-row"]').length,
      }
    })
    const sum = reads.done + reads.active + reads.failed
    if (LEGACY) {
      push(
        'S4(legacy) 统计条恒 0（旧实现形态）',
        sum === 0,
        JSON.stringify(reads),
      )
    } else {
      push(
        'S4 统计条非 0 且与「全部」页签读数一致（BUG-347）',
        sum > 0 && reads.tabAll !== null && sum === reads.tabAll,
        JSON.stringify(reads),
      )
    }
    await page.screenshot(path.join(SHOTS, 'bug348-pipeline-rows.png'))

    // ── S5：面板打开期间的请求链（BUG-349） ──
    const t0 = Date.now()
    const startIdx = hits.length
    // 基线：**面板打开之后**才算。进 TG 视图时 hook 会首拉一次（入口小计数要的数），
    // 那是合法的；要掐的是「面板在场还继续轮」。
    const baseCalls = await page.evaluate(() => window.__activityCalls || 0)
    await sleep(45000)
    const endCalls = await page.evaluate(() => window.__activityCalls || 0)
    const window = hits.slice(startIdx)
    const tasksAll = window.filter((u) => u.startsWith('/api/tg/cache/tasks/all')).length
    const dialogs = window.filter((u) => u.startsWith('/api/tg/dialogs')).length
    const metrics = {
      secs: Math.round((Date.now() - t0) / 1000),
      total: window.length,
      activityAfterOpen: endCalls - baseCalls,
      activityTotal: endCalls,
      tasksAll,
      dialogs,
    }
    if (LEGACY) {
      push(
        'S5(legacy) 面板在场时 activity 链仍在轮（旧实现形态）',
        metrics.activityAfterOpen >= 5,
        JSON.stringify(metrics),
      )
    } else {
      // 45s 窗口：面板在场 ⇒ ingest hook 让位（TG 视图不再启用）⇒ activity **一次不发**；
      // 伪造的有活报文证明「不是因为没活才安静」。tasks/all 受面板自己的 5s 节拍。
      push(
        'S5 面板在场时 activity 链一次不发（有活报文仍为 0）+ tasks/all ≤10（BUG-349）',
        metrics.activityAfterOpen === 0 && metrics.tasksAll <= 10 && metrics.dialogs <= 4,
        JSON.stringify(metrics),
      )
    }
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${LEGACY ? '[legacy 镜像]' : '[新实现]'} ${results.length - failed.length}/${results.length} PASS`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(' | '))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('probe error:', e)
  process.exitCode = 1
})
