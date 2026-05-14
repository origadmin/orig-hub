package protocol

import "time"

type ParsedURL struct {
	Scheme   string
	Host     string
	Path     string
	RawQuery string
	Fragment string
	Original string
}

type Metadata struct {
	Name         string
	Size         int64
	ContentType  string
	AcceptRanges bool
	Modified     time.Time
	ETag         string
	Mirrors      []string
	Headers      map[string]string
	Extra        map[string]interface{}
}

type Progress struct {
	Downloaded    int64
	TotalSize     int64
	Speed         float64
	ETA           time.Duration
	Connections   int
	ActiveWorkers int
}

type DownloadState int

const (
	DownloadStateQueued DownloadState = iota
	DownloadStateProbing
	DownloadStateDownloading
	DownloadStatePaused
	DownloadStatePausing
	DownloadStateCompleted
	DownloadStateError
	DownloadStateCancelled
)

func (s DownloadState) String() string {
	switch s {
	case DownloadStateQueued:
		return "Queued"
	case DownloadStateProbing:
		return "Probing"
	case DownloadStateDownloading:
		return "Downloading"
	case DownloadStatePaused:
		return "Paused"
	case DownloadStatePausing:
		return "Pausing"
	case DownloadStateCompleted:
		return "Completed"
	case DownloadStateError:
		return "Error"
	case DownloadStateCancelled:
		return "Cancelled"
	default:
		return "Unknown"
	}
}

type UploadState int

const (
	UploadStateQueued UploadState = iota
	UploadStateUploading
	UploadStatePaused
	UploadStateCompleted
	UploadStateError
	UploadStateCancelled
)

func (s UploadState) String() string {
	switch s {
	case UploadStateQueued:
		return "Queued"
	case UploadStateUploading:
		return "Uploading"
	case UploadStatePaused:
		return "Paused"
	case UploadStateCompleted:
		return "Completed"
	case UploadStateError:
		return "Error"
	case UploadStateCancelled:
		return "Cancelled"
	default:
		return "Unknown"
	}
}

type DownloadConfig struct {
	ID            string
	URL           string
	OutputPath    string
	Filename      string
	Mirrors       []string
	Headers       map[string]string
	TotalSize     int64
	SupportsRange bool
	MaxConns      int
	ProgressCh    chan<- Progress
}

type UploadConfig struct {
	ID         string
	URL        string
	FilePath   string
	Filename   string
	Headers    map[string]string
	ProgressCh chan<- Progress
}
