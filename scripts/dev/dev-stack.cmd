@echo off
rem OrigHub dev stack - MANUAL entry point (dev-only).
rem
rem This is the only thing you need to touch. It never runs in the background,
rem never monitors anything, and exits when you are done. The resident guard
rem from the previous round has been removed on purpose.
rem
rem Everything here is scaffolding for testing. It does NOT get linked into
rem orig-daemon / orig-tg / the Tauri shell and does not change how the shipped
rem binaries behave.
rem
rem Why there is a "build" action that stops things first:
rem   A running .exe is file-locked on Windows, so cargo cannot relink
rem   target\release\orig-daemon.exe and sync-sidecars.sh cannot copy over it.
rem   Building before stopping fails with Access denied.
rem
rem Why every start/status prints process-vs-binary timestamps:
rem   If the process started BEFORE the exe was last written, it is running the
rem   previous build - exactly the trap that made a whole acceptance run test
rem   stale code. The script now says so out loud.
rem
rem Keep this file pure ASCII (cmd.exe reads it as ANSI).

setlocal enabledelayedexpansion
cd /d "%~dp0..\.."
set "REPO=%CD%"
set "DEV=%~dp0dev_stack.py"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found in PATH.
    pause
    exit /b 2
)

rem Allow direct invocation: dev-stack.cmd status / start / restart / stop / build / build-tg
if not "%~1"=="" (
    python "%DEV%" %*
    exit /b %ERRORLEVEL%
)

:menu
cls
echo ============================================================
echo  OrigHub dev stack - manual control
echo ============================================================
echo.
python "%DEV%" status
echo.
echo ------------------------------------------------------------
echo   1  Start        (reuse if already healthy)
echo   2  Restart      (stop + start: use this after a new build)
echo   3  Stop         (frees the exe locks so cargo can relink)
echo   4  Build        (stop -^> cargo build -^> sync copies)
echo   5  Build tg     (only orig-tg; faster when touching the engine)
echo   6  Status only  (refresh the panel above)
echo   0  Exit
echo ------------------------------------------------------------
set "CHOICE="
set /p "CHOICE=Select: "
echo.

if "%CHOICE%"=="1" goto do_start
if "%CHOICE%"=="2" goto do_restart
if "%CHOICE%"=="3" goto do_stop
if "%CHOICE%"=="4" goto do_build
if "%CHOICE%"=="5" goto do_build_tg
if "%CHOICE%"=="6" goto menu
if "%CHOICE%"=="0" exit /b 0
echo Unknown choice.
pause
goto menu

:do_start
python "%DEV%" start
goto done

:do_restart
python "%DEV%" restart
goto done

:do_stop
python "%DEV%" stop
goto done

:do_build
python "%DEV%" build
goto done

:do_build_tg
python "%DEV%" build-tg
goto done

:done
echo.
pause
goto menu
