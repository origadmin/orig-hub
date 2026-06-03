package i18n

var builtinJa = map[string]string{
	"app.name":                "Orig Hub",

	"tray.openMainWindow":     "メインウィンドウを隠す",
	"tray.addDownload":        "新規タスク",
	"tray.resumeAll":          "すべて開始",
	"tray.pauseAll":           "すべて一時停止",
	"tray.floatingBar":        "フローティング設定",
	"tray.floatingBar.always":         "常に表示",
	"tray.floatingBar.downloading":    "ダウンロード中のみ表示",
	"tray.floatingBar.never":          "完全に閉じる",
	"tray.quit":               "Orig Hub を終了",
	"tray.tooltipIdle":        "Orig Hub — 待機中",
	"tray.tooltipActive":      "Orig Hub — %v · %v アクティブ",
	"tray.tooltipMinimized":   "Orig Hub — 最小化",

	"error.downloadNotFound":  "ダウンロードが見つかりません",
	"error.invalidURL":        "URL形式が無効です",
	"error.downloadFailed":    "ダウンロードに失敗しました",
	"error.pathNotExist":      "ダウンロードパスが存在しません",
}
