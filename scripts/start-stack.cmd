@echo off
rem OrigHub dev stack - one-click repair and keep-alive.
rem
rem Double-click this file when the UI says the backend is unreachable.
rem It does two things:
rem   1. repairs whatever is down, right now, with visible output;
rem   2. starts the keep-alive guard OUTSIDE this console (via WMI), so
rem      closing this window does not kill the services.
rem
rem Why the guard must be started via WMI: see scripts/launch_detached.ps1.
rem Keep this file pure ASCII (cmd.exe reads it as ANSI).

setlocal enabledelayedexpansion
cd /d "%~dp0.."

set "REPO=%CD%"
set "SCRIPTS=%~dp0"
set "PYW="

rem Resolve an absolute pythonw.exe: WMI-spawned processes do NOT inherit this
rem console's PATH, so a bare "pythonw" would fail to resolve there.
for /f "delims=" %%i in ('where pythonw 2^>nul') do (
    if not defined PYW set "PYW=%%i"
)
if not defined PYW (
    echo [ERROR] pythonw.exe not found in PATH. Install Python 3.10+ or add it to PATH.
    pause
    exit /b 2
)

echo === Step 1/2: repairing the stack ===
python "%SCRIPTS%stack_guard.py" --once
set "RC=%ERRORLEVEL%"
echo.

if not "%RC%"=="0" (
    echo [WARN] some component is still down. See the log paths printed above.
    echo        Most common cause: the binaries were never built.
    echo        Fix: cd download-engine ^&^& cargo build --release -p orig-daemon -p orig-tg
    echo.
)

echo === Step 2/2: starting the keep-alive guard ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS%launch_detached.ps1" -CommandLine "\"%PYW%\" \"%SCRIPTS%stack_guard.py\" --daemon" -WorkingDirectory "%REPO%"
if errorlevel 1 (
    echo [WARN] could not start the guard via WMI. The stack is still repaired
    echo        for now, but it will NOT self-heal and will die with this session.
) else (
    echo Guard started. Closing this window does NOT stop the services.
)

echo.
echo Frontend:  http://localhost:5180
echo Status:    python scripts\stack_guard.py --status
echo Guard log: %TEMP%\orighub-stack-guard.log
echo.
rem NOPAUSE=1 lets CI / an agent run this non-interactively.
if not defined NOPAUSE pause
