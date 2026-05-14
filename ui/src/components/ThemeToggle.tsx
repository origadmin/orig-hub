import { Sun, Moon, Monitor } from 'lucide-react'
import { Button } from './ui/button'
import { useStore } from '../store/useStore'

export function ThemeToggle() {
  const { theme, toggleTheme } = useStore()

  return (
    <Button variant="outline" size="icon" onClick={toggleTheme}>
      {theme === 'light' ? (
        <Moon className="h-4 w-4" />
      ) : theme === 'dark' ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
    </Button>
  )
}
