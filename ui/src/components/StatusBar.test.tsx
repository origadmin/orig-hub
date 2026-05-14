import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { useStore } from '../store/useStore'
import { DownloadStatus } from '../types'

const mockDownload = (overrides: Partial<DownloadStatus> = {}): DownloadStatus => ({
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
})

describe('StatusBar', () => {
  beforeEach(() => {
    useStore.setState({ downloads: [] })
  })

  it('shows 0 active when no downloads', () => {
    render(<StatusBar />)
    expect(screen.getByText('0 active')).toBeInTheDocument()
  })

  it('shows correct active count for downloading items', () => {
    useStore.setState({
      downloads: [
        mockDownload({ id: '1', status: 'downloading' }),
        mockDownload({ id: '2', status: 'downloading' }),
        mockDownload({ id: '3', status: 'paused' }),
      ],
    })
    render(<StatusBar />)
    expect(screen.getByText('2 active')).toBeInTheDocument()
  })

  it('shows total speed of active downloads', () => {
    useStore.setState({
      downloads: [
        mockDownload({ id: '1', speed: 1024 * 1024 }),
        mockDownload({ id: '2', speed: 1024 * 1024 }),
      ],
    })
    render(<StatusBar />)
    expect(screen.getByText('2 MB/s')).toBeInTheDocument()
  })

  it('shows total downloaded bytes', () => {
    useStore.setState({
      downloads: [
        mockDownload({ id: '1', downloaded: 52428800 }),
      ],
    })
    render(<StatusBar />)
    expect(screen.getByText('50 MB')).toBeInTheDocument()
  })

  it('excludes paused downloads from active count', () => {
    useStore.setState({
      downloads: [
        mockDownload({ id: '1', status: 'paused' }),
        mockDownload({ id: '2', status: 'completed' }),
      ],
    })
    render(<StatusBar />)
    expect(screen.getByText('0 active')).toBeInTheDocument()
  })

  it('shows 0 B/s when no active downloads', () => {
    useStore.setState({
      downloads: [
        mockDownload({ id: '1', status: 'paused', speed: 0 }),
      ],
    })
    render(<StatusBar />)
    expect(screen.getByText('0 B/s')).toBeInTheDocument()
  })
})
