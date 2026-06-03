package service

import (
	"context"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/session"
	"github.com/origadmin/orig-hub/internal/task"
)

type Service interface {
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

type DownloadService interface {
	Service
	SessionManager() session.Manager
	TaskQueue() task.Queue
}
