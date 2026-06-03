import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Window } from '@wailsio/runtime'
import { useStore } from './store/useStore'
import { AddDownloadDialog } from './components/AddDownloadDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { FAB } from './components/FAB'
import { useWailsEvents, useWailsActions, useDownloadPolling } from './hooks/useWailsEvents'
import { Events } from '@wailsio/runtime'
import { toast } from 'sonner'
import {
  Download, CheckCircle2, Video, PlayCircle, Globe, Clock, Settings,
  Plus, Search, List, Grid3X3, Play, Pause, FolderOpen, Trash2,
  ChevronRight, ChevronLeft, Minus, Square, X, Zap, HardDrive,
  ArrowUp, ArrowDown, ArrowUpRight, AlertCircle, FileText,
  Music, Image, File, RotateCcw, CalendarPlus, Timer, Calendar,
  MonitorSmartphone, CircleDot, RefreshCw, CloudDownload,
  SortAsc, User, BookOpen, SkipBack, SkipForward, Upload,
  Database, Shield, Mail, Terminal, Bell, Volume2, Subtitles,
  Cast, PictureInPicture2, Maximize2, Shuffle, Repeat, GripVertical,
  Filter, Activity, PauseCircle, CloudCog, CalendarDays, Repeat2,
  History, FolderSymlink, Magnet, Share, Power, Check
} from 'lucide-react'

type PageRoute = 'downloading' | 'completed' | 'library' | 'player' | 'browser' | 'scheduler' | 'settings'

const SIDEBAR_WIDTH = 240
const TITLEBAR_HEIGHT = 38
const STATUSBAR_HEIGHT = 32

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 KB/s'
  const k = 1024
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))} ${units[i]}`
}

function compactSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0B/s'
  const k = 1024
  const units = ['B/s', 'K/s', 'M/s', 'G/s']
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1))}${units[i]}`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function getProtocolInfo(url: string): { label: string; color: string; bg: string; border: string } {
  if (url.startsWith('magnet:') || url.includes('.torrent')) return { label: 'BT', color: 'text-secondary', bg: 'bg-secondary/10', border: 'border-secondary/20' }
  if (url.startsWith('ipfs://')) return { label: 'IPFS', color: 'text-secondary', bg: 'bg-secondary/10', border: 'border-secondary/20' }
  if (url.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)(\?|$)/i)) return { label: 'Video', color: 'text-secondary', bg: 'bg-secondary/10', border: 'border-secondary/20' }
  return { label: 'HTTP', color: 'text-on-surface-variant', bg: 'bg-white/10', border: 'border-white/20' }
}

function getFileIcon(url: string, filename: string) {
  const ext = (filename || url).split('.').pop()?.toLowerCase() || ''
  if (['mkv', 'mp4', 'avi', 'mov', 'wmv', 'webm'].includes(ext)) return <Video className="h-7 w-7" />
  if (['mp3', 'flac', 'wav', 'aac', 'ogg'].includes(ext)) return <Music className="h-7 w-7" />
  if (['jpg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return <Image className="h-7 w-7" />
  if (['exe', 'msi', 'dmg', 'deb', 'rpm'].includes(ext)) return <Terminal className="h-7 w-7" />
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <File className="h-7 w-7" />
  if (['iso'].includes(ext)) return <HardDrive className="h-7 w-7" />
  return <FileText className="h-7 w-7" />
}

function getWindowType(): 'main' | 'float' {
  if ((window as any).__OW__ === 'float') return 'float'
  return 'main'
}

function App() {
  const wt = getWindowType()
  if (wt === 'float') return <FloatBar />
  return <MainApp />
}

function FloatBar() {
  const downloads = useStore((s) => s.downloads)
  // TODO: 后续完善 — 贴边/展开/自动隐藏状态机 (代码已完整保留, 入口已关闭)
  const [expanded, setExpanded] = useState(false)
  const [snapDirection, setSnapDirection] = useState<'none' | 'top' | 'bottom' | 'left' | 'right'>('none')
  const [snapState, setSnapState] = useState<'normal' | 'snapped' | 'autohide'>('normal')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  // TODO: 后续完善 — 持久化到 settings
  const [floatVisible, setFloatVisible] = useState<'always' | 'downloading' | 'never'>('always')

  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'probing')
  const paused = downloads.filter((d) => d.status === 'paused')
  const hasError = downloads.some((d) => d.status === 'error')
  const dlSpeed = active.reduce((sum, d) => sum + d.speed, 0)
  const ulSpeed = active.reduce((sum, d) => sum + d.speed * 0.05, 0)
  const isDownloading = active.length > 0
  const isPaused = paused.length > 0 && active.length === 0
  const activeCount = downloads.filter((d) => d.status !== 'completed' && d.status !== 'cancelled' && d.status !== 'error').length
  const totalProgress = active.length > 0 ? active.reduce((sum, d) => sum + (d.progress || 0), 0) / active.length : 0
  const isSnapped = snapState === 'snapped' && snapDirection !== 'none'

  useEffect(() => {
    document.documentElement.classList.add('float-window')
    document.body.style.setProperty('margin', '0', 'important')
    document.body.style.setProperty('padding', '0', 'important')
    document.body.style.setProperty('overflow', 'hidden', 'important')
  }, [])

  // TODO: 后续完善 — 启用贴边/自动隐藏时恢复以下事件订阅
  // useEffect(() => {
  //   const off = Events.On('float:snap-state', (event: unknown) => { ... })
  //   return () => { off() }
  // }, [])
  //
  // useEffect(() => {
  //   const off = Events.On('float:expand-complete', () => {
  //     setExpanded(true)
  //   })
  //   return () => { off() }
  // }, [])

  useEffect(() => {
    if (!contextMenu) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.float-context-menu')) {
        setContextMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  useDownloadPolling()

  // TODO: 后续完善 — 启用展开/折叠时恢复以下入口
  // const handleMouseEnter = () => {
  //   try { Events.Emit('float:expand') } catch { /* */ }
  // }
  //
  // const handleMouseLeave = () => {
  //   setExpanded(false)
  //   try { Events.Emit('float:collapse') } catch { /* */ }
  // }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const BG = '#1c1c1f'
  const strokeColor = isDownloading ? '#34d399' : isPaused ? '#fbbf24' : hasError ? '#ef4444' : '#71717a'
  const ringProgress = isFinite(totalProgress) ? Math.min(Math.max(totalProgress, 0), 100) : 0
  const circumference = 2 * Math.PI * 14
  const offset = circumference - (circumference * ringProgress) / 100

  // Speed percentage for snapped bars (based on 10MB/s max)
  const maxSpeed = 10 * 1024 * 1024
  const dlPercent = Math.min(Math.max((dlSpeed / maxSpeed) * 100, 0), 100) || 0
  const ulPercent = Math.min(Math.max((ulSpeed / maxSpeed) * 100, 0), 100) || 0

  // === Snapped / Autohide state (TODO: 后续完善 — 入口已关闭) ===
  if (snapState === 'autohide' || isSnapped) {
    if (snapDirection === 'top' || snapDirection === 'bottom') {
      return (
        <div className="h-full w-full flex items-center gap-0.5 px-1" style={{ background: BG }}>
          <ArrowDown className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
          <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${dlPercent}%`, background: 'linear-gradient(90deg, #34d399, #10b981)' }} />
          </div>
          <ArrowUp className="h-2.5 w-2.5 text-blue-400 shrink-0" />
          <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${ulPercent}%`, background: 'linear-gradient(90deg, #60a5fa, #3b82f6)' }} />
          </div>
        </div>
      )
    }
    if (snapDirection === 'left' || snapDirection === 'right') {
      return (
        <div className="h-full w-full flex flex-col items-center gap-0.5 py-1" style={{ background: BG }}>
          <ArrowDown className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
          <div className="flex-1 w-1 bg-white/10 rounded-full overflow-hidden flex flex-col-reverse">
            <div className="w-full rounded-full transition-all duration-500" style={{ height: `${dlPercent}%`, background: 'linear-gradient(0deg, #34d399, #10b981)' }} />
          </div>
          <ArrowUp className="h-2.5 w-2.5 text-blue-400 shrink-0" />
          <div className="flex-1 w-1 bg-white/10 rounded-full overflow-hidden flex flex-col-reverse">
            <div className="w-full rounded-full transition-all duration-500" style={{ height: `${ulPercent}%`, background: 'linear-gradient(0deg, #60a5fa, #3b82f6)' }} />
          </div>
        </div>
      )
    }
    return (
      <div className="h-full w-full flex items-center gap-0.5 px-1" style={{ background: BG }}>
        <ArrowDown className="h-2.5 w-2.5 text-zinc-500 shrink-0" />
        <div className="flex-1 h-1 bg-white/10 rounded-full" />
        <ArrowUp className="h-2.5 w-2.5 text-zinc-500 shrink-0" />
        <div className="flex-1 h-1 bg-white/10 rounded-full" />
      </div>
    )
  }

  // === Collapsed state (200×44) ===
  const collapsedContent = (
    <>
      <div className="relative flex items-center justify-center shrink-0" style={{ width: 36, height: 36 }}>
        <svg width="36" height="36" viewBox="0 0 36 36" className="absolute inset-0" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2.5" />
          {active.length > 0 && (
            <circle cx="18" cy="18" r="14" fill="none" stroke={strokeColor} strokeWidth="2.5"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 500ms ease-out' }}
            />
          )}
        </svg>
        {isDownloading ? <Download className="relative z-10" style={{ width: 20, height: 20, color: '#34d399' }} />
          : isPaused ? <PauseCircle className="relative z-10" style={{ width: 20, height: 20, color: '#fbbf24' }} />
          : hasError ? <AlertCircle className="relative z-10" style={{ width: 20, height: 20, color: '#ef4444' }} />
          : <Download className="relative z-10" style={{ width: 20, height: 20, color: '#71717a' }} />}
      </div>
      <div className="flex items-center gap-0.5 min-w-0" style={{ fontFamily: "'Cascadia Code', 'Fira Code', monospace", fontSize: 11, fontWeight: 700 }}>
        <ArrowDown className="shrink-0" style={{ width: 12, height: 12, color: '#34d399' }} />
        <span className="whitespace-nowrap tabular-nums" style={{ color: '#34d399' }}>{compactSpeed(dlSpeed)}</span>
        <ArrowUp className="shrink-0" style={{ width: 12, height: 12, color: '#60a5fa' }} />
        <span className="whitespace-nowrap tabular-nums" style={{ color: '#60a5fa' }}>{compactSpeed(ulSpeed)}</span>
      </div>
    </>
  )

  if (!expanded) {
    return (
      <div className="h-full w-full flex items-center gap-1.5 px-2 rounded-lg overflow-hidden"
        style={{ background: BG, '--wails-draggable': 'drag', '--default-contextmenu': 'hide' } as React.CSSProperties}
        onContextMenu={handleContextMenu}
        onDoubleClick={() => { try { Events.Emit('floating:exit') } catch { /* */ } }}>
        {collapsedContent}
        {contextMenu && (
          <FloatContextMenu x={contextMenu.x} y={contextMenu.y} floatVisible={floatVisible} setFloatVisible={setFloatVisible} onClose={() => setContextMenu(null)} />
        )}
      </div>
    )
  }

  // === Expanded state (320×44) (TODO: 后续完善 — 入口已关闭) ===
  return (
    <div className="h-full w-full flex items-center gap-1.5 px-2 rounded-lg overflow-hidden"
      style={{ background: BG, '--wails-draggable': 'drag', '--default-contextmenu': 'hide' } as React.CSSProperties}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => { try { Events.Emit('floating:exit') } catch { /* */ } }}>
      {collapsedContent}
      <span className="shrink-0" style={{ marginLeft: 'auto', fontFamily: "'Cascadia Code', monospace", fontSize: 11, fontWeight: 700, color: '#a1a1aa' }}>
        {activeCount} active
      </span>
      {contextMenu && (
        <FloatContextMenu x={contextMenu.x} y={contextMenu.y} floatVisible={floatVisible} setFloatVisible={setFloatVisible} onClose={() => setContextMenu(null)} />
      )}
    </div>
  )
}

interface FloatContextMenuProps {
  x: number
  y: number
  floatVisible: 'always' | 'downloading' | 'never'
  setFloatVisible: (v: 'always' | 'downloading' | 'never') => void
  onClose: () => void
}

function FloatContextMenu({ x, y, floatVisible, setFloatVisible, onClose }: FloatContextMenuProps) {
  const wailsActions = useWailsActions()
  const { downloads } = useStore()
  const [showSubmenu, setShowSubmenu] = useState(false)
  const hasActive = downloads.some((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'probing')
  const hasPaused = downloads.some((d) => d.status === 'paused')
  const MENU_WIDTH = 200
  const SUBMENU_WIDTH = 180
  const MENU_ITEM_HEIGHT = 28
  const MENU_MAX_HEIGHT = 320

  const safeX = Math.min(Math.max(x, 4), window.innerWidth - MENU_WIDTH - 4)
  const safeY = Math.min(Math.max(y, 4), window.innerHeight - MENU_MAX_HEIGHT - 4)
  const submenuX = safeX + MENU_WIDTH - 4
  const submenuY = safeY + 4 * MENU_ITEM_HEIGHT + 8

  const handleAction = (action: () => void) => {
    return () => {
      try { action() } catch { /* */ }
      onClose()
    }
  }

  const pauseAll = async () => { for (const d of downloads.filter(d => d.status === 'downloading')) { try { await wailsActions.pauseDownload(d.id) } catch {} } }
  const resumeAll = async () => { for (const d of downloads.filter(d => d.status === 'paused')) { try { await wailsActions.resumeDownload(d.id) } catch {} } }

  const submenuItems = [
    { value: 'always', label: '总是显示', check: floatVisible === 'always' },
    { value: 'downloading', label: '仅下载时显示', check: floatVisible === 'downloading' },
    { value: 'never', label: '永久关闭', check: floatVisible === 'never' },
  ] as const

  return (
    <div
      className="float-context-menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: safeY,
        left: safeX,
        width: MENU_WIDTH,
        zIndex: 9999,
        background: 'rgba(40, 40, 44, 0.92)',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 8,
        padding: 4,
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
        animation: 'ctxMenuIn 100ms ease-out',
        transformOrigin: 'top left',
        userSelect: 'none',
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      <MenuItem label="隐藏主界面" onClick={handleAction(() => { try { Events.Emit('float:hide-main') } catch { /* */ } })} />
      <MenuDivider />
      <MenuItem icon={<Plus className="h-3.5 w-3.5" />} label="新建任务" onClick={handleAction(() => { try { Events.Emit('download:open-add-dialog') } catch { /* */ } })} />
      <MenuDivider />
      <MenuItem icon={<Play className="h-3.5 w-3.5" />} label="开始全部任务" disabled={!hasPaused} onClick={handleAction(resumeAll)} />
      <MenuItem icon={<Pause className="h-3.5 w-3.5" />} label="暂停全部任务" disabled={!hasActive} onClick={handleAction(pauseAll)} />
      <MenuItem
        icon={<Settings className="h-3.5 w-3.5" />}
        label="悬浮设置"
        hasSubmenu
        active={showSubmenu}
        onMouseEnterItem={() => setShowSubmenu(true)}
        onClick={() => setShowSubmenu(true)}
      />
      <MenuDivider />
      <MenuItem icon={<Power className="h-3.5 w-3.5" />} label="退出 Orig Hub" danger onClick={handleAction(() => { try { Events.Emit('app:quit') } catch { /* */ } })} />

      {showSubmenu && (
        <div
          onMouseEnter={() => setShowSubmenu(true)}
          onMouseLeave={() => setShowSubmenu(false)}
          style={{
            position: 'fixed',
            top: Math.min(submenuY, window.innerHeight - 4 * MENU_ITEM_HEIGHT - 8),
            left: Math.min(submenuX, window.innerWidth - SUBMENU_WIDTH - 4),
            width: SUBMENU_WIDTH,
            zIndex: 10000,
            background: 'rgba(40, 40, 44, 0.92)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 8,
            padding: 4,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3)',
            animation: 'ctxMenuIn 100ms ease-out',
          }}
        >
          {submenuItems.map((opt) => (
            <button
              key={opt.value}
              onClick={handleAction(() => setFloatVisible(opt.value))}
              className="float-menu-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                height: MENU_ITEM_HEIGHT,
                padding: '0 10px',
                border: 'none',
                background: 'transparent',
                color: '#e4e4e7',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 400,
                textAlign: 'left',
                transition: 'background 80ms ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, flexShrink: 0, color: opt.check ? '#34d399' : 'transparent' }}>
                {opt.check && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              <span style={{ flex: 1 }}>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  icon?: React.ReactNode
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  hasSubmenu?: boolean
  active?: boolean
  onClick?: () => void
  onMouseEnterItem?: () => void
}

function MenuItem({ icon, label, shortcut, danger, disabled, hasSubmenu, active, onClick, onMouseEnterItem }: MenuItemProps) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={(e) => {
        onMouseEnterItem?.()
        if (!disabled && !danger) e.currentTarget.style.background = active ? 'rgba(255, 255, 255, 0.10)' : 'rgba(255, 255, 255, 0.08)'
      }}
      disabled={disabled}
      className="float-menu-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        height: 28,
        padding: '0 10px',
        border: 'none',
        background: active ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
        color: disabled ? 'rgba(228, 228, 231, 0.4)' : danger ? '#f87171' : '#e4e4e7',
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
        fontWeight: 400,
        textAlign: 'left',
        transition: 'background 80ms ease',
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', system-ui, sans-serif",
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? 'rgba(255, 255, 255, 0.08)' : 'transparent'
      }}
    >
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, color: disabled ? 'rgba(161, 161, 170, 0.4)' : danger ? '#f87171' : '#a1a1aa', flexShrink: 0 }}>{icon}</span>}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {shortcut && <span style={{ fontSize: 10, color: 'rgba(161, 161, 170, 0.6)', fontFamily: "'Cascadia Code', monospace", marginLeft: 'auto', paddingLeft: 8 }}>{shortcut}</span>}
      {hasSubmenu && <ChevronRight className="h-3 w-3" style={{ color: 'rgba(161, 161, 170, 0.6)', marginLeft: 'auto', flexShrink: 0 }} />}
    </button>
  )
}

function MenuDivider() {
  return <div style={{ height: 1, background: 'rgba(255, 255, 255, 0.06)', margin: '3px 0' }} />
}

const NAV_ITEMS: { route: PageRoute; labelKey: string; icon: React.ReactNode }[] = [
  { route: 'downloading', labelKey: 'nav.downloads', icon: <Download className="h-5 w-5" /> },
  { route: 'completed', labelKey: 'download.status.completed', icon: <CheckCircle2 className="h-5 w-5" /> },
  { route: 'library', labelKey: 'nav.library', icon: <BookOpen className="h-5 w-5" /> },
  { route: 'player', labelKey: 'nav.player', icon: <PlayCircle className="h-5 w-5" /> },
  { route: 'browser', labelKey: 'nav.browser', icon: <Globe className="h-5 w-5" /> },
  { route: 'scheduler', labelKey: 'nav.scheduler', icon: <Clock className="h-5 w-5" /> },
]

type StatusFilter = 'all' | 'active' | 'paused' | 'error' | 'queued'
type ProtocolFilter = 'all' | 'HTTP' | 'BT' | 'IPFS' | 'Video'

function MainApp() {
  const { t } = useTranslation()
  const [page, setPage] = useState<PageRoute>('downloading')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [defaultDir, setDefaultDir] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>('all')
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [selectedDownloadId, setSelectedDownloadId] = useState<string | null>(null)
  const { downloads } = useStore()

  useWailsEvents()
  useDownloadPolling()
  const wailsActions = useWailsActions()

  useEffect(() => {
    wailsActions.getDefaultDownloadDir().then((dir) => {
      if (dir) { setDefaultDir(dir); useStore.getState().updateSettings({ downloadDirectory: dir }) }
    }).catch(() => {})
  }, [wailsActions])

  useEffect(() => {
    const off1 = Events.On('download:open-add-dialog', () => setDialogOpen(true))
    const off2 = Events.On('navigate:settings', () => setPage('settings'))
    return () => { off1(); off2() }
  }, [])

  const handleAddDownload = async (url: string, filename?: string, destPath?: string) => {
    try {
      await wailsActions.addDownload(url, destPath || defaultDir || '', filename || '', [], {})
      toast.success(t('download.addedToast'))
    } catch (err) { toast.error(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  const handlePause = async (id: string) => { try { await wailsActions.pauseDownload(id) } catch (err) { toast.error(String(err)) } }
  const handleResume = async (id: string) => { try { await wailsActions.resumeDownload(id) } catch (err) { toast.error(String(err)) } }
  const handleCancel = async (id: string) => { try { await wailsActions.cancelDownload(id) } catch (err) { toast.error(String(err)) } }
  const handleRemove = async (id: string) => { try { await wailsActions.removeDownload(id); useStore.getState().removeDownload(id) } catch (err) { toast.error(String(err)) } }
  const handlePauseAll = async () => { for (const d of downloads.filter(d => d.status === 'downloading')) { try { await wailsActions.pauseDownload(d.id) } catch {} } }
  const handleResumeAll = async () => { for (const d of downloads.filter(d => d.status === 'paused')) { try { await wailsActions.resumeDownload(d.id) } catch {} } }

  const activeDownloads = useMemo(() => downloads.filter(d => !['completed', 'cancelled'].includes(d.status)), [downloads])
  const completedDownloads = useMemo(() => downloads.filter(d => ['completed', 'cancelled', 'error'].includes(d.status)), [downloads])
  const downloadingCount = useMemo(() => downloads.filter(d => d.status === 'downloading' || d.status === 'queued' || d.status === 'probing').length, [downloads])
  const totalSpeed = useMemo(() => downloads.filter(d => d.status === 'downloading').reduce((sum, d) => sum + d.speed, 0), [downloads])
  const totalDownloaded = useMemo(() => downloads.reduce((sum, d) => sum + d.downloaded, 0), [downloads])
  const selectedDownload = useMemo(() => downloads.find(d => d.id === selectedDownloadId), [downloads, selectedDownloadId])
  const recentPaths = useMemo(() => [...new Set(downloads.map(d => d.dest_path).filter(Boolean))], [downloads])

  return (
    <div className="flex h-screen flex-col bg-background text-on-surface select-none overflow-hidden">
      <div className="flex shrink-0 border-b border-white/10 bg-surface/70 backdrop-blur-xl" style={{ height: TITLEBAR_HEIGHT }}>
        <div className="flex shrink-0 items-center px-3" style={{ width: SIDEBAR_WIDTH }}>
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/20">
            <ArrowDown className="h-3.5 w-3.5 text-primary" />
          </div>
          <span className="ml-2 text-sm font-semibold text-primary">{t('common.appName')}</span>
        </div>
        <div className="flex flex-1 items-center justify-center cursor-default" style={{ '--wails-draggable': 'drag', '--default-contextmenu': 'hide' } as React.CSSProperties} onDoubleClick={() => Window.ToggleMaximise()}>
          <span className="text-xs text-on-surface/40">{t('common.appName')}</span>
        </div>
        <div className="flex shrink-0" style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}>
          <button onClick={() => Events.Emit('floating:enter')} className="flex items-center justify-center text-on-surface/50 hover:bg-on-surface/10 hover:text-on-surface transition-colors" style={{ width: 46, height: TITLEBAR_HEIGHT }}><Minus className="h-3.5 w-3.5" /></button>
          <button onClick={() => Window.Maximise()} className="flex items-center justify-center text-on-surface/50 hover:bg-on-surface/10 hover:text-on-surface transition-colors" style={{ width: 46, height: TITLEBAR_HEIGHT }}><Square className="h-3 w-3" /></button>
          <button onClick={() => Events.Emit('floating:enter')} className="flex items-center justify-center text-on-surface/50 hover:bg-red-500/90 hover:text-white transition-colors" style={{ width: 46, height: TITLEBAR_HEIGHT }}><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex shrink-0 flex-col h-full bg-surface/70 backdrop-blur-xl border-r border-white/10 shadow-2xl py-4 px-3" style={{ width: SIDEBAR_WIDTH }}>
          <div className="mb-8 px-2">
            <h1 className="font-headline-lg text-headline-lg font-black text-primary tracking-tighter">{t('common.appName')}</h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant opacity-60">{t('nav.downloads')}</p>
          </div>
          <nav className="flex-1 space-y-1">
            {NAV_ITEMS.map((item) => {
              const isActive = page === item.route
              return (
                <button key={item.route} onClick={() => { setPage(item.route); setSelectedDownloadId(null) }} className={`flex w-full items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${isActive ? 'text-primary font-bold border-r-2 border-primary bg-white/5' : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5 hover:translate-x-1'}`}>
                  {item.icon}
                  <span className="font-body-md text-body-md">{t(item.labelKey)}</span>
                  {item.route === 'downloading' && downloadingCount > 0 && (
                    <span className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full leading-none ${isActive ? 'bg-primary/20 text-primary' : 'bg-white/10 text-on-surface-variant/60'}`}>{downloadingCount}</span>
                  )}
                </button>
              )
            })}
          </nav>
          <div className="mt-auto space-y-3">
            <button onClick={() => setPage('settings')} className={`flex w-full items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${page === 'settings' ? 'text-primary font-bold bg-white/5' : 'text-on-surface-variant hover:text-on-surface hover:bg-white/5'}`}>
              <Settings className="h-5 w-5" />
              <span className="font-body-md text-body-md">{t('nav.settings')}</span>
            </button>
            <div className="flex items-center gap-2.5 px-2 pt-2 border-t border-white/5">
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center"><User className="h-3.5 w-3.5 text-primary" /></div>
              <div className="flex flex-col">
                <span className="text-[11px] font-bold">Local User</span>
                <span className="text-[9px] text-on-surface-variant/60">Default Profile</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="flex-1 flex flex-col relative overflow-hidden bg-surface-container-lowest">
          {page === 'downloading' && !selectedDownload && (
            <DownloadingPage
              downloads={activeDownloads}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              protocolFilter={protocolFilter}
              setProtocolFilter={setProtocolFilter}
              viewMode={viewMode}
              setViewMode={setViewMode}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
              onRemove={handleRemove}
              onPauseAll={handlePauseAll}
              onResumeAll={handleResumeAll}
              onNewTask={() => setDialogOpen(true)}
              downloadingCount={downloadingCount}
              totalSpeed={totalSpeed}
              totalDownloaded={totalDownloaded}
              selectedDownloadId={selectedDownloadId}
              onSelectDownload={setSelectedDownloadId}
            />
          )}
          {page === 'downloading' && selectedDownload && (
            <DownloadDetailPanel download={selectedDownload} onClose={() => setSelectedDownloadId(null)} onPause={handlePause} onResume={handleResume} onCancel={handleCancel} />
          )}
          {page === 'completed' && <CompletedPage downloads={completedDownloads} />}
          {page === 'library' && <LibraryPage />}
          {page === 'player' && <PlayerPage />}
          {page === 'browser' && <BrowserPage />}
          {page === 'scheduler' && <SchedulerPage onNewTask={() => setDialogOpen(true)} />}
          {page === 'settings' && <div className="h-full"><SettingsPanel /></div>}
        </main>
      </div>

      <FAB onAddDownload={() => setDialogOpen(true)} onPasteURL={async () => { try { const t = await navigator.clipboard.readText(); if (t?.match(/^https?:\/\/|magnet:/)) { handleAddDownload(t); toast.success('URL pasted') } else toast.info('No URL found') } catch { toast.info('Cannot access clipboard') } }} onToggleSpeedLimit={() => {}} speedLimitEnabled={false} activeCount={downloadingCount} onToggleFloating={() => { try { Events.Emit('floating:enter') } catch {} }} />
      <AddDownloadDialog open={dialogOpen} onOpenChange={setDialogOpen} onAdd={handleAddDownload} defaultDir={defaultDir} recentPaths={recentPaths} />
    </div>
  )
}

interface DownloadingPageProps {
  downloads: ReturnType<typeof useStore.getState>['downloads']
  searchQuery: string
  setSearchQuery: (q: string) => void
  statusFilter: StatusFilter
  setStatusFilter: (f: StatusFilter) => void
  protocolFilter: ProtocolFilter
  setProtocolFilter: (p: ProtocolFilter) => void
  viewMode: 'list' | 'grid'
  setViewMode: (v: 'list' | 'grid') => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onPauseAll: () => void
  onResumeAll: () => void
  onNewTask: () => void
  downloadingCount: number
  totalSpeed: number
  totalDownloaded: number
  selectedDownloadId: string | null
  onSelectDownload: (id: string | null) => void
}

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All Tasks' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'error', label: 'Error' },
  { key: 'queued', label: 'Queued' },
]

const CONTENT_TABS = ['All Tasks', 'Music', 'Video', 'Software']

const PROTOCOL_CHIPS: { key: ProtocolFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'HTTP', label: 'HTTP' },
  { key: 'BT', label: 'BT' },
  { key: 'IPFS', label: 'IPFS' },
  { key: 'Video', label: 'Video' },
]

function DownloadingPage(props: DownloadingPageProps) {
  const { t } = useTranslation()
  const { downloads, searchQuery, setSearchQuery, statusFilter, setStatusFilter, protocolFilter, setProtocolFilter, viewMode, setViewMode, onPause, onResume, onCancel, onRemove, onPauseAll, onResumeAll, onNewTask, downloadingCount, totalSpeed, totalDownloaded, selectedDownloadId, onSelectDownload } = props

  const filtered = useMemo(() => {
    let list = downloads
    if (searchQuery) list = list.filter(d => (d.filename || d.url).toLowerCase().includes(searchQuery.toLowerCase()))
    if (statusFilter !== 'all') {
      list = list.filter(d => {
        switch (statusFilter) {
          case 'active': return d.status === 'downloading' || d.status === 'probing'
          case 'paused': return d.status === 'paused'
          case 'error': return d.status === 'error'
          case 'queued': return d.status === 'queued'
          default: return true
        }
      })
    }
    if (protocolFilter !== 'all') {
      list = list.filter(d => getProtocolInfo(d.url).label === protocolFilter)
    }
    return list
  }, [downloads, searchQuery, statusFilter, protocolFilter])

  return (
    <>
      <header className="flex justify-between items-center px-6 py-4 w-full sticky top-0 z-40 bg-surface/70 backdrop-blur-xl border-b border-white/10 shadow-sm">
        <div className="flex items-center gap-6 flex-1">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-on-surface-variant" />
            <input className="w-full bg-white/5 border border-white/10 rounded-full py-2 pl-10 pr-4 text-[13px] focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all" placeholder={t('download.sourcePlaceholder')} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
          <nav className="hidden lg:flex items-center gap-6">
            {CONTENT_TABS.map((tab, i) => (
              <button key={tab} onClick={() => setStatusFilter(i === 0 ? 'all' : 'all')} className={`pb-1 text-[13px] transition-colors ${i === 0 ? 'text-primary border-b-2 border-primary font-medium' : 'text-on-surface-variant hover:text-on-surface'}`}>
                {tab}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 p-1 bg-white/5 rounded-lg border border-white/10">
            <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-white/10 text-primary' : 'hover:bg-white/10 text-on-surface-variant'}`}><Grid3X3 className="h-4 w-4" /></button>
            <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-white/10 text-primary' : 'hover:bg-white/10 text-on-surface-variant'}`}><List className="h-4 w-4" /></button>
            <button className="p-1.5 rounded-md hover:bg-white/10 text-on-surface-variant transition-all"><SortAsc className="h-4 w-4" /></button>
          </div>
          <div className="h-6 w-px bg-white/10 mx-1" />
          <button onClick={onNewTask} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-primary to-primary-container text-on-primary font-bold rounded-lg text-xs hover:shadow-lg hover:shadow-primary/20 active:scale-95 transition-all">
            <Plus className="h-4 w-4" /> {t('download.newDownload')}
          </button>
        </div>
      </header>

      <div className="px-6 py-4 flex items-center justify-between border-b border-white/5 bg-surface/30 backdrop-blur-md">
        <div className="flex items-center gap-2">
          {PROTOCOL_CHIPS.map(chip => (
            <button key={chip.key} onClick={() => setProtocolFilter(protocolFilter === chip.key ? 'all' : chip.key)} className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all ${protocolFilter === chip.key ? 'bg-primary/20 border border-primary/30 text-primary' : 'bg-white/5 border border-white/10 text-on-surface-variant hover:bg-white/10'}`}>
              {chip.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={onPauseAll} className="text-[11px] font-bold text-on-surface-variant hover:text-primary flex items-center gap-1 transition-colors"><PauseCircle className="h-3.5 w-3.5" /> {t('tray.pauseAll')}</button>
          <button onClick={onResumeAll} className="text-[11px] font-bold text-on-surface-variant hover:text-primary flex items-center gap-1 transition-colors"><Play className="h-3.5 w-3.5" /> {t('tray.resumeAll')}</button>
          <button className="text-[11px] font-bold text-on-surface-variant hover:text-primary flex items-center gap-1 transition-colors"><FolderOpen className="h-3.5 w-3.5" /> {t('download.action.openFolder')}</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar pb-12">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="relative mb-8">
              <div className="absolute inset-0 bg-primary/20 blur-[80px] rounded-full" />
              <CloudDownload className="h-24 w-24 text-on-surface-variant/20 relative z-10" />
            </div>
            <h2 className="font-headline-lg text-headline-lg mb-2">{t('download.noDownloads')}</h2>
            <p className="text-on-surface-variant max-w-sm mb-8 text-[13px]">{t('download.noDownloads')}</p>
            <button onClick={onNewTask} className="px-6 py-3 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 hover:border-primary/50 text-primary font-bold flex items-center gap-3 transition-all">
              <Plus className="h-5 w-5" /> {t('download.newDownload')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 max-w-6xl mx-auto">
            {filtered.map((d) => {
              const protocol = getProtocolInfo(d.url)
              const isActive = d.status === 'downloading' || d.status === 'queued' || d.status === 'probing'
              const isPaused = d.status === 'paused'
              const isError = d.status === 'error'
              const isSelected = selectedDownloadId === d.id

              return (
                <div key={d.id} onClick={() => onSelectDownload(isSelected ? null : d.id)} className={`glass-card rounded-xl p-4 flex items-center gap-6 group cursor-pointer ${isError ? '!border-error/20' : ''} ${isSelected ? '!border-primary/40 bg-primary/5' : ''}`}>
                  <div className={`w-12 h-12 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-secondary-container/20 text-secondary' : isError ? 'bg-error-container/20 text-error' : isPaused ? 'bg-white/5 text-on-surface-variant' : 'bg-primary-container/20 text-primary'}`}>
                    {getFileIcon(d.url, d.filename || '')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-on-surface truncate max-w-[300px] text-[14px]">{d.filename || d.url}</h3>
                        <span className={`px-1.5 py-0.5 rounded ${protocol.bg} border ${protocol.border} ${protocol.color} text-[10px] font-black tracking-widest shrink-0`}>[{protocol.label}]</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={`font-mono text-[13px] tracking-tight ${isActive ? 'text-primary' : isError ? 'text-error' : 'text-on-surface-variant'}`}>
                            {isActive ? formatSpeed(d.speed) : isError ? 'FAILED' : isPaused ? '0.0 KB/s' : ''}
                          </p>
                          {isActive && d.eta > 0 && <p className="text-[10px] text-on-surface-variant uppercase tracking-tighter">ETA: {formatTime(d.eta)}</p>}
                          {isPaused && <p className="text-[10px] text-on-surface-variant uppercase tracking-tighter">Paused</p>}
                        </div>
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          {isActive && <button onClick={() => onPause(d.id)} className="p-1.5 hover:bg-white/10 rounded transition-colors text-on-surface-variant"><Pause className="h-4 w-4" /></button>}
                          {isPaused && <button onClick={() => onResume(d.id)} className="p-1.5 hover:bg-white/10 rounded transition-colors text-primary"><Play className="h-4 w-4" /></button>}
                          {isError && <button onClick={() => onResume(d.id)} className="p-1.5 hover:bg-white/10 rounded transition-colors text-on-surface-variant"><RefreshCw className="h-4 w-4" /></button>}
                          <button onClick={() => onCancel(d.id)} className="p-1.5 hover:bg-white/10 rounded transition-colors text-on-surface-variant"><X className="h-4 w-4" /></button>
                        </div>
                      </div>
                    </div>
                    <div className="w-full h-1.5 bg-surface-container rounded-full overflow-hidden mb-1">
                      <div className={`h-full rounded-full transition-all duration-700 ${isActive ? 'bg-gradient-to-r from-primary to-primary-container progress-glow' : isError ? 'bg-error' : isPaused ? 'bg-tertiary-container/30' : 'bg-primary'}`} style={{ width: `${d.progress}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-on-surface-variant">
                        {d.progress.toFixed(0)}% of {formatBytes(d.total_size)}{d.connections > 0 ? ` \u00B7 ${d.connections} ${protocol.label === 'BT' ? 'Peers' : 'conn'}` : ''}
                      </p>
                      <p className={`text-[11px] font-bold flex items-center gap-1 ${isActive ? 'text-primary' : isError ? 'text-error' : isPaused ? 'text-on-surface-variant' : 'text-primary'}`}>
                        {isActive && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
                        {d.status === 'downloading' ? t('download.status.downloading') : d.status === 'queued' ? t('download.status.waiting') : d.status === 'probing' ? t('download.status.probing') : d.status === 'paused' ? t('download.status.paused') : d.status === 'error' ? t('download.status.error') : d.status}
                      </p>
                    </div>
                    {isError && d.error && <p className="text-[11px] text-error mt-0.5">{d.error}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between px-6 w-full shrink-0 z-50 bg-surface-container-lowest/90 backdrop-blur-md border-t border-white/10" style={{ height: STATUSBAR_HEIGHT }}>
        <div className="flex items-center gap-6">
          <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">\u00A9 2024 Orig Hub Performance Manager</span>
          <span className="font-mono text-[13px] text-secondary font-bold">{t('statusbar.activeDownloads', { count: downloadingCount })}</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-on-surface-variant">
            <ArrowDown className="h-3.5 w-3.5 text-primary" />
            <span className="font-mono text-[13px]">DL: {formatSpeed(totalSpeed)}</span>
          </div>
          <div className="flex items-center gap-2 text-on-surface-variant">
            <ArrowUp className="h-3.5 w-3.5 text-secondary" />
            <span className="font-mono text-[13px]">UL: {formatSpeed(totalSpeed * 0.05)}</span>
          </div>
          <span className="font-mono text-[13px] text-on-surface-variant hover:text-primary transition-colors cursor-pointer">{t('nav.settings')}</span>
        </div>
      </footer>
    </>
  )
}

function DownloadDetailPanel({ download, onClose, onPause, onResume, onCancel }: { download: ReturnType<typeof useStore.getState>['downloads'][0]; onClose: () => void; onPause: (id: string) => void; onResume: (id: string) => void; onCancel: (id: string) => void }) {
  const isActive = download.status === 'downloading' || download.status === 'queued' || download.status === 'probing'
  const isPaused = download.status === 'paused'
  const protocol = getProtocolInfo(download.url)
  const speedBars = [40, 45, 38, 55, 65, 60, 75, 85, 80, 95, 100, 85, 70, 50, 45, 40, 45, 55, 75, 90, 85, 95, 70, 60, 55, 40, 35, 45, 65, 80, 85, 100]
  const mirrorNodes = [
    { name: 'fra-de-mirror-01', latency: '12ms', status: 'active' as const },
    { name: 'ams-nl-backbone', latency: '18ms', status: 'active' as const },
    { name: 'lon-uk-seed-04', latency: '45ms', status: 'slow' as const },
    { name: 'nyc-us-node', latency: 'Timeout', status: 'error' as const },
  ]
  const logEntries = [
    { time: '14:02:11', level: 'INFO', msg: 'Handshake complete with fra-de-mirror-01' },
    { time: '14:02:15', level: 'INFO', msg: 'Verifying block #4,112... OK' },
    { time: '14:02:18', level: 'NET', msg: 'Optimal path found via Cloudflare-AMS' },
    { time: '14:03:01', level: 'WARN', msg: 'Packet loss detected (4%) on node nyc-us. Retrying...' },
    { time: '14:03:12', level: 'INFO', msg: 'Allocation successful on local storage' },
    { time: '14:04:45', level: 'INFO', msg: `Writing stream at ${formatSpeed(download.speed)}` },
    { time: '14:05:22', level: 'INFO', msg: 'Checksum verified for blocks 5,000 to 6,000' },
    { time: '14:06:01', level: 'NET', msg: 'Mirror lon-uk-seed-04 latency dropped to 45ms' },
  ]
  const fileTree = [
    { name: 'Data/', type: 'folder', checked: true, indent: 0 },
    { name: 'content_p1.pak', type: 'file', checked: true, indent: 1, size: '42.1 GB' },
    { name: 'content_p2.pak', type: 'file', checked: true, indent: 1, size: '28.4 GB' },
    { name: 'Executables/', type: 'folder', checked: true, indent: 0 },
    { name: 'launcher.exe', type: 'file', checked: true, indent: 1, size: '124 MB' },
    { name: 'readme.txt', type: 'file', checked: false, indent: 1, size: '4 KB' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex justify-between items-end px-8 py-6 border-b border-white/10 bg-surface/70 backdrop-blur-xl">
        <div>
          <div className="flex items-center gap-2 text-on-surface-variant text-[13px] mb-2">
            <button onClick={onClose} className="hover:text-primary transition-colors cursor-pointer">Downloads</button>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="text-on-surface truncate">{download.filename || download.url}</span>
          </div>
          <h2 className="font-headline-xl text-headline-xl text-on-surface">{download.filename || 'Unknown'}</h2>
        </div>
        <div className="flex gap-2">
          {isActive && <button onClick={() => onPause(download.id)} className="p-2.5 rounded-lg bg-surface-container-high border border-white/5 hover:bg-white/10 transition-all"><Pause className="h-5 w-5" /></button>}
          {isPaused && <button onClick={() => onResume(download.id)} className="p-2.5 rounded-lg bg-surface-container-high border border-white/5 hover:bg-white/10 transition-all text-primary"><Play className="h-5 w-5" /></button>}
          <button onClick={() => onCancel(download.id)} className="p-2.5 rounded-lg bg-surface-container-high border border-white/5 hover:bg-white/10 transition-all"><Trash2 className="h-5 w-5 text-error" /></button>
          <button className="p-2.5 rounded-lg bg-surface-container-high border border-white/5 hover:bg-white/10 transition-all"><Share className="h-5 w-5" /></button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-8 pb-16">
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-8 glass-card-static rounded-xl p-4 flex flex-col min-h-[320px]">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-secondary/10"><Activity className="h-5 w-5 text-secondary" /></div>
                <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Network Throughput</span>
              </div>
              <div className="font-mono text-secondary text-2xl font-bold">{formatSpeed(download.speed)}</div>
            </div>
            <div className="flex-1 relative overflow-hidden flex items-end gap-1">
              {speedBars.map((h, i) => (
                <div key={i} className={`flex-1 rounded-t transition-all duration-700 ${i === speedBars.length - 1 ? 'bg-secondary animate-pulse' : `bg-secondary/${Math.min(Math.round(h / 10) * 10, 100)}`}`} style={{ height: `${h}%`, transitionDelay: `${i * 30}ms` }} />
              ))}
            </div>
          </div>

          <div className="col-span-4 flex flex-col gap-4">
            <div className="glass-card-static rounded-xl p-4 flex-1">
              <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest block mb-4">Active Mirrors</span>
              <div className="space-y-3">
                {mirrorNodes.map((node, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg hover:bg-white/5 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${node.status === 'active' ? 'bg-primary shadow-[0_0_8px_rgba(16,185,129,0.5)]' : node.status === 'slow' ? 'bg-secondary-container' : 'bg-error'}`} />
                      <span className="text-[13px] text-on-surface">{node.name}</span>
                    </div>
                    <span className={`font-mono text-[13px] ${node.status === 'active' ? 'text-primary' : node.status === 'slow' ? 'text-secondary-container' : 'text-error'}`}>{node.latency}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="glass-card-static rounded-xl p-4">
              <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest block mb-2">ETA Remaining</span>
              <div className="font-mono text-2xl text-primary font-bold">{download.eta > 0 ? formatTime(download.eta) : '--:--'}</div>
              <div className="mt-3 w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-secondary to-primary rounded-full" style={{ width: `${download.progress}%` }} />
              </div>
              <div className="flex justify-between mt-2 text-[11px] text-on-surface-variant font-mono">
                <span>{download.progress.toFixed(1)}%</span>
                <span>{formatBytes(download.downloaded)} / {formatBytes(download.total_size)}</span>
              </div>
            </div>
          </div>

          <div className="col-span-12 glass-card-static rounded-xl p-4">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <Grid3X3 className="h-4 w-4 text-primary" />
                <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Block Availability (1,024 Slices)</span>
              </div>
              <div className="text-[13px] text-on-surface-variant">{download.progress.toFixed(1)}% Verified</div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(12px,1fr))] gap-[2px]">
              {Array.from({ length: 400 }, (_, i) => {
                const rand = Math.random()
                const chunkClass = rand > 0.3 ? 'bg-primary/40' : rand > 0.1 ? 'bg-white/5' : 'bg-primary animate-pulse'
                return <div key={i} className={`h-3 rounded-sm ${chunkClass}`} />
              })}
            </div>
          </div>

          <div className="col-span-6 glass-card-static rounded-xl p-4">
            <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
              <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Payload Content</span>
              <span className="text-[13px] text-on-surface-variant">{fileTree.length} Files \u00B7 {formatBytes(download.total_size)}</span>
            </div>
            <div className="space-y-1 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
              {fileTree.map((f, i) => (
                <div key={i} className={`flex items-center gap-3 p-2 rounded hover:bg-white/5 transition-colors ${f.indent ? 'pl-8' : ''}`}>
                  <input defaultChecked={f.checked} className="rounded border-white/20 bg-transparent text-primary focus:ring-0" type="checkbox" />
                  {f.type === 'folder' ? <FolderOpen className="h-4 w-4 text-on-surface-variant" /> : f.name.endsWith('.exe') ? <Terminal className="h-4 w-4 text-primary" /> : <FileText className="h-4 w-4 text-secondary" />}
                  <span className="flex-1 text-[13px]">{f.name}</span>
                  {f.size && <span className="font-mono text-on-surface-variant text-[13px]">{f.size}</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="col-span-6 glass-card-static rounded-xl p-4 bg-black/40">
            <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
              <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">System Log</span>
              <div className="flex gap-2 items-center">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-[13px] text-primary">Streaming</span>
              </div>
            </div>
            <div className="font-mono text-[13px] text-on-surface-variant space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
              {logEntries.map((entry, i) => (
                <div key={i} className="flex gap-4">
                  <span className="text-white/20 shrink-0">{entry.time}</span>
                  <span className={`shrink-0 ${entry.level === 'INFO' ? 'text-primary' : entry.level === 'NET' ? 'text-secondary-container' : 'text-error'}`}>[{entry.level}]</span>
                  <span className={entry.level === 'WARN' ? 'text-error' : ''}>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CompletedPage({ downloads }: { downloads: ReturnType<typeof useStore.getState>['downloads'] }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [dateFilter, setDateFilter] = useState<string>('all')
  const filtered = useMemo(() => {
    let list = downloads
    if (searchQuery) list = list.filter(d => (d.filename || d.url).toLowerCase().includes(searchQuery.toLowerCase()))
    if (typeFilter !== 'all') {
      list = list.filter(d => {
        const ext = (d.filename || d.url).split('.').pop()?.toLowerCase() || ''
        switch (typeFilter) {
          case 'video': return ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'webm'].includes(ext)
          case 'audio': return ['mp3', 'flac', 'wav', 'aac', 'ogg'].includes(ext)
          case 'archive': return ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)
          case 'image': return ['iso'].includes(ext)
          case 'document': return ['pdf', 'doc', 'docx', 'txt'].includes(ext)
          default: return true
        }
      })
    }
    return list
  }, [downloads, searchQuery, typeFilter])
  const totalCompleted = filtered.filter(d => d.status === 'completed').length
  const totalStorage = filtered.reduce((sum, d) => sum + d.total_size, 0)

  return (
    <>
      <header className="flex justify-between items-center px-8 h-16 w-full z-40 bg-surface/70 backdrop-blur-xl border-b border-white/10">
        <div className="flex items-center gap-6 flex-1 max-w-2xl">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-on-surface-variant" />
            <input className="w-full bg-surface-container-low border border-white/10 rounded-full py-1.5 pl-10 pr-4 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="Search completed tasks..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTypeFilter(typeFilter === 'video' ? 'all' : 'video')} className={`px-4 py-1.5 rounded-full text-[12px] font-medium flex items-center gap-2 border transition-colors ${typeFilter === 'video' ? 'bg-primary/10 text-primary border-primary/30' : 'bg-surface-container-high text-on-surface-variant border-white/5 hover:bg-surface-container-highest'}`}>
              <Filter className="h-3.5 w-3.5" /> Type
            </button>
            <button onClick={() => setDateFilter(dateFilter === 'today' ? 'all' : 'today')} className={`px-4 py-1.5 rounded-full text-[12px] font-medium flex items-center gap-2 border transition-colors ${dateFilter === 'today' ? 'bg-primary/10 text-primary border-primary/30' : 'bg-surface-container-high text-on-surface-variant border-white/5 hover:bg-surface-container-highest'}`}>
              <CalendarDays className="h-3.5 w-3.5" /> Date
            </button>
          </div>
        </div>
        <span className="font-mono text-[11px] text-secondary">{filtered.length} items</span>
      </header>

      <div className="flex-1 p-8 overflow-y-auto custom-scrollbar pb-16">
        <div className="flex items-end justify-between mb-8">
          <div>
            <h2 className="font-headline-xl text-headline-xl text-on-surface mb-2">History</h2>
            <p className="text-on-surface-variant text-[13px]">Manage and access all your successfully completed tasks and media assets.</p>
          </div>
          <div className="flex items-center gap-3 p-3 glass-card-static rounded-xl">
            <div className="text-right">
              <p className="text-[10px] font-bold text-primary uppercase tracking-widest">Total Completed</p>
              <p className="font-mono text-headline-lg leading-none">{totalCompleted.toLocaleString()}</p>
            </div>
            <div className="w-[2px] h-8 bg-white/10 mx-2" />
            <div className="text-right">
              <p className="text-[10px] font-bold text-secondary uppercase tracking-widest">Storage Used</p>
              <p className="font-mono text-headline-lg leading-none">{formatBytes(totalStorage)}</p>
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="flex h-48 items-center justify-center"><div className="text-center"><CheckCircle2 className="h-12 w-12 mx-auto text-on-surface/15" /><p className="mt-3 text-sm text-on-surface/35">No completed downloads yet</p></div></div>
        ) : (
          <div className="glass-card-static rounded-xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/5 border-b border-white/10">
                  <th className="px-6 py-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">Name</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest text-right">Size</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">Date Completed</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest text-center">Status</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map((d) => {
                  const isCompleted = d.status === 'completed'
                  const isArchived = d.status === 'completed' && (d.filename || d.url).includes('.iso')
                  return (
                    <tr key={d.id} className="hover:bg-white/[0.03] transition-colors group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-4">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center border border-white/10 ${isCompleted ? 'bg-primary/10 text-primary' : 'bg-error-container/20 text-error'}`}>
                            {getFileIcon(d.url, d.filename || '')}
                          </div>
                          <div>
                            <p className="font-bold text-on-surface group-hover:text-primary transition-colors text-[13px]">{d.filename || d.url}</p>
                            <p className="text-[11px] text-on-surface-variant">{d.dest_path ? d.dest_path.split(/[\\/]/).pop() : 'Download'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right font-mono text-[12px] text-on-surface-variant">{formatBytes(d.total_size)}</td>
                      <td className="px-6 py-4">
                        <p className="text-[13px] text-on-surface">{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                        <p className="text-[11px] text-on-surface-variant font-mono">{new Date().toLocaleTimeString('en-US', { hour12: false })}</p>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`px-3 py-1 rounded-full text-[11px] font-bold border ${isArchived ? 'bg-secondary/10 text-secondary border-secondary/20' : isCompleted ? 'bg-primary/10 text-primary border-primary/20' : 'bg-error/10 text-error border-error/20'}`}>{isArchived ? 'Archived' : isCompleted ? 'Verified' : 'Failed'}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
                          <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-primary/50 text-on-surface-variant hover:text-primary transition-all" title="Open Folder"><FolderOpen className="h-4 w-4" /></button>
                          <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-secondary/50 text-on-surface-variant hover:text-secondary transition-all" title="Re-download"><RefreshCw className="h-4 w-4" /></button>
                          <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 hover:border-error/50 text-on-surface-variant hover:text-error transition-all" title="Delete"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-12 text-center p-12 rounded-2xl border-2 border-dashed border-white/5">
          <p className="text-on-surface-variant text-[13px] mb-4">Showing recent completed items. View older tasks in the <span className="text-primary cursor-pointer hover:underline">Archive</span>.</p>
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 rounded-full border border-white/10 text-[12px]">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span className="text-on-surface-variant">Auto-sync with Cloud Storage active</span>
          </div>
        </div>
      </div>
    </>
  )
}

const MOCK_CONTINUE_WATCHING = [
  { id: 'cw1', title: 'Cyber Resonance: Part 1', subtitle: 'S1:E4 • 12 mins left', progress: 75 },
  { id: 'cw2', title: 'Deep Learning Fundamentals', subtitle: 'Module 3 • 45 mins left', progress: 30 },
  { id: 'cw3', title: 'Terraforming Tomorrow', subtitle: 'Feature Film • 1h 20m left', progress: 90 },
]

const MOCK_MEDIA = [
  { id: '1', title: 'Architectural Synthesis', type: 'video', duration: '2:45:00', size: '2.4 GB', format: 'MP4', resolution: '4K', progress: 75 },
  { id: '2', title: 'Fluid Dynamics Masterclass', type: 'video', duration: '0:52:15', size: '850 MB', format: 'MKV', resolution: 'HD', progress: 30 },
  { id: '3', title: 'Setup of the Future', type: 'video', duration: '1:12:30', size: '4.1 GB', format: 'MOV', resolution: '4K', progress: 0 },
  { id: '4', title: 'Low Poly Aesthetics', type: 'video', duration: '0:15:00', size: '120 MB', format: 'MP4', resolution: 'HD', progress: 0 },
  { id: '5', title: 'Color Theory & Emotion', type: 'video', duration: '2:30:10', size: '5.6 GB', format: 'MKV', resolution: '4K', progress: 0 },
  { id: '6', title: 'Tech Podcast Ep.42', type: 'audio', duration: '45:30', size: '85 MB', format: 'MP3', resolution: '', progress: 60 },
  { id: '7', title: 'Ambient Soundscapes Vol.3', type: 'audio', duration: '1:20:00', size: '320 MB', format: 'FLAC', resolution: '', progress: 0 },
  { id: '8', title: 'Neural Network Deep Dive', type: 'video', duration: '48:32', size: '3.2 GB', format: 'MP4', resolution: '4K', progress: 45 },
]

function LibraryPage() {
  const [category, setCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [previewItem, setPreviewItem] = useState<typeof MOCK_MEDIA[0] | null>(null)
  const filtered = useMemo(() => {
    let list = MOCK_MEDIA
    if (category !== 'all') list = list.filter(m => m.type === category)
    if (searchQuery) list = list.filter(m => m.title.toLowerCase().includes(searchQuery.toLowerCase()))
    return list
  }, [category, searchQuery])

  return (
    <>
      <header className="sticky top-0 w-full z-40 flex justify-between items-center px-8 py-4 bg-surface/70 backdrop-blur-xl border-b border-white/10 shadow-sm">
        <div className="flex items-center gap-8">
          <div className="relative w-[320px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-on-surface-variant" />
            <input className="w-full bg-surface-container-low border border-white/10 rounded-full py-1.5 pl-10 pr-4 text-[13px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" placeholder="Search library..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </div>
          <nav className="flex items-center gap-6">
            {['all', 'video', 'audio', 'document'].map(c => (
              <button key={c} onClick={() => setCategory(c)} className={`text-[13px] pb-1 transition-colors ${category === c ? 'text-primary border-b-2 border-primary font-medium' : 'text-on-surface-variant hover:text-on-surface'}`}>
                {c === 'all' ? 'All Media' : c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 border-r border-white/10 pr-4">
            <button className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-on-surface-variant"><Grid3X3 className="h-4 w-4" /></button>
            <button className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-on-surface-variant"><List className="h-4 w-4" /></button>
            <button className="p-1.5 rounded-lg hover:bg-white/5 transition-all text-on-surface-variant"><SortAsc className="h-4 w-4" /></button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-8 pb-16 space-y-10">
        <div className="flex items-center gap-2 pb-2">
          {['all', 'video', 'audio', 'image', 'document'].map(c => (
            <button key={c} onClick={() => setCategory(c)} className={`px-5 py-2 rounded-full text-[13px] font-medium transition-all ${category === c ? 'bg-primary text-on-primary font-bold' : 'bg-surface-container-high border border-white/5 text-on-surface-variant hover:bg-white/5'}`}>
              {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-headline-lg text-headline-lg">Continue Watching</h2>
            <button className="text-primary text-[13px] font-medium hover:underline">View All</button>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-4 custom-scrollbar snap-x">
            {MOCK_CONTINUE_WATCHING.map(item => (
              <div key={item.id} className="min-w-[400px] h-[220px] rounded-xl overflow-hidden glass-card relative group cursor-pointer snap-start transition-transform duration-300 hover:scale-[1.02]">
                <div className="w-full h-full bg-gradient-to-br from-primary/5 to-secondary/5 flex items-center justify-center">
                  <Video className="h-16 w-16 text-on-surface/10" />
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent flex flex-col justify-end p-6">
                  <h3 className="font-bold text-headline-lg mb-1">{item.title}</h3>
                  <p className="text-on-surface-variant text-[13px] mb-4">{item.subtitle}</p>
                  <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-secondary to-primary" style={{ width: `${item.progress}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-headline-lg text-headline-lg">Media Library</h2>
            <div className="flex items-center gap-4">
              <span className="text-on-surface-variant text-[13px]">Sorted by Date Added</span>
              <Filter className="h-4 w-4 text-primary cursor-pointer" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-6">
            {filtered.map(m => (
              <div key={m.id} onClick={() => setPreviewItem(m)} className="glass-card relative rounded-xl overflow-hidden group cursor-pointer transition-all duration-500 hover:-translate-y-1">
                <div className="aspect-[2/3] relative overflow-hidden bg-gradient-to-br from-primary/5 to-secondary/5 flex items-center justify-center">
                  {m.type === 'video' ? <Video className="h-12 w-12 text-on-surface/10" /> : <Music className="h-12 w-12 text-on-surface/10" />}
                  {m.resolution && <span className="absolute top-3 right-3 bg-black/60 backdrop-blur-md text-primary font-bold text-[10px] px-2 py-1 rounded border border-primary/30">{m.resolution}</span>}
                  <span className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white font-bold text-[10px] px-2 py-1 rounded border border-white/10">{m.duration}</span>
                  <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all duration-300">
                    <Play className="h-12 w-12 text-white" />
                  </div>
                </div>
                <div className="p-4 bg-surface-container-highest/50 backdrop-blur-md">
                  <h4 className="font-bold text-[14px] truncate">{m.title}</h4>
                  <p className="text-on-surface-variant text-[13px] mt-1">{m.size} • {m.format}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {previewItem && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-8" onClick={() => setPreviewItem(null)}>
          <div className="glass-card-static max-w-4xl w-full rounded-2xl overflow-hidden shadow-2xl flex scale-100" onClick={(e) => e.stopPropagation()}>
            <div className="w-2/3 aspect-video relative group bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center">
              <Video className="h-20 w-20 text-on-surface/10" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <button className="w-16 h-16 rounded-full bg-primary text-on-primary flex items-center justify-center hover:scale-110 transition-transform"><Play className="h-8 w-8 ml-1" /></button>
              </div>
            </div>
            <div className="w-1/3 p-8 flex flex-col bg-surface-container">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="font-headline-xl text-headline-xl mb-2">{previewItem.title}</h2>
                  {previewItem.resolution && <span className="px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-primary text-[10px] font-bold">{previewItem.resolution} ULTRA HD</span>}
                </div>
                <button className="p-1 rounded-full hover:bg-white/10 transition-all text-on-surface-variant" onClick={() => setPreviewItem(null)}><X className="h-5 w-5" /></button>
              </div>
              <div className="space-y-4 flex-1">
                <div>
                  <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest mb-1">METADATA</p>
                  <p className="text-[13px]">Codec: H.265 (HEVC)</p>
                  <p className="text-[13px]">Duration: {previewItem.duration}</p>
                  <p className="text-[13px]">Format: {previewItem.format}</p>
                </div>
                <div>
                  <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest mb-1">FILE INFO</p>
                  <p className="text-[13px]">Size: {previewItem.size}</p>
                </div>
              </div>
              <div className="flex gap-2 mt-auto pt-6 border-t border-white/10">
                <button className="flex-1 py-2 bg-primary text-on-primary font-bold rounded-lg text-[13px]">Open File</button>
                <button className="p-2 border border-white/10 rounded-lg hover:bg-white/5 transition-all"><Trash2 className="h-4 w-4 text-on-surface-variant" /></button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const MOCK_PLAYLIST = [
  { id: 'pl1', title: '01. Neural Networks Deep Dive', duration: '48:32', quality: '4K DASH', active: true },
  { id: 'pl2', title: '02. Distributed Systems Explained', duration: '1:12:05', quality: '1080p', active: false },
  { id: 'pl3', title: '03. The Future of HLS-LL', duration: '24:15', quality: '4K HDR', active: false },
  { id: 'pl4', title: '04. Mastering WebAssembly', duration: '56:40', quality: '1080p', active: false },
]

function PlayerPage() {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(765)
  const [showQueue, setShowQueue] = useState(true)
  const [playbackSpeed, setPlaybackSpeed] = useState('1x')
  const duration = 2912
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)

  return (
    <div className="h-full flex overflow-hidden">
      <div className="flex-grow relative bg-black flex flex-col group">
        <div className="flex-1 flex items-center justify-center relative">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-secondary/5" />
          <Video className="h-24 w-24 text-white/5 relative z-10" />
          <div className="absolute top-8 left-8 z-20 flex items-center gap-2 opacity-0 group-hover:opacity-80 transition-opacity">
            <Zap className="h-4 w-4 text-primary" />
            <span className="font-mono text-[11px] uppercase tracking-widest text-white/50">orig-hub // hls.v3</span>
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-8 pt-24 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="relative group/seek cursor-pointer mb-6">
            <div className="absolute top-1/2 -translate-y-1/2 left-1/4 w-[2px] h-3 bg-white/30 z-10 rounded-full" />
            <div className="absolute top-1/2 -translate-y-1/2 left-2/3 w-[2px] h-3 bg-white/30 z-10 rounded-full" />
            <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden transition-all group-hover/seek:h-2">
              <div className="h-full bg-gradient-to-r from-secondary to-primary relative" style={{ width: `${(currentTime / duration) * 100}%` }}>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full scale-0 group-hover/seek:scale-100 transition-transform" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <button onClick={() => setIsPlaying(!isPlaying)} className="text-4xl hover:text-primary transition-colors">
                {isPlaying ? <Pause className="h-10 w-10" /> : <Play className="h-10 w-10" />}
              </button>
              <button className="hover:text-primary transition-colors text-on-surface-variant"><SkipForward className="h-5 w-5" /></button>
              <div className="flex items-center gap-3 group/vol">
                <Volume2 className="h-5 w-5 text-on-surface-variant" />
                <div className="w-0 group-hover/vol:w-24 overflow-hidden transition-all duration-300">
                  <div className="h-1 w-20 bg-white/20 rounded-full"><div className="h-full w-3/4 bg-white rounded-full" /></div>
                </div>
              </div>
              <div className="font-mono text-[13px] text-on-surface-variant ml-2">
                <span className="text-white">{formatTime(currentTime)}</span> / {formatTime(duration)}
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="relative">
                <button onClick={() => setShowSpeedMenu(!showSpeedMenu)} className="px-3 py-1 rounded border border-white/10 font-mono text-[11px] hover:bg-white/10 transition-colors uppercase">{playbackSpeed} Speed</button>
                {showSpeedMenu && (
                  <div className="absolute bottom-full mb-2 right-0 glass-card-static rounded-lg overflow-hidden shadow-xl py-1 min-w-[80px]">
                    {['0.5x', '1x', '1.5x', '2x'].map(s => (
                      <button key={s} onClick={() => { setPlaybackSpeed(s); setShowSpeedMenu(false) }} className={`w-full px-3 py-1.5 text-[11px] text-left hover:bg-white/10 transition-colors ${playbackSpeed === s ? 'text-primary font-bold' : 'text-on-surface-variant'}`}>{s}</button>
                    ))}
                  </div>
                )}
              </div>
              <button className="text-on-surface-variant hover:text-primary transition-colors"><Subtitles className="h-5 w-5" /></button>
              <button className="text-on-surface-variant hover:text-primary transition-colors"><Cast className="h-5 w-5" /></button>
              <button className="text-on-surface-variant hover:text-primary transition-colors"><PictureInPicture2 className="h-5 w-5" /></button>
              <button className="text-on-surface-variant hover:text-primary transition-colors"><Maximize2 className="h-5 w-5" /></button>
            </div>
          </div>
        </div>
      </div>

      {showQueue && (
        <aside className="w-[320px] glass-card-static h-full flex flex-col border-l border-white/5">
          <div className="p-6 border-b border-white/10 flex items-center justify-between">
            <h2 className="font-headline-lg text-lg">Queue</h2>
            <div className="flex gap-2">
              <button className="text-on-surface-variant hover:text-primary transition-colors"><Shuffle className="h-4 w-4" /></button>
              <button className="text-primary"><Repeat className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="flex-grow overflow-y-auto custom-scrollbar p-2 space-y-1">
            {MOCK_PLAYLIST.map(item => (
              <div key={item.id} className={`group flex items-center gap-4 p-3 rounded-xl transition-all cursor-pointer ${item.active ? 'bg-primary/10 border border-primary/20' : 'hover:bg-white/5 border border-transparent hover:border-white/10'}`}>
                <div className={`relative w-20 h-12 rounded overflow-hidden ${item.active ? '' : 'grayscale group-hover:grayscale-0'}`}>
                  <div className={`w-full h-full flex items-center justify-center ${item.active ? 'bg-primary/20' : 'bg-surface-container-high'}`}>
                    {item.active ? <Activity className="h-5 w-5 text-primary" /> : <Video className="h-5 w-5 text-on-surface-variant" />}
                  </div>
                </div>
                <div className="flex-grow min-w-0">
                  <div className={`text-xs truncate ${item.active ? 'text-primary font-bold' : 'font-semibold'}`}>{item.title}</div>
                  <div className="text-[10px] text-on-surface-variant font-mono">{item.duration} • {item.quality}</div>
                </div>
                <GripVertical className="h-4 w-4 text-on-surface-variant opacity-0 group-hover:opacity-100 cursor-grab" />
              </div>
            ))}
          </div>
          <div className="p-4 bg-surface-container-low border-t border-white/10">
            <div className="flex items-center justify-between text-[11px] font-mono text-on-surface-variant mb-2">
              <span>BUFFERED</span>
              <span className="text-secondary">92%</span>
            </div>
            <div className="h-1 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full bg-secondary w-[92%]" />
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

const MOCK_SNIFFER_ITEMS = [
  { id: 'sn1', title: 'Project_Emerald_4K.mp4', size: '12.4 GB', quality: '2160p', type: 'video' as const },
  { id: 'sn2', title: 'Original_Score_FLAC.zip', size: '840 MB', quality: 'Lossless', type: 'audio' as const },
  { id: 'sn3', title: 'Asset_Pack_v2.tar.gz', size: '4.2 GB', quality: 'RAW', type: 'image' as const },
]

function BrowserPage() {
  const [url, setUrl] = useState('https://orig-media-vault.com/network/streams/high-fidelity-4k')
  const [snifferOpen, setSnifferOpen] = useState(false)
  const snifferCount = MOCK_SNIFFER_ITEMS.length

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex items-center gap-4 border-b border-white/10 bg-surface/70 backdrop-blur-xl px-8 h-16">
        <div className="flex items-center gap-1">
          <button className="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant transition-colors"><ChevronLeft className="h-4 w-4" /></button>
          <button className="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant transition-colors"><ChevronRight className="h-4 w-4" /></button>
          <button className="p-2 rounded-lg hover:bg-white/5 text-on-surface-variant transition-colors"><RotateCcw className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 max-w-2xl relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-primary"><Shield className="h-4 w-4" /></div>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)} className="w-full bg-surface-container-lowest border border-white/10 rounded-lg pl-10 pr-4 py-2 font-mono text-[13px] focus:ring-2 focus:ring-secondary/20 focus:border-secondary outline-none transition-all" />
        </div>
      </div>

      <div className="flex-1 bg-surface-container-lowest overflow-y-auto custom-scrollbar p-8 relative">
        <div className="max-w-6xl mx-auto">
          <div className="mb-12">
            <div className="h-64 w-full rounded-xl overflow-hidden glass-card relative group mb-6">
              <div className="w-full h-full bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center">
                <Video className="h-16 w-16 text-on-surface/10" />
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <button className="w-16 h-16 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-2xl active:scale-90 transition-transform"><Play className="h-8 w-8 ml-1" /></button>
              </div>
            </div>
            <h2 className="font-headline-xl text-headline-xl mb-2">Network Stream: Project Emerald</h2>
            <p className="text-on-surface-variant max-w-2xl text-[13px]">Visualizing high-performance data architecture in real-time. This stream captures the essence of decentralized storage networks and fluid information flow.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="col-span-2 glass-card rounded-xl p-4 flex gap-4 items-center">
              <div className="w-24 h-24 rounded-lg bg-surface-container flex items-center justify-center text-primary"><Video className="h-10 w-10" /></div>
              <div>
                <h3 className="font-bold text-lg">Main Feature.mkv</h3>
                <p className="text-on-surface-variant text-[13px] mb-2">4K UHD • 12.4 GB • HEVC</p>
                <button className="px-4 py-1.5 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors text-[13px] font-bold">Preview File</button>
              </div>
            </div>
            <div className="glass-card rounded-xl p-4 flex flex-col justify-between">
              <Activity className="h-8 w-8 text-secondary" />
              <div>
                <h4 className="font-bold">Live Stats</h4>
                <p className="font-mono text-secondary text-[13px]">342 Peers</p>
              </div>
            </div>
          </div>

          <div className="mt-12 h-64 border-t border-white/5 pt-8">
            <h3 className="font-headline-lg text-headline-lg mb-6">Suggested Repositories</h3>
            <div className="grid grid-cols-4 gap-4">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-32 rounded-lg bg-surface-container-high/50 animate-pulse" />
              ))}
            </div>
          </div>
        </div>

        <div className="absolute bottom-10 right-10 flex flex-col items-end gap-4 z-50">
          {snifferOpen && (
            <div className="glass-card-static rounded-xl w-80 shadow-2xl overflow-hidden">
              <div className="bg-secondary/10 px-4 py-3 border-b border-secondary/20 flex justify-between items-center">
                <span className="font-bold text-secondary flex items-center gap-2 text-[13px]">
                  <Search className="h-4 w-4" /> {snifferCount} Media Links Detected
                </span>
                <span className="text-[10px] bg-secondary/20 text-secondary px-2 py-0.5 rounded-full uppercase font-bold tracking-wider">Sniffer Active</span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {MOCK_SNIFFER_ITEMS.map(item => (
                  <div key={item.id} className="p-3 border-b border-white/5 hover:bg-white/5 transition-colors flex items-center justify-between group">
                    <div className="flex items-center gap-3 overflow-hidden">
                      {item.type === 'video' ? <Video className="h-4 w-4 text-on-surface-variant group-hover:text-primary transition-colors" /> : item.type === 'audio' ? <Music className="h-4 w-4 text-on-surface-variant group-hover:text-primary transition-colors" /> : <Image className="h-4 w-4 text-on-surface-variant group-hover:text-primary transition-colors" />}
                      <div className="truncate">
                        <p className="text-[13px] font-medium truncate">{item.title}</p>
                        <p className="text-[11px] text-on-surface-variant font-mono">{item.size} • {item.quality}</p>
                      </div>
                    </div>
                    <button className="p-2 bg-primary text-on-primary rounded-lg hover:scale-105 active:scale-95 transition-all"><Download className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
              <div className="p-2 bg-surface-container-high/30">
                <button className="w-full py-2 bg-secondary text-on-secondary font-bold rounded-lg text-[13px] hover:opacity-90 transition-opacity">Download All Items</button>
              </div>
            </div>
          )}
          <button onClick={() => setSnifferOpen(!snifferOpen)} className={`w-14 h-14 rounded-full flex items-center justify-center shadow-xl hover:scale-110 active:scale-90 transition-all z-50 group relative ${snifferOpen ? 'bg-white/10 text-on-surface' : 'bg-secondary text-on-secondary'}`}>
            {snifferOpen ? <X className="h-6 w-6" /> : <><Search className="h-6 w-6" /><span className="absolute -top-1 -right-1 bg-error text-on-error text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-background">{snifferCount}</span></>}
          </button>
        </div>
      </div>
    </div>
  )
}

const MOCK_SCHEDULED_TASKS = [
  { id: 'st1', name: 'Daily DB Sync', tag: 'SYNC_TOOL', tagColor: 'secondary', schedule: '02:00 AM', repeat: 'Every 24h', load: '12.4 GB', loadLabel: 'EST. LOAD', enabled: true, icon: Database },
  { id: 'st2', name: 'Edge Cache Clear', tag: 'OPTIMIZER', tagColor: 'primary', schedule: 'Hourly', repeat: 'Next: 14:00', load: 'Low', loadLabel: 'PRIORITY', enabled: true, icon: CloudCog },
  { id: 'st3', name: 'Newsletter Dispatch', tag: 'PAUSED', tagColor: 'error', schedule: 'Weekly', repeat: '', load: '45.2k', loadLabel: 'TARGETS', enabled: false, icon: Mail },
  { id: 'st4', name: 'System Integrity Scan', tag: 'SEC_CORE', tagColor: 'secondary', schedule: '03:00 AM', repeat: '', load: 'High', loadLabel: 'PRIORITY', enabled: true, icon: Shield },
]

const CRON_MINUTES = ['Every minute (*)', 'Every 5 minutes (*/5)', 'Every 15 minutes (*/15)', 'At minute 0 (0)']
const CRON_HOURS = ['Every hour (*)', 'Every 6 hours (*/6)', 'Midnight (0)', 'Specific Range (9-17)']
const DAYS_OF_WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function SchedulerPage({ onNewTask }: { onNewTask: () => void }) {
  const [cronMinute, setCronMinute] = useState(CRON_MINUTES[2])
  const [cronHour, setCronHour] = useState(CRON_HOURS[0])
  const [selectedDays, setSelectedDays] = useState<number[]>([0])
  const [viewMode, setViewMode] = useState<'day' | 'week' | 'month'>('week')
  const [taskStates, setTaskStates] = useState<Record<string, boolean>>(() => {
    const states: Record<string, boolean> = {}
    MOCK_SCHEDULED_TASKS.forEach(t => { states[t.id] = t.enabled })
    return states
  })

  const cronExpression = useMemo(() => {
    const min = cronMinute.match(/\(([^)]+)\)/)?.[1] || '*'
    const hr = cronHour.match(/\(([^)]+)\)/)?.[1] || '*'
    const days = selectedDays.length === 0 ? '*' : selectedDays.map(d => d + 1).join(',')
    return `${min} ${hr} * * ${days}`
  }, [cronMinute, cronHour, selectedDays])

  const cronDescription = useMemo(() => {
    if (cronExpression === '*/15 * * * 1') return 'Runs every 15 minutes on Mondays'
    if (cronExpression === '0 0 * * *') return 'Runs daily at midnight'
    if (cronExpression === '*/15 * * * *') return 'Runs every 15 minutes every day'
    return `Custom schedule: ${cronExpression}`
  }, [cronExpression])

  const toggleDay = (idx: number) => {
    setSelectedDays(prev => prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx])
  }

  const toggleTask = (id: string) => {
    setTaskStates(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const graphBars = [40, 55, 70, 45, 85, 75, 95, 60, 50, 35, 40, 55]

  return (
    <>
      <header className="flex justify-between items-center px-8 h-16 w-full z-40 bg-surface/70 backdrop-blur-xl border-b border-white/10">
        <div className="flex items-center gap-4 flex-1 max-w-xl">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-on-surface-variant" />
            <input className="w-full bg-surface-container-low border border-white/5 rounded-lg pl-10 pr-4 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="Search tasks or logs..." />
          </div>
        </div>
      </header>

      <div className="flex-1 p-8 overflow-y-auto custom-scrollbar pb-16">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h2 className="font-headline-xl text-headline-xl text-on-surface">Task Scheduler</h2>
            <p className="text-on-surface-variant mt-1 text-[13px]">Manage recurring automation and queue priorities.</p>
          </div>
          <div className="flex gap-3">
            <button className="px-4 py-2 glass-card rounded-lg text-on-surface-variant flex items-center gap-2 hover:bg-white/5 active:scale-95 transition-all text-[11px] font-bold uppercase tracking-wider"><History className="h-4 w-4" /> Execution Log</button>
            <button className="px-6 py-2 bg-gradient-to-r from-primary to-primary-container text-on-primary-fixed rounded-lg font-bold shadow-lg active:scale-95 transition-all text-[13px]">Run All Tasks</button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          <section className="col-span-12 lg:col-span-4 flex flex-col gap-4">
            <div className="glass-card-static p-6 rounded-xl flex-1">
              <div className="flex items-center gap-3 mb-6">
                <Terminal className="h-5 w-5 text-primary" />
                <h3 className="font-headline-lg text-headline-lg">Cron Builder</h3>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Minute</label>
                  <select value={cronMinute} onChange={e => setCronMinute(e.target.value)} className="w-full bg-surface-container-low border border-white/10 rounded-lg p-3 text-[13px] focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer">
                    {CRON_MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Hour</label>
                  <select value={cronHour} onChange={e => setCronHour(e.target.value)} className="w-full bg-surface-container-low border border-white/10 rounded-lg p-3 text-[13px] focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer">
                    {CRON_HOURS.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Day of Week</label>
                  <div className="grid grid-cols-7 gap-1">
                    {DAYS_OF_WEEK.map((d, idx) => (
                      <button key={idx} onClick={() => toggleDay(idx)} className={`h-10 rounded flex items-center justify-center text-[11px] font-bold uppercase tracking-wider transition-all ${selectedDays.includes(idx) ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-white/5 hover:bg-white/10'}`}>{d}</button>
                    ))}
                  </div>
                </div>
                <div className="p-4 bg-surface-container-lowest rounded-lg border border-dashed border-white/10 mt-4">
                  <p className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Generated Cron</p>
                  <p className="font-mono text-primary text-lg">{cronExpression}</p>
                  <p className="text-[11px] text-on-surface-variant mt-2 italic">"{cronDescription}"</p>
                </div>
                <button className="w-full py-3 rounded-lg border border-primary/50 text-primary hover:bg-primary/5 font-bold transition-all text-[13px]">Save Pattern</button>
              </div>
            </div>

            <div className="glass-card-static p-6 rounded-xl h-64 overflow-hidden relative">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Queue Utilization</h3>
                <span className="font-mono text-primary text-[11px]">88% LOAD</span>
              </div>
              <div className="flex items-end gap-[2px] h-32 w-full mt-4">
                {graphBars.map((h, i) => (
                  <div key={i} className={`flex-1 rounded-t-sm transition-all duration-700 ${i === 6 ? 'bg-gradient-to-t from-primary to-secondary shadow-[0_0_10px_rgba(16,185,129,0.3)]' : `bg-primary/${Math.round(h / 10) * 10}`}`} style={{ height: `${h}%`, transitionDelay: `${i * 50}ms` }} />
                ))}
              </div>
              <div className="flex justify-between mt-4 text-[10px] font-mono text-on-surface-variant">
                <span>12:00</span><span>13:00</span><span>14:00</span><span>15:00</span><span>16:00</span>
              </div>
            </div>
          </section>

          <section className="col-span-12 lg:col-span-8 flex flex-col gap-4">
            <div className="glass-card-static p-4 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button className="p-2 hover:bg-white/5 rounded-full transition-all"><ChevronLeft className="h-5 w-5" /></button>
                <h3 className="font-headline-lg text-headline-lg">Tuesday, Oct 24</h3>
                <button className="p-2 hover:bg-white/5 rounded-full transition-all"><ChevronRight className="h-5 w-5" /></button>
              </div>
              <div className="flex bg-surface-container-lowest p-1 rounded-lg border border-white/5">
                {(['day', 'week', 'month'] as const).map(m => (
                  <button key={m} onClick={() => setViewMode(m)} className={`px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${viewMode === m ? 'bg-white/10 text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}>{m}</button>
                ))}
              </div>
            </div>

            <div className="glass-card-static rounded-xl flex-1 overflow-hidden">
              <div className="p-6 border-b border-white/5 flex justify-between items-center sticky top-0 bg-surface/90 backdrop-blur-md z-10">
                <h3 className="text-[11px] font-bold text-on-surface-variant uppercase tracking-widest">Active Scheduled Tasks</h3>
                <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold border border-primary/20">{MOCK_SCHEDULED_TASKS.filter(t => taskStates[t.id]).length} PENDING</span>
              </div>
              <div className="divide-y divide-white/5">
                {MOCK_SCHEDULED_TASKS.map(task => {
                  const Icon = task.icon
                  const isEnabled = taskStates[task.id]
                  return (
                    <div key={task.id} className={`p-6 hover:bg-white/[0.02] transition-colors group flex items-center gap-6 ${!isEnabled ? 'opacity-60' : ''}`}>
                      <div className={`w-12 h-12 rounded-xl bg-surface-container-high border border-white/10 flex items-center justify-center ${isEnabled ? 'text-primary group-hover:scale-110 transition-transform' : 'text-on-surface-variant'}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <h4 className="font-headline-lg text-lg">{task.name}</h4>
                          <span className={`px-2 py-0.5 text-[10px] rounded font-mono ${task.tagColor === 'secondary' ? 'bg-secondary-container/20 text-secondary' : task.tagColor === 'primary' ? 'bg-primary-container/20 text-primary' : 'bg-error-container/20 text-error'}`}>{task.tag}</span>
                        </div>
                        <div className="flex items-center gap-4 mt-1">
                          <div className="flex items-center gap-1 text-on-surface-variant text-[13px]">
                            <Clock className="h-3 w-3" /><span className="font-mono">{task.schedule}</span>
                          </div>
                          {task.repeat && (
                            <div className="flex items-center gap-1 text-on-surface-variant text-[13px]">
                              <Repeat className="h-3 w-3" /><span className="font-mono">{task.repeat}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-8">
                        <div className="text-right">
                          <p className={`font-mono ${isEnabled ? 'text-primary' : 'text-on-surface-variant'}`}>{task.load}</p>
                          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">{task.loadLabel}</p>
                        </div>
                        <button onClick={() => toggleTask(task.id)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isEnabled ? 'bg-primary' : 'bg-surface-container-highest'}`}>
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${isEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

export default App
