import { useMemo, useState } from 'react'

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
 */
export interface DeckFrame {
  src: string
  /** 底部渐变条文案（可选，如集号） */
  label?: string
}

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
  /** 点按卡片中央以外翻页；这里提供「翻到某帧」的回调（灯箱用） */
  onOpenFrame?: (index: number) => void
  testId?: string
}) {
  const { frames, w = 300, h = 169, maxW = 0, peek = 30, onOpenFrame, testId } = props
  const n = frames.length
  const [head, setHead] = useState(0)

  const { p, total, visible } = useMemo(() => {
    if (n === 0) return { p: 0, total: 0, visible: 0 }
    const vis = Math.min(n, 6)
    const cap = maxW > 0 ? maxW : w
    const step =
      n > 1 ? Math.max(8, Math.min(peek, Math.round((cap - w) / Math.max(1, vis - 1)))) : 0
    return { p: step, total: w + Math.max(0, vis - 1) * step, visible: vis }
  }, [n, w, maxW, peek])

  if (n === 0) return null

  const next = () => setHead((v) => (v + 1) % n)
  const prev = () => setHead((v) => (v - 1 + n) % n)

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x < r.width / 2) prev()
    else next()
  }

  return (
    <div
      className="relative cursor-pointer select-none"
      style={{ width: total, height: h, perspective: 900 }}
      onClick={onClick}
      data-testid={testId ?? 'episode-deck'}
      data-deck-count={`${head + 1} / ${n}`}
    >
      {frames.map((f, i) => {
        // 相对 head 的偏移：0 = 最前；超过可见槽数的卡全部压在队尾那条边下
        const rel = (i - head + n) % n
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
        {head + 1} / {n}
      </span>
      {onOpenFrame ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenFrame(head)
          }}
          className="absolute bottom-1.5 right-1.5 z-[99] rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white hover:bg-black/75"
          data-testid="episode-deck-open"
        >
          ⤢
        </button>
      ) : null}
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
