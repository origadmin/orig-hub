#!/usr/bin/env node
'use strict'

/**
 * BUG-186 独立验收：`POST /api/media/series/:id/merge` 的**批量契约**与**原子性**。
 *
 * ## 这个脚本与 `verify_series_multi_select_merge.cjs` 的关系
 *
 * 后者打**真实渲染**（剧集墙多选 → 对话框 → 合并）证明「用户可达路径」；
 * 本脚本**不碰浏览器**，直接打**真实运行的服务**（orig-tg 127.0.0.1:19787），
 * 逐条核对**后端契约**与**事务原子性**。两者互补：UI 脚本证明「能点到」，
 * 本脚本证明「点到之后服务端的语义边界逐条成立」。
 *
 * ## 断言矩阵（每条都打印**实测值**）
 *
 *   1. 目标不存在               → 404
 *   2. `sourceIds: []`          → 400
 *   3. `sourceIds` 含目标自身    → 400，且**状态指纹逐字不变**
 *   4. `sourceIds` 含不存在的 id → 404，且**状态指纹逐字不变**（目标分集数 / 各源是否仍在 / 分集归属）
 *   5. 两个字段都不给            → 400
 *   6. 旧形态 `{sourceId}` 仍可用 → 单源合并成功（源消失、目标分集 +1）
 *   7. 批量成功：3 个源（每个 ≥1 分集）并入目标 → 目标分集数 = 原 + 3、3 个源消失、
 *      且**分集确实挂在目标上**（逐条按 item 归属核，不只数数字）
 *   8. **原子性**：同一 `sourceIds` 里放「1 个有效源 + 1 个不存在的源」→ 必须 404，
 *      且**有效源也没被并走**（整条链最关键的一条）
 *   9. **测量的反向证伪**：用**同一套**状态指纹去跑一次**预期会改变状态**的成功调用
 *      （第 6 条的旧形态单源合并），断言它**必须测出变化**；测不出 ⇒ 测量空转 ⇒ FAIL。
 *      这一条用来证明第 3/4/8 条的「不变」不是假绿。
 *
 * ## 夹具（只造自己的，用完即删）
 *
 *   用 API 造 1 个目标 + 5 个源剧集（名字带唯一后缀 `ZZ-CONTRACT-<ts>-<K>`），
 *   每个挂 1 个分集（分集条目用唯一假路径，绝不与真实数据碰撞）。
 *   收尾按记录到的 id 精确删除，最后断言 `GET /api/media/series` 的 id 集合
 *   == 开工前记录的集合（证明没误伤真实数据）。
 *
 * ## 环境（用**真实在跑**的服务，严禁隔离实例 —— 隔离会丢真实 TG 数据）
 *
 *     # 服务已在跑：orig-tg 127.0.0.1:19787
 *     node verify/verify_series_merge_batch_contract.cjs
 *
 * ## Usage / Env
 *
 *   TG_API   (default http://127.0.0.1:19787)   orig-tg：/api/media/*
 *
 * Exit: 0 = 全部通过；2 = 断言失败；1 = 环境/通道问题。
 */

const path = require('node:path')

const TG_API = (process.env.TG_API || process.env.ORIG_TG_API || 'http://127.0.0.1:19787').replace(
  /\/$/,
  '',
)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── 断言记录 ──────────────────────────────

const results = []

/**
 * 记录并打印一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} detail 实测细节
 * @returns {boolean} ok
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`)
  return Boolean(ok)
}

function dumpResults() {
  console.log('--- assertions ---')
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail || 'n/a'}`}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`[merge-batch-contract] ${results.length - failed}/${results.length} assertions passed`)
}

// ────────────────────────────── HTTP（仅回环） ──────────────────────────────

/** 回环请求 → { status, json, text }（失败返回 status:0）。 */
async function httpJson(method, url, body) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch (_e) {
      json = null
    }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) }
  }
}

// ────────────────────────────── 后端真源 ──────────────────────────────

/** 列出全部剧集 id 集合（升序）。 */
async function seriesIdSet() {
  const r = await httpJson('GET', `${TG_API}/api/media/series`)
  const items = r.json && Array.isArray(r.json.items) ? r.json.items : []
  return items.map((s) => s.id).sort((a, b) => a - b)
}

/** 取剧集详情（不存在返回 null）。 */
async function getSeries(id) {
  const r = await httpJson('GET', `${TG_API}/api/media/series/${id}`)
  return r.status === 200 && r.json ? r.json : null
}

/** 造一个本地条目（唯一假路径 → 唯一 ref）。返回 itemId 或 null。 */
async function createItem(title) {
  const fakePath = path.join(
    require('node:os').tmpdir(),
    `orighub-contract-${Date.now()}-${title.replace(/[^\w.-]/g, '_')}.mp4`,
  )
  const r = await httpJson('POST', `${TG_API}/api/media/items`, {
    items: [{ path: fakePath, source: 'local', kind: 'video', title }],
  })
  const id = r.json && Array.isArray(r.json.ids) ? r.json.ids[0] : null
  return { id, status: r.status }
}

/** 造一条剧集。返回 seriesId 或 null。 */
async function createSeries(title) {
  const r = await httpJson('POST', `${TG_API}/api/media/series`, { title, kind: 'series' })
  return { id: r.json && typeof r.json.id === 'number' ? r.json.id : null, status: r.status }
}

/** 给剧集挂 1 个分集。 */
async function addEpisode(seriesId, itemId, episodeNo) {
  return httpJson('POST', `${TG_API}/api/media/series/${seriesId}/episodes`, {
    itemId,
    season: 1,
    episodeNo,
  })
}

/** 删剧集（幂等）。 */
async function deleteSeries(id) {
  return httpJson('DELETE', `${TG_API}/api/media/series/${id}`)
}

/** 删条目（幂等）。 */
async function deleteItem(id) {
  return httpJson('DELETE', `${TG_API}/api/media/items/${id}`)
}

/**
 * 调合并端点。
 * @param {number} targetId 路径上的目标剧集
 * @param {object} body 请求体（`{sourceId}` 或 `{sourceIds}` 或 `{}`）
 */
async function merge(targetId, body) {
  return httpJson('POST', `${TG_API}/api/media/series/${targetId}/merge`, body)
}

// ────────────────────────────── 状态指纹 ──────────────────────────────

/**
 * 单个剧集的状态指纹：`null`（不存在）或 `{ epCount, itemIds }`（分集数 + 分集归属的 item id 升序）。
 * @param {number} id 剧集 id
 */
async function seriesFp(id) {
  const d = await getSeries(id)
  if (!d) return null
  const itemIds = (d.episodes || []).map((e) => e.itemId).sort((a, b) => a - b)
  return { epCount: (d.episodes || []).length, declared: d.episodeCount, itemIds }
}

/**
 * 一组剧集的**联合状态指纹**（逐字可比较的字符串）。
 *
 * 覆盖：每个 id 是否存在、目标分集数、每个源的分集归属。任一字段变化 ⇒ 指纹变化。
 * 第 3/4/8 条断言「指纹不变」，第 9 条断言「指纹必须变」—— 用同一函数，互证不空转。
 * @param {number[]} ids 要纳入指纹的剧集 id（含目标与各源）
 */
async function fingerprint(ids) {
  const out = {}
  for (const id of ids) out[String(id)] = await seriesFp(id)
  return JSON.stringify(out)
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  console.log(`[merge-batch-contract] tg-api=${TG_API}`)

  // ── 环境自检 ───────────────────────────────────────────────────────
  const probe = await httpJson('GET', `${TG_API}/api/media/series`)
  if (probe.status !== 200) {
    console.error(
      `[merge-batch-contract] orig-tg media API not reachable (status=${probe.status}). Aborting (env).`,
    )
    process.exit(1)
  }

  // ── 开工前基线（证明结束时零变化）────────────────────────────────────
  const baselineSeries = await seriesIdSet()
  console.log(`[merge-batch-contract] baseline series (${baselineSeries.length}): ${JSON.stringify(baselineSeries)}`)

  const ts = Date.now()
  const created = { series: [], items: [] }
  const fx = {} // key -> { seriesId, itemId, title }

  /**
   * 造一条「剧集 + 1 个分集」夹具。
   * @param {string} key 短标识（T/A/B/C/D/E）
   */
  const makeFixture = async (key) => {
    const title = `ZZ-CONTRACT-${ts}-${key}`
    const item = await createItem(title)
    if (item.id == null) throw new Error(`fixture item ${key} not created (status=${item.status})`)
    created.items.push(item.id)
    const s = await createSeries(title)
    if (s.id == null) throw new Error(`fixture series ${key} not created (status=${s.status})`)
    created.series.push(s.id)
    const ep = await addEpisode(s.id, item.id, 1)
    if (ep.status !== 200) throw new Error(`fixture episode ${key} not added (status=${ep.status})`)
    fx[key] = { seriesId: s.id, itemId: item.id, title }
  }

  try {
    // 目标 T + 源 A/B/C（批量成功用）+ D（原子性用）+ E（旧形态单源用）
    for (const key of ['T', 'A', 'B', 'C', 'D', 'E']) await makeFixture(key)
    console.log(
      `[merge-batch-contract] fixtures: ${JSON.stringify(
        Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, v.seriesId])),
      )}`,
    )

    const T = fx.T.seriesId
    const MISSING = 999999999 // 一个几乎不可能存在的 id
    const allIds = [T, fx.A.seriesId, fx.B.seriesId, fx.C.seriesId, fx.D.seriesId, fx.E.seriesId]

    // 指纹基线（后续 #3/#4/#8 都要求与它逐字一致）
    const FP0 = await fingerprint(allIds)
    console.log(`[merge-batch-contract] FP0 (baseline fingerprint) = ${FP0}`)

    // ── 断言 1：目标不存在 → 404 ──────────────────────────────────────
    const r1 = await merge(MISSING, { sourceIds: [fx.A.seriesId] })
    check('1: 目标不存在 → 404', r1.status === 404, `status=${r1.status} body=${JSON.stringify(r1.json)}`)

    // ── 断言 2：sourceIds 空数组 → 400 ────────────────────────────────
    const r2 = await merge(T, { sourceIds: [] })
    check('2: sourceIds:[] → 400', r2.status === 400, `status=${r2.status} body=${JSON.stringify(r2.json)}`)

    // ── 断言 3：sourceIds 含目标自身 → 400，指纹不变 ──────────────────
    const r3 = await merge(T, { sourceIds: [fx.A.seriesId, T] })
    const fp3 = await fingerprint(allIds)
    check(
      '3: sourceIds 含目标自身 → 400',
      r3.status === 400,
      `status=${r3.status} body=${JSON.stringify(r3.json)}`,
    )
    check(
      '3b: 自合并被拒后状态指纹逐字不变',
      fp3 === FP0,
      fp3 === FP0 ? 'fingerprint identical to FP0' : `CHANGED\n  before=${FP0}\n  after =${fp3}`,
    )

    // ── 断言 4：sourceIds 含不存在的 id → 404，指纹逐字不变 ───────────
    const r4 = await merge(T, { sourceIds: [fx.A.seriesId, MISSING] })
    const fp4 = await fingerprint(allIds)
    check(
      '4: sourceIds 含不存在的 id → 404',
      r4.status === 404,
      `status=${r4.status} body=${JSON.stringify(r4.json)}`,
    )
    check(
      '4b: 源缺失被拒后状态指纹逐字不变（目标分集数 / 各源是否仍在 / 分集归属）',
      fp4 === FP0,
      fp4 === FP0 ? 'fingerprint identical to FP0' : `CHANGED\n  before=${FP0}\n  after =${fp4}`,
    )

    // ── 断言 5：两个字段都不给 → 400 ──────────────────────────────────
    const r5 = await merge(T, {})
    check('5: 两个字段都不给 → 400', r5.status === 400, `status=${r5.status} body=${JSON.stringify(r5.json)}`)

    // ── 断言 8（先做，D 必须在被并走之前测）：有效源 + 不存在的源 → 404，有效源没被并走 ──
    const D = fx.D.seriesId
    const fp8Before = await fingerprint(allIds)
    const r8 = await merge(T, { sourceIds: [D, MISSING] })
    const fp8After = await fingerprint(allIds)
    const dStillThere = (await getSeries(D)) !== null
    check(
      '8: 同一 sourceIds 里「1 个有效源 + 1 个不存在的源」→ 404',
      r8.status === 404,
      `status=${r8.status} body=${JSON.stringify(r8.json)}`,
    )
    check(
      '8b: 原子性 —— 有效源 D 也没被并走（D 仍在，且状态指纹逐字不变）',
      dStillThere && fp8After === fp8Before,
      `D_exists=${dStillThere} fpUnchanged=${fp8After === fp8Before}` +
        (fp8After === fp8Before ? '' : `\n  before=${fp8Before}\n  after =${fp8After}`),
    )

    // ── 断言 6 + 9：旧形态单源合并（成功，且测量必须测出变化）──────────
    const E = fx.E.seriesId
    const fp6Before = await fingerprint(allIds)
    const tBefore = await seriesFp(T)
    const r6 = await merge(T, { sourceId: E }) // 旧形态：{sourceId}
    const fp6After = await fingerprint(allIds)
    const tAfter = await seriesFp(T)
    const eGone = (await getSeries(E)) === null
    const tDelta = tAfter.epCount - tBefore.epCount
    const eItemAttached = tAfter.itemIds.includes(fx.E.itemId)
    check(
      '6: 旧形态 {sourceId} 仍可用 —— 单源合并成功（源消失、目标分集 +1、源分集挂到目标）',
      r6.status === 200 && eGone && tDelta === 1 && eItemAttached,
      `status=${r6.status} body=${JSON.stringify(r6.json)} E_gone=${eGone} targetEp ${tBefore.epCount}→${tAfter.epCount} (Δ=${tDelta}) E_item(${fx.E.itemId})_on_target=${eItemAttached}`,
    )
    check(
      '9: 测量的反向证伪 —— 同一状态指纹在「预期会改变状态」的成功调用上必须测出变化',
      fp6After !== fp6Before,
      fp6After !== fp6Before
        ? `fingerprint changed as expected (${fp6Before.length}→${fp6After.length} bytes)`
        : `MEASUREMENT VACUOUS: fingerprint unchanged across a successful single-source merge\n  before=${fp6Before}\n  after =${fp6After}`,
    )

    // ── 断言 7：批量成功（3 个源，每个 ≥1 分集）────────────────────────
    const sources = [fx.A.seriesId, fx.B.seriesId, fx.C.seriesId]
    const srcItemIds = [fx.A.itemId, fx.B.itemId, fx.C.itemId]
    const tBefore7 = await seriesFp(T)
    const r7 = await merge(T, { sourceIds: sources })
    await delay(200)
    const tAfter7 = await seriesFp(T)
    const sourcesGone = []
    for (const s of sources) sourcesGone.push((await getSeries(s)) === null)
    const delta7 = tAfter7.epCount - tBefore7.epCount
    // 逐条按 item 归属核：3 个源的分集条目确实挂在目标上。
    const ownership = srcItemIds.map((it) => ({ itemId: it, onTarget: tAfter7.itemIds.includes(it) }))
    const allAttached = ownership.every((o) => o.onTarget)
    check(
      '7: 批量成功 —— 3 个源并入目标，目标分集数 = 原 + 3',
      r7.status === 200 && delta7 === 3,
      `status=${r7.status} body=${JSON.stringify(r7.json)} targetEp ${tBefore7.epCount}→${tAfter7.epCount} (Δ=${delta7})`,
    )
    check(
      '7b: 3 个源剧集全部消失',
      sourcesGone.every(Boolean),
      `sources=${JSON.stringify(sources)} gone=${JSON.stringify(sourcesGone)}`,
    )
    check(
      '7c: 3 个源的分集**确实挂在目标上**（逐条按 item 归属核，不只数数字）',
      allAttached,
      `ownership=${JSON.stringify(ownership)} targetItemIds=${JSON.stringify(tAfter7.itemIds)}`,
    )

    // ── 页面健康无关（本脚本不打浏览器）────────────────────────────────
  } finally {
    // ── 收尾：只删自己造的夹具（按记录到的 id）──────────────────────────
    for (const id of created.series) await deleteSeries(id).catch(() => undefined)
    for (const id of created.items) await deleteItem(id).catch(() => undefined)
    await delay(150)
    const after = await seriesIdSet()
    const sameSet =
      after.length === baselineSeries.length &&
      after.every((v, i) => v === baselineSeries[i])
    console.log(
      `[merge-batch-contract] cleanup: removed series=${JSON.stringify(created.series)} items=${JSON.stringify(created.items)}`,
    )
    console.log(`[merge-batch-contract] series ids after=${JSON.stringify(after)}`)
    check(
      '收尾：剧集 id 集合与开工前逐字一致（未误伤真实数据）',
      sameSet,
      sameSet
        ? `identical (${after.length} ids)`
        : `DIFF\n  before=${JSON.stringify(baselineSeries)}\n  after =${JSON.stringify(after)}`,
    )
  }

  dumpResults()
  const failed = results.filter((r) => !r.ok).length
  if (failed > 0) process.exitCode = 2
}

main().catch((e) => {
  console.error('[merge-batch-contract] ERROR', (e && e.message) || e)
  process.exit(1)
})
