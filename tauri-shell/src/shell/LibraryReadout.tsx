import { memo } from 'react'
import { fmtSize } from '../lib/mediaSources'
import { useLibraryReadout } from '../store/libraryReadout'

/**
 * 全局状态栏的文件域读数叶子（BUG-400：占用/登记「应该在底栏显示状态」）。
 *
 * 用户裁定的「底栏」= 这条全局 `<footer>`（MainLayout 根部，连接态/速度同处），
 * 不是面板内再造一条 —— 面板内再叠一条就是双底栏，正是用户批评的「多余的栏」。
 *
 * 口径语义原样保留（BUG-133，位置迁移不改口径）：
 *  - 主口径 = 磁盘真值（清缓存后下降）；缺失 ⇒ 回退登记值并**改口径说明**，
 *    不显示 0、不假装它是磁盘占用；
 *  - 登记值显式标注「不是本地磁盘占用」；
 *  - 归零显示 `0 B`（「真的没有字节」是事实，不是缺读数；fmtSize(0) 的语义是后者）。
 *
 * 本叶子自订阅 store（低频：stats 只在轮询结果变化时写），MainLayout 不订阅。
 * `stats === null`（文件域数据从未加载）⇒ 不渲染 —— 不可用就不展示，不呈现死读数。
 */
export const LibraryReadout = memo(function LibraryReadout() {
  const stats = useLibraryReadout((s) => s.stats)
  const note = useLibraryReadout((s) => s.note)

  if (!stats) return null

  const hasDiskBasis = typeof stats.diskBytes === 'number'
  const leading = hasDiskBasis ? (stats.diskBytes ?? 0) : (stats.totalSize ?? 0)
  const occupancy = leading > 0 ? fmtSize(leading) : '0 B'
  const registered = typeof stats.totalSize === 'number' ? fmtSize(stats.totalSize) : '—'

  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="files-status-bar">
      <span
        className="shrink-0 text-[11px] text-muted"
        data-testid="page-secondary-info"
        title={`${hasDiskBasis
          ? '占用空间 = 文件管理在本机实际占用的磁盘字节（清缓存后会下降）'
          : '占用空间 = 文件管理登记的内容大小（后端未提供磁盘占用读数；清缓存后此值不变）'}\n登记值 = 内容在源头的大小之和（未落盘/字节已清的内容仍计入），不是本地磁盘占用`}
      >
        占用 {occupancy}
        {stats.truncated ? '（已截断）' : ''} · 登记 {registered}
      </span>
      {note ? <span className="min-w-0 truncate">{note}</span> : null}
    </span>
  )
})
