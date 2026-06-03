package app

import (
	"context"
	"os/exec"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/origadmin/orig-hub/internal/config"
	appI18n "github.com/origadmin/orig-hub/internal/i18n"
	"github.com/origadmin/orig-hub/internal/service"
	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	floatCollapsedW = 200
	floatCollapsedH = 44
	floatExpandedW  = 320
	floatExpandedH  = 44
	floatSnappedH   = 16
	floatSnappedW   = 16
	floatHiddenH    = 4
	floatHiddenW    = 4
	normalWidth     = 1200
	normalHeight    = 800
	snapThreshold   = 20

	snapNone      int32 = 0
	snapTop       int32 = 1
	snapBottom    int32 = 2
	snapLeft      int32 = 3
	snapRight     int32 = 4

	snapStateNormal   int32 = 0
	snapStateSnapped  int32 = 1
	snapStateAutoHide int32 = 2
)

type GUIController struct {
	app          *application.App
	mainWindow   *application.WebviewWindow
	floatWindow  *application.WebviewWindow
	svc          service.Service
	cfg          *config.Settings
	systray      *application.SystemTray
	quitting     atomic.Bool
	cancelPolling context.CancelFunc
	cancelSnap   context.CancelFunc
	snapCooldown atomic.Int64 // unix millis, don't re-snap until after this time
	mu           sync.Mutex

	floatExpanded  atomic.Bool
	snapDirection  atomic.Int32
	snapState      atomic.Int32
	floatHwnd      uintptr
	floatHwndMu    sync.Mutex
	lastSnapX      int
	lastSnapY      int

	mainSavedX int
	mainSavedY int
	mainSavedW int
	mainSavedH int

	floatSavedX int
	floatSavedY int

	ctxMenu         *application.ContextMenu
	OnLocaleChanged func(locale string)

	// floatingVisibleMode: "always" | "downloading" | "never"
	// TODO: 后续完善 — 持久化到 settings
	floatingVisibleMode atomic.Int32
}

func (g *GUIController) IsQuitting() bool {
	return g.quitting.Load()
}

func (g *GUIController) SetQuitting(v bool) {
	g.quitting.Store(v)
}

func (g *GUIController) IsMainWindowVisible() bool {
	return g.mainWindow.IsVisible()
}

func (g *GUIController) GetFloatingVisibleMode() string {
	switch g.floatingVisibleMode.Load() {
	case 1:
		return "downloading"
	case 2:
		return "never"
	default:
		return "always"
	}
}

func (g *GUIController) SetFloatingVisibleMode(mode string) {
	var v int32
	switch mode {
	case "downloading":
		v = 1
	case "never":
		v = 2
	default:
		v = 0
	}
	g.floatingVisibleMode.Store(v)
}

func NewGUIController(
	app *application.App,
	mainWindow *application.WebviewWindow,
	floatWindow *application.WebviewWindow,
	svc service.Service,
	cfg *config.Settings,
) *GUIController {
	return &GUIController{
		app:         app,
		mainWindow:  mainWindow,
		floatWindow: floatWindow,
		svc:         svc,
		cfg:         cfg,
	}
}

func (g *GUIController) createContextMenu() *application.ContextMenu {
	menu := application.NewContextMenu("float-bar")
	menu.Add("Open Main Window").OnClick(func(_ *application.Context) {
		g.RestoreMainWindow()
	})
	menu.Add("Add Download").OnClick(func(_ *application.Context) {
		g.app.Event.Emit("download:open-add-dialog")
		g.RestoreMainWindow()
	})
	menu.AddSeparator()
	menu.Add("Pause All").OnClick(func(_ *application.Context) {
		g.PauseAll()
	})
	menu.Add("Resume All").OnClick(func(_ *application.Context) {
		g.ResumeAll()
	})
	menu.AddSeparator()
	menu.Add("Open Download Folder").OnClick(func(_ *application.Context) {
		g.OpenDownloadFolder()
	})
	menu.AddSeparator()
	menu.Add("Toggle Floating Bar").OnClick(func(_ *application.Context) {
		g.HideFloatWindow()
	})
	menu.Add("Quit Orig Hub").OnClick(func(_ *application.Context) {
		g.quitting.Store(true)
		g.mainWindow.Close()
	})
	return menu
}

func (g *GUIController) SetSystray(systray *application.SystemTray) {
	g.systray = systray
}

func (g *GUIController) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	pollCtx, cancel := context.WithCancel(ctx)
	g.cancelPolling = cancel
	g.ctxMenu = g.createContextMenu()
	go g.pollDownloadStatus(pollCtx)
	go g.listenLocaleChanged(ctx)
	go g.listenFloatEvents(ctx)
	return nil
}

func (g *GUIController) ServiceShutdown() error {
	if g.cancelPolling != nil {
		g.cancelPolling()
	}
	g.stopSnapPolling()
	return nil
}

func (g *GUIController) listenLocaleChanged(ctx context.Context) {
	g.app.Event.On("locale:changed", func(event *application.CustomEvent) {
		if locale, ok := event.Data.(string); ok && locale != "" {
			if g.OnLocaleChanged != nil {
				g.OnLocaleChanged(locale)
			}
		}
	})
	<-ctx.Done()
}

func (g *GUIController) listenFloatEvents(ctx context.Context) {
	// TODO: 后续完善 — 启用贴边/展开/自动隐藏时恢复以下事件订阅
	// g.app.Event.On("float:expand", func(_ *application.CustomEvent) {
	// 	g.expandFloat()
	// })
	// g.app.Event.On("float:collapse", func(_ *application.CustomEvent) {
	// 	g.collapseFloat()
	// })
	g.app.Event.On("float:restore", func(_ *application.CustomEvent) {
		g.RestoreMainWindow()
	})
	g.app.Event.On("floating:enter", func(_ *application.CustomEvent) {
		g.HideMainWindow()
		g.ShowFloatWindow()
	})
	<-ctx.Done()
}

func (g *GUIController) pollDownloadStatus(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var wasActive bool

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			statuses, err := g.svc.List()
			if err != nil {
				continue
			}
			g.app.Event.Emit("download:status", statuses)

			activeCount := 0
			totalSpeed := float64(0)
			for _, s := range statuses {
				if s.Status == "downloading" {
					activeCount++
					totalSpeed += s.Speed
				}
			}

			isActive := activeCount > 0

			if g.systray != nil {
				if isActive {
					speed := formatSpeedValue(totalSpeed)
					g.systray.SetTooltip(appI18n.T("tray.tooltipActive", speed, formatInt(activeCount)))
					if !wasActive {
						g.systray.SetIcon(CreateTrayIconActive())
					}
				} else {
					g.systray.SetTooltip(appI18n.T("tray.tooltipIdle"))
					if wasActive {
						g.systray.SetIcon(CreateTrayIcon())
					}
				}
				wasActive = isActive
			}
		}
	}
}

func (g *GUIController) ShowFloatWindow() {
	g.snapDirection.Store(snapNone)
	g.snapState.Store(snapStateNormal)
	g.floatWindow.SetAlwaysOnTop(true)
	w, h := floatCollapsedW, floatCollapsedH
	screenW, screenH := getScreenSize()
	x := g.floatSavedX
	y := g.floatSavedY
	if x == 0 && y == 0 {
		x = screenW - w - 40
		y = screenH - h - 60
	}
	g.floatWindow.SetSize(w, h)
	g.floatWindow.SetPosition(x, y)
	g.floatWindow.Show()

	// TODO: 后续完善 — 启用贴边/自动隐藏时恢复
	// time.AfterFunc(500*time.Millisecond, func() {
	// 	g.emitSnapState()
	// })

	time.AfterFunc(200*time.Millisecond, func() {
		g.floatHwndMu.Lock()
		g.floatHwnd = findWindowByTitleInProcess("Orig Hub Float")
		if g.floatHwnd != 0 {
			setToolWindowStyle(g.floatHwnd)
		}
		g.floatHwndMu.Unlock()
	})

	// TODO: 后续完善 — 启用贴边/自动隐藏时恢复
	// time.AfterFunc(2000*time.Millisecond, func() {
	// 	g.startSnapPolling()
	// })
}

func (g *GUIController) HideFloatWindow() {
	g.stopSnapPolling()
	x, y := g.floatWindow.Position()
	g.floatSavedX = x
	g.floatSavedY = y
	g.floatWindow.Hide()
}

func (g *GUIController) HideMainWindow() {
	x, y := g.mainWindow.Position()
	w, h := g.mainWindow.Size()
	g.mainSavedX = x
	g.mainSavedY = y
	g.mainSavedW = w
	g.mainSavedH = h
	g.mainWindow.Hide()
}

func (g *GUIController) ShowMainWindow() {
	g.mainWindow.Show()
	if g.mainSavedW > 0 && g.mainSavedH > 0 {
		g.mainWindow.SetSize(g.mainSavedW, g.mainSavedH)
		g.mainWindow.SetPosition(g.mainSavedX, g.mainSavedY)
	}
	g.mainWindow.Focus()
}

func (g *GUIController) RestoreMainWindow() {
	g.HideFloatWindow()
	g.ShowMainWindow()
}

func (g *GUIController) ToggleFloatingBar() {
	g.floatHwndMu.Lock()
	hwnd := g.floatHwnd
	g.floatHwndMu.Unlock()

	if hwnd != 0 {
		visible, _, _ := procIsWindowVisible.Call(hwnd)
		if visible != 0 {
			g.HideFloatWindow()
			return
		}
	}
	g.ShowFloatWindow()
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) expandFloat() {
	if g.floatExpanded.Load() {
		return
	}
	g.floatExpanded.Store(true)
	dir := g.snapDirection.Load()
	state := g.snapState.Load()
	screenW, screenH := getScreenSize()

	x, y := g.floatWindow.Position()
	var newW, newH int
	switch {
	case state == snapStateSnapped && dir == snapTop:
		newW, newH = floatExpandedW, floatExpandedH
		g.floatWindow.SetSize(newW, newH)
		g.floatWindow.SetPosition(x, 0)
	case state == snapStateSnapped && dir == snapBottom:
		newW, newH = floatExpandedW, floatExpandedH
		g.floatWindow.SetSize(newW, newH)
		g.floatWindow.SetPosition(x, screenH-floatExpandedH)
	case state == snapStateSnapped && dir == snapLeft:
		newW, newH = floatExpandedW, floatExpandedH
		g.floatWindow.SetSize(newW, newH)
		g.floatWindow.SetPosition(0, y)
	case state == snapStateSnapped && dir == snapRight:
		newW, newH = floatExpandedW, floatExpandedH
		g.floatWindow.SetSize(newW, newH)
		g.floatWindow.SetPosition(screenW-floatExpandedW, y)
	default:
		newW, newH = floatExpandedW, floatExpandedH
		g.floatWindow.SetSize(newW, newH)
	}

	g.app.Event.Emit("float:expand-complete")
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) collapseFloat() {
	if !g.floatExpanded.Load() {
		return
	}
	g.floatExpanded.Store(false)
	dir := g.snapDirection.Load()
	state := g.snapState.Load()
	x, y := g.floatWindow.Position()
	screenW, screenH := getScreenSize()

	switch {
	case state == snapStateSnapped && dir == snapTop:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, 0)
	case state == snapStateSnapped && dir == snapBottom:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, screenH-floatSnappedH)
	case state == snapStateSnapped && dir == snapLeft:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		g.floatWindow.SetPosition(0, y)
	case state == snapStateSnapped && dir == snapRight:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		g.floatWindow.SetPosition(screenW-floatSnappedW, y)
	default:
		g.floatWindow.SetSize(floatCollapsedW, floatCollapsedH)
	}

	g.app.Event.Emit("float:collapse-complete")
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) startSnapPolling() {
	g.stopSnapPolling()
	ctx, cancel := context.WithCancel(context.Background())
	g.cancelSnap = cancel

	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()

		var stableCount int
		var lastX, lastY int
		var hideTimer *time.Timer

		for {
			select {
			case <-ctx.Done():
				if hideTimer != nil {
					hideTimer.Stop()
				}
				return
			case <-ticker.C:
				if g.quitting.Load() {
					return
				}
				x, y := g.floatWindow.Position()
				w, h := g.floatWindow.Size()

				if x != lastX || y != lastY {
					stableCount = 0
					lastX, lastY = x, y

					currentState := g.snapState.Load()
					if currentState != snapStateNormal {
						dir := g.detectSnap(x, y, w, h)
						if dir == snapNone {
							g.unsnap()
							stableCount = 0
						}
					}
					if hideTimer != nil {
						hideTimer.Stop()
						hideTimer = nil
					}
					continue
				}

				stableCount++

				currentState := g.snapState.Load()
				if currentState == snapStateNormal && stableCount >= 3 {
					// Check cooldown to prevent immediate re-snap after exitAutoHide
					if time.Now().UnixMilli() < g.snapCooldown.Load() {
						continue
					}
					dir := g.detectSnap(x, y, w, h)
					if dir != snapNone {
						g.applySnap(dir)
						stableCount = 0
						g.lastSnapX = x
						g.lastSnapY = y
					}
				}

				if currentState == snapStateSnapped && hideTimer == nil {
					hideTimer = time.AfterFunc(800*time.Millisecond, func() {
						g.enterAutoHide()
						hideTimer = nil
					})
				}
			}
		}
	}()

	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if g.quitting.Load() {
					return
				}
				if g.snapState.Load() != snapStateAutoHide {
					continue
				}
				mx, my := getCursorPos()
				g.floatHwndMu.Lock()
				hwnd := g.floatHwnd
				g.floatHwndMu.Unlock()
				if hwnd != 0 && isPointInWindowRect(hwnd, mx, my) {
					g.exitAutoHide()
				}
			}
		}
	}()
}

func (g *GUIController) stopSnapPolling() {
	if g.cancelSnap != nil {
		g.cancelSnap()
		g.cancelSnap = nil
	}
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) detectSnap(x, y, w, h int) int32 {
	screenW, screenH := getScreenSize()

	if y <= snapThreshold && y >= -h {
		return snapTop
	}
	if y+h >= screenH-snapThreshold && y+h <= screenH+h {
		return snapBottom
	}
	if x <= snapThreshold && x >= -w {
		return snapLeft
	}
	if x+w >= screenW-snapThreshold && x+w <= screenW+w {
		return snapRight
	}
	return snapNone
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) applySnap(dir int32) {
	x, _ := g.floatWindow.Position()
	screenW, screenH := getScreenSize()
	g.snapDirection.Store(dir)
	g.snapState.Store(snapStateSnapped)

	switch dir {
	case snapTop:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, 0)
	case snapBottom:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, screenH-floatSnappedH)
	case snapLeft:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		_, y := g.floatWindow.Position()
		g.floatWindow.SetPosition(0, y)
	case snapRight:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		_, y := g.floatWindow.Position()
		g.floatWindow.SetPosition(screenW-floatSnappedW, y)
	}

	g.emitSnapState()
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) unsnap() {
	x, y := g.floatWindow.Position()
	g.snapDirection.Store(snapNone)
	g.snapState.Store(snapStateNormal)
	g.floatWindow.SetSize(floatCollapsedW, floatCollapsedH)
	g.floatWindow.SetPosition(x, y)
	g.emitSnapState()
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) enterAutoHide() {
	if g.snapState.Load() != snapStateSnapped {
		return
	}
	g.snapState.Store(snapStateAutoHide)
	dir := g.snapDirection.Load()
	x, y := g.floatWindow.Position()
	screenW, screenH := getScreenSize()
	g.floatExpanded.Store(false)

	switch dir {
	case snapTop:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, -floatSnappedH+1)
	case snapBottom:
		g.floatWindow.SetSize(floatCollapsedW, floatSnappedH)
		g.floatWindow.SetPosition(x, screenH-1)
	case snapLeft:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		g.floatWindow.SetPosition(-floatSnappedW+1, y)
	case snapRight:
		g.floatWindow.SetSize(floatSnappedW, floatCollapsedW)
		g.floatWindow.SetPosition(screenW-1, y)
	}

	g.emitSnapState()
}

// TODO: 后续完善 — 贴边/展开/自动隐藏功能 (函数已完整保留, 入口已关闭)
func (g *GUIController) exitAutoHide() {
	if g.snapState.Load() != snapStateAutoHide {
		return
	}
	dir := g.snapDirection.Load()
	screenW, screenH := getScreenSize()

	g.snapDirection.Store(snapNone)
	g.snapState.Store(snapStateNormal)
	g.floatExpanded.Store(false)

	// Set 3-second cooldown to prevent immediate re-snap
	g.snapCooldown.Store(time.Now().Add(3 * time.Second).UnixMilli())

	// Restore to normal size and move AWAY from edge to prevent immediate re-snap
	x := screenW - floatCollapsedW - 40
	y := screenH - floatCollapsedH - 60

	// Use last known snap position as base if available
	if g.lastSnapX > 0 && g.lastSnapX < screenW-floatCollapsedW {
		x = g.lastSnapX
	}
	if dir == snapTop {
		y = 20
	} else if dir == snapBottom {
		y = screenH - floatCollapsedH - 20
	} else if dir == snapLeft {
		x = 20
		y = g.lastSnapY
		if y <= 0 || y > screenH-floatCollapsedH {
			y = screenH - floatCollapsedH - 60
		}
	} else if dir == snapRight {
		x = screenW - floatCollapsedW - 20
		y = g.lastSnapY
		if y <= 0 || y > screenH-floatCollapsedH {
			y = screenH - floatCollapsedH - 60
		}
	}

	g.floatWindow.SetSize(floatCollapsedW, floatCollapsedH)
	g.floatWindow.SetPosition(x, y)

	g.emitSnapState()
}

func (g *GUIController) emitSnapState() {
	dir := g.snapDirection.Load()
	state := g.snapState.Load()

	var dirStr string
	switch dir {
	case snapTop:
		dirStr = "top"
	case snapBottom:
		dirStr = "bottom"
	case snapLeft:
		dirStr = "left"
	case snapRight:
		dirStr = "right"
	default:
		dirStr = "none"
	}

	var stateStr string
	switch state {
	case snapStateSnapped:
		stateStr = "snapped"
	case snapStateAutoHide:
		stateStr = "autohide"
	default:
		stateStr = "normal"
	}

	g.app.Event.Emit("float:snap-state", map[string]string{
		"direction": dirStr,
		"state":     stateStr,
	})
}

func (g *GUIController) PauseAll() {
	statuses, _ := g.svc.List()
	for _, s := range statuses {
		if s.Status == "downloading" {
			_ = g.svc.Pause(s.ID)
		}
	}
	g.app.Event.Emit("download:all-paused")
}

func (g *GUIController) ResumeAll() {
	statuses, _ := g.svc.List()
	for _, s := range statuses {
		if s.Status == "paused" {
			_ = g.svc.Resume(context.Background(), s.ID)
		}
	}
	g.app.Event.Emit("download:all-resumed")
}

func (g *GUIController) OpenDownloadFolder() {
	dir := g.cfg.Download.OutputDir
	if dir == "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	_ = cmd.Start()
}

func formatSpeedValue(bytesPerSec float64) string {
	if bytesPerSec > 1024*1024 {
		return formatFloat(bytesPerSec/(1024*1024), 1) + " MB/s"
	} else if bytesPerSec > 1024 {
		return formatFloat(bytesPerSec/1024, 1) + " KB/s"
	}
	return "0 KB/s"
}

func formatFloat(f float64, prec int) string {
	return formatFloatImpl(f, prec)
}

func formatInt(i int) string {
	return formatIntImpl(i)
}