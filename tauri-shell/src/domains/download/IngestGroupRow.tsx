import { useEffect, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { formatBytes } from '../../lib/utils'
import { getCacheTaskItems } from '../../api/tg'
import type { GroupManifest, ManifestState, TgCacheTask } from '../../types'
import {
  ingestActionsFor,
  ingestDisplayName,
  isCacheActive,
  type IngestAction,
  type IngestGroup,
} from './ingestGroups'

/**
 * TG 入库对象行（BT 类比里的「种子」）。
 *
 * **折叠态**给整体状态：一批内容共 N 条、已入库 M 条；在传时叠加**条目内字节进度** ——
 * 一条 200MB 视频要传几分钟，只报条目数的话进度条全程冻结，观感就是「没有状态」
 * （BUG-181 的教训：长传窗口内必须有一个会动的读数）。
 *
 * **展开态**给两层明细，这是「和 BT 一样程度」的关键：
 *   ① 条目清单（`/api/tg/cache/tasks/:id/items`，BUG-296 组清单）—— 每集状态 / 有无字节；
 *   ② 历史批次 —— 同一批内容的历次入库记录（先前被平铺成独立行，是本缺陷的直接来源）。
 *
 * 与 `DownloadItem`（普通下载行）**并列而非合并**：两侧计量单位、状态词、可执行动作
 * 都不同，硬合成一个组件就会长出「点了没反应」的按钮。
 */

/** 入库各状态词 → 中文标签 + 徽标色调（`status` 是 orig-tg **原生**词，不做跨侧归一化）。 */
const cacheStatusMeta: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'danger' | 'default' | 'secondary' }
> = {
  queued: { label: '排队中', variant: 'secondary' },
  running: { label: '入库中', variant: 'default' },
  done: { label: '已完成', variant: 'success' },
  cancelled: { label: '已取消', variant: 'secondary' },
  failed: { label: '失败', variant: 'danger' },
  interrupted: { label: '已中断', variant: 'warning' },
}

const actionMeta: Record<IngestAction, { label: string }> = {
  cancel: { label: '取消' },
  retry: { label: '重试' },
}

/** 组清单每条状态的中文标签（BUG-296）。 */
const entryMeta: Record<ManifestState, { label: string; tone: string }> = {
  slotted: { label: '已入库', tone: 'text-success' },
  registered_unslotted: { label: '已登记未编入', tone: 'text-warning' },
  missing: { label: '无条目', tone: 'text-muted' },
}

function stamp(sec: number): string {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface Props {
  group: IngestGroup
  onAction: (task: TgCacheTask, action: IngestAction) => void
  onRemove: (task: TgCacheTask) => void
}

export function IngestGroupRow({ group, onAction, onRemove }: Props) {
  const { latest, history, runs } = group
  const [open, setOpen] = useState(false)
  const [manifest, setManifest] = useState<GroupManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const taskId = latest.id

  /**
   * 条目清单**懒加载**：只在首次展开时拉一次，之后复用。
   *
   * 不跟随轮询刷新 —— 逐任务拉组清单会让请求数随展开数线性增长（BUG-241 判据），
   * 且入库期间条目态变化不需要秒级精度。
   */
  useEffect(() => {
    if (!open || manifest) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    getCacheTaskItems(taskId)
      .then((m) => {
        if (!cancelled) setManifest(m)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, manifest, taskId])

  const meta = cacheStatusMeta[latest.status] ?? {
    label: latest.status,
    variant: 'secondary' as const,
  }
  const isActive = isCacheActive(latest.status)
  const hasByteTotal = (latest.itemBytesTotal ?? 0) > 0
  const byteProgress =
    hasByteTotal && latest.itemBytes != null
      ? Math.min(100, (latest.itemBytes / latest.itemBytesTotal!) * 100)
      : null
  /** 长传窗口内的真实动进度：优先条目内字节，否则退回条目数占比。 */
  const progress = byteProgress ?? latest.total > 0
    ? (latest.done / latest.total) * 100
    : 0

  return (
    <div
      className="rounded-lg border border-border-subtle bg-surface transition-all duration-200 hover:border-accent/40"
      data-testid="ingest-group-row"
      data-status={latest.status}
      data-key={group.key}
      data-runs={runs}
    >
      {/* ── 折叠头：对象名 + 状态 + 操作 ── */}
      {/*
        onClick 挂在**折叠头**上，不挂外层：外层还包着展开区，
        点明细会把整行收起来（用户展开后想选中/阅读时行会消失）。
      */}
      <div
        className="group cursor-pointer p-4"
        onClick={() => setOpen((o) => !o)}
        title="展开查看条目明细 / 历史批次"
        data-testid="ingest-group-header"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">TG 入库</Badge>
              <p
                className="truncate text-sm font-medium text-fg-strong"
                title={latest.title || latest.itemKey}
                data-testid="ingest-group-name"
              >
                {ingestDisplayName(latest)}
              </p>
              <Badge variant={meta.variant}>{meta.label}</Badge>
              {runs > 1 && (
                <span
                  className="shrink-0 text-[10px] text-muted"
                  title="同一批内容的历次入库记录已合并显示"
                  data-testid="ingest-group-runs"
                >
                  共 {runs} 次
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted" data-testid="ingest-group-caret">
              {open ? '▾' : '▸'}
            </span>
            <div
              className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              {ingestActionsFor(latest.status).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant="ghost"
                  onClick={() => onAction(latest, a)}
                  title={actionMeta[a]?.label ?? a}
                  data-testid={`ingest-group-action-${a}`}
                >
                  {actionMeta[a]?.label ?? a}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(latest)}
                title="删除记录"
                data-testid="ingest-group-remove"
              >
                删除
              </Button>
            </div>
          </div>
        </div>

        {/* 进度：条目数为主口径；在传且总量已知时用条目内字节进度（会动） */}
        <div className="mt-3">
          <Progress value={progress} animated={isActive} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span className="font-mono text-fg-mid" data-testid="ingest-group-progress">
            {latest.done} / {latest.total} 条
          </span>
          {byteProgress != null && (
            <span className="font-mono text-accent" data-testid="ingest-group-bytes">
              {formatBytes(latest.itemBytes!)} / {formatBytes(latest.itemBytesTotal!)}
            </span>
          )}
          {latest.itemBytes != null && byteProgress == null && (
            <span className="font-mono text-accent" data-testid="ingest-group-bytes">
              已收 {formatBytes(latest.itemBytes)}
            </span>
          )}
          <span className="font-mono">{stamp(latest.updatedAt)}</span>
          {latest.error && (
            <span className="truncate text-danger" title={latest.error}>
              {latest.error}
            </span>
          )}
        </div>
      </div>

      {/* ── 展开：条目清单 + 历史批次 ── */}
      {open && (
        <div className="space-y-3 border-t border-border-subtle px-4 pb-4 pt-3">
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-fg-mid">
              条目明细
              {latest.manifest && (
                <span className="ml-2 font-normal text-muted">
                  （已编入 {latest.manifest.slotted} / 未编入{' '}
                  {latest.manifest.registeredUnslotted} / 无条目{' '}
                  {latest.manifest.missing}）
                </span>
              )}
            </p>
            {loading && <p className="text-[11px] text-muted">加载中…</p>}
            {err && <p className="text-[11px] text-danger">{err}</p>}
            {!loading && !err && !manifest && (
              <p className="text-[11px] text-muted">无明细</p>
            )}
            {manifest && (
              <ul className="space-y-1" data-testid="ingest-group-entries">
                {manifest.entries.map((e) => {
                  const em = entryMeta[e.state]
                  const label =
                    e.season != null && e.episodeNo != null
                      ? `S${e.season}E${e.episodeNo}`
                      : `#${e.messageId}`
                  return (
                    <li
                      key={e.messageId}
                      className="flex items-center gap-3 text-[11px]"
                      data-testid="ingest-group-entry"
                      data-state={e.state}
                      data-bytes={e.hasBytes ? '1' : '0'}
                    >
                      <span className="w-16 shrink-0 font-mono text-muted">
                        {label}
                      </span>
                      <span className={em.tone}>{em.label}</span>
                      <span className="font-mono text-muted">
                        {e.hasBytes ? '有字节' : '无字节'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {history.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-fg-mid">
                历史批次（{history.length}）
              </p>
              <ul className="space-y-1" data-testid="ingest-group-history">
                {history.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-3 text-[11px] text-muted"
                    data-testid="ingest-group-history-item"
                    data-status={h.status}
                  >
                    <span className="w-16 shrink-0 font-mono">#{h.id}</span>
                    <span>{cacheStatusMeta[h.status]?.label ?? h.status}</span>
                    <span className="font-mono">{stamp(h.updatedAt)}</span>
                    {h.error && (
                      <span className="truncate text-danger" title={h.error}>
                        {h.error}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
