import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from './SettingsPanel'
import { useStore } from '../store/useStore'

describe('SettingsPanel', () => {
  beforeEach(() => {
    useStore.setState({
      settings: {
        maxConnections: 8,
        downloadDirectory: '',
        autoStart: true,
        notifications: true,
        theme: 'system',
      },
    })
  })

  it('renders all settings fields', () => {
    render(<SettingsPanel />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByLabelText('Max Connections')).toBeInTheDocument()
    expect(screen.getByLabelText('Download Directory')).toBeInTheDocument()
    expect(screen.getByLabelText('Auto Start Downloads')).toBeInTheDocument()
    expect(screen.getByLabelText('Enable Notifications')).toBeInTheDocument()
  })

  it('shows default max connections value', () => {
    render(<SettingsPanel />)
    const input = screen.getByLabelText('Max Connections') as HTMLInputElement
    expect(input.value).toBe('8')
  })

  it('updates max connections when input changes', () => {
    render(<SettingsPanel />)
    const input = screen.getByLabelText('Max Connections')
    fireEvent.change(input, { target: { value: '16' } })
    expect(useStore.getState().settings.maxConnections).toBe(16)
  })

  it('updates download directory when input changes', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel />)
    const input = screen.getByLabelText('Download Directory')
    await user.type(input, '/home/user/downloads')
    expect(useStore.getState().settings.downloadDirectory).toBe('/home/user/downloads')
  })

  it('toggles auto start switch', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel />)
    const switchEl = screen.getByRole('switch', { name: 'Auto Start Downloads' })
    expect(switchEl).toBeChecked()
    await user.click(switchEl)
    expect(useStore.getState().settings.autoStart).toBe(false)
  })

  it('toggles notifications switch', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel />)
    const switchEl = screen.getByRole('switch', { name: 'Enable Notifications' })
    expect(switchEl).toBeChecked()
    await user.click(switchEl)
    expect(useStore.getState().settings.notifications).toBe(false)
  })
})
