#!/usr/bin/env bash
# Clock Dock — start the server and open the display full-screen (kiosk) on macOS.
#
# Why kiosk mode instead of the in-page fullscreen button: the browser's
# Fullscreen API always exits on a real page reload (a security rule, not a
# bug) — including the remote "Reload display" button in Settings. --kiosk
# makes fullscreen a property of the Chrome window itself, so a reload just
# refreshes the page inside it without ever dropping out of fullscreen.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-8080}"
URL="http://localhost:${PORT}/"
LOG_FILE="server.log"

# 1) Start the local server if it isn't already running.
if ! lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "Starting Clock Dock server..."
  nohup node server/server.js >"$LOG_FILE" 2>&1 &
  disown
  sleep 2
else
  echo "Clock Dock server already running on port $PORT."
fi

# 2) Open the display in kiosk mode.
#    --autoplay-policy lets the adhan play without a manual tap.
echo "Opening display in kiosk mode: $URL"
open -na "Google Chrome" --args \
  --kiosk "$URL" \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run
