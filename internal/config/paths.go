package config

import (
	"os"
	"path/filepath"
	"runtime"
)

func ConfigDir() string {
	if dir := os.Getenv("ORIGHUB_HOME"); dir != "" {
		return dir
	}
	switch runtime.GOOS {
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData != "" {
			return filepath.Join(appData, "orig-hub")
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "orig-hub")
	default:
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "orig-hub")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".orig-hub")
}

func ConfigFile() string {
	return filepath.Join(ConfigDir(), "settings.toml")
}

func DataDir() string {
	if dir := os.Getenv("ORIGHUB_HOME"); dir != "" {
		return dir
	}
	s := DefaultSettings()
	return s.Daemon.DataDir
}

func DBPath() string {
	return filepath.Join(DataDir(), "orig-hub.db")
}

func DownloadDir() string {
	s := DefaultSettings()
	return s.Download.OutputDir
}

func EnsureDirs() error {
	dirs := []string{ConfigDir(), DataDir()}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}
	return nil
}

func LocaleDir() string {
	return filepath.Join(ConfigDir(), "locales")
}
