package types

import (
	"fmt"
	"testing"
	"time"
)

func TestNewProgressState(t *testing.T) {
	ps := NewProgressState("test-id", 1024)
	if ps.ID != "test-id" {
		t.Errorf("expected ID 'test-id', got %q", ps.ID)
	}
	if ps.TotalSize != 1024 {
		t.Errorf("expected TotalSize 1024, got %d", ps.TotalSize)
	}
}

func TestProgressStateSetGetDestPath(t *testing.T) {
	ps := NewProgressState("test", 0)
	ps.SetDestPath("/tmp/file.zip")
	if ps.GetDestPath() != "/tmp/file.zip" {
		t.Errorf("expected /tmp/file.zip, got %q", ps.GetDestPath())
	}
}

func TestProgressStateSetGetFilename(t *testing.T) {
	ps := NewProgressState("test", 0)
	ps.SetFilename("file.zip")
	if ps.GetFilename() != "file.zip" {
		t.Errorf("expected file.zip, got %q", ps.GetFilename())
	}
}

func TestProgressStateSetGetURL(t *testing.T) {
	ps := NewProgressState("test", 0)
	ps.SetURL("http://example.com/file.zip")
	if ps.GetURL() != "http://example.com/file.zip" {
		t.Errorf("expected URL, got %q", ps.GetURL())
	}
}

func TestProgressStateError(t *testing.T) {
	ps := NewProgressState("test", 0)
	if ps.GetError() != nil {
		t.Error("expected nil error initially")
	}

	testErr := fmt.Errorf("test error")
	ps.SetError(testErr)
	if ps.GetError() == nil {
		t.Error("expected non-nil error after SetError")
	}
}

func TestProgressStatePauseResume(t *testing.T) {
	ps := NewProgressState("test", 0)
	if ps.IsPaused() {
		t.Error("should not be paused initially")
	}

	ps.Pause()
	if !ps.IsPaused() {
		t.Error("should be paused after Pause()")
	}

	ps.Resume()
	if ps.IsPaused() {
		t.Error("should not be paused after Resume()")
	}
}

func TestProgressStatePausing(t *testing.T) {
	ps := NewProgressState("test", 0)
	if ps.IsPausing() {
		t.Error("should not be pausing initially")
	}

	ps.SetPausing(true)
	if !ps.IsPausing() {
		t.Error("should be pausing after SetPausing(true)")
	}
}

func TestProgressStateDownloaded(t *testing.T) {
	ps := NewProgressState("test", 1024)
	ps.Downloaded.Store(512)
	if ps.Downloaded.Load() != 512 {
		t.Errorf("expected 512, got %d", ps.Downloaded.Load())
	}
}

func TestProgressStateActiveWorkers(t *testing.T) {
	ps := NewProgressState("test", 0)
	ps.ActiveWorkers.Store(4)
	if ps.ActiveWorkers.Load() != 4 {
		t.Errorf("expected 4, got %d", ps.ActiveWorkers.Load())
	}
}

func TestProgressStateDone(t *testing.T) {
	ps := NewProgressState("test", 0)
	if ps.Done.Load() {
		t.Error("should not be done initially")
	}
	ps.Done.Store(true)
	if !ps.Done.Load() {
		t.Error("should be done after Store(true)")
	}
}

func TestProgressStateSetTotalSize(t *testing.T) {
	ps := NewProgressState("test", 100)
	ps.SetTotalSize(2048)
	if ps.TotalSize != 2048 {
		t.Errorf("expected 2048, got %d", ps.TotalSize)
	}
}

func TestProgressStateMirrors(t *testing.T) {
	ps := NewProgressState("test", 0)
	mirrors := []MirrorStatus{
		{URL: "http://mirror1.com", Active: true},
		{URL: "http://mirror2.com", Active: true},
	}
	ps.SetMirrors(mirrors)

	got := ps.GetMirrors()
	if len(got) != 2 {
		t.Fatalf("expected 2 mirrors, got %d", len(got))
	}
	if got[0].URL != "http://mirror1.com" {
		t.Errorf("expected mirror1, got %q", got[0].URL)
	}
}

func TestProgressStateMirrorsDeepCopy(t *testing.T) {
	ps := NewProgressState("test", 0)
	mirrors := []MirrorStatus{{URL: "http://mirror1.com", Active: true}}
	ps.SetMirrors(mirrors)

	got := ps.GetMirrors()
	got[0].URL = "modified"

	original := ps.GetMirrors()
	if original[0].URL != "http://mirror1.com" {
		t.Error("GetMirrors should return a deep copy")
	}
}

func TestProgressStateFinalizeSession(t *testing.T) {
	ps := NewProgressState("test", 1024)
	ps.Downloaded.Store(512)
	ps.VerifiedProgress.Store(512)

	sessionElapsed, totalElapsed := ps.FinalizeSession(512)
	if sessionElapsed < 0 {
		t.Errorf("sessionElapsed should be >= 0, got %v", sessionElapsed)
	}
	if totalElapsed < 0 {
		t.Errorf("totalElapsed should be >= 0, got %v", totalElapsed)
	}
}

func TestProgressStateSessionReset(t *testing.T) {
	ps := NewProgressState("test", 1024)
	ps.Downloaded.Store(512)
	ps.VerifiedProgress.Store(512)
	ps.Paused.Store(true)

	ps.SessionReset()

	if ps.SessionStartBytes != 0 {
		t.Errorf("expected SessionStartBytes 0 after reset, got %d", ps.SessionStartBytes)
	}
	if ps.SavedElapsed != 0 {
		t.Errorf("expected SavedElapsed 0 after reset, got %v", ps.SavedElapsed)
	}
	if ps.Downloaded.Load() != 512 {
		t.Errorf("Downloaded should not be reset, expected 512, got %d", ps.Downloaded.Load())
	}
	if ps.VerifiedProgress.Load() != 512 {
		t.Errorf("VerifiedProgress should not be reset, expected 512, got %d", ps.VerifiedProgress.Load())
	}
}

func TestProgressStateSavedElapsed(t *testing.T) {
	ps := NewProgressState("test", 0)
	ps.SetSavedElapsed(5 * time.Second)
	if ps.GetSavedElapsed() != 5*time.Second {
		t.Errorf("expected 5s, got %v", ps.GetSavedElapsed())
	}
}
