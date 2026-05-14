package core

import (
	"context"

	"github.com/origadmin/orig-hub/internal/download"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

type DownloadService interface {
	Add(ctx context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error)
	Pause(id string) error
	Resume(ctx context.Context, id string) error
	Cancel(id string) error
	GetStatus(id string) (*types.DownloadStatus, error)
	List() ([]types.DownloadStatus, error)
	History() ([]types.DownloadEntry, error)
	Shutdown() error
}

type LocalService struct {
	manager *download.Manager
	db      *state.DB
}

func NewLocalService(manager *download.Manager, db *state.DB) *LocalService {
	return &LocalService{
		manager: manager,
		db:      db,
	}
}

func (s *LocalService) Add(ctx context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
	cfg := &protocol.DownloadConfig{
		URL:        url,
		OutputPath: outputPath,
		Filename:   filename,
		Mirrors:    mirrors,
		Headers:    headers,
	}

	id, err := s.manager.Add(ctx, cfg)
	if err != nil {
		return "", err
	}

	status, _ := s.manager.GetStatus(id)
	entry := &types.DownloadEntry{
		ID:       id,
		URL:      url,
		DestPath: outputPath,
		Filename: filename,
		Status:   "downloading",
		Mirrors:  mirrors,
	}
	if status != nil {
		entry.TotalSize = status.TotalSize
	}
	_ = s.db.SaveDownload(entry)

	return id, nil
}

func (s *LocalService) Pause(id string) error {
	if err := s.manager.Pause(id); err != nil {
		return err
	}
	_ = s.db.UpdateStatus(id, "paused", 0)
	return nil
}

func (s *LocalService) Resume(ctx context.Context, id string) error {
	if err := s.manager.Resume(ctx, id); err != nil {
		return err
	}
	_ = s.db.UpdateStatus(id, "downloading", 0)
	return nil
}

func (s *LocalService) Cancel(id string) error {
	if err := s.manager.Cancel(id); err != nil {
		return err
	}
	_ = s.db.UpdateStatus(id, "cancelled", 0)
	return nil
}

func (s *LocalService) GetStatus(id string) (*types.DownloadStatus, error) {
	return s.manager.GetStatus(id)
}

func (s *LocalService) List() ([]types.DownloadStatus, error) {
	return s.manager.List()
}

func (s *LocalService) History() ([]types.DownloadEntry, error) {
	return s.db.ListDownloads("completed")
}

func (s *LocalService) Shutdown() error {
	return s.manager.Shutdown()
}
