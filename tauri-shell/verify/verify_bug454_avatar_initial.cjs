/**
 * BUG-454 验收（头像兜底字符）：旧实现 `(title || '?').charAt(0)` 会把标题开头的
 * 装饰符号（实测「【」）直接当头像渲染，用户看到的是「ICON 不对」。
 *
 * 断言全部**取自真源**：剥离规则从 `src/components/TgAvatar.tsx` 的源码里抽取，
 * 不在此复制一份（复制会与实现漂移 ⇒ 恒绿）。
 *
 *   node tauri-shell/verify/verify_bug454_avatar_initial.cjs
 */
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')
const AVATAR = path.join(REPO, 'tauri-shell', 'src', 'components', 'TgAvatar.tsx')
const PANEL = path.join(REPO, 'tauri-shell', 'src', 'components', 'TgPanel.tsx')

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed++
}

const src = fs.readFileSync(AVATAR, 'utf8')

// ① 从真源抽取剥离正则（源码里形如 `replace(/^[…]+/u, '')`）。
const m = src.match(/replace\(\/(\^\[[^\]]+\]\+)\/u/)
check('A1 真源含「跳过开头装饰字符」的剥离规则', !!m, m ? m[1] : '未匹配到')
const STRIP = m ? new RegExp(m[1], 'u') : null

/** 复刻 `channelInitial`：trim → 剥离前缀 → 取首字符（剥完为空兜 `#`）→ 大写。 */
function initialOf(title) {
  const raw = (title || '').trim()
  const stripped = raw.replace(STRIP, '')
  return (stripped.charAt(0) || '#').toUpperCase()
}

// ② 用户实测现象：标题以「【」开头时，头像**不得**再是「【」。
const decorated = '【琼楼】每日更新'
check(
  'A2 装饰符号标题不再渲染成「【」',
  initialOf(decorated) !== '【' && initialOf(decorated) === '琼',
  `initial=${JSON.stringify(initialOf(decorated))}`,
)

// ③ 普通标题回归：首字符照旧，且中文/英文都不被误剥。
check('A3 普通英文标题首字符保留', initialOf('MovieHub') === 'M', `initial=${initialOf('MovieHub')}`)
check('A4 普通中文标题首字符保留', initialOf('电影仓库') === '电', `initial=${initialOf('电影仓库')}`)

// ④ 全装饰/空标题：兜到 `#`，不渲染空白（BUG-194 同款「空标识」纪律）。
check('A5 空标题兜底为 #', initialOf('') === '#' && initialOf('【】') === '#', `empty=${initialOf('')}`)

// ⑤ 旧 fallback 三处已全部换成 TgAvatar（结构性：不许留散落副本）。
const panel = fs.readFileSync(PANEL, 'utf8')
const leftovers = (panel.match(/charAt\(0\)/g) || []).length
const usages = (panel.match(/<TgAvatar\b/g) || []).length
check('A6 TgPanel 内无残留 charAt(0) 头像兜底', leftovers === 0, `残留=${leftovers}`)
check('A7 头像渲染点收敛到 TgAvatar（3 处：监控行/频道行/详情头）', usages === 3, `调用=${usages}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
