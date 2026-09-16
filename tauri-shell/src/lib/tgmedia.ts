/** TG 媒体共用工具：判型兜底 + 尺寸/时间格式化（TgPanel / MediaLibraryPanel 共用） */

export type MediaType = 'photo' | 'video' | 'audio' | 'file'

const PHOTO_EXT = /\.(jpe?g|png|gif|webp|bmp|heic)$/i
const VIDEO_EXT = /\.(mp4|mkv|webm|mov|avi|m4v|ts|3gp)$/i
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|flac|wav|opus)$/i

export function guessMediaType(mime?: string, filePath?: string): MediaType {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'photo'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  // 历史行 type/mime 双缺（旧版下载落库未带元数据）→ 按落盘扩展名兜底判型，
  // 否则照片被当 file 塞进 <video> 播放必然失败。
  const p = filePath || ''
  if (PHOTO_EXT.test(p)) return 'photo'
  if (VIDEO_EXT.test(p)) return 'video'
  if (AUDIO_EXT.test(p)) return 'audio'
  return 'file'
}

export function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function fmtTime(sec?: number): string {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 秒 → h:mm:ss / m:ss（视频时长徽标用） */
export function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`
}
