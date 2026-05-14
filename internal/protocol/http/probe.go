package http

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/origadmin/orig-hub/internal/protocol"
	"github.com/origadmin/orig-hub/internal/engine/types"
)

type ProbeResult struct {
	Metadata      *protocol.Metadata
	SupportsRange bool
	TotalSize     int64
	Filename      string
	ContentType   string
}

func Probe(ctx context.Context, parsedURL *protocol.ParsedURL, runtime *types.RuntimeConfig) (*protocol.Metadata, error) {
	if parsedURL == nil {
		return nil, fmt.Errorf("parsed URL is required")
	}

	client := &http.Client{
		Timeout: types.ProbeTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return types.ErrMaxRedirects
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, parsedURL.Original, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create probe request: %w", err)
	}

	req.Header.Set("User-Agent", runtime.GetUserAgent())

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("probe request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, fmt.Errorf("probe returned status %d", resp.StatusCode)
	}

	meta := &protocol.Metadata{
		Name:         extractFilename(resp, parsedURL),
		Size:         parseContentLength(resp),
		ContentType:  resp.Header.Get("Content-Type"),
		AcceptRanges: strings.Contains(resp.Header.Get("Accept-Ranges"), "bytes") ||
			strings.Contains(resp.Header.Get("Accept-Ranges"), "Bytes"),
		ETag:    resp.Header.Get("ETag"),
		Headers: make(map[string]string),
		Extra:   make(map[string]interface{}),
	}

	if lm := resp.Header.Get("Last-Modified"); lm != "" {
		if t, err := http.ParseTime(lm); err == nil {
			meta.Modified = t
		}
	}

	for _, key := range []string{"Content-Disposition", "Content-Encoding", "Transfer-Encoding"} {
		if v := resp.Header.Get(key); v != "" {
			meta.Headers[key] = v
		}
	}

	return meta, nil
}

func extractFilename(resp *http.Response, parsedURL *protocol.ParsedURL) string {
	cd := resp.Header.Get("Content-Disposition")
	if cd != "" {
		if filename := parseContentDisposition(cd); filename != "" {
			return filename
		}
	}

	path := parsedURL.Path
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		path = path[idx+1:]
	}
	if path != "" {
		return path
	}
	return "download"
}

func parseContentDisposition(cd string) string {
	parts := strings.Split(cd, ";")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "filename=") {
			name := strings.TrimPrefix(part, "filename=")
			name = strings.Trim(name, "\"")
			if name != "" {
				return name
			}
		}
		if strings.HasPrefix(part, "filename*=") {
			name := strings.TrimPrefix(part, "filename*=")
			if idx := strings.Index(name, "''"); idx >= 0 {
				name = name[idx+2:]
			}
			name = strings.Trim(name, "\"")
			if name != "" {
				return name
			}
		}
	}
	return ""
}

func parseContentLength(resp *http.Response) int64 {
	cl := resp.Header.Get("Content-Length")
	if cl == "" {
		return -1
	}
	size, err := strconv.ParseInt(cl, 10, 64)
	if err != nil {
		return -1
	}
	return size
}
