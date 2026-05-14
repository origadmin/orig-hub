package types

import "time"

const (
	KB = 1 << 10
	MB = 1 << 20
	GB = 1 << 30

	IncompleteSuffix = ".orighub"

	MinChunk     = 2 * MB
	AlignSize    = 4 * KB
	WorkerBuffer = 512 * KB

	WorkerBatchSize     = 1 * MB
	WorkerBatchInterval = 200 * time.Millisecond

	PerHostMax     = 64
	DialHedgeCount = 4

	DefaultMaxIdleConns          = 100
	DefaultIdleConnTimeout       = 90 * time.Second
	DefaultTLSHandshakeTimeout   = 10 * time.Second
	DefaultResponseHeaderTimeout = 15 * time.Second
	DefaultExpectContinueTimeout = 1 * time.Second
	DialTimeout                  = 10 * time.Second
	KeepAliveDuration            = 30 * time.Second
	ProbeTimeout                 = 30 * time.Second

	PoolMaxIdleConns        = 512
	PoolMaxIdleConnsPerHost = 128
	PoolMaxConnsPerHost     = 512

	ProgressChannelBuffer = 100

	MaxTaskRetries = 3
	RetryBaseDelay = 200 * time.Millisecond

	HealthCheckInterval = 1 * time.Second
	SlowWorkerThreshold = 0.50
	SlowWorkerGrace     = 5 * time.Second
	StallTimeout        = 5 * time.Second
	SpeedEMAAlpha       = 0.3
)

type RuntimeConfig struct {
	MaxConnectionsPerHost int
	UserAgent             string
	ProxyURL              string
	CustomDNS             string
	SequentialDownload    bool
	MinChunkSize          int64
	WorkerBufferSize      int
	MaxTaskRetries        int
	DialHedgeCount        int
	SlowWorkerThreshold   float64
	SlowWorkerGracePeriod time.Duration
	StallTimeout          time.Duration
	SpeedEmaAlpha         float64
}

func (c *RuntimeConfig) GetUserAgent() string {
	if c.UserAgent == "" {
		return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	}
	return c.UserAgent
}

func (c *RuntimeConfig) GetMaxConnectionsPerHost() int {
	if c.MaxConnectionsPerHost <= 0 {
		return PerHostMax
	}
	return c.MaxConnectionsPerHost
}

func (c *RuntimeConfig) GetMinChunkSize() int64 {
	if c.MinChunkSize <= 0 {
		return MinChunk
	}
	return c.MinChunkSize
}

func (c *RuntimeConfig) GetWorkerBufferSize() int {
	if c.WorkerBufferSize <= 0 {
		return WorkerBuffer
	}
	return c.WorkerBufferSize
}

func (c *RuntimeConfig) GetMaxTaskRetries() int {
	if c.MaxTaskRetries <= 0 {
		return MaxTaskRetries
	}
	return c.MaxTaskRetries
}

func (c *RuntimeConfig) GetDialHedgeCount() int {
	if c.DialHedgeCount < 0 {
		return DialHedgeCount
	}
	return c.DialHedgeCount
}

func (c *RuntimeConfig) GetSlowWorkerThreshold() float64 {
	if c.SlowWorkerThreshold <= 0 {
		return SlowWorkerThreshold
	}
	return c.SlowWorkerThreshold
}

func (c *RuntimeConfig) GetSlowWorkerGracePeriod() time.Duration {
	if c.SlowWorkerGracePeriod <= 0 {
		return SlowWorkerGrace
	}
	return c.SlowWorkerGracePeriod
}

func (c *RuntimeConfig) GetStallTimeout() time.Duration {
	if c.StallTimeout <= 0 {
		return StallTimeout
	}
	return c.StallTimeout
}

func (c *RuntimeConfig) GetSpeedEmaAlpha() float64 {
	if c.SpeedEmaAlpha <= 0 {
		return SpeedEMAAlpha
	}
	return c.SpeedEmaAlpha
}
