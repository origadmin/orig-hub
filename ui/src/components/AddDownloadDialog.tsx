import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWailsActions } from '../hooks/useWailsEvents'
import { X, Link, Upload, ChevronRight, ClipboardPaste, Info } from 'lucide-react'

type TabType = 'single' | 'batch' | 'torrent'

interface AddDownloadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (url: string, filename?: string, destPath?: string) => void
  defaultDir: string
  recentPaths: string[]
}

export function AddDownloadDialog({ open, onOpenChange, onAdd, defaultDir, recentPaths }: AddDownloadDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabType>('single')
  const [source, setSource] = useState('')
  const [category, setCategory] = useState('auto')
  const [priority, setPriority] = useState('normal')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [mirrorUrl, setMirrorUrl] = useState('https://mirror.orig-hub.net/node-04/cache/')
  const [skipHash, setSkipHash] = useState(false)
  const [preAllocate, setPreAllocate] = useState(true)
  const [sourceError, setSourceError] = useState('')
  const { openDirectoryDialog } = useWailsActions()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleAdd = () => {
    const trimmed = source.trim()
    if (!trimmed) {
      setSourceError('Please enter a URL, magnet link, or torrent file path')
      return
    }
    onAdd(trimmed, undefined, defaultDir || undefined)
    setSource('')
    setSourceError('')
    onOpenChange(false)
  }

  const handleClipboardDetect = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setSource(text)
        setSourceError('')
      }
    } catch {
      // clipboard access denied
    }
  }

  if (!open) return null

  const tabs: { key: TabType; label: string }[] = [
    { key: 'single', label: 'Single URL' },
    { key: 'batch', label: 'Batch' },
    { key: 'torrent', label: 'Torrent/Magnet' },
  ]

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-surface-container-lowest/80 backdrop-blur-sm" onClick={() => onOpenChange(false)} />
      <div className="relative w-full max-w-2xl rounded-xl shadow-2xl shadow-black/50 overflow-hidden" style={{ background: 'rgba(24, 24, 27, 0.7)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
        <div className="px-6 py-5 border-b border-white/5 flex justify-between items-center bg-white/5">
          <h2 className="text-[24px] font-semibold text-on-surface tracking-tight">{t('download.newDownload')}</h2>
          <button className="text-on-surface-variant hover:text-primary transition-colors" onClick={() => onOpenChange(false)}><X className="h-5 w-5" /></button>
        </div>

        <div className="relative flex px-6 border-b border-white/5">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-6 py-4 text-[14px] font-bold transition-all relative ${activeTab === tab.key ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
            >
              {tab.label}
              {activeTab === tab.key && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-6">
          {(activeTab === 'single' || activeTab === 'batch') && (
            <div>
              <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">RESOURCE URL</label>
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  className="w-full h-24 bg-surface-container border border-white/10 rounded-lg p-4 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all resize-none"
                  placeholder={activeTab === 'batch' ? 'Paste multiple URLs, one per line...' : 'Paste link here...'}
                  value={source}
                  onChange={(e) => { setSource(e.target.value); setSourceError('') }}
                />
                <button
                  onClick={handleClipboardDetect}
                  className="absolute bottom-3 right-3 text-[13px] text-primary hover:underline flex items-center gap-1 bg-primary/10 px-2 py-1 rounded transition-colors"
                >
                  <ClipboardPaste className="h-4 w-4" />
                  Auto-detect Clipboard
                </button>
              </div>
              {sourceError && <p className="text-[13px] text-error mt-2">{sourceError}</p>}
            </div>
          )}

          {activeTab === 'torrent' && (
            <div>
              <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">TORRENT FILE</label>
              <div className="border-2 border-dashed border-white/10 rounded-lg p-8 flex flex-col items-center justify-center gap-3 hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer group">
                <Upload className="h-10 w-10 text-on-surface-variant group-hover:text-primary transition-colors" />
                <div className="text-center">
                  <p className="text-[14px] font-bold">Drag & Drop Torrent File</p>
                  <p className="text-[13px] text-on-surface-variant">or click to browse local storage</p>
                </div>
              </div>
              <div className="mt-4">
                <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">OR PASTE MAGNET LINK</label>
                <textarea
                  className="w-full h-16 bg-surface-container border border-white/10 rounded-lg p-4 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all resize-none"
                  placeholder="magnet:?xt=urn:btih:..."
                  value={source}
                  onChange={(e) => { setSource(e.target.value); setSourceError('') }}
                />
              </div>
              {sourceError && <p className="text-[13px] text-error mt-2">{sourceError}</p>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">CATEGORY</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer"
              >
                <option value="auto">{t('download.filenamePlaceholder')}</option>
                <option value="video">Movies & Video</option>
                <option value="audio">Music & Audio</option>
                <option value="software">Software</option>
                <option value="document">Documents</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">PRIORITY</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/20 appearance-none cursor-pointer"
              >
                <option value="normal">Normal</option>
                <option value="high">High (Burst)</option>
                <option value="maximum">Maximum (Override)</option>
                <option value="low">Low (Background)</option>
              </select>
            </div>
          </div>

          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors text-[13px] font-bold"
            >
              <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${showAdvanced ? 'rotate-90' : ''}`} />
              ADVANCED SETTINGS
            </button>
            {showAdvanced && (
              <div className="mt-4 p-4 rounded-lg bg-surface-container-lowest border border-white/5 space-y-4">
                <div>
                  <label className="block text-[11px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">MIRROR EDITING</label>
                  <input
                    type="text"
                    value={mirrorUrl}
                    onChange={(e) => setMirrorUrl(e.target.value)}
                    className="w-full bg-surface-container border border-white/10 rounded-lg px-4 py-2 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipHash}
                      onChange={(e) => setSkipHash(e.target.checked)}
                      className="rounded border-white/20 bg-transparent text-primary focus:ring-0"
                    />
                    <span className="text-[13px]">Skip hash check</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={preAllocate}
                      onChange={(e) => setPreAllocate(e.target.checked)}
                      className="rounded border-white/20 bg-transparent text-primary focus:ring-0"
                    />
                    <span className="text-[13px]">Pre-allocate storage</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-5 bg-white/5 border-t border-white/5 flex items-center justify-between">
          <p className="text-[13px] text-on-surface-variant flex items-center gap-2">
            <Info className="h-[18px] w-[18px] text-primary" />
            Estimated download time: <span className="text-primary font-mono">Calculating...</span>
          </p>
          <div className="flex gap-3">
            <button
              className="px-6 py-2.5 rounded-lg font-bold border border-white/10 hover:bg-white/5 transition-all text-[14px]"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              className="px-6 py-2.5 rounded-lg font-bold text-on-primary shadow-lg shadow-primary/20 active:scale-95 transition-all text-[14px]"
              style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)' }}
              onClick={handleAdd}
              disabled={!source.trim()}
            >
              {t('download.startDownload')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
