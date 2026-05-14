package concurrent

import (
	"sync"
	"testing"

	"github.com/origadmin/orig-hub/internal/engine/types"
)

func TestNewTaskQueue(t *testing.T) {
	q := NewTaskQueue()
	if q.Len() != 0 {
		t.Errorf("new queue should be empty, got %d", q.Len())
	}
}

func TestPushPop(t *testing.T) {
	q := NewTaskQueue()
	q.Push(types.Task{Offset: 0, Length: 100})
	q.Push(types.Task{Offset: 100, Length: 200})

	if q.Len() != 2 {
		t.Errorf("expected 2 tasks, got %d", q.Len())
	}

	task, ok := q.Pop()
	if !ok {
		t.Fatal("expected to pop a task")
	}
	if task.Offset != 0 || task.Length != 100 {
		t.Errorf("unexpected task: offset=%d, length=%d", task.Offset, task.Length)
	}

	task, ok = q.Pop()
	if !ok {
		t.Fatal("expected to pop a task")
	}
	if task.Offset != 100 || task.Length != 200 {
		t.Errorf("unexpected task: offset=%d, length=%d", task.Offset, task.Length)
	}
}

func TestPushMultiple(t *testing.T) {
	q := NewTaskQueue()
	tasks := []types.Task{
		{Offset: 0, Length: 100},
		{Offset: 100, Length: 200},
		{Offset: 300, Length: 300},
	}
	q.PushMultiple(tasks)

	if q.Len() != 3 {
		t.Errorf("expected 3 tasks, got %d", q.Len())
	}
}

func TestClose(t *testing.T) {
	q := NewTaskQueue()
	q.Close()

	_, ok := q.Pop()
	if ok {
		t.Error("expected pop to return false after close")
	}
}

func TestDrainRemaining(t *testing.T) {
	q := NewTaskQueue()
	q.Push(types.Task{Offset: 0, Length: 100})
	q.Push(types.Task{Offset: 100, Length: 200})

	remaining := q.DrainRemaining()
	if len(remaining) != 2 {
		t.Errorf("expected 2 remaining tasks, got %d", len(remaining))
	}
	if q.Len() != 0 {
		t.Errorf("queue should be empty after drain, got %d", q.Len())
	}
}

func TestIdleWorkers(t *testing.T) {
	q := NewTaskQueue()
	q.SetTotalWorkers(4)
	if q.TotalWorkers() != 4 {
		t.Errorf("expected 4 total workers, got %d", q.TotalWorkers())
	}
}

func TestPushAfterClose(t *testing.T) {
	q := NewTaskQueue()
	q.Close()
	q.Push(types.Task{Offset: 0, Length: 100})
	if q.Len() != 0 {
		t.Errorf("push after close should be ignored, got %d", q.Len())
	}
}

func TestConcurrentPushPop(t *testing.T) {
	q := NewTaskQueue()
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				offset := int64(id*10 + j)
				q.Push(types.Task{Offset: offset, Length: 100})
			}
		}(i)
	}
	wg.Wait()

	if q.Len() != 100 {
		t.Errorf("expected 100 tasks, got %d", q.Len())
	}

	count := 0
	for {
		q.Close()
		_, ok := q.Pop()
		if !ok {
			break
		}
		count++
	}

	remaining := q.DrainRemaining()
	count += len(remaining)

	if count != 100 {
		t.Errorf("expected 100 total popped tasks, got %d", count)
	}
}
