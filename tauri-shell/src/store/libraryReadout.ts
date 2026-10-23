import { create } from 'zustand'

/**
 * 文件域页面级读数（BUG-400：占用/登记「应该在底栏显示状态」）。
 *
 * 用户裁定的「底栏」= **全局状态栏**（MainLayout 根部 `<footer>`，连接态/速度
 * 同处）。读数的**生产者**是 `MediaLibraryPanel`（stats 数据局部性在那里），
 * 渲染点在 MainLayout 底栏 —— 两棵子树，只能走共享状态（同 filesSearch 模式）。
 *
 * 这里只存**原始数字**：格式化（fmtSize）与 BUG-133 的口径回退（磁盘真值缺失
 * ⇒ 回退登记值并改口径说明）都在叶子组件里做，store 不持有展示串。
 * `note` 是页面提示串（「单击选中，双击打开 · 显示 n/total」，面板已 i18n 拼好），
 * 面板卸载/切视图即清空，不跨视图遗留。
 */
export interface LibraryStatsRaw {
  /** 磁盘真值（后端未提供 = null ⇒ 叶子回退登记值并改口径说明） */
  diskBytes: number | null
  /** 登记值（SUM(size)，源头大小） */
  totalSize: number | null
  /** 磁盘真值是否被后端截断（BUG-133 既有口径标注） */
  truncated: boolean
}

interface LibraryReadoutState {
  stats: LibraryStatsRaw | null
  note: string | null
  setStats: (s: LibraryStatsRaw | null) => void
  setNote: (v: string | null) => void
}

export const useLibraryReadout = create<LibraryReadoutState>((set) => ({
  stats: null,
  note: null,
  setStats: (stats) => set({ stats }),
  setNote: (note) => set((s) => (s.note === note ? s : { note })),
}))
