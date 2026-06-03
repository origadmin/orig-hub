package app

import (
	"context"
	"os/exec"
	"runtime"

	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/service"
	"github.com/wailsapp/wails/v3/pkg/application"
)

type DownloadService struct {
	app *application.App
	svc service.Service
	cfg *config.Settings
}

func NewDownloadService(svc service.Service, cfg *config.Settings) *DownloadService {
	return &DownloadService{
		svc: svc,
		cfg: cfg,
	}
}

func (d *DownloadService) SetApp(app *application.App) {
	d.app = app
}

func (d *DownloadService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	return nil
}

func (d *DownloadService) AddDownload(url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
	if outputPath == "" {
		outputPath = d.cfg.Download.OutputDir
	}
	id, err := d.svc.Add(context.Background(), url, outputPath, filename, mirrors, headers)
	if err != nil {
		return "", err
	}
	d.app.Event.Emit("download:added", id)
	return id, nil
}

func (d *DownloadService) PauseDownload(id string) error {
	err := d.svc.Pause(id)
	if err != nil {
		return err
	}
	d.app.Event.Emit("download:paused", id)
	return nil
}

func (d *DownloadService) ResumeDownload(id string) error {
	err := d.svc.Resume(context.Background(), id)
	if err != nil {
		return err
	}
	d.app.Event.Emit("download:resumed", id)
	return nil
}

func (d *DownloadService) CancelDownload(id string) error {
	err := d.svc.Cancel(id)
	if err != nil {
		return err
	}
	d.app.Event.Emit("download:cancelled", id)
	return nil
}

func (d *DownloadService) RemoveDownload(id string) error {
	return d.svc.Remove(id)
}

func (d *DownloadService) GetDownloadStatus(id string) (*types.DownloadStatus, error) {
	return d.svc.GetStatus(id)
}

func (d *DownloadService) ListDownloads() ([]types.DownloadStatus, error) {
	return d.svc.List()
}

func (d *DownloadService) GetDownloadHistory() ([]types.DownloadEntry, error) {
	return d.svc.History()
}

func (d *DownloadService) GetDefaultDownloadDir() string {
	return d.cfg.Download.OutputDir
}

func (d *DownloadService) OpenDirectoryDialog(title string) (string, error) {
	selection, err := d.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title: title,
	}).PromptForSingleSelection()
	return selection, err
}

func (d *DownloadService) SaveSettings(outputDir string, maxConnections int) error {
	if outputDir != "" {
		d.cfg.Download.OutputDir = outputDir
	}
	if maxConnections > 0 {
		d.cfg.Download.MaxConnections = maxConnections
	}
	return d.cfg.Save(config.ConfigFile())
}

func (d *DownloadService) OpenFileLocation(path string) {
	if path == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", "/select,"+path)
	case "darwin":
		cmd = exec.Command("open", "-R", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	_ = cmd.Start()
}
