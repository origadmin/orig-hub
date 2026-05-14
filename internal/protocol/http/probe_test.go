package http

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

func TestProbeBasic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "HEAD" {
			w.Header().Set("Content-Length", "1024")
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Type", "application/octet-stream")
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/file.bin",
		Original: server.URL + "/file.bin",
	}

	meta, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if meta.Size != 1024 {
		t.Errorf("expected size 1024, got %d", meta.Size)
	}
	if !meta.AcceptRanges {
		t.Error("expected AcceptRanges to be true")
	}
}

func TestProbeFilenameFromContentDisposition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="test-file.zip"`)
		w.Header().Set("Content-Length", "2048")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/download",
		Original: server.URL + "/download",
	}

	meta, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if meta.Name != "test-file.zip" {
		t.Errorf("expected filename 'test-file.zip', got %q", meta.Name)
	}
}

func TestProbeFilenameFromURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "512")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/path/to/ubuntu.iso",
		Original: server.URL + "/path/to/ubuntu.iso",
	}

	meta, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if meta.Name != "ubuntu.iso" {
		t.Errorf("expected filename 'ubuntu.iso', got %q", meta.Name)
	}
}

func TestProbeNoRangeSupport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1024")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/file.bin",
		Original: server.URL + "/file.bin",
	}

	meta, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if meta.AcceptRanges {
		t.Error("expected AcceptRanges to be false")
	}
}

func TestProbeErrorStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/missing",
		Original: server.URL + "/missing",
	}

	_, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err == nil {
		t.Error("expected error for 404 status, got nil")
	}
}

func TestProbeNilURL(t *testing.T) {
	_, err := Probe(context.Background(), nil, &types.RuntimeConfig{})
	if err == nil {
		t.Error("expected error for nil URL, got nil")
	}
}

func TestProbeCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     "example.com",
		Original: "http://example.com/file.zip",
	}

	_, err := Probe(ctx, parsedURL, &types.RuntimeConfig{})
	if err == nil {
		t.Error("expected error for cancelled context, got nil")
	}
}

func TestProbeWithCustomUserAgent(t *testing.T) {
	var receivedUA string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedUA = r.Header.Get("User-Agent")
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/file",
		Original: server.URL + "/file",
	}

	runtime := &types.RuntimeConfig{UserAgent: "custom-probe-agent"}
	_, err := Probe(context.Background(), parsedURL, runtime)
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if receivedUA != "custom-probe-agent" {
		t.Errorf("expected User-Agent 'custom-probe-agent', got %q", receivedUA)
	}
}

func TestProbeETag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"abc123"`)
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsedURL := &protocol.ParsedURL{
		Scheme:   "http",
		Host:     server.Listener.Addr().String(),
		Path:     "/file",
		Original: server.URL + "/file",
	}

	meta, err := Probe(context.Background(), parsedURL, &types.RuntimeConfig{})
	if err != nil {
		t.Fatalf("probe failed: %v", err)
	}
	if meta.ETag != `"abc123"` {
		t.Errorf("expected ETag '\"abc123\"', got %q", meta.ETag)
	}
}
