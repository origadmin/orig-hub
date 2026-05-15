module.exports = {
  AddDownload: jest.fn().mockResolvedValue('test-id-1'),
  PauseDownload: jest.fn().mockResolvedValue(undefined),
  ResumeDownload: jest.fn().mockResolvedValue(undefined),
  CancelDownload: jest.fn().mockResolvedValue(undefined),
  RemoveDownload: jest.fn().mockResolvedValue(undefined),
  ListDownloads: jest.fn().mockResolvedValue([]),
  GetDownloadStatus: jest.fn().mockResolvedValue(null),
  GetDownloadHistory: jest.fn().mockResolvedValue([]),
  GetDefaultDownloadDir: jest.fn().mockResolvedValue('/home/user/Downloads'),
  OpenDirectoryDialog: jest.fn().mockResolvedValue(''),
  SaveSettings: jest.fn().mockResolvedValue(undefined),
}
