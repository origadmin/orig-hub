package testutil

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MockIPFSGatewayConfig struct {
	TimeoutDelay time.Duration
}

type pinEntry struct {
	CID     string
	Status  string
	Created time.Time
}

type MockIPFSGateway struct {
	Server     *httptest.Server
	Config     MockIPFSGatewayConfig
	mu         sync.Mutex
	pins       map[string]pinEntry
	cidData    map[string][]byte
	timeoutCID string
}

func NewMockIPFSGateway(cfg MockIPFSGatewayConfig) *MockIPFSGateway {
	m := &MockIPFSGateway{
		Config:  cfg,
		pins:    make(map[string]pinEntry),
		cidData: make(map[string][]byte),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ipfs/", m.handleResolve)
	mux.HandleFunc("/api/v0/pin/add", m.handlePinAdd)
	mux.HandleFunc("/api/v0/pin/rm", m.handlePinRemove)
	mux.HandleFunc("/api/v0/pin/ls", m.handlePinList)
	mux.HandleFunc("/api/v0/cat", m.handleCat)

	m.Server = httptest.NewServer(mux)
	return m
}

func (m *MockIPFSGateway) URL() string {
	return m.Server.URL
}

func (m *MockIPFSGateway) AddCIDData(cid string, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cidData[cid] = data
}

func (m *MockIPFSGateway) SetTimeoutCID(cid string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.timeoutCID = cid
}

func (m *MockIPFSGateway) Close() {
	m.Server.Close()
}

func (m *MockIPFSGateway) handleResolve(w http.ResponseWriter, r *http.Request) {
	cid := strings.TrimPrefix(r.URL.Path, "/ipfs/")

	m.mu.Lock()
	timeoutCID := m.timeoutCID
	delay := m.Config.TimeoutDelay
	data, exists := m.cidData[cid]
	m.mu.Unlock()

	if cid == timeoutCID && delay > 0 {
		time.Sleep(delay)
	}

	if !exists {
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, "cid %s not found", cid)
		return
	}

	if r.Method == http.MethodHead {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("X-Content-Hash", fmt.Sprintf("%x", sha256.Sum256(data)))
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}

func (m *MockIPFSGateway) handlePinAdd(w http.ResponseWriter, r *http.Request) {
	cid := r.URL.Query().Get("arg")
	if cid == "" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, "missing arg parameter")
		return
	}

	m.mu.Lock()
	m.pins[cid] = pinEntry{
		CID:     cid,
		Status:  "pinned",
		Created: time.Now(),
	}
	m.mu.Unlock()

	resp := map[string]interface{}{
		"Pins": []string{cid},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (m *MockIPFSGateway) handlePinRemove(w http.ResponseWriter, r *http.Request) {
	cid := r.URL.Query().Get("arg")
	if cid == "" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, "missing arg parameter")
		return
	}

	m.mu.Lock()
	delete(m.pins, cid)
	m.mu.Unlock()

	resp := map[string]interface{}{
		"Pins": []string{cid},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (m *MockIPFSGateway) handlePinList(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()

	keys := make(map[string]map[string]string)
	for cid, entry := range m.pins {
		keys[cid] = map[string]string{
			"Type": entry.Status,
		}
	}

	resp := map[string]interface{}{
		"Keys": keys,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (m *MockIPFSGateway) handleCat(w http.ResponseWriter, r *http.Request) {
	cid := r.URL.Query().Get("arg")
	if cid == "" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, "missing arg parameter")
		return
	}

	m.mu.Lock()
	timeoutCID := m.timeoutCID
	delay := m.Config.TimeoutDelay
	data, exists := m.cidData[cid]
	m.mu.Unlock()

	if cid == timeoutCID && delay > 0 {
		time.Sleep(delay)
	}

	if !exists {
		w.WriteHeader(http.StatusNotFound)
		_, _ = fmt.Fprintf(w, "cid %s not found", cid)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = io.Copy(w, newBytesReader(data))
}

type bytesReaderAt struct {
	data []byte
	pos  int
}

func newBytesReader(data []byte) *bytesReaderAt {
	return &bytesReaderAt{data: data}
}

func (r *bytesReaderAt) Read(p []byte) (n int, err error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n = copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
