package task

type Priority int

const (
	PriorityLow    Priority = 0
	PriorityNormal Priority = 1
	PriorityHigh   Priority = 2
	PriorityHighest Priority = 3
)

type Task struct {
	ID        string
	URL       string
	OutputDir string
	Filename  string
	Mirrors   []string
	Headers   map[string]string
	Priority  Priority
}

type Queue interface {
	Enqueue(t *Task) error
	Dequeue() (*Task, error)
	Peek() (*Task, error)
	Remove(id string) error
	UpdatePriority(id string, priority Priority) error
	Len() int
}

type TaskEventHandler interface {
	OnTaskAdded(t *Task)
	OnTaskRemoved(id string)
	OnTaskScheduled(t *Task)
}
