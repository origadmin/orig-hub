/**
 * 文件翻译模式 i18n（与主流应用一致的 locale 文件 + t() 方案）。
 *
 * 设计约束：分类的「规范化 key」（Videos/Audio/...）同时是磁盘子目录名、
 * classify_rules 的键、前端筛选值，因此绝不能用于显示层翻译——这里只翻译
 * 「显示文案」。分类 key 走 `category.<Key>` 命名空间，缺失时回退到 key 本身，
 * 因此用户自定义分类（任意名称）也能安全 fallback。
 */
import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'
import { useStore } from '../store/useStore'

export type Language = 'zh-CN' | 'en-US'

const MESSAGES: Record<Language, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'en-US': enUS as Record<string, string>,
}

export const SUPPORTED_LANGUAGES: { value: Language; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
]

/** 按浏览器环境推断默认语言（无需持久化时也给出合理默认值） */
export function detectLanguage(): Language {
  if (typeof navigator === 'undefined') return 'zh-CN'
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 当前生效语言：优先取已持久化的设置，否则按环境推断 */
export function getLanguage(): Language {
  const lang = useStore.getState().settings.language as Language | undefined
  return lang ?? detectLanguage()
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
  const dict = MESSAGES[lang] ?? MESSAGES['zh-CN']
  let str: string = dict[key] ?? MESSAGES['zh-CN'][key] ?? fallback ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}

/** 用户切换语言：写入设置（持久化）+ 同步 <html lang> */
export function setLanguage(lang: Language) {
  useStore.getState().updateSettings({ language: lang })
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
