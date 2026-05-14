import { Badge } from './ui/badge'

interface ProtocolBadgeProps {
  url: string
}

type ProtocolInfo = {
  label: string
  className: string
}

function detectProtocol(url: string): ProtocolInfo {
  const lower = url.toLowerCase()

  if (lower.startsWith('magnet:')) {
    return { label: 'BT', className: 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/25' }
  }

  if (lower.startsWith('ipfs://') || lower.startsWith('ipns://')) {
    return { label: 'IPFS', className: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/25' }
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (
      hostname.includes('youtube.com') ||
      hostname.includes('youtu.be') ||
      hostname.includes('bilibili.com') ||
      hostname.includes('b23.tv')
    ) {
      return { label: 'Video', className: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/25' }
    }
  } catch {
    // URL parsing failed, fall through to default
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return { label: 'HTTP', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25' }
  }

  return { label: 'HTTP', className: 'bg-muted text-muted-foreground border-border' }
}

export function ProtocolBadge({ url }: ProtocolBadgeProps) {
  const { label, className } = detectProtocol(url)
  return <Badge variant="outline" className={className}>{label}</Badge>
}
