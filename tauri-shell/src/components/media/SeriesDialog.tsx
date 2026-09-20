import { useState } from 'react'
import { GitMerge } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { appendEpisodes, createSeries, mergeSeries } from '../../api/media'
import type { MediaSeries, MergeResult } from '../../api/media'

const KIND_OPTIONS = [
  { value: 'series', label: '剧集', hint: '有季/集编号的连续内容（如番剧、课程）' },
  { value: 'collection', label: '合集', hint: '同一主题的松散聚合（如同类视频合辑）' },
  { value: 'album', label: '图集', hint: '以图片为主的相册' },
]

/** 新建剧集 */
export function CreateSeriesDialog(props: {
  onClose: () => void
  onCreated: (id: number, title: string) => void
  onError: (msg: string) => void
}) {
  const { onClose, onCreated, onError } = props
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState('series')
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
        kind: kind as 'series' | 'collection' | 'album',
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
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">新建剧集 / 合集</h4>
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
          <div className="space-y-1 pt-1">
            {KIND_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={[
                  'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5',
                  kind === o.value
                    ? 'border-accent bg-accent/5'
                    : 'border-border-subtle/60 hover:bg-surface-2/60',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="series-kind"
                  checked={kind === o.value}
                  onChange={() => setKind(o.value)}
                  className="mt-0.5 h-3 w-3"
                />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-fg-strong">{o.label}</span>
                  <span className="block text-[10px] text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
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
          合并剧集
        </h4>
        <p className="mt-1 text-[11px] text-muted">
          把另一个剧集的内容并入
          <span className="font-medium text-fg-strong">《{target.title}》</span>（
          {target.episodeCount} 集），源剧集随后被删除。
        </p>

        {candidates.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">没有其他剧集可供合并</p>
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
                  {s.title}（{s.episodeCount} 集）
                </option>
              ))}
            </select>
            <p className="text-[10px] leading-relaxed text-muted">
              内容按原有顺序接到目标各季末尾并重新编号；已在目标里的同一条目不会重复加入。
              文件名相同但内容不同的条目、同一内容的不同来源，都会原样保留 ——
              本功能不做内容合并判断。
            </p>
            <p className="text-[10px] leading-relaxed text-muted">
              集号规则：目标各季从
              <span className="font-medium text-fg-mid">现有最大集号往后</span>
              续编（不会覆盖已有编号）；并入的每一集保留「合并自《源剧集》· 原 E&lt;n&gt;」
              溯源标注，之后可在详情里改号或上下移动。两个剧集的标签会合并去重，
              不会丢也不会重复。
            </p>
            {confirming && source && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-relaxed text-destructive">
                将把《{source.title}》的 {source.episodeCount} 个分集并入《{target.title}》，
                源剧集会被删除，此操作无法撤销。
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          {confirming ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-destructive/50 px-3 text-xs text-destructive"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? '合并中…' : '确认合并'}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={sourceId === null}
              onClick={() => setConfirming(true)}
            >
              下一步
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
