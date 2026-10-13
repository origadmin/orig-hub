import { MediaLibraryPanel } from '../../components/MediaLibraryPanel'
import type { FileMode, NavState, SidebarCounts } from '../../nav'

/**
 * 文件域容器（模块重整 M0 · BUG-298 / M0-T03）。
 *
 * **M0 只做薄包裹**（`01-frontend-architecture.md` §8.1 原文「M0 包 → M2 拆」）：
 * 媒体库整块作为文件域的内容区，其左栏 rail 的**导航职责**已交回侧栏双树
 * （M0-T01）， rail 里的**能力**（标签云的截断/展开/过滤）原样搬进内容区，不丢。
 *
 * 深度拆解（ContentsView / SeriesView / TagsView / SeriesDetailView 四个 pane）
 * 属 M2，前置是 BUG-172（媒体脱离 TG）—— 那时 `components/media/*` 才会整体
 * `git mv` 到 `domains/files/media/`。本文件**不提前搬**，避免 20 个文件的导入
 * 路径 churn 与功能改动混在同一次提交里（§8.1 的分期理由）。
 *
 * 过渡口径（tasks.md §M0-T03，M0 数据源仍在 orig-tg 的 `/api/media/*`）：
 *   1. 父行/分类组 = 成品媒体墙，只显已入库 items，**绝不显任务行**；
 *   2. 未归档 = 现有 items 列表前端过滤（M2-T03 改后端参数化）；
 *   3. 分类计数随离散事件刷新，不轮询。
 */

interface Props {
  nav: NavState
  /** 树选择变化（下钻/返回/未归档勾选）→ 上报给 nav 单一真源 */
  onFmodeChange: (m: FileMode) => void
  /** 侧栏徽标的事实计数上报（同源纪律，见 nav/index.ts） */
  onCounts: (c: SidebarCounts) => void
  /**
   * 「在 TG 中查看」（BUG-305）：切到 TG 域的应用内出口。
   * MainLayout 的 `navigate('tg')` 通道；域间零直接 import，故由宿主接线。
   */
  onOpenTg: () => void
}

export function FilesPanel({ nav, onFmodeChange, onCounts, onOpenTg }: Props) {
  return (
    <MediaLibraryPanel
      fmode={nav.fmode}
      onFmodeChange={onFmodeChange}
      onCounts={onCounts}
      onOpenTg={onOpenTg}
    />
  )
}
