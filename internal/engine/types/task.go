package types

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

type Task struct {
	Offset          int64         `json:"offset"`
	Length          int64         `json:"length"`
	SharedMaxOffset *atomic.Int64 `json:"-"`
}

type ActiveTask struct {
	Task            Task
	StartTime       time.Time
	Cancel          context.CancelFunc
	CurrentOffset   atomic.Int64
	StopAt          atomic.Int64
	LastActivity    atomic.Int64
	WindowStart     time.Time
	WindowBytes     atomic.Int64
	Speed           float64
	SpeedMu         sync.Mutex
	Hedged          atomic.Int32
	SharedMaxOffset *atomic.Int64
}

func (a *ActiveTask) RemainingBytes() int64 {
	stopAt := a.StopAt.Load()
	current := a.CurrentOffset.Load()
	remaining := stopAt - current
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (a *ActiveTask) RemainingTask() *Task {
	remaining := a.RemainingBytes()
	if remaining <= 0 {
		return nil
	}
	return &Task{
		Offset:          a.CurrentOffset.Load(),
		Length:          remaining,
		SharedMaxOffset: a.SharedMaxOffset,
	}
}
