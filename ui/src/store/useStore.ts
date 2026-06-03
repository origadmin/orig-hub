import { create } from 'zustand'
import { DownloadStatus, AppSettings, ThemeValue } from '../types'
import i18n from '../i18n'
import { Events } from '@wailsio/runtime'

export type LocaleValue = 'en' | 'zh-CN' | 'ja'

interface State {
  downloads: DownloadStatus[]
  addDownload: (download: DownloadStatus) => void
  updateDownloads: (downloads: DownloadStatus[]) => void
  updateDownload: (id: string, updates: Partial<DownloadStatus>) => void
  removeDownload: (id: string) => void
  settings: AppSettings
  updateSettings: (updates: Partial<AppSettings>) => void
  theme: ThemeValue
  toggleTheme: () => void
  locale: LocaleValue
  setLocale: (locale: LocaleValue) => void
  useMockData: boolean
  enableMockData: () => void
  tickMockDownloads: () => void
  floatingMode: boolean
  setFloatingMode: (mode: boolean) => void
}

const defaultSettings: AppSettings = {
  maxConnections: 8,
  downloadDirectory: 'C:\\Users\\User\\Downloads',
  autoStart: true,
  notifications: true,
  theme: 'dark',
  floatingBarEnabled: true,
}

const MOCK_DOWNLOADS: DownloadStatus[] = [
  {
    id: 'mock-1',
    url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
    filename: 'ubuntu-24.04-desktop-amd64.iso',
    dest_path: 'C:\\Users\\User\\Downloads',
    total_size: 5016199168,
    downloaded: 3261527859,
    progress: 65.0,
    speed: 5242880,
    status: 'downloading',
    eta: 334,
    connections: 8,
    added_at: Date.now() - 600000,
    time_taken: 600,
    avg_speed: 4194304,
  },
  {
    id: 'mock-2',
    url: 'magnet:?xt=urn:btih:abc123&dn=Big.Buck.Bunny.1080p.mkv&tr=udp%3A%2F%2Ftracker.example.com',
    filename: 'Big.Buck.Bunny.1080p.mkv',
    dest_path: 'C:\\Users\\User\\Downloads\\Videos',
    total_size: 1572864000,
    downloaded: 786432000,
    progress: 50.0,
    speed: 2097152,
    status: 'downloading',
    eta: 375,
    connections: 24,
    added_at: Date.now() - 480000,
    time_taken: 480,
    avg_speed: 1572864,
  },
  {
    id: 'mock-3',
    url: 'https://cdn.example.com/driver-nvidia-551.76-win10.exe',
    filename: 'driver-nvidia-551.76-win10.exe',
    dest_path: 'C:\\Users\\User\\Downloads',
    total_size: 524288000,
    downloaded: 524288000,
    progress: 100,
    speed: 0,
    status: 'completed',
    eta: 0,
    connections: 4,
    added_at: Date.now() - 3600000,
    time_taken: 180,
    avg_speed: 2730669,
  },
  {
    id: 'mock-4',
    url: 'https://archive.org/download/some-podcast-ep42/some-podcast-ep42.mp3',
    filename: 'some-podcast-ep42.mp3',
    dest_path: 'C:\\Users\\User\\Downloads\\Audio',
    total_size: 89128960,
    downloaded: 44564480,
    progress: 50.0,
    speed: 0,
    status: 'paused',
    eta: 0,
    connections: 2,
    added_at: Date.now() - 900000,
    time_taken: 300,
    avg_speed: 148548,
  },
  {
    id: 'mock-5',
    url: 'https://example.com/file-not-found.zip',
    filename: 'file-not-found.zip',
    dest_path: 'C:\\Users\\User\\Downloads',
    total_size: 0,
    downloaded: 0,
    progress: 0,
    speed: 0,
    status: 'error',
    error: '404 Not Found',
    eta: 0,
    connections: 0,
    added_at: Date.now() - 120000,
    time_taken: 5,
    avg_speed: 0,
  },
  {
    id: 'mock-6',
    url: 'https://speed.cloudflare.com/__down?bytes=1073741824',
    filename: 'speed-test-1gb.bin',
    dest_path: 'C:\\Users\\User\\Downloads',
    total_size: 1073741824,
    downloaded: 0,
    progress: 0,
    speed: 0,
    status: 'queued',
    eta: 0,
    connections: 0,
    added_at: Date.now() - 30000,
    time_taken: 0,
    avg_speed: 0,
  },
  {
    id: 'mock-7',
    url: 'https://video.example.com/stream/4k-nature-doc-ep1.mp4',
    filename: '4k-nature-doc-ep1.mp4',
    dest_path: 'C:\\Users\\User\\Downloads\\Videos',
    total_size: 8589934592,
    downloaded: 2147483648,
    progress: 25.0,
    speed: 10485760,
    status: 'downloading',
    eta: 614,
    connections: 16,
    added_at: Date.now() - 180000,
    time_taken: 180,
    avg_speed: 10485760,
  },
  {
    id: 'mock-8',
    url: 'https://releases.nodejs.org/v22.2.0/node-v22.2.0-x64.msi',
    filename: 'node-v22.2.0-x64.msi',
    dest_path: 'C:\\Users\\User\\Downloads',
    total_size: 31457280,
    downloaded: 31457280,
    progress: 100,
    speed: 0,
    status: 'completed',
    eta: 0,
    connections: 4,
    added_at: Date.now() - 7200000,
    time_taken: 12,
    avg_speed: 2621440,
  },
]

export const useStore = create<State>((set) => ({
  downloads: [],
  addDownload: (download) =>
    set((state) => ({ downloads: [...state.downloads, download] })),
  updateDownloads: (downloads) =>
    set({ downloads }),
  updateDownload: (id, updates) =>
    set((state) => ({
      downloads: state.downloads.map((d) => (d.id === id ? { ...d, ...updates } : d)),
    })),
  removeDownload: (id) =>
    set((state) => ({ downloads: state.downloads.filter((d) => d.id !== id) })),
  settings: defaultSettings,
  updateSettings: (updates) =>
    set((state) => ({ settings: { ...state.settings, ...updates } })),
  theme: 'dark',
  toggleTheme: () =>
    set((state) => {
      const next: Record<ThemeValue, ThemeValue> = {
        light: 'dark',
        dark: 'system',
        system: 'light',
      }
      return { theme: next[state.theme], settings: { ...state.settings, theme: next[state.theme] } }
    }),
  locale: (localStorage.getItem('orig-hub-locale') as LocaleValue) || 'en',
  setLocale: (locale) => {
    i18n.changeLanguage(locale)
    Events.Emit('locale:changed', locale)
    set({ locale })
  },
  useMockData: false,
  enableMockData: () => set({ downloads: MOCK_DOWNLOADS, useMockData: true }),
  tickMockDownloads: () => set((state) => {
    if (!state.useMockData) return state
    const updated = state.downloads.map((d) => {
      if (d.status !== 'downloading') return d
      const increment = d.speed * 1.0
      const newDownloaded = Math.min(d.downloaded + increment, d.total_size)
      const newProgress = d.total_size > 0 ? Math.min((newDownloaded / d.total_size) * 100, 99.9) : 0
      const speedVariation = 0.85 + Math.random() * 0.3
      return {
        ...d,
        downloaded: newDownloaded,
        progress: newProgress,
        speed: d.speed * speedVariation,
        time_taken: d.time_taken + 1,
        avg_speed: d.time_taken > 0 ? newDownloaded / (d.time_taken + 1) : 0,
      }
    })
    return { downloads: updated }
  }),
  floatingMode: false,
  setFloatingMode: (mode) => set({ floatingMode: mode }),
}))
