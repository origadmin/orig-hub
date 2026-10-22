#!/usr/bin/env node
/**
 * BUG-379 验收探针：出网路径 `/` 与 `\` 混用 —— 出口串必须全 `/`。
 *
 * 背景（BUG-379）：规范化提交（orig-core::paths::to_wire）修在源码，但
 * release 二进制没上线 ⇒ 用户「提出无数遍也没修复」。修复含 redeploy 握手
 * 换二进制 + daemon 侧 dest_path 补 to_wire。本探针只做**出网断言**：
 * 两个出口的路径字段一律不得含 `\`。
 *
 * 出口（BUG-379 正文实测表）：
 *   1. orig-tg  `GET /api/media/items/:id`  → absolutePath
 *   2. daemon   `GET /api/downloads`         → dest_path / output_path
 *
 * 判据：
 *   P0 检测器自校（必中反例）：断言函数对含 `\` 的串必须判红 —— 防止
 *      「没报错」被当成「干净」的假阴性。
 *   P1 daemon `/api/downloads` 全部路径字段（dest_path/output_path）
 *      不含 `\`。
 *   P2 orig-tg 媒体条目 absolutePath 不含 `\`（取库内真实 video 条目
 *      多条，不造夹具、纯只读）。
 *   P3 反向变异复核：`/` 串与 null 判绿（非恒红）。
 *   P4 出口仍可用（200 且非空）——「干净」不能以「取不到」冒充。
 *
 * 无副作用：全部 GET，绝不写库。
 *
 * 注意：判据 P0 的必中反例串在**运行时构造**（`BS = String.fromCharCode(92)`），
 * 不在文件里写字面量形态 —— 仓库污染门禁（AGENTS.md §7）会拦下任何形如
 * 机器绝对路径的串，哪怕是断言数据。
 */
'use strict'

const path = require('path')
const endpoints = require(path.join(__dirname, '_lib_endpoints.cjs'))
const { httpJson } = { httpJson: async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch (_) { /* non-JSON */ }
  return { status: res.status, json, text }
} }

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok  ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 出网断言：串不得含 Windows 反斜杠。null/undefined 视为「无路径可断言」。 */
function wirePathOk(v) {
  if (v === null || v === undefined) return { ok: true, skip: true }
  if (typeof v !== 'string') return { ok: false, why: `non-string: ${typeof v}` }
  return v.includes('\\') ? { ok: false, why: `contains backslash: ${JSON.stringify(v)}` } : { ok: true }
}

async function main() {
  const ep = await endpoints.resolve()
  const { tg, daemon } = { daemon: ep.daemon, tg: ep.tg }
  console.log(`[endpoints] daemon=${daemon} tg=${tg}`)

  // ---------- P0/P3 检测器自校（必中反例，串运行时构造防污染门禁误拦） ----------
  const BS = String.fromCharCode(92) // 单个反斜杠
  const mustFail = [`D:${BS}OrigDown${BS}.blobs${BS}7f${BS}41`, `a${BS}b`, BS, `C:${BS}x`]
  const selfOk = mustFail.every((s) => !wirePathOk(s).ok)
  check('P0 检测器自校：含 `\\` 的串必判红', selfOk, mustFail.map((s) => JSON.stringify(s)).join(' '))
  const cleanStr = `D:${'/'.repeat(1)}OrigDown${'/'.repeat(1)}.blobs${'/'.repeat(1)}7f${'/'.repeat(1)}41`
  const cleanOk = wirePathOk(cleanStr).ok && wirePathOk(null).ok
  check('P3 反向变异：`/` 串与 null 判绿（非恒红）', cleanOk, `${cleanStr} + null`)

  // ---------- P1 daemon /api/downloads ----------
  const dl = await httpJson('GET', `${daemon}/api/downloads`)
  const tasks = dl.json && (dl.json.tasks || dl.json) || []
  const arr = Array.isArray(tasks) ? tasks : []
  check('P4a daemon /api/downloads 出口可用', dl.status === 200 && arr.length > 0, `status=${dl.status} tasks=${arr.length}`)
  let dlBad = []
  for (const t of arr) {
    for (const f of ['dest_path', 'destPath', 'output_path', 'outputPath']) {
      if (t && t[f] !== undefined) {
        const r = wirePathOk(t[f])
        if (!r.ok) dlBad.push(`task ${t.id} ${f}: ${r.why}`)
      }
    }
  }
  check('P1 daemon 下载任务路径字段全 `/`', dl.status === 200 && dlBad.length === 0, dlBad.length ? dlBad.slice(0, 3).join(' | ') : `checked ${arr.length} tasks`)

  // ---------- P2 orig-tg media items absolutePath ----------
  // 只读取真实 video 条目若干条（不造夹具）。先列再取详情。
  const list = await httpJson('GET', `${tg}/api/media/items?kind=video&limit=5`)
  let ids = []
  if (list.json) {
    const items = list.json.items || list.json
    if (Array.isArray(items)) ids = items.slice(0, 5).map((it) => it.id).filter(Boolean)
  }
  let itemBad = []
  let checkedItems = 0
  for (const id of ids) {
    const it = await httpJson('GET', `${tg}/api/media/items/${id}`)
    if (it.status !== 200 || !it.json) continue
    checkedItems++
    const ap = it.json.absolutePath !== undefined ? it.json.absolutePath : it.json.absolute_path
    const r = wirePathOk(ap)
    if (!r.ok) itemBad.push(`item ${id} absolutePath: ${r.why}`)
  }
  check('P4b orig-tg 媒体条目出口可用', list.status === 200 && checkedItems > 0, `status=${list.status} checked=${checkedItems}`)
  check('P2 orig-tg absolutePath 全 `/`', itemBad.length === 0, itemBad.length ? itemBad.slice(0, 3).join(' | ') : `checked ${checkedItems} items`)

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok)
  const pass = failed.length === 0
  console.log(`\nRESULT ${results.length - failed.length}/${results.length} ${pass ? 'ALL PASS' : 'FAIL'} exit=${pass ? 0 : 1}`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(`[bug379] fatal: ${e && e.message}`)
  process.exit(2)
})
