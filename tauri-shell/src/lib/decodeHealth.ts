import { useEffect, useState } from 'react'

/**
 * 视频轨解码健康度（BUG-034）：把两类**静默失败**变成可感知状态。
 *
 * 为什么必须有它：`<video>` 最常见的两种失败都不会触发 `onError`，播放器因此无从察觉——
 *
 * 1. `unsupported` —— 容器能解析、音频能解，但视频轨编码不受支持
 *    （典型：Chromium 无 HEVC 扩展时的 `hvc1`）。
 *    现象是 `duration` 正常、`currentTime` 照走、**`onError` 从不触发**，
 *    只有 `videoWidth === 0` 且一帧都不上屏。用户面对黑屏 + 走动的控制条，
 *    app 却什么都不提示。
 *
 * 2. `strained` —— 播放管线被饿死：**时间轴推进慢于请求的倍速**（真解码 / 投递跟不上）。
 *    主判据是**有效倍速** `ΔcurrentTime / (Δt × playbackRate)`；`readyState` 恒为 4、
 *    缓冲也充足时凭这些指标都看不出来，用户感知就是「莫名卡」。
 *
 *    （BUG-212 修订：`droppedVideoFrames` 增长**不是**解码不足的信号——倍速下呈现需求
 *    = 源帧率 × 倍速，超出刷新率时按比例丢帧是物理必然，与解码能力无关；丢帧只会
 *    影响上屏、不会让 `currentTime` 变慢，因此丢帧速率**不再**单独作为 `strained` 判据，
 *    仅在 1x 且缓冲充足时作为副判据保留，见 BUG-034 原意。）
 *
 * ---
 * BUG-053 修订：**「不论卡不卡都提示解码吃力」**
 *
 * 原实现是一个**只会置位、永不撤销的闩锁**：`setState('strained')` 之后没有任何路径
 * 回到 `'ok'`，于是任何一次瞬时抖动（起播预热、拖动进度、改倍速）都会把提示**永久**
 * 钉在画面上，直到切集或关闭播放器。用户因此在 1x 流畅播放时也看到它 ——
 * 实测同一素材 1x 播放丢帧为 0 / 486 帧。更糟的是提示文案建议「调低播放速度」，
 * 而降低倍速恰恰不会清掉它，用户只会得出「这提示没用」的结论。
 *
 * 现在改为**带迟滞的实时状态**：
 *
 * - **可恢复**：连续 `CALM_STREAK` 个采样点不再判为吃力 -> 撤销提示（迟滞，避免闪烁）。
 * - **预热静默期**：起播 / 跳转 / 改速后 `WARMUP_MS` 内只跟基线、不判定
 *   （解码器预热与首帧填充期的丢帧 / 时间轴爬升不代表吞吐不足）。
 * - **事件重设基线**：暂停/跳转期间计数与时间轴会跳变，恢复时不能把旧账算成新样本。
 * - **样本量下限**：采样窗内解码帧太少（卡缓冲 / 刚起播）时不足以估计丢帧速率。
 * - 画面尺寸出现后同样撤销 `unsupported`（元数据晚到、换源后不应误报）。
 */
export type DecodeState = 'ok' | 'strained' | 'unsupported'

const SAMPLE_MS = 500
/** 连续多少个采样点判为吃力才算吃力（4 × 500ms = 2s） */
const STRAIN_STREAK = 4
/** 连续多少个采样点恢复正常才撤销提示（4 × 500ms = 2s） */
const CALM_STREAK = 4
/** 丢帧速率阈值：每秒丢超过 3 帧算吃力（**仅 1x 副判据使用**，见 BUG-212） */
const DROP_PER_SEC = 3
/** 采样窗内解码帧少于此数时不足以估计丢帧速率（卡缓冲 / 刚起播的噪声样本） */
const MIN_SAMPLED_FRAMES = 4
/**
 * 有效倍速下限（BUG-212 主判据）：采样窗内「实际时间轴推进速度 / 期望推进速度」
 * 低于此值，即判定播放管线被饿死（真解码 / 投递不足）。
 *
 * 取 0.9 而非贴着 1.0：`currentTime` 采样、`performance.now()` 计时与 500ms 定时器
 * 都有毫秒级调度抖动，健康播放时该比值实测 ≈1.0 但会在 0.97–1.0 间浮动；留 10% 余量
 * 可避免把调度抖动误判为饿死，而真饿死时该比值通常远低于 0.9，仍能稳定命中。
 */
const EFF_RATE_MIN = 0.9
/** 元数据就绪后多久仍无画面尺寸，判定为视频轨不可解 */
const NO_FRAME_MS = 3000
/** 起播 / 跳转 / 改速后的静默期：解码器预热与首帧填充 */
const WARMUP_MS = 1500
/**
 * BUG-212 已知边界（**未处理**，如实登记）：
 *
 * 现象——`waiting` / `stalled` 也走 `rebase()`，而 `rebase()` 会重设时间轴基线
 * （`lastTime`）并进入 `WARMUP_MS` 预热。若某场景下「饿死」表现为 `waiting` / `stalled`
 * 的高频间歇（相邻 stall 间隔 < `WARMUP_MS`），则每次 stall 都会重置有效倍速基线并重新
 * 预热 ⇒ 主判据可能长期凑不满 `STRAIN_STREAK` 拍而**不报**（属**漏报**，非误报）。
 *
 * 为什么当前不触发——已实测 2x / 4x 下 `waiting` / `stalled` 均为 0（4x 丢帧 75.3% 时
 * 亦然），该路径在我们真正关心的倍速场景里根本不进入，故不会掩盖主判据。
 *
 * 为什么当前不修——修复需要把「重置丢帧基线」与「重置时间轴基线」拆开（stall 时不清
 * `lastTime`、不预热主判据），而这会触碰 BUG-166 对 `waiting` / `stalled` 重设基线的
 * 既有裁定。若将来出现「高频间歇 stall」的场景，需连同 BUG-166 一起重新裁定。
 */
/** 这些事件上丢帧计数与时间轴会跳变，必须重设基线，否则旧账会被算成新样本 */
const REBASE_EVENTS = [
  'loadedmetadata',
  'loadeddata',
  'seeking',
  'seeked',
  'ratechange',
  'play',
  // BUG-166：stall/缓冲恢复后解码器会爆发性补帧，晚到的帧被整批计为 dropped——
  // 这是「数据晚到」不是「解码慢」，恢复瞬间必须重置基线。
  'waiting',
  'stalled',
]
/**
 * 判定「解码吃力」**丢帧副判据**要求的数据供给下限（BUG-166）：缓冲领先播放位置不足
 * 此值时，丢帧是**数据晚到**（供给被同管道的其他流量抢走 / 在线流节流），不是解码吞吐
 * 不足——此时弹「调低播放速度会明显更流畅」是误导（用户实测：无可见卡顿却常驻提示）。
 *
 * BUG-212 修订：该豁免**只作用于丢帧副判据**，不再作用于「有效倍速」主判据。因为
 * `effRate < 1`（时间轴推进慢于请求倍速）本身就是「供给 / 管线跟不上」的**正面证据**，
 * 而非需要被排除的噪声；若在此处整体早退，主判据恰好在「真被饿死、缓冲自然不足」
 * 这一最该生效的场景永远无法触发。
 */
const DATA_AHEAD_MIN = 2.0

function qualityOf(el: HTMLVideoElement): VideoPlaybackQuality | null {
  return typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : null
}

export function useDecodeHealth(
  ref: React.RefObject<HTMLVideoElement | null>,
  resetKey?: string | number,
): DecodeState {
  const [state, setState] = useState<DecodeState>('ok')

  useEffect(() => {
    setState('ok')
    let stopped = false
    let bound: HTMLVideoElement | null = null
    let lastDrop = 0
    let lastTotal = 0
    let lastAt = performance.now()
    /** 上一拍的 `currentTime`，用于测「有效倍速」（BUG-212） */
    let lastTime = 0
    let strainStreak = 0
    let calmStreak = 0
    let zeroFrameSince = 0
    let warmupUntil = 0

    /** 重设基线并进入预热静默期（起播/跳转/改速/换源都会调用）。 */
    const rebase = () => {
      const el = ref.current
      if (!el) return
      const q = qualityOf(el)
      lastDrop = q ? q.droppedVideoFrames : 0
      lastTotal = q ? q.totalVideoFrames : 0
      // BUG-212：seeking 会跳变 currentTime，不重设会把跳变算成时间轴推进。
      lastTime = el.currentTime
      lastAt = performance.now()
      strainStreak = 0
      calmStreak = 0
      warmupUntil = lastAt + WARMUP_MS
    }

    const bind = (el: HTMLVideoElement) => {
      for (const ev of REBASE_EVENTS) el.addEventListener(ev, rebase)
      bound = el
    }
    const unbind = () => {
      if (!bound) return
      for (const ev of REBASE_EVENTS) bound.removeEventListener(ev, rebase)
      bound = null
    }

    const timer = window.setInterval(() => {
      if (stopped) return
      const el = ref.current
      if (!el) return
      // 元素可能在 effect 之后才挂载（或换源重建）→ 惰性绑定
      if (el !== bound) {
        unbind()
        bind(el)
        rebase()
      }
      const now = performance.now()
      const dt = now - lastAt
      lastAt = now

      // 情况 1：元数据已就绪却没有画面尺寸 → 视频轨解不出来
      if (el.readyState >= 2 && el.videoWidth === 0) {
        if (!zeroFrameSince) zeroFrameSince = now
        else if (now - zeroFrameSince > NO_FRAME_MS) setState('unsupported')
        return
      }
      // 画面尺寸出现（元数据晚到 / 换源）→ 不应停留在 unsupported
      zeroFrameSince = 0
      setState((prev) => (prev === 'unsupported' ? 'ok' : prev))

      // 情况 2：播放管线是否跟不上（时间轴推进 / 丢帧）。
      // seeking/paused 期间计数与时间轴会跳变，跳过这两态避免误报。
      const q = qualityOf(el)
      if (!q || el.seeking || el.paused || el.readyState < 2) {
        // 暂停/跳转：时间轴冻结或跳变，只跟住基线，不作为推进速度样本
        lastTime = el.currentTime
        return
      }
      if (now < warmupUntil) {
        // 预热期：只跟住基线，不判定
        lastDrop = q.droppedVideoFrames
        lastTotal = q.totalVideoFrames
        lastTime = el.currentTime
        return
      }
      const delta = q.droppedVideoFrames - lastDrop
      const sampled = q.totalVideoFrames - lastTotal
      lastDrop = q.droppedVideoFrames
      lastTotal = q.totalVideoFrames
      // 有效倍速（BUG-212 主判据）：本窗内时间轴实际推进 / 期望推进。
      // 丢帧只影响上屏、不改变 currentTime 的推进，故倍速下丢帧不会污染该比值。
      const advanced = el.currentTime - lastTime
      lastTime = el.currentTime
      if (dt <= 0) return
      const rate = el.playbackRate
      const effRate = advanced / (dt / 1000) / Math.max(rate, 0.01)

      // 主判据：管线是否被饿死（时间轴推进慢于请求倍速）。
      // 不受供给下限豁免——effRate < 1 本身就是「供给 / 管线跟不上」的正面证据。
      const effStarving = effRate < EFF_RATE_MIN

      // 数据供给下限（BUG-166）：缓冲领先不足时的丢帧是「帧晚到被弃」。
      // 该豁免**只作用于副判据**，不豁免主判据（见 DATA_AHEAD_MIN 注释）。
      const b = el.buffered
      const aheadSec = b.length ? b.end(b.length - 1) - el.currentTime : 0
      const supplyShort = aheadSec < DATA_AHEAD_MIN

      // 副判据（仅 1x，保留 BUG-034 原语义）：有足够缓冲却持续丢帧 ⇒ 确实解不动。
      // 倍速 > 1 时呈现需求 = 源帧率 × 倍速，丢帧是刷新率物理上限，不得单独触发提示。
      const dropSevere =
        rate <= 1.01 &&
        !supplyShort &&
        sampled >= MIN_SAMPLED_FRAMES &&
        delta / (dt / 1000) > DROP_PER_SEC

      const severe = effStarving || dropSevere
      if (severe) {
        strainStreak += 1
        calmStreak = 0
      } else {
        calmStreak += 1
        strainStreak = 0
      }
      if (strainStreak >= STRAIN_STREAK) setState('strained')
      else if (calmStreak >= CALM_STREAK) setState('ok')
    }, SAMPLE_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
      unbind()
    }
  }, [ref, resetKey])

  return state
}

/** 解码状态对应的 i18n key（'ok' 无需展示）。 */
export function decodeStateKey(s: DecodeState): string | null {
  if (s === 'unsupported') return 'tg.decodeUnsupported'
  if (s === 'strained') return 'tg.decodeStrained'
  return null
}
