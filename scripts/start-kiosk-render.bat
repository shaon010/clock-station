@echo off
REM ---------------------------------------------------------------------------
REM  Clock Dock — open the Render-hosted display full-screen (kiosk) on the tablet.
REM
REM  This app is hosted on Render, not run locally on the tablet, so there's no
REM  server to start here — this just opens the browser in kiosk mode pointed
REM  at the live URL below.
REM
REM  Why kiosk mode instead of opening a normal tab and clicking the on-screen
REM  fullscreen (⛶) button: the browser's Fullscreen API always exits on a
REM  real page reload (a security rule, not a bug) — including the remote
REM  "Reload display" button in Settings. --kiosk makes fullscreen a property
REM  of the browser window itself, so a reload just refreshes the page in
REM  place without ever leaving fullscreen.
REM
REM  Put a shortcut to this file in the Startup folder to run it at login:
REM    Win+R  ->  shell:startup   ->  paste a shortcut to start-kiosk-render.bat
REM ---------------------------------------------------------------------------

set URL=https://clock-dock.onrender.com/

REM Prefer Edge (lower power draw than Chrome on Windows). Edge registers
REM itself via the "App Paths" registry key, not the PATH env var, so
REM `where msedge` misses it even when it's installed — check its real
REM install locations directly instead.
set EDGE1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
set EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe

if exist "%EDGE1%" (
  start "" "%EDGE1%" --kiosk %URL% --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --no-first-run
) else if exist "%EDGE2%" (
  start "" "%EDGE2%" --kiosk %URL% --edge-kiosk-type=fullscreen --autoplay-policy=no-user-gesture-required --no-first-run
) else (
  start "" chrome --kiosk %URL% --autoplay-policy=no-user-gesture-required --no-first-run
)
