package concurrent

import (
	"sync"
	"sync/atomic"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

type TaskQueue struct {
	tasks        []types.Task
	mu           sync.Mutex
	closed       atomic.Bool
	waitCh       chan struct{}
	idleWorkers  atomic.Int32
	totalWorkers int32
}

func NewTaskQueue() *TaskQueue {
	return &TaskQueue{
		waitCh: make(chan struct{}, 1),
	}
}

func (q *TaskQueue) Push(task types.Task) {
	q.mu.Lock()
	if q.closed.Load() {
		q.mu.Unlock()
		return
	}
	q.tasks = append(q.tasks, task)
	q.mu.Unlock()
	q.notify()
}

func (q *TaskQueue) PushMultiple(tasks []types.Task) {
	q.mu.Lock()
	if q.closed.Load() {
		q.mu.Unlock()
		return
	}
	q.tasks = append(q.tasks, tasks...)
	q.mu.Unlock()
	q.notify()
}

func (q *TaskQueue) Pop() (types.Task, bool) {
	q.idleWorkers.Add(1)
	defer q.idleWorkers.Add(-1)

	for {
		q.mu.Lock()
		if len(q.tasks) > 0 {
			task := q.tasks[0]
			q.tasks = q.tasks[1:]
			q.mu.Unlock()
			return task, true
		}
		if q.closed.Load() {
			q.mu.Unlock()
			return types.Task{}, false
		}
		q.mu.Unlock()

		<-q.waitCh
	}
}

func (q *TaskQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.tasks)
}

func (q *TaskQueue) Close() {
	q.closed.Store(true)
	q.notify()
}

func (q *TaskQueue) DrainRemaining() []types.Task {
	q.mu.Lock()
	defer q.mu.Unlock()
	tasks := q.tasks
	q.tasks = nil
	return tasks
}

func (q *TaskQueue) IdleWorkers() int32 {
	return q.idleWorkers.Load()
}

func (q *TaskQueue) SetTotalWorkers(n int32) {
	q.totalWorkers = n
}

func (q *TaskQueue) TotalWorkers() int32 {
	return q.totalWorkers
}

func (q *TaskQueue) notify() {
	select {
	case q.waitCh <- struct{}{}:
	default:
	}
}
