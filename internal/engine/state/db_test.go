package state

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

func TestOpenAndClose(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		t.Error("database file should exist after Open")
	}
}

func TestSaveAndGetDownload(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	entry := &types.DownloadEntry{
		ID:         "test-1",
		URL:        "http://example.com/file.zip",
		DestPath:   "/tmp/file.zip",
		Filename:   "file.zip",
		Status:     "completed",
		TotalSize:  1024,
		Downloaded: 1024,
		URLHash:    "hash123",
		TimeTaken:  5000,
		AvgSpeed:   204.8,
		Mirrors:    []string{"http://mirror1.com/file.zip"},
	}

	if err := db.SaveDownload(entry); err != nil {
		t.Fatalf("failed to save download: %v", err)
	}

	got, err := db.GetDownload("test-1")
	if err != nil {
		t.Fatalf("failed to get download: %v", err)
	}

	if got.ID != "test-1" {
		t.Errorf("expected ID 'test-1', got %q", got.ID)
	}
	if got.URL != "http://example.com/file.zip" {
		t.Errorf("expected URL, got %q", got.URL)
	}
	if got.Status != "completed" {
		t.Errorf("expected status 'completed', got %q", got.Status)
	}
	if got.TotalSize != 1024 {
		t.Errorf("expected TotalSize 1024, got %d", got.TotalSize)
	}
	if len(got.Mirrors) != 1 || got.Mirrors[0] != "http://mirror1.com/file.zip" {
		t.Errorf("expected 1 mirror, got %v", got.Mirrors)
	}
}

func TestGetDownloadNotFound(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	_, err = db.GetDownload("nonexistent")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestListDownloads(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	for i := 0; i < 3; i++ {
		entry := &types.DownloadEntry{
			ID:       fmt.Sprintf("dl-%d", i),
			URL:      fmt.Sprintf("http://example.com/file%d.zip", i),
			DestPath: fmt.Sprintf("/tmp/file%d.zip", i),
			Filename: fmt.Sprintf("file%d.zip", i),
			Status:   "downloading",
		}
		if err := db.SaveDownload(entry); err != nil {
			t.Fatalf("failed to save: %v", err)
		}
	}

	entries, err := db.ListDownloads("")
	if err != nil {
		t.Fatalf("failed to list: %v", err)
	}
	if len(entries) != 3 {
		t.Errorf("expected 3 entries, got %d", len(entries))
	}

	downloading, err := db.ListDownloads("downloading")
	if err != nil {
		t.Fatalf("failed to list by status: %v", err)
	}
	if len(downloading) != 3 {
		t.Errorf("expected 3 downloading, got %d", len(downloading))
	}
}

func TestDeleteDownload(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	entry := &types.DownloadEntry{
		ID:       "del-1",
		URL:      "http://example.com/file.zip",
		DestPath: "/tmp/file.zip",
		Status:   "completed",
	}
	_ = db.SaveDownload(entry)

	if err := db.DeleteDownload("del-1"); err != nil {
		t.Fatalf("failed to delete: %v", err)
	}

	_, err = db.GetDownload("del-1")
	if err != types.ErrNotFound {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
}

func TestUpdateStatus(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	entry := &types.DownloadEntry{
		ID:       "upd-1",
		URL:      "http://example.com/file.zip",
		DestPath: "/tmp/file.zip",
		Status:   "downloading",
	}
	_ = db.SaveDownload(entry)

	if err := db.UpdateStatus("upd-1", "paused", 512); err != nil {
		t.Fatalf("failed to update status: %v", err)
	}

	got, _ := db.GetDownload("upd-1")
	if got.Status != "paused" {
		t.Errorf("expected status 'paused', got %q", got.Status)
	}
	if got.Downloaded != 512 {
		t.Errorf("expected downloaded 512, got %d", got.Downloaded)
	}
}

func TestSaveAndLoadTasks(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	entry := &types.DownloadEntry{
		ID:       "task-1",
		URL:      "http://example.com/file.zip",
		DestPath: "/tmp/file.zip",
		Status:   "paused",
	}
	_ = db.SaveDownload(entry)

	tasks := []types.Task{
		{Offset: 0, Length: 1024},
		{Offset: 1024, Length: 2048},
	}

	if err := db.SaveTasks("task-1", tasks); err != nil {
		t.Fatalf("failed to save tasks: %v", err)
	}

	got, err := db.LoadTasks("task-1")
	if err != nil {
		t.Fatalf("failed to load tasks: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(got))
	}
	if got[0].Offset != 0 || got[0].Length != 1024 {
		t.Errorf("unexpected task[0]: offset=%d, length=%d", got[0].Offset, got[0].Length)
	}
	if got[1].Offset != 1024 || got[1].Length != 2048 {
		t.Errorf("unexpected task[1]: offset=%d, length=%d", got[1].Offset, got[1].Length)
	}
}

func TestWALMode(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	var journalMode string
	row := db.db.QueryRow("PRAGMA journal_mode")
	if err := row.Scan(&journalMode); err != nil {
		t.Fatalf("failed to query journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Errorf("expected WAL mode, got %q", journalMode)
	}
}
