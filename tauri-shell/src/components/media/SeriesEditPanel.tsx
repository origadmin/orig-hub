import { useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { patchSeries, setSeriesTags } from '../../api/media'
import type { MediaSeriesDetail, MediaTag } from '../../api/media'
import { TagPicker } from './TagManagerDialog'
import { useTranslation } from '../../i18n'

/**
 * 剧集编辑面板：`title` / `description` / `year` / `tags` **一次提交**（R10）。
 *
 * **BUG-258 产品裁定（kind 收敛）**：剧集类型收敛为唯一值 `series`，本面板
 * **不再渲染任何 kind 编辑控件**（此前是单选项下拉，属于无效 UI）。提交时
 * **不携带 `kind` 键**（缺省 = 后端按「不改」处理），亦无隐藏的 kind 编辑通道。
 * 引擎侧保留 `SERIES_KINDS` 枚举 422 校验与一次性迁移作为数据层防线。
 *
 * 本面板**吸收了原来的独立「改名」铅笔**（`series-title-edit`）：改名能力没有删除，
 * 只是不再单列一个入口 —— 剧集头里「改名」类独立入口数必须为 0（R10 判据）。
 *
 * 提交分三路（都是现状已有的 API，不新增后端契约）：
 *   - `patchSeries(id, { title, description, year })`
 *   - `setSeriesTags(id, ids)`
 *   - 就地新建标签由父层 `onCreateTag` 提供（建完父层刷新，返回 id 让选择器立即勾上）
 *
 * `description` 与 `year` 都是「缺省 = 不改 / `null` = 显式清空」。
 * 年份此前**只发键不发值**：字段为空时展开式把整个 `year` 键省掉，而后端
 * `Option<i64>` 把 `None` 理解为「不改」—— 于是「空」与「不改」在契约上
 * 不可区分，**填错就永远清不掉**。现在按下方的 `yearTouched` 三态下发。
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
  const [year, setYear] = useState(series.year != null ? String(series.year) : '')
  /**
   * 用户是否碰过年份输入框（BUG-258）—— 三态里的第三个状态。
   *
   * **没碰过** ⇒ 键缺省 ⇒ 后端按「不改」处理，于是「打开面板什么都不改就保存」
   * 不会误清别人填的年份；**碰过且清空** ⇒ 显式发 `null` ⇒ 真清空。
   */
  const [yearTouched, setYearTouched] = useState(false)
  const [selected, setSelected] = useState<number[]>(series.tags.map((x) => x.id))
  const [busy, setBusy] = useState(false)

  /**
   * 保存。
   *
   * 标题是列表/卡片的主标识，`NOT NULL` —— **空值前端先拦**：空标题会让剧集在墙上
   * 变成一张无法辨认的卡。前端拦下一道，避免发一次必然 422 的请求。
   */
  const save = async () => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      onError(t('media.series.errTitleEmpty'))
      return
    }
    const yearRaw = year.trim()
    let yearValue: number | null = null
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
        // BUG-258 产品裁定：不携带 kind 键（缺省 = 后端按「不改」处理）。
        // 年份三态：碰过就发（空 ⇒ null = 清空），没碰过 ⇒ 省键 = 不改。
        ...(yearTouched ? { year: yearValue } : {}),
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

        {/* BUG-258 产品裁定：不再渲染 kind 编辑控件（单选项下拉属无效 UI，直接删除而非禁用） */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            <span>{t('media.series.editYear')}</span>
            <Input
              type="number"
              min={0}
              value={year}
              // BUG-258：一旦用户碰过这个字段就置位，于是「清空输入框 + 保存」
              // 会被当作**显式清空**下发（`year: null`），而不是「省键 = 不改」。
              onChange={(e) => {
                setYear(e.target.value)
                setYearTouched(true)
              }}
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
