package errdefs

const (
	ProbeFailed    = "PROBE_FAILED"
	ParseError     = "PARSE_ERROR"
	DownloadFailed = "DOWNLOAD_FAILED"
	UploadFailed   = "UPLOAD_FAILED"
	AuthRequired   = "AUTH_REQUIRED"
)

const (
	ChunkFailed       = "CHUNK_FAILED"
	StallDetected     = "STALL_DETECTED"
	HealthCheckFailed = "HEALTH_CHECK_FAILED"
	QueueFull         = "QUEUE_FULL"
)

const (
	NotFound          = "NOT_FOUND"
	AlreadyExists     = "ALREADY_EXISTS"
	InvalidState      = "INVALID_STATE"
	ConcurrencyLimit  = "CONCURRENCY_LIMIT"
)

const (
	NodeUnreachable      = "NODE_UNREACHABLE"
	NodeTimeout          = "NODE_TIMEOUT"
	ChunkReassignFailed  = "CHUNK_REASSIGN_FAILED"
	SyncFailed           = "SYNC_FAILED"
)

const (
	InvalidConfig    = "INVALID_CONFIG"
	MigrationFailed  = "MIGRATION_FAILED"
	PathError        = "PATH_ERROR"
)
