import { create } from 'zustand'

/**
 * 文件域搜索的状态（BUG-400：搜索框从面板工具条上移到顶部上下文栏）。
 *
 * 与 `tgSearch.ts` 同构（BUG-100 同一模式）：搜索框渲染在 `ContextBar`
 * （`MainLayout` 子树），过滤消费在 `MediaLibraryPanel` —— 两者不在同一棵
 * 子树里，只能靠共享状态传值。
 *
 * 拆 `input` / `committed` 两个字段的理由同 tgSearch：`input` 是高频值
 * （每次按键变化），只有搜索框叶子订阅；`committed` 防抖后才写入，
 * 只有面板订阅（驱动 `loadItems` 的 `q=`）。
 */
interface FilesSearchState {
  /** 输入框原文（高频，仅搜索框叶子订阅） */
  input: string
  /** 已提交关键词（防抖后写入；面板只订阅这个） */
  committed: string
  setInput: (v: string) => void
  /** 提交关键词（等值短路：不变则不通知订阅者） */
  commit: (v: string) => void
  /** 清空（切离 items 视图 / 点清除 / 面板「清除筛选」） */
  clear: () => void
}

export const useFilesSearch = create<FilesSearchState>((set) => ({
  input: '',
  committed: '',
  setInput: (v) => set({ input: v }),
  commit: (v) => set((s) => (s.committed === v ? s : { committed: v })),
  clear: () => set({ input: '', committed: '' }),
}))
