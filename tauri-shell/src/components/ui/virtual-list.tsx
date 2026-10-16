import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * 窗口化列表（BUG-316 段②：长列表全量同步渲染 ⇒ longtask 收敛）。
 *
 * ## 为什么需要
 * 下载域入库组行（实测 104 行 × ~108px）与文件域 cat-all 行（实测 671 行 × 34px）
 * 都是**全量同步渲染**：一次渲染上千节点，主线程一次 longtask 200ms+，导航切换
 * 直接卡住。窗口化只渲染视口 ± overscan 的行，上下用等高 spacer 占位。
 *
 * ## 动态行高
 * 行高不统一（入库行折叠 108px / 展开 432px；文件行 34px 但换行会变），故不用
 * 定高窗口，而是 **measure-and-cache**：
 *   - 每个已渲染行包一层 wrapper（`data-vl-row={index}`），高度按 `keyOf` 缓存；
 *   - 布局效应里对**新出现的行**同步量 `offsetHeight`（首帧即准，不闪）；
 *   - ResizeObserver 盯住已渲染行：展开/收起、容器缩放导致的换行变高，下一帧
 *     即收敛（CSS `transition-all` 吃不到的 auto 高度变化也照量）；
 *   - offsets 前缀和 + 二分查找可见窗口；spacer 高 = offsets 差。
 *
 * ## 不变量（验收锚点）
 *   - 容器挂 `data-total={items.length}`：脚本据此校验「渲染行数 < 总数，
 *     总数与数据源一致」—— 把窗口化拆掉（全量渲染）则渲染行数 == 总数，
 *     该断言必 FAIL（反向证伪的一半）；
 *   - 容器挂 `data-window={start:end}`：调试可读的当前窗口。
 *
 * 高度缓存按 key（不是 index）：items 重排/轮询换数组时，同一行的高度仍然有效，
 * 不会因为「新数组」整体失效重测（那会闪）。
 */

export interface VirtualListProps<T> {
  items: T[]
  /** 未量测行的预估高度（px）。取值按实测几何（见 bug316_row_geometry 探针）。 */
  estimate: number
  /** 窗口上下各多渲染的行数（快滚缓冲）。默认 8。 */
  overscan?: number
  /** 行 key：React key + 高度缓存键。同 key 的行视为同一行。 */
  keyOf: (item: T) => string | number
  renderItem: (item: T, index: number) => ReactNode
  /** 滚动容器类名（默认 `min-h-0 overflow-y-auto`）。 */
  className?: string
  /** 滚动容器 testid（脚本契约锚点）。 */
  testId?: string
  /** 行 wrapper 类名（间距等需烘进 wrapper 的效果，如 `pb-2.5`）。 */
  rowClassName?: string
}

export function VirtualList<T>({
  items,
  estimate,
  overscan = 8,
  keyOf,
  renderItem,
  className,
  testId,
  rowClassName,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  /** 实测高度缓存版本：量到新高度即 +1，驱动 offsets/窗口重算。 */
  const [heightsVersion, setHeightsVersion] = useState(0)

  /** 已观测行元素 → 行 key（ResizeObserver 回调里查 key 用）。 */
  const rowKeys = useRef(new WeakMap<Element, string | number>())
  /** 当前被 RO 观测的行元素集合（与已渲染窗口对齐，滚出即 unobserve）。 */
  const observed = useRef(new Set<Element>())
  /** 行 RO（懒创建：首帧布局效应时建；卸载/StrictMode 重挂即销毁重建）。 */
  const rowsRo = useRef<ResizeObserver | null>(null)
  /** 实测高度缓存（key → px）。未量测行回落 estimate。 */
  const heights = useRef(new Map<string | number, number>())
  /** rAF 句柄（滚动节流）。 */
  const rafId = useRef<number | null>(null)

  // ── offsets 前缀和：offsets[i] = 第 i 行顶边，offsets[n] = 总高 ──
  // keyOf 语义恒定（调用方传 item => item.id 这类），身份每渲染新建不影响结果，
  // 故不进 deps（进了反而每次渲染重算 O(n)）。
  const offsets = useMemo(() => {
    const arr = new Array<number>(items.length + 1)
    arr[0] = 0
    for (let i = 0; i < items.length; i += 1) {
      arr[i + 1] = arr[i] + (heights.current.get(keyOf(items[i])) ?? estimate)
    }
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, estimate, heightsVersion])
  const total = offsets[items.length]

  // ── 可见窗口 [start, end)：覆盖与 [scrollTop, scrollTop+viewportH] 相交的行 ──
  const { start, end } = useMemo(() => {
    const n = items.length
    if (n === 0) return { start: 0, end: 0 }
    const bottom = scrollTop + Math.max(viewportH, 1)
    // start = offsets <= scrollTop 的个数 − 1（scrollTop 所在行；不存在则为 0）
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    const s = Math.max(0, lo - 1)
    // end = offsets >= bottom 的第一行 + 1（至少含 bottom 所在行）
    let lo2 = 0
    let hi2 = n
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1
      if (offsets[mid] < bottom) lo2 = mid + 1
      else hi2 = mid
    }
    const e = Math.min(n, lo2 + 1)
    return { start: Math.max(0, s - overscan), end: Math.min(n, e + overscan) }
  }, [offsets, scrollTop, viewportH, overscan, items.length])

  // ── 行高量测（每渲染后跑；无 deps —— 新行进窗口、旧行滚出都要处理）──
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    if (!rowsRo.current) {
      rowsRo.current = new ResizeObserver((entries) => {
        let dirty = false
        for (const entry of entries) {
          const key = rowKeys.current.get(entry.target)
          if (key == null) continue
          const h = (entry.target as HTMLElement).offsetHeight
          const prev = heights.current.get(key)
          if (h > 0 && prev !== h) {
            heights.current.set(key, h)
            dirty = true
          }
        }
        if (dirty) setHeightsVersion((v) => v + 1)
      })
    }
    const ro = rowsRo.current
    const rendered = root.querySelectorAll('[data-vl-row]')
    const seen = new Set(rendered)
    // 滚出行：退观测（不留悬挂引用）
    for (const el of observed.current) {
      if (!seen.has(el)) {
        ro.unobserve(el)
        observed.current.delete(el)
        rowKeys.current.delete(el)
      }
    }
    // 新行：同步量一次（首帧即准），再交给 RO 持续盯
    let dirty = false
    for (const el of rendered) {
      const idx = Number(el.getAttribute('data-vl-row'))
      const key = keyOf(items[idx])
      const h = (el as HTMLElement).offsetHeight
      if (h > 0 && heights.current.get(key) !== h) {
        heights.current.set(key, h)
        dirty = true
      }
      if (!observed.current.has(el)) {
        observed.current.add(el)
        rowKeys.current.set(el, key)
        ro.observe(el)
      }
    }
    if (dirty) setHeightsVersion((v) => v + 1)
  })

  // ── 视口高度：容器 resize（窗口缩放/侧栏开合）时重算窗口 ──
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── 滚动：rAF 节流（每帧最多一次 setState）──
  const handleScroll = useCallback(() => {
    if (rafId.current != null) return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null
      const el = scrollRef.current
      if (el) setScrollTop(el.scrollTop)
    })
  }, [])

  // 卸载清理（StrictMode 重挂：RO 置空后下次布局效应会重建）
  useEffect(
    () => () => {
      rowsRo.current?.disconnect()
      rowsRo.current = null
      if (rafId.current != null) cancelAnimationFrame(rafId.current)
    },
    [],
  )

  const visible = items.slice(start, end)

  return (
    <div
      ref={scrollRef}
      className={className ?? 'min-h-0 overflow-y-auto'}
      data-testid={testId}
      data-total={items.length}
      data-window={items.length > 0 ? `${start}:${end}` : undefined}
      onScroll={handleScroll}
    >
      <div style={{ height: total }}>
        {start > 0 ? <div aria-hidden style={{ height: offsets[start] }} /> : null}
        {visible.map((item, i) => {
          const index = start + i
          return (
            <div key={keyOf(item)} data-vl-row={index} className={rowClassName}>
              {renderItem(item, index)}
            </div>
          )
        })}
        {end < items.length ? <div aria-hidden style={{ height: total - offsets[end] }} /> : null}
      </div>
    </div>
  )
}
