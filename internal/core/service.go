package core

import (
	"context"
	"fmt"
	"time"

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
	Remove(id string) error
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
	s := &LocalService{
		manager: manager,
		db:      db,
	}
	manager.SetOnDone(s.onDownloadDone)
	return s
}

func (s *LocalService) onDownloadDone(id string, status string, err error) {
	now := time.Now().Unix()
	entry := &types.DownloadEntry{
		ID:          id,
		Status:      status,
		CompletedAt: now,
	}
	if err != nil {
		entry.Status = "error"
	}

	dlStatus, statusErr := s.manager.GetStatus(id)
	if statusErr == nil && dlStatus != nil {
		entry.TotalSize = dlStatus.TotalSize
		entry.Downloaded = dlStatus.Downloaded
		entry.Filename = dlStatus.Filename
		if dlStatus.TotalSize > 0 && dlStatus.AddedAt > 0 {
			entry.TimeTaken = now - dlStatus.AddedAt
			if entry.TimeTaken > 0 {
				entry.AvgSpeed = float64(dlStatus.Downloaded) / float64(entry.TimeTaken)
			}
		}
	}

	if dbErr := s.db.UpdateDownloadEntry(entry); dbErr != nil {
		_ = fmt.Errorf("failed to update download entry %s: %w", id, dbErr)
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

func (s *LocalService) Remove(id string) error {
	err := s.manager.Remove(id)
	s.manager.Cleanup(id)
	return err
}

func (s *LocalService) GetStatus(id string) (*types.DownloadStatus, error) {
	return s.manager.GetStatus(id)
}

func (s *LocalService) List() ([]types.DownloadStatus, error) {
	return s.manager.List()
}

func (s *LocalService) History() ([]types.DownloadEntry, error) {
	return s.db.ListFinishedDownloads()
}

func (s *LocalService) Shutdown() error {
	return s.manager.Shutdown()
}
