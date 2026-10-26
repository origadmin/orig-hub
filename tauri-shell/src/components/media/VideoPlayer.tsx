import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CloudOff,
  FastForward,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture,
  Play,
  Rewind,
  Scissors,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { fmtDuration } from '../../lib/tgmedia'
import { useTranslation } from '../../i18n'
import {
  decodeStateKey,
  MEDIA_ERR_SRC_NOT_SUPPORTED,
  useDecodeHealth,
} from '../../lib/decodeHealth'
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
 *
 * BUG-216：进度条 / 缓冲段 / 时间文案这三块随媒体时间推进的 UI 被下沉到
 * `PlayerProgressBar` 与 `PlayerTimeText` 两个叶子组件，顶层组件**不再**因
 * `timeupdate` 重渲染。详见 `usePlaybackClock` 的注释。
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
  /**
   * 条目是否应有视频轨（audio = false）。`videoWidth === 0` 只有在**应有视频轨**时
   * 才是「解不出来」；音频条目本来就无视频轨，不能据此停载（BUG-207）。
   */
  hasVideoTrack?: boolean
  /**
   * 兼容流地址（BUG-208）：视频轨判「解不出来」时自动换源到这里（服务端实时转码
   * H.264）。缺省或兼容流也失败时回退 BUG-207 停载遮罩。
   */
  compatSrc?: string
  /**
   * 真源总时长（秒，BUG-253）：来自 `GET /api/media/items/<id>` 的 `duration` 字段，
   * 是片长的唯一可靠真值（实测对照 ffprobe 一致，本仓库一条 242s 条目已确认）。
   * `<video>` 元素在 live 转码流上的 `duration` 仍在随转码推进而增长（12s 内抖动 85
   * 次、瞬时仅 1~14s），绝不能用来当总数显示。挂载时直接用它初始化
   * `contentDurationRef`，元素 `durationchange` / `loadedmetadata` 一律不得覆盖。
   * 缺省（上游未提供）时退回元素 duration 作最后一次兜底。
   */
  duration?: number | null
  /**
   * 字节态（BUG-254）：本条目当前是否还有可播放的字节。
   * `false` ⇒ 渲染专属「无内容 / 未缓存」遮罩，与「浏览器无法解码该格式」明确区分，
   * 不显示误导性 codec 文案，并给出 `onRecache` 入口。缺省（`true` / undefined）⇒
   * 走正常播放 / 解码失败路径。
   */
  hasBytes?: boolean | null
  /** 无字节时「重新缓存」入口（BUG-254）；缺省 = 不展示重缓存按钮。 */
  onRecache?: () => void
  /**
   * BUG-417 分段播放（前/后跳过只播主段）：内容窗口起点 / 终点（秒）。
   * 仅作为**显示窗口**与**真实元素的钳制边界**使用，不写入 rate-switch 的
   * `contentOffsetRef`/`contentDurationRef`（避免与转码锚点逻辑冲突）。
   * `skipStartSec` 缺省 0；`skipEndSec` 缺省 null（不截断结尾）。
   */
  skipStartSec?: number
  skipEndSec?: number | null
}

/** 可选倍速档位（与 EE 一致；3x/4x 为 BUG-209 新增——用户要求高倍速审看，
 *  转码档已加 fpsmax 30，30fps 内容在 4x 时恰达显示器刷新上限） */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/** Build the server-side FRC URL for a non-1x rate. */
function streamUrlAtRate(src: string, rate: number): string {
  const url = new URL(src, window.location.href)
  url.searchParams.set('speed', String(rate))
  return url.toString()
}

/**
 * Ask the server whether the variant's proxy file is already on disk (BUG-226).
 * The probe endpoint (`?probe=1`) is metadata-only: it never occupies the
 * single-flight slot and never spawns ffmpeg. `duration` is the *source-content*
 * duration, used by the display layer before the element learns its own.
 */
interface StreamProbe {
  ready: boolean
  duration: number | null
}

async function probeStream(streamUrl: string): Promise<StreamProbe | null> {
  try {
    const url = new URL(streamUrl, window.location.href)
    url.searchParams.set('probe', '1')
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = (await res.json()) as { ready?: unknown; duration?: unknown }
    if (typeof data.ready !== 'boolean') return null
    return {
      ready: data.ready,
      duration:
        typeof data.duration === 'number' && data.duration > 0 ? data.duration : null,
    }
  } catch {
    return null
  }
}

/** Attach a `t` (source-content seconds) anchor so the transcode starts there. */
function withStartParam(streamUrl: string, startSecs: number): string {
  const url = new URL(streamUrl, window.location.href)
  url.searchParams.set('t', String(Math.floor(startSecs)))
  return url.toString()
}

/**
 * Same variant? Compares origin+path and the `speed` param only — the `t` anchor
 * deliberately does NOT count, otherwise the anchored URL we just committed would
 * never match `targetSrc` and the rate-switch effect would re-probe in a loop.
 */
function sameStreamTarget(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const ua = new URL(a, window.location.href)
    const ub = new URL(b, window.location.href)
    return (
      ua.origin + ua.pathname === ub.origin + ub.pathname &&
      ua.searchParams.get('speed') === ub.searchParams.get('speed')
    )
  } catch {
    return false
  }
}

/** 快退/快进步长（秒） */
const SKIP_SEC = 10
/**
 * 冷缓存锚定阈值（BUG-226，源内容秒）：换档时位置在此之下不重锚，走从 0:00
 * 起转的普通 live 流。两个原因：① 片头附近「转码追上来」的等待很小；② 正式
 * 代理缓存（BUG-223 的按速独立缓存）只在从 0:00 起转的 live 流上累积——客户端
 * 断开也继续转完落盘，太早锚定会让缓存永远建不起来。
 */
const ANCHOR_MIN_CONTENT_SEC = 10
/** 播放中控件自动隐藏延时 */
const HIDE_MS = 3000
/** 控件层淡出时长（与 Tailwind `duration-300` 对齐）：淡出结束后才把控件层移出合成（BUG-217）。 */
const CONTROLS_FADE_MS = 300
/** 居中点击反馈图标停留时长 */
const CENTER_MS = 1500
/** 自动连播倒计时秒数 */
const COUNTDOWN_SEC = 5

/**
 * BUG-428：距真源总时长多少秒以内算「播完」。
 *
 * 为什么需要这个常量：视频一律走 `/stream`（stream-first，2026-10-09 用户裁定），
 * 而该端点的响应头是 `x-orig-stream: live` + `transfer-encoding: chunked`
 * （无 `content-length`、无 `accept-ranges`）。live 流的元素 `duration` 只是
 * **随下载量上涨的估算值**（实测 9.43 → 26.1 → 36.0 → … → 374.1，恒比
 * `currentTime` 大 4~8s），因此浏览器**永远不会抛 `ended`**，
 * 自动连播倒计时也就永远不出现 —— 用户报的「连续播放完全丢失」。
 *
 * 兜底判据改用**真源总时长**（`duration` prop，来自 `GET /api/media/items/<id>`；
 * 实测 item 1574 的库内时长 694.07s 与 `/raw` 元素的 694.07s 逐位相同），
 * 容差 0.75s 足以覆盖 timeupdate 的 ~4Hz 采样粒度。
 */
const END_EPSILON_SEC = 0.75

// ---- 兼容流记忆（BUG-208）已彻底移除（BUG-224 停用 + 2026-10-09 stream-first 翻转）----
//
// BUG-224 曾把记忆机制停用（读即清空），前提是「这些源本机解得动」。2026-10-09
// 用户实测推翻：raw 直解 1x 卡 / 2x 非常卡 / 4x 无法播放，stream 转码流流畅
// —— 播放不再选择源：有 compatSrc 一律 stream-first（见组件内 streamFirst），
// 「记忆哪些源要转码」这个问题本身不再存在。

function rememberCompatSrc(_src: string): void {
  // stream-first 后不再需要任何记忆。
}

/**
 * 播放时钟（仅**时间文案**用，BUG-216）：把「随时间推进」的状态隔离在叶子组件里。
 *
 * BUG-225/226 时间契约：FRC 流的媒体时间轴被压缩为源内容/S，且**锚点流**
 * （`?t=`，冷缓存深位起转）的 0:00 对应内容位置 `contentOffset`。显示值恒为
 * `contentOffset + 媒体时间 × timeScale`；总时长优先用服务端探针给的源内容
 * 时长，否则由元素 duration 换算。
 *
 * 为什么抽成 hook 并由叶子组件持有：
 * 时间文案随媒体时间推进。若把这个 state 放在 `VideoPlayer` 顶层，每次 `timeupdate`
 * （约 3.8 次/秒，与倍速无关）都会重渲染**整棵控件树**（含 8 项倍速菜单、音量、
 * 全屏、PiP 等）。实测（同页同文件 1440×807，2x/4x）：顶层持有时间状态时上屏
 * 55.9/55.7fps、rVFC 间隔 p95=33ms、>25ms 的帧 42/38、DOM 变更 24.5/32.6 次/秒；
 * 把状态下沉到只画这一小块的叶子组件后，父组件不再因时间推进而重渲染。
 *
 * 这里只保留**文本**需要的 `currentTime` / `duration`：文案每秒才变一次，
 * React 的 characterData 写入本就与之等频（1 次/秒），无需再降到 DOM 层。
 * 进度条（更高频、需要条宽）走 `PlayerProgressBar` 的 ref + 直接写 DOM。
 */
function useMediaClock(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  timeScale = 1,
  contentOffset = 0,
  contentDuration: number | null = null,
) {
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentTime(contentOffset + v.currentTime * timeScale)
    const onDur = () => {
      if (contentDuration != null && contentDuration > 0) setDuration(contentDuration)
      else setDuration((Number.isFinite(v.duration) ? v.duration : 0) * timeScale + contentOffset)
    }
    v.addEventListener('timeupdate', onTime)
    // seeked：`skip()` 直接写 `v.currentTime` 后即时刷新（不必等下一个 timeupdate）
    v.addEventListener('seeked', onTime)
    v.addEventListener('loadedmetadata', onDur)
    v.addEventListener('durationchange', onDur)
    // 监听器挂载前可能已有元数据：立即同步一次
    onTime()
    onDur()
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('seeked', onTime)
      v.removeEventListener('loadedmetadata', onDur)
      v.removeEventListener('durationchange', onDur)
    }
  }, [videoRef, timeScale, contentOffset, contentDuration])

  return { currentTime, duration }
}

/** 时间文案叶子（BUG-216）：只订阅播放时钟，不牵动父组件重渲染。 */
function PlayerTimeText({
  videoRef,
  timeScale = 1,
  contentOffset = 0,
  contentDuration = null,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  timeScale?: number
  contentOffset?: number
  contentDuration?: number | null
}) {
  const { currentTime, duration } = useMediaClock(videoRef, timeScale, contentOffset, contentDuration)
  return (
    <span className="min-w-[92px] pl-1 text-xs font-medium tabular-nums text-white/90 md:text-sm">
      {fmtDuration(Math.floor(currentTime)) || '0:00'} / {fmtDuration(Math.floor(duration)) || '--:--'}
    </span>
  )
}

/** 播放段最小写入间隔（毫秒）：视觉平滑与 DOM 写入次数的折中。
 *  0.7s 一拍 ⇒ 每拍条宽移动 (0.7s × 倍速 / 时长) × 条宽；对 20 分钟条目、4x 约 3px，
 *  仍在肉眼可辨阈值附近，却把「每个 timeupdate 都写 DOM」降到 ~1.4 次/秒（BUG-216）。 */
const BAR_WRITE_MS = 700
/** aria-valuenow 更新间隔（毫秒）：与视觉节流解耦，辅助技术交互时仍能取到值。 */
const ARIA_WRITE_MS = 5000
/** 已缓冲段最小写入间隔（毫秒）与最小变化量（%）：缓冲会持续增长，不去重会持续刷 DOM。 */
const BUFFERED_WRITE_MS = 1500
const BUFFERED_DELTA_PCT = 2

interface PlayerProgressBarProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 悬停态由父组件持有（`pokeControls` 依赖它决定是否自动隐藏），此处只读+回调 */
  barHover: boolean
  onBarHoverChange: (hover: boolean) => void
  /**
   * BUG-217：控件层隐藏（`showControls=false`）时进度条退化为 **sr-only** 节点——
   * 仍带 `role="slider"` / `aria-valuemin/valuemax/valuenow`（无障碍树仍可达，仍由
   * `write()` 直写更新），但被裁成 1px，不再参与可见的布局/绘制/合成。
   */
  compact?: boolean
  /** The transformed stream's media clock is compressed by the selected content speed. */
  timeScale?: number
  /** BUG-226：锚点流的 0:00 对应的内容位置（源内容秒）。 */
  contentOffset?: number
  /** BUG-226：源内容总时长（秒）——探针先于元素元数据已知时用它画全局比例。 */
  contentDuration?: number | null
  /**
   * BUG-226：live 流上的拖拽落点超出已转码覆盖范围时由父组件换 src 重锚。
   * 返回 true = 父组件已处理（本地不再写 currentTime）；false = 本地 seek。
   */
  onContentSeek?: (contentSec: number) => boolean
}

/**
 * 进度条叶子（BUG-216）：承载缓冲段、播放段与拖拽。
 *
 * **时间推进完全不经 React state**：`timeupdate` / `progress` / `seeked` 触发的是
 * 「合并到一帧内、且按墙钟节流」的 DOM 直写（`el.style.width` / `setAttribute`）。
 * 这样既不让父组件重渲染，也不让本组件每秒重渲染几十次 —— 实测 DOM 变更从
 * 24.5/32.6 次/秒降到个位数（见 BUG-216）。
 *
 * 拖拽语义（BUG-165）**原样保留**：按下与移动只更新 `dragRatioRef`（视觉位置，条面
 * 即时跟手，**不写 `currentTime`** —— 每次写 `currentTime` 都会中止旧请求再发一个新
 * Range 请求，实测 2s 拖拽 7 发 7 取消）；只有 `pointerup` 才提交唯一一次 `seekToRatio`。
 */
function PlayerProgressBar({
  videoRef,
  barHover,
  onBarHoverChange,
  compact = false,
  timeScale = 1,
  contentOffset = 0,
  contentDuration = null,
  onContentSeek,
}: PlayerProgressBarProps) {
  const { t } = useTranslation()
  const barRef = useRef<HTMLDivElement>(null)
  const playedRef = useRef<HTMLDivElement>(null)
  const bufferedRef = useRef<HTMLDivElement>(null)
  /** 拖拽中的视觉位置（null = 未在拖拽）：只喂条面渲染，不碰 `currentTime`（BUG-165） */
  const dragRatioRef = useRef<number | null>(null)
  const lastBarMs = useRef(0)
  const lastAriaMs = useRef(0)
  const lastBufferedMs = useRef(0)
  const lastBufferedPct = useRef(-1)

  /** 把当前播放位置 / 缓冲 / aria 直接写进 DOM（不经 React state）。
   *  `force=true` 用于离散事件（seek / 拖拽 / 元数据）即时刷新，不受节流限制。
   *  BUG-225/226：所有比例都定义在**源内容时间轴**上（contentOffset 修正 +
   *  timeScale 换算），进度条在锚点流与完整代理上呈现同一全局比例。 */
  const displayDur = () => {
    const v = videoRef.current
    if (contentDuration != null && contentDuration > 0) return contentDuration
    if (!v) return 0
    return (Number.isFinite(v.duration) ? v.duration : 0) * timeScale + contentOffset
  }
  const write = useCallback(
    (force: boolean) => {
      const v = videoRef.current
      const slider = barRef.current
      // BUG-217：compact（sr-only）态没有可见条面，`played`/`buffered` 为 null；
      // 只要 slider 还在，aria 就必须继续更新（AT 可达是硬约束）。
      if (!v || !slider) return
      const played = playedRef.current
      const dur = displayDur()
      const now = performance.now()
      const ratio = dragRatioRef.current
      const shown = ratio !== null && dur > 0 ? ratio * dur : contentOffset + v.currentTime * timeScale

      // 播放段：墙钟节流 + 只在值变化时写（compact 态无可见条面，跳过）
      if (played && (force || now - lastBarMs.current >= BAR_WRITE_MS)) {
        lastBarMs.current = now
        const pct = dur > 0 ? Math.min(100, (shown / dur) * 100) : 0
        played.style.width = `${pct}%`
      }

      // aria：与视觉节流解耦，低频更新（拖拽/seek 时 force 即时）
      if (force || now - lastAriaMs.current >= ARIA_WRITE_MS) {
        lastAriaMs.current = now
        const maxSec = String(Math.floor(dur))
        const nowSec = String(Math.floor(shown))
        if (slider.getAttribute('aria-valuemax') !== maxSec) slider.setAttribute('aria-valuemax', maxSec)
        if (slider.getAttribute('aria-valuenow') !== nowSec) slider.setAttribute('aria-valuenow', nowSec)
      }

      // 已缓冲段：低频 + 显著变化才写（本地文件缓冲会持续增长，不去重会持续刷 DOM）
      const buffered = bufferedRef.current
      if (buffered && dur > 0 && (force || now - lastBufferedMs.current >= BUFFERED_WRITE_MS)) {
        const b = v.buffered
        const bp =
          b.length > 0
            ? Math.max(0, Math.min(100, ((contentOffset + b.end(b.length - 1) * timeScale) / dur) * 100))
            : 0
        if (force || Math.abs(bp - lastBufferedPct.current) >= BUFFERED_DELTA_PCT) {
          lastBufferedMs.current = now
          lastBufferedPct.current = bp
          buffered.style.width = `${bp}%`
        }
      }
    },
    // `displayDur` 读的是 props 与元素属性，无自身状态；依赖与旧实现一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoRef, timeScale, contentOffset, contentDuration],
  )

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTick = () => write(false)
    const onSeek = () => write(true)
    v.addEventListener('timeupdate', onTick)
    v.addEventListener('progress', onTick)
    v.addEventListener('seeked', onSeek)
    v.addEventListener('loadedmetadata', onSeek)
    v.addEventListener('durationchange', onSeek)
    // 监听器挂载前可能已有元数据 / 进度：立即同步一次
    write(true)
    return () => {
      v.removeEventListener('timeupdate', onTick)
      v.removeEventListener('progress', onTick)
      v.removeEventListener('seeked', onSeek)
      v.removeEventListener('loadedmetadata', onSeek)
      v.removeEventListener('durationchange', onSeek)
    }
  }, [videoRef, write])

  // 控件显隐切换（compact 变化）后立即重同步一次，避免条面 / aria 短暂停留旧值
  useEffect(() => {
    write(true)
  }, [compact, write])

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
      if (!v) return
      const dur = contentDuration != null && contentDuration > 0
        ? contentDuration
        : (Number.isFinite(v.duration) ? v.duration : 0) * timeScale + contentOffset
      if (!dur) return
      const contentSec = ratio * dur
      // live 流上目标超出已转码覆盖范围 → 父组件换 src 重锚（BUG-226）
      if (onContentSeek && onContentSeek(contentSec)) {
        write(true)
        return
      }
      v.currentTime = Math.max(0, (contentSec - contentOffset) / (timeScale || 1))
      write(true)
    },
    [videoRef, write, timeScale, contentOffset, contentDuration, onContentSeek],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const ratio = seekRatioFromClientX(e.clientX)
      if (ratio === null) return
      // 拖拽期**不提交 seek**（BUG-165）：松手前是未确认态，只记录视觉位置，
      // 条面即时跟手；真正提交在 pointerup。
      dragRatioRef.current = ratio
      write(true)
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      onBarHoverChange(true)
    },
    [seekRatioFromClientX, write, onBarHoverChange],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const ratio = seekRatioFromClientX(e.clientX)
      if (ratio === null) return
      dragRatioRef.current = ratio
      write(true) // 拖拽跟手：立即写，不等节流
    },
    [seekRatioFromClientX, write],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      onBarHoverChange(false)
      const ratio = dragRatioRef.current
      dragRatioRef.current = null
      // 松手 = 确认位：此刻才提交唯一一次 seek（BUG-165）。
      if (ratio !== null) seekToRatio(ratio)
      else write(true)
    },
    [seekToRatio, write, onBarHoverChange],
  )

  // BUG-217：隐藏态只留一个 sr-only 节点——保住 `role="slider"` 与 aria-valuemin/
  // valuemax/valuenow（无障碍树仍可达、仍由 `write()` 直写更新），但不参与可见的
  // 布局 / 绘制 / 合成。
  if (compact) {
    return (
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label={t('player.progress')}
        aria-valuemin={0}
        aria-valuemax={0}
        aria-valuenow={0}
        className="sr-only"
      />
    )
  }

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label={t('player.progress')}
      aria-valuemin={0}
      /* aria-valuemax / aria-valuenow 的**实际值**由 `write()` 直接写 DOM（BUG-216）；
         这里保留常量初值只为「属性始终存在」（BUG-149 的可访问性契约），
         React 只在初值变化时写入，故不会覆盖 `write()` 的直写结果。 */
      aria-valuemax={0}
      aria-valuenow={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseEnter={() => onBarHoverChange(true)}
      onMouseLeave={() => onBarHoverChange(false)}
      className={cn(
        'relative mb-3 cursor-pointer touch-none transition-all',
        barHover ? 'h-2.5' : 'h-1.5',
      )}
    >
      <div className="absolute inset-0 overflow-hidden rounded-full bg-white/25">
        {/* 条宽由 `write()` 直写（BUG-216）；JSX 初值 '0%' 只避免首帧闪满 */}
        <div ref={bufferedRef} className="h-full rounded-full bg-white/45" style={{ width: '0%' }} />
      </div>
      <div className="absolute inset-0 flex items-center">
        <div ref={playedRef} className="relative h-full rounded-full bg-accent" style={{ width: '0%' }}>
          <div
            className={cn(
              'absolute right-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 rounded-full border-2 border-white bg-accent shadow-lg transition-opacity',
              barHover ? 'opacity-100' : 'opacity-0',
            )}
          />
        </div>
      </div>
    </div>
  )
}

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
  hasVideoTrack = true,
  compatSrc,
  duration,
  hasBytes,
  onRecache,
  skipStartSec: skipStartProp = 0,
  skipEndSec: skipEndProp = null,
}: VideoPlayerProps) {
  const { t } = useTranslation()
  /**
   * BUG-254：无字节（无播放源）专属态标志。为 `false` 时渲染「无内容 / 未缓存」遮罩，
   * 并压制下方三类「解码失败」遮罩（致命 / 停载 / 解码异常）——让「没有内容」与
   * 「浏览器无法解码该格式」在视觉与文案上彻底分开，不显示误导性 codec 提示。
   */
  const noContent = hasBytes === false
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
  const hideTimer = useRef<number | null>(null)
  const centerTimer = useRef<number | null>(null)
  /**
   * 源内容总时长（秒）：**真源优先 `item.duration`**（BUG-253），其次换档探针
   * `probe.duration`，最后才退回元素 `duration`（live 转码流上仍在抖动增长，绝不当真）。
   * 挂载即用真源初始化——元素 `durationchange` / `loadedmetadata` 只在真源缺失
   * （null）时才兜底一次，绝不覆盖已由真源确立的总数（不会再出现 0:32/0:01）。
   * 旧 `durationRef`（BUG-216）永远停在 0，是 BUG-225 位置被钳回 0:00 的帮凶。
   */
  const contentDurationRef = useRef<number | null>(duration ?? null)
  /** BUG-226：当前流 0:00 对应的内容位置（锚点流 > 0，其余为 0）。 */
  const contentOffsetRef = useRef(0)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [showControls, setShowControls] = useState(true)
  /** 控件层是否应可见（播放中且未唤起控件时为 false）。 */
  const controlsVisible = showControls || !isPlaying
  /**
   * BUG-217：控件层是否仍参与布局 / 绘制 / 合成。
   *
   * 隐藏时**不能只 `opacity-0`**：实测（同页同文件 1440×807，2x/4x，3 轮中位）
   * app@2x 上屏 55.6fps、rVFC 间隔 p95=33ms、>25ms 的帧 43；把控件层真正移出后
   * 回到 58.7/17.2/12（≈ 裸 `<video>` 对照 59.2/17.1/6）。代价来自「按钮行 / 渐变
   * 遮罩仍参与布局 + 绘制 + 合成」，与透明度无关（只 `opacity:0` 且去掉过渡仅
   * 57.0/24.3/28）。
   *
   * 保留 300ms 淡出手感：先让 `opacity` 过渡到 0，**淡出结束**（`CONTROLS_FADE_MS`）
   * 后才把装饰性 chrome 移出（`hidden`）、进度条转 sr-only；`controlsVisible` 变回
   * true 时立即恢复，保证淡入平滑（父层始终 `display:block`，故 opacity 过渡可跑）。
   */
  const [chromeMounted, setChromeMounted] = useState(true)
  const [chromeShown, setChromeShown] = useState(true)
  useEffect(() => {
    if (controlsVisible) {
      // 显示：先挂载（display 恢复、opacity=0），下一帧再置 opacity=1，让 300ms 淡入能跑
      // （若与 display 同帧置 1，浏览器不会播放过渡）。
      setChromeMounted(true)
      const show = window.setTimeout(() => setChromeShown(true), 20)
      return () => window.clearTimeout(show)
    }
    // 隐藏：先淡出（opacity=0），**淡出结束**（CONTROLS_FADE_MS）后才把整层移出 DOM。
    setChromeShown(false)
    const hide = window.setTimeout(() => setChromeMounted(false), CONTROLS_FADE_MS)
    return () => window.clearTimeout(hide)
  }, [controlsVisible])
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
  /** 2026-10-09 用户裁定（推翻 BUG-229 的「可直解源一律 raw」）：播放一律从服务端转码流起步。
   *  raw 直解在本机实测 1x 卡 / 2x 非常卡 / 4x 无法播放（硬解吞吐不足），stream（H.264 30fps）
   *  实测流畅 —— raw 退役为下载/导出端点，不再参与播放。有 compatSrc 即 stream-first；
   *  非 1x 直接起对应 FRC 变体。 */
  const streamFirst = Boolean(compatSrc && compatSrc !== src)
  const initialFrc = streamFirst && playbackRate !== 1
  const activeSrcAtMountRef = useRef(
    initialFrc
      ? streamUrlAtRate(compatSrc!, playbackRate)
      : streamFirst
        ? compatSrc!
        : src,
  )
  const [activeSrc, setActiveSrc] = useState(activeSrcAtMountRef.current)
  const [usingCompat, setUsingCompat] = useState(streamFirst)
  const compatTriedRef = useRef(streamFirst)
  const baseCompatRef = useRef(streamFirst)
  const originalSrcRef = useRef(src)
  const compatSrcRef = useRef(compatSrc)
  const hasVideoTrackRef = useRef(hasVideoTrack)
  useEffect(() => {
    originalSrcRef.current = src
    compatSrcRef.current = compatSrc
    hasVideoTrackRef.current = hasVideoTrack
  }, [compatSrc, hasVideoTrack, src])
  /** Rate-transcoded streams use a compressed media timeline; scale back to source-content seconds. */
  const activeContentSpeedRef = useRef(initialFrc ? playbackRate : 1)
  /**
   * BUG-225/226：换 src 的位置恢复委托。`contentTime` 是**源内容秒**；
   * `offset` 是新流的锚点（`?t=`），恢复的媒体时间 = (contentTime - offset) / speed。
   */
  const pendingRateSwitchRef = useRef<{ contentTime: number; wasPlaying: boolean; offset: number } | null>(null)
  /** BUG-226：当前 src 是否支持任意位置 Range seek（原生源 / 完整代理 = true）。
   *  BUG-253 修正冷缓存语义：FRC/live 冷流在管道确认可服务 Range 之前**不可 seek**——
   *  初始值按「是否走了 /stream 转码端点」判定：原生 /raw 源 = true（浏览器自己管），
   *  转码流 = false（保守按 live，待 `commit()` 借 `probeStream` 的 `ready` 信号翻转，
   *  沿用 BUG-229 既有的 seekability 信号，不再误判冷流为「可任意 seek」把位置钳回片头）。 */
  const streamSeekableRef = useRef(!activeSrcAtMountRef.current.includes('/stream'))
  /** 已停载（退无可退）：渲染 BUG-207 的诚实失败遮罩 */
  const [halted, setHalted] = useState(false)

  /**
   * BUG-417 分段播放（前/后跳过只播主段）：内容窗口起点 / 终点（秒），由播放器内
   * 弹层设置，初始来自 props（外部可预设，缺省 0 / null）。仅用于显示窗口与真实
   * 元素的钳制边界，不写入 rate-switch 的 ref（避开转码锚点逻辑）。
   */
  const [skipStartSec, setSkipStartSec] = useState(skipStartProp)
  const [skipEndSec, setSkipEndSec] = useState(skipEndProp)
  const [skipOpen, setSkipOpen] = useState(false)
  const segOffset = skipStartSec > 0 ? skipStartSec : 0
  const segDuration = skipEndSec != null && skipEndSec > segOffset ? skipEndSec - segOffset : null

  /**
   * BUG-417 钳制（真实 `<video>` 元素，按绝对秒）：播放越过窗口起点 → 拉回起点；
   * 到达窗口终点 → 暂停并当作「播完」处理（续播走 `onPlayNext`，与 416 合并播放衔接）。
   * 独立于 rate-switch 的 `contentOffsetRef`/`contentDurationRef`，只服务于分段播放，
   * 不干扰转码锚点逻辑。本地文件（timeScale=1）下绝对秒即内容秒，钳制精确。
   */
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      if (segOffset > 0 && v.currentTime < segOffset - 0.15) {
        v.currentTime = segOffset
      } else if (segDuration != null && v.currentTime >= segOffset + segDuration - 0.1) {
        v.pause()
        if (onPlayNext) onPlayNext()
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [segOffset, segDuration, onPlayNext])

  /** BUG-417：元数据就绪后若设了起点，直接落到起点（不播片头）。 */
  useEffect(() => {
    if (segOffset <= 0) return
    const v = videoRef.current
    if (!v) return
    const seekToStart = () => {
      if (Math.abs(v.currentTime - segOffset) > 0.25) v.currentTime = segOffset
    }
    if (v.readyState >= 1) seekToStart()
    v.addEventListener('loadedmetadata', seekToStart)
    return () => v.removeEventListener('loadedmetadata', seekToStart)
  }, [segOffset, activeSrc])

  /** 视频轨解不出来 / 解码吃力 —— 两类 onError 抓不到的静默失败（BUG-034）。
   *  换源或改倍速都重设基线：倍速变化会改变所需解码吞吐，旧账不能算到新状态上（BUG-053）。 */
  const decode = useDecodeHealth(videoRef, `${activeSrc}|${playbackRate}`)

  // Keep the selected playback rate, but let the server transcode every non-1x rate to
  // a 30fps stream. Preserve source-content position/play state across the URL switch.
  //
  // BUG-226：换档前先探针该变体的代理是否就绪。就绪 → 直接换 src（完整代理，
  // Range 可拖，位置恢复走 currentTime）；冷缓存 → 带 `t=<当前内容秒>` 从当前
  // 位置起转的 live-only 流，免去「转码从 0:00 追上来」的分钟级等待。
  useEffect(() => {
    const compat = compatSrcRef.current
    const original = originalSrcRef.current
    if (!compat || !hasVideoTrackRef.current) return
    if (decode === 'unsupported' && !compatTriedRef.current) return
    if (baseCompatRef.current && playbackRate === 1 && activeSrc === original) {
      baseCompatRef.current = false
    }
    // 2026-10-09 stream-first 翻转（用户裁定）：播放一律在转码流上，倍速换档 =
    // 在 FRC 变体之间切换（streamUrlAtRate），1x = 基础转码流。原生源（/raw）
    // 只在没有 compatSrc 时兜底出现（此时 onCompat=false，倍速走 playbackRate）。
    // 历史（BUG-229）：非 1x 无条件切 FRC 曾引发 fMP4 乱序 range 风暴（69 req/s、
    // 预读 66% 全片）——该问题现由磁盘预算 LRU（ORIG_TG_PROXY_MAX_BYTES）兜底，
    // 且 stream-first 后换档发生在同容器变体之间，不再有 raw↔stream 往返。
    const onCompat = usingCompat || baseCompatRef.current || activeSrc.includes('/stream')
    const rateSrc = playbackRate === 1 || !onCompat ? null : streamUrlAtRate(compat, playbackRate)
    const targetSrc = rateSrc ?? (baseCompatRef.current ? compat : original)
    const targetContentSpeed = rateSrc ? playbackRate : 1
    // 锚点 URL（...&t=N）属于同一目标变体：提前返回时不得动 offset/seekable。
    if (sameStreamTarget(targetSrc, activeSrc)) {
      activeContentSpeedRef.current = targetContentSpeed
      setUsingCompat(Boolean(baseCompatRef.current && targetSrc === compat))
      return
    }

    const v = videoRef.current
    const contentTime = v ? v.currentTime * activeContentSpeedRef.current + contentOffsetRef.current : 0
    const wasPlaying = v ? (!v.paused || (Boolean(autoPlay) && v.readyState === 0)) : Boolean(autoPlay)
    let cancelled = false

    const commit = (offset: number, seekable: boolean) => {
      if (cancelled) return
      contentOffsetRef.current = offset
      streamSeekableRef.current = seekable
      pendingRateSwitchRef.current = { contentTime, wasPlaying, offset }
      activeContentSpeedRef.current = targetContentSpeed
      if (rateSrc) compatTriedRef.current = true
      setActiveSrc(offset > 0 ? withStartParam(targetSrc, offset) : targetSrc)
      setUsingCompat(Boolean(!rateSrc && baseCompatRef.current && targetSrc === compat))
    }

    if (!targetSrc.includes('/stream')) {
      // 原生源（/raw 等）：浏览器自己管 seek 与时间轴。
      commit(0, true)
      return
    }
    void (async () => {
      const probe = await probeStream(targetSrc)
      // 真源 `duration`（挂载即确立）优先：探针只补真源缺失时的兜底，绝不回写覆盖。
      if (probe?.duration != null && contentDurationRef.current == null) {
        contentDurationRef.current = probe.duration
      }
      if (probe?.ready) {
        // 代理已在盘上：完整文件，任意位置 Range 可拖。
        commit(0, true)
        return
      }
      // 冷缓存：位置 ≥ 阈值时从当前内容位置起转（锚点取整到秒）；片头附近
      // 保持 from-0 起转以累积正式代理缓存（见 ANCHOR_MIN_CONTENT_SEC 注释）。
      const offset = contentTime >= ANCHOR_MIN_CONTENT_SEC ? Math.floor(contentTime) : 0
      commit(offset, false)
    })()
    return () => {
      cancelled = true
    }
  }, [activeSrc, autoPlay, decode, playbackRate, usingCompat])

  /**
   * 视频轨判定「解不出来」→ **先试兼容流，退无可退才停载**（BUG-208 接棒 BUG-207）。
   *
   * 实测（媒体库 HEVC 条目 472/357，本机无硬件 HEVC）：0 帧可解，但 `preload="auto"`
   * 的 `<video>` 永远等不到可播数据，Chromium 进入「缓冲 → abort → 重取」循环 ——
   * 20 秒内 97–137 个请求、GB 级无效 IO，且把整个页面拖卡。
   *
   * 处置顺序：有 `compatSrc`（服务端实时转码 H.264，全平台硬解）→ 换源重试，原始源
   * 记入 localStorage（下次直开）；没有兼容流、或兼容流同样解不出来 → BUG-207 停载
   * 遮罩兜底。音频条目无视频轨属正常（`hasVideoTrack=false`），绝不触发。
   */
  useEffect(() => {
    if (decode !== 'unsupported' || !hasVideoTrack) return
    const v = videoRef.current
    if (!v) return
    if (compatSrc && !compatTriedRef.current) {
      compatTriedRef.current = true
      baseCompatRef.current = true
      rememberCompatSrc(src)
      setActiveSrc(compatSrc)
      setUsingCompat(true)
      // 兼容流不带 speed 参数 = 内容速率 1（播放速率由 applyPrefs 钳回 1）。
      // 直解高倍速中切兼容流时必须同步归位，否则 contentTime 换算全错。
      activeContentSpeedRef.current = 1
      contentOffsetRef.current = 0
      return
    }
    v.pause()
    v.removeAttribute('src')
    v.load()
    setIsPlaying(false)
    setIsBuffering(false)
    setHalted(true)
  }, [decode, hasVideoTrack, compatSrc, src])

  const effectiveVolume = isMuted ? 0 : volume

  // ---------- 偏好即时生效（含首次挂载与降级重载） ----------
  const applyPrefs = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = isMuted
    // 唯一真相源是 activeSrc：FRC 流（URL 带 speed 参数，内容时间轴已被服务端
    // 压缩 N 倍）播放速率必须钳 1 —— 不得用 usingCompat 判定，commit 的 rateSrc
    // 分支会把 usingCompat 置 false（BUG-229 修复时引入的回归：FRC 2x 实际
    // 2×2=4 倍速、4x 实际 8 倍速，且持久化倍速污染后续播放）。base 兼容流
    // （unsupported 兜底，URL 无 speed 参数 = 内容速率 1）同样钳 1。
    v.playbackRate = activeSrc.includes('/stream') && hasVideoTrack ? 1 : playbackRate
  }, [volume, isMuted, playbackRate, activeSrc, hasVideoTrack])

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
      if (pendingRateSwitchRef.current) pendingRateSwitchRef.current.wasPlaying = true
      void v.play().catch(() => {})
    } else {
      if (pendingRateSwitchRef.current) pendingRateSwitchRef.current.wasPlaying = false
      v.pause()
    }
    pokeControls()
  }, [pokeControls])

  /**
   * live 流上的进度条拖拽（BUG-226）：目标超出已转码覆盖范围时换 src 重锚
   * （服务端 `-ss t` 从目标位置起转）；覆盖范围内与完整代理 / 原生源都交给
   * 浏览器本地 seek。返回 true 表示已由重锚处理。
   *
   * 位置约束：必须声明在 `skip` 之前（skip 对超出覆盖范围的跳转复用本重锚
   * 通道，TS 禁止块级变量先使用后声明）。
   */
  const contentSeek = useCallback(
    (contentSec: number): boolean => {
      const v = videoRef.current
      if (!v) return false
      if (!activeSrc.includes('/stream')) return false
      if (streamSeekableRef.current) return false
      let bEnd = 0
      try {
        if (v.buffered.length > 0) bEnd = v.buffered.end(v.buffered.length - 1)
      } catch {
        // buffered 在 detached 元素上会抛；按未覆盖处理
      }
      const speed = activeContentSpeedRef.current || 1
      const offset = contentOffsetRef.current
      const mediaTarget = (contentSec - offset) / speed
      if (mediaTarget >= 0 && mediaTarget <= bEnd + 0.5) return false
      // 重锚：新流 0:00 = 目标内容位置
      const base = compatSrcRef.current
      if (!base) return false
      const rate = playbackRate === 1 ? null : playbackRate
      const url = rate == null ? base : streamUrlAtRate(base, rate)
      const contentDur = contentDurationRef.current
      const maxOffset = contentDur != null && contentDur > 0 ? Math.max(0, contentDur - 0.5) : contentSec
      const anchor = Math.min(Math.max(0, Math.floor(contentSec)), Math.floor(maxOffset))
      const wasPlaying = !v.paused
      pendingRateSwitchRef.current = { contentTime: contentSec, wasPlaying, offset: anchor }
      contentOffsetRef.current = anchor
      streamSeekableRef.current = false
      activeContentSpeedRef.current = rate ?? 1
      setActiveSrc(anchor > 0 ? withStartParam(url, anchor) : url)
      return true
    },
    [activeSrc, playbackRate],
  )

  const skip = useCallback(
    (sec: number) => {
      const v = videoRef.current
      if (!v) return
      const speed = activeContentSpeedRef.current || 1
      const offset = contentOffsetRef.current
      // BUG-226：live 流上跳转落点超出已转码覆盖范围时，本地 seek 会被
      // Chromium 钳回 seekable（= buffered）末端，实测 contentTime 纹丝不动。
      // 跳转与拖拽同为显式意图 → 走同一条重锚通道（contentSeek 对完整代理 /
      // 覆盖范围内返回 false，自然落到下面的本地 seek）。
      if (contentSeek(offset + v.currentTime * speed + sec)) return
      const mediaDelta = sec / speed
      // 上限：已知源内容时长 → 换算成媒体时间；live 流元素 duration 可能是
      // NaN（fMP4 empty moov）或只覆盖锚点之后的剩余段，都不许把位置钳回 0
      // （BUG-225 实测：±10s 在 live 流上把 currentTime 归零）。
      const contentDur = contentDurationRef.current
      const mediaMax =
        contentDur != null && contentDur > 0
          ? (contentDur - offset) / speed
          : Number.isFinite(v.duration) && v.duration > 0
            ? v.duration
            : Number.POSITIVE_INFINITY
      const next = Math.max(0, Math.min(mediaMax, v.currentTime + mediaDelta))
      // 写 `currentTime` 会触发 `seeked` / `timeupdate`，叶子组件（BUG-216）据此即时刷新条面与时间文案
      v.currentTime = next
      pokeControls()
    },
    [pokeControls, contentSeek],
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
      setPlaybackRate(rate)
      setSpeedOpen(false)
    },
    [setPlaybackRate],
  )

  // ---------- 媒体事件 ----------
  /** durationchange 兜底（BUG-225/BUG-253）：仅当真源 `contentDurationRef` 仍为空
   *  （上游未提供 item.duration、且换档探针也未给出）时才用元素 duration 兜底一次——
   *  真源一旦确立（挂载即由 item.duration 初始化），此处**绝不覆盖**，否则又会把
   *  总数回写成 live 转码流那个仍在抖动的瞬时时长（0:32/0:01 的根因）。 */
  const onDurationChange = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const dur = Number.isFinite(v.duration) ? v.duration : 0
    const speed = activeContentSpeedRef.current
    if (contentDurationRef.current == null && dur > 0) {
      contentDurationRef.current = dur * speed + contentOffsetRef.current
    }
  }, [])

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const dur = Number.isFinite(v.duration) ? v.duration : 0
    const speed = activeContentSpeedRef.current
    if (contentDurationRef.current == null && dur > 0) {
      contentDurationRef.current = dur * speed + contentOffsetRef.current
    }
    const pending = pendingRateSwitchRef.current
    if (pending) {
      pendingRateSwitchRef.current = null
      // BUG-225：恢复 = (内容位置 - 锚点) / 速度。live 流的 duration 常为 NaN
      // （fMP4 empty moov），上限只在拿到有限 duration 时钳制——旧实现
      // `Math.min(durationRef=0, target)` 把深位恢复直接钳回 0:00。
      const mediaTarget = (pending.contentTime - pending.offset) / (speed || 1)
      const upper = dur > 0 ? dur : Number.POSITIVE_INFINITY
      v.currentTime = Math.max(0, Math.min(upper, mediaTarget))
    }
    applyPrefs()
    if (pending?.wasPlaying) void v.play().catch(() => {})
    else if (pending) v.pause()
  }, [applyPrefs])

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
    /*
     * BUG-224：浏览器**明确**说「这个源不支持」时，先去服务端兼容流再判终态。
     *
     * 原来这条直接进终态，于是用户看到「浏览器无法解码该格式（如 .mov/QuickTime），
     * 请在 APP 内用系统播放器打开」——而 APP 里并没有这个入口，服务端那条明明能救的
     * 兼容流也压根没被试过。实测复现：媒体库条目 395（MPEG-TS 伪装成 .mp4，
     * ffprobe format_name=mpegts）在 Edge 里 1.5s 内报 `error.code=4`，
     * 直接 fatal，兼容流一次都没请求。
     *
     * 为什么之前没走到兼容流：`decodeHealth` 的 unsupported 判据要求
     * `readyState >= 2`，而浏览器直接拒绝的源 `readyState` 永远是 0 ——
     * 「最该被救的那一类」恰好是判据唯一看不见的那一类。
     * 现在改成由 `onError` 亲自接手：`MEDIA_ERR_SRC_NOT_SUPPORTED` 与零帧判定
     * 是同一个事实的两个来源（浏览器明说 vs 预算耗尽），必须汇到同一条处置。
     */
    if (v.error && v.error.code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
      const compat = compatSrcRef.current
      if (compat && !compatTriedRef.current && hasVideoTrackRef.current) {
        compatTriedRef.current = true
        baseCompatRef.current = true
        setFellBack(true)
        setActiveSrc(compat)
        setUsingCompat(true)
        applyPrefs()
        v.load()
        void v.play().catch(() => {})
        return
      }
    }
    setFatal(true)
    onFatal?.()
  }, [fallbackSrc, fellBack, onFatal, applyPrefs])

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

  /**
   * BUG-428：live 转码流上 `ended` 不可靠，用真源总时长兜底判定「真的播完了」。
   *
   * 触发条件（全部满足才认）：
   *   ① 当前源**不可任意 seek**（`streamSeekableRef === false`）—— 即 live/锚点流；
   *      完整代理与 `/raw` 的 `ended` 可靠，不兜底（避免库内时长有偏差时提前切集）；
   *   ② 真源总时长已知且 > 0（`contentDurationRef`，BUG-253）；
   *   ③ 换算到**源内容时间**后距末尾 ≤ `END_EPSILON_SEC`；
   *   ④ 未在播放起点（`currentTime > 0`），且本次播放尚未触发过。
   *
   * 换算必须走 `currentTime * speed + offset`：FRC 流的媒体时间轴是压缩的
   * （`speed` 倍），锚点流的 0:00 也不是内容 0:00（`offset`）。
   */
  const endGuardRef = useRef(false)
  const onTimeUpdateEnd = useCallback(() => {
    const v = videoRef.current
    if (!v || endGuardRef.current) return
    if (streamSeekableRef.current) return
    if (v.paused || v.currentTime <= 0) return
    const dur = contentDurationRef.current
    if (dur == null || !(dur > 0)) return
    const speed = activeContentSpeedRef.current || 1
    const contentTime = v.currentTime * speed + contentOffsetRef.current
    if (contentTime < dur - END_EPSILON_SEC) return
    endGuardRef.current = true
    onVideoEnded()
  }, [onVideoEnded])

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
        src={activeSrc}
        poster={poster ?? undefined}
        autoPlay={autoPlay && (!pendingRateSwitchRef.current || pendingRateSwitchRef.current.wasPlaying)}
        data-playback-mode={activeContentSpeedRef.current === 1 ? 'native' : 'frc'}
        data-content-speed={activeContentSpeedRef.current}
        data-content-offset={contentOffsetRef.current}
        playsInline
        preload="auto"
        /* 必须 h-full w-full + object-contain：max-h/max-w 只能缩小不能放大，
           会让分辨率低于容器的视频缩在中间一小块（实测 480×270 的视频在
           1300×800 的媒体区里只占一角）。object-contain 保证任意宽高比
           （含竖屏 1080×1882）都不变形且铺满可用区域。 */
        className="h-full w-full bg-black object-contain"
        onClick={togglePlay}
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={onDurationChange}
        onPlay={() => {
          setIsPlaying(true)
          setIsBuffering(false)
          // BUG-428：每次重新开始播放都复位播完兜底闸门，否则「重播」后不再触发连播
          endGuardRef.current = false
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
        onTimeUpdate={onTimeUpdateEnd}
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

      {/* BUG-254：无字节（无播放源）专属态 —— 与「浏览器无法解码该格式」明确区分，
          不显示误导性 codec 文案，给出「重新缓存」入口。压制所有解码失败遮罩。 */}
      {noContent && (
        <div
          role="alert"
          data-testid="player-nobytes"
          className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-8"
        >
          <CloudOff className="h-12 w-12 text-amber-500" />
          <p className="max-w-md text-center text-sm text-white/90">{t('player.noContent')}</p>
          {onRecache && (
            <button
              type="button"
              onClick={onRecache}
              className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90"
              data-testid="player-recache"
            >
              {t('media.recache')}
            </button>
          )}
        </div>
      )}

      {/* 致命错误遮罩 */}
      {fatal && !noContent && (
        <div
          role="alert"
          data-testid="player-decode-error"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
        >
          <AlertTriangle className="h-12 w-12 text-danger" />
          <p className="max-w-md text-center text-sm text-white/90">{t('tg.decodeFail')}</p>
        </div>
      )}

      {/* 视频轨解不出来且无兼容流可退：已停载（BUG-207/208），整屏告知而不是让用户对着黑屏听声音 */}
      {halted && !noContent && (
        <div
          role="alert"
          data-testid="player-decode-error"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/85 p-8"
        >
          <AlertTriangle className="h-12 w-12 text-danger" />
          <p className="max-w-md text-center text-sm text-white/90">{t('tg.decodeUnsupported')}</p>
        </div>
      )}

      {/* 兼容流横幅已移除（BUG-245）：转码是常态实现路径而非异常，常驻横幅把「能播」
          播报成「出问题了」，且长期占位遮挡画面。`usingCompat` 仍保留并驱动换档
          effect；真正需要告知用户的只有 fatal/halted 遮罩与下方解码异常提示。 */}

      {/* 解码异常提示（onError 抓不到的两类静默失败，BUG-034） */}
      {!fatal && !halted && decode !== 'ok' && !noContent && (
        <p
          data-testid="player-decode-error"
          className="absolute bottom-20 left-1/2 z-20 max-w-[80%] -translate-x-1/2 rounded-md border border-white/20 bg-black/70 px-3 py-1.5 text-center text-xs text-white/90 backdrop-blur-sm"
        >
          {t(decodeStateKey(decode) ?? 'tg.decodeFail')}
        </p>
      )}

      {/* 自动连播倒计时（YouTube 式）
          data-testid：连播是用户反复报「丢失」的能力（BUG-416），
          必须能被端到端判据观测到「播完真的浮出下一集」，不能只靠读代码。 */}
      {showCountdown && nextUp && (
        <div
          data-testid="player-autoplay-next"
          data-next-title={nextUp.title}
          data-next-episode={nextUp.episodeNo ?? ''}
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

      {/* 控件层隐藏态（BUG-217）：整层移出 DOM / 合成，只留一个 sr-only 进度条——
          保住 `role="slider"` 与 aria-valuemin/valuemax/valuenow（无障碍树仍可达、
          仍由 `write()` 直写更新），但不参与可见的布局 / 绘制 / 合成。 */}
      {!chromeMounted && (
        <PlayerProgressBar
          videoRef={videoRef}
          barHover={barHover}
          onBarHoverChange={setBarHover}
          compact
          timeScale={activeContentSpeedRef.current}
          contentOffset={contentOffsetRef.current}
          contentDuration={contentDurationRef.current}
          onContentSeek={contentSeek}
        />
      )}

      {/* 控件层 */}
      <div
        role="toolbar"
        aria-label={t('player.controls')}
        className={cn(
          'pointer-events-none absolute inset-0 z-10 flex flex-col justify-end transition-opacity duration-300',
          chromeShown ? 'opacity-100' : 'opacity-0',
          !chromeMounted && 'hidden',
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />

        <div className="pointer-events-auto relative px-3 pb-3 pt-14 md:px-4 md:pb-4">
          {/* 进度条（BUG-216：状态在叶子组件内，父组件不因 timeupdate 重渲染） */}
          {chromeMounted && (
            <PlayerProgressBar
              videoRef={videoRef}
              barHover={barHover}
              onBarHoverChange={setBarHover}
              timeScale={activeContentSpeedRef.current}
              contentOffset={segOffset}
              contentDuration={segDuration}
              onContentSeek={contentSeek}
            />
          )}

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

              {/* 时间（BUG-216：状态在叶子组件内；BUG-225/226：内容时间契约） */}
              <PlayerTimeText
                videoRef={videoRef}
                timeScale={activeContentSpeedRef.current}
                contentOffset={contentOffsetRef.current}
                contentDuration={contentDurationRef.current}
              />
            </div>

            <div className="flex items-center gap-1 md:gap-2">
              {/* BUG-417 跳过片头/片尾（分段播放）：弹层设前跳/后跳秒，应用后只播主段 */}
              <div className="relative">
                <button
                  type="button"
                  aria-label={t('player.skipSegment')}
                  aria-expanded={skipOpen}
                  aria-haspopup="dialog"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSkipOpen((v) => !v)
                    pokeControls()
                  }}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15',
                    (segOffset > 0 || segDuration != null) && 'bg-accent/30',
                    skipOpen && 'bg-white/15',
                  )}
                  data-testid="player-skip-segment"
                >
                  <Scissors className="h-5 w-5" />
                </button>
                {skipOpen && (
                  <div
                    role="dialog"
                    aria-label={t('player.skipSegment')}
                    className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-white/10 bg-black/90 p-3 shadow-xl backdrop-blur-md"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="mb-2 text-[11px] font-medium text-white/80">{t('player.skipSegmentHint')}</p>
                    <label className="mb-2 block">
                      <span className="mb-1 block text-[10px] text-white/60">{t('player.skipStart')}</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={Math.round(skipStartSec)}
                        onChange={(e) => setSkipStartSec(Math.max(0, Number(e.target.value) || 0))}
                        className="w-full rounded border border-white/15 bg-white/10 px-2 py-1 text-sm text-white outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] text-white/60">{t('player.skipEnd')}</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={skipEndSec ?? ''}
                        placeholder="∞"
                        onChange={(e) =>
                          setSkipEndSec(e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0))
                        }
                        className="w-full rounded border border-white/15 bg-white/10 px-2 py-1 text-sm text-white outline-none"
                      />
                    </label>
                  </div>
                )}
              </div>

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
