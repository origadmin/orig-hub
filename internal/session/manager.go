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
	err := s.downloader.Download(ctx)
	if err != nil {
		s.mu.Lock()
		s.err = err.Error()
		s.mu.Unlock()
		s.done <- err
	} else {
		s.done <- nil
	}
	close(s.done)
	if s.handler != nil {
		s.handler.OnCompleted(s.id, err)
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
