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
 * 判定都带持续时间门槛（连续 4 个采样点 ≈ 2 秒），避免瞬时抖动误报。
 */
export type DecodeState = 'ok' | 'strained' | 'unsupported'

const SAMPLE_MS = 500
/** 连续多少个采样点异常才上报（4 × 500ms = 2s） */
const STREAK = 4
/** 丢帧速率阈值：每秒丢超过 3 帧算吃力 */
const DROP_PER_SEC = 3
/** 元数据就绪后多久仍无画面尺寸，判定为视频轨不可解 */
const NO_FRAME_MS = 3000

export function useDecodeHealth(
  ref: React.RefObject<HTMLVideoElement | null>,
  resetKey?: string | number,
): DecodeState {
  const [state, setState] = useState<DecodeState>('ok')

  useEffect(() => {
    setState('ok')
    let stopped = false
    let lastDrop = 0
    let lastAt = performance.now()
    let severeStreak = 0
    let zeroFrameSince = 0

    const timer = window.setInterval(() => {
      if (stopped) return
      const el = ref.current
      if (!el) return
      const now = performance.now()
      const dt = now - lastAt
      lastAt = now

      // 情况 1：元数据已就绪却没有画面尺寸 → 视频轨解不出来
      if (el.readyState >= 2 && el.videoWidth === 0) {
        if (!zeroFrameSince) zeroFrameSince = now
        else if (now - zeroFrameSince > NO_FRAME_MS) setState('unsupported')
        return
      }
      zeroFrameSince = 0

      // 情况 2：丢帧速率持续偏高 → 解码吞吐不足
      // seeking/paused 期间计数会跳变，跳过这两态避免误报
      if (!el.getVideoPlaybackQuality || el.seeking || el.paused) return
      const q = el.getVideoPlaybackQuality()
      const delta = q.droppedVideoFrames - lastDrop
      lastDrop = q.droppedVideoFrames
      const severe = dt > 0 && delta / (dt / 1000) > DROP_PER_SEC
      severeStreak = severe ? severeStreak + 1 : 0
      if (severeStreak >= STREAK) setState('strained')
    }, SAMPLE_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
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
