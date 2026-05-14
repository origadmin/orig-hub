package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestInitLogger(t *testing.T) {
	tests := []struct {
		name      string
		level     string
		format    string
		wantLevel slog.Level
		wantJSON  bool
	}{
		{"debug json", "debug", "json", slog.LevelDebug, true},
		{"info text", "info", "text", slog.LevelInfo, false},
		{"warn json", "warn", "json", slog.LevelWarn, true},
		{"error text", "error", "text", slog.LevelError, false},
		{"default level", "unknown", "text", slog.LevelInfo, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			opts := &slog.HandlerOptions{Level: tt.wantLevel}
			var handler slog.Handler
			if tt.wantJSON {
				handler = slog.NewJSONHandler(&buf, opts)
			} else {
				handler = slog.NewTextHandler(&buf, opts)
			}
			logger := slog.New(handler)
			SetL(logger)

			L().Log(context.TODO(), tt.wantLevel, "test message")

			output := buf.String()
			if output == "" {
				t.Error("expected log output, got empty")
			}

			if tt.wantJSON {
				if !json.Valid([]byte(output)) {
					t.Errorf("expected valid JSON output, got: %s", output)
				}
			}

			if !strings.Contains(output, "test message") {
				t.Errorf("expected output to contain 'test message', got: %s", output)
			}
		})
	}
}

func TestWithHelpers(t *testing.T) {
	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	logger := slog.New(handler)
	SetL(logger)

	named := WithName("test-logger")
	named.Info("named message")
	if !strings.Contains(buf.String(), "logger=test-logger") {
		t.Errorf("expected 'logger=test-logger' in output, got: %s", buf.String())
	}
	buf.Reset()

	comp := WithComponent("download-manager")
	comp.Info("component message")
	if !strings.Contains(buf.String(), "component=download-manager") {
		t.Errorf("expected 'component=download-manager' in output, got: %s", buf.String())
	}
	buf.Reset()

	proto := WithProtocol("http")
	proto.Info("protocol message")
	if !strings.Contains(buf.String(), "protocol=http") {
		t.Errorf("expected 'protocol=http' in output, got: %s", buf.String())
	}
	buf.Reset()

	dl := WithDownloadID("abc-123")
	dl.Info("download message")
	if !strings.Contains(buf.String(), "download_id=abc-123") {
		t.Errorf("expected 'download_id=abc-123' in output, got: %s", buf.String())
	}
}

func TestSetL_Nil(t *testing.T) {
	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	logger := slog.New(handler)
	SetL(logger)

	before := L()
	SetL(nil)
	after := L()

	if after != before {
		t.Error("SetL(nil) should not change the global logger")
	}
}

func TestInitTracer_EmptyEndpoint(t *testing.T) {
	shutdown, err := InitTracer("", "test-service")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Error("expected non-nil shutdown function")
	}
	_ = shutdown(nil)
}
