/**
 * `cn` 类名合并判据（BUG-361）。
 *
 * 为什么必须有这条判据：`cn` 曾是裸 join，`<Button size="sm" className="h-7 …">`
 * 里 `h-8` 与 `h-7` 同在 class 列表，胜负由**生成样式表的源序**决定 ⇒ 同一个组件
 * 在不同构建顺序下可能渲染 28px 也可能渲染 32px，且无声无息。用户观感即
 * 「同样的按钮不一样高」「声明了的字号没生效」。
 *
 * 本脚本直接 import 真源（`src/lib/utils.ts`，Node 原生剥类型），不测副本。
 * 反向证伪：把「后者赢」翻成「前者赢」时本脚本必须红。
 *
 * 用法：node --experimental-strip-types tauri-shell/verify/_check_cn_merge.mjs
 */
import { cn } from '../src/lib/utils.ts'

const cases = [
  // 同组冲突：后者赢（调用方书写顺序即优先级）
  [['h-8', 'h-7', 'px-3'], 'h-7 px-3'],
  // 同组冲突：后者赢（调用方书写顺序即优先级）。
  // 中奖者保留在**它自己被写下的位置**，落选者整类丢掉 —— 合并后每个属性只剩一个类，
  // class 属性里的先后对互斥属性不再有任何影响。
  [['h-8', 'px-3', 'text-xs', 'h-6', 'text-[10px]'], 'px-3 h-6 text-[10px]'],
  [['text-sm', 'text-[13px]'], 'text-[13px]'],
  [['w-9', 'w-4'], 'w-4'],
  [['p-4', 'px-2'], 'p-4 px-2'],
  [['gap-1', 'gap-2'], 'gap-2'],
  [['!h-8', 'h-6'], 'h-6'],
  // 不同组：全部保留（与裸 join 行为一致，不得误合并）
  [['h-6', 'min-h-0'], 'h-6 min-h-0'],
  [['h-6', 'max-h-0'], 'h-6 max-h-0'],
  [['w-4', 'min-w-0'], 'w-4 min-w-0'],
  [['px-3', 'py-2'], 'px-3 py-2'],
  [['gap-2', 'gap-x-3'], 'gap-2 gap-x-3'],
  [['rounded-md', 'rounded-lg'], 'rounded-md rounded-lg'],
  [['bg-accent', 'bg-danger'], 'bg-accent bg-danger'],
  [['text-[11px]', 'text-muted'], 'text-[11px] text-muted'],
  [['text-muted', 'text-[11px]'], 'text-muted text-[11px]'],
  [['text-center', 'text-white'], 'text-center text-white'],
  // 变体前缀必须进键：hover 态与常态不是互斥
  [['hover:h-8', 'h-6'], 'hover:h-8 h-6'],
  [['h-6', 'hover:h-8'], 'h-6 hover:h-8'],
  // 假值过滤保持原行为
  [[false, null, undefined, 'h-9'], 'h-9'],
]

let bad = 0
for (const [input, want] of cases) {
  const got = cn(...input)
  if (got !== want) {
    bad++
    console.log(`FAIL cn(${JSON.stringify(input)}) = "${got}"  want "${want}"`)
  }
}

// 反向证伪：判据自身得有牙齿 —— 喂一个「前者赢」的假实现必须报红。
const fakeEarlierWins = (...cs) => {
  const list = cs.filter(Boolean)
  const first = {}
  for (const c of list) {
    const m = String(c).match(/^h-(\d+)$/)
    if (m && first.h === undefined) first.h = String(c)
  }
  return list.map((c) => (first.h !== undefined && /^h-\d+$/.test(String(c)) ? first.h : c)).join(' ')
}
if (fakeEarlierWins('h-8', 'h-7') === 'h-7') {
  bad++
  console.log('FAIL 反向证伪：假实现（前者赢）竟然通过了 h-8/h-7 用例')
}

console.log(bad === 0 ? `cn merge: ${cases.length}/${cases.length} PASS` : `cn merge: ${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
