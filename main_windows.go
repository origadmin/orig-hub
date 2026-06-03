//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

func readSystemLocaleRawImpl() string {
	kernel32, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return envLocale()
	}
	proc, err := kernel32.FindProc("GetUserDefaultLocaleName")
	if err != nil {
		return envLocale()
	}
	const bufLen = 85
	buf := make([]uint16, bufLen)
	r, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(bufLen))
	if r == 0 {
		return envLocale()
	}
	return syscall.UTF16ToString(buf)
}
