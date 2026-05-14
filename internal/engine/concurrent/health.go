package concurrent

import (
	"context"
	"sync"
	"time"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

type HealthMonitor struct {
	activeTasks map[int]*types.ActiveTask
	mu          sync.Mutex
	runtime     *types.RuntimeConfig
}

func NewHealthMonitor(runtime *types.RuntimeConfig) *HealthMonitor {
	if runtime == nil {
		runtime = &types.RuntimeConfig{}
	}
	return &HealthMonitor{
		activeTasks: make(map[int]*types.ActiveTask),
		runtime:     runtime,
	}
}

func (h *HealthMonitor) Register(workerID int, task *types.ActiveTask) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.activeTasks[workerID] = task
}

func (h *HealthMonitor) Unregister(workerID int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.activeTasks, workerID)
}

func (h *HealthMonitor) Check() []int {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	var slowWorkers []int

	var totalSpeed float64
	var speedCount int
	for _, task := range h.activeTasks {
		task.SpeedMu.Lock()
		if task.Speed > 0 {
			totalSpeed += task.Speed
			speedCount++
		}
		task.SpeedMu.Unlock()
	}

	var meanSpeed float64
	if speedCount > 0 {
		meanSpeed = totalSpeed / float64(speedCount)
	}

	threshold := h.runtime.GetSlowWorkerThreshold()
	gracePeriod := h.runtime.GetSlowWorkerGracePeriod()
	stallTimeout := h.runtime.GetStallTimeout()

	for id, task := range h.activeTasks {
		elapsed := now.Sub(task.StartTime)
		if elapsed < gracePeriod {
			continue
		}

		lastActivity := time.Unix(0, task.LastActivity.Load())
		if now.Sub(lastActivity) > stallTimeout {
			slowWorkers = append(slowWorkers, id)
			if task.Cancel != nil {
				task.Cancel()
			}
			continue
		}

		task.SpeedMu.Lock()
		speed := task.Speed
		task.SpeedMu.Unlock()

		if meanSpeed > 0 && speed > 0 && speed < threshold*meanSpeed {
			slowWorkers = append(slowWorkers, id)
			if task.Cancel != nil {
				task.Cancel()
			}
		}
	}

	return slowWorkers
}

func (h *HealthMonitor) Run(ctx context.Context) {
	ticker := time.NewTicker(types.HealthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.Check()
		}
	}
}
