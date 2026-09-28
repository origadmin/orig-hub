import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { patchSeries, setSeriesTags } from '../../api/media'
import type { MediaSeriesDetail, MediaTag } from '../../api/media'
import { TagPicker } from './TagManagerDialog'
import { useTranslation } from '../../i18n'

/** 剧集类型可选项 —— 与后端 `media_series.kind` 的三个取值一一对应 */
const KINDS = ['series', 'collection', 'album'] as const

/**
 * 剧集编辑面板：`title` / `description` / `kind` / `year` / `tags` **一次提交**（R10）。
 *
 * 本面板**吸收了原来的独立「改名」铅笔**（`series-title-edit`）：改名能力没有删除，
 * 只是不再单列一个入口 —— 剧集头里「改名」类独立入口数必须为 0（R10 判据）。
 *
 * 提交分三路（都是现状已有的 API，不新增后端契约）：
 *   - `patchSeries(id, { title, description, kind, year })`
 *   - `setSeriesTags(id, ids)`
 *   - 就地新建标签由父层 `onCreateTag` 提供（建完父层刷新，返回 id 让选择器立即勾上）
 *
 * `description` 空值下发 `null`（**显式清空**，后端 `Option<Option<String>>` 契约）——
 * 否则介绍设过就永远清不掉。
 */
export function SeriesEditPanel(props: {
  series: MediaSeriesDetail
  tags: MediaTag[]
  onClose: () => void
  onSaved: () => void
  onError: (msg: string) => void
  /** 就地新建标签：返回新标签 id（与 `TagPicker.onCreate` 同契约） */
  onCreateTag: (name: string) => Promise<number | null>
}) {
  const { t } = useTranslation()
  const { series, tags, onClose, onSaved, onError, onCreateTag } = props
  const [title, setTitle] = useState(series.title)
  const [desc, setDesc] = useState(series.description ?? '')
  const [kind, setKind] = useState(series.kind)
  const [year, setYear] = useState(series.year != null ? String(series.year) : '')
  const [selected, setSelected] = useState<number[]>(series.tags.map((x) => x.id))
  const [busy, setBusy] = useState(false)

  const kindLabel = (k: string): string => {
    if (k === 'series') return t('media.series.kindSeries')
    if (k === 'collection') return t('media.series.kindCollection')
    if (k === 'album') return t('media.series.kindAlbum')
    return k
  }

  /**
   * 保存。
   *
   * 标题是列表/卡片的主标识，`NOT NULL` —— **空值前端先拦**：空标题会让剧集在墙上
   * 变成一张无法辨认的卡。前端拦下一道，避免发一次必然 422 的请求。
   * 年份是可选字段：留空 = 显式不发（后端按「不改」处理，年份本身可缺省）。
   */
  const save = async () => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      onError(t('media.series.errTitleEmpty'))
      return
    }
    const yearRaw = year.trim()
    let yearValue: number | undefined
    if (yearRaw !== '') {
      const y = Number(yearRaw)
      if (!Number.isInteger(y) || y < 0) {
        onError(t('media.series.errYear'))
        return
      }
      yearValue = y
    }
    setBusy(true)
    try {
      await patchSeries(series.id, {
        title: nextTitle,
        // 空介绍 = 显式清空（null），不是「不改」
        description: desc.trim() || null,
        kind,
        ...(yearValue !== undefined ? { year: yearValue } : {}),
      })
      await setSeriesTags(series.id, selected)
      onSaved()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border border-border-subtle bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="series-edit-panel"
      >
        <h4 className="text-[13px] font-semibold text-fg-strong">
          {t('media.series.editMeta')}
        </h4>

        <label className="flex flex-col gap-1 text-[11px] text-muted">
          <span>{t('media.series.editTitle')}</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-7 text-[13px]"
            autoFocus
            data-testid="series-title-input"
          />
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted">
          <span>{t('media.series.editDesc')}</span>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t('media.descEmptySeries')}
            aria-label={t('media.series.editDesc')}
            data-testid="series-desc-input"
            rows={4}
            className="w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[11.5px] text-fg-strong"
          />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            <span>{t('media.series.editKind')}</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label={t('media.series.editKind')}
              data-testid="series-kind-select"
              className="h-7 rounded-md border border-border-subtle bg-surface px-1.5 text-[11.5px] text-fg-strong"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            <span>{t('media.series.editYear')}</span>
            <Input
              type="number"
              min={0}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="h-7 w-24 text-[11.5px]"
              aria-label={t('media.series.editYear')}
              data-testid="series-year-input"
            />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{t('media.series.editTags')}</span>
          <TagPicker
            tags={tags}
            selected={selected}
            onChange={setSelected}
            onCreate={onCreateTag}
          />
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
            {t('media.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-7 px-3 text-[11px]"
            disabled={busy || !title.trim()}
            onClick={() => void save()}
            data-testid="series-save"
          >
            {t('media.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
