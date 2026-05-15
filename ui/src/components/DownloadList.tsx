import { DownloadStatus } from '../types'
import { DownloadItem } from './DownloadItem'

interface DownloadListProps {
  downloads: DownloadStatus[]
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}

export function DownloadList({ downloads, onPause, onResume, onCancel, onRemove }: DownloadListProps) {
  if (downloads.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        No downloads yet
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {downloads.map((download) => (
        <DownloadItem
          key={download.id}
          download={download}
          onPause={onPause}
          onResume={onResume}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}
