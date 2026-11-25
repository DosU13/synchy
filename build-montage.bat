@echo off
rem Double-click this file to cut the trailers in the "trailers" folder into montage clips.
rem Only new or changed trailers are cut. To cut every trailer again: build-montage.bat --all
rem The booth also does this by itself when it starts, so this is optional.
cd /d "%~dp0"
chcp 65001 >nul
title SYNCHY montage
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node tools\build-montage.js %*
echo.
pause
