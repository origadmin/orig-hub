import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { createTag, deleteTag, patchTag } from '../../api/media'
import type { MediaTag } from '../../api/media'

const PALETTE = [
  '#2563eb',
  '#0891b2',
  '#16a34a',
  '#f59e0b',
  '#dc2626',
  '#7c3aed',
  '#db2777',
  '#64748b',
]

/** 标签多选器（内容/剧集共用） */
export function TagPicker(props: {
  tags: MediaTag[]
  selected: number[]
  onChange: (ids: number[]) => void
}) {
  const { tags, selected, onChange } = props
  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }
  if (tags.length === 0) {
    return <p className="py-2 text-[11px] text-muted">还没有标签，先在「标签管理」里新建</p>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => {
        const on = selected.includes(tag.id)
        return (
          <button
            key={tag.id}
            type="button"
            onClick={() => toggle(tag.id)}
            className={[
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              on ? 'text-white' : 'text-fg-strong hover:bg-surface-2',
            ].join(' ')}
            style={
              on
                ? { background: tag.color ?? '#64748b', borderColor: tag.color ?? '#64748b' }
                : { borderColor: `${tag.color ?? '#64748b'}66` }
            }
          >
            {tag.name}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 批量打标签：对选中的多条内容**覆盖式**重设标签集合。
 * 覆盖语义由后端 `set_item_tags` 保证（先清后写），界面上明确提示避免误以为追加。
 */
export function BulkTagDialog(props: {
  count: number
  tags: MediaTag[]
  onClose: () => void
  onApply: (tagIds: number[]) => Promise<void>
}) {
  const { count, tags, onClose, onApply } = props
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">为 {count} 项内容设置标签</h4>
        <p className="mt-1 text-[11px] text-muted">
          所选内容现有的标签会被<b>替换</b>为下面勾选的结果。
        </p>
        <div className="mt-3">
          <TagPicker tags={tags} selected={selected} onChange={setSelected} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onApply(selected)
                onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '应用中…' : '应用'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 标签管理：新建 / 重命名 / 改色 / 删除（删除会同时解除所有关联） */
export function TagManagerDialog(props: {
  tags: MediaTag[]
  onClose: () => void
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const { tags, onClose, onChanged, onError } = props
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PALETTE[0])
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const add = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      await createTag(name, newColor)
      setNewName('')
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (id: number) => {
    const name = editName.trim()
    if (!name) return
    setBusy(true)
    try {
      await patchTag(id, { name })
      setEditingId(null)
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const recolor = async (id: number, color: string) => {
    try {
      await patchTag(id, { color })
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (tag: MediaTag) => {
    setBusy(true)
    try {
      await deleteTag(tag.id)
      onChanged()
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
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-border-subtle bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <h4 className="text-[13px] font-semibold text-fg-strong">标签管理</h4>
          <p className="mt-0.5 text-[11px] text-muted">标签可挂在内容或剧集上，用于交叉归类检索。</p>
        </header>

        <div className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                placeholder="新标签名称"
                className="h-8 text-xs"
              />
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={busy || !newName.trim()}
              onClick={() => void add()}
            >
              新建
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setNewColor(c)}
                className={[
                  'h-4 w-4 rounded-full border-2',
                  newColor === c ? 'border-fg-strong' : 'border-transparent',
                ].join(' ')}
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {tags.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">暂无标签</p>
          ) : (
            <ul className="space-y-1">
              {tags.map((tag) => (
                <li key={tag.id} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-2/60">
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ background: tag.color ?? '#64748b' }}
                  />
                  {editingId === tag.id ? (
                    <>
                      <div className="min-w-0 flex-1">
                        <Input
                          value={editName}
                          autoFocus
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void rename(tag.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="h-7 text-xs"
                        />
                      </div>
                      <Button
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => void rename(tag.id)}
                      >
                        保存
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-strong">
                        {tag.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">
                        {tag.itemCount ?? 0} 内容 · {tag.seriesCount ?? 0} 剧集
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        {PALETTE.slice(0, 4).map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => void recolor(tag.id, c)}
                            className="h-3 w-3 rounded-full"
                            style={{ background: c }}
                            title={`改为 ${c}`}
                          />
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => {
                          setEditingId(tag.id)
                          setEditName(tag.name)
                        }}
                      >
                        重命名
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px] text-destructive"
                        onClick={() => void remove(tag)}
                      >
                        删除
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 justify-end border-t border-border-subtle/60 px-4 py-3">
          <Button size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            完成
          </Button>
        </footer>
      </div>
    </div>
  )
}
