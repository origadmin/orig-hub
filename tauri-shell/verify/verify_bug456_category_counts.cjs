/**
 * BUG-456 验收（文件管理侧栏分类状态数字）。
 *
 * 缺陷：侧栏分类子项只渲染 label，`counts` 里**没有 per-category 计数字段** ——
 * 数字没有真源，自然无处可显。修法不是「侧栏自己数一遍」（那违反 BUG-125/BUG-133
 * 「徽标数必须与域面板同源」），而是让域面板把它与分类视图**同一真源**的计数上报。
 *
 * 断言分两类：
 *   - 运行时：`GET /api/media/stats`（orig-tg）必须给出 `videos/photos/audios`；
 *   - 结构：上报链路（`MediaLibraryPanel` → `MainLayout` → `Sidebar`）三处接线齐全，
 *     且侧栏渲染点读的是上报值而不是另算。
 *
 *   TG_URL=http://127.0.0.1:29787 node tauri-shell/verify/verify_bug456_category_counts.cjs
 */
const fs = require('fs')
const path = require('path')

const TG = process.env.TG_URL || 'http://127.0.0.1:19787'
const REPO = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(REPO, 'tauri-shell', 'src', p), 'utf8')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed++
}

async function main() {
  // ---- 运行时：分类计数真源存在 ----
  let stats = null
  try {
    const r = await fetch(`${TG}/api/media/stats`)
    stats = r.ok ? await r.json() : null
  } catch {
    stats = null
  }
  check('U1 /api/media/stats 可达', !!stats, stats ? JSON.stringify({ items: stats.items }) : `TG_URL=${TG}`)
  if (stats) {
    const hasAll = ['videos', 'photos', 'audios'].every((k) => typeof stats[k] === 'number')
    check(
      'U2 真源含 per-kind 计数（videos/photos/audios）',
      hasAll,
      `videos=${stats.videos} photos=${stats.photos} audios=${stats.audios}`,
    )
  }

  // ---- 结构：上报链路三处接线 ----
  const panel = read('components/MediaLibraryPanel.tsx')
  check(
    'U3 域面板上报 byCategory（键映射 video←videos / image←photos / music←audios）',
    /byCategory\['video'\]|byCategory\.video/.test(panel) &&
      /byCategory\['image'\]\s*=\s*stats\.photos|byCategory\.image\s*=\s*stats\.photos/.test(panel) &&
      /byCategory\.music\s*=\s*stats\.audios/.test(panel),
    'MediaLibraryPanel.tsx',
  )
  check('U4 计数随真源变化才推（countsKey 含三项 kind 计数）', /countsKey[\s\S]{0,200}videos[\s\S]{0,200}photos[\s\S]{0,200}audios/.test(panel))

  const layout = read('shell/MainLayout.tsx')
  check('U5 MainLayout 中转 byCategory（不另算）', /byCategory:\s*filesCounts\.byCategory/.test(layout))

  const sidebar = read('shell/Sidebar.tsx')
  const renders = (sidebar.match(/counts\.byCategory/g) || []).length
  check('U6 侧栏分类子项读上报值渲染（video 行 + 其余分类行，共 4 处引用）', renders >= 4, `引用=${renders}`)
  check(
    'U7 「0 / 缺键不渲染」纪律：只在有值时渲染',
    /counts\.byCategory\?\.video\s*\?/.test(sidebar) && /counts\.byCategory\?\.\[cat\]\s*\?/.test(sidebar),
  )

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
