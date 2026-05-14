package core

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

type mockService struct {
	addFunc      func(ctx context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error)
	pauseFunc    func(id string) error
	resumeFunc   func(ctx context.Context, id string) error
	cancelFunc   func(id string) error
	statusFunc   func(id string) (*types.DownloadStatus, error)
	listFunc     func() ([]types.DownloadStatus, error)
	historyFunc  func() ([]types.DownloadEntry, error)
	shutdownFunc func() error
}

func (m *mockService) Add(ctx context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
	if m.addFunc != nil {
		return m.addFunc(ctx, url, outputPath, filename, mirrors, headers)
	}
	return "test-id", nil
}

func (m *mockService) Pause(id string) error {
	if m.pauseFunc != nil {
		return m.pauseFunc(id)
	}
	return nil
}

func (m *mockService) Resume(ctx context.Context, id string) error {
	if m.resumeFunc != nil {
		return m.resumeFunc(ctx, id)
	}
	return nil
}

func (m *mockService) Cancel(id string) error {
	if m.cancelFunc != nil {
		return m.cancelFunc(id)
	}
	return nil
}

func (m *mockService) GetStatus(id string) (*types.DownloadStatus, error) {
	if m.statusFunc != nil {
		return m.statusFunc(id)
	}
	return &types.DownloadStatus{ID: id, Status: "downloading"}, nil
}

func (m *mockService) List() ([]types.DownloadStatus, error) {
	if m.listFunc != nil {
		return m.listFunc()
	}
	return []types.DownloadStatus{}, nil
}

func (m *mockService) History() ([]types.DownloadEntry, error) {
	if m.historyFunc != nil {
		return m.historyFunc()
	}
	return []types.DownloadEntry{}, nil
}

func (m *mockService) Shutdown() error {
	if m.shutdownFunc != nil {
		return m.shutdownFunc()
	}
	return nil
}

func TestHealthEndpoint(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "ok" {
		t.Errorf("expected status 'ok', got %q", resp["status"])
	}
}

func TestListDownloads(t *testing.T) {
	svc := &mockService{
		listFunc: func() ([]types.DownloadStatus, error) {
			return []types.DownloadStatus{
				{ID: "1", Filename: "file1.zip", Status: "downloading"},
				{ID: "2", Filename: "file2.zip", Status: "completed"},
			}, nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/api/downloads", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var statuses []types.DownloadStatus
	_ = json.NewDecoder(w.Body).Decode(&statuses)
	if len(statuses) != 2 {
		t.Errorf("expected 2 downloads, got %d", len(statuses))
	}
}

func TestListDownloadsEmpty(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/api/downloads", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAddDownload(t *testing.T) {
	svc := &mockService{
		addFunc: func(_ context.Context, url, outputPath, filename string, mirrors []string, headers map[string]string) (string, error) {
			if url != "http://example.com/file.zip" {
				t.Errorf("unexpected URL: %s", url)
			}
			return "new-id", nil
		},
	}
	api := NewAPIServer(svc, "")

	body, _ := json.Marshal(map[string]string{
		"url": "http://example.com/file.zip",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/downloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", w.Code)
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["id"] != "new-id" {
		t.Errorf("expected id 'new-id', got %q", resp["id"])
	}
}

func TestAddDownloadNoURL(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest(http.MethodPost, "/api/downloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestAddDownloadInvalidBody(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPost, "/api/downloads", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid body, got %d", w.Code)
	}
}

func TestGetDownloadStatus(t *testing.T) {
	svc := &mockService{
		statusFunc: func(id string) (*types.DownloadStatus, error) {
			return &types.DownloadStatus{ID: id, Filename: "test.zip", Progress: 50.0}, nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/api/downloads/test-id", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var status types.DownloadStatus
	_ = json.NewDecoder(w.Body).Decode(&status)
	if status.ID != "test-id" {
		t.Errorf("expected id 'test-id', got %q", status.ID)
	}
	if status.Progress != 50.0 {
		t.Errorf("expected progress 50.0, got %f", status.Progress)
	}
}

func TestGetDownloadStatusNotFound(t *testing.T) {
	svc := &mockService{
		statusFunc: func(id string) (*types.DownloadStatus, error) {
			return nil, types.ErrNotFound
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/api/downloads/missing-id", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestPauseDownload(t *testing.T) {
	paused := false
	svc := &mockService{
		pauseFunc: func(id string) error {
			if id != "test-id" {
				t.Errorf("expected id 'test-id', got %q", id)
			}
			paused = true
			return nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPost, "/api/downloads/test-id?action=pause", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !paused {
		t.Error("expected pause to be called")
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "paused" {
		t.Errorf("expected status 'paused', got %q", resp["status"])
	}
}

func TestResumeDownload(t *testing.T) {
	resumed := false
	svc := &mockService{
		resumeFunc: func(_ context.Context, id string) error {
			resumed = true
			return nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPost, "/api/downloads/test-id?action=resume", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !resumed {
		t.Error("expected resume to be called")
	}
}

func TestCancelDownload(t *testing.T) {
	cancelled := false
	svc := &mockService{
		cancelFunc: func(id string) error {
			cancelled = true
			return nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPost, "/api/downloads/test-id?action=cancel", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !cancelled {
		t.Error("expected cancel to be called")
	}
}

func TestDeleteDownload(t *testing.T) {
	cancelled := false
	svc := &mockService{
		cancelFunc: func(id string) error {
			if id != "test-id" {
				t.Errorf("expected id 'test-id', got %q", id)
			}
			cancelled = true
			return nil
		},
	}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodDelete, "/api/downloads/test-id", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if !cancelled {
		t.Error("expected cancel to be called for delete")
	}

	var resp map[string]string
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "deleted" {
		t.Errorf("expected status 'deleted', got %q", resp["status"])
	}
}

func TestUnknownAction(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPost, "/api/downloads/test-id?action=unknown", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for unknown action, got %d", w.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodPut, "/api/downloads", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestTokenAuth(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "secret-token")

	req := httptest.NewRequest(http.MethodGet, "/api/downloads", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without auth, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/downloads", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	w = httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong token, got %d", w.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/downloads", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	w = httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with correct token, got %d", w.Code)
	}
}

func TestHealthNoTokenRequired(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "")

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 without token when no token configured, got %d", w.Code)
	}
}

func TestHealthRequiresTokenWhenConfigured(t *testing.T) {
	svc := &mockService{}
	api := NewAPIServer(svc, "secret-token")

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 when token configured and no auth provided, got %d", w.Code)
	}
}

func TestAddDownloadWithMirrorsAndHeaders(t *testing.T) {
	receivedMirrors := []string{}
	receivedHeaders := map[string]string{}
	svc := &mockService{
		addFunc: func(_ context.Context, _ string, _ string, _ string, mirrors []string, headers map[string]string) (string, error) {
			receivedMirrors = mirrors
			receivedHeaders = headers
			return "mirror-id", nil
		},
	}
	api := NewAPIServer(svc, "")

	body, _ := json.Marshal(map[string]interface{}{
		"url":     "http://example.com/file.zip",
		"mirrors": []string{"http://mirror1.com/file.zip", "http://mirror2.com/file.zip"},
		"headers": map[string]string{"X-Custom": "value"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/downloads", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", w.Code)
	}
	if len(receivedMirrors) != 2 {
		t.Errorf("expected 2 mirrors, got %d", len(receivedMirrors))
	}
	if receivedHeaders["X-Custom"] != "value" {
		t.Errorf("expected header X-Custom=value, got %v", receivedHeaders)
	}
}
