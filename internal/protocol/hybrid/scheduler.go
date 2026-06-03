package hybrid

import (
	"sync"
	"time"
)

type BlockScheduler struct {
	mu           sync.RWMutex
	pieces       map[int]*PieceState
	totalPieces  int
	pieceSize    int64
	totalSize    int64
	allocations  map[int]string
	failedCount  map[string]int
}

type PieceState struct {
	Index      int
	Downloaded bool
	Failed     bool
	AssignedTo string
}

func NewBlockScheduler() *BlockScheduler {
	return &BlockScheduler{
		pieces:      make(map[int]*PieceState),
		allocations: make(map[int]string),
		failedCount: make(map[string]int),
	}
}

func (s *BlockScheduler) Init(totalPieces int, pieceSize, totalSize int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.totalPieces = totalPieces
	s.pieceSize = pieceSize
	s.totalSize = totalSize
	s.pieces = make(map[int]*PieceState)
	s.allocations = make(map[int]string)

	for i := 0; i < totalPieces; i++ {
		s.pieces[i] = &PieceState{Index: i}
	}
}

func (s *BlockScheduler) Allocate(sourceName string, cap SourceCapability) *Piece {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.failedCount[sourceName] > 10 {
		return nil
	}

	for i, state := range s.pieces {
		if !state.Downloaded && !state.Failed && state.AssignedTo == "" {
			offset := int64(i) * s.pieceSize
			size := s.pieceSize
			if offset+size > s.totalSize {
				size = s.totalSize - offset
			}
			state.AssignedTo = sourceName
			s.allocations[i] = sourceName
			return &Piece{Index: i, Offset: offset, Size: size}
		}
	}

	return nil
}

func (s *BlockScheduler) MarkComplete(pieceIndex int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if state, ok := s.pieces[pieceIndex]; ok {
		state.Downloaded = true
		state.AssignedTo = ""
	}
}

func (s *BlockScheduler) MarkFailed(pieceIndex int, sourceName string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if state, ok := s.pieces[pieceIndex]; ok {
		state.Failed = true
		state.AssignedTo = ""
	}
	s.failedCount[sourceName]++
}

func (s *BlockScheduler) GetProgress() (completed, total int) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, state := range s.pieces {
		total++
		if state.Downloaded {
			completed++
		}
	}
	return
}

func (s *BlockScheduler) IsComplete() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, state := range s.pieces {
		if !state.Downloaded {
			return false
		}
	}
	return true
}

type SourceStats struct {
	Name            string
	TotalPieces     int
	CompletedPieces int
	FailedPieces    int
	AvgSpeed        int64
	LastActivity    time.Time
}
