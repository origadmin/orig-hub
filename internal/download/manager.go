package download

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

type OnDownloadDone func(id string, status string, err error)

type Manager struct {
	registry *protocol.ProtocolRegistry
	runtime  *types.RuntimeConfig
	active   map[string]*activeDownload
	mu       sync.RWMutex
	nextID   atomic.Int64
	onDone   OnDownloadDone
}

type activeDownload struct {
	id         string
	protocol   protocol.Protocol
	downloader protocol.Downloader
	cancelFunc context.CancelFunc
	config     *protocol.DownloadConfig
	addedAt    time.Time
	lastErr    string
}

func NewManager(registry *protocol.ProtocolRegistry, runtime *types.RuntimeConfig) *Manager {
	if runtime == nil {
		runtime = &types.RuntimeConfig{}
	}
	return &Manager{
		registry: registry,
		runtime:  runtime,
		active:   make(map[string]*activeDownload),
	}
}

func (m *Manager) SetOnDone(fn OnDownloadDone) {
	m.onDone = fn
}

func (m *Manager) Add(ctx context.Context, cfg *protocol.DownloadConfig) (string, error) {
	if cfg.URL == "" {
		return "", types.ErrURLRequired
	}
	if cfg.OutputPath == "" {
		return "", types.ErrDestRequired
	}

	p, _, err := m.registry.MatchURL(cfg.URL)
	if err != nil {
		return "", fmt.Errorf("no protocol found for URL: %w", err)
	}

	id := cfg.ID
	if id == "" {
		id = fmt.Sprintf("dl-%d", m.nextID.Add(1))
	}

	m.mu.Lock()
	if _, exists := m.active[id]; exists {
		m.mu.Unlock()
		return "", types.ErrIDExists
	}

	downloader, err := p.CreateDownloader(cfg)
	if err != nil {
		m.mu.Unlock()
		return "", fmt.Errorf("failed to create downloader: %w", err)
	}

	downloadCtx, cancel := context.WithCancel(context.Background())
	ad := &activeDownload{
		id:         id,
		protocol:   p,
		downloader: downloader,
		cancelFunc: cancel,
		config:     cfg,
		addedAt:    time.Now(),
	}
	m.active[id] = ad
	m.mu.Unlock()

	go func() {
		dlErr := downloader.Download(downloadCtx)
		if dlErr != nil && dlErr == context.Canceled {
			ad.lastErr = ""
			m.notifyDone(id, "cancelled", nil)
		} else if dlErr != nil {
			ad.lastErr = dlErr.Error()
			m.notifyDone(id, "error", dlErr)
		} else {
			ad.lastErr = ""
			m.notifyDone(id, "completed", nil)
		}
	}()

	return id, nil
}

func (m *Manager) notifyDone(id string, status string, err error) {
	if m.onDone != nil {
		m.onDone(id, status, err)
	}
}

func (m *Manager) Pause(id string) error {
	m.mu.RLock()
	ad, ok := m.active[id]
	m.mu.RUnlock()

	if !ok {
		return types.ErrNotFound
	}

	return ad.downloader.Pause()
}

func (m *Manager) Resume(ctx context.Context, id string) error {
	m.mu.RLock()
	ad, ok := m.active[id]
	m.mu.RUnlock()

	if !ok {
		return types.ErrNotFound
	}

	return ad.downloader.Resume(ctx)
}

func (m *Manager) Cancel(id string) error {
	m.mu.RLock()
	ad, ok := m.active[id]
	m.mu.RUnlock()

	if !ok {
		return types.ErrNotFound
	}

	err := ad.downloader.Cancel()
	ad.cancelFunc()

	return err
}

func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	ad, ok := m.active[id]
	if ok {
		ad.cancelFunc()
		delete(m.active, id)
	}
	m.mu.Unlock()
	return nil
}

func (m *Manager) GetStatus(id string) (*types.DownloadStatus, error) {
	m.mu.RLock()
	ad, ok := m.active[id]
	m.mu.RUnlock()

	if !ok {
		return nil, types.ErrNotFound
	}

	progress := ad.downloader.Progress()
	state := ad.downloader.State()

	status := &types.DownloadStatus{
		ID:          id,
		URL:         ad.config.URL,
		Filename:    ad.config.Filename,
		DestPath:    ad.config.OutputPath,
		TotalSize:   progress.TotalSize,
		Downloaded:  progress.Downloaded,
		Speed:       progress.Speed,
		Connections: progress.Connections,
		AddedAt:     ad.addedAt.Unix(),
	}

	if progress.TotalSize > 0 {
		status.Progress = float64(progress.Downloaded) / float64(progress.TotalSize) * 100
	}

	if progress.Speed > 0 && progress.Downloaded < progress.TotalSize {
		remaining := progress.TotalSize - progress.Downloaded
		status.ETA = int64(time.Duration(remaining) / time.Duration(int64(progress.Speed)))
	}

	switch state {
	case protocol.DownloadStateQueued:
		status.Status = "queued"
	case protocol.DownloadStateProbing:
		status.Status = "probing"
	case protocol.DownloadStateDownloading:
		status.Status = "downloading"
	case protocol.DownloadStatePaused, protocol.DownloadStatePausing:
		status.Status = "paused"
	case protocol.DownloadStateCompleted:
		status.Status = "completed"
	case protocol.DownloadStateError:
		status.Status = "error"
		status.Error = ad.lastErr
	case protocol.DownloadStateCancelled:
		status.Status = "cancelled"
	}

	return status, nil
}

func (m *Manager) List() ([]types.DownloadStatus, error) {
	ids := make([]string, 0)
	m.mu.RLock()
	for id := range m.active {
		ids = append(ids, id)
	}
	m.mu.RUnlock()

	var statuses []types.DownloadStatus
	for _, id := range ids {
		status, err := m.GetStatus(id)
		if err != nil {
			continue
		}
		statuses = append(statuses, *status)
	}

	return statuses, nil
}

func (m *Manager) Shutdown() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, ad := range m.active {
		_ = ad.downloader.Cancel()
		ad.cancelFunc()
		delete(m.active, id)
	}

	return nil
}
