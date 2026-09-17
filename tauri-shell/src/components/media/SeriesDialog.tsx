import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { appendEpisodes, createSeries } from '../../api/media'
import type { MediaSeries } from '../../api/media'

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
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简介（可选）"
            className="h-8 text-xs"
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
