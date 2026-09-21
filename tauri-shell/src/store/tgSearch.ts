import { create } from 'zustand'
import type { TgStoredMessage } from '../types'

/**
 * 全局监控查找的状态（BUG-100：搜索框上移到顶部上下文栏）。
 *
 * 为什么单独一个 store 而不是组件内 `useState`：
 * 搜索框渲染在 `ContextBar`（`MainLayout` 子树），命中结果渲染在 `TgPanel` —— 两者
 * 不在同一棵子树里，只能靠共享状态传值。
 *
 * 为什么不放进 `useStore` 本体：`input` 是**高频**值（每次按键变化）。若让 `TgPanel`
 * 直接订阅它，一次按键就会重渲染 2000+ 行的面板（AGENTS.md §5 流畅优先）。
 * 因此这里拆成两个字段：
 *   - `input`     —— 只有搜索框叶子订阅（高频，局部）；
 *   - `committed` —— 防抖 300ms 后才写入，只有 `TgPanel` 订阅（低频，驱动查询）。
 */
export type TgSearchHit = TgStoredMessage & { channelTitle?: string }

interface TgSearchState {
  /** 输入框原文（高频，仅搜索框叶子订阅） */
  input: string
  /** 已提交关键词（防抖后写入；`TgPanel` 只订阅这个） */
  committed: string
  hits: TgSearchHit[]
  searching: boolean
  setInput: (v: string) => void
  /** 提交关键词（等值短路：不变则不通知订阅者） */
  commit: (v: string) => void
  setHits: (hits: TgSearchHit[]) => void
  setSearching: (v: boolean) => void
  /** 清空（切离 TG 视图 / 点清除按钮） */
  clear: () => void
}

export const useTgSearch = create<TgSearchState>((set) => ({
  input: '',
  committed: '',
  hits: [],
  searching: false,
  setInput: (v) => set({ input: v }),
  commit: (v) => set((s) => (s.committed === v ? s : { committed: v })),
  setHits: (hits) => set({ hits }),
  setSearching: (searching) => set({ searching }),
  clear: () => set({ input: '', committed: '', hits: [], searching: false }),
}))
