package types

import "errors"

var (
	ErrPaused             = errors.New("download paused")
	ErrNotFound           = errors.New("download not found")
	ErrCompleted          = errors.New("download already completed")
	ErrPausing            = errors.New("download is still pausing, try again in a moment")
	ErrEngineNotInit      = errors.New("engine not initialized")
	ErrPoolNotInit        = errors.New("worker pool not initialized")
	ErrIDExists           = errors.New("download id already exists")
	ErrURLRequired        = errors.New("URL is required")
	ErrDestRequired       = errors.New("destination path is required")
	ErrServiceUnavailable = errors.New("service unavailable")
	ErrMaxRedirects       = errors.New("stopped after 10 redirects")
)
