import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * `Deck` —— 「书页右侧翻」层叠卡片（stacked deck）跑马灯。
 *
 * 规范真源：`docs/design/media-episode-image-handover-2026-09-28.md`（§2.5 / §5 v3）。
 * 用户原话判据：
 *   - 「主图跑马灯要那种折叠效果的」→ stacked deck，**书页是平的**：卡片永不 rotate，
 *     层叠只靠水平偏移 + 亮度衰减表达纵深；翻页 = 最前一张沿水平方向平移到队尾。
 *   - 「我要的只是右边的折叠效果」→ deck 只出现在详情**右栏**的单集图组位。
 *
 * 交互（v3 deck.js 一字不改地移植）：点**左半** = 上一张，点**右半** = 下一张；
 * 右上角计数 `h+1 / n` 实时更新。
 *
 * ★ 关键宽度约束（v3 踩坑记录 §5）：**总宽固定，不随帧数增长** ——
 *   `visible = min(n, 6)`，peek 由「总宽上限 − 单卡宽」反推，帧多则露边更薄但不为 0。
 *   否则 15 帧的图组会以 15×30px 撑破左邻栏。
 *
 *   BUG-429 补充：上限除了声明值 `maxW`，还要与**父容器可用宽**取小（见组件内
 *   `boxRef`/`avail`）—— `maxW` 是写死的数，而窗口最小 900 时右栏可能窄于它，
 *   只按声明值算会横向溢出。露边太薄会让后卡点不准（用户报「后面的图片不容易点击」），
 *   所以本次同时把声明值放大到 560 / peek 56，由响应式上限兜住窄窗口。
 */
export interface DeckFrame {
  src: string
  /** 底部渐变条文案（可选，如集号） */
  label?: string
}

/**
 * BUG-429：单张后卡**至少**要露出这么宽，否则点不准（用户：「后面的图片不容易点击」）。
 * 取 44px —— 与 BUG-327 的「按钮高 ≥ 36px」同一量级，留出视觉余量。
 */
const MIN_PEEK_PX = 44

/**
 * BUG-270：平铺态相邻两帧的间距（px）。
 */
const FLAT_GAP_PX = 8
/**
 * BUG-270：堆叠态**自动跑马**的节拍（ms）。用户 2026-10-10 裁定 D1「跑马 = 自动」：
 * 堆叠态必须在**无任何用户输入**时自行位移；原先只有「点左半/右半翻一张」，
 * 「跑马灯」只是名字（现象 4）。
 */
const MARQUEE_MS = 2600

export function Deck(props: {
  frames: DeckFrame[]
  /** 单卡宽（px） */
  w?: number
  /** 单卡高（px） */
  h?: number
  /** 总宽上限（px）；peek 由它反推。0 = 不设上限 */
  maxW?: number
  /** 初始露边宽度（px），会被上限约束收窄 */
  peek?: number
  /** 最多几个可见槽位（超出者叠在队尾那条边下）。默认 6（v3 原口径） */
  maxSlots?: number
  /** 点按卡片中央以外翻页；这里提供「翻到某帧」的回调（灯箱用） */
  onOpenFrame?: (index: number) => void
  testId?: string
}) {
  const {
    frames,
    w = 300,
    h = 169,
    maxW = 0,
    peek = 30,
    maxSlots = 6,
    onOpenFrame,
    testId,
  } = props
  const n = frames.length
  const [head, setHead] = useState(0)

  /**
   * BUG-429：总宽上限还要受**父容器实际可用宽**约束。
   *
   * 用户 2026-10-26：「本集图组 平铺需要再展开一点，后面的图片不容易点击」——
   * 实测竖版卡宽 170px 时后卡只露 **26px**（15%），父容器却有 830px 富余，
   * 露边太薄导致点不准。要展开就得放大 `maxW`，但 `maxW` 是写死的数：
   * 窗口最小 900 时右栏会窄于该值，写死的上限会**横向溢出**（这是既有隐患）。
   * 故这里量一次父容器宽，取 `min(maxW, 可用宽)` 作为真正的上限。
   */
  const boxRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const read = () => setAvail(Math.round(el.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { mode, p, total, visible } = useMemo(() => {
    if (n === 0) return { mode: 'stack' as const, p: 0, total: 0, visible: 0 }
    // 可用宽尚未量到（首帧）时按声明上限走，避免闪一帧 0 宽
    const declared = maxW > 0 ? maxW : w
    const cap = avail > 0 ? Math.min(declared, Math.max(w, avail)) : declared
    /*
     * BUG-270：用户原裁定 D2/D4「**够宽就一行平铺、放不下才堆叠**」——判定必须由
     * **容器可用宽**驱动（不是帧数阈值、也不是视口断点）。平铺所需宽 = n 张单卡 +
     * (n-1) 个间距；装得下就平铺（不重叠），装不下才进堆叠态。
     * 单帧（D5）单独成态：不参与层叠，整图居中、不裁剪。
     */
    if (n === 1) return { mode: 'single' as const, p: 0, total: w, visible: 1 }
    const flatW = n * w + (n - 1) * FLAT_GAP_PX
    if (cap >= flatW) return { mode: 'flat' as const, p: w + FLAT_GAP_PX, total: flatW, visible: n }
    const room = Math.max(0, cap - w)
    /*
     * BUG-429：槽位数不再写死 6 —— 实测 9 帧的图组里后 3 帧**完全叠在同一槽位**
     * （steps 里出现 3 个 0），用户「后面的图片不容易点击」有一半是这个原因。
     * 改成「按宽度预算能排几张就排几张，但每张露边不低于 MIN_PEEK_PX」：
     *   maxByStep = floor(可用宽 / MIN_PEEK_PX) + 1
     * 露边下限保证后卡始终够点，宽度上限保证不撑破容器。
     */
    const maxByStep = Math.floor(room / MIN_PEEK_PX) + 1
    const vis = Math.max(1, Math.min(n, maxSlots, maxByStep))
    const step =
      n > 1 ? Math.max(8, Math.min(peek, Math.round(room / Math.max(1, vis - 1)))) : 0
    return { mode: 'stack' as const, p: step, total: w + Math.max(0, vis - 1) * step, visible: vis }
  }, [n, w, maxW, peek, maxSlots, avail])

  /**
   * BUG-270：堆叠态的**自动跑马**（裁定 D1）。指针悬停时暂停（可选增强，
   * 不影响「无输入时自行位移」的判据）；离开恢复。
   */
  const hoverPausedRef = useRef(false)
  useEffect(() => {
    if (mode !== 'stack' || n <= 1) return
    const id = window.setInterval(() => {
      if (!hoverPausedRef.current) setHead((v) => (v + 1) % n)
    }, MARQUEE_MS)
    return () => window.clearInterval(id)
  }, [mode, n])

  if (n === 0) return null

  /** 帧序号的归一化 head（帧集合变化后 head 可能越界，取模防止负槽位）。 */
  const headAt = n > 0 ? head % n : 0

  const next = () => setHead((v) => (v + 1) % n)
  const prev = () => setHead((v) => (v - 1 + n) % n)

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x < r.width / 2) prev()
    else next()
  }

  /*
   * BUG-270：平铺态（裁定 D2「一行平铺 + 溢出横向滚动」）。装得下时全部帧同一行、
   * 不重叠；点任意一张直接开灯箱（不再有「翻页」语义 —— 全都看得见）。
   */
  if (mode === 'flat') {
    return (
      <div ref={boxRef} className="w-full min-w-0">
        <div
          className="flex flex-nowrap items-start gap-2 overflow-x-auto pb-1"
          data-testid={testId ?? 'episode-deck'}
          data-deck-mode="flat"
          data-deck-count={`${n}`}
        >
          {frames.map((f, i) => (
            <button
              key={`${f.src}-${i}`}
              type="button"
              onClick={() => onOpenFrame?.(i)}
              disabled={!onOpenFrame}
              className="relative overflow-hidden rounded-lg bg-surface-3 shadow-[0_2px_6px_rgba(16,24,40,.16),0_1px_2px_rgba(16,24,40,.1)] disabled:cursor-default"
              style={{ width: w, height: h }}
              data-testid="episode-deck-flat-tile"
              title={f.label}
            >
              <DeckImage src={f.src} alt="" />
              {f.label ? (
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3 font-mono text-[10.5px] text-white">
                  {f.label}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  /*
   * BUG-270：单帧（裁定 D5）—— 不裁剪（整图按原始宽高比缩放）、容器内居中、
   * 不出现 `1 / 1` 层叠计数。开灯箱能力保留（点图 / ⤢ 均可）。
   */
  if (mode === 'single') {
    const f = frames[0]
    return (
      <div ref={boxRef} className="w-full min-w-0">
        <div
          className="relative flex justify-center"
          data-testid={testId ?? 'episode-deck'}
          data-deck-mode="single"
        >
          <img
            src={f.src}
            alt=""
            loading="lazy"
            draggable={false}
            onClick={() => onOpenFrame?.(0)}
            className={onOpenFrame ? 'max-w-full cursor-zoom-in rounded-lg' : 'max-w-full rounded-lg'}
            style={{ width: w, height: 'auto' }}
          />
          {onOpenFrame ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpenFrame(0)
              }}
              className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white hover:bg-black/75"
              data-testid="episode-deck-open"
            >
              ⤢
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    /* BUG-429：量的是**外层可用宽**（`w-full`，与父容器同宽）。
       绝不能把 ref 挂到下面那个 width=total 的盒子上 —— 那会自己量自己，
       total 变化 → 可用宽变化 → total 再变，形成抖动回路。 */
    <div ref={boxRef} className="w-full min-w-0">
      <div
        className="relative cursor-pointer select-none"
        style={{ width: total, height: h, perspective: 900 }}
        onClick={onClick}
        onMouseEnter={() => {
          hoverPausedRef.current = true
        }}
        onMouseLeave={() => {
          hoverPausedRef.current = false
        }}
        data-testid={testId ?? 'episode-deck'}
        data-deck-mode="stack"
        data-deck-count={`${headAt + 1} / ${n}`}
      >
      {frames.map((f, i) => {
        // 相对 head 的偏移：0 = 最前；超过可见槽数的卡全部压在队尾那条边下
        const rel = (i - headAt + n) % n
        const slot = Math.min(rel, visible - 1)
        return (
          <div
            key={`${f.src}-${i}`}
            className="absolute top-0 overflow-hidden rounded-lg bg-surface-3 shadow-[0_2px_6px_rgba(16,24,40,.16),0_1px_2px_rgba(16,24,40,.1)]"
            style={{
              left: slot * p,
              zIndex: Math.max(1, n - rel),
              width: w,
              height: h,
              transition: 'left .42s cubic-bezier(.22,.7,.3,1)',
              filter: rel === 0 ? 'none' : `brightness(${1 - Math.min(rel, 3) * 0.06})`,
            }}
          >
            <DeckImage src={f.src} alt="" />
            {f.label ? (
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3 font-mono text-[10.5px] text-white">
                {f.label}
              </span>
            ) : null}
          </div>
        )
      })}
      <span
        className="absolute right-1.5 top-1.5 z-[99] rounded bg-black/60 px-1.5 py-px font-mono text-[9.5px] text-white"
        data-testid="episode-deck-count"
      >
        {headAt + 1} / {n}
      </span>
      {onOpenFrame ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenFrame(headAt)
          }}
          className="absolute bottom-1.5 right-1.5 z-[99] rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white hover:bg-black/75"
          data-testid="episode-deck-open"
        >
          ⤢
        </button>
      ) : null}
      </div>
    </div>
  )
}

/**
 * 单卡图片：**竖图 contain / 横图 cover** 互斥（交接文档 §3 ——
 * 「任何固定单向框形必伤一半」：真实库竖 8 / 横 46）。
 * 方向由源图实际尺寸判定（onLoad），与 CoverImage 同一兜底思想。
 */
function DeckImage(props: { src: string; alt?: string }) {
  const [portrait, setPortrait] = useState(false)
  return (
    <img
      src={props.src}
      alt={props.alt ?? ''}
      loading="lazy"
      draggable={false}
      onLoad={(e) => {
        const img = e.currentTarget
        setPortrait(img.naturalHeight > img.naturalWidth)
      }}
      className={`h-full w-full ${portrait ? 'object-contain' : 'object-cover'}`}
      style={portrait ? { background: '#0f1115' } : undefined}
    />
  )
}
