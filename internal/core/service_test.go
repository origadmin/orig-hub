package core

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/origadmin/orig-hub/internal/download"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpProto "github.com/origadmin/orig-hub/internal/protocol/http"
)

func setupService(t *testing.T) *LocalService {
	t.Helper()

	registry := protocol.NewRegistry()
	p := httpProto.New(nil)
	if err := registry.Register(p); err != nil {
		t.Fatalf("failed to register http protocol: %v", err)
	}

	manager := download.NewManager(registry, nil)

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := state.Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	return NewLocalService(manager, db)
}

func TestNewLocalService(t *testing.T) {
	svc := setupService(t)
	if svc == nil {
		t.Fatal("expected non-nil service")
	}
}

func TestLocalServiceAddEmptyURL(t *testing.T) {
	svc := setupService(t)

	_, err := svc.Add(context.Background(), "", "/tmp", "file.zip", nil, nil)
	if err == nil {
		t.Error("expected error for empty URL")
	}
}

func TestLocalServiceAddEmptyOutputPath(t *testing.T) {
	svc := setupService(t)

	_, err := svc.Add(context.Background(), "http://example.com/file.zip", "", "file.zip", nil, nil)
	if err == nil {
		t.Error("expected error for empty output path")
	}
}

func TestLocalServiceAddInvalidScheme(t *testing.T) {
	svc := setupService(t)

	_, err := svc.Add(context.Background(), "ftp://example.com/file.zip", "/tmp", "file.zip", nil, nil)
	if err == nil {
		t.Error("expected error for unsupported scheme")
	}
}

func TestLocalServicePauseNotFound(t *testing.T) {
	svc := setupService(t)

	err := svc.Pause("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestLocalServiceResumeNotFound(t *testing.T) {
	svc := setupService(t)

	err := svc.Resume(context.Background(), "nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestLocalServiceCancelNotFound(t *testing.T) {
	svc := setupService(t)

	err := svc.Cancel("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestLocalServiceGetStatusNotFound(t *testing.T) {
	svc := setupService(t)

	_, err := svc.GetStatus("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestLocalServiceListEmpty(t *testing.T) {
	svc := setupService(t)

	list, err := svc.List()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d items", len(list))
	}
}

func TestLocalServiceHistoryEmpty(t *testing.T) {
	svc := setupService(t)

	entries, err := svc.History()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected empty history, got %d items", len(entries))
	}
}

func TestLocalServiceShutdown(t *testing.T) {
	svc := setupService(t)

	if err := svc.Shutdown(); err != nil {
		t.Errorf("shutdown should not fail on empty service: %v", err)
	}
}

func TestLocalServiceAddAndHistory(t *testing.T) {
	svc := setupService(t)

	dir := t.TempDir()
	id, err := svc.Add(context.Background(), "http://example.com/file.zip", dir, "file.zip", nil, nil)
	if err != nil {
		t.Fatalf("failed to add download: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty id")
	}

	status, err := svc.GetStatus(id)
	if err != nil {
		t.Fatalf("failed to get status: %v", err)
	}
	if status.ID != id {
		t.Errorf("expected id %q, got %q", id, status.ID)
	}
	if status.Filename != "file.zip" {
		t.Errorf("expected filename 'file.zip', got %q", status.Filename)
	}
}

func TestLocalServiceAddWithMirrors(t *testing.T) {
	svc := setupService(t)

	dir := t.TempDir()
	mirrors := []string{"http://mirror1.com/file.zip", "http://mirror2.com/file.zip"}
	id, err := svc.Add(context.Background(), "http://example.com/file.zip", dir, "file.zip", mirrors, nil)
	if err != nil {
		t.Fatalf("failed to add download with mirrors: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty id")
	}
}

func TestLocalServiceListAfterAdd(t *testing.T) {
	svc := setupService(t)

	dir := t.TempDir()
	_, err := svc.Add(context.Background(), "http://example.com/file.zip", dir, "file.zip", nil, nil)
	if err != nil {
		t.Fatalf("failed to add download: %v", err)
	}

	list, err := svc.List()
	if err != nil {
		t.Fatalf("failed to list: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("expected 1 download, got %d", len(list))
	}
}

func TestLocalServiceAddWithHeaders(t *testing.T) {
	svc := setupService(t)

	dir := t.TempDir()
	headers := map[string]string{"X-API-Key": "test-key"}
	id, err := svc.Add(context.Background(), "http://example.com/file.zip", dir, "file.zip", nil, headers)
	if err != nil {
		t.Fatalf("failed to add download with headers: %v", err)
	}
	if id == "" {
		t.Error("expected non-empty id")
	}
}
