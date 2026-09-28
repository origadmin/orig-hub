import { useEffect, useMemo, useRef, useState } from 'react'
import type { EpisodeImageMeta, MediaEpisode, MediaSeriesDetail } from '../../api/media'
import { partitionEpisodes, showSeasonHeaders } from '../../lib/episodePresentation'
import { EpisodeRow } from './EpisodeRow'
import { EpisodeExpanded } from './EpisodeExpanded'
import { EpisodePhotoGrid } from './EpisodePhotoGrid'
import { useTranslation } from '../../i18n'

/**
 * 分集序列区：**手风琴状态机** + 季分组 + 键盘可达 + 图册分组。
 *
 * 为什么不用 `<details>`：`open` 由浏览器持有，无法保证「开新的自动关旧的」，
 * 也无法与键盘焦点 / 滚动恢复联动（设计 §3.2）。
 *
 * 状态归属：展开态（`focusedEpisodeId`）归容器 `SeriesDetail`（它还要编排编辑面板、
 * 灯箱、跳条目）；本组件只持有**键盘焦点** `activeIndex`（roving tabindex），
 * 二者可以不同 —— 用 ↓ 移动焦点不该顺手展开一集。
 *
 * 键盘（设计 §7）：
 *   ↑ / ↓       移动键盘焦点（**不改变展开态**；边界不回绕）
 *   Enter/Space 展开当前焦点行
 *   Esc         有关闭就关闭展开；无展开时不处理（交给对话框 / 灯箱）
 *   a-z/0-9     typeahead：跳到下一集标题以该串开头的行
 */
export function EpisodeBoard(props: {
  detail: MediaSeriesDetail
  focusedEpisodeId: number | null
  onFocusChange: (id: number | null) => void
  onPlayEpisode: (ep: MediaEpisode) => void
  onEditEpisode: (ep: MediaEpisode | null) => void
  /**
   * 单集编辑**保存成功后**的回调：容器据此重取详情。
   *
   * 面板只负责提交，不持有一份 `detail` —— 保存后若不回容器重取，页面会继续显示
   * 旧文案（后端的改动已在库里，UI 却停在改前），正是 R2 反例「改了介绍页面不变」。
   */
  onEditSaved: () => void
  /** 正在编辑的集 id（展开态的编辑面板由容器的这个状态驱动） */
  editingEpisodeId: number | null
  onAttachImages: (ep: MediaEpisode) => void
  onRemoveEpisode: (ep: MediaEpisode) => void
  onRemoveImage: (ep: MediaEpisode, itemId: number) => void
  onMove: (ep: MediaEpisode, dir: 'up' | 'down') => void
  onRecache: (ep: MediaEpisode) => void
  onOpenImages: (ep: MediaEpisode, index: number) => void
  onSwitchSource: (ep: MediaEpisode, itemId: number) => void
  onDetachSource: (ep: MediaEpisode, itemId: number) => void
  onGotoItem: (ep: MediaEpisode) => void
  onOpenPhotoLightbox: (index: number) => void
  onError: (msg: string) => void
}) {
  const { t } = useTranslation()
  const { detail, focusedEpisodeId, onFocusChange, editingEpisodeId } = props
  const { playEps, photoEps } = useMemo(() => partitionEpisodes(detail), [detail])
  const photoOnly = photoEps.length > 0 && playEps.length === 0

  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** typeahead 缓冲：连续按键在 700ms 内累积成同一个查询串 */
  const typeaheadRef = useRef<{ q: string; at: number }>({ q: '', at: 0 })

  // 换剧集（detail.id 变化）时把键盘焦点归零，避免沿用上一部剧的下标。
  useEffect(() => {
    setActiveIndex(0)
  }, [detail.id])

  /**
   * 单层剧集（R7）的「唯一集默认展开」**不在这里做** —— 它由容器 `SeriesDetail`
   * 直接推导（`effectiveFocusedId`）。原因：子组件 effect 先于父组件执行，在这里
   * 调 `onFocusChange(唯一集)` 会被父组件紧随其后的「换剧清态」effect 覆盖回
   * `null`，单集剧集永远展不开。
   */

  const labelOf = (ep: MediaEpisode): string =>
    (ep.title ?? '').trim() || `#${ep.itemId}`

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (playEps.length === 0) return
    const clamp = (i: number) => Math.max(0, Math.min(playEps.length - 1, i))
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // 边界不回绕：回绕会让「跳到第一集」变成误操作（设计 §7）
      setActiveIndex((i) => clamp(i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => clamp(i - 1))
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (document.activeElement === listRef.current) return
      e.preventDefault()
      const ep = playEps[activeIndex]
      if (ep) onFocusChange(focusedEpisodeId === ep.id ? null : ep.id)
      return
    }
    if (e.key === 'Escape') {
      // 有展开才处理；无展开时不 preventDefault，交给对话框 / 灯箱
      if (focusedEpisodeId != null) {
        e.preventDefault()
        onFocusChange(null)
      }
      return
    }
    // typeahead：单字符按键累积成查询串，跳到下一集以它开头的行
    if (/^[\w\u4e00-\u9fff]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now()
      const prev = typeaheadRef.current
      const q = (now - prev.at < 700 ? prev.q + e.key : e.key).toLowerCase()
      typeaheadRef.current = { q, at: now }
      const hit = playEps.findIndex((ep, i) => i > activeIndex && labelOf(ep).toLowerCase().startsWith(q))
      const from = hit >= 0 ? hit : playEps.findIndex((ep) => labelOf(ep).toLowerCase().startsWith(q))
      if (from >= 0) {
        setActiveIndex(from)
        listRef.current?.querySelector<HTMLElement>(`[data-testid="episode-row-${playEps[from].id}"]`)?.focus()
      }
    }
  }

  // 空态：既没有可播也没有图片
  if (playEps.length === 0 && photoEps.length === 0) {
    return (
      <p className="py-10 text-center text-xs text-muted" data-testid="episode-board">
        {t('media.episode.empty')}
      </p>
    )
  }

  /** 季分组（季号升序）。门控统一走 `showSeasonHeaders`，不散写三元（设计 §3.2）。 */
  const seasons = new Map<number, MediaEpisode[]>()
  for (const ep of playEps) {
    const bucket = seasons.get(ep.season)
    if (bucket) bucket.push(ep)
    else seasons.set(ep.season, [ep])
  }
  const seasonList = [...seasons.entries()].sort((a, b) => a[0] - b[0])
  const withHeaders = showSeasonHeaders(detail)

  const renderRow = (ep: MediaEpisode) => {
    const expanded = focusedEpisodeId === ep.id
    const matchIdx = playEps.indexOf(ep)
    return (
      <div key={ep.id} className="flex flex-col">
        <EpisodeRow
          ep={ep}
          series={detail}
          expanded={expanded}
          keyboardFocused={activeIndex === matchIdx}
          label={labelOf(ep)}
          onToggle={() => onFocusChange(expanded ? null : ep.id)}
          onPlay={() => props.onPlayEpisode(ep)}
          onEdit={() => {
            onFocusChange(ep.id)
            props.onEditEpisode(ep)
          }}
          onOpenImages={(_img: EpisodeImageMeta, index: number) => props.onOpenImages(ep, index)}
          onRecache={() => props.onRecache(ep)}
        />
        {/* 展开态渲染在**行的下方**（不是另开一列），块序由 EpisodeExpanded 写死 */}
        {expanded ? (
          <div className="mt-1 mb-3 rounded-md border border-border-subtle/60 bg-surface-2/30 p-3">
            <EpisodeExpanded
              ep={ep}
              series={detail}
              editing={editingEpisodeId === ep.id}
              onEdit={() => props.onEditEpisode(ep)}
              onEditClose={() => props.onEditEpisode(null)}
              onEditSaved={() => {
                props.onEditEpisode(null)
                props.onEditSaved()
              }}
              onAttachImages={() => props.onAttachImages(ep)}
              onRemoveImage={(itemId) => props.onRemoveImage(ep, itemId)}
              onMove={(dir) => props.onMove(ep, dir)}
              onRemove={() => props.onRemoveEpisode(ep)}
              onPlay={() => props.onPlayEpisode(ep)}
              onSwitchSource={(itemId) => props.onSwitchSource(ep, itemId)}
              onDetachSource={(itemId) => props.onDetachSource(ep, itemId)}
              onRecache={() => props.onRecache(ep)}
              onGotoItem={() => props.onGotoItem(ep)}
              onOpenLightbox={(index) => props.onOpenImages(ep, index)}
              onError={props.onError}
            />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      onKeyDown={onKeyDown}
      data-testid="episode-board"
      className="flex flex-col gap-3"
    >
      {photoOnly ? (
        /* photo-only / album：宫格形态（无集号行、无播放入口、无展开态） */
        <section>
          <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">
            {t('media.gallery.section', { n: photoEps.length })}
          </h4>
          <EpisodePhotoGrid
            eps={photoEps}
            onOpenLightbox={props.onOpenPhotoLightbox}
            onRemoveEpisode={props.onRemoveEpisode}
          />
        </section>
      ) : (
        <>
          {withHeaders
            ? seasonList.map(([season, eps]) => (
                <section key={season}>
                  <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">
                    {t('media.episode.seasonGroup', { n: season })}
                  </h4>
                  <div className="flex flex-col">{eps.map(renderRow)}</div>
                </section>
              ))
            : seasonList.map(([season, eps]) => (
                <div key={season} className="flex flex-col">
                  {eps.map(renderRow)}
                </div>
              ))}
          {/* 无可播内容时的空态 */}
          {playEps.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">{t('media.episode.noPlayable')}</p>
          ) : null}
          {/* 混合剧集：photo 分集以「图册 · N」小标题 + 宫格出现在**单集层末尾**
              （仍属单集层，不是全剧层横滚行） */}
          {photoEps.length > 0 ? (
            <section>
              <h4 className="mb-2 text-[12px] font-semibold text-fg-strong">
                {t('media.gallery.section', { n: photoEps.length })}
              </h4>
              <EpisodePhotoGrid
                eps={photoEps}
                onOpenLightbox={props.onOpenPhotoLightbox}
                onRemoveEpisode={props.onRemoveEpisode}
              />
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
