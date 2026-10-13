#!/usr/bin/env node
'use strict'
/* 只读侦察：找出「有字节 video」与「无字节」条目，确认 API 字段。不写任何数据。 */
const TG = process.env.TG_API || 'http://127.0.0.1:19788'

async function j(url) {
  const r = await fetch(url)
  const t = await r.text()
  let body = null
  try { body = JSON.parse(t) } catch { body = t.slice(0, 200) }
  return { status: r.status, body }
}

async function main() {
  const items = await j(`${TG}/api/media/items`)
  const list = (items.body && items.body.items) || []
  console.log(`[recon] /api/media/items status=${items.status} count=${list.length}`)
  const byKind = {}
  for (const it of list) byKind[it.kind] = (byKind[it.kind] || 0) + 1
  console.log(`[recon] byKind=${JSON.stringify(byKind)}`)

  const videoPresent = list.filter((i) => i.kind === 'video' && i.bytesPresence === 'present')
  const videoMissing = list.filter((i) => i.kind === 'video' && i.bytesPresence !== 'present')
  console.log(`\n[recon] video + bytesPresent = ${videoPresent.length}`)
  for (const i of videoPresent.slice(0, 8)) {
    console.log(`  id=${i.id} dur=${i.duration} size=${i.size} seriesId=${i.seriesId} filePath=${i.filePath}`)
  }
  console.log(`\n[recon] video + bytesMissing = ${videoMissing.length}`)
  for (const i of videoMissing.slice(0, 8)) {
    console.log(`  id=${i.id} dur=${i.duration} size=${i.size} bytesPresence=${i.bytesPresence} filePath=${i.filePath} title=${JSON.stringify(i.title)} seriesId=${i.seriesId}`)
  }

  const photos = list.filter((i) => i.kind === 'photo')
  console.log(`\n[recon] photo count=${photos.length} present=${photos.filter((p) => p.bytesPresence === 'present').length}`)

  // 详情端点字段
  const one = videoPresent[0]
  if (one) {
    const d = await j(`${TG}/api/media/items/${one.id}`)
    console.log(`\n[recon] GET /api/media/items/${one.id} status=${d.status}`)
    console.log(`  keys=${Object.keys((d.body && d.body.item) || d.body || {}).join(',')}`)
    console.log(`  body=${JSON.stringify(d.body).slice(0, 600)}`)
    const raw = await fetch(`${TG}/api/media/items/${one.id}/raw`, { method: 'HEAD' })
    console.log(`\n[recon] HEAD /raw id=${one.id} status=${raw.status} ctype=${raw.headers.get('content-type')} len=${raw.headers.get('content-length')}`)
    const stream = await fetch(`${TG}/api/media/items/${one.id}/stream`, { method: 'HEAD' })
    console.log(`[recon] HEAD /stream id=${one.id} status=${stream.status} ctype=${stream.headers.get('content-type')} len=${stream.headers.get('content-length')} accept-ranges=${stream.headers.get('accept-ranges')}`)
  }
  const miss = videoMissing[0]
  if (miss) {
    const rawM = await fetch(`${TG}/api/media/items/${miss.id}/raw`, { method: 'HEAD' })
    console.log(`[recon] HEAD /raw id=${miss.id}(missing) status=${rawM.status}`)
    const stM = await fetch(`${TG}/api/media/items/${miss.id}/stream`, { method: 'HEAD' })
    console.log(`[recon] HEAD /stream id=${miss.id}(missing) status=${stM.status}`)
  }
}

main().catch((e) => { console.error('[recon] ERR', e); process.exit(1) })
