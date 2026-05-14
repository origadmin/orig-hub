package errdefs

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrorNew(t *testing.T) {
	err := New(ProbeFailed, "probe failed for host")
	if err.Code != ProbeFailed {
		t.Errorf("expected code %q, got %q", ProbeFailed, err.Code)
	}
	if err.Message != "probe failed for host" {
		t.Errorf("expected message %q, got %q", "probe failed for host", err.Message)
	}
	if err.Cause != nil {
		t.Errorf("expected nil cause, got %v", err.Cause)
	}
}

func TestErrorNewString(t *testing.T) {
	err := New(DownloadFailed, "connection reset")
	expected := "DOWNLOAD_FAILED: connection reset"
	if err.Error() != expected {
		t.Errorf("expected %q, got %q", expected, err.Error())
	}
}

func TestErrorWrap(t *testing.T) {
	inner := errors.New("network timeout")
	err := Wrap(inner, DownloadFailed, "download interrupted")
	if err.Code != DownloadFailed {
		t.Errorf("expected code %q, got %q", DownloadFailed, err.Code)
	}
	if err.Cause != inner {
		t.Errorf("expected cause to be inner error")
	}
	expected := "DOWNLOAD_FAILED: download interrupted: network timeout"
	if err.Error() != expected {
		t.Errorf("expected %q, got %q", expected, err.Error())
	}
}

func TestErrorUnwrap(t *testing.T) {
	inner := errors.New("root cause")
	err := Wrap(inner, ChunkFailed, "chunk 3 failed")
	unwrapped := err.Unwrap()
	if unwrapped != inner {
		t.Errorf("expected unwrap to return inner error")
	}
}

func TestIsCode(t *testing.T) {
	err := New(ProbeFailed, "probe failed")
	if !IsCode(err, ProbeFailed) {
		t.Errorf("expected IsCode to return true for PROBE_FAILED")
	}
	if IsCode(err, DownloadFailed) {
		t.Errorf("expected IsCode to return false for DOWNLOAD_FAILED")
	}
	plainErr := errors.New("plain error")
	if IsCode(plainErr, ProbeFailed) {
		t.Errorf("expected IsCode to return false for non-Error type")
	}
}

func TestGetCode(t *testing.T) {
	err := New(ParseError, "invalid url")
	if code := GetCode(err); code != ParseError {
		t.Errorf("expected code %q, got %q", ParseError, code)
	}
	plainErr := errors.New("plain error")
	if code := GetCode(plainErr); code != "" {
		t.Errorf("expected empty code for non-Error type, got %q", code)
	}
}

func TestWithProtocol(t *testing.T) {
	inner := New(DownloadFailed, "connection lost")
	wrapped := WithProtocol(inner, "http")
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	wp, ok := wrapped.(*withProtocol)
	if !ok {
		t.Fatal("expected *withProtocol type")
	}
	if wp.Protocol() != "http" {
		t.Errorf("expected protocol %q, got %q", "http", wp.Protocol())
	}
	if wp.Unwrap() != inner {
		t.Errorf("expected unwrap to return inner error")
	}
}

func TestWithProtocolNil(t *testing.T) {
	if err := WithProtocol(nil, "http"); err != nil {
		t.Errorf("expected nil for nil error, got %v", err)
	}
}

func TestWithDownloadID(t *testing.T) {
	inner := New(DownloadFailed, "stalled")
	wrapped := WithDownloadID(inner, "dl-123")
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	wd, ok := wrapped.(*withDownloadID)
	if !ok {
		t.Fatal("expected *withDownloadID type")
	}
	if wd.DownloadID() != "dl-123" {
		t.Errorf("expected download_id %q, got %q", "dl-123", wd.DownloadID())
	}
}

func TestWithDownloadIDNil(t *testing.T) {
	if err := WithDownloadID(nil, "dl-123"); err != nil {
		t.Errorf("expected nil for nil error, got %v", err)
	}
}

func TestWithURL(t *testing.T) {
	inner := New(ParseError, "bad url")
	wrapped := WithURL(inner, "https://example.com/file.zip")
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	wu, ok := wrapped.(*withURL)
	if !ok {
		t.Fatal("expected *withURL type")
	}
	if wu.URL() != "https://example.com/file.zip" {
		t.Errorf("expected url %q, got %q", "https://example.com/file.zip", wu.URL())
	}
}

func TestWithURLNil(t *testing.T) {
	if err := WithURL(nil, "https://example.com"); err != nil {
		t.Errorf("expected nil for nil error, got %v", err)
	}
}

func TestWithRetry(t *testing.T) {
	inner := New(ChunkFailed, "chunk 5 failed")
	wrapped := WithRetry(inner, 3)
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	wr, ok := wrapped.(*withRetry)
	if !ok {
		t.Fatal("expected *withRetry type")
	}
	if wr.Attempt() != 3 {
		t.Errorf("expected attempt 3, got %d", wr.Attempt())
	}
}

func TestWithRetryNil(t *testing.T) {
	if err := WithRetry(nil, 3); err != nil {
		t.Errorf("expected nil for nil error, got %v", err)
	}
}

func TestUnwrapAll(t *testing.T) {
	root := errors.New("root cause")
	l1 := Wrap(root, ChunkFailed, "chunk failed")
	l2 := WithProtocol(l1, "http")
	l3 := WithDownloadID(l2, "dl-456")
	l4 := WithRetry(l3, 2)

	result := UnwrapAll(l4)
	if result != root {
		t.Errorf("expected root cause, got %v", result)
	}
}

func TestUnwrapAllNoWrap(t *testing.T) {
	err := errors.New("plain error")
	result := UnwrapAll(err)
	if result != err {
		t.Errorf("expected same error for unwrapped error")
	}
}

func TestAllErrorCodes(t *testing.T) {
	protocolCodes := []string{ProbeFailed, ParseError, DownloadFailed, UploadFailed, AuthRequired}
	for _, code := range protocolCodes {
		err := New(code, "test")
		if !IsCode(err, code) {
			t.Errorf("expected IsCode true for %q", code)
		}
	}

	engineCodes := []string{ChunkFailed, StallDetected, HealthCheckFailed, QueueFull}
	for _, code := range engineCodes {
		err := New(code, "test")
		if !IsCode(err, code) {
			t.Errorf("expected IsCode true for %q", code)
		}
	}

	serviceCodes := []string{NotFound, AlreadyExists, InvalidState, ConcurrencyLimit}
	for _, code := range serviceCodes {
		err := New(code, "test")
		if !IsCode(err, code) {
			t.Errorf("expected IsCode true for %q", code)
		}
	}

	nodeCodes := []string{NodeUnreachable, NodeTimeout, ChunkReassignFailed, SyncFailed}
	for _, code := range nodeCodes {
		err := New(code, "test")
		if !IsCode(err, code) {
			t.Errorf("expected IsCode true for %q", code)
		}
	}

	configCodes := []string{InvalidConfig, MigrationFailed, PathError}
	for _, code := range configCodes {
		err := New(code, "test")
		if !IsCode(err, code) {
			t.Errorf("expected IsCode true for %q", code)
		}
	}
}

func TestWrappedErrorFormatting(t *testing.T) {
	inner := New(DownloadFailed, "connection lost")
	wrapped := WithProtocol(inner, "http")
	msg := wrapped.Error()
	if msg == "" {
		t.Error("expected non-empty error message")
	}
}

func TestItoa(t *testing.T) {
	tests := []struct {
		input    int
		expected string
	}{
		{0, "0"},
		{1, "1"},
		{10, "10"},
		{-1, "-1"},
		{42, "42"},
	}
	for _, tt := range tests {
		result := itoa(tt.input)
		if result != tt.expected {
			t.Errorf("itoa(%d) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestErrorChainWithFmtFormatting(t *testing.T) {
	inner := errors.New("timeout")
	err := Wrap(inner, ChunkFailed, "chunk 3 failed")
	wrapped := WithProtocol(WithDownloadID(err, "dl-789"), "ftp")
	result := fmt.Sprintf("%v", wrapped)
	if result == "" {
		t.Error("expected non-empty formatted error")
	}
}
