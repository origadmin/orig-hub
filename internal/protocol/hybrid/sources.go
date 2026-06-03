package hybrid

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type HTTPSource struct {
	URL      string
	client   *http.Client
	metadata *FileMetadata

	mu           sync.RWMutex
	speed        atomic.Int64
	totalBytes   atomic.Int64
	downloadTime atomic.Int64
	active       atomic.Bool
	failedRanges []string
}

func (s *HTTPSource) Name() string {
	return "http"
}

func (s *HTTPSource) Open(ctx context.Context) error {
	if s.client == nil {
		s.client = &http.Client{
			Timeout: 30 * time.Second,
		}
	}
	s.active.Store(true)
	return nil
}

func (s *HTTPSource) Close() error {
	s.active.Store(false)
	return nil
}

func (s *HTTPSource) GetMetadata(ctx context.Context) (*FileMetadata, error) {
	if s.metadata != nil {
		return s.metadata, nil
	}

	req, err := http.NewRequestWithContext(ctx, "HEAD", s.URL, nil)
	if err != nil {
		return nil, err
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	filename := extractFilename(s.URL)
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if fn := extractFilename(cd); fn != "" {
			filename = fn
		}
	}

	s.metadata = &FileMetadata{
		Filename: filename,
		FileSize: resp.ContentLength,
	}

	if s.metadata.FileSize <= 0 {
		return nil, fmt.Errorf("cannot determine file size from %s", s.URL)
	}

	if s.metadata.PieceSize <= 0 {
		s.metadata.PieceSize = 1024 * 1024 // 1MB default
	}

	if s.metadata.FileSize > 0 {
		s.metadata.PieceCount = int((s.metadata.FileSize + s.metadata.PieceSize - 1) / s.metadata.PieceSize)
	}

	return s.metadata, nil
}

func (s *HTTPSource) GetPieces() ([]Piece, error) {
	meta, _ := s.GetMetadata(context.Background())
	if meta == nil {
		return nil, fmt.Errorf("metadata not available")
	}

	pieces := make([]Piece, 0, meta.PieceCount)
	for i := 0; i < meta.PieceCount; i++ {
		offset := int64(i) * meta.PieceSize
		size := meta.PieceSize
		if offset+size > meta.FileSize {
			size = meta.FileSize - offset
		}
		pieces = append(pieces, Piece{
			Index:  i,
			Offset: offset,
			Size:   size,
		})
	}

	return pieces, nil
}

func (s *HTTPSource) FetchPiece(ctx context.Context, piece Piece) ([]byte, error) {
	if !s.active.Load() {
		return nil, fmt.Errorf("source not active")
	}

	startTime := time.Now()
	defer func() {
		elapsed := time.Since(startTime)
		if elapsed > 0 {
			s.downloadTime.Add(elapsed.Nanoseconds())
		}
	}()

	req, err := http.NewRequestWithContext(ctx, "GET", s.URL, nil)
	if err != nil {
		return nil, err
	}

	end := piece.Offset + piece.Size - 1
	if piece.Offset+piece.Size > s.metadata.FileSize {
		end = s.metadata.FileSize - 1
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", piece.Offset, end))

	resp, err := s.client.Do(req)
	if err != nil {
		s.mu.Lock()
		s.failedRanges = append(s.failedRanges, fmt.Sprintf("%d", piece.Index))
		s.mu.Unlock()
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	s.totalBytes.Add(int64(len(data)))
	speed := float64(len(data)) / time.Since(startTime).Seconds()
	s.speed.Store(int64(speed))

	return data, nil
}

func (s *HTTPSource) Capabilities() SourceCapability {
	return SourceCapability{
		Protocol:     "http",
		MaxSpeed:    s.speed.Load(),
		Reliability: 0.95,
		Latency:    50 * time.Millisecond,
		Active:     s.active.Load(),
	}
}

func (s *HTTPSource) Speed() int64 {
	return s.speed.Load()
}

func (s *HTTPSource) MarkRangeFailed(pieceIndex int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failedRanges = append(s.failedRanges, fmt.Sprintf("%d", pieceIndex))
}

func (s *HTTPSource) IsRangeFailed(pieceIndex int) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	failed := fmt.Sprintf("%d", pieceIndex)
	for _, f := range s.failedRanges {
		if f == failed {
			return true
		}
	}
	return false
}

type BTSource struct {
	InfoHash string
}

func (s *BTSource) Name() string {
	return "bt"
}

func (s *BTSource) Open(ctx context.Context) error {
	return nil
}

func (s *BTSource) Close() error {
	return nil
}

func (s *BTSource) GetMetadata(ctx context.Context) (*FileMetadata, error) {
	return nil, fmt.Errorf("BT not implemented yet")
}

func (s *BTSource) GetPieces() ([]Piece, error) {
	return nil, fmt.Errorf("BT not implemented yet")
}

func (s *BTSource) FetchPiece(ctx context.Context, piece Piece) ([]byte, error) {
	return nil, fmt.Errorf("BT not implemented yet")
}

func (s *BTSource) Capabilities() SourceCapability {
	return SourceCapability{
		Protocol:    "bt",
		MaxSpeed:   50 * 1024 * 1024,
		Reliability: 0.8,
		Latency:    100 * time.Millisecond,
	}
}

type IPFSSource struct {
	CID     string
	Gateway string
}

func (s *IPFSSource) Name() string {
	return "ipfs"
}

func (s *IPFSSource) Open(ctx context.Context) error {
	if s.Gateway == "" {
		s.Gateway = "https://cloudflare-ipfs.com"
	}
	return nil
}

func (s *IPFSSource) Close() error {
	return nil
}

func (s *IPFSSource) GetMetadata(ctx context.Context) (*FileMetadata, error) {
	return nil, fmt.Errorf("IPFS metadata not implemented")
}

func (s *IPFSSource) GetPieces() ([]Piece, error) {
	return nil, fmt.Errorf("IPFS not implemented")
}

func (s *IPFSSource) FetchPiece(ctx context.Context, piece Piece) ([]byte, error) {
	url := fmt.Sprintf("%s/ipfs/%s", s.Gateway, s.CID)
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

func (s *IPFSSource) Capabilities() SourceCapability {
	return SourceCapability{
		Protocol:    "ipfs",
		MaxSpeed:   20 * 1024 * 1024,
		Reliability: 0.6,
		Latency:    200 * time.Millisecond,
	}
}

func extractFilename(s string) string {
	parts := bytes.Split([]byte(s), []byte("/"))
	if len(parts) > 0 {
		name := string(parts[len(parts)-1])
		parts = bytes.Split([]byte(name), []byte("="))
		if len(parts) > 1 {
			return string(parts[len(parts)-1])
		}
		return name
	}
	return ""
}

func writeFileAtomic(outputPath, filename string, data []byte) error {
	if err := os.MkdirAll(outputPath, 0755); err != nil {
		return err
	}

	destPath := filepath.Join(outputPath, filename)
	tmpPath := destPath + ".tmp"

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return err
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		return err
	}

	return nil
}

func hashData(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}

// ComputeFileHash 计算文件 SHA256 哈希
func ComputeFileHash(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}

	return fmt.Sprintf("%x", hasher.Sum(nil)), nil
}
