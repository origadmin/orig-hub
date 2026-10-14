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
 * 属 M2，那时 `components/media/*` 才会整体 `git mv` 到 `domains/files/media/`。
 * 本文件**不提前搬**，避免 20 个文件的导入路径 churn 与功能改动混在同一次提交里。
 *
 * ⚠ **当前内容区是设计基础违反，不是"过渡正确态"**（2026-10-15 用户裁定，BUG-299
 * 已升 critical）：D1=A「文件管理为纲」+ D13 事实轴的共识是「全部文件 = 全部受管
 * 字节，**共通 + 兼容**，含 zip/exe/pdf 等非媒体」（README §FileFact「受管字节的
 * **通用记录**」；spec §3「浏览全部文件，含非媒体文件」；09-revision §9.3「范围扩到
 * 含非媒体文件行」）。现状数据源只有 `media_item`（TG 缓存/手动导入两条写入路径），
 * ⇒ 域名「全量」实为「已登记媒体」，zip/exe/pdf 一律不可见。
 * **读通路不需要等 BUG-172**（2026-10-15 实证）：daemon 现存 `GET /api/downloads`
 * （含 `dest_path`）+ `/api/config` 的受管下载根即可枚举成品；BUG-172 只挡 ingest
 * 写入路径。任何「M0 暂不含 / 有损映射 / 已知欠账」式叙述都是在把违反合法化，
 * 本注释是违反标记，修复以 BUG-299 为准。
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
