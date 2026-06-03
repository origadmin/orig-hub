import { ReactNode } from 'react'
import { Download, CheckCircle, Settings, Plus, Play, Pause, Trash2, Moon, Sun, Monitor, FolderOpen, FileText, Zap, Shield, Globe, BarChart3, Folder, Info, Wrench, ClipboardList } from 'lucide-react'
import { TitleBar } from './TitleBar'
import { useStore } from '../store/useStore'

interface MainLayoutProps {
  children: ReactNode
  activeTab: string
  onTabChange: (tab: string) => void
  onAddDownload: () => void
  onPauseAll: () => void
  onResumeAll: () => void
}

const navItems = [
  { value: 'downloads', label: 'Downloading', icon: Download },
  { value: 'history', label: 'Completed', icon: CheckCircle },
  { value: 'settings', label: 'Settings', icon: Settings },
]

export function MainLayout({ children, activeTab, onTabChange, onAddDownload, onPauseAll, onResumeAll }: MainLayoutProps) {
  const { theme, toggleTheme } = useStore()
  const downloads = useStore((s) => s.downloads)
  const downloadingCount = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'probing').length
  const ThemeIcon = theme === 'light' ? Moon : theme === 'dark' ? Sun : Monitor

  const counts: Record<string, number> = {
    downloads: downloadingCount,
    history: 0,
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground select-none">
      <TitleBar />

      {/* Toolbar - full width, above sidebar */}
      <Toolbar
        onAdd={onAddDownload}
        onPauseAll={onPauseAll}
        onResumeAll={onResumeAll}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="flex w-48 flex-col border-r bg-muted/30">
          <nav className="flex flex-col gap-0.5 px-2 pt-2">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = activeTab === item.value
              const count = counts[item.value] ?? 0
              return (
                <button
                  key={item.value}
                  onClick={() => onTabChange(item.value)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-colors ${
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  <Icon className="h-[18px] w-[18px]" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {count > 0 && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                      active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>

          <div className="mt-auto border-t px-2 py-2">
            <button
              onClick={toggleTheme}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ThemeIcon className="h-[18px] w-[18px]" />
              <span>Theme</span>
            </button>
          </div>
        </aside>

        <div className="flex flex-1 flex-col overflow-hidden">
          <main className="flex-1 overflow-auto">{children}</main>
          <StatusBar />
        </div>
      </div>
    </div>
  )
}

function Toolbar({ onAdd, onPauseAll, onResumeAll }: { onAdd: () => void; onPauseAll: () => void; onResumeAll: () => void }) {
  const downloads = useStore((s) => s.downloads)
  const hasActive = downloads.some((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'probing')
  const hasPaused = downloads.some((d) => d.status === 'paused')

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-card px-2">
      <button
        onClick={onAdd}
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        <Plus className="h-4 w-4" />
        New
      </button>
      <div className="mx-1 h-5 w-px bg-border" />
      <button
        onClick={onResumeAll}
        disabled={!hasPaused}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 transition-colors"
        title="Resume All"
      >
        <Play className="h-4 w-4" />
      </button>
      <button
        onClick={onPauseAll}
        disabled={!hasActive}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 transition-colors"
        title="Pause All"
      >
        <Pause className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Clear Finished"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <div className="mx-1 h-5 w-px bg-border" />
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Open Download Folder"
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Speed Limit"
      >
        <BarChart3 className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Checksum Verify"
      >
        <Shield className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Browser Extension"
      >
        <Globe className="h-4 w-4" />
      </button>
      <div className="mx-1 h-5 w-px bg-border" />
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Schedule Downloads"
      >
        <ClipboardList className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Speed Test"
      >
        <Zap className="h-4 w-4" />
      </button>
      <div className="flex-1" />
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="Settings"
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        title="About"
      >
        <Info className="h-4 w-4" />
      </button>
    </div>
  )
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s'
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(2))} ${units[i]}`
}

function StatusBar() {
  const downloads = useStore((s) => s.downloads)
  const active = downloads.filter((d) => d.status === 'downloading')
  const totalSpeed = active.reduce((sum, d) => sum + d.speed, 0)

  return (
    <div className="flex items-center gap-4 border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
      <span>{active.length} downloading</span>
      <span>{formatSpeed(totalSpeed)}</span>
    </div>
  )
}
