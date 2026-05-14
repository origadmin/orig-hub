package logging

import (
	"log/slog"
	"os"
	"strings"
)

var globalLogger = slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

func InitLogger(level string, format string) {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "info":
		lvl = slog.LevelInfo
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: lvl}

	var handler slog.Handler
	switch strings.ToLower(format) {
	case "json":
		handler = slog.NewJSONHandler(os.Stdout, opts)
	default:
		handler = slog.NewTextHandler(os.Stdout, opts)
	}

	globalLogger = slog.New(handler)
	slog.SetDefault(globalLogger)
}

func WithName(name string) *slog.Logger {
	return globalLogger.With("logger", name)
}

func WithComponent(component string) *slog.Logger {
	return globalLogger.With("component", component)
}

func WithProtocol(protocol string) *slog.Logger {
	return globalLogger.With("protocol", protocol)
}

func WithDownloadID(id string) *slog.Logger {
	return globalLogger.With("download_id", id)
}

func L() *slog.Logger {
	return globalLogger
}

func SetL(l *slog.Logger) {
	if l != nil {
		globalLogger = l
		slog.SetDefault(l)
	}
}
