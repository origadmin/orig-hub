package main

import (
	"context"
	"time"

	"github.com/origadmin/orig-hub/internal/core"
	"github.com/origadmin/orig-hub/internal/engine/types"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx             context.Context
	downloadService core.DownloadService
	cancelPolling   context.CancelFunc
}

func NewApp(downloadService core.DownloadService) *App {
	return &App{
		downloadService: downloadService,
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	pollCtx, cancel := context.WithCancel(ctx)
	a.cancelPolling = cancel
	go a.pollDownloadStatus(pollCtx)
}

func (a *App) shutdown() {
	if a.cancelPolling != nil {
		a.cancelPolling()
	}
}

func (a *App) pollDownloadStatus(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			statuses, err := a.downloadService.List()
			if err != nil {
				continue
			}
			wailsRuntime.EventsEmit(a.ctx, "download:status", statuses)
		}
	}
}

func (a *App) AddDownload(url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
	id, err := a.downloadService.Add(a.ctx, url, outputPath, filename, mirrors, headers)
	if err != nil {
		return "", err
	}
	wailsRuntime.EventsEmit(a.ctx, "download:added", id)
	return id, nil
}

func (a *App) PauseDownload(id string) error {
	err := a.downloadService.Pause(id)
	if err != nil {
		return err
	}
	wailsRuntime.EventsEmit(a.ctx, "download:paused", id)
	return nil
}

func (a *App) ResumeDownload(id string) error {
	err := a.downloadService.Resume(a.ctx, id)
	if err != nil {
		return err
	}
	wailsRuntime.EventsEmit(a.ctx, "download:resumed", id)
	return nil
}

func (a *App) CancelDownload(id string) error {
	err := a.downloadService.Cancel(id)
	if err != nil {
		return err
	}
	wailsRuntime.EventsEmit(a.ctx, "download:cancelled", id)
	return nil
}

func (a *App) GetDownloadStatus(id string) (*types.DownloadStatus, error) {
	return a.downloadService.GetStatus(id)
}

func (a *App) ListDownloads() ([]types.DownloadStatus, error) {
	return a.downloadService.List()
}

func (a *App) GetDownloadHistory() ([]types.DownloadEntry, error) {
	return a.downloadService.History()
}
