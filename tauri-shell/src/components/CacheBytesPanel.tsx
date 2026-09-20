import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, HardDrive, Square } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'
import { fmtSize } from '../lib/tgmedia'
import { useTranslation } from '../i18n'
import { clearCacheBytes, getCacheClearPreview } from '../api/tg'
import type { CacheClearPreview } from '../api/tg'

/**
 * 缓存字节页签（BUG-059）。
 *
 * 「清除缓存文件」此前是一个**动作**：点确认就把下载目录内全部缓存字节清光，
 * 粒度只有「全清」与「逐条」两档，中间整层缺失 —— 于是最危险的档位被直接摆在一个
 * 按钮下面。这里把它改成**入口**：先看影响面（预计释放多少、涉及哪几条、多少孤儿、
 * 多少外部文件不参与），再按档或按勾选执行。
 *
 * 三条不变量：
 * - **只删缓存产出的字节**：外部文件（导入/扫描贴进来的）永不参与，面板如实标注
 *   「N 个不参与」—— 否则「清完之后占用没归零」会被当成清不干净；
 * - **不删条目**：清字节后条目回到「仅入库」态、可重新缓存；删条目属媒体库域；
 * - **预览只读**：打开面板多少次都不动磁盘，动手前一定有一次确认（确认条报出将清理
 *   几个文件、释放多少）。
 */

type ScopeKey = 'all' | 'orphan' | 'stale' | 'failed'

/** 待确认的清理：整档（`scope`）或勾选集合（`ids`），两者互斥（与后端契约一致）。 */
type Pending = { kind: 'scope'; scope: ScopeKey } | { kind: 'ids'; ids: number[] } | null

/** 陈旧档阈值（天）。写死为常量而非输入框：多一个自由输入就多一种误清刚下内容的方式。 */
const STALE_DAYS = 30

export function CacheBytesPanel(props: {
  onChanged?: () => void
  /** chatId → 频道标题。缺失时退回 `#<chatId>`，绝不把「未知」渲染成空串。 */
  chatTitleOf?: (chatId: number) => string | undefined
}) {
  const { onChanged, chatTitleOf } = props
  const { t } = useTranslation()
  const [preview, setPreview] = useState<CacheClearPreview | null>(null)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const p = await getCacheClearPreview(STALE_DAYS)
      if (!aliveRef.current) return
      setPreview(p)
      // 勾选只保留仍然存在的条目：清理后行会消失，脏勾选会让下一次「清理所选」少清几条
      // （而且界面上看不出来 —— 这是最难查的一类不一致）。
      const alive = new Set((p.items ?? []).map((x) => x.id))
      setSel((prev) => new Set([...prev].filter((id) => alive.has(id))))
      setErr('')
    } catch (e) {
      if (aliveRef.current) setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => {
      aliveRef.current = false
    }
  }, [load])

  const run = async () => {
    const p = pending
    setPending(null)
    if (!p) return
    setBusy(true)
    try {
      const res =
        p.kind === 'ids'
          ? await clearCacheBytes({ ids: p.ids })
          : p.scope === 'stale'
            ? await clearCacheBytes({ scope: 'stale', olderThanDays: STALE_DAYS })
            : await clearCacheBytes({ scope: p.scope })
      if (!aliveRef.current) return
      setMsg(
        t('tg.bytesDone', {
          n: res.removed,
          size: fmtSize(res.bytesFreed),
          skipped: res.skipped,
        }),
      )
      setSel(new Set())
      await load()
      onChanged?.()
    } catch (e) {
      if (aliveRef.current) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const items = useMemo(() => (preview?.items ?? []).filter((x) => x.inside), [preview])
  const allSelected = items.length > 0 && items.every((x) => sel.has(x.id))
  const someSelected = !allSelected && items.some((x) => sel.has(x.id))

  /**
   * 当前**勾选**的即时读数（BUG-079）。
   *
   * 与下面的 `pendingStat` 是两回事：那里是「确认条里待执行的那一批」，这里是
   * 「此刻勾了哪几条」。混用会让人在没点确认时就看到一串数字，却不知道它指的是
   * 已经发生还是将要发生 —— 数字对不上是最难查的一类不一致。
   */
  const { selCountNow, selBytesNow } = useMemo(() => {
    const picked = items.filter((x) => sel.has(x.id))
    return {
      selCountNow: picked.length,
      selBytesNow: picked.reduce((a, x) => a + x.bytes, 0),
    }
  }, [items, sel])

  const toggle = (id: number) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /**
   * 按频道聚合（只含可清理的 in-dir 条目）。
   *
   * 「只清这个频道的」是用户的原话诉求之一（BUG-059）。频道归属已经在预览明细里
   * （每条带 `chatId`），所以**不需要新端点**：整个频道的 id 集合就是一次勾选，
   * 仍旧走 `?ids=` 集合通道与同一个确认条 —— 不新增危险动词，也不新增清理半径。
   */
  const chatGroups = useMemo(() => {
    const byChat = new Map<number | null, { ids: number[]; bytes: number }>()
    for (const x of items) {
      const k = x.chatId ?? null
      const cur = byChat.get(k)
      if (cur) {
        cur.ids.push(x.id)
        cur.bytes += x.bytes
      } else {
        byChat.set(k, { ids: [x.id], bytes: x.bytes })
      }
    }
    return [...byChat.entries()]
      .map(([chatId, v]) => ({ chatId, ...v, count: v.ids.length }))
      .sort((a, b) => b.bytes - a.bytes)
  }, [items])

  /** 整频道切换勾选：全中则取消，否则补齐。 */
  const toggleChat = (ids: number[]) =>
    setSel((prev) => {
      const next = new Set(prev)
      const all = ids.every((id) => next.has(id))
      if (all) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })

  /** 确认条的目标读数：按当前目标集**现算**，不沿用上一次的统计。 */
  const pendingStat = useMemo(() => {
    if (!pending || !preview) return null
    if (pending.kind === 'scope') {
      const s =
        pending.scope === 'all'
          ? preview.total
          : pending.scope === 'orphan'
            ? preview.orphan
            : pending.scope === 'stale'
              ? preview.stale
              : preview.failed
      return { n: s.count, bytes: s.bytes }
    }
    const picked = items.filter((x) => pending.ids.includes(x.id))
    return { n: picked.length, bytes: picked.reduce((a, x) => a + x.bytes, 0) }
  }, [pending, preview, items])

  if (!preview) {
    return (
      <div
        className="flex h-24 items-center justify-center text-xs text-fg-muted"
        data-testid="cache-bytes-loading"
      >
        {t('tg.bytesPreviewing')}
      </div>
    )
  }

  const nothingToClear = preview.total.count === 0 && preview.orphan.count === 0

  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      {/* 影响面：先看清，再动手 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-surface-2/40 px-2.5 py-2 text-xs text-fg-muted">
        <HardDrive className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0" data-testid="cache-bytes-preview">
          {t('tg.bytesPreview', {
            size: fmtSize(preview.total.bytes),
            n: preview.total.count,
          })}
        </span>
        <span className="shrink-0 text-[11px]" data-testid="cache-bytes-orphan">
          · {t('tg.bytesOrphan', { n: preview.orphan.count, size: fmtSize(preview.orphan.bytes) })}
        </span>
        {preview.external.count > 0 ? (
          <span className="shrink-0 text-[11px]" data-testid="cache-bytes-external">
            · {t('tg.bytesExternal', { n: preview.external.count })}
          </span>
        ) : null}
        {selCountNow > 0 ? (
          <span
            className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent"
            data-testid="cache-bytes-selected-preview"
          >
            {t('tg.bytesSelected', { n: selCountNow, size: fmtSize(selBytesNow) })}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
        <span data-testid="cache-bytes-stale">
          {t('tg.bytesStale', {
            days: preview.olderThanDays,
            n: preview.stale.count,
            size: fmtSize(preview.stale.bytes),
          })}
        </span>
        <span data-testid="cache-bytes-failed">
          ·{' '}
          {t('tg.bytesFailed', { n: preview.failed.count, size: fmtSize(preview.failed.bytes) })}
        </span>
      </div>

      {/* 分档清理：整档是「清哪一类」，勾选是「清哪几条」，两条路互斥且都要确认 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px] text-destructive"
          disabled={busy || nothingToClear}
          onClick={() => setPending({ kind: 'scope', scope: 'all' })}
          data-testid="cache-bytes-clear-all"
        >
          {t('tg.bytesClearAll')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={busy || preview.orphan.count === 0}
          onClick={() => setPending({ kind: 'scope', scope: 'orphan' })}
          data-testid="cache-bytes-clear-orphan"
        >
          {t('tg.bytesClearOrphan')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={busy || preview.stale.count === 0}
          onClick={() => setPending({ kind: 'scope', scope: 'stale' })}
          data-testid="cache-bytes-clear-stale"
        >
          {t('tg.bytesClearStale')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={busy || preview.failed.count === 0}
          onClick={() => setPending({ kind: 'scope', scope: 'failed' })}
          data-testid="cache-bytes-clear-failed"
        >
          {t('tg.bytesClearFailed')}
        </Button>
      </div>

      {/* 按频道选定：把「只清这个频道的」从「手点 N 次」变成一次点击。
          它只是**勾选**（选择态仍走同一套确认条），不是新的清理档 —— 危险动词不增。 */}
      {chatGroups.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="cache-bytes-chats">
          <span className="text-[11px] text-fg-muted">{t('tg.bytesChatSelect')}</span>
          {chatGroups.map((g) => {
            const on = g.ids.every((id) => sel.has(id))
            // 部分选中（BUG-079）：整频道只有「全选 / 全不选」两种底色时，勾了其中几条
            // 的频道与一条没勾的频道长得一模一样 —— 「哪些已选」在视觉上不可分辨，
            // 于是用户只能逐条点开确认。这里给半选一个中间态。
            const part = !on && g.ids.some((id) => sel.has(id))
            const label =
              g.chatId == null
                ? t('tg.bytesChatNone')
                : chatTitleOf?.(g.chatId) || `#${g.chatId}`
            return (
              <button
                key={String(g.chatId)}
                type="button"
                onClick={() => toggleChat(g.ids)}
                aria-pressed={on}
                aria-label={t('tg.bytesChatGroup', { title: label, n: g.count, size: fmtSize(g.bytes) })}
                data-testid={`cache-bytes-chat-${g.chatId ?? 'none'}`}
                data-selected={on ? 'all' : part ? 'partial' : 'none'}
                title={
                  // 半选时把「已勾几条 / 共几条」写进悬浮：底色只表程度，精确值要给得出
                  part
                    ? `${t('tg.bytesChatGroup', { title: label, n: g.count, size: fmtSize(g.bytes) })}（${g.ids.filter((id) => sel.has(id)).length}/${g.count}）`
                    : t('tg.bytesChatGroup', { title: label, n: g.count, size: fmtSize(g.bytes) })
                }
                className={cn(
                  'max-w-[20rem] whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  on
                    ? 'border-accent/60 bg-accent/10 text-accent'
                    : part
                      ? 'border-accent/40 bg-accent/[0.06] text-accent/80'
                      : 'border-border-subtle text-fg-mid hover:bg-surface-2',
                )}
              >
                {t('tg.bytesChatGroup', { title: label, n: g.count, size: fmtSize(g.bytes) })}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 选择工具条 */}
      <div className="mt-2 flex items-center gap-2 rounded-md border border-border-subtle/70 bg-surface-2/25 px-2 py-1.5">
        <button
          type="button"
          onClick={() =>
            setSel((prev) => {
              const next = new Set(prev)
              if (allSelected) items.forEach((x) => next.delete(x.id))
              else items.forEach((x) => next.add(x.id))
              return next
            })
          }
          disabled={items.length === 0}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-fg-mid hover:bg-surface-2 disabled:opacity-50"
          data-testid="cache-bytes-select-all"
        >
          {allSelected ? (
            <CheckSquare className="h-3.5 w-3.5" />
          ) : (
            <Square className={cn('h-3.5 w-3.5', someSelected && 'text-accent')} />
          )}
          {t('tg.cacheSelectAll')}
        </button>
        <span className="text-[11px] text-fg-muted" data-testid="cache-bytes-selected-count">
          {t('tg.cacheSelectedCount', { n: sel.size })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-[11px]"
          disabled={busy || sel.size === 0}
          onClick={() => setPending({ kind: 'ids', ids: [...sel] })}
          data-testid="cache-bytes-clear-selected"
        >
          {t('tg.bytesClearSelected', { n: sel.size })}
        </Button>
      </div>

      {/* 确认条：单条入口与分档共用（不只是多一次点击，而是把「要清几个、释放多少」写清楚） */}
      {pending && pendingStat ? (
        <div
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
          data-testid="cache-bytes-confirm"
        >
          {t('tg.bytesConfirm', { n: pendingStat.n, size: fmtSize(pendingStat.bytes) })}
          <div className="mt-1.5 flex justify-end gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              disabled={busy}
              onClick={() => void run()}
              data-testid="cache-bytes-confirm-yes"
            >
              {t('tg.bytesConfirmYes')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setPending(null)}
              data-testid="cache-bytes-confirm-no"
            >
              {t('tg.bytesConfirmNo')}
            </Button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400" data-testid="cache-bytes-done">
          {msg}
        </p>
      ) : null}
      {err ? <p className="mt-2 text-xs text-red-500">{err}</p> : null}

      {/* 条目清单：认得出「删的是哪几条」，才能判断该不该删 */}
      <div className="mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {items.map((x) => {
          const on = sel.has(x.id)
          return (
            <div
              key={x.id}
              className={cn(
                'flex items-center gap-2 rounded-md border bg-surface-2/40 px-2.5 py-1.5',
                on ? 'border-accent/60 bg-accent/5' : 'border-border-subtle',
              )}
              data-testid="cache-bytes-row"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={t('tg.cacheSelectRow')}
                onClick={() => toggle(x.id)}
                className="shrink-0 rounded p-0.5 text-fg-mid hover:bg-surface-2"
                data-testid={`cache-bytes-check-${x.id}`}
              >
                {on ? (
                  <CheckSquare className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
              </button>
              <span className="min-w-0 flex-1 truncate text-xs text-fg-strong" title={x.title}>
                {x.title}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
                {fmtSize(x.bytes)}
              </span>
            </div>
          )
        })}
        {items.length === 0 ? (
          <div
            className="flex h-24 items-center justify-center text-xs text-fg-muted"
            data-testid="cache-bytes-empty"
          >
            {t('tg.bytesEmpty')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
