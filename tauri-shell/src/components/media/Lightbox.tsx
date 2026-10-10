import { useEffect } from 'react'
import { Trash2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'

/** 灯箱条目：`src` 由调用方按统一规则算出（`img.poster ?? mediaItemUrl(itemId)`）。 */
export interface LightboxItem {
  src: string
  alt: string
  itemId: number
}

/**
 * 统一图片灯箱 —— 取代现状的 `series-photo-viewer` + `episode-image-viewer` 两个。
 *
 * 能力守恒：两者都是「图片放大浏览」，合并为一个组件不减能力（设计 §5）。
 *
 * **翻页范围 = 传入数组**（R6）：集级挂图 = 该集的 `images`；图册 = 本组 photo 分集。
 * 因此「A 集 3 图 / B 集 2 图」时页数分别为 3 / 2，不会串到别的集。
 *
 * `isPhotoOnly` 为 true（图册成员）时**不渲染摘除按钮** —— 图册瓦片上的 × 是
 * 「从剧集移除一个分集」，在宫格上；灯箱里的「摘除」语义是「从本集挂图中摘掉一张」，
 * 对图册成员不成立。
 */
export function Lightbox(props: {
  items: LightboxItem[]
  index: number
  isPhotoOnly: boolean
  onIndexChange: (i: number) => void
  onClose: () => void
  /** 摘除**当前**这张挂图（集级挂图用，传 `onDetach(item.itemId)`） */
  onDetach?: (itemId: number) => void
}) {
  const { t } = useTranslation()
  const { items, index, isPhotoOnly, onIndexChange, onClose, onDetach } = props
  const item = items[index]

  // 翻页与关闭挂 window：灯箱内的 DOM 焦点位置不确定（点遮罩 / 点按钮后焦点
  // 可能落在被卸载的节点上），绑在容器上会漏按键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onIndexChange((index - 1 + items.length) % items.length)
      if (e.key === 'ArrowRight') onIndexChange((index + 1) % items.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onIndexChange, onClose])

  if (!item) return null

  // BUG-215：浮层参照系必须是**内容框**（标题栏下缘），不是视口。
  // 原 `fixed inset-0` 锚视口顶，而可见内容从 y=--titlebar-h 开始，
  // 角部锚定的 `top-4` 按钮（16–56px）上半截落进标题栏带内，
  // 又因 z-50 < 标题栏 z-60 被盖住 —— 既看不见也点不到（拖拽区吞命中）。
  // 改锚内容框后：① 按钮整体落在内容框内，可见可点；
  // ② 顺带不再往标题栏区绘制遮罩（原先那份绘制被标题栏完全盖住，属无效绘制）。
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-50 flex items-center justify-center bg-black/85 p-8"
      onClick={onClose}
      data-testid="lightbox"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        aria-label={t('media.lightbox.close')}
        data-testid="lightbox-close"
      >
        <X className="h-5 w-5" />
      </button>

      {items.length > 1 ? (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange((index - 1 + items.length) % items.length)
            }}
            className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label={t('media.lightbox.prev')}
            data-testid="lightbox-prev"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange((index + 1) % items.length)
            }}
            className="absolute right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            aria-label={t('media.lightbox.next')}
            data-testid="lightbox-next"
          >
            ›
          </button>
        </>
      ) : null}

      {onDetach && !isPhotoOnly ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDetach(item.itemId)
          }}
          className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-destructive"
          aria-label={t('media.removeEpisodeImage')}
          data-testid="lightbox-detach"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      ) : null}

      <img
        src={item.src}
        alt={item.alt}
        className="max-h-full max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />

      <p
        className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/70"
        data-testid="lightbox-position"
      >
        {t('media.lightbox.of', { i: index + 1, n: items.length })}
      </p>
    </div>
  )
}
