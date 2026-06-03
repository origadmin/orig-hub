package app

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	user32                         = syscall.NewLazyDLL("user32.dll")
	procCreateMutexW               = kernel32.NewProc("CreateMutexW")
	procGetLastError               = kernel32.NewProc("GetLastError")
	procFindWindowW                = user32.NewProc("FindWindowW")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procIsWindow                   = user32.NewProc("IsWindow")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procGetAncestor                = user32.NewProc("GetAncestor")
	procReleaseCapture             = user32.NewProc("ReleaseCapture")
	procSendMessageW               = user32.NewProc("SendMessageW")
	procGetSystemMetrics           = user32.NewProc("GetSystemMetrics")
	procMoveWindow                 = user32.NewProc("MoveWindow")
	procGetDpiForWindow            = user32.NewProc("GetDpiForWindow")
	procGetWindowRect              = user32.NewProc("GetWindowRect")
	procEnumWindows                = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	procGetCurrentProcessId        = kernel32.NewProc("GetCurrentProcessId")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")
	procGetClassNameW              = user32.NewProc("GetClassNameW")
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW       = user32.NewProc("GetWindowTextLengthW")
	procGetWindowLongW             = user32.NewProc("GetWindowLongW")
	procSetWindowLongW             = user32.NewProc("SetWindowLongW")
	procSetWindowPos               = user32.NewProc("SetWindowPos")
	procGetCursorPos               = user32.NewProc("GetCursorPos")
)

const (
	ERROR_ALREADY_EXISTS = 183
	SW_RESTORE           = 9
	WM_NCLBUTTONDOWN     = 0x00A1
	HTCAPTION            = 2
	GA_ROOT              = 2
	SM_CXSCREEN          = 0
	SM_CYSCREEN          = 1
	WS_EX_TOOLWINDOW     = 0x00000080
	SWP_NOMOVE           = 0x0002
	SWP_NOSIZE           = 0x0001
	SWP_NOZORDER         = 0x0004
	SWP_FRAMECHANGED     = 0x0020
)

var gwlExStyle = uintptr(0xFFFFFFEC)

func getScreenSize() (int, int) {
	w, _, _ := procGetSystemMetrics.Call(SM_CXSCREEN)
	h, _, _ := procGetSystemMetrics.Call(SM_CYSCREEN)
	return int(w), int(h)
}

type winRect struct {
	Left, Top, Right, Bottom int32
}

type winPoint struct {
	X, Y int32
}

func setToolWindowStyle(hwnd uintptr) {
	style, _, _ := procGetWindowLongW.Call(hwnd, gwlExStyle)
	style |= WS_EX_TOOLWINDOW
	procSetWindowLongW.Call(hwnd, gwlExStyle, style)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED)
}

func removeToolWindowStyle(hwnd uintptr) {
	style, _, _ := procGetWindowLongW.Call(hwnd, gwlExStyle)
	style &^= WS_EX_TOOLWINDOW
	procSetWindowLongW.Call(hwnd, gwlExStyle, style)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED)
}

func getCursorPos() (int, int) {
	var pt winPoint
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return int(pt.X), int(pt.Y)
}

func isPointInWindowRect(hwnd uintptr, mouseX, mouseY int) bool {
	var rect winRect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	return mouseX >= int(rect.Left) && mouseX <= int(rect.Right) &&
		mouseY >= int(rect.Top) && mouseY <= int(rect.Bottom)
}

func findWindowByTitle(title string) uintptr {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(titlePtr)))
	return hwnd
}

func findWindowByTitleInProcess(title string) uintptr {
	pid, _, _ := procGetCurrentProcessId.Call()
	var result uintptr

	cb := syscall.NewCallback(func(hwnd uintptr, lParam uintptr) uintptr {
		var winPid uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&winPid)))
		if winPid != uint32(pid) {
			return 1
		}

		length, _, _ := procGetWindowTextLengthW.Call(hwnd)
		if length == 0 {
			return 1
		}

		buf := make([]uint16, length+1)
		procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(length+1))
		windowTitle := syscall.UTF16ToString(buf)

		if windowTitle == title {
			result = hwnd
			return 0
		}
		return 1
	})

	procEnumWindows.Call(cb, 0)
	return result
}