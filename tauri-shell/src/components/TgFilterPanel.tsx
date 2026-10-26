/**
 * 文字筛选结果面板（BUG-329，用户 2026-10-19 诉求②；BUG-341 起命中按**相册组**呈现）。
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
 *
 * ## BUG-341：组是呈现与勾选的单位（用户「强调很多次」的缺陷）
 *
 * 活库实证：相册的组级 caption 只落在组内**一条**消息上（满员组 10 条仅 1 条带
 * caption）。旧链路三层都对「组」不负责——后端逐条匹配每组只现 1 行、前端平铺、
 * 入库只传 1 个 messageId ⇒ 组结构与组内内容双丢失。现在：
 *   - 后端 `filter_messages` 组内任一 member 匹配即整组入列，分页按单元（组永不跨页）；
 *   - 本面板把同一 `(channelId, groupId)` 的命中收敛成**一个相册行**（可展开看全部成员），
 *     无 group_id 的单条仍是单行；
 *   - 勾选 = **组级**（勾相册 = 整组，展开仅作预览）；提交时整组 messageIds 一次入队。
 *     组内已有字节的成员不下发（worker 侧 BUG-308 幂等兜底），只补缺的。
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

/** 消息键：`<chatId>:<messageId>`（跨频道，故不能只用 messageId） */
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

/** 每页**单元**数（BUG-341：limit 数相册/单条，不数消息——组永不被页边界切开）。
 *  旧版 200 是消息数口径；组级分页后 200 个相册一页渲染过重，取 50。 */
const PAGE_SIZE = 50

/** 呈现单元（BUG-341）：一个相册（groupId 非空）或一条单消息。 */
interface HitUnit {
  /** `g:<chatId>:<groupId>` / `m:<chatId>:<messageId>` —— 勾选与展开的唯一键 */
  key: string
  channelId: number
  /** BUG-345：string（group_id > JS 2^53，number 过 JSON 界丢精度） */
  groupId?: string
  /** 组内全部消息（单条单元 = 1 项）；顺序 = 后端返回序（组内 message_id 降序） */
  members: TgMonitorFilterHit[]
}

/** 把平铺命中收敛成单元（保序：后端保证同单元相邻，首次出现序即单元序）。 */
function groupHits(hits: TgMonitorFilterHit[]): HitUnit[] {
  const out: HitUnit[] = []
  const idx = new Map<string, HitUnit>()
  for (const h of hits) {
    const key = h.groupId != null ? `g:${h.channelId}:${h.groupId}` : `m:${h.channelId}:${h.messageId}`
    let u = idx.get(key)
    if (!u) {
      u = { key, channelId: h.channelId, groupId: h.groupId ?? undefined, members: [] }
      idx.set(key, u)
      out.push(u)
    }
    u.members.push(h)
  }
  return out
}

/** 单元标题：组内第一条带 caption 的（相册标题只落在那一条上）→ 文件名 → 相册计数。 */
function unitTitle(u: HitUnit): string {
  for (const m of u.members) {
    const cap = (m.caption ?? '').split('\n')[0].trim()
    if (cap) return cap
  }
  for (const m of u.members) {
    const name = (m.fileName ?? '').trim()
    if (name) return name
  }
  return t('tg.albumN', { n: u.members.length })
}

export function TgFilterPanel({ filter, onClose, onIngested }: Props) {
  const [hits, setHits] = useState<TgMonitorFilterHit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  /** 还有没有下一页（满一页单元才可能有；短页 = 到底） */
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 勾选态 = **单元键**集合（BUG-341：组是勾选单位） */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ingesting, setIngesting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 已展开（就地预览）的单元（BUG-151 范式：点行 = 展开，勾选/入库是各自独立的动作） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /** 首屏默认全选是否已执行（翻页增量勾选不得重跑它，否则用户的减法被还原） */
  const didInitSelect = useRef(false)
  /** 用户显式改过勾选的单元（BUG-341：翻页把同一相册的后续成员带回来时，
   *  不得把用户减掉的勾选静默还原——增量只补没被用户碰过的单元）。 */
  const touchedRef = useRef<Set<string>>(new Set())

  const units = useMemo(() => groupHits(hits), [hits])

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
    touchedRef.current = new Set()
    void (async () => {
      try {
        const items = await listTgMonitorFilterMessages(filter.id, PAGE_SIZE)
        if (!cancelled) {
          setHits(items)
          // hasMore 按**单元**数判（满页单元 ⇒ 可能有下一页）。
          setHasMore(groupHits(items).length === PAGE_SIZE)
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

  /** 「加载更多」（BUG-341 单元级分页）：游标仍取当前列表最后一行的复合三元组，
   *  后端据此解析该行所属单元并从**该单元之后**续页——组永远不会被切成两半。 */
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
      // 增量默认勾选（缺字节 = 要下载的），老页的勾选态原样带过去；
      // 且跳过用户显动过的单元（BUG-341：同相册跨页带回时不得还原）。
      const fresh = groupHits(items)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const u of fresh) {
          if (touchedRef.current.has(u.key)) continue
          if (u.members.some((m) => !m.downloaded)) next.add(u.key)
        }
        return next
      })
      // hasMore 与首屏同判据：本页满单元才可能有下一页（后端 limit 即单元数）。
      setHasMore(fresh.length === PAGE_SIZE)
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

  /** 可勾选 = 组内还有缺字节成员的单元（图片同样可下载；是否进「剧集」由后端
   *  kind 预切决定）。整组都已入库的单元不再可勾。 */
  const selectableUnits = useMemo(
    () => units.filter((u) => u.members.some((m) => !m.downloaded)),
    [units],
  )

  // 默认全选可入库单元（BUG-327 裁定：选中的 = 要下载的，用户只做减法）。
  // 只在**首屏到位后执行一次**：不能随 `units` 变化重跑——翻页追加新单元时
  // 那会把用户已取消的勾选全部还原（见 loadMore 的增量合并）。
  useEffect(() => {
    if (didInitSelect.current || loading || units.length === 0) return
    didInitSelect.current = true
    setSelected(new Set(selectableUnits.map((u) => u.key)))
  }, [loading, units, selectableUnits])

  const allChecked = selectableUnits.length > 0 && selectableUnits.every((u) => selected.has(u.key))
  const someChecked = selectableUnits.some((u) => selected.has(u.key))
  const selectAllRef = useRef<HTMLInputElement>(null)
  // 半选只能走 DOM 属性：`<input checked>` 表达不了 indeterminate，
  // 半选与「没选」长得一模一样，用户会以为自己没勾上（BUG-327）。
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked && !allChecked
  }, [someChecked, allChecked])

  const toggle = useCallback((key: string) => {
    touchedRef.current.add(key)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    for (const u of selectableUnits) touchedRef.current.add(u.key)
    setSelected(allChecked ? new Set() : new Set(selectableUnits.map((u) => u.key)))
  }, [allChecked, selectableUnits])

  /**
   * 提交入库：按**单元**一组一次请求（BUG-341；组 = 相册，即用户口径的「组数据」）。
   *
   * 之前按 `channelId` 把所有命中拍平成一个任务——同一频道里的多个相册被混成一条，
   * 相册结构丢失。现在以 `(channelId, groupId)` 为分组键：同一个相册的命中合并成
   * 一个带 `groupId` 的缓存任务（保留相册结构），无 `groupId` 的单条自成一组。
   * 图片照常入缓存；能否成「剧集」由后端 `file_items_into_series` 的 kind 预切
   * 决定，与是否勾选无关。
   *
   * 下发的 messageIds = 组内**缺字节**的成员（已有字节的不重下；worker 侧
   * BUG-308 对已登记条目幂等跳过，只补缺的）。
   *
   * `POST /api/tg/cache/tasks` 一次只接受一个 `chatId`（`EnqueueCacheReq`），
   * 跨频道批量只能拆开——这不是本面板能绕过的。
   */
  const ingest = useCallback(async () => {
    const picked = units.filter((u) => selected.has(u.key))
    if (picked.length === 0) {
      setNotice(t('tg.filterIngestNone'))
      return
    }
    setIngesting(true)
    setNotice(null)
    let queued = 0
    const failures: string[] = []
    for (const u of picked) {
      // 组 = 入库单位：整组缺字节成员一次入队（不是「匹配到的那一条」）。
      const ids = u.members.filter((m) => !m.downloaded).map((m) => m.messageId)
      if (ids.length === 0) continue
      try {
        const r = await enqueueCacheTask({
          chatId: u.channelId,
          messageIds: ids,
          groupId: u.groupId,
          // BUG-436 补强：筛选入库时把用户打的筛选文字作为标题兜底传下去
          // （引擎在 caption / 组内共用 caption 都缺时用作标题）。
          titleHint: filter.keyword || filter.label,
        })
        if (!r?.alreadyIngested) queued += ids.length
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
  }, [units, selected, onIngested])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tg-filter-panel">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onClose}
          data-testid="tg-filter-back"
        >
          ← {t('tg.filterBack')}
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg-strong">
          {t('tg.filterTitle', { label: filter.label })}
        </h3>
        <span className="shrink-0 rounded-md border border-border-subtle px-2 py-0.5 text-[12px] tabular-nums text-fg-mid">
          {t('tg.filterHits', { n: units.length })}
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
        ) : units.length === 0 ? (
          <p className="px-2 py-6 text-center text-[13px] text-muted">{t('tg.filterNoHits')}</p>
        ) : (
          units.map((u) => {
            const k = u.key
            const checked = selected.has(k)
            const open = expanded.has(k)
            const isAlbum = u.groupId != null
            // 可勾 = 组内还有缺字节成员（整组已入库的不可勾）。
            const pickable = u.members.some((m) => !m.downloaded)
            const newest = u.members.reduce<TgMonitorFilterHit | null>(
              (acc, m) => (acc == null || (m.date ?? 0) > (acc.date ?? 0) ? m : acc),
              null,
            )
            const totalSize = u.members.reduce((sum, m) => sum + (m.size ?? 0), 0)
            return (
              <div
                key={k}
                data-testid={isAlbum ? 'tg-filter-group' : 'tg-filter-hit'}
                className={cn(
                  'rounded-md transition-colors',
                  checked ? 'bg-accent/5' : 'hover:bg-surface-2/60',
                )}
              >
                <div className="flex items-start gap-2 px-2 py-2">
                  {/* 勾选区是独立热区：点行 = 展开预览，不再整行劫持勾选。
                      BUG-341：勾选 = **组级**——勾相册即整组，展开仅作预览。 */}
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
                      <p className="truncate text-[13px] font-medium text-fg-strong">
                        {unitTitle(u)}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                        {/* BUG-340：channelTitle 缺失 = 不渲染该段，不渲染 `—` 占位
                            （用户「从来没有需要显示(-)的要求」）。 */}
                        {u.members[0]?.channelTitle ? (
                          <span className="max-w-[45%] truncate">{u.members[0].channelTitle}</span>
                        ) : null}
                        {isAlbum ? (
                          <span className="font-medium text-accent">
                            {t('tg.albumN', { n: u.members.length })}
                          </span>
                        ) : (
                          <span>{typeLabel(u.members[0]?.type)}</span>
                        )}
                        {totalSize > 0 ? (
                          <span className="tabular-nums">{fmtSize(totalSize)}</span>
                        ) : null}
                        {newest?.date != null ? (
                          <span className="tabular-nums">{fmtTime(newest.date)}</span>
                        ) : null}
                        {!pickable ? (
                          <span className="text-success">{t('tg.downloaded')}</span>
                        ) : null}
                      </p>
                    </div>
                  </button>
                </div>
                {open ? (
                  isAlbum ? (
                    /* 相册展开 = 组内全部成员（BUG-341「必须显示组数据」：
                        成员行供预览核对，勾选在组行上，不拆成逐条可勾——
                        组是入库单位，逐条勾选会把「组数据」又变回单条语义）。 */
                    <div
                      className="mx-2 mb-2 rounded-md border border-border-subtle/60 bg-surface/40 p-2"
                      data-testid="tg-filter-members"
                    >
                      {u.members.map((m) => {
                        const thumbable = m.type === 'photo' || m.type === 'video'
                        return (
                          <div
                            key={keyOf(m)}
                            data-testid="tg-filter-member"
                            className="flex items-center gap-2 py-1"
                          >
                            {thumbable ? (
                              <img
                                src={tgThumbUrl(m.channelId, m.messageId)}
                                alt=""
                                className="h-10 w-10 shrink-0 rounded border border-border-subtle/60 object-cover"
                                loading="lazy"
                              />
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[12.5px] text-fg-strong">
                                {hitTitle(m)}
                              </p>
                              <p className="truncate text-[12px] text-muted">
                                {typeLabel(m.type)}
                                {m.size ? ` · ${fmtSize(m.size)}` : ''}
                                {m.downloaded ? ` · ${t('tg.downloaded')}` : ''}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    /* 单条就地预览（BUG-151 范式）：完整说明 + 文件名 + MIME +
                       时长 + 缩略图。播放入口留在频道内容流与全局搜索（BUG-151
                       范式在那两处已成范式，不在这里再开第三个播放入口）。 */
                    <div
                      className="mx-2 mb-2 rounded-md border border-border-subtle/60 bg-surface/40 p-2"
                      data-testid="tg-filter-hit-detail"
                    >
                      {u.members[0].caption ? (
                        <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg-mid">
                          {u.members[0].caption}
                        </p>
                      ) : null}
                      {u.members[0].fileName ? (
                        <p className="mt-1 break-all text-[12px] text-muted">
                          {u.members[0].fileName}
                          {u.members[0].mimeType ? ` · ${u.members[0].mimeType}` : ''}
                        </p>
                      ) : null}
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
                        <span>{typeLabel(u.members[0].type)}</span>
                        <span className="tabular-nums">{fmtSize(u.members[0].size)}</span>
                        {u.members[0].duration ? (
                          <span className="tabular-nums">
                            {t('tg.cacheCountUnit', { n: u.members[0].duration })}
                          </span>
                        ) : null}
                        {u.members[0].date != null ? (
                          <span className="tabular-nums">{fmtTime(u.members[0].date)}</span>
                        ) : null}
                        {u.members[0].channelTitle ? (
                          <span className="max-w-[50%] truncate">{u.members[0].channelTitle}</span>
                        ) : null}
                        {u.members[0].downloaded ? (
                          <span className="text-success">{t('tg.downloaded')}</span>
                        ) : (
                          <span>{t('tg.bytesMissing')}</span>
                        )}
                      </p>
                      {u.members[0].type === 'photo' || u.members[0].type === 'video' ? (
                        <img
                          src={tgThumbUrl(u.members[0].channelId, u.members[0].messageId)}
                          alt={hitTitle(u.members[0])}
                          className="mt-1.5 max-h-48 rounded-md border border-border-subtle/60 object-contain"
                          loading="lazy"
                        />
                      ) : null}
                    </div>
                  )
                ) : null}
              </div>
            )
          })
        )}
        {hasMore ? (
          <div className="px-2 py-2">
            {/* 「加载更多」（BUG-341 单元级分页）：整组一起翻，组不会被切成两半 */}
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
