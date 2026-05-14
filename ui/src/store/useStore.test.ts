import { useStore } from './useStore'
import { DownloadStatus } from '../types'

const mockDownload: DownloadStatus = {
  id: 'dl-1',
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  dest_path: '/downloads',
  total_size: 1048576,
  downloaded: 524288,
  progress: 50.0,
  speed: 102400,
  status: 'downloading',
  error: '',
  eta: 5,
  connections: 4,
  added_at: Date.now(),
  time_taken: 10,
  avg_speed: 100000,
}

const mockDownload2: DownloadStatus = {
  ...mockDownload,
  id: 'dl-2',
  filename: 'file2.zip',
}

describe('useStore', () => {
  beforeEach(() => {
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

  describe('initial state', () => {
    it('should have empty downloads', () => {
      const { downloads } = useStore.getState()
      expect(downloads).toEqual([])
    })

    it('should have default settings', () => {
      const { settings } = useStore.getState()
      expect(settings).toEqual({
        maxConnections: 8,
        downloadDirectory: '',
        autoStart: true,
        notifications: true,
        theme: 'system',
      })
    })

    it('should have theme set to system', () => {
      const { theme } = useStore.getState()
      expect(theme).toBe('system')
    })
  })

  describe('addDownload', () => {
    it('should add a download to the list', () => {
      useStore.getState().addDownload(mockDownload)
      const { downloads } = useStore.getState()
      expect(downloads).toHaveLength(1)
      expect(downloads[0]).toEqual(mockDownload)
    })

    it('should append downloads to existing list', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().addDownload(mockDownload2)
      const { downloads } = useStore.getState()
      expect(downloads).toHaveLength(2)
      expect(downloads[1].id).toBe('dl-2')
    })
  })

  describe('updateDownloads', () => {
    it('should replace the entire downloads list', () => {
      useStore.getState().addDownload(mockDownload)
      const newList = [mockDownload, mockDownload2]
      useStore.getState().updateDownloads(newList)
      const { downloads } = useStore.getState()
      expect(downloads).toEqual(newList)
      expect(downloads).toHaveLength(2)
    })

    it('should replace with empty list', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().updateDownloads([])
      const { downloads } = useStore.getState()
      expect(downloads).toEqual([])
    })
  })

  describe('updateDownload', () => {
    it('should update a specific download by id', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().updateDownload('dl-1', { progress: 75.0, status: 'downloading' })
      const { downloads } = useStore.getState()
      expect(downloads[0].progress).toBe(75.0)
      expect(downloads[0].status).toBe('downloading')
      expect(downloads[0].filename).toBe('file.zip')
    })

    it('should not modify other downloads', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().addDownload(mockDownload2)
      useStore.getState().updateDownload('dl-1', { progress: 99.0 })
      const { downloads } = useStore.getState()
      expect(downloads[0].progress).toBe(99.0)
      expect(downloads[1].progress).toBe(50.0)
    })

    it('should not change list if id not found', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().updateDownload('nonexistent', { progress: 99.0 })
      const { downloads } = useStore.getState()
      expect(downloads[0].progress).toBe(50.0)
    })
  })

  describe('removeDownload', () => {
    it('should remove a download by id', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().addDownload(mockDownload2)
      useStore.getState().removeDownload('dl-1')
      const { downloads } = useStore.getState()
      expect(downloads).toHaveLength(1)
      expect(downloads[0].id).toBe('dl-2')
    })

    it('should not error when removing non-existent id', () => {
      useStore.getState().addDownload(mockDownload)
      useStore.getState().removeDownload('nonexistent')
      const { downloads } = useStore.getState()
      expect(downloads).toHaveLength(1)
    })
  })

  describe('updateSettings', () => {
    it('should update specific settings', () => {
      useStore.getState().updateSettings({ maxConnections: 16 })
      const { settings } = useStore.getState()
      expect(settings.maxConnections).toBe(16)
      expect(settings.autoStart).toBe(true)
    })

    it('should update multiple settings at once', () => {
      useStore.getState().updateSettings({
        downloadDirectory: '/new/path',
        notifications: false,
      })
      const { settings } = useStore.getState()
      expect(settings.downloadDirectory).toBe('/new/path')
      expect(settings.notifications).toBe(false)
      expect(settings.maxConnections).toBe(8)
    })
  })

  describe('toggleTheme', () => {
    it('should cycle from system to light', () => {
      expect(useStore.getState().theme).toBe('system')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('light')
    })

    it('should cycle from light to dark', () => {
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('light')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('dark')
    })

    it('should cycle from dark to system', () => {
      useStore.getState().toggleTheme()
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('dark')
      useStore.getState().toggleTheme()
      expect(useStore.getState().theme).toBe('system')
    })

    it('should update settings.theme alongside theme', () => {
      useStore.getState().toggleTheme()
      expect(useStore.getState().settings.theme).toBe('light')
      useStore.getState().toggleTheme()
      expect(useStore.getState().settings.theme).toBe('dark')
      useStore.getState().toggleTheme()
      expect(useStore.getState().settings.theme).toBe('system')
    })
  })
})
