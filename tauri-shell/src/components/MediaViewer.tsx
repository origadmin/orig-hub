import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import type { ViewerItem } from '../types'

/**
 * 全局媒体播放器页（模块无关，不带任何模块信息）：打开时独占内容区整页。
 * 返回行（← 返回 + 标题 + n/N）+ 黑底媒体区（‹ › 收在面板内侧，不会出框）+ caption 底部行。
 */
export function MediaViewer(props: {
  items: ViewerItem[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
  /** 返回行标题；缺省用当前项 caption / #messageId */
  title?: string
  className?: string
}) {
  const { t } = useTranslation()
  const { items, index, onIndex, onClose, title, className } = props
  const cur = items[index]
  const many = items.length > 1

  /** 倍速（视频重挂载后经 onLoadedMetadata 回填） */
  const [rate, setRate] = useState(1)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  /** 首选+降级均失败（如 .mov 容器浏览器不可解码）→ 露出可读提示而非黑屏 */
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [cur?.key])
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate, cur?.key])

  // 键盘导航：←/→ 组内切换，Esc 返回（组件自持，任何挂载处行为一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        if (index > 0) onIndex(index - 1)
      } else if (e.key === 'ArrowRight') {
        if (index < items.length - 1) onIndex(index + 1)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onIndex, onClose])

  return (
    <div className={cn('flex min-h-0 flex-col bg-surface/20', className)}>
      {/* 返回行：← 返回 + 标题 + n/N */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-3 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-[11px]"
          onClick={onClose}
        >
          ← {t('tg.backToFeed')}
        </Button>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
          {title || cur.caption?.trim() || `#${cur.messageId}`}
        </span>
        {many && (
          <span className="shrink-0 text-[11px] text-muted">
            {index + 1}/{items.length}
          </span>
        )}
      </div>
      {/* 媒体区：黑底居中；‹ › 组内切换收进面板两侧，不再出框 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-4">
        {(cur.kind === 'video' || cur.kind === 'audio') && (
          <PlaybackSpeed rate={rate} onRate={setRate} />
        )}
        {many && index > 0 && (
          <button
            type="button"
            onClick={() => onIndex(index - 1)}
            className="absolute left-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
          >
            ‹
          </button>
        )}
        {cur.kind === 'photo' ? (
          <img
            key={String(cur.key)}
            src={cur.src}
            alt={cur.caption || ''}
            className="max-h-full max-w-full rounded-lg object-contain"
            onError={(e) => {
              const img = e.currentTarget
              if (cur.fallbackSrc && !img.dataset.fallback) {
                img.dataset.fallback = '1'
                img.src = cur.fallbackSrc
              } else {
                setFailed(true)
              }
            }}
          />
        ) : (
          <video
            key={String(cur.key)}
            ref={videoRef}
            src={cur.src}
            controls
            autoPlay
            preload="auto"
            onLoadedMetadata={(e) => {
              e.currentTarget.playbackRate = rate
            }}
            className="max-h-full max-w-full rounded-lg bg-black"
            onError={(e) => {
              const v = e.currentTarget
              if (cur.fallbackSrc && !v.dataset.fallback) {
                v.dataset.fallback = '1'
                v.src = cur.fallbackSrc
              } else {
                setFailed(true)
              }
            }}
          />
        )}
        {many && index < items.length - 1 && (
          <button
            type="button"
            onClick={() => onIndex(index + 1)}
            className="absolute right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-lg text-white hover:bg-white/20"
          >
            ›
          </button>
        )}
        {failed && (
          <p className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-center text-xs text-white/85">
            {t('tg.decodeFail')}
          </p>
        )}
      </div>
      {cur.caption?.trim() && (
        <p className="max-h-24 shrink-0 overflow-y-auto bg-black px-4 py-2 text-center text-xs text-white/80">
          {cur.caption}
        </p>
      )}
    </div>
  )
}

/** 倍速控制（悬浮媒体区右上角） */
function PlaybackSpeed({ rate, onRate }: { rate: number; onRate: (r: number) => void }) {
  const [open, setOpen] = useState(false)
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2]
  return (
    <div className="absolute right-2 top-2 z-10" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm hover:bg-black/70',
        )}
      >
        {rate}x
      </button>
      {open && (
        <div className="absolute right-0 top-8 flex flex-col overflow-hidden rounded-md border border-white/20 bg-black/85">
          {speeds.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onRate(s)
                setOpen(false)
              }}
              className={cn(
                'px-3 py-1.5 text-left text-[11px] text-white/80 hover:bg-white/10',
                s === rate && 'text-accent',
              )}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
