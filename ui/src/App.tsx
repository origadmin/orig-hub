import { useState, useEffect } from 'react'
import { Button } from './components/ui/button'
import { Card, CardHeader, CardTitle } from './components/ui/card'
import { useStore } from './store/useStore'
import { DownloadList } from './components/DownloadList'
import { AddDownloadDialog } from './components/AddDownloadDialog'
import { MainLayout } from './components/MainLayout'
import { SettingsPanel } from './components/SettingsPanel'
import { ThemeToggle } from './components/ThemeToggle'
import { useWailsEvents, useWailsActions } from './hooks/useWailsEvents'
import { EventsOn } from 'wailsjs/runtime/runtime.js'
import { toast } from 'sonner'

function App() {
  const [activeTab, setActiveTab] = useState('downloads')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [defaultDir, setDefaultDir] = useState('')
  const { downloads, updateDownloads } = useStore()

  useWailsEvents()
  const wailsActions = useWailsActions()

  useEffect(() => {
    wailsActions.getDefaultDownloadDir().then((dir) => {
      if (dir) {
        setDefaultDir(dir)
        useStore.getState().updateSettings({ downloadDirectory: dir })
      }
    })
  }, [wailsActions])

  useEffect(() => {
    wailsActions.listDownloads().then((list) => {
      if (list && list.length > 0) {
        updateDownloads(list)
      }
    })
  }, [wailsActions, updateDownloads])

  useEffect(() => {
    EventsOn('menu:add-download', () => {
      setDialogOpen(true)
    })
    EventsOn('menu:preferences', () => {
      setActiveTab('settings')
    })
  }, [])

  const handleAddDownload = async (url: string, filename?: string, destPath?: string) => {
    try {
      const outputPath = destPath || defaultDir || ''
      await wailsActions.addDownload(url, outputPath, filename || '', [], {})
      toast.success('Download added')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to add download: ${msg}`)
    }
  }

  const handlePause = async (id: string) => {
    try {
      await wailsActions.pauseDownload(id)
      toast.info('Download paused')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to pause: ${msg}`)
    }
  }

  const handleResume = async (id: string) => {
    try {
      await wailsActions.resumeDownload(id)
      toast.info('Download resumed')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to resume: ${msg}`)
    }
  }

  const handleCancel = async (id: string) => {
    try {
      await wailsActions.cancelDownload(id)
      toast.info('Download cancelled')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to cancel: ${msg}`)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await wailsActions.removeDownload(id)
      useStore.getState().removeDownload(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to remove: ${msg}`)
    }
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'downloads':
        return (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Downloads</h2>
              <div className="flex gap-2 items-center">
                <ThemeToggle />
                <Button onClick={() => setDialogOpen(true)}>Add Download</Button>
              </div>
            </div>
            <DownloadList
              downloads={downloads}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
              onRemove={handleRemove}
            />
          </div>
        )
      case 'history':
        return (
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">History</h2>
            <HistoryList />
          </div>
        )
      case 'settings':
        return <SettingsPanel />
      default:
        return null
    }
  }

  return (
    <MainLayout activeTab={activeTab} onTabChange={setActiveTab}>
      {renderTabContent()}
      <AddDownloadDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAdd={handleAddDownload}
        defaultDir={defaultDir}
      />
    </MainLayout>
  )
}

function HistoryList() {
  const [entries, setEntries] = useState<Array<{ id: string; url: string; filename: string; status: string; total_size: number }>>([])
  const wailsActions = useWailsActions()

  useEffect(() => {
    wailsActions.getHistory().then((list) => {
      if (list) setEntries(list)
    })
  }, [wailsActions])

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No history yet</CardTitle>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <Card key={entry.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{entry.filename || entry.url}</CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

export default App
