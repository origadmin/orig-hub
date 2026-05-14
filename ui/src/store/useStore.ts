import { create } from 'zustand'
import { DownloadStatus, AppSettings, ThemeValue } from '../types'

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
}

const defaultSettings: AppSettings = {
  maxConnections: 8,
  downloadDirectory: '',
  autoStart: true,
  notifications: true,
  theme: 'system',
}

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
  theme: 'system',
  toggleTheme: () =>
    set((state) => {
      const next: Record<ThemeValue, ThemeValue> = {
        light: 'dark',
        dark: 'system',
        system: 'light',
      }
      return { theme: next[state.theme], settings: { ...state.settings, theme: next[state.theme] } }
    }),
}))
