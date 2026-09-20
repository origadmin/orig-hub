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
