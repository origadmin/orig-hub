package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/origadmin/orig-hub/internal/config"
	"github.com/origadmin/orig-hub/internal/core"
	"github.com/origadmin/orig-hub/internal/download"
	"github.com/origadmin/orig-hub/internal/engine/state"
	"github.com/origadmin/orig-hub/internal/engine/types"
	"github.com/origadmin/orig-hub/internal/protocol"
	httpProto "github.com/origadmin/orig-hub/internal/protocol/http"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed ui/dist
var assets embed.FS

func main() {
	daemonCmd := flag.NewFlagSet("daemon", flag.ExitOnError)
	daemonPort := daemonCmd.Int("port", 0, "daemon port")

	addCmd := flag.NewFlagSet("add", flag.ExitOnError)
	addOutput := addCmd.String("o", "", "output directory")
	addFilename := addCmd.String("f", "", "filename")

	flag.Parse()

	if len(os.Args) < 2 {
		runGUI()
		return
	}

	cfg, err := config.Load(config.ConfigFile())
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	switch os.Args[1] {
	case "gui":
		runGUI()
	case "daemon":
		_ = daemonCmd.Parse(os.Args[2:])
		port := *daemonPort
		if port == 0 {
			port = cfg.Daemon.Port
		}
		runDaemon(cfg, port)
	case "add":
		_ = addCmd.Parse(os.Args[2:])
		if addCmd.NArg() < 1 {
			fmt.Println("Usage: orig-hub add <url>")
			os.Exit(1)
		}
		url := addCmd.Arg(0)
		addDownload(cfg, url, *addOutput, *addFilename)
	case "list":
		listDownloads(cfg)
	case "pause", "resume", "cancel":
		if len(os.Args) < 3 {
			fmt.Println("Usage: orig-hub <command> <id>")
			os.Exit(1)
		}
		controlDownload(cfg, os.Args[1], os.Args[2])
	default:
		fmt.Printf("Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func runGUI() {
	cfg, err := config.Load(config.ConfigFile())
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if err := config.EnsureDirs(); err != nil {
		log.Fatalf("Failed to create directories: %v", err)
	}

	registry := protocol.NewRegistry()
	p := httpProto.New(cfg.ToRuntimeConfig())
	if err := registry.Register(p); err != nil {
		log.Fatalf("Failed to register HTTP protocol: %v", err)
	}

	manager := download.NewManager(registry, cfg.ToRuntimeConfig())

	db, err := state.Open(config.DBPath())
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer func() { _ = db.Close() }()

	service := core.NewLocalService(manager, db)
	app := NewApp(service, cfg)

	appMenu := createAppMenu(app)

	err = wails.Run(&options.App{
		Title:  "orig-hub",
		Width:  1200,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
		},
		OnShutdown: func(ctx context.Context) {
			app.shutdown()
			_ = service.Shutdown()
		},
		Menu: appMenu,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
	})
	if err != nil {
		log.Fatalf("Error starting app: %v", err)
	}
}

func createAppMenu(app *App) *menu.Menu {
	appMenu := menu.NewMenu()

	fileMenu := appMenu.AddSubmenu("File")
	fileMenu.AddText("Add Download", keys.CmdOrCtrl("n"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:add-download")
	})
	fileMenu.AddSeparator()
	fileMenu.AddText("Preferences", keys.CmdOrCtrl(","), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:preferences")
	})
	fileMenu.AddSeparator()
	fileMenu.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
		wailsRuntime.Quit(app.ctx)
	})

	editMenu := appMenu.AddSubmenu("Edit")
	editMenu.AddText("Cut", keys.CmdOrCtrl("x"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:cut")
	})
	editMenu.AddText("Copy", keys.CmdOrCtrl("c"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:copy")
	})
	editMenu.AddText("Paste", keys.CmdOrCtrl("v"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:paste")
	})
	editMenu.AddSeparator()
	editMenu.AddText("Select All", keys.CmdOrCtrl("a"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:select-all")
	})

	viewMenu := appMenu.AddSubmenu("View")
	viewMenu.AddText("Toggle DevTools", keys.CmdOrCtrl("shift+i"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:toggle-devtools")
	})
	viewMenu.AddSeparator()
	viewMenu.AddText("Zoom In", keys.CmdOrCtrl("+"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:zoom-in")
	})
	viewMenu.AddText("Zoom Out", keys.CmdOrCtrl("-"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:zoom-out")
	})
	viewMenu.AddText("Reset Zoom", keys.CmdOrCtrl("0"), func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:zoom-reset")
	})

	helpMenu := appMenu.AddSubmenu("Help")
	helpMenu.AddText("About orig-hub", nil, func(_ *menu.CallbackData) {
		wailsRuntime.EventsEmit(app.ctx, "menu:about")
	})

	return appMenu
}

func runDaemon(cfg *config.Settings, port int) {
	if err := config.EnsureDirs(); err != nil {
		log.Fatalf("Failed to create directories: %v", err)
	}

	registry := protocol.NewRegistry()
	p := httpProto.New(cfg.ToRuntimeConfig())
	if err := registry.Register(p); err != nil {
		log.Fatalf("Failed to register HTTP protocol: %v", err)
	}

	manager := download.NewManager(registry, cfg.ToRuntimeConfig())

	db, err := state.Open(config.DBPath())
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer func() { _ = db.Close() }()

	service := core.NewLocalService(manager, db)
	apiServer := core.NewAPIServer(service, cfg.Daemon.Token)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("orig-hub daemon starting on %s", addr)

	server := &http.Server{
		Addr:    addr,
		Handler: apiServer,
	}

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down...")
	_ = service.Shutdown()
	_ = server.Close()
}

func addDownload(cfg *config.Settings, url, outputPath, filename string) {
	if outputPath == "" {
		outputPath = cfg.Download.OutputDir
	}

	registry := protocol.NewRegistry()
	p := httpProto.New(cfg.ToRuntimeConfig())
	if err := registry.Register(p); err != nil {
		log.Fatalf("Failed to register HTTP protocol: %v", err)
	}

	manager := download.NewManager(registry, cfg.ToRuntimeConfig())
	defer func() { _ = manager.Shutdown() }()

	id, err := manager.Add(context.Background(), &protocol.DownloadConfig{
		URL:        url,
		OutputPath: outputPath,
		Filename:   filename,
	})
	if err != nil {
		log.Fatalf("Failed to add download: %v", err)
	}

	fmt.Printf("Download added: %s\n", id)
}

func listDownloads(cfg *config.Settings) {
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/api/downloads", cfg.Daemon.Port))
	if err != nil {
		log.Fatalf("Failed to connect to daemon: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var statuses []types.DownloadStatus
	if err := json.NewDecoder(resp.Body).Decode(&statuses); err != nil {
		log.Fatalf("Failed to decode response: %v", err)
	}

	for _, s := range statuses {
		fmt.Printf("%s  %s  %.1f%%  %s\n", s.ID, s.Filename, s.Progress, s.Status)
	}
}

func controlDownload(cfg *config.Settings, action, id string) {
	url := fmt.Sprintf("http://localhost:%d/api/downloads/%s?action=%s", cfg.Daemon.Port, id, action)
	resp, err := http.Post(url, "application/json", nil)
	if err != nil {
		log.Fatalf("Failed to connect to daemon: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	fmt.Printf("%s %s: %s\n", action, id, resp.Status)
}
