package session

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/origadmin/orig-hub/internal/protocol"
)

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*sessionImpl
	registry *protocol.ProtocolRegistry
	handler  SessionEventHandler
}

type sessionImpl struct {
	id         string
	protocol   protocol.Protocol
	downloader protocol.Downloader
	config     *protocol.DownloadConfig
	handler    SessionEventHandler
	cancel     context.CancelFunc
	done       chan error
	createdAt  time.Time
	err        string
	mu         sync.RWMutex
}

func NewManager(registry *protocol.ProtocolRegistry) *Manager {
	return &Manager{
		sessions: make(map[string]*sessionImpl),
		registry: registry,
	}
}

func (m *Manager) SetEventHandler(h SessionEventHandler) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.handler = h
}

func (m *Manager) Add(ctx context.Context, cfg *protocol.DownloadConfig) (Session, error) {
	p, _, err := m.registry.MatchURL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("no protocol for URL: %w", err)
	}

	id := cfg.ID
	if id == "" {
		id = fmt.Sprintf("s-%d", time.Now().UnixNano())
	}
	cfg.ID = id

	downloader, err := p.CreateDownloader(cfg)
	if err != nil {
		return nil, fmt.Errorf("create downloader: %w", err)
	}

	sessionCtx, cancel := context.WithCancel(ctx)
	s := &sessionImpl{
		id:         id,
		protocol:   p,
		downloader: downloader,
		config:     cfg,
		handler:    m.getHandler(),
		cancel:     cancel,
		done:       make(chan error, 1),
		createdAt:  time.Now(),
	}

	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	go s.run(sessionCtx)

	return s, nil
}

func (m *Manager) getHandler() SessionEventHandler {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.handler
}

func (m *Manager) Get(id string) (Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	return s, ok
}

func (m *Manager) List() []Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		result = append(result, s)
	}
	return result
}

func (m *Manager) Remove(id string) {
	m.mu.Lock()
	if s, ok := m.sessions[id]; ok {
		s.cancel()
		delete(m.sessions, id)
	}
	m.mu.Unlock()
}

func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.sessions {
		s.cancel()
	}
	m.sessions = make(map[string]*sessionImpl)
}

func (s *sessionImpl) run(ctx context.Context) {
	// 进度轮询: 每 200ms 检查一次 downloader 状态
	pollDone := make(chan struct{})
	go s.pollProgress(ctx, pollDone)

	err := s.downloader.Download(ctx)
	close(pollDone)

	if err != nil {
		s.mu.Lock()
		s.err = err.Error()
		s.mu.Unlock()
	}

	// 完成/错误/取消时各触发一次
	if s.handler != nil {
		s.handler.OnStateChanged(s.id, s.downloader.State())
		if p := s.downloader.Progress(); p != nil {
			s.handler.OnProgress(s.id, p)
		}
		s.handler.OnCompleted(s.id, err)
	}

	s.done <- err
	close(s.done)
}

// pollProgress: 在 run() 期间每 200ms 触发 OnStateChanged/OnProgress (只在状态/进度变化时)
// 避免高频事件轰炸, 只有 Downloaded 增长超过 64KB 或状态变化时才 emit
func (s *sessionImpl) pollProgress(ctx context.Context, done <-chan struct{}) {
	const interval = 200 * time.Millisecond
	const progressThreshold = 64 * 1024 // 64KB

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var lastDownloaded int64
	var lastState protocol.DownloadState

	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			if s.handler == nil {
				continue
			}
			curState := s.downloader.State()
			if curState != lastState {
				lastState = curState
				s.handler.OnStateChanged(s.id, curState)
			}
			p := s.downloader.Progress()
			if p == nil {
				continue
			}
			if p.Downloaded-lastDownloaded >= progressThreshold || curState == protocol.DownloadStateCompleted || curState == protocol.DownloadStateError || curState == protocol.DownloadStateCancelled {
				lastDownloaded = p.Downloaded
				s.handler.OnProgress(s.id, p)
			}
		}
	}
}

func (s *sessionImpl) ID() string { return s.id }

func (s *sessionImpl) Protocol() string { return s.protocol.Name() }

func (s *sessionImpl) Config() *protocol.DownloadConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

func (s *sessionImpl) State() protocol.DownloadState {
	return s.downloader.State()
}

func (s *sessionImpl) Progress() *protocol.Progress {
	return s.downloader.Progress()
}

func (s *sessionImpl) CreatedAt() time.Time {
	return s.createdAt
}

func (s *sessionImpl) Cancel() {
	s.cancel()
}

func (s *sessionImpl) Wait() <-chan error {
	return s.done
}

func (s *sessionImpl) Pause() error {
	return s.downloader.Pause()
}

func (s *sessionImpl) Resume(ctx context.Context) error {
	return s.downloader.Resume(ctx)
}

func (s *sessionImpl) LastError() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

func (s *sessionImpl) Start(ctx context.Context) error {
	go s.run(ctx)
	return nil
}
