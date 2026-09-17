import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  FastForward,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture,
  Play,
  Rewind,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { fmtDuration } from '../../lib/tgmedia'
import { useTranslation } from '../../i18n'
import { decodeStateKey, useDecodeHealth } from '../../lib/decodeHealth'
import { usePlayerSettings } from '../../hooks/usePlayerSettings'

/**
 * 自绘控件视频播放器（移植自 orig-studio-web 的 VideoPlayer，按 orig-hub 裁剪）。
 *
 * 为什么不用原生 `controls`：原生控件的样式随浏览器而定，无法统一；
 * 也无法表达「缓冲中」「解码吃力」「自动连播下一集」这些状态——
 * 用户在原生控件下只能看到"卡住了"却不知道为什么。
 *
 * 相对 EE 原版**剥离**的部分（orig-hub 没有对应数据源）：
 *   - HLS（hlsSrc）：本地文件直投，无 m3u8 分片与转码产物
 *   - 清晰度切换（qualities）：单文件，无多档
 *   - 字幕 / 音轨：TG 与媒体库都无独立字幕文件
 *   - 转码中遮罩（isProcessing）：不存在转码流程
 *   - 进度条雪碧图预览（spriteVttUrl）：本机无 ffmpeg，无法生成雪碧图与 VTT
 *
 * **保留**的部分是真正决定手感的核心：自绘进度条（含缓冲段与拖拽）、
 * 键盘快捷键、控件自动隐藏、缓冲指示、以及「自动连播下一集」倒计时浮层。
 *
 * 快捷键（刻意避开 ←/→，那是 MediaViewer 的「上一个/下一个媒体项」）：
 *   Space / K 播放暂停   J / L 快退·快进 10s   ↑ / ↓ 音量   M 静音   F 全屏   P 画中画
 */
export interface NextUpInfo {
  title: string
  poster?: string | null
  /** 集号（1 起），用于「第 N 集」标注 */
  episodeNo?: number | null
}

export interface VideoPlayerProps {
  src: string
  /** 首选失败时回退一次（如本地文件缺失 → 在线流） */
  fallbackSrc?: string
  poster?: string | null
  autoPlay?: boolean
  className?: string
  /** 下一集：有值时播完弹「即将播放」倒计时浮层 */
  nextUp?: NextUpInfo | null
  /** 倒计时结束或点「立即播放」 */
  onPlayNext?: () => void
  /** 播完且没有下一集 */
  onEnded?: () => void
  /** 首选与降级均失败 */
  onFatal?: () => void
}

/** 可选倍速档位（与 EE 一致） */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
/** 快退/快进步长（秒） */
const SKIP_SEC = 10
/** 播放中控件自动隐藏延时 */
const HIDE_MS = 3000
/** 居中点击反馈图标停留时长 */
const CENTER_MS = 1500
/** 自动连播倒计时秒数 */
const COUNTDOWN_SEC = 5

export function VideoPlayer({
  src,
  fallbackSrc,
  poster,
  autoPlay,
  className,
  nextUp,
  onPlayNext,
  onEnded,
  onFatal,
}: VideoPlayerProps) {
  const { t } = useTranslation()
  const {
    volume,
    isMuted,
    playbackRate,
    autoPlayNext,
    setVolume,
    setIsMuted,
    setPlaybackRate,
  } = usePlayerSettings()

  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | null>(null)
  const centerTimer = useRef<number | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [isBuffering, setIsBuffering] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [barHover, setBarHover] = useState(false)
  const [volOpen, setVolOpen] = useState(false)
  const [showCenter, setShowCenter] = useState(false)
  const [centerIcon, setCenterIcon] = useState<'play' | 'pause'>('play')
  const [speedOpen, setSpeedOpen] = useState(false)
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC)
  const [showCountdown, setShowCountdown] = useState(false)
  const [fatal, setFatal] = useState(false)
  const [fellBack, setFellBack] = useState(false)

  /** 视频轨解不出来 / 解码吃力 —— 两类 onError 抓不到的静默失败（BUG-034） */
  const decode = useDecodeHealth(videoRef)

  const effectiveVolume = isMuted ? 0 : volume

  // ---------- 偏好即时生效（含首次挂载与降级重载） ----------
  const applyPrefs = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = isMuted
    v.playbackRate = playbackRate
  }, [volume, isMuted, playbackRate])

  useEffect(() => {
    applyPrefs()
  }, [applyPrefs])

  // ---------- 控件自动隐藏 ----------
  const pokeControls = useCallback(() => {
    setShowControls(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    const v = videoRef.current
    // 暂停或指针停在控件/菜单上时不隐藏，否则用户点不到
    if (v && !v.paused && !speedOpen && !barHover && !volOpen) {
      hideTimer.current = window.setTimeout(() => setShowControls(false), HIDE_MS)
    }
  }, [speedOpen, barHover, volOpen])

  useEffect(() => {
    pokeControls()
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [pokeControls])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    return () => {
      if (centerTimer.current) window.clearTimeout(centerTimer.current)
    }
  }, [])

  // ---------- 基础操作 ----------
  const flashCenter = useCallback((icon: 'play' | 'pause') => {
    setCenterIcon(icon)
    setShowCenter(true)
    if (centerTimer.current) window.clearTimeout(centerTimer.current)
    centerTimer.current = window.setTimeout(() => setShowCenter(false), CENTER_MS)
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    // 倒计时浮层挂着时，任意播放操作视为取消自动连播
    setShowCountdown(false)
    if (v.paused) {
      void v.play().catch(() => {})
    } else {
      v.pause()
    }
    pokeControls()
  }, [pokeControls])

  const skip = useCallback(
    (sec: number) => {
      const v = videoRef.current
      if (!v) return
      const d = Number.isFinite(v.duration) ? v.duration : duration
      const next = Math.max(0, Math.min(d || 0, v.currentTime + sec))
      v.currentTime = next
      setCurrentTime(next)
      pokeControls()
    },
    [duration, pokeControls],
  )

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const next = !v.muted
    v.muted = next
    setIsMuted(next)
    if (!next && v.volume === 0) {
      v.volume = 1
      setVolume(1)
    }
  }, [setIsMuted, setVolume])

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch {
      // WebView 未授权全屏等场景：静默忽略，不影响播放
    }
  }, [])

  const togglePiP = useCallback(async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await v.requestPictureInPicture()
    } catch {
      // 画中画不可用（未授权/元素不满足条件）：静默忽略
    }
  }, [])

  const changeVolume = useCallback(
    (val: number) => {
      const v = videoRef.current
      const clamped = Math.max(0, Math.min(1, val))
      if (v) {
        v.volume = clamped
        v.muted = clamped === 0
      }
      setVolume(clamped)
    },
    [setVolume],
  )

  const changeRate = useCallback(
    (rate: number) => {
      const v = videoRef.current
      if (v) v.playbackRate = rate
      setPlaybackRate(rate)
      setSpeedOpen(false)
    },
    [setPlaybackRate],
  )

  // ---------- 进度条：指针拖拽（pointer capture，拖出条外也跟手） ----------
  const seekRatioFromClientX = useCallback((clientX: number) => {
    const el = barRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return null
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const seekToRatio = useCallback(
    (ratio: number) => {
      const v = videoRef.current
      const d = Number.isFinite(v?.duration ?? NaN) ? (v as HTMLVideoElement).duration : duration
      if (!v || !d) return
      const t2 = ratio * d
      v.currentTime = t2
      setCurrentTime(t2)
    },
    [duration],
  )

  const onBarPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const ratio = seekRatioFromClientX(e.clientX)
      if (ratio === null) return
      seekToRatio(ratio)
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      setBarHover(true)
    },
    [seekRatioFromClientX, seekToRatio],
  )

  const onBarPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const ratio = seekRatioFromClientX(e.clientX)
      if (ratio === null) return
      seekToRatio(ratio)
    },
    [seekRatioFromClientX, seekToRatio],
  )

  const onBarPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setBarHover(false)
  }, [])

  // ---------- 媒体事件 ----------
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setDuration(Number.isFinite(v.duration) ? v.duration : 0)
    applyPrefs()
  }, [applyPrefs])

  const readBuffered = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.duration || !Number.isFinite(v.duration)) return
    const b = v.buffered
    if (b.length > 0) setBuffered(Math.min(1, b.end(b.length - 1) / v.duration))
  }, [])

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
    readBuffered()
  }, [readBuffered])

  const onError = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    // 首选失败 → 回退一次；再失败才认输
    if (fallbackSrc && !fellBack) {
      setFellBack(true)
      v.src = fallbackSrc
      v.load()
      void v.play().catch(() => {})
      return
    }
    setFatal(true)
    onFatal?.()
  }, [fallbackSrc, fellBack, onFatal])

  // ---------- 自动连播 ----------
  const onVideoEnded = useCallback(() => {
    setIsPlaying(false)
    if (nextUp && autoPlayNext) {
      setCountdown(COUNTDOWN_SEC)
      setShowCountdown(true)
      return
    }
    onEnded?.()
  }, [nextUp, autoPlayNext, onEnded])

  const cancelCountdown = useCallback(() => {
    setShowCountdown(false)
    setCountdown(COUNTDOWN_SEC)
  }, [])

  const playNextNow = useCallback(() => {
    setShowCountdown(false)
    setCountdown(COUNTDOWN_SEC)
    onPlayNext?.()
  }, [onPlayNext])

  useEffect(() => {
    if (!showCountdown) return
    if (countdown <= 0) {
      setShowCountdown(false)
      setCountdown(COUNTDOWN_SEC)
      onPlayNext?.()
      return
    }
    const id = window.setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => window.clearTimeout(id)
  }, [showCountdown, countdown, onPlayNext])

  // ---------- 快捷键 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入框内不劫持
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // 仅在播放器聚焦或全屏时响应，避免与页面其它快捷键打架
      const el = containerRef.current
      const focused = el && document.activeElement && el.contains(document.activeElement)
      if (!focused && !document.fullscreenElement) return

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault()
          flashCenter(videoRef.current?.paused ? 'play' : 'pause')
          togglePlay()
          break
        case 'j':
          e.preventDefault()
          skip(-SKIP_SEC)
          break
        case 'l':
          e.preventDefault()
          skip(SKIP_SEC)
          break
        case 'arrowup':
          e.preventDefault()
          changeVolume(effectiveVolume + 0.1)
          break
        case 'arrowdown':
          e.preventDefault()
          changeVolume(effectiveVolume - 0.1)
          break
        case 'm':
          e.preventDefault()
          toggleMute()
          break
        case 'f':
          e.preventDefault()
          void toggleFullscreen()
          break
        case 'p':
          e.preventDefault()
          void togglePiP()
          break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [flashCenter, togglePlay, skip, changeVolume, effectiveVolume, toggleMute, toggleFullscreen, togglePiP])

  const playedPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  const bufferedPct = Math.max(0, Math.min(100, buffered * 100))

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label={t('player.region')}
      className={cn(
        'group relative flex h-full w-full items-center justify-center overflow-hidden bg-black outline-none',
        className,
      )}
      onMouseMove={pokeControls}
      onMouseLeave={() => {
        const v = videoRef.current
        if (v && !v.paused && !speedOpen) setShowControls(false)
      }}
      onPointerDown={pokeControls}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        autoPlay={autoPlay}
        playsInline
        preload="auto"
        /* 必须 h-full w-full + object-contain：max-h/max-w 只能缩小不能放大，
           会让分辨率低于容器的视频缩在中间一小块（实测 480×270 的视频在
           1300×800 的媒体区里只占一角）。object-contain 保证任意宽高比
           （含竖屏 1080×1882）都不变形且铺满可用区域。 */
        className="h-full w-full bg-black object-contain"
        onClick={togglePlay}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onProgress={readBuffered}
        onPlay={() => {
          setIsPlaying(true)
          setIsBuffering(false)
          pokeControls()
        }}
        onPause={() => {
          setIsPlaying(false)
          setShowControls(true)
        }}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onCanPlay={() => setIsBuffering(false)}
        onEnded={onVideoEnded}
        onError={onError}
        onDoubleClick={() => void toggleFullscreen()}
      />

      {/* 点击反馈（居中图标，1.5s 后消失） */}
      {showCenter && !isBuffering && !fatal && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center" aria-hidden="true">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm md:h-20 md:w-20">
            {centerIcon === 'play' ? (
              <Play className="ml-1 h-8 w-8 fill-white text-white md:h-10 md:w-10" />
            ) : (
              <Pause className="h-8 w-8 fill-white text-white md:h-10 md:w-10" />
            )}
          </div>
        </div>
      )}

      {/* 缓冲指示 */}
      {isBuffering && !fatal && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center" aria-hidden="true">
          <div className="h-14 w-14 animate-spin rounded-full border-4 border-white/25 border-t-white" />
        </div>
      )}

      {/* 暂停时的居中播放按钮（控件可见时才显示） */}
      {!isPlaying && !fatal && showControls && !showCenter && !isBuffering && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <button
            type="button"
            aria-label={t('player.play')}
            onClick={(e) => {
              e.stopPropagation()
              flashCenter('play')
              togglePlay()
            }}
            className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm transition-transform hover:scale-110 md:h-20 md:w-20"
          >
            <Play className="ml-1 h-8 w-8 fill-white text-white md:h-10 md:w-10" />
          </button>
        </div>
      )}

      {/* 致命错误遮罩 */}
      {fatal && (
        <div
          role="alert"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
        >
          <AlertTriangle className="h-12 w-12 text-danger" />
          <p className="max-w-md text-center text-sm text-white/90">{t('tg.decodeFail')}</p>
        </div>
      )}

      {/* 解码异常提示（onError 抓不到的两类静默失败，BUG-034） */}
      {!fatal && decode !== 'ok' && (
        <p className="absolute bottom-20 left-1/2 z-20 max-w-[80%] -translate-x-1/2 rounded-md border border-white/20 bg-black/70 px-3 py-1.5 text-center text-xs text-white/90 backdrop-blur-sm">
          {t(decodeStateKey(decode) ?? 'tg.decodeFail')}
        </p>
      )}

      {/* 自动连播倒计时（YouTube 式） */}
      {showCountdown && nextUp && (
        <div
          className="absolute inset-0 z-40 flex items-end justify-end p-5 md:p-8"
          style={{
            background:
              'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.45) 50%, rgba(0,0,0,0.2) 100%)',
          }}
        >
          <button
            type="button"
            onClick={cancelCountdown}
            aria-label={t('player.cancelAutoplay')}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/85"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="relative aspect-video w-[30%] min-w-[220px] max-w-[320px] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/20">
            {nextUp.poster ? (
              <img src={nextUp.poster} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="h-full w-full bg-surface-2" />
            )}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.45) 45%, rgba(0,0,0,0.15) 100%)',
              }}
            />

            <div className="absolute left-3 top-3 rounded bg-black/50 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {nextUp.episodeNo ? t('player.episodeN', { n: nextUp.episodeNo }) : t('player.nextUp')}
            </div>

            {/* 倒计时圆环 */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-16 w-16">
                <svg className="h-16 w-16 -rotate-90" viewBox="0 0 36 36">
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="rgba(0,0,0,0.45)"
                    stroke="rgba(255,255,255,0.25)"
                    strokeWidth="2.5"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="16"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={`${(countdown / COUNTDOWN_SEC) * 100.53} 100.53`}
                    style={{ transition: 'stroke-dasharray 1s linear' }}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-lg font-bold tabular-nums text-white">{countdown}</span>
                </div>
              </div>
            </div>

            <div className="absolute bottom-3 left-3 right-28">
              <h3 className="line-clamp-2 text-sm font-semibold leading-tight text-white drop-shadow">
                {nextUp.title}
              </h3>
            </div>

            <button
              type="button"
              onClick={playNextNow}
              className="absolute bottom-3 right-3 rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black shadow-lg transition-colors hover:bg-white/90"
            >
              {t('player.playNow')}
            </button>
          </div>
        </div>
      )}

      {/* 控件层 */}
      <div
        role="toolbar"
        aria-label={t('player.controls')}
        className={cn(
          'pointer-events-none absolute inset-0 z-10 flex flex-col justify-end transition-opacity duration-300',
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />

        <div className="pointer-events-auto relative px-3 pb-3 pt-14 md:px-4 md:pb-4">
          {/* 进度条 */}
          <div
            ref={barRef}
            role="slider"
            tabIndex={0}
            aria-label={t('player.progress')}
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration)}
            aria-valuenow={Math.floor(currentTime)}
            onPointerDown={onBarPointerDown}
            onPointerMove={onBarPointerMove}
            onPointerUp={onBarPointerUp}
            onMouseEnter={() => setBarHover(true)}
            onMouseLeave={() => setBarHover(false)}
            className={cn(
              'relative mb-3 cursor-pointer touch-none transition-all',
              barHover ? 'h-2.5' : 'h-1.5',
            )}
          >
            <div className="absolute inset-0 overflow-hidden rounded-full bg-white/25">
              <div className="h-full rounded-full bg-white/45" style={{ width: `${bufferedPct}%` }} />
            </div>
            <div className="absolute inset-0 flex items-center">
              <div
                className="relative h-full rounded-full bg-accent"
                style={{ width: `${playedPct}%` }}
              >
                <div
                  className={cn(
                    'absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-white bg-accent shadow-lg transition-opacity',
                    barHover ? 'opacity-100' : 'opacity-0',
                  )}
                />
              </div>
            </div>
          </div>

          {/* 按钮组 */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 md:gap-2">
              {/* 播放 / 暂停 */}
              <button
                type="button"
                aria-label={isPlaying ? t('player.pause') : t('player.play')}
                onClick={(e) => {
                  e.stopPropagation()
                  flashCenter(isPlaying ? 'pause' : 'play')
                  togglePlay()
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                {isPlaying ? (
                  <Pause className="h-6 w-6 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-6 w-6 fill-current" />
                )}
              </button>

              {/* 快退 10s */}
              <button
                type="button"
                aria-label={t('player.rewind', { n: SKIP_SEC })}
                onClick={(e) => {
                  e.stopPropagation()
                  skip(-SKIP_SEC)
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                <Rewind className="h-5 w-5" />
              </button>

              {/* 快进 10s */}
              <button
                type="button"
                aria-label={t('player.forward', { n: SKIP_SEC })}
                onClick={(e) => {
                  e.stopPropagation()
                  skip(SKIP_SEC)
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                <FastForward className="h-5 w-5" />
              </button>

              {/* 音量（hover 展开） */}
              <div
                className="flex items-center"
                onMouseEnter={() => setVolOpen(true)}
                onMouseLeave={() => setVolOpen(false)}
              >
                <button
                  type="button"
                  aria-label={isMuted || volume === 0 ? t('player.unmute') : t('player.mute')}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleMute()
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-5 w-5" />
                  ) : (
                    <Volume2 className="h-5 w-5" />
                  )}
                </button>
                <div
                  className={cn(
                    'overflow-hidden transition-all duration-300',
                    volOpen ? 'w-24 opacity-100' : 'w-0 opacity-0',
                  )}
                >
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={effectiveVolume}
                    aria-label={t('player.volume')}
                    onChange={(e) => changeVolume(parseFloat(e.target.value))}
                    className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-white/30 accent-white"
                  />
                </div>
              </div>

              {/* 时间 */}
              <span className="min-w-[92px] pl-1 text-xs font-medium tabular-nums text-white/90 md:text-sm">
                {fmtDuration(Math.floor(currentTime)) || '0:00'} / {fmtDuration(Math.floor(duration)) || '--:--'}
              </span>
            </div>

            <div className="flex items-center gap-1 md:gap-2">
              {/* 倍速 */}
              <div className="relative">
                <button
                  type="button"
                  aria-label={t('player.speed')}
                  aria-expanded={speedOpen}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSpeedOpen((v) => !v)
                    pokeControls()
                  }}
                  className={cn(
                    'flex h-10 min-w-[3rem] items-center justify-center rounded-full px-3 text-sm font-medium text-white transition-colors hover:bg-white/15',
                    speedOpen && 'bg-white/15',
                  )}
                >
                  {playbackRate}x
                </button>
                {speedOpen && (
                  <div
                    role="menu"
                    aria-label={t('player.speed')}
                    className="absolute bottom-full right-0 mb-2 min-w-[132px] overflow-hidden rounded-lg border border-white/10 bg-black/90 shadow-xl backdrop-blur-md"
                  >
                    {RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        role="menuitemradio"
                        aria-checked={playbackRate === r}
                        onClick={(e) => {
                          e.stopPropagation()
                          changeRate(r)
                        }}
                        className={cn(
                          'flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-white transition-colors hover:bg-white/10',
                          playbackRate === r && 'bg-white/10 font-semibold',
                        )}
                      >
                        <span>
                          {r}x{r === 1 ? ` (${t('player.normal')})` : ''}
                        </span>
                        {playbackRate === r && <span className="text-accent">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 画中画 */}
              <button
                type="button"
                aria-label={t('player.pip')}
                onClick={(e) => {
                  e.stopPropagation()
                  void togglePiP()
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                <PictureInPicture className="h-5 w-5" />
              </button>

              {/* 全屏 */}
              <button
                type="button"
                aria-label={isFullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
                onClick={(e) => {
                  e.stopPropagation()
                  void toggleFullscreen()
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
              >
                {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
