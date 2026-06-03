import { useState, useCallback } from 'react'
import { Pause, Play, X, Trash2, FileText, CheckCircle2, AlertCircle, Loader2, Copy, FolderOpen, MoreVertical } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { DownloadStatus } from '../types'
import { Progress } from './ui/progress'
import { OpenFileLocation } from '../../bindings/github.com/origadmin/orig-hub/internal/app/downloadservice'

interface DownloadItemProps {
  download: DownloadStatus
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  compact?: boolean
}

const statusLabels: Record<string, string> = {
  queued: 'Waiting',
  probing: 'Probing',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  error: 'Error',
}

function getProtocolBadge(url: string): { label: string; color: string } {
  if (url.startsWith('magnet:') || url.includes('.torrent')) return { label: 'BT', color: 'bg-purple-500/20 text-purple-400' }
  if (url.startsWith('ipfs://')) return { label: 'IPFS', color: 'bg-cyan-500/20 text-cyan-400' }
  if (url.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)(\?|$)/i)) return { label: 'Video', color: 'bg-rose-500/20 text-rose-400' }
  return { label: 'HTTP', color: 'bg-blue-500/20 text-blue-400' }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return ''
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${units[i]}`
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  if (mins > 60) {
    const hours = Math.floor(mins / 60)
    return `${hours}h ${mins % 60}m`
  }
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function DownloadItem({ download, onPause, onResume, onCancel, onRemove, compact }: DownloadItemProps) {
  const [copied, setCopied] = useState(false)
  const isActive = download.status === 'downloading' || download.status === 'queued' || download.status === 'probing'
  const isCompleted = download.status === 'completed'
  const isError = download.status === 'error'
  const isPaused = download.status === 'paused'
  const isFinished = isCompleted || isError || download.status === 'cancelled'
  const displayName = download.filename || download.url
  const protocol = getProtocolBadge(download.url)

  const handleCopyUrl = useCallback(() => {
    navigator.clipboard.writeText(download.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [download.url])

  const handleOpenFolder = useCallback(() => {
    if (download.dest_path) {
      OpenFileLocation(download.dest_path).catch(() => {})
    }
  }, [download.dest_path])

  if (compact) {
    return (
      <div className="group flex flex-col gap-2 rounded-xl border border-outline/10 bg-surface-container/40 p-3 hover:bg-surface-container/60 transition-colors">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            {isCompleted ? <CheckCircle2 className="h-4 w-4 text-green-500" /> :
             isError ? <AlertCircle className="h-4 w-4 text-red-500" /> :
             isActive ? <Loader2 className="h-4 w-4 text-primary animate-spin" /> :
             <FileText className="h-4 w-4 text-muted-foreground" />}
          </div>
          <span className="truncate text-[12px] font-medium flex-1">{displayName}</span>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${protocol.color}`}>{protocol.label}</span>
        </div>
        {!isFinished && (
          <Progress value={download.progress} className="h-1" />
        )}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{download.progress.toFixed(0)}%</span>
          {download.speed > 0 && <span>{formatSpeed(download.speed)}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-3 border-b border-outline/10 px-4 py-3 hover:bg-on-surface/[0.03] transition-colors">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        {isCompleted ? (
          <CheckCircle2 className="h-5 w-5 text-green-500" />
        ) : isError ? (
          <AlertCircle className="h-5 w-5 text-red-500" />
        ) : isActive ? (
          <Loader2 className="h-5 w-5 text-primary animate-spin" />
        ) : (
          <FileText className="h-5 w-5 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-medium">{displayName}</span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${protocol.color}`}>{protocol.label}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {download.status === 'downloading' && (
              <button onClick={() => onPause(download.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Pause">
                <Pause className="h-3.5 w-3.5" />
              </button>
            )}
            {isPaused && (
              <button onClick={() => onResume(download.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Resume">
                <Play className="h-3.5 w-3.5" />
              </button>
            )}
            {isActive && (
              <button onClick={() => onCancel(download.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Cancel">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {isFinished && (
              <button onClick={() => onRemove(download.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Remove">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}

            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="More actions">
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[200px] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md z-50"
                  sideOffset={4}
                  align="end"
                >
                  {isPaused && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={() => onResume(download.id)}
                    >
                      <Play className="h-4 w-4" /> Resume
                    </DropdownMenu.Item>
                  )}
                  {download.status === 'downloading' && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={() => onPause(download.id)}
                    >
                      <Pause className="h-4 w-4" /> Pause
                    </DropdownMenu.Item>
                  )}
                  {isActive && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={() => onCancel(download.id)}
                    >
                      <X className="h-4 w-4" /> Cancel
                    </DropdownMenu.Item>
                  )}
                  {isFinished && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={() => onRemove(download.id)}
                    >
                      <Trash2 className="h-4 w-4" /> Remove from List
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                    onSelect={handleCopyUrl}
                  >
                    <Copy className="h-4 w-4" /> {copied ? 'Copied!' : 'Copy URL'}
                  </DropdownMenu.Item>
                  {isCompleted && download.dest_path && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={handleOpenFolder}
                    >
                      <FolderOpen className="h-4 w-4" /> Open File Location
                    </DropdownMenu.Item>
                  )}
                  {isCompleted && (
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground"
                      onSelect={() => handleCopyUrl()}
                    >
                      <FileText className="h-4 w-4" /> Re-download
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>

        {!isFinished && (
          <div className="mt-1.5 flex items-center gap-3">
            <Progress value={download.progress} className="h-1.5 flex-1" />
            <span className="shrink-0 text-xs text-muted-foreground w-12 text-right">{download.progress.toFixed(1)}%</span>
          </div>
        )}

        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {isActive && (
            <>
              <span>{formatBytes(download.downloaded)}{download.total_size > 0 ? ` / ${formatBytes(download.total_size)}` : ''}</span>
              {download.speed > 0 && <span>{formatSpeed(download.speed)}</span>}
              {download.eta > 0 && <span>ETA {formatTime(download.eta)}</span>}
            </>
          )}
          {isCompleted && (
            <span>{formatBytes(download.total_size)}</span>
          )}
          {isError && (
            <span className="text-destructive">{download.error || 'Download failed'}</span>
          )}
          {isPaused && (
            <span>{formatBytes(download.downloaded)}{download.total_size > 0 ? ` / ${formatBytes(download.total_size)}` : ''}</span>
          )}
          <span className={`ml-auto ${
            isError ? 'text-destructive' :
            isCompleted ? 'text-green-600 dark:text-green-400' :
            isActive ? 'text-primary' :
            'text-muted-foreground'
          }`}>
            {statusLabels[download.status] || download.status}
          </span>
        </div>
      </div>
    </div>
  )
}
