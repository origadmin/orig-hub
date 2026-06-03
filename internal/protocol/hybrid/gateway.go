package hybrid

import (
	"fmt"
	"html/template"
	"net/http"
)

type GatewayPageData struct {
	HybridLink    string
	AppName       string
	DownloadURL   string
	Filename      string
	FileSize      string
	SourceCount   int
	GatewayDomain string
}

const gatewayPageTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{.AppName}} - 极速下载</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{max-width:480px;width:100%;padding:24px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:32px;text-align:center}
.logo{font-size:48px;margin-bottom:16px}
.title{font-size:24px;font-weight:700;color:#fff;margin-bottom:8px}
.subtitle{font-size:14px;color:#888;margin-bottom:24px}
.file-info{background:#1e1e1e;border-radius:12px;padding:16px;margin-bottom:24px;text-align:left}
.file-info .row{display:flex;justify-content:space-between;padding:6px 0;font-size:13px}
.file-info .label{color:#888}
.file-info .value{color:#e0e0e0;font-weight:500}
.btn-launch{display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:12px;transition:all .2s}
.btn-launch.primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}
.btn-launch.primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px rgba(99,102,241,.4)}
.btn-launch.secondary{background:#1e1e1e;color:#aaa;border:1px solid #333}
.btn-launch.secondary:hover{border-color:#555;color:#fff}
.hint{font-size:12px;color:#666;margin-top:16px;line-height:1.6}
.status{margin-top:16px;padding:12px;border-radius:8px;font-size:13px;display:none}
.status.error{display:block;background:#2d1b1b;color:#f87171;border:1px solid #5c2020}
.status.success{display:block;background:#1b2d1b;color:#4ade80;border:1px solid #205c20}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="container">
<div class="card">
<div class="logo">⚡</div>
<div class="title">{{.AppName}}</div>
<div class="subtitle">极速多源下载</div>
{{if .Filename}}
<div class="file-info">
<div class="row"><span class="label">文件名</span><span class="value">{{.Filename}}</span></div>
{{if .FileSize}}<div class="row"><span class="label">大小</span><span class="value">{{.FileSize}}</span></div>{{end}}
{{if .SourceCount}}<div class="row"><span class="label">源数量</span><span class="value">{{.SourceCount}} 个镜像</span></div>{{end}}
</div>
{{end}}
<button class="btn-launch primary" id="launchBtn" onclick="launchApp()">
<span id="launchText">打开 {{.AppName}} 下载</span>
</button>
<a href="{{.DownloadURL}}" class="btn-launch secondary" id="downloadBtn" style="text-decoration:none;display:none">
未安装？点击下载 {{.AppName}}
</a>
<div class="status" id="status"></div>
<div class="hint">
点击按钮将自动唤起 {{.AppName}}<br>
如果未安装，将引导您下载安装
</div>
</div>
</div>
<script>
var hybridLink = "{{.HybridLink}}";
var launched = false;
var startTime = 0;

function launchApp() {
	var btn = document.getElementById('launchBtn');
	var text = document.getElementById('launchText');
	var status = document.getElementById('status');
	var dlBtn = document.getElementById('downloadBtn');

	text.innerHTML = '<span class="spinner"></span>正在唤起 {{.AppName}}...';
	btn.style.opacity = '0.7';
	btn.style.pointerEvents = 'none';
	startTime = Date.now();
	launched = false;

	var iframe = document.createElement('iframe');
	iframe.style.display = 'none';
	iframe.src = hybridLink;
	document.body.appendChild(iframe);

	setTimeout(function() {
		iframe.remove();
	}, 3000);

	setTimeout(function() {
		if (!launched && document.hidden) {
			launched = true;
			status.className = 'status success';
			status.textContent = '✓ {{.AppName}} 已启动';
			text.textContent = '已打开 {{.AppName}}';
		}
	}, 1500);

	setTimeout(function() {
		if (!launched) {
			status.className = 'status error';
			status.textContent = '⚠ 未检测到 {{.AppName}}，请确认已安装';
			dlBtn.style.display = 'block';
			text.textContent = '重试唤起';
			btn.style.opacity = '1';
			btn.style.pointerEvents = 'auto';
		}
	}, 3000);
}

document.addEventListener('visibilitychange', function() {
	if (document.hidden && startTime > 0) {
		launched = true;
		var status = document.getElementById('status');
		var text = document.getElementById('launchText');
		status.className = 'status success';
		status.textContent = '✓ {{.AppName}} 已启动';
		text.textContent = '已打开 {{.AppName}}';
	}
});

window.addEventListener('load', function() {
	setTimeout(launchApp, 500);
});
</script>
</body>
</html>`

var gatewayTmpl *template.Template

func init() {
	gatewayTmpl = template.Must(template.New("gateway").Parse(gatewayPageTemplate))
}

func ServeGatewayPage(w http.ResponseWriter, data GatewayPageData) error {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	return gatewayTmpl.Execute(w, data)
}

func BuildGatewayPageData(hybridLink, gatewayDomain string, payload *HybridPayload) GatewayPageData {
	data := GatewayPageData{
		HybridLink:    hybridLink,
		AppName:       "OrigHub",
		DownloadURL:   fmt.Sprintf("https://%s/download", gatewayDomain),
		GatewayDomain: gatewayDomain,
	}

	if payload != nil {
		if payload.Hash != "" {
			if len(payload.Hash) > 16 {
				data.Filename = payload.Hash[:16] + "..."
			} else {
				data.Filename = payload.Hash
			}
		}
		if payload.FileSize > 0 {
			data.FileSize = formatFileSize(payload.FileSize)
		}
		if len(payload.MultiSource) > 0 {
			data.SourceCount = len(payload.MultiSource)
		}
	}

	return data
}

func formatFileSize(size int64) string {
	const (
		KB = 1024
		MB = KB * 1024
		GB = MB * 1024
		TB = GB * 1024
	)
	switch {
	case size >= TB:
		return fmt.Sprintf("%.2f TB", float64(size)/float64(TB))
	case size >= GB:
		return fmt.Sprintf("%.2f GB", float64(size)/float64(GB))
	case size >= MB:
		return fmt.Sprintf("%.2f MB", float64(size)/float64(MB))
	case size >= KB:
		return fmt.Sprintf("%.2f KB", float64(size)/float64(KB))
	default:
		return fmt.Sprintf("%d B", size)
	}
}
