package config

import (
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/origadmin/orig-hub/internal/engine/types"
)

type Settings struct {
	General  GeneralSettings  `toml:"general"`
	Daemon   DaemonSettings   `toml:"daemon"`
	Download DownloadSettings `toml:"download"`
	Network  NetworkSettings  `toml:"network"`
}

type GeneralSettings struct {
	Locale             string `toml:"locale"`
	FloatingBarEnabled bool   `toml:"floating_bar_enabled"`
}

type DaemonSettings struct {
	Port    int    `toml:"port"`
	Token   string `toml:"token"`
	DataDir string `toml:"data_dir"`
}

type DownloadSettings struct {
	MaxConnections int    `toml:"max_connections"`
	OutputDir      string `toml:"output_dir"`
	MinChunkSize   int64  `toml:"min_chunk_size"`
	Sequential     bool   `toml:"sequential"`
}

type NetworkSettings struct {
	ProxyURL  string `toml:"proxy_url"`
	UserAgent string `toml:"user_agent"`
	CustomDNS string `toml:"custom_dns"`
}

func DefaultSettings() *Settings {
	homeDir, _ := os.UserHomeDir()
	return &Settings{
		General: GeneralSettings{
			FloatingBarEnabled: true,
		},
		Daemon: DaemonSettings{
			Port:    8080,
			Token:   "",
			DataDir: filepath.Join(homeDir, ".orig-hub"),
		},
		Download: DownloadSettings{
			MaxConnections: 8,
			OutputDir:      filepath.Join(homeDir, "Downloads"),
			MinChunkSize:   2 * 1024 * 1024,
			Sequential:     false,
		},
		Network: NetworkSettings{
			UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
	}
}

func Load(path string) (*Settings, error) {
	s := DefaultSettings()
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return s, nil
	}

	if _, err := toml.DecodeFile(path, s); err != nil {
		return nil, err
	}

	return s, nil
}

func (s *Settings) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	return toml.NewEncoder(f).Encode(s)
}

func (s *Settings) ToRuntimeConfig() *types.RuntimeConfig {
	return &types.RuntimeConfig{
		MaxConnectionsPerHost: s.Download.MaxConnections,
		UserAgent:             s.Network.UserAgent,
		ProxyURL:              s.Network.ProxyURL,
		CustomDNS:             s.Network.CustomDNS,
		SequentialDownload:    s.Download.Sequential,
		MinChunkSize:          s.Download.MinChunkSize,
	}
}
