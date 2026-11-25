@echo off
rem Double-click this file to start the SYNCHY booth full screen.
rem To close the booth: Alt+F4 on the booth screen, then close this window.
cd /d "%~dp0"
chcp 65001 >nul
title SYNCHY booth server
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server.js --kiosk
echo.
echo The booth server has stopped.
pause
