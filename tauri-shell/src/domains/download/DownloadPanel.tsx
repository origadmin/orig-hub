import { useMemo } from 'react'
import type { DownloadStatus, DownloadStatusValue } from '../../types'
import type { DlFilter } from '../../nav'
import { DownloadList } from './DownloadList'

/**
 * 下载域容器（模块重整 M0 · BUG-298 / M0-T02）。
 *
 * **只换挂载与状态来源**（禁区原文）：列表组件本身不改、行内悬停操作不改、
 * DetailSheet 不改、「新建下载」仍在标题栏右侧、**页面内无 tabs** ——
 * 状态选择唯一载体是侧栏下载树（`nav.dlFilter`）。
 *
 * 数据源 M0 保持现状（引擎任务端 `/api/downloads`，SSE 单一合并源）；
 * TG 任务并入在 M3（`/api/activity`，BUG-300）。
 *
 * 档位口径（BUG-082，与侧栏徽标、状态栏三处共用）：
 *   | 树选择   | 状态集合                                  |
 *   |----------|-------------------------------------------|
 *   | running  | downloading | queued | idle               |
 *   | paused   | paused                                    |
 *   | done     | completed                                 |
 *   | all      | 以上全部 + error | cancelled（失败兜底）  |
 * `error | cancelled` **没有专属树档**（用户裁定）：只在「全部任务」可见，
 * 靠行内红色错误文字 + 行内「删除」处理，不为它占用一个树位。
 */

interface Props {
  /** 侧栏下载树当前选择 */
  dlFilter: DlFilter
  /** 引擎任务全量（MainLayout 从 store 取，未过滤） */
  items: DownloadStatus[]
}

const RUNNING: DownloadStatusValue[] = ['downloading', 'queued', 'idle']

export function DownloadPanel({ dlFilter, items }: Props) {
  const visible = useMemo(() => {
    switch (dlFilter) {
      case 'running':
        return items.filter((d) => RUNNING.includes(d.status))
      case 'paused':
        return items.filter((d) => d.status === 'paused')
      case 'done':
        return items.filter((d) => d.status === 'completed')
      case 'all':
      default:
        // 全部任务 = 三档 + 失败兜底（error | cancelled 只在此可见）
        return items.filter(
          (d) =>
            RUNNING.includes(d.status) ||
            d.status === 'paused' ||
            d.status === 'completed' ||
            d.status === 'error' ||
            d.status === 'cancelled',
        )
    }
  }, [dlFilter, items])

  return <DownloadList items={visible} />
}
