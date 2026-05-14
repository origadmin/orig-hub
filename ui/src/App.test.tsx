import '@testing-library/jest-dom'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { useStore } from './store/useStore'
import { DownloadStatus } from './types'
import { AddDownload, PauseDownload, ResumeDownload, CancelDownload } from 'wailsjs/go/main/App.js'

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

describe('App Integration Tests', () => {
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

  describe('Flow 1: Page Navigation', () => {
    it('starts on Downloads tab by default', async () => {
      await act(async () => {
        render(<App />)
      })

      expect(screen.getByRole('heading', { name: 'Downloads' })).toBeInTheDocument()
      expect(screen.getByText('No downloads yet')).toBeInTheDocument()
    })

    it('switches to History view when History tab is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('tab', { name: 'History' }))

      expect(screen.getByText('No history yet')).toBeInTheDocument()
    })

    it('switches to Settings view when Settings tab is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('tab', { name: 'Settings' }))

      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
      expect(screen.getByLabelText('Max Connections')).toBeInTheDocument()
    })

    it('returns to Downloads view when Downloads tab is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('tab', { name: 'History' }))
      expect(screen.getByText('No history yet')).toBeInTheDocument()

      await user.click(screen.getByRole('tab', { name: 'Downloads' }))
      expect(screen.getByText('No downloads yet')).toBeInTheDocument()
    })
  })

  describe('Flow 2: Add Download Flow', () => {
    it('opens dialog when Add Download button is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: /add download/i }))

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByLabelText('URL')).toBeInTheDocument()
    })

    it('calls AddDownload API when URL is entered and Add Download is clicked in dialog', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: /add download/i }))

      const dialog = screen.getByRole('dialog')
      const urlInput = within(dialog).getByLabelText('URL')
      await user.type(urlInput, 'https://example.com/file.zip')

      const addBtn = within(dialog).getByRole('button', { name: /add download/i })
      await user.click(addBtn)

      expect(AddDownload as jest.Mock).toHaveBeenCalledWith(
        'https://example.com/file.zip',
        '',
        '',
        [],
        {}
      )
    })

    it('closes dialog after adding download', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: /add download/i }))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      const dialog = screen.getByRole('dialog')
      const urlInput = within(dialog).getByLabelText('URL')
      await user.type(urlInput, 'https://example.com/file.zip')

      const addBtn = within(dialog).getByRole('button', { name: /add download/i })
      await user.click(addBtn)

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('Flow 3: Download Operations', () => {
    it('shows Pause and Cancel buttons for downloading items', async () => {
      useStore.setState({
        downloads: [createMockDownload({ status: 'downloading' })],
      })

      await act(async () => {
        render(<App />)
      })

      expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    })

    it('calls PauseDownload API when Pause is clicked', async () => {
      const user = userEvent.setup()
      useStore.setState({
        downloads: [createMockDownload({ id: 'dl-1', status: 'downloading' })],
      })

      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: 'Pause' }))

      expect(PauseDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })

    it('shows Resume button when download is paused', async () => {
      useStore.setState({
        downloads: [createMockDownload({ status: 'paused' })],
      })

      await act(async () => {
        render(<App />)
      })

      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    })

    it('calls ResumeDownload API when Resume is clicked', async () => {
      const user = userEvent.setup()
      useStore.setState({
        downloads: [createMockDownload({ id: 'dl-1', status: 'paused' })],
      })

      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: 'Resume' }))

      expect(ResumeDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })

    it('calls CancelDownload API when Cancel is clicked', async () => {
      const user = userEvent.setup()
      useStore.setState({
        downloads: [createMockDownload({ id: 'dl-1', status: 'downloading' })],
      })

      await act(async () => {
        render(<App />)
      })

      await user.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(CancelDownload as jest.Mock).toHaveBeenCalledWith('dl-1')
    })
  })

  describe('Flow 4: Theme Toggle', () => {
    it('shows ThemeToggle button on Downloads page', async () => {
      await act(async () => {
        render(<App />)
      })

      const iconButtons = screen.getAllByRole('button').filter(
        (btn) => !btn.textContent?.trim()
      )
      expect(iconButtons.length).toBeGreaterThan(0)
    })

    it('changes theme when ThemeToggle is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        render(<App />)
      })

      expect(useStore.getState().theme).toBe('system')

      const themeToggle = screen.getAllByRole('button').find(
        (btn) => !btn.textContent?.trim()
      )
      expect(themeToggle).toBeTruthy()

      await user.click(themeToggle!)

      expect(useStore.getState().theme).toBe('light')
    })
  })

  describe('Flow 5: Status Bar', () => {
    it('shows active download count in status bar', async () => {
      useStore.setState({
        downloads: [
          createMockDownload({ id: 'dl-1', status: 'downloading' }),
          createMockDownload({ id: 'dl-2', status: 'downloading', filename: 'file2.zip' }),
          createMockDownload({ id: 'dl-3', status: 'paused', filename: 'file3.zip' }),
        ],
      })

      await act(async () => {
        render(<App />)
      })

      expect(screen.getByText('2 active')).toBeInTheDocument()
    })

    it('updates status bar when downloads change', async () => {
      useStore.setState({
        downloads: [createMockDownload({ id: 'dl-1', status: 'downloading' })],
      })

      await act(async () => {
        render(<App />)
      })

      expect(screen.getByText('1 active')).toBeInTheDocument()

      await act(async () => {
        useStore.setState({
          downloads: [createMockDownload({ id: 'dl-1', status: 'completed' })],
        })
      })

      expect(screen.getByText('0 active')).toBeInTheDocument()
    })
  })
})
