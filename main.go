package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"strings"

	"github.com/origadmin/orig-hub/internal/app"
	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/engine/state"
	appI18n "github.com/origadmin/orig-hub/internal/i18n"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpProto "github.com/origadmin/orig-hub/internal/protocol/http"
	"github.com/origadmin/orig-hub/internal/protocol/hybrid"
	"github.com/origadmin/orig-hub/internal/service"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

var (
	VERSION = "dev"
)

//go:embed ui/dist
var assets embed.FS

func main() {
	if !app.EnsureSingleInstance() {
		log.Println("Orig Hub is already running")
		return
	}
	defer app.ReleaseMutex()

	app.RunDaemon()

	cfg, err := config.Load(config.ConfigFile())
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if err := config.EnsureDirs(); err != nil {
		log.Fatalf("ensure dirs: %v", err)
	}

	if localeDir := config.LocaleDir(); localeDir != "" {
		_ = appI18n.LoadDir(localeDir)
	}
	if cfg.General.Locale != "" {
		appI18n.SetLocale(cfg.General.Locale)
	} else {
		// 默认跟随系统语言（Windows API 探测）
		if sys := detectSystemLocale(); sys != "" {
			appI18n.SetLocale(sys)
		}
	}

	registry := protocol.NewRegistry()
	httpP := httpProto.New(cfg.ToRuntimeConfig())
	if err := registry.Register(httpP); err != nil {
		log.Fatalf("register http protocol: %v", err)
	}

	hybridP := hybrid.NewHybridProtocol(registry, cfg.ToRuntimeConfig())
	if err := registry.Register(hybridP); err != nil {
		log.Fatalf("register hybrid protocol: %v", err)
	}

	db, err := state.Open(config.DBPath())
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer func() { _ = db.Close() }()

	svc := service.NewLocalService(registry, cfg, db)
	// 延迟注入 wailsApp.Event emitter (需先创建 wailsApp)

	subFS, err := fs.Sub(assets, "ui/dist")
	if err != nil {
		log.Fatalf("create sub filesystem: %v", err)
	}

	wailsApp := application.New(application.Options{
		Name: "Orig Hub",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(subFS),
		},
		Services: []application.Service{
			application.NewService(app.NewDownloadService(svc, cfg)),
		},
	})

	// 把 wailsApp 的事件总线注入 LocalService, 让 download 进度/状态 emit 到前端
	svc.SetEmitter(wailsApp.Event)

	mainWindow := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:                      "Orig Hub",
		URL:                        "/#main",
		Width:                      1200,
		Height:                     800,
		Frameless:                  true,
		BackgroundType:             application.BackgroundTypeTransparent,
		DefaultContextMenuDisabled: true,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 38,
		},
		Windows: application.WindowsWindow{
			WindowMaskDraggable: true,
		},
	})

	floatWindow := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:                      "Orig Hub Float",
		URL:                        "/?window=float",
		Width:                      200,
		Height:                     44,
		MinHeight:                  1,
		MinWidth:                   1,
		Frameless:                  true,
		BackgroundColour:           application.RGBA{Red: 28, Green: 28, Blue: 31, Alpha: 255},
		DefaultContextMenuDisabled: true,
		AlwaysOnTop:                true,
		Hidden:                     true,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 28,
		},
		Windows: application.WindowsWindow{
			WindowMaskDraggable: true,
		},
	})

	gui := app.NewGUIController(wailsApp, mainWindow, floatWindow, svc, cfg)

	wailsApp.RegisterService(application.NewService(gui))

	iconData := app.CreateTrayIcon()
	systray := wailsApp.SystemTray.New()
	systray.SetIcon(iconData)
	systray.SetTooltip(appI18n.T("tray.tooltipIdle"))

	createTrayMenu := func() *application.Menu {
		menu := wailsApp.NewMenu()
		menu.Add(appI18n.T("tray.openMainWindow")).OnClick(func(ctx *application.Context) {
			if gui.IsMainWindowVisible() {
				gui.HideMainWindow()
			} else {
				gui.RestoreMainWindow()
			}
		})
		menu.Add(appI18n.T("tray.addDownload")).OnClick(func(ctx *application.Context) {
			gui.RestoreMainWindow()
			wailsApp.Event.Emit("download:open-add-dialog")
		})
		menu.AddSeparator()
		menu.Add(appI18n.T("tray.resumeAll")).OnClick(func(ctx *application.Context) {
			gui.ResumeAll()
		})
		menu.Add(appI18n.T("tray.pauseAll")).OnClick(func(ctx *application.Context) {
			gui.PauseAll()
		})
		menu.AddSeparator()
		floatSubmenu := menu.AddSubmenu(appI18n.T("tray.floatingBar"))
		alwaysItem := floatSubmenu.AddRadio(appI18n.T("tray.floatingBar.always"), gui.GetFloatingVisibleMode() == "always")
		alwaysItem.OnClick(func(ctx *application.Context) { gui.SetFloatingVisibleMode("always") })
		downloadingItem := floatSubmenu.AddRadio(appI18n.T("tray.floatingBar.downloading"), gui.GetFloatingVisibleMode() == "downloading")
		downloadingItem.OnClick(func(ctx *application.Context) { gui.SetFloatingVisibleMode("downloading") })
		neverItem := floatSubmenu.AddRadio(appI18n.T("tray.floatingBar.never"), gui.GetFloatingVisibleMode() == "never")
		neverItem.OnClick(func(ctx *application.Context) { gui.SetFloatingVisibleMode("never") })
		menu.AddSeparator()
		menu.Add(appI18n.T("tray.quit")).OnClick(func(ctx *application.Context) {
			gui.SetQuitting(true)
			wailsApp.Quit()
		})
		return menu
	}

	systray.SetMenu(createTrayMenu())

	systray.OnClick(func() {
		gui.RestoreMainWindow()
	})

	systray.OnRightClick(func() {
		systray.SetMenu(createTrayMenu())
		systray.OpenMenu()
	})

	systray.OnDoubleClick(func() {
		gui.RestoreMainWindow()
	})

	gui.SetSystray(systray)

	mainWindow.OnWindowEvent(events.Windows.WindowClosing, func(event *application.WindowEvent) {
		if cfg.General.FloatingBarEnabled && !gui.IsQuitting() {
			gui.HideMainWindow()
			gui.ShowFloatWindow()
		}
	})

	floatWindow.OnWindowEvent(events.Windows.WindowClosing, func(event *application.WindowEvent) {
		if cfg.General.FloatingBarEnabled && !gui.IsQuitting() {
			gui.HideFloatWindow()
		}
	})

	gui.OnLocaleChanged = func(locale string) {
		appI18n.SetLocale(locale)
		systray.SetMenu(createTrayMenu())
		systray.SetTooltip(appI18n.T("tray.tooltipIdle"))
	}

	if err := wailsApp.Run(); err != nil {
		log.Fatalf("wails run: %v", err)
	}
}

// detectSystemLocale 返回当前系统区域语言。
// Windows: 调用 kernel32.GetUserDefaultLocaleName
// Linux/macOS: 使用环境变量 LANG / LC_ALL
// 返回值匹配 i18n 内置表: "en" / "zh-CN" / "ja"，未知返回 ""。
func detectSystemLocale() string {
	raw := readSystemLocaleRaw()
	if raw == "" {
		return ""
	}
	normalized := normalizeLocale(raw)
	switch normalized {
	case "en", "zh-CN", "ja":
		return normalized
	}
	if strings.HasPrefix(normalized, "zh") {
		return "zh-CN"
	}
	if strings.HasPrefix(normalized, "ja") {
		return "ja"
	}
	if strings.HasPrefix(normalized, "en") {
		return "en"
	}
	return ""
}

func normalizeLocale(raw string) string {
	s := strings.ReplaceAll(raw, "_", "-")
	if idx := strings.Index(s, "."); idx > 0 {
		s = s[:idx]
	}
	if idx := strings.Index(s, "-"); idx > 0 {
		lang := strings.ToLower(s[:idx])
		rest := s[idx+1:]
		rest = strings.ToUpper(rest[:1]) + rest[1:]
		return lang + "-" + rest
	}
	return strings.ToLower(s)
}

// readSystemLocaleRaw: Windows 通过 kernel32.GetUserDefaultLocaleName 探测。
// 其它平台: 直接使用环境变量 LC_ALL / LANG。
func readSystemLocaleRaw() string {
	return readSystemLocaleRawImpl()
}

func envLocale() string {
	if v := os.Getenv("LC_ALL"); v != "" {
		return v
	}
	if v := os.Getenv("LANG"); v != "" {
		return v
	}
	return ""
}