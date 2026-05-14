package http

import (
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

func TestHTTPProtocolName(t *testing.T) {
	p := New(nil)
	if p.Name() != "http" {
		t.Errorf("expected name 'http', got %q", p.Name())
	}
}

func TestHTTPProtocolSchemes(t *testing.T) {
	p := New(nil)
	schemes := p.Schemes()
	if len(schemes) != 2 || schemes[0] != "http" || schemes[1] != "https" {
		t.Errorf("expected [http https], got %v", schemes)
	}
}

func TestHTTPProtocolParseURL(t *testing.T) {
	p := New(nil)

	tests := []struct {
		name       string
		url        string
		wantErr    bool
		wantScheme string
	}{
		{"valid http", "http://example.com/file.zip", false, "http"},
		{"valid https", "https://example.com/file.zip", false, "https"},
		{"invalid scheme", "ftp://example.com/file.zip", true, ""},
		{"malformed", "://invalid", true, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, err := p.ParseURL(tt.url)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if parsed.Scheme != tt.wantScheme {
				t.Errorf("expected scheme %q, got %q", tt.wantScheme, parsed.Scheme)
			}
			if parsed.Original != tt.url {
				t.Errorf("expected original %q, got %q", tt.url, parsed.Original)
			}
		})
	}
}

func TestHTTPProtocolCapabilities(t *testing.T) {
	p := New(nil)
	caps := p.Capabilities()

	expectedCaps := []protocol.Capability{
		protocol.CapPauseResume,
		protocol.CapMirrors,
		protocol.CapStreaming,
		protocol.CapMetadataProbe,
		protocol.CapChunkBased,
		protocol.CapAuthSupport,
	}

	for _, cap := range expectedCaps {
		if !caps.Has(cap) {
			t.Errorf("expected capability %d to be set", cap)
		}
	}

	if caps.Has(protocol.CapUpload) {
		t.Error("HTTP should not have upload capability")
	}
}

func TestHTTPProtocolCreateUploader(t *testing.T) {
	p := New(nil)
	_, err := p.CreateUploader(&protocol.UploadConfig{ID: "test"})
	if err == nil {
		t.Error("expected error for HTTP upload, got nil")
	}
}

func TestHTTPProtocolCreateDownloaderNilConfig(t *testing.T) {
	p := New(nil)
	_, err := p.CreateDownloader(nil)
	if err == nil {
		t.Error("expected error for nil config, got nil")
	}
}

func TestHTTPProtocolCreateDownloaderEmptyURL(t *testing.T) {
	p := New(nil)
	_, err := p.CreateDownloader(&protocol.DownloadConfig{})
	if err == nil {
		t.Error("expected error for empty URL, got nil")
	}
}

func TestHTTPProtocolCreateDownloaderValid(t *testing.T) {
	p := New(nil)
	dl, err := p.CreateDownloader(&protocol.DownloadConfig{
		URL:        "http://example.com/file.zip",
		OutputPath: "/tmp",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dl == nil {
		t.Fatal("expected non-nil downloader")
	}
}

func TestHTTPProtocolWithRuntime(t *testing.T) {
	runtime := &types.RuntimeConfig{
		MaxConnectionsPerHost: 8,
		UserAgent:             "test-agent",
	}
	p := New(runtime)
	if p.runtime.MaxConnectionsPerHost != 8 {
		t.Errorf("expected 8 connections, got %d", p.runtime.MaxConnectionsPerHost)
	}
}
