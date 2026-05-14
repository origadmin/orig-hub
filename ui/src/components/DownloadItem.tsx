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
}

export function DownloadItem({ download, onPause, onResume, onCancel }: DownloadItemProps) {
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
    if (seconds === 0) return ''
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    if (mins > 60) {
      const hours = Math.floor(mins / 60)
      const remainingMins = mins % 60
      return `${hours}h ${remainingMins}m`
    }
    return `${mins}m ${secs}s`
  }

  const statusVariant = download.status === 'downloading' ? 'default' : 'secondary'
  const isActive = download.status === 'downloading' || download.status === 'queued'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <ProtocolBadge url={download.url} />
          <CardTitle className="text-sm font-medium truncate">{download.filename}</CardTitle>
        </div>
        <Badge variant={statusVariant}>
          {download.status}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={download.progress} />
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>
            {formatBytes(download.downloaded)} / {formatBytes(download.total_size)}
          </span>
          <span>{download.progress.toFixed(1)}%</span>
        </div>
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>{formatSpeed(download.speed)}</span>
          <span>ETA: {formatTime(download.eta)}</span>
        </div>
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
        </div>
      </CardContent>
    </Card>
  )
}
