import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Label } from './ui/label'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { useStore } from '../store/useStore'

export function SettingsPanel() {
  const { settings, updateSettings } = useStore()

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
          <Input
            id="downloadDirectory"
            value={settings.downloadDirectory}
            onChange={(e) =>
              updateSettings({ downloadDirectory: e.target.value })
            }
            placeholder="Enter download path"
          />
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
      </CardContent>
    </Card>
  )
}
