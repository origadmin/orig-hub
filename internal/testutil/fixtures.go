package testutil

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

var (
	tempDirs   []string
	tempDirsMu sync.Mutex
)

func TempDir() string {
	dir, err := os.MkdirTemp("", "orig-hub-test-*")
	if err != nil {
		panic(fmt.Sprintf("failed to create temp dir: %v", err))
	}

	tempDirsMu.Lock()
	tempDirs = append(tempDirs, dir)
	tempDirsMu.Unlock()

	return dir
}

func CleanupTempDirs() {
	tempDirsMu.Lock()
	defer tempDirsMu.Unlock()

	for _, dir := range tempDirs {
		_ = os.RemoveAll(dir)
	}
	tempDirs = tempDirs[:0]
}

func GenerateRandomFile(size int64) (path string, checksum string) {
	dir := TempDir()
	filename := fmt.Sprintf("random-%d.bin", size)
	path = filepath.Join(dir, filename)

	f, err := os.Create(path)
	if err != nil {
		panic(fmt.Sprintf("failed to create random file: %v", err))
	}
	defer func() { _ = f.Close() }()

	hasher := sha256.New()
	writer := io.MultiWriter(f, hasher)

	_, err = io.CopyN(writer, rand.Reader, size)
	if err != nil {
		panic(fmt.Sprintf("failed to write random file: %v", err))
	}

	checksum = hex.EncodeToString(hasher.Sum(nil))
	return path, checksum
}

func GenerateTestTorrent(name string, size int64) string {
	dir := TempDir()
	path := filepath.Join(dir, name+".torrent")

	content := fmt.Sprintf("d8:announce%d:%s4:info", len("http://localhost:6969/announce"), "http://localhost:6969/announce")
	content += fmt.Sprintf("d6:lengthi%de4:name%d:%s12:piece lengthi262144e", size, len(name), name)
	content += "e"

	err := os.WriteFile(path, []byte(content), 0644)
	if err != nil {
		panic(fmt.Sprintf("failed to create test torrent: %v", err))
	}

	return path
}

func FileChecksum(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		return ""
	}

	return hex.EncodeToString(hasher.Sum(nil))
}

func FileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return info.Size()
}

func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
