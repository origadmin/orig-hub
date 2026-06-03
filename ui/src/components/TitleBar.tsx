import { Minus, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Window } from '@wailsio/runtime'

export function TitleBar() {
  const { t } = useTranslation()
  const handleDoubleClick = () => {
    Window.ToggleMaximise()
  }

  return (
    <div
      className="flex h-9 shrink-0 items-center border-b bg-card select-none cursor-default"
      style={{ '--wails-draggable': 'drag' } as React.CSSProperties}
      onDoubleClick={handleDoubleClick}
    >
      <div className="flex items-center gap-2 px-3">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-primary text-primary-foreground text-[9px] font-bold">
          OH
        </div>
        <span className="text-xs font-medium text-foreground">{t('common.appName')}</span>
      </div>
      <div className="ml-auto flex" style={{ '--wails-draggable': 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => Window.Minimise()}
          title={t('titlebar.minimize')}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => Window.ToggleMaximise()}
          title={t('titlebar.maximize')}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          onClick={() => Window.Hide()}
          title={t('titlebar.close')}
          className="flex h-9 w-11 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
