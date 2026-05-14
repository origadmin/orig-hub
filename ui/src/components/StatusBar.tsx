import { ArrowDown, Activity, HardDrive } from 'lucide-react'
import { useStore } from '../store/useStore'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s'
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${units[i]}`
}

export function StatusBar() {
  const downloads = useStore((s) => s.downloads)

  const active = downloads.filter((d) => d.status === 'downloading')
  const activeCount = active.length
  const totalSpeed = active.reduce((sum, d) => sum + d.speed, 0)
  const totalDownloaded = downloads.reduce((sum, d) => sum + d.downloaded, 0)

  return (
    <div className="flex items-center gap-6 border-t bg-card px-4 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5" />
        <span>{activeCount} active</span>
      </div>
      <div className="flex items-center gap-1.5">
        <ArrowDown className="h-3.5 w-3.5" />
        <span>{formatSpeed(totalSpeed)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <HardDrive className="h-3.5 w-3.5" />
        <span>{formatBytes(totalDownloaded)}</span>
      </div>
    </div>
  )
}
