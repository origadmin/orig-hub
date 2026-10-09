/**
 * 封面生成（纯前端，无 ffmpeg 依赖）。
 *
 * 视频：加载后 seek 到指定秒，用 canvas 抽帧 → JPEG data-uri。
 * 图片：直接按目标宽度缩放 → JPEG data-uri。
 *
 * 生成的 data-uri 回写后端 `media_item.poster`，**一次生成永久复用**。
 *
 * ## 抽帧预算（BUG-239 收尾）
 *
 * 抽帧 / 缩略图会对 `/api/media/items/{id}/raw` 发请求，是**按条目**的解码级开销。
 * 一个「全部内容」网格有上百张卡，其中数十条是无封面的视频。若无约束，一屏卡片会
 * 一起排进解码队列（且同一 id 被并发请求多次），既把请求数放大，又与播放器争
 * 解码/IO —— 实测播放中 `currentTime` 只推进 **0.72×**（用户体感的卡顿）。
 *
 * 故引入四道门（全部集中在本文件的队列里，调用方只声明「我要这条的封面」）：
 *
 *   1. **可见性**：调用方只在卡片进入视口（含 [`COVER_VIEWPORT_MARGIN`] 余量）时
 *      才请求，离开即 `cancelCoverJob` 撤销**尚未启动**的排队（已在解码的撤销不了，
 *      由调用方忽略，不当作失败）。
 *   2. **上限**：待办队列 ≤ [`POSTER_MAX_PENDING`]，超出**丢弃并计数**（`console.warn`
 *      + [`posterExtractionStats`]）—— 宁可少抽几张，也不把队列堆成无界。
 *   3. **让路**：`setPosterExtractionPaused(true)` 期间不再**启动**新任务
 *      （播放器打开时置位）—— 用户正在看的内容优先。
 *   4. **去重**：同 key 的在途 / 排队任务合并为同一个 Promise，成功结果在一次会话内
 *      复用（`doneCache`）。这堵住了「后端回写 `poster` 之前的那段窗口」里的重复抽帧。
 *
 * 覆盖不倒退：成功仍 resolve 出 `dataUrl` 由调用方回写后端，一次生成永久复用；
 * 因预算被丢弃的任务由调用方稍后重试，**不会**让卡片永久空白。
 */

/** 并发上限：同时解码的封面上限（超过会把 WebView 主线程拖住）。 */
const MAX_CONCURRENT = 2
/** 待办上限（BUG-239）：进入队列的封面任务数上限，超出即丢弃并计数。 */
export const POSTER_MAX_PENDING = 10
/**
 * 视口余量（BUG-239）：卡片进入「视口 + 该余量」即视为可见。给一屏的预取空间，
 * 但不等于「整页」—— 用它把抽帧限制在用户**即将看到**的那一批。
 */
export const COVER_VIEWPORT_MARGIN = '200px'

/** 因预算（队列满）被丢弃的封面任务：不是失败，调用方应稍后重试。 */
export class PosterBudgetDropped extends Error {
  constructor(key: string) {
    super(`poster extraction dropped for budget: ${key}`)
    this.name = 'PosterBudgetDropped'
  }
}

export function isPosterBudgetDropped(e: unknown): boolean {
  return e instanceof PosterBudgetDropped
}

interface Job {
  key: string
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  promise: Promise<unknown>
  started: boolean
  cancelled: boolean
}

let active = 0
const queue: Job[] = []
/** 在途 / 排队的任务（按 key 去重）。 */
const inflight = new Map<string, Job>()
/** 已成功的封面（一次会话内复用，堵住「后端回写前」的重复抽帧窗口）。 */
const doneCache = new Map<string, unknown>()
/** 因队列满被丢弃的次数（可观测，见 `posterExtractionStats`）。 */
let dropped = 0
/** 让路开关：true 时不再启动新任务（播放器打开期间）。 */
let paused = false

export interface PosterExtractionStats {
  /** 正在解码的任务数 */
  active: number
  /** 排队等待的任务数 */
  pending: number
  /** 在途 + 排队的任务总数（按 key 去重后） */
  inflight: number
  /** 因队列满被丢弃的累计次数 */
  dropped: number
  /** 是否处于让路（暂停）态 */
  paused: boolean
}

export function posterExtractionStats(): PosterExtractionStats {
  return { active, pending: queue.length, inflight: inflight.size, dropped, paused }
}

/** 置位 / 复位让路开关。复位时立刻续跑排队的任务。 */
export function setPosterExtractionPaused(v: boolean): void {
  if (paused === v) return
  paused = v
  if (!paused) pump()
}

function pump(): void {
  while (!paused && active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()
    if (!job || job.cancelled) continue
    active += 1
    job.started = true
    job
      .run()
      .then(
        (v) => {
          if (!job.cancelled) doneCache.set(job.key, v)
          job.resolve(v)
        },
        (e) => job.reject(e),
      )
      .finally(() => {
        active -= 1
        inflight.delete(job.key)
        pump()
      })
  }
}

/**
 * 排队执行一个封面任务（按 `key` 去重 + 队列上限 + 让路）。
 *
 * - 同 key 已成功 ⇒ 直接返回缓存结果（不再发请求）；
 * - 同 key 在途 / 排队 ⇒ 返回**同一个** Promise（在途合并）；
 * - 队列已满 ⇒ 丢弃并 reject `PosterBudgetDropped`（计数 + 日志，不静默）。
 */
function schedule<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (doneCache.has(key)) return Promise.resolve(doneCache.get(key) as T)
  const existing = inflight.get(key)
  if (existing) return existing.promise as Promise<T>
  if (queue.length >= POSTER_MAX_PENDING) {
    dropped += 1
    console.warn(
      `[poster] pending queue full (${POSTER_MAX_PENDING}); dropped cover job ${key} (total dropped=${dropped})`,
    )
    return Promise.reject(new PosterBudgetDropped(key))
  }
  let resolveFn!: (v: unknown) => void
  let rejectFn!: (e: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  const job: Job = {
    key,
    run: run as () => Promise<unknown>,
    resolve: resolveFn,
    reject: rejectFn,
    promise,
    started: false,
    cancelled: false,
  }
  inflight.set(key, job)
  queue.push(job)
  pump()
  return promise as Promise<T>
}

/**
 * 撤销一个**尚未启动**的排队任务（卡片离开视口 / 卸载）。
 * 已在解码的任务无法中断，静默忽略 —— 调用方把 `PosterBudgetDropped` 当「不是失败」。
 */
export function cancelCoverJob(key: string): void {
  const job = inflight.get(key)
  if (!job || job.started) return
  job.cancelled = true
  inflight.delete(key)
  const i = queue.indexOf(job)
  if (i >= 0) queue.splice(i, 1)
  job.reject(new PosterBudgetDropped(key))
}

function drawToDataUrl(
  source: HTMLVideoElement | HTMLImageElement,
  w: number,
  h: number,
  maxW: number,
  quality = 0.7,
): string {
  const scale = Math.min(1, maxW / Math.max(1, w))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(w * scale))
  canvas.height = Math.max(2, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

export interface VideoProbe {
  /** 抽帧得到的封面 data-uri */
  dataUrl: string
  /** 时长（秒，四舍五入；0 = 未知） */
  duration: number
  width: number
  height: number
}

/**
 * 视频抽帧的**裸实现**（不含队列）。`seekTo` 超过时长时回退到第 0 秒。
 * 失败（不可解码 / 超时 / 画布被污染）一律 reject。
 */
function extractVideo(src: string, seekTo: number, maxW: number): Promise<VideoProbe> {
  return new Promise<VideoProbe>((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.preload = 'metadata'
    v.muted = true
    v.playsInline = true
    let settled = false

    const cleanup = () => {
      v.onloadeddata = null
      v.onseeked = null
      v.onerror = null
      v.removeAttribute('src')
      try {
        v.load()
      } catch {
        /* 忽略卸载异常 */
      }
    }
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('poster timeout'))
    }, 20000)

    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      try {
        const w = v.videoWidth || 16
        const h = v.videoHeight || 9
        const url = drawToDataUrl(v, w, h, maxW)
        // 同时把时长/分辨率带回去：媒体站卡片需要时长徽标，
        // 而这些元数据只有真正加载过媒体才知道（后端不做转码探测）。
        const duration = Number.isFinite(v.duration) ? Math.round(v.duration) : 0
        cleanup()
        resolve({ dataUrl: url, duration, width: w, height: h })
      } catch (e) {
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    v.onloadeddata = () => {
      const target = Number.isFinite(v.duration) && v.duration > seekTo ? seekTo : 0
      if (target > 0) {
        v.currentTime = target
      } else {
        finish()
      }
    }
    v.onseeked = () => finish()
    v.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      cleanup()
      reject(new Error('video load failed'))
    }
    v.src = src
  })
}

/** 图片缩略的**裸实现**（不含队列）。 */
function extractImage(src: string, maxW: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('thumb timeout'))
    }, 20000)
    img.onload = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      try {
        resolve(drawToDataUrl(img, img.naturalWidth || 16, img.naturalHeight || 9, maxW))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    img.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(new Error('image load failed'))
    }
    img.src = src
  })
}

/**
 * 请求一条视频条目的封面（走预算队列）。`key` 应是**按条目**稳定的
 * （调用方统一用 `v-<itemId>`），这样多个卡片 / 多次进入 / 多来源引用同一条目
 * 只会真正抽帧一次。
 */
export function requestVideoPoster(
  key: string,
  src: string,
  seekTo = 1,
  maxW = 480,
): Promise<VideoProbe> {
  return schedule(key, () => extractVideo(src, seekTo, maxW))
}

/** 请求一条图片条目的缩略图（走预算队列）。`key` 统一用 `p-<itemId>`。 */
export function requestImageThumb(key: string, src: string, maxW = 480): Promise<string> {
  return schedule(key, () => extractImage(src, maxW))
}

/** 生成后回写后端失败时的内存兜底（本次会话内不再重复抽帧）。 */
const failedOnce = new Set<string>()

export function markPosterFailed(key: string): void {
  failedOnce.add(key)
}

export function posterFailed(key: string): boolean {
  return failedOnce.has(key)
}

/**
 * 调试直通口（仅 dev）：把抽帧预算的读数挂到 `window`，供验收脚本断言
 * 「队列有上限、丢弃可观测」。与 `useStore.ts` 的 `__origStore` 同一约定 ——
 * 生产构建 `import.meta.env.DEV` 为 false，整段被 tree-shake，不残留。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __origPoster?: {
        stats: typeof posterExtractionStats
        pause: typeof setPosterExtractionPaused
        maxPending: number
      }
    }
  ).__origPoster = {
    stats: posterExtractionStats,
    pause: setPosterExtractionPaused,
    maxPending: POSTER_MAX_PENDING,
  }
}
