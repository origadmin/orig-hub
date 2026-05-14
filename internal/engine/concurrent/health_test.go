package concurrent

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

func TestNewHealthMonitor(t *testing.T) {
	hm := NewHealthMonitor(nil)
	if hm == nil {
		t.Fatal("expected non-nil health monitor")
	}
}

func TestRegisterUnregister(t *testing.T) {
	hm := NewHealthMonitor(nil)
	task := &types.ActiveTask{
		StartTime: time.Now(),
	}
	hm.Register(1, task)
	hm.Unregister(1)
}

func TestCheckNoSlowWorkers(t *testing.T) {
	hm := NewHealthMonitor(nil)
	task := &types.ActiveTask{
		StartTime:    time.Now(),
		LastActivity: atomic.Int64{},
	}
	task.LastActivity.Store(time.Now().UnixNano())
	hm.Register(1, task)

	slow := hm.Check()
	if len(slow) != 0 {
		t.Errorf("expected no slow workers, got %d", len(slow))
	}
}

func TestCheckStalledWorker(t *testing.T) {
	hm := NewHealthMonitor(&types.RuntimeConfig{
		StallTimeout:          1 * time.Millisecond,
		SlowWorkerGracePeriod: 1 * time.Nanosecond,
	})

	task := &types.ActiveTask{
		StartTime: time.Now().Add(-1 * time.Second),
	}
	task.LastActivity.Store(time.Now().Add(-10 * time.Second).UnixNano())

	var cancelled atomic.Bool
	task.Cancel = func() { cancelled.Store(true) }

	hm.Register(1, task)
	slow := hm.Check()
	if len(slow) != 1 {
		t.Errorf("expected 1 slow worker, got %d", len(slow))
	}
	if !cancelled.Load() {
		t.Error("expected stalled worker to be cancelled")
	}
}

func TestHealthMonitorRun(t *testing.T) {
	hm := NewHealthMonitor(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	hm.Run(ctx)
}
