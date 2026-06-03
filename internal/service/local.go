package service

import (
	"context"
	"time"

	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
	"github.com/origadmin/orig-hub/internal/session"
	"github.com/origadmin/orig-hub/internal/task"
)

type LocalService struct {
	sessionMgr *session.Manager
	taskQueue  task.Queue
	db         *state.DB
	cfg        *config.Settings
	emitter    EventEmitter
}

func NewLocalService(registry *protocol.ProtocolRegistry, cfg *config.Settings, db *state.DB) *LocalService {
	svc := &LocalService{
		sessionMgr: session.NewManager(registry),
		taskQueue:  task.NewQueue(),
		db:         db,
		cfg:        cfg,
		emitter:    noopEmitter{},
	}
	svc.sessionMgr.SetEventHandler(svc)
	return svc
}

// SetEmitter: 注入事件发射器 (Wails application.Event / 其他实现)
func (s *LocalService) SetEmitter(e EventEmitter) {
	s.emitter = e
}

// EventEmitter: LocalService 通过该接口向前端 emit 事件
// 返回值: true 表示 emit 成功 (与 wails application.EventManager.Emit 一致)
type EventEmitter interface {
	Emit(eventName string, data ...any) bool
}

type noopEmitter struct{}

func (noopEmitter) Emit(string, ...any) bool { return true }

// 下载状态变更的 wire 格式 (与 wails TypeScript 一致)
type downloadProgressEvent struct {
	ID          string  `json:"id"`
	Downloaded  int64   `json:"downloaded"`
	TotalSize   int64   `json:"total_size"`
	Speed       int64   `json:"speed"`
	Connections int     `json:"connections"`
	Progress    float64 `json:"progress"`
}

type downloadStateEvent struct {
	ID    string `json:"id"`
	State string `json:"state"`
}

func (s *LocalService) Add(ctx context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
	cfg := &protocol.DownloadConfig{
		URL:        url,
		OutputPath: outputPath,
		Filename:   filename,
		Mirrors:    mirrors,
		Headers:    headers,
	}

	sess, err := s.sessionMgr.Add(ctx, cfg)
	if err != nil {
		return "", err
	}

	entry := &types.DownloadEntry{
		ID:       sess.ID(),
		URL:      url,
		DestPath: outputPath,
		Filename: filename,
		Status:   "downloading",
		Mirrors:  mirrors,
	}
	_ = s.db.SaveDownload(entry)

	return sess.ID(), nil
}

func (s *LocalService) Pause(id string) error {
	sess, ok := s.sessionMgr.Get(id)
	if !ok {
		return types.ErrNotFound
	}
	_ = s.db.UpdateStatus(id, "paused", 0)
	return sess.Pause()
}

func (s *LocalService) Resume(ctx context.Context, id string) error {
	sess, ok := s.sessionMgr.Get(id)
	if !ok {
		return types.ErrNotFound
	}
	_ = s.db.UpdateStatus(id, "downloading", 0)
	return sess.Resume(ctx)
}

func (s *LocalService) Cancel(id string) error {
	sess, ok := s.sessionMgr.Get(id)
	if !ok {
		return types.ErrNotFound
	}
	_ = s.db.UpdateStatus(id, "cancelled", 0)
	sess.Cancel()
	return nil
}

func (s *LocalService) Remove(id string) error {
	s.sessionMgr.Remove(id)
	return nil
}

func (s *LocalService) GetStatus(id string) (*types.DownloadStatus, error) {
	sess, ok := s.sessionMgr.Get(id)
	if !ok {
		return nil, types.ErrNotFound
	}

	p := sess.Progress()
	st := sess.State()

	status := &types.DownloadStatus{
		ID:          sess.ID(),
		URL:         sess.Config().URL,
		Filename:    sess.Config().Filename,
		DestPath:    sess.Config().OutputPath,
		TotalSize:   p.TotalSize,
		Downloaded:  p.Downloaded,
		Speed:       p.Speed,
		Connections: p.Connections,
		AddedAt:     sess.CreatedAt().Unix(),
	}

	if p.TotalSize > 0 {
		status.Progress = float64(p.Downloaded) / float64(p.TotalSize) * 100
	}

	if p.Speed > 0 && p.Downloaded < p.TotalSize {
		remaining := p.TotalSize - p.Downloaded
		status.ETA = int64(time.Duration(remaining) / time.Duration(int64(p.Speed)))
	}

	switch st {
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
	case protocol.DownloadStateCancelled:
		status.Status = "cancelled"
	}

	return status, nil
}

func (s *LocalService) List() ([]types.DownloadStatus, error) {
	sessions := s.sessionMgr.List()
	result := make([]types.DownloadStatus, 0, len(sessions))
	for _, sess := range sessions {
		status, err := s.GetStatus(sess.ID())
		if err != nil {
			continue
		}
		result = append(result, *status)
	}
	return result, nil
}

func (s *LocalService) History() ([]types.DownloadEntry, error) {
	return s.db.ListFinishedDownloads()
}

func (s *LocalService) Shutdown() error {
	s.sessionMgr.Shutdown()
	return nil
}

func (s *LocalService) SessionManager() *session.Manager { return s.sessionMgr }
func (s *LocalService) TaskQueue() task.Queue            { return s.taskQueue }

func (s *LocalService) OnCompleted(id string, err error) {
	sess, ok := s.sessionMgr.Get(id)
	if !ok {
		return
	}

	now := time.Now().Unix()
	entry := &types.DownloadEntry{
		ID:          id,
		Status:      "completed",
		CompletedAt: now,
	}

	if err != nil {
		entry.Status = "error"
	}

	p := sess.Progress()
	if p != nil {
		entry.TotalSize = p.TotalSize
		entry.Downloaded = p.Downloaded
	}

	_ = s.db.UpdateDownloadEntry(entry)
}

func (s *LocalService) OnStateChanged(id string, state protocol.DownloadState) {
	wire := downloadStateEvent{ID: id, State: stateToWire(state)}
	s.emitter.Emit("download:state", wire)
}

// stateToWire: 将 protocol.DownloadState 转为前端期望的小写字符串
// (state.String() 返回 "Queued"/"Downloading" 等, 前端用 'queued'/'downloading')
func stateToWire(state protocol.DownloadState) string {
	switch state {
	case protocol.DownloadStateQueued:
		return "queued"
	case protocol.DownloadStateProbing:
		return "probing"
	case protocol.DownloadStateDownloading:
		return "downloading"
	case protocol.DownloadStatePausing, protocol.DownloadStatePaused:
		return "paused"
	case protocol.DownloadStateCompleted:
		return "completed"
	case protocol.DownloadStateCancelled:
		return "cancelled"
	case protocol.DownloadStateError:
		return "error"
	default:
		return "queued"
	}
}

func (s *LocalService) OnProgress(id string, progress *protocol.Progress) {
	if progress == nil {
		return
	}
	wire := downloadProgressEvent{
		ID:          id,
		Downloaded:  progress.Downloaded,
		TotalSize:   progress.TotalSize,
		Speed:       int64(progress.Speed),
		Connections: progress.Connections,
	}
	if progress.TotalSize > 0 {
		wire.Progress = float64(progress.Downloaded) / float64(progress.TotalSize) * 100
	}
	s.emitter.Emit("download:progress", wire)
}
