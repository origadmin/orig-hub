import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { patchMediaItem, setItemTags } from '../../api/media'
import type { MediaItem, MediaTag } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { TagPicker } from './TagManagerDialog'
import { fmtSize } from '../../lib/tgmedia'

/** 单条内容编辑：标题 + 标签（封面由卡片自动抽帧生成，也可在此预览） */
export function ItemEditDialog(props: {
  item: MediaItem
  tags: MediaTag[]
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
}) {
  const { item, tags, onClose, onSaved, onError } = props
  const [title, setTitle] = useState(item.title)
  const [selected, setSelected] = useState<number[]>(item.tags.map((t) => t.id))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setTitle(item.title)
    setSelected(item.tags.map((t) => t.id))
  }, [item.id, item.title, item.tags])

  const save = async () => {
    setBusy(true)
    try {
      if (title.trim() && title.trim() !== item.title) {
        await patchMediaItem(item.id, { title: title.trim() })
      }
      await setItemTags(item.id, selected)
      onSaved()
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
        <h4 className="text-[13px] font-semibold text-fg-strong">编辑内容</h4>

        <div className="mt-3 flex gap-3">
          <div className="h-20 w-36 shrink-0 overflow-hidden rounded-md bg-surface-2">
            {item.kind === 'photo' ? (
              <img
                src={mediaItemUrl(item.id)}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : item.poster ? (
              <img src={item.poster} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-xl text-muted">
                {item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '🎵' : '📄'}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1 text-[10.5px] text-muted">
            <p className="truncate">类型：{item.kind}</p>
            <p className="truncate">大小：{fmtSize(item.size)}</p>
            <p className="truncate" title={item.filePath ?? ''}>
              路径：{item.filePath ?? '—'}
            </p>
            {item.seriesTitle ? <p className="truncate">归属：{item.seriesTitle}</p> : null}
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <label className="block text-[11px] text-muted">标题</label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 text-xs"
            autoFocus
          />
          <label className="block text-[11px] text-muted">标签</label>
          <TagPicker tags={tags} selected={selected} onChange={setSelected} />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" className="h-8 px-3 text-xs" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
