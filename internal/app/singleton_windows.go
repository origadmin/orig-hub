package app

import (
	"syscall"
	"unsafe"
)

var mutexHandle uintptr

func EnsureSingleInstance() bool {
	name, _ := syscall.UTF16PtrFromString("OrigHub_SingleInstance_Mutex")
	mutexHandle, _, _ = procCreateMutexW.Call(
		uintptr(0),
		uintptr(0),
		uintptr(unsafe.Pointer(name)),
	)
	err, _, _ := procGetLastError.Call()
	if err == ERROR_ALREADY_EXISTS {
		activateExistingWindow()
		return false
	}
	return true
}

func activateExistingWindow() {
	className, _ := syscall.UTF16PtrFromString("Orig Hub")
	hwnd, _, _ := procFindWindowW.Call(
		uintptr(unsafe.Pointer(className)),
		uintptr(0),
	)
	if hwnd != 0 {
		isWnd, _, _ := procIsWindow.Call(hwnd)
		if isWnd != 0 {
			procShowWindow.Call(hwnd, SW_RESTORE)
			procSetForegroundWindow.Call(hwnd)
		}
	}
}

func ReleaseMutex() {
	if mutexHandle != 0 {
		syscall.CloseHandle(syscall.Handle(mutexHandle))
		mutexHandle = 0
	}
}
