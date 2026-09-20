import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { patchMediaItem, setItemTags } from '../../api/media'
import type { MediaItem, MediaTag } from '../../api/media'
import { mediaItemUrl } from '../../api/media'
import { clearCacheItem } from '../../api/tg'
import { TagPicker } from './TagManagerDialog'
import { coverFit, fmtSize } from '../../lib/tgmedia'

/**
 * 单条内容编辑：**标题 + 介绍 + 标签**（封面由卡片自动抽帧生成，也可在此预览）。
 *
 * 为什么必须有「介绍」位：剧集侧一直有 `description`，条目侧此前只有标题 ——
 * 正文无处可去，只能被塞进标题里，于是同一条 TG 消息在剧集详情页标题干净、
 * 介绍完整，点开视频却是一整坨原文（用户报的「剧集正确、视频错误」）。
 * 两个字段现在同源同切法，编辑也必须成对出现，否则用户改得掉标题、改不掉正文。
 */
export function ItemEditDialog(props: {
  item: MediaItem
  tags: MediaTag[]
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
}) {
  const { item, tags, onClose, onSaved, onError } = props
  const [title, setTitle] = useState(item.title)
  const [desc, setDesc] = useState(item.description ?? '')
  const [selected, setSelected] = useState<number[]>(item.tags.map((t) => t.id))
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** 有 `filePath` 才有字节可清；没有时不显示入口（比显示后报 422 诚实）。 */
  const canClear = Boolean(item.filePath)

  useEffect(() => {
    setTitle(item.title)
    setDesc(item.description ?? '')
    setSelected(item.tags.map((t) => t.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.title, item.description, item.tags])

  const save = async () => {
    setBusy(true)
    try {
      const patch: { title?: string; description?: string | null } = {}
      const nextTitle = title.trim()
      if (nextTitle && nextTitle !== item.title) patch.title = nextTitle
      const prevDesc = (item.description ?? '').trim()
      const nextDesc = desc.trim()
      if (nextDesc !== prevDesc) {
        // 空 = 显式清空（后端 nullable 契约）；否则写入新值。
        patch.description = nextDesc || null
      }
      if (Object.keys(patch).length > 0) await patchMediaItem(item.id, patch)
      await setItemTags(item.id, selected)
      onSaved()
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doClearCache = async () => {
    setClearing(true)
    try {
      await clearCacheItem(item.id)
      setConfirmClear(false)
      onSaved()
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-lg border border-border-subtle bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        data-testid="item-edit-dialog"
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">编辑内容</h4>

        <div className="mt-3 flex gap-3">
          <div className="h-20 w-36 shrink-0 overflow-hidden rounded-md bg-surface-2">
            {item.kind === 'photo' ? (
              <img src={mediaItemUrl(item.id)} alt="" className="h-full w-full object-contain" />
            ) : item.poster ? (
              <img src={item.poster} alt="" className={`h-full w-full ${coverFit(item.kind)}`} />
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
          <label className="block text-[11px] text-muted" htmlFor="item-edit-title">
            标题
          </label>
          <Input
            id="item-edit-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 text-xs"
            autoFocus
            data-testid="item-edit-title"
          />
          <label className="block text-[11px] text-muted" htmlFor="item-edit-desc">
            介绍
            <span className="ml-1 text-[10px] text-muted/70">
              （来自原消息标题之外的部分，与剧集介绍同一字段）
            </span>
          </label>
          {/* 介绍天然是多行内容：单行 Input 会把长介绍截成一行（用户实测反馈） */}
          <textarea
            id="item-edit-desc"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="留空则清除介绍"
            rows={4}
            className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-fg-strong placeholder:text-muted"
            data-testid="item-edit-desc"
          />
          <label className="block text-[11px] text-muted">标签</label>
          <TagPicker tags={tags} selected={selected} onChange={setSelected} />
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {/*
           * 清缓存独立成行：与「取消 / 保存」并排会出现两个「取消」（确认条的取消
           * 与关对话框的取消），语义不同的同名按钮挨在一起就是误操作源头。
           */}
          <div className="flex min-w-0 items-center gap-2" data-testid="item-cache-zone">
            {!canClear ? (
              <span className="text-[10.5px] text-muted" data-testid="item-clear-cache-na">
                无已缓存文件
              </span>
            ) : confirmClear ? (
              <>
                <span
                  className="min-w-0 flex-1 truncate text-[10.5px] text-muted"
                  data-testid="item-clear-cache-confirm"
                >
                  确定清除已缓存文件？记录保留，可重新缓存
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[10.5px]"
                  disabled={clearing}
                  onClick={() => void doClearCache()}
                  data-testid="item-clear-cache-yes"
                >
                  确定
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[10.5px]"
                  onClick={() => setConfirmClear(false)}
                  data-testid="item-clear-cache-no"
                >
                  不清了
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs"
                onClick={() => setConfirmClear(true)}
                data-testid="item-clear-cache"
              >
                清除缓存文件
              </Button>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={busy}
              onClick={() => void save()}
              data-testid="item-edit-save"
            >
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
