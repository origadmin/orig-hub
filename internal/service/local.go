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
}

func NewLocalService(registry *protocol.ProtocolRegistry, cfg *config.Settings, db *state.DB) *LocalService {
	svc := &LocalService{
		sessionMgr: session.NewManager(registry),
		taskQueue:  task.NewQueue(),
		db:         db,
		cfg:        cfg,
	}
	svc.sessionMgr.SetEventHandler(svc)
	return svc
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

func (s *LocalService) OnStateChanged(id string, state protocol.DownloadState) {}
func (s *LocalService) OnProgress(id string, progress *protocol.Progress)   {}
