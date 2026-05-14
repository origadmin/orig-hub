import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeToggle } from './ThemeToggle'
import { useStore } from '../store/useStore'

describe('ThemeToggle', () => {
  beforeEach(() => {
    useStore.setState({ theme: 'system' })
  })

  it('renders a button', () => {
    render(<ThemeToggle />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(1)
  })

  it('cycles theme from system to light on first click', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    await user.click(button)
    expect(useStore.getState().theme).toBe('light')
  })

  it('cycles theme from light to dark on second click', async () => {
    const user = userEvent.setup()
    useStore.setState({ theme: 'light' })
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    await user.click(button)
    expect(useStore.getState().theme).toBe('dark')
  })

  it('cycles theme from dark back to system', async () => {
    const user = userEvent.setup()
    useStore.setState({ theme: 'dark' })
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    await user.click(button)
    expect(useStore.getState().theme).toBe('system')
  })

  it('syncs settings.theme with theme on toggle', async () => {
    const user = userEvent.setup()
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    await user.click(button)
    expect(useStore.getState().settings.theme).toBe('light')
  })
})
