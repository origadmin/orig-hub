/**
 * 路径的**展示规范**与**存储规范**分离（BUG-332）。
 *
 * 存储/wire 一律正斜杠：daemon 的最小 TOML 解析器只 `trim_matches('"')` 不做反转义，
 * Windows 反斜杠会被当转义序列读坏（BUG-234 的妥协，不能改）。但用户看到的是
 * 资源管理器里的 `D:\OrigDown`，把存储妥协原样漏出去就是显示错误。
 *
 * 因此：进入任何可见文本前 `displayPath()`，离开输入框回写状态前 `storagePath()`。
 * 两者必须成对使用 —— 只做一半会出现「显示改了、保存后变成 `D:\\a`」或
 * 「显示 `\`、引擎读不到」。
 */

/** 宿主是否 Windows。桌面壳（WebView2）与浏览器里 UA 都带 Windows。 */
export const isWindowsHost = (): boolean =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** 存储形式 → 展示形式。Windows 下 `/` 变 `\`；非 Windows 原样返回。 */
export function displayPath(p: string | null | undefined): string {
  if (!p) return ''
  return isWindowsHost() ? p.replace(/\//g, '\\') : p
}

/**
 * 展示形式 → 存储形式。
 *
 * 只在 Windows 下把 `\` 折回 `/`：这样即使用户手工在输入框里敲了反斜杠，
 * 落盘/wire 仍然是解析器读得懂的正斜杠。`\\`（UNC 前导）也折成 `//`，
 * daemon 侧把 `//server/share` 当普通绝对路径处理，不会被当转义。
 */
export function storagePath(p: string | null | undefined): string {
  if (!p) return ''
  return isWindowsHost() ? p.replace(/\\/g, '/') : p
}

/**
 * 展示短路径：中间段过长时保留盘符/根与末两级，避免在单行里被 truncate 掉关键部分。
 * 只影响展示，不改变任何存储值。
 */
export function displayPathShort(p: string | null | undefined, keep = 2): string {
  const s = displayPath(p)
  if (!s) return ''
  const sep = isWindowsHost() ? '\\' : '/'
  const parts = s.split(sep).filter(Boolean)
  if (parts.length <= keep + 1) return s
  return `${parts[0]}${sep}…${sep}${parts.slice(-keep).join(sep)}`
}
