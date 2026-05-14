package protocol_test

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/origadmin/orig-hub/internal/protocol"
)

type mockProtocol struct {
	name    string
	schemes []string
	caps    protocol.CapabilitySet
}

func (m *mockProtocol) Name() string              { return m.name }
func (m *mockProtocol) Schemes() []string          { return m.schemes }
func (m *mockProtocol) ParseURL(raw string) (*protocol.ParsedURL, error) {
	if idx := strings.Index(raw, ":"); idx > 0 {
		scheme := raw[:idx]
		return &protocol.ParsedURL{Scheme: scheme, Original: raw}, nil
	}
	return nil, fmt.Errorf("invalid URL: %s", raw)
}
func (m *mockProtocol) Probe(ctx context.Context, url *protocol.ParsedURL) (*protocol.Metadata, error) {
	return &protocol.Metadata{Name: "test"}, nil
}
func (m *mockProtocol) Capabilities() protocol.CapabilitySet { return m.caps }
func (m *mockProtocol) CreateDownloader(cfg *protocol.DownloadConfig) (protocol.Downloader, error) {
	return nil, fmt.Errorf("not implemented")
}
func (m *mockProtocol) CreateUploader(cfg *protocol.UploadConfig) (protocol.Uploader, error) {
	return nil, fmt.Errorf("not implemented")
}

func newHTTPProtocol() *mockProtocol {
	return &mockProtocol{
		name:    "http",
		schemes: []string{"http", "https"},
		caps: protocol.NewCapabilitySet(
			protocol.CapPauseResume,
			protocol.CapMirrors,
			protocol.CapChunkBased,
			protocol.CapMetadataProbe,
			protocol.CapStreaming,
		),
	}
}

func newBTProtocol() *mockProtocol {
	return &mockProtocol{
		name:    "bittorrent",
		schemes: []string{"magnet"},
		caps: protocol.NewCapabilitySet(
			protocol.CapPauseResume,
			protocol.CapStreaming,
			protocol.CapUpload,
			protocol.CapChunkBased,
			protocol.CapDHT,
			protocol.CapMultiNode,
		),
	}
}

func TestNewRegistryIsEmpty(t *testing.T) {
	r := protocol.NewRegistry()
	if len(r.List()) != 0 {
		t.Error("new registry should be empty")
	}
	if len(r.Schemes()) != 0 {
		t.Error("new registry should have no schemes")
	}
}

func TestRegisterAndRetrieveByScheme(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	got, ok := r.Get("http")
	if !ok {
		t.Fatal("Get(http) returned false, want true")
	}
	if got.Name() != "http" {
		t.Errorf("Get(http).Name() = %q, want %q", got.Name(), "http")
	}
}

func TestRegisterSameSchemeTwice(t *testing.T) {
	r := protocol.NewRegistry()
	p1 := &mockProtocol{name: "http1", schemes: []string{"http"}, caps: protocol.NewCapabilitySet()}
	p2 := &mockProtocol{name: "http2", schemes: []string{"http"}, caps: protocol.NewCapabilitySet()}

	if err := r.Register(p1); err != nil {
		t.Fatalf("first Register() failed: %v", err)
	}
	if err := r.Register(p2); err == nil {
		t.Error("expected error when registering duplicate scheme, got nil")
	}
}

func TestRegisterSameNameTwice(t *testing.T) {
	r := protocol.NewRegistry()
	p1 := &mockProtocol{name: "http", schemes: []string{"http"}, caps: protocol.NewCapabilitySet()}
	p2 := &mockProtocol{name: "http", schemes: []string{"https"}, caps: protocol.NewCapabilitySet()}

	if err := r.Register(p1); err != nil {
		t.Fatalf("first Register() failed: %v", err)
	}
	if err := r.Register(p2); err == nil {
		t.Error("expected error when registering duplicate name, got nil")
	}
}

func TestRegisterProtocolWithMultipleSchemes(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	httpProto, ok := r.Get("http")
	if !ok {
		t.Fatal("Get(http) returned false")
	}
	httpsProto, ok := r.Get("https")
	if !ok {
		t.Fatal("Get(https) returned false")
	}
	if httpProto.Name() != httpsProto.Name() {
		t.Errorf("http and https should resolve to same protocol, got %q and %q", httpProto.Name(), httpsProto.Name())
	}
}

func TestGetNonExistentScheme(t *testing.T) {
	r := protocol.NewRegistry()
	_, ok := r.Get("ftp")
	if ok {
		t.Error("expected ok=false for non-existent scheme, got true")
	}
}

func TestGetByName(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	got, ok := r.GetByName("http")
	if !ok {
		t.Fatal("GetByName(http) returned false, want true")
	}
	if got.Name() != "http" {
		t.Errorf("GetByName(http).Name() = %q, want %q", got.Name(), "http")
	}
}

func TestGetByNameNonExistent(t *testing.T) {
	r := protocol.NewRegistry()
	_, ok := r.GetByName("nonexistent")
	if ok {
		t.Error("expected ok=false for non-existent name, got true")
	}
}

func TestMatchURLHTTP(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	got, parsed, err := r.MatchURL("http://example.com/file.zip")
	if err != nil {
		t.Fatalf("MatchURL() failed: %v", err)
	}
	if got.Name() != "http" {
		t.Errorf("MatchURL(http://...).Name() = %q, want %q", got.Name(), "http")
	}
	if parsed == nil {
		t.Fatal("MatchURL() returned nil parsed URL")
	} else if parsed.Scheme != "http" {
		t.Errorf("parsed.Scheme = %q, want %q", parsed.Scheme, "http")
	}
}

func TestMatchURLMagnet(t *testing.T) {
	r := protocol.NewRegistry()
	bt := newBTProtocol()

	if err := r.Register(bt); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	got, _, err := r.MatchURL("magnet:?xt=urn:btih:abc123&dn=test")
	if err != nil {
		t.Fatalf("MatchURL() failed: %v", err)
	}
	if got.Name() != "bittorrent" {
		t.Errorf("MatchURL(magnet:...).Name() = %q, want %q", got.Name(), "bittorrent")
	}
}

func TestMatchURLUnknownScheme(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	_, _, err := r.MatchURL("ftp://example.com/file.zip")
	if err == nil {
		t.Error("expected error for unknown scheme, got nil")
	}
}

func TestMatchURLMalformedURL(t *testing.T) {
	r := protocol.NewRegistry()
	p := newHTTPProtocol()

	if err := r.Register(p); err != nil {
		t.Fatalf("Register() failed: %v", err)
	}

	_, _, err := r.MatchURL("not-a-url")
	if err == nil {
		t.Error("expected error for malformed URL, got nil")
	}
}

func TestListReturnsAllProtocols(t *testing.T) {
	r := protocol.NewRegistry()
	http := newHTTPProtocol()
	bt := newBTProtocol()

	if err := r.Register(http); err != nil {
		t.Fatalf("Register(http) failed: %v", err)
	}
	if err := r.Register(bt); err != nil {
		t.Fatalf("Register(bt) failed: %v", err)
	}

	list := r.List()
	if len(list) != 2 {
		t.Errorf("List() returned %d protocols, want 2", len(list))
	}

	names := make(map[string]bool)
	for _, p := range list {
		names[p.Name()] = true
	}
	if !names["http"] {
		t.Error("List() missing http protocol")
	}
	if !names["bittorrent"] {
		t.Error("List() missing bittorrent protocol")
	}
}

func TestSchemesReturnsAllRegisteredSchemes(t *testing.T) {
	r := protocol.NewRegistry()
	http := newHTTPProtocol()
	bt := newBTProtocol()

	if err := r.Register(http); err != nil {
		t.Fatalf("Register(http) failed: %v", err)
	}
	if err := r.Register(bt); err != nil {
		t.Fatalf("Register(bt) failed: %v", err)
	}

	schemes := r.Schemes()
	if len(schemes) != 3 {
		t.Errorf("Schemes() returned %d schemes, want 3", len(schemes))
	}

	schemeSet := make(map[string]bool)
	for _, s := range schemes {
		schemeSet[s] = true
	}
	if !schemeSet["http"] {
		t.Error("Schemes() missing http")
	}
	if !schemeSet["https"] {
		t.Error("Schemes() missing https")
	}
	if !schemeSet["magnet"] {
		t.Error("Schemes() missing magnet")
	}
}

func TestConcurrentAccess(t *testing.T) {
	r := protocol.NewRegistry()

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		p := &mockProtocol{
			name:    "concurrent1",
			schemes: []string{"c1"},
			caps:    protocol.NewCapabilitySet(),
		}
		_ = r.Register(p)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		p := &mockProtocol{
			name:    "concurrent2",
			schemes: []string{"c2"},
			caps:    protocol.NewCapabilitySet(),
		}
		_ = r.Register(p)
	}()

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.List()
		}()
	}

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.Get("c1")
		}()
	}

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.Schemes()
		}()
	}

	wg.Wait()

	list := r.List()
	if len(list) != 2 {
		t.Errorf("after concurrent access, List() = %d, want 2", len(list))
	}
}
