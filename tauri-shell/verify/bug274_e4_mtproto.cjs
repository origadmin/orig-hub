#!/usr/bin/env node
'use strict'

/**
 * BUG-274 E4 取证脚本（只读；不改产品代码）。
 *
 * 目标：坐实/排除「排名 0」——**缓存 worker 的 MTProto 下载与 TG 面板的远程播放
 * （/api/tg/file）共用同一个 `Arc<dyn Client>`，缓存写入会饿死正在播放的在线流**。
 *
 * E4 判据（见 docs/bugs/BUG-274.md）：
 *   ① Local 侧（媒体库已落盘条目 /api/media/items/:id/raw，读磁盘）在缓存运行时应**不受影响**；
 *   ② Remote 侧（TG 面板未缓存消息 /api/tg/file，现场 MTProto 拉流）在缓存运行时应**被饿死**。
 *   ① 不卡 ② 卡 ⇒ 排名 0 成立。
 *
 * 同时采集一个**非媒体但用同一 client** 的端点（/api/tg/thumb）延迟，佐证「整条 MTProto
 * 客户端被独占」而非仅播放路径。
 *
 * 局限（如实登记）：若环境内**已有**缓存任务在跑，则无法获得「缓存空闲」基线；
 * 本脚本会打印 worker 状态，供判读时标注「窗口全程处于缓存中」。
 *
 * 用法：
 *   node verify/bug274_e4_mtproto.cjs
 * 环境变量：
 *   TG_URL        默认 http://127.0.0.1:19787
 *   E4_REMOTE     默认 -1001341930464/208253（未缓存视频，远程播放）
 *   E4_LOCAL_ID   默认 607（已落盘媒体库条目，本地播放）
 *   E4_SAMPLES    默认 3
 *   E4_CAP_MS     默认 15000（单次采样上限）
 *   ORIG_VERIFY_OUT 产物目录，默认 verify_shots/bug274_e4
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const REMOTE = process.env.E4_REMOTE || '-1001341930464/208253'
const LOCAL_ID = Number(process.env.E4_LOCAL_ID || 607)
const SAMPLES = Number(process.env.E4_SAMPLES || 3)
const CAP_MS = Number(process.env.E4_CAP_MS || 15000)
const OUT = path.resolve(
  process.env.ORIG_VERIFY_OUT || path.join(__dirname, '..', 'verify_shots', 'bug274_e4'),
)

/** 拉一个带 Range 的 URL，最长 capMs，返回收到字节数/耗时/速率。 */
function streamMeasure(url, rangeHeader, capMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let bytes = 0
    let status = 0
    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      const ms = Date.now() - started
      resolve({
        status,
        bytes,
        ms,
        speedBps: ms > 0 ? Math.round((bytes * 1000) / ms) : 0,
        ...extra,
      })
    }
    const req = http.get(url, { headers: { Range: rangeHeader } }, (res) => {
      status = res.statusCode || 0
      res.on('data', (c) => {
        bytes += c.length
      })
      res.on('end', () => done({ ended: 'eof' }))
      res.on('error', () => done({ ended: 'res_error' }))
    })
    req.on('error', (e) => done({ ended: 'req_error', err: String(e && e.message) }))
    const t = setTimeout(() => {
      req.destroy()
      done({ ended: 'cap' })
    }, capMs)
    req.on('close', () => {
      clearTimeout(t)
      done({ ended: 'close' })
    })
  })
}

/** GET 一个 URL 并解析 JSON（带超时）。 */
function getJson(url, capMs = 8000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: capMs }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, json: JSON.parse(d) })
        } catch (e) {
          resolve({ status: res.statusCode || 0, json: null, raw: d.slice(0, 200) })
        }
      })
    })
    req.on('error', (e) => resolve({ status: 0, err: String(e && e.message) }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, err: 'timeout' })
    })
  })
}

/** 一个端点只取延迟（不读 body），用于证明「客户端被独占」。 */
function latency(url, capMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (extra) => {
      if (settled) return
      settled = true
      resolve({ ms: Date.now() - started, ...extra })
    }
    const req = http.get(url, (res) => {
      res.resume()
      res.on('end', () => done({ status: res.statusCode, ok: true }))
    })
    req.on('error', (e) => done({ status: 0, ok: false, err: String(e && e.message) }))
    const t = setTimeout(() => {
      req.destroy()
      done({ status: 0, ok: false, err: 'cap' })
    }, capMs)
    req.on('close', () => {
      clearTimeout(t)
      done({ status: 0, ok: false, err: 'close' })
    })
  })
}

async function workerState() {
  const r = await getJson(`${TG}/api/tg/cache/tasks`)
  const t = r.json && r.json.task
  return t
    ? { id: t.id, status: t.status, done: t.done, total: t.total, itemBytes: t.itemBytes, currentId: t.currentId }
    : { none: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const result = {
    at: new Date().toISOString(),
    tg: TG,
    remote: REMOTE,
    localItemId: LOCAL_ID,
    samples: SAMPLES,
    capMs: CAP_MS,
  }

  // 前置：缓存 worker 状态（证明窗口是否「缓存中」）
  result.workerBefore = await workerState()
  console.log('[e4] worker before:', JSON.stringify(result.workerBefore))

  // ① Remote：/api/tg/file（未缓存 → 现场 MTProto 拉流）
  const remoteUrl = `${TG}/api/tg/file/${REMOTE}`
  result.remoteSamples = []
  for (let i = 0; i < SAMPLES; i++) {
    const m = await streamMeasure(remoteUrl, 'bytes=0-8388607', CAP_MS)
    result.remoteSamples.push(m)
    console.log(`[e4] remote #${i + 1}: status=${m.status} bytes=${m.bytes} speed=${m.speedBps} B/s (${m.ended})`)
    await sleep(300)
  }

  // ② Local：/api/media/items/:id/raw（已落盘 → 读磁盘）
  const localUrl = `${TG}/api/media/items/${LOCAL_ID}/raw`
  result.localSamples = []
  for (let i = 0; i < SAMPLES; i++) {
    const m = await streamMeasure(localUrl, 'bytes=0-8388607', CAP_MS)
    result.localSamples.push(m)
    console.log(`[e4] local  #${i + 1}: status=${m.status} bytes=${m.bytes} speed=${m.speedBps} B/s (${m.ended})`)
    await sleep(200)
  }

  // ③ 非媒体但同 client：thumb 延迟（证明整条客户端被独占）
  result.thumbLatency = await latency(`${TG}/api/tg/thumb/-1001341930464/208253`, 5000)
  console.log('[e4] thumb latency:', JSON.stringify(result.thumbLatency))
  result.dialogsLatency = await latency(`${TG}/api/tg/dialogs?limit=1`, 5000)
  console.log('[e4] dialogs latency:', JSON.stringify(result.dialogsLatency))

  // 后置：worker 状态
  result.workerAfter = await workerState()
  console.log('[e4] worker after:', JSON.stringify(result.workerAfter))

  // 汇总
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((s, x) => s + x[k], 0) / arr.length) : 0)
  result.summary = {
    remoteAvgBps: avg(result.remoteSamples, 'speedBps'),
    remoteAvgBytes: avg(result.remoteSamples, 'bytes'),
    localAvgBps: avg(result.localSamples, 'speedBps'),
    localAvgBytes: avg(result.localSamples, 'bytes'),
  }
  console.log('[e4] SUMMARY:', JSON.stringify(result.summary))

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
  console.log('[e4] wrote', path.join(OUT, 'result.json'))
}

main()
