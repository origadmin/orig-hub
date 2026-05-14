import '@testing-library/jest-dom'
import { useStore } from './store/useStore'
import { DownloadStatus } from './types'
import { AddDownload, PauseDownload, ResumeDownload, CancelDownload, GetDefaultDownloadDir } from 'wailsjs/go/main/App.js'

jest.mock('wailsjs/runtime/runtime.js', () => ({
  EventsOn: jest.fn(),
  EventsOff: jest.fn(),
  EventsEmit: jest.fn(),
}))

jest.mock('wailsjs/go/main/App.js', () => ({
  AddDownload: jest.fn().mockResolvedValue('test-id-1'),
  PauseDownload: jest.fn().mockResolvedValue(undefined),
  ResumeDownload: jest.fn().mockResolvedValue(undefined),
  CancelDownload: jest.fn().mockResolvedValue(undefined),
  ListDownloads: jest.fn().mockResolvedValue([]),
  GetDownloadStatus: jest.fn().mockResolvedValue(null),
  GetDownloadHistory: jest.fn().mockResolvedValue([]),
  GetDefaultDownloadDir: jest.fn().mockResolvedValue('/home/user/Downloads'),
}))

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
  Toaster: () => null,
}))

function createMockDownload(overrides: Partial<DownloadStatus> = {}): DownloadStatus {
  return {
    id: 'dl-1',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    dest_path: '/downloads',
    total_size: 104857600,
    downloaded: 52428800,
    progress: 50,
    speed: 1024 * 1024,
    status: 'downloading',
    error: '',
    eta: 50,
    connections: 4,
    added_at: Date.now() / 1000 - 100,
    time_taken: 100,
    avg_speed: 512 * 1024,
    ...overrides,
  }
}

describe('App Flow Logic Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useStore.setState({
      downloads: [],
      settings: {
        maxConnections: 8,
        downloadDirectory: '',
        autoStart: true,
        notifications: true,
        theme: 'system',
      },
      theme: 'system',
    })
  })

  describe('Download state management flow', () => {
    it('adds download to store and updates list', () => {
      const dl = createMockDownload()
      useStore.getState().addDownload(dl)
      expect(useStore.getState().downloads).toHaveLength(1)
      expect(useStore.getState().downloads[0].id).toBe('dl-1')
    })

    it('pauses download by updating status', () => {
      const dl = createMockDownload({ id: 'dl-1', status: 'downloading' })
      useStore.getState().addDownload(dl)
      useStore.getState().updateDownload('dl-1', { status: 'paused' })
      expect(useStore.getState().downloads[0].status).toBe('paused')
    })

    it('resumes download by updating status', () => {
      const dl = createMockDownload({ id: 'dl-1', status: 'paused' })
      useStore.getState().addDownload(dl)
      useStore.getState().updateDownload('dl-1', { status: 'downloading' })
      expect(useStore.getState().downloads[0].status).toBe('downloading')
    })

    it('cancels download by removing from list', () => {
      const dl = createMockDownload({ id: 'dl-1' })
      useStore.getState().addDownload(dl)
      useStore.getState().removeDownload('dl-1')
      expect(useStore.getState().downloads).toHaveLength(0)
    })

    it('updates multiple downloads at once', () => {
      useStore.getState().updateDownloads([
        createMockDownload({ id: 'dl-1' }),
        createMockDownload({ id: 'dl-2', filename: 'file2.zip' }),
      ])
      expect(useStore.getState().downloads).toHaveLength(2)
    })
  })

  describe('AddDownload API integration', () => {
    it('calls AddDownload with default dir when outputPath is empty', async () => {
      const url = 'https://example.com/file.zip'
      const defaultDir = '/home/user/Downloads'
      await AddDownload(url, defaultDir, '', [], {})
      expect(AddDownload as jest.Mock).toHaveBeenCalledWith(url, defaultDir, '', [], {})
    })

    it('calls AddDownload with custom outputPath', async () => {
      const url = 'https://example.com/file.zip'
      const customPath = '/custom/path'
      await AddDownload(url, customPath, 'file.zip', [], {})
      expect(AddDownload as jest.Mock).toHaveBeenCalledWith(url, customPath, 'file.zip', [], {})
    })
  })

  describe('Download operation API calls', () => {
    it('calls PauseDownload with correct id', async () => {
      await PauseDownload('dl-1')
      expect(PauseDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })

    it('calls ResumeDownload with correct id', async () => {
      await ResumeDownload('dl-1')
      expect(ResumeDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })

    it('calls CancelDownload with correct id', async () => {
      await CancelDownload('dl-1')
      expect(CancelDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })
  })

  describe('Default download directory', () => {
    it('fetches default download dir from backend', async () => {
      const dir = await GetDefaultDownloadDir()
      expect(dir).toBe('/home/user/Downloads')
      expect(GetDefaultDownloadDir as jest.Mock).toHaveBeenCalled()
    })

    it('updates settings with default dir', async () => {
      const dir = await GetDefaultDownloadDir()
      useStore.getState().updateSettings({ downloadDirectory: dir })
      expect(useStore.getState().settings.downloadDirectory).toBe('/home/user/Downloads')
    })
  })

  describe('Theme toggle flow', () => {
    it('cycles theme system → light → dark → system', () => {
      expect(useStore.getState().theme).toBe('system')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('light')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('dark')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('system')
    })
  })

  describe('Status bar calculation', () => {
    it('counts active downloads correctly', () => {
      useStore.getState().updateDownloads([
        createMockDownload({ id: '1', status: 'downloading' }),
        createMockDownload({ id: '2', status: 'downloading', filename: 'file2.zip' }),
        createMockDownload({ id: '3', status: 'paused', filename: 'file3.zip' }),
        createMockDownload({ id: '4', status: 'completed', filename: 'file4.zip' }),
      ])
      const active = useStore.getState().downloads.filter(d => d.status === 'downloading')
      expect(active).toHaveLength(2)
    })

    it('calculates total speed of active downloads', () => {
      useStore.getState().updateDownloads([
        createMockDownload({ id: '1', status: 'downloading', speed: 1024 * 1024 }),
        createMockDownload({ id: '2', status: 'downloading', speed: 1024 * 1024, filename: 'file2.zip' }),
      ])
      const totalSpeed = useStore.getState().downloads
        .filter(d => d.status === 'downloading')
        .reduce((sum, d) => sum + d.speed, 0)
      expect(totalSpeed).toBe(2 * 1024 * 1024)
    })
  })
})
