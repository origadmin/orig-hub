import { useState } from 'react'
import { GitMerge } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { appendEpisodes, createSeries, mergeSeries, mergeSeriesMulti } from '../../api/media'
import type { MediaSeries, MergeResult } from '../../api/media'
import { useTranslation } from '../../i18n'
import { seriesLabel } from '../../lib/displayTitle'

/**
 * 新建剧集（BUG-258 产品裁定：kind 收敛为唯一值 `series`）。
 *
 * 此前这里提供「剧集 / 合集 / 图集」三选一的 radio（`KIND_OPTIONS`）——
 * 产品裁定后类型不再可选，创建请求恒定 `kind: 'series'`。
 * 引擎侧保留 `SERIES_KINDS` 枚举 422 校验与一次性迁移作为数据层防线。
 */
export function CreateSeriesDialog(props: {
  onClose: () => void
  onCreated: (id: number, title: string) => void
  onError: (msg: string) => void
}) {
  const { onClose, onCreated, onError } = props
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [year, setYear] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const y = Number.parseInt(year.trim(), 10)
      const res = await createSeries({
        title: title.trim(),
        description: description.trim() || undefined,
        // BUG-258 产品裁定：kind 不可选，恒定唯一值
        kind: 'series',
        year: Number.isFinite(y) ? y : undefined,
      })
      onCreated(res.id, title.trim())
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="series-create-dialog"
      >
        <h2 className="text-base font-semibold text-fg-strong">新建剧集</h2>
        <div className="mt-3 space-y-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="名称，例如「Big Buck Bunny · 码率阶梯」"
            className="h-8 text-xs"
            autoFocus
          />
          {/* 介绍天然是多行内容：单行 Input 会把长介绍截成一行（用户实测反馈） */}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简介（可选，支持换行）"
            rows={2}
            className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-fg-strong placeholder:text-muted"
          />
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            placeholder="年份（可选）"
            className="h-8 text-xs"
            inputMode="numeric"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={busy || !title.trim()}
            onClick={() => void submit()}
          >
            {busy ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 把选中的内容批量加入某个剧集（按选择顺序编为连续集号） */
export function AddToSeriesDialog(props: {
  itemIds: number[]
  series: MediaSeries[]
  onClose: () => void
  onDone: (seriesTitle: string, added: number) => void
  onError: (msg: string) => void
}) {
  const { itemIds, series, onClose, onDone, onError } = props
  const [target, setTarget] = useState<number | null>(series[0]?.id ?? null)
  const [season, setSeason] = useState('1')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (target === null) return
    setBusy(true)
    try {
      const s = Number.parseInt(season, 10)
      const res = await appendEpisodes(target, itemIds, Number.isFinite(s) ? s : 1)
      const title = series.find((x) => x.id === target)?.title ?? ''
      onDone(title, res.added)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">
          将 {itemIds.length} 项加入剧集
        </h4>
        {series.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">
            还没有剧集，请先点「新建剧集」创建一个
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            <select
              value={target ?? ''}
              onChange={(e) => setTarget(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-border-subtle bg-surface px-2 text-xs text-fg-strong"
            >
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}（{s.episodeCount} 集）
                </option>
              ))}
            </select>
            <Input
              value={season}
              onChange={(e) => setSeason(e.target.value)}
              placeholder="季号（默认 1）"
              className="h-8 text-xs"
              inputMode="numeric"
            />
            <p className="text-[10px] text-muted">
              按当前选择顺序追加为连续集号（接在该季已有集数之后）。
            </p>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={busy || target === null || itemIds.length === 0}
            onClick={() => void submit()}
          >
            {busy ? '添加中…' : '加入'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 把某个剧集**整体并入**另一个剧集（BUG-037）。
 *
 * 源剧集会被删除、集号会被重编 —— **不可撤销**，所以提交前必须过一次显式确认：
 * 第一次点「下一步」只切到确认态，写明「《X》将被删除」后才允许真正执行。
 *
 * 文案刻意讲清「不做合并判断」：文件名相同而内容不同、同一内容多源导入、
 * `1-2` 与 `1,2` 并存、每批都带的预告，后端一律原样保留 —— 用户需要预期这一点，
 * 否则合并后看到「重复」会以为功能坏了。
 */
export function MergeSeriesDialog(props: {
  /** 合并目标（内容并入这里，它保留） */
  target: { id: number; title: string; episodeCount: number }
  series: MediaSeries[]
  onClose: () => void
  onDone: (res: MergeResult, sourceTitle: string) => void
  onError: (msg: string) => void
}) {
  const { target, series, onClose, onDone, onError } = props
  // 订阅 UI 语言（BUG-251）：seriesLabel 在函数内部读 `getLanguage()` 决定标记形态，
  // 本组件渲染的两处剧名依赖它 —— 不订阅 `settings.language` 则语言切换后标记不更新。
  // 文案全部走 i18n（BUG-252）：与 MergeSeriesMultiDialog 共用同一套 `media.seriesMerge*` 键。
  const { t } = useTranslation()
  // 目标自己不能当源
  const candidates = series.filter((s) => s.id !== target.id)
  const [sourceId, setSourceId] = useState<number | null>(candidates[0]?.id ?? null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const source = candidates.find((s) => s.id === sourceId) ?? null

  const submit = async () => {
    if (sourceId === null || !source) return
    setBusy(true)
    try {
      const res = await mergeSeries(target.id, sourceId)
      onDone(res, source.title)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-strong">
          <GitMerge className="h-3.5 w-3.5 shrink-0" />
          {t('media.seriesMergeOpen')}
        </h4>
        <p className="mt-1 text-[11px] text-muted">
          {t('media.seriesMergeTargetPrefix')}
          <span className="font-medium text-fg-strong">{seriesLabel(target.title)}</span>
          {t('media.seriesMergeTargetSuffix', { n: target.episodeCount })}
        </p>

        {candidates.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">{t('media.seriesMergeEmpty')}</p>
        ) : (
          <div className="mt-3 space-y-2">
            <select
              value={sourceId ?? ''}
              onChange={(e) => {
                setSourceId(Number(e.target.value))
                setConfirming(false)
              }}
              className="h-8 w-full rounded-md border border-border-subtle bg-surface px-2 text-xs text-fg-strong"
            >
              {candidates.map((s) => (
                <option key={s.id} value={s.id}>
                  {t('media.seriesMergeOption', { title: s.title, n: s.episodeCount })}
                </option>
              ))}
            </select>
            <p className="text-[10px] leading-relaxed text-muted">
              {t('media.seriesMergeOrderHint')}
            </p>
            <p className="text-[10px] leading-relaxed text-muted">
              {t('media.seriesMergeNumberPrefix')}
              <span className="font-medium text-fg-mid">{t('media.seriesMergeNumberEmph')}</span>
              {t('media.seriesMergeNumberSuffix')}
            </p>
            {confirming && source && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
                {t('media.seriesMergeConfirmBodySingle', {
                  source: seriesLabel(source.title),
                  n: source.episodeCount,
                  target: seriesLabel(target.title),
                })}
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            {t('media.cancel')}
          </Button>
          {confirming ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-destructive/50 px-3 text-xs text-destructive"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? t('media.seriesMergeBusy') : t('media.seriesMergeDone')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={sourceId === null}
              onClick={() => setConfirming(true)}
            >
              {t('media.seriesMergeNext')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 剧集墙多选合并（BUG-186）：把选中的 **N（≥2）条剧集** 合并为一条。
 *
 * 与内页的 `MergeSeriesDialog`（单源、目标固定为当前打开的剧集）不同，这里：
 *   1. **方向显式**：用户自己选「保留哪一条」，**不**由「先点了谁」隐含决定；
 *   2. **后果可见**：第二步确认列出**将被删除**的源剧集**名字**（删源不可逆）；
 *   3. **一次请求**：提交只发一个 `POST /api/media/series/:targetId/merge`，带全部 `sourceIds`
 *      —— 后端在同一事务里全成或全滚，前端**禁止**循环调单源端点。
 *
 * 两步确认形态与既有对话框一致：第一步选目标，第二步确认（带删除警示）。
 */
export function MergeSeriesMultiDialog(props: {
  open: boolean
  /** 被选中的剧集（≥2），顺序 = 用户点击顺序（仅用于展示，不作为方向判据） */
  series: MediaSeries[]
  onClose: () => void
  onDone: (res: MergeResult, targetTitle: string) => void
  onError: (msg: string) => void
}) {
  const { t } = useTranslation()
  const { open, series, onClose, onDone, onError } = props
  // 默认第一条只是「一个中性的起点」，**不是**方向判据：用户可以改，且必须走完两步确认。
  const [targetId, setTargetId] = useState<number>(series[0]?.id ?? -1)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!open) return null

  // 目标 = 用户**显式**选中的那一条（不是选择顺序里的第一条）。
  const target = series.find((s) => s.id === targetId) ?? null
  // 将被删除的源 = 除目标外的全部选中项。
  const sources = series.filter((s) => s.id !== (target?.id ?? -1))
  const sourceIds = sources.map((s) => s.id)

  const submit = async () => {
    if (!target || sourceIds.length === 0) return
    setBusy(true)
    try {
      const res = await mergeSeriesMulti(target.id, sourceIds)
      onDone(res, target.title)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
      data-testid="series-merge-multi-dialog"
    >
      <div
        className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-strong">
          <GitMerge className="h-3.5 w-3.5 shrink-0" />
          {t('media.seriesMergeOpen')}
        </h4>

        {!confirming ? (
          /* ── 第一步：显式选「保留哪一条」 ── */
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-medium text-fg-strong">
              {t('media.seriesMergeKeepTitle')}
            </p>
            <p className="text-[10px] leading-relaxed text-muted">
              {t('media.seriesMergeKeepHint')}
            </p>
            {/* 目标列表：N≥3 时也全部列出（可滚动，不截断到看不见） */}
            <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {series.map((s) => {
                const on = s.id === targetId
                return (
                  <label
                    key={s.id}
                    data-testid="series-merge-keep-option"
                    data-series-id={s.id}
                    className={[
                      'flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5',
                      on ? 'border-accent bg-accent/5' : 'border-border-subtle/60 hover:bg-surface-2/60',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="series-merge-keep"
                      checked={on}
                      onChange={() => setTargetId(s.id)}
                      className="h-3 w-3"
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg-strong" title={s.title}>
                      {s.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {t('media.episodeCount', { n: s.episodeCount })}
                    </span>
                    {on ? (
                      <span
                        data-testid="series-merge-target-badge"
                        className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white"
                      >
                        {t('media.seriesMergeTargetBadge')}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
            {/* 将被删除的源（列出**名字**，防误删） */}
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
              <p className="text-[10px] font-medium text-destructive">
                {t('media.seriesMergeWillDelete')}
              </p>
              <ul className="mt-0.5 list-disc pl-4 text-[10px] leading-relaxed text-destructive">
                {sources.map((s) => (
                  <li key={s.id} className="truncate" title={s.title}>
                    {s.title}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          /* ── 第二步：确认（不可逆警示） ── */
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-medium text-fg-strong">
              {t('media.seriesMergeConfirmTitle')}
            </p>
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive"
              data-testid="series-merge-confirm-warn"
            >
              {t('media.seriesMergeConfirmBody', { n: sourceIds.length, target: seriesLabel(target?.title ?? '') })}
            </p>
            <p className="text-[10px] font-medium text-destructive">
              {t('media.seriesMergeWillDelete')}
            </p>
            <ul
              className="max-h-40 list-disc overflow-y-auto pl-4 text-[11px] leading-relaxed text-destructive"
              data-testid="series-merge-delete-list"
            >
              {sources.map((s) => (
                <li key={s.id} className="truncate" title={s.title}>
                  {s.title}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={onClose}
            data-testid="series-merge-multi-cancel"
          >
            {t('media.seriesMergeCancel')}
          </Button>
          {confirming ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                disabled={busy}
                onClick={() => setConfirming(false)}
                data-testid="series-merge-multi-back"
              >
                {t('media.seriesMergeBack')}
              </Button>
              <Button
                size="sm"
                className="h-8 bg-destructive px-3 text-xs text-white hover:bg-destructive/90"
                disabled={busy}
                onClick={() => void submit()}
                data-testid="series-merge-multi-confirm"
              >
                {busy ? t('media.seriesMergeBusy') : t('media.seriesMergeDone')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={!target || sourceIds.length === 0}
              onClick={() => setConfirming(true)}
              data-testid="series-merge-multi-next"
            >
              {t('media.seriesMergeNext')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
