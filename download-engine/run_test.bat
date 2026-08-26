@echo off
setlocal
cd /d D:\workspace\project\golang\origadmin\framework\projects\orig-hub\download-engine
if errorlevel 1 (
  echo [ERROR] cannot cd to download-engine
  pause
  exit /b 1
)

echo == cargo build ==
cargo build
if errorlevel 1 (
  echo [BUILD FAILED] see errors above
  pause
  exit /b 1
)

where python3 >nul 2>nul
if %errorlevel%==0 (
  set PY=python3
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set PY=python
  ) else (
    echo [ERROR] python3/python not found.
    echo Install Python 3, or run manually:
    echo   python3 verify/verify_http.py --daemon target/debug/orig-daemon
    pause
    exit /b 1
  )
)

echo == HTTP test file download verify ==
%PY% verify/verify_http.py --daemon target/debug/orig-daemon
pause
