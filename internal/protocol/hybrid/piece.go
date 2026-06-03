package hybrid

import (
	"crypto/sha256"
	"fmt"
	"sync"
)

type PieceManager struct {
	mu          sync.RWMutex
	totalSize   int64
	pieceSize   int64
	pieceCount  int
	pieces      map[int][]byte
	pieceHashes map[int][]byte
	completed   bool
}

func NewPieceManager() *PieceManager {
	return &PieceManager{
		pieces:      make(map[int][]byte),
		pieceHashes: make(map[int][]byte),
	}
}

func (m *PieceManager) Init(totalSize int64, pieceSize int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.totalSize = totalSize
	m.pieceSize = pieceSize
	m.pieceCount = int((totalSize + pieceSize - 1) / pieceSize)

	return nil
}

func (m *PieceManager) SubmitPiece(index int, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if index < 0 || index >= m.pieceCount {
		return fmt.Errorf("invalid piece index %d", index)
	}

	if expectedHash, ok := m.pieceHashes[index]; ok {
		actualHash := sha256.Sum256(data)
		if !bytesEqual(actualHash[:], expectedHash) {
			return fmt.Errorf("piece %d hash mismatch", index)
		}
	}

	m.pieces[index] = data

	if len(m.pieces) == m.pieceCount {
		m.completed = true
	}

	return nil
}

func (m *PieceManager) SetPieceHash(index int, hash []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pieceHashes[index] = hash
}

func (m *PieceManager) IsComplete() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.completed
}

func (m *PieceManager) GetProgress() *struct {
	Total   int
	Current int
	Percent float64
} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	completed := len(m.pieces)
	percent := float64(0)
	if m.pieceCount > 0 {
		percent = float64(completed) / float64(m.pieceCount) * 100
	}

	return &struct {
		Total   int
		Current int
		Percent float64
	}{
		Total:   m.pieceCount,
		Current: completed,
		Percent: percent,
	}
}

func (m *PieceManager) Assemble() ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if !m.completed {
		return nil, fmt.Errorf("not all pieces downloaded")
	}

	result := make([]byte, 0, m.totalSize)
	for i := 0; i < m.pieceCount; i++ {
		piece, ok := m.pieces[i]
		if !ok {
			return nil, fmt.Errorf("missing piece %d", i)
		}
		result = append(result, piece...)
	}

	return result[:m.totalSize], nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
