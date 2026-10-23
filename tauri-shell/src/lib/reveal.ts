import { isTauri } from './env'

/**
 * 在系统文件管理器中**定位一个文件**（打开所在文件夹并选中它）。
 *
 * 三条入口（文件管理行内「打开目录」、内容详情、下载项）此前各自抄了一遍
 * `import('@tauri-apps/plugin-opener')` 的 try/catch —— 抄第三遍就该收口：
 * 行为差异（网页预览模式必须**如实报错**而不是静默）只允许有一处定义。
 *
 * 失败一律走调用方的 `onError`：这个动作没有「半成功」可言，吞掉异常等于
 * 用户点了没反应却不知道为什么（BUG-109 同族）。
 */
export async function revealItemPath(
  path: string,
  opts: {
    onError: (msg: string) => void
    /** 网页预览模式（无 opener 通道）时的说明文案。 */
    unsupported: string
    /** 调用失败时的前缀文案（调用方按自己的动词给）。 */
    failed: string
  },
): Promise<void> {
  if (!isTauri()) {
    opts.onError(opts.unsupported)
    return
  }
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
    await revealItemInDir(path)
  } catch (e) {
    opts.onError(`${opts.failed}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
