// 模拟前端 daemon.ts API 层：验证 REST 契约端到端
const BASE = 'http://127.0.0.1:9876'
const URL = process.env.TEST_URL || 'http://127.0.0.1:8899/file.bin'

async function req(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1 }
  else console.log(`PASS: ${msg}`)
}

async function main() {
  // 1. health
  const h = await req('/health')
  assert(h.status === 200 && h.body.status === 'ok', `health → ${h.status} ${JSON.stringify(h.body)}`)

  // 2. 清理旧任务
  const old = await req('/api/downloads')
  for (const d of old.body || []) {
    if (['completed', 'error', 'cancelled'].includes(d.status)) {
      await req(`/api/downloads/${d.id}`, { method: 'DELETE' })
    }
  }

  // 3. 添加任务
  const add = await req('/api/downloads', {
    method: 'POST',
    body: JSON.stringify({ url: URL, max_connections: 8 }),
  })
  assert(add.status === 201, `add → ${add.status} ${JSON.stringify(add.body)}`)
  const id = add.body.id
  assert(!!id, 'add returns id')

  // 4. 轮询到完成（最多 15s）
  let final = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    const d = await req(`/api/downloads/${id}`)
    if (d.status === 200) {
      final = d.body
      if (['completed', 'error'].includes(final.status)) break
    }
  }
  assert(final && final.status === 'completed', `download completed, got=${final?.status} downloaded=${final?.downloaded}/${final?.total_size}`)
  assert(final.downloaded === final.total_size, `size match ${final.downloaded}/${final.total_size}`)

  // 5. pause/resume on completed（契约可用性）
  const p = await req(`/api/downloads/${id}?action=pause`, { method: 'POST' })
  assert(p.status === 200, `pause → ${p.status} ${JSON.stringify(p.body)}`)
  const r = await req(`/api/downloads/${id}?action=resume`, { method: 'POST' })
  assert(r.status === 200, `resume → ${r.status} ${JSON.stringify(r.body)}`)

  // 6. 列表
  const list = await req('/api/downloads')
  assert(list.status === 200 && Array.isArray(list.body), `list → ${list.status}, ${list.body?.length} items`)

  // 7. delete
  const del = await req(`/api/downloads/${id}`, { method: 'DELETE' })
  assert(del.status === 200, `delete → ${del.status} ${JSON.stringify(del.body)}`)
  const gone = await req(`/api/downloads/${id}`)
  assert(gone.status === 404, `deleted task gone → ${gone.status}`)

  console.log('=== REST 契约端到端 ALL DONE ===')
}

main().catch(e => { console.error('FATAL:', e); process.exitCode = 1 })
