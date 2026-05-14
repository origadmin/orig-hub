package types

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

type ProgressState struct {
	ID            string
	Downloaded    atomic.Int64
	TotalSize     int64
	DestPath      string
	Filename      string
	URL           string
	StartTime     time.Time
	ActiveWorkers atomic.Int32
	Done          atomic.Bool
	Error         atomic.Pointer[error]
	Paused        atomic.Bool
	Pausing       atomic.Bool
	cancelFunc    context.CancelFunc

	VerifiedProgress  atomic.Int64
	SessionStartBytes int64
	SavedElapsed      time.Duration

	Mirrors []MirrorStatus

	mu sync.Mutex
}

type MirrorStatus struct {
	URL    string
	Active bool
	Error  bool
}

func NewProgressState(id string, totalSize int64) *ProgressState {
	return &ProgressState{
		ID:        id,
		TotalSize: totalSize,
		StartTime: time.Now(),
	}
}

func (p *ProgressState) SetDestPath(path string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.DestPath = path
}

func (p *ProgressState) GetDestPath() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.DestPath
}

func (p *ProgressState) SetFilename(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Filename = name
}

func (p *ProgressState) GetFilename() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Filename
}

func (p *ProgressState) SetURL(url string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.URL = url
}

func (p *ProgressState) GetURL() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.URL
}

func (p *ProgressState) SetTotalSize(size int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.TotalSize != size {
		p.TotalSize = size
		p.SessionStartBytes = 0
		p.SavedElapsed = 0
		p.StartTime = time.Now()
	}
}

func (p *ProgressState) SyncSessionStart() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.SessionStartBytes = p.Downloaded.Load()
	p.StartTime = time.Now()
}

func (p *ProgressState) SetError(err error) {
	p.Error.Store(&err)
}

func (p *ProgressState) GetError() error {
	if e := p.Error.Load(); e != nil {
		return *e
	}
	return nil
}

func (p *ProgressState) GetProgress() (downloaded int64, total int64, totalElapsed time.Duration, sessionElapsed time.Duration, connections int32, sessionStartBytes int64) {
	p.mu.Lock()
	totalSize := p.TotalSize
	sessionStart := p.SessionStartBytes
	savedElapsed := p.SavedElapsed
	startTime := p.StartTime
	p.mu.Unlock()

	downloaded = p.Downloaded.Load()
	total = totalSize
	connections = p.ActiveWorkers.Load()
	sessionStartBytes = sessionStart
	totalElapsed = savedElapsed + time.Since(startTime)
	sessionElapsed = time.Since(startTime)
	return
}

func (p *ProgressState) Pause() {
	p.Paused.Store(true)
	p.Pausing.Store(false)
	if p.cancelFunc != nil {
		p.cancelFunc()
	}
}

func (p *ProgressState) SetCancelFunc(fn context.CancelFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cancelFunc = fn
}

func (p *ProgressState) Resume() {
	p.Paused.Store(false)
	p.Pausing.Store(false)
	p.Error.Store(nil)
}

func (p *ProgressState) IsPaused() bool {
	return p.Paused.Load()
}

func (p *ProgressState) IsPausing() bool {
	return p.Pausing.Load()
}

func (p *ProgressState) SetPausing(val bool) {
	p.Pausing.Store(val)
}

func (p *ProgressState) SetSavedElapsed(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.SavedElapsed = d
}

func (p *ProgressState) GetSavedElapsed() time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.SavedElapsed
}

func (p *ProgressState) FinalizeSession(downloaded int64) (sessionElapsed time.Duration, totalElapsed time.Duration) {
	p.mu.Lock()
	savedElapsed := p.SavedElapsed
	startTime := p.StartTime
	p.mu.Unlock()

	sessionElapsed = time.Since(startTime)
	totalElapsed = savedElapsed + sessionElapsed

	p.mu.Lock()
	p.SavedElapsed = totalElapsed
	p.SessionStartBytes = downloaded
	p.StartTime = time.Now()
	p.mu.Unlock()

	return
}

func (p *ProgressState) SessionReset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.SessionStartBytes = 0
	p.SavedElapsed = 0
	p.StartTime = time.Now()
}

func (p *ProgressState) FinalizePauseSession(downloaded int64) time.Duration {
	p.mu.Lock()
	savedElapsed := p.SavedElapsed
	startTime := p.StartTime
	p.mu.Unlock()

	sessionElapsed := time.Since(startTime)
	totalElapsed := savedElapsed + sessionElapsed

	p.mu.Lock()
	p.SavedElapsed = totalElapsed
	p.SessionStartBytes = downloaded
	p.mu.Unlock()

	return totalElapsed
}

func (p *ProgressState) SetMirrors(mirrors []MirrorStatus) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Mirrors = mirrors
}

func (p *ProgressState) GetMirrors() []MirrorStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.Mirrors == nil {
		return nil
	}
	cp := make([]MirrorStatus, len(p.Mirrors))
	copy(cp, p.Mirrors)
	return cp
}
