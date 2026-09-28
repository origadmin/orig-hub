import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '../ui/button'
import type { MediaEpisode, MediaItem } from '../../api/media'
import { attachEpisodeImages, listMediaItems, mediaItemUrl } from '../../api/media'
import { useTranslation } from '../../i18n'

/**
 * 集级挂图选择对话框（BUG-168）：列出媒体库里 kind=photo 的条目，多选后确认挂载。
 *
 * 后端是 **replace-all** 语义（一次请求重写该集的图片位），这里把「既有挂图 + 新勾选」
 * 一起下发，对用户的观感就是「勾选即追加」，不用理解接口语义。
 * 确认失败走 `onError`（toast），对话框保持打开、勾选不丢。
 */
export function EpisodeImagePickerDialog(props: {
  episode: MediaEpisode
  onClose: () => void
  onError: (msg: string) => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const { episode, onClose, onError, onChanged } = props
  const [photos, setPhotos] = useState<MediaItem[] | null>(null)
  /** 预填既有挂图：确认时一并下发（replace-all 下表现为「追加勾选」） */
  const [selected, setSelected] = useState<number[]>(
    episode.images?.map((i) => i.itemId) ?? [],
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    listMediaItems({ kind: 'photo', limit: 200 })
      .then((r) => {
        if (alive) setPhotos(r.items)
      })
      .catch((e: unknown) => {
        if (alive) onError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const confirm = async () => {
    setBusy(true)
    try {
      await attachEpisodeImages(episode.id, selected)
      onChanged()
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border-subtle bg-surface p-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="episode-image-picker"
      >
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[13px] font-semibold text-fg-strong">
            {t('media.episodeImagesTitle', { no: episode.episodeNo })}
          </h4>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('media.lightbox.close')}
            className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg-mid"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {photos === null ? (
            <p className="py-8 text-center text-xs text-muted">…</p>
          ) : photos.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">{t('media.noPhotosInLibrary')}</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {photos.map((p) => {
                const on = selected.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    title={p.title}
                    aria-pressed={on}
                    data-testid="episode-image-option"
                    className={`relative overflow-hidden rounded border transition-colors ${
                      on ? 'border-accent ring-1 ring-accent' : 'border-border-subtle hover:border-accent/50'
                    }`}
                  >
                    <img
                      src={mediaItemUrl(p.id)}
                      alt={p.title}
                      loading="lazy"
                      className="aspect-square h-full w-full object-cover"
                    />
                    {on && (
                      <span className="absolute inset-0 flex items-end justify-end bg-accent/20 p-0.5">
                        <span className="rounded-full bg-accent px-1 text-[9px] font-semibold leading-4 text-white">
                          ✓
                        </span>
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-muted">{t('media.selectedImages', { n: selected.length })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
              {t('media.imagePickerCancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 px-3 text-[11px]"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="episode-image-picker-confirm"
            >
              {t('media.imagePickerConfirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
