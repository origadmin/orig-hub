'use strict'

/**
 * tauri-shell/verify/lib/sandbox.cjs
 *
 * 验收 / 诊断脚本的「污染防线」—— 防止临时脚本把测试残留写进**用户真实库**。
 * 详见 `docs/bugs/BUG-161.md`。
 *
 * ## 背景（BUG-161）
 *
 * 用户媒体库里出现了 `DiagCard_1790177710808` 这类「没有正确标题 / 内容」的条目。
 * 全仓 grep `DiagCard` 零命中 —— 它**不是产品代码生成的**，而是本机某次验收 / 诊断
 * 脚本直连**生产** orig-tg（`127.0.0.1:9877`，背后是用户真实库
 * `%APPDATA%\com.origadmin.orighub\tg\store.db`）建了一个剧集后**没有清理**，于是
 * 它作为一张「0 分集的孤儿剧集卡」留在了剧集墙上，用户可见。
 *
 * 根因：`tauri-shell/verify/*.cjs` 默认把后端地址指向**生产** 9877，且没有任何守卫
 * 阻止写入；清理只写在 `finally` 里，脚本被 kill / 未走 finally 时残留即落地。
 *
 * ## 本模块提供的三道防线
 *
 * 1. `guardWrites(scriptName, base)` —— 默认**拒绝**对生产实例写入（退出码 2）。
 *    确需在生产实例上做写验证时，必须显式 `ORIG_VERIFY_ALLOW_PROD_WRITES=1` 才放行
 *    （对应项目规则「删除 / 写任何东西要显式授权」）。推荐做法仍是**独立端口 + 唯一
 *    库名 + mock 构建**（见 `download-engine/verify/verify_bug_135_136.py` 头的拉起示例）。
 *
 * 2. `trackCleanup(fn)` + `installCleanup()` —— 登记清理动作，由进程钩子
 *    （`beforeExit` / `SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection`）
 *    在**所有**退出路径执行，不再依赖脚本作者手写 `finally`。
 *
 * 3. `createTempSeries(base, prefix)` —— 建临时剧集的**同时**自动登记删除，
 *    「建了不删」在 API 上不可表达。
 *
 * 另附 `listResidue(base)` / `sweepResidue(base, { apply })`：按已知测试前缀列出
 * （并可选删除）孤儿残留，供人工授权后一次性清理。
 *
 * @module sandbox
 */

const http = require('node:http')

/** 指向本机的等价写法 —— 它们都算「同一台机器上的生产实例」。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

/** 生产 orig-tg 端口（= 用户真实库的入口）。daemon 在 9876，不要混。 */
const PROD_PORT = 9877

/** 已知验收 / 诊断脚本的临时实体标题前缀（残留识别用）。 */
const TEST_TITLE_PREFIXES = [
  'DiagCard_',
  'VerifySeriesNF_',
  'VerifyProbe_',
  'Verify_',
  '验收改名-',
  '__probe_series__',
  '复现系列',
]

/** 形如 `任意前缀_<13 位毫秒>` 的合成标题 —— 测试残留的典型签名。 */
const MS_SUFFIX_RE = /_\d{13}$/

// ────────────────────────────── 地址判定 ──────────────────────────────

/**
 * 解析 base 的 host 与 port（容错：非法 URL 返回空值）。
 *
 * @param {string} base 形如 `http://127.0.0.1:9877`。
 * @returns {{host: string, port: number}} 解析结果；非法时 `{host:'', port:0}`。
 */
function parseHostPort(base) {
  try {
    const u = new URL(String(base))
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    return { host: u.hostname, port }
  } catch (_e) {
    return { host: '', port: 0 }
  }
}

/**
 * 目标是否为**生产**实例（回环地址 + 9877）。
 *
 * @param {string} base 后端 base。
 * @returns {boolean} 是生产实例则为 true。
 */
function isProduction(base) {
  const { host, port } = parseHostPort(base)
  return LOOPBACK_HOSTS.has(host) && port === PROD_PORT
}

// ────────────────────────────── 清理登记 ──────────────────────────────

/** @type {Array<() => (void|Promise<void>)>} */
const _cleanups = []
let _installed = false

/**
 * 登记一个清理动作（后登记的**先**执行，便于「先建的实体后删」）。
 *
 * @param {() => (void|Promise<void>)} fn 清理函数。
 */
function trackCleanup(fn) {
  if (typeof fn === 'function') _cleanups.push(fn)
}

/**
 * 依次执行并清空已登记的清理动作（逆序）。单个失败不打断其余。
 *
 * @returns {Promise<void>} 全部执行完（含失败吞掉并打印）后 resolve。
 */
async function runCleanups() {
  const fns = _cleanups.splice(0, _cleanups.length)
  for (const fn of fns.reverse()) {
    try {
      await fn()
    } catch (e) {
      console.error(`[sandbox] cleanup failed: ${e && e.message ? e.message : e}`)
    }
  }
}

/**
 * 安装进程级清理钩子（幂等）。覆盖所有退出路径：
 * 正常退出前的 `beforeExit`（可跑异步）、`SIGINT` / `SIGTERM`、未捕获异常 / 未处理拒绝。
 */
function installCleanup() {
  if (_installed) return
  _installed = true
  // beforeExit 在事件循环清空、进程真正退出前触发，且允许调度异步工作 ——
  // 这是「脚本没显式调 finalize() 也能清理」的关键。
  process.on('beforeExit', () => {
    runCleanups()
  })
  const onSignal = (sig) => {
    runCleanups().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('uncaughtException', (err) => {
    console.error(`[sandbox] uncaught: ${err && err.stack ? err.stack : err}`)
    runCleanups().finally(() => process.exit(2))
  })
  process.on('unhandledRejection', (err) => {
    console.error(`[sandbox] unhandledRejection: ${err && err.message ? err.message : err}`)
    runCleanups().finally(() => process.exit(2))
  })
}

/**
 * 显示执行清理（供脚本在退出前显式调用；与钩子互为兜底，幂等）。
 *
 * @returns {Promise<void>} 清理完成。
 */
async function finalize() {
  await runCleanups()
}

// ────────────────────────────── 写守卫 ──────────────────────────────

/**
 * 写守卫：默认**拒绝**对生产实例写入，避免在用户真实库里留下可见残留。
 *
 * - 目标是生产实例且未设 `ORIG_VERIFY_ALLOW_PROD_WRITES=1` → 打印指引并 `exit 2`。
 * - 目标是生产实例且已显式授权 → 打印醒目 WARN，并自动安装清理钩子。
 * - 目标非生产实例 → 直接放行（推荐姿态）。
 *
 * @param {string} scriptName 脚本名（仅用于日志）。
 * @param {string} base 脚本将要写入的后端 base。
 * @returns {void}
 */
function guardWrites(scriptName, base) {
  if (!isProduction(base)) return
  if (process.env.ORIG_VERIFY_ALLOW_PROD_WRITES !== '1') {
    console.error('')
    console.error('============================================================')
    console.error(`[sandbox] 拒绝执行：${scriptName} 会对**生产实例**写入。`)
    console.error(`[sandbox] 目标：${base}`)
    console.error('[sandbox] 生产实例背后是用户真实库，写入会留下用户可见残留')
    console.error('[sandbox] （历史事故：DiagCard_<ms> 孤儿剧集，见 BUG-161）。')
    console.error('')
    console.error('[sandbox] 推荐做法：指向**隔离实例**（独立端口 + 唯一库名 + mock 构建）：')
    console.error('  cd download-engine && CARGO_TARGET_DIR=target-mock \\')
    console.error('    cargo build -p orig-tg --release --features mock')
    console.error('  ORIG_TG_PORT=19877 ORIG_TG_DB="$TMP/store-$(date +%s).db" \\')
    console.error('  ORIG_TG_SESSION="$TMP/s.session" ORIG_TG_MOCK=1 \\')
    console.error('    target-mock/release/orig-tg.exe &   # 然后 ORIG_MEDIA_API=http://127.0.0.1:19877 ...')
    console.error('')
    console.error('[sandbox] 若确需在生产实例上做写验证（显式授权，后果自负）：')
    console.error('  ORIG_VERIFY_ALLOW_PROD_WRITES=1 node ' + scriptName)
    console.error('============================================================')
    console.error('')
    process.exit(2)
  }
  console.warn(
    `[sandbox] WARNING：${scriptName} 已获显式授权对生产实例写入（${base}）。` +
      '所有临时实体必须登记清理（createTempSeries / trackCleanup）。',
  )
  installCleanup()
}

// ────────────────────────────── HTTP 小工具 ──────────────────────────────

/**
 * 极简 JSON HTTP 请求（回环 server-to-server，不受浏览器 CORS 约束）。
 *
 * @param {string} method HTTP 方法。
 * @param {string} url 完整 URL。
 * @param {unknown} [body] 请求体（会被 JSON 序列化；null/undefined 表示无体）。
 * @param {number} [timeoutMs] 超时毫秒。
 * @returns {Promise<{status:number, json:any}>} 状态码与解析后的 JSON（解析失败为 null）。
 */
function httpJson(method, url, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = http.request(url, { method, timeout: timeoutMs, headers }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (raw += c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(raw)
        } catch (_e) {
          /* 非 JSON 响应 */
        }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', () => resolve({ status: 0, json: null }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null })
    })
    if (data) req.write(data)
    req.end()
  })
}

// ────────────────────────────── 临时实体（自动清理） ──────────────────────────────

/**
 * 在生产 / 隔离实例上建一个**临时剧集**，并自动登记删除（含异常路径）。
 *
 * @param {string} base 后端 base。
 * @param {string} [prefix] 标题前缀，默认 `VerifyProbe_`（落在已知残留前缀内，便于兜底扫描）。
 * @returns {Promise<{id:number, title:string}>} 新建剧集的 id 与标题。
 */
async function createTempSeries(base, prefix = 'VerifyProbe_', attempts = 4) {
  installCleanup()
  /*
   * BUG-422：orig-tg 偶发 **~14s stall**（实测同一条 GET 时快时慢：0.1s vs 13.7s），
   * httpJson 默认 8s 超时会把一次**本会成功**的 POST 判成 status=0，脚本随即抛
   * 「createTempSeries failed: status=0」假红。
   *
   * 重试策略不是无脑重发：status=0 = 客户端没收到响应，**服务端可能已经建成**。
   * 故先按标题查证（GET 幂等）——查到了就沿用那一个，绝不重复 POST 造第二条；
   * 确实没有才重试。每轮换新标题（Date.now 精度内不撞车）。
   */
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  let lastErr = 'unknown'
  for (let i = 0; i < attempts; i++) {
    const title = `${prefix}${Date.now()}`
    const { status, json } = await httpJson('POST', `${base}/api/media/series`, { title }, 20000)
    if (status === 200 && json && typeof json.id === 'number') {
      const id = json.id
      trackCleanup(async () => {
        await httpJson('DELETE', `${base}/api/media/series/${id}`)
      })
      return { id, title }
    }
    lastErr = `status=${status} body=${JSON.stringify(json)}`
    if (status === 0) {
      const list = await httpJson('GET', `${base}/api/media/series`, null, 20000)
      const hit = list.json && Array.isArray(list.json.items)
        ? list.json.items.find((x) => x && x.title === title)
        : null
      if (hit && typeof hit.id === 'number') {
        console.warn(`[sandbox] createTempSeries: POST 超时但服务端已建成，沿用 id=${hit.id}`)
        trackCleanup(async () => {
          await httpJson('DELETE', `${base}/api/media/series/${hit.id}`)
        })
        return { id: hit.id, title }
      }
    }
    await settle(600 * (i + 1))
  }
  throw new Error(`createTempSeries failed after ${attempts} attempts: ${lastErr}`)
}

/**
 * BUG-422：带重试的 GET —— orig-tg 偶发 ~14s stall（见 createTempSeries 注释），
 * 8s 超时会误判 status=0。读操作幂等，直接重试即可。
 */
async function httpJsonGet(url, timeoutMs = 20000, attempts = 4) {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  let last = { status: 0, json: null }
  for (let i = 0; i < attempts; i++) {
    last = await httpJson('GET', url, null, timeoutMs)
    if (last.status !== 0) return last
    await settle(500 * (i + 1))
  }
  return last
}

/**
 * 删除一个剧集（幂等，忽略失败）。
 *
 * @param {string} base 后端 base。
 * @param {number} id 剧集 id。
 * @returns {Promise<number>} HTTP 状态码（0 = 连接失败）。
 */
async function deleteSeries(base, id) {
  const { status } = await httpJson('DELETE', `${base}/api/media/series/${id}`)
  return status
}

/**
 * 撤销条目被 BUG-304 自动归档的归属（若有），解放 `media_episode.item_id` 槽位。
 *
 * 为什么必须有这一步（BUG-422）：BUG-304/D18「导入即成剧」——
 * `POST /api/media/items` 内部 `file_items_into_series` 把每条导入条目自动归档进
 * 单集剧集（写 `media_episode` 行）；而 `media_episode` 有 `UNIQUE(item_id)`
 * （活库索引 `idx_media_episode_item_unique`，BUG-292/297 上线）。夹具再往自己的
 * 剧集挂载 ⇒ INSERT 撞唯一约束 ⇒ 500
 * `UNIQUE constraint failed: media_episode.item_id`。这是**产品既定行为**
 * （导入即归档是对的），不是缺陷——夹具必须适配：挂载前先撤销自动归档。
 *
 * 撤销手法：自动剧集只挂该条目（导入键 `item:{id}` / `tg:msgs:...` 均夹具独有）
 * ⇒ 直接删整剧（`delete_series_explicit`：删剧且清墓碑）。**不摘单集**——
 * `remove_episode` 会写带 `source_key` 的墓碑（BUG-126「删了又回来」保护，
 * 设计上必须活过剪枝），每跑一轮就攒 inert 行；删剧路径零残留。
 * 兜底：剧集里若还有别的内容（不该发生）⇒ 只摘自己那一集。
 *
 * 实现提炼自 `verify_bug285_tg_source_link.cjs` 的 `detachCurrentEpisode`
 * （BUG-378 批次 `2d4ea90` 入库，当时只修了那一个脚本；BUG-422 收口到共享库，
 * 免得 13 个脚本各抄一份然后各自腐烂）。
 *
 * @param {string} base 后端 base。
 * @param {number} itemId 条目 id。
 * @returns {Promise<{detached:boolean, reason:string, seriesId:(number|null)}>}
 *   撤销结果；条目未被自动归档时 `{detached:false, reason:'not-filed'}`。
 */
async function detachAutoSeries(base, itemId) {
  const item = await httpJson('GET', `${base}/api/media/items/${itemId}`)
  // MediaItem 是 `rename_all = "camelCase"` —— 归属字段叫 `seriesId`，
  // 写成 `series_id` 会永远读到 undefined（静默误判「未归档」）。
  const sid = item.json && typeof item.json.seriesId === 'number' ? item.json.seriesId : null
  if (!sid) return { detached: false, reason: 'not-filed', seriesId: null }
  const detail = await httpJson('GET', `${base}/api/media/series/${sid}`)
  const eps = (detail.json && detail.json.episodes) || []
  // EpisodeView 同是 camelCase：条目字段叫 `itemId`（不是 `item_id`）。
  const mine = eps.filter((e) => e && (e.itemId === itemId || e.item_id === itemId))
  if (mine.length !== 1) {
    return { detached: false, reason: 'episode-row-missing', seriesId: sid }
  }
  if (eps.length === 1) {
    const del = await httpJson('DELETE', `${base}/api/media/series/${sid}`)
    return {
      detached: del.status === 200,
      reason: del.status === 200 ? 'auto-series-deleted' : `series-delete-${del.status}`,
      seriesId: sid,
    }
  }
  const del = await httpJson('DELETE', `${base}/api/media/episodes/${mine[0].id}`)
  return {
    detached: del.status === 200,
    reason: del.status === 200 ? 'detached' : `delete-${del.status}`,
    seriesId: sid,
  }
}

// ────────────────────────────── daemon 契约适配（BUG-358 / BUG-422） ──────────────────────────────

/** daemon `/api/config` 里 TG 插件的 id（与前端 `TG_PLUGIN_ID` 同值）。 */
const TG_PLUGIN_ID = 'tg'

/**
 * 从 `/api/config` 响应体取 orig-tg **实际端口**（BUG-358 后的唯一真源）。
 *
 * 为什么需要这个适配器：BUG-358 把契约里写死插件名的 `tg_port` / `tg_running` /
 * `tg_enabled` / `tg_last_error` 四个键收成 `plugins: [{id, label, enabled,
 * running, port, lastError, health}]`（用户原话：「"tg_enabled"这些都是什么？
 * 毫无共通性…我把TG改成BB，这个还能用吗？」）。验收脚本里 20+ 处仍在读旧键
 * `cfg.tg_port` ⇒ 全部拿到 undefined ⇒ 「环境未就绪」假红（BUG-422 实测：
 * verify_bug_214_qa_independent / verify_bug_214_series_bulk_ops 均因此退出）。
 *
 * 兼容旧 daemon：`tg_port` 键仍在时照样认（双轨只在这一处，不散到各脚本）。
 *
 * @param {object} cfg `/api/config` 的 JSON 响应体。
 * @returns {number|null} 端口；取不到返回 null。
 */
function tgPortOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : []
  const p = plugins.find((x) => x && x.id === TG_PLUGIN_ID)
  if (p && Number.isFinite(Number(p.port)) && Number(p.port) > 0) return Number(p.port)
  if (Number.isFinite(Number(cfg.tg_port)) && Number(cfg.tg_port) > 0) return Number(cfg.tg_port)
  return null
}

/**
 * 从 `/api/config` 响应体取 orig-tg **是否在运行**（同上，plugins 优先）。
 *
 * @param {object} cfg `/api/config` 的 JSON 响应体。
 * @returns {boolean} 在运行为 true；取不到按 false（「没证据说它在跑」）。
 */
function tgRunningOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return false
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : []
  const p = plugins.find((x) => x && x.id === TG_PLUGIN_ID)
  if (p && typeof p.running === 'boolean') return p.running
  return cfg.tg_running === true
}

// ────────────────────────────── 残留识别 / 清理 ──────────────────────────────

/**
 * 标题是否为「疑似测试残留」。
 *
 * @param {string} title 标题。
 * @returns {boolean} 命中已知前缀或 `<前缀>_<13 位毫秒>` 签名则为 true。
 */
function looksLikeResidue(title) {
  const t = String(title || '')
  if (TEST_TITLE_PREFIXES.some((p) => t.startsWith(p))) return true
  return MS_SUFFIX_RE.test(t)
}

/**
 * 列出媒体库里**疑似测试残留**的剧集（只读，不删除）。
 *
 * @param {string} base 后端 base。
 * @returns {Promise<Array<{id:number,title:string,episodeCount:number,createdAt:number}>>} 残留清单。
 */
async function listResidue(base) {
  const { status, json } = await httpJson('GET', `${base}/api/media/series`)
  if (status !== 200 || !json || !Array.isArray(json.items)) return []
  return json.items
    .filter((s) => looksLikeResidue(s.title))
    .map((s) => ({
      id: s.id,
      title: s.title,
      episodeCount: typeof s.episodeCount === 'number' ? s.episodeCount : 0,
      createdAt: s.createdAt || 0,
    }))
}

/**
 * 扫描并**可选删除**疑似测试残留的剧集。
 *
 * 安全闸门：只有 `apply=true` **且** `ORIG_VERIFY_ALLOW_PROD_WRITES=1`（显式授权）
 * 时才真正删除；否则仅列出（dry-run）。删除需用户显式授权，这是项目硬规则。
 *
 * @param {string} base 后端 base。
 * @param {{apply?: boolean}} [opts] `apply=true` 表示执行删除。
 * @returns {Promise<{scanned:number, matched:Array<object>, deleted:number, dryRun:boolean}>} 结果摘要。
 */
async function sweepResidue(base, opts = {}) {
  const apply = Boolean(opts.apply)
  const residue = await listResidue(base)
  const authorized = process.env.ORIG_VERIFY_ALLOW_PROD_WRITES === '1'
  const dryRun = !(apply && authorized)
  let deleted = 0
  if (!dryRun) {
    for (const item of residue) {
      const st = await deleteSeries(base, item.id)
      if (st === 200) deleted += 1
    }
  }
  return { scanned: residue.length, matched: residue, deleted, dryRun }
}

module.exports = {
  PROD_PORT,
  TEST_TITLE_PREFIXES,
  parseHostPort,
  isProduction,
  trackCleanup,
  runCleanups,
  installCleanup,
  finalize,
  guardWrites,
  httpJson,
  httpJsonGet,
  createTempSeries,
  deleteSeries,
  detachAutoSeries,
  tgPortOf,
  tgRunningOf,
  looksLikeResidue,
  listResidue,
  sweepResidue,
}
