@echo off
REM ---------------------------------------------------------------------------
REM  Clock Dock — start the server and open the display full-screen (kiosk).
REM  Put a shortcut to this file in the Startup folder so it runs at login:
REM    Win+R  ->  shell:startup   ->  paste a shortcut to start.bat
REM ---------------------------------------------------------------------------

cd /d "%~dp0.."

REM 1) Start the local server (new minimized window, keeps running)
start "Clock Dock server" /min cmd /c "node server\server.js"

REM 2) Give the server a moment to bind the port
timeout /t 3 /nobreak >nul

REM 3) Open the display in kiosk mode.
REM    --autoplay-policy flag lets the adhan play without a manual tap.
set URL=http://localhost:8080/

where msedge >nul 2>nul
if %errorlevel%==0 (
  start "" msedge --kiosk %URL% --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --no-first-run
) else (
  start "" chrome --kiosk %URL% --autoplay-policy=no-user-gesture-required --no-first-run
)
