package protocol_test

import (
	"testing"
	"time"

	"github.com/origadmin/orig-hub/internal/protocol"
)

func TestDownloadStateString(t *testing.T) {
	tests := []struct {
		state protocol.DownloadState
		want  string
	}{
		{protocol.DownloadStateQueued, "Queued"},
		{protocol.DownloadStateProbing, "Probing"},
		{protocol.DownloadStateDownloading, "Downloading"},
		{protocol.DownloadStatePaused, "Paused"},
		{protocol.DownloadStatePausing, "Pausing"},
		{protocol.DownloadStateCompleted, "Completed"},
		{protocol.DownloadStateError, "Error"},
		{protocol.DownloadStateCancelled, "Cancelled"},
		{protocol.DownloadState(99), "Unknown"},
	}

	for _, tt := range tests {
		got := tt.state.String()
		if got != tt.want {
			t.Errorf("DownloadState(%d).String() = %q, want %q", tt.state, got, tt.want)
		}
	}
}

func TestUploadStateString(t *testing.T) {
	tests := []struct {
		state protocol.UploadState
		want  string
	}{
		{protocol.UploadStateQueued, "Queued"},
		{protocol.UploadStateUploading, "Uploading"},
		{protocol.UploadStatePaused, "Paused"},
		{protocol.UploadStateCompleted, "Completed"},
		{protocol.UploadStateError, "Error"},
		{protocol.UploadStateCancelled, "Cancelled"},
		{protocol.UploadState(99), "Unknown"},
	}

	for _, tt := range tests {
		got := tt.state.String()
		if got != tt.want {
			t.Errorf("UploadState(%d).String() = %q, want %q", tt.state, got, tt.want)
		}
	}
}

func TestParsedURLFieldAccess(t *testing.T) {
	u := &protocol.ParsedURL{
		Scheme:   "https",
		Host:     "example.com",
		Path:     "/path/to/resource",
		RawQuery: "key=value&foo=bar",
		Fragment: "section",
		Original: "https://example.com/path/to/resource?key=value&foo=bar#section",
	}

	if u.Scheme != "https" {
		t.Errorf("Scheme = %q, want %q", u.Scheme, "https")
	}
	if u.Host != "example.com" {
		t.Errorf("Host = %q, want %q", u.Host, "example.com")
	}
	if u.Path != "/path/to/resource" {
		t.Errorf("Path = %q, want %q", u.Path, "/path/to/resource")
	}
	if u.RawQuery != "key=value&foo=bar" {
		t.Errorf("RawQuery = %q, want %q", u.RawQuery, "key=value&foo=bar")
	}
	if u.Fragment != "section" {
		t.Errorf("Fragment = %q, want %q", u.Fragment, "section")
	}
	if u.Original != "https://example.com/path/to/resource?key=value&foo=bar#section" {
		t.Errorf("Original = %q, want full URL", u.Original)
	}
}

func TestParsedURLZeroValue(t *testing.T) {
	var u protocol.ParsedURL
	if u.Scheme != "" {
		t.Errorf("zero Scheme = %q, want empty", u.Scheme)
	}
	if u.Host != "" {
		t.Errorf("zero Host = %q, want empty", u.Host)
	}
	if u.Path != "" {
		t.Errorf("zero Path = %q, want empty", u.Path)
	}
	if u.RawQuery != "" {
		t.Errorf("zero RawQuery = %q, want empty", u.RawQuery)
	}
	if u.Fragment != "" {
		t.Errorf("zero Fragment = %q, want empty", u.Fragment)
	}
	if u.Original != "" {
		t.Errorf("zero Original = %q, want empty", u.Original)
	}
}

func TestMetadataWithExtraMap(t *testing.T) {
	now := time.Now()
	m := &protocol.Metadata{
		Name:         "test-file.zip",
		Size:         1048576,
		ContentType:  "application/zip",
		AcceptRanges: true,
		Modified:     now,
		ETag:         `"abc123"`,
		Mirrors:      []string{"http://mirror1.com", "http://mirror2.com"},
		Headers:      map[string]string{"Authorization": "Bearer token"},
		Extra: map[string]interface{}{
			"retry_count": 3,
			"priority":    "high",
			"custom_flag": true,
		},
	}

	if m.Name != "test-file.zip" {
		t.Errorf("Name = %q, want %q", m.Name, "test-file.zip")
	}
	if m.Size != 1048576 {
		t.Errorf("Size = %d, want %d", m.Size, 1048576)
	}
	if m.ContentType != "application/zip" {
		t.Errorf("ContentType = %q, want %q", m.ContentType, "application/zip")
	}
	if !m.AcceptRanges {
		t.Error("AcceptRanges = false, want true")
	}
	if !m.Modified.Equal(now) {
		t.Errorf("Modified = %v, want %v", m.Modified, now)
	}
	if m.ETag != `"abc123"` {
		t.Errorf("ETag = %q, want %q", m.ETag, `"abc123"`)
	}
	if len(m.Mirrors) != 2 {
		t.Errorf("len(Mirrors) = %d, want %d", len(m.Mirrors), 2)
	}
	if m.Headers["Authorization"] != "Bearer token" {
		t.Errorf("Headers[Authorization] = %q, want %q", m.Headers["Authorization"], "Bearer token")
	}
	if retryCount, ok := m.Extra["retry_count"].(int); !ok || retryCount != 3 {
		t.Errorf("Extra[retry_count] = %v, want 3", m.Extra["retry_count"])
	}
	if priority, ok := m.Extra["priority"].(string); !ok || priority != "high" {
		t.Errorf("Extra[priority] = %v, want high", m.Extra["priority"])
	}
	if customFlag, ok := m.Extra["custom_flag"].(bool); !ok || !customFlag {
		t.Errorf("Extra[custom_flag] = %v, want true", m.Extra["custom_flag"])
	}
}

func TestMetadataZeroValue(t *testing.T) {
	var m protocol.Metadata
	if m.Name != "" {
		t.Errorf("zero Name = %q, want empty", m.Name)
	}
	if m.Size != 0 {
		t.Errorf("zero Size = %d, want 0", m.Size)
	}
	if m.Mirrors != nil {
		t.Errorf("zero Mirrors = %v, want nil", m.Mirrors)
	}
	if m.Headers != nil {
		t.Errorf("zero Headers = %v, want nil", m.Headers)
	}
	if m.Extra != nil {
		t.Errorf("zero Extra = %v, want nil", m.Extra)
	}
}

func TestProgressCalculations(t *testing.T) {
	p := &protocol.Progress{
		Downloaded:    500000,
		TotalSize:     1000000,
		Speed:         1024.5,
		ETA:           5 * time.Minute,
		Connections:   4,
		ActiveWorkers: 3,
	}

	if p.Downloaded != 500000 {
		t.Errorf("Downloaded = %d, want %d", p.Downloaded, 500000)
	}
	if p.TotalSize != 1000000 {
		t.Errorf("TotalSize = %d, want %d", p.TotalSize, 1000000)
	}

	percent := float64(p.Downloaded) / float64(p.TotalSize) * 100
	if percent != 50.0 {
		t.Errorf("percent = %f, want %f", percent, 50.0)
	}

	if p.Speed != 1024.5 {
		t.Errorf("Speed = %f, want %f", p.Speed, 1024.5)
	}
	if p.ETA != 5*time.Minute {
		t.Errorf("ETA = %v, want %v", p.ETA, 5*time.Minute)
	}
	if p.Connections != 4 {
		t.Errorf("Connections = %d, want %d", p.Connections, 4)
	}
	if p.ActiveWorkers != 3 {
		t.Errorf("ActiveWorkers = %d, want %d", p.ActiveWorkers, 3)
	}
}

func TestProgressZeroDownload(t *testing.T) {
	p := &protocol.Progress{
		Downloaded: 0,
		TotalSize:  1000000,
	}

	if p.TotalSize == 0 {
		t.Error("TotalSize should not be zero for percentage calculation")
	}
	percent := float64(p.Downloaded) / float64(p.TotalSize) * 100
	if percent != 0.0 {
		t.Errorf("percent = %f, want %f", percent, 0.0)
	}
}

func TestProgressCompleted(t *testing.T) {
	p := &protocol.Progress{
		Downloaded: 1000000,
		TotalSize:  1000000,
	}

	percent := float64(p.Downloaded) / float64(p.TotalSize) * 100
	if percent != 100.0 {
		t.Errorf("percent = %f, want %f", percent, 100.0)
	}
}

func TestDownloadConfig(t *testing.T) {
	ch := make(chan protocol.Progress, 10)
	cfg := protocol.DownloadConfig{
		ID:            "dl-001",
		URL:           "http://example.com/file.zip",
		OutputPath:    "/tmp/downloads",
		Filename:      "file.zip",
		Mirrors:       []string{"http://mirror1.com/file.zip"},
		Headers:       map[string]string{"User-Agent": "orig-hub/1.0"},
		TotalSize:     1048576,
		SupportsRange: true,
		MaxConns:      8,
		ProgressCh:    ch,
	}

	if cfg.ID != "dl-001" {
		t.Errorf("ID = %q, want %q", cfg.ID, "dl-001")
	}
	if cfg.MaxConns != 8 {
		t.Errorf("MaxConns = %d, want %d", cfg.MaxConns, 8)
	}
	if !cfg.SupportsRange {
		t.Error("SupportsRange = false, want true")
	}
	if len(cfg.Mirrors) != 1 {
		t.Errorf("len(Mirrors) = %d, want %d", len(cfg.Mirrors), 1)
	}
}

func TestUploadConfig(t *testing.T) {
	ch := make(chan protocol.Progress, 10)
	cfg := protocol.UploadConfig{
		ID:         "ul-001",
		URL:        "http://example.com/upload",
		FilePath:   "/tmp/file.zip",
		Filename:   "file.zip",
		Headers:    map[string]string{"Authorization": "Bearer token"},
		ProgressCh: ch,
	}

	if cfg.ID != "ul-001" {
		t.Errorf("ID = %q, want %q", cfg.ID, "ul-001")
	}
	if cfg.FilePath != "/tmp/file.zip" {
		t.Errorf("FilePath = %q, want %q", cfg.FilePath, "/tmp/file.zip")
	}
	if cfg.Filename != "file.zip" {
		t.Errorf("Filename = %q, want %q", cfg.Filename, "file.zip")
	}
}
