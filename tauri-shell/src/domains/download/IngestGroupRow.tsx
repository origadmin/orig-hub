import { useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { RowCheckbox } from '../../components/ui/selection-bar'
import { Progress } from '../../components/ui/progress'
import { formatBytes } from '../../lib/utils'
import { hasLibraryLocator } from '../../hooks/useGoLibrary'
import type { TgCacheTask } from '../../types'
import {
  ingestActionsFor,
  ingestDisplayName,
  isCacheActive,
  hasPriorityPin,
  type IngestAction,
  type IngestGroup,
} from './ingestGroups'
import { IngestDetailSheet } from './IngestDetailSheet'
import { useTranslation } from '../../i18n'

/**
 * TG 入库对象行（BT 类比里的「种子」）。
 *
 * **折叠态**给整体状态：一批内容共 N 条、已入库 M 条；在传时叠加**条目内字节进度** ——
 * 一条 200MB 视频要传几分钟，只报条目数的话进度条全程冻结，观感就是「没有状态」
 * （BUG-181 的教训：长传窗口内必须有一个会动的读数）。
 *
 * **明细**走**底部弹出 Sheet**（DLU-T01，2026-10-16 用户裁定「随 mock 测试那条，
 * 改用底部弹出」）：条目清单 + 历史批次，形态与引擎下载行的 `DownloadDetailSheet`
 * 统一。行内展开区已废除 —— 行内展开会把窗口化列表（BUG-316 段②）的 estimate
 * 打穿（展开行 432px 与折叠行 108px 混排 ⇒ 滚动跳动），Sheet 是 fixed 层。
 *
 * **入口没有独立按钮**（2026-10-20 用户第三次明确「明细按钮删除」；此前两次
 * 2026-10-16「位置样式有问题」、2026-10-19「下载明细不要按钮，只要选择」都只被
 * 改了样式/删了旁边的条目级按钮，诉求本身没被满足）：入口即折叠头整块
 * （`ingest-group-header` 的 onClick + title）。不要再长出任何「明细」控件 ——
 * 按钮形态、装饰 `▸`/`▾`、文字链都不行。
 *
 * 与 `DownloadItem`（普通下载行）**并列而非合并**：两侧计量单位、状态词、可执行动作
 * 都不同，硬合成一个组件就会长出「点了没反应」的按钮。显示统一（任务组范式、
 * 条目选择下载模型）见 `docs/design/download-unification-assessment-2026-10-16.md`。
 *
 * ## 2026-10-15 用户反馈后的补齐（BUG-300 复报）
 *
 * 入库流水线面板（`CacheManagerDialog`）有的能力，这里原先缺三样，现已补齐：
 * ① **跳转查看**（「去媒体库查看」）—— 走共享 hook `useGoLibrary`，与面板同一份实现；
 * ② **优先下载 / 取消优先**（BUG-277）—— 与后端 `cache::prioritizable` 同源判定；
 * ③ **已优先徽标** —— 排序状态必须看得见，否则点了除了顺序变化外无任何反馈。
 * 另：取消/中止不再让行消失 —— 记录留在「全部」档里、可数、可重试（BUG-314 已撤销
 * 曾误设的「已取消」独立树档；用户诉求是记录可见，不是新导航位）。
 *
 * ## 2026-10-15 用户复报（BUG-320 / BUG-315）
 *
 * ① **明细入口必须是个看得见的控件**：原先只是折叠头右上角一个 `▸`/`▾` 装饰字符
 * （`<span>` + 12px `text-muted`，与动作按钮同排），用户原话「展开/收缩根本看不到」。
 * 现为 `<button>` + Chevron 图标 + 「明细 N」文案 + `aria-expanded`，
 * 与 `CacheManagerDialog` 的清单入口同款。折叠头整块仍可点（旧交互不收回），
 * 但**入口自身独立可见、可聚焦** —— 不能让「能不能展开」只靠猜。
 *
 * ② **条目级「下载」是 BT 式选择**（BUG-315「无控制」；2026-10-19 用户裁定
 *    「不需要按钮，只需要选择，只有选中的才下载」）：Sheet 内勾选缺字节条目，
 *    底部一个批量动作 —— 逐条按钮已整体移除。后端幂等（BUG-308）：已入库拦下、
 *    活跃任务复用、缺字节复位重跑。
 *
 * ③ **条目级「停止」刻意不提供**：传输的最小单位是**任务**不是消息（TG 无真续传、
 * 队列不可抢占），条目级停止无法表达 —— 与其做「点了实际取消整批」的假按钮，
 * 不如直说「停止请用整行的取消」。这是「让错误状态不可表达」，不是功能缺失。
 */

/** 入库各状态词 → i18n key + 徽标色调（`status` 是 orig-tg **原生**词，不做跨侧归一化）。 */
const cacheStatusMeta: Record<
  string,
  { key: string; variant: 'success' | 'warning' | 'danger' | 'default' | 'secondary' }
> = {
  queued: { key: 'download.ingest.status.queued', variant: 'secondary' },
  running: { key: 'download.ingest.status.running', variant: 'default' },
  done: { key: 'download.ingest.status.done', variant: 'success' },
  cancelled: { key: 'download.ingest.status.cancelled', variant: 'secondary' },
  failed: { key: 'download.ingest.status.failed', variant: 'danger' },
  interrupted: { key: 'download.ingest.status.interrupted', variant: 'warning' },
}

const actionMeta: Record<IngestAction, { key: string; hintKey: string }> = {
  cancel: { key: 'download.ingest.action.cancel', hintKey: 'download.ingest.action.cancelHint' },
  retry: { key: 'download.ingest.action.retry', hintKey: 'download.ingest.action.retryHint' },
  // 优先下载（BUG-277）：语义写在 hint 里 —— 不抢占，只决定「当前任务跑完后接哪一条」。
  prefer: { key: 'download.ingest.action.prefer', hintKey: 'download.ingest.action.preferHint' },
  unprefer: { key: 'download.ingest.action.unprefer', hintKey: 'download.ingest.action.unpreferHint' },
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
  /** 「去媒体库查看」：就地起播成品并把焦点交给媒体库（共享 hook，见 `useGoLibrary`） */
  onGoLibrary: (task: TgCacheTask) => void
  /**
   * 批量下载**勾选的**条目（BT 式选择，2026-10-19 用户裁定）。
   *
   * 只承载勾选项的 messageId 列表；逐条按钮已在 Sheet 内移除。后端幂等
   * （BUG-308）：已入库拦下、活跃任务复用、缺字节复位重跑 —— 不会重复下载字节。
   * **条目级「停止」没有对应回调**，因为传输的最小单位是任务不是消息（见文件头 BUG-320 ③）。
   */
  onDownloadSelected?: (chatId: number, messageIds: number[]) => void
  /**
   * BUG-353：**选中**是下载域的控制面（2026-10-19 裁定「只有选中的才下载」同一条
   * 原则的反向：选中的 = 被操作的）。此前在传/待处理行只有行内按钮、没有任何
   * 选中能力 ⇒ 既不能批量干预，也没有「这些是我正在关注的内容」的表达 ——
   * 用户原话「下载中内容，没有选中，无法过滤取消下载」。
   */
  selected?: boolean
  onToggleSelect?: (key: string) => void
}

export function IngestGroupRow({
  group,
  onAction,
  onRemove,
  onGoLibrary,
  onDownloadSelected,
  selected = false,
  onToggleSelect,
}: Props) {
  const { t } = useTranslation()
  const { latest, runs } = group
  /** 明细 Sheet 开关（DLU-T01：底部弹出，替代原行内展开区）。 */
  const [sheetOpen, setSheetOpen] = useState(false)

  const meta = cacheStatusMeta[latest.status] ?? {
    key: latest.status,
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
      className={
        'rounded-lg border bg-surface transition-all duration-200 hover:border-accent/40 ' +
        (selected ? 'border-accent/60 bg-accent/5' : 'border-border-subtle')
      }
      data-testid="ingest-group-row"
      data-status={latest.status}
      data-key={group.key}
      data-runs={runs}
      data-selected={selected ? '1' : '0'}
    >
      {/* ── 折叠头：对象名 + 状态 + 操作 ── */}
      {/*
        折叠头整块点击 = 打开明细 Sheet（DLU-T01）。明细按钮与动作按钮都
        stopPropagation，不拦就会双触发（开 Sheet 后立刻关）。
      */}
      <div
        className="group cursor-pointer p-4"
        onClick={() => setSheetOpen(true)}
        title={t('download.ingest.headerTitle')}
        data-testid="ingest-group-header"
      >
        <div className="flex items-start justify-between gap-3">
          {/* 行级选中：下载域控制面（BUG-353）。点击只切换选中态、不打开明细 Sheet
              —— stopPropagation 拦掉折叠头整块的 onClick。 */}
          <label
            className="mt-0.5 flex shrink-0 cursor-pointer items-center"
            onClick={(e) => e.stopPropagation()}
            title={t('download.ingest.selectTitle')}
          >
            {/* BUG-393：行选择框走全仓标准组件。 */}
            <RowCheckbox
              checked={!!selected}
              onChange={() => onToggleSelect?.(group.key)}
              testId="ingest-group-select"
              ariaLabel={t('download.ingest.selectAria')}
            />
          </label>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{t('download.ingest.tgBadge')}</Badge>
              <p
                className="truncate text-sm font-medium text-fg-strong"
                title={latest.title || latest.itemKey}
                data-testid="ingest-group-name"
              >
                {ingestDisplayName(latest)}
              </p>
              <Badge variant={meta.variant}>{t(meta.key)}</Badge>
              {/* 优先下载徽标（BUG-277）：「已优先下载」是这一行的**排序状态**，必须看得见
                  —— 否则用户点了优先下载，除了列表顺序以外没有任何反馈可核对。 */}
              {/* BUG-396：徽标判据走唯一源 `hasPriorityPin` —— 终态任务没有优先状态。 */}
              {hasPriorityPin(latest.status, latest.priority ?? 0) && (
                <span
                  className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                  title={t('download.ingest.prioritizedTitle')}
                  data-testid="ingest-group-prioritized"
                >
                  {t('download.ingest.prioritized')}
                </span>
              )}
              {runs > 1 && (
                <span
                  className="shrink-0 text-[10px] text-muted"
                  title={t('download.ingest.runsTitle')}
                  data-testid="ingest-group-runs"
                >
                  {t('download.ingest.runs', { n: runs })}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {/*
              明细入口按钮已删除（2026-10-20 用户第三次明确；此前两次：
              2026-10-16「位置和样式有问题」→ 只改成底部弹出；2026-10-19
              「下载明细不要按钮，只要选择」→ 只删了条目级逐条「下载」按钮）。
              用户要的是**没有这个按钮**：入口收回归折叠头整块（下方 div 的
              onClick + title），Sheet 内容不变。三次诉求只改样式不改结构
              正是 BUG-320 复报的根因 —— 不要再长一个「明细」控件回来。
            */}
            {/*
              动作按钮**常驻可见**（2026-10-15 用户反馈「下载中的 TG 没有状态控制」）：
              原先整组 opacity-0 仅 hover 显形，活跃入库行——也就是最需要「取消」的那一行
              ——在不 hover 时看起来没有任何可控手段。hover 显形适用于低风险次要动作，
              不适用于「当前唯一能干预正在进行的入库的手段」。
            */}
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
              data-testid="ingest-group-actions"
            >
              {ingestActionsFor(latest.status, latest.priority ?? 0).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant="ghost"
                  onClick={() => onAction(latest, a)}
                  title={t(actionMeta[a]?.hintKey ?? actionMeta[a]?.key ?? a)}
                  data-testid={`ingest-group-action-${a}`}
                >
                  {t(actionMeta[a]?.key ?? a)}
                </Button>
              ))}
              {/*
                「去媒体库查看」（2026-10-15 用户反馈「入库流水线里面没有跳转查看」）：
                一次入库的终点是媒体库里的成品，出口就该通向成品。只在**已完成**且
                拿得到定位坐标时出现 —— 没入库完成就给这个按钮，点了播不出东西。
              */}
              {latest.status === 'done' && hasLibraryLocator(latest) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onGoLibrary(latest)}
                  title={t('download.ingest.goLibraryTitle')}
                  data-testid="ingest-group-golibrary"
                >
                  {t('download.ingest.goLibrary')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRemove(latest)}
                title={t('download.ingest.removeTitle')}
                data-testid="ingest-group-remove"
              >
                {t('download.ingest.remove')}
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
            {latest.done} / {latest.total}
            {t('download.ingest.entriesUnit')}
          </span>
          {byteProgress != null && (
            <span className="font-mono text-accent" data-testid="ingest-group-bytes">
              {formatBytes(latest.itemBytes!)} / {formatBytes(latest.itemBytesTotal!)}
            </span>
          )}
          {latest.itemBytes != null && byteProgress == null && (
            <span className="font-mono text-accent" data-testid="ingest-group-bytes">
              {t('download.ingest.bytesReceived', { size: formatBytes(latest.itemBytes!) })}
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

      {/* 明细 Sheet（DLU-T01：底部弹出，替代原行内展开区） */}
      {sheetOpen && (
        <IngestDetailSheet
          group={group}
          onDownloadSelected={onDownloadSelected}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}
