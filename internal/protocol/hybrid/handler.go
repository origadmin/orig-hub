package hybrid

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"golang.org/x/sys/windows/registry"
)

type ProtocolHandler struct {
	Scheme  string
	AppName string
	ExePath string
}

func NewProtocolHandler(scheme, appName string) (*ProtocolHandler, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("get executable path: %w", err)
	}
	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return nil, fmt.Errorf("resolve executable path: %w", err)
	}

	return &ProtocolHandler{
		Scheme:  scheme,
		AppName: appName,
		ExePath: exePath,
	}, nil
}

func (h *ProtocolHandler) Register() error {
	switch runtime.GOOS {
	case "windows":
		return h.registerWindows()
	case "darwin":
		return h.registerDarwin()
	case "linux":
		return h.registerLinux()
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

func (h *ProtocolHandler) Unregister() error {
	switch runtime.GOOS {
	case "windows":
		return h.unregisterWindows()
	case "darwin":
		return h.unregisterDarwin()
	case "linux":
		return h.unregisterLinux()
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

func (h *ProtocolHandler) IsRegistered() bool {
	switch runtime.GOOS {
	case "windows":
		return h.isRegisteredWindows()
	case "darwin":
		return h.isRegisteredDarwin()
	case "linux":
		return h.isRegisteredLinux()
	default:
		return false
	}
}

func (h *ProtocolHandler) registerWindows() error {
	keyPath := `Software\Classes\` + h.Scheme

	k, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("create registry key: %w", err)
	}

	if err := k.SetStringValue("", "URL:"+h.AppName+" Protocol"); err != nil {
		k.Close()
		return err
	}
	if err := k.SetStringValue("URL Protocol", ""); err != nil {
		k.Close()
		return err
	}
	k.Close()

	iconKey, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath+`\DefaultIcon`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	if err := iconKey.SetStringValue("", h.ExePath+",0"); err != nil {
		iconKey.Close()
		return err
	}
	iconKey.Close()

	shellKey, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath+`\shell\open\command`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	cmd := fmt.Sprintf(`"%s" "hybrid:%%1"`, h.ExePath)
	if err := shellKey.SetStringValue("", cmd); err != nil {
		shellKey.Close()
		return err
	}
	shellKey.Close()

	return nil
}

func (h *ProtocolHandler) unregisterWindows() error {
	keyPath := `Software\Classes\` + h.Scheme
	deleteKeyRecursive(registry.CURRENT_USER, keyPath)
	return nil
}

func deleteKeyRecursive(k registry.Key, path string) {
	openedKey, err := registry.OpenKey(k, path, registry.READ)
	if err != nil {
		return
	}
	subKeys, err := openedKey.ReadSubKeyNames(0)
	openedKey.Close()
	if err != nil {
		return
	}
	for _, sub := range subKeys {
		deleteKeyRecursive(k, path+`\`+sub)
	}
	registry.DeleteKey(k, path)
}

func (h *ProtocolHandler) isRegisteredWindows() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+h.Scheme, registry.READ)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

func (h *ProtocolHandler) registerDarwin() error {
	appDir := filepath.Join(os.Getenv("HOME"), "Library", "Application Support", h.AppName)
	if err := os.MkdirAll(appDir, 0755); err != nil {
		return err
	}

	plistPath := filepath.Join(appDir, "URLScheme.plist")

	plistContent := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key>
			<string>com.origadmin.orig-hub</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>%s</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`, h.Scheme)

	if err := os.WriteFile(plistPath, []byte(plistContent), 0644); err != nil {
		return err
	}

	return nil
}

func (h *ProtocolHandler) unregisterDarwin() error {
	appDir := filepath.Join(os.Getenv("HOME"), "Library", "Application Support", h.AppName)
	plistPath := filepath.Join(appDir, "URLScheme.plist")
	os.Remove(plistPath)
	return nil
}

func (h *ProtocolHandler) isRegisteredDarwin() bool {
	appDir := filepath.Join(os.Getenv("HOME"), "Library", "Application Support", h.AppName)
	plistPath := filepath.Join(appDir, "URLScheme.plist")
	_, err := os.Stat(plistPath)
	return err == nil
}

func (h *ProtocolHandler) registerLinux() error {
	appDir := filepath.Join(os.Getenv("HOME"), ".local", "share", "applications")
	if err := os.MkdirAll(appDir, 0755); err != nil {
		return err
	}

	desktopContent := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=%s
Exec=%s "hybrid:%%u"
MimeType=x-scheme-handler/%s;
NoDisplay=true
`, h.AppName, h.ExePath, h.Scheme)

	desktopPath := filepath.Join(appDir, h.Scheme+"-handler.desktop")
	if err := os.WriteFile(desktopPath, []byte(desktopContent), 0644); err != nil {
		return err
	}

	cmd := exec.Command("update-desktop-database", appDir)
	_ = cmd.Run()

	cmd = exec.Command("xdg-mime", "default", h.Scheme+"-handler.desktop", "x-scheme-handler/"+h.Scheme)
	_ = cmd.Run()

	return nil
}

func (h *ProtocolHandler) unregisterLinux() error {
	appDir := filepath.Join(os.Getenv("HOME"), ".local", "share", "applications")
	desktopPath := filepath.Join(appDir, h.Scheme+"-handler.desktop")
	os.Remove(desktopPath)

	cmd := exec.Command("update-desktop-database", appDir)
	_ = cmd.Run()
	return nil
}

func (h *ProtocolHandler) isRegisteredLinux() bool {
	cmd := exec.Command("xdg-mime", "query", "default", "x-scheme-handler/"+h.Scheme)
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return len(out) > 0
}
