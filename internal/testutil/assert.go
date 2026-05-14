package testutil

import (
	"fmt"
	"os"
	"testing"
)

func AssertDownloadProgress(t testing.TB, progress float64, expectedPercent float64) {
	t.Helper()
	tolerance := 0.5
	diff := progress - expectedPercent
	if diff < 0 {
		diff = -diff
	}
	if diff > tolerance {
		t.Errorf("download progress: got %.2f%%, expected %.2f%% (tolerance %.2f%%)", progress, expectedPercent, tolerance)
	}
}

func AssertFileChecksum(t testing.TB, path string, expectedSHA256 string) {
	t.Helper()
	if !FileExists(path) {
		t.Fatalf("file does not exist: %s", path)
	}

	actual := FileChecksum(path)
	if actual != expectedSHA256 {
		t.Errorf("file checksum mismatch for %s:\n  expected: %s\n  actual:   %s", path, expectedSHA256, actual)
	}
}

func AssertFileExists(t testing.TB, path string) {
	t.Helper()
	if !FileExists(path) {
		t.Errorf("expected file to exist: %s", path)
	}
}

func AssertFileNotExists(t testing.TB, path string) {
	t.Helper()
	if FileExists(path) {
		t.Errorf("expected file to not exist: %s", path)
	}
}

func AssertFileSize(t testing.TB, path string, expectedSize int64) {
	t.Helper()
	if !FileExists(path) {
		t.Fatalf("file does not exist: %s", path)
	}

	actual := FileSize(path)
	if actual != expectedSize {
		t.Errorf("file size mismatch for %s: expected %d, got %d", path, expectedSize, actual)
	}
}

func AssertHTTPStatusCode(t testing.TB, actual, expected int) {
	t.Helper()
	if actual != expected {
		t.Errorf("HTTP status code: expected %d, got %d", expected, actual)
	}
}

func AssertContentRange(t testing.TB, header, expected string) {
	t.Helper()
	if header != expected {
		t.Errorf("Content-Range header: expected %q, got %q", expected, header)
	}
}

func CreateTestFile(t testing.TB, dir string, name string, content []byte) string {
	t.Helper()
	path := dir + string(os.PathSeparator) + name
	err := os.WriteFile(path, content, 0644)
	if err != nil {
		t.Fatalf("failed to create test file %s: %v", path, err)
	}
	return path
}

func MustTempDir(t testing.TB) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "orig-hub-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return dir
}

func MustWriteFile(t testing.TB, path string, data []byte) {
	t.Helper()
	err := os.WriteFile(path, data, 0644)
	if err != nil {
		t.Fatalf("failed to write file %s: %v", path, err)
	}
}

func MustReadFile(t testing.TB, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read file %s: %v", path, err)
	}
	return data
}

func Errorf(format string, args ...interface{}) error {
	return fmt.Errorf(format, args...)
}
