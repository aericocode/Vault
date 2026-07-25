@echo off
rem Vault - interactive scan wizard (no flags to remember)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found in PATH.
  echo   Install the LTS build from https://nodejs.org then re-run scan.bat
  echo.
  pause
  exit /b 1
)

node video-tagger.js
pause
