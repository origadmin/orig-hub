# OrigHubDaemonWatchdog 计划任务重配脚本（消除每分钟的黑色控制台窗口）。
#
# 用法（以管理员身份运行，或右键「使用 PowerShell 运行」）：
#   powershell -ExecutionPolicy Bypass -File install_watchdog_task.ps1
#
# 作用：
#   1. 把任务的操作从 `python.exe watchdog.py` 换成 `pythonw.exe watchdog.py`
#      （pythonw 是 GUI 子系统，不会分配控制台窗口 → 不再闪）。
#   2. 勾选「隐藏(Hidden)」，并设每 1 分钟触发、单次执行上限 1 分钟、忽略新实例。
#
# 说明：本脚本只改「OrigHubDaemonWatchdog」这一个任务，不动其他任务。

param(
    # 看门狗脚本绝对路径；默认取与本脚本同目录的 orig_hub_watchdog.py
    [string]$ScriptPath = "",
    # 任务名
    [string]$TaskName = "OrigHubDaemonWatchdog"
)

$ErrorActionPreference = "Stop"

if (-not $ScriptPath) {
    $ScriptPath = Join-Path $PSScriptRoot "orig_hub_watchdog.py"
}
if (-not (Test-Path $ScriptPath)) {
    throw "找不到看门狗脚本：$ScriptPath"
}

# 解析 pythonw.exe 路径（与 python 同目录，随 Python 安装自带）
$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyw) {
    # 退而求其次：从 python.exe 同目录推算
    $py = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if ($py) {
        $pyw = Join-Path (Split-Path $py) "pythonw.exe"
    }
}
if (-not $pyw -or -not (Test-Path $pyw)) {
    throw "找不到 pythonw.exe，请确认 Python 已安装并加入 PATH。"
}

Write-Host "pythonw : $pyw"
Write-Host "script  : $ScriptPath"

# 构建动作与触发器
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$ScriptPath`""
# 不指定 RepetitionDuration ⇒ 每 1 分钟无限重复。[TimeSpan]::MaxValue 会序列化成
# P99999999DT23H59M59S，超出任务计划程序允许的 Duration 上限（报错
# 「任务 XML 包含格式不正确或超出范围的值」），故必须省略。
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

# -ErrorAction Stop：注册失败（如 XML 校验不过）立即终止，避免打印假成功。
$task = Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "OrigHub 下载引擎守护进程保活看门狗（无控制台）" `
    -Force -ErrorAction Stop
if (-not $task) {
    throw "计划任务 '$TaskName' 创建失败（未返回任务对象）。"
}

Write-Host "已（重）创建计划任务 '$TaskName'。" -ForegroundColor Green
Write-Host "可在「任务计划程序」中确认：操作 = $pyw，参数 = `"$ScriptPath`"，触发器 = 每 1 分钟，设置已勾选「隐藏」。"
Write-Host "日志：%LOCALAPPDATA%\OrigHub\logs\watchdog.log"
