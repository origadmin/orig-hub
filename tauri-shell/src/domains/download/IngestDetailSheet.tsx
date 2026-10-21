import { useEffect, useRef, useState } from 'react'
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

/**
 * 条目可勾选判据（BUG-368，用户**第三次**提出「图片无法选择」）。
 *
 * 旧判据 `!e.hasBytes` 对**照片**漏了一种态：BUG-049 例外分支下「已落盘的历史
 * 图片」`hasBytes=true` 但并未入库（`state=registered_unslotted`）—— 它们在
 * Sheet 里看得见却一个复选框都没有，点不动也没法随「下载选中」入队，用户观感
 * 就是「图片无法选择」。照片补上「有字节但未入库」这一支；后端 enqueue 幂等
 * （BUG-308：已入库 ⇒ `alreadyIngested` 零字节跳过），多给一个勾选不会重下。
 * 视频判据不变（有字节 = 已入库，无下载需求）。
 */
function isSelectableEntry(e: {
  hasBytes: boolean
  mediaType?: string | null
  state: ManifestState
}): boolean {
  return !e.hasBytes || (e.mediaType === 'photo' && e.state === 'registered_unslotted')
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
        if (cancelled) return
        setManifest(m)
        /*
         * 默认**全选缺字节条目**（2026-10-20 用户口径：「选中的=要下载的，
         * 入库=要下载的，实际：全部非选中」）。
         *
         * 缺字节 = 还没入库 = 要下载的，所以面板一打开就该是「全部选中 + 按钮可点」，
         * 用户只做减法（取消掉不想下的那几条）。旧实现给空集合 ⇒ 10 条全非选中、
         * 「下载选中」还灰着，等于告诉用户「没有要下载的」——与选择语义直接矛盾。
         *
         * 整批在传时不预选：此时选择无法兑现（条目级停止不存在，传输最小单位是任务，
         * 见 BUG-320 ③），预选会给出「已选 N 项」却按不动的假象。
         */
        if (!isCacheActive(latest.status)) {
          setSelected(
            new Set(m.entries.filter(isSelectableEntry).map((e) => e.messageId)),
          )
        }
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

  /**
   * 可选集合 = 未入库条目（缺字节，或 BUG-049 例外下「有字节但未入库」的照片，
   * 见 `isSelectableEntry`）。已入库的没有下载需求，不参与选择。
   *
   * 提到渲染之外算，是为了让「全选 / 半选」的状态只算一次 —— 原来两个状态算在
   * JSX 的 IIFE 里，`<input>` 只能表达 checked，没有 indeterminate，于是
   * **部分选中时全选框与「一条没选」长得一模一样**（用户 2026-10-20 报
   * 「全选和选中偏离」）。半选必须看得见，否则「全选」是个说谎的开关。
   */
  const selectableIds = manifest
    ? manifest.entries.filter(isSelectableEntry).map((e) => e.messageId)
    : []
  const allChecked =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const someChecked = selectableIds.some((id) => selected.has(id))
  const selectAllRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // `indeterminate` 只能走 DOM 属性，React 没有对应 prop。
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someChecked && !allChecked
    }
  }, [someChecked, allChecked])

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
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={(e) => e.stopPropagation()}
      data-testid="ingest-detail-sheet"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[86vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-surface shadow-2xl">
        {/* 抓手：**纯视觉暗示**（底部弹出面板的通用形态），不实现拖拽。
            原先写了 `title="拖拽"` —— 面板根本不能拖，这个提示是在骗人
            （2026-10-20 清理：不要做「说了做不到」的交互提示）。 */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="select-none text-lg leading-none text-muted" aria-hidden="true">
            ⠿
          </span>
        </div>

        {/* 表头：对象名 + 状态徽标 + 关闭（BUG-372：标题必须是第一行第一个元素，
            原先「TG 入库」徽标压在标题前面——用户「标题不在第一行」；与引擎
            DownloadDetailSheet 表头同构：␣抓手 + 标题 + 状态 + 关闭）。 */}
        <div className="flex items-center gap-2 px-4 pb-2">
          <p
            className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong"
            title={latest.title || latest.itemKey}
          >
            {ingestDisplayName(latest)}
          </p>
          <Badge variant={meta.variant} className="text-[12px]">{meta.label}</Badge>
          <button
            onClick={onClose}
            /* 关闭是唯一出口，命中区必须够大（原 px-2 py-1 ≈ 24×24px，13px 的 ✕ 太难点） */
            className="ml-1 rounded-md px-2.5 py-1.5 text-base leading-none text-muted hover:bg-border-subtle hover:text-fg-strong"
            title="关闭"
            aria-label="关闭明细"
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
              className="mb-2.5 text-[12px] leading-relaxed text-muted"
              data-testid="ingest-group-entry-note"
            >
              {isActive
                ? '整批入库中：条目级停止不存在（传输以整批任务为最小单位），要停请用列表行的「取消」'
                : '未入库的条目已经全部选中；取消勾选你不想下的，只有选中的才会下载'}
            </p>
            {loading && <p className="text-[12px] text-muted">加载中…</p>}
            {err && <p className="text-[12px] text-danger">{err}</p>}
            {!loading && !err && !manifest && (
              <p className="text-[12px] text-muted">无明细</p>
            )}
            {manifest && (() => {
              return (
              <>
              {/*
                全选放在**条目复选框那一列**（2026-10-20 用户报「全选和选中偏离」）：
                原来它被 flex-1 的标题挤到最右端，实测 x=1387，而每行复选框在 x≈16 ——
                相隔 1371px，「控制这些框的开关」和「这些框」在视觉上毫无关系。
                现结构：[全选 复选框][全选 文字][条目明细 + 计数]。
                字号 10px → 13px、框 12px → 16px：原来那个 36×15px 的标签几乎点不到。
              */}
              <div className="mb-2 flex items-center gap-3">
                {selectableIds.length > 0 ? (
                  <label
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[13px] text-fg-mid select-none"
                    title={isActive ? '整批入库中：不可选择' : '全选 / 取消全选缺字节条目'}
                    data-testid="ingest-sheet-select-all"
                  >
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-accent"
                      checked={allChecked}
                      disabled={isActive}
                      onChange={toggleAll}
                      data-testid="ingest-sheet-select-all-box"
                    />
                    全选
                  </label>
                ) : (
                  <span className="w-4 shrink-0" aria-hidden="true" />
                )}
                <p className="min-w-0 flex-1 text-[13px] font-medium text-fg-strong">
                  条目明细
                  {latest.manifest && (
                    <span className="ml-2 font-normal text-muted">
                      （已入库 {latest.manifest.slotted} / 未入库{' '}
                      {latest.manifest.registeredUnslotted} / 无条目 {latest.manifest.missing}）
                    </span>
                  )}
                </p>
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
                  // BUG-368：照片「有字节但未入库」也可勾选（历史落盘图未入媒体库），
                  // 判据统一定义在 isSelectableEntry。
                  const downloadable = isSelectableEntry(e)
                  const isSelected = selected.has(e.messageId)
                  return (
                    <li
                      key={e.messageId}
                      /*
                       * 整行可点选（2026-10-20 用户报「按钮完全无法找到」）：
                       * 原来唯一能选的只有那个 12×12px 的复选框 —— 鼠标要精确命中
                       * 一个小方块，实际等于「没有可点的东西」。现在整行都是命中区
                       * （≥36px 高），复选框只作状态指示。
                       * 不可下载的行（已入库）不给指针、不响应点击 —— 点它没有任何
                       * 可兑现的动作，做出来就是死按钮。
                       */
                      onClick={downloadable && !isActive ? () => toggleOne(e.messageId) : undefined}
                      className={[
                        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1 py-1.5 text-[13px]',
                        downloadable && !isActive
                          ? 'cursor-pointer select-none hover:bg-border-subtle/50'
                          : '',
                        // BUG-346：原先只给 `bg-accent/5` —— 在暗底行背景下与未选中
                        // 行的差异肉眼不可辨，用户勾完看到的仍是「灰色的、没选上」。
                        // 选中态必须有**边界**（描边）而不仅是底色深浅。
                        isSelected ? 'bg-accent/10 ring-1 ring-accent/50' : '',
                      ].join(' ')}
                      title={
                        downloadable && !isActive
                          ? isSelected
                            ? '点击取消这条（取消后不下载）'
                            : '点击选中这条（选中的才会下载）'
                          : undefined
                      }
                      data-testid="ingest-sheet-entry"
                      data-state={e.state}
                      data-bytes={e.hasBytes ? '1' : '0'}
                      data-inflight={inFlight ? '1' : '0'}
                      data-selected={isSelected ? '1' : '0'}
                    >
                      {downloadable && (
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-accent"
                          checked={isSelected}
                          disabled={isActive}
                          /*
                           * 行本身已负责切换：复选框的点击必须拦下来，否则
                           * 「input 触发一次 + 冒泡到行再触发一次」= 双击两下等于没点。
                           */
                          onClick={(ev) => ev.stopPropagation()}
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
                      <span className="w-14 shrink-0 font-mono text-muted">
                        {label}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-fg-strong"
                        title={title}
                        data-testid="ingest-sheet-entry-title"
                      >
                        {/* 没有 caption / fileName 时退回 messageId，**不要退回 label**
                            —— 左列已经写了「图片 / S1E1」，右列再写一遍就是「图片 图片」，
                            实测截图里整列重复，等于白占一列宽度。 */}
                        {title ?? `#${e.messageId}`}
                      </span>
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px]">
                        <span className="font-mono text-fg-mid">{sizeText}</span>
                        <span className="font-mono text-muted">{dateText}</span>
                        <span className={byteBadge.tone}>{byteBadge.label}</span>
                        {inFlight ? (
                          <Badge variant="default" className="shrink-0 text-[12px]">
                            {t('tg.manifestInFlight')}
                          </Badge>
                        ) : accumSec > 0 ? (
                          <Badge variant="secondary" className="shrink-0 text-[12px]">
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
              <p className="mb-1.5 text-[13px] font-medium text-fg-strong">
                历史批次（{history.length}）
              </p>
              <ul className="space-y-1" data-testid="ingest-sheet-history">
                {history.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-3 text-[12px] text-muted"
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

        {/*
          底部批量动作（BT 式选择的落点）：只有勾选的缺字节条目会被下载。
          宿主未接线 ⇒ 不渲染（组件不自造跳转/不自造动作，BUG-324 纪律）。

          2026-10-20 用户报「按钮完全无法找到」：实测原按钮 68×29px、11px 白字，
          挤在 1440 宽窗口的最右下角，未选中时还是 disabled+opacity-40 —— 看着像装饰。
          现在：13px 字号 + px-4 py-2（实测高度 ≥36px）+ 左侧把「已选 N 项」提到
          13px 并加粗，按钮文案永远带数量；未选中时按钮不消失（消失才是真的找不到），
          而是保持可见 + disabled + 文案直说「先选条目」。
        */}
        {onDownloadSelected && manifest && (
          <div
            className="flex shrink-0 items-center gap-3 border-t border-border-subtle px-4 py-3"
            data-testid="ingest-sheet-bulk-bar"
          >
            <span className="min-w-0 flex-1 text-[13px] text-muted">
              {selected.size > 0 ? (
                <>
                  已选{' '}
                  <span className="font-mono font-semibold text-fg-strong">
                    {selected.size}
                  </span>{' '}
                  项 / 可下载 {selectableIds.length} 项
                </>
              ) : (
                '尚未选择条目'
              )}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              disabled={isActive || selected.size === 0}
              title={
                isActive
                  ? '整批正在入库：请先用列表行的「取消」停止，再勾选下载'
                  : selected.size === 0
                    ? '先选条目：点行或勾选复选框'
                    : `下载选中的 ${selected.size} 项`
              }
              data-testid="ingest-sheet-download-selected"
              onClick={() => {
                if (selected.size === 0 || isActive) return
                onDownloadSelected(manifest.chatId, [...selected])
                setSelected(new Set())
              }}
            >
              {selected.size > 0 ? `下载选中 ${selected.size} 项` : '下载选中'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
