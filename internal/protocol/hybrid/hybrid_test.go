package hybrid

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

// TestPayloadRoundTrip: encode/decode 必须保持一致
func TestPayloadRoundTrip(t *testing.T) {
	payload := &HybridPayload{
		Version:   1,
		Hash:      "abc123def456",
		HashType:  "sha256",
		FileSize:  1024 * 1024 * 100,
		PieceSize: 1024 * 1024,
		PieceHashes: []string{
			"piecehash1", "piecehash2", "piecehash3",
		},
		MultiSource: []SourceMeta{
			{Type: "http", URL: "https://example.com/a.zip"},
			{Type: "http", URL: "https://mirror.example.com/a.zip"},
		},
	}

	encoded, err := encodePayload(payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if encoded == "" {
		t.Fatal("encoded is empty")
	}

	decoded, err := decodePayload(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded == nil {
		t.Fatal("decoded is nil")
	}
	if decoded.Hash != payload.Hash {
		t.Errorf("Hash mismatch: got %q, want %q", decoded.Hash, payload.Hash)
	}
	if decoded.FileSize != payload.FileSize {
		t.Errorf("FileSize mismatch: got %d, want %d", decoded.FileSize, payload.FileSize)
	}
	if decoded.PieceSize != payload.PieceSize {
		t.Errorf("PieceSize mismatch: got %d, want %d", decoded.PieceSize, payload.PieceSize)
	}
	if len(decoded.MultiSource) != len(payload.MultiSource) {
		t.Errorf("MultiSource count: got %d, want %d", len(decoded.MultiSource), len(payload.MultiSource))
	}
}

// TestHybridLinkRoundTrip: GenerateHybridLink + ParseHybridProtocolLink
func TestHybridLinkRoundTrip(t *testing.T) {
	payload := &HybridPayload{
		Version:   1,
		Hash:      "deadbeef",
		HashType:  "sha256",
		FileSize:  2048,
		PieceSize: 512,
		MultiSource: []SourceMeta{
			{Type: "http", URL: "https://a.example.com/x.bin"},
			{Type: "http", URL: "https://b.example.com/x.bin"},
		},
	}
	sources := []string{
		"https://a.example.com/x.bin",
		"https://b.example.com/x.bin",
	}

	link, err := GenerateHybridLink(payload, sources)
	if err != nil {
		t.Fatalf("GenerateHybridLink: %v", err)
	}
	if !strings.HasPrefix(link, "hybrid:?") {
		t.Errorf("link should start with 'hybrid:?', got %q", link)
	}

	gotPayload, gotSources, err := ParseHybridProtocolLink(link)
	if err != nil {
		t.Fatalf("ParseHybridProtocolLink: %v", err)
	}
	if gotPayload == nil {
		t.Fatal("payload nil after round-trip")
	}
	if gotPayload.Hash != payload.Hash {
		t.Errorf("Hash: got %q, want %q", gotPayload.Hash, payload.Hash)
	}
	if len(gotSources) != 2 {
		t.Errorf("sources count: got %d, want 2", len(gotSources))
	}
}

// TestGatewayLinkRoundTrip: GenerateGatewayLink + ParseGatewayLink
func TestGatewayLinkRoundTrip(t *testing.T) {
	payload := &HybridPayload{
		Version:  1,
		Hash:     "cafebabe",
		FileSize: 4096,
		MultiSource: []SourceMeta{
			{Type: "http", URL: "https://a.example.com/y.bin"},
		},
	}
	sources := []string{"https://a.example.com/y.bin"}

	link, err := GenerateGatewayLinkWithDomain(payload, sources, "test.local")
	if err != nil {
		t.Fatalf("GenerateGatewayLink: %v", err)
	}
	if !strings.HasPrefix(link, "https://test.local/dl?") {
		t.Errorf("link should start with gateway URL, got %q", link)
	}

	gotPayload, gotSources, err := ParseGatewayLink(link)
	if err != nil {
		t.Fatalf("ParseGatewayLink: %v", err)
	}
	if gotPayload == nil {
		t.Fatal("payload nil after round-trip")
	}
	if gotPayload.Hash != payload.Hash {
		t.Errorf("Hash: got %q, want %q", gotPayload.Hash, payload.Hash)
	}
	if len(gotSources) != 1 {
		t.Errorf("sources count: got %d, want 1", len(gotSources))
	}
}

// TestHybridDownloadSingleSource: 单一 HTTP source, 完整下载, SHA256 验证
func TestHybridDownloadSingleSource(t *testing.T) {
	payload := make([]byte, 3*1024*1024) // 3MB
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}
	expectedHash := sha256.Sum256(payload)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))

		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}

		rangeHeader := r.Header.Get("Range")
		if rangeHeader == "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
			return
		}

		var start, end int64
		fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end)
		if end >= int64(len(payload)) {
			end = int64(len(payload)) - 1
		}
		chunkLen := end - start + 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", chunkLen))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[start : end+1])
	}))
	defer server.Close()

	// 构造 hybrid:?http=... 链接
	link := "hybrid:?http=" + server.URL + "/test.bin"

	runtime := &types.RuntimeConfig{}
	proto := NewHybridProtocol(nil, runtime)
	dl, err := proto.CreateDownloader(&protocol.DownloadConfig{
		URL:        link,
		OutputPath: t.TempDir(),
		Filename:   "test.bin",
	})
	if err != nil {
		t.Fatalf("CreateDownloader: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := dl.Download(ctx); err != nil {
		t.Fatalf("Download: %v", err)
	}

	// 找到下载的文件
	tmpDir := t.TempDir()
	// 重新下载到指定 tmpDir
	dl2, _ := proto.CreateDownloader(&protocol.DownloadConfig{
		URL:        link,
		OutputPath: tmpDir,
		Filename:   "verify.bin",
	})
	if err := dl2.Download(ctx); err != nil {
		t.Fatalf("Download #2: %v", err)
	}

	dest := filepath.Join(tmpDir, "verify.bin")
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

// TestHybridDownloadMultiSource: 两个 HTTP source 链接, 验证多源集成
func TestHybridDownloadMultiSource(t *testing.T) {
	payload := make([]byte, 4*1024*1024) // 4MB
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}
	expectedHash := sha256.Sum256(payload)

	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))

		if r.Method == "HEAD" {
			w.WriteHeader(http.StatusOK)
			return
		}

		rangeHeader := r.Header.Get("Range")
		if rangeHeader == "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
			return
		}

		var start, end int64
		fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end)
		if end >= int64(len(payload)) {
			end = int64(len(payload)) - 1
		}
		chunkLen := end - start + 1
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.Header().Set("Content-Length", fmt.Sprintf("%d", chunkLen))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[start : end+1])
	}

	// 两个 source 提供同一文件
	server1 := httptest.NewServer(http.HandlerFunc(handler))
	defer server1.Close()
	server2 := httptest.NewServer(http.HandlerFunc(handler))
	defer server2.Close()

	link := "hybrid:?http=" + server1.URL + "/f.bin&http=" + server2.URL + "/f.bin"

	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{}
	proto := NewHybridProtocol(nil, runtime)
	dl, err := proto.CreateDownloader(&protocol.DownloadConfig{
		URL:        link,
		OutputPath: tmpDir,
		Filename:   "multi.bin",
	})
	if err != nil {
		t.Fatalf("CreateDownloader: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := dl.Download(ctx); err != nil {
		t.Fatalf("Download: %v", err)
	}

	dest := filepath.Join(tmpDir, "multi.bin")
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

// TestHybridDownloadCancel: 下载中取消 → 返回 error
func TestHybridDownloadCancel(t *testing.T) {
	payload := make([]byte, 16*1024*1024) // 16MB
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}

	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))

		if r.Method == "HEAD" {
			w.WriteHeader(http.StatusOK)
			return
		}

		rangeHeader := r.Header.Get("Range")
		if rangeHeader == "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload)
			return
		}
		var start, end int64
		fmt.Sscanf(rangeHeader, "bytes=%d-%d", &start, &end)
		if end >= int64(len(payload)) {
			end = int64(len(payload)) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.WriteHeader(http.StatusPartialContent)

		const block = 64 * 1024
		chunk := payload[start : end+1]
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
	}))
	defer server.Close()
	defer close(release)

	link := "hybrid:?http=" + server.URL + "/c.bin"
	tmpDir := t.TempDir()
	runtime := &types.RuntimeConfig{}
	proto := NewHybridProtocol(nil, runtime)
	dl, err := proto.CreateDownloader(&protocol.DownloadConfig{
		URL:        link,
		OutputPath: tmpDir,
		Filename:   "cancel.bin",
	})
	if err != nil {
		t.Fatalf("CreateDownloader: %v", err)
	}

	errCh := make(chan error, 1)
	go func() { errCh <- dl.Download(context.Background()) }()

	time.Sleep(500 * time.Millisecond)
	if err := dl.Cancel(); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	select {
	case err := <-errCh:
		if err == nil {
			t.Error("expected error after cancel, got nil")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("download did not respond to cancel within 3s")
	}
}

// 避免 unused import 警告: io, sync, atomic
var _ = io.Discard
var _ = sync.Mutex{}
var _ = atomic.Bool{}
