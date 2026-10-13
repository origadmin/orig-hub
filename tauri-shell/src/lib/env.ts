/**
 * 运行环境探测。
 *
 * 前端同时跑在两种形态下：
 * - 桌面客户端：Tauri WebView2 内，有 Tauri IPC 桥（`__TAURI_INTERNALS__`）。
 * - 网页调试模式：`vite dev` 跑在普通浏览器里，没有 Tauri 运行时。
 *
 * 纯浏览器里 `@tauri-apps/plugin-*` 调的是 Tauri 的 `invoke` IPC 桥，此时 `invoke` 为
 * `undefined`，直接调用会抛 `Cannot read properties of undefined (reading 'invoke')`。
 * 任何依赖原生的能力（系统对话框、文件系统、托盘…）调用前都必须先 `isTauri()` 守卫。
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * 网页调试模式的降级通道：把原生能力**换成的路径**交给用户（BUG-286）。
 *
 * 「打开文件夹」这类能力在纯浏览器里没有替代品，但「知道路径」有 ——
 * 降级为复制路径，用户可自行粘贴到资源管理器。剪贴板本身也可能不可用
 * （非安全上下文 / 权限被拒 / headless），所以这里是**尽力而为**：
 * 失败返回 false，由调用方退化成「直接展示路径」，绝不抛给 UI。
 *
 * @returns {Promise<boolean>} 是否成功写入剪贴板
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 剪贴板不可用不是错误 —— 降级路径本身（展示路径）仍然可用。
  }
  return false
}
