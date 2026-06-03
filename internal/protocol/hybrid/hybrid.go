package hybrid

import (
	"bytes"
	"compress/flate"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

type HybridProtocol struct {
	registry    *protocol.ProtocolRegistry
	runtime     *types.RuntimeConfig
	discovery   *SourceDiscovery
	scheduler   *BlockScheduler
	pieceMgr    *PieceManager
	localTracker *LocalTracker
}

func NewHybridProtocol(registry *protocol.ProtocolRegistry, runtime *types.RuntimeConfig) *HybridProtocol {
	if runtime == nil {
		runtime = &types.RuntimeConfig{}
	}
	return &HybridProtocol{
		registry:    registry,
		runtime:     runtime,
		discovery:   NewSourceDiscovery(runtime),
		scheduler:   NewBlockScheduler(),
		pieceMgr:    NewPieceManager(),
		localTracker: NewLocalTracker(),
	}
}

func (p *HybridProtocol) Name() string {
	return "hybrid"
}

func (p *HybridProtocol) Schemes() []string {
	return []string{"hybrid", "hybrid://"}
}

func (p *HybridProtocol) MatchURL(rawURL string) bool {
	if strings.HasPrefix(rawURL, "hybrid:?") {
		return true
	}
	if strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://") {
		if u, err := url.Parse(rawURL); err == nil {
			return strings.HasPrefix(u.Path, "/dl")
		}
	}
	return false
}

func (p *HybridProtocol) ParseURL(raw string) (*protocol.ParsedURL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse url: %w", err)
	}
	return &protocol.ParsedURL{
		Scheme:   "hybrid",
		Host:     u.Host,
		Path:     u.Path,
		RawQuery: u.RawQuery,
		Fragment: u.Fragment,
		Original: raw,
	}, nil
}

func (p *HybridProtocol) Probe(ctx context.Context, parsedURL *protocol.ParsedURL) (*protocol.Metadata, error) {
	sources, err := p.parseHybridURL(parsedURL.Original)
	if err != nil {
		return nil, err
	}
	if len(sources) == 0 {
		return nil, fmt.Errorf("no sources found")
	}

	primary := sources[0]
	meta, err := primary.GetMetadata(ctx)
	if err != nil {
		return nil, err
	}

	return &protocol.Metadata{
		Name:     meta.Filename,
		Size:     meta.FileSize,
		Mirrors:  p.getMirrorURLs(sources),
		Extra:    map[string]interface{}{"piece_size": meta.PieceSize},
	}, nil
}

func (p *HybridProtocol) getMirrorURLs(sources []Source) []string {
	mirrors := []string{}
	for _, s := range sources {
		if hs, ok := s.(*HTTPSource); ok {
			mirrors = append(mirrors, hs.URL)
		}
	}
	return mirrors
}

func (p *HybridProtocol) Capabilities() protocol.CapabilitySet {
	return protocol.NewCapabilitySet(
		protocol.CapChunkBased,
		protocol.CapMirrors,
		protocol.CapMetadataProbe,
	)
}

func (p *HybridProtocol) CreateDownloader(cfg *protocol.DownloadConfig) (protocol.Downloader, error) {
	sources, err := p.parseHybridURL(cfg.URL)
	if err != nil {
		return nil, err
	}

	downloader := &HybridDownloader{
		cfg:        cfg,
		sources:    sources,
		discovery:  p.discovery,
		scheduler:  p.scheduler,
		pieceMgr:   p.pieceMgr,
		registry:   p.registry,
		state:      protocol.DownloadStateQueued,
		progress:   protocol.Progress{},
	}

	return downloader, nil
}

func (p *HybridProtocol) CreateUploader(cfg *protocol.UploadConfig) (protocol.Uploader, error) {
	return nil, fmt.Errorf("hybrid protocol does not support upload")
}

// HybridPayload 核心编码数据
type HybridPayload struct {
	Version       int              `json:"v"`
	Hash          string           `json:"h,omitempty"`
	HashType      string           `json:"ht,omitempty"`
	FileSize      int64            `json:"s,omitempty"`
	PieceSize     int64            `json:"ps,omitempty"`
	PieceHashes   []string         `json:"ph,omitempty"`
	MultiSource   []SourceMeta     `json:"ms,omitempty"`
}

type SourceMeta struct {
	Type   string `json:"t"`
	URL    string `json:"u,omitempty"`
	Hash   string `json:"h,omitempty"`
	CID    string `json:"c,omitempty"`
	Range  string `json:"r,omitempty"`
}

// encodePayload 编码核心 payload
func encodePayload(payload *HybridPayload) (string, error) {
	if payload == nil {
		return "", nil
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}

	var compressedData []byte
	if len(jsonData) > 20 {
		var buf bytes.Buffer
		w, err := flate.NewWriter(&buf, flate.BestCompression)
		if err != nil {
			return "", fmt.Errorf("create flate writer: %w", err)
		}
		_, err = w.Write(jsonData)
		if err != nil {
			return "", fmt.Errorf("write flate: %w", err)
		}
		err = w.Close()
		if err != nil {
			return "", fmt.Errorf("close flate: %w", err)
		}
		compressedData = buf.Bytes()
	} else {
		compressedData = jsonData
	}

	encoded := base64.URLEncoding.EncodeToString(compressedData)
	encoded = strings.TrimRight(encoded, "=")

	return encoded, nil
}

// decodePayload 解码核心 payload
func decodePayload(encoded string) (*HybridPayload, error) {
	// 移除所有可能的前缀
	for _, prefix := range []string{"urn:hybrid:", "urn:origlink:", "urn:ms:"} {
		encoded = strings.TrimPrefix(encoded, prefix)
	}

	if encoded == "" {
		return nil, nil
	}

	padding := len(encoded) % 4
	if padding > 0 {
		encoded += strings.Repeat("=", 4-padding)
	}

	data, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("base64 decode: %w", err)
	}

	var jsonData []byte
	if len(data) > 0 {
		r := flate.NewReader(bytes.NewReader(data))
		decompressed, err := io.ReadAll(r)
		r.Close()
		if err == nil {
			jsonData = decompressed
		} else {
			jsonData = data
		}
	} else {
		jsonData = data
	}

	var payload HybridPayload
	if err := json.Unmarshal(jsonData, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal payload: %w", err)
	}

	return &payload, nil
}

// LinkOptions 链接生成选项
type LinkOptions struct {
	Scheme         string
	MaxSourceURLs  int
	Compact        bool
	GatewayDomain  string
	UseGateway     bool
}

// DefaultLinkOptions 默认选项
var DefaultLinkOptions = LinkOptions{
	Scheme:        "hybrid",
	MaxSourceURLs: 5,
	Compact:       false,
	GatewayDomain: "orig-hub.com",
	UseGateway:    false,
}

// GenerateHybridLink 生成 hybrid/origlink 链接
func GenerateHybridLink(payload *HybridPayload, sourceURLs []string) (string, error) {
	return GenerateHybridLinkWithOptions(payload, sourceURLs, DefaultLinkOptions)
}

// GenerateHybridLinkWithOptions 带选项生成链接
func GenerateHybridLinkWithOptions(payload *HybridPayload, sourceURLs []string, opts LinkOptions) (string, error) {
	var params []string

	if opts.Scheme == "" {
		opts.Scheme = DefaultLinkOptions.Scheme
	}
	if opts.GatewayDomain == "" {
		opts.GatewayDomain = DefaultLinkOptions.GatewayDomain
	}

	if payload != nil {
		encodedPayload, err := encodePayload(payload)
		if err != nil {
			return "", err
		}
		params = append(params, fmt.Sprintf("d=%s", encodedPayload))
	}

	if !opts.Compact {
		maxSources := len(sourceURLs)
		if opts.MaxSourceURLs > 0 && opts.MaxSourceURLs < maxSources {
			maxSources = opts.MaxSourceURLs
		}
		for i := 0; i < maxSources; i++ {
			if sourceURLs[i] != "" {
				params = append(params, fmt.Sprintf("http=%s", url.QueryEscape(sourceURLs[i])))
			}
		}
	}

	if len(params) == 0 {
		return "", fmt.Errorf("no parameters in link")
	}

	if opts.UseGateway {
		return fmt.Sprintf("https://%s/dl?%s", opts.GatewayDomain, strings.Join(params, "&")), nil
	}

	return fmt.Sprintf("%s:?%s", opts.Scheme, strings.Join(params, "&")), nil
}

func GenerateGatewayLink(payload *HybridPayload, sourceURLs []string) (string, error) {
	opts := DefaultLinkOptions
	opts.UseGateway = true
	return GenerateHybridLinkWithOptions(payload, sourceURLs, opts)
}

func GenerateGatewayLinkWithDomain(payload *HybridPayload, sourceURLs []string, domain string) (string, error) {
	opts := DefaultLinkOptions
	opts.UseGateway = true
	opts.GatewayDomain = domain
	return GenerateHybridLinkWithOptions(payload, sourceURLs, opts)
}

func GenerateShareLinks(payload *HybridPayload, sourceURLs []string, domain string) (string, string, error) {
	protocolLink, err := GenerateHybridLink(payload, sourceURLs)
	if err != nil {
		return "", "", err
	}
	gatewayLink, err := GenerateGatewayLinkWithDomain(payload, sourceURLs, domain)
	if err != nil {
		return protocolLink, "", err
	}
	return protocolLink, gatewayLink, nil
}

func ParseGatewayLink(link string) (*HybridPayload, []string, error) {
	u, err := url.Parse(link)
	if err != nil {
		return nil, nil, err
	}
	if !strings.HasPrefix(u.Path, "/dl") {
		return nil, nil, fmt.Errorf("not a gateway link")
	}
	params := u.Query()
	var payload *HybridPayload
	var sources []string
	if encodedData := params.Get("d"); encodedData != "" {
		payload, err = decodePayload(encodedData)
		if err != nil {
			return nil, nil, err
		}
	}
	for _, httpURL := range params["http"] {
		if httpURL != "" {
			sources = append(sources, httpURL)
		}
	}
	return payload, sources, nil
}

func ParseHybridProtocolLink(link string) (*HybridPayload, []string, error) {
	var queryString string
	switch {
	case strings.HasPrefix(link, "hybrid:?"):
		queryString = strings.TrimPrefix(link, "hybrid:?")
	default:
		return nil, nil, fmt.Errorf("not a hybrid protocol link")
	}
	params, err := url.ParseQuery(queryString)
	if err != nil {
		return nil, nil, err
	}
	var payload *HybridPayload
	var sources []string
	if dValue := params.Get("d"); dValue != "" {
		payload, err = decodePayload(dValue)
		if err != nil {
			return nil, nil, err
		}
	}
	if xtValue := params.Get("xt"); xtValue != "" {
		payload, err = decodePayload(xtValue)
		if err != nil {
			return nil, nil, err
		}
	}
	for _, httpURL := range params["http"] {
		if httpURL != "" {
			sources = append(sources, httpURL)
		}
	}
	return payload, sources, nil
}

// GenerateHybridLinkFromFile 从已下载文件和源 URL 生成共享链接
func GenerateHybridLinkFromFile(filePath string, sourceURLs []string) (string, error) {
	return GenerateHybridLinkFromFileWithOptions(filePath, sourceURLs, DefaultLinkOptions)
}

// GenerateHybridLinkFromFileWithOptions 带选项从已下载文件生成共享链接
func GenerateHybridLinkFromFileWithOptions(filePath string, sourceURLs []string, opts LinkOptions) (string, error) {
	fileHash, err := ComputeFileHash(filePath)
	if err != nil {
		return "", fmt.Errorf("compute file hash: %w", err)
	}

	fileInfo, err := os.Stat(filePath)
	if err != nil {
		return "", fmt.Errorf("stat file: %w", err)
	}

	var sourceMetas []SourceMeta
	if opts.Compact {
		for _, srcURL := range sourceURLs {
			sourceMetas = append(sourceMetas, SourceMeta{
				Type: "http",
				URL:  srcURL,
			})
		}
	} else {
		maxInPayload := len(sourceURLs)
		if opts.MaxSourceURLs > 0 && opts.MaxSourceURLs < maxInPayload {
			maxInPayload = opts.MaxSourceURLs
		}
		for i := 0; i < maxInPayload; i++ {
			sourceMetas = append(sourceMetas, SourceMeta{
				Type: "http",
				URL:  sourceURLs[i],
			})
		}
	}

	payload := &HybridPayload{
		Version:     1,
		Hash:        fileHash,
		HashType:    "sha256",
		FileSize:    fileInfo.Size(),
		MultiSource: sourceMetas,
	}

	return GenerateHybridLinkWithOptions(payload, sourceURLs, opts)
}

func (p *HybridProtocol) parseHybridURL(rawURL string) ([]Source, error) {
	sources := []Source{}

	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, fmt.Errorf("empty URL")
	}

	var params url.Values
	var err error

	switch {
	case strings.HasPrefix(rawURL, "hybrid:?"):
		params, err = url.ParseQuery(strings.TrimPrefix(rawURL, "hybrid:?"))
	case strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://"):
		u, parseErr := url.Parse(rawURL)
		if parseErr != nil {
			return nil, parseErr
		}
		params = u.Query()
	default:
		return nil, fmt.Errorf("invalid URL format")
	}

	if err != nil {
		return nil, fmt.Errorf("parse query: %w", err)
	}

	if dValue := params.Get("d"); dValue != "" {
		payload, err := decodePayload(dValue)
		if err == nil && payload != nil && len(payload.MultiSource) > 0 {
			for _, srcMeta := range payload.MultiSource {
				if srcMeta.Type == "http" && srcMeta.URL != "" {
					sources = append(sources, &HTTPSource{URL: srcMeta.URL})
				}
			}
		}
	}

	if xtValue := params.Get("xt"); xtValue != "" {
		payload, err := decodePayload(xtValue)
		if err == nil && payload != nil && len(payload.MultiSource) > 0 {
			for _, srcMeta := range payload.MultiSource {
				if srcMeta.Type == "http" && srcMeta.URL != "" {
					sources = append(sources, &HTTPSource{URL: srcMeta.URL})
				}
			}
		}
	}

	httpURLs := params["http"]
	for _, httpURL := range httpURLs {
		if httpURL != "" {
			sources = append(sources, &HTTPSource{URL: httpURL})
		}
	}

	if btHash := params.Get("bt"); btHash != "" {
		sources = append(sources, &BTSource{InfoHash: btHash})
	}
	if ipfsCID := params.Get("ipfs"); ipfsCID != "" {
		sources = append(sources, &IPFSSource{CID: ipfsCID})
	}

	if len(sources) == 0 {
		return nil, fmt.Errorf("no sources found in URL")
	}

	return sources, nil
}

type HybridDownloader struct {
	cfg        *protocol.DownloadConfig
	sources    []Source
	discovery  *SourceDiscovery
	scheduler  *BlockScheduler
	pieceMgr   *PieceManager
	registry   *protocol.ProtocolRegistry

	state      protocol.DownloadState
	stateMu    sync.RWMutex
	progress   protocol.Progress
	progressMu sync.RWMutex
	cancel     context.CancelFunc
	done       chan struct{}
	started    atomic.Bool
}

func (d *HybridDownloader) Download(ctx context.Context) error {
	if d.started.Swap(true) {
		return fmt.Errorf("download already started")
	}

	d.setState(protocol.DownloadStateDownloading)
	downloadCtx, cancel := context.WithCancel(ctx)
	d.cancel = cancel
	d.done = make(chan struct{})

	defer close(d.done)

	if err := d.discoverSources(downloadCtx); err != nil {
		d.setState(protocol.DownloadStateError)
		return fmt.Errorf("discover sources: %w", err)
	}

	meta, err := d.getPrimaryMetadata(downloadCtx)
	if err != nil {
		d.setState(protocol.DownloadStateError)
		return fmt.Errorf("get metadata: %w", err)
	}

	if err := d.pieceMgr.Init(meta.FileSize, meta.PieceSize); err != nil {
		d.setState(protocol.DownloadStateError)
		return fmt.Errorf("init piece manager: %w", err)
	}

	d.startSourceWorkers(downloadCtx, meta)

	err = d.waitForCompletion(downloadCtx, meta.FileSize)
	if err != nil {
		d.setState(protocol.DownloadStateError)
		return err
	}

	d.setState(protocol.DownloadStateCompleted)
	return nil
}

func (d *HybridDownloader) getPrimaryMetadata(ctx context.Context) (*FileMetadata, error) {
	primary := d.sources[0]
	return primary.GetMetadata(ctx)
}

func (d *HybridDownloader) discoverSources(ctx context.Context) error {
	for _, src := range d.sources {
		if err := src.Open(ctx); err != nil {
			return fmt.Errorf("open source %s: %w", src.Name(), err)
		}
	}
	if len(d.sources) == 0 {
		return fmt.Errorf("no sources available")
	}
	return nil
}

func (d *HybridDownloader) startSourceWorkers(ctx context.Context, meta *FileMetadata) {
	for _, src := range d.sources {
		go d.downloadFromSource(ctx, src, meta)
	}
}

func (d *HybridDownloader) downloadFromSource(ctx context.Context, src Source, meta *FileMetadata) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			piece := d.scheduler.Allocate(src.Name(), src.Capabilities())
			if piece == nil {
				if d.pieceMgr.IsComplete() {
					return
				}
				continue
			}

			data, err := src.FetchPiece(ctx, *piece)
			if err != nil {
				d.scheduler.MarkFailed(piece.Index, src.Name())
				continue
			}

			if err := d.pieceMgr.SubmitPiece(piece.Index, data); err != nil {
				d.scheduler.MarkFailed(piece.Index, src.Name())
				continue
			}

			d.scheduler.MarkComplete(piece.Index)
			d.updateProgress(meta.FileSize)
		}
	}
}

func (d *HybridDownloader) waitForCompletion(ctx context.Context, totalSize int64) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if d.pieceMgr.IsComplete() {
				data, err := d.pieceMgr.Assemble()
				if err != nil {
					return err
				}

				filename := d.cfg.Filename
				if filename == "" {
					filename = "downloaded_file"
				}

				return writeFileAtomic(d.cfg.OutputPath, filename, data)
			}
		}
	}
}

func (d *HybridDownloader) updateProgress(totalSize int64) {
	d.progressMu.Lock()
	progress := d.pieceMgr.GetProgress()
	d.progress.TotalSize = totalSize
	d.progress.Downloaded = int64(progress.Current) * int64(progress.Total)
	if d.progress.TotalSize > 0 {
		d.progress.Connections = 1
	}
	d.progressMu.Unlock()

	if d.cfg.ProgressCh != nil {
		select {
		case d.cfg.ProgressCh <- d.progress:
		default:
		}
	}
}

func (d *HybridDownloader) setState(state protocol.DownloadState) {
	d.stateMu.Lock()
	d.state = state
	d.stateMu.Unlock()
}

func (d *HybridDownloader) State() protocol.DownloadState {
	d.stateMu.RLock()
	defer d.stateMu.RUnlock()
	return d.state
}

func (d *HybridDownloader) Progress() *protocol.Progress {
	d.progressMu.Lock()
	defer d.progressMu.Unlock()
	p := d.progress
	return &p
}

func (d *HybridDownloader) Pause() error {
	return fmt.Errorf("hybrid download does not support pause")
}

func (d *HybridDownloader) Resume(ctx context.Context) error {
	return fmt.Errorf("hybrid download does not support resume")
}

func (d *HybridDownloader) Cancel() error {
	if d.cancel != nil {
		d.cancel()
	}
	d.setState(protocol.DownloadStateCancelled)
	return nil
}
