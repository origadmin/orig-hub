package service

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpproto "github.com/origadmin/orig-hub/internal/protocol/http"
)

// captureEmitter: 测试用的 emitter, 记录所有 emit 的事件
type captureEmitter struct {
	mu        sync.Mutex
	events    []capturedEvent
	stateOnID map[string]int // state event count per id
	progOnID  map[string]int // progress event count per id
}

type capturedEvent struct {
	name string
	data any
}

func newCaptureEmitter() *captureEmitter {
	return &captureEmitter{
		stateOnID: make(map[string]int),
		progOnID:  make(map[string]int),
	}
}

func (e *captureEmitter) Emit(name string, data ...any) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	var payload any
	if len(data) > 0 {
		payload = data[0]
	}
	e.events = append(e.events, capturedEvent{name: name, data: payload})
	switch name {
	case "download:state":
		if d, ok := payload.(downloadStateEvent); ok {
			e.stateOnID[d.ID]++
		}
	case "download:progress":
		if d, ok := payload.(downloadProgressEvent); ok {
			e.progOnID[d.ID]++
		}
	}
	return true
}

func (e *captureEmitter) progressCount(id string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.progOnID[id]
}

func (e *captureEmitter) stateCount(id string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stateOnID[id]
}

func (e *captureEmitter) latestState(id string) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	// walk events from end, find last state for id
	for i := len(e.events) - 1; i >= 0; i-- {
		ev := e.events[i]
		if ev.name != "download:state" {
			continue
		}
		if d, ok := ev.data.(downloadStateEvent); ok && d.ID == id {
			return d.State
		}
	}
	return ""
}

// buildHTTPPayloadServer: 起一个 httptest server, 返回 N 字节 payload 支持 Range
func buildHTTPPayloadServer(t *testing.T, size int) (*httptest.Server, []byte) {
	t.Helper()
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	return srv, payload
}

// openTestDB: 准备一个 in-memory state.DB (不写文件)
func openTestDB(t *testing.T) *state.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := state.Open(dir + "/test.db")
	if err != nil {
		t.Fatalf("state.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// makeCfg: 测试 config
func makeCfg(dir string) *config.Settings {
	return &config.Settings{
		Download: config.DownloadSettings{
			OutputDir:      dir,
			MaxConnections: 4,
		},
	}
}

func newService(t *testing.T) (*LocalService, *protocol.ProtocolRegistry) {
	t.Helper()
	dir := t.TempDir()
	db := openTestDB(t)
	cfg := makeCfg(dir)
	registry := protocol.NewRegistry()

	httpP := httpproto.New(cfg.ToRuntimeConfig())
	_ = registry.Register(httpP)
	svc := NewLocalService(registry, cfg, db)
	return svc, registry
}

// TestOnProgressEmitDuringDownload: 下载过程中, emitter 收到至少 1 次 download:progress
func TestOnProgressEmitDuringDownload(t *testing.T) {
	srv, _ := buildHTTPPayloadServer(t, 4*1024*1024) // 4 MB
	defer srv.Close()

	emitter := newCaptureEmitter()
	svc, _ := newService(t)
	svc.SetEmitter(emitter)

	id, err := svc.Add(t.Context(), srv.URL+"/f.bin", t.TempDir(), "f.bin", nil, nil)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	// 等待下载完成 (with 30s deadline)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := svc.GetStatus(id)
		if st != nil && st.Status == "completed" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	count := emitter.progressCount(id)
	if count < 1 {
		t.Errorf("expected >=1 download:progress event, got %d", count)
	}

	finalState := emitter.latestState(id)
	if finalState == "" {
		t.Error("expected download:state event(s), got 0")
	}
}

// TestOnStateChanged: 状态变更触发 download:state 事件
func TestOnStateChanged(t *testing.T) {
	srv, _ := buildHTTPPayloadServer(t, 2*1024*1024)
	defer srv.Close()

	emitter := newCaptureEmitter()
	svc, _ := newService(t)
	svc.SetEmitter(emitter)

	id, err := svc.Add(t.Context(), srv.URL+"/f.bin", t.TempDir(), "f.bin", nil, nil)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	// 等到 downloading
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := svc.GetStatus(id)
		if st != nil && st.Status == "downloading" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := svc.Pause(id); err != nil {
		t.Fatalf("Pause: %v", err)
	}
	time.Sleep(300 * time.Millisecond) // 给 poll 一点时间

	stateCount := emitter.stateCount(id)
	if stateCount < 1 {
		t.Errorf("expected download:state events, got %d", stateCount)
	}
}

// TestNoEmitterNoPanic: 不注入 emitter (用 noop) 时, OnProgress/OnStateChanged 不 panic
func TestNoEmitterNoPanic(t *testing.T) {
	srv, _ := buildHTTPPayloadServer(t, 1*1024*1024)
	defer srv.Close()

	svc, _ := newService(t)
	// 注意: 不调用 SetEmitter, 用 noopEmitter

	id, err := svc.Add(t.Context(), srv.URL+"/f.bin", t.TempDir(), "f.bin", nil, nil)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := svc.GetStatus(id)
		if st != nil && st.Status == "completed" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("download did not complete in 15s")
}

// TestStateToWireMapping: 验证 state 字符串小写映射
func TestStateToWireMapping(t *testing.T) {
	cases := []struct {
		in   protocol.DownloadState
		want string
	}{
		{protocol.DownloadStateQueued, "queued"},
		{protocol.DownloadStateProbing, "probing"},
		{protocol.DownloadStateDownloading, "downloading"},
		{protocol.DownloadStatePausing, "paused"},
		{protocol.DownloadStatePaused, "paused"},
		{protocol.DownloadStateCompleted, "completed"},
		{protocol.DownloadStateCancelled, "cancelled"},
		{protocol.DownloadStateError, "error"},
	}
	for _, c := range cases {
		got := stateToWire(c.in)
		if got != c.want {
			t.Errorf("stateToWire(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 静态断言: 编译期验证 captureEmitter 满足 EventEmitter
var _ EventEmitter = (*captureEmitter)(nil)
var _ atomic.Bool // avoid unused import
