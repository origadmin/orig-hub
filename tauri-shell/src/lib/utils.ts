/** 通用工具函数 */

/**
 * Tailwind 的**字体尺寸** token（`text-` 在 Tailwind 里一符三义：字号/颜色/对齐，
 * 只有这些 token 与方括号长度是字号，其余 `text-*` 一律不参与合并）。
 */
const FONT_SIZE_TOKENS = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
])

/**
 * 同一 CSS 属性的 utility 归为一组（BUG-361）。
 *
 * 只收**语义上互斥**的属性：同组出现两个类时后者必须赢。刻意不收 `rounded-*`
 * （`rounded-md` 与 `rounded-t-lg` 一个管全角一个管上角，不是互斥）与
 * `bg-*` / `border-*`（颜色与宽度混在同前缀下，误合并会静默改配色）。
 */
const SIZE_GROUPS: Array<[RegExp, string]> = [
  [/^h-/, 'height'],
  [/^min-h-/, 'minHeight'],
  [/^max-h-/, 'maxHeight'],
  [/^w-/, 'width'],
  [/^min-w-/, 'minWidth'],
  [/^max-w-/, 'maxWidth'],
  [/^p-/, 'padding'],
  [/^px-/, 'paddingX'],
  [/^py-/, 'paddingY'],
  [/^gap-x-/, 'gapX'],
  [/^gap-y-/, 'gapY'],
  [/^gap-/, 'gap'],
]

/**
 * 单个 utility 的分组键；`null` = 不参与冲突合并（原样保留）。
 *
 * 变体前缀（`hover:` / `md:` / `disabled:` …）必须进键：`hover:h-8` 与 `h-6`
 * 不是互斥（前者只在悬浮时生效），合并掉会让悬浮态失效。
 */
function groupKey(cls: string): string | null {
  let body = cls
  let variant = ''
  const colon = body.indexOf(':')
  if (colon >= 0) {
    variant = body.slice(0, colon + 1)
    body = body.slice(colon + 1)
  }
  // `!` 重要前缀不改变它属于哪一组
  if (body.startsWith('!')) body = body.slice(1)
  if (body.startsWith('text-')) {
    const rest = body.slice(5)
    if (FONT_SIZE_TOKENS.has(rest) || /^\[[^\]]+\]$/.test(rest)) return variant + '|fontSize'
    return null
  }
  for (const [re, name] of SIZE_GROUPS) {
    if (re.test(body)) return variant + '|' + name
  }
  return null
}

/**
 * 类名合并：**同组后者赢**（BUG-361）。
 *
 * 为什么不能是裸 join：`cn` 被 149 处 `<Button size="sm" className="h-7 …">`
 * 使用，`h-8`（size 给的）与 `h-7`（调用方给的）同在 class 列表里时，
 * 胜负由**生成样式表的源序**决定 —— 同一个组件在不同构建/不同 Tailwind
 * 扫描顺序下可能渲染 28px 也可能渲染 32px，且无声无息。用户看到的
 * 「同样的按钮不一样高、说好的字号没生效」即来源于此。
 *
 * 这里只做**同属性互斥**的裁决（后者赢 = 调用方书写顺序即优先级），
 * 不做跨属性猜测：不同组的类全部保留，行为与裸 join 完全一致。
 */
export function cn(...classes: (string | false | null | undefined)[]): string {
  const list = classes.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  const winner = new Map<string, string>()
  for (const cls of list) {
    const key = groupKey(cls)
    if (key === null) continue
    // 同组后者赢：直接覆盖（Map 保序，最终位置由首次出现决定，视觉无差异）
    winner.set(key, cls)
  }
  if (winner.size === 0) return list.join(' ')
  // 只保留每组的中奖者（位置取该组**首次**出现处，视觉无差异）；
  // 落选者整类丢掉 —— 留着就是同一个属性在 class 列表里出现两次。
  const emitted = new Set<string>()
  return list
    .filter((cls) => {
      const key = groupKey(cls)
      if (key === null) return true
      const w = winner.get(key)
      if (w !== cls) return false
      if (emitted.has(key)) return false
      emitted.add(key)
      return true
    })
    .join(' ')
}

/** 字节数 → 人类可读（KB/MB/GB） */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  )
  return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`
}

/** 速度（字节/秒）→ 人类可读 */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

/** 秒 → HH:MM:SS / MM:SS */
export function formatEta(sec: number): string {
  if (!sec || sec <= 0 || !isFinite(sec)) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 时间戳 → 本地时间字符串 */
export function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** URL → 提取文件名 */
export function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean)
    return seg.length > 0 ? decodeURIComponent(seg[seg.length - 1]) : u.hostname
  } catch {
    return url.split('/').pop() || url
  }
}
