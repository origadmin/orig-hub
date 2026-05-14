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

function App() {
  const [activeTab, setActiveTab] = useState('downloads')
  const [dialogOpen, setDialogOpen] = useState(false)
  const { downloads } = useStore()

  useWailsEvents()
  const wailsActions = useWailsActions()

  useEffect(() => {
    wailsActions.listDownloads().then((list) => {
      if (list && list.length > 0) {
        useStore.getState().updateDownloads(list)
      }
    })
  }, [wailsActions])

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
      await wailsActions.addDownload(url, destPath || '', filename || '', [], {})
    } catch (err) {
      console.error('Failed to add download:', err)
    }
  }

  const handlePause = async (id: string) => {
    try {
      await wailsActions.pauseDownload(id)
    } catch (err) {
      console.error('Failed to pause download:', err)
    }
  }

  const handleResume = async (id: string) => {
    try {
      await wailsActions.resumeDownload(id)
    } catch (err) {
      console.error('Failed to resume download:', err)
    }
  }

  const handleCancel = async (id: string) => {
    try {
      await wailsActions.cancelDownload(id)
    } catch (err) {
      console.error('Failed to cancel download:', err)
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
            />
          </div>
        )
      case 'history':
        return (
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">History</h2>
            <Card>
              <CardHeader>
                <CardTitle>No history yet</CardTitle>
              </CardHeader>
            </Card>
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
      />
    </MainLayout>
  )
}

export default App
