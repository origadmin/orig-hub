package types

type DownloadEntry struct {
	ID          string   `json:"id"`
	URLHash     string   `json:"url_hash"`
	URL         string   `json:"url"`
	DestPath    string   `json:"dest_path"`
	Filename    string   `json:"filename"`
	Status      string   `json:"status"`
	TotalSize   int64    `json:"total_size"`
	Downloaded  int64    `json:"downloaded"`
	CompletedAt int64    `json:"completed_at"`
	TimeTaken   int64    `json:"time_taken"`
	AvgSpeed    float64  `json:"avg_speed"`
	Mirrors     []string `json:"mirrors,omitempty"`
}

type DownloadStatus struct {
	ID          string  `json:"id"`
	URL         string  `json:"url"`
	Filename    string  `json:"filename"`
	DestPath    string  `json:"dest_path,omitempty"`
	TotalSize   int64   `json:"total_size"`
	Downloaded  int64   `json:"downloaded"`
	Progress    float64 `json:"progress"`
	Speed       float64 `json:"speed"`
	Status      string  `json:"status"`
	Error       string  `json:"error,omitempty"`
	ETA         int64   `json:"eta"`
	Connections int     `json:"connections"`
	AddedAt     int64   `json:"added_at"`
	TimeTaken   int64   `json:"time_taken"`
	AvgSpeed    float64 `json:"avg_speed"`
}

type DownloadState struct {
	ID         string   `json:"id"`
	URLHash    string   `json:"url_hash"`
	URL        string   `json:"url"`
	DestPath   string   `json:"dest_path"`
	TotalSize  int64    `json:"total_size"`
	Downloaded int64    `json:"downloaded"`
	Tasks      []Task   `json:"tasks"`
	Filename   string   `json:"filename"`
	CreatedAt  int64    `json:"created_at"`
	PausedAt   int64    `json:"paused_at"`
	Elapsed    int64    `json:"elapsed"`
	Mirrors    []string `json:"mirrors,omitempty"`
}

type CancelResult struct {
	Found     bool   `json:"found"`
	Filename  string `json:"filename"`
	DestPath  string `json:"dest_path"`
	Completed bool   `json:"completed"`
	WasQueued bool   `json:"was_queued"`
}
