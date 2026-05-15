import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useWailsActions } from '../hooks/useWailsEvents'

interface AddDownloadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (url: string, filename?: string, destPath?: string) => void
  defaultDir: string
}

export function AddDownloadDialog({ open, onOpenChange, onAdd, defaultDir }: AddDownloadDialogProps) {
  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [destPath, setDestPath] = useState(defaultDir)
  const { openDirectoryDialog } = useWailsActions()

  const handleBrowse = async () => {
    const dir = await openDirectoryDialog('Select Download Folder')
    if (dir) {
      setDestPath(dir)
    }
  }

  const handleAdd = () => {
    if (!url.trim()) return
    onAdd(url, filename || undefined, destPath || defaultDir || undefined)
    setUrl('')
    setFilename('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Download</DialogTitle>
          <DialogDescription>
            Enter the URL of the file you want to download
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              placeholder="https://example.com/file.zip"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="filename">Filename (optional)</Label>
            <Input
              id="filename"
              placeholder="Leave blank to auto-detect"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="destPath">Save to</Label>
            <div className="flex gap-2">
              <Input
                id="destPath"
                placeholder={defaultDir || 'Downloads folder'}
                value={destPath}
                onChange={(e) => setDestPath(e.target.value)}
                className="flex-1"
              />
              <Button variant="outline" onClick={handleBrowse} type="button">
                Browse
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!url.trim()}>
            Add Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
