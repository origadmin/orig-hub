package http

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
)

const maxRetries = 3

type HTTPDownloader struct {
	cfg        *protocol.DownloadConfig
	runtime    *types.RuntimeConfig
	state      protocol.DownloadState
	stateMu    sync.Mutex
	progress   protocol.Progress
	progressMu sync.Mutex
	cancelFunc atomic.Pointer[context.CancelFunc]
	done       atomic.Bool
	err        atomic.Pointer[error]
}

func NewDownloader(cfg *protocol.DownloadConfig, runtime *types.RuntimeConfig) *HTTPDownloader {
	if runtime == nil {
		runtime = &types.RuntimeConfig{}
	}
	return &HTTPDownloader{
		cfg:     cfg,
		runtime: runtime,
		state:   protocol.DownloadStateQueued,
		progress: protocol.Progress{
			TotalSize: cfg.TotalSize,
		},
	}
}

func (d *HTTPDownloader) Download(ctx context.Context) error {
	d.setState(protocol.DownloadStateDownloading)

	downloadCtx, cancel := context.WithCancel(ctx)
	d.cancelFunc.Store(&cancel)
	defer cancel()

	outputPath := d.cfg.OutputPath
	if outputPath == "" {
		return fmt.Errorf("output path is required")
	}

	filename := d.cfg.Filename
	if filename == "" {
		filename = "download"
	}

	destPath := filepath.Join(outputPath, filename)
	workingPath := destPath + types.IncompleteSuffix

	totalSize := d.cfg.TotalSize
	supportsRange := d.cfg.SupportsRange

	if totalSize <= 0 || !supportsRange {
		parsedURL, err := parseURLSimple(d.cfg.URL)
		if err == nil {
			meta, err := Probe(downloadCtx, parsedURL, d.runtime)
			if err == nil {
				if totalSize <= 0 {
					totalSize = meta.Size
				}
				if !supportsRange {
					supportsRange = meta.AcceptRanges
				}
				if filename == "download" && meta.Name != "" {
					filename = meta.Name
					destPath = filepath.Join(outputPath, filename)
					workingPath = destPath + types.IncompleteSuffix
				}
			}
		}
	}

	if err := os.MkdirAll(outputPath, 0755); err != nil {
		d.setError(fmt.Errorf("failed to create output directory: %w", err))
		d.setState(protocol.DownloadStateError)
		return err
	}

	outFile, err := os.Create(workingPath)
	if err != nil {
		d.setError(fmt.Errorf("failed to create file: %w", err))
		d.setState(protocol.DownloadStateError)
		return err
	}
	defer func() { _ = outFile.Close() }()

	if totalSize > 0 {
		_ = outFile.Truncate(totalSize)
	}

	var downloadErr error
	if supportsRange && totalSize > 0 && totalSize > types.MinChunk {
		downloadErr = d.concurrentDownload(downloadCtx, outFile, totalSize)
	} else {
		downloadErr = d.sequentialDownload(downloadCtx, outFile)
	}

	if d.isPaused() {
		d.setState(protocol.DownloadStatePaused)
		return types.ErrPaused
	}

	if downloadCtx.Err() == context.Canceled {
		d.setState(protocol.DownloadStateCancelled)
		return context.Canceled
	}

	if downloadErr != nil {
		d.setError(downloadErr)
		d.setState(protocol.DownloadStateError)
		return downloadErr
	}

	if err := outFile.Sync(); err != nil {
		return fmt.Errorf("failed to sync file: %w", err)
	}
	_ = outFile.Close()

	if err := os.Rename(workingPath, destPath); err != nil {
		return fmt.Errorf("failed to rename file: %w", err)
	}

	d.done.Store(true)
	d.setState(protocol.DownloadStateCompleted)
	return nil
}

func (d *HTTPDownloader) Pause() error {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	if d.state == protocol.DownloadStateDownloading {
		d.state = protocol.DownloadStatePausing
		if cf := d.cancelFunc.Load(); cf != nil {
			(*cf)()
		}
	}
	return nil
}

func (d *HTTPDownloader) Resume(ctx context.Context) error {
	d.stateMu.Lock()
	d.state = protocol.DownloadStateQueued
	d.stateMu.Unlock()
	return d.Download(ctx)
}

func (d *HTTPDownloader) Progress() *protocol.Progress {
	d.progressMu.Lock()
	defer d.progressMu.Unlock()
	p := d.progress
	return &p
}

func (d *HTTPDownloader) State() protocol.DownloadState {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.state
}

func (d *HTTPDownloader) Cancel() error {
	d.stateMu.Lock()
	d.state = protocol.DownloadStateCancelled
	d.stateMu.Unlock()
	if cf := d.cancelFunc.Load(); cf != nil {
		(*cf)()
	}
	return nil
}

func (d *HTTPDownloader) setState(s protocol.DownloadState) {
	d.stateMu.Lock()
	d.state = s
	d.stateMu.Unlock()
}

func (d *HTTPDownloader) isPaused() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.state == protocol.DownloadStatePaused || d.state == protocol.DownloadStatePausing
}

func (d *HTTPDownloader) setError(err error) {
	d.err.Store(&err)
}

func (d *HTTPDownloader) updateProgress(downloaded, total int64, speed float64) {
	d.progressMu.Lock()
	d.progress.Downloaded = downloaded
	d.progress.TotalSize = total
	d.progress.Speed = speed
	if total > 0 {
		d.progress.Connections = int(math.Round(float64(downloaded)/float64(types.MinChunk))) + 1
	}
	d.progressMu.Unlock()

	if d.cfg.ProgressCh != nil {
		select {
		case d.cfg.ProgressCh <- d.progress:
		default:
		}
	}
}

func (d *HTTPDownloader) makeHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 0,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return types.ErrMaxRedirects
			}
			if len(via) > 0 {
				for key, val := range d.cfg.Headers {
					if key != "Range" {
						req.Header.Set(key, val)
					}
				}
			}
			return nil
		},
		Transport: &http.Transport{
			MaxIdleConns:        10,
			MaxIdleConnsPerHost: 10,
			IdleConnTimeout:     90 * time.Second,
			DisableCompression:  true,
		},
	}
}

func (d *HTTPDownloader) concurrentDownload(ctx context.Context, file *os.File, totalSize int64) error {
	maxConns := d.cfg.MaxConns
	if maxConns <= 0 {
		maxConns = d.runtime.GetMaxConnectionsPerHost()
	}

	sizeMB := float64(totalSize) / float64(types.MB)
	numConns := int(math.Round(math.Sqrt(sizeMB)))
	minChunk := d.runtime.GetMinChunkSize()
	if minChunk > 0 {
		maxPossible := int(totalSize / minChunk)
		if maxPossible < 1 {
			maxPossible = 1
		}
		if numConns > maxPossible {
			numConns = maxPossible
		}
	}
	if numConns < 1 {
		numConns = 1
	}
	if numConns > maxConns {
		numConns = maxConns
	}

	chunkSize := totalSize / int64(numConns)
	if chunkSize < minChunk {
		chunkSize = minChunk
	}
	chunkSize = (chunkSize / types.AlignSize) * types.AlignSize
	if chunkSize == 0 {
		chunkSize = types.AlignSize
	}

	type chunkTask struct {
		offset, length int64
	}
	var tasks []chunkTask
	for offset := int64(0); offset < totalSize; offset += chunkSize {
		length := chunkSize
		if offset+length > totalSize {
			length = totalSize - offset
		}
		tasks = append(tasks, chunkTask{offset, length})
	}

	var downloaded atomic.Int64
	var wg sync.WaitGroup
	errCh := make(chan error, numConns)
	sem := make(chan struct{}, numConns)

	startTime := time.Now()

	for _, task := range tasks {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(t chunkTask) {
			defer wg.Done()
			defer func() { <-sem }()

			var chunkErr error
			for attempt := 0; attempt < maxRetries; attempt++ {
				if attempt > 0 {
					select {
					case <-ctx.Done():
						errCh <- ctx.Err()
						return
					case <-time.After(time.Duration(attempt) * time.Second):
					}
				}

				chunkErr = d.downloadChunk(ctx, file, t.offset, t.length, totalSize)
				if chunkErr == nil {
					break
				}
				if ctx.Err() != nil {
					errCh <- ctx.Err()
					return
				}
			}

			if chunkErr != nil {
				errCh <- chunkErr
				return
			}

			newDownloaded := downloaded.Add(t.length)
			elapsed := time.Since(startTime).Seconds()
			var speed float64
			if elapsed > 0 {
				speed = float64(newDownloaded) / elapsed
			}
			d.updateProgress(newDownloaded, totalSize, speed)
		}(task)
	}

	wg.Wait()
	close(errCh)

	for err := range errCh {
		if err != nil && ctx.Err() == nil {
			return err
		}
	}

	return nil
}

func (d *HTTPDownloader) downloadChunk(ctx context.Context, file *os.File, offset, length, totalSize int64) error {
	client := d.makeHTTPClient()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.cfg.URL, nil)
	if err != nil {
		return err
	}

	req.Header.Set("User-Agent", d.runtime.GetUserAgent())
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+length-1))
	req.Header.Set("Connection", "keep-alive")

	for key, val := range d.cfg.Headers {
		if key != "Range" {
			req.Header.Set(key, val)
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("rate limited (429)")
	}

	if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	buf := make([]byte, d.runtime.GetWorkerBufferSize())
	currentOffset := offset

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}

			writeN, writeErr := file.WriteAt(buf[:n], currentOffset)
			if writeErr != nil {
				return fmt.Errorf("write error: %w", writeErr)
			}
			currentOffset += int64(writeN)
		}

		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return fmt.Errorf("read error: %w", readErr)
		}
	}

	return nil
}

func (d *HTTPDownloader) sequentialDownload(ctx context.Context, file *os.File) error {
	client := d.makeHTTPClient()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.cfg.URL, nil)
	if err != nil {
		return err
	}

	req.Header.Set("User-Agent", d.runtime.GetUserAgent())
	req.Header.Set("Connection", "keep-alive")
	for key, val := range d.cfg.Headers {
		req.Header.Set(key, val)
	}

	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt) * time.Second):
			}
		}

		lastErr = d.doSequentialRequest(ctx, client, req, file)
		if lastErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}

	return lastErr
}

func (d *HTTPDownloader) doSequentialRequest(ctx context.Context, client *http.Client, origReq *http.Request, file *os.File) error {
	req := origReq.Clone(ctx)

	currentProgress := d.Progress()
	resumeOffset := currentProgress.Downloaded
	if resumeOffset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", resumeOffset))
	}

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusTooManyRequests {
		return fmt.Errorf("rate limited (429)")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && resumeOffset > 0 {
			return nil
		}
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	buf := make([]byte, d.runtime.GetWorkerBufferSize())
	var downloaded int64 = resumeOffset
	startTime := time.Now()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			writeN, writeErr := file.WriteAt(buf[:n], downloaded)
			if writeErr != nil {
				return fmt.Errorf("write error: %w", writeErr)
			}
			downloaded += int64(writeN)

			elapsed := time.Since(startTime).Seconds()
			var speed float64
			if elapsed > 0 {
				speed = float64(downloaded-resumeOffset) / elapsed
			}
			d.updateProgress(downloaded, d.progress.TotalSize, speed)
		}

		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return fmt.Errorf("read error: %w", readErr)
		}
	}

	return nil
}

func parseURLSimple(raw string) (*protocol.ParsedURL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
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
