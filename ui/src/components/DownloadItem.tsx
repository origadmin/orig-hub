import { DownloadStatus } from '../types'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Progress } from './ui/progress'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { ProtocolBadge } from './ProtocolBadge'

interface DownloadItemProps {
  download: DownloadStatus
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}

const statusLabels: Record<string, string> = {
  queued: 'Queued',
  probing: 'Probing',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Error',
}

export function DownloadItem({ download, onPause, onResume, onCancel, onRemove }: DownloadItemProps) {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const formatSpeed = (bytesPerSec: number): string => {
    if (bytesPerSec === 0) return ''
    const k = 1024
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
    return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${units[i]}`
  }

  const formatTime = (seconds: number): string => {
    if (seconds <= 0) return '--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    if (mins > 60) {
      const hours = Math.floor(mins / 60)
      const remainingMins = mins % 60
      return `${hours}h ${remainingMins}m`
    }
    if (mins > 0) {
      return `${mins}m ${secs}s`
    }
    return `${secs}s`
  }

  const isActive = download.status === 'downloading' || download.status === 'queued' || download.status === 'probing'
  const isCompleted = download.status === 'completed'
  const isError = download.status === 'error'
  const isCancelled = download.status === 'cancelled'
  const isFinished = isCompleted || isError || isCancelled
  const statusVariant = isActive ? 'default' : isError ? 'destructive' : 'secondary'

  const displayName = download.filename || download.url

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <ProtocolBadge url={download.url} />
          <CardTitle className="text-sm font-medium truncate">{displayName}</CardTitle>
        </div>
        <Badge variant={statusVariant}>
          {statusLabels[download.status] || download.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isFinished && (
          <Progress value={download.progress} />
        )}
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>
            {formatBytes(download.downloaded)}{download.total_size > 0 ? ` / ${formatBytes(download.total_size)}` : ''}
          </span>
          <span>{download.progress > 0 ? `${download.progress.toFixed(1)}%` : ''}</span>
        </div>
        {download.speed > 0 && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>{formatSpeed(download.speed)}</span>
            <span>ETA: {formatTime(download.eta)}</span>
          </div>
        )}
        {isError && download.error && (
          <div className="text-sm text-destructive">{download.error}</div>
        )}
        {isCompleted && download.dest_path && (
          <div className="text-sm text-muted-foreground truncate" title={download.dest_path}>
            Saved to: {download.dest_path}
          </div>
        )}
        <div className="flex gap-2">
          {download.status === 'downloading' ? (
            <Button variant="outline" size="sm" onClick={() => onPause(download.id)}>
              Pause
            </Button>
          ) : download.status === 'paused' ? (
            <Button variant="outline" size="sm" onClick={() => onResume(download.id)}>
              Resume
            </Button>
          ) : null}
          {isActive && (
            <Button variant="destructive" size="sm" onClick={() => onCancel(download.id)}>
              Cancel
            </Button>
          )}
          {isFinished && (
            <Button variant="outline" size="sm" onClick={() => onRemove(download.id)}>
              Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
