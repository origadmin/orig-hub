@echo off
rem OrigHub unified control - ONE script for dev + release (two isolated worlds).
rem Keep this file pure ASCII (cmd.exe reads it as ANSI).
rem Pass subcommands straight through, e.g.:
rem   hub.cmd dev build
rem   hub.cmd release build
rem   hub.cmd release run
rem   hub.cmd status

setlocal enabledelayedexpansion
cd /d "%~dp0.."
set "REPO=%CD%"
set "HUB=%~dp0hub.py"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found in PATH.
    pause
    exit /b 2
)

if "%~1"=="" (
    python "%HUB%" status
    exit /b %ERRORLEVEL%
)

python "%HUB%" %*
exit /b %ERRORLEVEL%
