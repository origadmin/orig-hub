import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddDownloadDialog } from './AddDownloadDialog'

describe('AddDownloadDialog', () => {
  const onOpenChange = jest.fn()
  const onAdd = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders dialog when open is true', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: 'Add Download' })).toBeInTheDocument()
    expect(screen.getByText('Enter the URL of the file you want to download')).toBeInTheDocument()
  })

  it('does not render dialog content when open is false', () => {
    render(<AddDownloadDialog open={false} onOpenChange={onOpenChange} onAdd={onAdd} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows URL, Filename, and DestPath inputs', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    expect(screen.getByLabelText('URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Filename (optional)')).toBeInTheDocument()
    expect(screen.getByLabelText('Output Path (optional)')).toBeInTheDocument()
  })

  it('disables Add Download button when URL is empty', () => {
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    const addBtn = screen.getByRole('button', { name: 'Add Download' })
    expect(addBtn).toBeDisabled()
  })

  it('enables Add Download button when URL is entered', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    const urlInput = screen.getByLabelText('URL')
    await user.type(urlInput, 'https://example.com/file.zip')
    const addBtn = screen.getByRole('button', { name: 'Add Download' })
    expect(addBtn).not.toBeDisabled()
  })

  it('calls onAdd with url, filename, destPath and closes dialog', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    await user.type(screen.getByLabelText('URL'), 'https://example.com/file.zip')
    await user.type(screen.getByLabelText('Filename (optional)'), 'file.zip')
    await user.type(screen.getByLabelText('Output Path (optional)'), '/downloads')
    await user.click(screen.getByRole('button', { name: 'Add Download' }))
    expect(onAdd).toHaveBeenCalledWith('https://example.com/file.zip', 'file.zip', '/downloads')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onAdd with undefined for empty optional fields', async () => {
    const user = userEvent.setup()
    render(<AddDownloadDialog open={true} onOpenChange={onOpenChange} onAdd={onAdd} />)
    await user.type(screen.getByLabelText('URL'), 'https://example.com/file.zip')
    await user.click(screen.getByRole('button', { name: 'Add Download' }))
    expect(onAdd).toHaveBeenCalledWith('https://example.com/file.zip', undefined, undefined)
  })
})
