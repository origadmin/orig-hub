export function createMockDownload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dl-1',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    dest_path: '/downloads',
    total_size: 104857600,
    downloaded: 52428800,
    progress: 50,
    speed: 1024 * 1024,
    status: 'downloading',
    error: '',
    eta: 50,
    connections: 4,
    added_at: Date.now() / 1000 - 100,
    time_taken: 100,
    avg_speed: 512 * 1024,
    ...overrides,
  }
}

export function createMockDownloadEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'entry-1',
    url_hash: 'abc123',
    url: 'https://example.com/file.zip',
    dest_path: '/downloads',
    filename: 'file.zip',
    status: 'completed',
    total_size: 104857600,
    downloaded: 104857600,
    completed_at: Date.now() / 1000,
    time_taken: 200,
    avg_speed: 512 * 1024,
    mirrors: [],
    ...overrides,
  }
}
