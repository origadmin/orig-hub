package protocol

import "context"

type Protocol interface {
	Name() string
	Schemes() []string
	ParseURL(raw string) (*ParsedURL, error)
	Probe(ctx context.Context, url *ParsedURL) (*Metadata, error)
	Capabilities() CapabilitySet
	CreateDownloader(cfg *DownloadConfig) (Downloader, error)
	CreateUploader(cfg *UploadConfig) (Uploader, error)
}

type Downloader interface {
	Download(ctx context.Context) error
	Pause() error
	Resume(ctx context.Context) error
	Progress() *Progress
	State() DownloadState
	Cancel() error
}

type Uploader interface {
	Upload(ctx context.Context) error
	Progress() *Progress
	State() UploadState
	Cancel() error
}
