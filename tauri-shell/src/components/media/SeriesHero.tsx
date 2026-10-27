import { useEffect, useRef, useState } from 'react'
import { Film, GitMerge, Image as ImageIcon, Pencil, Tag } from 'lucide-react'
import { Button } from '../ui/button'
import type { MediaSeriesDetail, MediaTag } from '../../api/media'
import { seriesKindLabelKey } from '../../api/media'
import { coverFit } from '../../lib/mediaSources'
import { resolveSeriesCover } from '../../lib/episodePresentation'
import { CoverImage } from './CoverImage'
import { TagToken } from './TagToken'
import { useTranslation } from '../../i18n'

/** 介绍折叠阈值：超过这个行数才给「展开 / 收起」（R4 要求介绍恒渲染、不截成单行） */
const DESC_CLAMP_PX = 64

/**
 * `SeriesHero` —— **全剧概览区**（常驻）。回答「这部剧是什么」。
 *
 * 排版选型：**方案 A 左右分栏**（`grid-cols-[320px_1fr]`），依据为真实渲染对比实测
 * （设计 §3.0）。
 *
 * 两条硬规则在这里落地：
 *   1. **海报宽高比 ≥ 16:9**（`aspect-video`，§3.1.1）—— 竖版人物封面（真实数据
 *      S101 / S80）被 `aspect-ratio < 16/9` 的横幅容器横切后只剩躯干局部。
 *      `coverFit` 已保证 photo 走 `object-contain`（不裁内容）。
 *   2. **窄屏退化到 900px**（§3.1.2）—— `< 900px` 单列堆叠且**海报保留**。
 *      原设计 `< 720px` → `hidden` 已废止：桌面壳 `tauri.conf.json` 的 `minWidth`
 *      就是 900，720 不可达；而隐藏海报等于丢掉剧集唯一的视觉标识。
 *
 * 用 `grid`（不是 flex）是刻意的：grid 项默认 `stretch`，但这里海报列有确定的
 * `aspect-video` 高度需求，故海报容器同时带 `self-start` 作双保险 —— 即使外层某天
 * 改回 flex，16:9 也不会被 `align-items:stretch` 顶掉（BUG-171 根因 2）。
 */
export function SeriesHero(props: {
  detail: MediaSeriesDetail
  tags: MediaTag[]
  onBack: () => void
  onEditSeries: () => void
  onEditTags: () => void
  onMerge: () => void
  onDelete: () => void
  onExport: () => void
  /** 点海报 → 打开封面灯箱（`media.series.coverOpen`） */
  onOpenCover: () => void
}) {
  const { t } = useTranslation()
  const { detail } = props
  const cover = resolveSeriesCover(detail)
  const descRef = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // 只在「介绍真的超阈值」时才给折叠入口 —— 短介绍挂一个「展开」是噪音。
  useEffect(() => {
    const el = descRef.current
    setOverflowing(el != null && el.scrollHeight > DESC_CLAMP_PX + 4)
  }, [detail.description])

  /**
   * 类型标签走 i18n，且**不原样透出未知枚举**（BUG-258）。
   *
   * 此前这段三分支在四个文件里各写一遍（`SeriesHero` / `SeriesCard` /
   * `SeriesDetail` / `SeriesEditPanel`），都以 `return k` 收尾 —— 四份定义必然漂移，
   * 且每份的兜底都会把一个界面无法解释的字符串显示成「合法类型」。现在统一走
   * `api/media#seriesKindLabelKey`（后端 `media::SERIES_KINDS` 对枚举外的值 422）。
   */
  const kindLabel = (k: string): string => t(seriesKindLabelKey(k))

  return (
    <section className="flex min-w-0 flex-col gap-4 border-b border-border-subtle/60 p-4" data-testid="series-hero">
      {/* 工具条：返回 + 剧集级操作。操作入口位置在任何宽度下都稳定（不挤在文字列底部） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={props.onBack}
          data-testid="series-back"
        >
          ← {t('media.series.back')}
        </Button>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/* ① 编辑（**吸收**原独立「改名」铅笔：标题/介绍/类型/年份/标签一个面板，R10） */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={props.onEditSeries}
            data-testid="series-edit"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('media.series.editMeta')}
          </Button>
          {/* ② 标签 */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={props.onEditTags}
            data-testid="series-tag-edit"
          >
            <Tag className="h-3.5 w-3.5" />
            {t('media.series.editTags')}
          </Button>
          {/* ③ 合并到…（从工具条移到 Hero，能力 #10 的迁移落位） */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={props.onMerge}
            title={t('media.series.mergeHint')}
            data-testid="series-merge"
          >
            <GitMerge className="h-3.5 w-3.5" />
            {t('media.series.merge')}
          </Button>
          {/* ④ 导出预览（能力 #21 的迁移落位）
              BUG-465：本组件**未挂载**（全仓 0 处 `<SeriesHero`），却与线上库级主操作
              `ContextBarFilesActions` 抢同一个 `media-export-preview` 契约 —— 验收脚本按
              testid 点击会指向错误元素。这里改名，保持全局唯一。 */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={props.onExport}
            data-testid="series-hero-export"
          >
            {t('media.exportPreview')}
          </Button>
          {/* ⑤ 删除剧集（带确认，由容器弹窗） */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px] text-destructive"
            onClick={props.onDelete}
            title={t('media.series.deleteHint')}
            data-testid="series-delete"
          >
            {t('media.series.delete')}
          </Button>
        </div>
      </div>

      {/*
        两列：海报 / 内容。`≥ 900px` 两列；`< 900px` 单列堆叠（海报仍保留）。
        `900px` 与桌面壳 `tauri.conf.json` 的 `minWidth` 对齐 —— 这是真实可达的最窄窗口。
      */}
      <div className="grid min-w-0 grid-cols-1 gap-6 min-[900px]:grid-cols-[320px_1fr]">
        {/* 海报块：宽高比 ≥ 16:9 + self-start（双保险，§3.1.1 / BUG-171 根因 2） */}
        <div className="min-w-0">
          <button
            type="button"
            onClick={props.onOpenCover}
            className="aspect-video w-full max-w-[320px] shrink-0 self-start overflow-hidden rounded-lg bg-surface-2"
            title={t('media.series.coverOpen')}
            data-testid="series-cover"
          >
            {cover ? (
              /* 竖版源图必须 object-contain —— 禁止「竖版图 + 横幅容器 + cover」。
                 `coverKind` 只说「能否当图片用」（video 需抽帧），不含宽高比；
                 故除 `coverFit` 外再由 `CoverImage` 按源图实际方向兜底（§3.1.1）。 */
              <CoverImage
                src={cover}
                alt={detail.title}
                fit={coverFit(detail.coverKind)}
                className="h-full w-full"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-muted">
                {detail.kind === 'album' ? (
                  <ImageIcon className="h-8 w-8" />
                ) : (
                  <Film className="h-8 w-8" />
                )}
              </span>
            )}
          </button>
        </div>

        {/* 内容列：标题 / 元信息 / 标签 / 介绍 */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* 标题 —— 剧集展示名，点击打开编辑面板（R10）。允许换行，不截成半句 */}
          <h3
            className="min-w-0 break-words [overflow-wrap:anywhere] text-[15px] font-semibold leading-snug text-fg-strong"
            data-testid="series-title"
          >
            {detail.title}
          </h3>

          {/* 元信息：「这是什么」应先于「讲什么」被读到 */}
          <p className="text-[11px] text-muted" data-testid="series-meta">
            {kindLabel(detail.kind)}
            {detail.year ? ` · ${detail.year}` : ''} ·{' '}
            {t('media.episodeCount', { n: detail.episodeCount })} ·{' '}
            {t('media.series.seasonCount', { n: detail.seasonCount })}
          </p>

          {detail.tags.length > 0 ? (
            <div className="flex flex-wrap gap-x-1.5 gap-y-0.5" data-testid="series-hero-tags">
              {detail.tags.map((tag) => (
                <TagToken key={tag.id} name={tag.name} />
              ))}
            </div>
          ) : null}

          {/*
            剧集介绍：**整页只有这一处**（R4）。
            非空恒渲染 —— **绝不用首集介绍兜底**；空就是空，给可编辑空位。
          */}
          {detail.description ? (
            <div className="flex items-start gap-1.5">
              <p
                ref={descRef}
                className="min-w-0 max-w-prose flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed text-muted"
                style={!expanded ? { maxHeight: DESC_CLAMP_PX, overflow: 'hidden' } : undefined}
                data-testid="series-description"
              >
                {detail.description}
              </p>
              <div className="flex shrink-0 flex-col items-start gap-1">
                {overflowing ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
                    data-testid="series-desc-toggle"
                  >
                    {expanded ? t('media.series.descShowLess') : t('media.series.descShowMore')}
                  </button>
                ) : null}
                {/* 编辑入口进面板（`series-desc-input` 等节点名保留，由 SeriesEditPanel 承载） */}
                <button
                  type="button"
                  onClick={props.onEditSeries}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg-mid"
                  title={t('media.editSeriesDesc')}
                  data-testid="series-desc-edit"
                >
                  <Pencil className="h-3 w-3" /> {t('media.series.editMeta')}
                </button>
              </div>
            </div>
          ) : (
            /* 介绍空态：可编辑空位（R4 判据）—— 不出现首集介绍文本 */
            <button
              type="button"
              onClick={props.onEditSeries}
              className="self-start rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-accent/10"
              data-testid="series-desc-edit"
            >
              {t('media.addSeriesDesc')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
