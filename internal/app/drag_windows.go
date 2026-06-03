package app

func dragWindow() {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return
	}

	root, _, _ := procGetAncestor.Call(hwnd, GA_ROOT)
	if root != 0 {
		isWnd, _, _ := procIsWindow.Call(root)
		if isWnd != 0 {
			hwnd = root
		}
	}

	procReleaseCapture.Call()
	procSendMessageW.Call(
		hwnd,
		WM_NCLBUTTONDOWN,
		HTCAPTION,
		uintptr(0),
	)
}
