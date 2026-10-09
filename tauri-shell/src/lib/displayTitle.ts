/**
 * 渲染层剧名标记（BUG-251）。
 *
 * 背景：剧集标题是**自由文本** —— 用户/来源可能已经自带标记。实测库里
 * 约 48.6%（17/35）的剧集标题**本就含 `《`**（如 `《小镇上的熟母露出俱乐部》`、
 * `#ai短剧 #Ai成人短剧 《苏老师的裸贷人生》`、`😀😀😀😀😀😀😀😀 #《存在感零》`）。
 * 渲染层若再无脑套一层，近半数剧集会显示成 `《《…》》`。
 *
 * 规则只有一条 —— **已自带标记就原样返回，否则按 UI 语言包一层**：
 *   - 不做括号「增删」平衡校正；
 *   - **不剥内部标记**（那会侵入标题内容：`#ai短剧 《X》` 里的 `《X》` 是标题自身的一部分）。
 *
 * **标记形态随 UI 语言**（BUG-251 en 语义修正）：中文界面用书名号 `《》`，
 * 英文界面用弯引号 `“”` —— 英文界面不该出现由我们加上的中文书名号。
 * 语言在函数**内部**读取（`getLanguage()`），调用点零负担、无需分支。
 *
 * 注意：**剧集卡片正面**（`SeriesCard.tsx` 直接输出 `series.title`）**不适用**本函数 ——
 * 那里本就不包裹，加了反而会改变既有卡面外观。
 *
 * 本函数依赖 `settings.language`（经 `getLanguage()`），因此**使用了它的组件必须订阅
 * language**（即调用 `useTranslation()`），否则语言切换后标记不会更新。
 *
 * @param title 原始剧名（可为空/null；调用方通常传入对象字段）
 * @returns 已带单层标记的剧名；空串原样返回 `''`
 */
import { getLanguage } from '../i18n'

/** 各语言下的书名标记（开/闭）；未知语言回退 zh-CN。 */
const MARKS: Record<string, [string, string]> = {
  'zh-CN': ['《', '》'],
  'en-US': ['“', '”'],
}

export function seriesLabel(title: string): string {
  const t = (title ?? '').trim()
  if (t === '') return t
  // 已自带标记（中文书名号或英文弯引号）→ 原样返回，绝不叠加。
  if (t.includes('《') || t.includes('“')) return t
  const [open, close] = MARKS[getLanguage()] ?? MARKS['zh-CN']
  return `${open}${t}${close}`
}
