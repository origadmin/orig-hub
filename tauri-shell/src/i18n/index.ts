/**
 * 文件翻译模式 i18n（与主流应用一致的 locale 文件 + t() 方案）。
 *
 * 设计约束：分类的「规范化 key」（Videos/Audio/...）同时是磁盘子目录名、
 * classify_rules 的键、前端筛选值，因此绝不能用于显示层翻译——这里只翻译
 * 「显示文案」。分类 key 走 `category.<Key>` 命名空间，缺失时回退到 key 本身，
 * 因此用户自定义分类（任意名称）也能安全 fallback。
 *
 * BUG-236：**语种 = `locales/` 目录的内容，不是本文件里的枚举**。
 * 此前 `MESSAGES` 与 `SUPPORTED_LANGUAGES` 各手写一份（2 项），新增语种必须同时
 * 改两处代码 + 手抄全量 JSON，事实上把界面冻结在中英两种语言。现在：
 *   - 语言包由 `import.meta.glob` 在构建期收集，文件名即 BCP-47 语种码；
 *   - 语言选择列表由同一份目录生成（顺序 = 默认语种在首位，其余按码排序）；
 *   - 缺失 key 的回退链固定为「当前语种 → 默认语种(zh-CN) → 调用方 fallback → key」，
 *     运行期永不渲染空白；**但门禁仍要求语言包键完备**（`scripts/check-i18n-keys.py`
 *     按所有语种的并集比对），回退只是兜底，不是「可以只翻一半」的许可。
 * 新增语种的完整步骤见 `docs/standards/dev.md` §7。
 */
import { useStore } from '../store/useStore'
import type { LanguageValue } from '../types'

/** 缺键回退的基准语种（也是新语种的翻译源）。 */
export const DEFAULT_LANGUAGE = 'zh-CN'

/**
 * 语种码（如 `zh-CN` / `en-US` / `de-DE`）。
 *
 * BUG-236：不再是 `'zh-CN' | 'en-US'` 字面量联合 —— 联合类型会让「加一个 JSON」
 * 变成「改一处类型」的编译错误，与「加文件即可」的设计目标直接冲突。
 */
export type Language = string

/** 少数语种的自称（其余由 `Intl.DisplayNames` 给本族语名，缺能力时回退语种码）。 */
const LANGUAGE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
}

/** 构建期收集的全部语言包：键 = 文件路径，值 = 该 JSON 的 default 导出。 */
const LOCALE_MODULES = import.meta.glob<Record<string, string>>('./locales/*.json', {
  eager: true,
  import: 'default',
})

/** `./locales/de-DE.json` → `de-DE` */
function localeCodeOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.json$/i, '')
}

const MESSAGES: Record<Language, Record<string, string>> = {}
for (const [path, dict] of Object.entries(LOCALE_MODULES)) {
  MESSAGES[localeCodeOf(path)] = dict
}

/** 本族语显示名：优先手写覆盖，其次 Intl（无该语种数据时退回语种码）。 */
function languageLabel(code: string): string {
  const fixed = LANGUAGE_LABELS[code]
  if (fixed) return fixed
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (name) return name
  } catch {
    // 老运行时没有 Intl.DisplayNames：语种码本身就是可用的显示名
  }
  return code
}

export const SUPPORTED_LANGUAGES: { value: Language; label: string }[] = [
  DEFAULT_LANGUAGE,
  ...Object.keys(MESSAGES)
    .filter((code) => code !== DEFAULT_LANGUAGE)
    .sort((a, b) => a.localeCompare(b)),
].map((code) => ({ value: code, label: languageLabel(code) }))

/** 按浏览器环境推断默认语言（无需持久化时也给出合理默认值） */
export function detectLanguage(): Language {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
  const nav = navigator.language?.toLowerCase() ?? ''
  if (nav.startsWith('zh')) return 'zh-CN'
  // 浏览器语言与已装语言包前缀相同（如 de-AT → de-DE）时直接用该语种
  const hit = Object.keys(MESSAGES).find((code) => code.toLowerCase().split('-')[0] === nav.split('-')[0])
  return hit ?? (MESSAGES['en-US'] ? 'en-US' : DEFAULT_LANGUAGE)
}

/**
 * 当前生效语言：优先取已持久化的设置，否则按环境推断。
 *
 * BUG-236：持久化值必须**仍是一个已装语种** —— 语言包被删掉后，旧设置会让界面
 * 落到「字典不存在 → 每条都是原始 key」。这里统一收口到默认语种。
 */
export function getLanguage(): Language {
  const stored = useStore.getState().settings.language as Language | undefined
  if (stored && MESSAGES[stored]) return stored
  const detected = detectLanguage()
  return MESSAGES[detected] ? detected : DEFAULT_LANGUAGE
}

/**
 * 翻译函数。
 * @param key 形如 `nav.all` / `category.Videos`
 * @param vars 可选插值，替换 `{name}` 占位符
 * @param fallback 缺失时的回退文案（缺省回退到 key 本身，保证绝不空白）
 */
export function t(
  key: string,
  vars?: Record<string, string | number>,
  fallback?: string,
): string {
  const lang = getLanguage()
  // 回退链（BUG-236）：当前语种 → 默认语种 → 调用方 fallback → key
  const dict = MESSAGES[lang] ?? {}
  const base = MESSAGES[DEFAULT_LANGUAGE] ?? {}
  let str: string = dict[key] ?? base[key] ?? fallback ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}

/** 用户切换语言：写入设置（持久化）+ 同步 <html lang> */
export function setLanguage(lang: Language) {
  // BUG-236：store 的 `language` 仍是被冻结成两值的联合类型（types.ts）；
  // 语种集合的真源在语言包目录，故此处按已装语种校验后再入 store。
  if (!MESSAGES[lang]) return
  useStore.getState().updateSettings({ language: lang as LanguageValue })
  document.documentElement.setAttribute('lang', lang)
}

/** 启动时根据当前设置同步 <html lang> 属性 */
export function applyLanguage() {
  document.documentElement.setAttribute('lang', getLanguage())
}

/** React 绑定：订阅 language，变化时组件自动重渲染 */
export function useTranslation() {
  const language = useStore((s) => s.settings.language)
  return { t, language, setLanguage, supported: SUPPORTED_LANGUAGES }
}
