import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Label } from './ui/label'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Button } from './ui/button'
import { useStore } from '../store/useStore'
import { useWailsActions } from '../hooks/useWailsEvents'
import { toast } from 'sonner'
import { Globe, FolderDown, Wifi, Bell, Keyboard, Info, Search, Download, Upload, RotateCcw, Zap, Shield, Monitor, Palette, Languages, Rocket, Clipboard, Puzzle, Server, ArrowDownToLine, ArrowUpFromLine, Layers, RefreshCw, Volume2, BellRing, VolumeX, BellOff, ChevronRight, PictureInPicture2 } from 'lucide-react'

type SettingsTab = 'general' | 'downloads' | 'connection' | 'notifications' | 'shortcuts' | 'about'

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'general', label: 'General', icon: <Globe className="h-4 w-4" />, desc: 'Appearance & behavior' },
  { id: 'downloads', label: 'Downloads', icon: <FolderDown className="h-4 w-4" />, desc: 'Paths & defaults' },
  { id: 'connection', label: 'Connection', icon: <Wifi className="h-4 w-4" />, desc: 'Proxy & bandwidth' },
  { id: 'notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" />, desc: 'Alerts & sounds' },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="h-4 w-4" />, desc: 'Keyboard bindings' },
  { id: 'about', label: 'About', icon: <Info className="h-4 w-4" />, desc: 'Version & info' },
]

export function SettingsPanel() {
  const { t } = useTranslation()
  const { settings, updateSettings, locale, setLocale } = useStore()
  const { openDirectoryDialog, saveSettings, setFloatingBarEnabled } = useWailsActions()
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [searchQuery, setSearchQuery] = useState('')

  const handleBrowseDir = async () => {
    const dir = await openDirectoryDialog('Select Download Directory')
    if (dir) {
      updateSettings({ downloadDirectory: dir })
    }
  }

  const handleSave = async () => {
    try {
      await saveSettings(settings.downloadDirectory, settings.maxConnections)
      toast.success('Settings saved')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save settings: ${msg}`)
    }
  }

  const handleReset = () => {
    updateSettings({
      maxConnections: 8,
      downloadDirectory: '',
      autoStart: true,
      notifications: true,
      theme: 'dark',
    })
    toast.info('Settings reset to defaults')
  }

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 border-r border-white/10 bg-surface-container/50 backdrop-blur-xl flex flex-col">
        <div className="p-6 pb-4">
          <h2 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.title')}</h2>
          <p className="text-on-surface-variant text-[12px]">Configure your experience</p>
        </div>
        <div className="px-4 mb-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-on-surface-variant" />
            <input
              type="text"
              placeholder="Search settings..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-surface-container-low border border-white/5 rounded-lg pl-9 pr-3 py-2 text-[12px] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
            />
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-3 flex-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all group ${
                activeTab === tab.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-white/5'
              }`}
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${activeTab === tab.id ? 'bg-primary/20 text-primary' : 'bg-white/5 text-on-surface-variant group-hover:bg-white/10'}`}>
                {tab.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[13px] font-medium ${activeTab === tab.id ? 'text-primary' : ''}`}>{tab.label}</p>
                <p className="text-[10px] text-on-surface-variant truncate">{tab.desc}</p>
              </div>
              {activeTab === tab.id && <ChevronRight className="h-3.5 w-3.5 text-primary/50" />}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-white/5">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
            <Zap className="h-4 w-4 text-primary" />
            <div>
              <p className="text-[11px] font-bold text-primary">Pro Settings</p>
              <p className="text-[10px] text-on-surface-variant">Unlock advanced options</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
          {activeTab === 'general' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.general')}</h3>
                <p className="text-on-surface-variant text-[13px]">Customize the application appearance and behavior.</p>
              </div>
              <div className="glass-card-static rounded-xl p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Palette className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">{t('settings.theme')}</Label>
                      <p className="text-[11px] text-on-surface-variant">Application color scheme</p>
                    </div>
                  </div>
                  <select value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as 'light' | 'dark' | 'system' })} className="rounded-lg border border-white/10 bg-surface-container-low px-4 py-2 text-[13px] focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer">
                    <option value="dark">{t('settings.themeDark')}</option>
                    <option value="light">{t('settings.themeLight')}</option>
                    <option value="system">{t('settings.themeSystem')}</option>
                  </select>
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Languages className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">{t('settings.language')}</Label>
                      <p className="text-[11px] text-on-surface-variant">Display language</p>
                    </div>
                  </div>
                  <select value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'zh-CN' | 'ja')} className="rounded-lg border border-white/10 bg-surface-container-low px-4 py-2 text-[13px] focus:ring-2 focus:ring-primary/20 outline-none cursor-pointer">
                    <option value="en">English</option>
                    <option value="zh-CN">中文</option>
                    <option value="ja">日本語</option>
                  </select>
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Rocket className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Launch at Startup</Label>
                      <p className="text-[11px] text-on-surface-variant">Start with the system</p>
                    </div>
                  </div>
                  <Switch checked={settings.autoStart} onCheckedChange={(c) => updateSettings({ autoStart: c })} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Monitor className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Minimize to Tray</Label>
                      <p className="text-[11px] text-on-surface-variant">Keep running when closed</p>
                    </div>
                  </div>
                  <Switch checked={settings.floatingBarEnabled} onCheckedChange={(c) => { updateSettings({ floatingBarEnabled: c }); setFloatingBarEnabled(c).catch(() => {}) }} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><PictureInPicture2 className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Floating Bar on Close</Label>
                      <p className="text-[11px] text-on-surface-variant">Show floating speed bar instead of closing</p>
                    </div>
                  </div>
                  <Switch checked={settings.floatingBarEnabled} onCheckedChange={(c) => { updateSettings({ floatingBarEnabled: c }); setFloatingBarEnabled(c).catch(() => {}) }} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'downloads' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.downloads')}</h3>
                <p className="text-on-surface-variant text-[13px]">Configure download paths, limits, and automation.</p>
              </div>
              <div className="glass-card-static rounded-xl p-6 space-y-6">
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><FolderDown className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">{t('settings.downloadDir')}</Label>
                      <p className="text-[11px] text-on-surface-variant">Where files are saved by default</p>
                    </div>
                  </div>
                  <div className="flex gap-2 ml-[52px]">
                    <Input value={settings.downloadDirectory} onChange={(e) => updateSettings({ downloadDirectory: e.target.value })} placeholder="Enter download path" className="flex-1 text-[13px] bg-surface-container-low border-white/10" />
                    <Button variant="outline" onClick={handleBrowseDir} type="button" className="text-[12px] border-white/10">{t('common.browse')}</Button>
                  </div>
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Layers className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">{t('settings.maxConnections')}</Label>
                      <p className="text-[11px] text-on-surface-variant">Range: 1-32 connections</p>
                    </div>
                  </div>
                  <Input type="number" value={settings.maxConnections} onChange={(e) => updateSettings({ maxConnections: parseInt(e.target.value) || 1 })} className="w-24 text-[13px] bg-surface-container-low border-white/10 text-center" min={1} max={32} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Zap className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">{t('settings.autoStart')}</Label>
                      <p className="text-[11px] text-on-surface-variant">Begin downloading when URL is added</p>
                    </div>
                  </div>
                  <Switch checked={settings.autoStart} onCheckedChange={(c) => updateSettings({ autoStart: c })} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Clipboard className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Clipboard Monitoring</Label>
                      <p className="text-[11px] text-on-surface-variant">Auto-detect copied URLs</p>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Puzzle className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Browser Extension Integration</Label>
                      <p className="text-[11px] text-on-surface-variant">Capture from browser extensions</p>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'connection' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.connection')}</h3>
                <p className="text-on-surface-variant text-[13px]">Configure proxy, bandwidth limits, and retry behavior.</p>
              </div>
              <div className="glass-card-static rounded-xl p-6 space-y-6">
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Server className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Proxy Configuration</Label>
                      <p className="text-[11px] text-on-surface-variant">Leave empty for direct connection</p>
                    </div>
                  </div>
                  <Input placeholder="http://proxy:port or socks5://proxy:port" className="ml-[52px] text-[13px] bg-surface-container-low border-white/10 font-mono" />
                </div>
                <div className="h-px bg-white/5" />
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><ArrowDownToLine className="h-5 w-5" /></div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[13px] font-medium">Max Download Speed</Label>
                        <span className="text-[12px] text-on-surface-variant font-mono">Unlimited</span>
                      </div>
                    </div>
                  </div>
                  <div className="ml-[52px]">
                    <input type="range" min={0} max={100} defaultValue={0} className="w-full h-1.5 rounded-full appearance-none bg-white/10 accent-primary cursor-pointer" />
                  </div>
                </div>
                <div className="h-px bg-white/5" />
                <div>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><ArrowUpFromLine className="h-5 w-5" /></div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[13px] font-medium">Max Upload Speed</Label>
                        <span className="text-[12px] text-on-surface-variant font-mono">Unlimited</span>
                      </div>
                    </div>
                  </div>
                  <div className="ml-[52px]">
                    <input type="range" min={0} max={100} defaultValue={0} className="w-full h-1.5 rounded-full appearance-none bg-white/10 accent-primary cursor-pointer" />
                  </div>
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Layers className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Max Concurrent Downloads</Label>
                      <p className="text-[11px] text-on-surface-variant">Simultaneous active downloads</p>
                    </div>
                  </div>
                  <Input type="number" defaultValue={5} className="w-24 text-[13px] bg-surface-container-low border-white/10 text-center" min={1} max={20} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><RefreshCw className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Retry Attempts</Label>
                      <p className="text-[11px] text-on-surface-variant">On connection failure</p>
                    </div>
                  </div>
                  <Input type="number" defaultValue={3} className="w-24 text-[13px] bg-surface-container-low border-white/10 text-center" min={0} max={10} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.notifications')}</h3>
                <p className="text-on-surface-variant text-[13px]">Control alerts, sounds, and notification behavior.</p>
              </div>
              <div className="glass-card-static rounded-xl p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><BellRing className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Download Complete</Label>
                      <p className="text-[11px] text-on-surface-variant">Notify when download finishes</p>
                    </div>
                  </div>
                  <Switch checked={settings.notifications} onCheckedChange={(c) => updateSettings({ notifications: c })} />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><BellOff className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Error Notification</Label>
                      <p className="text-[11px] text-on-surface-variant">Notify when download fails</p>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Volume2 className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Sound Alerts</Label>
                      <p className="text-[11px] text-on-surface-variant">Play sound on events</p>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
                <div className="h-px bg-white/5" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface-variant"><Shield className="h-5 w-5" /></div>
                    <div>
                      <Label className="text-[13px] font-medium">Tray Icon Badge</Label>
                      <p className="text-[11px] text-on-surface-variant">Show active count on tray</p>
                    </div>
                  </div>
                  <Switch defaultChecked />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">Keyboard Shortcuts</h3>
                <p className="text-on-surface-variant text-[13px]">Quick access key bindings for common actions.</p>
              </div>
              <div className="glass-card-static rounded-xl overflow-hidden">
                <div className="divide-y divide-white/5">
                  {[
                    { action: 'New Download', keys: 'Ctrl+N', desc: 'Open add download dialog' },
                    { action: 'Pause All', keys: 'Ctrl+Shift+P', desc: 'Pause all active downloads' },
                    { action: 'Resume All', keys: 'Ctrl+Shift+R', desc: 'Resume all paused downloads' },
                    { action: 'Open Settings', keys: 'Ctrl+,', desc: 'Open settings panel' },
                    { action: 'Toggle Floating', keys: 'Ctrl+Shift+F', desc: 'Show/hide floating window' },
                    { action: 'Search', keys: 'Ctrl+F', desc: 'Focus search input' },
                    { action: 'Paste URL', keys: 'Ctrl+V', desc: 'Paste and start download' },
                  ].map((shortcut) => (
                    <div key={shortcut.action} className="flex items-center justify-between px-6 py-4 hover:bg-white/[0.02] transition-colors">
                      <div>
                        <p className="text-[13px] font-medium text-on-surface">{shortcut.action}</p>
                        <p className="text-[11px] text-on-surface-variant">{shortcut.desc}</p>
                      </div>
                      <kbd className="rounded-lg bg-surface-container-low border border-white/10 px-3 py-1.5 text-[11px] font-mono text-on-surface-variant">
                        {shortcut.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="max-w-2xl space-y-8">
              <div>
                <h3 className="font-headline-xl text-headline-xl text-on-surface mb-1">{t('settings.about')}</h3>
                <p className="text-on-surface-variant text-[13px]">Application information and version details.</p>
              </div>
              <div className="glass-card-static rounded-xl p-8 text-center">
                <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/15 mb-4">
                  <Download className="h-10 w-10 text-primary" />
                </div>
                <h4 className="font-headline-xl text-headline-xl text-on-surface">Orig Hub</h4>
                <p className="text-[13px] text-on-surface-variant mt-1">Version 0.1.0 (Build 20260528)</p>
                <p className="text-[12px] text-on-surface-variant/50 mt-2">Desktop Download Manager & Media Hub</p>
              </div>
              <div className="glass-card-static rounded-xl overflow-hidden">
                <div className="divide-y divide-white/5">
                  {[
                    { label: 'Engine', value: 'Wails v3.0.0-alpha.96' },
                    { label: 'Runtime', value: 'Go 1.25 + WebView2' },
                    { label: 'License', value: 'MIT' },
                    { label: 'Architecture', value: 'x86_64' },
                  ].map(item => (
                    <div key={item.label} className="flex items-center justify-between px-6 py-4">
                      <span className="text-[13px] text-on-surface-variant">{item.label}</span>
                      <span className="text-[13px] text-on-surface font-mono">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
              <Button variant="outline" className="w-full text-[13px] border-white/10">
                {t('settings.checkUpdate')}
              </Button>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-white/10 bg-surface/70 backdrop-blur-xl px-8 py-4 flex items-center gap-3">
          <Button onClick={handleSave} className="text-[13px] bg-primary hover:bg-primary/90">
            {t('settings.saveSettings')}
          </Button>
          <Button variant="outline" onClick={handleReset} className="text-[13px] border-white/10">
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {t('settings.resetSettings')}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" className="text-[13px] text-on-surface-variant">
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Export
          </Button>
          <Button variant="ghost" className="text-[13px] text-on-surface-variant">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Import
          </Button>
        </div>
      </div>
    </div>
  )
}
