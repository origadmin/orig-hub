import { useTranslation } from 'react-i18next'
import { Plus, Link, Zap, ZapOff, PictureInPicture2 } from 'lucide-react'

interface FABProps {
  onAddDownload: () => void
  onPasteURL: () => void
  onToggleSpeedLimit: () => void
  speedLimitEnabled: boolean
  activeCount: number
  onToggleFloating: () => void
}

export function FAB({ onAddDownload, onPasteURL, onToggleSpeedLimit, speedLimitEnabled, activeCount, onToggleFloating }: FABProps) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onAddDownload}
      className="fixed bottom-10 right-10 z-[100] w-14 h-14 bg-primary text-on-primary rounded-full shadow-2xl shadow-primary/30 flex items-center justify-center hover:scale-110 active:scale-95 transition-all duration-200 ring-4 ring-primary/20"
      title={t('fab.newDownload')}
    >
      <Plus className="h-7 w-7" />
      {activeCount > 0 && (
        <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary text-on-secondary text-[10px] font-bold px-1.5">
          {activeCount}
        </span>
      )}
    </button>
  )
}
