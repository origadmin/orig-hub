import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadList } from './DownloadList'
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
  eta: 300,
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

function renderDownloadList(downloads: DownloadStatus[] = []) {
  const onPause = jest.fn()
  const onResume = jest.fn()
  const onCancel = jest.fn()
  const onRemove = jest.fn()

  const result = render(
    <DownloadList
      downloads={downloads}
      onPause={onPause}
      onResume={onResume}
      onCancel={onCancel}
      onRemove={onRemove}
    />
  )

  return { onPause, onResume, onCancel, onRemove, ...result }
}

describe('DownloadList', () => {
  it('should show empty message when list is empty', () => {
    renderDownloadList([])
    expect(screen.getByText(/No downloads yet/)).toBeInTheDocument()
  })

  it('should render a DownloadItem for each download', () => {
    renderDownloadList([mockDownload, mockDownload2])
    expect(screen.getByText('file.zip')).toBeInTheDocument()
    expect(screen.getByText('file2.zip')).toBeInTheDocument()
  })

  it('should not show empty message when there are downloads', () => {
    renderDownloadList([mockDownload])
    expect(screen.queryByText(/No downloads yet/)).not.toBeInTheDocument()
  })

  it('should pass onPause callback to DownloadItem', async () => {
    const user = userEvent.setup()
    const { onPause } = renderDownloadList([mockDownload])
    await user.click(screen.getByTitle('Pause'))
    expect(onPause).toHaveBeenCalledWith('dl-1')
  })

  it('should pass onResume callback to DownloadItem', async () => {
    const user = userEvent.setup()
    const { onResume } = renderDownloadList([{ ...mockDownload, status: 'paused' }])
    await user.click(screen.getByTitle('Resume'))
    expect(onResume).toHaveBeenCalledWith('dl-1')
  })

  it('should pass onCancel callback to DownloadItem', async () => {
    const user = userEvent.setup()
    const { onCancel } = renderDownloadList([mockDownload])
    await user.click(screen.getByTitle('Cancel'))
    expect(onCancel).toHaveBeenCalledWith('dl-1')
  })
})
