package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultSettings(t *testing.T) {
	s := DefaultSettings()
	if s.Daemon.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", s.Daemon.Port)
	}
	if s.Daemon.Token != "" {
		t.Errorf("expected empty default token, got %q", s.Daemon.Token)
	}
	if s.Download.MaxConnections != 8 {
		t.Errorf("expected default 8 connections, got %d", s.Download.MaxConnections)
	}
	if s.Download.MinChunkSize != 2*1024*1024 {
		t.Errorf("expected default min chunk size 2MB, got %d", s.Download.MinChunkSize)
	}
	if s.Download.Sequential {
		t.Error("expected default sequential to be false")
	}
	if s.Network.UserAgent == "" {
		t.Error("expected non-empty default user agent")
	}
	if s.Network.ProxyURL != "" {
		t.Errorf("expected empty default proxy URL, got %q", s.Network.ProxyURL)
	}
	if s.Network.CustomDNS != "" {
		t.Errorf("expected empty default custom DNS, got %q", s.Network.CustomDNS)
	}
}

func TestLoadNonExistent(t *testing.T) {
	s, err := Load("/nonexistent/path/settings.toml")
	if err != nil {
		t.Fatalf("should not error on missing file: %v", err)
	}
	if s.Daemon.Port != 8080 {
		t.Errorf("should return defaults, got port %d", s.Daemon.Port)
	}
	if s.Download.MaxConnections != 8 {
		t.Errorf("should return defaults, got %d connections", s.Download.MaxConnections)
	}
}

func TestSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.toml")

	s := DefaultSettings()
	s.Daemon.Port = 9090
	s.Daemon.Token = "test-token"
	s.Download.MaxConnections = 16
	s.Network.ProxyURL = "http://proxy:8080"
	s.Network.CustomDNS = "8.8.8.8"
	s.Download.Sequential = true

	if err := s.Save(path); err != nil {
		t.Fatalf("failed to save: %v", err)
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("settings file should exist after save")
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("failed to load: %v", err)
	}

	if loaded.Daemon.Port != 9090 {
		t.Errorf("expected port 9090, got %d", loaded.Daemon.Port)
	}
	if loaded.Daemon.Token != "test-token" {
		t.Errorf("expected token 'test-token', got %q", loaded.Daemon.Token)
	}
	if loaded.Download.MaxConnections != 16 {
		t.Errorf("expected 16 connections, got %d", loaded.Download.MaxConnections)
	}
	if loaded.Network.ProxyURL != "http://proxy:8080" {
		t.Errorf("expected proxy URL 'http://proxy:8080', got %q", loaded.Network.ProxyURL)
	}
	if loaded.Network.CustomDNS != "8.8.8.8" {
		t.Errorf("expected custom DNS '8.8.8.8', got %q", loaded.Network.CustomDNS)
	}
	if !loaded.Download.Sequential {
		t.Error("expected sequential to be true")
	}
}

func TestSaveCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subdir", "nested", "settings.toml")

	s := DefaultSettings()
	if err := s.Save(path); err != nil {
		t.Fatalf("failed to save with nested dirs: %v", err)
	}

	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("settings file should exist after save with nested dirs")
	}
}

func TestToRuntimeConfig(t *testing.T) {
	s := DefaultSettings()
	s.Download.MaxConnections = 4
	s.Network.UserAgent = "test-agent"
	s.Network.ProxyURL = "http://proxy:3128"
	s.Network.CustomDNS = "1.1.1.1"
	s.Download.Sequential = true
	s.Download.MinChunkSize = 4 * 1024 * 1024

	rc := s.ToRuntimeConfig()
	if rc.MaxConnectionsPerHost != 4 {
		t.Errorf("expected 4, got %d", rc.MaxConnectionsPerHost)
	}
	if rc.UserAgent != "test-agent" {
		t.Errorf("expected 'test-agent', got %q", rc.UserAgent)
	}
	if rc.ProxyURL != "http://proxy:3128" {
		t.Errorf("expected 'http://proxy:3128', got %q", rc.ProxyURL)
	}
	if rc.CustomDNS != "1.1.1.1" {
		t.Errorf("expected '1.1.1.1', got %q", rc.CustomDNS)
	}
	if !rc.SequentialDownload {
		t.Error("expected SequentialDownload to be true")
	}
	if rc.MinChunkSize != 4*1024*1024 {
		t.Errorf("expected 4MB min chunk size, got %d", rc.MinChunkSize)
	}
}

func TestToRuntimeConfigDefaults(t *testing.T) {
	s := DefaultSettings()

	rc := s.ToRuntimeConfig()
	if rc.MaxConnectionsPerHost != 8 {
		t.Errorf("expected 8, got %d", rc.MaxConnectionsPerHost)
	}
	if rc.UserAgent == "" {
		t.Error("expected non-empty user agent from defaults")
	}
	if rc.SequentialDownload {
		t.Error("expected SequentialDownload to be false by default")
	}
}
