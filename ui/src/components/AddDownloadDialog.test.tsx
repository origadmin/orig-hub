import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddDownloadDialog } from './AddDownloadDialog'

describe('AddDownloadDialog', () => {
  const onOpenChange = jest.fn()
  const onAdd = jest.fn()
  const defaultDir = '/home/user/Downloads'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders dialog when open is true', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Add Download' })).toBeInTheDocument()
    expect(screen.getByText('Enter the URL of the file you want to download')).toBeInTheDocument()
  })

  it('does not render dialog content when open is false', () => {
    render(<AddDownloadDialog open={false} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows URL, Filename, and Save to inputs', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    expect(screen.getByLabelText('URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Filename (optional)')).toBeInTheDocument()
    expect(screen.getByLabelText('Save to')).toBeInTheDocument()
  })

  it('pre-fills Save to with defaultDir', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    const input = screen.getByLabelText('Save to') as HTMLInputElement
    expect(input.value).toBe(defaultDir)
  })

  it('disables Add Download button when URL is empty', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    const addBtn = screen.getByRole('button', { name: 'Add Download' })
    expect(addBtn).toBeDisabled()
  })

  it('enables Add Download button when URL is entered', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    const urlInput = screen.getByLabelText('URL')
    await user.type(urlInput, 'https://example.com/file.zip')
    const addBtn = screen.getByRole('button', { name: 'Add Download' })
    expect(addBtn).not.toBeDisabled()
  })

  it('calls onAdd with url, filename, destPath and closes dialog', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    await user.type(screen.getByLabelText('URL'), 'https://example.com/file.zip')
    await user.type(screen.getByLabelText('Filename (optional)'), 'file.zip')
    await user.click(screen.getByRole('button', { name: 'Add Download' }))
    expect(onAdd).toHaveBeenCalledWith('https://example.com/file.zip', 'file.zip', defaultDir)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses defaultDir when destPath is not changed', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} defaultDir={defaultDir} />)
    await user.type(screen.getByLabelText('URL'), 'https://example.com/file.zip')
    await user.click(screen.getByRole('button', { name: 'Add Download' }))
    expect(onAdd).toHaveBeenCalledWith('https://example.com/file.zip', undefined, defaultDir)
  })
})
