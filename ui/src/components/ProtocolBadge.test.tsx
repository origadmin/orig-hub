import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { ProtocolBadge } from './ProtocolBadge'

describe('ProtocolBadge', () => {
  it('should show HTTP badge for http:// URL', () => {
    render(<ProtocolBadge url="http://example.com/file.zip" />)
    expect(screen.getByText('HTTP')).toBeInTheDocument()
  })

  it('should show HTTP badge for https:// URL', () => {
    render(<ProtocolBadge url="https://example.com/file.zip" />)
    expect(screen.getByText('HTTP')).toBeInTheDocument()
  })

  it('should show BT badge for magnet: URL', () => {
    render(<ProtocolBadge url="magnet:?xt=urn:btih:abc123" />)
    expect(screen.getByText('BT')).toBeInTheDocument()
  })

  it('should show IPFS badge for ipfs:// URL', () => {
    render(<ProtocolBadge url="ipfs://QmExampleHash" />)
    expect(screen.getByText('IPFS')).toBeInTheDocument()
  })

  it('should show Video badge for YouTube URL', () => {
    render(<ProtocolBadge url="https://www.youtube.com/watch?v=abc123" />)
    expect(screen.getByText('Video')).toBeInTheDocument()
  })

  it('should show Video badge for youtu.be short URL', () => {
    render(<ProtocolBadge url="https://youtu.be/abc123" />)
    expect(screen.getByText('Video')).toBeInTheDocument()
  })

  it('should show Video badge for Bilibili URL', () => {
    render(<ProtocolBadge url="https://www.bilibili.com/video/BV1abc" />)
    expect(screen.getByText('Video')).toBeInTheDocument()
  })

  it('should show Video badge for b23.tv short URL', () => {
    render(<ProtocolBadge url="https://b23.tv/abc123" />)
    expect(screen.getByText('Video')).toBeInTheDocument()
  })

  it('should show IPFS badge for ipns:// URL', () => {
    render(<ProtocolBadge url="ipns://example.eth" />)
    expect(screen.getByText('IPFS')).toBeInTheDocument()
  })

  it('should show HTTP badge for unknown protocol', () => {
    render(<ProtocolBadge url="ftp://files.example.com/data" />)
    expect(screen.getByText('HTTP')).toBeInTheDocument()
  })
})
