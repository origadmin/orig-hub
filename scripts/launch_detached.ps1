# OrigHub - host a process OUTSIDE the agent session (escape the job object).
#
# Why this is required:
#   Every shell command the agent runs lives in a job object. When the command
#   ends (or the session ends, or a background task is reclaimed), the job is
#   closed and KILL_ON_JOB_CLOSE takes every process inside it with it - even
#   children started with DETACHED_PROCESS, which only detaches the console,
#   not the job.
#   Measured on this machine: orig-daemon starts fine, writes
#   "orig-daemon listening on http://127.0.0.1:19786" to its log, then vanishes
#   a few seconds later with no panic, no error and no shutdown line, i.e. it
#   was TerminateProcess'd.
#
#   WMI's Win32_Process.Create spawns the process from WmiPrvSE.exe, whose job
#   is not the agent's, so the process survives the session. This is the only
#   system-level hosting mechanism available here: schtasks.exe is on the local
#   program blacklist (cannot be bypassed) and sc.exe needs admin rights.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch_detached.ps1 `
#       -CommandLine '"<pythonw.exe>" "<repo>/scripts/stack_guard.py" --daemon' `
#       -WorkingDirectory '<repo>'
#
# Output: one JSON line on success ({"ok":true,"pid":N}); non-zero exit on failure.
# NOTE: keep this file pure ASCII - PowerShell 5.1 reads .ps1 as ANSI and any
#       UTF-8 non-ASCII text breaks the parser.

param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [string]$WorkingDirectory = ""
)

$ErrorActionPreference = "Stop"

$argTable = @{ CommandLine = $CommandLine }
if ($WorkingDirectory -ne "") {
    $argTable["CurrentDirectory"] = $WorkingDirectory
}

try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $argTable
} catch {
    Write-Error ("WMI Win32_Process.Create failed: " + $_.Exception.Message)
    exit 2
}

if ($result.ReturnValue -ne 0) {
    # Common ReturnValue: 9 = path not found, 21 = invalid parameter, 2 = access denied
    Write-Error ("WMI create failed, ReturnValue=" + $result.ReturnValue + " (9=path not found, 21=invalid parameter, 2=access denied)")
    exit 3
}

'{"ok":true,"pid":' + $result.ProcessId + '}'
exit 0
