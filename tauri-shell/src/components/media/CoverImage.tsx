import { useState } from 'react'

/**
 * 封面图：在 `coverFit(kind)` 的基础上，**再按源图实际方向兜底**。
 *
 * 为什么不能只信 `kind`：`coverFit` 的语义是「图片是内容本身 → 不裁」，
 * 它判的是**内容类型**，不是**图片形状**。但同一张图在数据上可以是竖版 ——
 * TG 原档的截帧 / 竖版视频封面实测为 `480×853`（比值 0.563）。此时
 * `kind === 'video'` 会让容器套上 `object-cover`，在 16:9 横幅里把竖版图
 * 横切得只剩躯干（约裁掉 68% 高度）—— 正是设计 §3.1.1 明令禁止的
 * 「竖版图 + 横幅容器 + object-cover」组合。
 *
 * `coverKind` 只表达「这个条目能不能直接当图片用」（video 需先抽帧，
 * 见 `media.rs` 的 `cover_kind` 注释），**不携带宽高比信息** —— 不能拿它
 * 推断方向。唯一可靠的判据是图片加载后的 `naturalWidth` / `naturalHeight`。
 *
 * 兜底是**单向**的：只在「源图竖版 + 当前判定要裁」时改判 `contain`。
 * 横版图照常走 `coverFit` 的结果，不改变既有观感。
 */
export function CoverImage(props: {
  src: string
  alt?: string
  /** 内容类型（photo/video/audio/file），决定基准判定 */
  kind?: string | null
  /** `coverFit(kind)` 的结果，由调用方算好传入 —— 保证基准判定单点不变 */
  fit: string
  className?: string
}) {
  const { src, alt = '', fit, className = '' } = props
  /** 源图是否竖版（仅在加载完成后可知） */
  const [portrait, setPortrait] = useState(false)

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onLoad={(e) => {
        const el = e.currentTarget
        // 只在「竖版 且 当前会裁」时改判：横版与本就 contain 的图不受影响
        if (el.naturalHeight > el.naturalWidth && fit === 'object-cover') setPortrait(true)
      }}
      className={`${className} ${fit} ${portrait ? 'object-contain' : ''}`.trim()}
    />
  )
}
