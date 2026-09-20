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
 * 2. `strained` —— 解码吞吐跟不上（高分辨率/高码率 + 倍速播放）。
 *    现象是 `readyState` 恒为 4、缓冲也充足，但 `droppedVideoFrames` 持续增长，
 *    画面丢帧/跳帧。数据供给一切正常，所以凭缓冲指标永远看不出来，
 *    用户感知就是「莫名卡」。
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
 * - **可恢复**：连续 `CALM_STREAK` 个采样点不再丢帧 -> 撤销提示（迟滞，避免闪烁）。
 * - **预热静默期**：起播 / 跳转 / 改速后 `WARMUP_MS` 内只跟基线、不判定
 *   （解码器预热与首帧填充期的丢帧不代表吞吐不足）。
 * - **事件重设基线**：暂停/跳转期间计数会累积，恢复时不能把旧账算成新丢帧。
 * - **样本量下限**：采样窗内解码帧太少（卡缓冲 / 刚起播）时不判定。
 * - 画面尺寸出现后同样撤销 `unsupported`（元数据晚到、换源后不应误报）。
 */
export type DecodeState = 'ok' | 'strained' | 'unsupported'

const SAMPLE_MS = 500
/** 连续多少个采样点丢帧才算吃力（4 × 500ms = 2s） */
const STRAIN_STREAK = 4
/** 连续多少个采样点恢复正常才撤销提示（4 × 500ms = 2s） */
const CALM_STREAK = 4
/** 丢帧速率阈值：每秒丢超过 3 帧算吃力 */
const DROP_PER_SEC = 3
/** 采样窗内解码帧少于此数时不判定（卡缓冲 / 刚起播的噪声样本） */
const MIN_SAMPLED_FRAMES = 4
/** 元数据就绪后多久仍无画面尺寸，判定为视频轨不可解 */
const NO_FRAME_MS = 3000
/** 起播 / 跳转 / 改速后的静默期：解码器预热与首帧填充 */
const WARMUP_MS = 1500
/** 这些事件上丢帧计数会跳变，必须重设基线，否则旧账会被算成新丢帧 */
const REBASE_EVENTS = ['loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'ratechange', 'play']

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

      // 情况 2：丢帧速率持续偏高 → 解码吞吐不足
      // seeking/paused 期间计数会跳变，跳过这两态避免误报
      const q = qualityOf(el)
      if (!q || el.seeking || el.paused || el.readyState < 2) return
      if (now < warmupUntil) {
        // 预热期：只跟住基线，不判定
        lastDrop = q.droppedVideoFrames
        lastTotal = q.totalVideoFrames
        return
      }
      const delta = q.droppedVideoFrames - lastDrop
      const sampled = q.totalVideoFrames - lastTotal
      lastDrop = q.droppedVideoFrames
      lastTotal = q.totalVideoFrames
      // 采样窗内几乎没解出帧（卡缓冲 / 刚起播）：样本不足以判定
      if (dt <= 0 || sampled < MIN_SAMPLED_FRAMES) return

      const severe = delta / (dt / 1000) > DROP_PER_SEC
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
