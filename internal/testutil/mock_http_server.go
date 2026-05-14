package testutil

import (
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MockHTTPServerConfig struct {
	ContentLength      int64
	ContentDisposition string
	ResponseDelay      time.Duration
	DisconnectAfter    int64
	RedirectURL        string
	RedirectCode       int
	StatusCode         int
	EnableRange        bool
}

type MockHTTPServer struct {
	Server   *httptest.Server
	Config   MockHTTPServerConfig
	mu       sync.Mutex
	data     []byte
	requests int
}

func NewMockHTTPServer(cfg MockHTTPServerConfig) *MockHTTPServer {
	m := &MockHTTPServer{
		Config: cfg,
	}

	if cfg.ContentLength <= 0 {
		cfg.ContentLength = 1024
	}
	if cfg.StatusCode == 0 {
		cfg.StatusCode = http.StatusOK
	}
	if cfg.RedirectCode == 0 {
		cfg.RedirectCode = http.StatusMovedPermanently
	}

	m.data = make([]byte, cfg.ContentLength)
	_, _ = rand.Read(m.data)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.requests++
		m.mu.Unlock()

		if cfg.ResponseDelay > 0 {
			time.Sleep(cfg.ResponseDelay)
		}

		if cfg.RedirectURL != "" {
			http.Redirect(w, r, cfg.RedirectURL, cfg.RedirectCode)
			return
		}

		if cfg.StatusCode != http.StatusOK {
			w.WriteHeader(cfg.StatusCode)
			return
		}

		if cfg.ContentDisposition != "" {
			w.Header().Set("Content-Disposition", cfg.ContentDisposition)
		}

		if cfg.EnableRange {
			w.Header().Set("Accept-Ranges", "bytes")
			if rangeHdr := r.Header.Get("Range"); rangeHdr != "" {
				start, end, ok := parseRange(rangeHdr, cfg.ContentLength)
				if !ok {
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, cfg.ContentLength))
				w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
				w.WriteHeader(http.StatusPartialContent)

				if cfg.DisconnectAfter > 0 && (end-start+1) > cfg.DisconnectAfter {
					_, _ = w.Write(m.data[start : start+cfg.DisconnectAfter])
					if flusher, ok := w.(http.Flusher); ok {
						flusher.Flush()
					}
					return
				}
				_, _ = w.Write(m.data[start : end+1])
				return
			}
		}

		w.Header().Set("Content-Length", strconv.FormatInt(cfg.ContentLength, 10))

		if cfg.DisconnectAfter > 0 {
			_, _ = w.Write(m.data[:cfg.DisconnectAfter])
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			return
		}

		_, _ = w.Write(m.data)
	})

	m.Server = httptest.NewServer(handler)
	return m
}

func (m *MockHTTPServer) URL() string {
	return m.Server.URL
}

func (m *MockHTTPServer) Data() []byte {
	return m.data
}

func (m *MockHTTPServer) RequestCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requests
}

func (m *MockHTTPServer) Close() {
	m.Server.Close()
}

func parseRange(rangeHeader string, contentLength int64) (start, end int64, ok bool) {
	if !strings.HasPrefix(rangeHeader, "bytes=") {
		return 0, 0, false
	}

	rangeSpec := strings.TrimPrefix(rangeHeader, "bytes=")
	parts := strings.SplitN(rangeSpec, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}

	var err error
	if parts[0] == "" {
		var suffix int64
		suffix, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		start = contentLength - suffix
		end = contentLength - 1
	} else {
		start, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		if parts[1] == "" {
			end = contentLength - 1
		} else {
			end, err = strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				return 0, 0, false
			}
		}
	}

	if start < 0 || start > end || end >= contentLength {
		return 0, 0, false
	}

	return start, end, true
}

type SlowResponseConfig struct {
	TotalSize int64
	ChunkSize int64
	Delay     time.Duration
}

func NewSlowHTTPServer(cfg SlowResponseConfig) *httptest.Server {
	if cfg.TotalSize <= 0 {
		cfg.TotalSize = 1024
	}
	if cfg.ChunkSize <= 0 {
		cfg.ChunkSize = 64
	}
	if cfg.Delay == 0 {
		cfg.Delay = 50 * time.Millisecond
	}

	data := make([]byte, cfg.TotalSize)
	_, _ = rand.Read(data)

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt(cfg.TotalSize, 10))

		var written int64
		for written < cfg.TotalSize {
			end := written + cfg.ChunkSize
			if end > cfg.TotalSize {
				end = cfg.TotalSize
			}

			_, err := w.Write(data[written:end])
			if err != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}

			written = end
			time.Sleep(cfg.Delay)
		}
	}))
}

type DisconnectServerConfig struct {
	TotalSize     int64
	DisconnectAt  int64
	Reconnectable bool
}

func NewDisconnectHTTPServer(cfg DisconnectServerConfig) *httptest.Server {
	if cfg.TotalSize <= 0 {
		cfg.TotalSize = 1024
	}
	if cfg.DisconnectAt <= 0 {
		cfg.DisconnectAt = cfg.TotalSize / 2
	}

	data := make([]byte, cfg.TotalSize)
	_, _ = rand.Read(data)

	var mu sync.Mutex
	var attempt int

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempt++
		currentAttempt := attempt
		mu.Unlock()

		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", strconv.FormatInt(cfg.TotalSize, 10))

		if cfg.Reconnectable && currentAttempt > 1 {
			if rangeHdr := r.Header.Get("Range"); rangeHdr != "" {
				start, end, ok := parseRange(rangeHdr, cfg.TotalSize)
				if ok {
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, cfg.TotalSize))
					w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
					w.WriteHeader(http.StatusPartialContent)
					_, _ = w.Write(data[start : end+1])
					return
				}
			}
		}

		_, _ = io.Copy(w, io.LimitReader(newByteSliceReader(data), cfg.DisconnectAt))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}))
}

type byteSliceReader struct {
	data []byte
	pos  int
}

func newByteSliceReader(data []byte) *byteSliceReader {
	return &byteSliceReader{data: data}
}

func (r *byteSliceReader) Read(p []byte) (n int, err error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n = copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
