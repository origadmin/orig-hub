import { useMemo, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { createTag, deleteTag, patchTag } from '../../api/media'
import type { MediaTag } from '../../api/media'
import { useTranslation } from '../../i18n'

/** 归一化查询词：允许用户输入 `#短剧`，去掉前导 `#` 再匹配 */
function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^#+/, '')
}

/**
 * 标签多选器（内容/剧集共用）—— `#名称` 文本模式。
 *
 * 两个能力是这次重做补上的：
 *   1. **可搜索**：标签会越攒越多，一整墙平铺等于没有入口（原来就是一整墙）。
 *   2. **可就地新建**：搜不到就该顺手建一个，而不是关掉对话框去「标签管理」绕一圈。
 *      `onCreate` 由父层提供（父层才知道怎么刷新自己的标签列表），本组件只负责
 *      把返回的 id 选上并立刻显形 —— 新建的标签先在本地补一份，父层刷新到位后
 *      自然被真实数据顶替，用户不会看到「选了但没有名字」的空档。
 */
export function TagPicker(props: {
  tags: MediaTag[]
  selected: number[]
  onChange: (ids: number[]) => void
  /** 就地新建：返回新标签 id；父层不提供则不显示「新建」入口 */
  onCreate?: (name: string) => Promise<number | null>
}) {
  const { tags, selected, onChange, onCreate } = props
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [created, setCreated] = useState<MediaTag[]>([])
  const [busy, setBusy] = useState(false)

  /** 父层刷新到位之前，新建的标签先在本地补一份（避免选中后查不到名字） */
  const all: MediaTag[] = useMemo(() => {
    const extra = created.filter((c) => !tags.some((t) => t.id === c.id))
    return extra.length === 0 ? tags : [...tags, ...extra]
  }, [tags, created])

  const raw = normalizeQuery(query)
  const kw = raw.toLowerCase()
  const visible = kw === '' ? all : all.filter((t) => t.name.toLowerCase().includes(kw))
  const hasExact = all.some((t) => t.name.toLowerCase() === kw)
  /** 能建才有「新建」行：查询非空、且已有标签里没有同名 */
  const canCreate = Boolean(onCreate) && raw !== '' && !hasExact

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const create = async () => {
    if (!onCreate || raw === '') return
    setBusy(true)
    try {
      const id = await onCreate(raw)
      if (id == null) return
      setCreated((prev) => [...prev, { id, name: raw }])
      if (!selected.includes(id)) onChange([...selected, id])
      setQuery('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      {/* 已选区：搜索会把列表筛窄，已选的必须始终可见（否则等于看不见自己选了什么） */}
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1" data-testid="tag-picked">
          {selected.map((id) => {
            const tag = all.find((t) => t.id === id)
            return (
              <button
                key={id}
                type="button"
                data-testid={`tag-picked-${id}`}
                onClick={() => toggle(id)}
                title={t('media.tag.clickToRemove')}
                className="inline-flex max-w-full items-baseline gap-px whitespace-nowrap rounded bg-accent/15 px-1 py-px text-[10px] text-accent transition-colors hover:bg-accent/25"
              >
                <span className="text-accent/70">#</span>
                <span className="truncate">{tag?.name ?? `#${id}`}</span>
                <span aria-hidden="true">×</span>
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        <span className="shrink-0 text-[11px] text-accent">#</span>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('media.tag.searchPlaceholder')}
          className="h-7 text-[11px]"
          data-testid="tag-picker-input"
        />
      </div>

      <div className="max-h-40 overflow-y-auto">
        {all.length === 0 ? (
          <p className="py-2 text-[11px] text-muted">{t('media.tag.pickerEmpty')}</p>
        ) : null}
        {all.length > 0 && visible.length === 0 ? (
          <p className="py-2 text-[11px] text-muted">{t('media.tag.noMatch')}</p>
        ) : null}
        <div className="flex flex-wrap gap-1">
          {visible.map((tag) => {
            const on = selected.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                data-testid={`tag-option-${tag.id}`}
                onClick={() => toggle(tag.id)}
                className={[
                  'inline-flex max-w-full items-baseline gap-px whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  on
                    ? 'bg-accent/15 text-accent ring-1 ring-accent/40'
                    : 'text-muted hover:bg-surface-2 hover:text-fg-strong',
                ].join(' ')}
              >
                <span className={on ? 'text-accent/70' : 'text-accent/80'}>#</span>
                <span className="truncate">{tag.name}</span>
              </button>
            )
          })}
        </div>
        {canCreate ? (
          <button
            type="button"
            data-testid="tag-picker-create"
            disabled={busy}
            onClick={() => void create()}
            className="mt-1 inline-flex max-w-full items-baseline gap-px rounded px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
          >
            <span className="text-accent/80">{t('media.tag.createPrefix')}</span>
            <span className="truncate">{busy ? '…' : raw}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 批量打标签：对选中的多条内容**覆盖式**重设标签集合。
 * 覆盖语义由后端 `set_item_tags` 保证（先清后写），界面上明确提示避免误以为追加。
 *
 * `scope`（BUG-214）：同一组件服务 items 与剧集墙两处。目标不同则**文案口径**不同 ——
 * 对剧集说「为 N 项内容设置标签」是把剧集当内容，用户无从判断标签落在哪一层。
 * 默认 `'items'` 保持 items 侧现状不变。
 */
export function BulkTagDialog(props: {
  count: number
  tags: MediaTag[]
  /** 批量目标：内容条目 / 剧集（决定标题与提示的文案口径） */
  scope?: 'items' | 'series'
  onClose: () => void
  onApply: (tagIds: number[]) => Promise<void>
  /** 就地新建标签（转发给 TagPicker，使批量打标签时也能顺手建一个） */
  onCreate?: (name: string) => Promise<number | null>
}) {
  const { count, tags, scope = 'items', onClose, onApply, onCreate } = props
  const { t } = useTranslation()
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const isSeries = scope === 'series'

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
          {isSeries
            ? t('media.seriesBulkTagTitle', { n: count })
            : t('media.bulkTagTitle', { n: count })}
        </h4>
        <p className="mt-1 text-[11px] text-muted">
          {isSeries ? t('media.seriesBulkTagHint') : t('media.bulkTagHint')}
        </p>
        <div className="mt-3">
          <TagPicker
            tags={tags}
            selected={selected}
            onChange={setSelected}
            onCreate={onCreate}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onClose}>
            {t('media.cancel')}
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
            {busy ? t('media.tag.applying') : t('media.tag.apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 标签管理：新建 / 重命名 / 删除（删除会同时解除所有关联） */
export function TagManagerDialog(props: {
  tags: MediaTag[]
  onClose: () => void
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const { tags, onClose, onChanged, onError } = props
  const { t } = useTranslation()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  /** 列表过滤：标签会攒到几十上百条，没有搜索就是一堵找不到的墙 */
  const [filter, setFilter] = useState('')

  const kw = normalizeQuery(filter).toLowerCase()
  const visible = kw === '' ? tags : tags.filter((t) => t.name.toLowerCase().includes(kw))

  const add = async () => {
    const name = normalizeQuery(newName)
    if (!name) return
    setBusy(true)
    try {
      await createTag(name)
      setNewName('')
      onChanged()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (id: number) => {
    const name = normalizeQuery(editName)
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
          <h4 className="text-[13px] font-semibold text-fg-strong">{t('media.manageTags')}</h4>
          <p className="mt-0.5 text-[11px] text-muted">
            {t('media.tag.description')}
          </p>
        </header>

        <div className="shrink-0 border-b border-border-subtle/60 px-4 py-3">
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <span className="shrink-0 text-xs text-accent">#</span>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                placeholder={t('media.tag.newPlaceholder')}
                className="h-8 text-xs"
                data-testid="tag-new-input"
              />
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={busy || !normalizeQuery(newName)}
              onClick={() => void add()}
              data-testid="tag-new-submit"
            >
              {t('media.tag.create')}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <div className="flex items-center gap-1 pb-2">
            <span className="shrink-0 text-[11px] text-accent">#</span>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('media.tag.search')}
              className="h-7 text-[11px]"
              data-testid="tag-manager-search"
            />
          </div>
          {visible.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">
              {tags.length === 0 ? t('media.tag.empty') : t('media.tag.noMatch')}
            </p>
          ) : (
            <ul className="space-y-1">
              {visible.map((tag) => (
                <li
                  key={tag.id}
                  data-testid={`tag-row-${tag.id}`}
                  className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-2/60"
                >
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
                        {t('media.save')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        {t('media.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      {/*
                        行内名称是 12px / 高对比，`TagToken` 的基类是 10px / muted。
                        这里不用 `TagToken` + 覆盖类名：项目的 `cn()` 只是字符串拼接
                        （不是 tailwind-merge），同名工具类谁生效由 CSS 顺序决定，
                        覆盖并不可靠 —— 故直接写同构标记（`#` + 名称，无颜色）。
                      */}
                      <span className="inline-flex min-w-0 flex-1 items-baseline gap-px text-[12px] text-fg-strong">
                        <span className="text-accent/80">#</span>
                        <span className="truncate">{tag.name}</span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">
                        {t('media.tag.usage', { n: tag.itemCount ?? 0, m: tag.seriesCount ?? 0 })}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        onClick={() => {
                          setEditingId(tag.id)
                          setEditName(tag.name)
                        }}
                      >
                        {t('media.tag.rename')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px] text-destructive"
                        onClick={() => void remove(tag)}
                      >
                        {t('media.delete')}
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
            {t('media.tag.done')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
