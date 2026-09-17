/**
 * 封面生成（纯前端，无 ffmpeg 依赖）。
 *
 * 视频：加载后 seek 到指定秒，用 canvas 抽帧 → JPEG data-uri。
 * 图片：直接按目标宽度缩放 → JPEG data-uri。
 *
 * 生成的 data-uri 回写后端 `media_item.poster`，**一次生成永久复用**；
 * 并发受控（默认 2），避免一次性解码几十个视频把 WebView 卡死。
 */

const MAX_CONCURRENT = 2
let active = 0
const waiting: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((res) => waiting.push(res))
}

function release(): void {
  active -= 1
  const next = waiting.shift()
  if (next) {
    active += 1
    next()
  }
}

/** 排队执行（限制并发）。 */
export function withQueue<T>(fn: () => Promise<T>): Promise<T> {
  return acquire().then(
    () =>
      new Promise<T>((resolve, reject) => {
        fn().then(resolve, reject)
      }),
  ).then(
    (v) => {
      release()
      return v
    },
    (e) => {
      release()
      throw e
    },
  )
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

/**
 * 视频抽帧。`seekTo` 超过时长时自动回退到第 0 秒（短片也能拿到画面）。
 * 失败（不可解码 / 超时 / 画布被污染）一律 reject，由调用方降级为占位封面。
 */
export interface VideoProbe {
  /** 抽帧得到的封面 data-uri */
  dataUrl: string
  /** 时长（秒，四舍五入；0 = 未知） */
  duration: number
  width: number
  height: number
}

export function generateVideoPoster(src: string, seekTo = 1, maxW = 480): Promise<VideoProbe> {
  return withQueue(
    () =>
      new Promise<VideoProbe>((resolve, reject) => {
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
          const target =
            Number.isFinite(v.duration) && v.duration > seekTo ? seekTo : 0
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
      }),
  )
}

/** 图片缩略（统一卡片封面尺寸，避免大图直接进网格）。 */
export function generateImageThumb(src: string, maxW = 480): Promise<string> {
  return withQueue(
    () =>
      new Promise<string>((resolve, reject) => {
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
      }),
  )
}

/** 生成后回写后端失败时的内存兜底（本次会话内不再重复抽帧）。 */
const failedOnce = new Set<string>()

export function markPosterFailed(key: string): void {
  failedOnce.add(key)
}

export function posterFailed(key: string): boolean {
  return failedOnce.has(key)
}
