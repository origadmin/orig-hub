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

export function fmtSize(bytes?: number | null): string {
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

/**
 * 是否为 TG 落盘原始文件名（如 `photo--1004418016251_2000`）。
 *
 * 这类字符串来自下载器的命名规则，**不是标题** —— 直接展示会让界面充满乱码般的噪音，
 * 而且同一实体在侧栏（可读占位「图片 1」）与底部 caption（原始文件名）会变成两个名字。
 * 无真实标题时应回退到可读占位。
 */
export function isRawFileName(s?: string | null): boolean {
  return !!s && /^[a-z]+--\d+_\d+/i.test(s.trim())
}

/**
 * 图片「完整显示、不裁切」的唯一判定点（铺满 vs 完整的分界）。
 *
 * - `photo` → `object-contain`：**图片是内容本身**，裁掉边缘就是丢内容（用户报的
 *   「图片被截取」）。容器按固定几何排布，图片以留白换取完整。
 * - 其他（视频抽帧 / 音频 / 文档）→ `object-cover`：封面只是**指代**，裁切不影响
 *   信息量，且铺满更像海报墙。
 *
 * 单一函数而非各处散写三元：媒体类型判定是规则（type 是规则不是约定），
 * 分散写必然出现「某个角落还在 cover」的漏网之鱼。
 */
export function coverFit(kind?: string | null): string {
  return kind === 'photo' ? 'object-contain' : 'object-cover'
}

/** 相册宫格最多平铺的格子数（超出部分折进最后一格的 `+N`，与原图浏览页互补） */
export const ALBUM_MAX_TILES = 9

/**
 * 相册宫格列数：按图片数量自适应（参照 TG 相册排版）。
 *
 * 1 → 单图（自然比例整幅）
 * 2 → 2 列（并排）
 * 3 → 3 列（一行）
 * 4 → 2 列（2×2）
 * 5/6 → 3 列（3+2 / 3+3，即 5、6 宫格）
 * 7/8/9 → 3 列（3+3+1 / 3+3+2 / 3×3，即 7、8、9 宫格）
 *
 * 4 特意回到 2 列：3 列排 4 张会得到「3+1」的瘸腿行，而 2×2 是 4 图的自然形态。
 */
export function albumGridCols(n: number): 1 | 2 | 3 {
  if (n <= 1) return 1
  if (n === 2 || n === 4) return 2
  return 3
}

/** 相册宫格列数 → Tailwind 类（避免动态类名被 JIT 扫不到） */
export function albumGridClass(n: number): string {
  const c = albumGridCols(n)
  return c === 1 ? 'grid-cols-1' : c === 2 ? 'grid-cols-2' : 'grid-cols-3'
}

/** TG 来源标识 `chat:msg` → 频道号 + 消息号；格式不符返回 `null`（不猜、不兜底成 0）。 */
export function parseTgRef(ref?: string | null): { chatId: number; messageId: number } | null {
  if (!ref) return null
  const i = ref.indexOf(':')
  if (i <= 0 || i === ref.length - 1) return null
  const chatId = Number(ref.slice(0, i))
  const messageId = Number(ref.slice(i + 1))
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null
  return { chatId, messageId }
}

/**
 * 这条内容**当前有没有字节可播**（BUG-080）。
 *
 * 清缓存只删字节、留条目：条目仍在资料库与剧集里，外观却与正常内容一模一样，
 * 点下去 `GET /api/media/items/:id/raw` 返回 404 —— 静默播不了。有没有字节是**事实态**，
 * 必须由展示层如实呈现，而不是让一个长得能点的按钮去 404。
 *
 * 判据优先级：
 *   1. TG 图片**不落盘**（BUG-049）：raw 端点现场代理 TG 缩略图字节，
 *      `file_path` 为空也能显示 —— 那是「没有本地副本」，不是「丢失」；
 *   2. 后端下发的 `hasBytes`（分集视图；条目视图改看 `filePath`）；
 *   3. 有落盘路径即有字节。
 */
export function hasMediaBytes(item: {
  kind?: string | null
  source?: string | null
  filePath?: string | null
  hasBytes?: boolean | null
}): boolean {
  if (item.source === 'tg' && item.kind === 'photo') return true
  if (item.hasBytes != null) return item.hasBytes
  return Boolean(item.filePath)
}
