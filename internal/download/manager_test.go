package download

import (
	"context"
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpProto "github.com/origadmin/orig-hub/internal/protocol/http"
)

func setupManager(t *testing.T) *Manager {
	t.Helper()
	registry := protocol.NewRegistry()
	p := httpProto.New(nil)
	if err := registry.Register(p); err != nil {
		t.Fatalf("failed to register http protocol: %v", err)
	}
	return NewManager(registry, nil)
}

func TestNewManager(t *testing.T) {
	m := setupManager(t)
	if m == nil {
		t.Fatal("expected non-nil manager")
	}
}

func TestManagerAddEmptyURL(t *testing.T) {
	m := setupManager(t)
	_, err := m.Add(context.Background(), &protocol.DownloadConfig{
		OutputPath: "/tmp",
	})
	if err == nil {
		t.Error("expected error for empty URL")
	}
}

func TestManagerAddEmptyDest(t *testing.T) {
	m := setupManager(t)
	_, err := m.Add(context.Background(), &protocol.DownloadConfig{
		URL: "http://example.com/file.zip",
	})
	if err == nil {
		t.Error("expected error for empty destination")
	}
}

func TestManagerAddInvalidScheme(t *testing.T) {
	m := setupManager(t)
	_, err := m.Add(context.Background(), &protocol.DownloadConfig{
		URL:        "ftp://example.com/file.zip",
		OutputPath: "/tmp",
	})
	if err == nil {
		t.Error("expected error for unsupported scheme")
	}
}

func TestManagerPauseNotFound(t *testing.T) {
	m := setupManager(t)
	err := m.Pause("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestManagerResumeNotFound(t *testing.T) {
	m := setupManager(t)
	err := m.Resume(context.Background(), "nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestManagerCancelNotFound(t *testing.T) {
	m := setupManager(t)
	err := m.Cancel("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestManagerGetStatusNotFound(t *testing.T) {
	m := setupManager(t)
	_, err := m.GetStatus("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestManagerShutdown(t *testing.T) {
	m := setupManager(t)
	if err := m.Shutdown(); err != nil {
		t.Errorf("shutdown should not fail on empty manager: %v", err)
	}
}

func TestManagerListEmpty(t *testing.T) {
	m := setupManager(t)
	list, err := m.List()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d items", len(list))
	}
}
