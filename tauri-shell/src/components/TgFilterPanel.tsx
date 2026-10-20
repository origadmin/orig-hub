/**
 * 文字筛选结果面板（BUG-329，用户 2026-10-19 诉求②）。
 *
 * 定位：一条筛选规则 = **一条虚拟监控频道**。用户原话「多次作为多条，不是单一过滤。
 * 一条相当于一条监控」——所以这里呈现的是一份**独立条目**的命中列表，不是「在某个
 * 频道里叠加了条件」。多条规则各自成条目、各自算命中，互不合并。
 *
 * 结果用途（同一轮裁定）：**筛出列表 + 手动勾选入库**。故本面板只做三件事——
 * 列出命中、勾选、提交入库；不自动入库、不改监控关系、不动已入库消息。
 *
 * 默认勾选口径沿用 BUG-327 的裁定：**缺字节 = 要下载的 ⇒ 默认全选**，用户只做减法。
 * 「手动勾选」指提交动作由用户触发，不是指初始零选中——零选中配灰按钮正是上一轮
 * 被投诉的形态（「选中的=要下载的，实际全部非选中」）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TgMonitorFilter, TgMonitorFilterHit } from '../types'
import { enqueueCacheTask, listTgMonitorFilterMessages, tgThumbUrl } from '../api/tg'
import { t } from '../i18n'
import { cn } from '../lib/utils'
import { fmtSize, fmtTime } from '../lib/tgmedia'
import { Button } from './ui/button'

interface Props {
  filter: TgMonitorFilter
  /** 返回内容视图 */
  onClose: () => void
  /** 入库提交成功后回调（宿主据此刷新规则命中数 / 缓存任务态） */
  onIngested?: (queued: number) => void
}

/** 条目键：`<chatId>:<messageId>`（跨频道，故不能只用 messageId） */
const keyOf = (h: TgMonitorFilterHit) => `${h.channelId}:${h.messageId}`

/** 标题兜底：caption 首行 → 文件名 → 消息号。
 *  必须带文件名这一级：大量视频消息没有 caption、只有文件名（BUG-220），
 *  少了它命中行就是一排无名条目——「筛出来了」却看不出筛到了什么。 */
function hitTitle(h: TgMonitorFilterHit): string {
  const cap = (h.caption ?? '').split('\n')[0].trim()
  if (cap) return cap
  const name = (h.fileName ?? '').trim()
  if (name) return name
  return `#${h.messageId}`
}

function typeLabel(type?: string): string {
  return type === 'photo' ? '图片' : type === 'video' ? '视频' : type === 'audio' ? '音频' : '文件'
}

/** 每页条数（BUG-330 / TGM-07 分页）：与旧版 `limit=200` 硬顶保持一致 ——
 *  首屏一页、翻页走复合游标，不再「一次拉全部 + 后端 clamp」。 */
const PAGE_SIZE = 200

export function TgFilterPanel({ filter, onClose, onIngested }: Props) {
  const [hits, setHits] = useState<TgMonitorFilterHit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 还有没有下一页（仅当上一页是满页时才可能有；短页 = 到底） */
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ingesting, setIngesting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 已展开（就地预览）的命中行（BUG-151 范式：点行 = 展开，勾选/入库是各自独立的动作） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 首屏默认全选是否已执行（翻页增量勾选不得重跑它，否则用户的减法被还原） */
  const didInitSelect = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNotice(null)
    setExpanded(new Set())
    setHits([])
    setHasMore(false)
    // 换规则 = 新工作台：默认全选态复位，等首屏到位后重来（见下方 didInitSelect）。
    didInitSelect.current = false
    void (async () => {
      try {
        const items = await listTgMonitorFilterMessages(filter.id, PAGE_SIZE)
        if (!cancelled) {
          setHits(items)
          setHasMore(items.length === PAGE_SIZE)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filter.id])

  /** 「加载更多」（TGM-07）：用当前列表最后一行的复合游标续页。
   *  游标三元组缺一不可（date 理论上恒有——定序就是 COALESCE(msg_date, created_at)；
   *  万一没有就老实停下，不拿半截游标去翻）。 */
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const last = hits[hits.length - 1]
    if (!last || last.date === undefined) {
      setHasMore(false)
      return
    }
    setLoadingMore(true)
    try {
      const items = await listTgMonitorFilterMessages(filter.id, PAGE_SIZE, {
        date: last.date,
        channelId: last.channelId,
        messageId: last.messageId,
      })
      setHits((prev) => [...prev, ...items])
      // 翻页**不重置**已选（BUG-327「用户只做减法」）：用户翻页前取消的勾选
      // 不能被「加载更多」静默还原——那等于替用户把减法加回去。新页只做
      // 增量默认勾选（缺字节 = 要下载的），老页的勾选态原样带过去。
      setSelected((prev) => {
        const next = new Set(prev)
        for (const h of items) if (!h.downloaded) next.add(keyOf(h))
        return next
      })
      setHasMore(items.length === PAGE_SIZE)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [hits, loadingMore, hasMore, filter.id])

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** 可入库 = 还没有字节。图片与视频一样可勾选、可下载入缓存（用户「选 1」裁定）：
   *  若在这里按 `type === 'photo'` 把照片整行禁掉，就会出现「第一张是图片就仿佛整个
   *  列表无法入库」的假象。图片是否进「剧集」媒体库不由本面板决定——那是**后端**
   *  `file_items_into_series` 的 kind 预切（只收 video）保证的：图片只留 `media_item`
   *  作库内内容 / 挂视频集图片位，永不占集号。 */
  const selectable = useMemo(
    () => hits.filter((h) => !h.downloaded),
    [hits],
  )

  // 默认全选可入库条目（BUG-327 裁定：选中的 = 要下载的，用户只做减法）。
  // 只在**首屏到位后执行一次**：不能随 `selectable` 变化重跑——翻页追加新页时
  // 那会把用户已取消的勾选全部还原（见 loadMore 的增量合并）。
  useEffect(() => {
    if (didInitSelect.current || loading || hits.length === 0) return
    didInitSelect.current = true
    setSelected(new Set(selectable.map(keyOf)))
  }, [loading, hits, selectable])

  const allChecked = selectable.length > 0 && selectable.every((h) => selected.has(keyOf(h)))
  const someChecked = selectable.some((h) => selected.has(keyOf(h)))
  const selectAllRef = useRef<HTMLInputElement>(null)
  // 半选只能走 DOM 属性：`<input checked>` 表达不了 indeterminate，
  // 半选与「没选」长得一模一样，用户会以为自己没勾上（BUG-327）。
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked && !allChecked
  }, [someChecked, allChecked])

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected(allChecked ? new Set() : new Set(selectable.map(keyOf)))
  }, [allChecked, selectable])

  /**
   * 提交入库：按**相册（group_id）**分组，一组一次请求（BUG-329 裁定①）。
   *
   * 之前按 `channelId` 把所有命中拍平成一个任务——同一频道里的多个相册被混成一条，
   * 相册结构丢失。现在以 `group_id` 为分组键：同一个相册的命中合并成一个带 `groupId`
   * 的缓存任务（保留相册结构），无 `group_id` 的单条自成一组。图片照常入缓存；能否
   * 成「剧集」由后端 `file_items_into_series` 的 kind 预切决定，与是否勾选无关。
   *
   * `POST /api/tg/cache/tasks` 一次只接受一个 `chatId`（`EnqueueCacheReq`），
   * 跨频道批量只能拆开——这不是本面板能绕过的。
   */
  const ingest = useCallback(async () => {
    const picked = hits.filter((h) => selected.has(keyOf(h)))
    if (picked.length === 0) {
      setNotice(t('tg.filterIngestNone'))
      return
    }
    const groups = new Map<number, { chatId: number; groupId?: number; messageIds: number[] }>()
    for (const h of picked) {
      const key = h.groupId ?? -1
      let g = groups.get(key)
      if (!g) {
        g = { chatId: h.channelId, groupId: h.groupId, messageIds: [] }
        groups.set(key, g)
      }
      g.messageIds.push(h.messageId)
    }
    setIngesting(true)
    setNotice(null)
    let queued = 0
    const failures: string[] = []
    for (const g of groups.values()) {
      try {
        const r = await enqueueCacheTask({ chatId: g.chatId, messageIds: g.messageIds, groupId: g.groupId })
        if (!r?.alreadyIngested) queued += g.messageIds.length
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e))
      }
    }
    setIngesting(false)
    if (failures.length > 0) {
      // 如实报错：不能把「有一部分没提交成功」显示成「已提交」。
      setNotice(failures[0])
      return
    }
    setNotice(queued === 0 ? t('tg.filterIngestNone') : t('tg.filterIngestDone', { n: queued }))
    onIngested?.(queued)
  }, [hits, selected, onIngested])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tg-filter-panel">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 px-2 text-[12px]"
          onClick={onClose}
          data-testid="tg-filter-back"
        >
          ← {t('tg.filterBack')}
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg-strong">
          {t('tg.filterTitle', { label: filter.label })}
        </h3>
        <span className="shrink-0 rounded-md border border-border-subtle px-2 py-0.5 text-[12px] tabular-nums text-fg-mid">
          {t('tg.filterHits', { n: hits.length })}
        </span>
      </header>

      <div className="shrink-0 border-b border-border-subtle/60 px-3 py-1.5 text-[12px] text-muted">
        {/* label≡keyword 去重（BUG-330 v3）：两者相同时副条只留匹配说明，
            不再渲染第二串与标题完全相同的关键词（用户「同一文字显示 2 串」）。 */}
        {filter.label === filter.keyword
          ? t('tg.filterMatchOn')
          : `“${filter.keyword}” · ${t('tg.filterMatchOn')}`}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="tg-filter-hits">
        {loading ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted">{t('tg.filterLoading')}</p>
        ) : error ? (
          <p className="px-2 py-6 text-center text-[13px] text-danger">{error}</p>
        ) : hits.length === 0 ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted">{t('tg.filterNoHits')}</p>
        ) : (
          hits.map((h) => {
            const k = keyOf(h)
            const checked = selected.has(k)
            const open = expanded.has(k)
            // 可勾 = 缺字节（图片同样可下载；是否进「剧集」由后端 kind 预切决定）。
            const pickable = !h.downloaded
            const thumbable = h.type === 'photo' || h.type === 'video'
            return (
              <div
                key={k}
                data-testid="tg-filter-hit"
                className={cn(
                  'rounded-md transition-colors',
                  checked ? 'bg-accent/5' : 'hover:bg-surface-2/60',
                )}
              >
                <div className="flex items-start gap-2 px-2 py-2">
                  {/* 勾选区是独立热区：点行 = 展开预览，不再整行劫持勾选 */}
                  <label
                    className={cn(
                      'flex shrink-0 cursor-pointer items-center pt-0.5',
                      !pickable && 'cursor-default',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={checked}
                      disabled={!pickable}
                      onChange={() => toggle(k)}
                      aria-label={t('tg.filterSelectRow')}
                    />
                  </label>
                  {/* 行主体 = 展开开关（BUG-151 范式：先看清这是不是我要的，
                      勾选与入库是显式动作，不是点行顺带发生） */}
                  <button
                    type="button"
                    onClick={() => toggleExpand(k)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    {open ? (
                      <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-fg-strong">{hitTitle(h)}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                        <span className="max-w-[45%] truncate">{h.channelTitle ?? '—'}</span>
                        <span>{typeLabel(h.type)}</span>
                        <span className="tabular-nums">{fmtSize(h.size)}</span>
                        <span className="tabular-nums">{fmtTime(h.date)}</span>
                        {h.downloaded ? (
                          <span className="text-success">{t('tg.downloaded')}</span>
                        ) : null}
                      </p>
                    </div>
                  </button>
                </div>
                {open ? (
                  /* 就地预览（TGM-07 / 诉求①「筛选出来的内容无法看到内容信息」）：
                     完整说明 + 文件名 + MIME + 时长 + 缩略图。播放入口留在频道
                     内容流与全局搜索（BUG-151 范式在那两处已成范式，不在这里
                     再开第三个播放入口）。 */
                  <div
                    className="mx-2 mb-2 rounded-md border border-border-subtle/60 bg-surface/40 p-2"
                    data-testid="tg-filter-hit-detail"
                  >
                    {h.caption ? (
                      <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-mid">
                        {h.caption}
                      </p>
                    ) : null}
                    {h.fileName ? (
                      <p className="mt-1 break-all text-[12px] text-muted">
                        {h.fileName}
                        {h.mimeType ? ` · ${h.mimeType}` : ''}
                      </p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
                      <span>{typeLabel(h.type)}</span>
                      <span className="tabular-nums">{fmtSize(h.size)}</span>
                      {h.duration ? (
                        <span className="tabular-nums">{t('tg.cacheCountUnit', { n: h.duration })}</span>
                      ) : null}
                      <span className="tabular-nums">{fmtTime(h.date)}</span>
                      <span className="max-w-[50%] truncate">{h.channelTitle ?? '—'}</span>
                      {h.downloaded ? (
                        <span className="text-success">{t('tg.downloaded')}</span>
                      ) : (
                        <span>{t('tg.bytesMissing')}</span>
                      )}
                    </p>
                    {thumbable ? (
                      <img
                        src={tgThumbUrl(h.channelId, h.messageId)}
                        alt={hitTitle(h)}
                        className="mt-1.5 max-h-48 rounded-md border border-border-subtle/60 object-contain"
                        loading="lazy"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
        {hasMore ? (
          <div className="px-2 py-2">
            {/* 「加载更多」（TGM-07 分页）：取代旧版一次拉全部 + 后端 clamp 500 硬顶 */}
            <Button
              variant="secondary"
              size="sm"
              className="h-9 w-full text-[13px]"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              data-testid="tg-filter-load-more"
            >
              {loadingMore ? t('tg.filterLoading') : t('tg.filterLoadMore')}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border-subtle/60 px-3 py-2">
        <div className="flex items-center gap-3">
          <label className="flex shrink-0 items-center gap-2 text-[13px] text-fg-mid">
            <input
              ref={selectAllRef}
              type="checkbox"
              data-testid="tg-filter-select-all"
              className="h-4 w-4"
              checked={allChecked}
              onChange={toggleAll}
            />
            {t('tg.filterSelectAll')}
          </label>
          <span
            className="min-w-0 flex-1 truncate text-[12px] text-muted"
            data-testid="tg-filter-selected-count"
          >
            {t('tg.filterSelected', { n: selected.size })}
          </span>
          {/* 未选中仍渲染、只禁用（BUG-327）：按钮消失比灰着更难找。 */}
          <Button
            className="h-9 shrink-0 px-4 text-[13px] font-semibold"
            onClick={() => void ingest()}
            disabled={ingesting || selected.size === 0}
            data-testid="tg-filter-ingest"
          >
            {ingesting
              ? t('tg.filterIngesting')
              : t('tg.filterIngest', { n: selected.size })}
          </Button>
        </div>
        {notice ? (
          <p className="mt-1 text-[12px] text-fg-mid" data-testid="tg-filter-notice">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  )
}
