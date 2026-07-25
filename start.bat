@echo off
rem Vault - one-click launcher
rem Starts the local server and opens the viewer in the default browser.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found in PATH.
  echo   Install the LTS build from https://nodejs.org then re-run start.bat
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run: installing dependencies...
  call npm install || (echo   npm install failed - see errors above & pause & exit /b 1)
)

rem Port is defined ONCE in config\index.js (MEDIA_TAGGER_PORT env overrides it);
rem this just asks the config so the browser opens the right URL.
for /f %%p in ('node -p "require('./config').server.port"') do set PORT=%%p

rem Pass flags through (e.g. start.bat --gamify enables the opt-in tracker)
start "" "http://127.0.0.1:%PORT%"
node server\index.js %*
pause
