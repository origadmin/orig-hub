export const mockWailsRuntime = {
  EventsOn: jest.fn(),
  EventsOff: jest.fn(),
  EventsEmit: jest.fn(),
  WindowSetTitle: jest.fn(),
  WindowShow: jest.fn(),
  WindowHide: jest.fn(),
  WindowCenter: jest.fn(),
  Quit: jest.fn(),
}

export const mockWailsApp = {
  AddDownload: jest.fn().mockResolvedValue('test-id-1'),
  PauseDownload: jest.fn().mockResolvedValue(undefined),
  ResumeDownload: jest.fn().mockResolvedValue(undefined),
  CancelDownload: jest.fn().mockResolvedValue(undefined),
  ListDownloads: jest.fn().mockResolvedValue([]),
  GetDownloadStatus: jest.fn().mockResolvedValue(null),
  GetDownloadHistory: jest.fn().mockResolvedValue([]),
}

jest.mock('wailsjs/runtime/runtime.js', () => ({
  EventsOn: mockWailsRuntime.EventsOn,
  EventsOff: mockWailsRuntime.EventsOff,
  EventsEmit: mockWailsRuntime.EventsEmit,
  WindowSetTitle: mockWailsRuntime.WindowSetTitle,
  WindowShow: mockWailsRuntime.WindowShow,
  WindowHide: mockWailsRuntime.WindowHide,
  WindowCenter: mockWailsRuntime.WindowCenter,
  Quit: mockWailsRuntime.Quit,
}))

jest.mock('wailsjs/go/main/App.js', () => ({
  AddDownload: mockWailsApp.AddDownload,
  PauseDownload: mockWailsApp.PauseDownload,
  ResumeDownload: mockWailsApp.ResumeDownload,
  CancelDownload: mockWailsApp.CancelDownload,
  ListDownloads: mockWailsApp.ListDownloads,
  GetDownloadStatus: mockWailsApp.GetDownloadStatus,
  GetDownloadHistory: mockWailsApp.GetDownloadHistory,
}))

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
