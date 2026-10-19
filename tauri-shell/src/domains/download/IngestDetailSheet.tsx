import { useEffect, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { useTranslation } from '../../i18n'
import { formatBytes } from '../../lib/utils'
import { getCacheTaskItems } from '../../api/tg'
import type { GroupManifest, ManifestState } from '../../types'
import { ingestDisplayName, isCacheActive } from './ingestGroups'
import type { IngestGroup } from './ingestGroups'

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

/** 组清单每条状态的中文标签（BUG-296）。措辞统一到「入库」口径：2026-10-17 用户
 *  裁定「不应该有编入」—— 「编入」是内部术语，界面一律说「入库」。 */
const entryMeta: Record<ManifestState, { label: string; tone: string }> = {
  slotted: { label: '已入库', tone: 'text-success' },
  registered_unslotted: { label: '已登记未入库', tone: 'text-warning' },
  missing: { label: '无条目', tone: 'text-muted' },
}

function stamp(sec: number): string {
  if (!sec) return '—'
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 入库组明细**底部弹出 Sheet**（DLU-T01，2026-10-16 用户裁定「随 mock 测试那条，
 * 改用底部弹出」）。
 *
 * 形态与 `DownloadDetailSheet`（引擎下载行详情）统一：fixed 底部弹出 + 抓手 +
 * 遮罩/Esc 关闭 + max-h 滚动主体。原先的行内展开区废除 —— 行内展开会把
 * 窗口化列表（BUG-316 段②）的 estimate 打穿（展开行 432px 与折叠行 108px 混排
 * ⇒ 滚动跳动），Sheet 是 fixed 层不占列表流。
 *
 * 条目清单重排（DLU-T03）：裸技术词「有字节/无字节」并入状态徽标的自然语言
 * （「已入库」= 有字节且入库；「缺字节」= 无字节、可单独下载）—— 用户报「信息
 * 显示有问题」，重叠且难懂的两套字节/状态词是主因。
 *
 * ## 2026-10-19 用户裁定：BT 式选择，不要逐条按钮
 *
 * 原话「下载明细不需要按钮,只需要选择,只有选中的才下载(和 BT 下载一样)」。
 * 逐条「下载」按钮因此**整体移除**，改为：
 * - 每个**缺字节**条目一个复选框（已入库条目无字节需求，不参与选择）；
 * - 头部「全选」复选框（只覆盖可选项）；
 * - 底部一个批量动作「下载选中 N 项」——**只有勾选的条目才会下载**。
 *
 * 边界（不造假按钮）：整批在传时选择与批量动作一律禁用 —— 传输以整批任务为
 * 最小单位，条目级停止不存在（BUG-320 ③），此时勾选无法兑现。理由写在行内。
 *
 * 条目级「停止」刻意不提供（BUG-320 ③，头部注释保留于 IngestGroupRow）：
 * 传输的最小单位是任务不是消息，Sheet 内直说原因，不做假按钮。
 */
export function IngestDetailSheet({
  group,
  onDownloadSelected,
  onClose,
}: {
  group: IngestGroup
  /** 批量下载**勾选的**缺字节条目（BT 式选择，2026-10-19 用户裁定）。未勾选 = 不下载。 */
  onDownloadSelected?: (chatId: number, messageIds: number[]) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { latest, history } = group
  const [manifest, setManifest] = useState<GroupManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** 勾选的 messageId 集合（BT 式选择；只装**缺字节**条目）。Sheet 关闭即弃。 */
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Esc 关闭（与 DownloadDetailSheet 同款）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * 条目清单懒加载：Sheet 挂载即拉一次（每次打开明细都重新拉 —— 与旧「首次展开
   * 拉一次后复用」不同：Sheet 关闭后组件卸载，缓存随之失效；入库期间条目态会变，
   * 陈旧清单比多一次请求更糟）。不跟随轮询刷新（BUG-241：请求数随打开数线性增长）。
   */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setSelected(new Set()) // 新清单 ⇒ 旧勾选一律作废（条目集会变，陈旧勾选比没有更糟）
    getCacheTaskItems(latest.id)
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
  }, [latest.id])

  const meta = cacheStatusMeta[latest.status] ?? {
    label: latest.status,
    variant: 'secondary' as const,
  }
  const isActive = isCacheActive(latest.status)
  const progress =
    latest.total > 0 ? Math.min(100, (latest.done / latest.total) * 100) : 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={(e) => e.stopPropagation()}
      data-testid="ingest-detail-sheet"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[86vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-surface shadow-2xl">
        {/* 抓手 */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="select-none text-lg leading-none text-muted" title="拖拽">
            ⠿
          </span>
        </div>

        {/* 表头：对象名 + 状态徽标 + 关闭 */}
        <div className="flex items-center gap-2 px-4 pb-2">
          <Badge variant="secondary">TG 入库</Badge>
          <p
            className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong"
            title={latest.title || latest.itemKey}
          >
            {ingestDisplayName(latest)}
          </p>
          <Badge variant={meta.variant}>{meta.label}</Badge>
          <button
            onClick={onClose}
            className="ml-1 rounded-md px-2 py-1 text-muted hover:bg-border-subtle"
            title="关闭"
            data-testid="ingest-detail-sheet-close"
          >
            ✕
          </button>
        </div>

        {/* 元信息行 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-xs text-muted">
          <span className="font-mono text-fg-mid">
            {latest.done} / {latest.total} 条
          </span>
          {latest.itemBytes != null && latest.itemBytesTotal != null && (
            <span className="font-mono text-accent">
              {formatBytes(latest.itemBytes)} / {formatBytes(latest.itemBytesTotal)}
            </span>
          )}
          <span className="font-mono">{stamp(latest.updatedAt)}</span>
          {latest.error && (
            <span className="truncate text-danger" title={latest.error}>
              {latest.error}
            </span>
          )}
        </div>

        {/* 进度条 */}
        <div className="px-4 pb-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-border-subtle">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* 主体（滚动）：条目清单 + 历史批次 */}
        <div className="min-h-0 flex-1 space-y-4 overflow-auto border-t border-border-subtle px-4 py-3">
          <div>
            <p
              className="mb-2 text-[10px] text-muted"
              data-testid="ingest-group-entry-note"
            >
              {isActive
                ? '整批入库中：条目级停止不存在（传输以整批任务为最小单位），要停请用列表行的「取消」'
                : '勾选缺字节的条目，只有选中的才会下载（BT 式选择；已入库的条目无需下载）'}
            </p>
            {loading && <p className="text-[11px] text-muted">加载中…</p>}
            {err && <p className="text-[11px] text-danger">{err}</p>}
            {!loading && !err && !manifest && (
              <p className="text-[11px] text-muted">无明细</p>
            )}
            {manifest && (() => {
              // 可下载集合 = 缺字节条目（已入库的没有下载需求，不参与选择）。
              const selectable = manifest.entries.filter((e) => !e.hasBytes)
              const selectableIds = selectable.map((e) => e.messageId)
              const allChecked =
                selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
              const toggleAll = () => {
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (allChecked) {
                    for (const id of selectableIds) next.delete(id)
                  } else {
                    for (const id of selectableIds) next.add(id)
                  }
                  return next
                })
              }
              const toggleOne = (id: number) => {
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              return (
              <>
              <div className="mb-1.5 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[11px] font-medium text-fg-mid">
                  条目明细
                  {latest.manifest && (
                    <span className="ml-2 font-normal text-muted">
                      （已入库 {latest.manifest.slotted} / 未入库{' '}
                      {latest.manifest.registeredUnslotted} / 无条目 {latest.manifest.missing}）
                    </span>
                  )}
                </p>
                {selectableIds.length > 0 && (
                  <label
                    className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted select-none"
                    title={isActive ? '整批入库中：不可选择' : '全选 / 取消全选缺字节条目'}
                    data-testid="ingest-sheet-select-all"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-accent"
                      checked={allChecked}
                      disabled={isActive}
                      onChange={toggleAll}
                      data-testid="ingest-sheet-select-all-box"
                    />
                    全选
                  </label>
                )}
              </div>
              <ul className="space-y-1" data-testid="ingest-sheet-entries">
                {manifest.entries.map((e) => {
                  const em = entryMeta[e.state]
                  const isEpisode = e.season != null && e.episodeNo != null
                  const label = isEpisode
                    ? `S${e.season}E${e.episodeNo}`
                    : e.mediaType === 'photo'
                      ? '图片'
                      : e.mediaType === 'video'
                        ? '视频'
                        : `#${e.messageId}`
                  const title = e.caption ?? e.fileName ?? undefined
                  const sizeText =
                    typeof e.size === 'number' ? formatBytes(e.size) : '—'
                  const dateText =
                    typeof e.msgDate === 'number' && e.msgDate > 0
                      ? (() => {
                          const d = new Date(e.msgDate * 1000)
                          const p = (n: number) => String(n).padStart(2, '0')
                          return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
                        })()
                      : '—'
                  const inFlight = e.startedAt != null
                  const accumSec =
                    typeof e.accumMs === 'number' ? Math.round(e.accumMs / 1000) : 0
                  /**
                   * 状态徽标合并字节语义（DLU-T03）：旧版右侧簇里「状态 label +
                   * 有字节/无字节」两套词重叠且难懂。缺字节优先于清单态显示 ——
                   * 它是唯一可操作态（可勾选下载），且正是「我不要/我要这条」的判据面。
                   */
                  const byteBadge = !e.hasBytes
                    ? { label: '缺字节', tone: 'text-warning' as const }
                    : em
                  const downloadable = !e.hasBytes
                  const isSelected = selected.has(e.messageId)
                  return (
                    <li
                      key={e.messageId}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                      data-testid="ingest-sheet-entry"
                      data-state={e.state}
                      data-bytes={e.hasBytes ? '1' : '0'}
                      data-inflight={inFlight ? '1' : '0'}
                      data-selected={isSelected ? '1' : '0'}
                    >
                      {downloadable && (
                        <input
                          type="checkbox"
                          className="h-3 w-3 shrink-0 accent-accent"
                          checked={isSelected}
                          disabled={isActive}
                          onChange={() => toggleOne(e.messageId)}
                          title={
                            isActive
                              ? '整批正在入库：请先用列表行的「取消」停止，再勾选下载'
                              : '勾选后随底部「下载选中」一并下载'
                          }
                          data-testid="ingest-sheet-entry-checkbox"
                          data-message-id={e.messageId}
                          aria-label={`选择 ${label}`}
                        />
                      )}
                      <span className="w-12 shrink-0 font-mono text-muted">
                        {label}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-fg-strong"
                        title={title}
                      >
                        {title ?? label}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        <span className="font-mono text-fg-mid">{sizeText}</span>
                        <span className="font-mono text-muted">{dateText}</span>
                        <span className={byteBadge.tone}>{byteBadge.label}</span>
                        {inFlight ? (
                          <Badge variant="default" className="shrink-0">
                            {t('tg.manifestInFlight')}
                          </Badge>
                        ) : accumSec > 0 ? (
                          <Badge variant="secondary" className="shrink-0">
                            {t('tg.manifestAccum', { s: accumSec })}
                          </Badge>
                        ) : null}
                      </span>
                    </li>
                  )
                })}
              </ul>
              </>
              )
            })()}
          </div>

          {history.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-fg-mid">
                历史批次（{history.length}）
              </p>
              <ul className="space-y-1" data-testid="ingest-sheet-history">
                {history.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-3 text-[11px] text-muted"
                    data-testid="ingest-sheet-history-item"
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

        {/* 底部批量动作（BT 式选择的落点）：只有勾选的缺字节条目会被下载。
            宿主未接线 ⇒ 不渲染（组件不自造跳转/不自造动作，BUG-324 纪律）。 */}
        {onDownloadSelected && manifest && (
          <div
            className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-4 py-2.5"
            data-testid="ingest-sheet-bulk-bar"
          >
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
              {selected.size > 0
                ? `已选 ${selected.size} 项，仅这些条目会下载`
                : '勾选缺字节条目后，只有选中的会下载'}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isActive || selected.size === 0}
              title={
                isActive
                  ? '整批正在入库：请先用列表行的「取消」停止，再勾选下载'
                  : selected.size === 0
                    ? '先勾选要下载的条目'
                    : `下载选中的 ${selected.size} 项`
              }
              data-testid="ingest-sheet-download-selected"
              onClick={() => {
                if (selected.size === 0 || isActive) return
                onDownloadSelected(manifest.chatId, [...selected])
                setSelected(new Set())
              }}
            >
              下载选中{selected.size > 0 ? ` ${selected.size} 项` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
