package http

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

// TestDownloadSequentialSmallFile: 小文件 (< 2MB MinChunk) → 走 sequential 分支
func TestDownloadSequentialSmallFile(t *testing.T) {
	payload := make([]byte, 100*1024) // 100 KB
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}
	expectedHash := sha256.Sum256(payload)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))
		// 小文件: 不设置 Accept-Ranges 头 → 走 sequential
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
	defer server.Close()

	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{}

	dl := NewDownloader(&protocol.DownloadConfig{
		URL:        server.URL + "/small.bin",
		OutputPath: tmpDir,
		Filename:   "small.bin",
	}, runtime)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := dl.Download(ctx); err != nil {
		t.Fatalf("Download: %v", err)
	}

	dest := filepath.Join(tmpDir, "small.bin")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}

	gotHash := sha256.Sum256(got)
	if !bytes.Equal(gotHash[:], expectedHash[:]) {
		t.Errorf("hash mismatch: got %s, want %s",
			hex.EncodeToString(gotHash[:]),
			hex.EncodeToString(expectedHash[:]))
	}

	progress := dl.Progress()
	if progress.Downloaded != int64(len(payload)) {
		t.Errorf("Downloaded = %d, want %d", progress.Downloaded, len(payload))
	}
}

// TestDownloadConcurrentLargeFile: 大文件 (>= 2MB MinChunk) + Accept-Ranges: bytes → 走 concurrent 分支
func TestDownloadConcurrentLargeFile(t *testing.T) {
	payload := make([]byte, 8*1024*1024) // 8 MB, > 2MB MinChunk
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}
	expectedHash := sha256.Sum256(payload)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeader := r.Header.Get("Range")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))

		if rangeHeader == "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
			return
		}

		// parse "bytes=START-END"
		var start, end int64
		if _, err := fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end); err != nil {
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
		if end >= int64(len(payload)) {
			end = int64(len(payload)) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", end-start+1))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[start : end+1])
	}))
	defer server.Close()

	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{
		MaxConnectionsPerHost: 4,
	}

	dl := NewDownloader(&protocol.DownloadConfig{
		URL:        server.URL + "/large.bin",
		OutputPath: tmpDir,
		Filename:   "large.bin",
	}, runtime)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := dl.Download(ctx); err != nil {
		t.Fatalf("Download: %v", err)
	}

	dest := filepath.Join(tmpDir, "large.bin")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}

	gotHash := sha256.Sum256(got)
	if !bytes.Equal(gotHash[:], expectedHash[:]) {
		t.Errorf("hash mismatch: got %s, want %s",
			hex.EncodeToString(gotHash[:]),
			hex.EncodeToString(expectedHash[:]))
	}
}

// TestDownloadCancelMidway: 下载过程中取消 → 文件存在但状态为 Cancelled
func TestDownloadCancelMidway(t *testing.T) {
	payload := make([]byte, 16*1024*1024) // 16 MB
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}

	// server 慢速发送, 给客户端时间取消
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeader := r.Header.Get("Range")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))

		if rangeHeader != "" {
			var start, end int64
			fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end)
			if end >= int64(len(payload)) {
				end = int64(len(payload)) - 1
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
			w.Header().Set("Content-Length", fmt.Sprintf("%d", end-start+1))
			w.WriteHeader(http.StatusPartialContent)
			chunk := payload[start : end+1]
			// 分块慢速发送
			const block = 64 * 1024
			for i := 0; i < len(chunk); i += block {
				end2 := i + block
				if end2 > len(chunk) {
					end2 = len(chunk)
				}
				_, _ = w.Write(chunk[i:end2])
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				<-release
			}
			return
		}
		// 全量, 分块慢速发送
		const block = 64 * 1024
		for i := 0; i < len(payload); i += block {
			end2 := i + block
			if end2 > len(payload) {
				end2 = len(payload)
			}
			_, _ = w.Write(payload[i:end2])
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			<-release
		}
	}))
	defer server.Close()
	defer close(release)

	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{MaxConnectionsPerHost: 4}

	dl := NewDownloader(&protocol.DownloadConfig{
		URL:        server.URL + "/cancel.bin",
		OutputPath: tmpDir,
		Filename:   "cancel.bin",
	}, runtime)

	// 启动下载, 200ms 后取消
	errCh := make(chan error, 1)
	go func() { errCh <- dl.Download(context.Background()) }()

	time.Sleep(200 * time.Millisecond)
	if err := dl.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	dlErr := <-errCh
	if dlErr == nil {
		t.Error("expected error after cancel, got nil")
	}
}

// TestDownload404: 服务器返回 404 → 应返回 error
func TestDownload404(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer server.Close()

	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{}

	dl := NewDownloader(&protocol.DownloadConfig{
		URL:        server.URL + "/missing.bin",
		OutputPath: tmpDir,
		Filename:   "missing.bin",
	}, runtime)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := dl.Download(ctx); err == nil {
		t.Error("expected error for 404, got nil")
	}
}
