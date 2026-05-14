package http

import (
	"context"
	"fmt"
	"net/url"

	"github.com/origadmin/orig-hub/internal/protocol"
	"github.com/origadmin/orig-hub/internal/engine/types"
)

type HTTPProtocol struct {
	runtime *types.RuntimeConfig
}

func New(runtime *types.RuntimeConfig) *HTTPProtocol {
	if runtime == nil {
		runtime = &types.RuntimeConfig{}
	}
	return &HTTPProtocol{runtime: runtime}
}

func (p *HTTPProtocol) Name() string { return "http" }

func (p *HTTPProtocol) Schemes() []string { return []string{"http", "https"} }

func (p *HTTPProtocol) ParseURL(raw string) (*protocol.ParsedURL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	return &protocol.ParsedURL{
		Scheme:   u.Scheme,
		Host:     u.Host,
		Path:     u.Path,
		RawQuery: u.RawQuery,
		Fragment: u.Fragment,
		Original: raw,
	}, nil
}

func (p *HTTPProtocol) Probe(ctx context.Context, parsedURL *protocol.ParsedURL) (*protocol.Metadata, error) {
	return Probe(ctx, parsedURL, p.runtime)
}

func (p *HTTPProtocol) Capabilities() protocol.CapabilitySet {
	return protocol.NewCapabilitySet(
		protocol.CapPauseResume,
		protocol.CapMirrors,
		protocol.CapStreaming,
		protocol.CapMetadataProbe,
		protocol.CapChunkBased,
		protocol.CapAuthSupport,
	)
}

func (p *HTTPProtocol) CreateDownloader(cfg *protocol.DownloadConfig) (protocol.Downloader, error) {
	if cfg == nil {
		return nil, fmt.Errorf("download config is required")
	}
	if cfg.URL == "" {
		return nil, fmt.Errorf("URL is required")
	}
	return NewDownloader(cfg, p.runtime), nil
}

func (p *HTTPProtocol) CreateUploader(cfg *protocol.UploadConfig) (protocol.Uploader, error) {
	return nil, fmt.Errorf("HTTP protocol does not support upload")
}
