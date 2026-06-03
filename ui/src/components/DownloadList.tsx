import { DownloadStatus } from '../types'
import { DownloadItem } from './DownloadItem'

interface DownloadListProps {
  downloads: DownloadStatus[]
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  viewMode?: 'list' | 'grid'
}

export function DownloadList({ downloads, onPause, onResume, onCancel, onRemove, viewMode = 'list' }: DownloadListProps) {
  if (downloads.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No downloads yet. Click New to add a download.
      </div>
    )
  }

  if (viewMode === 'grid') {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
        {downloads.map((download) => (
          <DownloadItem
            key={download.id}
            download={download}
            onPause={onPause}
            onResume={onResume}
            onCancel={onCancel}
            onRemove={onRemove}
            compact
          />
        ))}
      </div>
    )
  }

  return (
    <div>
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
