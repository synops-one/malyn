@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Malyn.ps1" %*
if errorlevel 1 (
  echo.
  echo Malyn setup did not finish. See the error above.
  pause
  exit /b 1
)
echo.
pause
