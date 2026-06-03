import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadItem } from './DownloadItem'
import { DownloadStatus } from '../types'

const baseDownload: DownloadStatus = {
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
  eta: 300,
  connections: 4,
  added_at: Date.now(),
  time_taken: 10,
  avg_speed: 100000,
}

function renderDownloadItem(overrides: Partial<DownloadStatus> = {}) {
  const onPause = jest.fn()
  const onResume = jest.fn()
  const onCancel = jest.fn()
  const onRemove = jest.fn()
  const download = { ...baseDownload, ...overrides }

  const result = render(
    <DownloadItem
      download={download}
      onPause={onPause}
      onResume={onResume}
      onCancel={onCancel}
      onRemove={onRemove}
    />
  )

  return { onPause, onResume, onCancel, onRemove, ...result }
}

describe('DownloadItem', () => {
  describe('rendering', () => {
    it('should show the filename', () => {
      renderDownloadItem()
      expect(screen.getByText('file.zip')).toBeInTheDocument()
    })

    it('should show the progress percentage', () => {
      renderDownloadItem({ progress: 50.0 })
      expect(screen.getByText('50.0%')).toBeInTheDocument()
    })

    it('should show download speed', () => {
      renderDownloadItem({ speed: 102400 })
      expect(screen.getByText('100 KB/s')).toBeInTheDocument()
    })

    it('should show ETA time', () => {
      renderDownloadItem({ eta: 300 })
      expect(screen.getByText('5m 0s')).toBeInTheDocument()
    })

    it('should show downloaded and total size', () => {
      renderDownloadItem({ downloaded: 524288, total_size: 1048576 })
      expect(screen.getByText(/512 KB/)).toBeInTheDocument()
    })

    it('should show the status label', () => {
      renderDownloadItem({ status: 'downloading' })
      expect(screen.getByText('Downloading')).toBeInTheDocument()
    })
  })

  describe('downloading status', () => {
    it('should show Pause button', () => {
      renderDownloadItem({ status: 'downloading' })
      expect(screen.getByTitle('Pause')).toBeInTheDocument()
    })

    it('should show Cancel button', () => {
      renderDownloadItem({ status: 'downloading' })
      expect(screen.getByTitle('Cancel')).toBeInTheDocument()
    })

    it('should not show Resume button', () => {
      renderDownloadItem({ status: 'downloading' })
      expect(screen.queryByTitle('Resume')).not.toBeInTheDocument()
    })

    it('should not show Remove button', () => {
      renderDownloadItem({ status: 'downloading' })
      expect(screen.queryByTitle('Remove')).not.toBeInTheDocument()
    })
  })

  describe('paused status', () => {
    it('should show Resume button', () => {
      renderDownloadItem({ status: 'paused' })
      expect(screen.getByTitle('Resume')).toBeInTheDocument()
    })

    it('should not show Cancel button', () => {
      renderDownloadItem({ status: 'paused' })
      expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument()
    })

    it('should not show Pause button', () => {
      renderDownloadItem({ status: 'paused' })
      expect(screen.queryByTitle('Pause')).not.toBeInTheDocument()
    })
  })

  describe('queued status', () => {
    it('should show Cancel button', () => {
      renderDownloadItem({ status: 'queued' })
      expect(screen.getByTitle('Cancel')).toBeInTheDocument()
    })

    it('should not show Pause button', () => {
      renderDownloadItem({ status: 'queued' })
      expect(screen.queryByTitle('Pause')).not.toBeInTheDocument()
    })
  })

  describe('completed status', () => {
    it('should show Remove button', () => {
      renderDownloadItem({ status: 'completed' })
      expect(screen.getByTitle('Remove')).toBeInTheDocument()
    })

    it('should not show Pause or Cancel buttons', () => {
      renderDownloadItem({ status: 'completed' })
      expect(screen.queryByTitle('Pause')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument()
    })
  })

  describe('error status', () => {
    it('should show Remove button', () => {
      renderDownloadItem({ status: 'error', error: 'connection failed' })
      expect(screen.getByTitle('Remove')).toBeInTheDocument()
    })

    it('should show error message', () => {
      renderDownloadItem({ status: 'error', error: 'connection failed' })
      expect(screen.getByText('connection failed')).toBeInTheDocument()
    })
  })

  describe('button interactions', () => {
    it('should call onPause with correct id when Pause is clicked', async () => {
      const user = userEvent.setup()
      const { onPause } = renderDownloadItem({ status: 'downloading' })
      await user.click(screen.getByTitle('Pause'))
      expect(onPause).toHaveBeenCalledWith('dl-1')
    })

    it('should call onResume with correct id when Resume is clicked', async () => {
      const user = userEvent.setup()
      const { onResume } = renderDownloadItem({ status: 'paused' })
      await user.click(screen.getByTitle('Resume'))
      expect(onResume).toHaveBeenCalledWith('dl-1')
    })

    it('should call onCancel with correct id when Cancel is clicked', async () => {
      const user = userEvent.setup()
      const { onCancel } = renderDownloadItem({ status: 'downloading' })
      await user.click(screen.getByTitle('Cancel'))
      expect(onCancel).toHaveBeenCalledWith('dl-1')
    })

    it('should call onRemove with correct id when Remove is clicked', async () => {
      const user = userEvent.setup()
      const { onRemove } = renderDownloadItem({ status: 'completed' })
      await user.click(screen.getByTitle('Remove'))
      expect(onRemove).toHaveBeenCalledWith('dl-1')
    })
  })
})
