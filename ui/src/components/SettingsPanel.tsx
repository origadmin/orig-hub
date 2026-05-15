import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Label } from './ui/label'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Button } from './ui/button'
import { useStore } from '../store/useStore'
import { useWailsActions } from '../hooks/useWailsEvents'
import { toast } from 'sonner'

export function SettingsPanel() {
  const { settings, updateSettings } = useStore()
  const { openDirectoryDialog, saveSettings } = useWailsActions()

  const handleBrowseDir = async () => {
    const dir = await openDirectoryDialog('Select Download Directory')
    if (dir) {
      updateSettings({ downloadDirectory: dir })
    }
  }

  const handleSave = async () => {
    try {
      await saveSettings(settings.downloadDirectory, settings.maxConnections)
      toast.success('Settings saved')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save settings: ${msg}`)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="maxConnections">Max Connections</Label>
          <Input
            id="maxConnections"
            type="number"
            value={settings.maxConnections}
            onChange={(e) =>
              updateSettings({ maxConnections: parseInt(e.target.value) || 1 })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="downloadDirectory">Download Directory</Label>
          <div className="flex gap-2">
            <Input
              id="downloadDirectory"
              value={settings.downloadDirectory}
              onChange={(e) =>
                updateSettings({ downloadDirectory: e.target.value })
              }
              placeholder="Enter download path"
              className="flex-1"
            />
            <Button variant="outline" onClick={handleBrowseDir} type="button">
              Browse
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="autoStart">Auto Start Downloads</Label>
          <Switch
            id="autoStart"
            checked={settings.autoStart}
            onCheckedChange={(checked) => updateSettings({ autoStart: checked })}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="notifications">Enable Notifications</Label>
          <Switch
            id="notifications"
            checked={settings.notifications}
            onCheckedChange={(checked) =>
              updateSettings({ notifications: checked })
            }
          />
        </div>
        <Button onClick={handleSave} className="w-full">
          Save Settings
        </Button>
      </CardContent>
    </Card>
  )
}
