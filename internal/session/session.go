package session

import (
	"context"
	"time"

	"github.com/origadmin/orig-hub/internal/protocol"
)

type Session interface {
	ID() string
	Protocol() string
	Config() *protocol.DownloadConfig
	State() protocol.DownloadState
	Progress() *protocol.Progress
	LastError() string
	CreatedAt() time.Time
	Start(ctx context.Context) error
	Pause() error
	Resume(ctx context.Context) error
	Cancel()
	Wait() <-chan error
}

type SessionEventHandler interface {
	OnStateChanged(id string, state protocol.DownloadState)
	OnProgress(id string, progress *protocol.Progress)
	OnCompleted(id string, err error)
}
