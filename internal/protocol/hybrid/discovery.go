package hybrid

import (
	"context"
	"sync"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

type SourceDiscovery struct {
	cfg           *types.RuntimeConfig
	localTracker  *LocalTracker
	mu            sync.RWMutex
	searchers     []Searcher
}

func NewSourceDiscovery(cfg *types.RuntimeConfig) *SourceDiscovery {
	d := &SourceDiscovery{
		cfg:          cfg,
		localTracker: NewLocalTracker(),
	}

	d.searchers = []Searcher{
		NewLocalTrackerSearcher(d.localTracker),
		NewBTSearcher(),
	}

	return d
}

func (d *SourceDiscovery) Discover(ctx context.Context, source Source) ([]Source, error) {
	discovered := []Source{}

	meta, err := source.GetMetadata(ctx)
	if err != nil {
		return nil, err
	}

	for _, searcher := range d.searchers {
		select {
		case <-ctx.Done():
			return discovered, nil
		default:
		}

		matches, err := searcher.Search(ctx, meta)
		if err != nil {
			continue
		}

		for _, m := range matches {
			if verifyMatch(meta, m) {
				discovered = append(discovered, m)
			}
		}
	}

	return discovered, nil
}

func verifyMatch(original *FileMetadata, found Source) bool {
	foundMeta, err := found.GetMetadata(context.Background())
	if err != nil {
		return false
	}

	return foundMeta.FileSize == original.FileSize
}

type Source interface {
	Name() string
	Open(ctx context.Context) error
	Close() error
	GetMetadata(ctx context.Context) (*FileMetadata, error)
	GetPieces() ([]Piece, error)
	FetchPiece(ctx context.Context, piece Piece) ([]byte, error)
	Capabilities() SourceCapability
}

type SourceCapability struct {
	Protocol        string
	MaxSpeed        int64
	Reliability     float64
	Latency         time.Duration
	AvailablePieces []int
	Active          bool
}

type FileMetadata struct {
	Filename   string
	FileSize   int64
	PieceSize  int64
	PieceCount int
	Hash       string
}

type Piece struct {
	Index  int
	Offset int64
	Size   int64
	Hash   []byte
}

type LocalTracker struct {
	mu    sync.RWMutex
	files map[string]*TrackedFile
}

type TrackedFile struct {
	Filename   string
	FileSize   int64
	InfoHash   string
	IPFSCID    string
	HTTPURL    string
	Downloaded time.Time
	PeerCount  int
}

func NewLocalTracker() *LocalTracker {
	return &LocalTracker{
		files: make(map[string]*TrackedFile),
	}
}

func (t *LocalTracker) Register(meta *FileMetadata) {
	t.mu.Lock()
	defer t.mu.Unlock()

	key := meta.Hash
	if key == "" {
		key = meta.Filename
	}

	t.files[key] = &TrackedFile{
		Filename:   meta.Filename,
		FileSize:   meta.FileSize,
		Downloaded: time.Now(),
	}
}

func (t *LocalTracker) FindBySize(size int64) []*TrackedFile {
	t.mu.RLock()
	defer t.mu.RUnlock()

	var results []*TrackedFile
	for _, f := range t.files {
		if f.FileSize == size {
			results = append(results, f)
		}
	}
	return results
}

func (t *LocalTracker) FindByFilename(name string) []*TrackedFile {
	t.mu.RLock()
	defer t.mu.RUnlock()

	var results []*TrackedFile
	for _, f := range t.files {
		if f.Filename == name {
			results = append(results, f)
		}
	}
	return results
}

type Searcher interface {
	Search(ctx context.Context, meta *FileMetadata) ([]Source, error)
	Name() string
}

type LocalTrackerSearcher struct {
	tracker *LocalTracker
}

func NewLocalTrackerSearcher(tracker *LocalTracker) *LocalTrackerSearcher {
	return &LocalTrackerSearcher{tracker: tracker}
}

func (s *LocalTrackerSearcher) Name() string {
	return "local"
}

func (s *LocalTrackerSearcher) Search(ctx context.Context, meta *FileMetadata) ([]Source, error) {
	matches := s.tracker.FindByFilename(meta.Filename)

	var sources []Source
	for _, m := range matches {
		if m.HTTPURL != "" {
			sources = append(sources, &HTTPSource{URL: m.HTTPURL})
		}
		if m.InfoHash != "" {
			sources = append(sources, &BTSource{InfoHash: m.InfoHash})
		}
		if m.IPFSCID != "" {
			sources = append(sources, &IPFSSource{CID: m.IPFSCID})
		}
	}

	return sources, nil
}

type BTSearcher struct{}

func NewBTSearcher() *BTSearcher {
	return &BTSearcher{}
}

func (s *BTSearcher) Name() string {
	return "bt"
}

func (s *BTSearcher) Search(ctx context.Context, meta *FileMetadata) ([]Source, error) {
	return []Source{}, nil
}
