import { useCallback, useEffect, useState } from 'react'

/**
 * 播放器偏好持久化（音量 / 静音 / 倍速 / 自动连播）。
 *
 * 为什么必须落到 localStorage 而不是各播放器自己 useState：
 * 用户在播放器里调好的音量与倍速，切到下一集、关掉再打开，都应延续。
 * 否则每次都要重调一遍，这正是「播放器不好用」的主要来源。
 *
 * 参考 orig-studio-web（EE）的同名 hook，差异：存储键换成 orighub 命名空间，
 * 且去掉 quality（orig-hub 是本地文件直投，无多档转码，不存在清晰度概念）。
 */
export interface PlayerSettings {
  volume: number
  isMuted: boolean
  playbackRate: number
  autoPlayNext: boolean
}

const STORAGE_KEY = 'orighub_player_settings'

const DEFAULTS: PlayerSettings = {
  volume: 1,
  isMuted: false,
  playbackRate: 1,
  autoPlayNext: true,
}

function readStored(): PlayerSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlayerSettings>
      // 逐字段校验：脏数据（越界音量 / 非法倍速）会让 video 元素静默不生效
      const volume =
        typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1
          ? parsed.volume
          : DEFAULTS.volume
      const playbackRate =
        typeof parsed.playbackRate === 'number' && parsed.playbackRate > 0 && parsed.playbackRate <= 4
          ? parsed.playbackRate
          : DEFAULTS.playbackRate
      return {
        volume,
        isMuted: typeof parsed.isMuted === 'boolean' ? parsed.isMuted : DEFAULTS.isMuted,
        playbackRate,
        autoPlayNext:
          typeof parsed.autoPlayNext === 'boolean' ? parsed.autoPlayNext : DEFAULTS.autoPlayNext,
      }
    }
  } catch {
    // 存储不可用 / JSON 损坏 → 用默认值，绝不影响播放
  }
  return DEFAULTS
}

export function usePlayerSettings() {
  const [settings, setSettings] = useState<PlayerSettings>(readStored)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // 隐私模式等场景写入失败：忽略，不影响本次会话
    }
  }, [settings])

  const setVolume = useCallback((volume: number) => {
    setSettings((p) => ({ ...p, volume, isMuted: volume === 0 ? true : p.isMuted }))
  }, [])

  const setIsMuted = useCallback((isMuted: boolean) => {
    setSettings((p) => ({ ...p, isMuted }))
  }, [])

  const setPlaybackRate = useCallback((playbackRate: number) => {
    setSettings((p) => ({ ...p, playbackRate }))
  }, [])

  const setAutoPlayNext = useCallback((autoPlayNext: boolean) => {
    setSettings((p) => ({ ...p, autoPlayNext }))
  }, [])

  return { ...settings, setVolume, setIsMuted, setPlaybackRate, setAutoPlayNext }
}
