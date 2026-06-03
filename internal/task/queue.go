package task

import (
	"container/heap"
	"fmt"
	"sync"
)

type taskHeapItem struct {
	task  *Task
	index int
}

type taskQueue struct {
	mu      sync.Mutex
	items   map[string]*taskHeapItem
	heap    []taskHeapItem
	handler TaskEventHandler
}

func NewQueue() Queue {
	q := &taskQueue{
		items: make(map[string]*taskHeapItem),
	}
	heap.Init(q)
	return q
}

func (q *taskQueue) Enqueue(t *Task) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if t.ID == "" {
		t.ID = fmt.Sprintf("task-%d", len(q.items))
	}

	if _, exists := q.items[t.ID]; exists {
		return fmt.Errorf("task %s already exists", t.ID)
	}

	item := &taskHeapItem{task: t}
	q.items[t.ID] = item
	heap.Push(q, item)

	if q.handler != nil {
		q.handler.OnTaskAdded(t)
	}

	return nil
}

func (q *taskQueue) Dequeue() (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.heap) == 0 {
		return nil, fmt.Errorf("queue is empty")
	}

	item := heap.Pop(q).(*taskHeapItem)
	delete(q.items, item.task.ID)

	if q.handler != nil {
		q.handler.OnTaskScheduled(item.task)
	}

	return item.task, nil
}

func (q *taskQueue) Peek() (*Task, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.heap) == 0 {
		return nil, fmt.Errorf("queue is empty")
	}

	return q.heap[0].task, nil
}

func (q *taskQueue) Remove(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	item, exists := q.items[id]
	if !exists {
		return fmt.Errorf("task %s not found", id)
	}

	heap.Remove(q, item.index)
	delete(q.items, id)

	if q.handler != nil {
		q.handler.OnTaskRemoved(id)
	}

	return nil
}

func (q *taskQueue) UpdatePriority(id string, priority Priority) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	item, exists := q.items[id]
	if !exists {
		return fmt.Errorf("task %s not found", id)
	}

	item.task.Priority = priority
	heap.Fix(q, item.index)

	return nil
}

func (q *taskQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

func (q *taskQueue) Less(i, j int) bool {
	return q.heap[i].task.Priority > q.heap[j].task.Priority
}

func (q *taskQueue) Swap(i, j int) {
	q.heap[i], q.heap[j] = q.heap[j], q.heap[i]
	q.heap[i].index = i
	q.heap[j].index = j
}

func (q *taskQueue) Push(x interface{}) {
	item := x.(*taskHeapItem)
	item.index = len(q.heap)
	q.heap = append(q.heap, *item)
}

func (q *taskQueue) Pop() interface{} {
	old := q.heap
	n := len(old)
	item := old[n-1]
	q.heap = old[0 : n-1]
	return item
}
